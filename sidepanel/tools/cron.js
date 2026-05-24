// Background-jobs surface for the agent.
//
// Two layers exposed:
//   1. cron_*   — schedule, list, inspect, pause, run-now, log JS jobs
//                 that fire on a chrome.alarms-driven schedule (every-N
//                 or 5-field cron expression).
//   2. state_*  — shared key/value store with TTL. The async pipe
//                 between an auth-refresher job and the scraper that
//                 consumes its output. Also useful as a memo store
//                 even without cron.
//
// Both layers live in the service worker (see Cron in background.js).
// These tools are thin wrappers that send messages to the SW and
// forward the response. Kept in their own file so the tool registry
// stays modular and the SW remains the single source of truth.
//
// Job code runs in the SW with this sandbox:
//   K.state.get(key) / set(k,v,{ttlMs}) / delete(k) / list(prefix)
//   K.log(...args) / K.stderr(...args)
//   K.now() / K.job
//   K.tools.network_fetch / page_eval / cookies_get / cookies_getAll /
//          tabs_query / tabs_get / downloads_download / notification
//   K.chrome   ← escape hatch for anything not in K.tools
//   K.fetch    ← raw fetch (SW context, no CORS-from-extension issues)

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg } = window.KyotoTR;

  // ──────── CRON ────────

  T({
    name: 'cron_add',
    group: 'cron',
    description:
      'Register a background job. `schedule.every` (e.g. "25m", "30s", "1h", "1d") for simple periodic — minimum 30s. ' +
      '`schedule.cron` ("min hr dom mon dow") for calendar schedules, e.g. "0 * * * *" (top of every hour), "0 9 * * 1-5" (weekdays 9am). ' +
      '`code` is a JS string evaluated as an async function body in the service worker with a `K` sandbox exposing K.state, K.log, K.stderr, K.now, K.sleep(ms), K.job, K.tools (network_fetch, page_eval, cookies_get, tabs_query, downloads_download, notification, fs_write, fs_read, fs_list, fs_delete), K.chrome, K.fetch. ' +
      '`singleton: true` skips a firing if the previous run is still in flight (auth refreshers should set this). ' +
      'On failure: exponential backoff — next runs are skipped until basePeriod × min(32, 2^(failures-1)) elapses. After `autoPauseAfter` (default 5) consecutive failures the job is auto-paused and a system notification fires. ' +
      'Returns { id, name, slug, nextRunAt, ... }. Job runs ONLY while Chrome is running.',
    parameters: OBJ({
      name: STR,
      schedule: OBJ({ every: STR, cron: STR }),
      code: STR,
      notes: STR,
      paused: BOOL,
      singleton: BOOL,
      tags: { type: 'array', items: STR },
      autoPauseNotify: BOOL,
      timeoutMs: NUM,
      autoPauseAfter: NUM,
    }, ['name', 'schedule', 'code']),
    handler: async (args) => bg('CRON_ADD', args || {}),
  });

  T({
    name: 'cron_dry_run',
    group: 'cron',
    description:
      'Run job `code` ONCE with the K sandbox, without registering anything. Same execution environment as a real run (K.state, K.tools, K.fetch, K.chrome) — state mutations DO persist, alarms do not. Use this to verify the code parses and behaves before `cron_add` puts a broken job on the schedule. ' +
      'Returns { ok, ms, stdout, stderr, error }.',
    parameters: OBJ({ code: STR, timeoutMs: NUM }, ['code']),
    handler: async ({ code, timeoutMs }) => bg('CRON_DRY_RUN', { code, timeoutMs }),
  });

  T({
    name: 'cron_list',
    group: 'cron',
    description:
      'List all background jobs with their key fields (id, name, schedule, paused, pauseUntil, tags, lastRunAt, nextRunAt, consecutiveFailures, lastError). Pass `tag` to filter to jobs that include that tag.',
    parameters: OBJ({ includePaused: BOOL, tag: STR }),
    handler: async ({ includePaused = true, tag } = {}) => bg('CRON_LIST', { includePaused, tag }),
  });

  T({
    name: 'cron_snooze',
    group: 'cron',
    description: 'Pause a job for `durationMs` and have it auto-resume at the reconcile pass after the deadline. Useful for rate-limit Retry-After windows or planned downtime — preferable to `cron_pause` because there\'s nothing to remember to undo.',
    parameters: OBJ({ id: STR, durationMs: NUM }, ['id', 'durationMs']),
    handler: async ({ id, durationMs }) => bg('CRON_SNOOZE', { id, durationMs }),
  });

  T({
    name: 'cron_stats',
    group: 'cron',
    description:
      'Aggregate metrics for a job over its kept run history (up to 200 entries). Returns { totalRuns, ok, fail, skipped, successRate, p50Ms, p95Ms, avgMs, recentErrors }. `sinceMs` (epoch ms) filters the window.',
    parameters: OBJ({ id: STR, sinceMs: NUM }, ['id']),
    handler: async ({ id, sinceMs }) => bg('CRON_STATS', { id, sinceMs }),
  });

  T({
    name: 'cron_get',
    group: 'cron',
    description: 'Return the full record for one job, including its code body. Use this before `cron_update` to fetch + tweak.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => bg('CRON_GET', { id }),
  });

  T({
    name: 'cron_update',
    group: 'cron',
    description:
      'Patch a job. Allowed fields: name, schedule, code, notes, paused, timeoutMs, autoPauseAfter. Anything else is ignored. Re-schedules the alarm if `schedule` changed. Returns the updated record.',
    parameters: OBJ({
      id: STR,
      name: STR,
      schedule: OBJ({ every: STR, cron: STR }),
      code: STR,
      notes: STR,
      paused: BOOL,
      pauseUntil: NUM,
      singleton: BOOL,
      tags: { type: 'array', items: STR },
      autoPauseNotify: BOOL,
      timeoutMs: NUM,
      autoPauseAfter: NUM,
    }, ['id']),
    handler: async ({ id, ...patch }) => bg('CRON_UPDATE', { id, ...patch }),
  });

  T({
    name: 'cron_remove',
    group: 'cron',
    description: 'Delete a job and cancel its alarm. Logs for the job are also cleared.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => bg('CRON_REMOVE', { id }),
  });

  T({
    name: 'cron_pause',
    group: 'cron',
    description: 'Pause a job without removing it. The alarm is cleared; resume to put it back on schedule.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => bg('CRON_PAUSE', { id }),
  });

  T({
    name: 'cron_resume',
    group: 'cron',
    description: 'Resume a paused job. Resets the consecutive-failure counter so it gets a clean slate.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => bg('CRON_RESUME', { id }),
  });

  T({
    name: 'cron_run_now',
    group: 'cron',
    description:
      'Execute a job immediately, out-of-band of its schedule. By default waits for completion and returns the run result; pass `async: true` to fire-and-forget (returns { queued: true }).',
    parameters: OBJ({ id: STR, async: BOOL }, ['id']),
    handler: async ({ id, async: asyncRun = false }) => bg('CRON_RUN_NOW', { id, async: asyncRun }),
  });

  T({
    name: 'cron_logs',
    group: 'cron',
    description:
      'Read recent runs of a job. Newest first. Each entry: { ts, ok, ms, stdout, stderr, error?, triggeredBy }.',
    parameters: OBJ({ id: STR, limit: NUM, sinceMs: NUM }, ['id']),
    handler: async ({ id, limit = 20, sinceMs }) => bg('CRON_LOGS', { id, limit, sinceMs }),
  });

  T({
    name: 'cron_status',
    group: 'cron',
    description: 'Dashboard of every job + count of state-store keys + last reconcile time. Use to give the user a quick overview.',
    parameters: OBJ(),
    handler: async () => bg('CRON_STATUS'),
  });

  // ──────── STATE PIPE ────────

  T({
    name: 'state_get',
    group: 'cron',
    description:
      'Read a value from the shared state store. Returns { value, writtenAt, ttlMs, writtenBy, expired } or { missing: true }. ' +
      '`expired: true` means the TTL elapsed — the value is still returned, but the caller should treat it as stale.',
    parameters: OBJ({ key: STR }, ['key']),
    handler: async ({ key }) => bg('STATE_GET', { key }),
  });

  T({
    name: 'state_set',
    group: 'cron',
    description:
      'Write a value to the shared state store. Value must be JSON-serializable. ' +
      'Optional `ttlMs` marks the value as expired once that many ms elapses since the write (the value stays readable; callers see `expired: true`). ' +
      'Per-value cap is ~50KB — for bulk data use KyotoVFS via fs_write.',
    parameters: OBJ({ key: STR, value: {}, ttlMs: NUM, writtenBy: STR }, ['key', 'value']),
    handler: async ({ key, value, ttlMs, writtenBy }) => bg('STATE_SET', { key, value, ttlMs, writtenBy }),
  });

  T({
    name: 'state_delete',
    group: 'cron',
    description: 'Remove a key from the shared state store.',
    parameters: OBJ({ key: STR }, ['key']),
    handler: async ({ key }) => bg('STATE_DELETE', { key }),
  });

  T({
    name: 'state_list',
    group: 'cron',
    description: 'Enumerate keys in the state store. Optional `prefix` filters to keys starting with it.',
    parameters: OBJ({ prefix: STR }),
    handler: async ({ prefix } = {}) => bg('STATE_LIST', { prefix }),
  });
})();
