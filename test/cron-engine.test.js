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
    atob, btoa,
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
  for (let i = 0; i < 5; i++) await Cron.runJobNow(j.id);
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
