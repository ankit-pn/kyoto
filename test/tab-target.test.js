// Tests for sidepanel/tab-target.js — which tab a tool call may act on.
//
// Regression under test: a conversation is bound to one tab, but a tool that
// doesn't receive `tabId` falls back to the browser's ACTIVE tab. So switching
// tabs during a running turn silently retargeted every subsequent tool call:
// the agent started reading/clicking a page the model never chose and its
// context began describing the wrong page. The panel now injects the bound
// tabId for every session (previously: subagents only).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'tab-target.js'), 'utf-8');

function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/tab-target.js' });
    return globalThis.KyotoTabTarget;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const TT = load();
const eq = assert.equal;

// ── The core regression ──────────────────────────────
test('a bound session pins tab-scoped tools to its own tab', () => {
  // NOT a subagent: this is the case that was broken.
  const session = { id: 's1', tabId: 42 };
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: {}, session }), 42);
  eq(TT.resolveToolTabId({ toolName: 'page_click', args: { selector: '#go' }, session }), 42);
  eq(TT.resolveToolTabId({ toolName: 'tab_screenshot', args: {}, session }), 42);
});

test('subagents are still pinned (previously the only covered case)', () => {
  const sub = { id: 'sub1', tabId: 7, _subagent: true };
  eq(TT.resolveToolTabId({ toolName: 'page_content', args: {}, session: sub }), 7);
});

test('injection actually lands in the args the tool receives', () => {
  const session = { tabId: 42 };
  const args = { selector: '#submit' };
  const out = TT.injectToolTabId({ toolName: 'page_click', args, session });
  eq(out.tabId, 42);
  eq(out.selector, '#submit', 'other arguments must be preserved');
  eq(args.tabId, undefined, 'the caller\'s object must not be mutated');
});

// ── Explicit tabId always wins ───────────────────────
test('an explicit tabId in the call is never overridden', () => {
  const session = { tabId: 42 };
  // The model deliberately targeting another tab must be respected.
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: { tabId: 99 }, session }), null);
  const out = TT.injectToolTabId({ toolName: 'page_eval', args: { tabId: 99 }, session });
  eq(out.tabId, 99);
});

test('tabId: 0 is treated as explicit, not as "unset"', () => {
  // Falsy-but-real ids must not be silently replaced by the bound tab.
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: { tabId: 0 }, session: { tabId: 42 } }), null);
});

// ── Non-applicable cases ─────────────────────────────
test('non-tab-scoped tools are left alone', () => {
  const session = { tabId: 42 };
  for (const toolName of ['memory_add', 'fs_write', 'cron_add', 'minimax_web_search', 'workspace_save']) {
    eq(TT.resolveToolTabId({ toolName, args: {}, session }), null, `${toolName} must not be pinned`);
  }
});

test('an unbound session keeps the old "active tab" behaviour', () => {
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: {}, session: { tabId: null } }), null);
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: {}, session: {} }), null);
  eq(TT.resolveToolTabId({ toolName: 'page_eval', args: {}, session: null }), null);
  // Missing args must not throw.
  eq(TT.resolveToolTabId({ toolName: 'page_eval', session: { tabId: 5 } }), 5);
});

test('a garbage tabId is ignored rather than injected', () => {
  for (const tabId of ['42', NaN, Infinity, -1, {}, undefined]) {
    eq(TT.resolveToolTabId({ toolName: 'page_eval', args: {}, session: { tabId } }), null,
      `tabId ${String(tabId)} should not be injected`);
  }
});

test('injectToolTabId tolerates missing/odd args', () => {
  const session = { tabId: 5 };
  assert.deepEqual(TT.injectToolTabId({ toolName: 'page_eval', args: null, session }), { tabId: 5 });
  assert.deepEqual(TT.injectToolTabId({ toolName: 'page_eval', args: undefined, session }), { tabId: 5 });
  assert.deepEqual(TT.injectToolTabId({ toolName: 'memory_add', args: { x: 1 }, session }), { x: 1 });
});

// ── Coverage guard ───────────────────────────────────
// If someone adds a tab-scoped tool and forgets this list, the active-tab bug
// quietly returns for that tool. These names are the ones that resolve a tab
// internally (either from args.tabId or via activeTab()).
test('the tab-aware list covers every tool that resolves a tab internally', () => {
  const required = [
    // page / DOM
    'page_content', 'page_html', 'page_query', 'page_click', 'page_fill',
    'page_fill_form', 'page_scroll', 'page_wait_for', 'page_eval',
    'page_performance', 'page_local_storage', 'page_session_storage',
    'page_fetch_intercept', 'page_fetch_intercept_read',
    // tabs
    'tab_active', 'tab_navigate', 'tab_reload', 'tab_screenshot',
    // indexeddb
    'idb_read', 'idb_list_databases', 'idb_list_stores',
    // network / console / debugger
    'network_capture_start', 'console_attach', 'console_read',
    'debugger_attach', 'debugger_detach',
    // media / youtube
    'media_detect', 'youtube_extract', 'youtube_capture_streams', 'yt_dlp_command',
    'minimax_describe_tab',
    // cookies (they derive a URL from the tab)
    'cookies_list', 'cookies_get', 'cookies_analyze', 'cookies_snapshot', 'cookies_diff'
  ];
  const missing = required.filter(n => !TT.TAB_AWARE_TOOLS.has(n));
  assert.deepEqual(missing, [], `tab-aware tools missing from the list: ${missing.join(', ')}`);
});

test('isTabAware matches the set', () => {
  eq(TT.isTabAware('page_eval'), true);
  eq(TT.isTabAware('memory_add'), false);
  eq(TT.isTabAware(''), false);
  eq(TT.isTabAware(undefined), false);
});

// ── Page-context provenance ──────────────────────────
// The page snapshot is refreshed from one tab. If a session stays visible while
// the user browses elsewhere (pinned session), injecting that snapshot would feed
// the model a page it is not working on.
test('page context is accepted only for the session that owns the tab', () => {
  eq(TT.pageContextMatchesSession(42, 42), true);
  eq(TT.pageContextMatchesSession(42, 7), false);
});

test('page context keeps working when provenance or binding is unknown', () => {
  // Snapshot predating the tabId field, or an unbound session: don't silently
  // drop context the user expects.
  eq(TT.pageContextMatchesSession(null, 42), true);
  eq(TT.pageContextMatchesSession(undefined, 42), true);
  eq(TT.pageContextMatchesSession(42, null), true);
  eq(TT.pageContextMatchesSession(42, undefined), true);
  eq(TT.pageContextMatchesSession(42, '42'), true, 'a non-numeric binding is treated as unbound');
});

// ── Source guards ────────────────────────────────────
// The gating must not be subagent-only again, and the module must not depend on
// the side panel's globals (it is loaded before sidepanel.js).
test('the tab-target module has no DOM/chrome dependencies and no subagent gating', () => {
  assert.ok(!/chrome\./.test(SRC), 'tab-target.js must not touch chrome.* (it is pure)');
  assert.ok(!/document\./.test(SRC), 'tab-target.js must not touch the DOM');
  assert.ok(!/_subagent/.test(SRC), 'subagent-only gating must not return');
});
