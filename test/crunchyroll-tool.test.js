// Functional tests for cr_get_stream_info. Stubs chrome.scripting +
// chrome.tabs and asserts the tool routes its in-page fetch chain
// through the right endpoints, parses the response, and surfaces
// clear errors when auth or playback fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHarness({ inPageFetch, activeUrl = 'https://www.crunchyroll.com/watch/GE00367923JAJP/ep' } = {}) {
  const win = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };
  const sandbox = {
    window: win, self: win,
    addEventListener: () => {}, removeEventListener: () => {},
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
    chrome: {
      runtime: { id: 'test-ext', connectNative: () => { throw new Error('no native'); } },
      tabs: {
        query: async () => [{ id: 99, windowId: 0, url: activeUrl }],
        get: async (id) => ({ id, windowId: 0, url: activeUrl }),
      },
      scripting: {
        // Run the injected func in-place. The func uses `fetch` from the
        // sandbox global — override per-test via `inPageFetch` so we can
        // simulate /auth/v1/token, /playback/v3, manifest fetch.
        executeScript: async ({ func, args }) => {
          const saved = sandbox.fetch;
          if (inPageFetch) sandbox.fetch = inPageFetch;
          try {
            const result = await Promise.resolve(func.apply(null, args || []));
            return [{ result }];
          } finally { sandbox.fetch = saved; }
        }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: { getAll: async () => [] },
      history: {}, bookmarks: {}, downloads: {},
    },
    indexedDB: {}, crypto: { subtle: {}, getRandomValues: (a) => a },
    fetch: async () => ({ ok: false, status: 0 }),
    URL, URLSearchParams, TextEncoder, TextDecoder, DataView, Uint8Array, ArrayBuffer,
    DOMParser: function () {}, FileReader: function () {}, Blob: function () {},
    HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, atob, btoa, unescape, encodeURIComponent,
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    navigator: { clipboard: { writeText: async () => {} } },
    location: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    'core','workspace','browser','cookies','network','python','fs','media',
    'shell','youtube','data','skills','widevine','drm','m3u8dl','crunchyroll','subagent','finalize'
  ].map(n => path.join(__dirname, '..', 'sidepanel', 'tools', `${n}.js`));
  for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf-8'), sandbox, { filename: f });
  return win;
}

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function textResp(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

test('cr_get_stream_info errors when videoId cannot be inferred from URL', async () => {
  const win = loadHarness({ activeUrl: 'https://www.crunchyroll.com/' });  // no /watch/<id>
  const r = await win.KyotoTools.call('cr_get_stream_info', {});
  assert.ok(r.error && /videoId/i.test(r.error), JSON.stringify(r));
  assert.ok(r.hint && /watch/i.test(r.hint));
});

test('cr_get_stream_info infers videoId from active tab URL', async () => {
  const calls = [];
  const win = loadHarness({
    inPageFetch: async (url, opts) => {
      calls.push(url);
      if (url.includes('/auth/v1/token')) return jsonResp(200, { access_token: 'TOKEN_BEARER' });
      if (url.includes('/playback/v3/')) return jsonResp(200, {
        url: 'https://example.test/manifest.mpd',
        token: 'TOKEN_VIDEO', assetId: 'A1', playbackGuid: 'PG1',
      });
      if (url.includes('/manifest.mpd')) return textResp(200,
        '<MPD><cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">AAAAW3Bzc2g=</cenc:pssh></MPD>'
      );
      return { ok: false, status: 0, text: async () => '' };
    }
  });
  const r = await win.KyotoTools.call('cr_get_stream_info', {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.bearer_token, 'TOKEN_BEARER');
  assert.equal(r.video_token, 'TOKEN_VIDEO');
  assert.equal(r.manifest_url, 'https://example.test/manifest.mpd');
  assert.equal(r.asset_id, 'A1');
  assert.equal(r.pssh, 'AAAAW3Bzc2g=');
  // The flow hit /auth, /playback, /manifest in order.
  assert.ok(calls[0].includes('/auth/v1/token'));
  assert.ok(calls[1].includes('/playback/v3/GE00367923JAJP/web/chrome/play'));
  assert.ok(calls[2].includes('/manifest.mpd'));
});

test('cr_get_stream_info surfaces auth/v1/token failure with a sign-in hint', async () => {
  const win = loadHarness({
    inPageFetch: async (url) => {
      if (url.includes('/auth/v1/token')) return { ok: false, status: 401, text: async () => 'invalid_grant' };
      return jsonResp(200, {});
    }
  });
  const r = await win.KyotoTools.call('cr_get_stream_info', { videoId: 'GE12345678ENUS' });
  assert.ok(r.error && /401/.test(r.error));
  assert.ok(r.hint && /sign in/i.test(r.hint));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.steps)), [{ step: 'auth/v1/token', status: 401 }]);
});

test('cr_get_stream_info surfaces playback/v3 403 with subscription hint', async () => {
  const win = loadHarness({
    inPageFetch: async (url) => {
      if (url.includes('/auth/v1/token')) return jsonResp(200, { access_token: 'OK' });
      if (url.includes('/playback/v3/')) return { ok: false, status: 403, text: async () => 'geo restricted' };
      return jsonResp(200, {});
    }
  });
  const r = await win.KyotoTools.call('cr_get_stream_info', { videoId: 'GE12345678ENUS' });
  assert.ok(r.error && /403/.test(r.error));
  assert.ok(r.hint && /(premium|region)/i.test(r.hint));
  // Steps record both calls — useful for debugging.
  const stepNames = JSON.parse(JSON.stringify(r.steps)).map(s => s.step);
  assert.deepStrictEqual(stepNames, ['auth/v1/token', 'playback/v3/play']);
});

test('cr_get_stream_info extracts cenc:default_KID from the MPD when present', async () => {
  const win = loadHarness({
    inPageFetch: async (url) => {
      if (url.includes('/auth/v1/token')) return jsonResp(200, { access_token: 'B' });
      if (url.includes('/playback/v3/')) return jsonResp(200, {
        url: 'https://x/m.mpd', token: 'V', assetId: 'A', playbackGuid: 'P',
      });
      return textResp(200, `
        <MPD>
          <Representation cenc:default_KID="11112222-3333-4444-5555-666677778888"/>
          <cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">AAAA</cenc:pssh>
        </MPD>
      `);
    }
  });
  const r = await win.KyotoTools.call('cr_get_stream_info', { videoId: 'GE1' });
  assert.ok(r.ok);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.key_ids)),
    ['11112222-3333-4444-5555-666677778888']);
});
