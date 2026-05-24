// Functional tests for the drm_* tools (devine wrapper). We can't run
// devine itself in CI — and we wouldn't want to (it needs a .wvd
// device file). Instead we stub the shell bridge + chrome.cookies and
// assert the wrapper:
//   - Detects missing setup pieces and returns clear guidance.
//   - Exports cookies in valid Netscape format.
//   - Bails cleanly when there's no .wvd, no shell host, etc.
//   - Builds the right devine command with the right flags + quoting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadHarness({ shellHandler, cookies = [], hasShell = true } = {}) {
  // shellHandler(cmd, timeoutMs) → { exitCode, stdout, stderr } | { error }
  // Default handler simulates "nothing is installed".
  const handler = shellHandler || (async (cmd) => {
    if (/--version/.test(cmd)) return { exitCode: 1, stdout: '', stderr: 'not found' };
    if (/command -v/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
    if (/python3 -c.*devine\/devices/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
    if (/python3 -c.*mkdir/.test(cmd)) return { exitCode: 0, stdout: 'OK', stderr: '' };
    if (/echo ok/.test(cmd)) return { exitCode: 0, stdout: 'ok', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const calls = [];

  const win = {
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  };
  const sandbox = {
    window: win,
    self: win,
    addEventListener: () => {},
    removeEventListener: () => {},
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
    chrome: {
      runtime: { id: 'test-ext', connectNative: () => { throw new Error('no native in test'); } },
      tabs: {
        query: async () => [{ id: 1, windowId: 0, url: 'https://www.crunchyroll.com/watch/GE00374498ENUS/foo' }],
        get: async (id) => ({ id, windowId: 0, url: 'https://www.crunchyroll.com/watch/GE00374498ENUS/foo' }),
      },
      scripting: {
        executeScript: async ({ func, args }) => {
          const result = await Promise.resolve(func.apply(null, args || []));
          return [{ result }];
        }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      cookies: {
        getAll: async (query) => cookies.filter(c => {
          if (query.domain) return c.domain.includes(query.domain) || query.domain.includes(c.domain.replace(/^\./, ''));
          if (query.url) { try { return c.domain.includes(new URL(query.url).hostname.replace(/^www\./, '')); } catch { return false; } }
          return true;
        })
      },
      history: {}, bookmarks: {}, downloads: {},
    },
    indexedDB: {},
    crypto: { subtle: {}, getRandomValues: (a) => a },
    fetch: async () => ({ ok: false, status: 0 }),
    URL,
    URLSearchParams,
    TextEncoder, TextDecoder,
    DataView, Uint8Array, ArrayBuffer,
    DOMParser: function () {},
    FileReader: function () {},
    Blob: function () {},
    HTMLInputElement: function () {},
    HTMLTextAreaElement: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Date, JSON, Object, Array, Set, Map, Number, String,
    Boolean, RegExp, Error, Promise, atob, btoa,
    unescape, encodeURIComponent,
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

  // Patch the shell bridge AFTER load (so drm.js's _shell sees our stub).
  if (hasShell) {
    win.KyotoShell = {
      ShellHost: {
        send: async (msg, timeoutMs) => {
          calls.push({ msg, timeoutMs });
          if (msg.type === 'ping') return { platform: 'test', cwd: '/tmp' };
          if (msg.type === 'exec_bg') {
            const r = await handler(msg.command, timeoutMs);
            return { jobId: 'job_test_1', idleTimeoutMs: msg.idleTimeoutMs, ...r };
          }
          // synchronous exec
          const r = await handler(msg.command, msg.timeoutMs);
          return r;
        }
      },
      shell: async (cmd, timeoutMs) => {
        calls.push({ cmd, timeoutMs });
        return handler(cmd, timeoutMs);
      },
      ensureJobsSupported: async () => true,
      upgradeHint: () => 'reinstall the shell bridge',
    };
  } else {
    win.KyotoShell = null;
  }

  return { win, calls };
}

test('drm_check_setup reports shell host missing when bridge is not installed', async () => {
  const { win } = loadHarness({ hasShell: false });
  const r = await win.KyotoTools.call('drm_check_setup', {});
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('shellHost'));
  assert.ok(r.instructions.some(i => /shell bridge/i.test(i)));
});

test('drm_check_setup reports devine missing with install instructions', async () => {
  const { win } = loadHarness();  // default stub returns "nothing installed"
  const r = await win.KyotoTools.call('drm_check_setup', {});
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('devine'), `expected devine in missing, got ${JSON.stringify(r.missing)}`);
  // devine is archived on PyPI as of 2025-07-09 — instructions should
  // tell the user to install from GitHub.
  assert.ok(r.instructions.some(i => /git\+https:\/\/github\.com\/devine-dl\/devine/.test(i)),
    `expected git install hint, got: ${JSON.stringify(r.instructions)}`);
  assert.ok(r.instructions.some(i => /archived/i.test(i)),
    `expected mention of the archived state, got: ${JSON.stringify(r.instructions)}`);
});

test('drm_check_setup reports .wvd missing even when devine is installed', async () => {
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/devine --version/.test(cmd) || /\/devine --version/.test(cmd)) {
        return { exitCode: 0, stdout: 'devine 3.0.0\n', stderr: '' };
      }
      if (/command -v devine/.test(cmd)) return { exitCode: 0, stdout: '/opt/homebrew/bin/devine\n' };
      if (/python3 -c.*devine\/devices/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' }; // no wvd
      if (/command -v ffmpeg/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/ffmpeg\n' };
      if (/command -v mp4decrypt/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/mp4decrypt\n' };
      return { exitCode: 1, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('drm_check_setup', {});
  assert.equal(r.devine.ok, true);
  assert.equal(r.wvd.ok, false);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('wvd'));
  assert.ok(r.instructions.some(i => /\.wvd|devices\//.test(i)));
});

test('drm_check_setup ready=true when every piece is present', async () => {
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/devine --version/.test(cmd) || /\/devine --version/.test(cmd)) return { exitCode: 0, stdout: 'devine 3.0.0\n' };
      if (/command -v devine/.test(cmd)) return { exitCode: 0, stdout: '/opt/homebrew/bin/devine\n' };
      if (/python3 -c.*devine\/devices/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.config/devine/devices/mydev.wvd\n' };
      if (/command -v ffmpeg/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/ffmpeg\n' };
      if (/command -v mp4decrypt/.test(cmd)) return { exitCode: 0, stdout: '/usr/local/bin/mp4decrypt\n' };
      return { exitCode: 0, stdout: '' };
    }
  });
  const r = await win.KyotoTools.call('drm_check_setup', {});
  assert.equal(r.ready, true, JSON.stringify(r));
  assert.equal(r.devine.version, '3.0.0');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.wvd.paths)), ['/home/u/.config/devine/devices/mydev.wvd']);
});

test('drm_export_cookies builds a valid Netscape file and writes via shell', async () => {
  const wroteCmds = [];
  const { win, calls } = loadHarness({
    cookies: [
      { name: 'session', value: 'abc123', domain: '.crunchyroll.com', path: '/', secure: true, httpOnly: true, expirationDate: 2000000000 },
      { name: 'lang', value: 'en-US', domain: 'www.crunchyroll.com', path: '/', secure: false, httpOnly: false, expirationDate: 2000000000 },
    ],
    shellHandler: async (cmd) => {
      wroteCmds.push(cmd);
      if (/p\.write_bytes/.test(cmd)) {
        return { exitCode: 0, stdout: '/home/u/.cache/kyoto-drm/cookies-crunchyroll.com.txt\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const r = await win.KyotoTools.call('drm_export_cookies', { domain: 'crunchyroll.com' });
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(r.count, 2);
  assert.equal(r.domain, 'crunchyroll.com');
  assert.equal(r.path, '/home/u/.cache/kyoto-drm/cookies-crunchyroll.com.txt');

  // The shell command should have included a base64-encoded Netscape file.
  const writeCmd = wroteCmds.find(c => /p\.write_bytes/.test(c));
  assert.ok(writeCmd, 'should have called write_bytes');
  const b64Match = writeCmd.match(/b64decode\('([^']+)'\)/);
  assert.ok(b64Match, `should have base64 payload, got: ${writeCmd.slice(0, 200)}`);
  const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
  assert.ok(/^# Netscape HTTP Cookie File/.test(decoded), `not a Netscape file: ${decoded.slice(0, 100)}`);
  assert.ok(/session\tabc123/.test(decoded), 'should contain session cookie');
  assert.ok(/#HttpOnly_/.test(decoded), 'httpOnly cookies need the prefix');
  assert.ok(/lang\ten-US/.test(decoded), 'should contain lang cookie');
});

test('drm_download bails clean when shell host is missing', async () => {
  const { win } = loadHarness({ hasShell: false });
  const r = await win.KyotoTools.call('drm_download', {
    service: 'CR',
    url: 'https://www.crunchyroll.com/watch/GE00374498ENUS/foo'
  });
  assert.ok(r.error && /Shell bridge/i.test(r.error), `expected shell error, got ${JSON.stringify(r)}`);
});

test('drm_download bails clean when no .wvd exists (after devine install)', async () => {
  const { win } = loadHarness({
    shellHandler: async (cmd) => {
      if (/devine --version/.test(cmd) || /\/devine --version/.test(cmd)) return { exitCode: 0, stdout: 'devine 3.0.0\n' };
      if (/command -v devine/.test(cmd)) return { exitCode: 0, stdout: '/opt/homebrew/bin/devine\n' };
      if (/python3 -c.*devine\/devices/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' }; // empty
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const r = await win.KyotoTools.call('drm_download', {
    service: 'CR',
    url: 'https://www.crunchyroll.com/watch/GE00374498ENUS/foo'
  });
  assert.ok(r.error && /\.wvd/i.test(r.error), `expected wvd error, got ${JSON.stringify(r)}`);
  assert.ok(/distribute/i.test(r.hint || ''));
});

test('drm_download spawns the right devine command via shell_exec_bg', async () => {
  let bgSent = null;
  const { win, calls } = loadHarness({
    cookies: [
      { name: 'session', value: 'abc', domain: '.crunchyroll.com', path: '/', secure: true, httpOnly: true, expirationDate: 2e9 },
    ],
    shellHandler: async (cmd) => {
      if (/devine --version/.test(cmd) || /\/devine --version/.test(cmd)) return { exitCode: 0, stdout: 'devine 3.0.0\n' };
      if (/command -v devine/.test(cmd)) return { exitCode: 0, stdout: '/opt/homebrew/bin/devine\n' };
      if (/python3 -c.*devine\/devices/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.config/devine/devices/mydev.wvd\n' };
      if (/p\.write_bytes/.test(cmd)) return { exitCode: 0, stdout: '/home/u/.cache/kyoto-drm/cookies-crunchyroll.com.txt\n' };
      if (/mkdir/.test(cmd)) return { exitCode: 0, stdout: '' };
      return { exitCode: 0, stdout: '' };
    }
  });

  // Capture the exec_bg payload.
  const origSend = win.KyotoShell.ShellHost.send;
  win.KyotoShell.ShellHost.send = async function (msg, t) {
    if (msg.type === 'exec_bg') bgSent = msg;
    return origSend.call(this, msg, t);
  };

  const r = await win.KyotoTools.call('drm_download', {
    service: 'CR',
    url: 'https://www.crunchyroll.com/watch/GE00374498ENUS/foo',
    quality: '1080p',
    audio_language: 'en'
  });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'bg');
  assert.equal(r.jobId, 'job_test_1');
  assert.equal(r.devineVersion, '3.0.0');
  assert.ok(bgSent, 'should have sent an exec_bg message');
  assert.ok(/devine.*dl.*-q '1080p'.*-l 'en'.*--cookies/.test(bgSent.command),
    `command missing expected flags: ${bgSent.command}`);
  assert.ok(/'CR'/.test(bgSent.command), 'service should be quoted');
  assert.ok(/'https:\/\/www\.crunchyroll\.com/.test(bgSent.command), 'url should be quoted');
  assert.ok(/kyoto-drm\/cookies-crunchyroll\.com\.txt/.test(bgSent.command),
    'should pass the exported cookies path');
});
