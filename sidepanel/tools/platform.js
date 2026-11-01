// Platform-level Chrome capabilities Kyoto did not use before: tab groups,
// recently-closed sessions, power keep-awake, MHTML page capture, per-origin
// data clearing, window inventory, the reading list and idle detection.
//
// Every one of these needs a permission the core browser tools don't use
// (tabGroups, sessions, power, pageCapture, browsingData, readingList, idle).
// Those are declared in manifest.json and this file is added to
// sidepanel.html by the integration step — this file itself stays a plain
// append-only registry contribution (see tools/core.js).
//
// Handlers never throw: a thrown tool error aborts the agent turn, while a
// returned { error } lets the model read it and adapt. Each handler therefore
// feature-detects its chrome.* namespace and validates its arguments before
// touching an API, so an older Chrome (or a build missing a permission) gets
// a readable message instead of an opaque rejection.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, activeTab, truncate } = window.KyotoTR;

  // ──────── SHARED HELPERS ────────
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
  const isIntArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isInt);
  const missing = (api) => ({ error: `${api}: not supported in this Chrome version` });
  // Some chrome.* calls return a promise (MV3) and some are callback-only even
  // today (chrome.power). Awaiting a non-promise is harmless but `await` on
  // `undefined` still returns undefined — this keeps those call sites uniform.
  const maybe = (v) => (v && typeof v.then === 'function' ? v : Promise.resolve(v));
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

  // chrome.tabGroups.Color enum — Chrome rejects anything else, so we say so
  // ourselves with a helpful message instead of surfacing a raw type error.
  const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

  const tabRef = (t) => ({
    id: t.id,
    url: truncate(t.url || '', 300),
    title: truncate(t.title || '', 160)
  });

  function shapeGroup(g, tabs) {
    const list = Array.isArray(tabs) ? tabs : [];
    return {
      id: g.id,
      title: g.title || '',
      color: g.color,
      collapsed: !!g.collapsed,
      windowId: g.windowId,
      tabCount: list.length,
      tabs: list.map(tabRef)
    };
  }

  async function groupTabs(groupId) {
    // chrome.tabs.query supports a groupId filter (Chrome 88+, and tabGroups
    // needs 89+ anyway), so this is cheap even when grouping many tabs.
    try { return await chrome.tabs.query({ groupId }); } catch { return []; }
  }

  function _httpUrl(raw) {
    try {
      const u = new URL(String(raw));
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch { return null; }
  }

  // ──────── TAB GROUPS ────────
  T({
    name: 'tabgroup_list',
    group: 'platform',
    description:
      'List the browser\'s tab groups, with the tabs inside each one. ' +
      'Use it to see how the user has organised their open tabs, or before group_* tools to find the id you need. ' +
      'Returns { count, groups: [{ id, title, color, collapsed, windowId, tabCount, tabs: [{id, url, title}] }] }. ' +
      'A group with no title is normal — Chrome shows the colour until someone names it.',
    parameters: OBJ(),
    handler: async () => {
      try {
        if (!chrome.tabGroups?.query) return missing('chrome.tabGroups');
        const [groups, tabs] = await Promise.all([
          chrome.tabGroups.query({}),
          chrome.tabs.query({})
        ]);
        const byGroup = new Map();
        for (const t of tabs) {
          // groupId is -1 (TAB_GROUP_ID_NONE) for ungrouped tabs.
          if (!isInt(t.groupId) || t.groupId < 0) continue;
          const list = byGroup.get(t.groupId) || [];
          list.push(t);
          byGroup.set(t.groupId, list);
        }
        const shaped = groups.map(g => shapeGroup(g, byGroup.get(g.id) || []));
        // Stable reading order: window, then group id.
        shaped.sort((a, b) => (a.windowId - b.windowId) || (a.id - b.id));
        return { count: shaped.length, groups: shaped };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'tabgroup_create',
    group: 'platform',
    description:
      'Create a new tab group from one or more tabs, optionally naming it and setting its colour/collapsed state. ' +
      'Omit `tabIds` to put the active tab in a new group. All tabs must already be in the same window (Chrome cannot group across windows) — use `tab_move_to_window` first if you need that. ' +
      'Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange. Returns { groupId, group } with the resulting group and its tabs.',
    parameters: OBJ({
      tabIds: { type: 'array', items: NUM },
      title: STR,
      color: { type: 'string', enum: GROUP_COLORS },
      collapsed: BOOL
    }),
    handler: async (args = {}) => {
      try {
        const { tabIds, title, color, collapsed } = args || {};
        if (!chrome.tabs?.group) return missing('chrome.tabs.group');
        if (!chrome.tabGroups?.update) return missing('chrome.tabGroups');

        if (tabIds !== undefined && !isIntArray(tabIds)) {
          return { error: 'tabIds must be a non-empty array of tab ids (integers)' };
        }
        if (title !== undefined && typeof title !== 'string') {
          return { error: 'title must be a string (use "" to clear an existing title)' };
        }
        if (color !== undefined && !GROUP_COLORS.includes(color)) {
          return { error: `color must be one of: ${GROUP_COLORS.join(', ')}` };
        }
        if (collapsed !== undefined && typeof collapsed !== 'boolean') {
          return { error: 'collapsed must be a boolean' };
        }

        const ids = tabIds ?? [(await activeTab()).id];

        // Validate the tabs up front: chrome.tabs.group rejects cross-window
        // tab sets with a cryptic message, and a stale tab id surfaces as a
        // bare "No tab with id" later. One pass gives a useful error instead.
        const resolved = [];
        for (const id of ids) {
          let tab;
          try { tab = await chrome.tabs.get(id); }
          catch { return { error: `no tab with id ${id}` }; }
          resolved.push(tab);
        }
        const windows = new Set(resolved.map(t => t.windowId));
        if (windows.size > 1) {
          return { error: `tabs span ${windows.size} windows — a tab group can only contain tabs from one window` };
        }

        const groupId = await chrome.tabs.group({ tabIds: ids });
        const patch = {};
        if (title !== undefined) patch.title = title;
        if (color !== undefined) patch.color = color;
        if (collapsed !== undefined) patch.collapsed = collapsed;

        let group;
        if (Object.keys(patch).length) {
          group = await chrome.tabGroups.update(groupId, patch);
        } else {
          try { group = await chrome.tabGroups.get(groupId); } catch { group = { id: groupId }; }
        }
        return {
          groupId,
          group: shapeGroup(group || { id: groupId }, await groupTabs(groupId))
        };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'tabgroup_add',
    group: 'platform',
    description:
      'Move existing tabs into an existing tab group (by group id from `tabgroup_list`). Tabs are moved, not copied, and must be in the same window as the group — for that case move the tab with `tabgroup_create`/`tab_move_to_window` instead. ' +
      'Returns { groupId, added, group } with the group\'s updated contents.',
    parameters: OBJ({ groupId: NUM, tabIds: { type: 'array', items: NUM } }, ['groupId', 'tabIds']),
    handler: async (args = {}) => {
      try {
        const { groupId, tabIds } = args || {};
        if (!chrome.tabs?.group) return missing('chrome.tabs.group');
        if (!isInt(groupId)) return { error: 'groupId must be an integer (see tabgroup_list)' };
        if (!isIntArray(tabIds)) return { error: 'tabIds must be a non-empty array of tab ids (integers)' };

        try { await chrome.tabGroups.get(groupId); }
        catch { return { error: `no tab group with id ${groupId}` }; }

        await chrome.tabs.group({ groupId, tabIds });
        let group = { id: groupId };
        try { group = await chrome.tabGroups.get(groupId); } catch { /* keep stub */ }
        return { groupId, added: tabIds, group: shapeGroup(group, await groupTabs(groupId)) };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'tabgroup_ungroup',
    group: 'platform',
    description:
      'Remove tabs from their tab group (the tabs stay open). The group disappears once it is empty. Returns { ungrouped: [tabIds] }.',
    parameters: OBJ({ tabIds: { type: 'array', items: NUM } }, ['tabIds']),
    handler: async (args = {}) => {
      try {
        const { tabIds } = args || {};
        if (!chrome.tabs?.ungroup) return missing('chrome.tabs.ungroup');
        if (!isIntArray(tabIds)) return { error: 'tabIds must be a non-empty array of tab ids (integers)' };
        for (const id of tabIds) {
          try { await chrome.tabs.get(id); }
          catch { return { error: `no tab with id ${id}` }; }
        }
        await chrome.tabs.ungroup(tabIds);
        return { ungrouped: tabIds };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── RECENTLY CLOSED (SESSIONS) ────────
  const SESSION_MAX = 25; // chrome.sessions.getRecentlyClosed caps maxResults at 25

  function shapeSessionEntry(entry) {
    const closedAt = iso(entry.lastModified);
    // chrome.sessions sessions are either a single restored tab or a whole
    // window (with its tabs). There is no `title`/`url` on a window, so the
    // first tab stands in as a label.
    if (entry.tab) {
      const t = entry.tab;
      return {
        kind: 'tab',
        sessionId: t.sessionId,
        title: truncate(t.title || '', 160),
        url: truncate(t.url || '', 300),
        windowId: t.windowId,
        tabCount: 1,
        closedAt
      };
    }
    if (entry.window) {
      const w = entry.window;
      const tabs = Array.isArray(w.tabs) ? w.tabs : [];
      const first = tabs[0] || {};
      return {
        kind: 'window',
        sessionId: w.sessionId,
        title: truncate(first.title || (tabs.length ? '(window)' : '(empty window)'), 160),
        url: truncate(first.url || '', 300),
        windowId: w.windowId ?? w.id,
        tabCount: tabs.length,
        closedAt,
        // A window's contents matter for "what did I just close?" — surface a
        // few titles, capped so a 40-tab window does not flood the context.
        tabTitles: tabs.slice(0, 6).map(t => truncate(t.title || '', 100)),
        tabsOmitted: Math.max(0, tabs.length - 6)
      };
    }
    return { kind: 'unknown', sessionId: entry.sessionId ?? null, closedAt };
  }

  T({
    name: 'session_recent',
    group: 'platform',
    description:
      'List recently closed tabs and windows — the "what did I just close?" tool. Newest first. ' +
      'Returns { count, closed: [{ kind: "tab"|"window", sessionId, title, url, windowId, tabCount, closedAt }] }. ' +
      'Pass a `sessionId` from this list to `session_restore`. Note Chrome keeps only a short history here, and each entry consumes one slot whether it is a tab or a window.',
    parameters: OBJ({ maxResults: NUM }),
    handler: async (args = {}) => {
      try {
        const { maxResults } = args || {};
        if (!chrome.sessions?.getRecentlyClosed) return missing('chrome.sessions');
        let max = SESSION_MAX;
        if (maxResults !== undefined) {
          if (!isInt(maxResults)) return { error: 'maxResults must be an integer' };
          max = Math.max(1, Math.min(SESSION_MAX, maxResults));
        }
        const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: max });
        const closed = (sessions || []).map(shapeSessionEntry);
        return { count: closed.length, maxResults: max, closed };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'session_restore',
    group: 'platform',
    description:
      'Reopen a recently closed tab or window. Omit `sessionId` to restore the most recently closed item (the same thing Ctrl+Shift+T does). ' +
      'Use after `session_recent` when the user asks for a specific closed tab back. Session ids expire — if restore fails with an invalid-id error, call `session_recent` again for fresh ids.',
    parameters: OBJ({ sessionId: STR }),
    handler: async (args = {}) => {
      try {
        const { sessionId } = args || {};
        if (!chrome.sessions?.restore) return missing('chrome.sessions');
        if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
          return { error: 'sessionId must be a string (from session_recent)' };
        }
        const session = sessionId
          ? await chrome.sessions.restore(sessionId)
          : await chrome.sessions.restore();
        const summary = shapeSessionEntry(session || {});
        return { restored: true, session: summary };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── POWER KEEP-AWAKE ────────
  // chrome.power exposes no "query" — Chrome only lets the extension request
  // and release. We therefore report what Kyoto last asked for, which is what
  // the agent actually needs to reason about.
  let keepAwake = null; // { mode, since }

  T({
    name: 'power_keep_awake',
    group: 'platform',
    description:
      'Stop the computer from sleeping/greying the display while long work runs, or release that request. ' +
      'Use it before multi-minute unattended runs (big scrapes, batch loops, cron jobs) so the OS does not suspend the machine and stall the agent mid-task; release it (release: true) when the run finishes so the user\'s power settings apply again. ' +
      'Mode "system" (default) prevents sleep, "display" also keeps the screen on — prefer "system" unless the task needs the display awake. ' +
      'Returns { keptAwake, mode, since }. Keep-awake is not queryable through chrome.power, so this reflects what Kyoto last requested, and Chrome drops it when the extension page unloads or the browser restarts.',
    parameters: OBJ({
      mode: { type: 'string', enum: ['system', 'display'] },
      release: BOOL
    }),
    handler: async (args = {}) => {
      try {
        const { mode = 'system', release = false } = args || {};
        if (!chrome.power?.requestKeepAwake) return missing('chrome.power');
        if (!['system', 'display'].includes(mode)) {
          return { error: 'mode must be "system" or "display"' };
        }
        if (typeof release !== 'boolean') return { error: 'release must be a boolean' };

        if (release) {
          const wasAwake = keepAwake;
          await maybe(chrome.power.releaseKeepAwake());
          keepAwake = null;
          return {
            keptAwake: false,
            mode: null,
            released: true,
            wasKeptAwake: !!wasAwake,
            previousMode: wasAwake?.mode ?? null
          };
        }
        await maybe(chrome.power.requestKeepAwake(mode));
        keepAwake = { mode, since: new Date().toISOString() };
        return {
          keptAwake: true,
          mode,
          since: keepAwake.since,
          note: 'Chrome releases this when the extension page unloads or the browser restarts — re-request it after a reload if the run is still going.'
        };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── MHTML PAGE CAPTURE ────────
  // MHTML (multipart/related) bundles the DOM *and* every subresource into a
  // single file that Chrome can reopen offline. That makes it the right format
  // for evidence/archiving: a screenshot loses the text, and page_html loses
  // the images/CSS.
  function saveAsMHTML(tabId) {
    return new Promise((resolve, reject) => {
      try {
        chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
          // Must be read inside the callback, otherwise Chrome only logs
          // "Unchecked runtime.lastError" and the failure is invisible.
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!blob) return reject(new Error('pageCapture returned no data (is the tab discarded or still loading?)'));
          resolve(blob);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function captureFilename(raw, tab) {
    let host = 'page';
    try { host = new URL(tab?.url || '').hostname || 'page'; } catch { /* non-http tab */ }
    let name = String(raw || `${host}-${ts()}.mhtml`).trim()
      .replace(/\.\.+/g, '.')
      .replace(/^\/+/, '')
      .replace(/[\\:*?"<>|]+/g, '_');
    if (!name) name = `${host}-${ts()}.mhtml`;
    if (!/\.(mhtml|mht)$/i.test(name)) name += '.mhtml';
    return name;
  }

  T({
    name: 'page_capture_mhtml',
    group: 'platform',
    description:
      'Save a full page as an MHTML archive — HTML plus every image/CSS/font inlined — and put it in the user\'s Kyoto workspace folder. ' +
      'Use it when a page must be preserved as evidence or read offline later (receipts, dashboards, articles that may change); unlike a screenshot it stays searchable, unlike page_html it keeps the assets. ' +
      'Only works on normal http(s) pages that are loaded — Chrome blocks chrome://, the Web Store, and discarded tabs. ' +
      'Returns { ok, filename, downloadId, bytes, savedTo, location, folder, tabId, url }.',
    parameters: OBJ({ tabId: NUM, filename: STR }),
    handler: async (args = {}) => {
      let objectUrl = null;
      let downloadId = null;
      try {
        const { tabId, filename } = args || {};
        if (!chrome.pageCapture?.saveAsMHTML) return missing('chrome.pageCapture');
        if (tabId !== undefined && !isInt(tabId)) return { error: 'tabId must be an integer' };
        if (filename !== undefined && typeof filename !== 'string') {
          return { error: 'filename must be a string' };
        }

        const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : await activeTab();
        const targetId = tab.id;
        const name = captureFilename(filename, tab);

        let blob;
        try {
          blob = await saveAsMHTML(targetId);
        } catch (e) {
          return {
            error: `could not capture tab ${targetId}: ${e?.message || String(e)} — pageCapture refuses chrome://, the Web Store, and pages that are not fully loaded`,
            tabId: targetId
          };
        }

        objectUrl = URL.createObjectURL(blob);
        const r = window.KyotoWorkspace
          ? await window.KyotoWorkspace.downloadUrl({ url: objectUrl, filename: name })
          : {
              downloadId: await chrome.downloads.download({ url: objectUrl, filename: name, saveAs: false, conflictAction: 'uniquify' }),
              path: name
            };
        downloadId = r.downloadId ?? null;

        return {
          ok: true,
          filename: name,
          downloadId,
          bytes: blob.size,
          mimeType: 'multipart/related',
          savedTo: r.path,
          location: r.location,
          folder: r.folder,
          tabId: targetId,
          url: truncate(tab.url || '', 300),
          ...(r.note ? { note: r.note } : {})
        };
      } catch (e) {
        // The download never started (or the capture failed before a download
        // existed), so nothing will ever read the blob.
        if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch {} objectUrl = null; }
        return { error: e?.message || String(e) };
      } finally {
        // The download API resolves as soon as the download is *queued*, so a
        // fixed timer can revoke the URL while a Save-As dialog is still open.
        // Hand the URL to the shared download-lifecycle revoker once we know
        // the download id; keep the old bounded fallback otherwise.
        if (objectUrl) {
          const revokeWhenDone = window.KyotoWorkspace?._revokeBlobUrlWhenDownloaded;
          if (revokeWhenDone && downloadId != null) revokeWhenDone(objectUrl, downloadId);
          else setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch {} }, 120000);
        }
      }
    }
  });

  // ──────── PER-ORIGIN DATA CLEARING ────────
  // Map of the friendly kind names we accept (lower-cased for tolerance) to
  // the keys chrome.browsingData expects in its `dataToRemove` object.
  const DATA_KINDS = {
    cache: 'cache',
    cookies: 'cookies',
    filesystems: 'fileSystems',
    indexeddb: 'indexedDB',
    localstorage: 'localStorage',
    serviceworkers: 'serviceWorkers',
    websql: 'webSQL'
  };
  const DEFAULT_KINDS = ['cache', 'cookies', 'localStorage', 'indexedDB'];

  T({
    name: 'site_data_clear',
    group: 'platform',
    description:
      'DESTRUCTIVE: erase browsing data for ONE origin — cookies (i.e. sign the user out), cache, localStorage, IndexedDB, service workers, file systems, WebSQL. ' +
      'Use it only when the user explicitly asks to "log me out of X" or "start clean on X"; it cannot be undone, it kills that origin\'s sessions for every profile tab, and it may destroy unsaved site state. ' +
      'Never call it speculatively or on an origin the user did not name. ' +
      'Defaults to cache+cookies+localStorage+indexedDB (pass `kinds` to narrow or widen: cache, cookies, fileSystems, indexedDB, localStorage, serviceWorkers, webSQL). ' +
      'Returns { cleared: true, origin, kinds, clearedAt }.',
    parameters: OBJ({
      origin: STR,
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['cache', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'] }
      }
    }, ['origin']),
    handler: async (args = {}) => {
      try {
        const { origin, kinds } = args || {};
        if (!chrome.browsingData?.remove) return missing('chrome.browsingData');
        if (typeof origin !== 'string' || !origin.trim()) {
          return { error: 'origin is required and must be a string like "https://example.com"' };
        }

        let parsed;
        try { parsed = new URL(origin.trim()); }
        catch { return { error: `origin must be an absolute URL like "https://example.com", got "${origin}"` }; }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { error: `origin must use http:// or https:// — refusing "${parsed.protocol}" (chrome://, file:// and extension origins cannot be cleared this way)` };
        }
        if (!parsed.hostname) return { error: 'origin must include a hostname' };
        // browsingData wants a bare origin, so a pasted page URL is trimmed to
        // scheme+host+port rather than rejected.
        const canonical = parsed.origin;
        const normalised = canonical !== origin.trim();

        let names = DEFAULT_KINDS;
        if (kinds !== undefined) {
          if (!Array.isArray(kinds) || kinds.length === 0) {
            return { error: 'kinds must be a non-empty array of kind names' };
          }
          names = [];
          for (const raw of kinds) {
            if (typeof raw !== 'string') return { error: 'kinds must contain strings' };
            const key = raw.trim().toLowerCase();
            const mapped = DATA_KINDS[key];
            if (!mapped) {
              return { error: `unknown kind "${raw}" — allowed: ${Object.values(DATA_KINDS).join(', ')}` };
            }
            if (!names.includes(mapped)) names.push(mapped);
          }
        }

        const dataTypes = {};
        for (const k of names) dataTypes[k] = true;

        await maybe(chrome.browsingData.remove({ origins: [canonical] }, dataTypes));

        return {
          cleared: true,
          origin: canonical,
          kinds: names,
          clearedAt: new Date().toISOString(),
          ...(normalised ? { note: `origin narrowed to "${canonical}"` } : {})
        };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── WINDOW INVENTORY ────────
  // Registered as windows_inspect (not windows_list) because browser.js
  // already registers windows_list: two tools with the same name would both be
  // offered to the model and only the first one would ever be callable.
  T({
    name: 'windows_inspect',
    group: 'platform',
    description:
      'Full window inventory: every browser window with its id, focused/state/type and tab count, and — with populate: true — the tabs inside each one. ' +
      'Use it to decide where to put a new tab (pair with `tab_move_to_window`) or to find a windowId, especially when the user has several windows open. ' +
      'For a flat list of tabs only, `tabs_list` is cheaper; this one is for window structure.',
    parameters: OBJ({ populate: BOOL }),
    handler: async (args = {}) => {
      try {
        const { populate = false } = args || {};
        if (!chrome.windows?.getAll) return missing('chrome.windows');
        if (typeof populate !== 'boolean') return { error: 'populate must be a boolean' };
        const wins = await chrome.windows.getAll({ populate });
        // chrome.windows.getAll only includes `tabs` when populate:true, so a
        // plain call would report 0 tabs for every window. One tabs.query pass
        // gives real counts without forcing the caller to fetch every tab.
        let counts = null;
        if (!populate) {
          try {
            counts = new Map();
            for (const t of await chrome.tabs.query({})) {
              counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
            }
          } catch { counts = null; }
        }
        const windows = (wins || []).map(w => {
          const tabs = Array.isArray(w.tabs) ? w.tabs : [];
          const out = {
            id: w.id,
            focused: !!w.focused,
            state: w.state,
            type: w.type || 'normal',
            incognito: !!w.incognito,
            tabCount: tabs.length || counts?.get(w.id) || 0
          };
          if (populate) out.tabs = tabs.map(tabRef);
          return out;
        });
        return { count: windows.length, windows };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'tab_move_to_window',
    group: 'platform',
    description:
      'Move a tab into another existing window, or into a brand-new window (omit `windowId`). ' +
      'chrome.windows.create({ tabId }) moves the tab rather than duplicating it, so the original tab is gone afterwards. ' +
      'Use it to tidy a crowded window or to isolate a task in its own window before working in it. Returns { moved, tabId, windowId, index, created } — `windowId` is the destination.',
    parameters: OBJ({ tabId: NUM, windowId: NUM }, ['tabId']),
    handler: async (args = {}) => {
      try {
        const { tabId, windowId } = args || {};
        if (!chrome.tabs?.move && !chrome.windows?.create) {
          return { error: 'tabs.move/windows.create: not supported in this Chrome version' };
        }
        if (!isInt(tabId)) return { error: 'tabId must be an integer' };
        if (windowId !== undefined && !isInt(windowId)) return { error: 'windowId must be an integer' };

        let tab;
        try { tab = await chrome.tabs.get(tabId); }
        catch { return { error: `no tab with id ${tabId}` }; }

        if (windowId === undefined) {
          if (!chrome.windows?.create) return missing('chrome.windows.create');
          const win = await chrome.windows.create({ tabId });
          return { moved: true, created: true, tabId, windowId: win?.id ?? null };
        }

        if (windowId === tab.windowId) {
          return { moved: false, created: false, tabId, windowId, note: 'tab is already in that window' };
        }
        if (!chrome.tabs?.move) return missing('chrome.tabs.move');
        try { await chrome.windows.get(windowId); }
        catch { return { error: `no window with id ${windowId}` }; }

        // index -1 appends to the end of the destination window.
        const moved = await chrome.tabs.move(tabId, { windowId, index: -1 });
        const movedTab = Array.isArray(moved) ? moved[0] : moved;
        return {
          moved: true,
          created: false,
          tabId,
          windowId,
          index: movedTab?.index ?? null
        };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── READING LIST ────────
  T({
    name: 'reading_list_add',
    group: 'platform',
    description:
      'Add a page to Chrome\'s Reading list ("read later"), optionally pre-marked as read. Defaults to the current tab\'s URL and title. ' +
      'Requires the Reading list feature to be enabled in Chrome (chrome://flags → Reading list, or a recent desktop Chrome where it is on by default); if it is off the API is absent and this returns a clear error. ' +
      'Use it when the user says "save this to read later". Returns { added, url, title, hasBeenRead }.',
    parameters: OBJ({ url: STR, title: STR, hasBeenRead: BOOL }),
    handler: async (args = {}) => {
      try {
        const { url, title, hasBeenRead = false } = args || {};
        if (!chrome.readingList?.addEntry) return missing('chrome.readingList');
        if (typeof hasBeenRead !== 'boolean') return { error: 'hasBeenRead must be a boolean' };
        if (title !== undefined && typeof title !== 'string') return { error: 'title must be a string' };

        let finalUrl = url;
        let finalTitle = title;
        if (finalUrl === undefined || finalTitle === undefined) {
          const tab = await activeTab();
          if (finalUrl === undefined) finalUrl = tab.url;
          if (finalTitle === undefined) finalTitle = tab.title;
        }
        const href = _httpUrl(finalUrl);
        if (!href) return { error: `url must be a normal http(s) page URL, got "${finalUrl ?? ''}"` };
        finalTitle = (finalTitle || href).trim() || href;

        await chrome.readingList.addEntry({ url: href, title: finalTitle, hasBeenRead });
        return { added: true, url: href, title: finalTitle, hasBeenRead };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  T({
    name: 'reading_list_query',
    group: 'platform',
    description:
      'List entries in Chrome\'s Reading list: { url, title, hasBeenRead, creationTime, lastUpdateTime }. ' +
      'Pass `since` (epoch milliseconds) to only get entries created at or after that time — handy for "what did I save this week?". ' +
      'Same requirement as reading_list_add: the Reading list feature must be enabled in Chrome. Use it before suggesting what to read, or to dedupe before adding.',
    parameters: OBJ({ since: NUM }),
    handler: async (args = {}) => {
      try {
        const { since } = args || {};
        if (!chrome.readingList?.query) return missing('chrome.readingList');
        if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since))) {
          return { error: 'since must be an epoch timestamp in milliseconds' };
        }
        const all = await chrome.readingList.query({});
        const entries = (all || [])
          .filter(e => since === undefined || (typeof e.creationTime === 'number' && e.creationTime >= since))
          .map(e => ({
            url: truncate(e.url || '', 300),
            title: truncate(e.title || '', 160),
            hasBeenRead: !!e.hasBeenRead,
            creationTime: e.creationTime,
            createdAt: iso(e.creationTime),
            lastUpdateTime: e.lastUpdateTime,
            updatedAt: iso(e.lastUpdateTime)
          }));
        return { count: entries.length, since: since ?? null, entries };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  // ──────── IDLE STATE ────────
  T({
    name: 'idle_state',
    group: 'platform',
    description:
      'Report whether the user is at the computer: state is "active" (input within the detection window), "idle" (no input for that long) or "locked" (screen locked). ' +
      'Use it before starting long or disruptive work (big scrapes, many tab operations, anything that steals focus): if the user is idle or locked, prefer to defer the risky step until they are back rather than rearranging their screen unseen. ' +
      'detectionSeconds defaults to 60 and is clamped to Chrome\'s 15-second minimum. Returns { state, detectionSeconds }.',
    parameters: OBJ({ detectionSeconds: NUM }),
    handler: async (args = {}) => {
      try {
        const { detectionSeconds = 60 } = args || {};
        if (!chrome.idle?.queryState) return missing('chrome.idle');
        if (typeof detectionSeconds !== 'number' || !Number.isFinite(detectionSeconds)) {
          return { error: 'detectionSeconds must be a number of seconds' };
        }
        // Chrome's minimum detection interval is 15 s.
        const secs = Math.max(15, Math.min(3600, Math.round(detectionSeconds)));
        const state = await maybe(chrome.idle.queryState(secs));
        return {
          state: state || 'active',
          detectionSeconds: secs,
          note: state === 'locked'
            ? 'Screen is locked — the user cannot see anything you do right now.'
            : state === 'idle'
              ? 'User has been away for the detection window.'
              : 'User is active.'
        };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });
})();
