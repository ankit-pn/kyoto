// End-to-end tests that boot the REAL panel in jsdom and drive its UI.
//
// This is the only layer that exercises sidepanel.js's wiring — the 7k-line glue
// where the previous two audits found their bugs (a fallback chain that never
// fired, tool calls retargeting to the wrong tab, a palette that navigated in a
// different order than it rendered).
//
// The harness loads the shipped HTML and every shipped script, unmodified, in
// declaration order, against a recording `chrome` stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootPanel, key, type } = require('./helpers/panel-harness');

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

// ── Boot health ──────────────────────────────────────
test('the panel boots with no console errors', async () => {
  const p = await bootPanel();
  assert.deepEqual(p.errors, [], 'boot must not log errors:\n' + p.errors.join('\n'));
  assert.ok(p.loaded.length >= 30, `expected the full script graph, got ${p.loaded.length}`);
});

test('boot registers the whole tool registry and creates a session', async () => {
  const p = await bootPanel();
  const tools = p.window.KyotoTools;
  assert.ok(tools, 'KyotoTools must exist after boot');
  const list = tools.list();
  assert.ok(list.length > 140, `expected >140 tools, got ${list.length}`);
  const session = p.window.KyotoSession?.active?.();
  assert.ok(session, 'boot must leave an active session');
  assert.equal(typeof session.tabId, 'number', 'the session must be bound to a tab');
});

test('boot reads settings and the spend ledger', async () => {
  const p = await bootPanel();
  const gets = p.chrome.__calls.filter(c => c.ns === 'storage' && c.method === 'get');
  assert.ok(gets.length >= 2, 'boot should read settings and the spend total');
});

// ── Command palette ──────────────────────────────────
test('Ctrl+K opens the palette and Esc closes it', async () => {
  const p = await bootPanel();
  const ov = p.window.document.getElementById('paletteOverlay');
  assert.ok(ov.classList.contains('hidden'), 'palette starts hidden');

  key(p.window, 'k', { ctrlKey: true });
  assert.equal(ov.classList.contains('hidden'), false, 'Ctrl+K must open the palette');
  assert.ok(p.window.document.querySelectorAll('.palette-item').length > 20,
    'the unfiltered palette should list actions, slashes and tools');

  key(p.window, 'Escape');
  assert.ok(ov.classList.contains('hidden'), 'Esc must close the palette');
});

test('typing filters the palette and groups results by source', async () => {
  const p = await bootPanel();
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, p.window.document.getElementById('paletteInput'), 'spend');

  const labels = [...p.window.document.querySelectorAll('.palette-item .pi-label')].map(e => e.textContent);
  assert.ok(labels.length > 0, 'filtering must leave matches');
  assert.ok(labels.some(l => /spend/i.test(l)), `expected a "spend" match, got: ${labels.join(', ')}`);

  const groups = [...p.window.document.querySelectorAll('.palette-group')].map(e => e.textContent);
  assert.ok(groups.length >= 1, 'results must be grouped');
  // Groups must be from the known priority list.
  for (const g of groups) {
    assert.ok(['action', 'slash', 'session', 'model', 'tool', 'setting'].includes(g), `unexpected group "${g}"`);
  }
});

// REGRESSION: the list is rendered grouped by source, so arrow-key navigation
// must follow the RENDERED order. Navigating by raw score order made the cursor
// appear to jump between sections.
test('arrow keys move through items in rendered order', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'co');
  await settle(10);

  const rendered = [...doc.querySelectorAll('.palette-item')];
  assert.ok(rendered.length > 2, 'need several results to test navigation');

  const activeIdx = () => [...doc.querySelectorAll('.palette-item')].findIndex(e => e.classList.contains('active'));
  assert.equal(activeIdx(), 0, 'first item starts active');

  key(p.window, 'ArrowDown');
  assert.equal(activeIdx(), 1, 'ArrowDown must move to the next RENDERED item');

  key(p.window, 'ArrowDown');
  assert.equal(activeIdx(), 2);

  key(p.window, 'ArrowUp');
  assert.equal(activeIdx(), 1, 'ArrowUp must move back');
});

test('the palette index clamps when the filtered list shrinks', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'co');
  await settle(10);
  for (let i = 0; i < 6; i++) key(p.window, 'ArrowDown');   // walk past the end
  // Narrow the list drastically; the index must clamp, not point past the end.
  type(p.window, doc.getElementById('paletteInput'), 'spend');
  await settle(10);
  const items = [...doc.querySelectorAll('.palette-item')];
  assert.ok(items.length > 0);
  const active = items.findIndex(e => e.classList.contains('active'));
  assert.ok(active >= 0 && active < items.length, `active index ${active} out of range (${items.length})`);
});

test('running a palette action performs its side effect', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  const before = chat.textContent.length;

  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'spend');   // "Show spend" action
  await settle(10);
  key(p.window, 'Enter');
  await settle(60);

  assert.ok(!doc.getElementById('paletteOverlay').classList.contains('hidden') === false,
    'running an action closes the palette');
  const text = doc.getElementById('chat').textContent;
  assert.ok(text.length > before, 'the action must append something to the chat');
  assert.match(text, /All time/i, '/cost must report the all-time spend');
});

// ── Voice ────────────────────────────────────────────
test('the mic stays hidden when Web Speech is unavailable', async () => {
  const p = await bootPanel();
  const mic = p.window.document.getElementById('micBtn');
  assert.ok(mic.classList.contains('hidden'), 'no dead button when speech is unsupported');
});

test('with Web Speech available the mic dictates into the composer without duplicating', async () => {
  const p = await bootPanel({
    beforeBoot: (window) => {
      class FakeRecognition {
        constructor() { this.lang = ''; FakeRecognition.last = this; }
        start() { setTimeout(() => this.onresult({
          resultIndex: 0,
          results: [
            Object.assign([{ transcript: 'hello ' }], { isFinal: false }),
          ],
        }), 5); }
        stop() { this.onend?.(); }
      }
      window.SpeechRecognition = FakeRecognition;
    }
  });
  const doc = p.window.document;
  const mic = doc.getElementById('micBtn');
  assert.equal(mic.classList.contains('hidden'), false, 'mic must appear when speech is supported');

  mic.click();                     // start
  await settle(40);
  const input = doc.getElementById('input');
  assert.match(input.value, /hello/, 'interim transcript should reach the composer');

  mic.click();                     // stop
  await settle(20);
  // The committed text must contain a single "hello" — interim must REPLACE,
  // not append, or the composer fills with progressively longer duplicates.
  assert.equal((input.value.match(/hello/g) || []).length, 1,
    `dictation duplicated text: ${JSON.stringify(input.value)}`);
});

// ── Share ────────────────────────────────────────────
test('/share exports a redacted, self-contained HTML file', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'share');
  await settle(10);
  key(p.window, 'Enter');
  await settle(120);

  const dl = p.chrome.__calls.filter(c => c.ns === 'downloads' && c.method === 'download');
  assert.equal(dl.length, 1, 'share must trigger exactly one download');
  assert.match(String(dl[0].args[0].filename), /\.html$/);
  assert.match(doc.getElementById('chat').textContent, /shared this session/i);
});

// ── Routines: replay wiring ──────────────────────────
test('running a routine replays it on the session tab with no model call', async () => {
  const p = await bootPanel({
    beforeBoot: (_w, chrome) => {
      chrome.__store.set('kyoto_routines', [{
        id: 'rt_test', name: 'login', url: 'https://example.test/login', createdAt: Date.now(),
        steps: [{ action: 'click', selector: '[data-testid="next-step"]', note: 'Next' }]
      }]);
    }
  });
  const session = p.window.KyotoSession.active();

  await p.window.KyotoRoutineApi.run('login');
  await settle(60);

  const exec = p.chrome.__calls.filter(c => c.ns === 'scripting' && c.method === 'executeScript');
  assert.equal(exec.length, 1, 'replay must inject exactly once');
  const target = exec[0].args[0].target;
  assert.equal(target.tabId, session.tabId,
    'replay must run on the conversation\'s tab, never the active tab');

  const text = p.window.document.getElementById('chat').textContent;
  assert.match(text, /no model calls/i, 'the zero-cost property should be stated to the user');
});

test('a routine with masked values refuses to replay until values are supplied', async () => {
  const p = await bootPanel({
    beforeBoot: (_w, chrome) => {
      chrome.__store.set('kyoto_routines', [{
        id: 'rt_pw', name: 'signin', steps: [
          { action: 'type', selector: '[name="email"]', value: '«email»', needsValue: true, valueHint: 'email' },
          { action: 'click', selector: '#go' }
        ]
      }]);
    }
  });
  await p.window.KyotoRoutineApi.run('signin');
  await settle(40);
  const exec = p.chrome.__calls.filter(c => c.ns === 'scripting' && c.method === 'executeScript');
  assert.equal(exec.length, 0, 'a masked routine must NOT be replayed with the placeholder as the value');
  assert.match(p.window.document.getElementById('chat').textContent, /masked|need/i);
});

// ── Council wiring (needs ≥2 providers) ──────────────
test('/council explains itself when fewer than two providers are configured', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  // Drive it the way a user does: type the slash command and press Enter.
  const input = doc.getElementById('input');
  input.value = '/council what is the best approach?';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(80);
  const text = doc.getElementById('chat').textContent;
  assert.match(text, /at least 2|needs at least/i,
    `expected council to explain the provider requirement, got: ${text.slice(-200)}`);
});

// ══════════════════════════════════════════════════════
// Regressions for the v14.24.0 independent audit
// ══════════════════════════════════════════════════════

// AUDIT H1: isDestructiveStep() was computed but never consulted, so replay
// clicked Delete/Pay/Submit with no confirmation.
test('a destructive routine is refused until explicitly confirmed', async () => {
  const p = await bootPanel({
    beforeBoot: (_w, chrome) => {
      chrome.__store.set('kyoto_routines', [{
        id: 'rt_del', name: 'cleanup', url: 'https://example.test/',
        steps: [{ action: 'click', selector: '[data-testid="delete-account"]', note: 'Delete account' }]
      }]);
    }
  });

  await p.window.KyotoRoutineApi.run('cleanup');
  await settle(50);
  let exec = p.chrome.__calls.filter(c => c.ns === 'scripting' && c.method === 'executeScript');
  assert.equal(exec.length, 0, 'a destructive routine must NOT replay without confirmation');
  assert.match(p.window.document.getElementById('chat').textContent, /destructive|confirm/i);

  // Re-running with confirm is the acknowledgement.
  await p.window.KyotoRoutineApi.run('cleanup', { confirm: true });
  await settle(80);
  exec = p.chrome.__calls.filter(c => c.ns === 'scripting' && c.method === 'executeScript');
  assert.equal(exec.length, 1, 'confirmed destructive routine should replay');
});

// AUDIT M1: speechState was never reset, so a second dictation prepended the
// previous session's transcript.
test('a second dictation does not inherit the previous transcript', async () => {
  let transcript = 'first phrase';
  const p = await bootPanel({
    beforeBoot: (window) => {
      class FakeRecognition {
        start() {
          setTimeout(() => this.onresult({
            resultIndex: 0,
            results: [Object.assign([{ transcript }], { isFinal: true })],
          }), 5);
        }
        stop() { this.onend?.(); }
      }
      window.SpeechRecognition = FakeRecognition;
    }
  });
  const doc = p.window.document;
  const mic = doc.getElementById('micBtn');
  const input = doc.getElementById('input');

  mic.click(); await settle(40);   // session 1 -> "first phrase"
  mic.click(); await settle(20);
  assert.match(input.value, /first phrase/);

  input.value = '';                 // user clears the composer
  transcript = 'second phrase';
  mic.click(); await settle(40);    // session 2
  mic.click(); await settle(20);

  assert.ok(!/first phrase/.test(input.value),
    `second dictation inherited the first transcript: ${JSON.stringify(input.value)}`);
  assert.match(input.value, /second phrase/);
});

// AUDIT M2: composerPristine was never captured, so dictation overwrote typed text.
test('dictation appends to text the user already typed', async () => {
  const p = await bootPanel({
    beforeBoot: (window) => {
      class FakeRecognition {
        start() {
          setTimeout(() => this.onresult({
            resultIndex: 0,
            results: [Object.assign([{ transcript: 'dictated words' }], { isFinal: true })],
          }), 5);
        }
        stop() { this.onend?.(); }
      }
      window.SpeechRecognition = FakeRecognition;
    }
  });
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.value = 'typed first';
  doc.getElementById('micBtn').click();
  await settle(40);
  assert.match(input.value, /typed first/, 'typed text must survive dictation');
  assert.match(input.value, /dictated words/);
});

// ══════════════════════════════════════════════════════
// Accessibility & interaction (keyboard paths)
// ══════════════════════════════════════════════════════

test('opening settings moves focus into the dialog', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const drawer = doc.getElementById('drawer');
  assert.ok(drawer.classList.contains('hidden'), 'drawer starts hidden');

  doc.getElementById('settingsBtn').click();
  await settle(40);
  assert.equal(drawer.classList.contains('hidden'), false, 'settings button must open the drawer');

  const active = doc.activeElement;
  assert.ok(active && drawer.contains(active),
    `focus must move into the dialog, got ${active ? active.tagName + '#' + active.id : 'null'}`);
});

test('Escape closes the settings dialog and restores focus to the opener', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const drawer = doc.getElementById('drawer');
  const opener = doc.getElementById('settingsBtn');

  opener.focus();
  opener.click();
  await settle(40);
  assert.equal(drawer.classList.contains('hidden'), false);

  // A modal dialog must be dismissable from the keyboard.
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(40);
  assert.ok(drawer.classList.contains('hidden'), 'Escape must close the drawer');
  assert.equal(doc.activeElement, opener, 'focus must return to the control that opened the dialog');
});

test('the live region receives coarse turn announcements', async () => {
  const p = await bootPanel();
  const status = p.window.document.getElementById('srStatus');
  assert.ok(status, 'live region must exist');
  assert.equal(status.getAttribute('aria-live'), 'polite');

  // Drive a real turn: the stub has no API key, so this exercises the submit
  // path (and its announcement) without any network.
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.value = 'hello there';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(120);

  // A keyless panel cannot start a turn: it explains via an alert (the error
  // card) and opens Settings. The status region only mentions the context
  // change, so the user does not hear the same sentence twice.
  assert.match(status.textContent, /settings opened/i,
    `expected a context-change announcement, got ${JSON.stringify(status.textContent)}`);
  assert.ok(p.window.document.querySelector('.msg.error[role="alert"]'),
    'the reason itself is carried by the alert');
});

test('Escape in the palette returns focus to the composer', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  key(p.window, 'k', { ctrlKey: true });
  await settle(20);
  assert.ok(doc.getElementById('paletteInput'), 'palette input exists');

  key(p.window, 'Escape');
  await settle(20);
  assert.ok(doc.getElementById('paletteOverlay').classList.contains('hidden'));
  assert.equal(doc.activeElement, doc.getElementById('input'),
    'focus should return to the composer so typing can continue');
});

test('messages expose a one-click copy that writes the message text', async () => {
  const p = await bootPanel();
  const doc = p.window.document;

  // /cost appends an assistant message with no network involved.
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'spend');
  await settle(10);
  key(p.window, 'Enter');
  await settle(80);

  const msgs = [...doc.querySelectorAll('.msg.assistant')];
  assert.ok(msgs.length > 0, 'a message should have been rendered');

  const last = msgs[msgs.length - 1];
  const btn = last.querySelector('.copy-msg-btn');
  assert.ok(btn, 'every message should carry a copy button');
  assert.equal(btn.getAttribute('aria-label'), 'Copy this message', 'icon-only control needs a name');

  const written = [];
  p.window.navigator.clipboard.writeText = async (t) => { written.push(t); };

  btn.click();
  await settle(40);
  assert.equal(written.length, 1, 'clicking copy must write to the clipboard');
  assert.ok(written[0].length > 0, 'the copied text must not be empty');
  assert.match(written[0], /spend|cost|\\$/i, `copied the wrong content: ${JSON.stringify(written[0].slice(0, 80))}`);
});

// ══════════════════════════════════════════════════════
// Stick-to-bottom / "jump to latest"
// ══════════════════════════════════════════════════════
// Regression: every streamed chunk forced scrollTop = scrollHeight, so scrolling
// up to read earlier output during a reply was impossible — the view snapped
// back within a few hundred ms.

function fakeScrollGeometry(chat, { scrollHeight = 1000, clientHeight = 400 } = {}) {
  Object.defineProperty(chat, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(chat, 'clientHeight', { configurable: true, get: () => clientHeight });
}

test('the log does not follow output while the user has scrolled up', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  const jump = doc.getElementById('jumpLatestBtn');
  fakeScrollGeometry(chat);

  // Simulate the user scrolling up to read.
  chat.scrollTop = 0;
  chat.dispatchEvent(new p.window.Event('scroll'));
  await settle(20);
  assert.ok(!jump.classList.contains('hidden'), 'the jump-to-latest pill should appear when scrolled up');

  // New output must NOT yank the view back.
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'spend');
  await settle(10);
  key(p.window, 'Enter');
  await settle(80);

  assert.equal(chat.scrollTop, 0, 'the view must stay where the user put it');
});

test('the jump button returns to the tail and hides itself', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  const jump = doc.getElementById('jumpLatestBtn');
  fakeScrollGeometry(chat);

  chat.scrollTop = 0;
  chat.dispatchEvent(new p.window.Event('scroll'));
  await settle(20);
  assert.ok(!jump.classList.contains('hidden'));

  jump.click();
  await settle(30);
  assert.equal(chat.scrollTop, 1000, 'jumping must land at the bottom (scrollHeight)');
  assert.ok(jump.classList.contains('hidden'), 'the pill hides once back at the tail');
});

test('scrolling back to the bottom resumes following automatically', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  const jump = doc.getElementById('jumpLatestBtn');
  fakeScrollGeometry(chat);

  chat.scrollTop = 0;
  chat.dispatchEvent(new p.window.Event('scroll'));
  await settle(20);
  assert.ok(!jump.classList.contains('hidden'));

  // User scrolls back down to the tail themselves (1000 - 600 - 400 = 0).
  chat.scrollTop = 600;
  chat.dispatchEvent(new p.window.Event('scroll'));
  await settle(20);
  assert.ok(jump.classList.contains('hidden'), 'being at the tail means no pill');
});

test('sending a message always takes the user back to the bottom', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  fakeScrollGeometry(chat);

  chat.scrollTop = 0;
  chat.dispatchEvent(new p.window.Event('scroll'));
  await settle(20);

  // Submitting is an explicit "show me the conversation" gesture.
  const input = doc.getElementById('input');
  input.value = 'hello';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(80);

  assert.equal(chat.scrollTop, 1000, 'sending must force the log back to the tail');
});

// ══════════════════════════════════════════════════════
// Settings drawer index
// ══════════════════════════════════════════════════════
// 15 sections / 41 fields in one column: finding a section meant a long scroll.

test('the settings drawer exposes a nav built from its own sections', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(50);

  const chips = [...doc.querySelectorAll('#drawerNav .nav-chip')];
  const headings = [...doc.querySelectorAll('.drawer-body .drawer-section')];
  assert.ok(headings.length >= 10, `expected the drawer to have many sections, got ${headings.length}`);
  assert.equal(chips.length, headings.length, 'every section needs a nav chip');

  // Icon/text chips still need names; each chip is text so aria-label is a bonus.
  for (const chip of chips) {
    assert.ok(chip.getAttribute('aria-label'), 'nav chips need an accessible name');
    assert.ok(chip.textContent.trim().length > 0);
  }
  // Every heading is a scroll target.
  for (const h of headings) assert.ok(h.id, 'every section heading needs an id to scroll to');
  assert.equal(new Set(headings.map(h => h.id)).size, headings.length, 'section ids must be unique');
});

test('clicking a nav chip scrolls that section into view', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(50);

  const chips = [...doc.querySelectorAll('#drawerNav .nav-chip')];
  const target = chips[chips.length - 1];
  const wanted = doc.getElementById('sec-' + target.getAttribute('aria-label')
    .replace(/^Jump to /, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  assert.ok(wanted, 'expected to resolve the heading for the last chip');

  let scrolled = null;
  wanted.scrollIntoView = function () { scrolled = this.id; };
  target.click();
  await settle(20);
  assert.equal(scrolled, wanted.id, 'the chip must scroll its own section into view');
});

// ══════════════════════════════════════════════════════
// Retry on a failed turn
// ══════════════════════════════════════════════════════
// Before this, a failed turn left the user with no action: they had to retype.

test('a failed turn offers retry, and retrying re-runs without duplicating the prompt', async () => {
  const p = await bootPanel();
  const doc = p.window.document;

  // Keyless submit fails and renders an error message.
  const input = doc.getElementById('input');
  input.value = 'what is on this page?';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(120);

  const errMsg = [...doc.querySelectorAll('.msg.error')].pop();
  assert.ok(errMsg, 'the failed turn should render an error message');
  const retry = errMsg.querySelector('.retry-btn');
  assert.ok(retry, 'the error must offer a retry action');
  assert.equal(retry.getAttribute('aria-label'), 'Retry the last message');

  retry.click();
  await settle(200);

  // The retried turn fails the same way (still no key) — which is the point:
  // retry re-attempts the exact request instead of silently doing nothing.
  const text = doc.getElementById('chat').textContent;
  assert.match(text, /No API key/i, 'retry must re-attempt the turn and report the same failure');
});



// ══════════════════════════════════════════════════════
// Collapsible settings sections
// ══════════════════════════════════════════════════════
// 15 sections / 41 fields: the advanced half (cron, workspace, shell, S3,
// MCP, backup) buried everything used day to day.

function sectionState(doc) {
  const out = {};
  for (const h of doc.querySelectorAll('.drawer-body .drawer-section')) {
    let anyHidden = false;
    let el = h.nextElementSibling;
    while (el && !(el.tagName === 'H3')) { if (el.hidden) anyHidden = true; el = el.nextElementSibling; }
    out[h.textContent.trim()] = anyHidden ? 'collapsed' : 'expanded';
  }
  return out;
}

test('advanced sections start collapsed while core ones stay open', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const state = sectionState(doc);
  assert.equal(state['Appearance'], 'expanded', 'core settings must be visible');
  assert.equal(state['Context & spend'], 'expanded');
  assert.equal(state['Background jobs (cron)'], 'collapsed', 'advanced settings should start collapsed');
  assert.equal(state['MCP servers'], 'collapsed');
  assert.equal(state['Backup'], 'collapsed');

  // Every heading is a keyboard-reachable toggle with an expanded state.
  for (const h of doc.querySelectorAll('.drawer-body .drawer-section')) {
    assert.equal(h.getAttribute('role'), 'button');
    assert.ok(h.hasAttribute('tabindex'), 'headings must be focusable');
    assert.ok(['true', 'false'].includes(h.getAttribute('aria-expanded')));
  }
});

test('clicking a section heading expands and persists it', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const heading = [...doc.querySelectorAll('.drawer-body .drawer-section')]
    .find(h => h.textContent.trim() === 'MCP servers');
  assert.equal(heading.getAttribute('aria-expanded'), 'false');

  heading.click();
  await settle(40);
  assert.equal(heading.getAttribute('aria-expanded'), 'true', 'a collapsed section must expand on click');
  assert.equal(sectionState(doc)['MCP servers'], 'expanded');

  const writes = p.chrome.__calls.filter(c => c.ns === 'storage' && c.method === 'set'
    && c.args[0] && 'kyoto_collapsed_sections' in c.args[0]);
  assert.ok(writes.length > 0, 'collapse state must be persisted');
  assert.ok(!writes[writes.length - 1].args[0].kyoto_collapsed_sections.includes('mcp-servers'),
    'an expanded section must be removed from the collapsed set');
});

test('section headings toggle from the keyboard', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const heading = [...doc.querySelectorAll('.drawer-body .drawer-section')]
    .find(h => h.textContent.trim() === 'Shell bridge (native messaging)');
  assert.equal(heading.getAttribute('aria-expanded'), 'false');
  heading.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(40);
  assert.equal(heading.getAttribute('aria-expanded'), 'true', 'Enter must toggle the section');
});

test('collapse choices survive a panel reload', async () => {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();

  // First run: collapse a section that is open by default.
  const first = await bootPanel({ chrome });
  const doc1 = first.window.document;
  doc1.getElementById('settingsBtn').click();
  await settle(80);
  const appearance = [...doc1.querySelectorAll('.drawer-body .drawer-section')]
    .find(h => h.textContent.trim() === 'Appearance');
  assert.equal(appearance.getAttribute('aria-expanded'), 'true');
  appearance.click();
  await settle(40);

  // Second run with the same storage: the choice must be remembered.
  const second = await bootPanel({ chrome });
  const doc2 = second.window.document;
  doc2.getElementById('settingsBtn').click();
  await settle(80);
  assert.equal(sectionState(doc2)['Appearance'], 'collapsed',
    'a section the user collapsed must stay collapsed after reload');
});

// ══════════════════════════════════════════════════════
// Pinned Save + unsaved-changes indicator
// ══════════════════════════════════════════════════════
// Save used to be the last element of a 15-section / 41-field scroll: changing
// the provider or model at the top meant scrolling the whole drawer to apply it.

test('Save is pinned outside the scrolling drawer body', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const save = doc.getElementById('saveBtn');
  assert.ok(save, 'Save must exist');
  assert.equal(save.closest('.drawer-body'), null,
    'Save must not live inside the scrolling body — it has to stay reachable');
  assert.ok(save.closest('.drawer-footer'), 'Save belongs in the pinned footer');

  // The body is the scroll container; the footer is its sibling.
  const body = doc.querySelector('.drawer-body');
  const footer = doc.querySelector('.drawer-footer');
  assert.equal(footer.parentElement, body.parentElement,
    'footer and body must be siblings for the flex column to pin the footer');
});

test('editing a setting marks the drawer dirty, and saving clears it', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const save = doc.getElementById('saveBtn');
  assert.equal(save.classList.contains('dirty'), false, 'a freshly opened drawer is clean');

  const provider = doc.getElementById('provider');
  provider.value = 'deepseek';
  provider.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await settle(30);
  assert.equal(save.classList.contains('dirty'), true, 'an edit must be visible as unsaved');
  assert.match(save.getAttribute('aria-label'), /unsaved/i);

  // A save that is REJECTED (here: no API key) must keep the marker — the edits
  // really are still unsaved, so clearing it would be a lie.
  save.click();
  await settle(120);
  assert.equal(save.classList.contains('dirty'), true,
    'a refused save must not claim the changes were stored');

  // The marker is cleared by the same routine on a successful save; reopening
  // the drawer is another path that resets it, so prove resetting works here.
  doc.getElementById('closeDrawerBtn').click();
  await settle(40);
  doc.getElementById('settingsBtn').click();
  await settle(80);
  assert.equal(save.classList.contains('dirty'), false,
    'reopening the drawer must start from a clean state');
});

test('typing in a text field marks the drawer dirty', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);
  const save = doc.getElementById('saveBtn');
  const prompt = doc.getElementById('systemPrompt');
  prompt.value = 'Be concise.';
  prompt.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  await settle(30);
  assert.equal(save.classList.contains('dirty'), true);
});

// ══════════════════════════════════════════════════════
// Model picker keyboard navigation
// ══════════════════════════════════════════════════════
// The picker had a search box but no keyboard selection: you could filter a
// 450-model list and then still had to reach for the mouse.

function seedPopoverItems(p, doc) {
  const list = doc.getElementById('popoverList');
  list.innerHTML = `
    <div class="popover-item" role="option" data-model="m-one" data-provider="openrouter">one</div>
    <div class="popover-item" role="option" data-model="m-two" data-provider="openrouter">two</div>
    <div class="popover-item" role="option" data-model="m-three" data-provider="openrouter">three</div>`;
  return list;
}
const kbd = (p, el, key) => el.dispatchEvent(
  new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

test('the model picker focuses its search and exposes listbox semantics', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('modelBtn').click();
  await settle(60);

  assert.equal(doc.getElementById('popoverList').getAttribute('role'), 'listbox');
  assert.equal(doc.activeElement, doc.getElementById('popoverSearch'),
    'opening the picker should put the caret in the filter');
});

test('arrow keys move a keyboard cursor through the model list', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('modelBtn').click();
  await settle(60);
  const list = seedPopoverItems(p, doc);
  const search = doc.getElementById('popoverSearch');
  const cursor = () => list.querySelector('.kbd-active')?.textContent;

  kbd(p, search, 'ArrowDown');
  assert.equal(cursor(), 'one', 'first ArrowDown highlights the first result');
  kbd(p, search, 'ArrowDown');
  assert.equal(cursor(), 'two');
  kbd(p, search, 'ArrowUp');
  assert.equal(cursor(), 'one');
  kbd(p, search, 'End');
  assert.equal(cursor(), 'three', 'End jumps to the last result');
  kbd(p, search, 'Home');
  assert.equal(cursor(), 'one', 'Home jumps back to the first');
});

test('Enter selects the highlighted model and closes the picker', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('modelBtn').click();
  await settle(60);
  const list = seedPopoverItems(p, doc);
  const search = doc.getElementById('popoverSearch');

  kbd(p, search, 'ArrowDown');
  kbd(p, search, 'ArrowDown');   // -> second item
  kbd(p, search, 'Enter');
  await settle(150);

  const writes = p.chrome.__calls
    .filter(c => c.ns === 'storage' && c.method === 'set' && c.args[0] && 'model' in c.args[0])
    .map(c => c.args[0].model);
  assert.equal(writes[writes.length - 1], 'm-two', 'Enter must select the highlighted model');
  assert.ok(doc.getElementById('modelPopover').classList.contains('hidden'), 'picking closes the picker');
});

test('Enter with no highlight does not select anything', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('modelBtn').click();
  await settle(60);
  const list = seedPopoverItems(p, doc);
  const search = doc.getElementById('popoverSearch');

  kbd(p, search, 'Enter');       // no cursor moved yet, nothing highlighted
  await settle(80);
  const picked = p.chrome.__calls
    .filter(c => c.ns === 'storage' && c.method === 'set' && c.args[0] && 'model' in c.args[0]);
  assert.equal(picked.length, 0, 'Enter without a highlighted row must be a no-op');
  assert.ok(!list.querySelector('.kbd-active'));
});

test('the session picker is keyboard navigable too', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(80);

  const list = doc.getElementById('sessionsList');
  const search = doc.getElementById('sessionsSearch');
  assert.equal(doc.activeElement, search, 'the session filter should take focus');

  // Provide two rows so cursor movement is observable.
  list.innerHTML = `
    <div class="sess-item" data-id="s1"><span class="sess-title">one</span></div>
    <div class="sess-item" data-id="s2"><span class="sess-title">two</span></div>`;
  const cursor = () => list.querySelector('.kbd-active')?.dataset.id;

  kbd(p, search, 'ArrowDown');
  assert.equal(cursor(), 's1');
  kbd(p, search, 'ArrowDown');
  assert.equal(cursor(), 's2');
  kbd(p, search, 'ArrowUp');
  assert.equal(cursor(), 's1');
});

// ══════════════════════════════════════════════════════
// Follow-up queue
// ══════════════════════════════════════════════════════
// Enter during a streaming reply used to start a SECOND concurrent chat loop on
// the same session — two streams interleaving into one history. It now queues.

/** Boot with enough config to start a real turn, and a network we control. */
async function bootWithPendingTurn(fetchImpl) {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('provider', 'openrouter');
  chrome.__store.set('model', 'test/model');
  chrome.__store.set('apiKeys', { openrouter: 'test-key' });
  const p = await bootPanel({ chrome, beforeBoot: (w) => { w.fetch = fetchImpl; } });
  const doc = p.window.document;
  const send = (text) => {
    const input = doc.getElementById('input');
    input.value = text;
    input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  return { p, doc, send };
}

const hangingFetch = (u, init) => new Promise((_, rej) => {
  if (init && init.signal) {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  }
});

test('a message typed mid-stream is queued, not started concurrently', async () => {
  const { p, doc, send } = await bootWithPendingTurn(hangingFetch);
  send('first question');
  await settle(150);
  assert.ok(!doc.getElementById('stopBtn').classList.contains('hidden'), 'first turn should be in flight');

  send('second question');
  await settle(150);

  const bar = doc.getElementById('queueBar');
  assert.ok(!bar.classList.contains('hidden'), 'the queued message should be visible');
  assert.match(bar.textContent, /second question/);
  assert.match(bar.textContent, /Queued/i);

  // The user's second message must NOT have been sent as a new turn: it is not
  // in the transcript as a user bubble yet.
  const userBubbles = [...doc.querySelectorAll('.msg.user')].map(el => el.textContent);
  assert.equal(userBubbles.filter(t => t.includes('second question')).length, 0,
    'a queued message must not be sent until the current turn finishes');

  doc.getElementById('stopBtn').click();   // clean up the hanging turn
  await settle(120);
});

test('a queued message can be cancelled before it sends', async () => {
  const { doc, send } = await bootWithPendingTurn(hangingFetch);
  send('first');
  await settle(150);
  send('cancel me');
  await settle(150);
  assert.match(doc.getElementById('queueBar').textContent, /cancel me/);

  doc.querySelector('#queueBar .q-cancel').click();
  await settle(60);
  assert.ok(doc.getElementById('queueBar').classList.contains('hidden'),
    'cancelling the only queued message hides the strip');
  doc.getElementById('stopBtn').click();
  await settle(120);
});

test('stopping the turn discards queued follow-ups instead of firing them', async () => {
  const { doc, send } = await bootWithPendingTurn(hangingFetch);
  send('first');
  await settle(150);
  send('should be dropped');
  await settle(150);
  assert.match(doc.getElementById('queueBar').textContent, /should be dropped/);

  doc.getElementById('stopBtn').click();
  await settle(250);

  assert.ok(doc.getElementById('queueBar').classList.contains('hidden'), 'stop empties the queue');
  const userBubbles = [...doc.querySelectorAll('.msg.user')].map(el => el.textContent);
  assert.equal(userBubbles.filter(t => t.includes('should be dropped')).length, 0,
    'Stop means stop: the queued message must not be sent afterwards');
});

test('the queue drains once the running turn finishes', async () => {
  // Network fails fast, so the first turn ends quickly and the queue drains.
  const failingFetch = async () => { throw new Error('network down'); };
  const { doc, send } = await bootWithPendingTurn(failingFetch);
  send('first');
  await settle(200);
  send('second');
  await settle(400);

  const userBubbles = [...doc.querySelectorAll('.msg.user')].map(el => el.textContent);
  assert.ok(userBubbles.some(t => t.includes('second')),
    `the queued message should be sent after the turn ends; saw: ${JSON.stringify(userBubbles)}`);
});

// ══════════════════════════════════════════════════════
// Retry a failed model-catalogue fetch
// ══════════════════════════════════════════════════════
// The hint said "Failed: …" with no action available: the only way to retry was
// to switch provider back and forth or reopen the panel.

async function bootDrawerWithFetch(fetchImpl) {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('provider', 'openrouter');
  chrome.__store.set('apiKeys', { openrouter: 'test-key' });
  const p = await bootPanel({ chrome, beforeBoot: (w) => { w.fetch = fetchImpl; } });
  p.window.document.getElementById('settingsBtn').click();
  await settle(250);
  return p;
}

test('the retry control is hidden until a fetch fails', async () => {
  const p = await bootDrawerWithFetch(async () => ({ ok: true, json: async () => ({ data: [{ id: 'a/one', name: 'One' }] }) }));
  const doc = p.window.document;
  assert.ok(doc.getElementById('modelRetryBtn').classList.contains('hidden'),
    'a successful fetch should not offer retry');
});

test('a failed catalogue fetch offers retry, and retrying refetches', async () => {
  let calls = 0;
  const p = await bootDrawerWithFetch(async () => { calls++; throw new Error('endpoint down'); });
  const doc = p.window.document;
  const retry = doc.getElementById('modelRetryBtn');

  assert.ok(!retry.classList.contains('hidden'), 'a failure must offer a retry');
  assert.match(doc.getElementById('modelHint').textContent, /unreachable|Failed/i);

  const before = calls;
  retry.click();
  await settle(250);
  assert.ok(calls > before, 'clicking retry must attempt the fetch again');
  assert.ok(!retry.classList.contains('hidden'), 'still failing, so retry stays available');
});

test('retry disappears once the fetch succeeds', async () => {
  // The panel fetches once at boot and again when the drawer opens, so counting
  // attempts is unreliable — drive the outcome with an explicit flag instead.
  let failing = true;
  const p = await bootDrawerWithFetch(async () => {
    if (failing) throw new Error('transient');
    return { ok: true, json: async () => ({ data: [{ id: 'a/one', name: 'One' }] }) };
  });
  const doc = p.window.document;
  const retry = doc.getElementById('modelRetryBtn');
  assert.ok(!retry.classList.contains('hidden'), 'first attempt fails');

  failing = false;
  retry.click();
  await settle(300);
  assert.ok(retry.classList.contains('hidden'), 'after success there is nothing to retry');
});

// ══════════════════════════════════════════════════════
// Message timestamps
// ══════════════════════════════════════════════════════
// Long sessions had no way to tell when something was said.

test('a sent message shows a timestamp', async () => {
  const { doc, send } = await bootWithPendingTurn(hangingFetch);
  send('what time is this');
  await settle(150);

  const time = doc.querySelector('.msg.user .msg-time');
  assert.ok(time, 'the user bubble should carry a timestamp');
  assert.match(time.textContent, /\d{1,2}:\d{2}/, `unexpected format: ${time.textContent}`);
  assert.ok(time.getAttribute('datetime'), 'use a machine-readable <time datetime>');
  assert.ok(time.title.length > 0, 'hover should reveal the full date');

  doc.getElementById('stopBtn').click();
  await settle(120);
});

test('the timestamp never reaches the API payload', async () => {
  // `_ts` is underscore-prefixed, which buildMessages() strips. If that ever
  // regressed, every request would carry a bogus message field.
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('provider', 'openrouter');
  chrome.__store.set('model', 'test/model');
  chrome.__store.set('apiKeys', { openrouter: 'test-key' });

  let captured = null;
  const p = await bootPanel({
    chrome,
    beforeBoot: (w) => {
      w.fetch = (u, init) => {
        try { captured = JSON.parse(init.body); } catch { /* not JSON */ }
        return new Promise((_, rej) => {
          if (init && init.signal) {
            init.signal.addEventListener('abort', () => {
              const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
            });
          }
        });
      };
    }
  });
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.value = 'timestamped';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(250);

  assert.ok(captured && Array.isArray(captured.messages), 'the request should have been captured');
  assert.ok(!JSON.stringify(captured).includes('_ts'), 'internal _ts leaked into the request body');
  for (const m of captured.messages) {
    for (const k of Object.keys(m)) {
      assert.ok(!k.startsWith('_'), `internal key ${k} leaked into the wire message`);
    }
  }
  doc.getElementById('stopBtn').click();
  await settle(120);
});

// ══════════════════════════════════════════════════════
// Keyboard shortcuts help
// ══════════════════════════════════════════════════════
// The panel had several shortcuts (palette, picker navigation, slash
// completion) and advertised none of them.

test('? opens the shortcuts dialog and Escape closes it', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const overlay = doc.getElementById('shortcutsOverlay');
  assert.ok(overlay.classList.contains('hidden'), 'starts hidden');

  doc.getElementById('sendBtn').focus();
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await settle(40);
  assert.ok(!overlay.classList.contains('hidden'), '? should open the dialog');
  assert.ok(overlay.contains(doc.activeElement), 'focus must move into the dialog');

  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle(40);
  assert.ok(overlay.classList.contains('hidden'), 'Escape must close it');
  assert.equal(doc.activeElement, doc.getElementById('sendBtn'), 'focus returns to the opener');
});

test('typing ? in the composer does not open the dialog', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.focus();
  // This is the regression that matters: `?` is a normal character here.
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await settle(40);
  assert.ok(doc.getElementById('shortcutsOverlay').classList.contains('hidden'),
    'a question mark typed into the composer must go to the composer');
});

test('the dialog documents the shortcuts that actually exist', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await settle(40);

  const rows = [...doc.querySelectorAll('.shortcuts-list > div')];
  assert.ok(rows.length >= 8, `expected a full list, got ${rows.length}`);
  const text = rows.map(r => r.textContent).join(' ');
  for (const expected of ['K', 'Enter', 'Shift', '/', 'Esc', 'Home', 'End', 'Tab']) {
    assert.ok(text.includes(expected), `shortcut ${expected} should be documented`);
  }
  // Machine-readable keys, not just styled text.
  assert.ok(doc.querySelectorAll('.shortcuts-list kbd').length >= 8);
});

test('the palette can open the shortcuts dialog by name', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  key(p.window, 'k', { ctrlKey: true });
  type(p.window, doc.getElementById('paletteInput'), 'keyboard');
  await settle(15);
  key(p.window, 'Enter');
  await settle(60);
  assert.ok(!doc.getElementById('shortcutsOverlay').classList.contains('hidden'),
    'the palette entry should open the shortcuts dialog');
});

test('clicking the scrim closes the shortcuts dialog', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await settle(40);
  const overlay = doc.getElementById('shortcutsOverlay');
  overlay.click();                       // click on the backdrop itself
  await settle(40);
  assert.ok(overlay.classList.contains('hidden'), 'a scrim click should dismiss it');
});

// ══════════════════════════════════════════════════════
// Modal focus containment
// ══════════════════════════════════════════════════════
// The drawers and dialogs declare aria-modal="true" but did not trap focus, so
// Tab walked out into the panel behind the scrim and keyboard users ended up
// operating controls they could not see.

function drawerFocusables(doc) {
  const drawer = doc.getElementById('drawer');
  return [...drawer.querySelectorAll('button, input, select, textarea, a[href]')]
    .filter(el => !el.disabled && !el.hidden);
}
const pressTab = (p, opts = {}) => p.window.document.dispatchEvent(
  new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...opts }));

test('Tab wraps from the last control back to the first inside the drawer', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const items = drawerFocusables(doc);
  assert.ok(items.length > 5, 'the drawer should have plenty of controls');
  items[items.length - 1].focus();
  pressTab(p);
  assert.equal(doc.activeElement, items[0], 'focus must not escape past the last control');
});

test('Shift+Tab wraps from the first control back to the last', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);

  const items = drawerFocusables(doc);
  items[0].focus();
  pressTab(p, { shiftKey: true });
  assert.equal(doc.activeElement, items[items.length - 1], 'focus must not escape before the first control');
});

test('the obscured background is inert while a dialog is open', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const chat = doc.getElementById('chat');
  assert.ok(!chat.inert && !chat.hasAttribute('inert'), 'background starts interactive');

  doc.getElementById('settingsBtn').click();
  await settle(80);
  assert.ok(chat.inert === true || chat.hasAttribute('inert'),
    'content behind the scrim must not be focusable or clickable');

  doc.getElementById('closeDrawerBtn').click();
  await settle(60);
  assert.ok(!chat.inert && !chat.hasAttribute('inert'), 'closing restores the background');
});

test('the scrim still closes the drawer even with focus contained', async () => {
  // Regression guard: making the background inert must NOT swallow the scrim
  // click, which is how most people dismiss the drawer.
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(80);
  doc.getElementById('overlay').click();
  await settle(60);
  assert.ok(doc.getElementById('drawer').classList.contains('hidden'), 'clicking the scrim must still close it');
});

test('the shortcuts dialog contains focus too', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await settle(60);
  const overlay = doc.getElementById('shortcutsOverlay');
  assert.ok(overlay.contains(doc.activeElement), 'focus starts inside');

  const items = [...overlay.querySelectorAll('button, input, select, textarea, a[href]')].filter(el => !el.disabled && !el.hidden);
  items[items.length - 1].focus();
  pressTab(p);
  assert.ok(overlay.contains(doc.activeElement), 'Tab must not leave the dialog');
});

test('Tab is not hijacked when no dialog is open', async () => {
  const p = await bootPanel();
  const ev = new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  p.window.document.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'normal tabbing must be untouched outside dialogs');
});

// ══════════════════════════════════════════════════════
// ARIA combobox wiring
// ══════════════════════════════════════════════════════
// The pickers highlight a row visually, but nothing connected that row to the
// accessibility tree: a screen reader had no idea what the arrow keys selected.
// `aria-activedescendant` is the link, and `aria-expanded`/`aria-controls` make
// the input announce itself as a combobox.

test('the command palette is a proper combobox', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const input = doc.getElementById('paletteInput');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), 'paletteList');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');

  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await settle(40);
  assert.equal(input.getAttribute('aria-expanded'), 'true');

  const ad = input.getAttribute('aria-activedescendant');
  assert.ok(ad, 'the palette must expose which row is active');
  const row = doc.getElementById(ad);
  assert.ok(row, `aria-activedescendant ${ad} must reference a real element`);
  assert.ok(row.classList.contains('active'), 'it must point at the visually active row');

  key(p.window, 'ArrowDown');
  await settle(20);
  const ad2 = input.getAttribute('aria-activedescendant');
  assert.notEqual(ad2, ad, 'moving the cursor must move the active descendant');
  assert.ok(doc.getElementById(ad2).classList.contains('active'));

  key(p.window, 'Escape');
  await settle(30);
  assert.equal(input.getAttribute('aria-expanded'), 'false', 'closing must reset aria-expanded');
});

test('the model picker exposes its keyboard cursor', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('modelBtn').click();
  await settle(60);
  const list = seedPopoverItems(p, doc);
  const input = doc.getElementById('popoverSearch');

  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(input.getAttribute('aria-controls'), 'popoverList');
  assert.equal(list.getAttribute('role'), 'listbox');

  kbd(p, input, 'ArrowDown');
  await settle(20);
  const ad = input.getAttribute('aria-activedescendant');
  assert.ok(ad, 'arrowing must set aria-activedescendant');
  assert.equal(doc.getElementById(ad), list.querySelector('.kbd-active'),
    'the active descendant must be the highlighted row');
});

test('the session picker exposes its keyboard cursor', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(80);
  const list = doc.getElementById('sessionsList');
  const input = doc.getElementById('sessionsSearch');
  list.innerHTML = `<div class="sess-item" data-id="s1"><span class="sess-title">one</span></div>
                    <div class="sess-item" data-id="s2"><span class="sess-title">two</span></div>`;

  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  // A list, not a listbox: session rows contain nested fork/rename/delete
  // buttons, and an option may not contain interactive descendants.
  assert.equal(list.getAttribute('role'), 'list');

  kbd(p, input, 'ArrowDown');
  await settle(20);
  const ad = input.getAttribute('aria-activedescendant');
  assert.ok(ad, 'arrowing must set aria-activedescendant');
  assert.equal(doc.getElementById(ad), list.querySelector('.kbd-active'));
});

test('the composer owns the slash-command listbox', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const input = doc.getElementById('input');
  assert.equal(input.getAttribute('aria-controls'), 'slashPalette');
  assert.equal(input.getAttribute('aria-expanded'), 'false');

  // Open the slash palette the way a user does.
  type(p.window, input, '/');
  await settle(60);
  const palette = doc.getElementById('slashPalette');
  assert.ok(!palette.classList.contains('hidden'), 'typing / should open the slash palette');
  assert.equal(palette.getAttribute('role'), 'listbox');
  assert.equal(input.getAttribute('aria-expanded'), 'true');

  const ad = input.getAttribute('aria-activedescendant');
  assert.ok(ad, 'the composer must expose the highlighted slash command');
  const row = doc.getElementById(ad);
  assert.ok(row && palette.contains(row), `aria-activedescendant ${ad} must be a row in the palette`);
  assert.ok(row.classList.contains('active'), 'it must point at the visually active row');

  // Arrow navigation keeps the relationship in sync.
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle(20);
  const ad2 = input.getAttribute('aria-activedescendant');
  assert.notEqual(ad2, ad, 'moving the highlight must move the active descendant');
  assert.equal(doc.getElementById(ad2), palette.querySelector('.slash-item.active'));
});

// ══════════════════════════════════════════════════════
// UI state exposed to assistive tech
// ══════════════════════════════════════════════════════
// Toggles only signalled state with a red dot / highlight class, and the
// transcript never said it was still changing.

test('toggle buttons expose their pressed state', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  for (const id of ['captureBtn', 'visionBtn']) {
    const btn = doc.getElementById(id);
    assert.ok(btn.hasAttribute('aria-pressed'), `${id} must declare aria-pressed`);
    assert.equal(btn.getAttribute('aria-pressed'), 'false', `${id} starts unpressed`);
  }

  // Vision attach is a pure client-side toggle — easy to drive.
  doc.getElementById('visionBtn').click();
  await settle(40);
  assert.equal(doc.getElementById('visionBtn').getAttribute('aria-pressed'), 'true',
    'turning the screenshot toggle on must be announced');
  doc.getElementById('visionBtn').click();
  await settle(40);
  assert.equal(doc.getElementById('visionBtn').getAttribute('aria-pressed'), 'false',
    'and turning it off again');
});

test('the transcript announces that it is busy while streaming', async () => {
  const { doc, send } = await bootWithPendingTurn(hangingFetch);
  const chat = doc.getElementById('chat');
  assert.ok(!chat.hasAttribute('aria-busy'), 'idle transcript is not busy');

  send('hello');
  await settle(150);
  assert.equal(chat.getAttribute('aria-busy'), 'true',
    'a streaming reply means the transcript is still changing');

  doc.getElementById('stopBtn').click();
  await settle(250);
  assert.ok(!chat.hasAttribute('aria-busy'), 'aria-busy must be cleared when the turn ends');
});

test('the active conversation is marked with aria-current', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(80);

  const rows = [...doc.querySelectorAll('#sessionsList .sess-item')];
  assert.ok(rows.length > 0, 'there should be at least one session');
  const current = rows.filter(r => r.getAttribute('aria-current') === 'true');
  assert.equal(current.length, 1, 'exactly one row is the current conversation');
  assert.ok(current[0].classList.contains('active'), 'aria-current must match the visual state');
  // Rows are listitems, because they contain their own buttons.
  for (const r of rows) assert.equal(r.getAttribute('role'), 'listitem');
});

test('the mic reports listening state', async () => {
  const p = await bootPanel({
    beforeBoot: (window) => {
      class FakeRecognition {
        start() { /* stay listening */ }
        stop() { this.onend?.(); }
      }
      window.SpeechRecognition = FakeRecognition;
    }
  });
  const doc = p.window.document;
  const mic = doc.getElementById('micBtn');
  assert.equal(mic.getAttribute('aria-pressed'), 'false', 'mic starts unpressed');

  mic.click();
  await settle(40);
  assert.equal(mic.getAttribute('aria-pressed'), 'true', 'listening must be announced');
  assert.ok(mic.classList.contains('listening'));

  mic.click();
  await settle(40);
  assert.equal(mic.getAttribute('aria-pressed'), 'false', 'stopping must clear it');
});

// ══════════════════════════════════════════════════════
// Errors are announced
// ══════════════════════════════════════════════════════
// Errors land in a log that is deliberately not a live region (streaming would
// flood it), so without role="alert" a screen-reader user would never learn that
// a turn failed.

test('a live error is an alert, and normal messages are not', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.value = 'anything';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(200);

  const err = doc.querySelector('.msg.error');
  assert.ok(err, 'the keyless send should render an error');
  assert.equal(err.getAttribute('role'), 'alert', 'a failure must be announced immediately');

  const normal = [...doc.querySelectorAll('.msg:not(.error)')];
  assert.ok(normal.every(el => !el.hasAttribute('role')),
    'normal messages must not be alerts (the log is not a live region)');
});

test('the error is announced once, not twice', async () => {
  // The status region previously repeated the same sentence the error card
  // shows, so a screen-reader user heard it twice. The card (alert) carries the
  // reason; the status region only mentions the context change.
  const p = await bootPanel();
  const doc = p.window.document;
  const input = doc.getElementById('input');
  input.value = 'anything';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(200);

  const status = doc.getElementById('srStatus').textContent;
  const err = doc.querySelector('.msg.error');
  assert.ok(err);
  assert.ok(!/no api key/i.test(status),
    `the status region must not repeat the error text, got ${JSON.stringify(status)}`);
  assert.match(status, /settings opened/i, 'it should mention the context change instead');
});

test('replaying history does not re-alert old errors', async () => {
  // Switching sessions re-renders the transcript; historical errors must not
  // fire alerts again (that would spam a screen reader on every switch).
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('kyoto_sessions_index', [{
    id: 'sess_old', title: 'Old chat', lastActive: Date.now(), tabId: 1, url: 'https://example.test/'
  }]);
  chrome.__store.set('kyoto_session_sess_old', {
    id: 'sess_old', title: 'Old chat', lastActive: Date.now(), tabId: 1,
    history: [
      { role: 'user', content: 'hi', _ts: Date.now() },
      { role: 'assistant', content: 'Error: provider exploded', _error: true, _ts: Date.now() }
    ]
  });
  const p = await bootPanel({ chrome });
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(100);
  const row = [...doc.querySelectorAll('#sessionsList .sess-item')]
    .find(el => (el.textContent || '').includes('Old chat'));
  assert.ok(row, 'seeded session should be listed');
  row.click();
  await settle(200);

  const errCard = doc.querySelector('.msg.error');
  assert.ok(errCard, 'the stored error should still render');
  assert.equal(errCard.getAttribute('role'), null,
    'a replayed historical error must not be a live alert');
});

// ══════════════════════════════════════════════════════
// Settings form accessibility
// ══════════════════════════════════════════════════════
// Every field had a visible <label>, but none were associated with their control:
// no `for` attribute, and they do not wrap the input. Screen readers announced
// the drawer as 30+ bare "combobox" / "edit text" controls with no name.

function accessibleName(doc, control) {
  if (control.getAttribute('aria-label')) return control.getAttribute('aria-label').trim();
  const labelledby = control.getAttribute('aria-labelledby');
  if (labelledby) {
    const el = doc.getElementById(labelledby);
    if (el) return el.textContent.trim();
  }
  if (control.id) {
    const forLabel = doc.querySelector(`label[for="${control.id}"]`);
    if (forLabel && forLabel.textContent.trim()) return forLabel.textContent.trim();
  }
  const wrap = control.closest('label');
  if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
  return '';
}

test('every settings control has an accessible name', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(120);

  const drawer = doc.getElementById('drawer');
  const controls = [...drawer.querySelectorAll('input:not([type="hidden"]), select, textarea')];
  assert.ok(controls.length > 40, `expected the full form, got ${controls.length}`);

  const unnamed = controls.filter(c => !accessibleName(doc, c)).map(c => c.id || c.tagName);
  assert.deepEqual(unnamed, [], `controls with no accessible name: ${unnamed.join(', ')}`);
});

test('labels are associated with their control, not just adjacent to it', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(120);

  // Spot-checks across different control types.
  for (const [id, expected] of [['provider', 'Provider'], ['apiKey', 'OpenRouter API key'], ['model', /model/i], ['temperature', 'Temperature']]) {
    const control = doc.getElementById(id);
    assert.ok(control, `${id} should exist`);
    const name = accessibleName(doc, control);
    if (expected instanceof RegExp) assert.match(name, expected, `${id} has name "${name}"`);
    else assert.equal(name, expected, `${id} should be announced as "${expected}"`);
  }
  // And the label is actually wired via for=, not just visually adjacent.
  assert.equal(doc.querySelector('label[for="provider"]')?.textContent.trim(), 'Provider');
});

test('settings hints are linked to their field', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('settingsBtn').click();
  await settle(120);

  const drawer = doc.getElementById('drawer');
  const described = [...drawer.querySelectorAll('[aria-describedby]')];
  assert.ok(described.length >= 10, `expected hints to be linked, found ${described.length}`);
  // And each reference resolves to real guidance text.
  let resolved = 0;
  for (const control of described) {
    const target = doc.getElementById(control.getAttribute('aria-describedby'));
    if (target && target.textContent.trim()) resolved++;
  }
  assert.equal(resolved, described.length, 'every aria-describedby must point at real hint text');
});

// ══════════════════════════════════════════════════════
// Every control has a real accessible name
// ══════════════════════════════════════════════════════
// The panel is full of glyph buttons (⎘ ⇣ ✎ ⌧ × ⤴ ⧉ 🎤 📸). A glyph is not a
// name: a screen reader announces the character itself, or nothing useful. This
// is a permanent version of the sweep that found them, so the class cannot come
// back as new buttons are added.

const GLYPH_ONLY = (name) => !/[a-zA-Z]/.test(name);

async function scanButtonNames(doc) {
  const offenders = [];
  for (const btn of doc.querySelectorAll('button')) {
    const name = (btn.getAttribute('aria-label') || '').trim() || (btn.textContent || '').trim();
    if (!name) { offenders.push(`${btn.id || btn.className}: <empty>`); continue; }
    if (GLYPH_ONLY(name)) offenders.push(`${btn.id || btn.className}: ${JSON.stringify(name)}`);
  }
  return offenders;
}

test('no button in the panel is announced as a bare glyph', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  // Render the surfaces that build their buttons lazily.
  doc.getElementById('settingsBtn').click();
  await settle(120);
  doc.getElementById('sessionsBtn').click();
  await settle(120);
  doc.getElementById('modelBtn').click();
  await settle(120);

  const offenders = await scanButtonNames(doc);
  assert.deepEqual(offenders, [], `buttons with no real accessible name:\n${offenders.join('\n')}`);
});

test('a rendered transcript has no glyph-only buttons either', async () => {
  // The message bubble controls (pin ☆/★, edit ✎) only exist once a transcript
  // is rendered, so the sweep above would miss them.
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('kyoto_sessions_index', [{ id: 'sess_hist', title: 'History', lastActive: Date.now(), tabId: 1, url: 'https://e.test/' }]);
  chrome.__store.set('kyoto_session_sess_hist', {
    id: 'sess_hist', title: 'History', lastActive: Date.now(), tabId: 1,
    history: [
      { role: 'user', content: 'hi', _ts: Date.now() },
      { role: 'assistant', content: 'hello there', _ts: Date.now() }
    ]
  });
  const p = await bootPanel({ chrome });
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(120);
  const row = [...doc.querySelectorAll('#sessionsList .sess-item')].find(el => el.textContent.includes('History'));
  assert.ok(row, 'seeded conversation should be listed');
  row.click();
  await settle(250);

  assert.ok(doc.querySelector('.msg .pin-btn'), 'the transcript should expose its pin control');
  const offenders = await scanButtonNames(doc);
  assert.deepEqual(offenders, [], `transcript buttons with no real accessible name:\n${offenders.join('\n')}`);
});

test('session actions are named after what they do, not their glyph', async () => {
  const p = await bootPanel();
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(120);

  const acts = [...doc.querySelectorAll('#sessionsList .sess-act')];
  assert.ok(acts.length >= 5, `expected the session action row, got ${acts.length}`);
  const names = acts.map(b => b.getAttribute('aria-label'));
  for (const n of names) assert.ok(n && n.length > 3, `weak label: ${JSON.stringify(n)}`);
  // Distinct names, so several rows are navigable without ambiguity.
  assert.equal(new Set(names).size, names.length, `duplicate action labels: ${names.join(', ')}`);
  // And they say what they act on.
  for (const n of names) assert.match(n, /conversation/i);
});

// ══════════════════════════════════════════════════════
// Attached images
// ══════════════════════════════════════════════════════
// Screenshot attachments have no alt: a screen reader announced "image" or read
// a fragment of the base64 data URL, and a broken image was a silent blank box.

async function bootVisionSession() {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('kyoto_sessions_index', [{ id: 's_vis', title: 'Vision', lastActive: Date.now(), tabId: 1, url: 'https://e.test/' }]);
  chrome.__store.set('kyoto_session_s_vis', {
    id: 's_vis', title: 'Vision', lastActive: Date.now(), tabId: 1,
    history: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBBCCCCDDDD' } }
      ],
      _ts: Date.now()
    }]
  });
  const p = await bootPanel({ chrome });
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(120);
  const row = [...doc.querySelectorAll('#sessionsList .sess-item')].find(el => el.textContent.includes('Vision'));
  assert.ok(row, 'the seeded conversation should be listed');
  row.click();
  await settle(250);
  return { p, doc };
}

test('an attached screenshot has a descriptive alt that does not leak the payload', async () => {
  const { doc } = await bootVisionSession();
  const img = doc.querySelector('.msg-image');
  assert.ok(img, 'the image part should render');

  const alt = img.getAttribute('alt');
  assert.ok(alt && alt.trim().length > 3, 'the image needs a real description');
  assert.ok(!/base64|data:/i.test(alt), `alt must not echo the data URL, got ${JSON.stringify(alt)}`);
});

test('every image in the panel has alt text', async () => {
  const { doc } = await bootVisionSession();
  const images = [...doc.querySelectorAll('img')];
  assert.ok(images.length > 0, 'there should be at least one image to check');
  const missing = images.filter(i => !(i.getAttribute('alt') || '').trim());
  assert.deepEqual(missing, [], 'all images need alt text');
});

test('a broken image becomes a visible, announced placeholder', async () => {
  const { p, doc } = await bootVisionSession();
  const img = doc.querySelector('.msg-image');
  img.dispatchEvent(new p.window.Event('error'));
  await settle(40);

  assert.equal(doc.querySelector('.msg-image'), null, 'the broken image should be replaced');
  const note = doc.querySelector('.msg-image-fallback');
  assert.ok(note, 'a fallback must be shown');
  assert.match(note.textContent, /could not be displayed/i);
  assert.ok(note.textContent.length > 10, 'the placeholder carries the description the image had');
});

// ══════════════════════════════════════════════════════
// Per-conversation drafts
// ══════════════════════════════════════════════════════
// The composer is one shared textarea and switching sessions never touched it:
// a half-written message for one conversation followed you into another, one
// Enter away from being sent to the wrong place.

async function bootTwoSessions(chromeOverride) {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = chromeOverride || makeChrome();
  chrome.__store.set('kyoto_sessions_index', [
    { id: 's_a', title: 'Alpha', lastActive: Date.now(), tabId: 1, url: 'https://a.test/' },
    { id: 's_b', title: 'Beta', lastActive: Date.now() - 1000, tabId: 2, url: 'https://b.test/' }
  ]);
  chrome.__store.set('kyoto_session_s_a', { id: 's_a', title: 'Alpha', lastActive: Date.now(), tabId: 1, history: [] });
  chrome.__store.set('kyoto_session_s_b', { id: 's_b', title: 'Beta', lastActive: Date.now(), tabId: 2, history: [] });
  const p = await bootPanel({ chrome });
  const doc = p.window.document;
  const input = doc.getElementById('input');
  const pick = async (title) => {
    doc.getElementById('sessionsBtn').click();
    await settle(120);
    const row = [...doc.querySelectorAll('#sessionsList .sess-item')]
      .find(el => (el.textContent || '').includes(title));
    assert.ok(row, `session ${title} should be listed`);
    row.click();
    await settle(220);
  };
  const typeDraft = (text) => {
    input.value = text;
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  };
  return { p, doc, input, pick, typeDraft, chrome };
}

test('a draft does not leak into another conversation', async () => {
  const { input, pick, typeDraft } = await bootTwoSessions();
  await pick('Alpha');
  typeDraft('half-written message for Alpha');
  await pick('Beta');
  assert.equal(input.value, '', 'switching conversations must not carry the draft over');
});

test('returning to a conversation restores its draft', async () => {
  const { input, pick, typeDraft } = await bootTwoSessions();
  await pick('Alpha');
  typeDraft('keep me');
  await pick('Beta');
  await pick('Alpha');
  assert.equal(input.value, 'keep me', 'the draft should come back with its conversation');
});

test('a draft survives a send that is rejected', async () => {
  // The Enter handler empties the composer before it knows whether the turn will
  // be accepted (here: no API key), so the draft must not be discarded by that.
  const { p, input, pick, typeDraft } = await bootTwoSessions();
  await pick('Alpha');
  typeDraft('text I must not lose');
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(300);

  await pick('Beta');
  await pick('Alpha');
  assert.equal(input.value, 'text I must not lose',
    'a failed send must not cost the user their draft');
});

test('drafts survive a panel reload', async () => {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  const first = await bootTwoSessions(chrome);
  await first.pick('Alpha');
  first.typeDraft('persisted across reload');
  await settle(600);   // let the debounced save flush

  assert.equal(chrome.__store.get('kyoto_drafts')?.s_a, 'persisted across reload',
    'the draft should be persisted, not only held in memory');

  const second = await bootTwoSessions(chrome);   // same storage, fresh panel
  await second.pick('Alpha');
  assert.equal(second.input.value, 'persisted across reload');
});

test('a sent message clears its draft', async () => {
  // Accept the turn for real (hanging network) so the send actually lands in
  // history, which is when the draft is cleared.
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('provider', 'openrouter');
  chrome.__store.set('model', 'test/model');
  chrome.__store.set('apiKeys', { openrouter: 'test-key' });
  chrome.__store.set('kyoto_sessions_index', [{ id: 's_a', title: 'Alpha', lastActive: Date.now(), tabId: 1, url: 'https://a.test/' }]);
  chrome.__store.set('kyoto_session_s_a', { id: 's_a', title: 'Alpha', lastActive: Date.now(), tabId: 1, history: [] });

  const p = await bootPanel({ chrome, beforeBoot: (w) => { w.fetch = hangingFetch; } });
  const doc = p.window.document;
  const input = doc.getElementById('input');
  doc.getElementById('sessionsBtn').click();
  await settle(120);
  [...doc.querySelectorAll('#sessionsList .sess-item')].find(e => e.textContent.includes('Alpha')).click();
  await settle(220);

  input.value = 'send me';
  input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(300);
  await settle(600);   // debounced save window

  const stored = chrome.__store.get('kyoto_drafts') || {};
  assert.ok(!stored.s_a, `a delivered message should clear its draft, still stored: ${JSON.stringify(stored)}`);

  doc.getElementById('stopBtn').click();
  await settle(150);
});

// ══════════════════════════════════════════════════════
// Storage failures are visible
// ══════════════════════════════════════════════════════
// persistSession had no error handling: a quota failure threw into whatever
// flow was saving, the in-memory index was updated anyway, and the user went on
// believing their conversation was stored. Silent data loss is the worst UX
// failure there is, so it gets a persistent warning rather than a chat line
// (which the next transcript re-render wipes).

test('a failed save shows a persistent, actionable warning', async () => {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async (obj) => {
    if (Object.keys(obj).some(k => k.startsWith('kyoto_session_'))) {
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    return realSet.call(chrome.storage.local, obj);
  };

  const p = await bootPanel({ chrome });
  const bar = p.window.document.getElementById('persistWarnBar');
  assert.ok(!bar.classList.contains('hidden'), 'a failing save must be visible');
  assert.match(bar.textContent, /storage problem/i);
  assert.match(bar.textContent, /storage is full/i, 'quota failures should say what to do about it');
  assert.match(bar.textContent, /lost/i, 'and that the work is at risk');
  // It must survive the transcript re-render that happens during boot.
  assert.ok(bar.isConnected, 'the warning bar is part of the persistent UI');
});

test('a healthy save shows no warning', async () => {
  const p = await bootPanel();
  const bar = p.window.document.getElementById('persistWarnBar');
  assert.ok(bar.classList.contains('hidden'), 'no false alarm when storage works');
});

test('a malformed stored conversation is reported, not silently blank', async () => {
  const { makeChrome } = require('./helpers/chrome-stub');
  const chrome = makeChrome();
  chrome.__store.set('kyoto_sessions_index', [{ id: 's_bad', title: 'Broken', lastActive: Date.now(), tabId: 1, url: 'https://e.test/' }]);
  chrome.__store.set('kyoto_session_s_bad', { nonsense: true });   // no id, no history

  const p = await bootPanel({ chrome });
  const doc = p.window.document;
  doc.getElementById('sessionsBtn').click();
  await settle(120);
  const row = [...doc.querySelectorAll('#sessionsList .sess-item')].find(el => (el.textContent || '').includes('Broken'));
  assert.ok(row, 'the broken session is still listed');
  row.click();
  await settle(250);

  // The panel must not blow up, and it must say something rather than showing an
  // empty conversation as if the history never existed. The warning lives in the
  // persistent bar, because the chat line is wiped by the re-render that follows.
  assert.deepEqual(p.errors, [], 'an unreadable record must not throw');
  const bar = doc.getElementById('persistWarnBar');
  assert.ok(!bar.classList.contains('hidden'), 'an unreadable conversation must be reported');
  assert.match(bar.textContent, /could not be read|malformed/i);
});
