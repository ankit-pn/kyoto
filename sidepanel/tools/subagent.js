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
      'Use this when a task naturally splits into independent investigations — e.g. "compare prices across 3 sites", "summarise these 5 PRs", "extract docs from N URLs", "log into and screenshot 4 dashboards in parallel". ' +
      'Each subagent has its own conversation history, its own tab, and runs the same browser toolset you do (minus `agent` and `ask_user`).\n\n' +
      'Usage notes:\n' +
      '1. Launch MULTIPLE subagents concurrently whenever possible — emit multiple `agent` tool calls in a single message and they all run in parallel, each in its own tab.\n' +
      '2. When the agent is done, it returns a single message back to you. The result is NOT visible to the user — you should summarise its findings for the user yourself.\n' +
      '3. Each agent invocation is STATELESS. You cannot send follow-up messages to it, and it cannot communicate with you outside of its final reply. Therefore your `prompt` must contain a HIGHLY DETAILED task description — specify exactly what the agent should do AND exactly what information it should return.\n' +
      '4. The agent\'s output should generally be trusted.\n' +
      '5. Use `start_url` to seed the spawned tab with a URL (default: about:blank). Set `close_tab: true` to auto-close the tab when the child finishes; otherwise it stays open so the user can inspect the work.\n' +
      '6. Returns `{ ok, result, sessionId, tabId, tabUrl, messageCount, costUsd, totalUsage }`. `result` is the child\'s final assistant text.',
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
