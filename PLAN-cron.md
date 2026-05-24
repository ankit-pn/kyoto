# Plan: in-extension background jobs + async state pipe

Status: **draft, not implemented**.
Owner: ankit.
Last updated: 2026-05-24.

## Goal

Give the agent a real "background worker" surface:

- It can register **jobs** that run on a schedule.
- It can read/write a small **shared state store** that jobs use as an
  async pipe (auth tokens, last-seen cursors, etc.).
- It can fully manage everything from chat — list, pause, run-now,
  inspect logs, remove.
- It can do all of this without installing anything native, and without
  the per-OS complexity of launchd / systemd / Task Scheduler.

Tradeoff accepted: **jobs only run while Chrome is running.** This is
fine because the auth flows we care about (Cloudflare-protected
sessions, page-JS-signed headers, browser cookies) only work inside the
browser anyway. If a job-while-Chrome-closed requirement appears later,
we add a kyoto-shell daemon as a *complement*, not a replacement.

## Architecture, one paragraph

A single `chrome.alarms`-driven scheduler in the background service
worker reads job specs from `chrome.storage.local`, dispatches each
firing to an in-process executor that evaluates the job's JS code with
a sandbox object (`K`) exposing the full tool registry plus the state
pipe. Every run appends a row to a per-job history buffer in
`KyotoVFS` (IndexedDB) — small enough to keep, large enough not to
truncate immediately. Failures back off exponentially; consecutive
failures past a threshold auto-pause the job. The agent talks to it
through `cron_*` and `state_*` tools registered in
`sidepanel/tools/cron.js`.

## Storage layout

### `chrome.storage.local` (single-writer, the SW)

```
kyoto.cron.jobs = {
  <jobId>: {
    id: '<uuid>',
    name: 'crunchyroll-auth-refresh',
    schedule: { every: '25m' } | { cron: '0 * * * *' },
    code: 'await K.state.set("cr.token", await K.tools.page_eval({...}))',
    paused: false,
    createdAt: 1779000000000,
    lastRunAt: null,
    nextRunAt: 1779001500000,
    consecutiveFailures: 0,
    notes: 'Refreshes Crunchyroll session every 25min while the
            crunchyroll.com tab is open.',
  },
  ...
}

kyoto.cron.state = {
  <key>: {
    value: <json-serializable>,
    writtenAt: 1779001500000,
    ttlMs: 1800000,          // optional
    writtenBy: 'jobId' | 'agent' | 'tool:<name>'
  },
  ...
}

kyoto.cron.runtime = {
  lastReconcileAt: 1779000000000,
  nextGcAt: 1779003600000,
  // any other "is the scheduler healthy" flags
}
```

### `KyotoVFS` (IndexedDB) for per-job logs

One path per job, append-only ring of recent runs:

```
/cron/<jobId>/runs.jsonl
```

Each line is:

```json
{ "ts": 1779001500000, "ok": true, "ms": 412, "stdout": "...", "stderr": null }
```

Cap at 200 lines per job; trim oldest on append. Job stdout/stderr is
just whatever the job's code writes via `K.log(...)` or `K.stderr(...)`.

## Tool surface

All registered under group `cron`, all in `sidepanel/tools/cron.js`.

| Tool | Args | Returns |
|---|---|---|
| `cron_add` | `{ name, schedule: {every?:STR \| cron?:STR}, code:STR, notes?:STR, paused?:BOOL }` | `{ id, nextRunAt }` |
| `cron_list` | `{ includePaused?:BOOL }` | `{ jobs: [{id,name,schedule,paused,lastRunAt,nextRunAt,consecutiveFailures}] }` |
| `cron_get` | `{ id }` | full job record |
| `cron_remove` | `{ id }` | `{ removed: true }` |
| `cron_pause` / `cron_resume` | `{ id }` | updated job |
| `cron_run_now` | `{ id, async?:BOOL }` | run result (or `{queued:true}` if async) |
| `cron_logs` | `{ id, limit?:NUM, sinceMs?:NUM }` | `{ runs: [...] }` |
| `cron_status` | `{}` | summary table of all jobs incl. next/last run, failure counts |
| `state_set` | `{ key, value, ttlMs?:NUM }` | `{ ok, writtenAt }` |
| `state_get` | `{ key }` | `{ value, writtenAt, ttlMs, expired }` or `{ missing: true }` |
| `state_list` | `{ prefix?:STR }` | `{ keys: [{key, writtenAt, expired}] }` |
| `state_delete` | `{ key }` | `{ deleted: BOOL }` |

`state_*` is intentionally also useful outside cron — the agent can
read/write the same store directly from chat.

## Job execution model

When an alarm fires for `<jobId>`, the dispatcher:

1. Loads the job spec.
2. Builds a `K` sandbox object:
   ```ts
   K = {
     tools: <ProxyObject>,    // K.tools.network_fetch({...}) etc.
     state: { get, set, delete, list },
     log:    (...args) => /* writes to current run's stdout buffer */,
     stderr: (...args) => /* writes to current run's stderr buffer */,
     now:    () => Date.now(),
     job:    { id, name, lastRunAt },
     // intentionally no eval, no fetch (use K.tools.network_fetch),
     // no chrome.* (use K.tools.*) — keeps the surface auditable
   }
   ```
3. Evaluates `code` as an async function body with `K` in scope:
   ```js
   new AsyncFunction('K', code)(K)
   ```
4. Captures stdout, stderr, duration, error.
5. Writes a run record to `/cron/<jobId>/runs.jsonl`.
6. Updates `lastRunAt`, `consecutiveFailures` (reset on success,
   `++` on failure).
7. If `consecutiveFailures >= 5`, sets `paused: true` and writes a
   loud line to the log explaining why.

## Scheduling

We wrap `chrome.alarms` so the agent can write either:

- `schedule: { every: '25m' }` — runs every 25 minutes
  → `chrome.alarms.create('kyoto-cron:<id>', { periodInMinutes: 25 })`
- `schedule: { cron: '0 9 * * 1-5' }` — weekdays 9am
  → we keep a 1-minute master alarm (`kyoto-cron:master`) and on each
    tick check which cron jobs are due, fire those.

`every` is exact; `cron` is "fires within the minute after due". 30s
minimum (chrome.alarms limit) applies to both.

On SW startup we **reconcile**: read `kyoto.cron.jobs`, ensure each
non-paused, non-cron job has a matching alarm; cancel orphan alarms;
ensure the master alarm exists if any cron-format job exists.

## Failure handling

- **Per-run timeout**: 5 minutes default, configurable in the job spec
  (`timeoutMs`). Same wall-clock guard pattern already used in the
  chat-loop tool race.
- **Exponential backoff on failure**: not by rescheduling alarms (that
  fights with the configured period) but by SKIPPING the next N runs
  proportional to `consecutiveFailures`. Predictable + easy to reason
  about.
- **Auto-pause threshold**: 5 consecutive failures → `paused: true`.
  Agent / user can resume.
- **Last error visible**: kept on the job record as
  `lastError: { ts, message, stack? }`.

## Storage hygiene

- Run history capped at 200 entries per job; oldest trimmed on append.
- Tombstoning: deleted jobs leave their `/cron/<id>/runs.jsonl` for 24h
  then GC'd by the SW on next reconcile.
- State store: if `ttlMs` is set and expired, `state_get` returns
  `expired: true`. The agent / job decides what to do.

## UI (Settings drawer)

Minimal, read-mostly:

```
Settings → Background jobs
┌─────────────────────────────────────────────────────────────┐
│ ● crunchyroll-auth-refresh   every 25m   ran 14m ago  ✓   │
│   ○ scrape-twitter-likes    cron 0 * * *  ran 53m ago  ✗   │  ← red, click for last error
│   ○ check-deploys           every 5m     PAUSED            │
│   [ + Add job ]   [ Refresh ]                              │
└─────────────────────────────────────────────────────────────┘
```

Click a row → drawer with full code, recent run log, pause/resume/
delete/run-now buttons. The code field is plain text; you edit it,
save, the SW reschedules.

V1 can skip the UI entirely — the agent surfaces everything via
`cron_status` — but the UI is high-value and small (~150 lines). Build
both.

## Files we'll touch / create

```
sidepanel/tools/cron.js          NEW  — registers cron_* + state_* tools
background.js                    EDIT — add CronEngine init + alarm listener
background/cron-engine.js        NEW  — scheduler + dispatcher + reconcile
background/state-store.js        NEW  — thin wrapper around chrome.storage.local
                                        for kyoto.cron.state with TTL
sidepanel/sidepanel.html         EDIT — new drawer section "Background jobs"
sidepanel/sidepanel.js           EDIT — drawer UI + TAB_AWARE_TOOLS for any
                                        cron tools that resolve the active tab
                                        (probably none — jobs specify tabs
                                        explicitly)
manifest.json                    EDIT — bump version; `alarms` permission
                                        already declared ✓
test/cron-tool.test.js           NEW  — sandbox tests against the in-process
                                        engine (vm harness pattern matches
                                        existing tests)
test/state-store.test.js         NEW  — TTL + read/write
```

## Implementation order (small, shippable cuts)

1. **State store + state_* tools** (1–2 hr). No scheduler yet. Just a
   wrapper around `chrome.storage.local` with TTL and a clean tool
   surface. Useful immediately — agent can use it for memos.
2. **CronEngine: schedule + dispatch only** (3–4 hr). `every` schedules
   only, no cron expressions. Logs to KyotoVFS. No UI. Tools:
   `cron_add`, `cron_list`, `cron_remove`, `cron_run_now`, `cron_logs`.
3. **Failure handling + auto-pause** (1 hr). Counter + backoff +
   auto-pause threshold.
4. **`cron_pause` / `cron_resume` / `cron_status` / `cron_get`** (30 min).
5. **Cron expression support** (2–3 hr). Add master 1-minute tick that
   evaluates cron exprs against current time. Small parser, or take a
   tiny dep (e.g. `cron-parser` if we vendor it — it's pure JS).
6. **Settings UI** (3–4 hr). Read/write panel; live status; per-job
   drawer.
7. **GC + storage hygiene** (1 hr). Per-SW-startup pass.

Total: roughly 1.5–2 dev days if focused.

## Concrete worked example: Crunchyroll auth refresher

The pattern the user originally wanted, fully expressed in this system:

**Auth refresher (browser-bound, runs in extension)**
```js
// cron_add({
//   name: 'crunchyroll-auth-refresh',
//   schedule: { every: '25m' },
//   code: <below>
// })

const tabs = await K.tools.tabs_list({ urlPattern: '*://www.crunchyroll.com/*' });
if (!tabs.tabs?.length) { K.log('no CR tab open, skipping'); return; }
const tabId = tabs.tabs[0].id;

const r = await K.tools.page_eval({
  tabId,
  code: `
    const auth = await fetch('https://www.crunchyroll.com/auth/v1/token', {
      method:'POST',
      headers:{'Authorization':'Basic '+btoa('noaihdevm_6iyg0a8l0q:'),
               'Content-Type':'application/x-www-form-urlencoded'},
      body:'grant_type=etp_rt_cookie', credentials:'include'
    }).then(r=>r.json());
    auth.access_token
  `
});
if (r.ok && r.result) {
  await K.state.set('crunchyroll.access_token', r.result, { ttlMs: 25 * 60 * 1000 });
  K.log('refreshed access token, len=' + r.result.length);
} else {
  throw new Error('refresh failed: ' + JSON.stringify(r));
}
```

**Scraper (could be browser-side too, or any agent flow)**
```js
const tok = await K.state.get('crunchyroll.access_token');
if (!tok || tok.expired) {
  K.log('no fresh token, waiting for next refresher tick');
  return;
}
const data = await K.tools.network_fetch({
  url: 'https://www.crunchyroll.com/content/v2/discover/recent',
  headers: { 'Authorization': 'Bearer ' + tok.value }
});
await K.tools.fs_write({ path: '/scrape/cr/recent.json',
                         content: JSON.stringify(data) });
```

The agent registered both. They share state through `kyoto.cron.state`.
The scraper doesn't need to know how the token was obtained; the
refresher doesn't need to know who consumes it.

## Test strategy

Same vm-sandbox pattern as existing tests:

- Stub `chrome.alarms` with an in-memory scheduler that advances a
  fake clock.
- Stub `chrome.storage.local` with an in-memory Map.
- Tests assert:
  - `cron_add` writes the spec, creates the alarm, returns `nextRunAt`.
  - Firing the alarm runs the code, captures stdout, appends a run row.
  - 5 consecutive failures auto-pauses.
  - TTL expiry is visible via `state_get { expired: true }`.
  - Reconcile after SW restart re-creates alarms for stored jobs.
  - Cron expression matches "now ± 30s" → fires; outside window → skip.

No real Chrome needed for any of this.

## Decisions still needed (please answer before I start)

1. **Job code language**: JS string evaluated in the SW with `K`. OR
   a small DSL ("run tool X, store result in state key Y"). JS is
   universal and flexible but means jobs can do anything; DSL is safer
   and self-documenting but limited.
   **Default if you don't pick**: JS string.
2. **Master cron-tick precision**: 1 minute (most cron tools) or 30
   seconds (max chrome.alarms precision)? Doesn't matter for almost
   all real jobs.
   **Default**: 1 minute.
3. **Storage budget**: ~5MB for chrome.storage.local is shared with
   the rest of Kyoto. Run logs go to IndexedDB so they don't eat it,
   but job code itself + state will. Cap state values to say 50KB each?
   **Default**: 50KB per value, warn at 80%.
4. **Failure threshold for auto-pause**: 5 default OK? Some folks want
   3, some want 20.
   **Default**: 5, settable per-job (`autoPauseAfter`).
5. **Job-name uniqueness**: enforced or allowed-with-warning? Slugs
   helpful for logs.
   **Default**: enforced, lowercase-with-hyphens slug derived from name.
6. **First real use case to drive the design**: Crunchyroll? GitHub
   stars? A specific dashboard? Build *with* a real consumer or this
   ends up over-abstracted.

## Out of scope (deliberately)

- Cross-device sync of jobs.
- Running jobs when Chrome is fully closed (would need native daemon).
- A real cron expression language with the long form (`@yearly` etc.).
  Add later if useful.
- Audit / approval flow for job code. Single-user single-machine; if
  the agent or user writes a job, it runs.
- Distributed locking, multi-replica, scaling. There's one SW.

## Risks

- **chrome.storage.local quota** if jobs proliferate or someone writes
  huge state values. Mitigated by per-value cap + IndexedDB for logs.
- **Service worker thrash**: cron with 30s precision means SW wakes
  every 30s if you have any cron-format jobs. Acceptable; alternative
  is to only wake on demand.
- **Job code can call `K.tools.shell_exec`** etc. — i.e. anything the
  agent can do. That's intentional: same trust model as in-chat tool
  use. Worth noting in the docs.
- **Migrations**: if we change the job schema, we need a one-shot
  migrator on SW startup. Bake a `_schemaVersion` into stored records
  from day one.
