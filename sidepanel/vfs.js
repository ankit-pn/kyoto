// Kyoto Virtual FileSystem.
//
// Storage: a single IndexedDB database named "kyoto_vfs" with one
// object store "files" keyed by absolute path (always starting with "/").
// Records: { path, content (Uint8Array), mime, size, mtime }.
//
// Directories are IMPLICIT — derived from path prefixes when listing.
// All paths are normalised to use "/" and start with "/".

(() => {
  'use strict';

  const DB_NAME = 'kyoto_vfs';
  const STORE = 'files';

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return db().then(d => d.transaction(STORE, mode).objectStore(STORE));
  }

  // ── Path helpers ─────────────────────────────────────
  function normalise(path) {
    if (!path || typeof path !== 'string') throw new Error('path required');
    let p = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    // resolve "." and ".."
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return '/' + parts.join('/');
  }
  function dirname(p) {
    const n = normalise(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  }
  function basename(p) {
    const n = normalise(p);
    const i = n.lastIndexOf('/');
    return n.slice(i + 1);
  }

  // ── Binary helpers ───────────────────────────────────
  function bytesFromContent(content) {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (typeof content === 'string') return new TextEncoder().encode(content);
    if (content && typeof content === 'object') {
      return new TextEncoder().encode(JSON.stringify(content));
    }
    return new TextEncoder().encode(String(content ?? ''));
  }

  // btoa() takes a latin1 string. Spreading the whole byte array into
  // String.fromCharCode(...bytes) pushes one argument per byte and hits
  // V8's argument limit (~125 k) — RangeError: Maximum call stack size
  // exceeded for files above ~120 KB. Build the binary string in chunks,
  // then base64 the complete string once (a single btoa call means the
  // chunks do not need to be 3-byte aligned).
  function bytesToBase64(bytes) {
    const CHUNK = 0x8000; // 32 KB — well below the argument limit
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // ── Public API ───────────────────────────────────────
  async function write(path, content, { mime } = {}) {
    const p = normalise(path);
    const bytes = bytesFromContent(content);
    const record = {
      path: p,
      content: bytes,
      mime: mime || guessMime(p),
      size: bytes.byteLength,
      mtime: Date.now()
    };
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = store.put(record);
      r.onsuccess = () => resolve({ path: p, size: bytes.byteLength });
      r.onerror = () => reject(r.error);
    });
  }

  async function append(path, content) {
    const p = normalise(path);
    const existing = await readBytes(p).catch(() => null);
    const addBytes = bytesFromContent(content);
    if (existing) {
      const combined = new Uint8Array(existing.byteLength + addBytes.byteLength);
      combined.set(existing, 0);
      combined.set(addBytes, existing.byteLength);
      return write(p, combined);
    }
    return write(p, addBytes);
  }

  async function readBytes(path) {
    const p = normalise(path);
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const r = store.get(p);
      r.onsuccess = () => {
        if (!r.result) return reject(new Error(`No such file: ${p}`));
        resolve(r.result.content);
      };
      r.onerror = () => reject(r.error);
    });
  }

  async function read(path, { offset = 0, limit, encoding = 'utf-8' } = {}) {
    const bytes = await readBytes(path);
    const sliceEnd = limit != null ? Math.min(bytes.byteLength, offset + limit) : bytes.byteLength;
    const slice = bytes.subarray(offset, sliceEnd);
    if (encoding === 'binary' || encoding === 'bytes') {
      // Don't try to decode binary as text — return base64.
      return { path: normalise(path), bytes: slice.byteLength, base64: bytesToBase64(slice), totalSize: bytes.byteLength };
    }
    let text;
    try { text = new TextDecoder(encoding).decode(slice); }
    catch { text = new TextDecoder('utf-8').decode(slice); }
    return {
      path: normalise(path),
      content: text,
      offset,
      bytesRead: slice.byteLength,
      totalSize: bytes.byteLength,
      truncated: sliceEnd < bytes.byteLength
    };
  }

  async function stat(path) {
    const p = normalise(path);
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const r = store.get(p);
      r.onsuccess = () => {
        if (!r.result) return resolve(null);
        const { path, mime, size, mtime } = r.result;
        resolve({ path, mime, size, mtime, mtimeISO: new Date(mtime).toISOString() });
      };
      r.onerror = () => reject(r.error);
    });
  }

  async function del(path, { recursive = false } = {}) {
    const p = normalise(path);
    const store = await tx('readwrite');
    if (!recursive) {
      return new Promise((resolve, reject) => {
        const r = store.delete(p);
        r.onsuccess = () => resolve({ deleted: 1, path: p });
        r.onerror = () => reject(r.error);
      });
    }
    const prefix = p === '/' ? '/' : p + '/';
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      let n = 0;
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return resolve({ deleted: n, path: p });
        if (cur.key === p || cur.key.startsWith(prefix)) {
          cur.delete();
          n++;
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function move(from, to) {
    const a = normalise(from);
    const b = normalise(to);
    const bytes = await readBytes(a);
    const s = await stat(a);
    await write(b, bytes, { mime: s?.mime });
    await del(a);
    return { from: a, to: b };
  }

  // Recursive listing — returns a flat array of file metadata and a
  // derived list of directories observed along the way.
  async function list({ path = '/', recursive = true, limit = 5000 } = {}) {
    const prefix = path === '/' ? '/' : normalise(path) + '/';
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const out = [];
      const dirs = new Set();
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return resolve({ files: out, dirs: [...dirs].sort(), totalFiles: out.length });
        const k = cur.key;
        if (k === '/' || k.startsWith(prefix) || prefix === '/') {
          const rest = k.slice(prefix.length || 1);
          if (recursive || !rest.includes('/')) {
            const v = cur.value;
            out.push({ path: k, size: v.size, mtime: v.mtime, mime: v.mime });
          }
          // record intermediate directories
          let dir = dirname(k);
          while (dir && dir !== '/' && dir.length > prefix.length - 1) {
            dirs.add(dir);
            dir = dirname(dir);
          }
        }
        if (out.length >= limit) return resolve({ files: out, dirs: [...dirs].sort(), totalFiles: out.length, truncated: true });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function total() {
    const { files } = await list({ path: '/', recursive: true, limit: 100000 });
    const bytes = files.reduce((a, f) => a + (f.size || 0), 0);
    return { fileCount: files.length, totalBytes: bytes };
  }

  async function clear() {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = store.clear();
      r.onsuccess = () => resolve({ cleared: true });
      r.onerror = () => reject(r.error);
    });
  }

  // ── ZIP export via fflate ────────────────────────────
  // Build an object { 'rel/path': Uint8Array, … } from a path subtree
  // and pass it to fflate.zipSync. Returns a Blob for download.
  async function exportZip({ path = '/' } = {}) {
    if (typeof window.fflate?.zipSync !== 'function') {
      throw new Error('fflate not loaded (expected window.fflate from lib/fflate.min.js)');
    }
    const root = normalise(path);
    const { files } = await list({ path: root, recursive: true, limit: 100000 });
    if (!files.length) throw new Error(`No files under ${root}`);
    const obj = {};
    const stripPrefix = root === '/' ? 1 : root.length + 1;
    for (const f of files) {
      const rel = f.path.slice(stripPrefix);
      if (!rel) continue;
      // eslint-disable-next-line no-await-in-loop
      obj[rel] = await readBytes(f.path);
    }
    const zipped = window.fflate.zipSync(obj, { level: 6 });
    return new Blob([zipped], { type: 'application/zip' });
  }

  // ── MIME guess ───────────────────────────────────────
  function guessMime(p) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    const map = {
      json: 'application/json',
      md: 'text/markdown',
      txt: 'text/plain',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      html: 'text/html',
      htm: 'text/html',
      xml: 'text/xml',
      yaml: 'text/yaml', yml: 'text/yaml',
      js: 'text/javascript',
      ts: 'text/typescript',
      py: 'text/x-python',
      log: 'text/plain',
      svg: 'image/svg+xml',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf'
    };
    return map[ext] || 'application/octet-stream';
  }

  window.KyotoVFS = {
    write, append, read, readBytes, stat, del, move, list, total, clear, exportZip,
    _normalise: normalise, _dirname: dirname, _basename: basename
  };
})();
