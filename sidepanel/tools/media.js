// Media download + chat export.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg, activeTab, scrip } = window.KyotoTR;

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
      'Download a DIRECT media URL (.mp4, .m4a, .mp3, .webm, …) via chrome.downloads. ' +
      'Use this when you already have the direct file URL — e.g. a podcast .mp3 link, a CDN .mp4 from `media_detect`, or any URL `web_fetch_extract` surfaced. ' +
      'NOT the right choice for site URLs like youtube.com / instagram.com / twitter.com — for those, use `yt_dlp_run` instead (handles login cookies, signature ciphers, manifest reassembly, ffmpeg merge automatically). ' +
      'Pass `filename` to override the auto-derived name.',
    parameters: OBJ({
      url: STR,
      filename: STR,
      saveAs: BOOL
    }, ['url']),
    handler: async ({ url, filename, saveAs = false } = {}) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const fname = filename || _guessKeyFromUrl(url);

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
      // This tool creates the blob URL, so this tool must revoke it — whichever
      // path produced the download. Revoke on the download's terminal state,
      // NOT on a fixed timer: with saveAs:true Chrome doesn't read the bytes
      // until the user confirms the dialog, so a 120 s timer breaks long
      // Save-As dialogs (audit C18).
      let downloadId = null;
      try {
        if (window.KyotoWorkspace) {
          const r = await window.KyotoWorkspace.downloadUrl({ url, filename: suggested, saveAs: true });
          downloadId = r.downloadId ?? null;
          return {
            ok: true, filename: suggested, bytes: blob.size,
            downloadId: r.downloadId, format: fmt, scope,
            savedTo: r.path, location: r.location, folder: r.folder,
            ...(r.note ? { note: r.note } : {})
          };
        }
        downloadId = await chrome.downloads.download({ url, filename: suggested, saveAs: true });
        return { ok: true, filename: suggested, bytes: blob.size, downloadId, format: fmt, scope };
      } catch (e) {
        // The download never started, so nothing will ever read the blob.
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
})();
