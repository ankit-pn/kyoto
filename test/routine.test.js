// Tests for sidepanel/routine.js — the pure planning half of "routines".
//
// What is under test is the part that must never be wrong twice: if
// `bestSelector` picks a generated id, or `toSteps` silently drops a step, the
// replay acts on a real page in a way the user did not record — and nothing
// throws, so the failure is invisible until something was deleted or submitted.
//
// The module is loaded exactly like the other pure sidepanel helpers
// (see test/context.test.js): same-realm VM so shared prototypes work, and
// array results are compared via .join(',') so a future switch to
// vm.createContext() cannot break the assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'routine.js'), 'utf-8');

function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/routine.js' });
    return globalThis.KyotoRoutine;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const R = load();
const eq = assert.equal;

// ═════════════════════════════════════════════════════
// bestSelector — preference order and stability
// ═════════════════════════════════════════════════════

test('selector preference: data-testid wins over everything', () => {
  eq(R.bestSelector({
    testId: 'login-button',
    ariaLabel: 'Log in',
    name: 'commit',
    id: 'submit-btn',
    selector: 'form > button.primary'
  }), '[data-testid="login-button"]');
});

test('selector preference: aria-label beats name/id/path', () => {
  eq(R.bestSelector({
    ariaLabel: 'Close dialog',
    name: 'commit',
    id: 'close',
    selector: 'div > button'
  }), '[aria-label="Close dialog"]');
});

test('selector preference: name beats id/path', () => {
  eq(R.bestSelector({
    name: 'email',
    id: 'email-field',
    selector: 'input.email'
  }), '[name="email"]');
});

test('selector preference: a stable id is used when no attribute selector exists', () => {
  eq(R.bestSelector({ id: 'login-form', selector: 'form#login-form' }), '#login-form');
});

test('selector preference: the recorded CSS path is the last resort', () => {
  eq(R.bestSelector({ selector: 'form#checkout > button.primary' }), 'form#checkout > button.primary');
});

// ── generated-id rejection ────────────────────────────
// These ids look precise but are re-created (differently) on every page load,
// so a routine recorded against them would replay onto the wrong element.
test('generated ids are rejected (uuid, counters, react/ember, hex, indices)', () => {
  const ids = [
    '3f2a9c1b-4d5e-6f70-8a9b-0c1d2e3f4a5b', // uuid
    'el-1699999999999',                       // long numeric run
    'react-aria-1',                           // react generated
    'ember123',                               // ember generated
    'aBcDeF1234567890abcdef',                 // long hex blob
    'item-42',                                // index suffix
    'tab2',                                   // index-like suffix
    'row_12',                                 // index suffix with underscore
    ':r1:',                                   // React 18 useId
  ];
  for (const id of ids) {
    eq(R.bestSelector({ id }), null, `id ${id} must not become a selector`);
  }
});

test('a generated id does not block a better structured selector', () => {
  eq(R.bestSelector({ id: 'react-aria-7', testId: 'save' }), '[data-testid="save"]');
});

test('stable ids still work and are not over-rejected', () => {
  for (const id of ['login-form', 'checkout', 'main_content', 'nav-primary']) {
    eq(R.bestSelector({ id }), `#${id}`, `id ${id} should be accepted`);
  }
  // Library names must be matched as a TOKEN: an author id that merely
  // contains the letters (reaction-panel) is still a perfectly good anchor.
  eq(R.bestSelector({ id: 'reaction-panel' }), '#reaction-panel');
});

test('a stable #id inside a path is not confused with the class/pseudo that follows', () => {
  eq(R.bestSelector({ selector: 'div#a.b' }), 'div#a.b');
  eq(R.bestSelector({ selector: 'a#main:hover' }), 'a#main:hover');
});

// ── positional-path rejection ────────────────────────
test('deep nth-child/nth-of-type chains are rejected', () => {
  // 5 elements deep — beyond the chain limit.
  eq(R.bestSelector({
    selector: 'div:nth-child(1) > div:nth-child(2) > div:nth-child(3) > section > button:nth-child(2)'
  }), null);
  // More than one positional anchor is a chain of guesses, even when shallow.
  eq(R.bestSelector({ selector: 'form > div:nth-of-type(2) > input:nth-of-type(1)' }), null);
});

test('a single shallow positional anchor is accepted', () => {
  eq(R.bestSelector({ selector: 'form > input:nth-of-type(2)' }), 'form > input:nth-of-type(2)');
});

test('> * (unknown tag) chains are rejected', () => {
  eq(R.bestSelector({ selector: 'div > * > span' }), null);
  eq(R.bestSelector({ selector: '*' }), null);
});

test('a generated id inside a recorded path poisons the whole path', () => {
  eq(R.bestSelector({ selector: 'form > #react-aria-3' }), null);
  eq(R.bestSelector({ selector: 'form > #checkout-panel' }), 'form > #checkout-panel');
});

test('the recorder\'s "window" placeholder is not a selector', () => {
  eq(R.bestSelector({ selector: 'window' }), null);
});

// ── nothing reliable ─────────────────────────────────
test('returns null when nothing reliable is available (never invents a text selector)', () => {
  eq(R.bestSelector({ text: 'Delete account' }), null);
  eq(R.bestSelector({ label: 'Log in' }), null);
  eq(R.bestSelector({}), null);
  eq(R.bestSelector(null), null);
  eq(R.bestSelector(undefined), null);
  eq(R.bestSelector('button'), null);
  eq(R.bestSelector({ selector: '' }), null);
});

// ── attribute escaping ───────────────────────────────
test('attribute values are escaped (quotes, backslashes, newlines)', () => {
  // A testId containing a double quote must not produce broken CSS.
  eq(R.bestSelector({ testId: 'say "hi"' }), '[data-testid="say \\"hi\\""]');
  eq(R.bestSelector({ testId: 'a\\b' }), '[data-testid="a\\\\b"]');
  eq(R.bestSelector({ ariaLabel: 'line\nbreak' }), '[aria-label="line\\a break"]');
});

test('absurdly long attribute values fall through instead of emitting a giant selector', () => {
  const long = 'x'.repeat(300);
  eq(R.bestSelector({ testId: long, id: 'fallback' }), '#fallback');
});

// ═════════════════════════════════════════════════════
// normaliseEvent — recorder payload → step
// ═════════════════════════════════════════════════════

test('normaliseEvent maps the real recorder payloads (event discriminator)', () => {
  eq(R.normaliseEvent({ event: 'click', selector: '[data-testid="go"]', text: 'Go' }).action, 'click');
  const typed = R.normaliseEvent({ event: 'fill', selector: '[name="email"]', inputType: 'email', value: 'a@b.c' });
  eq(typed.action, 'type');
  eq(typed.value, 'a@b.c');
  eq(typed.selector, '[name="email"]');
  const nav = R.normaliseEvent({ event: 'nav', selector: 'window', url: 'https://example.test/a' });
  eq(nav.action, 'navigate');
  eq(nav.url, 'https://example.test/a');
});

test('normaliseEvent accepts kind as a legacy alias', () => {
  eq(R.normaliseEvent({ kind: 'click', selector: '#go' }).action, 'click');
});

test('normaliseEvent: fill into a select becomes a select step', () => {
  const s = R.normaliseEvent({ event: 'fill', selector: '#country', inputType: 'select-one', value: 'US' });
  eq(s.action, 'select');
  eq(s.value, 'US');
});

test('normaliseEvent: submit becomes press Enter on the form selector', () => {
  const s = R.normaliseEvent({ event: 'submit', selector: 'form#login', tag: 'FORM' });
  eq(s.action, 'press');
  eq(s.key, 'Enter');
  eq(s.selector, 'form#login');
});

test('normaliseEvent: key Enter is kept, Escape/Tab are dropped', () => {
  const enter = R.normaliseEvent({ event: 'key', key: 'Enter', selector: 'input[name="q"]' });
  eq(enter.action, 'press');
  eq(enter.key, 'Enter');
  eq(R.normaliseEvent({ event: 'key', key: 'Escape', selector: '#dialog' }), null);
  eq(R.normaliseEvent({ event: 'key', key: 'Tab', selector: '#field' }), null);
});

test('normaliseEvent returns null for unusable events', () => {
  // unknown / missing discriminator
  eq(R.normaliseEvent({ event: 'scroll', selector: '#x' }), null);
  eq(R.normaliseEvent({ selector: '#x' }), null);
  eq(R.normaliseEvent({}), null);
  eq(R.normaliseEvent(null), null);
  eq(R.normaliseEvent(undefined), null);
  eq(R.normaliseEvent('click'), null);
  // click without a usable selector
  eq(R.normaliseEvent({ event: 'click', text: 'Submit' }), null);
  // type without a selector, or without a value
  eq(R.normaliseEvent({ event: 'fill', value: 'x' }), null);
  eq(R.normaliseEvent({ event: 'fill', selector: '[name="q"]', value: '   ' }), null);
  eq(R.normaliseEvent({ event: 'fill', selector: '[name="q"]' }), null);
  // navigate without a url, or with one that could never be replayed safely
  eq(R.normaliseEvent({ event: 'nav', selector: 'window' }), null);
  eq(R.normaliseEvent({ event: 'nav', url: 'not-a-url' }), null);
  eq(R.normaliseEvent({ event: 'nav', url: 'javascript:alert(1)' }), null);
  eq(R.normaliseEvent({ event: 'nav', url: 'data:text/html,<h1>x' }), null);
});

// The recorder→plan pipeline must ALWAYS be plannable: whatever toSteps emits
// has to pass validateSteps, otherwise a captured routine would fail at the
// last moment with an error the user cannot fix (the raw events are gone).
test('anything toSteps emits is a valid, plannable routine', () => {
  const pick = (arr, i) => arr[i % arr.length];
  const sels = ['#login', '#react-1', 'form#checkout > button', '[data-testid="go"]',
    '[name="email"]', 'div > * > span', 'window', '', 'div:nth-child(1) > b'];
  const vals = ['a@b.c', '«password»', '', '   ', 'x', '«card»'];
  const keys = ['Enter', 'Escape', 'Tab', 'a'];
  const urls = ['https://x.test/', '', 'not-a-url', 'javascript:alert(1)', 'file:///etc/passwd'];
  let produced = 0;
  for (let i = 0; i < 60; i++) {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push({
        event: pick(['click', 'fill', 'submit', 'key', 'nav', 'bogus'], i + j),
        selector: pick(sels, i * 3 + j),
        value: pick(vals, i + j * 2),
        key: pick(keys, i + j),
        inputType: pick(['text', 'select-one', 'checkbox'], i + j),
        tag: pick(['INPUT', 'SELECT', 'FORM'], i + j),
        text: pick(['Delete', 'Go', ''], i + j),
        url: pick(urls, i + j)
      });
    }
    const steps = R.toSteps(events);
    if (!steps.length) continue;
    produced++;
    eq(R.validateSteps(steps).ok, true, `toSteps produced an invalid routine: ${JSON.stringify(steps)}`);
    R.buildReplayPlan(steps); // must not throw
    R.describeRoutine(steps); // must not throw
  }
  assert.ok(produced > 20, 'the matrix should have produced routines to check');
});

// ── masked values (hard constraint) ──────────────────
// The recorder masks secrets before they reach the panel; replaying a mask as
// real input would type the literal «password» into the field.
test('masked values set needsValue and keep the placeholder', () => {
  const s = R.normaliseEvent({ event: 'fill', selector: '[name="password"]', inputType: 'password', value: '«password»' });
  eq(s.action, 'type');
  eq(s.needsValue, true);
  eq(s.valueHint, 'password');
  eq(s.value, '«password»', 'the placeholder stays so the routine still describes itself');

  const email = R.normaliseEvent({ event: 'fill', selector: '[name="email"]', value: '«email»' });
  eq(email.needsValue, true);
  eq(email.valueHint, 'email');

  const select = R.normaliseEvent({ event: 'fill', selector: '#otp-channel', inputType: 'select-one', value: '«otp»' });
  eq(select.action, 'select');
  eq(select.needsValue, true);
  eq(select.valueHint, 'otp');
});

test('an unmasked value never sets needsValue', () => {
  const s = R.normaliseEvent({ event: 'fill', selector: '#q', value: 'hello' });
  eq(s.needsValue, undefined);
  eq(s.valueHint, undefined);
});

test('checkbox/radio fills become clicks (a value cannot be typed into them)', () => {
  const s = R.normaliseEvent({ event: 'fill', selector: '#agree', inputType: 'checkbox', value: 'on' });
  eq(s.action, 'click');
});

test('click steps keep the element text as an advisory note', () => {
  const s = R.normaliseEvent({ event: 'click', selector: '[data-testid="x"]', text: '  Delete   account ' });
  eq(s.note, 'Delete account');
  // …and it is capped so a container's whole text does not bloat the routine.
  const big = R.normaliseEvent({ event: 'click', selector: '#x', text: 'y'.repeat(500) });
  eq(big.note.length, 80);
});

// ═════════════════════════════════════════════════════
// toSteps — coalescing, waits, order
// ═════════════════════════════════════════════════════

const fillEv = (ts, value, selector = '[name="email"]') =>
  ({ event: 'fill', selector, inputType: 'email', value, ts });
const clickEv = (ts, selector = '#go', text = 'Go') =>
  ({ event: 'click', selector, text, ts });

test('char-by-char typing coalesces into ONE step with the last value', () => {
  const steps = R.toSteps([fillEv(0, 'a'), fillEv(50, 'ab'), fillEv(100, 'abc'), fillEv(150, 'abcd')]);
  eq(steps.length, 1);
  eq(steps[0].action, 'type');
  eq(steps[0].value, 'abcd');
});

test('typing into different fields does not coalesce across selectors', () => {
  const steps = R.toSteps([fillEv(0, 'a', '#a'), fillEv(50, 'b', '#b')]);
  eq(steps.length, 2);
  eq(steps.map(s => s.selector).join(','), '#a,#b');
  eq(steps.map(s => s.value).join(','), 'a,b');
});

test('a click between two type runs on the same selector keeps them separate', () => {
  const steps = R.toSteps([
    fillEv(0, 'first'),
    clickEv(100),
    fillEv(200, 'second')
  ]);
  eq(steps.map(s => s.action).join(','), 'type,click,type');
  eq(steps[0].value, 'first');
  eq(steps[2].value, 'second');
});

test('duplicate clicks on the same selector within idleGapMs collapse', () => {
  const steps = R.toSteps([clickEv(1000), clickEv(1200)]);
  eq(steps.length, 1);
});

test('clicks on the same selector beyond idleGapMs are kept (and paced)', () => {
  const steps = R.toSteps([clickEv(1000), clickEv(4000)]);
  eq(steps.length, 2);
  eq(steps[1].waitMs, 3000);
});

test('clicks on different selectors never collapse', () => {
  const steps = R.toSteps([clickEv(1000, '#a'), clickEv(1050, '#b')]);
  eq(steps.length, 2);
});

test('waitMs is inserted for gaps over idleGapMs and capped at 5000', () => {
  const steps = R.toSteps([clickEv(0, '#a'), clickEv(2000, '#b'), clickEv(100000, '#c')]);
  eq(steps[1].waitMs, 2000);
  eq(steps[2].waitMs, 5000, 'a 97s gap must be capped, not replayed verbatim');
});

test('no waitMs for gaps within idleGapMs', () => {
  const steps = R.toSteps([clickEv(0, '#a'), clickEv(300, '#b')]);
  eq(steps[1].waitMs, undefined);
});

test('idleGapMs is configurable', () => {
  const within = R.toSteps([clickEv(1000), clickEv(1500)], { idleGapMs: 800 });
  eq(within.length, 1);
  const outside = R.toSteps([clickEv(1000), clickEv(1500)], { idleGapMs: 100 });
  eq(outside.length, 2);
  eq(outside[1].waitMs, 500);
});

test('toSteps preserves order and drops unusable events', () => {
  const steps = R.toSteps([
    { event: 'click', selector: '#a', ts: 0 },
    { event: 'click', text: 'no selector', ts: 50 },   // dropped
    { event: 'scroll', selector: '#x', ts: 60 },       // dropped
    { event: 'fill', selector: '#b', value: 'v', ts: 100 },
    { event: 'nav', url: 'https://x.test/', ts: 200 },
    { event: 'scroll', ts: 210 },                      // dropped
    { event: 'click', selector: '#c', ts: 300 }
  ]);
  eq(steps.map(s => s.action).join(','), 'click,type,navigate,click');
  eq(steps.map(s => s.selector || s.url).join(' > '), '#a > #b > https://x.test/ > #c');
});

test('toSteps tolerates garbage input', () => {
  eq(R.toSteps(null).join(','), '');
  eq(R.toSteps(undefined).join(','), '');
  eq(R.toSteps([]).join(','), '');
  eq(R.toSteps(['nope', 42, null]).join(','), '');
});

test('missing timestamps keep both clicks (dropping a real click is worse)', () => {
  const steps = R.toSteps([{ event: 'click', selector: '#a' }, { event: 'click', selector: '#a' }]);
  eq(steps.length, 2);
  eq(steps[1].waitMs, undefined);
});

test('a masked typing run still ends up as one needsValue step', () => {
  const steps = R.toSteps([
    { event: 'fill', selector: '#pw', inputType: 'password', value: '«password»', ts: 0 },
    { event: 'fill', selector: '#pw', inputType: 'password', value: '«password»', ts: 80 }
  ]);
  eq(steps.length, 1);
  eq(steps[0].needsValue, true);
  eq(steps[0].valueHint, 'password');
});

// ═════════════════════════════════════════════════════
// isDestructiveStep
// ═════════════════════════════════════════════════════

test('destructive clicks are flagged', () => {
  const cases = [
    { action: 'click', selector: '[data-testid="delete-account"]' },
    { action: 'click', selector: '#btn', note: 'Delete account' },
    { action: 'click', selector: 'button[type="submit"]' },
    { action: 'click', selector: '#x', note: 'Pay now' },
    { action: 'click', selector: '#x', note: 'Publish' },
    { action: 'click', selector: '#x', note: 'Send message' },
    { action: 'click', selector: '#x', note: 'Cancel account' },
    { action: 'click', selector: '#x', note: 'Unsubscribe' },
  ];
  for (const step of cases) eq(R.isDestructiveStep(step), true, JSON.stringify(step));
});

test('ordinary clicks are not flagged', () => {
  const cases = [
    { action: 'click', selector: '[data-testid="next"]' },
    { action: 'click', selector: '#save-draft', note: 'Save draft' },
    { action: 'click', selector: '#x', note: 'Cancel' },          // only "cancel account" matches
    { action: 'click', selector: '#x', note: 'Add to cart' },
    { action: 'navigate', url: 'https://example.test/delete' },   // navigate is never flagged
    { action: 'type', selector: '#q', value: 'delete me' },       // typing is never flagged
  ];
  for (const step of cases) eq(R.isDestructiveStep(step), false, JSON.stringify(step));
});

test('press Enter is destructive on a form-ish target only', () => {
  eq(R.isDestructiveStep({ action: 'press', key: 'Enter', selector: 'form#login' }), true);
  eq(R.isDestructiveStep({ action: 'press', key: 'Enter', selector: 'button[type="submit"]' }), true);
  eq(R.isDestructiveStep({ action: 'press', key: 'Enter', selector: 'input[name="search"]' }), false);
  eq(R.isDestructiveStep({ action: 'press', key: 'Enter' }), false);
  eq(R.isDestructiveStep({ action: 'press', key: 'Tab', selector: 'form' }), false);
});

test('isDestructiveStep tolerates garbage', () => {
  eq(R.isDestructiveStep(null), false);
  eq(R.isDestructiveStep(undefined), false);
  eq(R.isDestructiveStep('click delete'), false);
});

// ═════════════════════════════════════════════════════
// validateSteps
// ═════════════════════════════════════════════════════

test('validateSteps rejects an empty routine', () => {
  const v = R.validateSteps([]);
  eq(v.ok, false);
  eq(v.errors.join(','), 'routine has no steps');
});

test('validateSteps accepts a good routine', () => {
  const v = R.validateSteps([
    { action: 'navigate', url: 'https://example.test/' },
    { action: 'click', selector: '[data-testid="go"]' },
    { action: 'type', selector: '[name="email"]', value: 'a@b.c' },
    { action: 'select', selector: '#country', value: 'US' },
    { action: 'press', key: 'Enter', selector: 'form' }
  ]);
  eq(v.ok, true);
  eq(v.errors.join(','), '');
});

test('validateSteps collects EVERY error, each naming its step', () => {
  const v = R.validateSteps([
    { action: 'click' },                                              // 1: no selector
    { action: 'bogus', selector: '#x' },                              // 2: unknown action
    { action: 'navigate', url: 'javascript:alert(1)' },               // 3: bad protocol
    { action: 'type', selector: '#q' },                               // 4: no value
    'not-an-object',                                                 // 5: not an object
    { action: 'press' },                                              // 6: no key
    { action: 'select', selector: '#c', value: 'V', waitMs: -5 }      // 7: negative wait
  ]);
  eq(v.ok, false);
  eq(v.errors.length, 7, `expected one error per bad step, got: ${v.errors.join(' | ')}`);
  const joined = v.errors.join(' | ');
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(joined.includes(`step ${n}:`), `error for step ${n} missing: ${joined}`);
  }
  assert.ok(/unknown action "bogus"/.test(joined));
  assert.ok(/must be http\(s\)/.test(joined));
  assert.ok(/requires a value/.test(joined));
  assert.ok(/requires a key/.test(joined));
  assert.ok(/waitMs must be a non-negative number/.test(joined));
});

test('validateSteps: a masked step is valid without a real value', () => {
  const masked = { action: 'type', selector: '[name="password"]', value: '«password»', needsValue: true, valueHint: 'password' };
  eq(R.validateSteps([masked]).ok, true);
  // Even if the placeholder itself was stripped, needsValue is authoritative.
  const stripped = { action: 'type', selector: '#pw', needsValue: true };
  eq(R.validateSteps([stripped]).ok, true);
});

test('validateSteps: an empty non-masked value is still an error', () => {
  for (const step of [
    { action: 'type', selector: '#q', value: '' },
    { action: 'type', selector: '#q' },
    { action: 'select', selector: '#q', value: '   ' }
  ]) {
    const v = R.validateSteps([step]);
    eq(v.ok, false, JSON.stringify(step));
    assert.ok(/requires a value/.test(v.errors.join(' ')));
  }
});

test('validateSteps: navigate must be an absolute http(s) URL', () => {
  for (const url of ['not a url', '/relative', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    eq(R.validateSteps([{ action: 'navigate', url }]).ok, false, `url ${url} must be rejected`);
  }
  eq(R.validateSteps([{ action: 'navigate', url: 'https://ok.test/x?y=1' }]).ok, true);
});

test('validateSteps tolerates a non-array', () => {
  eq(R.validateSteps(null).ok, false);
  eq(R.validateSteps(undefined).ok, false);
  eq(R.validateSteps({}).ok, false);
});

// ═════════════════════════════════════════════════════
// describeRoutine
// ═════════════════════════════════════════════════════

test('describeRoutine renders one numbered line per step', () => {
  const out = R.describeRoutine([
    { action: 'click', selector: '[data-testid="x"]' },
    { action: 'type', selector: '[name="email"]', value: 'a@b.c' },
    { action: 'navigate', url: 'https://example.test/' }
  ]);
  eq(out, [
    '1. click [data-testid="x"]',
    '2. type "a@b.c" into [name="email"]',
    '3. navigate to https://example.test/'
  ].join('\n'));
});

test('describeRoutine marks destructive steps with ⚠', () => {
  const out = R.describeRoutine([
    { action: 'click', selector: '[data-testid="delete-account"]', note: 'Delete account' },
    { action: 'click', selector: '[data-testid="next"]' }
  ]);
  const lines = out.split('\n');
  assert.ok(lines[0].includes('⚠'), `destructive line must be flagged: ${lines[0]}`);
  assert.ok(!lines[1].includes('⚠'), `safe line must not be flagged: ${lines[1]}`);
});

test('describeRoutine renders masked steps as needing input at replay', () => {
  const out = R.describeRoutine([
    { action: 'type', selector: '[name="password"]', value: '«password»', needsValue: true, valueHint: 'password' }
  ]);
  eq(out, '1. type <password required at replay> into [name="password"]');
});

test('describeRoutine shows waits, select and press forms', () => {
  const out = R.describeRoutine([
    { action: 'click', selector: '#a', waitMs: 800 },
    { action: 'select', selector: '#country', value: 'US' },
    { action: 'press', key: 'Enter', selector: 'input[name="q"]' },
    { action: 'press', key: 'Enter' }
  ]);
  const lines = out.split('\n');
  eq(lines[0], '1. click #a (wait 800ms first)');
  eq(lines[1], '2. select "US" in #country');
  eq(lines[2], '3. press Enter on input[name="q"]');
  eq(lines[3], '4. press Enter');
});

test('describeRoutine flags a form-submitting press as destructive', () => {
  // Enter on a form target submits it, so it is destructive by the same
  // heuristic used for clicks.
  eq(R.describeRoutine([{ action: 'press', key: 'Enter', selector: 'form#checkout' }]),
    '1. ⚠ press Enter on form#checkout');
});

test('describeRoutine returns an empty string for an empty routine', () => {
  eq(R.describeRoutine([]), '');
  eq(R.describeRoutine(null), '');
});

// ═════════════════════════════════════════════════════
// buildReplayPlan
// ═════════════════════════════════════════════════════

const good = () => ([
  { action: 'navigate', url: 'https://example.test/' },
  { action: 'type', selector: '[name="email"]', value: 'a@b.c' },
  { action: 'click', selector: '[data-testid="go"]' }
]);

test('buildReplayPlan returns steps + timeout + needsValues', () => {
  const plan = R.buildReplayPlan(good());
  eq(plan.steps.length, 3);
  eq(plan.timeoutMs, 10000);
  eq(plan.needsValues.join(','), '');
  eq(plan.steps.map(s => s.action).join(','), 'navigate,type,click');
});

test('buildReplayPlan reports which steps still need a value (0-based indices)', () => {
  const plan = R.buildReplayPlan([
    { action: 'type', selector: '[name="email"]', value: 'a@b.c' },
    { action: 'type', selector: '[name="password"]', value: '«password»', needsValue: true, valueHint: 'password' },
    { action: 'click', selector: '#go' },
    { action: 'select', selector: '#card', value: '«card»', needsValue: true }
  ]);
  eq(plan.needsValues.join(','), '1,3');
  eq(plan.steps[1].needsValue, true);
  eq(plan.steps[1].value, '«password»');
});

test('buildReplayPlan throws for an invalid routine, with all errors joined', () => {
  assert.throws(
    () => R.buildReplayPlan([{ action: 'click' }, { action: 'navigate' }]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(/invalid routine/.test(err.message));
      assert.ok(/step 1: click requires a selector/.test(err.message));
      assert.ok(/step 2: navigate requires a url/.test(err.message));
      return true;
    }
  );
  assert.throws(() => R.buildReplayPlan([]), /invalid routine: routine has no steps/);
});

test('buildReplayPlan clamps the timeout to 1000..60000', () => {
  eq(R.buildReplayPlan(good(), { defaultTimeoutMs: 50 }).timeoutMs, 1000);
  eq(R.buildReplayPlan(good(), { defaultTimeoutMs: 999999 }).timeoutMs, 60000);
  eq(R.buildReplayPlan(good(), { defaultTimeoutMs: 2500 }).timeoutMs, 2500);
  eq(R.buildReplayPlan(good(), { defaultTimeoutMs: NaN }).timeoutMs, 10000);
});

test('buildReplayPlan accepts a routine object and honours its timeout/budget', () => {
  eq(R.buildReplayPlan({ steps: good(), timeoutMs: 1234 }).timeoutMs, 1234);
  eq(R.buildReplayPlan({ steps: good(), timeoutMs: 1 }).timeoutMs, 1000);
  eq(R.buildReplayPlan({ steps: good() }).timeoutMs, 10000);
});

test('buildReplayPlan clamps waitMs into the plan', () => {
  const plan = R.buildReplayPlan([{ action: 'click', selector: '#a', waitMs: 999999 }]);
  eq(plan.steps[0].waitMs, 5000);
});

test('buildReplayPlan never mutates the caller\'s steps', () => {
  const input = good();
  input[0].waitMs = 700;
  const snapshot = JSON.stringify(input);
  const plan = R.buildReplayPlan(input);
  eq(JSON.stringify(input), snapshot, 'input steps must not be mutated');
  assert.notEqual(plan.steps[0], input[0], 'plan steps must be detached copies');
});

test('buildReplayPlan drops non-contract bookkeeping fields', () => {
  const plan = R.buildReplayPlan([{ action: 'click', selector: '#a', ts: 123, startTs: 5, junk: true }]);
  eq(Object.keys(plan.steps[0]).join(','), 'action,selector');
});

// ═════════════════════════════════════════════════════
// End-to-end: a realistic capture
// ═════════════════════════════════════════════════════
// Uses exactly the payload shapes _kyotoCaptureContentScript sends (event
// discriminator, masked values, `window` placeholder on nav) so a change to
// either side of the recorder/planner contract shows up here.
test('a recorded login flow plans correctly end to end', () => {
  const events = [
    { event: 'nav', selector: 'window', url: 'https://app.test/login', ts: 0 },
    { event: 'click', selector: '[data-testid="open-form"]', text: 'Open', ts: 500 },
    { event: 'fill', selector: '[name="email"]', inputType: 'email', value: '«email»', ts: 900 },
    { event: 'fill', selector: '[name="password"]', inputType: 'password', value: '«password»', ts: 1200 },
    { event: 'submit', selector: 'form#login', tag: 'FORM', ts: 1600 },
    { event: 'nav', selector: 'window', url: 'https://app.test/dashboard', ts: 4000 },
    { event: 'click', selector: '[data-testid="row-1"]', text: 'Row 1', ts: 4300 },
    { event: 'key', key: 'Escape', selector: '#dialog', ts: 4400 }, // dropped
    { event: 'click', selector: '[data-testid="delete-account"]', text: 'Delete account', ts: 4800 }
  ];

  const steps = R.toSteps(events);
  eq(steps.map(s => s.action).join(','), 'navigate,click,type,type,press,navigate,click,click');
  eq(steps[2].needsValue, true);
  eq(steps[3].needsValue, true);
  // The 2.4s pause between submitting and the dashboard landing becomes a wait.
  eq(steps[5].waitMs, 2400);

  const plan = R.buildReplayPlan(steps);
  eq(plan.needsValues.join(','), '2,3');
  eq(plan.timeoutMs, 10000);

  const described = R.describeRoutine(steps).split('\n');
  eq(described[0], '1. navigate to https://app.test/login');
  eq(described[2], '3. type <email required at replay> into [name="email"]');
  eq(described[4], '5. ⚠ press Enter on form#login', 'form submit is destructive');
  eq(described[7], '8. ⚠ click [data-testid="delete-account"]', 'delete is flagged');
});

// ═════════════════════════════════════════════════════
// Source guards
// ═════════════════════════════════════════════════════
// The module must stay pure: it is loaded before sidepanel.js and unit-tested
// in node, so any chrome.*/DOM access here would make the plan untestable and
// mix planning with acting.
test('routine.js stays pure (no chrome.*, no DOM, no eval)', () => {
  assert.ok(!/chrome\./.test(SRC), 'routine.js must not touch chrome.*');
  assert.ok(!/document\./.test(SRC), 'routine.js must not touch the DOM');
  assert.ok(!/\beval\s*\(/.test(SRC), 'routine.js must not eval');
  assert.ok(!/new Function/.test(SRC), 'routine.js must not build functions from strings');
  assert.ok(/window\.KyotoRoutine\s*=/.test(SRC), 'must export window.KyotoRoutine');
});
