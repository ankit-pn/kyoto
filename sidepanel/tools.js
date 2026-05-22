// Kyoto tool registry. Exposed as window.KyotoTools.
// Each tool has: name, group, description, parameters (JSON schema), handler(args).
// Handlers run in the side panel context; if they need SW-only state
// (webRequest buffer, debugger) they message the background worker.

(() => {
  'use strict';

  // ── Helpers ──────────────────────────────────────────
  async function bg(type, args) {
    const res = await chrome.runtime.sendMessage({ type, args });
    if (!res) throw new Error('no response from background');
    if (!res.ok) throw new Error(res.error || 'background error');
    return res.data;
  }

  async function activeTab() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t) throw new Error('no active tab');
    return t;
  }

  function truncate(value, maxBytes = 65536) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (s.length <= maxBytes) return value;
    return (typeof value === 'string')
      ? s.slice(0, maxBytes) + `… [truncated, ${s.length - maxBytes} more bytes]`
      : { _truncated: true, originalBytes: s.length, preview: s.slice(0, maxBytes) };
  }

  async function scrip(tabId, func, args = [], world = 'ISOLATED') {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world,
      func,
      args
    });
    return res?.result;
  }

  // ── Tool definitions ─────────────────────────────────
  const TOOLS = [];
  const T = (def) => TOOLS.push(def);
  const STR = { type: 'string' };
  const NUM = { type: 'number' };
  const BOOL = { type: 'boolean' };
  const OBJ = (props = {}, required = []) => ({
    type: 'object',
    properties: props,
    required,
    additionalProperties: false
  });

  // ──────── TABS / WINDOWS ────────
  T({
    name: 'tabs_list',
    group: 'browser',
    description: 'List all open browser tabs across windows.',
    parameters: OBJ(),
    handler: async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id, windowId: t.windowId, index: t.index, url: t.url,
        title: t.title, active: t.active, audible: t.audible,
        pinned: t.pinned, mutedInfo: t.mutedInfo, status: t.status
      }));
    }
  });

  T({
    name: 'tab_active',
    group: 'browser',
    description: 'Get information about the active tab in the current window.',
    parameters: OBJ(),
    handler: async () => activeTab()
  });

  T({
    name: 'tab_open',
    group: 'browser',
    description: 'Open a new tab. Optionally make it the active tab.',
    parameters: OBJ({ url: STR, active: BOOL }, ['url']),
    handler: async ({ url, active = true }) => {
      const tab = await chrome.tabs.create({ url, active });
      return { id: tab.id, url: tab.url };
    }
  });

  T({
    name: 'tab_navigate',
    group: 'browser',
    description: 'Navigate a tab to a URL. Defaults to the active tab.',
    parameters: OBJ({ url: STR, tabId: NUM }, ['url']),
    handler: async ({ url, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.update(tabId, { url });
      return { id: tab.id, url: tab.url };
    }
  });

  T({
    name: 'tab_reload',
    group: 'browser',
    description: 'Reload a tab. Defaults to the active tab.',
    parameters: OBJ({ tabId: NUM, bypassCache: BOOL }),
    handler: async ({ tabId, bypassCache = false } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      await chrome.tabs.reload(tabId, { bypassCache });
      return { reloaded: tabId };
    }
  });

  T({
    name: 'tab_close',
    group: 'browser',
    description: 'Close one or more tabs by id.',
    parameters: OBJ({ tabIds: { type: 'array', items: NUM } }, ['tabIds']),
    handler: async ({ tabIds }) => {
      await chrome.tabs.remove(tabIds);
      return { closed: tabIds };
    }
  });

  T({
    name: 'tab_screenshot',
    group: 'browser',
    description: 'Capture a PNG screenshot of the visible area of the current window. Returns a data URL.',
    parameters: OBJ({ format: { type: 'string', enum: ['png', 'jpeg'] }, quality: NUM }),
    handler: async ({ format = 'png', quality = 90 } = {}) => {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format, quality });
      return { dataUrl: truncate(dataUrl, 200000), bytes: dataUrl.length };
    }
  });

  T({
    name: 'windows_list',
    group: 'browser',
    description: 'List all browser windows with their tabs.',
    parameters: OBJ(),
    handler: async () => chrome.windows.getAll({ populate: true })
  });

  // ──────── PAGE / DOM ────────
  T({
    name: 'page_content',
    group: 'page',
    description: 'Extract the main readable content of a tab (article / body text).',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => bg('PAGE_EXTRACT_CONTENT', { tabId })
  });

  T({
    name: 'page_html',
    group: 'page',
    description: 'Return the outer HTML of a tab, or of elements matching a CSS selector. Truncated to 60 KB.',
    parameters: OBJ({ selector: STR, tabId: NUM, max: NUM }),
    handler: async ({ selector, tabId, max = 60000 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const res = await scrip(tabId, (sel) => {
        if (!sel) return document.documentElement.outerHTML;
        return Array.from(document.querySelectorAll(sel)).map(el => el.outerHTML).join('\n\n');
      }, [selector || '']);
      return truncate(res || '', max);
    }
  });

  T({
    name: 'page_query',
    group: 'page',
    description: 'querySelectorAll on the page. Returns tag/id/classes/text/attrs for each match.',
    parameters: OBJ({ selector: STR, tabId: NUM, limit: NUM }, ['selector']),
    handler: async ({ selector, tabId, limit = 50 }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, lim) => {
        const out = [];
        const nodes = document.querySelectorAll(sel);
        for (let i = 0; i < Math.min(nodes.length, lim); i++) {
          const el = nodes[i];
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          const rect = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/) : undefined,
            text: (el.textContent || '').trim().slice(0, 200),
            attrs,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, visible: rect.width > 0 && rect.height > 0 }
          });
        }
        return { total: nodes.length, shown: out.length, items: out };
      }, [selector, limit]);
    }
  });

  T({
    name: 'page_click',
    group: 'page',
    description: 'Click the first element matching a CSS selector.',
    parameters: OBJ({ selector: STR, tabId: NUM }, ['selector']),
    handler: async ({ selector, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { clicked: false, error: 'no match' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { clicked: true, tag: el.tagName };
      }, [selector]);
    }
  });

  T({
    name: 'page_fill',
    group: 'page',
    description: 'Set the value of an input/textarea/contenteditable and dispatch input+change events.',
    parameters: OBJ({ selector: STR, value: STR, tabId: NUM }, ['selector', 'value']),
    handler: async ({ selector, value, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { filled: false, error: 'no match' };
        el.focus();
        if (el.isContentEditable) {
          el.textContent = val;
        } else {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, val);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true };
      }, [selector, value]);
    }
  });

  T({
    name: 'page_scroll',
    group: 'page',
    description: 'Scroll to a selector (into view, centered) or to a y pixel position.',
    parameters: OBJ({ selector: STR, y: NUM, tabId: NUM }),
    handler: async ({ selector, y, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, yPos) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return { scrolled: false, error: 'no match' };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          return { scrolled: true, to: 'selector' };
        }
        window.scrollTo({ top: yPos ?? 0, behavior: 'instant' });
        return { scrolled: true, to: 'y', y: yPos ?? 0 };
      }, [selector || '', y]);
    }
  });

  T({
    name: 'page_wait_for',
    group: 'page',
    description: 'Wait until a selector exists / is visible, or until a JS expression returns truthy. Timeout in ms.',
    parameters: OBJ({ selector: STR, expression: STR, timeoutMs: NUM, tabId: NUM }),
    handler: async ({ selector, expression, timeoutMs = 5000, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (sel, expr, ms) => {
        const deadline = Date.now() + ms;
        const check = () => {
          if (sel) {
            const el = document.querySelector(sel);
            return el && el.getBoundingClientRect().width > 0;
          }
          if (expr) {
            try { return !!eval(expr); } catch { return false; }
          }
          return false;
        };
        while (Date.now() < deadline) {
          if (check()) return { matched: true, waitedMs: ms - (deadline - Date.now()) };
          await new Promise(r => setTimeout(r, 100));
        }
        return { matched: false, timeoutMs: ms };
      }, [selector || '', expression || '', timeoutMs], 'MAIN');
    }
  });

  T({
    name: 'page_eval',
    group: 'page',
    description: 'Evaluate JavaScript in the page MAIN world. The result must be JSON-serializable. POWERFUL — can read page state, call site JS, modify DOM.',
    parameters: OBJ({ code: STR, tabId: NUM }, ['code']),
    handler: async ({ code, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      const res = await scrip(tabId, async (src) => {
        try {
          let val;
          try { val = (0, eval)(`(async()=>{return (${src})})()`); }
          catch { val = (0, eval)(`(async()=>{${src}})()`); }
          val = await val;
          try { return { ok: true, result: JSON.parse(JSON.stringify(val)) }; }
          catch { return { ok: true, result: String(val) }; }
        } catch (e) {
          return { ok: false, error: e?.message || String(e), stack: e?.stack };
        }
      }, [code], 'MAIN');
      return res;
    }
  });

  // ──────── STORAGE (page-side) ────────
  T({
    name: 'page_local_storage',
    group: 'storage',
    description: 'Read all localStorage entries for the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      });
    }
  });

  T({
    name: 'page_session_storage',
    group: 'storage',
    description: 'Read all sessionStorage entries for the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        const out = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          out[k] = sessionStorage.getItem(k);
        }
        return out;
      });
    }
  });

  // ──────── COOKIES ────────
  function classifyCookie(c) {
    const n = c.name.toLowerCase();
    const tags = [];
    if (/^(session|sess|sid|connect\.sid|jsessionid|phpsessid|asp\.net_sessionid|ci_session)/.test(n)) tags.push('session');
    if (/(token|jwt|auth|access|refresh|bearer|api_key|apikey)/.test(n)) tags.push('auth');
    if (/^(csrf|xsrf|_csrf|x-csrf)/.test(n)) tags.push('csrf');
    if (/^(_ga|_gid|_gcl|_fbp|_fbc|utm_|amp_|mp_|_pk_|optim|hubspotutk|intercom)/.test(n)) tags.push('tracking');
    if (/(consent|cookieyes|cmplz|gdpr|euconsent)/.test(n)) tags.push('consent');
    if (c.httpOnly) tags.push('httpOnly');
    if (c.secure) tags.push('secure');
    if (c.sameSite && c.sameSite !== 'unspecified') tags.push(`sameSite:${c.sameSite}`);
    if (!tags.length) tags.push('other');
    return tags;
  }

  T({
    name: 'cookies_list',
    group: 'cookies',
    description: 'List cookies for a URL or domain. Pass exactly one of `url` or `domain`.',
    parameters: OBJ({ url: STR, domain: STR }),
    handler: async ({ url, domain } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) {
        const t = await activeTab();
        query.url = t.url;
      }
      const cookies = await chrome.cookies.getAll(query);
      return cookies.map(c => ({ ...c, tags: classifyCookie(c) }));
    }
  });

  T({
    name: 'cookies_get',
    group: 'cookies',
    description: 'Get a specific cookie by url + name.',
    parameters: OBJ({ url: STR, name: STR }, ['url', 'name']),
    handler: async ({ url, name }) => chrome.cookies.get({ url, name })
  });

  T({
    name: 'cookies_set',
    group: 'cookies',
    description: 'Set or overwrite a cookie. WRITE operation.',
    parameters: OBJ({
      url: STR, name: STR, value: STR, domain: STR, path: STR,
      secure: BOOL, httpOnly: BOOL,
      sameSite: { type: 'string', enum: ['no_restriction', 'lax', 'strict', 'unspecified'] },
      expirationDate: NUM
    }, ['url', 'name', 'value']),
    handler: async (args) => chrome.cookies.set(args)
  });

  T({
    name: 'cookies_remove',
    group: 'cookies',
    description: 'Remove a cookie by url + name. WRITE operation.',
    parameters: OBJ({ url: STR, name: STR }, ['url', 'name']),
    handler: async ({ url, name }) => chrome.cookies.remove({ url, name })
  });

  T({
    name: 'cookies_export',
    group: 'cookies',
    description: 'Export cookies for cloning a session. Format: "netscape" (cookies.txt), "json" (full), "header" (Cookie: header), or "curl-b" (curl --cookie line).',
    parameters: OBJ({
      url: STR, domain: STR,
      format: { type: 'string', enum: ['netscape', 'json', 'header', 'curl-b'] },
      includeHttpOnly: BOOL
    }),
    handler: async ({ url, domain, format = 'netscape', includeHttpOnly = true } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) { query.url = (await activeTab()).url; }
      const cookies = await chrome.cookies.getAll(query);
      const filtered = includeHttpOnly ? cookies : cookies.filter(c => !c.httpOnly);
      if (format === 'json') return filtered;
      if (format === 'header') return { cookieHeader: filtered.map(c => `${c.name}=${c.value}`).join('; '), count: filtered.length };
      if (format === 'curl-b') return { curl: filtered.map(c => `-b '${c.name}=${c.value}'`).join(' '), count: filtered.length };
      // netscape cookies.txt
      const lines = [
        '# Netscape HTTP Cookie File',
        '# Exported by Kyoto',
        ''
      ];
      for (const c of filtered) {
        const host = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
        const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const httpsOnly = c.secure ? 'TRUE' : 'FALSE';
        const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
        lines.push([host, includeSub, c.path || '/', httpsOnly, exp, c.name, c.value].join('\t'));
      }
      return { netscape: lines.join('\n'), count: filtered.length };
    }
  });

  T({
    name: 'cookies_analyze',
    group: 'cookies',
    description: 'Classify cookies for a URL/domain into session, auth, csrf, tracking, consent. Useful for identifying which cookies matter for session cloning.',
    parameters: OBJ({ url: STR, domain: STR }),
    handler: async ({ url, domain } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) query.url = (await activeTab()).url;
      const cookies = await chrome.cookies.getAll(query);
      const byTag = {};
      const annotated = cookies.map(c => {
        const tags = classifyCookie(c);
        tags.forEach(t => { byTag[t] = (byTag[t] || 0) + 1; });
        return {
          name: c.name, domain: c.domain, path: c.path,
          httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
          session: !c.expirationDate, expires: c.expirationDate,
          valuePreview: (c.value || '').slice(0, 40),
          tags
        };
      });
      const importantForCloning = annotated.filter(c => c.tags.some(t => t === 'session' || t === 'auth'));
      return { total: annotated.length, byTag, importantForCloning, all: annotated };
    }
  });

  // ──────── NETWORK ────────
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

  // ──────── DEVTOOLS-ish ────────
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

  // ──────── CLIPBOARD ────────
  T({
    name: 'clipboard_write',
    group: 'misc',
    description: 'Write text to the system clipboard (works from the side panel).',
    parameters: OBJ({ text: STR }, ['text']),
    handler: async ({ text }) => { await navigator.clipboard.writeText(text); return { written: true, bytes: text.length }; }
  });

  // ──────── PERMISSIONS ────────
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

  // ──────── MEMORY (cross-session) ────────
  // Persistent notes the user (or the agent) can write, search, and recall.
  // Storage:
  //   kyoto_memory_index : array of { id, title, tags, createdAt, updatedAt }
  //   kyoto_memory_<id>  : full record { id, title, content, tags, createdAt, updatedAt }
  const MEM_INDEX_KEY = 'kyoto_memory_index';
  const MEM_KEY = (id) => `kyoto_memory_${id}`;
  function memNewId() { return 'mem_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  async function memLoadIndex() {
    const g = await chrome.storage.local.get(MEM_INDEX_KEY);
    return g[MEM_INDEX_KEY] || [];
  }
  async function memWriteIndex(idx) { await chrome.storage.local.set({ [MEM_INDEX_KEY]: idx }); }

  T({
    name: 'memory_add',
    group: 'memory',
    description: 'Save a long-lived note that will be available in every future session. Use for: user preferences, repeated context, useful snippets, API keys / URLs the user names, important facts. Returns the new memory id.',
    parameters: OBJ({
      title: STR,
      content: STR,
      tags: { type: 'array', items: STR }
    }, ['title', 'content']),
    handler: async ({ title, content, tags = [] }) => {
      const id = memNewId();
      const now = Date.now();
      const record = { id, title, content, tags, createdAt: now, updatedAt: now };
      await chrome.storage.local.set({ [MEM_KEY(id)]: record });
      const idx = await memLoadIndex();
      idx.unshift({ id, title, tags, createdAt: now, updatedAt: now });
      await memWriteIndex(idx);
      return { id, saved: true };
    }
  });

  T({
    name: 'memory_list',
    group: 'memory',
    description: 'List all saved memories (metadata only — id, title, tags, timestamps). Use this first to see what is available before reading.',
    parameters: OBJ({ limit: NUM }),
    handler: async ({ limit = 200 } = {}) => {
      const idx = await memLoadIndex();
      return { total: idx.length, items: idx.slice(0, limit) };
    }
  });

  T({
    name: 'memory_get',
    group: 'memory',
    description: 'Read the full content of a memory by id.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => {
      const g = await chrome.storage.local.get(MEM_KEY(id));
      return g[MEM_KEY(id)] || { error: 'not found' };
    }
  });

  T({
    name: 'memory_search',
    group: 'memory',
    description: 'Simple case-insensitive substring search across memory titles, tags, and content. Returns matching memory metadata.',
    parameters: OBJ({ query: STR, limit: NUM }, ['query']),
    handler: async ({ query, limit = 20 }) => {
      const q = query.toLowerCase();
      const idx = await memLoadIndex();
      const matches = [];
      for (const meta of idx) {
        if (meta.title.toLowerCase().includes(q) || (meta.tags || []).some(t => t.toLowerCase().includes(q))) {
          matches.push({ ...meta, _hit: 'title/tags' });
          continue;
        }
        const g = await chrome.storage.local.get(MEM_KEY(meta.id));
        const full = g[MEM_KEY(meta.id)];
        if (full?.content?.toLowerCase().includes(q)) matches.push({ ...meta, _hit: 'content' });
        if (matches.length >= limit) break;
      }
      return { total: matches.length, items: matches };
    }
  });

  T({
    name: 'memory_update',
    group: 'memory',
    description: 'Update fields of an existing memory. Any field omitted is preserved.',
    parameters: OBJ({ id: STR, title: STR, content: STR, tags: { type: 'array', items: STR } }, ['id']),
    handler: async ({ id, title, content, tags }) => {
      const g = await chrome.storage.local.get(MEM_KEY(id));
      const current = g[MEM_KEY(id)];
      if (!current) return { error: 'not found' };
      if (title !== undefined) current.title = title;
      if (content !== undefined) current.content = content;
      if (tags !== undefined) current.tags = tags;
      current.updatedAt = Date.now();
      await chrome.storage.local.set({ [MEM_KEY(id)]: current });
      const idx = await memLoadIndex();
      const i = idx.findIndex(m => m.id === id);
      if (i >= 0) {
        idx[i] = { id, title: current.title, tags: current.tags, createdAt: current.createdAt, updatedAt: current.updatedAt };
        await memWriteIndex(idx);
      }
      return { id, updated: true };
    }
  });

  T({
    name: 'memory_delete',
    group: 'memory',
    description: 'Delete a memory by id.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => {
      await chrome.storage.local.remove(MEM_KEY(id));
      const idx = await memLoadIndex();
      await memWriteIndex(idx.filter(m => m.id !== id));
      return { id, deleted: true };
    }
  });

  // ── Public API ───────────────────────────────────────
  window.KyotoTools = {
    list: () => TOOLS.map(t => ({ name: t.name, group: t.group, description: t.description })),
    schemas: (enabledGroups) => TOOLS
      .filter(t => !enabledGroups || enabledGroups.has(t.group))
      .map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      })),
    groups: () => [...new Set(TOOLS.map(t => t.group))],
    call: async (name, args) => {
      const t = TOOLS.find(x => x.name === name);
      if (!t) return { error: `Unknown tool: ${name}` };
      try { return await t.handler(args || {}); }
      catch (e) { return { error: e?.message || String(e), stack: e?.stack }; }
    }
  };
})();
