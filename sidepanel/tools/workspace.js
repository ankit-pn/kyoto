// On-disk workspace folder. The single place every chrome.downloads
// call passes through, so the user has one knob ("workspaceFolder")
// that controls where the agent's generated files end up.
//
// Two modes:
//   - "downloads" (default, always works) — files land under
//     <Chrome's default Downloads dir>/<workspaceFolder>/. This is the
//     only filesystem location chrome.downloads.download can write to
//     in MV3 without a native host.
//   - "documents" (opt-in) — after the download finishes, we shell out
//     to the kyoto-shell.py native host and `mv` the file to
//     ~/Documents/<workspaceFolder>/. Requires the shell bridge to be
//     installed; if it's not, calls fall back to "downloads" with a
//     `note` in the result.
//
// Tools that produce files (fs_zip, chat_export, media_download, new
// workspace_save, etc.) call window.KyotoWorkspace.downloadUrl()
// instead of chrome.downloads.download() directly.

(() => {
  'use strict';

  const Workspace = (() => {
    let settings = { folder: 'Kyoto', location: 'downloads' };
    let docsRoot = null;
    let docsProbed = false;
    // Last failure from the documents-mode probe/mkdir, surfaced by
    // describe() instead of claiming the folder exists.
    let docsError = null;

    function _safeFolder(name) {
      // Strip both filesystem-illegal characters AND shell metacharacters
      // (', `, $) — the workspace folder name flows through shell commands
      // for the documents-mode mv. Leaving ' / $ / backtick in would let a
      // folder like `My's Stuff` break those.
      const cleaned = String(name || '').trim()
        .replace(/[\\/:*?"<>|'`$]+/g, '_')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ').trim();
      return cleaned || 'Kyoto';
    }
    function _safeFilename(name) {
      return String(name || '')
        .replace(/[\\:*?"<>|]+/g, '_')
        .replace(/\.\.+/g, '.')
        .replace(/^\/+/, '');
    }

    // The native host runs commands with `subprocess.run(..., shell=True)`
    // (install/kyoto-shell.py), so anything interpolated into the command
    // string is re-parsed by sh — or by cmd.exe on Windows. Nesting a JS
    // JSON literal into `python3 -c "…"` does not survive that: the quotes
    // terminate the -c argument and python sees a SyntaxError. Quoting is
    // also not portable (cmd.exe has no single-quote quoting; sh expands
    // $ and backticks inside double quotes). So keep the python program
    // itself inside double quotes (it contains no `"`, `$` or backticks)
    // and pass every path as an *unquoted* base64 argv token — the base64
    // alphabet [A-Za-z0-9+/=] needs no quoting under either shell.
    function _b64utf8(s) {
      const bytes = new TextEncoder().encode(String(s));
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }
    function _pyCmd(script, paths) {
      return `python3 -c "${script}" ${paths.map(_b64utf8).join(' ')}`;
    }

    function setFromSettings(s) {
      if (!s || typeof s !== 'object') return;
      if (s.workspaceFolder !== undefined) {
        settings.folder = _safeFolder(s.workspaceFolder);
      }
      if (s.workspaceLocation !== undefined) {
        settings.location = (s.workspaceLocation === 'documents') ? 'documents' : 'downloads';
        // Mode flipped → re-probe the shell host next describe() call.
        docsProbed = false;
        docsRoot = null;
      }
    }

    async function _readFromStorage() {
      try {
        const got = await chrome.storage.local.get(['workspaceFolder', 'workspaceLocation']);
        setFromSettings(got);
      } catch {}
    }

    function name() { return settings.folder; }
    function location() { return settings.location; }

    function relativePath(filename) {
      const clean = _safeFilename(filename || '');
      return `${settings.folder}/${clean}`;
    }

    async function _detectDocumentsRoot() {
      if (docsProbed) return docsRoot;
      docsProbed = true;
      if (!window.KyotoShell?.shell) {
        // Cheap check (no IPC) — don't cache it, the host may be
        // installed/connected after this call.
        docsProbed = false;
        return null;
      }
      try {
        // python3 handles Windows + POSIX home expansion uniformly.
        // mkdir(exist_ok) so missing Documents folders are created.
        const r = await window.KyotoShell.shell(
          `python3 -c "import pathlib; p=pathlib.Path.home()/'Documents'; p.mkdir(exist_ok=True); print(str(p))"`,
          15000
        );
        const out = (r?.stdout || '').trim().split(/\r?\n/).pop();
        if (r?.error || (typeof r?.exitCode === 'number' && r.exitCode !== 0)) {
          docsError = String(r.error || r.stderr || `exit ${r.exitCode}`).trim();
          docsRoot = null;
          docsProbed = false; // transient failure — allow a later retry
        } else if (out) {
          docsRoot = out;
          docsError = null;
        }
      } catch (e) {
        docsError = e?.message || String(e);
        docsProbed = false; // transient failure — allow a later retry
      }
      return docsRoot;
    }

    // For shell-host tools (yt-dlp, etc.) that write files themselves
    // instead of going through chrome.downloads. Returns a path that
    // can be passed to a shell command as the directory to write into;
    // safe to use as `${path}/%(title)s.%(ext)s` etc.
    async function shellDefaultDir() {
      if (settings.location === 'documents') {
        const dir = await ensureDocumentsDir();
        if (dir) return dir;
      }
      return `~/Downloads/${settings.folder}`;
    }

    async function ensureDocumentsDir() {
      const root = await _detectDocumentsRoot();
      if (!root) return null;
      const dir = `${root}/${settings.folder}`;
      try {
        const r = await window.KyotoShell.shell(_pyCmd(
          `import base64,pathlib,sys; p=base64.b64decode(sys.argv[1]).decode('utf-8'); pathlib.Path(p).mkdir(parents=True,exist_ok=True)`,
          [dir]
        ), 10000);
        if (r?.error || (typeof r?.exitCode === 'number' && r.exitCode !== 0)) {
          // Don't return a path that was never created — describe() and
          // downloadUrl() must fall back to Downloads instead.
          docsError = String(r?.error || r?.stderr || `exit ${r?.exitCode}`).trim();
          return null;
        }
        docsError = null;
      } catch (e) {
        docsError = e?.message || String(e);
        return null;
      }
      return dir;
    }

    async function describe() {
      const out = {
        folder: settings.folder,
        location: settings.location,
        downloadsPath: `<Chrome's default Downloads dir>/${settings.folder}/`,
      };
      if (settings.location === 'documents') {
        const dir = await ensureDocumentsDir();
        if (dir) {
          out.documentsPath = dir;
          out.shellHostAvailable = true;
        } else {
          out.shellHostAvailable = false;
          out.fallback = 'downloads';
          out.note = docsError
            ? `Shell bridge could not set up the Documents workspace: ${docsError} — using downloads-mode fallback.`
            : 'Shell bridge not installed — using downloads-mode fallback.';
        }
      }
      return out;
    }

    function _waitForDownload(id, timeoutMs = 30000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = async () => {
          try {
            const [d] = await chrome.downloads.search({ id });
            if (d && (d.state === 'complete' || d.state === 'interrupted')) {
              resolve(d.state === 'complete' ? d.filename : null);
              return;
            }
          } catch {}
          if (Date.now() - start > timeoutMs) { resolve(null); return; }
          setTimeout(tick, 400);
        };
        tick();
      });
    }

    async function downloadUrl({ url, filename, saveAs = false, conflictAction = 'uniquify' } = {}) {
      if (!url) throw new Error('url required');
      const rel = relativePath(filename);
      const downloadId = await chrome.downloads.download({
        url, filename: rel, saveAs, conflictAction
      });
      const out = {
        downloadId,
        folder: settings.folder,
        location: settings.location,
        path: rel,
      };
      if (settings.location === 'documents') {
        try {
          const docsDir = await ensureDocumentsDir();
          if (!docsDir) {
            out.note = 'documents mode requested but shell host unavailable — file left in Downloads/' + settings.folder + '/';
            return out;
          }
          const finalSrc = await _waitForDownload(downloadId);
          if (!finalSrc) {
            out.note = 'download did not complete in time — file not relocated';
            return out;
          }
          const baseName = _safeFilename(filename || finalSrc.split(/[\\/]/).pop());
          const dest = `${docsDir}/${baseName}`;
          const r = await window.KyotoShell.shell(_pyCmd(
            `import base64,pathlib,shutil,sys; d=lambda i: base64.b64decode(sys.argv[i]).decode('utf-8'); src=d(1); dst=d(2); pathlib.Path(dst).parent.mkdir(parents=True,exist_ok=True); shutil.move(src,dst); print(dst)`,
            [finalSrc, dest]
          ), 20000);
          const movedTo = (r?.stdout || '').trim().split(/\r?\n/).pop();
          if (r?.error || (typeof r?.exitCode === 'number' && r.exitCode !== 0)) {
            out.note = 'move to Documents failed: ' + String(r.error || r.stderr || `exit ${r.exitCode}`).trim() + ' — file left in Downloads/' + settings.folder + '/';
          } else if (!movedTo) {
            out.note = 'move to Documents failed: no destination path in host output — file left in Downloads/' + settings.folder + '/';
          } else {
            out.path = movedTo;
          }
        } catch (e) {
          out.note = 'move to Documents failed: ' + (e?.message || String(e));
        }
      }
      return out;
    }

    _readFromStorage();

    return {
      setFromSettings,
      name, location,
      relativePath,
      describe,
      ensureDocumentsDir,
      shellDefaultDir,
      downloadUrl,
      _safeFolder, _safeFilename,
    };
  })();

  window.KyotoWorkspace = Workspace;
  // Shared with media.js / fs.js so their blob-URL downloads use the same
  // download-lifecycle revoke instead of the old fixed 120 s timer.
  // (Function declarations hoist, so the helper is already defined here.)
  Workspace._revokeBlobUrlWhenDownloaded = _revokeBlobUrlWhenDownloaded;

  // Keep a blob: object URL alive until Chrome has actually finished
  // reading it. downloads.download() resolves as soon as the download is
  // merely queued; with saveAs:true the bytes are fetched only after the
  // user confirms the Save-As dialog, which can take minutes. Revoking on
  // a fixed 120 s timer (the old behaviour) therefore broke long save
  // dialogs / queued downloads with a dead URL. Revoke on the download's
  // terminal state instead, with a long fallback in case onChanged never
  // fires for this id.
  const BLOB_URL_FALLBACK_MS = 30 * 60 * 1000;
  function _revokeBlobUrlWhenDownloaded(url, downloadId) {
    const revoke = () => { try { URL.revokeObjectURL(url); } catch {} };
    let timer = null;
    let listener = null;
    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (listener) {
        try { chrome.downloads.onChanged.removeListener(listener); } catch {}
        listener = null;
      }
      revoke();
    };
    if (downloadId != null && chrome.downloads?.onChanged?.addListener) {
      listener = (delta) => {
        if (!delta || delta.id !== downloadId) return;
        const state = delta.state && delta.state.current;
        if (state === 'complete' || state === 'interrupted') finish();
      };
      try { chrome.downloads.onChanged.addListener(listener); } catch { listener = null; }
      // Documents mode waits for the download, so it may already have
      // settled before the listener was attached.
      try {
        chrome.downloads.search({ id: downloadId }).then(([d]) => {
          if (d && (d.state === 'complete' || d.state === 'interrupted')) finish();
        }).catch(() => {});
      } catch {}
      timer = setTimeout(finish, BLOB_URL_FALLBACK_MS);
    } else {
      // No download-lifecycle API available (test doubles / older hosts):
      // keep the old fixed delay rather than leaking the URL forever.
      timer = setTimeout(finish, 120000);
    }
  }

  // Register the workspace-introspection + workspace-save tools on the
  // shared registry. KyotoTR is set up by tools/core.js which loads
  // immediately before this file.
  const { T, STR, BOOL, OBJ } = window.KyotoTR;

  T({
    name: 'workspace_info',
    group: 'fs',
    description:
      'Return the user\'s configured on-disk workspace folder: { folder, location, downloadsPath, documentsPath?, shellHostAvailable?, note? }. ' +
      '`location` is "downloads" (subfolder of Chrome\'s default Downloads dir, always works) or "documents" (~/Documents/<folder>/, requires the kyoto-shell bridge). ' +
      'Use this when the user asks "where did that file go?" or before generating a new file you want to tell the user about.',
    parameters: OBJ(),
    handler: async () => window.KyotoWorkspace.describe()
  });

  T({
    name: 'workspace_save',
    group: 'fs',
    description:
      'Save a VFS file (or arbitrary text/base64 content) into the user\'s on-disk workspace folder. ' +
      'Either pass `vfsPath` (read from the in-browser scratch FS via fs_write/fs_append) or `content` + `encoding`. ' +
      'Returns { ok, path, location, folder, downloadId, bytes }. ' +
      'Prefer this over `fs_zip` for single files — `fs_zip` is for bundling the whole scratch FS.',
    parameters: OBJ({
      filename: STR,
      vfsPath: STR,
      content: STR,
      encoding: { type: 'string', enum: ['utf-8', 'base64'] },
      mime: STR,
      saveAs: BOOL
    }, ['filename']),
    handler: async ({ filename, vfsPath, content, encoding = 'utf-8', mime, saveAs = false } = {}) => {
      if (!filename) throw new Error('filename required');
      let blob;
      if (vfsPath) {
        if (!window.KyotoVFS) throw new Error('VFS not available');
        // VFS binary mode returns { base64, bytes, totalSize } — no mime.
        // Pull mime separately via stat() so the saved file gets the
        // right Content-Type when chrome.downloads writes it.
        const [data, st] = await Promise.all([
          window.KyotoVFS.read(vfsPath, { encoding: 'binary' }),
          window.KyotoVFS.stat(vfsPath).catch(() => null)
        ]);
        const b64 = data?.base64 || '';
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        blob = new Blob([bin], { type: mime || st?.mime || 'application/octet-stream' });
      } else if (content != null) {
        if (encoding === 'base64') {
          const bin = Uint8Array.from(atob(content), c => c.charCodeAt(0));
          blob = new Blob([bin], { type: mime || 'application/octet-stream' });
        } else {
          blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
        }
      } else {
        throw new Error('pass vfsPath OR content');
      }
      const url = URL.createObjectURL(blob);
      let r;
      try {
        r = await window.KyotoWorkspace.downloadUrl({ url, filename, saveAs });
      } catch (e) {
        // The download never started, so nothing will read the blob.
        try { URL.revokeObjectURL(url); } catch {}
        throw e;
      }
      _revokeBlobUrlWhenDownloaded(url, r?.downloadId);
      return { ok: true, bytes: blob.size, ...r };
    }
  });
})();
