// Test for _responsesEventToChatLines — the SSE event translator that
// turns OpenAI Responses-API events into Chat-Completions-style delta
// lines so the existing chat reader can consume the stream unchanged.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return src.slice(start, i);
}

const factory = new Function(`${extractFn('_responsesEventToChatLines')}\nreturn _responsesEventToChatLines;`);
const translate = factory();

const newCtx = () => ({
  toolIndex: {}, nextToolIdx: 0, errorMessage: null,
  emittedDeltas: 0, emittedFinish: false, seenEventTypes: new Set(),
});

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got: ${a}\n  exp: ${e}\n`);
}

// 1) Text delta → {choices:[{delta:{content}}]}
{
  const ctx = newCtx();
  const out = translate({ type: 'response.output_text.delta', delta: 'Hello' }, ctx);
  eq(JSON.parse(out[0]), { choices: [{ index: 0, delta: { content: 'Hello' } }] }, '1: text delta');
  eq(ctx.emittedDeltas, 1, '1: emittedDeltas++');
}

// 2) output_text.done as fallback when no deltas were emitted.
{
  const ctx = newCtx();
  const out = translate({ type: 'response.output_text.done', text: 'Full text' }, ctx);
  eq(JSON.parse(out[0]), { choices: [{ index: 0, delta: { content: 'Full text' } }] }, '2: done fallback');
}

// 3) output_text.done is IGNORED when deltas already streamed (avoid duplication).
{
  const ctx = newCtx();
  translate({ type: 'response.output_text.delta', delta: 'Hi' }, ctx);
  const out = translate({ type: 'response.output_text.done', text: 'Hi there' }, ctx);
  eq(out.length, 0, '3: done after delta = noop');
}

// 4) Reasoning delta — all three event-name variants opencode handles.
for (const name of [
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary.delta',
]) {
  const ctx = newCtx();
  const out = translate({ type: name, delta: 'thinking…' }, ctx);
  eq(JSON.parse(out[0]), { choices: [{ index: 0, delta: { reasoning_content: 'thinking…' } }] }, `4: ${name}`);
}

// 5) Function call lifecycle: .added registers id+name, .delta appends args,
//    .completed emits finish_reason:tool_calls.
{
  const ctx = newCtx();
  let out = translate({
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'fs_read', arguments: '' },
  }, ctx);
  eq(JSON.parse(out[0]), {
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '' } }] } }],
  }, '5a: .added');

  out = translate({
    type: 'response.function_call_arguments.delta',
    item_id: 'item_1',
    delta: '{"path":"',
  }, ctx);
  eq(JSON.parse(out[0]), {
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"' } }] } }],
  }, '5b: .delta');

  out = translate({
    type: 'response.function_call_arguments.delta',
    item_id: 'item_1',
    delta: 'a"}',
  }, ctx);
  eq(JSON.parse(out[0]), {
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'a"}' } }] } }],
  }, '5c: .delta append');

  out = translate({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }, ctx);
  const parsed = JSON.parse(out[0]);
  eq(parsed.choices[0].finish_reason, 'tool_calls', '5d: finish_reason');
  eq(parsed.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, '5e: usage');
  eq(out[1], '[DONE]', '5f: terminal');
  eq(ctx.emittedFinish, true, '5g: emittedFinish');
}

// 6) Arguments delta arriving BEFORE the .added event is a no-op
//    (we have no idx to attach it to).
{
  const ctx = newCtx();
  const out = translate({ type: 'response.function_call_arguments.delta', item_id: 'item_X', delta: 'x' }, ctx);
  eq(out.length, 0, '6: orphan delta = noop');
}

// 7) output_item.done with a function_call we haven't seen — register it
//    and emit a single tool_call chunk with the full arguments.
{
  const ctx = newCtx();
  const out = translate({
    type: 'response.output_item.done',
    item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'fs_write', arguments: '{"k":1}' },
  }, ctx);
  eq(JSON.parse(out[0]), {
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'fs_write', arguments: '{"k":1}' } }] } }],
  }, '7: done-only fn call');
}

// 8) response.completed without tools emits finish_reason:stop.
{
  const ctx = newCtx();
  translate({ type: 'response.output_text.delta', delta: 'Hi' }, ctx);
  const out = translate({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }, ctx);
  eq(JSON.parse(out[0]).choices[0].finish_reason, 'stop', '8: stop');
}

// 9) response.incomplete with max_output_tokens reason → finish_reason:length.
{
  const ctx = newCtx();
  const out = translate({
    type: 'response.incomplete',
    response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 2, output_tokens: 8 } },
  }, ctx);
  eq(JSON.parse(out[0]).choices[0].finish_reason, 'length', '9: length');
  eq(out[1], '[DONE]', '9: terminal');
}

// 10) response.failed surfaces a clean error message via ctx.errorMessage.
{
  const ctx = newCtx();
  const out = translate({ type: 'response.failed', response: { error: { message: 'rate limited' } } }, ctx);
  eq(ctx.errorMessage, 'rate limited', '10: error captured');
  eq(out[0], '[DONE]', '10: terminal');
}

// 11) Unrecognised event types: return empty array (don't crash).
{
  const ctx = newCtx();
  for (const t of ['response.created', 'response.in_progress', 'response.output_item.added.unknown', 'whatever']) {
    eq(translate({ type: t }, ctx), [], `11: ignore ${t}`);
  }
  eq(ctx.emittedDeltas, 0, '11: no emissions');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
