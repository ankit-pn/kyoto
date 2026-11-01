// Tests for sidepanel/council-core.js — the multi-model comparison helpers.
//
// Two things must not regress:
//
// 1. ORDER. mergeResults() must return rows aligned to `candidates`, no matter
//    which model answered first. A council view that reorders itself by
//    completion time makes the same conversation jump around while answers
//    stream in, and can silently promote a failed model to the top.
// 2. RANKING. rank() is the ONLY reordering, and it is a total order: answered
//    before failed, cheaper before dearer, faster before slower, unknown values
//    last, ties stable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'sidepanel', 'council-core.js'),
  'utf-8'
);

// Same-realm load so deepEqual sees shared prototypes.
function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/council-core.js' });
    return globalThis.KyotoCouncil;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const C = load();
const eq = assert.equal;

// ── Fixtures ─────────────────────────────────────────
function candidates() {
  return [
    { provider: 'openrouter', model: 'openai/gpt-4o-mini', label: 'gpt-4o-mini' },
    { provider: 'opencode-go', model: 'glm-5.3', label: 'glm-5.3' },
    { provider: 'deepseek', model: 'deepseek-chat', label: 'deepseek-chat' }
  ];
}

// ── sanitiseCandidates ───────────────────────────────
test('sanitiseCandidates tolerates null / junk input', () => {
  assert.deepEqual(C.sanitiseCandidates(null), []);
  assert.deepEqual(C.sanitiseCandidates(undefined), []);
  assert.deepEqual(C.sanitiseCandidates('nope'), []);
  assert.deepEqual(C.sanitiseCandidates({}), []);
  assert.deepEqual(C.sanitiseCandidates([null, 'x', 42, [], undefined]), []);
});

test('sanitiseCandidates drops entries without a usable provider AND model', () => {
  const out = C.sanitiseCandidates([
    { provider: 'openrouter', model: 'a' },          // ok
    { provider: '', model: 'b' },                    // no provider
    { provider: 'x', model: '   ' },                 // blank model
    { provider: 7, model: 'c' },                     // non-string provider
    { model: 'd' },                                  // missing provider
    { provider: 'y' },                               // missing model
    null,
    'junk',
    { provider: 'deepseek', model: 'deepseek-chat' } // ok
  ]);
  eq(out.length, 2);
  eq(out[0].provider, 'openrouter');
  eq(out[1].provider, 'deepseek');
});

test('sanitiseCandidates dedupes by provider:model, keeping the first', () => {
  const out = C.sanitiseCandidates([
    { provider: 'openrouter', model: 'm1', label: 'first' },
    { provider: 'openrouter', model: 'm1', label: 'dupe' },
    { provider: 'deepseek', model: 'm1', label: 'other provider' },
    { provider: ' openrouter ', model: ' m1 ', label: 'trimmed dupe' }
  ]);
  eq(out.length, 2);
  eq(out[0].label, 'first', 'first occurrence wins');
  eq(out[1].provider, 'deepseek', 'same model id on another provider is distinct');
});

test('sanitiseCandidates trims fields and falls back label -> model id', () => {
  const out = C.sanitiseCandidates([
    { provider: '  openrouter  ', model: '  openai/gpt-4o-mini  ' },
    { provider: 'deepseek', model: 'deepseek-chat', label: '   ' }
  ]);
  eq(out[0].provider, 'openrouter');
  eq(out[0].model, 'openai/gpt-4o-mini');
  eq(out[0].label, 'openai/gpt-4o-mini', 'missing label falls back to model');
  eq(out[1].label, 'deepseek-chat', 'blank label falls back to model');
});

test('sanitiseCandidates caps at the default limit of 4', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ provider: 'p', model: `m${i}` }));
  eq(C.sanitiseCandidates(many).length, 4);
});

test('sanitiseCandidates honours an explicit limit and ignores junk limits', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ provider: 'p', model: `m${i}` }));
  eq(C.sanitiseCandidates(many, { limit: 2 }).length, 2);
  eq(C.sanitiseCandidates(many, { limit: 1 }).length, 1);
  eq(C.sanitiseCandidates(many, { limit: 0 }).length, 4, 'invalid limit falls back to default');
  eq(C.sanitiseCandidates(many, { limit: -3 }).length, 4);
  eq(C.sanitiseCandidates(many, { limit: 'x' }).length, 4);
  eq(C.sanitiseCandidates(many, { limit: 2.9 }).length, 2, 'fractional limits floor');
});

test('sanitiseCandidates returns exactly provider/model/label and never mutates input', () => {
  const input = [{ provider: 'p', model: 'm', label: 'L', extra: 'drop me', _cost: 1 }];
  const out = C.sanitiseCandidates(input);
  assert.deepEqual(Object.keys(out[0]).sort(), ['label', 'model', 'provider']);
  eq(out[0].extra, undefined);
  eq(out[0]._cost, undefined);
  eq(input[0].extra, 'drop me', 'input untouched');
});

// ── mergeResults: ordering ───────────────────────────
test('mergeResults keeps candidate order for aligned results', () => {
  const merged = C.mergeResults(candidates(), [
    { text: 'A', ms: 100, cost: 0.0001 },
    { text: 'B', ms: 200, cost: 0.0002 },
    { text: 'C', ms: 300, cost: 0.0003 }
  ]);
  eq(merged.length, 3);
  assert.deepEqual(merged.map(m => m.text), ['A', 'B', 'C']);
  assert.deepEqual(merged.map(m => m.label), ['gpt-4o-mini', 'glm-5.3', 'deepseek-chat']);
});

// THE invariant: results that arrive out of completion order must still land in
// their candidate's column. Identity (provider+model) is what makes that safe.
test('mergeResults places identity-tagged results back into candidate order', () => {
  const merged = C.mergeResults(candidates(), [
    // finished 3rd
    { provider: 'deepseek', model: 'deepseek-chat', text: 'C', ms: 900 },
    // finished 1st
    { provider: 'openrouter', model: 'openai/gpt-4o-mini', text: 'A', ms: 100 },
    // finished 2nd
    { provider: 'opencode-go', model: 'glm-5.3', text: 'B', ms: 500 }
  ]);
  assert.deepEqual(merged.map(m => m.text), ['A', 'B', 'C']);
  assert.deepEqual(merged.map(m => m.provider), ['openrouter', 'opencode-go', 'deepseek']);
  assert.deepEqual(merged.map(m => m.ms), [100, 500, 900]);
});

test('mergeResults routes by label when provider/model are absent', () => {
  const merged = C.mergeResults(candidates(), [
    { label: 'glm-5.3', text: 'B' },
    { label: 'gpt-4o-mini', text: 'A' }
  ]);
  assert.deepEqual(merged.map(m => m.text), ['A', 'B', '']);
  eq(merged[2].ok, false, 'the unlabelled/unsupplied candidate is a failed row');
});

// Out-of-order completions may arrive as settled wrappers with the identity on
// the WRAPPER (the value is just the text/usage). A failed model must still land
// in its own column, not be pushed into whichever slot is free.
test('mergeResults routes settled wrappers by identity on the wrapper', () => {
  const settled = [
    { status: 'rejected', reason: new Error('deepseek timed out'), provider: 'deepseek', model: 'deepseek-chat' },
    { status: 'fulfilled', provider: 'opencode-go', model: 'glm-5.3', value: { text: 'B', ms: 500 } },
    { status: 'fulfilled', provider: 'openrouter', model: 'openai/gpt-4o-mini', value: { text: 'A', ms: 100 } }
  ];
  const merged = C.mergeResults(candidates(), settled);
  assert.deepEqual(merged.map(m => m.label), ['gpt-4o-mini', 'glm-5.3', 'deepseek-chat']);
  eq(merged[0].text, 'A');
  eq(merged[1].text, 'B');
  eq(merged[2].ok, false);
  assert.match(merged[2].error, /timed out/, 'the failure lands in the right column');
});

test('mergeResults keeps positional fill for identity-less settled arrays', () => {
  const settled = [
    { status: 'fulfilled', value: { text: 'A', ms: 10, cost: 0.001 } },
    { status: 'rejected', reason: new Error('HTTP 429 from upstream') },
    { status: 'fulfilled', value: { text: 'C', ms: 30, cost: 0.003 } }
  ];
  const merged = C.mergeResults(candidates(), settled);
  eq(merged.length, 3);
  eq(merged[0].ok, true);
  eq(merged[0].text, 'A');
  eq(merged[1].ok, false);
  assert.match(merged[1].error, /429/);
  eq(merged[2].text, 'C');
});

// ── mergeResults: normalisation ──────────────────────
test('mergeResults normalises settled fulfilled/rejected entries', () => {
  const merged = C.mergeResults(
    [{ provider: 'p', model: 'm', label: 'm' }],
    [{ status: 'rejected', reason: 'connection reset' }]
  );
  eq(merged.length, 1);
  eq(merged[0].ok, false);
  eq(merged[0].error, 'connection reset', 'rejected -> ok:false + message string');
});

test('mergeResults turns Error / object / missing reasons into a message string', () => {
  const asError = C.mergeResults([{ provider: 'p', model: 'm' }], [{ status: 'rejected', reason: new Error('boom') }]);
  eq(asError[0].error, 'boom');

  const asObject = C.mergeResults([{ provider: 'p', model: 'm' }], [{ status: 'rejected', reason: { message: 'nested boom' } }]);
  eq(asObject[0].error, 'nested boom');

  const asNothing = C.mergeResults([{ provider: 'p', model: 'm' }], [{ status: 'rejected' }]);
  eq(typeof asNothing[0].error, 'string');
  assert.ok(asNothing[0].error.length > 0, 'error must never be an empty string');
});

test('mergeResults handles plain {ok:false, error} results and string results', () => {
  const merged = C.mergeResults(
    [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
    [{ ok: false, error: 'model refused' }, 'plain string answer']
  );
  eq(merged[0].ok, false);
  eq(merged[0].error, 'model refused');
  eq(merged[1].ok, true);
  eq(merged[1].text, 'plain string answer');
});

test('mergeResults emits a failed row for a missing result (never drops the candidate)', () => {
  const merged = C.mergeResults(candidates(), [{ text: 'A' }]);
  eq(merged.length, 3, 'all candidates keep a column');
  eq(merged[0].ok, true);
  eq(merged[1].ok, false);
  eq(merged[2].ok, false);
  assert.match(merged[1].error, /no result/i);
  eq(merged[1].text, '');
});

test('mergeResults ignores extra results beyond the candidate list', () => {
  const merged = C.mergeResults(
    [{ provider: 'p', model: 'a' }],
    [{ text: 'A' }, { text: 'extra one' }, { text: 'extra two' }]
  );
  eq(merged.length, 1);
  eq(merged[0].text, 'A');
});

test('mergeResults returns exactly the documented row shape', () => {
  const merged = C.mergeResults(candidates(), [{ text: 'A' }]);
  assert.deepEqual(
    Object.keys(merged[0]).sort(),
    ['cost', 'error', 'label', 'model', 'ms', 'ok', 'provider', 'text', 'usage']
  );
  eq(merged[0].usage, null);
  eq(merged[0].cost, null);
  eq(merged[0].ms, null);
});

test('mergeResults normalises ms/cost/usage and accepts the _cost/_usage house aliases', () => {
  const merged = C.mergeResults(
    [
      { provider: 'p', model: 'a' }, { provider: 'p', model: 'b' },
      { provider: 'p', model: 'c' }, { provider: 'p', model: 'd' }
    ],
    [
      { text: 'A', ms: 250, cost: 0.0012, usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { text: 'B', ms: 'fast', cost: 'cheap', usage: 'nope' },
      { text: 'C', ms: NaN, _cost: 0.0005, _usage: { total_tokens: 3 } },
      { text: 'D', cost: -1 }
    ]
  );
  eq(merged[0].ms, 250);
  eq(merged[0].cost, 0.0012);
  assert.deepEqual(merged[0].usage, { prompt_tokens: 10, completion_tokens: 5 });

  eq(merged[1].ms, null, 'non-number ms -> null');
  eq(merged[1].cost, null, 'non-number cost -> null');
  eq(merged[1].usage, null, 'non-object usage -> null');

  eq(merged[2].ms, null, 'NaN ms -> null');
  eq(merged[2].cost, 0.0005, '_cost is the house alias for cost');
  assert.deepEqual(merged[2].usage, { total_tokens: 3 }, '_usage is the house alias for usage');

  eq(merged[3].cost, -1, 'a finite negative cost passes through; rank() treats it as unknown');
  eq(merged[3].ms, null);
});

test('mergeResults tolerates null candidates / results without throwing', () => {
  assert.deepEqual(C.mergeResults(null, null), []);
  assert.deepEqual(C.mergeResults(undefined, []), []);
  assert.deepEqual(C.mergeResults([], [{ text: 'x' }]), []);
  const merged = C.mergeResults([{ provider: 'p', model: 'm' }], null);
  eq(merged.length, 1);
  eq(merged[0].ok, false);
});

// ── rank ─────────────────────────────────────────────
test('rank puts answered rows before failed ones', () => {
  const merged = [
    { label: 'failed', ok: false, cost: 0.0001, ms: 10 },
    { label: 'answered', ok: true, cost: 0.9, ms: 9000 }
  ];
  assert.deepEqual(C.rank(merged).map(m => m.label), ['answered', 'failed']);
});

test('rank orders by cost ascending, with unknown cost last', () => {
  const merged = [
    { label: 'pricy', ok: true, cost: 0.01, ms: 10 },
    { label: 'free', ok: true, cost: 0, ms: 10 },
    { label: 'unknown', ok: true, cost: null, ms: 10 },
    { label: 'cheap', ok: true, cost: 0.001, ms: 10 }
  ];
  assert.deepEqual(C.rank(merged).map(m => m.label), ['free', 'cheap', 'pricy', 'unknown']);
});

test('rank falls back to ms ascending, with unknown ms last', () => {
  const merged = [
    { label: 'slow', ok: true, cost: 0.001, ms: 900 },
    { label: 'unknown', ok: true, cost: 0.001, ms: null },
    { label: 'fast', ok: true, cost: 0.001, ms: 90 }
  ];
  assert.deepEqual(C.rank(merged).map(m => m.label), ['fast', 'slow', 'unknown']);
});

test('rank is stable for fully-tied rows (original order preserved)', () => {
  const merged = [
    { label: 'first', ok: true, cost: 0.001, ms: 100 },
    { label: 'second', ok: true, cost: 0.001, ms: 100 },
    { label: 'third', ok: true, cost: 0.001, ms: 100 }
  ];
  assert.deepEqual(C.rank(merged).map(m => m.label), ['first', 'second', 'third']);
});

test('rank returns a NEW array and does not mutate the input', () => {
  const merged = [
    { label: 'failed', ok: false },
    { label: 'ok', ok: true }
  ];
  const snapshot = merged.map(m => m.label);
  const ranked = C.rank(merged);
  assert.notEqual(ranked, merged, 'must be a new array');
  assert.deepEqual(merged.map(m => m.label), snapshot, 'input order untouched');
  assert.deepEqual(ranked.map(m => m.label), ['ok', 'failed']);
});

test('rank tolerates junk rows and non-arrays', () => {
  assert.deepEqual(C.rank(null), []);
  assert.deepEqual(C.rank(undefined), []);
  assert.deepEqual(C.rank([]), []);
  const mixed = [null, { label: 'a', ok: true }, 'junk', { label: 'b', ok: false }];
  const out = C.rank(mixed);
  eq(out.length, 4);
  eq(out[0].label, 'a', 'truthy ok sorts first even with junk around it');
});

// ── formatSummary ────────────────────────────────────
test('formatSummary lists every answered model with label, identity, ms and cost', () => {
  const merged = C.mergeResults(candidates(), [
    { text: 'A', ms: 1240, cost: 0.0012 },
    { text: 'B', ms: 90, cost: 0.0004 },
    { text: 'C', ms: 5000, cost: 0 }
  ]);
  const s = C.formatSummary(merged);
  assert.match(s, /### Council/);
  assert.match(s, /3\/3 answered/);
  assert.match(s, /gpt-4o-mini/);
  assert.match(s, /glm-5\.3/);
  assert.match(s, /deepseek-chat/);
  assert.match(s, /\$0\.0012/, 'cost formatted as $0.0012-ish');
  assert.match(s, /\$0\.0004/);
  assert.match(s, /1240 ms/);
  eq(s.trim().split('\n').filter(l => l.startsWith('- ')).length, 3, 'one bullet per model');
});

test('formatSummary marks failed models with their error and em dashes', () => {
  const merged = C.mergeResults(candidates(), [
    { text: 'fine', ms: 100, cost: 0.0002 },
    { status: 'rejected', reason: 'HTTP 429 Too Many Requests' },
    { text: 'also fine', ms: 200, cost: 0.0003 }
  ]);
  const s = C.formatSummary(merged);
  assert.match(s, /2\/3 answered/);
  assert.match(s, /error: HTTP 429 Too Many Requests/);
  assert.match(s, /—/, 'unknown ms/cost render as an em dash');
});

test('formatSummary does not throw on all-failed, empty or junk input', () => {
  const allFailed = C.mergeResults(candidates(), [
    { status: 'rejected', reason: 'x' },
    { status: 'rejected', reason: 'y' },
    { status: 'rejected', reason: 'z' }
  ]);
  const failedText = C.formatSummary(allFailed);
  eq(typeof failedText, 'string');
  assert.match(failedText, /0\/3 answered/);
  assert.match(failedText, /error: x/);

  const empty = C.formatSummary([]);
  eq(typeof empty, 'string');
  assert.ok(empty.length > 0, 'empty council still renders an explainable summary');

  eq(typeof C.formatSummary(null), 'string');
  eq(typeof C.formatSummary(undefined), 'string');
  const junk = [null, 'nope', { label: 'only label' }];
  eq(typeof C.formatSummary(junk), 'string');
  assert.match(C.formatSummary(junk), /only label/);
});

test('formatSummary keeps one bullet per row even when labels are hostile', () => {
  const merged = C.mergeResults(
    [{ provider: 'p', model: 'm', label: 'bad\n**label**`with` stuff' }],
    [{ text: 'x', ms: 1, cost: 0 }]
  );
  const s = C.formatSummary(merged);
  eq(s.trim().split('\n').filter(l => l.startsWith('- ')).length, 1, 'newlines must not split the bullet');
  assert.ok(!s.includes('**label**'), 'emphasis markers are neutralised');
});
