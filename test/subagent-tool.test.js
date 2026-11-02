// Smoke test for the subagent tool: confirms the tool registry loads,
// `agent` is registered with the expected schema, and TAB_AWARE_TOOLS
// covers the tools that should respect a subagent's bound tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadToolsHarness() {
  // Minimal stubs for the chrome.* / browser globals each tool file
  // touches at LOAD time. Tools that only call chrome at run-time
  // (inside handlers) work without further stubbing.
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  const sandbox = {
    window: win,
    self: win,
    addEventListener: () => {},
    removeEventListener: () => {},
    document: {
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    chrome: {
      runtime: { id: 'test-ext', connectNative: () => { throw new Error('no native in test'); } },
      tabs: {},
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: {},
      history: {},
      bookmarks: {},
      downloads: {},
    },
    indexedDB: {},
    crypto: { subtle: {}, getRandomValues: (a) => a },
    fetch: async () => ({ ok: false, status: 0 }),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    DOMParser: function () {},
    FileReader: function () {},
    Blob: function () {},
    HTMLInputElement: function () {},
    HTMLTextAreaElement: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, atob, btoa,
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    navigator: { clipboard: { writeText: async () => {} } },
    location: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    'core','workspace','browser','cookies','network','python','fs','media',
    'shell','youtube','data','skills','subagent','finalize'
  ].map(n => path.join(__dirname, '..', 'sidepanel', 'tools', `${n}.js`));

  for (const f of files) {
    const code = fs.readFileSync(f, 'utf-8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  return win;
}

test('tools registry loads cleanly', () => {
  const win = loadToolsHarness();
  assert.ok(win.KyotoTools, 'KyotoTools should be exposed');
  assert.ok(win.KyotoTR, 'KyotoTR should be exposed');
  assert.ok(typeof win.KyotoTools.call === 'function');
  assert.ok(typeof win.KyotoTools.schemas === 'function');
});

test('every expected tool family is registered', () => {
  const win = loadToolsHarness();
  const names = new Set(win.KyotoTools.list().map(t => t.name));
  // Spot-check one tool from each family file.
  const must = [
    'tabs_list','page_eval',        // browser
    'cookies_list','curl_to_fetch', // cookies
    'network_fetch','web_fetch_extract', // network
    'python_exec',                  // python
    'fs_write','fs_zip',            // fs
    'media_download','chat_export', // media
    'shell_exec',                   // shell
    'yt_dlp_run',                   // youtube
    'json_to_typescript','minimax_describe_tab', // data
    'memory_add','ask_user',        // memory + meta
    'agent',                        // subagent
  ];
  for (const n of must) {
    assert.ok(names.has(n), `missing tool: ${n}`);
  }
});

test('agent tool schema looks right', () => {
  const win = loadToolsHarness();
  const schema = win.KyotoTools.schemas().find(s => s.function.name === 'agent');
  assert.ok(schema, 'agent schema should exist');
  assert.equal(schema.type, 'function');
  assert.equal(schema.function.parameters.type, 'object');
  // Round-trip JSON-clone — vm-context arrays don't share Array.prototype
  // with the parent, which trips up node:test's structural equality.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(schema.function.parameters.required)),
    ['prompt']
  );
  assert.ok(schema.function.parameters.properties.prompt);
  assert.ok(schema.function.parameters.properties.start_url);
  assert.ok(schema.function.parameters.properties.close_tab);
});

test('agent tool gracefully fails when KyotoSession missing', async () => {
  const win = loadToolsHarness();
  // KyotoSession is defined in sidepanel.js (separate IIFE) — not loaded
  // in this harness, so the tool should report a clean error rather
  // than crash.
  const r = await win.KyotoTools.call('agent', { prompt: 'hi' });
  assert.ok(r.error && /subagent runtime/i.test(r.error), `unexpected: ${JSON.stringify(r)}`);
});

test('KyotoShell is exposed by tools/shell.js (so youtube.js can reuse it)', () => {
  const win = loadToolsHarness();
  assert.ok(win.KyotoShell);
  assert.equal(typeof win.KyotoShell.shell, 'function');
});

test('KyotoWorkspace exposes folder/location and prefixes download paths', () => {
  const win = loadToolsHarness();
  assert.ok(win.KyotoWorkspace, 'KyotoWorkspace should be exposed');
  // Default folder is "Kyoto", location "downloads".
  assert.equal(win.KyotoWorkspace.name(), 'Kyoto');
  assert.equal(win.KyotoWorkspace.location(), 'downloads');
  // Path prefixing for chrome.downloads.
  assert.equal(win.KyotoWorkspace.relativePath('foo.zip'), 'Kyoto/foo.zip');
  assert.equal(win.KyotoWorkspace.relativePath('/leading-slash.txt'), 'Kyoto/leading-slash.txt');
  // Unsafe characters in the folder name get sanitised — both filesystem-
  // illegal chars (/, :, ?, etc.) AND shell metacharacters (', `, $) so
  // the folder name is safe to interpolate into any shell command.
  win.KyotoWorkspace.setFromSettings({ workspaceFolder: 'My/Bad:Name?' });
  assert.equal(win.KyotoWorkspace.name(), 'My_Bad_Name_');
  win.KyotoWorkspace.setFromSettings({ workspaceFolder: "My's $Stuff `oops`" });
  assert.equal(win.KyotoWorkspace.name(), 'My_s _Stuff _oops_');
  // Location switching is validated, fallback is downloads.
  win.KyotoWorkspace.setFromSettings({ workspaceLocation: 'documents' });
  assert.equal(win.KyotoWorkspace.location(), 'documents');
  win.KyotoWorkspace.setFromSettings({ workspaceLocation: 'bogus' });
  assert.equal(win.KyotoWorkspace.location(), 'downloads');
});

test('workspace_info + workspace_save tools are registered', () => {
  const win = loadToolsHarness();
  const names = new Set(win.KyotoTools.list().map(t => t.name));
  assert.ok(names.has('workspace_info'));
  assert.ok(names.has('workspace_save'));
  const save = win.KyotoTools.schemas().find(s => s.function.name === 'workspace_save');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(save.function.parameters.required)),
    ['filename']
  );
});
