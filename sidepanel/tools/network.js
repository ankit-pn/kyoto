// Network capture, fetch interceptor, console attach, debugger, history,
// bookmarks, downloads, clipboard, permissions, HAR/Postman export,
// arbitrary-URL fetch+extract. All the non-DOM observability tools.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg, activeTab, scrip } = window.KyotoTR;

  // ──────── NETWORK CAPTURE ────────
  T({
    name: 'network_capture_start',
    group: 'network',
    description: 'Start observing network requests. scope=all logs every request; scope=tab restricts to the active tab.',
    parameters: OBJ({ scope: { type: 'string', enum: ['all', 'tab'] }, tabId: NUM }),
    handler: async (args = {}) => bg('NET_CAPTURE_START', args)
  });
  T({
    name: 'network_capture_stop',
    group: 'network',
    description: 'Stop observing network requests (kept events stay available to list).',
    parameters: OBJ(),
    handler: async () => bg('NET_CAPTURE_STOP')
  });
  T({
    name: 'network_capture_clear',
    group: 'network',
    description: 'Clear the captured-network buffer.',
    parameters: OBJ(),
    handler: async () => bg('NET_CAPTURE_CLEAR')
  });
  T({
    name: 'network_capture_list',
    group: 'network',
    description: 'List captured requests. Optional regex filter on URL/status. Most recent last.',
    parameters: OBJ({ filter: STR, limit: NUM, sinceMs: NUM }),
    handler: async (args = {}) => bg('NET_CAPTURE_LIST', args)
  });
  T({
    name: 'network_capture_detail',
    group: 'network',
    description: 'Full record (headers, timing) for one captured request id.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async (args) => bg('NET_CAPTURE_DETAIL', args)
  });

  T({
    name: 'network_fetch',
    group: 'network',
    description: 'Make an HTTP request from the extension. Sends user cookies by default — useful for replaying authenticated calls.',
    parameters: OBJ({
      url: STR, method: STR,
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: {},
      includeCookies: BOOL,
      maxBodyBytes: NUM
    }, ['url']),
    handler: async (args) => bg('NET_FETCH', args)
  });

  // ──────── PAGE-SIDE FETCH INTERCEPT ────────
  T({
    name: 'page_fetch_intercept',
    group: 'network',
    description: 'Hook fetch and XMLHttpRequest in the page MAIN world to record full request/response bodies. Reads recorded calls with `page_fetch_intercept_read`.',
    parameters: OBJ({ tabId: NUM, max: NUM }),
    handler: async ({ tabId, max = 100 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (cap) => {
        if (window.__kyoto_intercept_installed) {
          window.__kyoto_intercept_cap = cap;
          return { installed: true, alreadyOn: true };
        }
        window.__kyoto_intercept_installed = true;
        window.__kyoto_intercept_log = [];
        window.__kyoto_intercept_cap = cap;
        const push = (rec) => {
          const log = window.__kyoto_intercept_log;
          log.push(rec);
          if (log.length > window.__kyoto_intercept_cap) log.shift();
        };
        const origFetch = window.fetch;
        window.fetch = async function (input, init) {
          const startedAt = Date.now();
          const req = typeof input === 'string' ? { url: input, method: (init && init.method) || 'GET', body: init && init.body }
                                                : { url: input.url, method: input.method, body: init && init.body };
          let res, err;
          try { res = await origFetch.apply(this, arguments); }
          catch (e) { err = e; throw e; }
          finally {
            const clone = res ? res.clone() : null;
            const rec = {
              t: 'fetch', startedAt, url: req.url, method: req.method,
              reqBody: typeof req.body === 'string' ? req.body.slice(0, 4000) : undefined,
              status: res?.status, ok: res?.ok, error: err?.message
            };
            if (clone) {
              try { rec.respBody = (await clone.text()).slice(0, 8000); }
              catch {}
            }
            push(rec);
          }
          return res;
        };
        const OrigXHR = window.XMLHttpRequest;
        function KXHR() {
          const x = new OrigXHR();
          let rec = { t: 'xhr', startedAt: 0 };
          const origOpen = x.open;
          x.open = function (m, u) { rec.method = m; rec.url = u; return origOpen.apply(this, arguments); };
          const origSend = x.send;
          x.send = function (b) { rec.startedAt = Date.now(); rec.reqBody = typeof b === 'string' ? b.slice(0, 4000) : undefined; return origSend.apply(this, arguments); };
          x.addEventListener('loadend', () => {
            rec.status = x.status;
            try { rec.respBody = String(x.responseText || '').slice(0, 8000); } catch {}
            push(rec);
          });
          return x;
        }
        KXHR.prototype = OrigXHR.prototype;
        window.XMLHttpRequest = KXHR;
        return { installed: true, alreadyOn: false };
      }, [max], 'MAIN');
    }
  });

  T({
    name: 'page_fetch_intercept_read',
    group: 'network',
    description: 'Read the recorded fetch/XHR log installed by page_fetch_intercept. Optional URL substring filter.',
    parameters: OBJ({ tabId: NUM, urlSubstring: STR, limit: NUM }),
    handler: async ({ tabId, urlSubstring, limit = 50 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sub, lim) => {
        const log = window.__kyoto_intercept_log || [];
        const filtered = sub ? log.filter(r => (r.url || '').includes(sub)) : log;
        return { totalRecorded: log.length, returned: Math.min(filtered.length, lim), entries: filtered.slice(-lim) };
      }, [urlSubstring || '', limit]);
    }
  });

  // ──────── DEVTOOLS-ISH ────────
  T({
    name: 'console_attach',
    group: 'devtools',
    description: 'Install hooks on console.log/info/warn/error/debug in the page MAIN world so future logs are recorded.',
    parameters: OBJ({ tabId: NUM, max: NUM }),
    handler: async ({ tabId, max = 500 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (cap) => {
        if (window.__kyoto_console_installed) {
          window.__kyoto_console_cap = cap;
          return { installed: true, alreadyOn: true };
        }
        window.__kyoto_console_installed = true;
        window.__kyoto_console_log = [];
        window.__kyoto_console_cap = cap;
        const fmt = (a) => a.map(x => {
          try { return typeof x === 'string' ? x : JSON.stringify(x); }
          catch { return String(x); }
        }).join(' ');
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
          const orig = console[level].bind(console);
          console[level] = function (...args) {
            const log = window.__kyoto_console_log;
            log.push({ t: Date.now(), level, message: fmt(args).slice(0, 4000) });
            if (log.length > window.__kyoto_console_cap) log.shift();
            return orig(...args);
          };
        }
        window.addEventListener('error', (e) => {
          window.__kyoto_console_log.push({ t: Date.now(), level: 'error', message: `[uncaught] ${e.message} @ ${e.filename}:${e.lineno}` });
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__kyoto_console_log.push({ t: Date.now(), level: 'error', message: `[unhandledrejection] ${e.reason?.message || e.reason}` });
        });
        return { installed: true, alreadyOn: false };
      }, [max], 'MAIN');
    }
  });

  T({
    name: 'console_read',
    group: 'devtools',
    description: 'Read recorded console logs from the active tab (requires console_attach beforehand).',
    parameters: OBJ({ tabId: NUM, level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] }, limit: NUM }),
    handler: async ({ tabId, level, limit = 100 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (lvl, lim) => {
        const log = window.__kyoto_console_log || [];
        const filtered = lvl ? log.filter(e => e.level === lvl) : log;
        return { total: log.length, returned: Math.min(filtered.length, lim), entries: filtered.slice(-lim) };
      }, [level || '', limit], 'MAIN');
    }
  });

  T({
    name: 'page_performance',
    group: 'devtools',
    description: 'Read Performance Timing + paint metrics (navigation timing, FCP, LCP if available).',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paints = {};
        performance.getEntriesByType('paint').forEach(p => { paints[p.name] = p.startTime; });
        let lcp;
        try { lcp = performance.getEntriesByType('largest-contentful-paint').slice(-1)[0]?.startTime; } catch {}
        return {
          url: location.href,
          navigation: nav ? {
            type: nav.type, redirectCount: nav.redirectCount,
            domContentLoaded: nav.domContentLoadedEventEnd,
            loadEvent: nav.loadEventEnd, duration: nav.duration,
            transferSize: nav.transferSize, encodedBodySize: nav.encodedBodySize
          } : null,
          paints, lcp,
          memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null,
          resourceCount: performance.getEntriesByType('resource').length
        };
      }, [], 'MAIN');
    }
  });

  // ──────── DEBUGGER (optional permission) ────────
  T({
    name: 'debugger_attach',
    group: 'debugger',
    description: 'Attach the chrome.debugger protocol to a tab (CDP). Required for response-body capture and full devtools control. Shows a yellow banner on the tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => bg('DEBUGGER_ATTACH', { tabId })
  });
  T({
    name: 'debugger_detach',
    group: 'debugger',
    description: 'Detach chrome.debugger from a tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => bg('DEBUGGER_DETACH', { tabId })
  });
  T({
    name: 'debugger_send',
    group: 'debugger',
    description: 'Send a raw CDP method to an attached tab (e.g. "Runtime.evaluate", "Network.getResponseBody", "Input.dispatchKeyEvent"). params is the CDP-method params object.',
    parameters: OBJ({ tabId: NUM, method: STR, params: { type: 'object' } }, ['method']),
    handler: async (args) => bg('DEBUGGER_SEND', args)
  });

  // ──────── BROWSER DATA ────────
  T({
    name: 'history_search',
    group: 'browser-data',
    description: 'Search browsing history.',
    parameters: OBJ({ text: STR, maxResults: NUM, startTimeMs: NUM }, ['text']),
    handler: async ({ text, maxResults = 50, startTimeMs } = {}) => {
      return chrome.history.search({ text, maxResults, startTime: startTimeMs });
    }
  });
  T({
    name: 'bookmarks_search',
    group: 'browser-data',
    description: 'Search bookmarks.',
    parameters: OBJ({ query: STR }, ['query']),
    handler: async ({ query }) => chrome.bookmarks.search(query)
  });
  T({
    name: 'downloads_search',
    group: 'browser-data',
    description: 'Search download history.',
    parameters: OBJ({ query: { type: 'array', items: STR }, limit: NUM }),
    handler: async ({ query, limit = 50 } = {}) => chrome.downloads.search({ query, limit })
  });

  // ──────── CLIPBOARD / PERMISSIONS ────────
  T({
    name: 'clipboard_write',
    group: 'misc',
    description: 'Write text to the system clipboard (works from the side panel).',
    parameters: OBJ({ text: STR }, ['text']),
    handler: async ({ text }) => { await navigator.clipboard.writeText(text); return { written: true, bytes: text.length }; }
  });

  T({
    name: 'permission_request',
    group: 'misc',
    description: 'Request an optional permission at runtime (e.g. "debugger"). Returns granted=true/false.',
    parameters: OBJ({ permissions: { type: 'array', items: STR }, origins: { type: 'array', items: STR } }),
    handler: async (args = {}) => bg('REQUEST_OPTIONAL_PERMISSION', args)
  });
  T({
    name: 'permission_check',
    group: 'misc',
    description: 'Check whether an optional permission/origin has been granted.',
    parameters: OBJ({ permissions: { type: 'array', items: STR }, origins: { type: 'array', items: STR } }),
    handler: async (args = {}) => bg('CHECK_PERMISSION', args)
  });

  // ──────── EXPORT ────────
  T({
    name: 'network_har_export',
    group: 'network',
    description: 'Export the captured network events as HAR 1.2 JSON, suitable for opening in DevTools / Insomnia / Postman. Optionally filter by URL substring/regex.',
    parameters: OBJ({ filter: STR, includeSince: NUM }),
    handler: async (args = {}) => bg('NET_CAPTURE_HAR', args)
  });

  T({
    name: 'network_postman_export',
    group: 'network',
    description: 'Convert the captured network buffer into a Postman v2.1 collection JSON, grouped by host. Pairs with network_capture_start. Importable into Postman, Bruno, Insomnia.',
    parameters: OBJ({ filter: STR, includeSince: NUM, name: STR }),
    handler: async (args = {}) => bg('NET_CAPTURE_POSTMAN', args)
  });

  // ──────── ARBITRARY URL FETCH + EXTRACT ────────
  T({
    name: 'web_fetch_extract',
    group: 'network',
    description: 'Fetch an arbitrary URL, parse the HTML, and return the readable main content (article/body text), plus title and discovered links. Unlike `network_fetch` this strips chrome and extracts readable text — the URL-equivalent of `page_content` for the current tab.',
    parameters: OBJ({
      url: STR,
      maxBytes: NUM,
      includeLinks: BOOL
    }, ['url']),
    handler: async ({ url, maxBytes = 20000, includeLinks = false } = {}) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const res = await fetch(url, { credentials: 'omit' });
      const status = res.status;
      const ct = res.headers.get('content-type') || '';
      if (!/text\/html/.test(ct) && !/application\/xhtml/.test(ct)) {
        const txt = await res.text();
        return { status, mime: ct, url: res.url, text: txt.slice(0, maxBytes) };
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const baseEl = doc.querySelector('base');
      const base = baseEl?.href || res.url;
      const dropSel = 'script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role="navigation"],.ad,.advertisement,.cookie-banner';
      doc.querySelectorAll(dropSel).forEach(n => n.remove());
      const cands = Array.from(doc.querySelectorAll('article, main, [role="main"], .post-content, .article-content, .entry-content, #content'))
        .filter(el => el.textContent.trim().length > 200);
      let root = cands[0];
      if (!root) {
        let best = null, bestScore = 0;
        for (const el of doc.body.querySelectorAll('*')) {
          const t = el.textContent.trim();
          if (t.length < 300) continue;
          const blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote').length;
          if (blocks < 3) continue;
          const score = t.length * (blocks / Math.max(1, el.querySelectorAll('*').length));
          if (score > bestScore) { bestScore = score; best = el; }
        }
        root = best || doc.body;
      }
      let text = root.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > maxBytes) text = text.slice(0, maxBytes) + '… [truncated]';
      const out = { status, url: res.url, title: doc.title || '', text };
      if (includeLinks) {
        const seen = new Set();
        const links = [];
        for (const a of doc.querySelectorAll('a[href]')) {
          let href;
          try { href = new URL(a.getAttribute('href'), base).toString(); } catch { continue; }
          if (seen.has(href)) continue;
          seen.add(href);
          links.push({ href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
          if (links.length >= 200) break;
        }
        out.links = links;
      }
      return out;
    }
  });
})();
