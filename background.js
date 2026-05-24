// ── Boot ─────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'kt-ask-selection',
    title: 'Ask Kyoto about "%s"',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'kt-ask-page',
    title: 'Ask Kyoto about this page',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch {}
  const payload = info.menuItemId === 'kt-ask-selection'
    ? { type: 'ASK_SELECTION', text: info.selectionText || '' }
    : { type: 'ASK_PAGE' };
  setTimeout(() => { chrome.runtime.sendMessage(payload).catch(() => {}); }, 250);
});

// ── Network capture (webRequest, observe-only in MV3) ──
const RING_MAX = 500;
const capture = {
  active: false,
  filterTabId: null,
  events: [],   // ring buffer of completed requests
  inflight: new Map()  // requestId -> partial record
};

function pushEvent(rec) {
  capture.events.push(rec);
  if (capture.events.length > RING_MAX) capture.events.splice(0, capture.events.length - RING_MAX);
}

function shouldRecord(details) {
  if (!capture.active) return false;
  if (capture.filterTabId != null && details.tabId !== capture.filterTabId) return false;
  return true;
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (!shouldRecord(d)) return;
  capture.inflight.set(d.requestId, {
    id: d.requestId,
    url: d.url,
    method: d.method,
    type: d.type,
    tabId: d.tabId,
    started: d.timeStamp,
    initiator: d.initiator
  });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onSendHeaders.addListener((d) => {
  const rec = capture.inflight.get(d.requestId);
  if (rec) rec.requestHeaders = d.requestHeaders;
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const rec = capture.inflight.get(d.requestId);
  if (rec) rec.responseHeaders = d.responseHeaders;
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

chrome.webRequest.onCompleted.addListener((d) => {
  const rec = capture.inflight.get(d.requestId);
  if (!rec) return;
  rec.status = d.statusCode;
  rec.statusLine = d.statusLine;
  rec.fromCache = d.fromCache;
  rec.completed = d.timeStamp;
  rec.durationMs = Math.round(d.timeStamp - rec.started);
  rec.ip = d.ip;
  capture.inflight.delete(d.requestId);
  pushEvent(rec);
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((d) => {
  const rec = capture.inflight.get(d.requestId);
  if (!rec) return;
  rec.error = d.error;
  rec.completed = d.timeStamp;
  rec.durationMs = Math.round(d.timeStamp - rec.started);
  capture.inflight.delete(d.requestId);
  pushEvent(rec);
}, { urls: ['<all_urls>'] });

// ── Tool handlers (background-side) ────────────────────
async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id ?? null;
}

const HANDLERS = {
  // ── page extraction (existing) ───────
  async PAGE_EXTRACT_CONTENT({ tabId } = {}) {
    tabId = tabId ?? await activeTabId();
    if (!tabId) throw new Error('no active tab');
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const drop = 'script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role="navigation"]';
        const cands = Array.from(document.querySelectorAll(
          'article, main, [role="main"], .post-content, .article-content, .entry-content, #content'
        )).filter(el => el.textContent.trim().length > 200);
        let root = cands[0];
        if (!root) {
          let best = null, bestScore = 0;
          for (const el of document.body.querySelectorAll('*')) {
            if (el.matches(drop)) continue;
            const txt = el.textContent.trim();
            if (txt.length < 300) continue;
            const blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote').length;
            if (blocks < 3) continue;
            const score = txt.length * (blocks / Math.max(1, el.querySelectorAll('*').length));
            if (score > bestScore) { bestScore = score; best = el; }
          }
          root = best || document.body;
        }
        const clone = root.cloneNode(true);
        clone.querySelectorAll(drop).forEach(n => n.remove());
        let text = clone.textContent.replace(/\s+/g, ' ').trim();
        if (text.length > 20000) text = text.slice(0, 20000) + '… [truncated]';
        return { title: document.title || '', url: location.href, content: text };
      }
    });
    return res?.result || { title: '', url: '', content: '' };
  },

  // ── network capture ──────────────────
  async NET_CAPTURE_START({ tabId, scope = 'all' } = {}) {
    capture.active = true;
    capture.filterTabId = scope === 'tab' ? (tabId ?? await activeTabId()) : null;
    return { capturing: true, scope, tabId: capture.filterTabId };
  },
  NET_CAPTURE_STOP() {
    capture.active = false;
    return { capturing: false, kept: capture.events.length };
  },
  NET_CAPTURE_CLEAR() {
    capture.events = [];
    capture.inflight.clear();
    return { cleared: true };
  },
  NET_CAPTURE_LIST({ filter, limit = 100, sinceMs } = {}) {
    let out = capture.events;
    if (sinceMs) out = out.filter(r => r.started >= sinceMs);
    if (filter) {
      const re = new RegExp(filter, 'i');
      out = out.filter(r => re.test(r.url) || re.test(String(r.status || '')));
    }
    return {
      capturing: capture.active,
      total: capture.events.length,
      shown: Math.min(out.length, limit),
      events: out.slice(-limit).map(r => ({
        method: r.method, status: r.status, url: r.url, type: r.type,
        durationMs: r.durationMs, fromCache: r.fromCache, tabId: r.tabId,
        error: r.error
      }))
    };
  },
  NET_CAPTURE_DETAIL({ id }) {
    const rec = capture.events.find(r => r.id === id);
    if (!rec) return { error: 'not found' };
    return rec;
  },
  NET_CAPTURE_POSTMAN({ filter, includeSince, name = 'Kyoto capture' } = {}) {
    let events = capture.events;
    if (includeSince) events = events.filter(r => r.started >= includeSince);
    if (filter) {
      const re = new RegExp(filter, 'i');
      events = events.filter(r => re.test(r.url));
    }
    // Group by host so the collection is readable.
    const byHost = new Map();
    for (const r of events) {
      let host = '';
      try { host = new URL(r.url).host; } catch { host = 'other'; }
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(r);
    }
    const items = [...byHost.entries()].map(([host, reqs]) => ({
      name: host,
      item: reqs.map(r => {
        let u;
        try { u = new URL(r.url); } catch { u = null; }
        const queryArr = [];
        if (u) u.searchParams.forEach((v, k) => queryArr.push({ key: k, value: v }));
        const headers = (r.requestHeaders || []).map(h => ({ key: h.name, value: h.value }));
        return {
          name: `${r.method} ${u ? u.pathname || '/' : r.url}`,
          request: {
            method: r.method,
            header: headers,
            url: u ? {
              raw: r.url,
              protocol: (u.protocol || 'https:').replace(':', ''),
              host: u.hostname.split('.'),
              path: (u.pathname || '/').replace(/^\/+/, '').split('/'),
              query: queryArr
            } : { raw: r.url }
          },
          response: []
        };
      })
    }));
    return {
      info: {
        name,
        _postman_id: 'kyoto-' + Math.random().toString(36).slice(2),
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: items
    };
  },
  NET_CAPTURE_HAR({ filter, includeSince } = {}) {
    let events = capture.events;
    if (includeSince) events = events.filter(r => r.started >= includeSince);
    if (filter) {
      const re = new RegExp(filter, 'i');
      events = events.filter(r => re.test(r.url));
    }
    const toHeaderArray = (hs) => (hs || []).map(h => ({ name: h.name, value: h.value }));
    const entries = events.map((r) => ({
      startedDateTime: new Date(r.started).toISOString(),
      time: r.durationMs || 0,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: 'HTTP/1.1',
        headers: toHeaderArray(r.requestHeaders),
        queryString: (() => {
          try {
            const u = new URL(r.url);
            const out = [];
            u.searchParams.forEach((v, k) => out.push({ name: k, value: v }));
            return out;
          } catch { return []; }
        })(),
        cookies: [],
        headersSize: -1,
        bodySize: -1
      },
      response: {
        status: r.status || 0,
        statusText: r.statusLine ? r.statusLine.split(' ').slice(2).join(' ') : '',
        httpVersion: 'HTTP/1.1',
        headers: toHeaderArray(r.responseHeaders),
        cookies: [],
        content: {
          size: 0,
          mimeType: (r.responseHeaders || []).find(h => /^content-type$/i.test(h.name))?.value || ''
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: -1
      },
      cache: {},
      timings: { send: 0, wait: r.durationMs || 0, receive: 0 },
      _error: r.error,
      _resourceType: r.type,
      _fromCache: r.fromCache,
      _initiator: r.initiator,
      _serverIPAddress: r.ip
    }));
    return {
      log: {
        version: '1.2',
        creator: { name: 'Kyoto', version: '7.0.0' },
        browser: { name: 'Chrome', version: 'unknown' },
        entries
      }
    };
  },

  // ── server-side fetch (replay with cookies) ──
  async NET_FETCH({ url, method = 'GET', headers = {}, body, includeCookies = true, maxBodyBytes = 65536 }) {
    if (!url) throw new Error('url required');
    const init = { method, headers, credentials: includeCookies ? 'include' : 'omit' };
    if (body != null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(url, init);
    const ct = res.headers.get('content-type') || '';
    const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/.test(ct);
    let bodyOut;
    if (isText) {
      bodyOut = await res.text();
      if (bodyOut.length > maxBodyBytes) bodyOut = bodyOut.slice(0, maxBodyBytes) + '… [truncated]';
    } else {
      const buf = await res.arrayBuffer();
      bodyOut = `[binary ${buf.byteLength} bytes, content-type=${ct}]`;
    }
    const headersOut = {};
    res.headers.forEach((v, k) => { headersOut[k] = v; });
    return { status: res.status, statusText: res.statusText, headers: headersOut, body: bodyOut };
  },

  // ── debugger (optional permission) ──
  async DEBUGGER_ATTACH({ tabId } = {}) {
    tabId = tabId ?? await activeTabId();
    await chrome.debugger.attach({ tabId }, '1.3');
    return { attached: true, tabId };
  },
  async DEBUGGER_DETACH({ tabId } = {}) {
    tabId = tabId ?? await activeTabId();
    await chrome.debugger.detach({ tabId });
    return { detached: true, tabId };
  },
  async DEBUGGER_SEND({ tabId, method, params = {} } = {}) {
    tabId = tabId ?? await activeTabId();
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result || { ok: true };
  },

  async REQUEST_OPTIONAL_PERMISSION({ permissions = [], origins = [] } = {}) {
    const granted = await chrome.permissions.request({ permissions, origins });
    return { granted };
  },
  async CHECK_PERMISSION({ permissions = [], origins = [] } = {}) {
    const has = await chrome.permissions.contains({ permissions, origins });
    return { has };
  },

  // ── state pipe (chrome.storage.local with TTL) ──
  async STATE_GET({ key } = {})      { return Cron.stateGet(key); },
  async STATE_SET({ key, value, ttlMs, writtenBy } = {}) { return Cron.stateSet(key, value, { ttlMs, writtenBy }); },
  async STATE_DELETE({ key } = {})   { return Cron.stateDelete(key); },
  async STATE_LIST({ prefix } = {})  { return Cron.stateList(prefix); },

  // ── cron job management ──
  async CRON_ADD(spec)               { return Cron.addJob(spec || {}); },
  async CRON_LIST({ includePaused = true } = {}) { return Cron.listJobs({ includePaused }); },
  async CRON_GET({ id } = {})        { return Cron.getJob(id); },
  async CRON_REMOVE({ id } = {})     { return Cron.removeJob(id); },
  async CRON_PAUSE({ id } = {})      { return Cron.pauseJob(id); },
  async CRON_RESUME({ id } = {})     { return Cron.resumeJob(id); },
  async CRON_RUN_NOW({ id, async: asyncRun = false } = {}) { return Cron.runJobNow(id, { async: asyncRun }); },
  async CRON_LOGS({ id, limit = 20, sinceMs } = {}) { return Cron.getJobLogs(id, { limit, sinceMs }); },
  async CRON_STATUS()                { return Cron.status(); },
  async CRON_UPDATE({ id, ...patch } = {}) { return Cron.updateJob(id, patch); },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  // Legacy alias
  if (msg.type === 'GET_PAGE_CONTENT') msg.type = 'PAGE_EXTRACT_CONTENT';
  const handler = HANDLERS[msg.type];
  if (!handler) return;
  (async () => {
    try { sendResponse({ ok: true, data: await handler(msg.args || msg) }); }
    catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
  })();
  return true;
});

// ─────────────────────────────────────────────────────────────────
// Codex SSE proxy
// ─────────────────────────────────────────────────────────────────
// Chrome's side panel / extension-page fetch sometimes refuses to
// stream cross-origin SSE responses (CORS quirks; Cloudflare-fronted
// endpoints that omit Content-Type / Access-Control-Allow-Origin).
// The service worker doesn't hit those quirks — fetch + response.body
// streaming works reliably here. So we proxy the Codex POST: side
// panel opens a port, posts the request; we fetch and pipe each chunk
// back as a port message; the side panel rebuilds a ReadableStream
// from those messages and feeds its existing parser.
//
// Port lifecycle:
//   panel -> connect({ name: 'codex-stream' })
//   panel -> port.postMessage({ type: 'start', url, headers, body })
//   bg    -> port.postMessage({ type: 'status', status, headers })  // once
//   bg    -> port.postMessage({ type: 'chunk', data })              // 0..N times (data: Array<number>)
//   bg    -> port.postMessage({ type: 'done' })                     // terminal
//   bg    -> port.postMessage({ type: 'error', message })           // alt terminal
//   panel -> port.postMessage({ type: 'abort' })                    // user cancel
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'codex-stream') return;
  const ac = new AbortController();
  let timeoutId = null;
  let sawResponse = false;
  let terminalSent = false;
  const clearRequestTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearRequestTimeout();
    try { ac.abort(); } catch {}
    try { port.disconnect(); } catch {}
  };
  const finishAfterFlush = () => {
    clearRequestTimeout();
    // Port messages are delivered asynchronously. Disconnecting in the
    // same tick as the terminal message can drop the final chunk/error,
    // which looks like a silent "no response" in the side panel.
    setTimeout(cleanup, 250);
  };
  const postTerminal = (message) => {
    if (terminalSent) return false;
    terminalSent = true;
    try { port.postMessage(message); } catch {}
    finishAfterFlush();
    return true;
  };
  port.onDisconnect.addListener(cleanup);
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'abort') { cleanup(); return; }
    if (msg?.type !== 'start') return;
    const { url, headers, body } = msg;
    try {
      timeoutId = setTimeout(() => {
        if (sawResponse) return;
        postTerminal({ type: 'error', message: 'Codex request timed out before response headers' });
      }, 90_000);
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
      sawResponse = true;
      clearRequestTimeout();
      const respHeaders = {};
      try { res.headers.forEach((v, k) => { respHeaders[k] = v; }); } catch {}
      port.postMessage({ type: 'status', status: res.status, statusText: res.statusText, headers: respHeaders });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        postTerminal({ type: 'error', message: `HTTP ${res.status}: ${text.slice(0, 800)}` });
        return;
      }
      if (!res.body) {
        postTerminal({ type: 'error', message: 'response.body was null (no stream)' });
        return;
      }

      // Snapshot quota headers — Codex returns 200 + opens a stream for
      // accounts without Codex access (free plan, depleted go/edu plan,
      // etc.) and then sends nothing. Pre-empt that stall with a clear
      // error rather than letting the post-stream idle timer fire.
      const plan = (respHeaders['x-codex-plan-type'] || '').toLowerCase();
      const hasCredits = respHeaders['x-codex-credits-has-credits'] || '';
      const unlimited = respHeaders['x-codex-credits-unlimited'] || '';
      const usedPct = respHeaders['x-codex-primary-used-percent'] || '';
      const resetSec = respHeaders['x-codex-primary-reset-after-seconds'] || '';
      const reqId = respHeaders['x-oai-request-id'] || '';
      const limit = respHeaders['x-codex-active-limit'] || '';
      const quotaSummary = (
        `plan=${plan || '?'}, limit=${limit || '?'}, hasCredits=${hasCredits || '?'}` +
        `, unlimited=${unlimited || '?'}, used=${usedPct || '?'}%` +
        (resetSec ? `, reset=${Math.round(Number(resetSec) / 3600)}h` : '') +
        (reqId ? `, request=${reqId}` : '')
      );

      // Plans known to actually receive Codex output via the OAuth backend.
      // 'go' is allowlisted only if the user still has primary quota left.
      const PAID_PLANS = new Set(['plus', 'pro', 'business', 'enterprise', 'team']);
      const isPaid = PAID_PLANS.has(plan);
      const isUnlimited = unlimited === 'True' || unlimited === 'true';
      const goWithBudget = plan === 'go' && Number(usedPct) < 100;
      const canCallCodex = isPaid || isUnlimited || goWithBudget || hasCredits === 'True';
      if (!canCallCodex) {
        postTerminal({
          type: 'error',
          message:
            `Your ChatGPT subscription doesn't include Codex access. ${quotaSummary}. ` +
            `Upgrade to ChatGPT Plus/Pro for Codex models, OR open Settings → API key to use ` +
            `regular OpenAI models (GPT-4o, o3, etc.) via your OpenAI API account.`,
        });
        return;
      }

      const reader = res.body.getReader();
      // 45s post-stream-idle timer — if Codex opens the stream but
      // never flushes any bytes (quota stall behaviour), abort and
      // surface the quota header snapshot rather than spinning forever.
      const STREAM_IDLE_MS = 45_000;
      let sawAnyBytes = false;
      const streamIdleTimer = setTimeout(() => {
        if (sawAnyBytes) return;
        postTerminal({
          type: 'error',
          message:
            `Codex accepted the request but sent no SSE bytes while idle after streaming ` +
            `started for ${Math.round(STREAM_IDLE_MS / 1000)}s. Codex quota headers: ${quotaSummary}. ` +
            `This is a backend/quota stall, not an OAuth failure.`,
        });
        try { ac.abort(); } catch {}
      }, STREAM_IDLE_MS);

      while (true) {
        if (ac.signal.aborted) { cleanup(); return; }
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          if (!sawAnyBytes) {
            sawAnyBytes = true;
            clearTimeout(streamIdleTimer);
          }
          // Port messages are JSON-serialised, so Uint8Array becomes
          // {0:n,1:n,…}. Convert to a plain array on send and back to
          // bytes on receive.
          port.postMessage({ type: 'chunk', data: Array.from(value) });
        }
      }
      clearTimeout(streamIdleTimer);
      if (!sawAnyBytes && !terminalSent) {
        postTerminal({
          type: 'error',
          message:
            `Codex closed the stream without sending any bytes. ${quotaSummary}. ` +
            `This usually means your plan doesn't have Codex access right now.`,
        });
      } else {
        postTerminal({ type: 'done' });
      }
    } catch (e) {
      if (terminalSent) return;
      if (e?.name === 'AbortError') postTerminal({ type: 'error', message: 'aborted' });
      else postTerminal({ type: 'error', message: e?.message || String(e) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Background jobs (cron) + shared state pipe
// ─────────────────────────────────────────────────────────────────
// Design: see PLAN-cron.md. tl;dr:
//   - Job specs in chrome.storage.local[kyoto.cron.jobs].
//   - State pipe in chrome.storage.local[kyoto.cron.state] with TTL.
//   - Run history in IndexedDB `kyoto-cron-logs` so it doesn't eat
//     the 5MB storage quota.
//   - chrome.alarms wakes the SW; we dispatch by jobId.
//   - For cron-expr jobs we keep a 1-minute master alarm and check
//     each tick which jobs are due.
//
// Job code runs in the SW with a K sandbox object:
//   K.state, K.log, K.stderr, K.now, K.job, K.tools, K.chrome
// K.tools is a SW-safe subset; the K.chrome escape hatch is right
// there for anything else.

const Cron = (() => {
  'use strict';

  const STORAGE_JOBS  = 'kyoto.cron.jobs';
  const STORAGE_STATE = 'kyoto.cron.state';
  const STORAGE_RT    = 'kyoto.cron.runtime';
  const ALARM_PREFIX  = 'kyoto-cron:';
  const ALARM_MASTER  = 'kyoto-cron:master';
  const SCHEMA_VERSION = 1;
  const MAX_STATE_BYTES = 50 * 1024;   // 50KB per value
  const MAX_RUNS_PER_JOB = 200;
  const DEFAULT_AUTO_PAUSE = 5;
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min per run

  // ── chrome.storage.local read/write helpers ──
  async function loadObj(key) {
    const got = await chrome.storage.local.get(key);
    return got[key] || {};
  }
  async function saveObj(key, val) {
    await chrome.storage.local.set({ [key]: val });
  }

  // ── State pipe ──
  function _expired(rec) {
    if (!rec || !rec.ttlMs) return false;
    return (rec.writtenAt + rec.ttlMs) <= Date.now();
  }

  async function stateGet(key) {
    if (!key) throw new Error('key required');
    const all = await loadObj(STORAGE_STATE);
    const rec = all[key];
    if (!rec) return { missing: true };
    const expired = _expired(rec);
    return {
      value: rec.value, writtenAt: rec.writtenAt,
      ttlMs: rec.ttlMs || null, writtenBy: rec.writtenBy || null,
      expired
    };
  }

  async function stateSet(key, value, { ttlMs, writtenBy } = {}) {
    if (!key) throw new Error('key required');
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_STATE_BYTES) {
      throw new Error(`state value too large (${serialized.length} > ${MAX_STATE_BYTES} bytes). Keep cron state small; put bulk data in KyotoVFS.`);
    }
    const all = await loadObj(STORAGE_STATE);
    all[key] = {
      value, writtenAt: Date.now(),
      ttlMs: ttlMs || null,
      writtenBy: writtenBy || 'agent',
    };
    await saveObj(STORAGE_STATE, all);
    return { ok: true, writtenAt: all[key].writtenAt };
  }

  async function stateDelete(key) {
    const all = await loadObj(STORAGE_STATE);
    if (!(key in all)) return { deleted: false };
    delete all[key];
    await saveObj(STORAGE_STATE, all);
    return { deleted: true };
  }

  async function stateList(prefix) {
    const all = await loadObj(STORAGE_STATE);
    const items = Object.entries(all)
      .filter(([k]) => !prefix || k.startsWith(prefix))
      .map(([key, rec]) => ({
        key, writtenAt: rec.writtenAt,
        ttlMs: rec.ttlMs || null,
        expired: _expired(rec),
        writtenBy: rec.writtenBy || null,
        bytes: JSON.stringify(rec.value || null).length,
      }));
    return { count: items.length, items };
  }

  // ── Run-history IndexedDB ──
  // Separate DB so it doesn't fight KyotoVFS or chrome.storage quota.
  const IDB_NAME = 'kyoto-cron-logs';
  const IDB_VERSION = 1;
  const IDB_STORE = 'runs';
  let _idbPromise = null;

  function openIdb() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          // Composite key [jobId, ts] so reads-by-job are cheap and
          // appends are naturally chronological.
          const os = db.createObjectStore(IDB_STORE, { keyPath: ['jobId', 'ts'] });
          os.createIndex('byJob', 'jobId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _idbPromise;
  }

  async function appendRun(jobId, run) {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ jobId, ...run });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    // Trim oldest beyond cap.
    const runs = await readRuns(jobId, MAX_RUNS_PER_JOB + 50);
    if (runs.length > MAX_RUNS_PER_JOB) {
      const toDelete = runs.slice(MAX_RUNS_PER_JOB);  // sorted newest-first
      const db2 = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = db2.transaction(IDB_STORE, 'readwrite');
        const os = tx.objectStore(IDB_STORE);
        for (const r of toDelete) os.delete([r.jobId, r.ts]);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  async function readRuns(jobId, limit = 20) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const idx = tx.objectStore(IDB_STORE).index('byJob');
      const out = [];
      // Walk in reverse — newest first.
      const cursorReq = idx.openCursor(IDB_KeyRange_only(jobId), 'prev');
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (!cur || out.length >= limit) return resolve(out);
        out.push(cur.value);
        cur.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  function IDB_KeyRange_only(v) { return IDBKeyRange.only(v); }

  async function deleteRunsForJob(jobId) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const idx = tx.objectStore(IDB_STORE).index('byJob');
      const cursorReq = idx.openCursor(IDBKeyRange.only(jobId));
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (!cur) return;
        cur.delete();
        cur.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Schedule parsing ──
  // Supported `every` shorthand: '30s','5m','2h','1d'.
  function parseEvery(s) {
    if (typeof s !== 'string') return null;
    const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
    return ms;
  }

  // Tiny cron-expr matcher: minute hour dom month dow.
  // Each field: '*', N, N-M, N,N,N, '*/N', or combinations.
  // Returns true if `d` matches the expr.
  function parseField(expr, min, max) {
    if (expr === '*') return new Set(rangeArr(min, max));
    const out = new Set();
    for (const part of expr.split(',')) {
      let step = 1; let body = part;
      if (part.includes('/')) {
        const [b, s] = part.split('/');
        body = b || '*'; step = parseInt(s, 10) || 1;
      }
      let lo = min, hi = max;
      if (body !== '*') {
        if (body.includes('-')) {
          const [a, b] = body.split('-').map(Number);
          lo = a; hi = b;
        } else {
          lo = parseInt(body, 10);
          hi = parseInt(body, 10);
        }
      }
      for (let i = lo; i <= hi; i += step) if (i >= min && i <= max) out.add(i);
    }
    return out;
  }
  function rangeArr(lo, hi) { const a = []; for (let i = lo; i <= hi; i++) a.push(i); return a; }

  function cronMatches(expr, d) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [min, hr, dom, mon, dow] = parts;
    try {
      if (!parseField(min, 0, 59).has(d.getMinutes())) return false;
      if (!parseField(hr,  0, 23).has(d.getHours())) return false;
      if (!parseField(dom, 1, 31).has(d.getDate())) return false;
      if (!parseField(mon, 1, 12).has(d.getMonth() + 1)) return false;
      if (!parseField(dow, 0, 6 ).has(d.getDay())) return false;
      return true;
    } catch { return false; }
  }

  // ── Job management ──
  function slugify(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';
  }
  function newId() {
    return 'job_' + Math.random().toString(36).slice(2, 12);
  }

  function validateSpec(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('spec required');
    if (!spec.name || typeof spec.name !== 'string') throw new Error('name required (string)');
    if (!spec.schedule || typeof spec.schedule !== 'object') throw new Error('schedule required');
    if (!spec.schedule.every && !spec.schedule.cron) {
      throw new Error('schedule.every (e.g. "25m") or schedule.cron (e.g. "0 * * * *") required');
    }
    if (spec.schedule.every && parseEvery(spec.schedule.every) == null) {
      throw new Error(`invalid schedule.every: ${spec.schedule.every}. Use N s/m/h/d, e.g. "30m".`);
    }
    if (spec.schedule.every && parseEvery(spec.schedule.every) < 30000) {
      throw new Error(`schedule.every minimum is 30s (chrome.alarms limit). Got ${spec.schedule.every}.`);
    }
    if (spec.schedule.cron) {
      const expr = String(spec.schedule.cron).trim();
      const parts = expr.split(/\s+/);
      if (parts.length !== 5) {
        throw new Error(`invalid schedule.cron: "${expr}". Need 5 fields (minute hour day-of-month month day-of-week).`);
      }
      // Each field is comma-separated; each part is *, N, N-M, optionally /S.
      const partRe = /^(\*|\d+(-\d+)?)(\/\d+)?$/;
      const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
      for (let i = 0; i < 5; i++) {
        for (const sub of parts[i].split(',')) {
          if (!partRe.test(sub)) {
            throw new Error(`invalid schedule.cron: "${expr}" — field ${i + 1} ("${parts[i]}") has unparseable part "${sub}".`);
          }
        }
        // Sanity-check the parsed range produces at least one value.
        const set = parseField(parts[i], limits[i][0], limits[i][1]);
        if (set.size === 0) {
          throw new Error(`invalid schedule.cron: "${expr}" — field ${i + 1} ("${parts[i]}") matches no values in [${limits[i][0]},${limits[i][1]}].`);
        }
      }
    }
    if (!spec.code || typeof spec.code !== 'string') throw new Error('code required (JS string)');
  }

  async function addJob(spec) {
    validateSpec(spec);
    const jobs = await loadObj(STORAGE_JOBS);
    const slug = slugify(spec.name);
    // Enforce slug uniqueness so logs / alarm names are predictable.
    for (const j of Object.values(jobs)) {
      if (j.slug === slug) throw new Error(`a job with slug "${slug}" already exists (id ${j.id})`);
    }
    const id = newId();
    const now = Date.now();
    const job = {
      id, name: spec.name, slug,
      schedule: spec.schedule,
      code: spec.code,
      paused: !!spec.paused,
      singleton: !!spec.singleton,
      notes: spec.notes || '',
      timeoutMs: spec.timeoutMs || DEFAULT_TIMEOUT_MS,
      autoPauseAfter: spec.autoPauseAfter || DEFAULT_AUTO_PAUSE,
      createdAt: now,
      lastRunAt: null, lastError: null,
      nextRunAt: null,
      consecutiveFailures: 0,
      _runningSince: null,    // set on execute start, cleared on finish
      _backoffUntil: null,    // set on failure, cleared on success/resume
      _schemaVersion: SCHEMA_VERSION,
    };
    jobs[id] = job;
    await saveObj(STORAGE_JOBS, jobs);
    if (!job.paused) await scheduleAlarm(job);
    job.nextRunAt = job.nextRunAt;
    return job;
  }

  async function listJobs({ includePaused = true } = {}) {
    const jobs = await loadObj(STORAGE_JOBS);
    return {
      jobs: Object.values(jobs)
        .filter(j => includePaused || !j.paused)
        .map(j => ({
          id: j.id, name: j.name, slug: j.slug,
          schedule: j.schedule, paused: j.paused,
          lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt,
          consecutiveFailures: j.consecutiveFailures,
          lastError: j.lastError,
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    };
  }

  async function getJob(id) {
    const jobs = await loadObj(STORAGE_JOBS);
    const j = jobs[id];
    if (!j) throw new Error(`no job with id ${id}`);
    return j;
  }

  async function updateJob(id, patch) {
    const jobs = await loadObj(STORAGE_JOBS);
    const j = jobs[id];
    if (!j) throw new Error(`no job with id ${id}`);
    // Only allow safe fields to be patched.
    const allow = ['name', 'schedule', 'code', 'notes', 'paused', 'singleton', 'timeoutMs', 'autoPauseAfter'];
    for (const k of allow) if (k in patch) j[k] = patch[k];
    if ('schedule' in patch) validateSpec({ name: j.name, schedule: j.schedule, code: j.code });
    jobs[id] = j;
    await saveObj(STORAGE_JOBS, jobs);
    await clearAlarm(id);
    if (!j.paused) await scheduleAlarm(j);
    return j;
  }

  async function removeJob(id) {
    const jobs = await loadObj(STORAGE_JOBS);
    if (!jobs[id]) return { removed: false };
    delete jobs[id];
    await saveObj(STORAGE_JOBS, jobs);
    await clearAlarm(id);
    deleteRunsForJob(id).catch(() => {});
    return { removed: true };
  }

  async function pauseJob(id) {
    const j = await getJob(id);
    j.paused = true;
    await saveObj(STORAGE_JOBS, { ...(await loadObj(STORAGE_JOBS)), [id]: j });
    await clearAlarm(id);
    return j;
  }

  async function resumeJob(id) {
    const j = await getJob(id);
    j.paused = false;
    j.consecutiveFailures = 0;  // give it a clean slate
    j._backoffUntil = null;     // and reset the backoff window
    await saveObj(STORAGE_JOBS, { ...(await loadObj(STORAGE_JOBS)), [id]: j });
    await scheduleAlarm(j);
    return j;
  }

  async function runJobNow(id, { async: asyncRun = false } = {}) {
    const j = await getJob(id);
    if (asyncRun) {
      executeJob(j, { triggeredBy: 'run_now' }).catch(() => {});
      return { queued: true, id };
    }
    return executeJob(j, { triggeredBy: 'run_now' });
  }

  async function getJobLogs(id, { limit = 20, sinceMs } = {}) {
    await getJob(id);  // verifies exists
    let runs = await readRuns(id, limit);
    if (sinceMs) runs = runs.filter(r => r.ts >= sinceMs);
    return { jobId: id, runs };
  }

  async function status() {
    const { jobs } = await listJobs({ includePaused: true });
    const stateAll = await loadObj(STORAGE_STATE);
    const rt = await loadObj(STORAGE_RT);
    return {
      jobs,
      stateKeys: Object.keys(stateAll).length,
      lastReconcileAt: rt.lastReconcileAt || null,
    };
  }

  // ── Alarms ──
  function alarmNameFor(jobId) { return ALARM_PREFIX + jobId; }

  async function scheduleAlarm(job) {
    // For cron-expr jobs we don't create a per-job alarm — the master
    // 1-minute tick handles them. For `every` jobs we create a
    // periodic alarm with the right period.
    if (job.schedule.cron) {
      // Make sure master exists.
      const existing = await chrome.alarms.get(ALARM_MASTER);
      if (!existing) {
        await chrome.alarms.create(ALARM_MASTER, { periodInMinutes: 1, delayInMinutes: 1 });
      }
      job.nextRunAt = nextCronTickFrom(Date.now(), job.schedule.cron);
      await persistJob(job);
      return;
    }
    const ms = parseEvery(job.schedule.every);
    const minutes = Math.max(0.5, ms / 60000);   // chrome.alarms minimum is 30s
    await chrome.alarms.create(alarmNameFor(job.id), { periodInMinutes: minutes, delayInMinutes: minutes });
    job.nextRunAt = Date.now() + ms;
    await persistJob(job);
  }

  async function clearAlarm(jobId) {
    try { await chrome.alarms.clear(alarmNameFor(jobId)); } catch {}
  }

  async function persistJob(job) {
    const jobs = await loadObj(STORAGE_JOBS);
    jobs[job.id] = job;
    await saveObj(STORAGE_JOBS, jobs);
  }

  function nextCronTickFrom(fromMs, expr) {
    // Walk forward minute-by-minute up to 7 days, find first match.
    // Cheap enough: max 7*24*60 = 10,080 iterations.
    const d = new Date(fromMs); d.setSeconds(0, 0);
    for (let i = 0; i < 7 * 24 * 60; i++) {
      d.setMinutes(d.getMinutes() + 1);
      if (cronMatches(expr, d)) return d.getTime();
    }
    return null;
  }

  // ── Same KyotoVFS database the sidepanel uses ──
  // Letting jobs persist data to /cron/<id>/... is much friendlier
  // than capping them at 50KB of state + 4KB of stdout. Files written
  // here are visible to chat's existing fs_read tool.
  const VFS_DB = 'kyoto_vfs';
  const VFS_STORE = 'files';
  let _vfsPromise = null;
  function openVfs() {
    if (_vfsPromise) return _vfsPromise;
    _vfsPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(VFS_DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(VFS_STORE)) {
          d.createObjectStore(VFS_STORE, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _vfsPromise;
  }
  function _vfsNormalise(p) {
    if (!p || typeof p !== 'string') throw new Error('path required');
    let n = p.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!n.startsWith('/')) n = '/' + n;
    const parts = [];
    for (const seg of n.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return '/' + parts.join('/');
  }
  function _vfsBytes(c) {
    if (c instanceof Uint8Array) return c;
    if (typeof c === 'string') return new TextEncoder().encode(c);
    if (c && typeof c === 'object') return new TextEncoder().encode(JSON.stringify(c));
    return new TextEncoder().encode(String(c ?? ''));
  }
  async function vfsWrite(path, content, { mime } = {}) {
    const p = _vfsNormalise(path);
    const bytes = _vfsBytes(content);
    const db = await openVfs();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VFS_STORE, 'readwrite');
      tx.objectStore(VFS_STORE).put({
        path: p, content: bytes,
        mime: mime || 'application/octet-stream',
        size: bytes.byteLength, mtime: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return { path: p, size: bytes.byteLength };
  }
  async function vfsRead(path, { encoding = 'utf-8' } = {}) {
    const p = _vfsNormalise(path);
    const db = await openVfs();
    const rec = await new Promise((resolve, reject) => {
      const req = db.transaction(VFS_STORE, 'readonly').objectStore(VFS_STORE).get(p);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!rec) throw new Error('no such file: ' + p);
    if (encoding === 'binary') {
      // base64
      let bin = ''; for (let i = 0; i < rec.content.length; i++) bin += String.fromCharCode(rec.content[i]);
      return { path: p, base64: btoa(bin), bytes: rec.size, mime: rec.mime };
    }
    return { path: p, content: new TextDecoder(encoding).decode(rec.content), bytes: rec.size, mime: rec.mime };
  }
  async function vfsList(prefix = '/') {
    const p = _vfsNormalise(prefix);
    const db = await openVfs();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(VFS_STORE, 'readonly').objectStore(VFS_STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve({ prefix: p, files: out });
        if (c.value.path.startsWith(p)) {
          out.push({ path: c.value.path, size: c.value.size, mime: c.value.mime, mtime: c.value.mtime });
        }
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function vfsDelete(path) {
    const p = _vfsNormalise(path);
    const db = await openVfs();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VFS_STORE, 'readwrite');
      tx.objectStore(VFS_STORE).delete(p);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return { deleted: true, path: p };
  }

  // ── K sandbox: what job code can call ──
  function buildSandbox(job, runBuffer) {
    const log = (...args) => runBuffer.stdout.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    const stderr = (...args) => runBuffer.stderr.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    const tools = {
      async network_fetch({ url, method = 'GET', headers = {}, body, credentials = 'include', timeoutMs = 30000 } = {}) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await fetch(url, { method, headers, body, credentials, signal: ac.signal });
          const text = await res.text();
          const out = {}; res.headers.forEach((v, k) => out[k] = v);
          return { status: res.status, ok: res.ok, headers: out, body: text };
        } finally { clearTimeout(t); }
      },
      async page_eval({ tabId, code, timeoutMs = 30000 } = {}) {
        if (tabId == null) throw new Error('page_eval requires tabId');
        const [r] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN', args: [code, timeoutMs],
          func: (src, ms) => new Promise((resolve) => {
            let settled = false;
            const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
            const tid = setTimeout(() => finish({ ok: false, error: 'page_eval timed out after ' + ms + 'ms' }), ms);
            (async () => {
              try {
                let v; try { v = (0, eval)('(async()=>{return (' + src + ')})()'); }
                catch { v = (0, eval)('(async()=>{' + src + '})()'); }
                v = await v;
                clearTimeout(tid);
                try { finish({ ok: true, result: JSON.parse(JSON.stringify(v)) }); }
                catch { finish({ ok: true, result: String(v) }); }
              } catch (e) {
                clearTimeout(tid);
                finish({ ok: false, error: e?.message || String(e) });
              }
            })();
          })
        });
        return r?.result;
      },
      cookies_get: (args) => chrome.cookies.get(args),
      cookies_getAll: (args) => chrome.cookies.getAll(args),
      tabs_query: (args) => chrome.tabs.query(args),
      tabs_get: ({ tabId }) => chrome.tabs.get(tabId),
      downloads_download: (args) => chrome.downloads.download(args),
      notification: ({ title, message } = {}) =>
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: title || 'Kyoto', message: message || '' }),
      // KyotoVFS — same IndexedDB the sidepanel's fs_* tools use, so a
      // job can write a big result and chat can fs_read it (or vice
      // versa). Bypasses the 50KB state cap for bulk data.
      fs_write: (args) => vfsWrite(args.path, args.content, { mime: args.mime }),
      fs_read:  (args) => vfsRead(args.path, { encoding: args.encoding }),
      fs_list:  (args = {}) => vfsList(args.prefix || '/'),
      fs_delete:(args) => vfsDelete(args.path),
    };
    return {
      job: { id: job.id, name: job.name, lastRunAt: job.lastRunAt },
      now: () => Date.now(),
      sleep: (ms) => new Promise(r => setTimeout(r, Math.max(0, ms || 0))),
      log, stderr,
      state: {
        get: stateGet,
        set: (k, v, opts = {}) => stateSet(k, v, { ...opts, writtenBy: 'job:' + job.id }),
        delete: stateDelete,
        list: stateList,
      },
      tools,
      chrome,  // escape hatch for anything not in tools
      fetch,
    };
  }

  // ── Execute one job ──
  async function executeJob(job, { triggeredBy = 'alarm' } = {}) {
    const start = Date.now();
    // Singleton + backoff skip checks. Re-read the job spec so we see
    // _runningSince that another concurrent firing wrote. (We pass `job`
    // by value into onAlarm so the cached copy can be stale.)
    if (triggeredBy === 'alarm' || triggeredBy === 'cron') {
      const cur = (await loadObj(STORAGE_JOBS))[job.id];
      if (!cur) return { ok: false, error: 'job vanished mid-fire' };
      if (cur._backoffUntil && start < cur._backoffUntil) {
        const remainingMs = cur._backoffUntil - start;
        appendRun(job.id, {
          ts: start, ok: false, ms: 0, stdout: '',
          stderr: `skipped: in backoff, ~${Math.round(remainingMs / 1000)}s remaining`,
          error: 'backoff', triggeredBy,
        }).catch(() => {});
        return { ok: false, skipped: true, reason: 'backoff', remainingMs };
      }
      if (cur.singleton && cur._runningSince
          && (start - cur._runningSince) < (cur.timeoutMs || DEFAULT_TIMEOUT_MS)) {
        const elapsedMs = start - cur._runningSince;
        appendRun(job.id, {
          ts: start, ok: false, ms: 0, stdout: '',
          stderr: `skipped: singleton, previous run still in flight (${Math.round(elapsedMs / 1000)}s elapsed)`,
          error: 'singleton-skip', triggeredBy,
        }).catch(() => {});
        return { ok: false, skipped: true, reason: 'singleton', elapsedMs };
      }
      // Claim the run. Writing _runningSince here closes the race.
      cur._runningSince = start;
      await persistJob(cur);
    }

    const runBuf = { stdout: [], stderr: [] };
    let ok = false; let err = null;
    let timerId;
    try {
      const K = buildSandbox(job, runBuf);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction('K', '"use strict";\n' + job.code);
      const exec = fn(K);
      // Per-run wall clock cap. Clear the timer whichever side wins
      // the race so a fast job doesn't leak a 5-minute setTimeout.
      const timeoutP = new Promise((_, rej) => {
        timerId = setTimeout(
          () => rej(new Error(`job timed out after ${job.timeoutMs}ms`)),
          job.timeoutMs
        );
      });
      await Promise.race([exec, timeoutP]);
      ok = true;
    } catch (e) {
      err = e?.message || String(e);
    } finally {
      clearTimeout(timerId);
    }
    const ms = Date.now() - start;
    const run = {
      ts: start, ok, ms,
      stdout: runBuf.stdout.slice(-100).join('\n').slice(-4000),
      stderr: runBuf.stderr.slice(-100).join('\n').slice(-4000),
      error: ok ? null : err,
      triggeredBy,
    };
    appendRun(job.id, run).catch(() => {});

    // Update job state.
    const jobs = await loadObj(STORAGE_JOBS);
    const cur = jobs[job.id];
    if (cur) {
      cur.lastRunAt = start;
      cur._runningSince = null;   // release the singleton claim
      if (ok) {
        cur.consecutiveFailures = 0;
        cur.lastError = null;
        cur._backoffUntil = null;
      } else {
        cur.consecutiveFailures = (cur.consecutiveFailures || 0) + 1;
        cur.lastError = { ts: start, message: err };
        // Exponential backoff: skip future runs until basePeriod *
        // 2^(failures-1), capped at 32x. Cron jobs use 1 minute as base.
        const basePeriod = cur.schedule?.every ? parseEvery(cur.schedule.every) : 60000;
        const factor = Math.min(32, Math.pow(2, cur.consecutiveFailures - 1));
        cur._backoffUntil = Date.now() + (basePeriod * factor);
        if (cur.consecutiveFailures >= (cur.autoPauseAfter || DEFAULT_AUTO_PAUSE)) {
          cur.paused = true;
          cur._backoffUntil = null;  // pause is the terminal state; no more retries
          await clearAlarm(cur.id);
          runBuf.stderr.push(`[auto-paused after ${cur.consecutiveFailures} consecutive failures]`);
          appendRun(cur.id, { ts: Date.now(), ok: false, ms: 0,
            stdout: '', stderr: `auto-paused after ${cur.consecutiveFailures} failures`,
            error: 'auto-paused', triggeredBy: 'auto-pause' }).catch(() => {});
          // Tell the user. Notifications API may not be granted; ignore failure.
          try {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: 'Kyoto: cron job auto-paused',
              message: `"${cur.name}" failed ${cur.consecutiveFailures}x in a row. Last error: ${(err || '').slice(0, 140)}`,
            });
          } catch {}
        }
      }
      // Update nextRunAt.
      if (cur.schedule?.cron) cur.nextRunAt = nextCronTickFrom(Date.now(), cur.schedule.cron);
      else if (cur.schedule?.every) cur.nextRunAt = Date.now() + (parseEvery(cur.schedule.every) || 0);
      jobs[job.id] = cur;
      await saveObj(STORAGE_JOBS, jobs);
    }
    return { ok, ms, error: err, stdout: run.stdout, stderr: run.stderr };
  }

  // ── Alarm dispatch ──
  async function onAlarm(alarm) {
    if (alarm.name === ALARM_MASTER) {
      // Master tick: fire any cron-expr jobs whose minute has arrived.
      const jobs = await loadObj(STORAGE_JOBS);
      const now = new Date();
      for (const j of Object.values(jobs)) {
        if (j.paused) continue;
        if (!j.schedule?.cron) continue;
        if (cronMatches(j.schedule.cron, now)) {
          executeJob(j, { triggeredBy: 'cron' }).catch(() => {});
        }
      }
      return;
    }
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const id = alarm.name.slice(ALARM_PREFIX.length);
    if (id === 'master') return;
    const jobs = await loadObj(STORAGE_JOBS);
    const j = jobs[id];
    if (!j || j.paused) return;
    executeJob(j, { triggeredBy: 'alarm' }).catch(() => {});
  }

  // ── Reconcile on SW startup ──
  // SW can restart mid-run; alarms persist but our in-memory state
  // doesn't. Make sure storage and chrome.alarms agree.
  async function reconcile() {
    const jobs = await loadObj(STORAGE_JOBS);
    const haveMaster = await chrome.alarms.get(ALARM_MASTER).then(a => !!a).catch(() => false);
    let needMaster = false;
    const seen = new Set();
    for (const j of Object.values(jobs)) {
      if (j.schedule?.cron && !j.paused) needMaster = true;
      if (j.schedule?.every && !j.paused) {
        seen.add(alarmNameFor(j.id));
        const existing = await chrome.alarms.get(alarmNameFor(j.id)).catch(() => null);
        if (!existing) {
          const ms = parseEvery(j.schedule.every);
          if (ms) await chrome.alarms.create(alarmNameFor(j.id), { periodInMinutes: Math.max(0.5, ms / 60000), delayInMinutes: Math.max(0.5, ms / 60000) });
        }
      }
    }
    if (needMaster && !haveMaster) {
      await chrome.alarms.create(ALARM_MASTER, { periodInMinutes: 1, delayInMinutes: 1 });
    }
    if (!needMaster && haveMaster) {
      await chrome.alarms.clear(ALARM_MASTER);
    }
    // Cancel orphan alarms (job removed but alarm leaked).
    const all = await chrome.alarms.getAll().catch(() => []);
    for (const a of all) {
      if (a.name.startsWith(ALARM_PREFIX) && a.name !== ALARM_MASTER && !seen.has(a.name)) {
        await chrome.alarms.clear(a.name).catch(() => {});
      }
    }
    const rt = await loadObj(STORAGE_RT);
    rt.lastReconcileAt = Date.now();
    await saveObj(STORAGE_RT, rt);
  }

  return {
    stateGet, stateSet, stateDelete, stateList,
    addJob, listJobs, getJob, updateJob, removeJob,
    pauseJob, resumeJob, runJobNow, getJobLogs, status,
    onAlarm, reconcile,
    // internals exposed for tests:
    _parseEvery: parseEvery, _cronMatches: cronMatches,
    _nextCronTickFrom: nextCronTickFrom,
    _appendRun: appendRun, _readRuns: readRuns,
  };
})();

// Hook the alarm + lifecycle events.
chrome.alarms.onAlarm.addListener((alarm) => { Cron.onAlarm(alarm).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { Cron.reconcile().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { Cron.reconcile().catch(() => {}); });
// Also reconcile on first SW load (covers extension reload / update).
Cron.reconcile().catch(() => {});
