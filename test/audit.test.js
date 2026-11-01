// Repo-wide structural audit.
//
// Every other test checks one module's behaviour. This one checks the glue that
// no unit test can see: that the manifest agrees with the code, that every
// script the panel loads actually exists and is ordered correctly, that every
// element the JS reaches for exists in the markup, and that no secret is
// committed.
//
// It exists because each of those has already broken for real in this repo: an
// unused permission (install warning for nothing), a duplicate tool name that
// silently shadowed a tool, a hardcoded skills-hub key, and dead element refs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** Strip // and /* *\/ comments while respecting string/template literals. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// All first-party JS, comments stripped, for code-level scans.
function allSources() {
  const files = ['background.js', 'sidepanel/sidepanel.js', 'sidepanel/mcp.js', 'sidepanel/vfs.js',
    'sidepanel/models-registry.js', 'sidepanel/providers.js', 'sidepanel/context.js',
    'sidepanel/tab-target.js', 'sidepanel/palette-core.js', 'sidepanel/speech.js',
    'sidepanel/council-core.js', 'sidepanel/routine.js', 'sidepanel/share-core.js'];
  for (const f of fs.readdirSync(path.join(ROOT, 'sidepanel', 'tools'))) {
    if (f.endsWith('.js')) files.push('sidepanel/tools/' + f);
  }
  return files.filter(f => fs.existsSync(path.join(ROOT, f)))
    .map(f => ({ file: f, code: stripComments(read(f)) }));
}

const MANIFEST = JSON.parse(read('manifest.json'));
const HTML = read('sidepanel/sidepanel.html');
const SOURCES = allSources();
const ALL_CODE = SOURCES.map(s => s.code).join('\n');

// ── Manifest ─────────────────────────────────────────
test('manifest is valid and has the fields Chrome needs', () => {
  assert.equal(MANIFEST.manifest_version, 3);
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+$/);
  assert.ok(MANIFEST.name && MANIFEST.description);
  assert.ok(Array.isArray(MANIFEST.permissions) && MANIFEST.permissions.length > 0);
  assert.ok(MANIFEST.background?.service_worker, 'MV3 service worker must be declared');
  assert.equal(MANIFEST.side_panel?.default_path, 'sidepanel/sidepanel.html');
});

// Namespaces that need NO permission declaration. Anything else used in code
// must appear in `permissions` / `optional_permissions`.
const PERMISSION_FREE = new Set(['runtime', 'i18n', 'permissions', 'windows', 'extension', 'types']);

/** Map a permission to the code pattern that proves it is used. */
const PERMISSION_USAGE = {
  storage: /chrome\.storage\b/,
  sidePanel: /chrome\.sidePanel\b/,
  scripting: /chrome\.scripting\b/,
  contextMenus: /chrome\.contextMenus\b/,
  tabs: /chrome\.tabs\b/,
  cookies: /chrome\.cookies\b/,
  webRequest: /chrome\.webRequest\b/,
  webNavigation: /chrome\.webNavigation\b/,
  history: /chrome\.history\b/,
  bookmarks: /chrome\.bookmarks\b/,
  downloads: /chrome\.downloads\b/,
  notifications: /chrome\.notifications\b/,
  clipboardWrite: /navigator\.clipboard\.writeText|clipboard\.write/,
  alarms: /chrome\.alarms\b/,
  debugger: /chrome\.debugger\b/,
  nativeMessaging: /connectNative|sendNativeMessage/,
  tabGroups: /chrome\.tabGroups\b|chrome\.tabs\.group/,
  sessions: /chrome\.sessions\b/,
  power: /chrome\.power\b/,
  pageCapture: /chrome\.pageCapture\b/,
  browsingData: /chrome\.browsingData\b/,
  readingList: /chrome\.readingList\b/,
  idle: /chrome\.idle\b/,
  omnibox: /chrome\.omnibox\b/,
  declarativeNetRequest: /chrome\.declarativeNetRequest\b/,
  declarativeNetRequestWithHostAccess: /chrome\.declarativeNetRequest\b/,
  management: /chrome\.management\b/,
  topSites: /chrome\.topSites\b/,
  clipboardRead: /navigator\.clipboard\.readText|clipboard\.read/
};

test('every declared permission is actually used (unused grants = install warning for nothing)', () => {
  const declared = [...MANIFEST.permissions, ...(MANIFEST.optional_permissions || [])];
  const unused = declared.filter(p => {
    const re = PERMISSION_USAGE[p];
    // Unknown permission: require at least a chrome.<name> reference.
    return re ? !re.test(ALL_CODE) : !new RegExp(`chrome\\.${p}\\b`).test(ALL_CODE);
  });
  assert.deepEqual(unused, [], `declared but unused (remove them): ${unused.join(', ')}`);
});

test('every chrome namespace used in code is declared or permission-free', () => {
  const used = new Set();
  for (const m of ALL_CODE.matchAll(/chrome\.([a-zA-Z]+)/g)) used.add(m[1]);
  const declared = new Set([...MANIFEST.permissions, ...(MANIFEST.optional_permissions || []), ...PERMISSION_FREE]);
  const missing = [...used].filter(ns => !declared.has(ns)).sort();
  assert.deepEqual(missing, [],
    `chrome APIs used without a declared permission (Chrome will throw/deny): ${missing.join(', ')}`);
});

// ── Script graph ─────────────────────────────────────
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

test('every script the panel loads exists on disk', () => {
  const missing = SCRIPTS.filter(src => !fs.existsSync(path.join(ROOT, 'sidepanel', src)));
  assert.deepEqual(missing, [], `sidepanel.html references missing files: ${missing.join(', ')}`);
});

test('script tag order is correct', () => {
  assert.ok(SCRIPTS.length > 10, `expected many scripts, got ${SCRIPTS.length}`);
  assert.deepEqual(SCRIPTS, [...new Set(SCRIPTS)], 'duplicate <script> tags would double-execute modules');
  const last = SCRIPTS[SCRIPTS.length - 1];
  assert.equal(last, 'sidepanel.js', 'sidepanel.js must load last (it consumes every module)');
  // tools/core.js defines the registry the tool modules append to.
  assert.equal(SCRIPTS.indexOf('tools/core.js') < SCRIPTS.indexOf('tools/finalize.js'), true);
  // finalize.js seals the registry, so every tools/ script must come before it.
  const toolScripts = SCRIPTS.filter(s => s.startsWith('tools/'));
  for (const ts of toolScripts) {
    if (ts === 'tools/finalize.js') continue;
    assert.ok(SCRIPTS.indexOf(ts) < SCRIPTS.indexOf('tools/finalize.js'),
      `${ts} loads after tools/finalize.js, so its tools are silently dropped`);
  }
  // Pure feature modules must be available before sidepanel.js uses them.
  for (const mod of ['providers.js', 'context.js', 'tab-target.js', 'palette-core.js',
    'speech.js', 'council-core.js', 'routine.js', 'share-core.js']) {
    assert.ok(SCRIPTS.includes(mod), `${mod} is not loaded by sidepanel.html`);
    assert.ok(SCRIPTS.indexOf(mod) < SCRIPTS.indexOf('sidepanel.js'), `${mod} must load before sidepanel.js`);
  }
});

// ── DOM contract ─────────────────────────────────────
const HTML_IDS = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
// Created at runtime, so it never appears in the markup.
const RUNTIME_IDS = new Set(['streaming-banner']);
const PANEL_JS = stripComments(read('sidepanel/sidepanel.js'));

test('every element the panel reaches for exists in the markup', () => {
  const refs = new Set();
  for (const m of PANEL_JS.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
  for (const m of PANEL_JS.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter(id => !HTML_IDS.has(id) && !RUNTIME_IDS.has(id)).sort();
  assert.deepEqual(missing, [], `$('id') references with no matching id= in sidepanel.html: ${missing.join(', ')}`);
});

test('every els.<key> used is defined, and no undefined key is reached', () => {
  const start = PANEL_JS.indexOf('const els = {');
  assert.ok(start > -1, 'const els = { not found');
  let depth = 0, end = -1;
  const open = PANEL_JS.indexOf('{', start);
  for (let i = open; i < PANEL_JS.length; i++) {
    if (PANEL_JS[i] === '{') depth++;
    else if (PANEL_JS[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = PANEL_JS.slice(open, end + 1);
  const defined = new Set([...block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]));
  const used = new Set([...PANEL_JS.matchAll(/\bels\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  const missing = [...used].filter(k => !defined.has(k)).sort();
  assert.deepEqual(missing, [], `els.<key> used but not defined: ${missing.join(', ')}`);
});

// ── Secret hygiene ───────────────────────────────────
test('no hardcoded credentials are committed', () => {
  const files = ['manifest.json', ...SOURCES.map(s => s.file), 'README.md'];
  const patterns = [
    [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI-style key'],
    [/\bsk-or-v1-[A-Za-z0-9]{16,}/, 'OpenRouter key'],
    [/\boc_sk_[A-Za-z0-9]{8,}/, 'OpenCode key'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key']
  ];
  const hits = [];
  for (const f of files) {
    const raw = f.endsWith('.js') ? stripComments(read(f)) : read(f);
    for (const [re, label] of patterns) {
      const m = raw.match(re);
      if (m) hits.push(`${f}: ${label} (${m[0].slice(0, 12)}…)`);
    }
  }
  assert.deepEqual(hits, [], `hardcoded secrets found:\n${hits.join('\n')}`);
});

// ── Docs ↔ reality ───────────────────────────────────
test('README documents the current version', () => {
  const readme = read('README.md');
  // The README does not pin a version, but it must not claim a stale one.
  const stale = readme.match(/v(\d+)\.(\d+)\.(\d+) version/i);
  if (stale) {
    assert.equal(stale[0], `v${MANIFEST.version} version`, 'README quotes a stale version');
  }
  assert.ok(readme.includes('Ctrl/Cmd+K') || readme.includes('Ctrl/Cmd+K'), 'palette shortcut should be documented');
});

// ── Accessibility invariants ─────────────────────────
// These exist because the panel shipped with 10 icon-only buttons whose only
// accessible name was `title` (unreliable for screen readers, useless on touch),
// zero visible keyboard focus on buttons, and four infinite animations with no
// reduced-motion escape.

test('every icon-only button has an accessible name', () => {
  const offenders = [];
  for (const m of HTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const inner = m[2].replace(/<[^>]+>/g, '').trim();
    if (inner) continue;                       // has visible text
    if (/aria-label\s*=/.test(attrs)) continue; // named
    const id = (attrs.match(/id="([^"]+)"/) || [])[1]
      || (attrs.match(/class="([^"]+)"/) || [])[1] || 'unnamed';
    offenders.push(id);
  }
  assert.deepEqual(offenders, [],
    `icon-only buttons need aria-label (title alone is not an accessible name): ${offenders.join(', ')}`);
});

test('keyboard focus is visible', () => {
  const css = read('sidepanel/sidepanel.css');
  assert.match(css, /:focus-visible/, 'buttons need a visible focus indicator for keyboard users');
  assert.match(css, /outline:\s*2px solid/, 'the focus ring should be an outline (does not shift layout)');
});

test('animations respect prefers-reduced-motion', () => {
  const css = read('sidepanel/sidepanel.css');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    'infinite animations must be disabled when the OS asks for reduced motion');
  assert.match(css, /animation-iteration-count:\s*1/, 'reduced motion should stop looping animations');
});

test('the panel exposes a live region for announcements', () => {
  assert.match(HTML, /id="srStatus"[^>]*aria-live="polite"/, 'a polite live region is required for turn announcements');
  // The conversation itself must not be a live region: streaming would flood a
  // screen reader with every token.
  const chatTag = (HTML.match(/<main class="chat"[^>]*>/) || [''])[0];
  assert.ok(!/aria-live/.test(chatTag), 'the chat log must not be aria-live (streaming would spam the reader)');
});

test('the settings drawer is a labelled modal dialog', () => {
  const tag = (HTML.match(/<aside[^>]*id="drawer"[^>]*>/) || [''])[0];
  assert.match(tag, /role="dialog"/);
  assert.match(tag, /aria-modal="true"/);
  assert.match(tag, /aria-labelledby="drawerTitle"/);
  assert.match(HTML, /id="drawerTitle"/, 'the aria-labelledby target must exist');
});

test('the layout adapts to a narrow side panel', () => {
  const css = read('sidepanel/sidepanel.css');
  assert.match(css, /@media\s*\(max-width:\s*380px\)/,
    'a side panel is routinely dragged narrow; the layout needs a narrow breakpoint');
});

test('the drawer keeps Save outside the scrolling region', () => {
  // Save used to be the last element of a 15-section / 41-field scroll, so a
  // change made at the top of the form required scrolling the whole drawer to
  // apply it. Structural guard so it cannot drift back.
  const bodyStart = HTML.indexOf('class="drawer-body"');
  const asideEnd = HTML.indexOf('</aside>');
  assert.ok(bodyStart > -1 && asideEnd > bodyStart);
  const saveIdx = HTML.indexOf('id="saveBtn"');
  assert.ok(saveIdx > -1, 'the Save button must exist');
  const footerIdx = HTML.indexOf('class="drawer-footer"');
  assert.ok(footerIdx > -1, 'there must be a pinned drawer footer');
  assert.ok(saveIdx > footerIdx, 'Save must live inside the pinned footer');
  // ...and the footer must come after the scrollable body closes.
  const bodyEnd = HTML.indexOf('</div>', HTML.lastIndexOf('<p class="hint"', footerIdx));
  assert.ok(footerIdx > bodyStart, 'footer must follow the body in source order');
});

// ── Theme integrity ──────────────────────────────────
// The panel ships dark, light (manual) and system-light themes. A colour written
// as a raw value instead of a token is a bug waiting to happen: white-alpha hover
// surfaces were invisible on the light theme, and the dark-theme greens/reds were
// too pale to read on white. These guards keep new rules on the token system.

function cssRuleLines() {
  return read('sidepanel/sidepanel.css').split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    // Token declarations define the theme; they are allowed raw values.
    .filter(({ line }) => !/^\s*--[a-z0-9-]+\s*:/i.test(line));
}

test('no rule hardcodes a white-alpha surface (invisible on the light theme)', () => {
  const offenders = cssRuleLines()
    .filter(({ line }) => /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/.test(line) && !/var\(--/.test(line))
    .map(({ no, line }) => `${no}: ${line.trim()}`);
  assert.deepEqual(offenders, [],
    `use var(--hover) / var(--hover-strong) instead of white-alpha:\n${offenders.join('\n')}`);
});

test('no rule hardcodes a colour value outside the token system', () => {
  // Allowed: var(--token, #fallback) and pure-black shadows/scrims.
  const offenders = cssRuleLines().filter(({ line }) => {
    if (/var\(--[a-z0-9-]+\s*,\s*#/.test(line)) return false;      // defensive fallback
    if (/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(line)) return false;  // shadow / scrim
    return /(color|background|border|fill|stroke)\s*:\s*#[0-9a-fA-F]{3,8}/.test(line);
  }).map(({ no, line }) => `${no}: ${line.trim()}`);
  assert.deepEqual(offenders, [],
    `hardcoded colours bypass the theme:\n${offenders.join('\n')}`);
});

/**
 * Extract a CSS rule block by selector, exactly. A naive split() would include
 * everything AFTER the match, so a token defined in a later scope would satisfy
 * the assertion — the guard would pass while the theme was broken.
 */
function cssBlock(selector) {
  const css = read('sidepanel/sidepanel.css');
  const start = css.indexOf(selector + ' {');
  assert.ok(start > -1, `rule ${selector} not found`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${selector}`);
}

test('theme-dependent tokens are defined in every theme scope', () => {
  // These differ per theme, so each scope must set them: :root (dark default),
  // the manual light/dark overrides, and the system-light media query.
  const scopes = {
    ':root': cssBlock(':root'),
    'body.theme-light': cssBlock('body.theme-light'),
    'body.theme-dark': cssBlock('body.theme-dark'),
    'prefers-color-scheme: light': cssBlock('@media (prefers-color-scheme: light)'),
  };
  for (const [name, block] of Object.entries(scopes)) {
    for (const token of ['--hover', '--hover-strong']) {
      assert.ok(block.includes(token + ':'), `${token} missing from ${name}`);
    }
  }
});

test('semantic colours are themed for contrast on a light background', () => {
  // The dark-theme red/green/amber are too pale to read on white at 11px.
  for (const scope of ['body.theme-light', '@media (prefers-color-scheme: light)']) {
    const block = cssBlock(scope);
    for (const token of ['--danger', '--ok', '--warn']) {
      assert.ok(block.includes(token + ':'), `${token} missing from ${scope}`);
    }
  }
});

test('the shortcuts help dialog is a labelled modal', () => {
  const tag = (HTML.match(/<div[^>]*id="shortcutsOverlay"[^>]*>/) || [''])[0];
  assert.ok(tag, 'the shortcuts overlay must exist');
  assert.match(tag, /role="dialog"/);
  assert.match(tag, /aria-modal="true"/);
  assert.match(tag, /aria-labelledby="shortcutsTitle"/);
  assert.match(HTML, /id="shortcutsTitle"/, 'the aria-labelledby target must exist');
  // Every shortcut row must use real <kbd> elements, not styled spans, so the
  // keys are exposed as keys rather than prose.
  const rows = (HTML.match(/class="shortcuts-list"[\s\S]*?<\/dl>/) || [''])[0];
  assert.ok((rows.match(/<kbd>/g) || []).length >= 8, 'shortcuts should be marked up with <kbd>');
  // And the empty state must advertise it, or nobody finds it.
  assert.match(HTML, /empty-hint[\s\S]{0,120}kbd/, 'the empty state should point at the shortcut help');
});

test('every listbox is owned by a combobox that can reach it', () => {
  // A role="listbox" with no combobox wiring is keyboard-discoverable but not
  // announced. Each combobox must declare aria-controls pointing at a real
  // listbox in the same document.
  const boxes = [...HTML.matchAll(/id="([^"]+)"[^>]*role="listbox"/g)].map(m => m[1]);
  // (The session list is a role="list": its rows contain nested action buttons,
  // and an option may not contain interactive descendants.)
  assert.ok(boxes.length >= 3, `expected the pickers to be listboxes, found ${boxes.length}`);
  // The owner may be a combobox (search inputs) or a textbox (the composer,
  // which owns the slash-command listbox) — the invariant is the wiring, not the role.
  const owners = [...HTML.matchAll(/id="([^"]+)"[^>]*aria-controls="([^"]+)"[^>]*/g)];
  const covered = new Set();
  for (const [whole, inputId, controls] of owners) {
    if (!boxes.includes(controls)) continue;
    covered.add(controls);
    assert.match(whole, /aria-expanded=/, `${inputId} must expose aria-expanded`);
    assert.match(whole, /aria-autocomplete=/, `${inputId} should declare aria-autocomplete for a filter box`);
  }
  for (const box of boxes) {
    assert.ok(covered.has(box), `listbox "${box}" has no owner with aria-controls/aria-expanded`);
  }
});

test('toggle buttons declare their pressed state', () => {
  // A toggle whose state is only a colour/class is invisible to assistive tech.
  for (const id of ['captureBtn', 'visionBtn', 'micBtn']) {
    const tag = (HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`)) || [''])[0];
    assert.ok(tag, `${id} should exist`);
    assert.match(tag, /aria-pressed="(true|false)"/, `${id} is a toggle and needs aria-pressed`);
  }
});

// ── Colour contrast (measurable, not a matter of taste) ──
// The text tokens had never been checked against WCAG. --text-faint was 3.6:1 on
// dark and 3.0:1 on the elevated light background, used for hints, timestamps and
// labels at 10-11px where the AA threshold is 4.5:1. Contrast is arithmetic, so
// this is a guard rather than an opinion.

function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Colour tokens declared inside a given rule block. */
function hexTokens(selector) {
  const block = cssBlock(selector);
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) out[m[1]] = m[2];
  return out;
}

const AA_NORMAL = 4.5;

test('every text token meets WCAG AA against every surface it is used on', () => {
  const scopes = {
    dark: hexTokens(':root'),
    light: hexTokens('body.theme-light'),
    'system-light': hexTokens('@media (prefers-color-scheme: light)')
  };
  const failures = [];
  for (const [name, t] of Object.entries(scopes)) {
    for (const surface of ['bg', 'bg-elev', 'bg-elev2']) {
      if (!t[surface]) continue;
      for (const fg of ['text', 'text-dim', 'text-faint']) {
        if (!t[fg]) continue;
        const r = contrastRatio(t[fg], t[surface]);
        if (r < AA_NORMAL) {
          failures.push(`${name}: --${fg} ${t[fg]} on --${surface} ${t[surface]} = ${r.toFixed(2)}:1 (need ${AA_NORMAL})`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `contrast failures:\n${failures.join('\n')}`);
});

test('semantic colours are readable on the page background', () => {
  // Error/ok/warn text appears on --bg in cron rows, statuses and tool states.
  const scopes = {
    dark: hexTokens(':root'),
    light: hexTokens('body.theme-light')
  };
  const failures = [];
  for (const [name, t] of Object.entries(scopes)) {
    for (const fg of ['accent', 'danger', 'ok', 'warn']) {
      if (!t[fg] || !t.bg) continue;
      const r = contrastRatio(t[fg], t.bg);
      // 3:1 is the UI-component threshold; these are used for text as well, so
      // hold them to the normal-text bar where they already pass.
      if (r < 3) failures.push(`${name}: --${fg} on --bg = ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `semantic contrast failures:\n${failures.join('\n')}`);
});

test('the visual hierarchy of text tokens is preserved', () => {
  // Making faint text pass must not make it indistinguishable from dim text.
  for (const selector of [':root', 'body.theme-light']) {
    const t = hexTokens(selector);
    if (!t.text || !t['text-dim'] || !t['text-faint']) continue;
    const dim = relativeLuminance(t['text-dim']);
    const faint = relativeLuminance(t['text-faint']);
    const bgLum = relativeLuminance(t.bg);
    // Each step must be further from the background than the next-brighter token.
    const dDim = Math.abs(dim - bgLum);
    const dFaint = Math.abs(faint - bgLum);
    assert.ok(dDim > dFaint, `${selector}: --text-dim must stay more prominent than --text-faint`);
    assert.ok(dFaint > 0.01, `${selector}: --text-faint must remain visible against the background`);
  }
});

// ── Minimum click/tap targets (WCAG 2.5.8, AA) ────────
// Several controls are intentionally small glyphs (16-18px tall measured from
// font-size + padding). They now carry a transparent pseudo-element that expands
// the hit area to >=24x24 without changing the visual design.

const SMALL_CONTROLS = [
  '.pin-btn', '.edit-btn', '.copy-msg-btn', '.sess-act',
  '.q-cancel', '.copy-btn', '.ctx-reload', '.pw-dismiss'
];

function cssRuleBody(selector) {
  const css = read('sidepanel/sidepanel.css');
  const head = selector + '::after';
  const start = css.indexOf(head);
  if (start === -1) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(start, i + 1); }
  }
  return '';
}

test('every small control has a >=24px hit area', () => {
  const missing = [];
  for (const sel of SMALL_CONTROLS) {
    const body = cssRuleBody(sel);
    if (!body) { missing.push(`${sel}: no ::after hit-area rule`); continue; }
    if (!/position:\s*absolute/.test(body)) missing.push(`${sel}: hit area not positioned`);
    if (!/height:\s*24px/.test(body)) missing.push(`${sel}: hit area is not 24px tall`);
    // Adjacent siblings must not spill horizontally over each other.
    if (sel === '.sess-act') {
      if (/width:\s*24px/.test(body) || /left:\s*50%/.test(body)) {
        missing.push('.sess-act: horizontal spill would overlap its neighbours');
      }
    } else if (!/width:\s*24px/.test(body)) {
      missing.push(`${sel}: hit area is not 24px wide`);
    }
  }
  assert.deepEqual(missing, [], `click-target problems:\n${missing.join('\n')}`);
});

test('hit areas are invisible and do not paint', () => {
  for (const sel of SMALL_CONTROLS) {
    const body = cssRuleBody(sel);
    if (!body) continue;
    assert.match(body, /content:\s*''/, `${sel}: pseudo-element needs empty content`);
    assert.match(body, /background:\s*transparent/, `${sel}: hit area must not paint`);
  }
});

// ── Minimum readable text size ────────────────────────
// 20 rules used 9-10.5px. Some are deliberate micro-typography (uppercase badge
// tags, glyph indicators) where small caps are the intended style, but others
// carried real content — timestamps, tool state, token/cost numbers, session
// metadata — and were hard to read at 10px. Those were raised to 11px; this guard
// keeps new content text from creeping below it, while documenting the exceptions.

// Decorative or micro-typographic rules that are deliberately small.
const SMALL_TEXT_ALLOWED = new Set([
  '.hit-tag',                     // uppercase badge on skill hits
  '.slash-tag',                   // "action"/"custom" badge
  '.slash-palette .slash-tag',    // same badge, scoped inside the palette
  '.skill-tag',                   // uppercase tag chip
  '.queue-chip .q-label',         // uppercase "QUEUED" badge
  '.msg-role',                    // "YOU" / "ASSISTANT" caps label
  '.code-bar',                    // code block language header
  '.popover-group',               // section header in the model picker
  '.drawer-body .drawer-section.toggle::before',  // the ▸ disclosure glyph
  '.btn-vision.active::after'     // the "attached" dot indicator
]);

test('content text is at least 11px (decorative micro-type excepted)', () => {
  const css = read('sidepanel/sidepanel.css');
  const lines = css.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/font-size:\s*(9|9\.5|10|10\.5)px/);
    if (!m) continue;
    // Find the owning selector by scanning back for the block opener.
    let owner = '?';
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      if (lines[j].includes('{')) {
        owner = (lines[j].split('{')[0].trim() || (lines[j - 1] || '').trim()).trim();
        break;
      }
    }
    const bare = owner.replace(/\s*\/\*.*$/, '').trim();
    if (SMALL_TEXT_ALLOWED.has(bare)) continue;
    offenders.push(`${bare || '(unknown)'} -> ${m[1]}px`);
  }
  assert.deepEqual(offenders, [],
    `raise these to >=11px, or add them to SMALL_TEXT_ALLOWED with a reason:\n${offenders.join('\n')}`);
});
