// Shared tool-registry bootstrap. Every other tool file (tools/*.js)
// pulls T, OBJ, etc. from window.KyotoTR — keeping each file small
// without giving up the cheap append-only registration pattern.
// Must load FIRST. tools/finalize.js wraps the populated registry
// as window.KyotoTools, and must load LAST.

(() => {
  'use strict';

  // ── Skills-hub defaults ──────────────────────────────
  // The URL of the public Kyoto skills hub, kept as a convenience default.
  //
  // No credential ships any more. The old baked-in key granted *write*
  // access to the public hub for every install, so anyone who extracted it
  // from the published bundle could publish/overwrite hub skills — and the
  // `global` partition is auto-surfaced in session prompts, making that a
  // remote prompt-injection supply chain. Users must now paste their own
  // hub API key in Settings → Skills hub.
  //
  // The object shape is kept because sidepanel.js (separate IIFE) reads
  // `.url` / `.key` when seeding settings defaults. `.key` is a non-secret
  // placeholder flagged by `keyIsPlaceholder`; tools/skills.js treats it as
  // "no credential configured", so nothing is sent and every hub feature
  // (including global-skill injection) stays off until the user sets a key.
  window.KYOTO_DEFAULT_SKILLS_HUB = {
    url: 'https://skills.kryvik.com',
    key: 'set-your-own-hub-api-key',
    keyIsPlaceholder: true,
  };

  // ── Helpers ──────────────────────────────────────────
  async function bg(type, args) {
    const res = await chrome.runtime.sendMessage({ type, args });
    if (!res) throw new Error('no response from background');
    if (!res.ok) throw new Error(res.error || 'background error');
    return res.data;
  }

  async function activeTab() {
    // Subagent tab-override: when a child agent is running its own
    // chat loop in a dedicated tab, tools default to that tab instead
    // of whatever tab is foregrounded in the user's window. Set/cleared
    // by sidepanel/subagents.js around each step of a subagent loop.
    if (typeof window.__kyotoTabOverride === 'number') {
      try {
        const t = await chrome.tabs.get(window.__kyotoTabOverride);
        if (t) return t;
      } catch {}
    }
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

  const STR = { type: 'string' };
  const NUM = { type: 'number' };
  const BOOL = { type: 'boolean' };
  const OBJ = (props = {}, required = []) => ({
    type: 'object',
    properties: props,
    required,
    additionalProperties: false
  });

  const TOOLS = [];
  function T(def) { TOOLS.push(def); }

  window.KyotoTR = {
    TOOLS, T, STR, NUM, BOOL, OBJ,
    bg, activeTab, truncate, scrip
  };
})();
