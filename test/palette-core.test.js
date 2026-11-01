// Tests for sidepanel/palette-core.js — the pure command-palette search core.
//
// The palette is a fuzzy launcher over ~147 tools, slash commands, sessions,
// models and settings actions. The behaviour that matters (and that a UI test
// cannot pin down cheaply) is here: the preference order of match types, the
// determinism of the ranking, the fact that `limit` never discards a better
// match, and the fixed section order. A wrong comparator makes the palette feel
// possessed: results reorder between identical keystrokes, or the thing the
// user typed the prefix of is not first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'palette-core.js'), 'utf-8');

// Same-realm load (see test/context.test.js) so deepEqual sees shared
// prototypes; a cross-realm array would fail strict deepEqual.
function load() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try {
    vm.runInThisContext(SRC, { filename: 'sidepanel/palette-core.js' });
    return globalThis.KyotoPalette;
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const P = load();
const { score, rank, moveIndex, groupBySource } = P;
const eq = assert.equal;

const ids = (items) => items.map((item) => item.id);

// ── score: match-type preference order ───────────────
test('score: an exact prefix beats a plain subsequence', () => {
  const prefix = score('page', 'page_click');
  const subsequence = score('page', 'repaged');
  assert.ok(prefix > 0 && subsequence > 0, 'both must match');
  assert.ok(prefix > subsequence, `prefix ${prefix} should beat subsequence ${subsequence}`);
});

test('score: a word-boundary match beats a mid-word match', () => {
  // Same query, similar label lengths: only the start position differs.
  const boundary = score('page', 'go page now');
  const midWord = score('page', 'xpagex');
  assert.ok(boundary > midWord, `word boundary ${boundary} should beat mid-word ${midWord}`);
  // Initials-style search is a word-boundary match too: "gtw" -> "go to web".
  assert.ok(score('gtw', 'go to web') > score('gtw', 'xgtwx'));
});

test('score: a camelCase boundary beats a plain subsequence', () => {
  const camel = score('session', 'ChatSession');
  const plain = score('session', 'chatsession');
  assert.ok(camel > plain, `camelCase ${camel} should beat plain ${plain}`);
});

test('score: gaps between matched characters are penalised', () => {
  const tight = score('ab', 'axb');
  const gappy = score('ab', 'axxxxxxxb');
  assert.ok(tight > gappy, `short gap ${tight} should beat long gap ${gappy}`);
});

test('score: matching is case-insensitive', () => {
  eq(score('PAGE', 'page_click'), score('page', 'page_click'));
  eq(score('page', 'PAGE_CLICK'), score('page', 'page_click'));
});

test('score: empty query, empty text and non-matches return 0', () => {
  eq(score('', 'page_click'), 0, 'empty query scores 0; rank() handles ordering');
  eq(score('   ', 'page_click'), 0);
  eq(score('zzz', 'page_click'), 0, 'no subsequence -> no match');
  eq(score('page', ''), 0);
  eq(score(null, 'page_click'), 0);
});

test('score: keywords are searchable, but a label hit outranks a keyword hit', () => {
  const viaKeyword = score('lights', 'toggle', ['turn on the lights']);
  assert.ok(viaKeyword > 0, 'keyword should provide a match when the label does not');
  const labelHit = score('lights', 'lights');
  const keywordHit = score('lights', 'toggle', ['lights']);
  assert.ok(labelHit > keywordHit, `label ${labelHit} should beat keyword ${keywordHit}`);
});

// ── rank: ordering, stability, limit ─────────────────
test('rank: an empty query returns every item in the original order', () => {
  const items = [
    { id: 'c', label: 'Zebra', source: 'tool' },
    { id: 'a', label: 'Alpha', source: 'action' },
    { id: 'b', label: 'Mike', source: 'session' }
  ];
  const out = rank(items, '');
  assert.deepEqual(ids(out), ['c', 'a', 'b']);
  assert.notStrictEqual(out, items, 'must not hand back the caller\'s array');
  // And the caller's array order is untouched.
  assert.deepEqual(ids(items), ['c', 'a', 'b']);
  // Whitespace-only behaves like empty.
  assert.deepEqual(ids(rank(items, '   ')), ['c', 'a', 'b']);
});

test('rank: no match returns an empty list', () => {
  const items = [{ id: 'a', label: 'page_click', source: 'tool' }];
  assert.deepEqual(rank(items, 'qqqq'), []);
});

test('rank: orders by score, best first', () => {
  const items = [
    { id: 'mid', label: 'xpagex', source: 'tool' },
    { id: 'prefix', label: 'page_click', source: 'tool' },
    { id: 'word', label: 'go page now', source: 'tool' }
  ];
  assert.deepEqual(ids(rank(items, 'page')), ['prefix', 'word', 'mid']);
});

test('rank: ties break on shorter label, then on original index', () => {
  // Both are exact prefixes of the query, so they score identically.
  const byLength = [
    { id: 'long', label: 'Run tests', source: 'action' },
    { id: 'short', label: 'Run', source: 'action' }
  ];
  assert.deepEqual(ids(rank(byLength, 'run')), ['short', 'long']);

  // Identical labels: the earlier input item wins, deterministically.
  const byIndex = [
    { id: 'first', label: 'Toggle sidebar', source: 'action' },
    { id: 'second', label: 'Toggle sidebar', source: 'action' }
  ];
  assert.deepEqual(ids(rank(byIndex, 'tog')), ['first', 'second']);
});

test('rank: repeated calls are deterministic', () => {
  const items = [];
  for (let i = 0; i < 20; i++) {
    items.push({ id: `item${i}`, label: 'session', source: 'session' });
  }
  items.push({ id: 'other', label: 'sessions', source: 'session' });
  const first = ids(rank(items, 'sess'));
  const second = ids(rank(items, 'sess'));
  assert.deepEqual(first, second);
  assert.equal(first.length, 21, 'all matches survive');
});

test('rank: limit is applied AFTER sorting, never before', () => {
  // The best match sits at index 1; a naive slice-before-sort would drop it.
  const items = [
    { id: 'mid', label: 'xpagex', source: 'tool' },
    { id: 'prefix', label: 'page_click', source: 'tool' }
  ];
  assert.deepEqual(ids(rank(items, 'page', { limit: 1 })), ['prefix']);
  assert.deepEqual(ids(rank(items, 'page', { limit: 5 })), ['prefix', 'mid']);
  assert.deepEqual(rank(items, 'page', { limit: 0 }), []);
  assert.deepEqual(ids(rank(items, 'page')), ['prefix', 'mid'], 'no limit -> everything');
});

test('rank: non-matching items never leak into the result', () => {
  const items = [
    { id: 'yes', label: 'open settings', source: 'action' },
    { id: 'no', label: 'cron_add', source: 'tool' }
  ];
  assert.deepEqual(ids(rank(items, 'settings')), ['yes']);
  assert.deepEqual(ids(rank(items, 'settings', { limit: 10 })), ['yes']);
});

// ── moveIndex ────────────────────────────────────────
test('moveIndex: wraps forward past the end and backward past the start', () => {
  eq(moveIndex(4, 1, 5), 0);
  eq(moveIndex(0, -1, 5), 4);
  eq(moveIndex(2, 1, 5), 3);
  eq(moveIndex(2, -1, 5), 1);
});

test('moveIndex: handles length 0 and 1 without producing an invalid index', () => {
  eq(moveIndex(0, 1, 0), 0);
  eq(moveIndex(3, -1, 0), 0);
  eq(moveIndex(0, 1, 1), 0);
  eq(moveIndex(0, -1, 1), 0);
  eq(moveIndex(7, 5, 1), 0);
});

test('moveIndex: -1 (no selection) enters the list from the moving end', () => {
  // ArrowDown from nothing selects the first item, ArrowUp selects the last.
  eq(moveIndex(-1, 1, 5), 0);
  eq(moveIndex(-1, -1, 5), 4);
});

test('moveIndex: a delta larger than the list wraps by modulo', () => {
  eq(moveIndex(0, 12, 5), 2);
  eq(moveIndex(1, -7, 5), 4);
});

// ── groupBySource ────────────────────────────────────
const MIXED = [
  { id: 'tool1', label: 'page_click', source: 'tool' },
  { id: 'setting1', label: 'Theme', source: 'setting' },
  { id: 'action1', label: 'New chat', source: 'action' },
  { id: 'unknown1', label: 'Plugin', source: 'plugin' },
  { id: 'slash1', label: '/help', source: 'slash' },
  { id: 'session1', label: 'Yesterday', source: 'session' },
  { id: 'model1', label: 'gpt-4o', source: 'model' },
  { id: 'other1', label: 'Misc', source: 'other' },
  { id: 'action2', label: 'Open settings', source: 'action' },
  { id: 'unknown2', label: 'Legacy', source: 'legacy' }
];

test('groupBySource: groups follow the fixed source priority', () => {
  const groups = groupBySource(MIXED);
  assert.deepEqual(
    groups.map((g) => g.source),
    ['action', 'slash', 'session', 'model', 'tool', 'setting', 'other', 'plugin', 'legacy']
  );
});

test('groupBySource: unknown sources come last, in first-seen order', () => {
  const groups = groupBySource([
    { id: 'z', source: 'zzz' },
    { id: 'tool', source: 'tool' },
    { id: 'a', source: 'aaa' }
  ]);
  assert.deepEqual(groups.map((g) => g.source), ['tool', 'zzz', 'aaa']);
});

test('groupBySource: item order inside a group is the incoming order', () => {
  const groups = groupBySource(MIXED);
  const actions = groups.find((g) => g.source === 'action');
  assert.deepEqual(ids(actions.items), ['action1', 'action2']);
});

test('groupBySource: a missing or blank source falls into "other"', () => {
  const groups = groupBySource([
    { id: 'nosource', label: 'Thing' },
    { id: 'blank', label: 'Other thing', source: '  ' },
    { id: 'tool', label: 'page_click', source: 'tool' }
  ]);
  assert.deepEqual(groups.map((g) => g.source), ['tool', 'other']);
  assert.deepEqual(ids(groups[1].items), ['nosource', 'blank']);
});

test('groupBySource: empty and malformed input returns no groups', () => {
  assert.deepEqual(groupBySource([]), []);
  assert.deepEqual(groupBySource(null), []);
  assert.deepEqual(groupBySource([null, undefined, 42]), []);
});
