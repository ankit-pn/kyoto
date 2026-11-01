// Tests for sidepanel/context.js — the compaction planner.
//
// The dangerous part of context compaction is the CUT POINT. Chat APIs require
// that an assistant message carrying `tool_calls` is immediately followed by a
// `tool` message for each call id; a cut in the middle of that group produces a
// transcript every OpenAI-compatible server rejects. These tests pin that
// invariant down, plus the "don't compact when it won't help" rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'context.js'), 'utf-8');

// Same-realm load so deepEqual sees shared prototypes.
function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/context.js' });
    return globalThis.KyotoContext;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const C = load();
const eq = assert.equal;

// ── Fixtures ─────────────────────────────────────────
// A realistic agent transcript: user → assistant(tool_calls) → tool → assistant.
function turn(n, { toolCalls = true, big = 0 } = {}) {
  const pad = big ? 'x'.repeat(big) : '';
  const out = [
    { role: 'user', content: `request ${n} ${pad}` },
    { role: 'assistant', content: `working ${n}` }
  ];
  if (toolCalls) {
    out[1] = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'page_eval', arguments: `{"n":${n}}` } }]
    };
    out.push({ role: 'tool', tool_call_id: `call_${n}`, name: 'page_eval', content: `result ${n} ${pad}` });
    out.push({ role: 'assistant', content: `done ${n}` });
  }
  return out;
}
function transcript(turns, opts) {
  const h = [];
  for (let i = 0; i < turns; i++) h.push(...turn(i, opts));
  return h;
}

// Structural invariant the real API enforces.
function assertNoOrphanTools(history, label) {
  const pending = new Set();
  for (const m of history) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) pending.add(tc.id);
    } else if (m.role === 'tool') {
      assert.ok(
        pending.has(m.tool_call_id),
        `${label}: tool result ${m.tool_call_id} has no preceding assistant tool_calls (orphaned)`
      );
      pending.delete(m.tool_call_id);
    }
  }
}

// ── Token estimation ─────────────────────────────────
test('estimateTokens grows with content and counts messages', () => {
  const small = C.estimateTokens([{ role: 'user', content: 'hi' }]);
  const big = C.estimateTokens([{ role: 'user', content: 'hi'.repeat(4000) }]);
  assert.ok(big > small * 10, 'longer content should estimate larger');
  eq(C.estimateTokens([]), 0);
  eq(C.estimateTokens(null), 0);
});

test('estimateTokens counts tool_call arguments and multimodal parts', () => {
  const a = C.estimateTokens([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: 'y'.repeat(400) } }] }]);
  const b = C.estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(400) }] }]);
  assert.ok(a > 50 && b > 50, `expected both to count their payloads (tool=${a}, parts=${b})`);
});

// ── Cut-point selection ──────────────────────────────
test('findCutIndex returns the index of the Nth most recent user message', () => {
  const h = transcript(5);           // 5 turns × 4 messages = 20
  // user messages sit at 0,4,8,12,16
  eq(C.findCutIndex(h, 1), 16);
  eq(C.findCutIndex(h, 3), 8);
  eq(C.findCutIndex(h, 9), -1, 'not enough user turns -> no safe cut');
});

test('planCompaction does nothing below the threshold', () => {
  const h = transcript(3);
  eq(C.planCompaction(h, { contextTokens: 200000, threshold: 0.75 }), null);
});

test('planCompaction fires when the estimate crosses the threshold', () => {
  // ~40 KB of text ≈ 11k tokens against a 2k window: comfortably over.
  const h = transcript(6, { big: 4000 });
  const plan = C.planCompaction(h, { contextTokens: 2000, threshold: 0.75, keepTurns: 2 });
  assert.ok(plan, 'should produce a plan');
  assert.ok(plan.cutIndex > 0);
  assert.ok(plan.droppedCount > 0 && plan.keptCount > 0);
  assert.ok(plan.tokensAfterEstimate < plan.tokensBefore, 'compaction must reduce the estimate');
});

// THE invariant: a cut may only land immediately before a `user` message, so a
// tool_calls group can never be split.
test('the cut always lands on a user turn (no split tool groups)', () => {
  for (const keep of [1, 2, 3, 4]) {
    const h = transcript(8, { big: 3000 });
    const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: keep });
    assert.ok(plan, `expected a plan for keepTurns=${keep}`);
    eq(h[plan.cutIndex].role, 'user', `cut must be at a user message (keepTurns=${keep})`);
    assert.ok(plan.cutIndex > 0);
  }
});

test('resulting transcript has no orphaned tool results', () => {
  const h = transcript(8, { big: 3000 });
  const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: 2 });
  const next = C.buildCompactedHistory(h, plan, 'SUMMARY');
  assertNoOrphanTools(next, 'compacted');
  eq(next[0].role, 'user', 'first message carries the recap');
  assert.ok(String(next[0].content).includes('SUMMARY'));
});

test('buildCompactedHistory keeps the tail verbatim', () => {
  const h = transcript(6, { big: 2000 });
  const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: 2 });
  const next = C.buildCompactedHistory(h, plan, 'S');
  const tail = h.slice(plan.cutIndex);
  // The recap is merged into the first kept turn, so everything AFTER it is
  // byte-identical to the original tail.
  assert.deepEqual(next.slice(1), tail.slice(1), 'subsequent turns must be untouched');
  assert.ok(String(next[0].content).includes(String(tail[0].content)),
    'the first kept turn must survive inside the merged turn');
});

// A standalone recap turn would sit next to the tail's first user message,
// producing two consecutive `user` messages — legal in the schema but merged or
// rejected inconsistently by gateways. The recap is merged instead.
test('recap is merged into the first kept user turn, not added as a second one', () => {
  const h = transcript(8, { big: 3000 });
  const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: 2 });
  const next = C.buildCompactedHistory(h, plan, 'RECAP');
  eq(next[0].role, 'user');
  assert.ok(String(next[0].content).startsWith('[Earlier conversation compacted'));
  for (let i = 1; i < next.length; i++) {
    assert.ok(!(next[i].role === 'user' && next[i - 1].role === 'user'),
      `two consecutive user turns at index ${i}`);
  }
  assertNoOrphanTools(next, 'merged');
});

test('a pinned assistant turn carrying tool_calls is NOT re-inserted (would orphan its results)', () => {
  const h = transcript(8, { big: 3000 });
  // Pin an assistant message that has tool_calls — its tool results are in the
  // dropped range, so keeping it would produce an invalid transcript.
  h[1]._pinned = true;
  const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: 2 });
  assert.ok(plan && plan.pinned.length === 1);
  const next = C.buildCompactedHistory(h, plan, 'S');
  assertNoOrphanTools(next, 'pinned-toolcalls');
  assert.ok(!next.some(m => m._pinned && Array.isArray(m.tool_calls)),
    'a pinned tool-calling assistant turn must be dropped rather than orphaned');
});

// ── Pinned messages ──────────────────────────────────
test('pinned messages from the dropped range survive compaction', () => {
  const h = transcript(8, { big: 3000 });
  // h[3] is the first turn's final assistant message (no tool_calls), so it is
  // safe to re-insert on its own.
  h[3]._pinned = true;
  const plan = C.planCompaction(h, { contextTokens: 1500, threshold: 0.5, keepTurns: 2 });
  assert.ok(plan, 'expected a plan');
  eq(plan.pinned.length, 1);
  const next = C.buildCompactedHistory(h, plan, 'S');
  assert.ok(next.some(m => m._pinned === true), 'pinned message must still be present');
  // recap is merged into the first kept turn, so the pinned turn follows it
  eq(next[1]._pinned, true);
});

// ── Guards ───────────────────────────────────────────
test('planCompaction refuses a cut that would not meaningfully help', () => {
  // Threshold just barely crossed, but almost everything is in the kept tail.
  const h = transcript(2, { big: 100 });
  eq(C.planCompaction(h, { contextTokens: 300, threshold: 0.1, keepTurns: 1 }), null);
});

test('force bypasses the threshold but still needs enough droppable turns', () => {
  const h = transcript(6);
  const plan = C.planCompaction(h, { contextTokens: 10_000_000, force: true, keepTurns: 2 });
  assert.ok(plan, 'force should compact a small-but-long-enough transcript');
  const tooShort = transcript(1);
  eq(C.planCompaction(tooShort, { contextTokens: 10_000_000, force: true, keepTurns: 2 }), null);
});

test('planCompaction tolerates empty / malformed history', () => {
  eq(C.planCompaction([], {}), null);
  eq(C.planCompaction(null, {}), null);
  eq(C.planCompaction([{ role: 'user', content: 'x' }], { force: true }), null);
});

test('buildCompactedHistory is a no-op without a plan', () => {
  const h = transcript(2);
  eq(C.buildCompactedHistory(h, null, 'x'), h);
  eq(C.buildCompactedHistory(h, { cutIndex: 0 }, 'x'), h);
});

// ── Fallback summary ─────────────────────────────────
test('fallbackSummary preserves user intent and tool names', () => {
  const h = transcript(4);
  const plan = C.planCompaction(h, { contextTokens: 10_000_000, force: true, keepTurns: 1 });
  const s = C.fallbackSummary(h, plan);
  assert.match(s, /request 0/, 'earlier user requests should appear');
  assert.match(s, /page_eval/, 'tools used should appear');
});

test('summarisePrompt includes the dropped conversation and the constraints', () => {
  const h = transcript(4);
  const plan = C.planCompaction(h, { contextTokens: 10_000_000, force: true, keepTurns: 1 });
  const p = C.summarisePrompt(h, plan);
  assert.match(p, /RULED OUT/i);
  assert.match(p, /request 0/);
  assert.match(p, /CONVERSATION/);
});

// ── Retryability (drives model fallback) ─────────────
test('isRetryableError classifies transient failures as retryable', () => {
  for (const m of [
    'HTTP 429 Too Many Requests',
    'HTTP 503',
    'rate limited by upstream provider (openai)',
    'stream error [provider_error]: Provider disconnected unexpectedly',
    'This model\'s maximum context length is 128000 tokens',
    'fetch failed',
    'job timed out after 5000ms'
  ]) {
    eq(C.isRetryableError(m), true, `expected retryable: ${m}`);
  }
});

test('isRetryableError does not retry auth or quota failures', () => {
  for (const m of [
    'HTTP 401 Unauthorized',
    'No API key configured for OpenRouter.',
    'OpenRouter rejected the key — check it at openrouter.ai/keys.',
    'Payment required (402) — top up your OpenRouter balance.',
    'OpenCode Go refused this model (403)'
  ]) {
    eq(C.isRetryableError(m), false, `expected NOT retryable: ${m}`);
  }
});

// ── Fallback chain parsing ───────────────────────────
// Provider ids contain '-' and model ids contain '/', so the FIRST colon is
// the separator. Getting this wrong silently disables the fallback chain.
test('parseFallbackChain parses provider:model lines', () => {
  const out = C.parseFallbackChain(
    'openrouter:openai/gpt-4o-mini\nopencode-go:glm-5.3'
  );
  assert.deepEqual(out, [
    { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    { provider: 'opencode-go', model: 'glm-5.3' }
  ]);
});

test('parseFallbackChain keeps the colon inside a model id', () => {
  const out = C.parseFallbackChain('openrouter:meta-llama/llama-3.3-70b-instruct:free');
  eq(out[0].provider, 'openrouter');
  eq(out[0].model, 'meta-llama/llama-3.3-70b-instruct:free');
});

test('parseFallbackChain ignores blanks, comments, duplicates and junk', () => {
  const out = C.parseFallbackChain([
    '',
    '   ',
    '# a comment',
    'no-colon-here',
    ':missing-provider',
    'missing-model:',
    'openrouter:openai/gpt-4o-mini',
    '  openrouter:openai/gpt-4o-mini  ',
    'deepseek:deepseek-chat'
  ]);
  assert.deepEqual(out, [
    { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    { provider: 'deepseek', model: 'deepseek-chat' }
  ]);
});

test('parseFallbackChain tolerates non-string input', () => {
  assert.deepEqual(C.parseFallbackChain(null), []);
  assert.deepEqual(C.parseFallbackChain(undefined), []);
  assert.deepEqual(C.parseFallbackChain(''), []);
});
