// Tests for sidepanel/speech.js — the pure voice state machine and chunker.
//
// The DOM/SpeechRecognition calls live in sidepanel.js; this file pins down the
// rules that browsers make easy to get wrong:
//   - `interim` events RESEND the whole hypothesis, so they must replace, not
//     append ("hello hello hello" is the classic bug);
//   - `final` results append once, but a re-delivered final must not duplicate
//     the phrase;
//   - an `error` must never erase text the user has already spoken;
//   - state is immutable, so the UI can diff old/new states safely;
//   - long replies are chunked at sentence, then whitespace boundaries, never
//     mid-word — except an indivisible word longer than the limit, which is
//     returned whole rather than lost.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'speech.js'), 'utf-8');

// Same-realm load (see test/context.test.js): deepEqual only sees shared
// prototypes when the IIFE runs in this realm.
function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/speech.js' });
    return globalThis.KyotoSpeech;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const S = load();
const { supportsSpeech, initialState, reduceSpeech, chunkForSpeech } = S;
const eq = assert.equal;

// ── supportsSpeech ───────────────────────────────────
test('supportsSpeech: true when the scope exposes SpeechRecognition', () => {
  eq(supportsSpeech({ SpeechRecognition: function FakeRecognition() {} }), true);
});

test('supportsSpeech: true for the legacy webkitSpeechRecognition name', () => {
  eq(supportsSpeech({ webkitSpeechRecognition: class FakeRecognition {} }), true);
});

test('supportsSpeech: false when the API is absent or the scope is unusable', () => {
  eq(supportsSpeech({}), false);
  eq(supportsSpeech(null), false);
  eq(supportsSpeech(undefined), false);
  eq(supportsSpeech(0), false);
  // In node there is no recognition API at all, so the default scope is false.
  eq(supportsSpeech(), false);
});

// ── reduceSpeech: session lifecycle ──────────────────
test('initialState: a fresh empty state every call', () => {
  assert.deepEqual(initialState(), { finalText: '', interim: '', listening: false, error: null });
  assert.notStrictEqual(initialState(), initialState());
});

test('start: turns listening on and clears a previous error but keeps text', () => {
  const failed = { finalText: 'hello', interim: 'wor', listening: false, error: 'not-allowed' };
  const out = reduceSpeech(failed, { type: 'start' });
  eq(out.listening, true);
  eq(out.error, null);
  eq(out.finalText, 'hello', 'committed text survives a restart');
  eq(out.interim, 'wor');
});

test('end: stops listening and keeps the transcript', () => {
  const listening = { finalText: 'keep this', interim: '', listening: true, error: null };
  const out = reduceSpeech(listening, { type: 'end' });
  eq(out.listening, false);
  eq(out.finalText, 'keep this');
  eq(out.error, null);
});

test('reset: returns a completely clean state', () => {
  const dirty = { finalText: 'hello', interim: 'wor', listening: true, error: 'boom' };
  assert.deepEqual(reduceSpeech(dirty, { type: 'reset' }), initialState());
});

// ── reduceSpeech: the interim append bug ─────────────
test('interim REPLACES the hypothesis instead of appending to it', () => {
  let state = reduceSpeech(initialState(), { type: 'interim', text: 'hel' });
  eq(state.interim, 'hel');
  // Browsers resend the whole hypothesis; appending would give "helhello wor".
  state = reduceSpeech(state, { type: 'interim', text: 'hello wor' });
  eq(state.interim, 'hello wor');
  eq(state.finalText, '', 'an interim result is not committed');
  // Backing up (engine restarted its hypothesis) also replaces.
  state = reduceSpeech(state, { type: 'interim', text: 'hello' });
  eq(state.interim, 'hello');
});

// ── reduceSpeech: final results ──────────────────────
test('final: appends to finalText and clears the interim hypothesis', () => {
  const withInterim = { finalText: '', interim: 'hello wor', listening: true, error: null };
  const out = reduceSpeech(withInterim, { type: 'final', text: 'hello world' });
  eq(out.finalText, 'hello world');
  eq(out.interim, '', 'committed text must not remain as interim');
});

test('final: successive finals are space-joined without double spaces', () => {
  let state = reduceSpeech(initialState(), { type: 'final', text: 'hello' });
  state = reduceSpeech(state, { type: 'final', text: '  world  ' });
  eq(state.finalText, 'hello world');
  // A state that already carries stray whitespace is normalised too.
  const messy = { finalText: 'hello  there ', interim: '', listening: true, error: null };
  eq(reduceSpeech(messy, { type: 'final', text: 'friend' }).finalText, 'hello there friend');
});

test('final: the same result delivered twice is not duplicated', () => {
  // Chrome can re-deliver a final result (e.g. after restarting the recognizer).
  const once = reduceSpeech(initialState(), { type: 'final', text: 'turn on the lights' });
  const twice = reduceSpeech(once, { type: 'final', text: 'turn on the lights' });
  eq(twice.finalText, 'turn on the lights');
  eq(twice.interim, '');
});

test('final: a repeated result is not duplicated even after earlier text', () => {
  let state = reduceSpeech(initialState(), { type: 'final', text: 'hello' });
  state = reduceSpeech(state, { type: 'final', text: 'world' });
  state = reduceSpeech(state, { type: 'final', text: 'world' });
  eq(state.finalText, 'hello world');
});

test('final: duplicates are detected case-insensitively', () => {
  const once = reduceSpeech(initialState(), { type: 'final', text: 'Turn On The Lights' });
  const twice = reduceSpeech(once, { type: 'final', text: 'turn on the lights' });
  eq(twice.finalText, 'Turn On The Lights');
});

test('final: distinct results are appended in order', () => {
  let state = reduceSpeech(initialState(), { type: 'final', text: 'open' });
  state = reduceSpeech(state, { type: 'final', text: 'the settings' });
  state = reduceSpeech(state, { type: 'final', text: 'page' });
  eq(state.finalText, 'open the settings page');
});

test('final: an empty result commits nothing and only clears the interim', () => {
  const state = { finalText: 'kept', interim: 'stale hypothesis', listening: true, error: null };
  const out = reduceSpeech(state, { type: 'final', text: '   ' });
  eq(out.finalText, 'kept');
  eq(out.interim, '');
});

// ── reduceSpeech: errors ─────────────────────────────
test('error: stops listening but preserves already-committed text', () => {
  const state = { finalText: 'keep this', interim: 'partial', listening: true, error: null };
  const out = reduceSpeech(state, { type: 'error', message: 'not-allowed' });
  eq(out.listening, false);
  eq(out.error, 'not-allowed');
  eq(out.finalText, 'keep this', 'a microphone error must not erase dictation');
  eq(out.interim, 'partial', 'the in-flight hypothesis is left as-is for the UI');
});

test('error: a missing message still produces a usable error string', () => {
  const out = reduceSpeech(initialState(), { type: 'error' });
  eq(out.listening, false);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

// ── reduceSpeech: immutability + defensive behaviour ─
test('reduceSpeech: never mutates the input state and always returns a new object', () => {
  const state = Object.freeze({
    finalText: 'hello',
    interim: 'wor',
    listening: true,
    error: null
  });
  const before = JSON.stringify(state);
  const out = reduceSpeech(state, { type: 'final', text: 'world' });
  assert.notStrictEqual(out, state);
  eq(JSON.stringify(state), before, 'input object must be untouched');
  eq(out.finalText, 'hello world');
});

test('reduceSpeech: an unknown event returns an unchanged copy', () => {
  const state = { finalText: 'hello', interim: 'wor', listening: true, error: null };
  const out = reduceSpeech(state, { type: 'bogus' });
  assert.deepEqual(out, state);
  assert.notStrictEqual(out, state);
  // Missing/garbage state and event must not throw.
  eq(reduceSpeech(null, { type: 'start' }).listening, true);
  eq(reduceSpeech(initialState(), null).listening, false);
});

// ── chunkForSpeech ───────────────────────────────────
test('chunkForSpeech: short text becomes a single chunk', () => {
  assert.deepEqual(chunkForSpeech('Hello there.', 220), ['Hello there.']);
  assert.deepEqual(chunkForSpeech('abcde', 5), ['abcde'], 'text exactly at the limit fits');
  assert.deepEqual(chunkForSpeech('abcde', 4), ['abcde'], 'single short word');
});

test('chunkForSpeech: splits on sentence boundaries and respects maxChars', () => {
  const text = 'One two three. Four five six. Seven eight nine.';
  const chunks = chunkForSpeech(text, 18);
  assert.deepEqual(chunks, ['One two three.', 'Four five six.', 'Seven eight nine.']);
  for (const chunk of chunks) assert.ok(chunk.length <= 18);
});

test('chunkForSpeech: falls back to whitespace without splitting a word', () => {
  const text = 'alpha beta gamma delta';
  const chunks = chunkForSpeech(text, 11);
  assert.deepEqual(chunks, ['alpha beta', 'gamma delta']);
  assert.equal(chunks.join(' '), text, 'no word may be broken by the split');
});

test('chunkForSpeech: keeps a single word longer than maxChars', () => {
  const longWord = 'floccinaucinihilipilification';
  // Returning it whole is deliberate: splitting would corrupt it and dropping
  // it would lose the user's word entirely.
  const chunks = chunkForSpeech(`short ${longWord} end`, 8);
  assert.ok(chunks.includes(longWord), 'the over-long word must survive');
  assert.equal(chunks.join(' '), `short ${longWord} end`);
});

test('chunkForSpeech: empty and whitespace-only text produces no chunks', () => {
  assert.deepEqual(chunkForSpeech(''), []);
  assert.deepEqual(chunkForSpeech('   \n\t  '), []);
  assert.deepEqual(chunkForSpeech(null), []);
  assert.deepEqual(chunkForSpeech(undefined), []);
});

test('chunkForSpeech: long mixed text keeps every chunk within the limit', () => {
  const text =
    'The quick brown fox jumps over the lazy dog. ' +
    'Pack my box with five dozen liquor jugs! ' +
    'How vexingly quick daft zebras jump? ' +
    'Sphinx of black quartz, judge my vow.';
  const max = 40;
  const chunks = chunkForSpeech(text, max);
  assert.ok(chunks.length > 1, 'the text is longer than the limit');
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no empty chunks');
    assert.ok(chunk.length <= max, `chunk too long (${chunk.length}): "${chunk}"`);
  }
  assert.equal(chunks.join(' '), text.replace(/\s+/g, ' ').trim());
});

test('chunkForSpeech: honours the default 220-character limit', () => {
  const text = ('word '.repeat(80)).trim(); // 399 characters, no punctuation
  const chunks = chunkForSpeech(text);
  assert.ok(chunks.length > 1, 'should be split at the default limit');
  for (const chunk of chunks) assert.ok(chunk.length <= 220, `too long: ${chunk.length}`);
  assert.equal(chunks.join(' '), text);
});
