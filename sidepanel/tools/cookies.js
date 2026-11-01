// Cookies: list/get/set/remove/export, snapshot/diff, and curl helpers.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, activeTab } = window.KyotoTR;

  // Resolve which tab to derive a URL/domain from. A conversation is bound to
  // one tab and the side panel injects that `tabId`; using `activeTab()`
  // instead meant that switching tabs mid-turn silently pointed cookie reads at
  // a page the model never chose.
  async function tabFor(tabId) {
    if (tabId != null) {
      try { return await chrome.tabs.get(tabId); } catch { /* tab closed */ }
    }
    return activeTab();
  }

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
    parameters: OBJ({ url: STR, domain: STR, tabId: NUM }),
    handler: async ({ url, domain, tabId } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) {
        const t = await tabFor(tabId);
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
      url: STR, domain: STR, tabId: NUM,
      format: { type: 'string', enum: ['netscape', 'json', 'header', 'curl-b'] },
      includeHttpOnly: BOOL
    }),
    handler: async ({ url, domain, tabId, format = 'netscape', includeHttpOnly = true } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) { query.url = (await tabFor(tabId)).url; }
      const cookies = await chrome.cookies.getAll(query);
      const filtered = includeHttpOnly ? cookies : cookies.filter(c => !c.httpOnly);
      if (format === 'json') return filtered;
      if (format === 'header') return { cookieHeader: filtered.map(c => `${c.name}=${c.value}`).join('; '), count: filtered.length };
      if (format === 'curl-b') return { curl: filtered.map(c => `-b '${c.name}=${c.value}'`).join(' '), count: filtered.length };
      // Netscape cookies.txt — see original tools.js for the leading-dot invariant.
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
    parameters: OBJ({ url: STR, domain: STR, tabId: NUM }),
    handler: async ({ url, domain, tabId } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) query.url = (await tabFor(tabId)).url;
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

  // ──────── COOKIE SNAPSHOT + DIFF ────────
  const COOKIE_SNAP_KEY = 'kyoto_cookie_snapshot';

  T({
    name: 'cookies_snapshot',
    group: 'cookies',
    description: 'Save the current cookie state for a URL or domain as a snapshot. Use before performing an action (login, logout, accept-cookies banner) so cookies_diff can show what changed.',
    parameters: OBJ({ url: STR, domain: STR, label: STR, tabId: NUM }),
    handler: async ({ url, domain, label = 'default', tabId } = {}) => {
      const query = url ? { url } : domain ? { domain } : {};
      if (!url && !domain) { const t = await tabFor(tabId); query.url = t.url; }
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

  // ──────── CURL ⇄ FETCH ────────
  function parseCurlString(input) {
    const cleaned = input.replace(/\\\n/g, ' ').trim();
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
      else if (t === '-b' || t === '--cookie') { out.headers['Cookie'] = tokens[++i]; }
      else if (t === '-u' || t === '--user') { out.headers['Authorization'] = 'Basic ' + btoa(tokens[++i]); }
      else if (t === '-A' || t === '--user-agent') { out.headers['User-Agent'] = tokens[++i]; }
      else if (t === '-e' || t === '--referer') { out.headers['Referer'] = tokens[++i]; }
      else if (t.startsWith('--')) {
        if (tokens[i + 1] && !/^https?:/.test(tokens[i + 1]) && !tokens[i + 1].startsWith('-')) i++;
      }
      else if (t.startsWith('-')) {
        if (tokens[i + 1] && !/^https?:/.test(tokens[i + 1]) && !tokens[i + 1].startsWith('-')) i++;
      }
      else if (!out.url) { out.url = t; }
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
})();
