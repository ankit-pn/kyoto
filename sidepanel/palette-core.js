// Fuzzy command palette core — scoring, ranking and grouping, with no UI.
//
// The palette searches ~147 tools, dozens of slash commands, sessions, models
// and settings actions on every keystroke. That is a pure data problem, so it
// lives here (loaded before sidepanel.js as `window.KyotoPalette`) and is
// unit-tested in node. No chrome.*, no document: sidepanel.js owns the input
// handling, keyboard navigation and rendering.
//
// The subtle part is keeping the ordering stable and explainable. Typing "sess"
// should put "Open session" above an accidental subsequence, and "gtw" should
// find "go to web" by its word initials rather than in the middle of a word.
// The bonuses below encode exactly that preference order:
//
//     exact prefix  >  word-boundary match  >  camelCase boundary  >  plain
//
// All scores are positive for a real match so that 0 can safely mean "no
// match" (and an empty query, which matches everything, scores 0 by design —
// rank() handles that case explicitly instead of sorting on 0).

(() => {
  'use strict';

  const BASE_SCORE = 1000;        // any real match is comfortably > 0
  const PER_MATCHED_CHAR = 12;
  const ADJACENT_BONUS = 10;      // each pair of consecutive matched chars
  // Bonuses must dominate the gap penalty: a word-boundary match in a long
  // label still has to beat an accidental mid-word subsequence in a short one.
  const PREFIX_BONUS = 600;
  const WORD_BOUNDARY_BONUS = 350;
  const CAMEL_BOUNDARY_BONUS = 200;
  const GAP_PENALTY = 4;          // per skipped character between matches
  const MAX_GAP_PENALTY = 150;    // caps the effect of very long labels
  const LEADING_PENALTY = 2;      // per character before the first match
  const MAX_LEADING_PENALTY = 60;
  const KEYWORD_PENALTY = 60;     // a label hit is slightly better than a keyword hit

  // Fixed display order for grouped palette sections. Unknown sources sort
  // after everything here, in the order they were first seen.
  const SOURCE_PRIORITY = ['action', 'slash', 'session', 'model', 'tool', 'setting', 'other'];

  function toText(value) {
    if (typeof value === 'string') return value;
    return value == null ? '' : String(value);
  }

  // A word boundary is the start of the string or any position preceded by a
  // non-alphanumeric character ("page_click" -> p at 0 and c after "_").
  function isWordBoundary(text, index) {
    if (index <= 0) return true;
    return !/[a-z0-9]/i.test(text[index - 1]);
  }

  // A camelCase boundary is an uppercase letter preceded by a lowercase letter
  // or digit ("ChatSession" -> S at index 4). Deliberately NOT counted as a
  // word boundary: the two bonuses are ranked separately.
  function isCamelBoundary(text, index) {
    if (index <= 0) return false;
    return /[A-Z]/.test(text[index]) && /[a-z0-9]/.test(text[index - 1]);
  }

  // Greedy left-to-right subsequence match. Greedy is deterministic (the
  // ranking must be reproducible keystroke for keystroke) and for short label
  // texts the optimal alignment would almost always be the greedy one anyway.
  function matchPositions(haystack, needle) {
    const positions = [];
    let from = 0;
    for (let i = 0; i < needle.length; i++) {
      const found = haystack.indexOf(needle[i], from);
      if (found === -1) return null;
      positions.push(found);
      from = found + 1;
    }
    return positions;
  }

  /** Score a single candidate string (already-normalised query, raw text). */
  function scoreText(query, text) {
    if (!query || !text) return 0;
    const lower = text.toLowerCase();
    const positions = matchPositions(lower, query);
    if (!positions) return 0;

    let score = BASE_SCORE + PER_MATCHED_CHAR * query.length;
    let gapChars = 0;
    let adjacentPairs = 0;
    for (let i = 1; i < positions.length; i++) {
      const gap = positions[i] - positions[i - 1] - 1;
      if (gap > 0) gapChars += gap;
      else adjacentPairs++;
    }
    score += adjacentPairs * ADJACENT_BONUS;
    score -= Math.min(gapChars * GAP_PENALTY, MAX_GAP_PENALTY);
    score -= Math.min(positions[0] * LEADING_PENALTY, MAX_LEADING_PENALTY);

    // Tier the match by where it STARTS. Typing "click" should find
    // "page_click" at the underscore, and typing "session" should find
    // "ChatSession" at the capital, rather than only working when every single
    // matched character happens to sit on a boundary.
    const isPrefix = positions[0] === 0 && lower.startsWith(query);
    if (isPrefix) {
      score += PREFIX_BONUS;
    } else if (isWordBoundary(text, positions[0])) {
      score += WORD_BOUNDARY_BONUS;
    } else if (isCamelBoundary(text, positions[0])) {
      score += CAMEL_BOUNDARY_BONUS;
    }
    return score;
  }

  /**
   * How well `text` (a label or one keyword) matches `query`.
   *
   * Subsequence match, case-insensitive, with the bonus tiers described at the
   * top of the file. Returns 0 for "no match" and for an empty query — rank()
   * treats the empty query as "match everything, keep order".
   *
   * @param {string} query
   * @param {string} text
   * @param {string[]|string} [keywords] optional extra terms to match against
   *   (an item's `keywords` array). A label hit always outranks a keyword hit
   *   for the same quality of match.
   * @returns {number}
   */
  function score(query, text, keywords) {
    const q = toText(query).trim().toLowerCase();
    if (!q) return 0;

    let best = scoreText(q, toText(text));
    const list = Array.isArray(keywords) ? keywords : (keywords == null ? [] : [keywords]);
    for (const keyword of list) {
      const keywordScore = scoreText(q, toText(keyword));
      if (keywordScore > 0) best = Math.max(best, keywordScore - KEYWORD_PENALTY);
    }
    return best;
  }

  /**
   * Rank items best-first. Deterministic: score desc, then shorter label asc,
   * then original index asc. `limit` is applied AFTER sorting, so a high-scoring
   * item near the end of the input is never cut off in favour of a worse one.
   *
   * An empty query matches everything with score 0 and therefore returns the
   * items in their incoming order (still honouring `limit`).
   *
   * @param {Array<{id:any,label:string,hint?:string,source:string,keywords?:string[]}>} items
   * @param {string} query
   * @param {{limit?:number}} [opts]
   * @returns {Array} matching items, best first; never the caller's array
   */
  function rank(items, query, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const q = toText(query).trim();

    const rawLimit = opts ? opts.limit : undefined;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(0, Math.floor(rawLimit))
        : null;

    if (!q) {
      const ordered = list.slice();
      return limit == null ? ordered : ordered.slice(0, limit);
    }

    const scored = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== 'object') continue;
      const itemScore = score(q, item.label, item.keywords);
      if (itemScore <= 0) continue;
      scored.push({ item, score: itemScore, index: i, labelLength: toText(item.label).length });
    }

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.labelLength - b.labelLength ||
        a.index - b.index
    );

    const ranked = scored.map((entry) => entry.item);
    return limit == null ? ranked : ranked.slice(0, limit);
  }

  /**
   * Move a palette selection index by `delta`, wrapping at both ends.
   *
   * - length 0 or 1: there is only ever one legal index, 0.
   * - -1 (nothing selected yet) is treated as "just outside" the list, so
   *   ArrowDown (delta +1) selects the first item and ArrowUp (delta -1)
   *   selects the last one. Wrapping -1 arithmetically would make ArrowUp
   *   from an empty selection land on the second-to-last item.
   * - A delta larger than the list wraps repeatedly (modulo).
   *
   * @returns {number} an index in [0, length)
   */
  function moveIndex(index, delta, length) {
    const n = Math.floor(Number(length));
    if (!Number.isFinite(n) || n <= 0) return 0;

    const d = Number.isFinite(Number(delta)) ? Math.trunc(Number(delta)) : 0;
    const i = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : -1;

    if (d === 0) return i >= 0 && i < n ? i : 0;

    if (i < 0 || i >= n) {
      const from = d > 0 ? -1 : n;
      return ((from + d) % n + n) % n;
    }
    return ((i + d) % n + n) % n;
  }

  /**
   * Group items by `source`, preserving incoming order inside each group and
   * the first-seen order of items. Groups are ordered by SOURCE_PRIORITY;
   * unknown sources come last, in first-seen order relative to each other.
   *
   * @param {Array<{source?:string}>} items
   * @returns {Array<{source:string, items:Array}>}
   */
  function groupBySource(items) {
    const list = Array.isArray(items) ? items : [];
    const sourceOrder = [];
    const buckets = new Map();

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rawSource = typeof item.source === 'string' ? item.source.trim() : '';
      // Items with no source still need a section; "other" is the documented
      // catch-all and sorts last among the known sources.
      const source = rawSource || 'other';
      let bucket = buckets.get(source);
      if (!bucket) {
        bucket = [];
        buckets.set(source, bucket);
        sourceOrder.push(source);
      }
      bucket.push(item);
    }

    const priority = (source) => {
      const index = SOURCE_PRIORITY.indexOf(source);
      return index === -1 ? SOURCE_PRIORITY.length : index;
    };
    // Array.prototype.sort is stable (ES2019+), so equal-priority unknown
    // sources keep their first-seen order.
    sourceOrder.sort((a, b) => priority(a) - priority(b));

    return sourceOrder.map((source) => ({ source, items: buckets.get(source) }));
  }

  window.KyotoPalette = {
    score,
    rank,
    moveIndex,
    groupBySource
  };
})();
