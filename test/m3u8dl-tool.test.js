// Functional tests for the m3u8dl_* tools (N_m3u8DL-RE pipeline). We
// can't run the real binary in CI — and we wouldn't want to — so we
// stub the shell bridge + chrome.cookies and verify the wrapper:
//   - probes the pipeline pieces correctly
//   - detects the platform → asset tag mapping
//   - parses pywidevine's KID:KEY output
//   - builds the right N_m3u8DL-RE command with --key / --header / --save-dir
//   - bails clean when shell host / N_m3u8DL-RE / mp4decrypt is missing

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHarness({ shellHandler, cookies = [], hasShell = true, platform = 'darwin' } = {}) {
  const handler = shellHandler || (async () => ({ exitCode: 1, stdout: '', stderr: '' }));
  const calls = [];

  const win = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };
  const sandbox = {
    window: win, self: win,
    addEventListener: () => {}, removeEventListener: () => {},
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
    chrome: {
      runtime: { id: 'test-ext', connectNative: () => { throw new Error('no native'); } },
      tabs: {
        query: async () => [{ id: 1, windowId: 0, url: 'https://www.crunchyroll.com/watch/X' }],
        get: async (id) => ({ id, windowId: 0, url: 'https://www.crunchyroll.com/watch/X' }),
      },
      scripting: {
        executeScript: async ({ func, args }) => [{ result: await Promise.resolve(func.apply(null, args || [])) }]
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: {
        getAll: async (q) => cookies.filter(c => {
          if (q.domain) return c.domain.includes(q.domain) || q.domain.includes(c.domain.replace(/^\./, ''));
          if (q.url) { try { return c.domain.includes(new URL(q.url).hostname.replace(/^www\./, '')); } catch { return false; } }
          return true;
        })
      },
      cookies_old: {}, history: {}, bookmarks: {}, downloads: {},
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

  if (hasShell) {
    win.KyotoShell = {
      ShellHost: {
        send: async (msg, t) => {
          calls.push({ msg, t });
          if (msg.type === 'ping') return { platform, cwd: '/tmp' };
          if (msg.type === 'exec_bg') {
            const r = await handler(msg.command, t);
            return { jobId: 'job_test_1', idleTimeoutMs: msg.idleTimeoutMs, ...r };
          }
          return handler(msg.command, msg.timeoutMs);
        }
      },
      shell: async (cmd, t) => { calls.push({ cmd, t }); return handler(cmd, t); },
      ensureJobsSupported: async () => true,
    };
  } else {
    win.KyotoShell = null;
  }
  return { win, calls };
}

test('m3u8dl_check_setup reports shell host missing when bridge unavailable', async () => {
  const { win } = loadHarness({ hasShell: false });
  const r = await win.KyotoTools.call('m3u8dl_check_setup', {});
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('shellHost'));
});

test('_findWvd probe also searches the macOS-specific WVDs path', async () => {
  // The Python probe should glob in `~/Library/Application Support/devine/WVDs`
  // in addition to `~/.config/devine/devices`. The shell handler captures
  // every command so we can assert the path was included verbatim.
  let probeCmd = null;
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/devine\/devices|devine\/WVDs|kyoto\/wvd/.test(cmd)) { probeCmd = cmd; return { exitCode: 0, stdout: '' }; }
      return { exitCode: 0, stdout: '' };
    }
  });
  await win.KyotoTools.call('m3u8dl_check_setup', {});
  assert.ok(probeCmd, 'expected the wvd probe to run');
  assert.ok(/Library\/Application Support\/devine\/WVDs/.test(probeCmd),
    `probe command should include macOS WVDs path, got: ${probeCmd}`);
  assert.ok(/\.config\/devine\/devices/.test(probeCmd),
    `probe command should still include Linux path, got: ${probeCmd}`);
});

test('m3u8dl_check_setup ready=true when every piece is present', async () => {
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/N_m3u8DL-RE.*--version/.test(cmd)) return { exitCode: 0, stdout: '0.5.1+abcdef1234567\n' };
      if (/import pywidevine/.test(cmd)) return { exitCode: 0, stdout: '1.9.0\n' };
      if (/python3 --version|python --version/.test(cmd)) return { exitCode: 0, stdout: 'Python 3.11.5\n' };
      if (/pywidevine.*__version__/.test(cmd)) return { exitCode: 0, stdout: '1.9.0\n' };
      if (/devine\/devices|kyoto\/wvd/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.config/devine/devices/dev.wvd\n' };
      if (/command -v ffmpeg/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/ffmpeg\n' };
      if (/command -v mp4decrypt/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/mp4decrypt\n' };
      return { exitCode: 1, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('m3u8dl_check_setup', {});
  assert.equal(r.ready, true, JSON.stringify(r));
  assert.equal(r.m3u8dl.ok, true);
  assert.equal(r.python.ok, true);
  assert.equal(r.pywidevine.ok, true);
  assert.equal(r.wvd.ok, true);
});

test('m3u8dl_check_setup surfaces missing pieces with install guidance', async () => {
  const { win } = loadHarness();  // default: nothing installed
  const r = await win.KyotoTools.call('m3u8dl_check_setup', {});
  assert.equal(r.ready, false);
  // m3u8dl missing → instruction mentions m3u8dl_install
  assert.ok(r.missing.includes('m3u8dl'));
  assert.ok(r.instructions.some(i => /m3u8dl_install/.test(i)));
  // wvd missing → instruction is explicit about the hard wall
  assert.ok(r.missing.includes('wvd'));
  assert.ok(r.instructions.some(i => /\.wvd/.test(i) && /(distribute|sourcing)/i.test(i)));
});

test('m3u8dl_install detects platform tag and downloads the matching asset', async () => {
  let asked = [];
  const { win } = loadHarness({
    platform: 'darwin',
    shellHandler: async (cmd) => {
      asked.push(cmd);
      if (/N_m3u8DL-RE.*--version/.test(cmd)) return { exitCode: 1, stdout: '' };
      if (/uname -m/.test(cmd)) return { exitCode: 0, stdout: 'arm64\n' };
      if (/api\.github\.com.*N_m3u8DL-RE/.test(cmd)) {
        return { exitCode: 0, stdout: 'https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.2.0/N_m3u8DL-RE_v0.2.0_osx-arm64.tar.gz\n' };
      }
      if (/set -e/.test(cmd)) {
        // The install script. Pretend it succeeded.
        return { exitCode: 0, stdout: 'installed: /home/u/.local/bin/N_m3u8DL-RE\n' };
      }
      // After install, the second findM3U8DL call should succeed.
      return { exitCode: 1, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('m3u8dl_install', {});
  // The install path should have asked for the osx-arm64 asset.
  assert.ok(asked.some(c => /osx-arm64/.test(c)), `expected osx-arm64 in calls, got: ${asked.join('\n')}`);
  // Even though we returned "install succeeded", the subsequent
  // _findM3U8DL still returns nothing (we didn't simulate the binary
  // being on disk), so the tool reports the not-found follow-up.
  assert.equal(r.ok, false);
  assert.ok(r.log.some(l => /install reported success/i.test(l)),
    `expected post-install verification message, got: ${JSON.stringify(r.log)}`);
});

test('widevine_keys parses KID:KEY pairs from pywidevine stdout', async () => {
  let licenseCmd = null;
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/import pywidevine/.test(cmd)) return { exitCode: 0, stdout: '1.9.0\n' };
      if (/devine\/devices|kyoto\/wvd/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.wvd\n' };
      if (/-m pywidevine license/.test(cmd)) {
        licenseCmd = cmd;
        return {
          exitCode: 0,
          stdout:
            '[INFO] running license challenge\n' +
            '[Content Keys]\n' +
            '11112222333344445555666677778888:aabbccddeeff00112233445566778899\n' +
            'deadbeefdeadbeefdeadbeefdeadbeef:00112233445566778899aabbccddeeff\n'
        };
      }
      return { exitCode: 1, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('widevine_keys', {
    pssh: 'AAAA...',
    license_url: 'https://lic.example/widevine',
    headers: { 'x-cr-video-token': 'abc' }
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.keyCount, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.keys[0])), {
    kid: '11112222333344445555666677778888',
    key: 'aabbccddeeff00112233445566778899',
  });
  assert.ok(licenseCmd && /'x-cr-video-token'/.test(licenseCmd),
    `expected -H header passthrough in command, got: ${licenseCmd}`);
  assert.ok(/'AAAA\.\.\.'/.test(licenseCmd), 'PSSH should be quoted');
  assert.ok(/'https:\/\/lic\.example\/widevine'/.test(licenseCmd), 'license url should be quoted');
});

test('widevine_keys reports clean error when no .wvd is available', async () => {
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/import pywidevine/.test(cmd)) return { exitCode: 0, stdout: '1.9.0\n' };
      if (/devine\/devices|kyoto\/wvd/.test(cmd)) return { exitCode: 0, stdout: '' };
      return { exitCode: 1, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('widevine_keys', {
    pssh: 'A', license_url: 'https://lic.example'
  });
  assert.ok(r.error && /\.wvd/.test(r.error), `expected wvd error, got: ${JSON.stringify(r)}`);
});

test('m3u8dl_download bails clean when shell host is missing', async () => {
  const { win } = loadHarness({ hasShell: false });
  const r = await win.KyotoTools.call('m3u8dl_download', { manifest_url: 'https://x/m.mpd' });
  assert.ok(r.error && /Shell bridge/i.test(r.error));
});

test('m3u8dl_download builds command with --key, --header (Cookie), --save-dir', async () => {
  let bgSent = null;
  const { win } = loadHarness({
    cookies: [
      { name: 'sess', value: 'abc', domain: '.crunchyroll.com', path: '/', secure: true, httpOnly: true, expirationDate: 2e9 }
    ],
    shellHandler: async (cmd) => {
      if (/N_m3u8DL-RE.*--version/.test(cmd)) return { exitCode: 0, stdout: '0.5.1+abcdef1234567\n' };
      if (/command -v mp4decrypt/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/mp4decrypt\n' };
      if (/import pywidevine/.test(cmd)) return { exitCode: 0, stdout: '1.9.0\n' };
      if (/p\.write_bytes/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.cache/kyoto-m3u8dl/cookies-crunchyroll.com.txt\n' };
      if (/mkdir -p/.test(cmd)) return { exitCode: 0, stdout: '' };
      return { exitCode: 0, stdout: '' };
    }
  });
  // Intercept exec_bg.
  const origSend = win.KyotoShell.ShellHost.send;
  win.KyotoShell.ShellHost.send = async function (msg, t) {
    if (msg.type === 'exec_bg') bgSent = msg;
    return origSend.call(this, msg, t);
  };

  const r = await win.KyotoTools.call('m3u8dl_download', {
    manifest_url: 'https://www.crunchyroll.com/playback/manifest.mpd',
    keys: [
      { kid: '11112222333344445555666677778888', key: 'aabbccddeeff00112233445566778899' }
    ],
    cookies: true,
    save_name: 'episode-01'
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.jobId, 'job_test_1');
  assert.ok(bgSent, 'should send exec_bg');
  assert.ok(/--key '11112222333344445555666677778888:aabbccddeeff00112233445566778899'/.test(bgSent.command),
    `key flag missing: ${bgSent.command}`);
  assert.ok(/--save-name 'episode-01'/.test(bgSent.command), `save-name flag missing: ${bgSent.command}`);
  assert.ok(/--header 'Cookie: sess=abc'/.test(bgSent.command),
    `cookie header missing: ${bgSent.command}`);
  assert.ok(/--save-dir/.test(bgSent.command));
  assert.ok(/--auto-select/.test(bgSent.command));
  assert.ok(/--mux-after-done format=mp4/.test(bgSent.command));
});

test('m3u8dl_download warns when mp4decrypt is missing but keys are passed', async () => {
  let bgSent = null;
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/N_m3u8DL-RE.*--version/.test(cmd)) return { exitCode: 0, stdout: '0.5.1+abcdef1234567\n' };
      if (/command -v mp4decrypt/.test(cmd)) return { exitCode: 0, stdout: '' };  // missing
      if (/mkdir -p/.test(cmd)) return { exitCode: 0, stdout: '' };
      return { exitCode: 0, stdout: '' };
    }
  });
  const origSend = win.KyotoShell.ShellHost.send;
  win.KyotoShell.ShellHost.send = async function (msg, t) {
    if (msg.type === 'exec_bg') bgSent = msg;
    return origSend.call(this, msg, t);
  };
  const r = await win.KyotoTools.call('m3u8dl_download', {
    manifest_url: 'https://x/m.mpd',
    keys: [{ kid: 'a'.repeat(32), key: 'b'.repeat(32) }]
  });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some(n => /mp4decrypt not found/i.test(n)), JSON.stringify(r.notes));
});
