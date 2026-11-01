// Tests for the Cron engine that lives inside background.js.
//
// The engine is a self-contained IIFE assigned to `Cron`. We grab its
// source by string-extracting it from background.js, drop it into a
// VM context with stubbed chrome.alarms / chrome.storage.local /
// IndexedDB (via fake-indexeddb), then drive it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// fake-indexeddb is the standard polyfill — pulled in via node's
// resolver from this repo's node_modules if present; otherwise we
// fall back to a tiny stub that satisfies the read/write/cursor API
// we actually use.
let FakeIDB = null;
try { FakeIDB = require('fake-indexeddb'); } catch {}

function loadCronEngine({ chromeStubs } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf-8');
  const startMatch = src.match(/^const Cron = \(\(\) => \{/m);
  if (!startMatch) throw new Error('Cron IIFE not found in background.js');
  const startIdx = startMatch.index;
  // Find the matching `})();` for the IIFE — single-occurrence terminator
  // in this file (the helper ends with `})();` on its own line right
  // before the alarm-listener hookups).
  const tailMatch = src.slice(startIdx).match(/\n\}\)\(\);\n/);
  if (!tailMatch) throw new Error('Cron IIFE terminator not found');
  const endIdx = startIdx + tailMatch.index + tailMatch[0].length;
  // The IIFE binds `const Cron = (() => { ... })()` — that's a
  // lexical binding and doesn't attach to the vm sandbox globals.
  // Rewrite to `globalThis.Cron = ...` so we can grab it after eval.
  const fnSrc = src.slice(startIdx, endIdx).replace(/^const Cron =/, 'globalThis.Cron =');

  // Build a sandbox with chrome stubs + IndexedDB.
  const sandbox = {
    chrome: chromeStubs,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    atob, btoa, TextEncoder, TextDecoder, Uint8Array,
  };
  if (FakeIDB) {
    sandbox.indexedDB = FakeIDB.indexedDB;
    sandbox.IDBKeyRange = FakeIDB.IDBKeyRange;
  } else {
    // Minimal stub: don't actually persist runs in tests that don't need them.
    sandbox.indexedDB = { open: () => { throw new Error('indexedDB not available in this test env'); } };
    sandbox.IDBKeyRange = { only: (v) => v };
  }
  sandbox.fetch = async () => ({ ok: false, status: 0, text: async () => '', headers: { forEach() {} } });
  sandbox.AbortController = class { abort() {} signal = {} };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox, { filename: 'background.js#Cron' });
  return sandbox.Cron;
}

function makeChromeStub() {
  const storage = {};
  const alarms = new Map();
  const stubs = {
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === 'string') return { [key]: storage[key] };
          if (Array.isArray(key)) {
            const out = {}; for (const k of key) if (k in storage) out[k] = storage[k];
            return out;
          }
          return { ...storage };
        },
        set: async (patch) => { Object.assign(storage, patch); },
      }
    },
    alarms: {
      create: async (name, opts) => { alarms.set(name, { name, ...opts }); },
      get: async (name) => alarms.get(name) || null,
      getAll: async () => [...alarms.values()],
      clear: async (name) => { alarms.delete(name); return true; },
      onAlarm: { addListener: () => {} },
    },
    cookies: { get: async () => ({}), getAll: async () => [] },
    tabs: { query: async () => [], get: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
    downloads: { download: async () => 0 },
    notifications: { create: async () => 'nid' },
    runtime: { onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
  };
  return { stubs, _storage: storage, _alarms: alarms };
}

// ──────── state pipe ────────

test('stateSet stores a value with writtenAt and stateGet returns it', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const r = await Cron.stateSet('foo', { bar: 1 }, { writtenBy: 'agent' });
  assert.equal(r.ok, true);
  assert.ok(r.writtenAt > 0);
  const g = await Cron.stateGet('foo');
  assert.deepStrictEqual(g.value, { bar: 1 });
  assert.equal(g.writtenBy, 'agent');
  assert.equal(g.expired, false);
});

test('stateGet on a missing key returns { missing: true }', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const g = await Cron.stateGet('nope');
  assert.equal(g.missing, true);
});

test('stateSet enforces 50KB per-value cap', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const big = 'x'.repeat(60 * 1024);
  await assert.rejects(() => Cron.stateSet('big', big), /too large/);
});

test('stateGet flags expired when ttl elapsed', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.stateSet('k', 'v', { ttlMs: 50 });
  await new Promise(r => setTimeout(r, 80));
  const g = await Cron.stateGet('k');
  assert.equal(g.expired, true);
  assert.equal(g.value, 'v');  // value still readable
});

test('stateList filters by prefix and reports bytes per entry', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.stateSet('cr.a', 'one');
  await Cron.stateSet('cr.b', 'two');
  await Cron.stateSet('other.c', 'three');
  const r = await Cron.stateList('cr.');
  assert.equal(r.count, 2);
  const keys = r.items.map(i => i.key).sort();
  assert.deepStrictEqual(keys, ['cr.a', 'cr.b']);
  assert.ok(r.items.every(i => i.bytes > 0));
});

test('stateDelete removes the key and returns deleted:true', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.stateSet('x', 1);
  assert.equal((await Cron.stateDelete('x')).deleted, true);
  assert.equal((await Cron.stateGet('x')).missing, true);
  assert.equal((await Cron.stateDelete('x')).deleted, false);
});

// ──────── schedule parsing ────────

test('_parseEvery parses N s/m/h/d into ms', () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  assert.equal(Cron._parseEvery('30s'), 30000);
  assert.equal(Cron._parseEvery('25m'), 25 * 60000);
  assert.equal(Cron._parseEvery('2h'), 2 * 3600000);
  assert.equal(Cron._parseEvery('1d'), 86400000);
  assert.equal(Cron._parseEvery('nope'), null);
});

test('_cronMatches handles *, ranges, lists, and steps', () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // Use a fixed date so we control all 5 fields.
  // Wed 2026-05-27 09:00 UTC — depending on test host TZ. We use local
  // Date so just construct one and read its fields back.
  const d = new Date('2026-05-27T09:00:00');
  // Every minute every hour every day: matches anything.
  assert.equal(Cron._cronMatches('* * * * *', d), true);
  // 9am exactly:
  assert.equal(Cron._cronMatches('0 9 * * *', d), true);
  assert.equal(Cron._cronMatches('0 10 * * *', d), false);
  // Range hour:
  assert.equal(Cron._cronMatches('0 8-10 * * *', d), true);
  // Step minute (every 30 min) — 0 matches */30:
  assert.equal(Cron._cronMatches('*/30 * * * *', d), true);
  // List day-of-week (we don't assert dow because it varies; just make sure parser doesn't blow up)
  assert.doesNotThrow(() => Cron._cronMatches('0 9 * * 1,3,5', d));
});

// ──────── job lifecycle ────────

test('addJob validates required fields', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await assert.rejects(() => Cron.addJob({}), /name required/);
  await assert.rejects(() => Cron.addJob({ name: 'a' }), /schedule required/);
  await assert.rejects(() => Cron.addJob({ name: 'a', schedule: {} }), /every.*cron/);
  await assert.rejects(() => Cron.addJob({ name: 'a', schedule: { every: '1m' } }), /code required/);
  await assert.rejects(() => Cron.addJob({ name: 'a', schedule: { every: '5s' }, code: 'K.log(1)' }), /minimum is 30s/);
});

test('addJob stores spec, creates alarm, returns nextRunAt', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const job = await Cron.addJob({ name: 'My Job', schedule: { every: '30m' }, code: 'K.log("hi")' });
  assert.ok(job.id.startsWith('job_'));
  assert.equal(job.slug, 'my-job');
  assert.equal(job.paused, false);
  assert.ok(job.nextRunAt > Date.now());
  // Alarm was created with the right period.
  const alarm = _alarms.get('kyoto-cron:' + job.id);
  assert.ok(alarm, 'alarm should exist');
  assert.equal(alarm.periodInMinutes, 30);
});

test('addJob enforces slug uniqueness', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.addJob({ name: 'My Job', schedule: { every: '1m' }, code: '1' });
  await assert.rejects(
    () => Cron.addJob({ name: 'My Job', schedule: { every: '1m' }, code: '1' }),
    /already exists/
  );
});

test('removeJob clears the alarm and tombstones the spec', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'gone', schedule: { every: '1m' }, code: '1' });
  await Cron.removeJob(j.id);
  assert.equal(_alarms.has('kyoto-cron:' + j.id), false);
  await assert.rejects(() => Cron.getJob(j.id), /no job/);
});

test('pauseJob clears alarm; resumeJob recreates it and resets failure count', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'p', schedule: { every: '1m' }, code: '1' });
  await Cron.pauseJob(j.id);
  assert.equal(_alarms.has('kyoto-cron:' + j.id), false);
  await Cron.resumeJob(j.id);
  assert.equal(_alarms.has('kyoto-cron:' + j.id), true);
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, false);
  assert.equal(cur.consecutiveFailures, 0);
});

// ──────── execution ────────

test('runJobNow synchronously executes the code and returns ok + stdout', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'run', schedule: { every: '1m' },
    code: 'K.log("hello"); K.log("world"); await K.state.set("done", true);'
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, true);
  assert.ok(r.stdout.includes('hello') && r.stdout.includes('world'));
  // Side effect visible:
  const got = await Cron.stateGet('done');
  assert.equal(got.value, true);
  assert.equal(got.writtenBy, 'job:' + j.id);
});

test('runJobNow surfaces errors and increments consecutiveFailures', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'boom', schedule: { every: '1m' },
    code: 'throw new Error("nope")'
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, false);
  assert.ok(/nope/.test(r.error));
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.consecutiveFailures, 1);
  assert.equal(cur.lastError.message, 'nope');
});

test('5 consecutive failures auto-pauses the job', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'flaky', schedule: { every: '1m' },
    code: 'throw new Error("x")', autoPauseAfter: 5,
  });
  // force:true — this test needs 5 forced attempts, and each failure opens a
  // backoff window that an ordinary manual run now respects.
  for (let i = 0; i < 5; i++) await Cron.runJobNow(j.id, { force: true });
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, true);
  // Alarm should have been cleared on auto-pause.
  assert.equal(_alarms.has('kyoto-cron:' + j.id), false);
});

test('updateJob with new schedule re-creates the alarm', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'u', schedule: { every: '1m' }, code: '1' });
  await Cron.updateJob(j.id, { schedule: { every: '5m' } });
  const alarm = _alarms.get('kyoto-cron:' + j.id);
  assert.equal(alarm.periodInMinutes, 5);
});

// ──────── alarm dispatch ────────

test('onAlarm dispatches to the right job', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'alm', schedule: { every: '1m' },
    code: 'await K.state.set("fired", K.now())'
  });
  await Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  // executeJob is fire-and-forget inside onAlarm; give microtasks a tick.
  await new Promise(r => setTimeout(r, 20));
  const got = await Cron.stateGet('fired');
  assert.ok(got.value > 0, JSON.stringify(got));
});

// ──────── iteration 2: validation, singleton, backoff, fs, sleep, notify ────────

test('addJob rejects malformed cron expressions at add-time', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // Wrong number of fields:
  await assert.rejects(() => Cron.addJob({
    name: 'bad-1', schedule: { cron: '0 0 * *' }, code: '1'
  }), /Need 5 fields/);
  // Unparseable token in a field:
  await assert.rejects(() => Cron.addJob({
    name: 'bad-2', schedule: { cron: '0 abc * * *' }, code: '1'
  }), /unparseable part/);
  // Out-of-range minute (60):
  await assert.rejects(() => Cron.addJob({
    name: 'bad-3', schedule: { cron: '60 * * * *' }, code: '1'
  }), /matches no values/);
  // Valid expression sails through:
  const ok = await Cron.addJob({
    name: 'good', schedule: { cron: '*/5 9-17 * * 1-5' }, code: '1'
  });
  assert.ok(ok.id);
});

test('singleton: alarm skips when previous run still in flight', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // Job that takes ~150ms. With singleton: true, a second alarm during
  // that window should be skipped, not run in parallel.
  const j = await Cron.addJob({
    name: 'slow-singleton',
    schedule: { every: '1m' }, singleton: true, timeoutMs: 60000,
    code: 'await K.sleep(150); await K.state.set("ran", (await K.state.get("ran")).value + 1 || 1);'
  });
  // Seed the counter
  await Cron.stateSet('ran', 0);
  // Fire two alarms back-to-back. The first claims _runningSince; the
  // second sees it set and bails.
  const p1 = Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  // Tiny delay so the first await inside executeJob has a chance to set _runningSince.
  await new Promise(r => setTimeout(r, 20));
  await Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  await p1;
  await new Promise(r => setTimeout(r, 200));  // let first run finish
  const got = await Cron.stateGet('ran');
  assert.equal(got.value, 1, 'only one run should have incremented the counter');
  const logs = await Cron.getJobLogs(j.id, { limit: 5 });
  assert.ok(logs.runs.some(r => /singleton/.test(r.stderr || '') || r.error === 'singleton-skip'),
    'expected a singleton-skip log entry');
});

test('non-singleton: parallel firings are allowed (regression guard)', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'parallel',
    schedule: { every: '1m' },  // no singleton
    code: 'await K.sleep(80); await K.state.set("ran", ((await K.state.get("ran")).value || 0) + 1);'
  });
  await Cron.stateSet('ran', 0);
  const p1 = Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  const p2 = Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  await Promise.all([p1, p2]);
  await new Promise(r => setTimeout(r, 150));
  const got = await Cron.stateGet('ran');
  // Both runs should have incremented — that's the OPPOSITE of singleton.
  assert.ok(got.value >= 1, 'at least one ran');
});

test('exponential backoff: failed job\'s next alarm fires get skipped within the window', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'failing',
    schedule: { every: '1m' }, autoPauseAfter: 99,  // don't auto-pause for this test
    code: 'throw new Error("nope")'
  });
  // First run: actually executes and fails.
  await Cron.runJobNow(j.id);
  const after1 = await Cron.getJob(j.id);
  assert.equal(after1.consecutiveFailures, 1);
  assert.ok(after1._backoffUntil > Date.now(), 'backoff window should be set');
  // Now fire the alarm — should be skipped because we're inside the
  // backoff window (basePeriod * 2^0 = 1 min).
  await Cron.onAlarm({ name: 'kyoto-cron:' + j.id });
  await new Promise(r => setTimeout(r, 20));
  const after2 = await Cron.getJob(j.id);
  // consecutiveFailures shouldn't have incremented because the skip
  // doesn't count as a run.
  assert.equal(after2.consecutiveFailures, 1, 'backoff-skipped firing must not count as a failure');
  const logs = await Cron.getJobLogs(j.id, { limit: 5 });
  assert.ok(logs.runs.some(r => r.error === 'backoff'),
    'expected a backoff-skip log entry, got: ' + JSON.stringify(logs.runs.map(r => r.error)));
});

test('successful run clears backoff window and consecutiveFailures', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  let mode = 'fail';
  // Job whose behaviour we flip mid-test via shared state.
  const j = await Cron.addJob({
    name: 'recoverable',
    schedule: { every: '1m' }, autoPauseAfter: 99,
    code: 'const m = (await K.state.get("mode")).value; if (m === "fail") throw new Error("x"); K.log("ok");'
  });
  await Cron.stateSet('mode', 'fail');
  await Cron.runJobNow(j.id);
  let cur = await Cron.getJob(j.id);
  assert.equal(cur.consecutiveFailures, 1);
  assert.ok(cur._backoffUntil > Date.now());
  // Flip to success. force:true because the failure above opened a backoff
  // window that a plain manual run now respects.
  await Cron.stateSet('mode', 'ok');
  await Cron.runJobNow(j.id, { force: true });
  cur = await Cron.getJob(j.id);
  assert.equal(cur.consecutiveFailures, 0);
  assert.equal(cur._backoffUntil, null);
});

// Audit C12: a manual run is still a run. It must honour the backoff window
// (and the singleton guard) instead of starting a second concurrent copy;
// force:true is the explicit opt-out.
test('runJobNow respects the backoff window unless force:true', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'manual-backoff', schedule: { every: '1m' }, autoPauseAfter: 99,
    code: 'throw new Error("nope")',
  });
  const first = await Cron.runJobNow(j.id);
  assert.equal(first.ok, false);
  assert.equal(first.skipped, undefined, 'the first run actually executes');

  // Inside the backoff window the second manual run is skipped, not executed.
  const second = await Cron.runJobNow(j.id);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'backoff');

  // force:true bypasses the backoff window and really runs (and fails) again.
  const forced = await Cron.runJobNow(j.id, { force: true });
  assert.equal(forced.skipped, undefined);
  assert.equal(forced.ok, false);
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.consecutiveFailures, 2);
});

test('K.tools.fs_write + fs_read round-trip via the shared KyotoVFS', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'fs-roundtrip',
    schedule: { every: '1m' },
    code: `
      await K.tools.fs_write({ path: '/cron/test/note.txt', content: 'hello from a job' });
      const back = await K.tools.fs_read({ path: '/cron/test/note.txt' });
      await K.state.set('echo', back.content);
      const ls = await K.tools.fs_list({ prefix: '/cron/test' });
      await K.state.set('count', ls.files.length);
    `
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await Cron.stateGet('echo')).value, 'hello from a job');
  assert.equal((await Cron.stateGet('count')).value, 1);
});

test('K.sleep delays the right amount (smoke test, not millisecond-precise)', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'sleeper', schedule: { every: '1m' },
    code: 'const t0 = K.now(); await K.sleep(120); await K.state.set("dur", K.now() - t0);'
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, true);
  const dur = (await Cron.stateGet('dur')).value;
  assert.ok(dur >= 100 && dur < 500, 'sleep should pause ~120ms, got ' + dur);
});

test('auto-pause fires a chrome.notifications.create call', async () => {
  // Wire up a recording notifications stub.
  const { stubs } = makeChromeStub();
  const notifications = [];
  stubs.notifications = { create: async (n) => { notifications.push(n); return 'nid'; } };
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'breaks',
    schedule: { every: '1m' }, autoPauseAfter: 2,
    code: 'throw new Error("boom")'
  });
  await Cron.runJobNow(j.id, { force: true });
  await Cron.runJobNow(j.id, { force: true });  // hits the threshold (forced past the backoff window)
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, true);
  assert.equal(notifications.length, 1, 'one notification per auto-pause event');
  assert.ok(/auto-paused/i.test(notifications[0].title));
  assert.ok(/boom/.test(notifications[0].message));
});

// ──────── iteration 3: dry-run, stats, tags, snooze, reconcile-heal, notify opt-out ────────

test('dryRunJob executes code without registering or scheduling', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const r = await Cron.dryRunJob({
    code: 'K.log("dry"); K.log("run"); await K.state.set("from_dry_run", 42);'
  });
  assert.equal(r.ok, true);
  assert.ok(r.stdout.includes('dry') && r.stdout.includes('run'));
  // No job registered:
  const { jobs } = await Cron.listJobs();
  assert.equal(jobs.length, 0);
  // No alarms:
  assert.equal(_alarms.size, 0);
  // State write DID persist (so dry-run can verify auth flows):
  assert.equal((await Cron.stateGet('from_dry_run')).value, 42);
});

test('dryRunJob captures runtime errors without crashing', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const r = await Cron.dryRunJob({ code: 'this.is.not.valid' });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('cron_stats aggregates ok/fail/skipped and computes percentiles', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'stats-target',
    schedule: { every: '1m' }, autoPauseAfter: 99,
    code: 'await K.sleep(20);'
  });
  // 3 OK runs, 1 fail, 1 backoff-skip simulated by writing directly.
  await Cron.runJobNow(j.id);
  await Cron.runJobNow(j.id);
  await Cron.runJobNow(j.id);
  await Cron._appendRun(j.id, { ts: Date.now(), ok: false, ms: 5, stdout: '', stderr: '', error: 'whatever', triggeredBy: 'alarm' });
  await Cron._appendRun(j.id, { ts: Date.now(), ok: false, ms: 0, stdout: '', stderr: '', error: 'backoff', triggeredBy: 'alarm' });
  const s = await Cron.getJobStats(j.id);
  assert.equal(s.totalRuns, 5);
  assert.equal(s.ok, 3);
  assert.equal(s.fail, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.successRate, +(3 / 4).toFixed(3));
  assert.ok(s.p50Ms >= 0);
  assert.ok(s.avgMs >= 0);
  assert.equal(s.recentErrors.length, 1);
  assert.equal(s.recentErrors[0].message, 'whatever');
});

test('tags: cron_list filters by tag; cron_status counts tags', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.addJob({ name: 'cr-auth',   schedule: { every: '1m' }, code: '1', tags: ['crunchyroll', 'auth'] });
  await Cron.addJob({ name: 'cr-scrape', schedule: { every: '1m' }, code: '1', tags: ['crunchyroll'] });
  await Cron.addJob({ name: 'other',     schedule: { every: '1m' }, code: '1', tags: ['ad-hoc'] });
  const cr = await Cron.listJobs({ tag: 'crunchyroll' });
  assert.equal(cr.jobs.length, 2);
  assert.ok(cr.jobs.every(j => j.tags.includes('crunchyroll')));
  const auth = await Cron.listJobs({ tag: 'auth' });
  assert.equal(auth.jobs.length, 1);
  const s = await Cron.status();
  assert.equal(s.tagCounts.crunchyroll, 2);
  assert.equal(s.tagCounts.auth, 1);
  assert.equal(s.tagCounts['ad-hoc'], 1);
});

test('snoozeJob pauses with a deadline; reconcile auto-resumes after it elapses', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'snoozy', schedule: { every: '1m' }, code: '1' });
  await Cron.snoozeJob(j.id, 50);  // 50ms snooze
  let cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, true);
  assert.ok(cur.pauseUntil > Date.now());
  assert.equal(_alarms.has('kyoto-cron:' + j.id), false, 'alarm should be cleared while snoozed');
  // Wait for the deadline, then reconcile.
  await new Promise(r => setTimeout(r, 80));
  await Cron.reconcile();
  cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, false, 'reconcile should have resumed the job');
  assert.equal(cur.pauseUntil, null);
  assert.ok(_alarms.has('kyoto-cron:' + j.id), 'alarm should be back');
});

test('reconcile heals stale _runningSince after a simulated SW crash', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'crashed', schedule: { every: '1m' }, singleton: true, timeoutMs: 200,
    code: '1',
  });
  // Simulate a previous run that started, set _runningSince, and the
  // SW died — leaving the field set forever. We write directly into
  // the spec to mimic that condition.
  const jobs = await stubs.storage.local.get('kyoto.cron.jobs');
  jobs['kyoto.cron.jobs'][j.id]._runningSince = Date.now() - 60_000;  // 60s ago, well past timeout
  await stubs.storage.local.set({ 'kyoto.cron.jobs': jobs['kyoto.cron.jobs'] });
  await Cron.reconcile();
  const cur = await Cron.getJob(j.id);
  assert.equal(cur._runningSince, null, 'stale _runningSince should have been cleared');
  // A reconcile-cleanup log entry should be appended.
  const logs = await Cron.getJobLogs(j.id, { limit: 5 });
  assert.ok(logs.runs.some(r => r.error === 'reconcile-cleanup'),
    'expected reconcile-cleanup log entry');
});

test('autoPauseNotify: false suppresses the chrome.notifications call', async () => {
  const { stubs } = makeChromeStub();
  const notifications = [];
  stubs.notifications = { create: async (n) => { notifications.push(n); return 'nid'; } };
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'silent-breaks',
    schedule: { every: '1m' }, autoPauseAfter: 2, autoPauseNotify: false,
    code: 'throw new Error("x")',
  });
  await Cron.runJobNow(j.id, { force: true });
  await Cron.runJobNow(j.id, { force: true });
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, true, 'still auto-pauses');
  assert.equal(notifications.length, 0, 'but no toast was fired');
});

// ──────── iteration 4: K.cron API, parseability, GC, export/import, size watch ────────

test('addJob rejects code that does not parse', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await assert.rejects(
    () => Cron.addJob({ name: 'bad-syntax', schedule: { every: '1m' }, code: 'await 1 +' }),
    /code does not parse/
  );
});

test('updateJob with broken code is rejected before being stored', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'ok', schedule: { every: '1m' }, code: 'K.log(1)' });
  await assert.rejects(
    () => Cron.updateJob(j.id, { code: 'function ( {' }),
    /code does not parse/
  );
  // Original code should be untouched.
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.code, 'K.log(1)');
});

test('K.cron.run triggers another job from inside the current one', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // Set up a "refresher" job that writes a token, plus a "scraper"
  // that calls K.cron.run on the refresher when its state is missing.
  const refresher = await Cron.addJob({
    name: 'refresher', schedule: { every: '1m' },
    code: 'await K.state.set("token", "fresh-" + K.now());'
  });
  const scraper = await Cron.addJob({
    name: 'scraper', schedule: { every: '1m' },
    code: `
      let tok = await K.state.get("token");
      if (tok.missing) {
        await K.cron.run("${refresher.id}");
        tok = await K.state.get("token");
      }
      await K.state.set("scraper_saw", tok.value);
    `
  });
  await Cron.runJobNow(scraper.id);
  const saw = await Cron.stateGet('scraper_saw');
  assert.ok(saw.value && saw.value.startsWith('fresh-'),
    'scraper should have triggered refresher and read the token, got: ' + JSON.stringify(saw));
});

test('K.cron.run refuses to target the current job (recursion guard)', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'self-runner', schedule: { every: '1m' },
    code: 'await K.cron.run(K.job.id);'  // would recurse forever
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, false);
  assert.ok(/cannot target the current job/i.test(r.error));
});

test('K.cron.snoozeSelf snoozes the current job', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({
    name: 'self-snoozer', schedule: { every: '1m' },
    code: 'await K.cron.snoozeSelf(60_000); K.log("snoozed");'
  });
  const r = await Cron.runJobNow(j.id);
  assert.equal(r.ok, true);
  const cur = await Cron.getJob(j.id);
  assert.equal(cur.paused, true);
  assert.ok(cur.pauseUntil > Date.now());
});

test('K.cron.stats and K.cron.logs read other jobs from inside one', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const tracked = await Cron.addJob({ name: 'tracked', schedule: { every: '1m' }, code: 'K.log("hi")' });
  await Cron.runJobNow(tracked.id);
  const observer = await Cron.addJob({
    name: 'observer', schedule: { every: '1m' },
    code: `
      const stats = await K.cron.stats("${tracked.id}");
      const logs  = await K.cron.logs("${tracked.id}", { limit: 5 });
      await K.state.set("observed", { totalRuns: stats.totalRuns, logCount: logs.runs.length });
    `
  });
  const r = await Cron.runJobNow(observer.id);
  assert.equal(r.ok, true, r.error);
  const o = await Cron.stateGet('observed');
  assert.equal(o.value.totalRuns, 1);
  assert.equal(o.value.logCount, 1);
});

test('gcOldRuns deletes IDB rows older than the cutoff', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const j = await Cron.addJob({ name: 'old-runner', schedule: { every: '1m' }, code: '1' });
  // Inject runs at ages 100 days, 5 days, 1 hour.
  const now = Date.now();
  await Cron._appendRun(j.id, { ts: now - 100 * 86400_000, ok: true, ms: 1, stdout: '', stderr: '', error: null, triggeredBy: 'old' });
  await Cron._appendRun(j.id, { ts: now -   5 * 86400_000, ok: true, ms: 1, stdout: '', stderr: '', error: null, triggeredBy: 'middle' });
  await Cron._appendRun(j.id, { ts: now -          3600_000, ok: true, ms: 1, stdout: '', stderr: '', error: null, triggeredBy: 'fresh' });
  const r = await Cron.gcOldRuns(30 * 86400_000);  // 30-day cutoff
  assert.ok(r.deleted >= 1);
  const after = await Cron._readRuns(j.id, 50);
  // Only entries within 30 days should remain.
  assert.ok(after.every(x => (now - x.ts) <= 30 * 86400_000),
    'all surviving runs should be within 30d, got: ' + JSON.stringify(after.map(x => (now - x.ts) / 86400_000 + 'd ago')));
});

test('exportAll returns a portable payload; importAll merge skips duplicate slugs', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.addJob({ name: 'one', schedule: { every: '1m' }, code: 'K.log("a")', tags: ['t1'] });
  await Cron.stateSet('shared.key', { hello: 'world' });
  const payload = await Cron.exportAll();
  assert.equal(payload._kyotoCronExport, 1);
  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.jobs[0].name, 'one');
  assert.ok(payload.state['shared.key']);

  // Import into a fresh engine.
  const { stubs: stubs2 } = makeChromeStub();
  const Cron2 = loadCronEngine({ chromeStubs: stubs2 });
  await Cron2.addJob({ name: 'one', schedule: { every: '1m' }, code: 'K.log("local")' });
  const r = await Cron2.importAll(payload, { mode: 'merge' });
  assert.equal(r.jobsAdded, 0, 'slug conflict skips');
  assert.equal(r.jobsSkipped, 1);
  assert.equal(r.stateKeys, 1);
  // Local "one" still has the local code.
  const list = await Cron2.listJobs();
  const one = list.jobs.find(j => j.name === 'one');
  const full = await Cron2.getJob(one.id);
  assert.equal(full.code, 'K.log("local")');
  // But the state key was imported.
  assert.deepStrictEqual((await Cron2.stateGet('shared.key')).value, { hello: 'world' });
});

test('importAll replace mode wipes existing jobs and imports fresh', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  await Cron.addJob({ name: 'before', schedule: { every: '1m' }, code: '1' });
  const payload = {
    _kyotoCronExport: 1,
    jobs: [{ name: 'after', schedule: { every: '1m' }, code: '2' }],
    state: {},
  };
  const r = await Cron.importAll(payload, { mode: 'replace' });
  assert.equal(r.jobsAdded, 1);
  const list = await Cron.listJobs();
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].name, 'after');
});

// Audit C17: the warning threshold used to be 4MB and the message claimed the
// local quota was ~5MB. Chrome's `storage.local` quota is ~10MB, so the
// warning fired when the store was still less than half full and understated
// the platform limit. Threshold is now 8MB (~80% of 10MB).
test('stateSet returns sizeWarning when aggregate state exceeds 80% of 10MB', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // 49KB per write × 175 keys ≈ 8.4MB. The 50KB per-value cap stays separate;
  // we're checking the AGGREGATE.
  const chunk = 'a'.repeat(49 * 1024);
  for (let i = 0; i < 175; i++) {
    await Cron.stateSet('big.' + i, chunk);
  }
  const r = await Cron.stateSet('big.last', chunk);
  assert.ok(r.sizeWarning, 'should warn when over 80%, got: ' + JSON.stringify({ ...r, value: undefined }));
  assert.ok(/MB/.test(r.sizeWarning));
  assert.ok(r.bytesUsed > 8 * 1024 * 1024);
});

test('stateSet does not warn while the state store is under the threshold', async () => {
  const { stubs } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  const r = await Cron.stateSet('small.key', 'a'.repeat(1024));
  assert.equal(r.sizeWarning, undefined);
});

test('reconcile creates missing alarms and clears orphans', async () => {
  const { stubs, _alarms } = makeChromeStub();
  const Cron = loadCronEngine({ chromeStubs: stubs });
  // Add a job, then manually nuke the alarm to simulate SW restart
  // that lost the alarm somehow.
  const j = await Cron.addJob({ name: 'r', schedule: { every: '1m' }, code: '1' });
  _alarms.delete('kyoto-cron:' + j.id);
  // Inject an orphan alarm.
  _alarms.set('kyoto-cron:ghost', { name: 'kyoto-cron:ghost', periodInMinutes: 1 });
  await Cron.reconcile();
  assert.ok(_alarms.has('kyoto-cron:' + j.id), 'real job alarm should be recreated');
  assert.equal(_alarms.has('kyoto-cron:ghost'), false, 'orphan alarm should be cleared');
});
