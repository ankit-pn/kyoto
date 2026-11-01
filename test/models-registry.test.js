// Tests for the max-output-token resolver in sidepanel/models-registry.js.
//
// Context: the settings default was a hardcoded 8 192 output tokens while
// models.dev reported the selected model could write 384 000 — so every modern
// model ran at a fraction of its capability, and the settings hint claimed the
// value was being "clamped to 8K" when nothing was being clamped at all.
//
// `resolveMaxOutput` is the single place that decides what to send:
//   0 / empty  -> the model's documented cap (auto)
//   explicit   -> honoured, but never above the model's cap (asking for more 400s)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Same-realm load: the module attaches window.KyotoModels and reads only its
// own static table until init() fetches models.dev (never called here).
globalThis.window = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'models-registry.js'), 'utf-8'),
  { filename: 'models-registry.js' }
);
const M = globalThis.KyotoModels;

// The exact model from the bug report: 1M context, 384K output.
const PROVIDER = 'opencode-go';
const MODEL = 'deepseek-v4.1-flash';

test('the static table knows the model from the report (384K output)', () => {
  const info = M.get(PROVIDER, MODEL);
  assert.ok(info, 'model must exist in the fallback table');
  assert.equal(info.output, 384000);
  assert.equal(info.context, 1000000);
});

test('auto (0) requests the model\'s full documented output, not a constant', () => {
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 0), 384000);
});

test('empty / undefined / NaN / negative all mean auto', () => {
  for (const v of ['', null, undefined, NaN, -1]) {
    assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, v), 384000, `value ${String(v)} should mean auto`);
  }
});

test('an explicit value below the cap is honoured unchanged', () => {
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 8192), 8192);
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 131072), 131072);
});

test('an explicit value above the cap is clamped to the model, not the request', () => {
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 999999), 384000);
});

test('a tiny value is floored at 64 rather than sending an unusable cap', () => {
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 1), 64);
  assert.equal(M.resolveMaxOutput(PROVIDER, MODEL, 0.5), 64);
});

test('an unknown model falls back instead of returning null/NaN', () => {
  // Unknown model on a known provider -> provider _default, not a bad value.
  const out = M.resolveMaxOutput(PROVIDER, 'no-such-model', 0);
  assert.ok(Number.isFinite(out) && out > 0, `expected a usable number, got ${out}`);

  // Unknown provider entirely -> the caller-supplied fallback.
  assert.equal(M.resolveMaxOutput('nope', 'no-such-model', 0, { fallback: 4096 }), 4096);
});

test('auto still respects a low-capability model rather than over-asking', () => {
  // deepseek-chat documents 8K; auto must not blindly send 384K.
  assert.equal(M.resolveMaxOutput('deepseek', 'deepseek-chat', 0), 8192);
  // And a model that genuinely supports 384K is not dragged down to 8K.
  assert.equal(M.resolveMaxOutput('opencode-go', 'glm-5.3', 0), 131072);
});
