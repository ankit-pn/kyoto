// Shell bridge: chrome.runtime.connectNative to the kyoto-shell.py host.
// Exposes ShellHost + a tiny `_shell()` helper on window.KyotoShell so
// tools/youtube.js (and any future tool) can reuse it.

(() => {
  'use strict';
  const { T, STR, NUM, OBJ } = window.KyotoTR;

  const ShellHost = (() => {
    const HOST_NAME = 'com.kyoto.shell';
    let port = null;
    const pending = new Map();

    function disconnect(err) {
      port = null;
      for (const [id, { reject, timeoutId }] of pending) {
        clearTimeout(timeoutId);
        reject(err || new Error('shell host disconnected'));
      }
      pending.clear();
    }

    function ensurePort() {
      if (port) return port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (e) {
        throw new Error(`Native messaging not available: ${e.message}`);
      }
      port.onMessage.addListener((msg) => {
        const id = msg && msg.id;
        if (!id || !pending.has(id)) return;
        const { resolve, timeoutId } = pending.get(id);
        clearTimeout(timeoutId);
        pending.delete(id);
        resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        const lastErr = chrome.runtime.lastError;
        const e = lastErr
          ? new Error(`Shell host: ${lastErr.message}. Run the installer? curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`)
          : null;
        disconnect(e);
      });
      return port;
    }

    function send(msg, timeoutMs) {
      const id = msg.id || ('sh_' + Math.random().toString(36).slice(2, 11));
      msg.id = id;
      return new Promise((resolve, reject) => {
        let p;
        try { p = ensurePort(); } catch (e) { return reject(e); }
        const timeoutId = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`shell_exec timed out after ${Math.round(timeoutMs / 1000)}s`));
          }
        }, timeoutMs + 2000);
        pending.set(id, { resolve, reject, timeoutId });
        try { p.postMessage(msg); }
        catch (e) {
          clearTimeout(timeoutId);
          pending.delete(id);
          reject(e);
        }
      });
    }

    return { send, get extensionId() { return chrome.runtime.id; } };
  })();

  let _hostJobsSupported = null;
  async function _ensureJobsSupported() {
    if (_hostJobsSupported !== null) return _hostJobsSupported;
    try {
      const r = await ShellHost.send({ type: 'ping' }, 5000);
      _hostJobsSupported = !!r.jobs;
    } catch {
      _hostJobsSupported = false;
    }
    return _hostJobsSupported;
  }
  function _hostUpgradeHint() {
    return `Re-run the installer to upgrade: curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`;
  }

  // Exposed for tools/youtube.js (yt-dlp orchestration calls _shell directly).
  window.KyotoShell = {
    ShellHost,
    ensureJobsSupported: _ensureJobsSupported,
    upgradeHint: _hostUpgradeHint,
    shell: (command, timeoutMs = 60000) => ShellHost.send({ command, timeoutMs }, timeoutMs)
  };

  T({
    name: 'shell_exec',
    group: 'shell',
    description:
      'Execute a shell command synchronously and return when it finishes. ' +
      'TWO timeout modes: ' +
      '(a) wall-clock — pass `timeoutMs` only; kills after that many ms even if the command is still working. ' +
      '(b) **idle** — pass `idleTimeoutMs`; kills only when the command stops producing stdout/stderr for that long. This is the right choice for installs, downloads, builds, anything that prints progress. The wall-clock cap is removed. ' +
      'Returns { stdout, stderr, exitCode, idleMs?, elapsedMs?, killedReason? }. ' +
      'For commands you want to background (do other work while they run), use `shell_exec_bg` + `shell_poll`/`shell_wait` instead.',
    parameters: OBJ({
      command: STR,
      cwd: STR,
      timeoutMs: NUM,
      idleTimeoutMs: NUM,
      env: { type: 'object', additionalProperties: STR }
    }, ['command']),
    handler: async ({ command, cwd, timeoutMs = 60000, idleTimeoutMs, env } = {}) => {
      if (!command || !command.trim()) throw new Error('command required');
      const portTimeout = idleTimeoutMs ? Math.max(idleTimeoutMs * 6, 3600000) : timeoutMs;
      try {
        const payload = { command, cwd, env };
        if (idleTimeoutMs) payload.idleTimeoutMs = idleTimeoutMs;
        else payload.timeoutMs = timeoutMs;
        const r = await ShellHost.send(payload, portTimeout);
        if (r.error) return { error: r.error, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode, killedReason: r.killedReason };
        const out = { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode ?? null, cwd: r.cwd };
        if (r.idleMs !== undefined) out.idleMs = r.idleMs;
        if (r.elapsedMs !== undefined) out.elapsedMs = r.elapsedMs;
        if (r.killedReason) out.killedReason = r.killedReason;
        return out;
      } catch (e) {
        return {
          error: e.message,
          installHint: `Run: curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`,
          installHintWindows: `Run (PowerShell): $env:KYOTO_EXT_ID="${chrome.runtime.id}"; irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex`
        };
      }
    }
  });

  T({
    name: 'shell_exec_bg',
    group: 'shell',
    description:
      'Start a shell command IN BACKGROUND and return immediately with a `jobId`. The agent can do other work while the job runs. ' +
      'Use this for any command expected to take > 30s (installs, downloads, builds, training, large transfers). ' +
      'The job is auto-killed if it produces no new stdout/stderr for `idleTimeoutMs` (default 60s) — set this LARGER for commands with long silent phases. ' +
      'Pair with `shell_poll` (read current state), `shell_wait` (block until done), `shell_kill` (terminate), `shell_jobs` (list all). ' +
      'Returns { jobId, idleTimeoutMs }. Requires the v14.4+ shell host — older hosts will silently run this as a foreground exec.',
    parameters: OBJ({
      command: STR,
      cwd: STR,
      env: { type: 'object', additionalProperties: STR },
      idleTimeoutMs: NUM
    }, ['command']),
    handler: async ({ command, cwd, env, idleTimeoutMs = 60000 } = {}) => {
      if (!command || !command.trim()) throw new Error('command required');
      if (!await _ensureJobsSupported()) {
        return { error: `Shell host doesn't support background jobs (v14.4+ required). ${_hostUpgradeHint()}` };
      }
      try {
        const r = await ShellHost.send({ type: 'exec_bg', command, cwd, env, idleTimeoutMs }, 10000);
        if (r.error) return { error: r.error };
        if (!r.jobId) return { error: 'host did not return a jobId — shell bridge may be out of date. ' + _hostUpgradeHint() };
        return { jobId: r.jobId, idleTimeoutMs: r.idleTimeoutMs ?? idleTimeoutMs };
      } catch (e) { return { error: e.message }; }
    }
  });

  T({
    name: 'shell_poll',
    group: 'shell',
    description:
      'Read a background job\'s status + accumulated output. ' +
      'Returns { stdout, stderr, exitCode, done, idleMs, elapsedMs, killedReason, idleTimeoutMs }. ' +
      'Pass `clear: true` to truncate the buffer after read so the next poll only shows new output — keeps token cost flat for long-running jobs.',
    parameters: OBJ({ jobId: STR, clear: { type: 'boolean' } }, ['jobId']),
    handler: async ({ jobId, clear } = {}) => {
      if (!jobId) throw new Error('jobId required');
      if (!await _ensureJobsSupported()) {
        return { error: `Shell host doesn't support background jobs. ${_hostUpgradeHint()}` };
      }
      try {
        const r = await ShellHost.send({ type: 'job_poll', jobId, clear: !!clear }, 10000);
        if (r.error) return { error: r.error };
        return r;
      } catch (e) { return { error: e.message }; }
    }
  });

  T({
    name: 'shell_wait',
    group: 'shell',
    description:
      'Block until a background job finishes OR `maxWaitMs` elapses (default 30s). Internally polls every ~1s. ' +
      'Returns the final job status (same shape as `shell_poll`). If the job is still running when maxWaitMs hits, returns the latest snapshot with a `note` field — the job KEEPS RUNNING; call `shell_wait` again or `shell_kill` to stop it.',
    parameters: OBJ({ jobId: STR, maxWaitMs: NUM, pollMs: NUM, clear: { type: 'boolean' } }, ['jobId']),
    handler: async ({ jobId, maxWaitMs = 30000, pollMs = 1000, clear } = {}) => {
      if (!jobId) throw new Error('jobId required');
      if (!await _ensureJobsSupported()) {
        return { error: `Shell host doesn't support background jobs. ${_hostUpgradeHint()}` };
      }
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        let r;
        try { r = await ShellHost.send({ type: 'job_poll', jobId, clear: !!clear }, 10000); }
        catch (e) { return { error: e.message }; }
        if (r.error) return { error: r.error };
        if (r.done) return r;
        await new Promise(res => setTimeout(res, Math.max(200, pollMs)));
      }
      let r;
      try { r = await ShellHost.send({ type: 'job_poll', jobId, clear: !!clear }, 10000); }
      catch (e) { return { error: e.message }; }
      if (r.error) return { error: r.error };
      return { ...r, note: 'still running — call shell_wait again to keep waiting, or shell_kill to stop it' };
    }
  });

  T({
    name: 'shell_kill',
    group: 'shell',
    description: 'Terminate a background shell job by jobId. Returns { jobId, killed: true } or an error if the job is unknown.',
    parameters: OBJ({ jobId: STR, reason: STR }, ['jobId']),
    handler: async ({ jobId, reason } = {}) => {
      if (!jobId) throw new Error('jobId required');
      if (!await _ensureJobsSupported()) {
        return { error: `Shell host doesn't support background jobs. ${_hostUpgradeHint()}` };
      }
      try {
        const r = await ShellHost.send({ type: 'job_kill', jobId, reason }, 5000);
        if (r.error) return { error: r.error };
        return { jobId: r.jobId, killed: true };
      } catch (e) { return { error: e.message }; }
    }
  });

  T({
    name: 'shell_jobs',
    group: 'shell',
    description: 'List every background job the host knows about — running and completed. Returns { jobs: [{ jobId, command, done, exitCode, idleMs, elapsedMs, killedReason, cwd, idleTimeoutMs }] }.',
    parameters: OBJ(),
    handler: async () => {
      if (!await _ensureJobsSupported()) {
        return { error: `Shell host doesn't support background jobs. ${_hostUpgradeHint()}` };
      }
      try {
        const r = await ShellHost.send({ type: 'jobs_list' }, 5000);
        if (r.error) return { error: r.error };
        return { jobs: r.jobs || [] };
      } catch (e) { return { error: e.message }; }
    }
  });

  T({
    name: 'shell_ping',
    group: 'shell',
    description: 'Ping the native messaging host to verify it\'s installed and reachable. Returns { ok, platform, cwd, jobsSupported } on success — `jobsSupported: true` means the v14.4+ host with background-job + idle-timeout support is installed. Older hosts return `jobsSupported: false`; `shell_exec_bg`/`shell_poll`/etc. will not work until the user re-runs the installer.',
    parameters: OBJ(),
    handler: async () => {
      try {
        const r = await ShellHost.send({ type: 'ping' }, 5000);
        _hostJobsSupported = !!r.jobs;
        return { ok: true, platform: r.platform, cwd: r.cwd, jobsSupported: _hostJobsSupported };
      } catch (e) {
        return {
          ok: false,
          error: e.message,
          installHint: `curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${chrome.runtime.id}`,
          installHintWindows: `$env:KYOTO_EXT_ID="${chrome.runtime.id}"; irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex`
        };
      }
    }
  });
})();
