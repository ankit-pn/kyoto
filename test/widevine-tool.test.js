// Functional tests for the widevine_* tools. Drives them through the
// shared tool harness, builds known PSSH boxes byte-for-byte and
// confirms the parser surfaces the right system ID + key IDs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The widevine license-request tools now inject their EME flow into
// the active tab's MAIN world via chrome.scripting.executeScript. The
// harness simulates that by hot-swapping the sandbox's `navigator` +
// `fetch` for the duration of each executeScript call, then invoking
// the injected `func` in-place. The injected function is defined
// inside the same vm context as the rest of widevine.js, so it picks
// up whatever globals we put on `sandbox` at call time.
function loadHarness({ pageMKSA = null, pageFetch = null } = {}) {
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  const baseNavigator = { clipboard: { writeText: async () => {} } };
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
          // Hot-swap page-world globals around the injected func.
          const savedNav = sandbox.navigator;
          const savedFetch = sandbox.fetch;
          if (pageMKSA || pageFetch) {
            sandbox.navigator = {
              ...savedNav,
              requestMediaKeySystemAccess: pageMKSA || savedNav.requestMediaKeySystemAccess,
            };
            if (pageFetch) sandbox.fetch = pageFetch;
          }
          try {
            const result = await Promise.resolve(func.apply(null, args || []));
            return [{ result }];
          } finally {
            sandbox.navigator = savedNav;
            sandbox.fetch = savedFetch;
          }
        }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: {},
      history: {},
      bookmarks: {},
      downloads: { download: async () => 1, search: async () => [] },
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
    DataView,
    Uint8Array, ArrayBuffer,
    DOMParser: function () {},
    FileReader: function () {},
    Blob: function () {},
    HTMLInputElement: function () {},
    HTMLTextAreaElement: function () {},
    setTimeout: (fn, ms, ...rest) => { const t = setTimeout(fn, ms, ...rest); try { t.unref?.(); } catch {}; return t; },
    clearTimeout,
    setInterval: (fn, ms, ...rest) => { const t = setInterval(fn, ms, ...rest); try { t.unref?.(); } catch {}; return t; },
    clearInterval,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, atob, btoa,
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    navigator: baseNavigator,
    location: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    'core','workspace','browser','cookies','network','python','fs','media',
    'shell','youtube','data','skills','widevine','subagent','finalize'
  ].map(n => path.join(__dirname, '..', 'sidepanel', 'tools', `${n}.js`));
  for (const f of files) {
    vm.runInContext(fs.readFileSync(f, 'utf-8'), sandbox, { filename: f });
  }
  // Expose the chrome stub on win too so individual tests can monkey-
  // patch it (e.g. spy on chrome.tabs.get to assert routing behaviour).
  win.chrome = sandbox.chrome;
  return win;
}

// ── PSSH box construction helpers ──

const WV_SYSTEM_ID_HEX = 'edef8ba979d64acea3c827dcd51d21ed';
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) out[i / 2] = parseInt(h.substr(i, 2), 16);
  return out;
}
function bytesToB64(u8) { return Buffer.from(u8).toString('base64'); }
function u32BE(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function buildPssh({ version = 0, kids = [], data = new Uint8Array(0) } = {}) {
  const sysId = hexToBytes(WV_SYSTEM_ID_HEX);
  let body;
  if (version >= 1) {
    const kidBytes = concat(...kids);
    body = concat(
      u32BE(kids.length),
      kidBytes,
      u32BE(data.length),
      data
    );
  } else {
    body = concat(u32BE(data.length), data);
  }
  const header = concat(
    new Uint8Array([0x70, 0x73, 0x73, 0x68]),  // 'pssh'
    new Uint8Array([version, 0, 0, 0]),
    sysId,
  );
  const total = 4 + header.length + body.length;  // +4 for size field itself
  return concat(u32BE(total), header, body);
}

// ── tests ──

test('widevine_parse_pssh decodes a v0 Widevine PSSH', async () => {
  const win = loadHarness();
  const dataPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11, 0x22]);
  const box = buildPssh({ version: 0, data: dataPayload });
  const r = await win.KyotoTools.call('widevine_parse_pssh', { pssh: bytesToB64(box) });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.systemId, WV_SYSTEM_ID_HEX);
  assert.equal(r.systemName, 'Widevine');
  assert.equal(r.systemIdGuid, 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
  assert.equal(r.version, 0);
  assert.equal(r.flags, 0);
  assert.equal(r.dataSize, dataPayload.length);
  // No KIDs in v0 body.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.keyIds)), []);
});

test('widevine_parse_pssh decodes a v1 PSSH with two KIDs', async () => {
  const win = loadHarness();
  const kid1 = hexToBytes('11112222333344445555666677778888');
  const kid2 = hexToBytes('aaaabbbbccccddddeeeeffff00001111');
  const box = buildPssh({ version: 1, kids: [kid1, kid2], data: new Uint8Array([0xfe, 0xed]) });
  const r = await win.KyotoTools.call('widevine_parse_pssh', { pssh: bytesToB64(box) });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.version, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.keyIds)), [
    '11112222333344445555666677778888',
    'aaaabbbbccccddddeeeeffff00001111',
  ]);
  assert.equal(r.dataSize, 2);
});

test('widevine_parse_pssh rejects non-PSSH input cleanly', async () => {
  const win = loadHarness();
  const garbage = bytesToB64(new Uint8Array([0, 0, 0, 16, 0x66, 0x72, 0x65, 0x65, 1, 2, 3, 4, 5, 6, 7, 8]));
  const r = await win.KyotoTools.call('widevine_parse_pssh', { pssh: garbage });
  assert.ok(r.error && /pssh/i.test(r.error), `expected pssh error, got ${JSON.stringify(r)}`);
});

test('widevine_extract_pssh finds <cenc:pssh> entries in MPD XML', async () => {
  const win = loadHarness();
  const box = buildPssh({ version: 0, data: new Uint8Array([1, 2, 3]) });
  const psshB64 = bytesToB64(box);
  const mpd = `<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
      <Period>
        <AdaptationSet>
          <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
            <cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">${psshB64}</cenc:pssh>
          </ContentProtection>
        </AdaptationSet>
      </Period>
    </MPD>`;
  const r = await win.KyotoTools.call('widevine_extract_pssh', { mpd });
  assert.equal(r.source, 'mpd');
  assert.equal(r.system, 'DASH');
  assert.equal(r.psshEntries.length, 1);
  assert.equal(r.psshEntries[0].systemId, WV_SYSTEM_ID_HEX);
  assert.equal(r.psshEntries[0].b64, psshB64);
});

test('widevine_extract_pssh finds a PSSH inside a junk-padded init segment', async () => {
  const win = loadHarness();
  const box = buildPssh({ version: 1, kids: [hexToBytes('cafebabecafebabecafebabecafebabe')] });
  const junkBefore = new Uint8Array(64).fill(0x42);
  const junkAfter  = new Uint8Array(32).fill(0x55);
  const segment = concat(junkBefore, box, junkAfter);
  const r = await win.KyotoTools.call('widevine_extract_pssh', {
    init_segment_b64: bytesToB64(segment)
  });
  assert.equal(r.source, 'init-segment');
  assert.equal(r.psshBoxes.length, 1);
  assert.equal(r.psshBoxes[0].offset, junkBefore.length);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(r.psshBoxes[0].keyIds)),
    ['cafebabecafebabecafebabecafebabe']
  );
});

test('widevine_extract_pssh requires at least one input', async () => {
  const win = loadHarness();
  const r = await win.KyotoTools.call('widevine_extract_pssh', {});
  assert.ok(r.error, `expected error, got ${JSON.stringify(r)}`);
});

test('widevine_request_license fails cleanly when EME is not available in the page', async () => {
  // No pageMKSA → the injected pageEmeFlow's requestMediaKeySystemAccess
  // call rejects (undefined), which we capture as "EME setup failed".
  const win = loadHarness();
  const r = await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://example.com/license',
    pssh: bytesToB64(buildPssh({ version: 0 }))
  });
  assert.ok(r.error, `expected error, got ${JSON.stringify(r)}`);
  assert.ok(/EME setup failed/i.test(r.error), `expected EME setup error, got: ${r.error}`);
});

function stubSession() {
  const handlers = { message: [], keystatuseschange: [] };
  const session = {
    sessionId: 'test-session-1',
    keyStatuses: {
      _entries: [],
      get size() { return this._entries.length; },
      forEach(cb) { for (const [kid, status] of this._entries) cb(status, kid); }
    },
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      handlers[type] = (handlers[type] || []).filter(h => h !== fn);
    },
    generateRequest: async function (_initType, _initData) {
      const challenge = new Uint8Array([0xc, 0xb, 0xa, 0x9, 0x8, 0x7]);
      setImmediate(() => {
        for (const h of handlers.message) {
          h({ messageType: 'license-request', message: challenge.buffer });
        }
      });
    },
    update: async function (_licenseBuf) {
      session.keyStatuses._entries.push([
        hexToBytes('11112222333344445555666677778888').buffer,
        'usable'
      ]);
      setImmediate(() => { for (const h of handlers.keystatuseschange) h({}); });
    },
    close: async () => {},
    _handlers: handlers
  };
  return session;
}

test('widevine_request_license posts to the license server and returns usable keys (stubbed CDM)', async () => {
  const fetchCalls = [];
  const stubFetch = async (url, opts) => {
    fetchCalls.push({
      url,
      contentType: opts.headers?.['Content-Type'],
      authHeader: opts.headers?.['Authorization'],
      bodyBytes: opts.body && (opts.body.byteLength ?? opts.body.length)
    });
    return {
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array([0x11, 0x22, 0x33]).buffer.slice(0),
      text: async () => ''
    };
  };
  const stubMKSA = async (_keySystem, _config) => ({
    createMediaKeys: async () => ({
      createSession: () => stubSession()
    })
  });

  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  const r = await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(buildPssh({ version: 0 })),
    headers: { Authorization: 'Bearer xyz' }
  });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].status, 'usable');
  assert.equal(r.keys[0].kid, '11112222333344445555666677778888');
  // Verify the tool actually called the license server with the right
  // headers and a non-empty challenge body.
  assert.equal(fetchCalls.length, 1, 'should fetch the license server exactly once');
  assert.equal(fetchCalls[0].url, 'https://lic.example/req');
  assert.equal(fetchCalls[0].contentType, 'application/octet-stream');
  assert.equal(fetchCalls[0].authHeader, 'Bearer xyz');
  assert.ok(fetchCalls[0].bodyBytes > 0);
});

test('widevine_request_license with challenge_only returns the challenge without hitting the network', async () => {
  let fetched = false;
  const stubFetch = async () => { fetched = true; return { ok: false, status: 500, text: async () => '' }; };
  const stubMKSA = async () => ({
    createMediaKeys: async () => ({ createSession: () => stubSession() })
  });
  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  const r = await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(buildPssh({ version: 0 })),
    challenge_only: true
  });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.ok(r.challengeHex, 'should return challengeHex');
  assert.equal(r.challengeBytes, 6);  // matches stubSession's challenge
  assert.equal(fetched, false, 'challenge_only must NOT hit the license server');
});

test('widevine_get_content_keys parses PSSH + fetches license in one call', async () => {
  let fetched = false;
  const stubFetch = async () => {
    fetched = true;
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer.slice(0), text: async () => '' };
  };
  const stubMKSA = async () => ({
    createMediaKeys: async () => ({ createSession: () => stubSession() })
  });
  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  const box = buildPssh({ version: 1, kids: [hexToBytes('22223333444455556666777788889999')] });
  const r = await win.KyotoTools.call('widevine_get_content_keys', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(box)
  });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(fetched, true);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.usableKeys.length, 1);
  assert.equal(r.psshInfo.systemId, WV_SYSTEM_ID_HEX);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(r.psshInfo.keyIds)),
    ['22223333444455556666777788889999']
  );
});

test('widevine_extract_pssh tags un-parseable PSSH entries with an error (instead of silently dropping fields)', async () => {
  const win = loadHarness();
  // Inject a base64 that decodes to something that ISN'T a pssh box.
  const bogus = Buffer.from(new Uint8Array(20).fill(0xab)).toString('base64');
  const mpd = `<MPD><cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">${bogus}</cenc:pssh></MPD>`;
  const r = await win.KyotoTools.call('widevine_extract_pssh', { mpd });
  assert.equal(r.psshEntries.length, 1);
  assert.equal(r.psshEntries[0].b64, bogus);
  assert.ok(r.psshEntries[0].error, `expected error field, got ${JSON.stringify(r.psshEntries[0])}`);
});

test('widevine_request_license reports session.update failures (e.g. malformed license)', async () => {
  // CDM rejects the license response. The injected flow must surface
  // the error rather than hanging until the 35s timeout.
  const stubFetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => new Uint8Array([0xde, 0xad]).buffer.slice(0),
    text: async () => ''
  });
  function brokenSession() {
    const s = stubSession();
    s.update = async () => { throw new Error('CDM_PARSE_ERROR'); };
    return s;
  }
  const stubMKSA = async () => ({
    createMediaKeys: async () => ({ createSession: () => brokenSession() })
  });
  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  const r = await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(buildPssh({ version: 0 }))
  });
  assert.ok(r.error, `expected error, got ${JSON.stringify(r)}`);
  assert.ok(/session\.update failed/i.test(r.error) && /CDM_PARSE_ERROR/.test(r.error),
    `expected session.update error, got: ${r.error}`);
});

test('widevine_request_license routes through an explicit tabId when supplied', async () => {
  const tabsAsked = [];
  const stubFetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array().buffer.slice(0), text: async () => '' });
  const stubMKSA = async () => ({ createMediaKeys: async () => ({ createSession: () => stubSession() }) });
  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  // Hook chrome.tabs.get to record which tab the tool resolved.
  const origGet = win.chrome.tabs.get;
  win.chrome.tabs.get = async (id) => { tabsAsked.push(id); return origGet(id); };
  await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(buildPssh({ version: 0 })),
    tabId: 42
  });
  assert.ok(tabsAsked.includes(42), `expected tabs.get(42), got ${JSON.stringify(tabsAsked)}`);
});

test('widevine_request_license surfaces license server failures', async () => {
  const stubFetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const stubMKSA = async () => ({
    createMediaKeys: async () => ({ createSession: () => stubSession() })
  });
  const win = loadHarness({ pageMKSA: stubMKSA, pageFetch: stubFetch });
  const r = await win.KyotoTools.call('widevine_request_license', {
    license_url: 'https://lic.example/req',
    pssh: bytesToB64(buildPssh({ version: 0 }))
  });
  assert.ok(r.error, `expected error, got ${JSON.stringify(r)}`);
  assert.ok(/HTTP 403/.test(r.error), `expected 403 in error, got: ${r.error}`);
});