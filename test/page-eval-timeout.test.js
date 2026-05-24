// Test for page_eval's hard timeout. Before this guard, a user script
// that did `await video.play()` when the page blocked autoplay would
// hang forever — the tool never returned, the assistant turn never
// completed, and every subsequent send failed with the OpenAI-compat
// "insufficient tool messages following tool_calls" error.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHarness({ pageEvalStub } = {}) {
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  const sandbox = {
    window: win,
    self: win,
    addEventListener: () => {},
    removeEventListener: () => {},
    document: {
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    chrome: {
      runtime: { id: 'test-ext', connectNative: () => { throw new Error('no native in test'); } },
      tabs: {
        query: async () => [{ id: 1, windowId: 0, url: 'https://example.test/' }],
        get: async (id) => ({ id, windowId: 0, url: 'https://example.test/' }),
      },
      scripting: {
        executeScript: async ({ target, world, func, args }) => {
          // pageEvalStub lets tests override what "the page" actually
          // executes. If unset, we execute the func directly with the
          // provided args inside this sandbox — which is exactly what
          // a well-behaved page would do.
          if (pageEvalStub) {
            const result = await pageEvalStub({ target, world, func, args });
            return [{ result }];
          }
          const result = await Promise.resolve(func.apply(null, args || []));
          return [{ result }];
        }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: {}, history: {}, bookmarks: {}, downloads: {},
    },
    indexedDB: {},
    crypto: { subtle: {}, getRandomValues: (a) => a },
    fetch: async () => ({ ok: false, status: 0 }),
    URL: Object.assign(class extends URL {}, {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {}
    }),
    URLSearchParams,
    TextEncoder, TextDecoder,
    DataView, Uint8Array, ArrayBuffer,
    DOMParser: function () {},
    FileReader: function () {},
    Blob: function () {},
    HTMLInputElement: function () {},
    HTMLTextAreaElement: function () {},
    // Use plain timers — the page_eval timeout itself uses setTimeout
    // to fire the cancel; if we unref'd it the test runner would
    // observe "Promise resolution still pending" before the timeout
    // had a chance to settle the promise.
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, atob, btoa,
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    navigator: { clipboard: { writeText: async () => {} } },
    location: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    'core','workspace','browser','cookies','network','python','fs','media',
    'shell','youtube','data','skills','widevine','drm','m3u8dl','subagent','finalize'
  ].map(n => path.join(__dirname, '..', 'sidepanel', 'tools', `${n}.js`));
  for (const f of files) {
    vm.runInContext(fs.readFileSync(f, 'utf-8'), sandbox, { filename: f });
  }
  return win;
}

test('page_eval returns a successful result for a quick synchronous script', async () => {
  const win = loadHarness();
  const r = await win.KyotoTools.call('page_eval', { code: '1 + 2' });
  assert.equal(r.ok, true);
  assert.equal(r.result, 3);
});

test('page_eval returns a successful result for a quick async script', async () => {
  const win = loadHarness();
  const r = await win.KyotoTools.call('page_eval', {
    code: 'await new Promise(r => setTimeout(() => r(42), 10))'
  });
  assert.equal(r.ok, true);
  assert.equal(r.result, 42);
});

test('page_eval times out a never-resolving promise (the original Crunchyroll bug)', async () => {
  const win = loadHarness();
  const start = Date.now();
  // Mimics the actual script that hung: an await on a promise that
  // never resolves. With a 700ms cap the tool must return within ~1s.
  const r = await win.KyotoTools.call('page_eval', {
    // Never-resolving promise — emulates the actual Crunchyroll bug
    // where `await video.play()` hung indefinitely.
    code: 'await new Promise(function() {})',
    timeoutMs: 700
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, 'should resolve with ok:false, not hang');
  assert.ok(/timed out/i.test(r.error), `error should mention timeout, got: ${r.error}`);
  assert.ok(/700ms/.test(r.error), `error should mention the timeout value, got: ${r.error}`);
  assert.ok(elapsed < 3000, `should return within a few seconds, took ${elapsed}ms`);
});

test('page_eval bounds timeoutMs to [500, 600000]', async () => {
  const win = loadHarness();
  // Way-too-small value clamps up to 500ms minimum. 1ms would never
  // be enough for the tiny async setup, so we wouldn't get a real
  // result back if the clamp didn't work. Verify by asking for a
  // script that resolves in 50ms with a 1ms requested timeout — under
  // the floor of 500ms, the script should still succeed.
  const r = await win.KyotoTools.call('page_eval', {
    code: 'await new Promise(r => setTimeout(() => r("ok"), 50))',
    timeoutMs: 1
  });
  assert.equal(r.ok, true, `clamp should keep timeout >= 500ms, got: ${JSON.stringify(r)}`);
  assert.equal(r.result, 'ok');
});

test('page_eval surfaces script errors normally (no timeout interference)', async () => {
  const win = loadHarness();
  const r = await win.KyotoTools.call('page_eval', {
    code: 'throw new Error("boom")'
  });
  assert.equal(r.ok, false);
  assert.ok(/boom/.test(r.error), `error should pass through, got: ${r.error}`);
});
