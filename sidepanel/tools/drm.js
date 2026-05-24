// DRM downloader — wrapper around `devine` (https://github.com/devine-dl/devine).
//
// What this is FOR:
//   End-to-end downloading of Widevine-protected video from supported
//   services (Crunchyroll, Disney+, etc.). The browser CDM can't expose
//   key bytes to JavaScript, so the actual decryption has to happen in
//   an external CDM emulator. Devine does that, plus per-service auth,
//   manifest parsing, segment download, and ffmpeg muxing.
//
// What this WON'T do:
//   - Ship a Widevine `.wvd` device file. Those are leaked CDM identities
//     and outside what this extension distributes. The user provides
//     their own at `~/.config/devine/devices/<name>.wvd`. Without one,
//     no Widevine flow works (browser, devine, or anything else).
//   - Replace per-service plugins. Devine has plugins for the major
//     services; this wrapper just spawns devine and passes through.
//
// What the wrapper actually adds on top of running devine by hand:
//   - Auto-install on first use (`pipx install devine`) using the same
//     ladder as `yt_dlp_run`.
//   - Cookie export from the user's logged-in tab → Netscape txt file
//     → `--cookies` flag. (Devine usually needs you to do this by hand.)
//   - Workspace folder integration — output lands wherever `workspace_info`
//     points (Downloads/<folder>/ or ~/Documents/<folder>/).
//   - Spawned via shell_exec_bg so the agent can poll progress without
//     blocking the chat turn.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, activeTab } = window.KyotoTR;

  async function _shell(cmd, timeoutMs = 60000) {
    if (!window.KyotoShell?.shell) {
      return { error: 'Shell bridge not installed. Open Settings → Shell bridge.', _noShell: true };
    }
    return window.KyotoShell.shell(cmd, timeoutMs);
  }

  // ──────── devine binary probe + auto-install ────────
  //
  // NOTE (2026-05): devine was archived 2025-07-09 and is no longer on
  // PyPI. `pip install devine` returns "No matching distribution found".
  // We install from the GitHub mirror instead. The CDM-Project fork
  // (https://www.cdm-project.com/CDRM-Team/devine) is also a viable
  // target for users who want active maintenance.

  const _DEVINE_PATHS = [
    '/opt/homebrew/bin/devine',
    '/usr/local/bin/devine',
    '$HOME/.local/bin/devine',
    '/opt/local/bin/devine',
    // macOS framework Python from python.org installer — common on macOS
    // when the user installed pywidevine via pip3 instead of pipx.
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/devine',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/devine',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/devine',
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/devine',
  ];

  // Python interpreters to try when probing `python -m devine` and when
  // installing devine. Framework Python comes first because system
  // python3 on modern macOS has code-signing restrictions that block
  // some user-installed C extensions (e.g. pycryptodome's _cpuid_c.so).
  const _PYTHON_INTERPRETERS = [
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    'python3',
    'python',
  ];

  // Find a python that can import pywidevine — strong proxy for "this
  // interpreter has a working crypto stack". We prefer this one for
  // any `python -m devine` invocation and for the auto-install step.
  let _cachedWorkingPython = null;
  async function _findWorkingPython() {
    if (_cachedWorkingPython) return _cachedWorkingPython;
    for (const py of _PYTHON_INTERPRETERS) {
      try {
        const r = await _shell(`${py} -c "import pywidevine; print(pywidevine.__version__ if hasattr(pywidevine, '__version__') else 'ok')" 2>&1`, 8000);
        if (!r._noShell && r.exitCode === 0 && (r.stdout || '').trim()) {
          _cachedWorkingPython = py;
          return py;
        }
      } catch {}
    }
    // Fall back to any python at all so we can still try installs.
    for (const py of _PYTHON_INTERPRETERS) {
      try {
        const r = await _shell(`${py} --version 2>&1`, 5000);
        if (!r._noShell && r.exitCode === 0) return py;
      } catch {}
    }
    return null;
  }

  async function _devineProbe(invocation) {
    try {
      const r = await _shell(`${invocation} --version 2>&1`, 8000);
      if (r._noShell || r.exitCode !== 0) return null;
      const m = (r.stdout || '').trim().match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  async function _findDevine() {
    for (const p of _DEVINE_PATHS) {
      const v = await _devineProbe(p);
      if (v) return { binary: p, version: v };
    }
    const r = await _shell('command -v devine 2>/dev/null || true', 5000);
    if (r._noShell) return null;
    const out = (r.stdout || '').trim();
    if (out) {
      const v = await _devineProbe(out);
      if (v) return { binary: out, version: v };
    }
    // Try `python -m devine` against every interpreter, framework Python
    // first — that's where pywidevine usually ends up on macOS.
    for (const py of _PYTHON_INTERPRETERS) {
      const v = await _devineProbe(`${py} -m devine`);
      if (v) return { binary: `${py} -m devine`, version: v };
    }
    return null;
  }

  async function _devineAutoInstall() {
    const log = [];
    const py = await _findWorkingPython();
    if (!py) {
      log.push('no usable python3 found on PATH or in framework locations');
      return { ok: false, log, hint: 'install Python 3.10+ first (python.org installer is easiest on macOS)' };
    }
    log.push(`using python: ${py}`);

    // PyPI install is dead since devine was archived 2025-07-09. We
    // still try it first in case PyPI gets a maintained republish; then
    // fall through to the git+https path, then to the CDM-Project fork.
    const candidates = [
      `${py} -m pip install --user --upgrade devine`,
      `${py} -m pip install --user "git+https://github.com/devine-dl/devine.git"`,
      `${py} -m pip install --user "git+https://github.com/CDRM-Project/devine.git"`,
    ];
    for (const c of candidates) {
      try {
        const r = await _shell(c + ' 2>&1', 300000);
        if (r._noShell) return { ok: false, log: ['shell bridge not installed'] };
        log.push(`${c} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) {
          const found = await _findDevine();
          if (found) { log.push(`devine ok at: ${found.binary}`); return { ok: true, ...found, log }; }
          log.push('install reported success but devine binary not found on PATH — may need to add the install dir to PATH');
        } else {
          // Surface a short tail of the error so the caller knows why
          // it failed instead of getting a bare exit code.
          const tail = (r.stdout || '').slice(-300);
          if (tail) log.push(`  ↳ ${tail.trim().split('\n').slice(-3).join(' | ')}`);
        }
      } catch (e) { log.push(`${c} -> ${e.message}`); }
    }
    return {
      ok: false,
      log,
      hint:
        'devine was archived on 2025-07-09 and is no longer on PyPI. The git installer should still work; ' +
        'if it failed, try the CDM-Project fork (https://www.cdm-project.com/CDRM-Team/devine) or switch ' +
        'to a different DRM downloader entirely (e.g. N_m3u8DL-RE).'
    };
  }

  // ──────── .wvd device file probe ────────
  //
  // Devine looks for devices in `~/.config/devine/devices/` on Linux/macOS
  // and `%APPDATA%/devine/devices/` on Windows. We check both. We can't
  // know if a device is actually loadable without running devine — but
  // presence of any .wvd file is a strong signal that setup is done.

  async function _findWvd() {
    const py = await _findWorkingPython() || 'python3';
    const r = await _shell(
      `${py} -c "import pathlib, os, sys; ` +
      `roots=[pathlib.Path.home()/'.config/devine/devices', ` +
      `pathlib.Path(os.environ.get('APPDATA',''))/'devine/devices' if os.environ.get('APPDATA') else None]; ` +
      `roots=[r for r in roots if r and r.exists()]; ` +
      `hits=[str(f) for r in roots for f in r.glob('*.wvd')]; ` +
      `print('\\n'.join(hits))"`,
      10000
    );
    if (r._noShell) return null;
    const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    return { found: lines.length > 0, paths: lines };
  }

  // ──────── ffmpeg / mp4decrypt probes ────────

  async function _hasBinary(name, candidates = []) {
    const r = await _shell(`command -v ${name} 2>/dev/null || true`, 5000);
    if (r._noShell) return null;
    const out = (r.stdout || '').trim();
    if (out) return out;
    for (const c of candidates) {
      const r2 = await _shell(`test -x ${c} && echo OK || true`, 5000);
      if (/OK/.test(r2.stdout || '')) return c;
    }
    return null;
  }

  // ──────── cookie export ────────
  //
  // Devine accepts a Netscape cookies.txt via `--cookies <path>`. We
  // build it from chrome.cookies.getAll (which includes httpOnly) and
  // write it through the shell bridge. Files go under a cache dir so
  // we don't pollute the workspace folder with auth material.

  function _netscapeCookies(cookies) {
    const lines = [
      '# Netscape HTTP Cookie File',
      '# Exported by Kyoto for devine',
      ''
    ];
    for (const c of cookies) {
      const hasLeadingDot = c.domain.startsWith('.');
      const includeSub = hasLeadingDot ? 'TRUE' : 'FALSE';
      const httpsOnly = c.secure ? 'TRUE' : 'FALSE';
      const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      const row = [c.domain, includeSub, c.path || '/', httpsOnly, exp, c.name, c.value].join('\t');
      lines.push(c.httpOnly ? '#HttpOnly_' + row : row);
    }
    return lines.join('\n') + '\n';
  }

  async function _writeCookieFile(domain, contents) {
    // Quote-safe: base64-encode the contents, decode on the shell side.
    const b64 = btoa(unescape(encodeURIComponent(contents)));
    const safeDomain = (domain || 'cookies').replace(/[^a-zA-Z0-9._-]/g, '_');
    const pyExe = await _findWorkingPython() || 'python3';
    const py =
      `${pyExe} -c "import base64, os, pathlib; ` +
      `d=pathlib.Path.home()/'.cache/kyoto-drm'; d.mkdir(parents=True, exist_ok=True); ` +
      `p=d/'cookies-${safeDomain}.txt'; ` +
      `p.write_bytes(base64.b64decode('${b64}')); ` +
      `os.chmod(p, 0o600); print(str(p))"`;
    const r = await _shell(py, 15000);
    if (r._noShell) return { error: 'shell bridge not installed' };
    const path = (r.stdout || '').trim().split(/\r?\n/).pop();
    if (r.exitCode !== 0 || !path) {
      return { error: `cookie write failed: ${r.stderr || r.stdout || 'unknown'}` };
    }
    return { path };
  }

  async function _exportCookiesToFile(domain) {
    const query = domain ? { domain } : { url: (await activeTab()).url };
    const cookies = await chrome.cookies.getAll(query);
    if (!cookies.length) return { error: `no cookies for ${domain || query.url}` };
    const txt = _netscapeCookies(cookies);
    const wrote = await _writeCookieFile(domain || new URL(query.url).hostname, txt);
    if (wrote.error) return wrote;
    return { path: wrote.path, count: cookies.length, domain: domain || new URL(query.url).hostname };
  }

  // ──────── TOOLS ────────

  T({
    name: 'drm_check_setup',
    group: 'media',
    description:
      'Probe whether the DRM-download pipeline is ready: shell bridge installed, devine on PATH, at least one .wvd device file present, ffmpeg + mp4decrypt available. ' +
      'Returns { ready, shellHost, devine, wvd, ffmpeg, mp4decrypt, missing, instructions } so the agent can tell the user exactly what to install before calling drm_download.',
    parameters: OBJ({}),
    handler: async () => {
      const out = { shellHost: null, devine: null, wvd: null, ffmpeg: null, mp4decrypt: null };
      const missing = [];
      const instructions = [];

      if (!window.KyotoShell?.shell) {
        out.shellHost = { ok: false };
        missing.push('shellHost');
        instructions.push('Install the shell bridge: open Settings → Shell bridge for the one-line installer.');
        return { ready: false, ...out, missing, instructions };
      }
      try {
        // shell host accepts {type:'ping'} for a platform string; fall back
        // to a plain echo if ping isn't supported (older host).
        const pong = await window.KyotoShell.ShellHost.send({ type: 'ping' }, 5000);
        out.shellHost = { ok: true, platform: pong?.platform || 'unknown', cwd: pong?.cwd };
      } catch (e) { out.shellHost = { ok: false, error: e.message }; missing.push('shellHost'); }

      // Track which python we found and whether it has pywidevine — the
      // model needs this to pick the right invocation.
      const workingPy = await _findWorkingPython();
      out.python = workingPy ? { ok: true, binary: workingPy, hasPywidevine: true } : { ok: false };

      const devine = await _findDevine();
      if (devine) out.devine = { ok: true, ...devine };
      else {
        out.devine = { ok: false };
        missing.push('devine');
        instructions.push(
          'devine was archived on 2025-07-09 and removed from PyPI. Install from GitHub instead: ' +
          `\`${workingPy || 'python3'} -m pip install --user "git+https://github.com/devine-dl/devine.git"\`. ` +
          'drm_download will try this automatically. The CDM-Project fork (https://www.cdm-project.com/CDRM-Team/devine) ' +
          'is also an option if the original repo gets taken down.'
        );
        // Service plugins are an additional gotcha — devine ships with
        // ~zero working service plugins by default. Mention it so the
        // user doesn't get stuck after install.
        instructions.push(
          'After installing devine you also need a SERVICE PLUGIN for the site you want to download from ' +
          '(e.g. Crunchyroll). Devine plugins live under `services/<TAG>/` in the devine config dir; ' +
          'community plugins are typically distributed via private channels.'
        );
      }

      const wvd = await _findWvd();
      if (wvd?.found) out.wvd = { ok: true, paths: wvd.paths };
      else { out.wvd = { ok: false };
        missing.push('wvd');
        instructions.push(
          '⚠️  THE HARD PART: place a Widevine device file at `~/.config/devine/devices/<name>.wvd` and ' +
          'set it as the default in `~/.config/devine/devine.yaml` (`cdm.default: <name>`). ' +
          'Kyoto does NOT distribute .wvd files — these are leaked CDM identities tied to a specific device. ' +
          'Sourcing one is on you (KeyDive on a rooted Android, or community channels). Without a .wvd, NOTHING ' +
          'in the pipeline can decrypt anything.'
        );
      }

      const ff = await _hasBinary('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
      out.ffmpeg = ff ? { ok: true, binary: ff } : { ok: false };
      if (!ff) { missing.push('ffmpeg'); instructions.push('Install ffmpeg: `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Debian/Ubuntu).'); }

      const mp4d = await _hasBinary('mp4decrypt', ['/opt/homebrew/bin/mp4decrypt', '/usr/local/bin/mp4decrypt']);
      out.mp4decrypt = mp4d ? { ok: true, binary: mp4d } : { ok: false };
      if (!mp4d) {
        missing.push('mp4decrypt');
        instructions.push(
          'Install mp4decrypt (part of Bento4): on macOS, `brew install bento4` if you have Homebrew, ' +
          'otherwise download the macOS arm64/x64 SDK from https://www.bento4.com/downloads/, unzip, and ' +
          'add the bin/ folder to PATH. On Linux: `apt install bento4` or build from source.'
        );
      }

      return { ready: missing.length === 0, ...out, missing, instructions };
    }
  });

  T({
    name: 'drm_export_cookies',
    group: 'media',
    description:
      'Export cookies for a domain (default: the active tab\'s domain) to a Netscape `cookies.txt` file under `~/.cache/kyoto-drm/`. ' +
      'Returns { path, count, domain }. Pass `path` to drm_download or any other devine invocation via `--cookies <path>`. ' +
      'Useful on its own if the user wants to run devine manually with their browser session.',
    parameters: OBJ({ domain: STR, tabId: NUM }),
    handler: async ({ domain } = {}) => {
      const r = await _exportCookiesToFile(domain);
      return r.error ? { error: r.error } : r;
    }
  });

  T({
    name: 'drm_download',
    group: 'media',
    description:
      'Download a DRM-protected video end-to-end via devine. Auto-installs devine from GitHub if missing (devine was archived 2025-07-09 and is no longer on PyPI — we install from git+https://github.com/devine-dl/devine.git). Exports the active tab\'s cookies to a Netscape file and passes them to devine via --cookies. ' +
      'Runs in the background — returns { ok, jobId, command, hint } so the agent can shell_poll / shell_wait for progress. Files land under the on-disk workspace folder (see workspace_info). ' +
      'REQUIRES: shell bridge installed, a Widevine .wvd at ~/.config/devine/devices/ (Kyoto does not ship one — call drm_check_setup first to see what\'s missing), and a working devine service plugin for the target site.',
    parameters: OBJ({
      service: STR,           // devine service tag, e.g. "CR" for Crunchyroll
      url: STR,               // the watch page URL or a service-specific title id
      quality: STR,           // e.g. "1080p", "720p"
      audio_language: STR,    // e.g. "en"
      subtitle_language: STR, // e.g. "en"
      vaults: STR,            // optional comma-separated devine vault names
      extra_args: STR,        // passthrough to devine
      tabId: NUM,
    }, ['service', 'url']),
    handler: async (args = {}) => {
      const { service, url, quality, audio_language, subtitle_language, vaults, extra_args = '' } = args;
      if (!window.KyotoShell?.shell) {
        return { error: 'Shell bridge not installed. Open Settings → Shell bridge.' };
      }
      if (!url) return { error: 'url required' };
      if (!service) return { error: 'service required (devine service tag, e.g. "CR" for Crunchyroll)' };

      // 1. Ensure devine binary is available.
      let devine = await _findDevine();
      let installLog;
      if (!devine) {
        const inst = await _devineAutoInstall();
        installLog = inst.log;
        if (!inst.ok) {
          return {
            error: 'devine is not installed and auto-install failed',
            installLog,
            hint: 'Install manually:  pipx install devine   (or:  pip3 install --user devine).'
          };
        }
        devine = { binary: inst.binary, version: inst.version };
      }

      // 2. Verify .wvd presence so devine doesn't fail with a cryptic CDM error.
      const wvd = await _findWvd();
      if (!wvd?.found) {
        return {
          error: 'No Widevine device file (.wvd) found',
          searched: ['~/.config/devine/devices/', '%APPDATA%/devine/devices/'],
          hint: 'Place a .wvd file in one of those folders and set it as the default in ~/.config/devine/devine.yaml under `cdm.default`. Kyoto does not distribute .wvd files — sourcing one is on you.'
        };
      }

      // 3. Export cookies from the active tab for the URL's domain.
      const u = new URL(url);
      const cookiesRes = await _exportCookiesToFile(u.hostname.replace(/^www\./, ''));
      let cookiesPath = null;
      if (cookiesRes.error) {
        // Non-fatal — devine can work without cookies for some flows.
        installLog = (installLog || []).concat([`cookie export skipped: ${cookiesRes.error}`]);
      } else {
        cookiesPath = cookiesRes.path;
      }

      // Shell single-quote helper. `'foo'\''bar'` is the standard way
      // to embed a literal apostrophe inside single-quoted shell text.
      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

      // 4. Resolve the workspace output dir. Make sure it exists —
      // devine doesn't always mkdir its target. The `~/` prefix needs
      // to expand at the shell level so we can't fully single-quote it;
      // split the leading `~/` off and quote only the rest.
      const outDir = await window.KyotoWorkspace?.shellDefaultDir?.() || '~/Downloads/Kyoto';
      const mkdirArg = outDir.startsWith('~/')
        ? `~/${sq(outDir.slice(2))}`
        : sq(outDir);
      await _shell(`mkdir -p ${mkdirArg}`, 10000);

      // 5. Build the devine command.
      const parts = [devine.binary, 'dl'];
      if (quality) parts.push('-q', sq(quality));
      if (audio_language) parts.push('-l', sq(audio_language));
      if (subtitle_language) parts.push('-sl', sq(subtitle_language));
      if (vaults) parts.push('-v', sq(vaults));
      if (cookiesPath) parts.push('--cookies', sq(cookiesPath));
      if (extra_args && extra_args.trim()) parts.push(extra_args.trim());
      parts.push(sq(service));
      parts.push(sq(url));
      const command = parts.join(' ');

      // 6. Spawn in the background — devine downloads can take minutes.
      const fullCmd = `cd ${sq(outDir)} && ${command} 2>&1`;
      if (!await window.KyotoShell.ensureJobsSupported?.()) {
        // Fall back to sync exec with a long idle timeout. The chat-loop
        // tool timeout (5min default) still bounds this.
        const r = await _shell(fullCmd, 270000);
        return {
          ok: r.exitCode === 0,
          mode: 'sync',
          exitCode: r.exitCode,
          stdoutTail: (r.stdout || '').slice(-2000),
          stderrTail: (r.stderr || '').slice(-1000),
          command,
          outDir,
          cookiesPath,
          installLog,
          hint: r.exitCode === 0
            ? `File should be under ${outDir}.`
            : `devine exited ${r.exitCode}. Check stderr/stdout. Run drm_check_setup to verify the pipeline.`,
        };
      }
      const job = await window.KyotoShell.ShellHost.send({
        type: 'exec_bg', command: fullCmd, idleTimeoutMs: 600000  // 10 min idle for slow segments
      }, 15000);
      if (job?.error || !job?.jobId) {
        return { error: job?.error || 'failed to start background job', command };
      }
      return {
        ok: true,
        mode: 'bg',
        jobId: job.jobId,
        idleTimeoutMs: job.idleTimeoutMs,
        command,
        outDir,
        cookiesPath,
        wvdPaths: wvd.paths,
        devineVersion: devine.version,
        installLog,
        hint:
          `Devine is running in the background. Poll with \`shell_poll { jobId: "${job.jobId}", clear: true }\` ` +
          `to read incremental output, or \`shell_wait { jobId: "${job.jobId}", maxWaitMs: 60000 }\` to block until ` +
          `it finishes. Output lands under ${outDir}.`
      };
    }
  });
})();
