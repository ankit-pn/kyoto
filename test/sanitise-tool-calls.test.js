// Test for sanitiseDanglingToolCalls — the helper that heals a chat
// history when an assistant message with tool_calls is missing some
// of the corresponding role:'tool' responses. OpenAI-compat servers
// reject such histories with "An assistant message with 'tool_calls'
// must be followed by tool messages...", and once the bad history is
// persisted the user is stuck unless we heal it before the next send.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract the function source from sidepanel.js so the test
// stays in lockstep with the deployed implementation. The
// pattern is anchored on the function name plus a balanced-brace
// scan starting from the matching `{`.
function extractSanitiser() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'),
    'utf-8'
  );
  const startMatch = src.match(/function\s+sanitiseDanglingToolCalls\s*\(/);
  if (!startMatch) throw new Error('sanitiseDanglingToolCalls not found');
  let i = src.indexOf('{', startMatch.index);
  if (i < 0) throw new Error('opening brace not found');
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '/' && src[j + 1] === '/') {
      const eol = src.indexOf('\n', j);
      j = eol < 0 ? src.length : eol;
      continue;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // skip string literal
      const quote = ch;
      j++;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j += 2; else j++;
      }
    }
    j++;
  }
  const fnSrc = src.slice(startMatch.index, j);
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}; return sanitiseDanglingToolCalls;`)();
}

const sanitise = extractSanitiser();

test('returns false and leaves history alone when everything is answered', () => {
  const session = {
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'foo', content: '{"ok":true}' },
      { role: 'assistant', content: 'all good' },
    ]
  };
  const before = JSON.stringify(session.history);
  assert.equal(sanitise(session), false);
  assert.equal(JSON.stringify(session.history), before);
});

test('plugs a single missing tool response with a placeholder', () => {
  const session = {
    history: [
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
      ]},
      // No matching tool message — last write of a crashed turn.
    ]
  };
  assert.equal(sanitise(session), true);
  assert.equal(session.history.length, 3);
  const placeholder = session.history[2];
  assert.equal(placeholder.role, 'tool');
  assert.equal(placeholder.tool_call_id, 'call_a');
  assert.equal(placeholder.name, 'tool_a');
  assert.ok(placeholder._aborted);
  const parsed = JSON.parse(placeholder.content);
  assert.ok(parsed.error, 'placeholder content should be a JSON error envelope');
});

test('plugs only the missing one when some tool_calls are already answered', () => {
  const session = {
    history: [
      { role: 'user', content: 'fan out' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        { id: 'call_3', type: 'function', function: { name: 'c', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'a', content: '{}' },
      { role: 'tool', tool_call_id: 'call_3', name: 'c', content: '{}' },
    ]
  };
  assert.equal(sanitise(session), true);
  // Should now have ONE more entry (placeholder for call_2), inserted
  // adjacent to the existing tool responses so the response window
  // stays contiguous.
  const toolMsgs = session.history.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 3, 'should have 3 tool responses total');
  const ids = toolMsgs.map(m => m.tool_call_id).sort();
  assert.deepStrictEqual(ids, ['call_1', 'call_2', 'call_3']);
  const placeholder = toolMsgs.find(m => m.tool_call_id === 'call_2');
  assert.ok(placeholder._aborted);
});

test('heals every dangling assistant message, not just the most recent', () => {
  const session = {
    history: [
      { role: 'user', content: 'first ask' },
      // First assistant turn with a missing tool response.
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_old', type: 'function', function: { name: 'old', arguments: '{}' } },
      ]},
      // Conversation moved on (user replied without the response) —
      // shouldn't happen in practice, but if it does we still want to
      // fix BOTH holes.
      { role: 'user', content: 'second ask' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_new', type: 'function', function: { name: 'new', arguments: '{}' } },
      ]},
    ]
  };
  assert.equal(sanitise(session), true);
  const ids = new Set(session.history.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  assert.ok(ids.has('call_old'));
  assert.ok(ids.has('call_new'));
});

test('uses the caller-supplied reason in the placeholder error', () => {
  const session = {
    history: [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_z', type: 'function', function: { name: 'z', arguments: '{}' } },
      ]},
    ]
  };
  sanitise(session, '[stopped by user]');
  const placeholder = session.history.find(m => m.role === 'tool');
  const parsed = JSON.parse(placeholder.content);
  assert.equal(parsed.error, '[stopped by user]');
});

test('no-op on empty / null / malformed sessions', () => {
  assert.equal(sanitise(null), false);
  assert.equal(sanitise({}), false);
  assert.equal(sanitise({ history: [] }), false);
  assert.equal(sanitise({ history: 'not an array' }), false);
  assert.equal(sanitise({ history: [{ role: 'user', content: 'hi' }] }), false);
});

test('ignores assistant messages with empty tool_calls arrays', () => {
  const session = {
    history: [
      { role: 'assistant', content: 'plain reply', tool_calls: [] },
    ]
  };
  assert.equal(sanitise(session), false);
});
