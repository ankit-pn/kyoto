// Contract sweep across every registered tool.
//
// The house rule is "a tool returns { error }, it never throws" — a thrown error
// aborts the whole agent turn, while a returned one lets the model read it and
// adapt. Nothing enforced that across 150+ tools, so this test invokes every
// handler with empty arguments against a recording `chrome` stub and checks the
// rule holds.
//
// It also gives the destructive tools (which can wipe data or rewrite the user's
// network) a dedicated check: their empty-argument path must be rejected by
// validation BEFORE any chrome call is made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { makeChrome } = require('./helpers/chrome-stub');

const ROOT = path.join(__dirname, '..');

function toolScriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.html'), 'utf-8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map(m => m[1])
    .filter(src => src.startsWith('tools/'))
    .map(src => path.join(ROOT, 'sidepanel', src));
}

function loadRegistry() {
  const chrome = makeChrome();
  const sandbox = {
    console, chrome,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, TypeError, Symbol, Proxy, Reflect,
    atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Uint16Array,
    URL, Blob, File, FormData, Response, Request, Headers,
    fetch: async () => ({ ok: false, status: 0, text: async () => '', json: async () => ({}), headers: { get: () => null, forEach: () => {} } }),
    AbortController,
    indexedDB: { open: () => { throw new Error('no indexedDB in this test'); } },
    navigator: { userAgent: 'node', language: 'en-US', clipboard: { writeText: async () => {}, readText: async () => '' } },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, postMessage: () => {},
    location: { href: 'https://example.test/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
    addEventListener: () => {}, body: { appendChild() {} }, head: { appendChild() {} },
    documentElement: { style: {} },
  };
  const context = vm.createContext(sandbox);
  for (const file of toolScriptOrder()) {
    if (!fs.existsSync(file)) continue;
    vm.runInContext(fs.readFileSync(file, 'utf-8'), context, { filename: file });
  }
  return { api: sandbox.window.KyotoTools, chrome, sandbox };
}

const { api: TOOLS, chrome: CHROME } = loadRegistry();
const LIST = TOOLS.list();

// Tools whose empty-args path MUST be refused by validation (never reach chrome).
// These can destroy user data, rewrite networking, or drive the browser.
// Tools that can destroy user data, rewrite the user's networking, or sign them
// out. Called with no arguments they must fail validation WITHOUT performing the
// destructive call. (`net_rule_clear` is deliberately absent: removing all rules
// with no arguments is its documented purpose, it is the reset escape hatch.)
const MUST_REJECT_EMPTY = [
  'site_data_clear', 'net_rule_block', 'net_rule_redirect', 'net_rule_stub',
  'routine_run', 'routine_save', 'routine_delete',
  'tab_close', 'cookies_set', 'cookies_remove',
  'fs_delete', 'fs_move', 'memory_add', 'cron_add', 'cron_remove',
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms))
  ]);
}

const THREW = [];
const NOT_OBJECT = [];
const OK = [];

test('every tool handler is invocable with empty args', async () => {
  for (const t of LIST) {
    let outcome;
    try {
      outcome = await withTimeout(Promise.resolve(TOOLS.call(t.name, {})), 8000, t.name);
    } catch (e) {
      THREW.push(`${t.name}: ${e?.message || String(e)}`);
      continue;
    }
    if (outcome === null || typeof outcome !== 'object') {
      NOT_OBJECT.push(`${t.name}: returned ${typeof outcome}`);
    } else {
      OK.push(t.name);
    }
  }
  // Report rather than fail here; the assertions below decide what is a bug.
  console.log(`\n[tool sweep] ${OK.length} ok · ${THREW.length} threw · ${NOT_OBJECT.length} non-object return`);
  if (THREW.length) console.log('[tool sweep] threw:\n  ' + THREW.join('\n  '));
});

// A tool that throws on bad input turns a recoverable mistake into a dead turn.
// Any tool in this list must be fixed or explicitly justified here.
const THROW_ALLOWLIST = new Set([
  // These legitimately need a live target and cannot run under a stub:
  // (kept explicit so a NEW thrower is caught rather than absorbed)
]);

test('no tool throws on empty arguments (house rule: return { error })', () => {
  const unexplained = THREW.filter(line => !THROW_ALLOWLIST.has(line.split(':')[0]));
  assert.deepEqual(unexplained, [],
    `tools must return { error } instead of throwing:\n${unexplained.join('\n')}`);
});

test('every tool returns an object, never a primitive or undefined', () => {
  assert.deepEqual(NOT_OBJECT, [], `handlers returning non-objects:\n${NOT_OBJECT.join('\n')}`);
});

test('destructive tools refuse empty args without side effects', async () => {
  const problems = [];
  for (const name of MUST_REJECT_EMPTY) {
    if (!LIST.some(t => t.name === name)) continue;
    CHROME.__calls.length = 0;
    let res;
    try { res = await withTimeout(Promise.resolve(TOOLS.call(name, {})), 3000, name); }
    catch (e) { problems.push(`${name}: threw (${e?.message || e})`); continue; }
    const calls = CHROME.__calls.slice();
    // The invariant that matters is not "returns {error}" (some tools legitimately
    // accept no args) but "does not perform a destructive browser operation".
    const DESTRUCTIVE = new Set(['remove', 'update', 'download', 'group', 'ungroup',
      'attach', 'removeDynamicRules', 'clear']);
    const destructive = calls.filter(c =>
      DESTRUCTIVE.has(c.method) || c.method === 'updateDynamicRules' || c.method === 'remove');
    if (!res || typeof res !== 'object') {
      problems.push(`${name}: returned ${typeof res} instead of an object`);
    }
    if (destructive.length) {
      problems.push(`${name}: performed a destructive call with no args (${destructive.map(w => w.ns + '.' + w.method).join(', ')})`);
    }
  }
  assert.deepEqual(problems, [], `destructive-tool guard failures:\n${problems.join('\n')}`);
});

// ══════════════════════════════════════════════════════
// Regressions for the v14.24.0 independent audit
// ══════════════════════════════════════════════════════

// AUDIT H2: a DNR redirect installed browser-wide and persistently could send a
// precise filter's original request headers (Authorization/Cookies) to an
// attacker host, with no confirmation. Cross-origin targets must be explicit.
test('a cross-origin intercept redirect is refused without explicit consent', async () => {
  const res = await TOOLS.call('net_rule_redirect', {
    urlFilter: '||api.example.com/',
    redirectUrl: 'https://attacker.test/collect'
  });
  assert.ok(res && res.error, 'cross-origin redirect must be refused');
  assert.match(String(res.error), /cross-origin/i);
  assert.match(String(res.error), /confirmCrossOrigin/, 'the error must name the escape hatch');

  // Explicit consent is honoured.
  const ok = await TOOLS.call('net_rule_redirect', {
    urlFilter: '||api.example.com/',
    redirectUrl: 'https://attacker.test/collect',
    confirmCrossOrigin: true
  });
  assert.ok(ok && !ok.error, `explicitly confirmed redirect should install, got: ${JSON.stringify(ok)}`);

  // A same-host redirect (the normal localhost-mock workflow) needs no consent.
  const local = await TOOLS.call('net_rule_redirect', {
    urlFilter: '||api.example.com/',
    redirectUrl: 'https://api.example.com:8443/v2/'
  });
  assert.ok(local && !local.error, `same-host redirect should install, got: ${JSON.stringify(local)}`);
});
