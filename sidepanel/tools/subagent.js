// Subagent / `agent` tool — opens a fresh tab, runs a child agent loop
// in its own session bound to that tab, returns the final assistant text.
// Inspired by opencode's `agent` tool, adapted for the browser:
//   - Each child gets its OWN tab (not just its own session)
//   - Tab-aware tools are auto-injected with the child's tabId, so the
//     child's actions land on its tab even if the user clicks away
//   - Multiple concurrent agent calls in one turn → multiple tabs in
//     parallel
//   - Recursive agent spawning is disabled by default (to prevent
//     unbounded cost); same for the `ask_user` UI prompt.

(() => {
  'use strict';
  const { T, STR, BOOL, OBJ } = window.KyotoTR;

  T({
    name: 'agent',
    group: 'meta',
    description:
      'Spawn a child browser agent in its OWN tab to do a self-contained sub-task and report back. ' +
      'Use this when a task naturally splits into independent investigations — e.g. "compare prices across 3 sites", "summarise these 5 PRs", "extract docs from N URLs". ' +
      'Each subagent has its own conversation history, its own tab, and runs the same toolset you do (minus `agent` itself and `ask_user`). ' +
      'Launch MULTIPLE subagents concurrently by emitting multiple `agent` tool calls in one turn — they all run in parallel, each in a separate tab. ' +
      'The child is stateless from your perspective: you give it a prompt, it returns one final message. Make the prompt SELF-CONTAINED and SPECIFIC — say exactly what you want back. ' +
      'Pass `start_url` to seed the new tab with a URL (default: about:blank). Pass `close_tab: true` to close the spawned tab after the child finishes (otherwise it stays open so the user can inspect what was done). ' +
      'Returns { ok, result, sessionId, tabId, tabUrl, messageCount } where `result` is the child\'s final assistant text.',
    parameters: OBJ({
      prompt: STR,
      start_url: STR,
      close_tab: BOOL,
      make_active: BOOL
    }, ['prompt']),
    handler: async (args = {}) => {
      if (!window.KyotoSession?.spawnSubagent) {
        return { error: 'subagent runtime not available (KyotoSession.spawnSubagent missing)' };
      }
      try {
        return await window.KyotoSession.spawnSubagent({
          prompt: args.prompt,
          startUrl: args.start_url,
          closeTab: !!args.close_tab,
          makeActive: !!args.make_active
        });
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });
})();
