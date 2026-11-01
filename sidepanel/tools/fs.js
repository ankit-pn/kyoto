// Virtual-filesystem tools (backed by IndexedDB via window.KyotoVFS).
// Used by the agent as a scratch workspace that survives panel reloads.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ } = window.KyotoTR;

  function _vfs() {
    if (!window.KyotoVFS) throw new Error('VFS not loaded');
    return window.KyotoVFS;
  }

  T({
    name: 'fs_write',
    group: 'fs',
    description:
      'Write a file into the agent\'s virtual workspace (IndexedDB-backed, persists across panel reloads). ' +
      'Use this to checkpoint scraped data, intermediate JSON, generated code, etc. outside the conversation context. ' +
      '`path` is absolute under "/" — e.g. "/scrape/users/page-1.json". Existing files are overwritten; use `fs_append` to extend instead. ' +
      'Bytes are stored as-is; on read they\'re decoded as UTF-8 unless you ask for binary.',
    parameters: OBJ({ path: STR, content: STR, mime: STR }, ['path', 'content']),
    handler: async ({ path, content, mime } = {}) => _vfs().write(path, content, { mime })
  });

  T({
    name: 'fs_append',
    group: 'fs',
    description:
      'Append text to a workspace file (creates it if missing). Useful when streaming output during a long scrape — append after each page rather than buffering everything in the conversation. Pair with `fs_zip` at the end.',
    parameters: OBJ({ path: STR, content: STR }, ['path', 'content']),
    handler: async ({ path, content } = {}) => _vfs().append(path, content)
  });

  T({
    name: 'fs_read',
    group: 'fs',
    description:
      'Read a workspace file. Returns content as text by default. For files larger than the model\'s context, pass `offset` + `limit` to read in chunks; the response includes `bytesRead`, `totalSize`, and `truncated` so you can paginate. Pass encoding="binary" to get a base64 string instead of decoded text.',
    parameters: OBJ({
      path: STR,
      offset: NUM,
      limit: NUM,
      encoding: { type: 'string', enum: ['utf-8', 'utf-16', 'latin1', 'binary'] }
    }, ['path']),
    handler: async (args = {}) => _vfs().read(args.path, args)
  });

  T({
    name: 'fs_list',
    group: 'fs',
    description:
      'List files in the workspace. Pass `path` to scope (default "/", which is everything). Set `recursive: false` to only show immediate children. Returns { files: [{path, size, mtime, mime}, …], dirs: ["/scrape", …], totalFiles }.',
    parameters: OBJ({ path: STR, recursive: BOOL, limit: NUM }),
    handler: async (args = {}) => _vfs().list(args)
  });

  T({
    name: 'fs_stat',
    group: 'fs',
    description: 'Metadata for one workspace file: size, mime, mtime. Returns null if the file does not exist.',
    parameters: OBJ({ path: STR }, ['path']),
    handler: async ({ path } = {}) => _vfs().stat(path)
  });

  T({
    name: 'fs_delete',
    group: 'fs',
    description: 'Delete a file. Set `recursive: true` to delete every file under a directory prefix. Use sparingly — there is no trash.',
    parameters: OBJ({ path: STR, recursive: BOOL }, ['path']),
    handler: async (args = {}) => _vfs().del(args.path, args)
  });

  T({
    name: 'fs_move',
    group: 'fs',
    description: 'Rename or move a single workspace file. Does not yet support moving a whole subtree — use fs_list + fs_move/fs_delete for that.',
    parameters: OBJ({ from: STR, to: STR }, ['from', 'to']),
    handler: async ({ from, to } = {}) => _vfs().move(from, to)
  });

  T({
    name: 'fs_total',
    group: 'fs',
    description: 'Summary of the workspace: { fileCount, totalBytes }.',
    parameters: OBJ(),
    handler: async () => _vfs().total()
  });

  T({
    name: 'fs_zip',
    group: 'fs',
    description:
      'Bundle a workspace subtree into a ZIP and save it under the user\'s on-disk workspace folder (see `workspace_info`). ' +
      '`path` selects the subtree to zip (default "/" = everything). `outputName` overrides the suggested filename (default `kyoto-workspace-<timestamp>.zip`). ' +
      'Returns { ok, fileCount, bytes, downloadId, suggestedFilename, savedTo, location, folder } on success.',
    parameters: OBJ({ path: STR, outputName: STR }),
    handler: async ({ path = '/', outputName } = {}) => {
      const blob = await _vfs().exportZip({ path });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/-Z$/, 'Z');
      const filename = outputName || `kyoto-workspace-${ts}.zip`;
      const url = URL.createObjectURL(blob);
      // This tool owns the blob URL, so it revokes it once the download has
      // actually settled — a fixed timer would kill the URL while a Save-As
      // dialog is still open (audit C18).
      let downloadId = null;
      try {
        const r = window.KyotoWorkspace
          ? await window.KyotoWorkspace.downloadUrl({ url, filename })
          : { downloadId: await chrome.downloads.download({ url, filename, saveAs: false }), path: filename };
        downloadId = r.downloadId ?? null;
        const t = await _vfs().total();
        return {
          ok: true, fileCount: t.fileCount, bytes: blob.size,
          downloadId: r.downloadId, suggestedFilename: filename,
          savedTo: r.path, location: r.location, folder: r.folder,
          ...(r.note ? { note: r.note } : {})
        };
      } catch (e) {
        try { URL.revokeObjectURL(url); } catch {}
        throw e;
      } finally {
        if (downloadId != null) {
          const revokeWhenDone = window.KyotoWorkspace?._revokeBlobUrlWhenDownloaded;
          if (revokeWhenDone) revokeWhenDone(url, downloadId);
          else setTimeout(() => URL.revokeObjectURL(url), 120000);
        }
      }
    }
  });

  T({
    name: 'fs_clear',
    group: 'fs',
    description: 'Wipe EVERY file in the workspace. The agent should not call this without explicit user confirmation — use only when the user explicitly asks to start fresh.',
    parameters: OBJ(),
    handler: async () => _vfs().clear()
  });
})();
