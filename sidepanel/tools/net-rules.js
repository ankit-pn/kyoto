// Network interception tools — chrome.declarativeNetRequest DYNAMIC rules.
//
// WHY THIS IS A SUPERPOWER
//   One rule can make an API fail, block a tracker/analytics host, force a CDN
//   "offline", or point a frontend at a localhost mock — no proxy, no code
//   change, and it applies to the real page the developer is debugging.
//
// WHY THIS IS DANGEROUS
//   These are *dynamic* rules. Chrome persists them (they are not this page's
//   memory): they keep rewriting traffic after the side panel closes, after the
//   tab closes, and after the browser restarts — until something removes them.
//   They are also BROWSER-WIDE: every tab and every site, not just the tab this
//   conversation is bound to. A too-broad filter can black-hole the user's
//   whole web while the side panel keeps working, which makes the breakage easy
//   to miss. Mitigations, all in this file:
//     - a filter that matches essentially everything (`*`, `|`, `^`, empty) is
//       rejected unless the caller passes `confirmBroad: true`;
//     - every rule gets a note and is listed by net_rules_list;
//     - net_rule_clear removes EVERY dynamic rule and restores normal
//       networking — the escape hatch to tell the user about.
//
// HARD LIMITS OF THE API (not bugs here)
//   declarativeNetRequest can block, redirect, rewrite headers and upgrade the
//   scheme. It CANNOT change an HTTP status code or the body of an arbitrary
//   response: MV3 extensions never see response bodies at this layer. That is
//   why there is no `net_rule_mock_status` — see net_rule_stub for what is
//   actually possible, and for why a localhost mock is the dependable route.
//
// Group 'intercept'. Load after core.js, before finalize.js.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, truncate } = window.KyotoTR;

  // ──────── CONSTANTS ────────
  // Must mirror chrome.declarativeNetRequest.ResourceType. An unknown type makes
  // updateDynamicRules reject the whole rule.
  const RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'webtransport', 'webbundle', 'other'
  ];
  const RESOURCE_TYPE_SET = new Set(RESOURCE_TYPES);
  const DEFAULT_RESOURCE_TYPES = ['xmlhttprequest', 'script', 'image', 'stylesheet', 'main_frame', 'sub_frame'];
  // A data: target cannot satisfy a frame request (Chrome refuses frame
  // redirects to data:), so the stub defaults to subresources only.
  const STUB_RESOURCE_TYPES = ['xmlhttprequest', 'script', 'image', 'stylesheet'];

  // A DNR rule has no description/note field, so notes live in
  // chrome.storage.local keyed by rule id and are merged back in by
  // net_rules_list. Purely cosmetic: losing a note never affects a rule.
  const NOTES_KEY = 'kyoto.netRules.notes.v1';
  const MAX_FILTER_CHARS = 2048;
  const MAX_REDIRECT_CHARS = 32768; // data: stubs inline their whole body
  const MAX_NOTE_CHARS = 200;
  const MAX_RULES_RETURNED = 500;
  const MAX_RULE_ID = 2147483647;

  // ──────── API ACCESS ────────
  // Resolved lazily inside handlers, never at load time: other harnesses load
  // this file without any chrome.* present.
  function dnr() {
    const api = (typeof chrome !== 'undefined' && chrome) ? chrome.declarativeNetRequest : null;
    if (!api || typeof api.getDynamicRules !== 'function') {
      throw new Error('chrome.declarativeNetRequest is unavailable — the manifest needs the "declarativeNetRequest" and "declarativeNetRequestWithHostAccess" permissions (plus <all_urls> host access, which redirect/modifyHeaders require for third-party sites)');
    }
    return api;
  }

  async function getRules() {
    const rules = await dnr().getDynamicRules();
    return Array.isArray(rules) ? rules : [];
  }

  // getAvailableDynamicRuleCount() is missing on older Chrome; absence must not
  // turn a working tool into an error.
  async function availableRuleSlots() {
    const api = dnr();
    if (typeof api.getAvailableDynamicRuleCount !== 'function') return null;
    try {
      const remaining = await api.getAvailableDynamicRuleCount();
      return typeof remaining === 'number' ? remaining : null;
    } catch {
      return null;
    }
  }

  async function assertRuleSlots() {
    const slots = await availableRuleSlots();
    if (slots === 0) {
      throw new Error('the dynamic-rule quota is exhausted — free slots with net_rule_remove { id } or reset everything with net_rule_clear, then retry');
    }
    return slots;
  }

  // Rule ids are allocated by reading the current max id, which races when a
  // provider emits parallel tool calls. Chain mutations through one promise so
  // the read-modify-write is atomic within this page (the DNR store itself
  // stays the source of truth across contexts).
  let mutationChain = Promise.resolve();
  function withRuleLock(fn) {
    const next = mutationChain.then(() => fn(), () => fn());
    mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }

  // ──────── NOTE STORE ────────
  function notesArea() {
    try {
      if (typeof chrome === 'undefined' || !chrome || !chrome.storage) return null;
      return chrome.storage.local || null;
    } catch {
      return null;
    }
  }

  async function readNotes() {
    const area = notesArea();
    if (!area || typeof area.get !== 'function') return {};
    try {
      const bag = await area.get(NOTES_KEY);
      const notes = bag ? bag[NOTES_KEY] : null;
      if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {};
      return notes;
    } catch {
      return {};
    }
  }

  async function writeNotes(notes) {
    const area = notesArea();
    if (!area || typeof area.set !== 'function') return false;
    try {
      await area.set({ [NOTES_KEY]: notes || {} });
      return true;
    } catch {
      return false;
    }
  }

  async function saveNote(id, meta) {
    const notes = await readNotes();
    notes[id] = meta;
    return writeNotes(notes);
  }

  // ──────── VALIDATION ────────
  function shortText(value, max) {
    const s = String(value);
    if (s.length <= max) return s;
    return s.slice(0, max) + `… [${s.length - max} more chars]`;
  }

  // Host a urlFilter is scoped to, when it names one. `||api.example.com/x` and
  // `|https://api.example.com/x` both yield "api.example.com". Patterns that name
  // no concrete host (wildcards, ^-anchored regex-ish filters) yield null.
  function hostFromFilter(filter) {
    if (typeof filter !== 'string') return null;
    const m = filter.match(/^\|{0,2}(?:https?:\/\/)?\.?([^/^|*?]+)/i);
    if (!m) return null;
    const host = String(m[1] || '').trim().toLowerCase().replace(/^\./, '');
    return host.includes('.') && !host.includes('*') ? host : null;
  }

  function validFilter(raw) {
    if (typeof raw !== 'string') throw new Error('urlFilter is required and must be a string');
    const filter = raw.trim();
    if (!filter) throw new Error('urlFilter must be a non-empty string — an empty filter matches every request; a host or path fragment such as "||api.example.com/v1/" is what you usually want');
    if (filter.length > MAX_FILTER_CHARS) throw new Error(`urlFilter is too long (${filter.length} chars, max ${MAX_FILTER_CHARS})`);
    if (/[\u0000-\u001f\u007f]/.test(filter)) throw new Error('urlFilter must not contain control characters or newlines');
    return filter;
  }

  // A filter built only from DNR wildcard/anchor syntax matches essentially
  // every URL in every tab.
  function isBroadFilter(filter) {
    return filter.replace(/[*|^]/g, '').trim() === '';
  }

  function assertFilterIsScoped(toolName, filter, confirmBroad) {
    if (!isBroadFilter(filter) || confirmBroad === true) return;
    throw new Error(`${toolName}: urlFilter ${JSON.stringify(filter)} matches essentially EVERY request in the browser — all sites, all tabs — not just the page you are debugging. If that is genuinely intended, call again with confirmBroad: true. Prefer a scoped filter such as "||api.example.com/v1/" or "/api/users". Undo later with net_rule_remove or net_rule_clear.`);
  }

  function validResourceTypes(raw, defaults = DEFAULT_RESOURCE_TYPES) {
    if (raw == null) return defaults.slice();
    if (!Array.isArray(raw)) throw new Error('resourceTypes must be an array of resource types');
    if (!raw.length) throw new Error(`resourceTypes must not be empty — omit it to use the default (${DEFAULT_RESOURCE_TYPES.join(', ')})`);
    const out = [];
    for (const item of raw) {
      if (typeof item !== 'string') throw new Error('resourceTypes must contain only strings');
      const type = item.trim().toLowerCase();
      if (!RESOURCE_TYPE_SET.has(type)) {
        throw new Error(`unknown resourceType ${JSON.stringify(item)} — allowed: ${RESOURCE_TYPES.join(', ')}`);
      }
      if (!out.includes(type)) out.push(type);
    }
    return out;
  }

  function validPriority(raw) {
    if (raw == null) return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 1000000) throw new Error('priority must be an integer between 1 and 1000000 (default 1; higher wins when several rules match)');
    return n;
  }

  function validNote(raw) {
    if (raw == null) return undefined;
    if (typeof raw !== 'string') throw new Error('note must be a string');
    const note = raw.trim();
    if (!note) return undefined;
    return note.slice(0, MAX_NOTE_CHARS);
  }

  function validRuleId(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RULE_ID) throw new Error('id must be a positive integer — get the ids from net_rules_list');
    return n;
  }

  // Redirect targets: http(s) (e.g. a localhost mock) or a data: URL. Anything
  // else (javascript:, file:, chrome-extension:) is rejected before Chrome has
  // to.
  function validRedirectUrl(raw) {
    if (typeof raw !== 'string') throw new Error('redirectUrl is required and must be a string');
    const target = raw.trim();
    if (!target) throw new Error('redirectUrl must be a non-empty string');
    if (target.length > MAX_REDIRECT_CHARS) throw new Error(`redirectUrl is too long (${target.length} chars, max ${MAX_REDIRECT_CHARS}) — inline data: URLs that large are fragile; serve the stub from a localhost mock instead`);
    if (/[\u0000-\u001f\u007f]/.test(target)) throw new Error('redirectUrl must not contain control characters or newlines');
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error(`redirectUrl is not a valid absolute URL: ${shortText(target, 120)} — it must start with http://, https:// or data:`);
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (!parsed.hostname) throw new Error('redirectUrl is missing a hostname');
      return { url: target, protocol: parsed.protocol };
    }
    if (parsed.protocol === 'data:') {
      if (!target.includes(',')) throw new Error('data: redirect URL needs a comma and a body, e.g. "data:application/json,%7B%7D"');
      return { url: target, protocol: parsed.protocol };
    }
    throw new Error(`redirectUrl scheme ${JSON.stringify(parsed.protocol)} is not allowed — declarativeNetRequest redirects accept only http:, https: and data:`);
  }

  function validContentType(raw) {
    if (raw == null) return 'application/json';
    if (typeof raw !== 'string') throw new Error('contentType must be a string such as "application/json"');
    const ct = raw.trim();
    if (!ct) return 'application/json';
    if (ct.length > 120) throw new Error('contentType is too long (max 120 chars)');
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*charset=[a-z0-9_-]+)?$/i.test(ct)) {
      throw new Error(`contentType ${JSON.stringify(ct)} does not look like a MIME type (expected e.g. "application/json" or "text/plain;charset=utf-8")`);
    }
    return ct;
  }

  function nextRuleId(rules) {
    let max = 0;
    for (const rule of rules) {
      const id = Number(rule && rule.id);
      if (Number.isInteger(id) && id > max) max = id;
    }
    const next = max + 1;
    if (next > MAX_RULE_ID) throw new Error('no free dynamic rule id left — run net_rule_clear to reset the id space');
    return next;
  }

  // ──────── RULE VIEWS (compact / LLM-readable) ────────
  function headerOps(list) {
    if (!Array.isArray(list)) return undefined;
    const out = [];
    for (const h of list) {
      if (!h || typeof h !== 'object') continue;
      out.push({
        header: h.header,
        operation: h.operation,
        value: h.value == null ? undefined : shortText(h.value, 120)
      });
    }
    return out.length ? out : undefined;
  }

  function actionView(action) {
    const a = action || {};
    const view = { type: a.type || 'unknown' };
    const redirect = a.redirect;
    if (redirect && typeof redirect === 'object') {
      if (redirect.url != null) view.redirectUrl = shortText(redirect.url, 300);
      if (redirect.extensionPath != null) view.extensionPath = shortText(redirect.extensionPath, 300);
      if (redirect.regexSubstitution != null) view.regexSubstitution = shortText(redirect.regexSubstitution, 300);
      if (redirect.transform != null) view.transform = truncate(redirect.transform, 2000);
    }
    const reqHeaders = headerOps(a.requestHeaders);
    const resHeaders = headerOps(a.responseHeaders);
    if (reqHeaders) view.requestHeaderOps = reqHeaders;
    if (resHeaders) view.responseHeaderOps = resHeaders;
    return view;
  }

  function conditionView(condition) {
    const c = condition || {};
    const view = {};
    if (c.urlFilter != null) view.urlFilter = shortText(c.urlFilter, 400);
    if (c.regexFilter != null) view.regexFilter = shortText(c.regexFilter, 400);
    if (c.isUrlFilterCaseSensitive) view.isUrlFilterCaseSensitive = true;
    if (Array.isArray(c.resourceTypes)) view.resourceTypes = c.resourceTypes.slice(0, RESOURCE_TYPES.length);
    if (Array.isArray(c.excludedResourceTypes)) view.excludedResourceTypes = c.excludedResourceTypes.slice(0, RESOURCE_TYPES.length);
    if (Array.isArray(c.requestDomains)) view.requestDomains = c.requestDomains.slice(0, 100);
    if (Array.isArray(c.excludedRequestDomains)) view.excludedRequestDomains = c.excludedRequestDomains.slice(0, 100);
    if (Array.isArray(c.initiatorDomains)) view.initiatorDomains = c.initiatorDomains.slice(0, 100);
    if (Array.isArray(c.excludedInitiatorDomains)) view.excludedInitiatorDomains = c.excludedInitiatorDomains.slice(0, 100);
    if (Array.isArray(c.requestMethods)) view.requestMethods = c.requestMethods.slice(0, 20);
    return view;
  }

  function ruleView(rule, notes) {
    const r = rule || {};
    const view = {
      id: r.id,
      priority: r.priority == null ? 1 : r.priority,
      action: actionView(r.action),
      condition: conditionView(r.condition)
    };
    const meta = notes ? (notes[r.id] || notes[String(r.id)]) : null;
    if (meta && typeof meta === 'object') {
      if (meta.note) view.note = shortText(meta.note, MAX_NOTE_CHARS);
      if (meta.kind) view.createdBy = meta.kind;
      if (meta.createdAt) view.createdAt = meta.createdAt;
    }
    return view;
  }

  // Add one rule, then read it back: the returned view should describe what
  // Chrome stored, not merely what was submitted.
  async function addRule(rule, meta) {
    const api = dnr();
    await api.updateDynamicRules({ addRules: [rule] });
    const stored = (await getRules()).find(r => r && r.id === rule.id) || null;
    await saveNote(rule.id, meta);
    if (!stored) {
      throw new Error('Chrome accepted the updateDynamicRules call but the new rule is not in getDynamicRules() — it may have been dropped by the dynamic-rule quota; call net_rules_list to check, then net_rule_clear and retry');
    }
    return stored;
  }

  function today() {
    try {
      return new Date().toISOString();
    } catch {
      return undefined;
    }
  }

  // ──────── LIST ────────
  T({
    name: 'net_rules_list',
    group: 'intercept',
    description: 'List every active dynamic network-intercept rule (declarativeNetRequest). Each entry shows id, priority, action (block, redirect + target, header ops) and condition (urlFilter/regexFilter, resourceTypes, requestDomains), plus the note saved when it was created. These rules are browser-wide and survive browser restarts until removed — this is the first thing to check when a page behaves oddly. Also reports the remaining dynamic-rule quota.',
    parameters: OBJ({ limit: NUM }),
    handler: async (args = {}) => {
      try {
        const rules = await getRules();
        const notes = await readNotes();

        // Prune notes for rules that no longer exist (removed elsewhere, or
        // dynamic rules cleared by a browser/extension update).
        const liveIds = new Set(rules.map(r => Number(r && r.id)));
        const staleKeys = Object.keys(notes).filter(k => !liveIds.has(Number(k)));
        if (staleKeys.length) {
          for (const k of staleKeys) delete notes[k];
          await writeNotes(notes);
        }

        const requested = Number(args.limit);
        const limit = Number.isFinite(requested)
          ? Math.max(1, Math.min(MAX_RULES_RETURNED, Math.floor(requested)))
          : MAX_RULES_RETURNED;

        const sorted = rules.slice().sort((a, b) => Number(a && a.id) - Number(b && b.id));
        const shown = sorted.slice(0, limit).map(r => ruleView(r, notes));
        const count = rules.length;
        const out = {
          count,
          returned: shown.length,
          rules: shown
        };
        if (shown.length < count) out.truncated = true;

        const slots = await availableRuleSlots();
        if (slots != null) out.remainingRuleQuota = slots;

        if (!count) {
          out.hint = 'No intercept rules installed — normal networking. Create one with net_rule_block, net_rule_redirect or net_rule_stub.';
        } else {
          out.hint = 'These rules apply to every tab and site. Remove one with net_rule_remove { id }; remove all and restore normal networking with net_rule_clear.';
        }
        return truncate(out, 32768);
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── BLOCK ────────
  T({
    name: 'net_rule_block',
    group: 'intercept',
    description: 'Block network requests matching a urlFilter (declarativeNetRequest action "block"). Use it to simulate an offline API/CDN, kill analytics or tracker calls, or test how a page degrades when a request fails: a blocked request fails like an offline one (net::ERR_BLOCKED_BY_CLIENT), which is the dependable way to fake an outage. Filter is DNR syntax: "||api.example.com/v1/" (domain anchored, any scheme + subdomains), "/api/users" (URL substring), "example.com/track*pixel" (wildcards), "|https://cdn.example.com/" (prefix anchored). Applied BROWSER-WIDE and persists across restarts until removed. A filter that matches everything (e.g. "*") is refused unless confirmBroad: true is passed.',
    parameters: OBJ({
      urlFilter: STR,
      resourceTypes: { type: 'array', items: STR },
      note: STR,
      priority: NUM,
      confirmBroad: BOOL
    }, ['urlFilter']),
    handler: async (args = {}) => {
      try {
        const { urlFilter, resourceTypes, note, priority, confirmBroad } = args;
        const filter = validFilter(urlFilter);
        assertFilterIsScoped('net_rule_block', filter, confirmBroad);
        const types = validResourceTypes(resourceTypes);
        const prio = validPriority(priority);
        const noteText = validNote(note);
        return await withRuleLock(async () => {
          await assertRuleSlots();
          const rules = await getRules();
          const id = nextRuleId(rules);
          const rule = {
            id,
            priority: prio,
            action: { type: 'block' },
            condition: { urlFilter: filter, resourceTypes: types }
          };
          const meta = { kind: 'block', note: noteText, createdAt: today() };
          const stored = await addRule(rule, meta);
          return {
            added: true,
            rule: ruleView(stored, { [id]: meta }),
            hint: 'Live now for matching requests in every tab. Already-loaded resources keep their cached copies — reload the page to see the block. Undo with net_rule_remove { id }, or net_rule_clear to restore normal networking.'
          };
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── REDIRECT ────────
  T({
    name: 'net_rule_redirect',
    group: 'intercept',
    description: 'Redirect requests matching a urlFilter to another URL (declarativeNetRequest action "redirect"). Main use: point a frontend API at a localhost mock — e.g. urlFilter "||api.example.com/" redirectUrl "http://localhost:3000/" — so the page talks to a server you control, including its real status codes. Target must be an absolute http(s) or data: URL; resourceTypes defaults to xmlhttprequest, script, image, stylesheet, main_frame and sub_frame. Applied BROWSER-WIDE and persists across restarts until removed; a filter that matches everything requires confirmBroad: true, and a redirect to a DIFFERENT host than the filter requires confirmCrossOrigin: true (cross-origin redirects can forward the original request headers).',
    parameters: OBJ({
      urlFilter: STR,
      redirectUrl: STR,
      resourceTypes: { type: 'array', items: STR },
      note: STR,
      priority: NUM,
      confirmBroad: BOOL,
      confirmCrossOrigin: BOOL
    }, ['urlFilter', 'redirectUrl']),
    handler: async (args = {}) => {
      try {
        const { urlFilter, redirectUrl, resourceTypes, note, priority, confirmBroad } = args;
        const filter = validFilter(urlFilter);
        assertFilterIsScoped('net_rule_redirect', filter, confirmBroad);
        const target = validRedirectUrl(redirectUrl);
        // AUDIT H2: a cross-origin redirect can forward the original request's
        // headers (Authorization, Cookie, CSRF tokens) to a host the user never
        // meant to talk to, and the rule is BROWSER-WIDE and PERSISTS. Requiring
        // an explicit flag makes an exfiltration vector a deliberate choice
        // rather than a one-word tool call.
        const filterHost = hostFromFilter(filter);
        const targetHost = target.protocol === 'data:' ? null : new URL(target.url).hostname.toLowerCase();
        if (filterHost && targetHost && filterHost !== targetHost) {
          if (args.confirmCrossOrigin !== true) {
            return {
              error: `cross-origin redirect refused: filter is scoped to "${filterHost}" but the target is "${targetHost}". ` +
                `A cross-origin redirect can forward the original request's headers (Authorization/Cookies) to that host. ` +
                `Pass confirmCrossOrigin: true if that is genuinely intended.`
            };
          }
        }
        const types = validResourceTypes(resourceTypes);
        const prio = validPriority(priority);
        const noteText = validNote(note);
        const warnings = [];
        if (target.protocol === 'data:') {
          warnings.push('data: redirects are accepted by the rules engine but Chrome treats redirects to non-http(s) schemes as unsafe in many request contexts (fetch/XHR often fail with net::ERR_UNSAFE_REDIRECT or a CORS error) — the rule will be installed, but the page may report a network error rather than your body. Prefer an http://localhost mock when the response must actually arrive.');
          if (types.includes('main_frame')) {
            warnings.push('main_frame is in resourceTypes: Chrome refuses to navigate a tab to a data: URL, so drop main_frame (or redirect to http(s)) if this rule should affect navigations.');
          }
        }
        return await withRuleLock(async () => {
          await assertRuleSlots();
          const rules = await getRules();
          const id = nextRuleId(rules);
          const rule = {
            id,
            priority: prio,
            action: { type: 'redirect', redirect: { url: target.url } },
            condition: { urlFilter: filter, resourceTypes: types }
          };
          const meta = { kind: 'redirect', note: noteText, createdAt: today() };
          const stored = await addRule(rule, meta);
          const out = {
            added: true,
            rule: ruleView(stored, { [id]: meta }),
            hint: 'Live now for matching requests in every tab; reload the page to re-issue requests through the rule. Undo with net_rule_remove { id }, or net_rule_clear to restore normal networking.'
          };
          if (warnings.length) out.warnings = warnings;
          return out;
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── STUB (body replacement — deliberately NOT "set status") ────────
  // DeclarativeNetRequest has no action that changes an HTTP status code, and
  // MV3 cannot rewrite an arbitrary response body either. The only lever is a
  // redirect to a data: URL whose body is the stub. That keeps a useful tool
  // (replace a script/JSON/image response with canned content) without
  // pretending a 404/500 can be produced — hence the name `net_rule_stub` and
  // the long list of caveats in the description. Honestly simulating an API
  // failure means a localhost mock + net_rule_redirect, where the status code is
  // real.
  T({
    name: 'net_rule_stub',
    group: 'intercept',
    description: 'Replace the BODY of responses matching a urlFilter with a fixed stub, by redirecting them to a data: URL (JSON by default). HONEST LIMITS: declarativeNetRequest cannot set an HTTP status code, so this can NOT fake a 404/500 — the response is served from a data: URL, not with a status you choose. Chrome also treats redirects to non-http(s) schemes as unsafe in many request contexts (fetch/XHR commonly fail with net::ERR_UNSAFE_REDIRECT or CORS), so a page may show a network error instead of the stub. Reliable alternatives: net_rule_block for a hard network failure, or run a local mock server and use net_rule_redirect when you need a real status code or a body that must actually arrive. resourceTypes defaults to xmlhttprequest, script, image and stylesheet (frame requests cannot be satisfied by a data: target). Applied BROWSER-WIDE and persists across restarts until removed; a filter that matches everything requires confirmBroad: true.',
    parameters: OBJ({
      urlFilter: STR,
      body: {},
      contentType: STR,
      resourceTypes: { type: 'array', items: STR },
      note: STR,
      priority: NUM,
      confirmBroad: BOOL
    }, ['urlFilter']),
    handler: async (args = {}) => {
      try {
        const { urlFilter, body, contentType, resourceTypes, note, priority, confirmBroad } = args;
        const filter = validFilter(urlFilter);
        assertFilterIsScoped('net_rule_stub', filter, confirmBroad);
        const types = validResourceTypes(resourceTypes, STUB_RESOURCE_TYPES);
        const prio = validPriority(priority);
        const noteText = validNote(note);
        const ct = validContentType(contentType);
        const warnings = [];

        // A stray statusCode (a caller expecting the old "mock status" shape)
        // must not be silently ignored — say plainly that it cannot apply.
        if (args.statusCode != null) {
          warnings.push(`statusCode ${JSON.stringify(args.statusCode)} is NOT applied and there is no status parameter: declarativeNetRequest has no action that changes a response status code. The stub is served from a data: URL, so it is a 200 when the redirect is honoured, whatever status you asked for.`);
        }

        let text;
        if (body == null) {
          text = JSON.stringify({ stubbed: true, by: 'kyoto', note: 'response body replaced by net_rule_stub' });
        } else if (typeof body === 'string') {
          text = body;
        } else if (typeof body === 'number' || typeof body === 'boolean') {
          text = String(body);
        } else {
          try {
            text = JSON.stringify(body);
          } catch {
            throw new Error('body must be JSON-serializable (object, array, string, number, boolean or null)');
          }
          if (typeof text !== 'string') throw new Error('body must be JSON-serializable');
        }

        const head = /charset=/i.test(ct) ? `data:${ct},` : `data:${ct};charset=utf-8,`;
        const dataUrl = head + encodeURIComponent(text);
        if (dataUrl.length > MAX_REDIRECT_CHARS) {
          throw new Error(`the stub body is too large once encoded (${dataUrl.length} chars, max ${MAX_REDIRECT_CHARS}) — serve it from a localhost mock and use net_rule_redirect instead`);
        }

        if (types.includes('main_frame') || types.includes('sub_frame')) {
          warnings.push('main_frame/sub_frame cannot be stubbed with a data: target: Chrome refuses frame redirects to data: URLs, so matching navigations will fail to load. Remove the frame types if this stub is for API/asset responses.');
        }
        warnings.push('The stub carries no status code and no CORS headers: only request types that tolerate a data: URL will actually receive it, and existing cached responses are unaffected until the page is reloaded. For a reliable API stub or failure, serve it from a localhost mock and use net_rule_redirect.');

        return await withRuleLock(async () => {
          await assertRuleSlots();
          const rules = await getRules();
          const id = nextRuleId(rules);
          const rule = {
            id,
            priority: prio,
            action: { type: 'redirect', redirect: { url: dataUrl } },
            condition: { urlFilter: filter, resourceTypes: types }
          };
          const meta = { kind: 'stub', note: noteText, createdAt: today() };
          const stored = await addRule(rule, meta);
          return {
            added: true,
            rule: ruleView(stored, { [id]: meta }),
            stub: {
              contentType: ct,
              bodyPreview: truncate(text, 2000),
              bodyChars: text.length
            },
            statusNote: 'HTTP status is NOT controllable: declarativeNetRequest has no status-code action, so the stub cannot be a 404/500. It is a data: URL response (a 200 when the redirect is honoured).',
            warnings,
            hint: 'Live now for matching requests in every tab; reload the page to see it. Undo with net_rule_remove { id }, or net_rule_clear to restore normal networking.'
          };
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── REMOVE ONE ────────
  T({
    name: 'net_rule_remove',
    group: 'intercept',
    description: 'Remove one dynamic intercept rule by id (ids come from net_rules_list). Reports whether that id existed; other rules stay active. For "undo everything and restore normal networking" use net_rule_clear instead.',
    parameters: OBJ({ id: NUM }, ['id']),
    handler: async (args = {}) => {
      try {
        const id = validRuleId(args.id);
        return await withRuleLock(async () => {
          const api = dnr();
          const before = await getRules();
          const existed = before.some(r => Number(r && r.id) === id);
          if (!existed) {
            return {
              removed: false,
              existed: false,
              id,
              count: before.length,
              hint: `no dynamic rule with id ${id} — call net_rules_list for the current ids (it may already have been removed, or cleared by a browser/extension update)`
            };
          }
          await api.updateDynamicRules({ removeRuleIds: [id] });
          const notes = await readNotes();
          delete notes[id];
          delete notes[String(id)];
          await writeNotes(notes);
          const after = await getRules();
          const stillInstalled = after.some(r => Number(r && r.id) === id);
          const out = {
            removed: !stillInstalled,
            existed: true,
            id,
            count: after.length
          };
          if (stillInstalled) {
            out.warning = `rule ${id} is still present after the remove call — call net_rules_list to inspect it, and net_rule_clear to reset everything`;
          } else if (!after.length) {
            out.hint = 'That was the last intercept rule — normal networking is restored.';
          } else {
            out.hint = `${after.length} intercept rule(s) still active; net_rules_list shows them.`;
          }
          return out;
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── CLEAR ALL ────────
  T({
    name: 'net_rule_clear',
    group: 'intercept',
    description: 'REMOVE ALL dynamic intercept rules — the "restore normal networking" escape hatch. Use it whenever a simulation is done, or when a page/browser seems broken by rules added earlier. Reports how many rules were removed and is idempotent (zero rules installed = success, nothing removed). Dynamic rules persist across browser restarts, so this is the reset.',
    parameters: OBJ(),
    handler: async () => {
      try {
        return await withRuleLock(async () => {
          const api = dnr();
          const before = await getRules();
          const ids = before.map(r => Number(r && r.id)).filter(n => Number.isInteger(n) && n >= 1);
          if (ids.length) await api.updateDynamicRules({ removeRuleIds: ids });
          await writeNotes({});
          const after = await getRules();
          const out = {
            cleared: true,
            removedCount: ids.length,
            count: after.length
          };
          if (after.length) {
            out.warning = `${after.length} dynamic rule(s) are still installed after the clear call — call net_rules_list to inspect them`;
          } else if (ids.length) {
            out.hint = 'Normal networking restored: every dynamic intercept rule is gone. Reload any affected page (its earlier requests may be cached).';
          } else {
            out.hint = 'No dynamic intercept rules were installed — networking was already normal.';
          }
          return out;
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });
})();
