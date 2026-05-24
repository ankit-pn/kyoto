// yt-dlp orchestration: install, ffmpeg, PO-token provider, multi-client
// SABR fallback, YouTube auth sniffing. Plus the older direct-extract
// + segment-capture tools kept as best-effort fallbacks.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg, activeTab, scrip } = window.KyotoTR;

  async function _shell(command, timeoutMs = 60000) {
    if (!window.KyotoShell) throw new Error('Shell bridge module not loaded');
    return window.KyotoShell.shell(command, timeoutMs);
  }

  T({
    name: 'youtube_extract',
    group: 'media',
    description:
      'Extract YouTube streaming data (formats, URLs, metadata) from the active YouTube tab by reading ytInitialPlayerResponse. ' +
      'Primarily diagnostic — for actually downloading, prefer `yt_dlp_run` which is full-speed and handles signatures + n-param + ffmpeg merging. ' +
      'Returns each format with `url` + `needsCipher`; formats with `needsCipher: false` and a non-null `url` would work with `media_download`, but most modern YouTube formats are ciphered. ' +
      'Live streams usually expose `hlsManifestUrl`.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        let pr = window.ytInitialPlayerResponse
          || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response);
        if (typeof pr === 'string') {
          try { pr = JSON.parse(pr); } catch { pr = null; }
        }
        if (!pr) {
          const html = document.documentElement.innerHTML;
          const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var |<\/script>)/);
          if (m) { try { pr = JSON.parse(m[1]); } catch {} }
        }
        if (!pr) {
          return { error: 'Not a YouTube watch / shorts / music page, or player response unavailable.' };
        }
        const sd = pr.streamingData || {};
        const vd = pr.videoDetails || {};

        const mapFmt = (f) => ({
          itag: f.itag,
          mimeType: f.mimeType,
          quality: f.qualityLabel || f.audioQuality,
          bitrate: f.bitrate,
          fps: f.fps,
          width: f.width,
          height: f.height,
          contentLength: f.contentLength,
          durationMs: f.approxDurationMs,
          url: f.url || null,
          needsCipher: !f.url && !!f.signatureCipher
        });
        return {
          videoId: vd.videoId,
          title: vd.title,
          author: vd.author,
          channelId: vd.channelId,
          durationSec: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
          viewCount: vd.viewCount ? Number(vd.viewCount) : null,
          isLive: !!vd.isLive || !!vd.isLiveContent,
          thumbnails: (vd.thumbnail && vd.thumbnail.thumbnails) || [],
          progressive: (sd.formats || []).map(mapFmt),
          adaptive: (sd.adaptiveFormats || []).map(mapFmt),
          hlsManifestUrl: sd.hlsManifestUrl || null,
          dashManifestUrl: sd.dashManifestUrl || null
        };
      });
    }
  });

  T({
    name: 'youtube_capture_streams',
    group: 'media',
    description:
      'Last-resort YouTube workaround when the shell bridge / yt_dlp_run is unavailable. ' +
      'Snoops the page\'s own player network traffic to grab post-cipher videoplayback URLs (no signature decoding needed). ' +
      'Plays the video briefly, captures URLs, returns them grouped by itag. Pass `urlWithoutRange` to `media_download`. ' +
      'IMPORTANT: in-browser downloads are THROTTLED to ~30-100 KB/s by YouTube\'s n-parameter — only yt-dlp deciphers it. ' +
      'PREFER `yt_dlp_run` if the shell bridge is installed (full speed, no babysitting).',
    parameters: OBJ({ tabId: NUM, playForMs: NUM }),
    handler: async ({ tabId, playForMs = 5000 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.get(tabId);
      if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(tab?.url || '')) {
        return { error: `Active tab isn't YouTube: ${tab?.url}` };
      }

      const wasCapturing = (await bg('NET_CAPTURE_LIST', { limit: 1 }))?.capturing;
      if (!wasCapturing) await bg('NET_CAPTURE_START', { scope: 'tab', tabId });
      try { await bg('NET_CAPTURE_CLEAR'); } catch {}

      const playResult = await scrip(tabId, () => {
        const v = document.querySelector('video');
        if (!v) return { played: false, error: 'no <video> element on page' };
        try { v.play(); } catch {}
        try {
          if (isFinite(v.duration) && v.duration > 0) {
            const old = v.currentTime || 0;
            const ahead = old + 180;
            const target = ahead < v.duration - 5 ? ahead : Math.max(0, old - 60);
            v.currentTime = target;
          }
        } catch {}
        return { played: !v.paused, currentTime: v.currentTime, duration: v.duration };
      });

      const waitMs = Math.max(1500, Math.min(20000, playForMs));
      const seekTicker = (async () => {
        const ticks = Math.floor(waitMs / 2000);
        for (let i = 1; i < ticks; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            await scrip(tabId, () => {
              const v = document.querySelector('video');
              if (!v || !isFinite(v.duration) || v.duration <= 0) return;
              const next = (v.currentTime + 47) % Math.max(60, v.duration - 5);
              v.currentTime = next;
            });
          } catch {}
        }
      })();
      await Promise.race([
        seekTicker,
        new Promise(r => setTimeout(r, waitMs))
      ]);

      const cap = await bg('NET_CAPTURE_LIST', { filter: 'googlevideo\\.com.*videoplayback', limit: 400 });
      if (!wasCapturing) await bg('NET_CAPTURE_STOP');

      const byItag = new Map();
      const stripRange = (u) => u
        .replace(/[?&]range=[^&]*/, '')
        .replace(/[?&]rn=[^&]*/, '')
        .replace(/[?&]rbuf=[^&]*/, '');
      for (const e of (cap?.events || [])) {
        const m = e.url && e.url.match(/[?&]itag=(\d+)/);
        if (!m) continue;
        const itag = m[1];
        if (byItag.has(itag) && cap.events.indexOf(e) < cap.events.length / 2) continue;
        const mime = (() => {
          const t = (e.url.match(/[?&]mime=([^&]+)/) || [])[1];
          return t ? decodeURIComponent(t) : null;
        })();
        byItag.set(itag, {
          itag,
          url: e.url,
          urlWithoutRange: stripRange(e.url),
          mime,
          status: e.status
        });
      }

      const AUDIO = new Set(['139','140','141','171','249','250','251','256','258','327','380','600','774']);
      const PROGRESSIVE = new Set(['5','6','17','18','22','34','35','36','37','38','43','44','45','46','82','83','84','85','100','101','102']);
      const items = [...byItag.values()];
      const audio = items.filter(i => AUDIO.has(i.itag));
      const progressive = items.filter(i => PROGRESSIVE.has(i.itag));
      const video = items.filter(i => !AUDIO.has(i.itag) && !PROGRESSIVE.has(i.itag));

      return {
        ok: items.length > 0,
        playResult,
        captured: items.length,
        progressive, audio, video,
        hint: items.length
          ? 'Pass `urlWithoutRange` from any item to `media_download` to grab the full stream.'
          : 'No googlevideo URLs were captured. Reasons: (1) autoplay blocked — ask the user to click play once. (2) The page is YouTube Music or Shorts which sometimes hold off on segment fetches. (3) `webRequest` permission revoked. Fall back to `yt_dlp_command`.'
      };
    }
  });

  const _YT_DLP_PATHS = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '$HOME/.local/bin/yt-dlp',
    '/opt/local/bin/yt-dlp',
    '$HOME/Library/Python/3.13/bin/yt-dlp',
    '$HOME/Library/Python/3.12/bin/yt-dlp',
    '$HOME/Library/Python/3.11/bin/yt-dlp',
    '$HOME/Library/Python/3.10/bin/yt-dlp',
    '$HOME/Library/Python/3.9/bin/yt-dlp'
  ];

  async function _ytDlpProbe(invocation) {
    try {
      const r = await _shell(`${invocation} --version 2>&1`, 8000);
      if (r.exitCode !== 0) return false;
      return /\d{4}\.\d{2}\.\d{2}/.test(r.stdout || '');
    } catch {
      return false;
    }
  }

  async function _findYtDlp() {
    for (const p of _YT_DLP_PATHS) {
      if (await _ytDlpProbe(p)) return p;
    }
    const r2 = await _shell('command -v yt-dlp 2>/dev/null || true', 5000);
    const out2 = (r2.stdout || '').trim();
    if (out2 && await _ytDlpProbe(out2)) return out2;
    for (const py of ['python3', 'python']) {
      if (await _ytDlpProbe(`${py} -m yt_dlp`)) return `${py} -m yt_dlp`;
    }
    return null;
  }

  async function _ytDlpAutoInstall() {
    const candidates = [
      'pipx install yt-dlp',
      'python3 -m pip install --user --upgrade yt-dlp',
      'pip3 install --user --upgrade yt-dlp',
      'python -m pip install --user --upgrade yt-dlp',
      'pip install --user --upgrade yt-dlp'
    ];
    const log = [];
    for (const c of candidates) {
      try {
        const r = await _shell(c + ' 2>&1', 240000);
        log.push(`${c} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) {
          const found = await _findYtDlp();
          if (found) {
            log.push(`yt-dlp ok at: ${found}`);
            return { ok: true, binary: found, log };
          }
        }
      } catch (e) {
        log.push(`${c} -> ${e.message}`);
      }
    }
    return { ok: false, log };
  }

  const _ytAuthCache = { poToken: null, visitorData: null, capturedAt: 0 };
  const YT_AUTH_FRESH_MS = 45 * 60 * 1000;

  async function _captureYoutubeAuth() {
    if (_ytAuthCache.poToken && (Date.now() - _ytAuthCache.capturedAt) < YT_AUTH_FRESH_MS) {
      return { ..._ytAuthCache, fromCache: true };
    }
    let tabs;
    try {
      tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://m.youtube.com/*', '*://music.youtube.com/*'] });
    } catch { return null; }
    if (!tabs?.length) return null;

    for (const tab of tabs) {
      let res;
      try {
        res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => {
            try {
              if (!window.__kyotoYtAuthHook) {
                window.__kyotoYtAuthHook = true;
                window.__kyotoYtAuth = window.__kyotoYtAuth || {};
                const captureFromBody = (body) => {
                  if (!body) return;
                  let s = body;
                  if (typeof s !== 'string') { try { s = String(s); } catch { return; } }
                  if (!s || s[0] !== '{') return;
                  try {
                    const j = JSON.parse(s);
                    const tok = j?.serviceIntegrityDimensions?.poToken;
                    const vd  = j?.context?.client?.visitorData;
                    if (tok) window.__kyotoYtAuth.poToken = tok;
                    if (vd)  window.__kyotoYtAuth.visitorData = vd;
                    if (tok || vd) window.__kyotoYtAuth.capturedAt = Date.now();
                  } catch {}
                };
                const origFetch = window.fetch;
                window.fetch = function (input, init) {
                  try {
                    const u = typeof input === 'string' ? input : input?.url;
                    if (u && /\/youtubei\/v1\/(player|next|browse)/.test(u) && init && init.body) {
                      captureFromBody(init.body);
                    }
                  } catch {}
                  return origFetch.apply(this, arguments);
                };
                const xhrSend = XMLHttpRequest.prototype.send;
                const xhrOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function (method, url) {
                  this.__kyotoUrl = url;
                  return xhrOpen.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send = function (body) {
                  try {
                    if (this.__kyotoUrl && /\/youtubei\/v1\/(player|next|browse)/.test(this.__kyotoUrl)) {
                      captureFromBody(body);
                    }
                  } catch {}
                  return xhrSend.apply(this, arguments);
                };
              }
              try {
                const vd = window.ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.visitorData;
                if (vd && !window.__kyotoYtAuth.visitorData) {
                  window.__kyotoYtAuth.visitorData = vd;
                  window.__kyotoYtAuth.capturedAt = window.__kyotoYtAuth.capturedAt || Date.now();
                }
              } catch {}
              return window.__kyotoYtAuth || null;
            } catch (e) {
              return { error: e?.message || String(e) };
            }
          },
        });
      } catch { continue; }
      const auth = res?.[0]?.result;
      if (auth && !auth.error && (auth.poToken || auth.visitorData)) {
        _ytAuthCache.poToken = auth.poToken || _ytAuthCache.poToken;
        _ytAuthCache.visitorData = auth.visitorData || _ytAuthCache.visitorData;
        _ytAuthCache.capturedAt = auth.capturedAt || Date.now();
        return { ..._ytAuthCache, fromCache: false };
      }
    }
    return null;
  }

  function _is403Sabr(text) {
    if (!text) return false;
    return /HTTP Error 403/.test(text)
      || /SABR/i.test(text)
      || /Please sign in/i.test(text)
      || /needs to be reloaded/i.test(text)
      || /Requested format is not available/i.test(text)
      || /Only images are available for download/i.test(text);
  }

  async function _hasFfmpeg() {
    const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/local/bin/ffmpeg'];
    for (const c of candidates) {
      const r = await _shell(`${c} -version >/dev/null 2>&1 && echo OK || echo MISS`, 5000);
      if (/OK/.test(r.stdout || '')) return c;
    }
    return null;
  }

  async function _installFfmpeg() {
    const log = [];
    const cmds = [
      '(test -x /opt/homebrew/bin/brew && /opt/homebrew/bin/brew install ffmpeg) || (test -x /usr/local/bin/brew && /usr/local/bin/brew install ffmpeg) || false',
      'command -v apt >/dev/null && sudo -n apt install -y ffmpeg',
      'command -v dnf >/dev/null && sudo -n dnf install -y ffmpeg',
      'command -v pacman >/dev/null && sudo -n pacman -S --noconfirm ffmpeg',
      'command -v apk >/dev/null && sudo -n apk add ffmpeg'
    ];
    for (const c of cmds) {
      try {
        const r = await _shell(c + ' 2>&1', 300000);
        log.push(`${c.split('&&')[0].trim()} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) {
          const ff = await _hasFfmpeg();
          if (ff) return { ok: true, ffmpeg: ff, log };
        }
      } catch (e) {
        log.push(`${c} -> ${e.message}`);
      }
    }
    return { ok: false, log };
  }

  async function _installPoTokenProvider() {
    const log = [];
    const node = await _shell('command -v node 2>/dev/null && node --version 2>&1', 5000);
    const hasNode = (node.stdout || '').trim().startsWith('v');
    log.push(`node detected: ${hasNode ? (node.stdout || '').trim() : 'NO'}`);
    if (!hasNode) {
      return { ok: false, log, reason: 'no Node.js — bgutil plugin needs it to mint PO tokens' };
    }
    const pkgs = ['bgutil-ytdlp-pot-provider', 'bgutils-ytdlp-pot-provider', 'yt-dlp-get-pot-bgutil'];
    const installers = ['pipx install', 'python3 -m pip install --user --upgrade', 'pip3 install --user --upgrade'];
    for (const installer of installers) {
      for (const pkg of pkgs) {
        const cmd = `${installer} ${pkg}`;
        const r = await _shell(cmd + ' 2>&1', 180000);
        log.push(`${cmd} -> exit ${r.exitCode}`);
        if (r.exitCode === 0) return { ok: true, log, method: cmd };
      }
    }
    return { ok: false, log };
  }

  async function _ytDlpSelfUpdate(binary) {
    if (!binary) return { ok: false };
    const isModuleInvocation = / -m yt_dlp$/.test(binary);
    const cmd = isModuleInvocation
      ? `${binary.split(' ')[0]} -m pip install --user --upgrade yt-dlp 2>&1`
      : `${binary} -U 2>&1`;
    try {
      const r = await _shell(cmd, 120000);
      return { ok: r.exitCode === 0, stdoutTail: (r.stdout || '').slice(-400) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  T({
    name: 'yt_dlp_run',
    group: 'media',
    description:
      'Download a media URL using yt-dlp via the shell bridge. ' +
      'This is the recommended path for ANY site yt-dlp supports — YouTube, Instagram, Twitter/X, Vimeo, Twitch, TikTok, SoundCloud, Bilibili, podcast sites, etc. (~1500 supported). ' +
      'Full speed (no n-param throttling), auto ffmpeg merge of separate streams. ' +
      'On first call, attempts to install yt-dlp automatically via pipx -> pip --user. ' +
      'Returns { ok, savedPath, command } on success. ' +
      'Requires the shell bridge to be installed (Settings → Shell bridge).',
    parameters: OBJ({
      url: STR,
      audioOnly: BOOL,
      format: STR,
      outputDir: STR,
      useBrowserCookies: BOOL,
      extraArgs: STR,
      timeoutMs: NUM
    }, ['url']),
    handler: async (args = {}) => {
      const { url, audioOnly = false, format, outputDir, useBrowserCookies = true, extraArgs = '', timeoutMs = 600000 } = args;
      if (!url || !/^https?:\/\//i.test(url)) {
        return { error: 'url must be a full http(s) URL' };
      }

      // If the user hasn't passed an explicit outputDir, route through
      // the on-disk workspace so yt-dlp writes alongside everything
      // else the agent generates.
      let workspaceDir = null;
      try { workspaceDir = await window.KyotoWorkspace?.shellDefaultDir(); } catch {}

      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const buildCmd = (binary, { ytClients, noCookies = false, ytAuth = null } = {}) => {
        const parts = [binary];
        if (useBrowserCookies && !noCookies) parts.push('--cookies-from-browser', 'chrome');
        if (audioOnly) {
          parts.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        } else if (format) {
          parts.push('-f', sq(format));
        } else {
          parts.push('-f', sq('bv*+ba/b'), '--merge-output-format', 'mp4');
        }
        const isYT = /youtube\.com|youtu\.be/i.test(url);
        const extractorArgs = [];
        if (!noCookies && ytClients && isYT) {
          extractorArgs.push(`player_client=${ytClients}`);
        }
        if (ytAuth && isYT) {
          if (ytAuth.poToken) extractorArgs.push(`po_token=web.gvs+${ytAuth.poToken}`);
          if (ytAuth.visitorData) extractorArgs.push(`visitor_data=${ytAuth.visitorData}`);
        }
        if (extractorArgs.length) parts.push('--extractor-args', sq(`youtube:${extractorArgs.join(';')}`));
        const dir = (outputDir || workspaceDir || '~/Downloads').replace(/\/+$/, '');
        parts.push('-o', sq(`${dir}/%(title)s.%(ext)s`));
        parts.push('--print', sq('after_move:filepath'));
        parts.push('--no-warnings');
        if (extraArgs && extraArgs.trim()) parts.push(extraArgs.trim());
        parts.push(sq(url));
        return parts.join(' ');
      };

      let binary, installLog;
      try {
        binary = await _findYtDlp();
      } catch (e) {
        return {
          error: e.message,
          hint: 'Shell bridge not installed. Open Settings → Shell bridge for the one-line installer.'
        };
      }
      if (!binary) {
        const inst = await _ytDlpAutoInstall();
        installLog = inst.log;
        if (!inst.ok) {
          return {
            error: 'yt-dlp is not installed and auto-install failed',
            installLog,
            hint: 'Install manually:  pipx install yt-dlp   (or:  pip3 install --user yt-dlp).  On macOS the easiest is:  brew install yt-dlp ffmpeg'
          };
        }
        binary = inst.binary;
      }

      let ffmpegLog;
      const needsFfmpeg = !format || /\+/.test(format) || audioOnly;
      let ffmpegPath = null;
      if (needsFfmpeg) {
        ffmpegPath = await _hasFfmpeg();
        if (!ffmpegPath) {
          const inst = await _installFfmpeg();
          ffmpegLog = inst.log;
          if (inst.ok) ffmpegPath = inst.ffmpeg;
        }
      }

      const isYouTube = /youtube\.com|youtu\.be/i.test(url);
      let ytAuth = null;
      if (isYouTube) {
        try { ytAuth = await _captureYoutubeAuth(); } catch {}
      }

      const clientPlan = isYouTube
        ? ['tv_simply,mweb,web_safari', 'default,tv_simply,mweb,web_safari,web_creator', null]
        : [null];

      let lastResult;
      let attemptedSelfUpdate = false;
      let attemptedNoCookies = false;
      let attemptedPotProvider = false;
      let potProviderLog;
      for (const ytClients of clientPlan) {
        const cmd = buildCmd(binary, { ytClients, ytAuth });
        const r = await _shell(cmd + ' 2>&1', timeoutMs);
        lastResult = r;
        if (r.exitCode === 0) {
          const lines = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
          const savedPath = lines[lines.length - 1] || null;
          return {
            ok: true, savedPath, binary,
            ytClients: ytClients || 'default',
            ffmpegPath,
            stdoutTail: lines.slice(-5).join('\n'),
            installLog, ffmpegLog, potProviderLog
          };
        }
        let sabr = _is403Sabr(r.stdout) || _is403Sabr(r.stderr);
        if (sabr && !attemptedSelfUpdate && isYouTube) {
          attemptedSelfUpdate = true;
          await _ytDlpSelfUpdate(binary);
          const r2 = await _shell(cmd + ' 2>&1', timeoutMs);
          lastResult = r2;
          if (r2.exitCode === 0) {
            const lines = (r2.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
            return {
              ok: true,
              savedPath: lines[lines.length - 1] || null,
              binary,
              ytClients: ytClients || 'default',
              ffmpegPath,
              stdoutTail: lines.slice(-5).join('\n'),
              installLog, ffmpegLog,
              note: 'Succeeded after auto-update.'
            };
          }
          sabr = _is403Sabr(r2.stdout) || _is403Sabr(r2.stderr);
        }
        if (sabr && useBrowserCookies && !attemptedNoCookies && isYouTube) {
          attemptedNoCookies = true;
          const noCookieCmd = buildCmd(binary, { noCookies: true });
          const rnc = await _shell(noCookieCmd + ' 2>&1', timeoutMs);
          lastResult = rnc;
          if (rnc.exitCode === 0) {
            const lines = (rnc.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
            return {
              ok: true,
              savedPath: lines[lines.length - 1] || null,
              binary,
              ytClients: 'android_vr (auto, no cookies)',
              ffmpegPath,
              stdoutTail: lines.slice(-5).join('\n'),
              installLog, ffmpegLog,
              note: 'Succeeded after dropping --cookies-from-browser — SABR was cookie-induced.'
            };
          }
          sabr = _is403Sabr(rnc.stdout) || _is403Sabr(rnc.stderr);
        }
        const isLast = ytClients === clientPlan[clientPlan.length - 1];
        if (sabr && isLast && !attemptedPotProvider && isYouTube) {
          attemptedPotProvider = true;
          const pot = await _installPoTokenProvider();
          potProviderLog = pot.log;
          if (pot.ok) {
            const r3 = await _shell(cmd + ' 2>&1', timeoutMs);
            lastResult = r3;
            if (r3.exitCode === 0) {
              const lines = (r3.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
              return {
                ok: true,
                savedPath: lines[lines.length - 1] || null,
                binary, ytClients: ytClients || 'default',
                ffmpegPath,
                stdoutTail: lines.slice(-5).join('\n'),
                installLog, ffmpegLog, potProviderLog,
                note: `Succeeded after installing PO-token provider (${pot.method}).`
              };
            }
          }
        }
        if (!sabr) break;
      }

      const r = lastResult;
      const isSabr = _is403Sabr(r?.stdout) || _is403Sabr(r?.stderr);
      const updateHint = binary === 'python3 -m yt_dlp' || binary === 'python -m yt_dlp'
        ? 'pip3 install --user --upgrade yt-dlp'
        : `${binary} -U`;
      return {
        error: `yt-dlp exited ${r?.exitCode}`,
        stdout: (r?.stdout || '').slice(-2000),
        stderr: (r?.stderr || '').slice(-2000),
        installLog, ffmpegLog, potProviderLog,
        binary, ffmpegPath,
        hint: isSabr && isYouTube
          ? [
              'Hit a YouTube SABR / 403 block. yt-dlp tried multiple player clients with an auto-update, all still 403\'d.',
              attemptedPotProvider
                ? (potProviderLog && potProviderLog.length
                    ? 'PO-token provider auto-install attempted but didn\'t resolve the 403 (see potProviderLog). Most common cause: Node.js missing or pipx not on PATH.'
                    : 'PO-token provider auto-install was skipped (no Node.js detected).')
                : null,
              `1. Try the latest yt-dlp release manually:  ${updateHint}`,
              '2. Install Node.js + the PO-token provider plugin (the real fix for SABR-only accounts):',
              '     brew install node    # macOS  (or:  sudo apt install nodejs)',
              '     pipx install bgutil-ytdlp-pot-provider',
              '   yt-dlp picks it up automatically; re-run /dl after that.',
              '3. Last resort, fetch the lowest tier (often skips SABR):',
              '     yt_dlp_run { url, format: "worst" }',
              '4. Or generate the command and paste in a terminal where you have a better-pathed Python:',
              '     yt_dlp_command { url }'
            ].filter(Boolean).join('\n')
          : isYouTube && !ffmpegPath
            ? 'ffmpeg not installed and auto-install failed — yt-dlp can\'t merge separate video+audio streams. Try `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux).'
            : undefined
      };
    }
  });

  T({
    name: 'yt_dlp_command',
    group: 'media',
    description:
      'Generate a yt-dlp command string for the active YouTube tab without running it. ' +
      'Use ONLY when the user wants the command to paste themselves (no shell bridge, or they prefer running it manually). ' +
      'For actually downloading, call `yt_dlp_run` instead — it executes via the shell bridge, auto-installs yt-dlp if missing, and returns the saved file path.',
    parameters: OBJ({
      tabId: NUM,
      audioOnly: BOOL,
      format: STR,
      outputDir: STR,
      useBrowserCookies: BOOL
    }),
    handler: async ({ tabId, audioOnly = false, format, outputDir, useBrowserCookies = true } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || '';
      if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(url)) {
        return { error: `Active tab isn't a YouTube URL: ${url}` };
      }
      const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const parts = ['yt-dlp'];
      if (useBrowserCookies) parts.push('--cookies-from-browser', 'chrome');
      if (audioOnly) {
        parts.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else if (format) {
        parts.push('-f', sq(format));
      } else {
        parts.push('-f', sq('bv*+ba/b'), '--merge-output-format', 'mp4');
      }
      const out = outputDir
        ? `${outputDir.replace(/\/+$/, '')}/%(title)s.%(ext)s`
        : '%(title)s.%(ext)s';
      parts.push('-o', sq(out));
      parts.push(sq(url));

      return {
        command: parts.join(' '),
        url,
        hints: [
          'Install: `pipx install yt-dlp` (recommended) or `brew install yt-dlp` / `pip install yt-dlp`.',
          useBrowserCookies ? '`--cookies-from-browser chrome` reuses your logged-in YouTube cookies (helps with age-gates / Premium / members-only). Close Chrome first if it complains about a locked cookie DB.' : null,
          audioOnly ? 'Audio-only requires ffmpeg installed (used to remux to MP3).' : 'Default merge target is mp4; needs ffmpeg installed.',
          'For a playlist URL, yt-dlp downloads every video; add `--playlist-items 1-10` to limit.'
        ].filter(Boolean)
      };
    }
  });
})();
