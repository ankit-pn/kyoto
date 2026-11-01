// Integration test for the tool registry.
//
// Loads every sidepanel/tools/*.js in the SAME order sidepanel.html declares
// them, in a VM with a stub `chrome`, then asserts the registry invariants the
// agent depends on.
//
// Why this exists: tool names go straight into the OpenAI `tools[].function.name`
// array. A duplicate name (or an invalid identifier) makes providers reject the
// whole request or silently shadow one tool — and `finalize.js`'s TOOLS.find()
// only ever reaches the first match, so the second copy is dead code that looks
// alive. This test is the cheapest possible guard for that class of bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// A `chrome` stand-in that tolerates arbitrary property chains and calls at
// module-load time. Handlers are not exercised here — this test is about the
// registry, not each tool's behaviour.
function makeChromeStub() {
  const make = () => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;      // never look like a thenable
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '';
      return make();
    },
    apply() { return Promise.resolve({}); },
    construct() { return make(); },
  });
  return make();
}

/** Script src order from sidepanel.html, filtered to the tool modules. */
function toolScriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.html'), 'utf-8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map(m => m[1])
    .filter(src => src.startsWith('tools/'));
}

function loadRegistry() {
  const sandbox = {
    console,
    chrome: makeChromeStub(),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, TypeError, Symbol, Proxy, Reflect,
    atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    URL, Blob, fetch: async () => ({ ok: false, status: 0, text: async () => '', json: async () => ({}) }),
    AbortController,
    indexedDB: { open: () => { throw new Error('no indexedDB in this test'); } },
    navigator: { userAgent: 'node' },
    // Some tool modules register page-level listeners at load time.
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    postMessage: () => {},
    location: { href: 'https://example.test/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const order = toolScriptOrder();
  assert.ok(order.includes('tools/core.js'), 'sidepanel.html must load tools/core.js');
  assert.ok(order.includes('tools/finalize.js'), 'sidepanel.html must load tools/finalize.js');
  // core.js must come first (defines KyotoTR) and finalize.js last (seals it).
  assert.equal(order[0], 'tools/core.js', 'tools/core.js must load first');
  assert.equal(order[order.length - 1], 'tools/finalize.js', 'tools/finalize.js must load last');

  for (const src of order) {
    const file = path.join(ROOT, 'sidepanel', src);
    assert.ok(fs.existsSync(file), `sidepanel.html references a missing file: sidepanel/${src}`);
    const code = fs.readFileSync(file, 'utf-8');
    vm.runInContext(code, context, { filename: `sidepanel/${src}` });
  }
  return { tools: sandbox.window.KyotoTools, order, sandbox };
}

const { tools: TOOLS_API, order } = loadRegistry();
const list = TOOLS_API.list();

test('every tool module referenced by sidepanel.html loads', () => {
  assert.ok(order.length >= 15, `expected the full tool set, got ${order.length} script tags`);
  assert.ok(Array.isArray(list) && list.length > 100, `expected >100 tools, got ${list.length}`);
});

test('tool names are unique across the whole registry', () => {
  const seen = new Map();
  const dups = [];
  for (const t of list) {
    if (seen.has(t.name)) dups.push(`${t.name} (${seen.get(t.name)} + ${t.group})`);
    else seen.set(t.name, t.group);
  }
  assert.equal(dups.join(','), '', `duplicate tool names break the provider schema: ${dups.join(', ')}`);
});

test('tool names are valid function identifiers', () => {
  for (const t of list) {
    assert.match(t.name, /^[A-Za-z0-9_-]+$/,
      `"${t.name}" must be a valid OpenAI function name (letters, digits, _ and -)`);
    assert.ok(t.name.length <= 64, `"${t.name}" exceeds the 64-char function-name limit`);
  }
});

test('every tool has the fields the schema builder needs', () => {
  for (const t of list) {
    assert.ok(typeof t.group === 'string' && t.group.length, `${t.name}: missing group`);
    assert.ok(typeof t.description === 'string' && t.description.length > 10,
      `${t.name}: description too short for an LLM to choose it`);
    assert.ok(t.group !== 'undefined', `${t.name}: group resolved to the string "undefined"`);
  }
  // The public list() intentionally exposes only name/group/description, so
  // check parameters + handler through a schema build.
  for (const t of list) {
    const [schema] = TOOLS_API.schemas(new Set([t.group])).filter(s => s.function.name === t.name);
    assert.ok(schema, `${t.name}: missing from schemas()`);
    assert.equal(schema.type, 'function');
    assert.ok(schema.function.parameters && schema.function.parameters.type === 'object',
      `${t.name}: parameters must be an object schema`);
  }
});

test('groups() reflects registered groups and schemas() filters by them', () => {
  const groups = TOOLS_API.groups();
  for (const expected of ['browser', 'page', 'cookies', 'network', 'platform', 'intercept']) {
    assert.ok(groups.includes(expected), `expected group "${expected}" in ${groups.join(',')}`);
  }
  const platform = TOOLS_API.schemas(new Set(['platform']));
  assert.ok(platform.length > 0, 'platform group should expose tools');
  for (const s of platform) {
    const meta = list.find(t => t.name === s.function.name);
    assert.equal(meta.group, 'platform', `${s.function.name} leaked into the platform group`);
  }
});

test('the new capability groups are distinct and populated', () => {
  // platform = Chrome-platform surfaces (tab groups, sessions, power, ...)
  const platform = TOOLS_API.schemas(new Set(['platform'])).map(s => s.function.name).sort();
  // intercept = declarativeNetRequest rules
  const intercept = TOOLS_API.schemas(new Set(['intercept'])).map(s => s.function.name).sort();
  assert.ok(platform.length >= 10, `expected >=10 platform tools, got ${platform.length}`);
  assert.ok(intercept.length >= 4, `expected >=4 intercept tools, got ${intercept.length}`);
  const overlap = platform.filter(n => intercept.includes(n));
  // Compare as strings: values crossing the VM boundary carry different
  // Object/Array prototypes, so deepEqual would fail on identical contents.
  assert.equal(overlap.join(','), '', 'a tool name is registered in both new groups');
});

test('an unknown tool name returns an error instead of throwing', async () => {
  const res = await TOOLS_API.call('definitely_not_a_tool');
  assert.ok(res && typeof res.error === 'string' && /Unknown tool/.test(res.error));
});

test('every tool group in the registry is enabled by default', () => {
  // A group missing from defaults.enabledGroups ships invisible to the agent:
  // schemas(enabledGroups) filters it out and the user never sees a checkbox.
  const js = fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.js'), 'utf-8');
  const m = js.match(/enabledGroups:\s*\[([^\]]*)\]/);
  assert.ok(m, 'could not find enabledGroups defaults in sidepanel.js');
  const defaults = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  const missing = TOOLS_API.groups().filter(g => !defaults.has(g));
  assert.equal(missing.join(','), '',
    `tool groups not in defaults.enabledGroups (they would be invisible): ${missing.join(', ')}`);
});
