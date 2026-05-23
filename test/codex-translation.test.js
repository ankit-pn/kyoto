// Standalone test for the Chat-Completions -> OpenAI Responses-API
// translation that runChatLoop's Codex fork uses. Run with `node`.
//
// The function-under-test lives inside sidepanel.js's IIFE; we extract
// it by regex + Function() so this test stays a pure unit test (no
// jsdom, no chrome.* stubs). If the function signature drifts the
// extractor will throw — that's the test failing loudly.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');

// Pull the two helpers we exercise: _chatCompletionsToResponses and
// isCodexModel (the former references the latter).
function extractFn(name) {
  // Match `function NAME(args) { ... }` with brace counting.
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in sidepanel.js`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return src.slice(start, i);
}

const helperSrc = [
  extractFn('_b64urlDecode'),
  extractFn('_decodeJwt'),
  extractFn('_extractAccountIdFromJwt'),
  extractFn('_extractAccountId'),
  extractFn('isCodexModel'),
  extractFn('isOauthRoutableModel'),
  extractFn('_chatCompletionsToResponses'),
  extractFn('_openaiCodexHeaders'),
].join('\n');
const factory = new Function(`${helperSrc}\nreturn { isCodexModel, isOauthRoutableModel, _chatCompletionsToResponses, _extractAccountId, _openaiCodexHeaders };`);
const { isCodexModel, isOauthRoutableModel, _chatCompletionsToResponses, _extractAccountId, _openaiCodexHeaders } = factory();

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got: ${a}\n  exp: ${e}\n`);
}
function deepIncludes(actual, expected, label) {
  for (const k of Object.keys(expected)) {
    if (JSON.stringify(actual[k]) !== JSON.stringify(expected[k])) {
      fail++;
      console.error(`FAIL ${label}.${k}\n  got: ${JSON.stringify(actual[k])}\n  exp: ${JSON.stringify(expected[k])}\n`);
      return;
    }
  }
  pass++;
}

// 1) System message goes into top-level `instructions` field (codex
//    backend requires this — 400s with "Instructions are required"
//    otherwise) and is NOT duplicated into the input array.
//    Reference: opencode session/llm/request.ts:90
//      `if (isOpenaiOauth) options.instructions = system.join("\n")`
{
  const body = {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
    temperature: 0.7,
    max_tokens: 8192,
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5.5');
  eq(out.instructions, 'You are helpful.', '1: instructions at top level');
  eq(out.input[0], { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, '1: input[0] is user (no system item)');
  eq(out.temperature, undefined, '1: temperature stripped');
  eq(out.top_p, undefined, '1: top_p stripped');
  eq(out.max_tokens, undefined, '1: max_tokens stripped');
  eq(out.max_output_tokens, undefined, '1: max_output_tokens stripped');
  eq(out.store, false, '1: store:false');
  eq(out.prompt_cache_key, 'kyoto', '1: prompt_cache_key default');
  eq(out.stream, true, '1: stream:true');
  eq(out.model, 'gpt-5.5', '1: model passed through');
}

// 2) Multiple system messages get joined with \n (opencode's
//    `system.join("\n")` — single newline, not double).
{
  const body = {
    messages: [
      { role: 'system', content: 'Part A' },
      { role: 'system', content: 'Part B' },
      { role: 'user', content: 'hi' },
    ],
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5.5');
  eq(out.instructions, 'Part A\nPart B', '2: joined with \\n');
}

// 2b) No system messages at all → instructions is non-empty fallback
//     (codex backend rejects empty instructions; we send a single space).
{
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const out = _chatCompletionsToResponses(body, 'gpt-5.5');
  eq(out.instructions, ' ', '2b: fallback when no system messages');
}

// 3) Reasoning defaults: gpt-5.x gets {effort,summary}; gpt-5-chat
//    and gpt-5-pro do NOT.
{
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  eq(_chatCompletionsToResponses(body, 'gpt-5').reasoning, { effort: 'medium', summary: 'auto' }, '3a: gpt-5');
  eq(_chatCompletionsToResponses(body, 'gpt-5.5').reasoning, { effort: 'medium', summary: 'auto' }, '3b: gpt-5.5');
  eq(_chatCompletionsToResponses(body, 'gpt-5-codex').reasoning, { effort: 'medium', summary: 'auto' }, '3c: codex');
  eq(_chatCompletionsToResponses(body, 'gpt-5-chat').reasoning, undefined, '3d: gpt-5-chat no reasoning');
  eq(_chatCompletionsToResponses(body, 'gpt-5-pro').reasoning, undefined, '3e: gpt-5-pro no reasoning');
}

// 4) Current opencode defaults versioned non-chat/non-codex GPT-5 to
//    low verbosity. Codex variants do not get this.
{
  const out = _chatCompletionsToResponses({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5.5');
  eq(out.text, { verbosity: 'low' }, '4a: gpt-5.5 text verbosity low');
  eq(_chatCompletionsToResponses({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5.3-codex').text, undefined, '4b: codex no text verbosity');
  eq(_chatCompletionsToResponses({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5.2-chat').text, undefined, '4c: chat no text verbosity');
}

// 4b) Caller can pass the session id used as OpenAI prompt_cache_key.
{
  const out = _chatCompletionsToResponses({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5.5', 'sess_abc');
  eq(out.prompt_cache_key, 'sess_abc', '4d: prompt cache key from session');
}

// 5) Assistant text + tool_calls translate to the right input items in
//    order (text first, then function_call items in tool_calls order).
{
  const body = {
    messages: [
      { role: 'user', content: 'open the file' },
      {
        role: 'assistant',
        content: 'Reading…',
        tool_calls: [
          { id: 'call_abc', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: 'file contents' },
    ],
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5-codex');
  // No system messages in this fixture; input starts with the user turn.
  eq(out.input[0], { role: 'user', content: [{ type: 'input_text', text: 'open the file' }] }, '5: user');
  eq(out.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Reading…' }] }, '5: asst text');
  eq(out.input[2], { type: 'function_call', call_id: 'call_abc', name: 'fs_read', arguments: '{"path":"a"}' }, '5: fn call');
  eq(out.input[3], { type: 'function_call_output', call_id: 'call_abc', output: 'file contents' }, '5: fn output');
}

// 6) Orphan tool messages (missing tool_call_id) are skipped — would
//    otherwise 400 the Codex backend with call_id:null.
{
  const body = {
    messages: [
      { role: 'user', content: 'x' },
      { role: 'tool', content: 'orphan with no id' },                       // skipped
      { role: 'tool', tool_call_id: 'call_xyz', content: 'kept' },          // kept
    ],
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5-codex');
  const fnOutputs = out.input.filter(i => i.type === 'function_call_output');
  eq(fnOutputs.length, 1, '6: orphan skipped, 1 fn output');
  eq(fnOutputs[0].call_id, 'call_xyz', '6: kept call_id');
}

// 7) Multimodal user content (image_url) maps to input_image item.
{
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,XXX' } },
      ],
    }],
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5');
  eq(out.input[0].content[0], { type: 'input_text', text: 'what is this' }, '7: text part');
  eq(out.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,XXX' }, '7: image part');
}

// 8) Tools array gets shaped as { type:function, name, description, parameters }
//    (not { type:function, function: { name, … } } like Chat Completions).
{
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }],
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5-codex');
  eq(out.tools[0], {
    type: 'function',
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }, '8: tool shape');
  eq(out.tool_choice, undefined, '8: tool_choice omitted when caller did not set it');
}

// 8b) Explicit tool_choice is forwarded.
{
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    tool_choice: 'required',
  };
  const out = _chatCompletionsToResponses(body, 'gpt-5-codex');
  eq(out.tool_choice, 'required', '8b: explicit tool_choice forwarded');
}

// 9) isCodexModel sanity.
eq(isCodexModel('gpt-5-codex'), true, '9a');
eq(isCodexModel('gpt-5.1-codex-max'), true, '9b');
eq(isCodexModel('gpt-5'), false, '9c');
eq(isCodexModel('gpt-5.5'), false, '9d');
eq(isOauthRoutableModel('gpt-5.5'), true, '9e: gpt-5.5 oauth');
eq(isOauthRoutableModel('gpt-5.4-mini'), true, '9f: gpt-5.4-mini oauth');
eq(isOauthRoutableModel('gpt-5.3-codex'), true, '9g: gpt-5.3-codex oauth');
eq(isOauthRoutableModel('gpt-5-codex'), false, '9h: old gpt-5-codex not oauth');
eq(isOauthRoutableModel('gpt-5.2-codex'), false, '9i: non-allowlisted 5.2 variant not oauth');
eq(isOauthRoutableModel('gpt-5.5-pro'), true, '9j: future/minor >5.4 oauth');

// 10) Account id can come from either id_token or access_token. The
// device-flow access token commonly carries the nested auth claim, and
// refresh responses may omit id_token entirely.
{
  const makeJwt = (payload) => {
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
  };
  const nested = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_nested' } });
  const top = makeJwt({ chatgpt_account_id: 'acct_top' });
  eq(_extractAccountId({ access_token: nested }), 'acct_nested', '10a: access token nested claim');
  eq(_extractAccountId({ id_token: top, access_token: nested }), 'acct_top', '10b: id token wins');
}

// 11) Codex headers mirror opencode's current OAuth plugin shape.
{
  const headers = _openaiCodexHeaders('tok', 'acct', 'req_1', 'sess_1');
  eq(headers.Authorization, 'Bearer tok', '11a: bearer');
  eq(headers['ChatGPT-Account-Id'], 'acct', '11b: account header casing');
  eq(headers.originator, 'opencode', '11c: opencode originator');
  eq(headers.session_id, 'sess_1', '11d: session id');
  eq(headers['x-client-request-id'], 'req_1', '11e: request id');
  eq(headers['ChatGPT-Account-ID'], undefined, '11f: no duplicate account header');
  eq(headers.Originator, undefined, '11g: no duplicate originator header');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
