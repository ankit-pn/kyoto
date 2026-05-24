// Media + S3 + chat export. AWS SigV4 is self-contained (no SDK).

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg, activeTab, scrip } = window.KyotoTR;

  // ──────── AWS S3 (Signature V4 via WebCrypto) ────────
  function _bytesFrom(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === 'string') return new TextEncoder().encode(v);
    return new TextEncoder().encode(String(v));
  }
  async function _sha256Hex(data) {
    const buf = await crypto.subtle.digest('SHA-256', _bytesFrom(data));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function _hmac(key, data) {
    const k = (key instanceof Uint8Array) ? key : _bytesFrom(key);
    const ck = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, _bytesFrom(data));
    return new Uint8Array(sig);
  }
  function _hex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function s3Put({ accessKey, secretKey, region, bucket, key, body, contentType, endpoint }) {
    const service = 's3';
    region = region || 'us-east-1';
    let host, path;
    if (endpoint) {
      const ep = new URL(endpoint);
      host = ep.host;
      const epPath = (ep.pathname || '').replace(/\/+$/, '');
      path = `${epPath}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      host = `${bucket}.s3.${region}.amazonaws.com`;
      path = '/' + key.split('/').map(encodeURIComponent).join('/');
    }
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const bodyBytes = _bytesFrom(body);
    const bodyHash = await _sha256Hex(bodyBytes);

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${bodyHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'PUT', path, '', canonicalHeaders, signedHeaders, bodyHash
    ].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, await _sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate    = await _hmac('AWS4' + secretKey, dateStamp);
    const kRegion  = await _hmac(kDate, region);
    const kService = await _hmac(kRegion, service);
    const kSigning = await _hmac(kService, 'aws4_request');
    const sig      = _hex(await _hmac(kSigning, stringToSign));

    const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
    const url = `https://${host}${path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': amzDate,
        'Authorization': auth,
        'Content-Type': contentType || 'application/octet-stream'
      },
      body: bodyBytes
    });
    return { res, url };
  }
  async function _readS3Settings() {
    const keys = ['s3AccessKeyId', 's3SecretAccessKey', 's3Region', 's3Bucket', 's3KeyPrefix', 's3Endpoint'];
    const g = await chrome.storage.local.get(keys);
    return {
      accessKey:  g.s3AccessKeyId || '',
      secretKey:  g.s3SecretAccessKey || '',
      region:     g.s3Region || 'us-east-1',
      bucket:     g.s3Bucket || '',
      keyPrefix:  g.s3KeyPrefix || '',
      endpoint:   g.s3Endpoint || ''
    };
  }
  function _s3PublicUrl(s, key) {
    if (s.endpoint) {
      try { return new URL(`${s.bucket}/${key}`, s.endpoint).toString(); } catch { return null; }
    }
    return `https://${s.bucket}.s3.${s.region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  function _guessKeyFromUrl(url) {
    try {
      const u = new URL(url);
      const name = u.pathname.split('/').pop() || ('file-' + Date.now());
      return decodeURIComponent(name).replace(/[?#].*$/, '') || ('file-' + Date.now());
    } catch { return 'file-' + Date.now(); }
  }

  T({
    name: 's3_upload',
    group: 'media',
    description: 'Upload data to AWS S3 or any S3-compatible endpoint (Cloudflare R2, Wasabi, MinIO, Backblaze B2). Credentials come from Settings → AWS S3. Pass `sourceUrl` to upload an external file (Kyoto fetches it first) OR `content` to upload a string directly. `key` overrides the auto-derived filename; `bucket` overrides the default bucket. Returns the resulting object URL.',
    parameters: OBJ({
      sourceUrl: STR,
      content: STR,
      contentType: STR,
      key: STR,
      bucket: STR,
      keyPrefix: STR
    }),
    handler: async (args = {}) => {
      const s = await _readS3Settings();
      if (!s.accessKey || !s.secretKey) throw new Error('S3 credentials not configured (Settings → AWS S3).');
      const bucket = args.bucket || s.bucket;
      if (!bucket) throw new Error('No S3 bucket configured.');
      let bytes, contentType;
      if (args.content != null) {
        const dm = typeof args.content === 'string' && args.content.startsWith('data:')
          ? args.content.match(/^data:([^;,]+)?(?:;([^,]+))?,([\s\S]*)$/)
          : null;
        if (dm) {
          contentType = args.contentType || dm[1] || 'application/octet-stream';
          if (dm[2] === 'base64') {
            const bin = atob(dm[3]);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else {
            bytes = new TextEncoder().encode(decodeURIComponent(dm[3]));
          }
        } else {
          bytes = new TextEncoder().encode(args.content);
          contentType = args.contentType || 'text/plain; charset=utf-8';
        }
      } else if (args.sourceUrl) {
        const r = await fetch(args.sourceUrl, { credentials: 'include' });
        if (!r.ok) throw new Error(`source fetch ${r.status}`);
        bytes = new Uint8Array(await r.arrayBuffer());
        contentType = args.contentType || r.headers.get('content-type') || 'application/octet-stream';
      } else {
        throw new Error('Pass `content` or `sourceUrl`.');
      }
      const prefix = (args.keyPrefix ?? s.keyPrefix).replace(/^\/+|\/+$/g, '');
      const baseKey = args.key || _guessKeyFromUrl(args.sourceUrl || '');
      const fullKey = prefix ? `${prefix}/${baseKey}` : baseKey;
      const { res, url } = await s3Put({
        accessKey: s.accessKey, secretKey: s.secretKey,
        region: s.region, bucket, key: fullKey,
        endpoint: s.endpoint, body: bytes, contentType
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`S3 PUT ${res.status}: ${text.slice(0, 400)}`);
      }
      return {
        ok: true,
        url: _s3PublicUrl({ ...s, bucket }, fullKey),
        key: fullKey,
        bucket,
        bytes: bytes.length,
        contentType
      };
    }
  });

  // ──────── MEDIA DETECT + DOWNLOAD ────────
  T({
    name: 'media_detect',
    group: 'media',
    description: 'Scan the active page for media URLs: <video>/<audio>/<source> tags, og:video / og:audio meta, JSON-LD VideoObject, plus media-typed requests from the network capture buffer. Detects YouTube specifically and notes the in-browser limitation (signature deciphering not feasible without yt-dlp).',
    parameters: OBJ({ tabId: NUM, includeNetwork: BOOL }),
    handler: async ({ tabId, includeNetwork = true } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const dom = await scrip(tabId, () => {
        const out = [];
        for (const el of document.querySelectorAll('video, audio')) {
          if (el.currentSrc) out.push({ kind: 'media-element', tag: el.tagName.toLowerCase(), url: el.currentSrc });
          else if (el.src) out.push({ kind: 'media-element', tag: el.tagName.toLowerCase(), url: el.src });
          for (const s of el.querySelectorAll('source')) {
            if (s.src) out.push({ kind: 'source', tag: 'source', url: s.src, type: s.type || '' });
          }
        }
        for (const m of document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"]')) {
          if (m.content) out.push({ kind: 'opengraph', property: m.getAttribute('property'), url: m.content });
        }
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(s.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const it of items) {
              const t = it && it['@type'];
              if (!t) continue;
              if (t === 'VideoObject' || t === 'AudioObject' || t === 'MusicRecording') {
                if (it.contentUrl) out.push({ kind: 'json-ld', type: t, name: it.name || '', url: it.contentUrl });
              }
            }
          } catch {}
        }
        const yt = (location.host.endsWith('youtube.com') || location.host === 'youtu.be') ||
                   (typeof window.ytInitialPlayerResponse !== 'undefined');
        return { items: out, isYouTube: yt, url: location.href, title: document.title };
      }, []);

      let net = [];
      if (includeNetwork) {
        try {
          const r = await bg('NET_CAPTURE_LIST', {
            filter: '\\.(mp4|m4v|webm|mov|m3u8|mpd|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\\?|$|/)',
            limit: 80
          });
          net = (r?.events || []).map(e => ({
            kind: 'network', url: e.url, status: e.status, type: e.type, ip: e.ip
          }));
        } catch {}
      }

      const dedup = new Set();
      const all = [...(dom?.items || []), ...net].filter(x => {
        if (!x.url) return false;
        if (dedup.has(x.url)) return false;
        dedup.add(x.url);
        return true;
      });

      return {
        page: { url: dom?.url, title: dom?.title },
        items: all,
        isYouTube: !!dom?.isYouTube,
        notes: [
          dom?.isYouTube ? 'YouTube detected — call `yt_dlp_run { url: location.href }` (full speed via shell bridge + yt-dlp). It also handles 1500 other sites: Instagram, Twitter/X, Vimeo, Twitch, TikTok, podcasts, etc.' : null,
          'Got a direct file URL (an .mp3 / .mp4 / etc. you can fetch as-is)? Pass it to `media_download`.',
          'Got a site URL (not a direct file)? Use `yt_dlp_run` — it handles cookies, ciphers, manifest reassembly, ffmpeg merge automatically.',
          'For HLS (.m3u8) without yt-dlp: fetch the manifest with `network_fetch`, parse, download segments. yt-dlp does this for you.'
        ].filter(Boolean)
      };
    }
  });

  T({
    name: 'media_download',
    group: 'media',
    description:
      'Download a DIRECT media URL (.mp4, .m4a, .mp3, .webm, …) via chrome.downloads (default) or upload it to S3 (uploadToS3: true). ' +
      'Use this when you already have the direct file URL — e.g. a podcast .mp3 link, a CDN .mp4 from `media_detect`, or any URL `web_fetch_extract` surfaced. ' +
      'NOT the right choice for site URLs like youtube.com / instagram.com / twitter.com — for those, use `yt_dlp_run` instead (handles login cookies, signature ciphers, manifest reassembly, ffmpeg merge automatically). ' +
      'Pass `filename` (or `s3Key`) to override the auto-derived name.',
    parameters: OBJ({
      url: STR,
      filename: STR,
      uploadToS3: BOOL,
      s3Key: STR,
      s3Bucket: STR,
      saveAs: BOOL
    }, ['url']),
    handler: async ({ url, filename, uploadToS3, s3Key, s3Bucket, saveAs = false } = {}) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const fname = filename || _guessKeyFromUrl(url);

      if (uploadToS3) {
        const s = await _readS3Settings();
        if (!s.accessKey || !s.secretKey) throw new Error('S3 credentials not configured (Settings → AWS S3).');
        const bucket = s3Bucket || s.bucket;
        if (!bucket) throw new Error('No S3 bucket configured.');
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error(`source fetch ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        const prefix = s.keyPrefix.replace(/^\/+|\/+$/g, '');
        const key = (prefix ? prefix + '/' : '') + (s3Key || fname);
        const { res } = await s3Put({
          accessKey: s.accessKey, secretKey: s.secretKey,
          region: s.region, bucket, key,
          endpoint: s.endpoint, body: bytes, contentType
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`S3 PUT ${res.status}: ${t.slice(0, 400)}`);
        }
        return {
          ok: true,
          target: 's3',
          s3Url: _s3PublicUrl({ ...s, bucket }, key),
          key, bucket, bytes: bytes.length, contentType
        };
      }

      if (window.KyotoWorkspace) {
        const r = await window.KyotoWorkspace.downloadUrl({ url, filename: fname, saveAs });
        return {
          ok: true, target: 'local',
          downloadId: r.downloadId, suggestedFilename: fname,
          savedTo: r.path, location: r.location, folder: r.folder,
          ...(r.note ? { note: r.note } : {})
        };
      }
      const downloadId = await chrome.downloads.download({ url, filename: fname, saveAs });
      return { ok: true, target: 'local', downloadId, suggestedFilename: fname };
    }
  });

  // ──────── CHAT HISTORY EXPORT ────────
  function _formatSessionMarkdown(session, { providerLabel } = {}) {
    if (!session) return '# (no session)';
    const lines = [];
    const created = session.createdAt ? new Date(session.createdAt).toISOString() : 'unknown';
    lines.push(`# Kyoto chat — ${session.title || session.id}`);
    lines.push('');
    lines.push(`- **Session id:** \`${session.id}\``);
    lines.push(`- **Created:** ${created}`);
    if (session.tabUrl) lines.push(`- **Bound tab URL:** ${session.tabUrl}`);
    if (providerLabel) lines.push(`- **Provider/model at export time:** ${providerLabel}`);
    if (session.goal) lines.push(`- **Active goal:** ${session.goal}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    const history = session.history || [];
    for (const msg of history) {
      const role = msg.role;
      if (role === 'system') {
        lines.push('## ⚙️ System');
        lines.push('');
        lines.push('```');
        lines.push((msg.content || '').toString());
        lines.push('```');
        lines.push('');
        continue;
      }
      if (role === 'user') {
        lines.push('## 👤 User');
        lines.push('');
        const c = msg.content;
        if (typeof c === 'string') {
          lines.push(c);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (part?.type === 'text') lines.push(part.text || '');
            else if (part?.type === 'image_url') lines.push(`![image](${part.image_url?.url || ''})`);
          }
        }
        lines.push('');
        continue;
      }
      if (role === 'assistant') {
        lines.push('## 🤖 Assistant');
        if (msg._finishReason) lines.push(`*finish: \`${msg._finishReason}\`*`);
        if (msg._usage) {
          const u = msg._usage;
          const cost = msg._cost != null ? ` · $${Number(msg._cost).toFixed(4)}` : '';
          lines.push(`*tokens: in ${u.prompt_tokens ?? '?'} · out ${u.completion_tokens ?? '?'} · total ${u.total_tokens ?? '?'}${cost}*`);
        }
        lines.push('');
        if (msg.reasoning_content) {
          lines.push('<details><summary>Reasoning (thinking)</summary>');
          lines.push('');
          lines.push(msg.reasoning_content);
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        if (msg.content) {
          lines.push(msg.content);
          lines.push('');
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name || '(unknown)';
            lines.push(`#### 🔧 Tool call: \`${name}\``);
            lines.push('');
            lines.push('```json');
            let args = tc.function?.arguments || '{}';
            try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
            lines.push(args);
            lines.push('```');
            lines.push('');
          }
        }
        continue;
      }
      if (role === 'tool') {
        lines.push(`#### 📦 Tool result${msg.name ? ` (\`${msg.name}\`)` : ''}`);
        lines.push('');
        lines.push('```json');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        if (content && content.length > 20000) lines.push(content.slice(0, 20000) + `\n… (truncated, ${content.length - 20000} more chars)`);
        else lines.push(content || '');
        lines.push('```');
        lines.push('');
        continue;
      }
    }
    return lines.join('\n');
  }

  function _suggestedExportName(session, ext) {
    const safe = (s) => String(s || '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = safe(session?.title) || safe(session?.id) || 'chat';
    return `kyoto-chat-${slug}-${stamp}.${ext}`;
  }

  T({
    name: 'chat_export',
    group: 'misc',
    description:
      'Export the chat history as a downloadable file. ' +
      '`format` is "json" (full structure incl. tool calls / tool results / usage stats — round-trippable) or "markdown" (human-readable). ' +
      'Default scope is the ACTIVE session. Pass `sessionId` to export a specific session, or `scope: "all"` to bundle every session into one archive. ' +
      'Returns { ok, filename, bytes, downloadId, format }.',
    parameters: OBJ({
      format: { type: 'string', enum: ['json', 'markdown', 'md'] },
      sessionId: STR,
      scope: { type: 'string', enum: ['active', 'all'] },
      filename: STR
    }, ['format']),
    handler: async ({ format, sessionId, scope = 'active', filename } = {}) => {
      if (!window.KyotoSession) throw new Error('Session API not available');
      const fmt = format === 'md' ? 'markdown' : format;
      let content, mime, ext;

      if (scope === 'all') {
        const index = window.KyotoSession.listIndex();
        const sessions = [];
        for (const meta of index) {
          const full = await window.KyotoSession.load(meta.id);
          if (full) sessions.push(full);
        }
        if (fmt === 'markdown') {
          content = sessions.map(s => _formatSessionMarkdown(s)).join('\n\n---\n\n');
          mime = 'text/markdown';
          ext = 'md';
        } else {
          content = JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2);
          mime = 'application/json';
          ext = 'json';
        }
      } else {
        const session = sessionId
          ? await window.KyotoSession.load(sessionId)
          : window.KyotoSession.active();
        if (!session) throw new Error('No session to export');
        if (fmt === 'markdown') {
          const snap = window.KyotoSession.settingsSnapshot();
          content = _formatSessionMarkdown(session, { providerLabel: `${snap.provider}/${snap.model}` });
          mime = 'text/markdown';
          ext = 'md';
        } else {
          content = JSON.stringify(session, null, 2);
          mime = 'application/json';
          ext = 'json';
        }
      }

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const suggested = filename || _suggestedExportName(
        scope === 'all' ? { title: 'all-sessions' } : (sessionId ? { id: sessionId } : window.KyotoSession.active()),
        ext
      );
      try {
        if (window.KyotoWorkspace) {
          const r = await window.KyotoWorkspace.downloadUrl({ url, filename: suggested, saveAs: true });
          return {
            ok: true, filename: suggested, bytes: blob.size,
            downloadId: r.downloadId, format: fmt, scope,
            savedTo: r.path, location: r.location, folder: r.folder,
            ...(r.note ? { note: r.note } : {})
          };
        }
        const downloadId = await chrome.downloads.download({ url, filename: suggested, saveAs: true });
        return { ok: true, filename: suggested, bytes: blob.size, downloadId, format: fmt, scope };
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      }
    }
  });
})();
