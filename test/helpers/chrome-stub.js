// A recording `chrome` stand-in for tests.
//
// Goal: enough real behaviour that tool handlers take their normal paths, while
// recording every call so a test can assert on intent ("did it try to attach the
// debugger?") without touching a browser.
//
// Two rules learned the hard way:
//  * reads must return Promises resolving to plausible data, never `undefined`,
//    or handlers throw on `.then` of undefined;
//  * unknown namespaces must not explode, because tools are loaded as a set and
//    one un-stubbed API would fail every unrelated test.

'use strict';

function makeChrome() {
  const calls = [];
  const record = (ns, method) => (...args) => {
    calls.push({ ns, method, args });
    return undefined;
  };

  // ── storage (real in-memory map so save/load round-trips work) ──
  const store = new Map();
  const storageArea = {
    async get(keys) {
      calls.push({ ns: 'storage', method: 'get', args: [keys] });
      if (keys == null) return Object.fromEntries(store);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    async set(obj) {
      calls.push({ ns: 'storage', method: 'set', args: [obj] });
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(keys) {
      calls.push({ ns: 'storage', method: 'remove', args: [keys] });
      for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
    },
    async clear() { calls.push({ ns: 'storage', method: 'clear', args: [] }); store.clear(); },
    onChanged: { addListener: record('storage', 'onChanged.addListener'), removeListener() {} }
  };

  const tabEvents = { onCreated: [], onUpdated: [], onRemoved: [], onActivated: [] };
  const removeFrom = (arr, fn) => {
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  };

  // ── tabs: one plausible tab, ids 1..n ──
  const tab = (id, extra = {}) => ({
    id, windowId: 1, active: id === 1, status: 'complete',
    url: `https://example.test/page${id}`, title: `Example ${id}`,
    ...extra
  });
  const tabs = [tab(1), tab(2, { active: false })];
  const tabsApi = {
    async query(q = {}) {
      calls.push({ ns: 'tabs', method: 'query', args: [q] });
      if (q.active) return tabs.filter(t => t.active);
      return tabs.slice();
    },
    async get(id) {
      calls.push({ ns: 'tabs', method: 'get', args: [id] });
      const t = tabs.find(x => x.id === id);
      if (!t) throw new Error(`No tab with id: ${id}.`);
      return t;
    },
    async create(props = {}) {
      calls.push({ ns: 'tabs', method: 'create', args: [props] });
      const t = tab(99, { url: props.url || 'about:blank', active: props.active !== false });
      tabs.push(t);
      return t;
    },
    async update(id, props = {}) { calls.push({ ns: 'tabs', method: 'update', args: [id, props] }); return tab(id, props); },
    async remove(ids) { calls.push({ ns: 'tabs', method: 'remove', args: [ids] }); },
    async reload(id) { calls.push({ ns: 'tabs', method: 'reload', args: [id] }); },
    async captureVisibleTab(windowId, opts) {
      calls.push({ ns: 'tabs', method: 'captureVisibleTab', args: [windowId, opts] });
      return 'data:image/png;base64,AAAA';
    },
    async group(opts) { calls.push({ ns: 'tabs', method: 'group', args: [opts] }); return 7; },
    async ungroup(ids) { calls.push({ ns: 'tabs', method: 'ungroup', args: [ids] }); },
    // Tab events keep their listeners so tests can fire them (rapid tab
    // switching is a real user pattern and its ordering matters).
    onCreated: { addListener: (f) => { calls.push({ ns: 'tabs', method: 'onCreated.addListener', args: [] }); tabEvents.onCreated.push(f); } },
    onUpdated: { addListener: (f) => { calls.push({ ns: 'tabs', method: 'onUpdated.addListener', args: [] }); tabEvents.onUpdated.push(f); }, removeListener(f) { removeFrom(tabEvents.onUpdated, f); } },
    onRemoved: { addListener: (f) => { calls.push({ ns: 'tabs', method: 'onRemoved.addListener', args: [] }); tabEvents.onRemoved.push(f); } },
    onActivated: { addListener: (f) => { calls.push({ ns: 'tabs', method: 'onActivated.addListener', args: [] }); tabEvents.onActivated.push(f); } }
  };

  // ── windows ──
  const windowsApi = {
    async getAll(opts) { calls.push({ ns: 'windows', method: 'getAll', args: [opts] }); return [{ id: 1, focused: true, state: 'normal', type: 'normal', tabs: opts?.populate ? tabs.slice() : undefined }]; },
    async create(props = {}) { calls.push({ ns: 'windows', method: 'create', args: [props] }); return { id: 2, tabs: [tab(100)] }; },
    async get(id) { calls.push({ ns: 'windows', method: 'get', args: [id] }); return { id, focused: true }; }
  };

  // ── runtime ──
  const listeners = { onMessage: [], onInstalled: [], onStartup: [] };
  const runtime = {
    id: 'test-extension-id',
    lastError: undefined,
    getURL: (p) => `chrome-extension://test/${p}`,
    async sendMessage(msg) { calls.push({ ns: 'runtime', method: 'sendMessage', args: [msg] }); return { ok: true, data: {} }; },
    connectNative: (host) => {
      calls.push({ ns: 'runtime', method: 'connectNative', args: [host] });
      return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} };
    },
    connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
    onMessage: { addListener: (f) => listeners.onMessage.push(f) },
    onInstalled: { addListener: (f) => listeners.onInstalled.push(f) },
    onStartup: { addListener: (f) => listeners.onStartup.push(f) },
    onConnect: { addListener() {} },
    getManifest: () => ({ version: '0.0.0-test' })
  };

  // ── scripting ──
  const scripting = {
    async executeScript(opts) {
      calls.push({ ns: 'scripting', method: 'executeScript', args: [opts] });
      return [{ result: { ok: true } }];
    }
  };

  // ── alarms ──
  const alarmMap = new Map();
  const alarms = {
    async create(name, info) { calls.push({ ns: 'alarms', method: 'create', args: [name, info] }); alarmMap.set(name, info); },
    async clear(name) { calls.push({ ns: 'alarms', method: 'clear', args: [name] }); return alarmMap.delete(name); },
    async clearAll() { alarmMap.clear(); return true; },
    async get(name) { return alarmMap.get(name); },
    async getAll() { return [...alarmMap.entries()].map(([name, info]) => ({ name, ...info })); },
    onAlarm: { addListener: record('alarms', 'onAlarm') }
  };

  // ── Generic factory for the simple, data-returning APIs ──
  const simple = (ns, overrides = {}) => ({
    ...overrides,
    __ns: ns
  });

  const dynamicRules = [];

  const chromeStub = {
    __calls: calls,
    __listeners: listeners,
    __tabEvents: tabEvents,
    __store: store,
    runtime,
    storage: { local: storageArea, session: { ...storageArea, get: storageArea.get, set: storageArea.set }, sync: storageArea, onChanged: storageArea.onChanged },
    tabs: tabsApi,
    windows: windowsApi,
    scripting,
    alarms,
    sidePanel: { async open(o) { calls.push({ ns: 'sidePanel', method: 'open', args: [o] }); }, setPanelBehavior: async () => {} },
    permissions: {
      async contains(p) { calls.push({ ns: 'permissions', method: 'contains', args: [p] }); return true; },
      async request(p) { calls.push({ ns: 'permissions', method: 'request', args: [p] }); return true; },
      async remove(p) { return true; },
      onAdded: { addListener() {} }, onRemoved: { addListener() {} }
    },
    i18n: { getMessage: (k) => k },
    contextMenus: {
      create: (o, cb) => { calls.push({ ns: 'contextMenus', method: 'create', args: [o] }); cb?.(); },
      removeAll: (cb) => { calls.push({ ns: 'contextMenus', method: 'removeAll', args: [] }); cb?.(); },
      onClicked: { addListener: record('contextMenus', 'onClicked') }
    },
    cookies: {
      async getAll(q) { calls.push({ ns: 'cookies', method: 'getAll', args: [q] }); return [{ name: 'sid', value: 'x', domain: 'example.test', path: '/', httpOnly: true, secure: true }]; },
      async get(q) { calls.push({ ns: 'cookies', method: 'get', args: [q] }); return { name: 'sid', value: 'x' }; },
      async set(d) { calls.push({ ns: 'cookies', method: 'set', args: [d] }); return d; },
      async remove(d) { calls.push({ ns: 'cookies', method: 'remove', args: [d] }); }
    },
    history: { async search(q) { calls.push({ ns: 'history', method: 'search', args: [q] }); return [{ id: '1', title: 'Example', url: 'https://example.test/', lastVisitTime: Date.now() }]; } },
    bookmarks: { async search(q) { calls.push({ ns: 'bookmarks', method: 'search', args: [q] }); return [{ id: '1', title: 'Example', url: 'https://example.test/' }]; }, getTree: async () => [] },
    downloads: {
      async download(o) { calls.push({ ns: 'downloads', method: 'download', args: [o] }); return 42; },
      async search(q) { calls.push({ ns: 'downloads', method: 'search', args: [q] }); return [{ id: 42, state: 'complete', filename: '/tmp/x' }]; },
      onChanged: { addListener: record('downloads', 'onChanged'), removeListener() {} }
    },
    notifications: { create: (o, cb) => { calls.push({ ns: 'notifications', method: 'create', args: [o] }); cb?.(1); } },
    debugger: {
      async attach(t, v) { calls.push({ ns: 'debugger', method: 'attach', args: [t, v] }); },
      async detach(t) { calls.push({ ns: 'debugger', method: 'detach', args: [t] }); },
      async sendCommand(t, m, p) { calls.push({ ns: 'debugger', method: 'sendCommand', args: [t, m, p] }); return { ok: true }; },
      onDetach: { addListener() {} }, onEvent: { addListener() {} }
    },
    webRequest: {
      onBeforeRequest: { addListener: record('webRequest', 'onBeforeRequest') },
      onSendHeaders: { addListener: record('webRequest', 'onSendHeaders') },
      onHeadersReceived: { addListener: record('webRequest', 'onHeadersReceived') },
      onCompleted: { addListener: record('webRequest', 'onCompleted') },
      onErrorOccurred: { addListener: record('webRequest', 'onErrorOccurred') }
    },
    webNavigation: { onCommitted: { addListener() {} } },
    tabGroups: {
      async query(q) { calls.push({ ns: 'tabGroups', method: 'query', args: [q] }); return [{ id: 7, title: 'Group', color: 'blue', collapsed: false }]; },
      async update(id, p) { calls.push({ ns: 'tabGroups', method: 'update', args: [id, p] }); return { id, ...p }; },
      async get(id) { return { id, title: 'Group', color: 'blue' }; }
    },
    sessions: {
      async getRecentlyClosed(o) { calls.push({ ns: 'sessions', method: 'getRecentlyClosed', args: [o] }); return [{ lastModified: Date.now(), tab: { title: 'Closed', url: 'https://example.test/closed', sessionId: 's1' } }]; },
      async restore(id) { calls.push({ ns: 'sessions', method: 'restore', args: [id] }); return { id, tab: { id: 5 } }; },
      async getDevices() { return []; }
    },
    power: { requestKeepAwake: (l) => calls.push({ ns: 'power', method: 'requestKeepAwake', args: [l] }), releaseKeepAwake: () => calls.push({ ns: 'power', method: 'releaseKeepAwake', args: [] }) },
    pageCapture: { saveAsMHTML: (o, cb) => { calls.push({ ns: 'pageCapture', method: 'saveAsMHTML', args: [o] }); cb(new Blob(['<html></html>'], { type: 'multipart/related' })); } },
    browsingData: { async remove(o, t) { calls.push({ ns: 'browsingData', method: 'remove', args: [o, t] }); } },
    readingList: {
      async addEntry(e) { calls.push({ ns: 'readingList', method: 'addEntry', args: [e] }); },
      async query(q) { calls.push({ ns: 'readingList', method: 'query', args: [q] }); return [{ url: 'https://example.test/', title: 'Example', hasBeenRead: false, creationTime: Date.now() }]; },
      async removeEntry(e) { calls.push({ ns: 'readingList', method: 'removeEntry', args: [e] }); },
      async updateEntry(e) { calls.push({ ns: 'readingList', method: 'updateEntry', args: [e] }); }
    },
    idle: { async queryState(n) { calls.push({ ns: 'idle', method: 'queryState', args: [n] }); return 'active'; }, onStateChanged: { addListener() {} } },
    omnibox: { setDefaultSuggestion: (s) => calls.push({ ns: 'omnibox', method: 'setDefaultSuggestion', args: [s] }), onInputChanged: { addListener() {} }, onInputEntered: { addListener() {} } },
    declarativeNetRequest: {
      // Stateful: the net_rule_* tools verify an install by re-reading the rule
      // list, so a stub that always returns [] would make every install look
      // like it was silently dropped.
      async getDynamicRules() {
        calls.push({ ns: 'declarativeNetRequest', method: 'getDynamicRules', args: [] });
        return [...dynamicRules];
      },
      async updateDynamicRules(o = {}) {
        calls.push({ ns: 'declarativeNetRequest', method: 'updateDynamicRules', args: [o] });
        for (const id of (o.removeRuleIds || [])) {
          const i = dynamicRules.findIndex(r => r.id === id);
          if (i !== -1) dynamicRules.splice(i, 1);
        }
        for (const rule of (o.addRules || [])) {
          const i = dynamicRules.findIndex(r => r.id === rule.id);
          if (i !== -1) dynamicRules[i] = rule; else dynamicRules.push(rule);
        }
      },
      async getAvailableDynamicRuleCount() { return 5000; },
      async isRegexSupported() { return { isSupported: true }; }
    },
    action: { setBadgeText: async (o) => calls.push({ ns: 'action', method: 'setBadgeText', args: [o] }), setIcon: async () => {} },
    commands: { onCommand: { addListener() {} } }
  };

  // Any namespace we did not model: return a permissive object whose methods
  // resolve, so an un-modelled API degrades instead of crashing the suite.
  return new Proxy(chromeStub, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return new Proxy({}, {
        get(_t, m) {
          if (m === 'then') return undefined;
          return (...args) => {
            calls.push({ ns: String(prop), method: String(m), args });
            return Promise.resolve({});
          };
        }
      });
    }
  });
}

module.exports = { makeChrome };
