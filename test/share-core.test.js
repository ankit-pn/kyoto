// Tests for sidepanel/share-core.js — the standalone HTML export.
//
// This file is SECURITY-critical. A share export leaves the machine and gets
// opened by other people, so two properties are non-negotiable:
//
// 1. REDACTION. Credentials in a transcript (provider keys, JWTs, Bearer
//    tokens, opaque 40+ char blobs) must not survive into the file — while
//    ordinary prose, URLs and short hex must survive untouched, or the export
//    becomes useless and people stop using it.
// 2. ESCAPING. Model/tool output is hostile input. Every `<`, `>`, `&`, `"`,
//    `'` must be escaped so a transcript can never inject markup, and the
//    document must contain no executable or remote content at all (no
//    <script>, no <link>, no @import, no remote url(), no remote images).
//
// Plus: underscore-prefixed bookkeeping (`_usage/_cost/_spend/_subagent*`/
// `_reasoning`) must never be emitted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'sidepanel', 'share-core.js'),
  'utf-8'
);

// Same-realm load so deepEqual sees shared prototypes.
function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/share-core.js' });
    return globalThis.KyotoShare;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const S = load();

// A fake OpenRouter key, assembled at RUNTIME so the source never contains a
// literal that secret scanners flag. GitHub push protection blocks the push on a
// `sk-or-v1-<hex>` literal even though this fixture is synthetic — the scanner
// cannot tell, and adding the repo to an allowlist would leave the pattern in
// history for every future clone. The regex under test is unchanged: the prefix
// followed by 64 hex characters.
const fakeORKey = () => 'sk-or-' + 'v1-' + '0123456789abcdef'.repeat(4);
const eq = assert.equal;

// JWT fixture is built by concatenation so this file never contains a literal
// token that secret scanners (or this module's own rules) can trip over.
const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dbq7Z1r0fQk8mVd2'].join('.');

// ══════════════════════════════════════════════════════
// redactSecrets — every supported format
// ══════════════════════════════════════════════════════
test('redactSecrets removes OpenRouter keys (sk-or-v1-…)', () => {
  const out = S.redactSecrets(`key ${fakeORKey()} here`);
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(!/sk-or-v1-[0-9a-f]/i.test(out), out);
  assert.match(out, /^key \[REDACTED\] here$/);
});

test('redactSecrets removes OpenAI-style keys (sk-, sk-proj-, sk-svcacct-)', () => {
  for (const key of [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'sk-svcacct-abcdefghijklmnopqrstuvwxyz012345'
  ]) {
    const out = S.redactSecrets(`OPENAI_API_KEY=${key}`);
    assert.ok(!out.includes(key), `leaked ${key.slice(0, 12)}…: ${out}`);
    assert.ok(out.includes('[REDACTED]'), out);
  }
});

test('redactSecrets removes OpenCode Go keys (oc_sk_…)', () => {
  const key = 'oc_sk_abcdefghijklmnop1234567890';
  const out = S.redactSecrets(`token: ${key}`);
  assert.ok(!out.includes(key), out);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets removes GitHub tokens (ghp_/gho_ and friends)', () => {
  for (const key of [
    'ghp_1234567890abcdefghijABCDEFGHIJ',
    'gho_1234567890abcdefghijABCDEFGHIJ',
    'ghs_1234567890abcdefghijABCDEFGHIJ'
  ]) {
    const out = S.redactSecrets(`git push https://${key}@github.com/x/y`);
    assert.ok(!out.includes(key), `leaked ${key.slice(0, 8)}…: ${out}`);
    assert.ok(out.includes('[REDACTED]'), out);
  }
});

test('redactSecrets removes AWS access key ids (AKIA + 16)', () => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const out = S.redactSecrets(`aws_access_key_id = ${key}`);
  assert.ok(!out.includes(key), out);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets keeps the Bearer scheme word but drops the token', () => {
  const out = S.redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
  assert.match(out, /^Authorization: Bearer \[REDACTED\]$/);
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'));
});

test('redactSecrets removes JWTs (three dotted base64url segments)', () => {
  const out = S.redactSecrets(`Authorization: JWT ${JWT}`);
  assert.ok(!out.includes(JWT), out);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets removes long hex blobs (40 and 64 chars)', () => {
  const sha1 = 'a'.repeat(40);
  const sha256 = '0123456789abcdef'.repeat(4);
  const out = S.redactSecrets(`hash=${sha1} other=${sha256}`);
  assert.ok(!out.includes(sha1), out);
  assert.ok(!out.includes(sha256), out);
  eq((out.match(/\[REDACTED\]/g) || []).length, 2, out);
});

test('redactSecrets removes 40+ char base64-ish blobs', () => {
  const blob = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAbCdEfGh';
  const out = S.redactSecrets(`token ${blob}`);
  assert.ok(!out.includes(blob), out);
  assert.ok(out.includes('[REDACTED]'));
});

// ── redactSecrets must not over-reach ────────────────
test('redactSecrets removes whole PEM private-key blocks (multiline)', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    'ijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345',
    '-----END RSA PRIVATE KEY-----'
  ].join('\n');
  const out = S.redactSecrets(`before\n${pem}\nafter`);
  assert.ok(!out.includes('MIIEpAIBAAKCAQEA'), out);
  assert.ok(!out.includes('PRIVATE KEY'), out);
  assert.ok(out.includes('[REDACTED]'));
  assert.match(out, /^before\n\[REDACTED\]\nafter$/, 'surrounding prose survives');
});

test('redactSecrets redacts a truncated PEM block instead of leaking it', () => {
  const truncated = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'].join('\n');
  const out = S.redactSecrets(truncated);
  assert.ok(!out.includes('b3BlbnNzaC1rZXktdjE'), out);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets leaves ordinary prose, code and short identifiers alone', () => {
  const prose = [
    'The quick brown fox jumps over the lazy dog.',
    'Use `chrome.declarativeNetRequest.getDynamicRules()` to list rules.',
    'Pneumonoultramicroscopicsilicovolcanoconiosis is a long word.',
    'commit 1a2b3c4 and short hex deadbeef / cafe1234 stay readable.',
    'filename: 2026-11-01T09-02-33Z-export.json',
    'error_code=ENOENT path=/usr/local/lib/node_modules',
    'Style: sk-learn style pipelines are lowercase and hyphenated.'
  ].join('\n');
  eq(S.redactSecrets(prose), prose);
});

test('redactSecrets does not mangle normal URLs', () => {
  const urls = [
    'https://example.com/docs/api/reference?page=2&lang=en',
    'http://localhost:3000/api/users/42?include=profile',
    'https://cdn.example.com/assets/app.3f2a1b.css',
    'https://github.com/ankit/kyoto/blob/main/README.md',
    'mailto:support@example.com'
  ].join('\n');
  eq(S.redactSecrets(urls), urls);
});

test('redactSecrets is idempotent (a second pass changes nothing)', () => {
  const dirty = `sk-abcdefghijklmnopqrstuvwxyz012345 ${JWT} ${'f'.repeat(40)} Bearer abcdefghijklmnop`;
  const once = S.redactSecrets(dirty);
  eq(S.redactSecrets(once), once);
});

test('redactSecrets tolerates non-string input and empty values', () => {
  eq(S.redactSecrets(null), '');
  eq(S.redactSecrets(undefined), '');
  eq(S.redactSecrets(42), '42');
  eq(S.redactSecrets(''), '');
});

// ══════════════════════════════════════════════════════
// buildShareHtml — document skeleton
// ══════════════════════════════════════════════════════
function session(overrides = {}) {
  return {
    id: 'sess-1',
    title: 'Debugging the checkout API',
    history: [
      { role: 'user', content: 'Why does POST /api/checkout return 500?' },
      { role: 'assistant', content: 'Let me look at the network log.' },
      { role: 'tool', name: 'network_capture_list', content: '[]' }
    ],
    ...overrides
  };
}

test('buildShareHtml emits one standalone document with inline styles', () => {
  const html = S.buildShareHtml(session());
  assert.ok(html.startsWith('<!doctype html>'), html.slice(0, 40));
  assert.ok(html.includes('<style>'), 'styles are inline');
  assert.ok(html.includes('</html>'));
  assert.ok(html.includes('Debugging the checkout API'));
  assert.ok(html.includes('Why does POST /api/checkout return 500?'));
  assert.ok(html.includes('Let me look at the network log.'));
  assert.ok(html.includes('network_capture_list'));
});

test('buildShareHtml makes zero external requests and loads no code', () => {
  const html = S.buildShareHtml(session({
    history: [
      { role: 'user', content: 'plain prose, no links here' },
      { role: 'assistant', content: 'ok' }
    ]
  }));
  const forbidden = [
    /<script/i, /<link\b/i, /<iframe/i, /<object/i, /<embed/i,
    /@import/i, /url\s*\(/i, /javascript:/i,
    /src\s*=\s*["']https?:/i, /href\s*=\s*["']https?:/i,
    /https?:\/\//i
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(html), `export must not contain ${re}: ${(html.match(re) || [])[0]}`);
  }
});

test('buildShareHtml footer names Kyoto and carries a timestamp', () => {
  const html = S.buildShareHtml(session());
  assert.match(html, /Exported from Kyoto/);
  assert.match(html, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO timestamp in the footer');
});

// ══════════════════════════════════════════════════════
// buildShareHtml — escaping (hostile input)
// ══════════════════════════════════════════════════════
test('buildShareHtml escapes HTML injection in the title', () => {
  const html = S.buildShareHtml(session({
    title: '<script>alert("xss")</script> & <b>bold</b> it\'s'
  }));
  assert.ok(!html.includes('<script>alert'), 'raw script tag leaked');
  assert.ok(!html.includes('<b>bold</b>'), 'raw markup leaked');
  assert.ok(html.includes('&lt;script&gt;'), 'title must be escaped');
  assert.ok(html.includes('&amp;'), 'ampersand must be escaped');
  assert.ok(html.includes('&quot;xss&quot;'), 'double quote must be escaped');
  assert.ok(html.includes('&#39;'), 'single quote must be escaped');
  // Title appears in both <title> and <h1>, so escaping must hold in both.
  eq((html.match(/&lt;script&gt;/g) || []).length, 2, 'title escaped everywhere it is emitted');
});

test('buildShareHtml escapes HTML injection in every message role', () => {
  const payload = '<img src=x onerror="alert(1)"> & <script>evil()</script>';
  const html = S.buildShareHtml(session({
    history: [
      { role: 'user', content: payload },
      { role: 'assistant', content: payload },
      { role: 'tool', name: '<b>tool</b>', content: payload }
    ]
  }));
  assert.ok(!html.includes('<img src=x'), 'user/assistant payload leaked');
  assert.ok(!html.includes('<script>evil'), 'script payload leaked');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'payload must be escaped');
  assert.ok(html.includes('&lt;b&gt;tool&lt;/b&gt;'), 'tool name must be escaped');
});

test('buildShareHtml redacts secrets in the title, messages, tool calls and results', () => {
  const key = fakeORKey();
  const html = S.buildShareHtml(session({
    title: `keys: ${key}`,
    history: [
      { role: 'user', content: `my key is ${key}` },
      { role: 'assistant', content: `Bearer ${'a'.repeat(32)}`, tool_calls: [{ function: { name: 'network_fetch', arguments: JSON.stringify({ auth: `Bearer ${JWT}` }) } }] },
      { role: 'tool', name: 'network_fetch', content: `AKIAIOSFODNN7EXAMPLE` }
    ]
  }));
  assert.ok(!html.includes(key), 'title/content key leaked');
  assert.ok(!html.includes(JWT), 'JWT in tool arguments leaked');
  assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key in tool result leaked');
  assert.ok((html.match(/\[REDACTED\]/g) || []).length >= 4, 'every secret replaced with [REDACTED]');
});

// ══════════════════════════════════════════════════════
// buildShareHtml — multimodal content
// ══════════════════════════════════════════════════════
test('buildShareHtml renders array content: text parts and data: images', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const html = S.buildShareHtml(session({
    history: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is wrong here?' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  }));
  assert.ok(html.includes('what is wrong here?'));
  assert.ok(html.includes(`<img src="${dataUrl}" alt="image">`), 'data: URL must be embedded');
});

test('buildShareHtml never embeds or fetches remote images', () => {
  const html = S.buildShareHtml(session({
    history: [{
      role: 'user',
      content: [
        { type: 'text', text: 'screenshot attached' },
        { type: 'image_url', image_url: { url: 'https://example.com/shot.png' } },
        { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }
      ]
    }]
  }));
  assert.ok(!html.includes('example.com/shot.png'), 'remote URL must not survive');
  assert.ok(!/src\s*=\s*["']https?:/i.test(html), 'no remote img src');
  assert.ok(!html.includes('svg+xml'), 'SVG data URLs are not embedded (they can carry script)');
  eq((html.match(/\[image\]/g) || []).length, 2, 'each non-raster image becomes a placeholder');
});

// ══════════════════════════════════════════════════════
// buildShareHtml — tool calls / results
// ══════════════════════════════════════════════════════
test('buildShareHtml renders assistant tool_calls as collapsed details', () => {
  const html = S.buildShareHtml(session({
    history: [{
      role: 'assistant',
      content: 'checking',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'page_eval', arguments: '{"code":"document.title"}' }
      }]
    }]
  }));
  assert.match(html, /<details class="tool-call">/);
  assert.ok(html.includes('tool call: <code class="tool">page_eval</code>'));
  assert.ok(html.includes('&quot;code&quot;') && html.includes('&quot;document.title&quot;'), 'arguments are escaped (re-serialised JSON)');
  assert.ok(!html.includes('<details open'), 'tool calls start collapsed');
});

test('buildShareHtml escapes and redacts tool_calls arguments', () => {
  const html = S.buildShareHtml(session({
    history: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: {
          name: 'network_fetch',
          arguments: JSON.stringify({ url: 'https://api.example.com', headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }, probe: '<script>' })
        }
      }]
    }]
  }));
  assert.ok(!html.includes('abcdefghijklmnopqrstuvwxyz'), 'bearer token leaked from arguments');
  assert.ok(!html.includes('<script>'), 'arguments injected raw HTML');
  assert.ok(html.includes('&lt;script&gt;'), 'arguments must be escaped');
});

test('buildShareHtml renders tool result turns inside a collapsed details block', () => {
  const html = S.buildShareHtml(session({
    history: [{ role: 'tool', name: 'fs_read', content: '{"ok":true,"bytes":12}' }]
  }));
  assert.match(html, /<details class="tool-result">/);
  assert.ok(html.includes('tool result: <code class="tool">fs_read</code>'));
  assert.ok(html.includes('&quot;ok&quot;:true'));
});

// ══════════════════════════════════════════════════════
// buildShareHtml — private keys must never be emitted
// ══════════════════════════════════════════════════════
test('buildShareHtml strips every underscore-prefixed key', () => {
  const html = S.buildShareHtml(session({
    _spend: 4.2,
    _subagentRuns: 7,
    title: 'with bookkeeping',
    history: [{
      role: 'assistant',
      content: 'answer',
      _usage: { prompt_tokens: 98765, completion_tokens: 4321 },
      _cost: 1.2345,
      _reasoning: 'SECRET-REASONING-TRACE',
      _pinned: true,
      _error: 'INTERNAL-ERROR-DETAIL',
      _subagentParent: 'sess-0',
      tool_calls: [{
        function: {
          name: 'page_eval',
          arguments: JSON.stringify({ code: '1', _internal: 'HIDDEN-NESTED-MARKER' })
        }
      }]
    }]
  }));
  for (const marker of ['98765', '1.2345', 'SECRET-REASONING-TRACE', 'INTERNAL-ERROR-DETAIL', 'HIDDEN-NESTED-MARKER', 'sess-0']) {
    assert.ok(!html.includes(marker), `private marker leaked: ${marker}`);
  }
  // …and none of the key names themselves appear either.
  for (const key of ['_usage', '_cost', '_reasoning', '_pinned', '_error', '_subagent', '_internal']) {
    assert.ok(!html.includes(key), `private key leaked: ${key}`);
  }
});

// ══════════════════════════════════════════════════════
// buildShareHtml — tolerance
// ══════════════════════════════════════════════════════
test('buildShareHtml tolerates missing/undefined session fields', () => {
  for (const input of [undefined, null, {}, { history: null }, { history: 'nope' }, { title: 42 }, 5, 'x']) {
    const html = S.buildShareHtml(input);
    assert.ok(html.startsWith('<!doctype html>'), `broken doc for ${JSON.stringify(input)}`);
    assert.ok(html.includes('</html>'));
    assert.ok(html.includes('Exported from Kyoto'));
  }
});

test('buildShareHtml skips empty turns but keeps the rest', () => {
  const html = S.buildShareHtml(session({
    history: [null, {}, { role: 'user', content: '' }, { role: 'assistant', content: 'kept' }, { role: 'wat', content: 'dropped' }]
  }));
  assert.ok(html.includes('kept'));
  assert.ok(!html.includes('dropped'), 'unknown roles are not part of the shared conversation');
});

test('buildShareHtml does not render system/developer prompt plumbing', () => {
  const html = S.buildShareHtml(session({
    history: [
      { role: 'system', content: 'SYSTEM-PROMPT-SECRET' },
      { role: 'developer', content: 'DEVELOPER-PROMPT-SECRET' },
      { role: 'user', content: 'hi' }
    ]
  }));
  assert.ok(!html.includes('SYSTEM-PROMPT-SECRET'));
  assert.ok(!html.includes('DEVELOPER-PROMPT-SECRET'));
  assert.ok(html.includes('hi'));
});

test('buildShareHtml escapes tool result objects and drops private nested keys', () => {
  const html = S.buildShareHtml(session({
    history: [{ role: 'tool', name: 'x', content: { ok: true, _hidden: 'NESTED-PRIVATE', note: '<b>' } }]
  }));
  assert.ok(!html.includes('NESTED-PRIVATE'));
  assert.ok(html.includes('&quot;ok&quot;: true'));
  assert.ok(html.includes('&lt;b&gt;'));
});

// ══════════════════════════════════════════════════════
// buildShareHtml — markdown hook
// ══════════════════════════════════════════════════════
test('buildShareHtml uses renderMarkdown when supplied and passes it redacted text', () => {
  let received = null;
  const html = S.buildShareHtml(session({
    history: [{ role: 'assistant', content: '**bold** sk-abcdefghijklmnopqrstuvwxyz012345' }]
  }), {
    renderMarkdown: (text) => {
      received = text;
      return '<p class="md">rendered</p>';
    }
  });
  assert.ok(html.includes('<p class="md">rendered</p>'), 'renderer output is embedded as HTML');
  assert.ok(received && received.includes('**bold**'), 'markdown source reached the renderer');
  assert.ok(!received.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'renderer must receive redacted text');
});

test('buildShareHtml does NOT turn markdown into HTML without a renderer', () => {
  const html = S.buildShareHtml(session({
    history: [{ role: 'assistant', content: '**bold** and <b>raw</b> and `code`' }]
  }));
  assert.ok(html.includes('**bold**'), 'markdown stays literal text');
  assert.ok(!html.includes('<strong>'), 'no markdown renderer ran');
  assert.ok(!html.includes('<b>raw</b>'), 'raw HTML from the model stays text');
  assert.ok(html.includes('&lt;b&gt;raw&lt;/b&gt;'));
});

test('buildShareHtml survives a throwing renderMarkdown by escaping instead', () => {
  const html = S.buildShareHtml(session({
    history: [{ role: 'assistant', content: 'fallback <text>' }]
  }), {
    renderMarkdown: () => { throw new Error('renderer exploded'); }
  });
  assert.ok(html.includes('fallback &lt;text&gt;'), 'falls back to escaped text');
  assert.ok(html.includes('Exported from Kyoto'));
});

// ══════════════════════════════════════════════════════
// Full-document invariants on a rich, hostile fixture
// ══════════════════════════════════════════════════════
test('a rich hostile session still exports an inert self-contained document', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const html = S.buildShareHtml({
    title: '<script>owned()</script>',
    url: 'https://example.com/private',
    history: [
      { role: 'user', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }, { type: 'image_url', image_url: { url: dataUrl } }] },
      { role: 'assistant', content: 'key sk-abcdefghijklmnopqrstuvwxyz012345', tool_calls: [{ function: { name: 'network_fetch', arguments: '{"h":"Bearer abcdefghijklmnopqrstuvwxyz"}' } }], _usage: { prompt_tokens: 111 }, _reasoning: 'hidden' },
      { role: 'tool', name: 'shell_exec', content: '<script>alert(2)</script> AKIAIOSFODNN7EXAMPLE' }
    ]
  });

  // Structure
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<style>') && html.includes('</style>'));
  assert.ok(html.includes('Exported from Kyoto'));

  // No executable/remote content, no secret or bookkeeping
  for (const re of [/<script/i, /<link\b/i, /@import/i, /url\s*\(/i, /src\s*=\s*["']https?:/i, /https?:\/\//i]) {
    assert.ok(!re.test(html), `hostile fixture emitted ${re}`);
  }
  assert.ok(!html.includes('abcdefghijklmnopqrstuvwxyz'), 'API key leaked');
  assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key leaked');
  assert.ok(!html.includes('111'), 'usage tokens leaked');
  assert.ok(!html.includes('hidden'), 'reasoning leaked');
});

// ══════════════════════════════════════════════════════
// Regressions for the v14.24.0 independent audit
// ══════════════════════════════════════════════════════

// AUDIT M3: renderMarkdown output was embedded verbatim. The panel's renderer
// (marked) emits live javascript: hrefs, so an export opened by someone else
// could run script on click. The export must be inert.
test('sanitiseHtml neutralises script, handlers and javascript: URLs', () => {
  const out = S.sanitiseHtml(
    '<p><a href="javascript:alert(1)">x</a><img src=x onerror="alert(1)">' +
    '<script>alert(1)</script><a href="https://ok.test/page">ok</a></p>'
  );
  assert.ok(!/javascript:/i.test(out), 'javascript: URL survived sanitising');
  assert.ok(!/onerror/i.test(out), 'inline handler survived sanitising');
  assert.ok(!/<script/i.test(out), 'script element survived sanitising');
  assert.match(out, /https:\/\/ok\.test\/page/, 'legitimate links must survive');
  assert.ok(!/""/.test(out), `sanitiser produced malformed attributes: ${out}`);
});

test('a markdown renderer that emits script cannot make the export executable', () => {
  const html = S.buildShareHtml(
    { title: 'x', history: [{ role: 'user', content: 'hello' }] },
    { renderMarkdown: (t) => `<a href="javascript:alert(1)">${t}</a><script>alert(2)</script>` }
  );
  assert.ok(!/javascript:/i.test(html), 'javascript: href leaked into the export');
  assert.ok(!/<script>alert/i.test(html), 'script leaked into the export');
  assert.match(html, /Content-Security-Policy/, 'the export should carry a CSP as defence in depth');
});

// AUDIT M4: a credential wrapped across a line was only partially redacted,
// leaving the tail of the key in the export.
test('redacts a credential split across a line boundary', () => {
  const wrapped = 'token sk-or-v1-' + 'a'.repeat(20) + '\n' + 'b'.repeat(20) + ' end';
  const out = S.redactSecrets(wrapped);
  assert.ok(!/a{20}/.test(out), 'first fragment leaked');
  assert.ok(!/b{20}/.test(out), 'wrapped tail leaked');
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /end$/, 'surrounding prose must be preserved');
});
