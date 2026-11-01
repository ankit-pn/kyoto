// Standalone conversation export — one self-contained HTML file.
//
// Loaded before sidepanel.js as a plain IIFE that attaches `window.KyotoShare`.
// Every export is PURE (no chrome.*, no DOM, no network), so the two things that
// actually matter can be unit-tested in node: what gets REDACTED and what gets
// ESCAPED. See test/share-core.test.js.
//
// Why this exists: sharing a debugging session today means either a JSON blob
// full of internal bookkeeping or a pile of screenshots. A single HTML file
// opens anywhere — but it LEAVES the machine, so it has to be safe by
// construction:
//
//   * Secrets are stripped before anything is emitted. Provider keys, JWTs,
//     Bearer tokens and opaque 40+ char blobs turn up in transcripts all the
//     time (a tool prints a request, a model echoes a config, a tool dumps a key
//     file). The export passes
//     the title, message text, tool arguments and tool results through
//     redactSecrets() first. Redaction errs toward over-redacting opaque blobs:
//     at this layer a 40-char hex digest is indistinguishable from a 40-char
//     hex secret.
//   * The document is INERT: no <script>, no <link>, no @import, no remote
//     url(...) and no remote images. It makes zero network requests, so opening
//     someone else's export cannot phone home or leak the reader's IP.
//   * Everything is HTML-escaped (< > & " '). The only raw HTML in the output
//     is markup written by this module, plus caller-supplied renderMarkdown()
//     output — that hook is explicitly the caller's responsibility.
//   * Redaction runs on TEXT before it is embedded — never on the assembled
//     document. Running it last would shred the base64 bodies of embedded
//     data: images (they match the opaque-blob rule), so keep it where it is.
//   * Underscore-prefixed bookkeeping is dropped everywhere: `_usage`, `_cost`,
//     `_spend`, `_subagent*`, `_reasoning`, `_pinned`, … are internal state, and
//     some of it (reasoning/encrypted blocks) can be large or sensitive. It is
//     never serialised, not even inside tool-call arguments.
//
// CSP note: the emitted document needs no CSP of its own because it contains no
// executable content at all.

(() => {
  'use strict';

  const REDACTED = '[REDACTED]';

  // Order matters: the scheme keeps its word ("Bearer") so the reader can tell
  // what was dropped, and the specific token shapes run before the generic
  // opaque-blob rules.
  const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

  // PEM private keys span many lines, so they are handled before the
  // line-oriented rules (which would otherwise redact only fragments and leave
  // the rest of the key material in the file). A truncated block — an export
  // cut mid-stream — is redacted to the end of the text rather than leaked.
  const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

  const SECRET_PATTERNS = [
    // OpenRouter keys: sk-or-v1-<hash>.
    /\bsk-or-v1-[A-Za-z0-9_-]{8,}/g,
    // OpenAI-style keys: sk-…, sk-proj-…, sk-svcacct-…, sk-admin-…
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{12,}/g,
    // OpenCode Go keys: oc_sk_…
    /\boc_sk_[A-Za-z0-9_-]{8,}/g,
    // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_.
    /\bgh[pousr]_[A-Za-z0-9]{12,}/g,
    // AWS access key id: AKIA + 16 uppercase/digits.
    /\bAKIA[0-9A-Z]{16}\b/g,
    // JWT: header.payload.signature, base64url with optional padding.
    /\beyJ[A-Za-z0-9_-]{6,}={0,2}\.[A-Za-z0-9_-]{6,}={0,2}\.[A-Za-z0-9_-]{6,}={0,2}/g,
    // Long hex (SHA-1 length and up). 40+ hex chars is not prose. Trade-off,
    // documented above: a git SHA looks exactly like a hex secret.
    /\b[0-9a-fA-F]{40,}\b/g,
    // Opaque base64-ish blobs: 40+ chars that mix cases AND digits. Requiring
    // both keeps ordinary words, slugs, hostnames and long lowercase paths out
    // of it — prose and normal URLs survive.
    /(?<![\w+/-])(?=[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-]))(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g
  ];

  // Raster data: images only. SVG is deliberately excluded: an SVG data URL can
  // carry script, and an export must stay inert even if a transcript is hostile.
  const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+$/i;

  const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  padding: 32px 16px 48px;
  background: #f5f6f8;
  color: #1c2024;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; }
.title { margin: 0 0 4px; font-size: 26px; line-height: 1.25; word-break: break-word; }
.meta { margin: 0 0 28px; color: #6b7280; font-size: 13px; }
.turn { margin: 0 0 18px; border-radius: 10px; padding: 14px 16px; background: #ffffff; border: 1px solid #e5e7eb; }
.turn-user { background: #eef4ff; border-color: #d5e2fb; }
.turn-tool { background: #fafafa; }
.role { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; }
.body img { max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; }
.body p { margin: 0 0 10px; }
.body pre, .body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; }
.body pre { background: #f2f4f7; padding: 10px 12px; border-radius: 8px; overflow-x: auto; white-space: pre; }
.body code { background: #f2f4f7; padding: 1px 4px; border-radius: 4px; }
.body pre code { background: none; padding: 0; }
details { margin: 8px 0 0; border-top: 1px solid #e5e7eb; padding-top: 8px; }
summary { cursor: pointer; color: #4b5563; font-size: 13px; }
details pre { background: #f2f4f7; padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: 8px 0 0; }
code.tool { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.image-placeholder { display: inline-block; color: #6b7280; font-size: 13px; font-style: italic; }
.empty { color: #6b7280; }
.footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; text-align: center; }
@media (prefers-color-scheme: dark) {
  body { background: #0f1216; color: #e6e9ee; }
  .turn { background: #171b21; border-color: #262d36; }
  .turn-user { background: #16202f; border-color: #263447; }
  .turn-tool { background: #13171c; }
  .body pre, .body code, details pre { background: #1d232b; }
  .title { color: #f3f5f8; }
}
`;

  // ──────── ESCAPING ────────
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Escape every character that can change the document's structure. */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ──────── REDACTION ────────
  /**
   * Strip credential-shaped strings. Pure and idempotent: redacting twice must
   * produce the same text (a second pass must not eat a neighbouring word).
   *
   * @param {string} text
   * @returns {string}
   */
  // A key copy-pasted out of a wrapped terminal/email can arrive split across
  // lines: the per-line patterns above would redact the first fragment and leave
  // the tail of the key in the export. Require >=10 chars per segment so normal
  // prose that happens to start with a prefix is not swallowed.
  const WRAPPED_SECRET_RE = /\b(?:sk-or-v1-|sk-|oc_sk_|gh[pousr]_)[A-Za-z0-9_-]{10,}(?:\s*\n\s*[A-Za-z0-9_-]{10,})+/g;

  function redactSecrets(text) {
    let out = typeof text === 'string' ? text : (text == null ? '' : String(text));
    try {
      out = out.replace(PEM_PRIVATE_KEY_RE, REDACTED);
      out = out.replace(BEARER_RE, `$1${REDACTED}`);
      // Line-wrapped keys FIRST: the single-line patterns would redact the first
      // fragment and leave the tail of the key in the export.
      out = out.replace(WRAPPED_SECRET_RE, REDACTED);
      for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    } catch {
      // The patterns are static, so this is unreachable; if it ever did fire,
      // returning the original text is still better than losing the message.
    }
    return out;
  }

  // ──────── PRIVATE-KEY STRIPPING ────────
  /**
   * Deep copy with every `_`-prefixed key dropped. `_usage`, `_cost`, `_spend`,
   * `_subagent*`, `_reasoning`, `_pinned` and friends are internal state and
   * must never reach a shared file. `depth` bounds cyclic structures.
   */
  function stripPrivate(value, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(value)) return value.map((v) => stripPrivate(v, depth + 1));
    if (isPlainObject(value)) {
      const out = {};
      for (const key of Object.keys(value)) {
        if (key.charAt(0) === '_') continue;
        out[key] = stripPrivate(value[key], depth + 1);
      }
      return out;
    }
    return value;
  }

  function jsonText(value) {
    if (typeof value === 'string') return value;
    try {
      const text = JSON.stringify(stripPrivate(value), null, 2);
      return typeof text === 'string' ? text : '';
    } catch {
      return String(value == null ? '' : value);
    }
  }

  // ──────── CONTENT RENDERING ────────
  /**
   * Text → HTML. Redaction always runs here; markdown is opt-in.
   *
   * When `renderMarkdown` is supplied the caller guarantees its output is safe
   * HTML (the side panel's renderer escapes raw HTML). When it is absent we
   * escape, so markdown that a model wrote stays literal text instead of
   * becoming live HTML.
   */
  // AUDIT M3: caller-supplied markdown output was embedded verbatim, and the
  // panel's renderer (marked) happily emits <a href="javascript:...">. An export
  // is opened by someone else, so a model-written link could run script in their
  // browser. Strip the dangerous constructs rather than trusting the caller.
  function sanitiseHtml(html) {
    return String(html)
      // Executable/embedded content.
      .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
      // Inline event handlers (onclick, onerror, …).
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // javascript:/vbscript:/data:text-html URLs in any attribute. Rewrite the
      // whole attribute so the result stays valid HTML (no orphaned quote).
      .replace(/\b(href|src|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (m, name, val) => {
          const bare = String(val).replace(/^["']|["']$/g, '').trim();
          return /^\s*(javascript|vbscript|data\s*:\s*text\/html)\s*:/i.test(bare) ? `${name}="#"` : m;
        })
      // style="…expression(…)" / behavior:url(…) era payloads.
      .replace(/\bstyle\s*=\s*("|')[^"']*(expression|behavior|javascript)[^"']*\1/gi, '');
  }

  function renderText(text, renderMarkdown) {
    const redacted = redactSecrets(text);
    if (typeof renderMarkdown === 'function') {
      try {
        const html = renderMarkdown(redacted);
        if (typeof html === 'string') return sanitiseHtml(html);
      } catch {
        // A broken markdown renderer must not cost the reader the message.
      }
    }
    return esc(redacted);
  }

  function imageUrlOf(part) {
    const raw = part.image_url;
    if (typeof raw === 'string') return raw;
    if (isPlainObject(raw) && typeof raw.url === 'string') return raw.url;
    if (typeof part.url === 'string') return part.url;
    return null;
  }

  /** Render string | OpenAI-style parts | object content into HTML. */
  function renderContent(content, renderMarkdown) {
    if (content == null) return '';
    if (typeof content === 'string') return renderText(content, renderMarkdown);
    if (typeof content === 'number' || typeof content === 'boolean') {
      return esc(redactSecrets(String(content)));
    }
    if (isPlainObject(content)) {
      return `<pre><code>${esc(redactSecrets(jsonText(content)))}</code></pre>`;
    }
    if (!Array.isArray(content)) return '';

    const out = [];
    for (const part of content) {
      if (part == null) continue;
      if (typeof part === 'string') {
        out.push(renderText(part, renderMarkdown));
        continue;
      }
      if (!isPlainObject(part)) continue;
      const type = part.type;
      if (type === 'text' || (type == null && typeof part.text === 'string')) {
        if (typeof part.text === 'string') out.push(renderText(part.text, renderMarkdown));
        continue;
      }
      if (type === 'image_url' || type === 'image') {
        const url = imageUrlOf(part);
        if (url && IMAGE_DATA_URL.test(url)) {
          out.push(`<img src="${esc(url)}" alt="image">`);
        } else {
          // Remote/animated/SVG images are never fetched or embedded.
          out.push('<span class="image-placeholder">[image]</span>');
        }
        continue;
      }
      // Unknown part types are dropped rather than serialised: they can carry
      // provider-internal state.
    }
    return out.join('\n');
  }

  /**
   * Tool-call arguments are usually a JSON string, so key-walking alone cannot
   * see nested bookkeeping (an agent can pass `_internal` inside its arguments).
   * Parse when it looks like JSON, strip `_` keys, re-serialise; anything that
   * is not JSON stays verbatim (it may be a partial stream chunk).
   */
  function argumentsText(rawArgs) {
    if (rawArgs == null) return '{}';
    if (typeof rawArgs !== 'string') return jsonText(rawArgs);
    const trimmed = rawArgs.trim();
    if (!trimmed || (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[')) return rawArgs;
    try {
      return jsonText(JSON.parse(trimmed));
    } catch {
      return rawArgs;
    }
  }

  /** Collapsed tool-call blocks for an assistant turn. */
  function renderToolCalls(calls) {
    if (!Array.isArray(calls) || !calls.length) return '';
    const blocks = [];
    for (const call of calls) {
      if (!isPlainObject(call)) continue;
      const fn = isPlainObject(call.function) ? call.function : {};
      const name = typeof fn.name === 'string' && fn.name
        ? fn.name
        : (typeof call.name === 'string' && call.name ? call.name : 'unknown_tool');
      const rawArgs = fn.arguments != null ? fn.arguments : call.arguments;
      const args = argumentsText(rawArgs);
      blocks.push(
        `<details class="tool-call"><summary>tool call: <code class="tool">${esc(redactSecrets(name))}</code></summary>` +
        `<pre><code>${esc(redactSecrets(args))}</code></pre></details>`
      );
    }
    return blocks.join('\n');
  }

  function messageRole(m) {
    return (isPlainObject(m) && typeof m.role === 'string') ? m.role : '';
  }

  function renderTurn(message, renderMarkdown) {
    const role = messageRole(message);
    if (!role) return '';

    if (role === 'user') {
      return '<section class="turn turn-user">\n<div class="role">User</div>\n' +
        `<div class="body">${renderContent(message.content, renderMarkdown)}</div>\n</section>`;
    }
    if (role === 'assistant') {
      const body = renderContent(message.content, renderMarkdown);
      const calls = renderToolCalls(message.tool_calls);
      return '<section class="turn turn-assistant">\n<div class="role">Assistant</div>\n' +
        `<div class="body">${body}</div>\n${calls ? calls + '\n' : ''}</section>`;
    }
    if (role === 'tool') {
      const name = (typeof message.name === 'string' && message.name) ? message.name : 'tool';
      const body = renderContent(message.content, null);
      return '<section class="turn turn-tool">\n<div class="role">Tool</div>\n' +
        `<details class="tool-result"><summary>tool result: <code class="tool">${esc(redactSecrets(name))}</code></summary>` +
        `\n<div class="body">${body}</div>\n</details>\n</section>`;
    }
    // `system`/`developer`/unknown roles are internal prompt plumbing: they are
    // not part of the conversation the user is sharing, and they are the most
    // likely place for hidden instructions to leak. Drop them.
    return '';
  }

  // ──────── DOCUMENT ────────
  /**
   * Build the complete standalone HTML export.
   *
   * @param {object} session  { title?, history?: [...] } — missing fields are fine.
   * @param {{renderMarkdown?: (text:string)=>string}} [options]
   * @returns {string}
   */
  function buildShareHtml(session, options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const renderMarkdown = typeof opts.renderMarkdown === 'function' ? opts.renderMarkdown : null;
    const src = isPlainObject(session) ? session : {};

    const rawTitle = typeof src.title === 'string' ? src.title.trim() : '';
    const title = redactSecrets(rawTitle) || 'Kyoto conversation';
    const history = Array.isArray(src.history) ? src.history : [];
    const turns = history.map((m) => renderTurn(m, renderMarkdown)).filter(Boolean);
    const stamp = new Date().toISOString();
    const safeStamp = esc(stamp);
    const safeTitle = esc(title);
    const count = turns.length;

    const head = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="color-scheme" content="light dark">',
      // Defence in depth: even if markup smuggling slips through, this export can
      // never run script or make a network request. It is opened as a file://
      // document by someone else, so it must be inert by construction.
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">',
      `<title>${safeTitle}</title>`,
      `<style>${STYLE}</style>`,
      '</head>',
      '<body>',
      '<main class="wrap">',
      `<h1 class="title">${safeTitle}</h1>`,
      `<p class="meta">${count} message${count === 1 ? '' : 's'}</p>`
    ];

    const body = turns.length
      ? turns
      : ['<p class="empty">No messages in this conversation.</p>'];

    const foot = [
      `<footer class="footer">Exported from Kyoto · <time datetime="${safeStamp}">${safeStamp}</time></footer>`,
      '</main>',
      '</body>',
      '</html>',
      ''
    ];

    return head.concat(body, foot).join('\n');
  }

  window.KyotoShare = {
    redactSecrets,
    buildShareHtml,
    sanitiseHtml
  };
})();
