// Wraps the populated tool registry as window.KyotoTools — the public
// API the side panel calls into. Must load AFTER every tools/*.js
// that calls T(...).

(() => {
  'use strict';
  const TR = window.KyotoTR;
  if (!TR) throw new Error('KyotoTR not initialised — tools/core.js missing or out of order');
  const TOOLS = TR.TOOLS;
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
