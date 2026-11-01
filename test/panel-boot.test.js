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

  // A keyless panel cannot start a turn: it explains, opens Settings and
  // announces — so a screen-reader user is not silently teleported into a dialog.
  assert.match(status.textContent, /Cannot send|API key/i,
    `expected a failure announcement, got ${JSON.stringify(status.textContent)}`);
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
