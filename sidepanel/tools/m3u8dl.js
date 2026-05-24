// N_m3u8DL-RE downloader pipeline (https://github.com/nilaoda/N_m3u8DL-RE).
//
// Modern, actively maintained alternative to the archived `devine`. The
// architecture is intentionally decoupled:
//
//   pywidevine CLI         ← generates the license challenge, asks the
//                            license server for the keys, returns
//                            `KID:KEY` lines on stdout (needs your .wvd)
//   N_m3u8DL-RE            ← downloads DASH/HLS segments, decrypts with
//                            mp4decrypt using the keys we hand it,
//                            muxes with ffmpeg
//
// Unlike devine, N_m3u8DL-RE has NO service plugins — you bring the
// manifest URL, the cookies/headers, and the keys yourself. Kyoto's
// existing tools (cookies_export_netscape, widevine_extract_pssh,
// network_capture_list) already cover those, so the agent just stitches
// them together.
//
// Tools:
//   m3u8dl_check_setup   Probes binary + ffmpeg + mp4decrypt + python +
//                        pywidevine + .wvd. Returns ready/missing list.
//   m3u8dl_install       Downloads the right N_m3u8DL-RE release from
//                        GitHub for the user's platform, extracts to
//                        ~/.local/bin/.
//   widevine_keys        Wraps `pywidevine license` — given a PSSH +
//                        license URL + auth headers, returns {kid, key}
//                        pairs.
//   m3u8dl_download      Builds + runs the N_m3u8DL-RE command in the
//                        background. Takes manifest_url, keys (array
//                        from widevine_keys), cookies_path or headers,
//                        save_name. Returns jobId for shell_poll.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, activeTab } = window.KyotoTR;

  async function _shell(cmd, timeoutMs = 60000) {
    if (!window.KyotoShell?.shell) {
      return { error: 'Shell bridge not installed.', _noShell: true };
    }
    return window.KyotoShell.shell(cmd, timeoutMs);
  }

  // ──────── shared python + wvd helpers ────────
  //
  // Duplicated from drm.js for now — both files use the same machinery
  // and pulling them out into a shared helpers module is a bigger
  // refactor. Keep behaviour in sync if you change one.

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

  let _cachedPython = null;
  async function _findWorkingPython() {
    if (_cachedPython) return _cachedPython;
    for (const py of _PYTHON_INTERPRETERS) {
      try {
        const r = await _shell(`${py} -c "import pywidevine" 2>&1`, 8000);
        if (!r._noShell && r.exitCode === 0) { _cachedPython = py; return py; }
      } catch {}
    }
    for (const py of _PYTHON_INTERPRETERS) {
      try {
        const r = await _shell(`${py} --version 2>&1`, 5000);
        if (!r._noShell && r.exitCode === 0) return py;
      } catch {}
    }
    return null;
  }

  async function _findWvd() {
    const py = await _findWorkingPython() || 'python3';
    const r = await _shell(
      `${py} -c "import pathlib, os; ` +
      `roots=[pathlib.Path.home()/'.config/devine/devices', ` +
      `pathlib.Path.home()/'.config/kyoto/wvd', ` +
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

  // ──────── N_m3u8DL-RE binary probe + install ────────

  const _M3U8DL_PATHS = [
    '$HOME/.local/bin/N_m3u8DL-RE',
    '/opt/homebrew/bin/N_m3u8DL-RE',
    '/usr/local/bin/N_m3u8DL-RE',
    '/usr/bin/N_m3u8DL-RE',
  ];

  // N_m3u8DL-RE --version output looks like:
  //   0.5.1+c1f6db5639397dde362c31b31eebd88c796c90da
  // i.e. a semver prefix. The previous probe used `2>&1 | head -1`, which
  // exited 0 even when the binary was missing AND its `/N_m3u8DL-RE/i`
  // regex matched the SHELL ERROR MESSAGE ("/bin/sh: N_m3u8DL-RE: No such
  // file or directory") — a classic false positive. Require an actual
  // semver match and pass through the raw exit code.
  function _isVersionLine(s) {
    return /^\d+\.\d+\.\d+/.test((s || '').trim().split('\n')[0]);
  }

  async function _findM3U8DL() {
    for (const p of _M3U8DL_PATHS) {
      const r = await _shell(`${p} --version 2>&1`, 5000);
      if (r._noShell) return null;
      if (r.exitCode === 0 && _isVersionLine(r.stdout)) {
        return { binary: p, versionLine: (r.stdout || '').trim().split('\n')[0] };
      }
    }
    const which = await _shell('command -v N_m3u8DL-RE 2>/dev/null || true', 5000);
    if (which._noShell) return null;
    const out = (which.stdout || '').trim();
    if (out) {
      const r = await _shell(`${out} --version 2>&1`, 5000);
      if (r.exitCode === 0 && _isVersionLine(r.stdout)) {
        return { binary: out, versionLine: (r.stdout || '').trim().split('\n')[0] };
      }
    }
    return null;
  }

  // Map shell-host's platform + uname -m to the asset-name fragment used
  // in N_m3u8DL-RE GitHub releases.
  async function _detectPlatformTag() {
    let platform = 'linux';
    try {
      const p = await window.KyotoShell.ShellHost.send({ type: 'ping' }, 5000);
      if (p?.platform) platform = p.platform;
    } catch {}
    const archR = await _shell('uname -m 2>/dev/null || echo unknown', 5000);
    const arch = (archR.stdout || '').trim();
    if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
    if (platform === 'linux') return /aarch64|arm64/.test(arch) ? 'linux-arm64' : 'linux-x64';
    if (platform === 'win32') return 'win-x64';
    return null;
  }

  async function _installM3U8DL() {
    const log = [];
    const tag = await _detectPlatformTag();
    if (!tag) {
      return { ok: false, log: ['could not detect platform — install N_m3u8DL-RE manually from https://github.com/nilaoda/N_m3u8DL-RE/releases'] };
    }
    log.push(`platform tag: ${tag}`);

    // Resolve the latest release URL via the GitHub API. We do it via
    // curl + grep instead of a Python one-liner to avoid yet another
    // dependency on _findWorkingPython.
    const apiUrl = 'https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest';
    const probe = await _shell(
      `curl -sL ${apiUrl} | grep -oE '"browser_download_url": *"[^"]*${tag}[^"]*"' | head -1 | cut -d'"' -f4`,
      30000
    );
    const dlUrl = (probe.stdout || '').trim();
    if (!dlUrl) {
      return { ok: false, log: [...log, `no asset matching ${tag} in latest release JSON`] };
    }
    log.push(`download: ${dlUrl}`);

    // Stage into ~/.cache/kyoto-m3u8dl/, extract, copy the binary to
    // ~/.local/bin/. We support .tar.gz (linux/osx) and .zip (windows).
    const installScript = `
      set -e
      DIR="$HOME/.cache/kyoto-m3u8dl"
      mkdir -p "$DIR" "$HOME/.local/bin"
      cd "$DIR"
      rm -rf staging
      mkdir staging
      cd staging
      curl -sL -o asset "${dlUrl}"
      case "${dlUrl}" in
        *.tar.gz) tar -xzf asset ;;
        *.zip) unzip -q asset ;;
        *) echo "unsupported archive: ${dlUrl}"; exit 1 ;;
      esac
      # The release ships a single binary nested one level deep; find it.
      BIN=$(find . -type f -name 'N_m3u8DL-RE' -o -name 'N_m3u8DL-RE.exe' | head -1)
      if [ -z "$BIN" ]; then echo "binary not found in archive"; exit 1; fi
      cp "$BIN" "$HOME/.local/bin/N_m3u8DL-RE"
      chmod +x "$HOME/.local/bin/N_m3u8DL-RE"
      # macOS auto-quarantines anything Chrome (and our extension) downloads.
      # Without stripping com.apple.quarantine, Gatekeeper SIGKILLs the
      # binary on first run with "Killed: 9". xattr returns nonzero on
      # non-macOS systems and on macOS when the attribute is absent — both
      # safe to ignore. The 2>/dev/null suppresses the noise.
      xattr -d com.apple.quarantine "$HOME/.local/bin/N_m3u8DL-RE" 2>/dev/null || true
      echo "installed: $HOME/.local/bin/N_m3u8DL-RE"
    `;
    const r = await _shell(installScript, 180000);
    log.push(`install -> exit ${r.exitCode}`);
    if (r.stdout) log.push(...((r.stdout || '').trim().split('\n').slice(-5)));
    if (r.exitCode !== 0) return { ok: false, log, stderr: r.stderr };
    const found = await _findM3U8DL();
    return found ? { ok: true, ...found, log } : { ok: false, log: [...log, 'install reported success but binary still not found'] };
  }

  // ──────── cookie export (Netscape format) ────────
  //
  // Reused from drm.js logic. Kept here so m3u8dl is self-contained.

  function _netscapeCookies(cookies) {
    const lines = ['# Netscape HTTP Cookie File', '# Exported by Kyoto for N_m3u8DL-RE', ''];
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

  async function _writeCacheFile(name, contents) {
    const b64 = btoa(unescape(encodeURIComponent(contents)));
    const safe = (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const pyExe = await _findWorkingPython() || 'python3';
    const r = await _shell(
      `${pyExe} -c "import base64, os, pathlib; ` +
      `d=pathlib.Path.home()/'.cache/kyoto-m3u8dl'; d.mkdir(parents=True, exist_ok=True); ` +
      `p=d/'${safe}'; p.write_bytes(base64.b64decode('${b64}')); ` +
      `os.chmod(p, 0o600); print(str(p))"`,
      15000
    );
    if (r._noShell) return { error: 'shell bridge not installed' };
    const path = (r.stdout || '').trim().split(/\r?\n/).pop();
    if (r.exitCode !== 0 || !path) return { error: `write failed: ${r.stderr || r.stdout || 'unknown'}` };
    return { path };
  }

  async function _exportCookiesForUrl(targetUrl) {
    const u = new URL(targetUrl);
    const domain = u.hostname.replace(/^www\./, '');
    const cookies = await chrome.cookies.getAll({ domain });
    if (!cookies.length) return { error: `no cookies for ${domain}` };
    const wrote = await _writeCacheFile(`cookies-${domain.replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`, _netscapeCookies(cookies));
    if (wrote.error) return wrote;
    return { path: wrote.path, count: cookies.length, domain };
  }

  // ──────── TOOLS ────────

  T({
    name: 'm3u8dl_check_setup',
    group: 'media',
    description:
      'Probe the N_m3u8DL-RE DRM pipeline. Checks shell bridge, N_m3u8DL-RE binary, ffmpeg, mp4decrypt, a python interpreter that can import pywidevine, and at least one .wvd device file. ' +
      'Returns { ready, missing, instructions } so the agent knows exactly what to install before calling widevine_keys / m3u8dl_download.',
    parameters: OBJ({}),
    handler: async () => {
      const out = { shellHost: null, m3u8dl: null, ffmpeg: null, mp4decrypt: null, python: null, pywidevine: null, wvd: null };
      const missing = [];
      const instructions = [];

      if (!window.KyotoShell?.shell) {
        out.shellHost = { ok: false };
        missing.push('shellHost');
        instructions.push('Install the shell bridge: open Settings → Shell bridge.');
        return { ready: false, ...out, missing, instructions };
      }
      try {
        const pong = await window.KyotoShell.ShellHost.send({ type: 'ping' }, 5000);
        out.shellHost = { ok: true, platform: pong?.platform || 'unknown', cwd: pong?.cwd };
      } catch (e) { out.shellHost = { ok: false, error: e.message }; missing.push('shellHost'); }

      const m3u8 = await _findM3U8DL();
      if (m3u8) out.m3u8dl = { ok: true, ...m3u8 };
      else {
        out.m3u8dl = { ok: false };
        missing.push('m3u8dl');
        instructions.push('Run `m3u8dl_install` to fetch the right N_m3u8DL-RE release for your platform — it just downloads a single binary into ~/.local/bin/.');
      }

      const py = await _findWorkingPython();
      if (py) out.python = { ok: true, binary: py };
      else {
        out.python = { ok: false };
        missing.push('python');
        instructions.push('Install Python 3.10+ — the python.org installer is easiest on macOS. The system python3 on modern macOS has code-signing restrictions that block pywidevine\'s crypto extensions.');
      }

      if (py) {
        const pwv = await _shell(`${py} -c "import pywidevine; print(getattr(pywidevine, '__version__', '?'))" 2>&1`, 5000);
        if (pwv.exitCode === 0 && (pwv.stdout || '').trim()) {
          out.pywidevine = { ok: true, version: (pwv.stdout || '').trim() };
        } else {
          out.pywidevine = { ok: false };
          missing.push('pywidevine');
          instructions.push(`Install pywidevine into the working python: \`${py} -m pip install --user pywidevine\`.`);
        }
      } else {
        out.pywidevine = { ok: false };
        missing.push('pywidevine');
      }

      const wvd = await _findWvd();
      if (wvd?.found) out.wvd = { ok: true, paths: wvd.paths };
      else {
        out.wvd = { ok: false };
        missing.push('wvd');
        instructions.push('⚠️  THE HARD PART: place a Widevine device file at `~/.config/devine/devices/<name>.wvd` (or `~/.config/kyoto/wvd/`). Kyoto does NOT distribute .wvd files — they are leaked CDM identities and sourcing one is on you. Without a .wvd, NOTHING in the pipeline can decrypt anything.');
      }

      const ff = await _hasBinary('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
      out.ffmpeg = ff ? { ok: true, binary: ff } : { ok: false };
      if (!ff) { missing.push('ffmpeg'); instructions.push('Install ffmpeg: `brew install ffmpeg` (macOS) or `apt install ffmpeg`.'); }

      const mp4d = await _hasBinary('mp4decrypt', ['/opt/homebrew/bin/mp4decrypt', '/usr/local/bin/mp4decrypt']);
      out.mp4decrypt = mp4d ? { ok: true, binary: mp4d } : { ok: false };
      if (!mp4d) { missing.push('mp4decrypt'); instructions.push('Install mp4decrypt (Bento4): `brew install bento4` (macOS) or download from https://www.bento4.com/downloads/.'); }

      return { ready: missing.length === 0, ...out, missing, instructions };
    }
  });

  T({
    name: 'm3u8dl_install',
    group: 'media',
    description:
      'Download the latest N_m3u8DL-RE release from GitHub for the user\'s platform (auto-detected: osx-arm64, osx-x64, linux-x64, linux-arm64, win-x64) and install the binary into ~/.local/bin/. ' +
      'Idempotent — if it\'s already installed, returns { ok, alreadyInstalled, binary, versionLine } without re-downloading. ' +
      'Requires the shell bridge and `curl`.',
    parameters: OBJ({}),
    handler: async () => {
      const existing = await _findM3U8DL();
      if (existing) return { ok: true, alreadyInstalled: true, ...existing };
      return _installM3U8DL();
    }
  });

  T({
    name: 'widevine_keys',
    group: 'media',
    description:
      'Run `pywidevine license` to ask a license server for Widevine content keys given a PSSH and the user\'s .wvd. Parses the `KID:KEY` lines from stdout into a structured array. ' +
      'Use the output `keys` array directly with `m3u8dl_download` (which passes each as `--key kid:value`). ' +
      'REQUIRES: a working python with pywidevine importable AND a .wvd device file (run m3u8dl_check_setup first). ' +
      'You also need the license server URL (capture it from the page network traffic) and any auth headers the service requires (e.g. Authorization: Bearer ..., x-cr-video-token: ...).',
    parameters: OBJ({
      pssh: STR,
      license_url: STR,
      headers: OBJ(),
      wvd: STR,
    }, ['pssh', 'license_url']),
    handler: async ({ pssh, license_url, headers, wvd } = {}) => {
      if (!window.KyotoShell?.shell) return { error: 'Shell bridge not installed.' };
      const py = await _findWorkingPython();
      if (!py) return { error: 'No python interpreter found that can import pywidevine. Install Python 3.10+ + `pip install pywidevine`.' };

      // Resolve the .wvd file: caller can override; otherwise pick the
      // first one we find in the conventional locations.
      let wvdPath = wvd;
      if (!wvdPath) {
        const found = await _findWvd();
        if (!found?.paths?.length) {
          return { error: 'No .wvd device file found. Place one under ~/.config/devine/devices/ or ~/.config/kyoto/wvd/.' };
        }
        wvdPath = found.paths[0];
      }

      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const parts = [py, '-m', 'pywidevine', 'license', '-d', sq(wvdPath)];
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
          parts.push('-H', sq(k), sq(String(v)));
        }
      }
      parts.push(sq(pssh));
      parts.push(sq(license_url));
      const cmd = parts.join(' ');
      const r = await _shell(cmd + ' 2>&1', 60000);
      if (r._noShell) return { error: 'shell bridge unavailable' };
      const stdout = r.stdout || '';
      // pywidevine prints content keys as `KID:HEXKEY` (32-hex chars for KID,
      // 32 for KEY). Sometimes prefixed with log lines — grab every match.
      const keys = [];
      for (const m of stdout.matchAll(/\b([a-f0-9]{32}):([a-f0-9]{32})\b/gi)) {
        keys.push({ kid: m[1].toLowerCase(), key: m[2].toLowerCase() });
      }
      if (r.exitCode !== 0 && !keys.length) {
        return { error: `pywidevine exited ${r.exitCode}`, stdoutTail: stdout.slice(-1500), command: cmd };
      }
      return {
        ok: keys.length > 0,
        keys,
        keyCount: keys.length,
        wvd: wvdPath,
        stdoutTail: stdout.slice(-800),
        command: cmd,
      };
    }
  });

  T({
    name: 'm3u8dl_download',
    group: 'media',
    description:
      'Download (and decrypt + mux) a DASH/HLS stream via N_m3u8DL-RE. Pass `manifest_url` plus optional `keys` (from `widevine_keys`) for Widevine-protected content. ' +
      'For authenticated streams, either pass `cookies` (auto-exports the active tab\'s cookies to a Netscape file and includes them via `--header "Cookie: ..."`) or supply `headers` directly. ' +
      'Runs in the background — returns { ok, jobId, command, hint } so the agent can `shell_poll` for progress. Output lands under the on-disk workspace folder (see workspace_info). ' +
      'REQUIRES: N_m3u8DL-RE installed (call m3u8dl_install if not), ffmpeg, and mp4decrypt for Widevine content.',
    parameters: OBJ({
      manifest_url: STR,
      keys: { type: 'array', items: OBJ({ kid: STR, key: STR }, ['kid', 'key']) },
      cookies: BOOL,                  // auto-export from active tab
      cookies_for_url: STR,           // override URL whose cookies to export
      headers: OBJ(),                 // extra headers, merged on top
      save_name: STR,
      select_video: STR,              // default "best"
      select_audio: STR,
      mux_format: STR,                // default "mp4"
      extra_args: STR,
      tabId: NUM,
    }, ['manifest_url']),
    handler: async (args = {}) => {
      const {
        manifest_url, keys = [], cookies = false, cookies_for_url,
        headers = {}, save_name, select_video, select_audio,
        mux_format, extra_args = ''
      } = args;
      if (!window.KyotoShell?.shell) return { error: 'Shell bridge not installed.' };
      if (!manifest_url) return { error: 'manifest_url required' };

      // 1. Resolve / install N_m3u8DL-RE.
      let bin = await _findM3U8DL();
      let installLog;
      if (!bin) {
        const inst = await _installM3U8DL();
        installLog = inst.log;
        if (!inst.ok) return { error: 'N_m3u8DL-RE not installed and auto-install failed', installLog };
        bin = { binary: inst.binary };
      }

      // 2. Verify mp4decrypt if keys are being passed.
      const notes = [];
      if (keys.length) {
        const mp4d = await _hasBinary('mp4decrypt', ['/opt/homebrew/bin/mp4decrypt', '/usr/local/bin/mp4decrypt']);
        if (!mp4d) {
          notes.push('mp4decrypt not found — decryption will fail. Install Bento4 (brew install bento4 / https://www.bento4.com/downloads/).');
        }
      }

      // 3. Cookie file (optional).
      let cookieFile = null;
      let cookieHeader = null;
      if (cookies) {
        const target = cookies_for_url || manifest_url;
        const exp = await _exportCookiesForUrl(target);
        if (exp.error) notes.push(`cookie export skipped: ${exp.error}`);
        else {
          cookieFile = exp.path;
          // N_m3u8DL-RE doesn't accept a cookies file directly — pass
          // them as a Cookie: header on every request instead.
          const all = await chrome.cookies.getAll({ domain: new URL(target).hostname.replace(/^www\./, '') });
          cookieHeader = all.map(c => `${c.name}=${c.value}`).join('; ');
        }
      }

      // 4. Resolve workspace output dir + ensure it exists.
      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const outDir = await window.KyotoWorkspace?.shellDefaultDir?.() || '~/Downloads/Kyoto';
      const mkdirArg = outDir.startsWith('~/') ? `~/${sq(outDir.slice(2))}` : sq(outDir);
      await _shell(`mkdir -p ${mkdirArg}`, 10000);

      // 5. Build the N_m3u8DL-RE command.
      const parts = [bin.binary, sq(manifest_url)];
      parts.push('--save-dir', mkdirArg);
      parts.push('--tmp-dir', mkdirArg);
      if (save_name) parts.push('--save-name', sq(save_name));
      parts.push('--auto-select');
      if (select_video) parts.push('--select-video', sq(select_video));
      if (select_audio) parts.push('--select-audio', sq(select_audio));
      parts.push('--mux-after-done', `format=${mux_format || 'mp4'}`);
      // Use mp4decrypt by default — most reliable for Widevine.
      parts.push('--use-shaka-packager', 'false');
      for (const k of keys) {
        if (k?.kid && k?.key) parts.push('--key', sq(`${k.kid}:${k.key}`));
      }
      const allHeaders = { ...(headers || {}) };
      if (cookieHeader) allHeaders['Cookie'] = cookieHeader;
      for (const [k, v] of Object.entries(allHeaders)) {
        parts.push('--header', sq(`${k}: ${String(v)}`));
      }
      if (extra_args && extra_args.trim()) parts.push(extra_args.trim());
      const command = parts.join(' ');

      // 6. Spawn in the background — segment download can take minutes.
      const fullCmd = `${command} 2>&1`;
      if (!await window.KyotoShell.ensureJobsSupported?.()) {
        const r = await _shell(fullCmd, 270000);
        return {
          ok: r.exitCode === 0,
          mode: 'sync',
          exitCode: r.exitCode,
          stdoutTail: (r.stdout || '').slice(-2000),
          command, outDir, cookieFile, notes,
        };
      }
      const job = await window.KyotoShell.ShellHost.send({
        type: 'exec_bg', command: fullCmd, idleTimeoutMs: 600000
      }, 15000);
      if (job?.error || !job?.jobId) return { error: job?.error || 'failed to start background job', command };
      return {
        ok: true,
        mode: 'bg',
        jobId: job.jobId,
        idleTimeoutMs: job.idleTimeoutMs,
        command, outDir, cookieFile, notes,
        keyCount: keys.length,
        hint:
          `N_m3u8DL-RE is running. Poll with \`shell_poll { jobId: "${job.jobId}", clear: true }\` for ` +
          `incremental output, or \`shell_wait { jobId: "${job.jobId}", maxWaitMs: 60000 }\` to block ` +
          `until it finishes. Output lands under ${outDir}.`
      };
    }
  });
})();
