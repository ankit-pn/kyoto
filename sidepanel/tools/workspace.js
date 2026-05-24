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

    function _safeFolder(name) {
      const cleaned = String(name || '').trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
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
      if (!window.KyotoShell?.shell) return null;
      try {
        // python3 handles Windows + POSIX home expansion uniformly.
        // mkdir(exist_ok) so missing Documents folders are created.
        const r = await window.KyotoShell.shell(
          `python3 -c "import pathlib; p=pathlib.Path.home()/'Documents'; p.mkdir(exist_ok=True); print(str(p))"`,
          15000
        );
        const out = (r?.stdout || '').trim().split(/\r?\n/).pop();
        if (out && !r.error) docsRoot = out;
      } catch {}
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
        await window.KyotoShell.shell(
          `python3 -c "import pathlib; pathlib.Path(${JSON.stringify(dir)}).mkdir(parents=True, exist_ok=True)"`,
          10000
        );
      } catch {}
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
          out.note = 'Shell bridge not installed — using downloads-mode fallback.';
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
          const r = await window.KyotoShell.shell(
            `python3 -c "import shutil, pathlib, sys; src=${JSON.stringify(finalSrc)}; dst=${JSON.stringify(dest)}; pathlib.Path(dst).parent.mkdir(parents=True, exist_ok=True); shutil.move(src, dst); print(dst)"`,
            20000
          );
          const movedTo = (r?.stdout || '').trim().split(/\r?\n/).pop();
          if (r?.error || !movedTo) {
            out.note = 'move to Documents failed: ' + (r?.error || r?.stderr || 'unknown') + ' — file left in Downloads/' + settings.folder + '/';
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
      try {
        const r = await window.KyotoWorkspace.downloadUrl({ url, filename, saveAs });
        return { ok: true, bytes: blob.size, ...r };
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      }
    }
  });
})();
