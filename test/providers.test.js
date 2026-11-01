// Tests for sidepanel/providers.js — the pure provider layer.
//
// providers.js is deliberately free of chrome.* and DOM access so it can be
// driven from node inside a VM sandbox. Everything asserted here is logic that
// silently breaks the agent in production if it regresses: model-id suffix
// handling, OpenRouter request extras, OpenCode Go session headers, reasoning
// passthrough for multi-turn tool loops, in-band stream errors, usage/cost
// normalisation and catalogue parsing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'providers.js'), 'utf-8');

// Run in THIS realm (not a fresh vm context) so the objects providers.js
// returns share the test's Object/Array prototypes — otherwise
// assert.deepEqual fails with "same structure but not reference-equal".
function load() {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevWindow = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/providers.js' });
    return globalThis.KyotoProviders;
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
}

const P = load();
const eq = assert.equal;
const deq = assert.deepEqual;

// ── Model id suffixes ─────────────────────────────────
// Catalog variants are real entries with their own pricing; routing variants
// are request-time toggles. Confusing the two silently sends a model id that
// does not exist, or resolves :free to the paid entry with wrong limits.
test('splitModelId: catalog variants are preserved', () => {
  deq(P.splitModelId('deepseek/deepseek-r1:free'), { catalogId: 'deepseek/deepseek-r1:free', routing: [] });
  deq(P.splitModelId('openai/gpt-5:batch'), { catalogId: 'openai/gpt-5:batch', routing: [] });
});

test('splitModelId: routing variants are stripped from the lookup id', () => {
  deq(P.splitModelId('openai/gpt-5.2:nitro'), { catalogId: 'openai/gpt-5.2', routing: [':nitro'] });
  deq(P.splitModelId('openai/gpt-5.2:nitro:exacto'), {
    catalogId: 'openai/gpt-5.2',
    routing: [':nitro', ':exacto']
  });
});

test('splitModelId: dead variants are dropped entirely', () => {
  deq(P.splitModelId('openai/gpt-5:extended'), { catalogId: 'openai/gpt-5', routing: [] });
  deq(P.splitModelId('openai/gpt-5:online'), { catalogId: 'openai/gpt-5', routing: [] });
});

test('splitModelId: plain and vendor-prefixed ids pass through', () => {
  deq(P.splitModelId('anthropic/claude-haiku-5.5'), { catalogId: 'anthropic/claude-haiku-5.5', routing: [] });
  deq(P.splitModelId(''), { catalogId: '', routing: [] });
});

test('orRequestModelId: appends the settings variant to the catalog id', () => {
  eq(P.orRequestModelId('openai/gpt-5.2', { orVariant: ':exacto' }), 'openai/gpt-5.2:exacto');
  // catalog suffix survives, routing variant is added after it
  eq(P.orRequestModelId('deepseek/deepseek-r1:free', { orVariant: ':nitro' }), 'deepseek/deepseek-r1:free:nitro');
  // no variant configured -> untouched
  eq(P.orRequestModelId('openai/gpt-5.2', {}), 'openai/gpt-5.2');
  // junk variant is ignored rather than forwarded
  eq(P.orRequestModelId('openai/gpt-5.2', { orVariant: ':bogus' }), 'openai/gpt-5.2');
});

// ── OpenRouter request extras ────────────────────────
test('orBuildExtras: sets require_parameters when tools are present', () => {
  // Without this OpenRouter silently drops `tools` when no provider supports
  // them, and the agent quietly loses its hands.
  const x = P.orBuildExtras({ settings: {}, hasTools: true });
  eq(x.provider.require_parameters, true);
});

test('orBuildExtras: omits provider object entirely when nothing is configured', () => {
  const x = P.orBuildExtras({ settings: {}, hasTools: false });
  eq(x.provider, undefined);
  eq(x.reasoning, undefined);
});

test('orBuildExtras: forwards routing prefs', () => {
  const x = P.orBuildExtras({
    settings: { orSort: 'price', orDataCollection: 'deny', orAllowFallbacks: false },
    hasTools: false
  });
  eq(x.provider.sort, 'price');
  eq(x.provider.data_collection, 'deny');
  eq(x.provider.allow_fallbacks, false);
});

test('orBuildExtras: unknown sort is not forwarded', () => {
  const x = P.orBuildExtras({ settings: { orSort: 'bogus' }, hasTools: true });
  eq(x.provider.sort, undefined);
  eq(x.provider.require_parameters, true);
});

test('orBuildExtras: reasoning effort is sent as reasoning.effort', () => {
  eq(P.orBuildExtras({ settings: { orReasoningEffort: 'high' } }).reasoning.effort, 'high');
  // invalid / empty effort means "don't send the param"
  eq(P.orBuildExtras({ settings: { orReasoningEffort: 'turbo' } }).reasoning, undefined);
  eq(P.orBuildExtras({ settings: {} }).reasoning, undefined);
});

// ── OpenRouter catalogue parsing ─────────────────────
function orModel(over) {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    context_length: 1000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    top_provider: { max_completion_tokens: 500 },
    supported_parameters: ['tools'],
    pricing: { prompt: '0.000001', completion: '0.000002' },
    ...over
  };
}

test('orParseModels: drops models that cannot return text', () => {
  const list = P.orParseModels({
    data: [
      orModel({ id: 'google/gemini-image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
      orModel({ id: 'openai/gpt-5' })
    ]
  });
  deq(list.map((m) => m.id), ['openai/gpt-5']);
});

test('orParseModels: reads tools, vision, limits and pricing', () => {
  const [m] = P.orParseModels({
    data: [orModel({
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'structured_outputs'],
      context_length: 200000,
      top_provider: { max_completion_tokens: 64000 }
    })]
  });
  eq(m.supportsTools, true);
  eq(m.vision, true);
  eq(m.supportsStructuredOutputs, true);
  eq(m.context, 200000);
  eq(m.maxOutput, 64000);
  // pricing stays per-token (OpenRouter's native unit)
  eq(m.pricing.prompt, 0.000001);
});

test('orParseModels: falls back to context when max_completion_tokens is null', () => {
  const [m] = P.orParseModels({ data: [orModel({ top_provider: { max_completion_tokens: null } })] });
  assert.ok(m.maxOutput > 0, 'maxOutput should still be a usable number');
});

test('orParseModels: never offers dead catalog variants', () => {
  const list = P.orParseModels({ data: [orModel({ id: 'x/y:extended' }), orModel({ id: 'x/y:thinking' })] });
  deq(list, []);
});

test('orParseModels: keeps :free as a selectable model', () => {
  const list = P.orParseModels({ data: [orModel({ id: 'deepseek/deepseek-r1:free' })] });
  eq(list[0].id, 'deepseek/deepseek-r1:free');
});

test('orParseModels: surfaces reasoning metadata', () => {
  const [m] = P.orParseModels({
    data: [orModel({
      reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['low', 'high'], default_effort: 'low', supports_max_tokens: true }
    })]
  });
  eq(m.reasoning.supported, true);
  eq(m.reasoning.mandatory, true);
  deq(m.reasoning.efforts, ['low', 'high']);
  eq(m.reasoning.defaultEffort, 'low');
  eq(m.reasoning.supportsMaxTokens, true);
});

test('orParseModels: tolerates a malformed payload', () => {
  deq(P.orParseModels(null), []);
  deq(P.orParseModels({}), []);
});

// ── OpenCode Go ──────────────────────────────────────
test('ocgoSessionId: deterministic per session and shaped like ses_…', () => {
  const a = P.ocgoSessionId({ id: 'sess-abc' });
  const b = P.ocgoSessionId({ id: 'sess-abc' });
  const c = P.ocgoSessionId({ id: 'sess-xyz' });
  // Stability matters: a new id per turn would defeat the gateway's
  // per-conversation accounting.
  eq(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^ses_[A-Za-z0-9]+$/);
});

test('ocgoParseModels: reads capabilities, limits and per-million pricing', () => {
  const [m] = P.ocgoParseModels({
    data: [{
      id: 'glm-5.3',
      name: 'GLM-5.3',
      family: 'glm',
      canonical_id: 'zhipuai/glm-5.3',
      modalities: { input: ['text'], output: ['text'] },
      capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high'] }, structured_output: true },
      limit: { context: 1000000, output: 131072 },
      cost: { text: { input: { price: 1.4 }, output: { price: 4.4 } } }
    }]
  });
  eq(m.id, 'glm-5.3');
  eq(m.supportsTools, true);
  eq(m.supportsStructuredOutputs, true);
  eq(m.context, 1000000);
  eq(m.maxOutput, 131072);
  deq(m.reasoning.efforts, ['low', 'high']);
  // Go quotes USD per million tokens; we normalise to per-token so the shared
  // cost maths matches OpenRouter.
  eq(m.pricing.prompt, 1.4 / 1_000_000);
  eq(m.pricing.completion, 4.4 / 1_000_000);
});

test('ocgoParseModels: tolerates a malformed payload', () => {
  deq(P.ocgoParseModels(null), []);
  deq(P.ocgoParseModels({ data: [{}] }), []);
});

// ── Stream reduction ─────────────────────────────────
function acc() {
  return { text: '', reasoningText: '', reasoningField: null, reasoningDetails: [], sawDetails: false, toolBuf: [] };
}

test('reduceDelta: accumulates text', () => {
  const a = acc();
  eq(P.reduceDelta(a, { content: 'Hel' }).textChunk, 'Hel');
  eq(P.reduceDelta(a, { content: 'lo' }).textChunk, 'lo');
  eq(a.text, 'Hello');
});

test('reduceDelta: captures reasoning_content (OpenCode Go / DeepSeek)', () => {
  const a = acc();
  P.reduceDelta(a, { reasoning_content: 'think' });
  eq(a.reasoningField, 'reasoning_content');
  eq(a.reasoningText, 'think');
});

test('reduceDelta: captures reasoning_details and merges by index', () => {
  const a = acc();
  P.reduceDelta(a, { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'ab' }] });
  P.reduceDelta(a, { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'abcd' }] });
  P.reduceDelta(a, { reasoning_details: [{ type: 'reasoning.summary', index: 1, summary: 'done' }] });
  eq(a.reasoningDetails.length, 2, 'same index must replace, not duplicate');
  eq(a.reasoningDetails[0].text, 'abcd');
  eq(a.reasoningDetails[1].index, 1);
});

test('reduceDelta: does not double-render when both channels carry reasoning', () => {
  const a = acc();
  const out = P.reduceDelta(a, {
    reasoning: 'same text',
    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'same text' }]
  });
  // Only the details-derived text is shown, otherwise the card shows it twice.
  eq(out.reasoningChunk, 'same text');
  const out2 = P.reduceDelta(a, { reasoning: 'more' });
  eq(out2, null);
});

test('reduceDelta: concatenates tool-call argument fragments', () => {
  const a = acc();
  P.reduceDelta(a, { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'nav', arguments: '{"u"' } }] });
  P.reduceDelta(a, { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] });
  eq(a.toolBuf[0].id, 'call_1');
  eq(a.toolBuf[0].function.name, 'nav');
  eq(a.toolBuf[0].function.arguments, '{"u":"x"}');
});

test('reduceDelta: tolerates junk', () => {
  const a = acc();
  eq(P.reduceDelta(a, null), null);
  eq(P.reduceDelta(a, {}), null);
});

// ── Reasoning echo ───────────────────────────────────
test('reasoningEchoFields: prefers reasoning_details over the string form', () => {
  const a = acc();
  a.reasoningText = 'plain';
  a.reasoningField = 'reasoning';
  a.reasoningDetails = [{ type: 'reasoning.encrypted', index: 0, data: 'sig' }];
  const echo = P.reasoningEchoFields(a);
  deq(Object.keys(echo), ['reasoning_details']);
  deq(echo.reasoning_details, a.reasoningDetails);
});

test('reasoningEchoFields: falls back to the provider field name', () => {
  const a = acc();
  a.reasoningText = 'plain';
  a.reasoningField = 'reasoning_content';
  deq(P.reasoningEchoFields(a), { reasoning_content: 'plain' });
});

test('reasoningEchoFields: empty accumulator echoes nothing', () => {
  deq(P.reasoningEchoFields(acc()), {});
});

// ── SSE helpers ──────────────────────────────────────
test('isSseComment: detects keep-alive comments', () => {
  eq(P.isSseComment(': OPENROUTER PROCESSING'), true);
  eq(P.isSseComment('  : keep-alive'), true);
  eq(P.isSseComment('data: {}'), false);
  eq(P.isSseComment(''), false);
});

test('streamError: detects a top-level in-band error', () => {
  const e = P.streamError({
    error: { code: 500, message: 'Provider disconnected', metadata: { error_type: 'provider_error', provider_code: 'up' } },
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }]
  });
  eq(e.message, 'Provider disconnected');
  eq(e.errorType, 'provider_error');
  eq(e.providerCode, 'up');
});

test('streamError: detects finish_reason=error without a body error', () => {
  const e = P.streamError({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
  assert.ok(e && /finish_reason/.test(e.message));
});

test('streamError: a normal chunk is not an error', () => {
  eq(P.streamError({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }), null);
  eq(P.streamError(null), null);
});

// ── Usage / cost ─────────────────────────────────────
test('normaliseUsage: reads cost (not total_cost) and token details', () => {
  const u = P.normaliseUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: 0.002,
    prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 2 }
  });
  eq(u.cost, 0.002);
  eq(u.cached_tokens, 4);
  eq(u.cache_write_tokens, 1);
  eq(u.reasoning_tokens, 2);
  eq(u.total_tokens, 15);
});

test('normaliseUsage: surfaces OpenCode Go billing fields', () => {
  const u = P.normaliseUsage({
    prompt_tokens: 1, completion_tokens: 1, cost: 0.5,
    opencode: { billing_source: 'go', allowance: 0.5 }
  });
  eq(u.billing_source, 'go');
  eq(u.allowance, 0.5);
});

test('normaliseUsage: derives total when absent', () => {
  eq(P.normaliseUsage({ prompt_tokens: 3, completion_tokens: 4 }).total_tokens, 7);
  eq(P.normaliseUsage(null), null);
});

// ── Failure decoding ─────────────────────────────────
test('orDescribeFailure: explains 402 by limit_source', () => {
  const m = P.orDescribeFailure({
    status: 402,
    body: { error: { message: 'budget', metadata: { limit_source: 'openrouter_in_flight_budget' } } }
  });
  assert.match(m, /in-flight budget/i);
});

test('orDescribeFailure: names the 401 causes distinctly', () => {
  assert.match(P.orDescribeFailure({ status: 401, body: { error: { message: 'No cookie auth credentials found' } } }), /No API key/i);
  assert.match(P.orDescribeFailure({ status: 401, body: { error: { message: 'User not found.' } } }), /rejected the key/i);
});

test('orDescribeFailure: attributes 429 to the upstream provider when known', () => {
  const m = P.orDescribeFailure({
    status: 429,
    body: { error: { message: 'slow down', metadata: { provider_code: 'openai' } } }
  });
  assert.match(m, /upstream provider \(openai\)/);
});

test('orDescribeFailure: 403 points at the free-model training toggle', () => {
  const m = P.orDescribeFailure({ status: 403, body: { error: { message: 'blocked' } } });
  assert.match(m, /allow training/i);
  // A limit_source turns it into a budget/guardrail message instead.
  const g = P.orDescribeFailure({ status: 403, body: { error: { message: 'x', metadata: { limit_source: 'guardrail' } } } });
  assert.match(g, /guardrail/i);
});

test('ocgoDescribeFailure: 401/403/429 get provider-specific copy', () => {
  assert.match(P.ocgoDescribeFailure({ status: 401, body: {} }), /opencode\.ai\/console/);
  assert.match(P.ocgoDescribeFailure({ status: 403, body: {} }), /free-tier/i);
  assert.match(P.ocgoDescribeFailure({ status: 429, body: {} }), /rate limited/i);
});

// ── Provider wiring ──────────────────────────────────
test('OpenRouter definition: endpoints, headers and attribution', () => {
  const or = P.openrouter;
  eq(or.chatUrl, 'https://openrouter.ai/api/v1/chat/completions');
  eq(or.modelsUrl, 'https://openrouter.ai/api/v1/models');
  const h = or.headers('sk-or-v1-x');
  eq(h.Authorization, 'Bearer sk-or-v1-x');
  // Attribution: HTTP-Referer is what registers the app; both title spellings
  // are accepted by the API.
  eq(h['HTTP-Referer'], 'https://github.com/ankit-pn/kyoto');
  assert.ok(h['X-Title']);
  assert.ok(h['X-OpenRouter-Title']);
});

test('OpenCode Go definition: base paths, session header and public catalogue', () => {
  const go = P.opencodeGo;
  eq(go.chatUrl, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  // The catalogue is NOT under the /openai/v1 prefix — an SDK that appends
  // /models to the chat base would 404 here.
  eq(go.modelsUrl, 'https://opencode.ai/inference/go/v1/models');
  eq(go.publicModels, true);
  eq(go.requiresSession, true);
  const h = go.headers('oc_sk_x', { sessionId: 'ses_abc' });
  eq(h.Authorization, 'Bearer oc_sk_x');
  // Omitting this header makes the gateway return 400 MissingSessionID
  // before credentials are even checked.
  eq(h['x-opencode-session'], 'ses_abc');
  assert.ok(go.headers('k')['x-opencode-session'], 'a session header is always present');
});
