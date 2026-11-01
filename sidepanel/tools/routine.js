// Routines — record a page workflow once, replay it deterministically.
//
// These tools are thin adapters: the side panel owns recording, storage and the
// replay executor (it needs `chrome.scripting` plus the session's bound tab), and
// exposes them on `window.KyotoRoutineApi`. Keeping the tools thin means the
// replay semantics live in exactly one place.
//
// Replay costs ZERO model calls, which is the point: the agent can hand a
// repetitive multi-step workflow to a routine, and cron can run it on a schedule
// without paying for a model turn each time.

(() => {
  'use strict';
  const { T, STR, OBJ, BOOL } = window.KyotoTR;

  function api() {
    const a = window.KyotoRoutineApi;
    if (!a) throw new Error('routines are unavailable (side panel not ready)');
    return a;
  }

  T({
    name: 'routine_list',
    group: 'routine',
    description:
      'List saved replayable routines. A routine is a recorded sequence of page actions ' +
      '(click / type / select / navigate / press) that can be replayed exactly, with no model calls. ' +
      'Returns { count, routines: [{ id, name, steps, url }] }.',
    parameters: OBJ(),
    handler: async () => {
      try {
        const list = await api().list();
        return {
          count: list.length,
          routines: list.map(r => ({
            id: r.id,
            name: r.name,
            steps: Array.isArray(r.steps) ? r.steps.length : 0,
            url: r.url || null
          }))
        };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });

  T({
    name: 'routine_run',
    group: 'routine',
    description:
      'Replay a saved routine by name or id on the tab this conversation is bound to. ' +
      'Executes the recorded steps in order (waiting for each element) and returns a per-step result. ' +
      'Use it for repetitive workflows that were recorded earlier — it makes NO model calls, so it is fast and free. ' +
      'Steps whose value was masked during recording (password / email / card / OTP) cannot be replayed: ' +
      'pass their values in `values` (keyed by the placeholder hint, e.g. {"password":"…"}), ' +
      'or the tool will report which steps need input. It stops at the first failing step and reports it. ' +
      'IMPORTANT: if the routine contains destructive-looking steps (Delete / Pay / Submit / Send …) it is REFUSED ' +
      'unless you pass confirm: true — re-running with confirm means you have decided the action is intended.',
    parameters: OBJ({
      name: STR,
      values: { type: 'object', additionalProperties: true },
      confirm: BOOL
    }, ['name']),
    handler: async ({ name, values, confirm } = {}) => {
      try {
        if (!name || typeof name !== 'string') return { error: 'name is required (routine name or id)' };
        return await api().run(name, { values: values || undefined, confirm: confirm === true });
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });

  T({
    name: 'routine_save',
    group: 'routine',
    description:
      'Save the actions currently in the page-action recording buffer as a replayable routine. ' +
      'The user must have recorded a workflow first (the ● button in the composer). ' +
      'Returns { id, name, steps } on success, or an error explaining why the recording cannot be ' +
      'turned into a routine (e.g. actions with no stable selector are dropped).',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name } = {}) => {
      try {
        if (!name || typeof name !== 'string') return { error: 'name is required' };
        const rec = await api().save(name);
        if (!rec) return { error: 'recording could not be converted into a routine (see chat for details)' };
        return { id: rec.id, name: rec.name, steps: rec.steps.length };
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });

  T({
    name: 'routine_delete',
    group: 'routine',
    description: 'Delete a saved routine by name or id. Returns { removed, id, name }.',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name } = {}) => {
      try {
        if (!name || typeof name !== 'string') return { error: 'name is required' };
        return await api().remove(name);
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });
})();
