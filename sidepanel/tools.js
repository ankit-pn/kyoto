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
    description: 'Open a new tab. Optionally make it the active tab. The new tab automatically inherits the calling agent\'s conversation — switching to it shows the same chat continued, not a fresh session. Set `freshSession: true` to opt out (the new tab becomes a brand-new session, useful when forking unrelated tasks).',
    parameters: OBJ({ url: STR, active: BOOL, freshSession: BOOL }, ['url']),
    handler: async ({ url, active = true, freshSession = false }) => {
      // Mark BEFORE chrome.tabs.create so the side panel's
      // onCreated handler can adopt the new tab into this session.
      if (!freshSession && window.__kyotoMarkPendingTabBind) {
        window.__kyotoMarkPendingTabBind();
      }
      const tab = await chrome.tabs.create({ url, active });
      return { id: tab.id, url: tab.url, inheritedSession: !freshSession };
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
    description: 'Capture a screenshot of the visible area of the current window. Returns the full data URL (use `format: "jpeg"` and a lower `quality` to reduce size). Note: the data URL is large; if you only need to *analyze* the screenshot with a vision model, prefer `minimax_describe_tab` which captures + analyzes in one step without round-tripping the base64 through the conversation.',
    parameters: OBJ({ format: { type: 'string', enum: ['png', 'jpeg'] }, quality: NUM }),
    handler: async ({ format = 'png', quality = 90 } = {}) => {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format, quality });
      // Don't truncate — a truncated data URL is invalid and breaks any
      // downstream consumer. Callers should pick JPEG + low quality if
      // size matters.
      return { dataUrl, bytes: dataUrl.length, mimeType: `image/${format}` };
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
      // Netscape cookies.txt — spec-compliant for Python cookielib /
      // curl / yt-dlp.
      //
      // The key invariant (which the previous version of this code
      // violated and broke yt-dlp imports): the first column's leading
      // dot must agree with the second column ("include subdomains").
      //   - Domain cookie ("Domain=example.com" in Set-Cookie):
      //       Chrome reports `.example.com` here. We emit `.example.com`
      //       TRUE → cookielib accepts.
      //   - Host-only cookie (no Domain attribute):
      //       Chrome reports `www.example.com`. We emit `www.example.com`
      //       FALSE → cookielib accepts. The OLD code emitted
      //       `.www.example.com` FALSE, which cookielib rejects with
      //       "domain_specified == initial_dot" AssertionError.
      // httpOnly cookies are tagged with the conventional `#HttpOnly_`
      // line prefix that yt-dlp and curl both honour.
      const lines = [
        '# Netscape HTTP Cookie File',
        '# Exported by Kyoto',
        '# This file may be edited by hand. Generated automatically.',
        ''
      ];
      for (const c of filtered) {
        const hasLeadingDot = c.domain.startsWith('.');
        const includeSub = hasLeadingDot ? 'TRUE' : 'FALSE';
        const host = c.domain;
        const httpsOnly = c.secure ? 'TRUE' : 'FALSE';
        const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
        const row = [host, includeSub, c.path || '/', httpsOnly, exp, c.name, c.value].join('\t');
        lines.push(c.httpOnly ? '#HttpOnly_' + row : row);
      }
      return { netscape: lines.join('\n') + '\n', count: filtered.length };
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

  // ──────── HAR EXPORT ────────
  T({
    name: 'network_har_export',
    group: 'network',
    description: 'Export the captured network events as HAR 1.2 JSON, suitable for opening in DevTools / Insomnia / Postman. Optionally filter by URL substring/regex.',
    parameters: OBJ({ filter: STR, includeSince: NUM }),
    handler: async (args = {}) => bg('NET_CAPTURE_HAR', args)
  });

  // ──────── CURL ⇄ FETCH ────────
  function parseCurlString(input) {
    // Strip line continuations and surrounding whitespace
    const cleaned = input.replace(/\\\n/g, ' ').trim();
    // Tokenise with quote-awareness
    const tokens = [];
    let cur = '', q = null;
    for (let i = 0; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (q) {
        if (c === q) { q = null; }
        else if (c === '\\' && cleaned[i + 1] === q) { cur += q; i++; }
        else { cur += c; }
      } else if (c === "'" || c === '"') { q = c; }
      else if (/\s/.test(c)) { if (cur) { tokens.push(cur); cur = ''; } }
      else { cur += c; }
    }
    if (cur) tokens.push(cur);
    if (!tokens.length || !/^curl$/i.test(tokens[0])) {
      throw new Error('Input must start with `curl`.');
    }
    const out = { method: 'GET', url: '', headers: {}, body: null };
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-X' || t === '--request') { out.method = tokens[++i].toUpperCase(); }
      else if (t === '-H' || t === '--header') {
        const h = tokens[++i];
        const ci = h.indexOf(':');
        if (ci > 0) out.headers[h.slice(0, ci).trim()] = h.slice(ci + 1).trim();
      }
      else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
        out.body = tokens[++i];
        if (out.method === 'GET') out.method = 'POST';
      }
      else if (t === '-b' || t === '--cookie') {
        out.headers['Cookie'] = tokens[++i];
      }
      else if (t === '-u' || t === '--user') {
        out.headers['Authorization'] = 'Basic ' + btoa(tokens[++i]);
      }
      else if (t === '-A' || t === '--user-agent') {
        out.headers['User-Agent'] = tokens[++i];
      }
      else if (t === '-e' || t === '--referer') {
        out.headers['Referer'] = tokens[++i];
      }
      else if (t.startsWith('--')) {
        // Skip unrecognised flags' values heuristically (only consume if next is not URL-like)
        if (tokens[i + 1] && !/^https?:/.test(tokens[i + 1]) && !tokens[i + 1].startsWith('-')) i++;
      }
      else if (t.startsWith('-')) {
        // Short flag with arg
        if (tokens[i + 1] && !/^https?:/.test(tokens[i + 1]) && !tokens[i + 1].startsWith('-')) i++;
      }
      else if (!out.url) {
        out.url = t;
      }
    }
    if (!out.url) throw new Error('No URL found in curl command.');
    return out;
  }

  T({
    name: 'curl_to_fetch',
    group: 'network',
    description: 'Parse a curl command (any common form: -X, -H, -d/--data, -b/--cookie, -u, etc.) and return an equivalent JavaScript `fetch()` snippet, plus the parsed request as an object.',
    parameters: OBJ({ curl: STR }, ['curl']),
    handler: async ({ curl }) => {
      const r = parseCurlString(curl);
      const opts = { method: r.method };
      if (Object.keys(r.headers).length) opts.headers = r.headers;
      if (r.body != null) opts.body = r.body;
      const optsJson = JSON.stringify(opts, null, 2);
      const snippet = `await fetch(${JSON.stringify(r.url)}, ${optsJson});`;
      return { parsed: r, fetchSnippet: snippet };
    }
  });

  T({
    name: 'fetch_to_curl',
    group: 'network',
    description: 'Convert a fetch-style request (url + method/headers/body) into a copy-pasteable curl command.',
    parameters: OBJ({
      url: STR,
      method: STR,
      headers: { type: 'object', additionalProperties: STR },
      body: {}
    }, ['url']),
    handler: async ({ url, method = 'GET', headers = {}, body } = {}) => {
      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const parts = ['curl', '-X', method.toUpperCase(), sq(url)];
      for (const [k, v] of Object.entries(headers)) parts.push('-H', sq(`${k}: ${v}`));
      if (body != null) {
        const b = typeof body === 'string' ? body : JSON.stringify(body);
        parts.push('--data-raw', sq(b));
      }
      return { curl: parts.join(' ') };
    }
  });

  // ──────── COOKIE SNAPSHOT + DIFF ────────
  const COOKIE_SNAP_KEY = 'kyoto_cookie_snapshot';

  T({
    name: 'cookies_snapshot',
    group: 'cookies',
    description: 'Save the current cookie state for a URL or domain as a snapshot. Use before performing an action (login, logout, accept-cookies banner) so cookies_diff can show what changed.',
    parameters: OBJ({ url: STR, domain: STR, label: STR }),
    handler: async ({ url, domain, label = 'default' } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) { const t = await activeTab(); query.url = t.url; }
      const cookies = await chrome.cookies.getAll(query);
      const all = (await chrome.storage.local.get(COOKIE_SNAP_KEY))[COOKIE_SNAP_KEY] || {};
      all[label] = { takenAt: Date.now(), query, cookies };
      await chrome.storage.local.set({ [COOKIE_SNAP_KEY]: all });
      return { label, count: cookies.length, takenAt: all[label].takenAt };
    }
  });

  T({
    name: 'cookies_diff',
    group: 'cookies',
    description: 'Compare current cookies against a saved snapshot (by label). Returns added / removed / changed cookies. Reveals which cookies an action actually set or modified.',
    parameters: OBJ({ label: STR, url: STR, domain: STR }),
    handler: async ({ label = 'default', url, domain } = {}) => {
      const all = (await chrome.storage.local.get(COOKIE_SNAP_KEY))[COOKIE_SNAP_KEY] || {};
      const snap = all[label];
      if (!snap) return { error: `No snapshot named "${label}". Call cookies_snapshot first.` };
      const query = url ? { url } : domain ? { domain } : snap.query;
      const now = await chrome.cookies.getAll(query);
      const key = (c) => `${c.domain}|${c.path}|${c.name}`;
      const before = new Map(snap.cookies.map(c => [key(c), c]));
      const after = new Map(now.map(c => [key(c), c]));
      const added = [], removed = [], changed = [];
      for (const [k, v] of after) {
        if (!before.has(k)) added.push(v);
        else {
          const b = before.get(k);
          if (b.value !== v.value || b.expirationDate !== v.expirationDate) {
            changed.push({ name: v.name, domain: v.domain, before: b.value.slice(0, 40), after: v.value.slice(0, 40) });
          }
        }
      }
      for (const [k, v] of before) {
        if (!after.has(k)) removed.push(v);
      }
      return {
        snapshotLabel: label,
        snapshotAgeSec: Math.floor((Date.now() - snap.takenAt) / 1000),
        added: added.map(c => ({ name: c.name, domain: c.domain, value: c.value.slice(0, 40), httpOnly: c.httpOnly, secure: c.secure })),
        removed: removed.map(c => ({ name: c.name, domain: c.domain })),
        changed
      };
    }
  });

  // ──────── STORAGE WRITES ────────
  T({
    name: 'page_local_storage_set',
    group: 'storage',
    description: 'Set a localStorage key on the active tab. WRITE operation.',
    parameters: OBJ({ key: STR, value: STR, tabId: NUM }, ['key', 'value']),
    handler: async ({ key, value, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k, v) => { localStorage.setItem(k, v); return { set: true, key: k }; }, [key, value]);
    }
  });
  T({
    name: 'page_local_storage_remove',
    group: 'storage',
    description: 'Remove a localStorage key on the active tab. Pass key="*" to clear all. WRITE operation.',
    parameters: OBJ({ key: STR, tabId: NUM }, ['key']),
    handler: async ({ key, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k) => {
        if (k === '*') { localStorage.clear(); return { cleared: true }; }
        localStorage.removeItem(k); return { removed: true, key: k };
      }, [key]);
    }
  });
  T({
    name: 'page_session_storage_set',
    group: 'storage',
    description: 'Set a sessionStorage key on the active tab. WRITE operation.',
    parameters: OBJ({ key: STR, value: STR, tabId: NUM }, ['key', 'value']),
    handler: async ({ key, value, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k, v) => { sessionStorage.setItem(k, v); return { set: true, key: k }; }, [key, value]);
    }
  });
  T({
    name: 'page_session_storage_remove',
    group: 'storage',
    description: 'Remove a sessionStorage key. Pass key="*" to clear all. WRITE operation.',
    parameters: OBJ({ key: STR, tabId: NUM }, ['key']),
    handler: async ({ key, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k) => {
        if (k === '*') { sessionStorage.clear(); return { cleared: true }; }
        sessionStorage.removeItem(k); return { removed: true, key: k };
      }, [key]);
    }
  });

  // ──────── INDEXEDDB (read-only) ────────
  T({
    name: 'idb_list_databases',
    group: 'storage',
    description: 'List all IndexedDB databases visible to the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async () => {
        if (!indexedDB.databases) return { error: 'indexedDB.databases() unsupported in this browser' };
        const list = await indexedDB.databases();
        return list;
      }, [], 'MAIN');
    }
  });

  T({
    name: 'idb_list_stores',
    group: 'storage',
    description: 'List object stores within an IndexedDB database, plus their indexes.',
    parameters: OBJ({ database: STR, tabId: NUM }, ['database']),
    handler: async ({ database, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (dbName) => {
        return await new Promise((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve({ error: req.error?.message || 'open failed' });
          req.onsuccess = () => {
            const db = req.result;
            const stores = [];
            for (const name of db.objectStoreNames) {
              const tx = db.transaction(name, 'readonly');
              const st = tx.objectStore(name);
              stores.push({
                name,
                keyPath: st.keyPath,
                autoIncrement: st.autoIncrement,
                indexNames: [...st.indexNames]
              });
            }
            db.close();
            resolve({ database: dbName, version: db.version, stores });
          };
        });
      }, [database], 'MAIN');
    }
  });

  T({
    name: 'idb_read',
    group: 'storage',
    description: 'Read up to `limit` records from an IndexedDB object store. Read-only.',
    parameters: OBJ({ database: STR, store: STR, limit: NUM, tabId: NUM }, ['database', 'store']),
    handler: async ({ database, store, limit = 50, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (dbName, storeName, lim) => {
        return await new Promise((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve({ error: req.error?.message || 'open failed' });
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve({ error: `Store "${storeName}" not found` });
              return;
            }
            const tx = db.transaction(storeName, 'readonly');
            const st = tx.objectStore(storeName);
            const out = [];
            const cursorReq = st.openCursor();
            cursorReq.onerror = () => { db.close(); resolve({ error: cursorReq.error?.message || 'cursor failed' }); };
            cursorReq.onsuccess = (e) => {
              const cur = e.target.result;
              if (cur && out.length < lim) {
                try { out.push({ key: cur.key, value: JSON.parse(JSON.stringify(cur.value)) }); }
                catch { out.push({ key: cur.key, value: String(cur.value) }); }
                cur.continue();
              } else {
                db.close();
                resolve({ database: dbName, store: storeName, count: out.length, records: out });
              }
            };
          };
        });
      }, [database, store, limit], 'MAIN');
    }
  });

  // ──────── BULK FORM FILL ────────
  T({
    name: 'page_fill_form',
    group: 'page',
    description: 'Fill multiple form fields in one call. `fields` is an object mapping CSS selector -> value. Submits no form; pair with page_click on the submit button.',
    parameters: OBJ({
      fields: { type: 'object', additionalProperties: STR },
      tabId: NUM
    }, ['fields']),
    handler: async ({ fields, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (map) => {
        const results = [];
        for (const [sel, val] of Object.entries(map)) {
          const el = document.querySelector(sel);
          if (!el) { results.push({ selector: sel, ok: false, error: 'no match' }); continue; }
          el.focus();
          if (el.isContentEditable) { el.textContent = val; }
          else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, val);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ selector: sel, ok: true });
        }
        return { filled: results.filter(r => r.ok).length, total: results.length, results };
      }, [fields]);
    }
  });

  // ──────── PYTHON (via Pyodide in a sandbox iframe) ────────
  // Pyodide can't run in the side panel directly (extension CSP forbids
  // unsafe-eval and remote scripts). It lives in a sandboxed iframe
  // declared in the manifest; we drive it over postMessage.
  const PythonSandbox = (() => {
    let ready = false;
    let readyPromise = null;

    // Catch the sandbox's "ready" announcement even if it arrives before
    // we ask for it.
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sandbox_ready') ready = true;
    });

    function getIframe() {
      const f = document.getElementById('pythonSandbox');
      if (!f) throw new Error('Python sandbox iframe missing from side-panel DOM.');
      return f;
    }

    function ensureReady(timeoutMs = 30000) {
      if (ready) return Promise.resolve();
      if (readyPromise) return readyPromise;
      readyPromise = new Promise((resolve, reject) => {
        const iframe = getIframe();
        const pingId = 'ping_' + Math.random().toString(36).slice(2, 9);
        const t0 = Date.now();
        const onMsg = (e) => {
          if (!e.data) return;
          if (e.data.type === 'sandbox_ready' || (e.data.type === 'pong' && e.data.id === pingId)) {
            ready = true;
            window.removeEventListener('message', onMsg);
            clearInterval(pingTimer);
            clearTimeout(timeoutTimer);
            resolve();
          }
        };
        window.addEventListener('message', onMsg);
        const sendPing = () => {
          try { iframe.contentWindow.postMessage({ type: 'ping', id: pingId }, '*'); } catch {}
        };
        sendPing();
        const pingTimer = setInterval(sendPing, 500);
        const timeoutTimer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          clearInterval(pingTimer);
          reject(new Error(`Python sandbox did not become ready within ${Math.round((Date.now() - t0) / 1000)}s.`));
        }, timeoutMs);
      });
      return readyPromise;
    }

    async function exec({ code, packages, timeoutMs = 120000 }) {
      await ensureReady();
      const iframe = getIframe();
      return new Promise((resolve, reject) => {
        const id = 'py_' + Math.random().toString(36).slice(2, 11);
        const onMsg = (e) => {
          if (!e.data || e.data.id !== id) return;
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          if (e.data.type === 'result') {
            resolve({ value: e.data.value, stdout: e.data.stdout || '', stderr: e.data.stderr || '' });
          } else {
            reject(new Error(e.data.error || 'unknown sandbox error'));
          }
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error(`python_exec timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        iframe.contentWindow.postMessage({
          type: 'exec', id, code,
          packages: Array.isArray(packages) ? packages : []
        }, '*');
      });
    }

    return { exec };
  })();

  T({
    name: 'python_exec',
    group: 'devtools',
    description:
      'Execute Python code via Pyodide (full CPython compiled to WebAssembly) inside a sandboxed iframe. ' +
      'The first call lazily downloads Pyodide from cdn.jsdelivr.net (~5 MB; browser-cached after). ' +
      'Each call is isolated — no state persists between calls (no module imports carrying over, no global vars). ' +
      'Returns { value, stdout, stderr }: `value` is the result of the LAST expression (or the explicit returned value); ' +
      '`stdout` / `stderr` capture print() / exception traces. ' +
      'Pass `packages` to install via micropip before running, e.g. `["numpy", "requests"]`. ' +
      'Default timeout: 120 s.',
    parameters: OBJ({
      code: STR,
      packages: { type: 'array', items: STR },
      timeoutMs: NUM
    }, ['code']),
    handler: async (args = {}) => PythonSandbox.exec(args)
  });

  // ──────── AWS S3 (Signature V4 via WebCrypto) ────────
  // Self-contained signing — no SDK bloat. Works with native AWS S3
  // and S3-compatible endpoints (Cloudflare R2, Wasabi, MinIO,
  // Backblaze B2 S3, etc.).
  function _bytesFrom(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === 'string') return new TextEncoder().encode(v);
    return new TextEncoder().encode(String(v));
  }
  async function _sha256Hex(data) {
    const buf = await crypto.subtle.digest('SHA-256', _bytesFrom(data));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function _hmac(key, data) {
    const k = (key instanceof Uint8Array) ? key : _bytesFrom(key);
    const ck = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, _bytesFrom(data));
    return new Uint8Array(sig);
  }
  function _hex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function s3Put({ accessKey, secretKey, region, bucket, key, body, contentType, endpoint }) {
    const service = 's3';
    region = region || 'us-east-1';
    let host, path;
    if (endpoint) {
      const ep = new URL(endpoint);
      host = ep.host;
      const epPath = (ep.pathname || '').replace(/\/+$/, '');
      // S3-compatible endpoints typically take /<bucket>/<key>.
      path = `${epPath}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      host = `${bucket}.s3.${region}.amazonaws.com`;
      path = '/' + key.split('/').map(encodeURIComponent).join('/');
    }
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const bodyBytes = _bytesFrom(body);
    const bodyHash = await _sha256Hex(bodyBytes);

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${bodyHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'PUT', path, '', canonicalHeaders, signedHeaders, bodyHash
    ].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, await _sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate    = await _hmac('AWS4' + secretKey, dateStamp);
    const kRegion  = await _hmac(kDate, region);
    const kService = await _hmac(kRegion, service);
    const kSigning = await _hmac(kService, 'aws4_request');
    const sig      = _hex(await _hmac(kSigning, stringToSign));

    const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
    const url = `https://${host}${path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': amzDate,
        'Authorization': auth,
        'Content-Type': contentType || 'application/octet-stream'
      },
      body: bodyBytes
    });
    return { res, url };
  }
  async function _readS3Settings() {
    const keys = ['s3AccessKeyId', 's3SecretAccessKey', 's3Region', 's3Bucket', 's3KeyPrefix', 's3Endpoint'];
    const g = await chrome.storage.local.get(keys);
    return {
      accessKey:  g.s3AccessKeyId || '',
      secretKey:  g.s3SecretAccessKey || '',
      region:     g.s3Region || 'us-east-1',
      bucket:     g.s3Bucket || '',
      keyPrefix:  g.s3KeyPrefix || '',
      endpoint:   g.s3Endpoint || ''
    };
  }
  function _s3PublicUrl(s, key) {
    if (s.endpoint) {
      try { return new URL(`${s.bucket}/${key}`, s.endpoint).toString(); } catch { return null; }
    }
    return `https://${s.bucket}.s3.${s.region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  function _guessKeyFromUrl(url) {
    try {
      const u = new URL(url);
      const name = u.pathname.split('/').pop() || ('file-' + Date.now());
      return decodeURIComponent(name).replace(/[?#].*$/, '') || ('file-' + Date.now());
    } catch { return 'file-' + Date.now(); }
  }

  T({
    name: 's3_upload',
    group: 'media',
    description: 'Upload data to AWS S3 or any S3-compatible endpoint (Cloudflare R2, Wasabi, MinIO, Backblaze B2). Credentials come from Settings → AWS S3. Pass `sourceUrl` to upload an external file (Kyoto fetches it first) OR `content` to upload a string directly. `key` overrides the auto-derived filename; `bucket` overrides the default bucket. Returns the resulting object URL.',
    parameters: OBJ({
      sourceUrl: STR,
      content: STR,
      contentType: STR,
      key: STR,
      bucket: STR,
      keyPrefix: STR
    }),
    handler: async (args = {}) => {
      const s = await _readS3Settings();
      if (!s.accessKey || !s.secretKey) throw new Error('S3 credentials not configured (Settings → AWS S3).');
      const bucket = args.bucket || s.bucket;
      if (!bucket) throw new Error('No S3 bucket configured.');
      let bytes, contentType;
      if (args.content != null) {
        // Detect data: URLs so the common "screenshot -> upload" flow
        // doesn't upload the base64 string as a text file.
        const dm = typeof args.content === 'string' && args.content.startsWith('data:')
          ? args.content.match(/^data:([^;,]+)?(?:;([^,]+))?,([\s\S]*)$/)
          : null;
        if (dm) {
          contentType = args.contentType || dm[1] || 'application/octet-stream';
          if (dm[2] === 'base64') {
            const bin = atob(dm[3]);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else {
            bytes = new TextEncoder().encode(decodeURIComponent(dm[3]));
          }
        } else {
          bytes = new TextEncoder().encode(args.content);
          contentType = args.contentType || 'text/plain; charset=utf-8';
        }
      } else if (args.sourceUrl) {
        // credentials: 'include' so authenticated URLs work (the user's
        // cookies are sent — extension has <all_urls> host permission).
        const r = await fetch(args.sourceUrl, { credentials: 'include' });
        if (!r.ok) throw new Error(`source fetch ${r.status}`);
        bytes = new Uint8Array(await r.arrayBuffer());
        contentType = args.contentType || r.headers.get('content-type') || 'application/octet-stream';
      } else {
        throw new Error('Pass `content` or `sourceUrl`.');
      }
      const prefix = (args.keyPrefix ?? s.keyPrefix).replace(/^\/+|\/+$/g, '');
      const baseKey = args.key || _guessKeyFromUrl(args.sourceUrl || '');
      const fullKey = prefix ? `${prefix}/${baseKey}` : baseKey;
      const { res, url } = await s3Put({
        accessKey: s.accessKey, secretKey: s.secretKey,
        region: s.region, bucket, key: fullKey,
        endpoint: s.endpoint, body: bytes, contentType
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`S3 PUT ${res.status}: ${text.slice(0, 400)}`);
      }
      return {
        ok: true,
        url: _s3PublicUrl({ ...s, bucket }, fullKey),
        key: fullKey,
        bucket,
        bytes: bytes.length,
        contentType
      };
    }
  });

  // ──────── MEDIA DETECT + DOWNLOAD ────────
  T({
    name: 'media_detect',
    group: 'media',
    description: 'Scan the active page for media URLs: <video>/<audio>/<source> tags, og:video / og:audio meta, JSON-LD VideoObject, plus media-typed requests from the network capture buffer. Detects YouTube specifically and notes the in-browser limitation (signature deciphering not feasible without yt-dlp).',
    parameters: OBJ({ tabId: NUM, includeNetwork: BOOL }),
    handler: async ({ tabId, includeNetwork = true } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const dom = await scrip(tabId, () => {
        const out = [];
        for (const el of document.querySelectorAll('video, audio')) {
          if (el.currentSrc) out.push({ kind: 'media-element', tag: el.tagName.toLowerCase(), url: el.currentSrc });
          else if (el.src) out.push({ kind: 'media-element', tag: el.tagName.toLowerCase(), url: el.src });
          for (const s of el.querySelectorAll('source')) {
            if (s.src) out.push({ kind: 'source', tag: 'source', url: s.src, type: s.type || '' });
          }
        }
        for (const m of document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"]')) {
          if (m.content) out.push({ kind: 'opengraph', property: m.getAttribute('property'), url: m.content });
        }
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(s.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const it of items) {
              const t = it && it['@type'];
              if (!t) continue;
              if (t === 'VideoObject' || t === 'AudioObject' || t === 'MusicRecording') {
                if (it.contentUrl) out.push({ kind: 'json-ld', type: t, name: it.name || '', url: it.contentUrl });
              }
            }
          } catch {}
        }
        const yt = (location.host.endsWith('youtube.com') || location.host === 'youtu.be') ||
                   (typeof window.ytInitialPlayerResponse !== 'undefined');
        return { items: out, isYouTube: yt, url: location.href, title: document.title };
      }, []);

      let net = [];
      if (includeNetwork) {
        try {
          const r = await bg('NET_CAPTURE_LIST', {
            filter: '\\.(mp4|m4v|webm|mov|m3u8|mpd|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\\?|$|/)',
            limit: 80
          });
          net = (r?.events || []).map(e => ({
            kind: 'network', url: e.url, status: e.status, type: e.type, ip: e.ip
          }));
        } catch {}
      }

      const dedup = new Set();
      const all = [...(dom?.items || []), ...net].filter(x => {
        if (!x.url) return false;
        if (dedup.has(x.url)) return false;
        dedup.add(x.url);
        return true;
      });

      return {
        page: { url: dom?.url, title: dom?.title },
        items: all,
        isYouTube: !!dom?.isYouTube,
        notes: [
          dom?.isYouTube ? 'YouTube detected — call `yt_dlp_run { url: location.href }` (full speed via shell bridge + yt-dlp). It also handles 1500 other sites: Instagram, Twitter/X, Vimeo, Twitch, TikTok, podcasts, etc.' : null,
          'Got a direct file URL (an .mp3 / .mp4 / etc. you can fetch as-is)? Pass it to `media_download`.',
          'Got a site URL (not a direct file)? Use `yt_dlp_run` — it handles cookies, ciphers, manifest reassembly, ffmpeg merge automatically.',
          'For HLS (.m3u8) without yt-dlp: fetch the manifest with `network_fetch`, parse, download segments. yt-dlp does this for you.'
        ].filter(Boolean)
      };
    }
  });

  T({
    name: 'media_download',
    group: 'media',
    description:
      'Download a DIRECT media URL (.mp4, .m4a, .mp3, .webm, …) via chrome.downloads (default) or upload it to S3 (uploadToS3: true). ' +
      'Use this when you already have the direct file URL — e.g. a podcast .mp3 link, a CDN .mp4 from `media_detect`, or any URL `web_fetch_extract` surfaced. ' +
      'NOT the right choice for site URLs like youtube.com / instagram.com / twitter.com — for those, use `yt_dlp_run` instead (handles login cookies, signature ciphers, manifest reassembly, ffmpeg merge automatically). ' +
      'Pass `filename` (or `s3Key`) to override the auto-derived name.',
    parameters: OBJ({
      url: STR,
      filename: STR,
      uploadToS3: BOOL,
      s3Key: STR,
      s3Bucket: STR,
      saveAs: BOOL
    }, ['url']),
    handler: async ({ url, filename, uploadToS3, s3Key, s3Bucket, saveAs = false } = {}) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const fname = filename || _guessKeyFromUrl(url);

      if (uploadToS3) {
        const s = await _readS3Settings();
        if (!s.accessKey || !s.secretKey) throw new Error('S3 credentials not configured (Settings → AWS S3).');
        const bucket = s3Bucket || s.bucket;
        if (!bucket) throw new Error('No S3 bucket configured.');
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error(`source fetch ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        const prefix = s.keyPrefix.replace(/^\/+|\/+$/g, '');
        const key = (prefix ? prefix + '/' : '') + (s3Key || fname);
        const { res } = await s3Put({
          accessKey: s.accessKey, secretKey: s.secretKey,
          region: s.region, bucket, key,
          endpoint: s.endpoint, body: bytes, contentType
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`S3 PUT ${res.status}: ${t.slice(0, 400)}`);
        }
        return {
          ok: true,
          target: 's3',
          s3Url: _s3PublicUrl({ ...s, bucket }, key),
          key, bucket, bytes: bytes.length, contentType
        };
      }

      // Local download — let chrome.downloads stream it (no JS-memory blob).
      const downloadId = await chrome.downloads.download({ url, filename: fname, saveAs });
      return { ok: true, target: 'local', downloadId, suggestedFilename: fname };
    }
  });

  // ──────── CHAT HISTORY EXPORT ────────
  // Pulls the active (or named) session out of side-panel storage,
  // serialises it as JSON or Markdown, and downloads it via
  // chrome.downloads. Useful when the user wants a record outside
  // the extension's own storage.
  function _formatSessionMarkdown(session, { providerLabel } = {}) {
    if (!session) return '# (no session)';
    const lines = [];
    const created = session.createdAt ? new Date(session.createdAt).toISOString() : 'unknown';
    lines.push(`# Kyoto chat — ${session.title || session.id}`);
    lines.push('');
    lines.push(`- **Session id:** \`${session.id}\``);
    lines.push(`- **Created:** ${created}`);
    if (session.tabUrl) lines.push(`- **Bound tab URL:** ${session.tabUrl}`);
    if (providerLabel) lines.push(`- **Provider/model at export time:** ${providerLabel}`);
    if (session.goal) lines.push(`- **Active goal:** ${session.goal}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    const history = session.history || [];
    for (const msg of history) {
      const role = msg.role;
      if (role === 'system') {
        lines.push('## ⚙️ System');
        lines.push('');
        lines.push('```');
        lines.push((msg.content || '').toString());
        lines.push('```');
        lines.push('');
        continue;
      }
      if (role === 'user') {
        lines.push('## 👤 User');
        lines.push('');
        const c = msg.content;
        if (typeof c === 'string') {
          lines.push(c);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (part?.type === 'text') lines.push(part.text || '');
            else if (part?.type === 'image_url') lines.push(`![image](${part.image_url?.url || ''})`);
          }
        }
        lines.push('');
        continue;
      }
      if (role === 'assistant') {
        lines.push('## 🤖 Assistant');
        if (msg._finishReason) lines.push(`*finish: \`${msg._finishReason}\`*`);
        if (msg._usage) {
          const u = msg._usage;
          const cost = msg._cost != null ? ` · $${Number(msg._cost).toFixed(4)}` : '';
          lines.push(`*tokens: in ${u.prompt_tokens ?? '?'} · out ${u.completion_tokens ?? '?'} · total ${u.total_tokens ?? '?'}${cost}*`);
        }
        lines.push('');
        if (msg.reasoning_content) {
          lines.push('<details><summary>Reasoning (thinking)</summary>');
          lines.push('');
          lines.push(msg.reasoning_content);
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        if (msg.content) {
          lines.push(msg.content);
          lines.push('');
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name || '(unknown)';
            lines.push(`#### 🔧 Tool call: \`${name}\``);
            lines.push('');
            lines.push('```json');
            let args = tc.function?.arguments || '{}';
            try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
            lines.push(args);
            lines.push('```');
            lines.push('');
          }
        }
        continue;
      }
      if (role === 'tool') {
        lines.push(`#### 📦 Tool result${msg.name ? ` (\`${msg.name}\`)` : ''}`);
        lines.push('');
        lines.push('```json');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        if (content && content.length > 20000) lines.push(content.slice(0, 20000) + `\n… (truncated, ${content.length - 20000} more chars)`);
        else lines.push(content || '');
        lines.push('```');
        lines.push('');
        continue;
      }
    }
    return lines.join('\n');
  }

  function _suggestedExportName(session, ext) {
    const safe = (s) => String(s || '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = safe(session?.title) || safe(session?.id) || 'chat';
    return `kyoto-chat-${slug}-${stamp}.${ext}`;
  }

  T({
    name: 'chat_export',
    group: 'misc',
    description:
      'Export the chat history as a downloadable file. ' +
      '`format` is "json" (full structure incl. tool calls / tool results / usage stats — round-trippable) or "markdown" (human-readable). ' +
      'Default scope is the ACTIVE session. Pass `sessionId` to export a specific session, or `scope: "all"` to bundle every session into one archive. ' +
      'Returns { ok, filename, bytes, downloadId, format }.',
    parameters: OBJ({
      format: { type: 'string', enum: ['json', 'markdown', 'md'] },
      sessionId: STR,
      scope: { type: 'string', enum: ['active', 'all'] },
      filename: STR
    }, ['format']),
    handler: async ({ format, sessionId, scope = 'active', filename } = {}) => {
      if (!window.KyotoSession) throw new Error('Session API not available');
      const fmt = format === 'md' ? 'markdown' : format;
      let content, mime, ext;

      if (scope === 'all') {
        const index = window.KyotoSession.listIndex();
        const sessions = [];
        for (const meta of index) {
          // eslint-disable-next-line no-await-in-loop
          const full = await window.KyotoSession.load(meta.id);
          if (full) sessions.push(full);
        }
        if (fmt === 'markdown') {
          content = sessions.map(s => _formatSessionMarkdown(s)).join('\n\n---\n\n');
          mime = 'text/markdown';
          ext = 'md';
        } else {
          content = JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2);
          mime = 'application/json';
          ext = 'json';
        }
      } else {
        const session = sessionId
          ? await window.KyotoSession.load(sessionId)
          : window.KyotoSession.active();
        if (!session) throw new Error('No session to export');
        if (fmt === 'markdown') {
          const snap = window.KyotoSession.settingsSnapshot();
          content = _formatSessionMarkdown(session, { providerLabel: `${snap.provider}/${snap.model}` });
          mime = 'text/markdown';
          ext = 'md';
        } else {
          content = JSON.stringify(session, null, 2);
          mime = 'application/json';
          ext = 'json';
        }
      }

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const suggested = filename || _suggestedExportName(
        scope === 'all' ? { title: 'all-sessions' } : (sessionId ? { id: sessionId } : window.KyotoSession.active()),
        ext
      );
      const downloadId = await chrome.downloads.download({ url, filename: suggested, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      return { ok: true, filename: suggested, bytes: blob.size, downloadId, format: fmt, scope };
    }
  });

  // ──────── VIRTUAL FILESYSTEM (in IndexedDB) ────────
  // A scratch workspace for the agent — drop scraped data here in
  // chunks, walk it later, package up as a ZIP for the user to
  // download. Lives in IndexedDB so the quota is large (~GBs) and
  // survives panel reloads. All paths are absolute, "/"-rooted, and
  // directories are implicit. Stored as binary internally; tools
  // expose text by default.
  function _vfs() {
    if (!window.KyotoVFS) throw new Error('VFS not loaded');
    return window.KyotoVFS;
  }

  T({
    name: 'fs_write',
    group: 'fs',
    description:
      'Write a file into the agent\'s virtual workspace (IndexedDB-backed, persists across panel reloads). ' +
      'Use this to checkpoint scraped data, intermediate JSON, generated code, etc. outside the conversation context. ' +
      '`path` is absolute under "/" — e.g. "/scrape/users/page-1.json". Existing files are overwritten; use `fs_append` to extend instead. ' +
      'Bytes are stored as-is; on read they\'re decoded as UTF-8 unless you ask for binary.',
    parameters: OBJ({ path: STR, content: STR, mime: STR }, ['path', 'content']),
    handler: async ({ path, content, mime } = {}) => _vfs().write(path, content, { mime })
  });

  T({
    name: 'fs_append',
    group: 'fs',
    description:
      'Append text to a workspace file (creates it if missing). Useful when streaming output during a long scrape — append after each page rather than buffering everything in the conversation. Pair with `fs_zip` at the end.',
    parameters: OBJ({ path: STR, content: STR }, ['path', 'content']),
    handler: async ({ path, content } = {}) => _vfs().append(path, content)
  });

  T({
    name: 'fs_read',
    group: 'fs',
    description:
      'Read a workspace file. Returns content as text by default. For files larger than the model\'s context, pass `offset` + `limit` to read in chunks; the response includes `bytesRead`, `totalSize`, and `truncated` so you can paginate. Pass encoding="binary" to get a base64 string instead of decoded text.',
    parameters: OBJ({
      path: STR,
      offset: NUM,
      limit: NUM,
      encoding: { type: 'string', enum: ['utf-8', 'utf-16', 'latin1', 'binary'] }
    }, ['path']),
    handler: async (args = {}) => _vfs().read(args.path, args)
  });

  T({
    name: 'fs_list',
    group: 'fs',
    description:
      'List files in the workspace. Pass `path` to scope (default "/", which is everything). Set `recursive: false` to only show immediate children. Returns { files: [{path, size, mtime, mime}, …], dirs: ["/scrape", …], totalFiles }.',
    parameters: OBJ({ path: STR, recursive: BOOL, limit: NUM }),
    handler: async (args = {}) => _vfs().list(args)
  });

  T({
    name: 'fs_stat',
    group: 'fs',
    description: 'Metadata for one workspace file: size, mime, mtime. Returns null if the file does not exist.',
    parameters: OBJ({ path: STR }, ['path']),
    handler: async ({ path } = {}) => _vfs().stat(path)
  });

  T({
    name: 'fs_delete',
    group: 'fs',
    description: 'Delete a file. Set `recursive: true` to delete every file under a directory prefix. Use sparingly — there is no trash.',
    parameters: OBJ({ path: STR, recursive: BOOL }, ['path']),
    handler: async (args = {}) => _vfs().del(args.path, args)
  });

  T({
    name: 'fs_move',
    group: 'fs',
    description: 'Rename or move a single workspace file. Does not yet support moving a whole subtree — use fs_list + fs_move/fs_delete for that.',
    parameters: OBJ({ from: STR, to: STR }, ['from', 'to']),
    handler: async ({ from, to } = {}) => _vfs().move(from, to)
  });

  T({
    name: 'fs_total',
    group: 'fs',
    description: 'Summary of the workspace: { fileCount, totalBytes }.',
    parameters: OBJ(),
    handler: async () => _vfs().total()
  });

  T({
    name: 'fs_zip',
    group: 'fs',
    description:
      'Bundle a workspace subtree into a ZIP and trigger a download to the user\'s Downloads folder. ' +
      '`path` selects the subtree to zip (default "/" = everything). `outputName` overrides the suggested filename (default `kyoto-workspace-<timestamp>.zip`). ' +
      'Returns { ok, fileCount, bytes, downloadId, suggestedFilename } on success.',
    parameters: OBJ({ path: STR, outputName: STR }),
    handler: async ({ path = '/', outputName } = {}) => {
      const blob = await _vfs().exportZip({ path });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/-Z$/, 'Z');
      const filename = outputName || `kyoto-workspace-${ts}.zip`;
      const url = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      const t = await _vfs().total();
      return { ok: true, fileCount: t.fileCount, bytes: blob.size, downloadId, suggestedFilename: filename };
    }
  });

  T({
    name: 'fs_clear',
    group: 'fs',
    description: 'Wipe EVERY file in the workspace. The agent should not call this without explicit user confirmation — use only when the user explicitly asks to start fresh.',
    parameters: OBJ(),
    handler: async () => _vfs().clear()
  });

  // ──────── SHELL (native messaging to local host) ────────
  // Talks to the kyoto-shell.py host installed via install.sh / install.ps1.
  // One long-lived chrome.runtime.connectNative port; auto-reconnects.
  const ShellHost = (() => {
    const HOST_NAME = 'com.kyoto.shell';
    let port = null;
    const pending = new Map();   // id -> { resolve, reject, timeoutId }

    function disconnect(err) {
      port = null;
      for (const [id, { reject, timeoutId }] of pending) {
        clearTimeout(timeoutId);
        reject(err || new Error('shell host disconnected'));
      }
      pending.clear();
    }

    function ensurePort() {
      if (port) return port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (e) {
        throw new Error(`Native messaging not available: ${e.message}`);
      }
      port.onMessage.addListener((msg) => {
        const id = msg && msg.id;
        if (!id || !pending.has(id)) return;
        const { resolve, timeoutId } = pending.get(id);
        clearTimeout(timeoutId);
        pending.delete(id);
        resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        const lastErr = chrome.runtime.lastError;
        const e = lastErr
          ? new Error(`Shell host: ${lastErr.message}. Run the installer? curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`)
          : null;
        disconnect(e);
      });
      return port;
    }

    function send(msg, timeoutMs) {
      const id = msg.id || ('sh_' + Math.random().toString(36).slice(2, 11));
      msg.id = id;
      return new Promise((resolve, reject) => {
        let p;
        try { p = ensurePort(); } catch (e) { return reject(e); }
        const timeoutId = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`shell_exec timed out after ${Math.round(timeoutMs / 1000)}s`));
          }
        }, timeoutMs + 2000); // give the host a couple of seconds to surface its own timeout
        pending.set(id, { resolve, reject, timeoutId });
        try { p.postMessage(msg); }
        catch (e) {
          clearTimeout(timeoutId);
          pending.delete(id);
          reject(e);
        }
      });
    }

    return { send, get extensionId() { return chrome.runtime.id; } };
  })();

  T({
    name: 'shell_exec',
    group: 'shell',
    description:
      'Execute a shell command on the user\'s OS via Kyoto\'s native messaging host. Runs as the user, with their PATH and env. ' +
      'Returns { stdout, stderr, exitCode }. Long-running commands stream nothing — they\'re captured in full and returned at the end (or `error: timed out`). ' +
      'Requires the host to be installed once: curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- <EXTENSION_ID>. ' +
      'WINDOWS: irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex. ' +
      'The extension ID is shown in Settings → Shell bridge.',
    parameters: OBJ({
      command: STR,
      cwd: STR,
      timeoutMs: NUM,
      env: { type: 'object', additionalProperties: STR }
    }, ['command']),
    handler: async ({ command, cwd, timeoutMs = 60000, env } = {}) => {
      if (!command || !command.trim()) throw new Error('command required');
      try {
        const r = await ShellHost.send({ command, cwd, timeoutMs, env }, timeoutMs);
        if (r.error) return { error: r.error, stdout: r.stdout || '', stderr: r.stderr || '' };
        return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode ?? null, cwd: r.cwd };
      } catch (e) {
        return {
          error: e.message,
          installHint: `Run: curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`,
          installHintWindows: `Run (PowerShell): $env:KYOTO_EXT_ID="${chrome.runtime.id}"; irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex`
        };
      }
    }
  });

  T({
    name: 'shell_ping',
    group: 'shell',
    description: 'Ping the native messaging host to verify it\'s installed and reachable. Returns { ok, platform, cwd } on success, an installHint on failure.',
    parameters: OBJ(),
    handler: async () => {
      try {
        const r = await ShellHost.send({ type: 'ping' }, 5000);
        return { ok: true, platform: r.platform, cwd: r.cwd };
      } catch (e) {
        return {
          ok: false,
          error: e.message,
          installHint: `curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`,
          installHintWindows: `$env:KYOTO_EXT_ID="${chrome.runtime.id}"; irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex`
        };
      }
    }
  });

  // ──────── YOUTUBE (best-effort, signature-cipher caveat) ────────
  T({
    name: 'youtube_extract',
    group: 'media',
    description:
      'Extract YouTube streaming data (formats, URLs, metadata) from the active YouTube tab by reading ytInitialPlayerResponse. ' +
      'Primarily diagnostic — for actually downloading, prefer `yt_dlp_run` which is full-speed and handles signatures + n-param + ffmpeg merging. ' +
      'Returns each format with `url` + `needsCipher`; formats with `needsCipher: false` and a non-null `url` would work with `media_download`, but most modern YouTube formats are ciphered. ' +
      'Live streams usually expose `hlsManifestUrl`.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        let pr = window.ytInitialPlayerResponse
          || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response);
        if (typeof pr === 'string') {
          try { pr = JSON.parse(pr); } catch { pr = null; }
        }
        if (!pr) {
          // Last-resort scrape of the inline script
          const html = document.documentElement.innerHTML;
          // [\s\S]+? — `.+?` doesn't span newlines and the YouTube
          // inline JSON spans them. The non-greedy quantifier stops
          // at the first `};` followed by the right boundary token.
          const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var |<\/script>)/);
          if (m) { try { pr = JSON.parse(m[1]); } catch {} }
        }
        if (!pr) {
          return { error: 'Not a YouTube watch / shorts / music page, or player response unavailable.' };
        }
        const sd = pr.streamingData || {};
        const vd = pr.videoDetails || {};

        const mapFmt = (f) => ({
          itag: f.itag,
          mimeType: f.mimeType,
          quality: f.qualityLabel || f.audioQuality,
          bitrate: f.bitrate,
          fps: f.fps,
          width: f.width,
          height: f.height,
          contentLength: f.contentLength,
          durationMs: f.approxDurationMs,
          url: f.url || null,
          needsCipher: !f.url && !!f.signatureCipher
        });
        return {
          videoId: vd.videoId,
          title: vd.title,
          author: vd.author,
          channelId: vd.channelId,
          durationSec: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
          viewCount: vd.viewCount ? Number(vd.viewCount) : null,
          isLive: !!vd.isLive || !!vd.isLiveContent,
          thumbnails: (vd.thumbnail && vd.thumbnail.thumbnails) || [],
          progressive: (sd.formats || []).map(mapFmt),
          adaptive: (sd.adaptiveFormats || []).map(mapFmt),
          hlsManifestUrl: sd.hlsManifestUrl || null,
          dashManifestUrl: sd.dashManifestUrl || null
        };
      });
    }
  });

  T({
    name: 'youtube_capture_streams',
    group: 'media',
    description:
      'Last-resort YouTube workaround when the shell bridge / yt_dlp_run is unavailable. ' +
      'Snoops the page\'s own player network traffic to grab post-cipher videoplayback URLs (no signature decoding needed). ' +
      'Plays the video briefly, captures URLs, returns them grouped by itag. Pass `urlWithoutRange` to `media_download`. ' +
      'IMPORTANT: in-browser downloads are THROTTLED to ~30-100 KB/s by YouTube\'s n-parameter — only yt-dlp deciphers it. ' +
      'PREFER `yt_dlp_run` if the shell bridge is installed (full speed, no babysitting).',
    parameters: OBJ({
      tabId: NUM,
      playForMs: NUM
    }),
    handler: async ({ tabId, playForMs = 5000 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.get(tabId);
      if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(tab?.url || '')) {
        return { error: `Active tab isn't YouTube: ${tab?.url}` };
      }

      const wasCapturing = (await bg('NET_CAPTURE_LIST', { limit: 1 }))?.capturing;
      if (!wasCapturing) await bg('NET_CAPTURE_START', { scope: 'tab', tabId });
      // Clear any pre-existing capture so we only see fresh requests.
      try { await bg('NET_CAPTURE_CLEAR'); } catch {}

      // Kick the player so it actually fetches segments. We have to land
      // OUTSIDE the already-buffered range or the player never re-requests
      // — YouTube buffers ~120s ahead, so +0.5s is always inside it.
      const playResult = await scrip(tabId, () => {
        const v = document.querySelector('video');
        if (!v) return { played: false, error: 'no <video> element on page' };
        try { v.play(); } catch {}
        try {
          if (isFinite(v.duration) && v.duration > 0) {
            const old = v.currentTime || 0;
            // Pick a target well past the buffer head. If we're already
            // near the end, jump backwards instead.
            const ahead = old + 180;
            const target = ahead < v.duration - 5 ? ahead : Math.max(0, old - 60);
            v.currentTime = target;
          }
        } catch {}
        return { played: !v.paused, currentTime: v.currentTime, duration: v.duration };
      });

      const waitMs = Math.max(1500, Math.min(20000, playForMs));
      // While waiting, re-seek every ~2s to invalidate the buffer again —
      // catches players that re-buffer aggressively and stop fetching.
      const seekTicker = (async () => {
        const ticks = Math.floor(waitMs / 2000);
        for (let i = 1; i < ticks; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            await scrip(tabId, () => {
              const v = document.querySelector('video');
              if (!v || !isFinite(v.duration) || v.duration <= 0) return;
              const next = (v.currentTime + 47) % Math.max(60, v.duration - 5);
              v.currentTime = next;
            });
          } catch {}
        }
      })();
      await Promise.race([
        seekTicker,
        new Promise(r => setTimeout(r, waitMs))
      ]);

      const cap = await bg('NET_CAPTURE_LIST', {
        filter: 'googlevideo\\.com.*videoplayback',
        limit: 400
      });
      if (!wasCapturing) await bg('NET_CAPTURE_STOP');

      // One entry per itag (the latest URL we saw for it).
      const byItag = new Map();
      const stripRange = (u) => u
        .replace(/[?&]range=[^&]*/, '')
        .replace(/[?&]rn=[^&]*/, '')
        .replace(/[?&]rbuf=[^&]*/, '');
      for (const e of (cap?.events || [])) {
        const m = e.url && e.url.match(/[?&]itag=(\d+)/);
        if (!m) continue;
        const itag = m[1];
        if (byItag.has(itag) && cap.events.indexOf(e) < cap.events.length / 2) continue;
        const mime = (() => {
          const t = (e.url.match(/[?&]mime=([^&]+)/) || [])[1];
          return t ? decodeURIComponent(t) : null;
        })();
        byItag.set(itag, {
          itag,
          url: e.url,
          urlWithoutRange: stripRange(e.url),
          mime,
          status: e.status
        });
      }

      // Best-effort itag categorisation. Audio-only and progressive lists
      // are well-known; anything else is treated as video-only adaptive.
      const AUDIO = new Set(['139','140','141','171','249','250','251','256','258','327','380','600','774']);
      const PROGRESSIVE = new Set(['5','6','17','18','22','34','35','36','37','38','43','44','45','46','82','83','84','85','100','101','102']);
      const items = [...byItag.values()];
      const audio = items.filter(i => AUDIO.has(i.itag));
      const progressive = items.filter(i => PROGRESSIVE.has(i.itag));
      const video = items.filter(i => !AUDIO.has(i.itag) && !PROGRESSIVE.has(i.itag));

      return {
        ok: items.length > 0,
        playResult,
        captured: items.length,
        progressive, audio, video,
        hint: items.length
          ? 'Pass `urlWithoutRange` from any item to `media_download` to grab the full stream. Progressive items have audio+video combined; otherwise pick one from `audio` and one from `video` and merge externally with ffmpeg.'
          : 'No googlevideo URLs were captured. Reasons: (1) autoplay was blocked — ask the user to click play once, then retry. (2) The page is YouTube Music or Shorts which sometimes hold off on segment fetches. (3) `webRequest` permission was revoked. Fall back to `yt_dlp_command`.'
      };
    }
  });

  // Internal helper — calls shell_exec via the same ShellHost.send the
  // shell_exec tool uses. Throws if the shell bridge isn't installed.
  async function _shell(command, timeoutMs = 60000) {
    return ShellHost.send({ command, timeoutMs }, timeoutMs);
  }

  // Where binaries get dropped by various installers. The shell host
  // runs commands without sourcing the user's interactive shell rc,
  // so PATH may not include these. Always try in order.
  const _YT_DLP_PATHS = [
    '/opt/homebrew/bin/yt-dlp',       // Apple Silicon Homebrew
    '/usr/local/bin/yt-dlp',          // Intel Homebrew + most Linux package managers
    '$HOME/.local/bin/yt-dlp',        // pipx default + pip --user (Linux + macOS Python.org)
    '/opt/local/bin/yt-dlp',          // MacPorts
    // pip --user on macOS system Python installs under ~/Library/Python/3.X/bin
    '$HOME/Library/Python/3.13/bin/yt-dlp',
    '$HOME/Library/Python/3.12/bin/yt-dlp',
    '$HOME/Library/Python/3.11/bin/yt-dlp',
    '$HOME/Library/Python/3.10/bin/yt-dlp',
    '$HOME/Library/Python/3.9/bin/yt-dlp'
  ];

  // Returns a usable yt-dlp invocation string, e.g.
  //   "/opt/homebrew/bin/yt-dlp"
  //   "$HOME/Library/Python/3.9/bin/yt-dlp"
  //   "python3 -m yt_dlp"
  //   null if nothing works.
  // Verify a yt-dlp invocation actually runs. `test -x` lies for Homebrew
  // binaries whose Python shebang points at a removed interpreter
  // ("bad interpreter: /opt/homebrew/opt/python@3.11/bin/python3.11").
  async function _ytDlpProbe(invocation) {
    try {
      const r = await _shell(`${invocation} --version 2>&1`, 8000);
      if (r.exitCode !== 0) return false;
      // The real yt-dlp prints a date-like version (e.g. "2025.10.14").
      return /\d{4}\.\d{2}\.\d{2}/.test(r.stdout || '');
    } catch {
      return false;
    }
  }

  async function _findYtDlp() {
    // 1) any of the well-known absolute paths — but verify it actually runs.
    for (const p of _YT_DLP_PATHS) {
      // eslint-disable-next-line no-await-in-loop
      if (await _ytDlpProbe(p)) return p;
    }
    // 2) on the shell's PATH directly
    const r2 = await _shell('command -v yt-dlp 2>/dev/null || true', 5000);
    const out2 = (r2.stdout || '').trim();
    if (out2 && await _ytDlpProbe(out2)) return out2;
    // 3) python -m yt_dlp (the module IS installed even if the script isn't on PATH)
    for (const py of ['python3', 'python']) {
      // eslint-disable-next-line no-await-in-loop
      if (await _ytDlpProbe(`${py} -m yt_dlp`)) return `${py} -m yt_dlp`;
    }
    return null;
  }

  async function _ytDlpAutoInstall() {
    // Prefer pipx (clean install), then user-site pip. yt-dlp self-updates
    // via "yt-dlp -U" so we don't have to upgrade it ourselves.
    const candidates = [
      'pipx install yt-dlp',
      'python3 -m pip install --user --upgrade yt-dlp',
      'pip3 install --user --upgrade yt-dlp',
      'python -m pip install --user --upgrade yt-dlp',
      'pip install --user --upgrade yt-dlp'
    ];
    const log = [];
    for (const c of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await _shell(c + ' 2>&1', 240000);
        log.push(`${c} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) {
          // eslint-disable-next-line no-await-in-loop
          const found = await _findYtDlp();
          if (found) {
            log.push(`yt-dlp ok at: ${found}`);
            return { ok: true, binary: found, log };
          }
        }
      } catch (e) {
        log.push(`${c} -> ${e.message}`);
      }
    }
    return { ok: false, log };
  }

  // Heuristic: did this look like YouTube's SABR-only 403?
  function _is403Sabr(text) {
    if (!text) return false;
    return /HTTP Error 403/.test(text) || /SABR/i.test(text) || /Please sign in/i.test(text);
  }

  // Check if ffmpeg is on the user's PATH. yt-dlp NEEDS ffmpeg to
  // merge bv*+ba streams; without it we silently fall back to a
  // single (usually 360p) progressive format.
  async function _hasFfmpeg() {
    const candidates = [
      'ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/opt/local/bin/ffmpeg'
    ];
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const r = await _shell(`${c} -version >/dev/null 2>&1 && echo OK || echo MISS`, 5000);
      if (/OK/.test(r.stdout || '')) return c;
    }
    return null;
  }

  // Best-effort ffmpeg installer. macOS gets brew, Linux gets apt /
  // dnf / pacman / apk in order. Returns { ok, log }.
  async function _installFfmpeg() {
    const log = [];
    const cmds = [
      // macOS — Homebrew first (most common)
      '(test -x /opt/homebrew/bin/brew && /opt/homebrew/bin/brew install ffmpeg) || (test -x /usr/local/bin/brew && /usr/local/bin/brew install ffmpeg) || false',
      // Debian/Ubuntu
      'command -v apt >/dev/null && sudo -n apt install -y ffmpeg',
      // Fedora/RHEL
      'command -v dnf >/dev/null && sudo -n dnf install -y ffmpeg',
      // Arch
      'command -v pacman >/dev/null && sudo -n pacman -S --noconfirm ffmpeg',
      // Alpine
      'command -v apk >/dev/null && sudo -n apk add ffmpeg'
    ];
    for (const c of cmds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await _shell(c + ' 2>&1', 300000);
        log.push(`${c.split('&&')[0].trim()} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) {
          // eslint-disable-next-line no-await-in-loop
          const ff = await _hasFfmpeg();
          if (ff) return { ok: true, ffmpeg: ff, log };
        }
      } catch (e) {
        log.push(`${c} -> ${e.message}`);
      }
    }
    return { ok: false, log };
  }

  // Try to install the bgutil PO-token provider plugin. yt-dlp picks it
  // up automatically the next time it runs. Needs Node.js because the
  // plugin shells out to a Node helper to mint tokens. Returns
  // { ok, log, method }. Best-effort — skipped silently if Node missing.
  async function _installPoTokenProvider() {
    const log = [];
    const node = await _shell('command -v node 2>/dev/null && node --version 2>&1', 5000);
    const hasNode = (node.stdout || '').trim().startsWith('v');
    log.push(`node detected: ${hasNode ? (node.stdout || '').trim() : 'NO'}`);
    if (!hasNode) {
      return { ok: false, log, reason: 'no Node.js — bgutil plugin needs it to mint PO tokens' };
    }
    // Package name has churned: try the current name first, then the
    // older / mirror names. Any one that ends up installable is fine.
    const pkgs = [
      'bgutil-ytdlp-pot-provider',
      'bgutils-ytdlp-pot-provider',
      'yt-dlp-get-pot-bgutil'
    ];
    const installers = ['pipx install', 'python3 -m pip install --user --upgrade', 'pip3 install --user --upgrade'];
    for (const installer of installers) {
      for (const pkg of pkgs) {
        const cmd = `${installer} ${pkg}`;
        // eslint-disable-next-line no-await-in-loop
        const r = await _shell(cmd + ' 2>&1', 180000);
        log.push(`${cmd} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) return { ok: true, log, method: cmd };
      }
    }
    return { ok: false, log };
  }

  // Attempt a yt-dlp self-update. Works for pipx and pip --user installs.
  // Cheap, idempotent. Skipped silently on permission errors.
  async function _ytDlpSelfUpdate(binary) {
    if (!binary) return { ok: false };
    // -U works for the standalone binary; for python -m yt_dlp paths
    // we need pip --upgrade instead.
    const isModuleInvocation = / -m yt_dlp$/.test(binary);
    const cmd = isModuleInvocation
      ? `${binary.split(' ')[0]} -m pip install --user --upgrade yt-dlp 2>&1`
      : `${binary} -U 2>&1`;
    try {
      const r = await _shell(cmd, 120000);
      return { ok: r.exitCode === 0, stdoutTail: (r.stdout || '').slice(-400) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  T({
    name: 'yt_dlp_run',
    group: 'media',
    description:
      'Download a media URL using yt-dlp via the shell bridge. ' +
      'This is the recommended path for ANY site yt-dlp supports — YouTube, Instagram, Twitter/X, Vimeo, Twitch, TikTok, SoundCloud, Bilibili, podcast sites, etc. (~1500 supported). ' +
      'Full speed (no n-param throttling), auto ffmpeg merge of separate streams. ' +
      'On first call, attempts to install yt-dlp automatically via pipx -> pip --user. ' +
      'Returns { ok, savedPath, command } on success. ' +
      'Requires the shell bridge to be installed (Settings → Shell bridge).',
    parameters: OBJ({
      url: STR,
      audioOnly: BOOL,
      format: STR,
      outputDir: STR,
      useBrowserCookies: BOOL,
      extraArgs: STR,
      timeoutMs: NUM
    }, ['url']),
    handler: async (args = {}) => {
      const { url, audioOnly = false, format, outputDir, useBrowserCookies = true, extraArgs = '', timeoutMs = 600000 } = args;
      if (!url || !/^https?:\/\//i.test(url)) {
        return { error: 'url must be a full http(s) URL' };
      }

      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const buildCmd = (binary, { ytClients } = {}) => {
        const parts = [binary];
        if (useBrowserCookies) parts.push('--cookies-from-browser', 'chrome');
        if (audioOnly) {
          parts.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        } else if (format) {
          parts.push('-f', sq(format));
        } else {
          parts.push('-f', sq('bv*+ba/b'), '--merge-output-format', 'mp4');
        }
        if (ytClients && /youtube\.com|youtu\.be/i.test(url)) {
          // Multi-client fallback works around YouTube's SABR-only experiment
          // (see yt-dlp issue #12482). tv_simply / web_safari / mweb still
          // serve plain https segment URLs at the time of writing.
          parts.push('--extractor-args', sq(`youtube:player_client=${ytClients}`));
        }
        const dir = (outputDir || '~/Downloads').replace(/\/+$/, '');
        parts.push('-o', sq(`${dir}/%(title)s.%(ext)s`));
        parts.push('--print', sq('after_move:filepath'));
        parts.push('--no-warnings');
        if (extraArgs && extraArgs.trim()) parts.push(extraArgs.trim());
        parts.push(sq(url));
        return parts.join(' ');
      };

      // 1) Find or install yt-dlp BEFORE the first download attempt.
      // We no longer "try yt-dlp blindly and hope PATH catches it" — the
      // shell host's PATH doesn't include pipx/pip --user dirs reliably.
      let binary, installLog;
      try {
        binary = await _findYtDlp();
      } catch (e) {
        return {
          error: e.message,
          hint: 'Shell bridge not installed. Open Settings → Shell bridge for the one-line installer.'
        };
      }
      if (!binary) {
        const inst = await _ytDlpAutoInstall();
        installLog = inst.log;
        if (!inst.ok) {
          return {
            error: 'yt-dlp is not installed and auto-install failed',
            installLog,
            hint: 'Install manually:  pipx install yt-dlp   (or:  pip3 install --user yt-dlp).  On macOS the easiest is:  brew install yt-dlp ffmpeg'
          };
        }
        binary = inst.binary;
      }

      // 2) Make sure ffmpeg is around for HQ YouTube (bv*+ba merging).
      // No-op if already installed or the user passed audioOnly+mp3 (which
      // still needs ffmpeg, but we attempt install lazily on 403 too).
      let ffmpegLog;
      const needsFfmpeg = !format || /\+/.test(format) || audioOnly;
      let ffmpegPath = null;
      if (needsFfmpeg) {
        ffmpegPath = await _hasFfmpeg();
        if (!ffmpegPath) {
          const inst = await _installFfmpeg();
          ffmpegLog = inst.log;
          if (inst.ok) ffmpegPath = inst.ffmpeg;
        }
      }

      // 3) For YouTube, try a SABR-resistant client tuple first.
      const isYouTube = /youtube\.com|youtu\.be/i.test(url);
      const clientPlan = isYouTube
        ? ['tv_simply,mweb,web_safari', 'default,tv_simply,mweb,web_safari,web_creator', null]
        : [null];

      let lastResult;
      let attemptedSelfUpdate = false;
      let attemptedPotProvider = false;
      let potProviderLog;
      for (const ytClients of clientPlan) {
        const cmd = buildCmd(binary, { ytClients });
        // eslint-disable-next-line no-await-in-loop
        const r = await _shell(cmd + ' 2>&1', timeoutMs);
        lastResult = r;
        if (r.exitCode === 0) {
          const lines = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
          const savedPath = lines[lines.length - 1] || null;
          return {
            ok: true,
            savedPath,
            binary,
            ytClients: ytClients || 'default',
            ffmpegPath,
            stdoutTail: lines.slice(-5).join('\n'),
            installLog,
            ffmpegLog,
            potProviderLog
          };
        }
        const sabr = _is403Sabr(r.stdout) || _is403Sabr(r.stderr);
        // First SABR-shaped failure: try a self-update once. yt-dlp's
        // SABR workarounds change weekly; an old install is the most
        // common cause of "all clients 403."
        if (sabr && !attemptedSelfUpdate && isYouTube) {
          attemptedSelfUpdate = true;
          // eslint-disable-next-line no-await-in-loop
          await _ytDlpSelfUpdate(binary);
          // Retry the same client tuple after update — don't advance.
          // eslint-disable-next-line no-await-in-loop
          const r2 = await _shell(cmd + ' 2>&1', timeoutMs);
          lastResult = r2;
          if (r2.exitCode === 0) {
            const lines = (r2.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
            return {
              ok: true,
              savedPath: lines[lines.length - 1] || null,
              binary,
              ytClients: ytClients || 'default',
              ffmpegPath,
              stdoutTail: lines.slice(-5).join('\n'),
              installLog,
              ffmpegLog,
              note: 'Succeeded after auto-update.'
            };
          }
        }
        // Persistent SABR after self-update → real fix is the PO-token
        // provider plugin. Try once to install it (needs Node.js) and
        // retry. Only attempted on the LAST client tuple to avoid
        // installing it three times.
        const isLast = ytClients === clientPlan[clientPlan.length - 1];
        if (sabr && isLast && !attemptedPotProvider && isYouTube) {
          attemptedPotProvider = true;
          // eslint-disable-next-line no-await-in-loop
          const pot = await _installPoTokenProvider();
          potProviderLog = pot.log;
          if (pot.ok) {
            // eslint-disable-next-line no-await-in-loop
            const r3 = await _shell(cmd + ' 2>&1', timeoutMs);
            lastResult = r3;
            if (r3.exitCode === 0) {
              const lines = (r3.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
              return {
                ok: true,
                savedPath: lines[lines.length - 1] || null,
                binary,
                ytClients: ytClients || 'default',
                ffmpegPath,
                stdoutTail: lines.slice(-5).join('\n'),
                installLog,
                ffmpegLog,
                potProviderLog,
                note: `Succeeded after installing PO-token provider (${pot.method}).`
              };
            }
          }
        }
        // not SABR-shaped → no point trying alternate client tuples
        if (!sabr) break;
      }

      // None of the attempts worked.
      const r = lastResult;
      const isSabr = _is403Sabr(r?.stdout) || _is403Sabr(r?.stderr);
      const updateHint = binary === 'python3 -m yt_dlp' || binary === 'python -m yt_dlp'
        ? 'pip3 install --user --upgrade yt-dlp'
        : `${binary} -U`;
      return {
        error: `yt-dlp exited ${r?.exitCode}`,
        stdout: (r?.stdout || '').slice(-2000),
        stderr: (r?.stderr || '').slice(-2000),
        installLog,
        ffmpegLog,
        potProviderLog,
        binary,
        ffmpegPath,
        hint: isSabr && isYouTube
          ? [
              'Hit a YouTube SABR / 403 block. yt-dlp tried multiple player clients with an auto-update, all still 403\'d.',
              attemptedPotProvider
                ? (potProviderLog && potProviderLog.length
                    ? `PO-token provider auto-install attempted but didn\'t resolve the 403 (see potProviderLog). Most common cause: Node.js missing or pipx not on PATH.`
                    : 'PO-token provider auto-install was skipped (no Node.js detected).')
                : null,
              `1. Try the latest yt-dlp release manually:  ${updateHint}`,
              '2. Install Node.js + the PO-token provider plugin (the real fix for SABR-only accounts):',
              '     brew install node    # macOS  (or:  sudo apt install nodejs)',
              '     pipx install bgutil-ytdlp-pot-provider',
              '   yt-dlp picks it up automatically; re-run /dl after that.',
              '3. Last resort, fetch the lowest tier (often skips SABR):',
              '     yt_dlp_run { url, format: "worst" }',
              '4. Or generate the command and paste in a terminal where you have a better-pathed Python:',
              '     yt_dlp_command { url }'
            ].filter(Boolean).join('\n')
          : isYouTube && !ffmpegPath
            ? 'ffmpeg not installed and auto-install failed — yt-dlp can\'t merge separate video+audio streams. Try `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux).'
            : undefined
      };
    }
  });

  T({
    name: 'yt_dlp_command',
    group: 'media',
    description:
      'Generate a yt-dlp command string for the active YouTube tab without running it. ' +
      'Use ONLY when the user wants the command to paste themselves (no shell bridge, or they prefer running it manually). ' +
      'For actually downloading, call `yt_dlp_run` instead — it executes via the shell bridge, auto-installs yt-dlp if missing, and returns the saved file path.',
    parameters: OBJ({
      tabId: NUM,
      audioOnly: BOOL,
      format: STR,
      outputDir: STR,
      useBrowserCookies: BOOL
    }),
    handler: async ({ tabId, audioOnly = false, format, outputDir, useBrowserCookies = true } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || '';
      if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(url)) {
        return { error: `Active tab isn't a YouTube URL: ${url}` };
      }
      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const parts = ['yt-dlp'];
      if (useBrowserCookies) parts.push('--cookies-from-browser', 'chrome');
      if (audioOnly) {
        parts.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else if (format) {
        parts.push('-f', sq(format));
      } else {
        // Modern default: best video + best audio merged into mp4 when possible
        parts.push('-f', sq('bv*+ba/b'), '--merge-output-format', 'mp4');
      }
      const out = outputDir
        ? `${outputDir.replace(/\/+$/, '')}/%(title)s.%(ext)s`
        : '%(title)s.%(ext)s';
      parts.push('-o', sq(out));
      parts.push(sq(url));

      return {
        command: parts.join(' '),
        url,
        hints: [
          'Install: `pipx install yt-dlp` (recommended) or `brew install yt-dlp` / `pip install yt-dlp`.',
          useBrowserCookies ? '`--cookies-from-browser chrome` reuses your logged-in YouTube cookies (helps with age-gates / Premium / members-only). Close Chrome first if it complains about a locked cookie DB.' : null,
          audioOnly ? 'Audio-only requires ffmpeg installed (used to remux to MP3).' : 'Default merge target is mp4; needs ffmpeg installed.',
          'For a playlist URL, yt-dlp downloads every video; add `--playlist-items 1-10` to limit.'
        ].filter(Boolean)
      };
    }
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
        // Not HTML — return raw text snippet
        const txt = await res.text();
        return { status, mime: ct, url: res.url, text: txt.slice(0, maxBytes) };
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const baseEl = doc.querySelector('base');
      const base = baseEl?.href || res.url;
      // Strip non-content elements before extracting text
      const dropSel = 'script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role="navigation"],.ad,.advertisement,.cookie-banner';
      doc.querySelectorAll(dropSel).forEach(n => n.remove());
      // Pick a main-content root using the same heuristic as page_content
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
      const out = {
        status, url: res.url, title: doc.title || '', text
      };
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

  // ──────── EXPORT / GENERATE ────────
  T({
    name: 'network_postman_export',
    group: 'network',
    description: 'Convert the captured network buffer into a Postman v2.1 collection JSON, grouped by host. Pairs with network_capture_start. Importable into Postman, Bruno, Insomnia.',
    parameters: OBJ({ filter: STR, includeSince: NUM, name: STR }),
    handler: async (args = {}) => bg('NET_CAPTURE_POSTMAN', args)
  });

  function inferTSType(value, depth = 0) {
    if (depth > 6) return 'unknown';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      if (!value.length) return 'unknown[]';
      const sample = value.slice(0, 8);
      const types = new Set(sample.map(v => inferTSType(v, depth + 1)));
      return types.size === 1
        ? `${[...types][0]}[]`
        : `(${[...types].join(' | ')})[]`;
    }
    const t = typeof value;
    if (t === 'string') return 'string';
    if (t === 'number') return Number.isInteger(value) ? 'number' : 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'object') return '__object__';
    return 'unknown';
  }
  // Merge object shapes seen across array elements / multiple samples.
  function mergeShape(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      if (!(k in out)) { out[k] = { ...b[k], optional: true }; continue; }
      out[k] = { type: out[k].type === b[k].type ? out[k].type : `${out[k].type} | ${b[k].type}`, optional: out[k].optional && b[k].optional };
    }
    for (const k of Object.keys(out)) {
      if (!(k in b)) out[k].optional = true;
    }
    return out;
  }
  function collectShapes(value, name, shapes, depth = 0) {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const el of value.slice(0, 8)) collectShapes(el, name, shapes, depth + 1);
      return;
    }
    const shape = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      const t = inferTSType(v);
      if (t === '__object__' && v && !Array.isArray(v)) {
        const childName = name + capitalise(k);
        collectShapes(v, childName, shapes, depth + 1);
        shape[k] = { type: childName, optional: false };
      } else if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
        const childName = name + capitalise(k.replace(/s$/, '')) || (name + capitalise(k));
        collectShapes(v, childName, shapes, depth + 1);
        shape[k] = { type: childName + '[]', optional: false };
      } else {
        shape[k] = { type: t, optional: false };
      }
    }
    shapes.set(name, shapes.has(name) ? mergeShape(shapes.get(name), shape) : shape);
  }
  function capitalise(s) { return s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^([a-z])/, (_, c) => c.toUpperCase()) || 'X'; }
  function renderShapes(shapes) {
    const parts = [];
    for (const [name, shape] of shapes) {
      const lines = [`export interface ${name} {`];
      for (const k of Object.keys(shape)) {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const s = shape[k];
        lines.push(`  ${key}${s.optional ? '?' : ''}: ${s.type};`);
      }
      lines.push('}');
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  T({
    name: 'json_to_typescript',
    group: 'devtools',
    description: 'Infer TypeScript interface definitions from a JSON sample (object or array of objects). Returns a string with the generated `export interface` blocks plus a root type name. Handles nested objects, arrays-of-objects, and merges shapes when multiple samples disagree.',
    parameters: OBJ({
      json: {},
      rootName: STR
    }, ['json']),
    handler: async ({ json, rootName = 'Root' } = {}) => {
      let value = json;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
      }
      // Sanitise so the generated TS is always syntactically valid even
      // when the model passes "my api" or "user data" as rootName.
      const safeName = capitalise(rootName) || 'Root';
      const shapes = new Map();
      if (Array.isArray(value)) {
        collectShapes(value, safeName, shapes);
        const root = `export type ${safeName}List = ${safeName}[];`;
        return { types: [renderShapes(shapes), root].filter(Boolean).join('\n\n'), root: `${safeName}List` };
      }
      if (value && typeof value === 'object') {
        collectShapes(value, safeName, shapes);
        return { types: renderShapes(shapes), root: safeName };
      }
      return { types: `export type ${safeName} = ${inferTSType(value)};`, root: safeName };
    }
  });

  // ──────── PACKAGE & SEARCH LOOKUPS ────────
  async function getJson(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r.json();
  }

  T({
    name: 'npm_info',
    group: 'devtools',
    description: 'Look up an npm package: latest version, description, license, repository, homepage, tarball URL, recent versions. Hits registry.npmjs.org (no auth).',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name }) => {
      const d = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      const latest = d['dist-tags']?.latest;
      const v = d.versions?.[latest] || {};
      return {
        name: d.name, latest, description: d.description,
        license: v.license, homepage: v.homepage || d.homepage,
        repository: v.repository?.url || d.repository?.url,
        time: d.time?.[latest],
        recentVersions: Object.keys(d.versions || {}).slice(-15),
        tarball: v.dist?.tarball,
        dependencies: v.dependencies,
        peerDependencies: v.peerDependencies
      };
    }
  });

  T({
    name: 'pypi_info',
    group: 'devtools',
    description: 'Look up a PyPI package: latest version, summary, home/project URLs, license, releases. Hits pypi.org JSON API (no auth).',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name }) => {
      const d = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      const info = d.info || {};
      return {
        name: info.name, version: info.version,
        summary: info.summary, author: info.author,
        license: info.license,
        home_page: info.home_page,
        project_urls: info.project_urls,
        requires_python: info.requires_python,
        recentReleases: Object.keys(d.releases || {}).slice(-15)
      };
    }
  });

  T({
    name: 'stackoverflow_search',
    group: 'devtools',
    description: 'Search Stack Overflow titles. Returns top matching questions with title, score, answer count, link. Uses the Stack Exchange API (no auth, rate-limited).',
    parameters: OBJ({ query: STR, tagged: STR, limit: NUM }, ['query']),
    handler: async ({ query, tagged, limit = 10 }) => {
      const params = new URLSearchParams({
        order: 'desc', sort: 'relevance',
        intitle: query, site: 'stackoverflow', pagesize: String(Math.min(limit, 30))
      });
      if (tagged) params.set('tagged', tagged);
      const d = await getJson(`https://api.stackexchange.com/2.3/search?${params.toString()}`);
      return {
        total: d.total ?? d.items?.length ?? 0,
        items: (d.items || []).map(it => ({
          title: it.title, score: it.score, answers: it.answer_count, accepted: it.is_answered,
          link: it.link, tags: it.tags, asked: it.creation_date
        }))
      };
    }
  });

  // ──────── MINIMAX TOKEN-PLAN APIS ────────
  // Native implementation of the two tools MiniMax's stdio MCP server
  // exposes (`web_search` and `understand_image`), since browser
  // extensions can't talk to local stdio MCP servers. Re-uses the
  // MiniMax API key already in Settings (apiKeys.minimax) — works
  // even when MiniMax isn't the active chat provider.
  const MINIMAX_API_BASE = 'https://api.minimax.io';

  async function minimaxKey() {
    const got = await chrome.storage.local.get('apiKeys');
    const k = got.apiKeys?.minimax;
    if (!k) throw new Error('No MiniMax API key in Settings. Add one (Provider = MiniMax) — required for token-plan tools.');
    return k;
  }
  async function minimaxFetch(path, body) {
    const apiKey = await minimaxKey();
    const res = await fetch(MINIMAX_API_BASE + path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'MM-API-Source': 'Kyoto-Extension'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`MiniMax non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown error'}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message || text.slice(0, 200)}`);
    return data;
  }

  // MiniMax VLM expects a `data:image/...;base64,...` data URL.
  // The stdio MCP server downloads HTTP(S) images server-side then
  // base64-encodes; we have to do the same client-side.
  async function toDataUrl(input) {
    if (!input) throw new Error('image_url required');
    if (input.startsWith('data:')) return input;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const r = await fetch(input);
      if (!r.ok) throw new Error(`Failed to fetch image: HTTP ${r.status}`);
      const blob = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onloadend = () => res(fr.result);
        fr.onerror = () => rej(new Error('FileReader failed'));
        fr.readAsDataURL(blob);
      });
    }
    throw new Error('image_url must start with http://, https://, or data:');
  }

  T({
    name: 'minimax_web_search',
    group: 'minimax',
    description: 'Web search via MiniMax token-plan (Google-grade results). Returns organic results { title, link, snippet, date } and related search suggestions. Requires a MiniMax API key in Settings — works even if MiniMax is not the active chat provider. Best with 3–5 keyword queries; include the year for time-sensitive topics.',
    parameters: OBJ({ query: STR }, ['query']),
    handler: async ({ query }) => {
      if (!query || !query.trim()) throw new Error('query required');
      const data = await minimaxFetch('/v1/coding_plan/search', { q: query });
      return {
        organic: data.organic || [],
        related_searches: data.related_searches || []
      };
    }
  });

  T({
    name: 'minimax_understand_image',
    group: 'minimax',
    description: 'Vision/VLM analysis via MiniMax token-plan. Pass a `prompt` describing what to extract and an `image_url` (http(s) URL or data URL). Supports JPEG/PNG/WebP. Returns a text description. For analyzing the current tab, prefer `minimax_describe_tab` which avoids round-tripping a large base64 string through the conversation.',
    parameters: OBJ({ prompt: STR, image_url: STR }, ['prompt', 'image_url']),
    handler: async ({ prompt, image_url }) => {
      if (!prompt) throw new Error('prompt required');
      const dataUrl = await toDataUrl(image_url);
      const data = await minimaxFetch('/v1/coding_plan/vlm', { prompt, image_url: dataUrl });
      return { content: data.content || '' };
    }
  });

  T({
    name: 'minimax_describe_tab',
    group: 'minimax',
    description: 'Capture a screenshot of the active tab and analyze it via MiniMax VLM in one tool call. Use for "what is on this page", OCR, layout analysis, accessibility checks. Returns only the model\'s text — the screenshot data URL never enters the conversation, so this is the cheap way to do tab-level vision.',
    parameters: OBJ({
      prompt: STR,
      format: { type: 'string', enum: ['jpeg', 'png'] },
      quality: NUM
    }, ['prompt']),
    handler: async ({ prompt, format = 'jpeg', quality = 80 }) => {
      if (!prompt) throw new Error('prompt required');
      const dataUrl = await chrome.tabs.captureVisibleTab({ format, quality });
      const data = await minimaxFetch('/v1/coding_plan/vlm', { prompt, image_url: dataUrl });
      return { content: data.content || '', screenshotBytes: dataUrl.length };
    }
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
