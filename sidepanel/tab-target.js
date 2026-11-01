// Which tab a tool call should act on.
//
// Kyoto binds each conversation to ONE tab (that is what "per-tab sessions"
// means). But a tool that doesn't receive an explicit `tabId` falls back to the
// browser's *currently active* tab. So while an agent turn was running, the user
// switching to another tab silently retargeted every subsequent tool call to the
// new tab: the model kept clicking/reading a page it never chose, and the tool
// results — and therefore the context — started describing the wrong page.
//
// The fix is to pin tab-scoped tool calls to the conversation's bound tab for
// the whole turn. This module owns the (pure, testable) decision of *whether*
// and *what* to inject; sidepanel.js applies it right before dispatch.
//
// Why inject `tabId` rather than a global override: Kyoto can run several
// sessions concurrently (`state.runtimes` is per-session), so a single global
// "current tab" variable would be clobbered whenever two turns interleaved at an
// await. Passing the tab explicitly is per-call and race-free.

(() => {
  'use strict';

  // Tools that operate on a specific tab. Every entry accepts a `tabId` argument
  // (or is adapted below to honour one), so injecting it is sufficient.
  //
  // Keep this in sync when adding tab-scoped tools: a missing entry silently
  // reintroduces the "follow the active tab" bug.
  const TAB_AWARE_TOOLS = new Set([
    // page / DOM
    'page_content', 'page_html', 'page_query', 'page_click', 'page_fill',
    'page_fill_form', 'page_scroll', 'page_wait_for', 'page_eval',
    'page_performance', 'page_local_storage', 'page_session_storage',
    'page_local_storage_set', 'page_local_storage_remove',
    'page_session_storage_set', 'page_session_storage_remove',
    'page_fetch_intercept', 'page_fetch_intercept_read',
    // tabs
    'tab_active', 'tab_navigate', 'tab_reload', 'tab_screenshot',
    // IndexedDB
    'idb_list_databases', 'idb_list_stores', 'idb_read',
    // network / console / debugger
    'network_capture_start', 'console_attach', 'console_read',
    'debugger_attach', 'debugger_detach',
    // media / youtube
    'media_detect', 'youtube_extract', 'youtube_capture_streams', 'yt_dlp_command',
    'minimax_describe_tab',
    // cookies — these derive a URL from the tab when no url/domain is given,
    // so they are just as vulnerable to the active-tab drift as the page tools.
    'cookies_list', 'cookies_get', 'cookies_analyze', 'cookies_snapshot',
    'cookies_diff'
  ]);

  function isTabAware(toolName) {
    return !!toolName && TAB_AWARE_TOOLS.has(toolName);
  }

  /**
   * The tabId to inject for this call, or null when the call should keep its
   * natural behaviour.
   *
   * Returns null when:
   *  - the tool isn't tab-scoped;
   *  - the caller was explicit (`args.tabId`) — never override the model;
   *  - the conversation isn't bound to a tab (then "active tab" is the only
   *    sensible default, which is what it already does).
   *
   * @param {{toolName:string, args?:object, session?:{tabId?:number|null}}} o
   * @returns {number|null}
   */
  function resolveToolTabId({ toolName, args, session } = {}) {
    if (!isTabAware(toolName)) return null;
    const explicit = args ? args.tabId : undefined;
    if (explicit !== undefined && explicit !== null) return null;
    const bound = session ? session.tabId : undefined;
    // Only a real tab id is meaningful; null/undefined means "unbound".
    if (typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0) return null;
    return bound;
  }

  /** Apply the binding to an args object (returns a new object; never mutates). */
  function injectToolTabId({ toolName, args, session } = {}) {
    const base = args && typeof args === 'object' ? args : {};
    const tabId = resolveToolTabId({ toolName, args: base, session });
    if (tabId == null) return base;
    return { ...base, tabId };
  }

  /**
   * May the cached page snapshot be injected into this conversation's prompt?
   *
   * The snapshot in `state.page` is refreshed from a specific tab. If a session
   * stays visible while the user browses elsewhere (pinned session), the two can
   * disagree — and injecting another tab's content would quietly feed the model
   * a page it is not working on.
   *
   * @param {number|null|undefined} pageTabId    tab the snapshot came from
   * @param {number|null|undefined} sessionTabId tab the conversation is bound to
   */
  function pageContextMatchesSession(pageTabId, sessionTabId) {
    // Unknown provenance (older snapshot) or unbound session: keep the previous
    // behaviour rather than dropping context the user expects.
    if (pageTabId == null) return true;
    if (typeof sessionTabId !== 'number' || !Number.isFinite(sessionTabId)) return true;
    return pageTabId === sessionTabId;
  }

  window.KyotoTabTarget = {
    TAB_AWARE_TOOLS,
    isTabAware,
    resolveToolTabId,
    injectToolTabId,
    pageContextMatchesSession
  };
})();
