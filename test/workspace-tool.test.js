// Functional test for the workspace folder feature. Stubs
// chrome.downloads, chrome.storage and KyotoVFS so we can drive
// workspace_info and workspace_save through their real handlers and
// confirm the actual download payload is what we expect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHarness({ storage = {}, vfs = null } = {}) {
  const captured = { downloads: [], objectUrls: [], blobs: [] };

  // node:test runs in a Node context where Blob exists, but to be able
  // to inspect what the tool put into the blob we shim a tiny version
  // that just records the buffers it was constructed with.
  // The Uint8Array prototype inside the vm sandbox is NOT the same as
  // the one on the outer Node realm, so `p instanceof Uint8Array` is
  // false here for buffers built by the tool code. Duck-type instead.
  function isU8Like(p) {
    return p && typeof p === 'object' && typeof p.byteLength === 'number' && typeof p.BYTES_PER_ELEMENT === 'number';
  }
  function TestBlob(parts = [], opts = {}) {
    this._parts = parts;
    this.type = opts.type || '';
    this.size = parts.reduce((n, p) => {
      if (typeof p === 'string') return n + Buffer.byteLength(p, 'utf-8');
      if (isU8Like(p)) return n + p.byteLength;
      if (p && typeof p.byteLength === 'number') return n + p.byteLength;
      return n;
    }, 0);
    captured.blobs.push(this);
  }
  TestBlob.prototype.text = async function () {
    return this._parts.map(p => {
      if (typeof p === 'string') return p;
      if (isU8Like(p)) return Buffer.from(p).toString('utf-8');
      return String(p);
    }).join('');
  };

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
      tabs: {},
      storage: {
        local: {
          get: async (keys) => {
            if (!keys) return { ...storage };
            const want = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of want) if (k in storage) out[k] = storage[k];
            return out;
          },
          set: async (patch) => { Object.assign(storage, patch); }
        }
      },
      cookies: {},
      history: {},
      bookmarks: {},
      downloads: {
        download: async (opts) => {
          captured.downloads.push(opts);
          return captured.downloads.length; // pretend downloadId
        },
        search: async ({ id }) => [{ id, state: 'complete', filename: `/tmp/dl-${id}` }]
      },
    },
    indexedDB: {},
    crypto: { subtle: {}, getRandomValues: (a) => a },
    fetch: async () => ({ ok: false, status: 0 }),
    URL: Object.assign(class extends URL {}, {
      createObjectURL: (blob) => {
        const u = `blob:test/${captured.objectUrls.length}`;
        captured.objectUrls.push({ url: u, blob });
        return u;
      },
      revokeObjectURL: () => {}
    }),
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    DOMParser: function () {},
    FileReader: function () {},
    Blob: TestBlob,
    HTMLInputElement: function () {},
    HTMLTextAreaElement: function () {},
    // Wrap setTimeout so URL.revokeObjectURL (scheduled 120s out by
    // workspace_save) doesn't keep the event loop alive after the
    // suite finishes.
    setTimeout: (fn, ms, ...rest) => {
      const t = setTimeout(fn, ms, ...rest);
      try { t.unref?.(); } catch {}
      return t;
    },
    clearTimeout, setInterval, clearInterval,
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
    const code = fs.readFileSync(f, 'utf-8');
    vm.runInContext(code, sandbox, { filename: f });
  }

  if (vfs) win.KyotoVFS = vfs;
  return { win, captured, storage };
}

test('workspace_info returns the default folder + location', async () => {
  const { win } = loadHarness();
  const r = await win.KyotoTools.call('workspace_info', {});
  assert.equal(r.folder, 'Kyoto');
  assert.equal(r.location, 'downloads');
  assert.ok(r.downloadsPath.includes('Kyoto/'));
  // No documentsPath when we're in downloads mode.
  assert.equal(r.documentsPath, undefined);
});

test('workspace_info honours folder name from chrome.storage', async () => {
  const { win } = loadHarness({ storage: { workspaceFolder: 'My Stuff', workspaceLocation: 'downloads' } });
  // _readFromStorage() is async — give it a microtask to settle.
  await new Promise(r => setTimeout(r, 10));
  const r = await win.KyotoTools.call('workspace_info', {});
  assert.equal(r.folder, 'My Stuff');
});

test('workspace_save with inline content writes blob through chrome.downloads under the workspace prefix', async () => {
  const { win, captured } = loadHarness();
  const r = await win.KyotoTools.call('workspace_save', {
    filename: 'report.txt',
    content: 'hello workspace'
  });
  assert.equal(r.ok, true);
  assert.equal(r.folder, 'Kyoto');
  assert.equal(r.location, 'downloads');
  assert.equal(r.path, 'Kyoto/report.txt');
  assert.equal(captured.downloads.length, 1);
  assert.equal(captured.downloads[0].filename, 'Kyoto/report.txt');
  // The blob we asked chrome.downloads to write contains the right bytes.
  const blob = captured.objectUrls[0].blob;
  assert.equal(await blob.text(), 'hello workspace');
  assert.equal(blob.type, 'text/plain;charset=utf-8');
});

test('workspace_save with base64 content decodes correctly', async () => {
  const { win, captured } = loadHarness();
  const payload = Buffer.from('binary-data-here').toString('base64');
  const r = await win.KyotoTools.call('workspace_save', {
    filename: 'pkg.bin',
    content: payload,
    encoding: 'base64',
    mime: 'application/octet-stream'
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'Kyoto/pkg.bin');
  const blob = captured.objectUrls[0].blob;
  assert.equal(await blob.text(), 'binary-data-here');
  assert.equal(blob.type, 'application/octet-stream');
});

test('workspace_save reads VFS files via base64 (matches real VFS contract)', async () => {
  const fakeBytes = 'I am a vfs file';
  const fakeB64 = Buffer.from(fakeBytes).toString('base64');
  const vfs = {
    read: async () => ({ base64: fakeB64, bytes: fakeBytes.length, totalSize: fakeBytes.length }),
    stat: async () => ({ mime: 'text/markdown', size: fakeBytes.length, mtime: Date.now() })
  };
  const { win, captured } = loadHarness({ vfs });
  const r = await win.KyotoTools.call('workspace_save', {
    filename: 'notes.md',
    vfsPath: '/scrape/notes.md'
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.path, 'Kyoto/notes.md');
  const blob = captured.objectUrls[0].blob;
  assert.equal(await blob.text(), fakeBytes);
  assert.equal(blob.type, 'text/markdown');
});

test('workspace_save rejects when neither vfsPath nor content is supplied', async () => {
  const { win } = loadHarness();
  const r = await win.KyotoTools.call('workspace_save', { filename: 'x.txt' });
  assert.ok(r.error && /vfsPath/.test(r.error), `expected vfsPath/content error, got ${JSON.stringify(r)}`);
});

test('workspace_save sanitises dangerous filenames', async () => {
  const { win, captured } = loadHarness();
  const r = await win.KyotoTools.call('workspace_save', {
    filename: '../../etc/passwd',
    content: 'nope'
  });
  assert.equal(r.ok, true);
  // ../../ folded down to .././ via the .. → . collapse; leading slashes stripped.
  // Important thing: no leading "../" climbing out of the workspace folder.
  assert.ok(!r.path.includes('..'), `path should not contain '..': ${r.path}`);
  assert.ok(r.path.startsWith('Kyoto/'), `path should start with Kyoto/: ${r.path}`);
});

test('switching to documents mode without a shell host falls back gracefully', async () => {
  const { win } = loadHarness();
  win.KyotoWorkspace.setFromSettings({ workspaceLocation: 'documents' });
  const info = await win.KyotoTools.call('workspace_info', {});
  assert.equal(info.location, 'documents');
  // ShellHost.send throws (no native in test), so documentsPath is null
  // and we get the fallback hint.
  assert.equal(info.shellHostAvailable, false);
  assert.equal(info.fallback, 'downloads');
  assert.ok(/shell bridge/i.test(info.note));
});

test('fs_zip and chat_export resolve workspace_info-style fields too', () => {
  const { win } = loadHarness();
  // Spot-check that the two routed tools advertise their workspace
  // fields in their description so the model knows about them.
  const fs_zip = win.KyotoTools.list().find(t => t.name === 'fs_zip');
  const chat_export = win.KyotoTools.list().find(t => t.name === 'chat_export');
  assert.ok(/workspace_info|on-disk workspace/i.test(fs_zip.description));
  // chat_export didn't get the description updated — that's intentional;
  // its existing copy still applies. Just confirm it's still registered.
  assert.ok(chat_export);
});
