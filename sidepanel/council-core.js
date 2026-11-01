// Council mode — ask several models the same question, then compare answers.
//
// Loaded before sidepanel.js as a plain IIFE that attaches `window.KyotoCouncil`.
// Every export is PURE (no chrome.*, no DOM, no network), so the ordering rules
// — which decide what the user actually sees — can be unit-tested in node.
// See test/council-core.test.js.
//
// Why this exists: one model can be confidently wrong, and the cheapest way to
// catch that is to ask two or three the same question and compare. The failure
// mode this module exists to prevent is PRESENTATION DRIFT: if merged rows
// followed *completion* order, the columns would jump around while answers
// stream in, and a failed model could silently be sitting at the top. So
// mergeResults() always returns rows aligned to `candidates`, and rank() is the
// only function allowed to reorder — explicitly, by a documented total order.
//
// Cost/usage note: rows carry `cost` and `usage` through untouched so the panel
// can show real spend. This module never computes prices; it only formats what
// the caller measured.

(() => {
  'use strict';

  const DEFAULT_LIMIT = 4;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function cleanString(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  /** Finite number or null (money/ms are only meaningful as numbers here). */
  function finiteOrNull(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  }

  function candidateKey(provider, model) {
    return `${provider}\u0000${model}`;
  }

  /** Best-effort human message from an Error, a string, or an error-ish object. */
  function errorMessage(value, fallback = 'unknown error') {
    if (value == null) return fallback;
    if (typeof value === 'string') return cleanString(value) || fallback;
    if (value instanceof Error) return cleanString(value.message) || fallback;
    if (isPlainObject(value) && typeof value.message === 'string') {
      return cleanString(value.message) || fallback;
    }
    try {
      const text = JSON.stringify(value);
      return text && text !== '{}' ? text : fallback;
    } catch {
      return fallback;
    }
  }

  /** JSON for structured payloads, with underscore bookkeeping dropped. */
  function jsonText(value) {
    try {
      const text = JSON.stringify(value);
      return typeof text === 'string' ? text : String(value == null ? '' : value);
    } catch {
      return String(value == null ? '' : value);
    }
  }

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return jsonText(value);
  }

  // ──────── CANDIDATES ────────
  /**
   * Validate the user's council picks.
   *
   * Junk must never reach the API layer: a candidate without a provider/model is
   * not callable, and duplicates would ask the same model twice (double spend,
   * identical answers side by side). First occurrence wins; the label is a
   * display nicety and falls back to the model id.
   *
   * @param {Array<{provider?:string, model?:string, label?:string}>} list
   * @param {{limit?:number}} [options]
   * @returns {Array<{provider:string, model:string, label:string}>}
   */
  function sanitiseCandidates(list, options = {}) {
    if (!Array.isArray(list)) return [];
    const opts = isPlainObject(options) ? options : {};
    let limit = Number(opts.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    limit = Math.floor(limit);

    const out = [];
    const seen = new Set();
    for (const raw of list) {
      if (!isPlainObject(raw)) continue;
      const provider = cleanString(raw.provider);
      const model = cleanString(raw.model);
      if (!provider || !model) continue;
      const key = candidateKey(provider, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, model, label: cleanString(raw.label) || model });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ──────── RESULT NORMALISATION ────────
  /**
   * Unwrap one raw result into the internal shape. Accepts:
   *   - plain values (string, number, boolean)
   *   - {ok, text, error, ms, cost, usage}
   *   - settled entries: {status:'fulfilled', value} / {status:'rejected', reason}
   *
   * `depth` guards against a malformed/self-referential settled value.
   */
  function unwrapResult(entry, depth = 0) {
    if (depth > 3) return { ok: false, error: 'malformed result' };
    if (entry == null) return { ok: false, error: 'no result', missing: true };
    if (typeof entry === 'string') return { ok: true, text: entry };
    if (typeof entry === 'number' || typeof entry === 'boolean') return { ok: true, text: String(entry) };
    if (!isPlainObject(entry)) return { ok: false, error: 'malformed result' };

    if (entry.status === 'rejected') {
      return { ok: false, error: errorMessage(entry.reason), identity: identityFrom(entry) };
    }
    if (entry.status === 'fulfilled') {
      const inner = ('value' in entry) ? unwrapResult(entry.value, depth + 1) : { ok: true, text: '' };
      const wrapper = identityFrom(entry);
      if (hasIdentity(wrapper) && !hasIdentity(inner.identity)) inner.identity = wrapper;
      return inner;
    }

    const hasError = entry.error != null &&
      (typeof entry.error === 'string' ? entry.error.trim() !== '' : true);
    const explicitOk = typeof entry.ok === 'boolean' ? entry.ok : undefined;
    const ok = explicitOk === true ? true : (explicitOk === false ? false : !hasError);

    return {
      ok,
      text: textOf(entry.text != null ? entry.text : entry.content),
      error: ok ? null : (hasError ? errorMessage(entry.error) : (explicitOk === false ? 'failed' : 'no result')),
      ms: finiteOrNull(entry.ms != null ? entry.ms : entry.latencyMs),
      cost: finiteOrNull(entry.cost != null ? entry.cost : entry._cost),
      usage: isPlainObject(entry.usage) ? entry.usage : (isPlainObject(entry._usage) ? entry._usage : null),
      identity: identityFrom(entry)
    };
  }

  function identityOf(norm) {
    return (norm && norm.identity) || { provider: '', model: '', label: '' };
  }

  /**
   * Identity carried by a result envelope. `Promise.allSettled` wrappers lose
   * nothing positionally, but a caller that filters/sorts completions may hand
   * us wrappers in arbitrary order — so a provider/model on the wrapper is worth
   * honouring, including on a rejected entry (you still want the failure in the
   * right column).
   */
  function identityFrom(entry) {
    return {
      provider: cleanString(entry.provider),
      model: cleanString(entry.model),
      label: cleanString(entry.label)
    };
  }

  function hasIdentity(identity) {
    return !!(identity && ((identity.provider && identity.model) || identity.label));
  }

  /** First still-unassigned slot this result provably belongs to, else -1. */
  function findSlot(identity, candidates, assigned) {
    if (!identity) return -1;
    if (identity.provider && identity.model) {
      const key = candidateKey(identity.provider, identity.model);
      for (let i = 0; i < candidates.length; i++) {
        if (assigned[i]) continue;
        if (candidateKey(candidates[i].provider, candidates[i].model) === key) return i;
      }
    }
    if (identity.label) {
      // Labels are only unambiguous when exactly one candidate has them.
      const matches = [];
      for (let i = 0; i < candidates.length; i++) {
        if (!assigned[i] && candidates[i].label === identity.label) matches.push(i);
      }
      if (matches.length === 1) return matches[0];
    }
    return -1;
  }

  function buildMerged(candidate, norm) {
    const ok = !!(norm && norm.ok === true);
    const text = (norm && typeof norm.text === 'string') ? norm.text : '';
    let error = null;
    if (!ok) {
      const raw = norm && typeof norm.error === 'string' ? norm.error.trim() : '';
      // A candidate with no result at all is a different failure from one whose
      // result was rejected: say which, so the panel does not read as "the model
      // errored" when it was simply never asked / never returned.
      error = raw || (norm ? 'unknown error' : 'no result for this model');
    }
    return {
      provider: candidate.provider,
      model: candidate.model,
      label: candidate.label,
      ok,
      text,
      error,
      ms: norm ? finiteOrNull(norm.ms) : null,
      usage: norm && isPlainObject(norm.usage) ? norm.usage : null,
      cost: norm ? finiteOrNull(norm.cost) : null
    };
  }

  /**
   * Normalise raw results into one row per candidate, IN CANDIDATE ORDER.
   *
   * Results are matched to candidates by identity (provider+model, or an
   * unambiguous label) when they carry one — that is what makes out-of-order
   * completions safe. Results without identity are matched positionally to the
   * remaining slots, which is the `Promise.allSettled` shape. Extra results are
   * ignored; missing results become failed rows instead of disappearing (a
   * vanished column is worse UI than an explicit error).
   *
   * @param {Array<{provider:string, model:string, label:string}>} candidates
   * @param {Array} results
   * @returns {Array<{provider,model,label,ok,text,error,ms,usage,cost}>}
   */
  function mergeResults(candidates, results) {
    const rows = Array.isArray(candidates)
      ? candidates.filter(isPlainObject).map((c) => ({
        provider: cleanString(c.provider),
        model: cleanString(c.model),
        label: cleanString(c.label) || cleanString(c.model)
      }))
      : [];
    const list = Array.isArray(results) ? results : [];
    const assigned = new Array(rows.length).fill(null);
    const pending = [];

    for (const raw of list) {
      const norm = unwrapResult(raw);
      const slot = findSlot(identityOf(norm), rows, assigned);
      if (slot === -1) pending.push(norm);
      else assigned[slot] = norm;
    }

    let cursor = 0;
    for (const norm of pending) {
      while (cursor < assigned.length && assigned[cursor]) cursor++;
      if (cursor >= assigned.length) break; // more results than candidates
      assigned[cursor] = norm;
      cursor++;
    }

    return rows.map((candidate, i) => buildMerged(candidate, assigned[i]));
  }

  // ──────── RANKING ────────
  const INF = Infinity;

  function costOrder(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : INF;
  }

  function msOrder(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : INF;
  }

  /**
   * Best-first ordering: answered before failed, cheaper before dearer, faster
   * before slower, unknown (null) values last, ties keep the incoming order.
   *
   * Returns a NEW array; the caller's array (which drives the UI columns) is
   * never reordered in place.
   */
  function rank(merged) {
    const rows = Array.isArray(merged) ? merged.slice() : [];
    const decorated = rows.map((row, index) => ({ row, index }));
    decorated.sort((a, b) => {
      const aOk = a.row && a.row.ok ? 1 : 0;
      const bOk = b.row && b.row.ok ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;

      const aCost = costOrder(a.row && a.row.cost);
      const bCost = costOrder(b.row && b.row.cost);
      if (aCost !== bCost) return aCost < bCost ? -1 : 1;

      const aMs = msOrder(a.row && a.row.ms);
      const bMs = msOrder(b.row && b.row.ms);
      if (aMs !== bMs) return aMs < bMs ? -1 : 1;

      return a.index - b.index;
    });
    return decorated.map((d) => d.row);
  }

  // ──────── SUMMARY ────────
  function trimZeros(s) {
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  function formatCost(cost) {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return '—';
    if (cost === 0) return '$0';
    if (cost < 0.0001) return '<$0.0001';
    if (cost < 1) return '$' + trimZeros(cost.toFixed(4));
    return '$' + trimZeros(cost.toFixed(2));
  }

  function formatMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    return Math.round(ms) + ' ms';
  }

  /** Single-line, markdown-safe-ish inline text (bullets must not break). */
  function inline(value, fallback = '') {
    const s = String(value == null ? '' : value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();
    return s || fallback;
  }

  function identityText(row) {
    const provider = inline(row && row.provider);
    const model = inline(row && row.model);
    if (provider && model) return `${provider}/${model}`;
    return provider || model || '';
  }

  /**
   * Markdown comparison table (bullets). Never throws: it is the last thing
   * rendered before the user sees the panel, and a single malformed row must
   * not take the whole turn's output with it.
   *
   * @param {Array} merged
   * @returns {string}
   */
  function formatSummary(merged) {
    const rows = Array.isArray(merged) ? merged.filter(isPlainObject) : [];
    if (!rows.length) return '### Council\n\n_No models to compare._\n';

    const okCount = rows.filter((row) => row && row.ok).length;
    const lines = [`### Council · ${okCount}/${rows.length} answered`, ''];

    for (const row of rows) {
      const label = inline(row && row.label) || inline(row && row.model) || 'unknown model';
      const identity = identityText(row);
      const status = row && row.ok ? 'ok' : `error: ${inline(row && row.error, 'unknown error')}`;
      const parts = [
        `- **${label}**`,
        identity ? `(${identity})` : '',
        `— ${status} · ${formatMs(row && row.ms)} · ${formatCost(row && row.cost)}`
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }
    return lines.join('\n') + '\n';
  }

  window.KyotoCouncil = {
    sanitiseCandidates,
    mergeResults,
    rank,
    formatSummary
  };
})();
