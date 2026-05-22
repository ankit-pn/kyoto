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
  }
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
