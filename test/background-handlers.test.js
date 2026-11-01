// Behaviour tests for the MV3 service worker (`background.js`).
//
// `background.js` runs in a service worker and cannot be required, so we load
// the real file into a VM with a recording `chrome` stub — the same technique
// the cron tests use, extended to the message dispatcher and the handlers that
// previous audits found bugs in.
//
// The two regressions pinned here were silent in production:
//  * NET_FETCH blocked forever on an SSE response and buffered unbounded bodies;
//  * network capture lived only in SW memory, so MV3 suspension discarded it
//    while tools still reported `capturing:true`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { makeChrome } = require('./helpers/chrome-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf-8');

/** Load background.js in a fresh VM sharing `chrome` (so a reload = SW restart). */
function loadWorker(chrome = makeChrome(), overrides = {}) {
  // A fresh SW instance: drop listeners left by any previous instance.
  if (chrome.__listeners) {
    for (const k of Object.keys(chrome.__listeners)) chrome.__listeners[k].length = 0;
  }
  const sandbox = {
    chrome,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, Date, JSON, Object, Array, Set, Map, WeakMap, Number, String,
    Boolean, RegExp, Error, TypeError, Symbol, Proxy, Reflect,
    atob, btoa, TextEncoder, TextDecoder, Uint8Array, Uint16Array, ArrayBuffer,
    URL, Blob, fetch: overrides.fetch || (async () => ({ ok: false, status: 0, text: async () => '', headers: { get: () => null, forEach: () => {} } })),
    AbortController, AbortSignal,
    indexedDB: { open: () => { throw new Error('indexedDB unavailable in this test'); } },
    navigator: { userAgent: 'node' },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(SRC, context, { filename: 'background.js' });
  return { sandbox, chrome };
}

/** Invoke the registered onMessage listener like Chrome would. */
function dispatch(chrome, msg) {
  const listener = chrome.__listeners.onMessage[0];
  assert.ok(listener, 'background.js must register a runtime.onMessage listener');
  return new Promise((resolve) => {
    const keepOpen = listener(msg, {}, resolve);
    // The listener returns true to keep the channel open for an async reply.
    if (keepOpen !== true) resolve(undefined);
  });
}

// ── Dispatcher ───────────────────────────────────────
test('the message dispatcher wraps handler results as { ok, data }', async () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  const res = await dispatch(chrome, { type: 'NET_CAPTURE_LIST', args: {} });
  assert.equal(res.ok, true);
  assert.ok(res.data && typeof res.data === 'object');
});

test('the dispatcher turns a thrown handler error into { ok:false, error }', async () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  // NET_FETCH with no url throws by design; the dispatcher must catch it.
  const res = await dispatch(chrome, { type: 'NET_FETCH', args: {} });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /url required/i);
});

test('an unknown message type is ignored rather than throwing', async () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  const res = await dispatch(chrome, { type: 'TOTALLY_UNKNOWN', args: {} });
  assert.equal(res, undefined, 'unknown types must not reply (no handler)');
});

// ── NET_FETCH (audit C9) ─────────────────────────────
function mkRes({ ct, body, status = 200 }) {
  return {
    status, statusText: 'OK',
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ct : null), forEach: (cb) => cb('content-type', ct) },
    body,
  };
}

test('NET_FETCH cancels an endless SSE stream instead of hanging', async () => {
  let cancelled = 0;
  const chrome = makeChrome();
  const enc = (s) => new TextEncoder().encode(s);
  loadWorker(chrome, {
    fetch: async () => mkRes({
      ct: 'text/event-stream',
      body: {
        getReader: () => {
          let n = 0;
          return {
            read: async () => (n++ < 20 ? { value: enc('data: {"x":1}\n\n'), done: false } : new Promise(() => {})),
            cancel: async () => { cancelled++; },
          };
        },
      },
    })
  });
  const res = await dispatch(chrome, { type: 'NET_FETCH', args: { url: 'https://x/sse', maxBodyBytes: 50 } });
  assert.equal(res.ok, true);
  assert.equal(cancelled, 1, 'the stream must be cancelled, not read to EOF');
  assert.match(res.data.body, /event-stream|capture window/i);
});

test('NET_FETCH does not buffer a binary body', async () => {
  let cancelled = 0;
  const chrome = makeChrome();
  loadWorker(chrome, {
    fetch: async () => mkRes({ ct: 'application/octet-stream', body: { cancel: async () => { cancelled++; } } })
  });
  const res = await dispatch(chrome, { type: 'NET_FETCH', args: { url: 'https://x/bin' } });
  assert.equal(res.ok, true);
  assert.equal(cancelled, 1);
  assert.match(res.data.body, /binary/i);
});

test('NET_FETCH caps a text body at maxBodyBytes', async () => {
  const chrome = makeChrome();
  const enc = (s) => new TextEncoder().encode(s);
  loadWorker(chrome, {
    fetch: async () => mkRes({
      ct: 'text/plain',
      body: {
        getReader: () => {
          let n = 0;
          return { read: async () => (n++ < 5 ? { value: enc('a'.repeat(100)), done: false } : { done: true }), cancel: async () => {} };
        },
      },
    })
  });
  const res = await dispatch(chrome, { type: 'NET_FETCH', args: { url: 'https://x/big', maxBodyBytes: 150 } });
  assert.equal(res.ok, true);
  assert.match(res.data.body, /truncated/);
  assert.ok(res.data.body.length < 400, 'body must be bounded');
});

test('NET_FETCH times out a fetch that never resolves', async () => {
  const chrome = makeChrome();
  loadWorker(chrome, {
    fetch: (url, init) => new Promise((_, rej) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    })
  });
  const res = await dispatch(chrome, { type: 'NET_FETCH', args: { url: 'https://x/hang', timeoutMs: 50 } });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /timed out/i);
});

// ── Network capture survives an SW restart (audit C3) ──
test('capture state survives a simulated service-worker restart', async () => {
  const chrome = makeChrome();
  // First SW instance: start a capture.
  loadWorker(chrome);
  const started = await dispatch(chrome, { type: 'NET_CAPTURE_START', args: { scope: 'all' } });
  assert.equal(started.ok, true);
  assert.equal(started.data.capturing, true);
  const persisted = chrome.__store.get('kyoto.capture.state');
  assert.ok(persisted && persisted.active === true, 'capture flag must be persisted to storage.session');

  // Second instance on the same storage = the worker restarted. Module-level
  // state is gone; hydrateCaptureState() must restore it.
  loadWorker(chrome);
  const listed = await dispatch(chrome, { type: 'NET_CAPTURE_LIST', args: {} });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.capturing, true, 'capture must still be active after a restart');
  assert.equal(listed.data.resumedAfterRestart, true);
  assert.match(String(listed.data.notice), /restart/i, 'the caller must be told the buffer was lost');
});

test('stopping a capture clears the persisted flag', async () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  await dispatch(chrome, { type: 'NET_CAPTURE_START', args: { scope: 'all' } });
  await dispatch(chrome, { type: 'NET_CAPTURE_STOP', args: {} });
  const persisted = chrome.__store.get('kyoto.capture.state');
  assert.ok(persisted && persisted.active === false);
  loadWorker(chrome);
  const listed = await dispatch(chrome, { type: 'NET_CAPTURE_LIST', args: {} });
  assert.equal(listed.data.capturing, false);
});

// ── Context menus are idempotent (audit C20) ─────────
test('onInstalled removes existing context menus before creating them', () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  const listener = chrome.__listeners.onInstalled[0];
  assert.ok(listener, 'onInstalled listener must be registered');
  listener();
  const menuCalls = chrome.__calls.filter(c => c.ns === 'contextMenus');
  assert.ok(menuCalls.length >= 2, 'menus must be created');
  const removeIdx = menuCalls.findIndex(c => c.method === 'removeAll');
  const firstCreate = menuCalls.findIndex(c => c.method === 'create');
  assert.ok(removeIdx > -1, 'removeAll must be called first (duplicate ids otherwise)');
  assert.ok(removeIdx < firstCreate, 'removeAll must precede create');
});

// ── Omnibox wiring ───────────────────────────────────
test('the omnibox default suggestion and keyword are registered', () => {
  const chrome = makeChrome();
  loadWorker(chrome);
  const sug = chrome.__calls.find(c => c.ns === 'omnibox' && c.method === 'setDefaultSuggestion');
  assert.ok(sug, 'omnibox default suggestion must be set');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf-8'));
  assert.ok(manifest.omnibox?.keyword, 'manifest must declare an omnibox keyword');
});
