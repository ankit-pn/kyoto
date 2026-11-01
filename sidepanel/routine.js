// Routines: record page actions once, then replay them deterministically with
// ZERO model calls.
//
// This module is the PURE planning half of the feature: it turns the recorder's
// raw `CAPTURE_EVENT` payloads into a replayable step list. It never touches the
// Chrome extension APIs, the DOM, or the page — `sidepanel.js` does the recording
// and the replay executor does the acting. Every export is a pure function so the
// safety-critical part (selector choice + step ordering) can be unit-tested in
// node. See test/routine.test.js.
//
// Why so defensive: replay is blind. A wrong selector does not error out, it
// acts on whatever element happens to match on a *later* page load, and a step
// that is silently dropped makes the routine half-complete while still
// reporting success. So we would rather return null (step unusable, surfaced to
// the user) than guess, and we never synthesise a text/label selector.
//
// STEP SHAPE (the contract the replay executor consumes):
//   { action:'click'|'type'|'select'|'navigate'|'press',
//     selector?, value?, url?, key?, note?, waitMs?,
//     needsValue?, valueHint? }
//
// `needsValue` is set when the recorder masked the value (see MASK_RE): the
// placeholder stays in `value` so the routine still describes itself, but the
// executor must collect a real value from the user before replaying.
//
// RECORDER PAYLOAD (from _kyotoCaptureContentScript in sidepanel.js) uses
// `event` as its discriminator, not `kind`:
//   { event:'fill', selector, inputType, value, label, url, title, ts }
//   { event:'click', selector, text, tag, href, url, title, ts }
//   { event:'submit', selector, tag:'FORM', url, title, ts }
//   { event:'key', key:'Enter'|'Escape'|'Tab', selector, text, url, ts }
//   { event:'nav', selector:'window', url, title, ts }
// `kind` is accepted as a legacy alias, and every field is advisory.

(() => {
  'use strict';

  const ACTIONS = new Set(['click', 'type', 'select', 'navigate', 'press']);

  // Values the content script masks BEFORE sending to the side panel:
  // «password» «email» «card» «otp» «secret». A routine must never replay one
  // of these as if it were real input — they are placeholders, not secrets.
  const MASK_RE = /^«([a-z]+)»$/i;

  // Heuristic safety net, not a guarantee: these words usually mean an action
  // the user cannot take back (delete, pay, publish…). A match forces a user
  // confirmation before the routine runs; a miss does NOT make a step safe.
  const DESTRUCTIVE_RE =
    /delete|remove|destroy|drop|pay|purchase|buy|confirm|submit|send|publish|deploy|unsubscribe|cancel account/i;

  // Selector limits. Long/positional paths are the ones that silently drift
  // between page loads, which is exactly the failure mode replay must not have.
  const CSS_ATTR_MAX = 200;   // attribute values longer than this are unusable
  const CSS_PATH_MAX = 400;   // whole-selector sanity cap
  const MAX_CHAIN = 4;        // max elements in a `a > b > c` path
  const ID_MAX = 64;

  const WAIT_CAP_MS = 5000;   // never stall a replay longer than this
  const TIMEOUT_MIN_MS = 1000;
  const TIMEOUT_MAX_MS = 60000;
  const DEFAULT_TIMEOUT_MS = 10000;
  const NOTE_MAX = 80;

  // ──────── selectors ────────

  function firstString(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  }

  /**
   * Escape a value for use inside a CSS attribute selector's double quotes.
   * Returns null when the value is unusable (empty/absurdly long): a caller
   * must fall through to the next preference, never emit a broken selector.
   */
  function cssAttrValue(value) {
    const v = String(value ?? '');
    if (!v.trim() || v.length > CSS_ATTR_MAX) return null;
    return v
      .replace(/\\/g, '\\\\')      // backslash must be escaped first
      .replace(/"/g, '\\"')        // else `[name="a"b"]` becomes invalid CSS
      .replace(/\r\n|[\n\r]/g, '\\a '); // newlines need a CSS escape, not a literal
  }

  // ids a framework or the browser generated rather than the author wrote.
  // A routine recorded against one of these replays against a different
  // element — or nothing — on the next page load, so they are never trusted
  // even though they look precise.
  const GENERATED_ID_RE = [
    /:r[0-9a-z]+:/i,                    // React 18 useId: ":r1:"
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
    /\d{6,}/,                           // timestamps/counters: "el-1699999999"
    // Library prefixes, as a token: "react-aria-1" / "ember123" / "ng-model",
    // but NOT an author id that merely contains the letters ("reaction-panel").
    /(?:^|[-_])(?:react|ember|svelte|angular|vue|radix|headlessui|mui|mantine|chakra|rc|j_id|ext-gen|gwt)(?=[-_]|\d|$)/i,
    /[0-9a-f]{12,}/i,                   // long hex blob
    /(?:^|[-_])\d+$/,                   // index suffix: "row-3", "item_12"
    /[a-z][-_]?\d{1,4}$/i,              // "tab2", "col_07", "section-12"
  ];

  function isStableId(id) {
    const s = String(id ?? '').trim();
    if (!s || s.length > ID_MAX) return false;
    // Must be a plain CSS id token; anything needing escapes (#a\:b) is
    // framework-generated in practice.
    if (!/^[A-Za-z_][\w-]*$/.test(s)) return false;
    return !GENERATED_ID_RE.some(re => re.test(s));
  }

  /** Every `#id` in one path segment must be stable (quoted attr values ignored). */
  function segmentIdsStable(segment) {
    // Strip quoted strings first so `[href="#top"]` is not read as an id.
    const stripped = segment.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    // Stop at the CSS tokens that *follow* an id (`.class`, `:pseudo`, `[attr]`,
    // a combinator) so `div#main.active` is read as id "main", not "main.active".
    const re = /#((?:[^\s>#.[:]|\\.)+)/g;
    let m;
    while ((m = re.exec(stripped))) {
      const id = m[1].replace(/\\(.)/g, '$1');
      if (!isStableId(id)) return false;
    }
    return true;
  }

  /**
   * Is a recorded CSS path safe to replay?
   *
   * Rejected: chains deeper than MAX_CHAIN elements, `> *` (unknown tag),
   * more than one positional pseudo (a chain of positions is a chain of
   * guesses), any generated `#id` inside the path, and the recorder's literal
   * `window` placeholder.
   */
  function isStableSelectorPath(selector) {
    if (typeof selector !== 'string') return false;
    const s = selector.trim();
    if (!s || s.length > CSS_PATH_MAX) return false;
    if (/^(?:window|document)$/i.test(s)) return false;
    if (!/^[A-Za-z_#.[]/.test(s)) return false;
    const segments = s.split('>').map(x => x.trim()).filter(Boolean);
    if (!segments.length || segments.length > MAX_CHAIN) return false;
    if (segments.some(seg => seg.startsWith('*'))) return false;
    const positional = (s.match(/:nth-(?:child|of-type|last-child|last-of-type)\(/gi) || []).length;
    if (positional > 1) return false;
    for (const seg of segments) if (!segmentIdsStable(seg)) return false;
    return true;
  }

  /**
   * Best stable selector for an element descriptor, or null.
   *
   * Preference order (most stable → least):
   *   1. [data-testid] — author-written for automation, survives restyles;
   *   2. [aria-label]  — author-written, but copy/translation can change it;
   *   3. [name]        — form field identity, stable for inputs;
   *   4. #id           — only when the id looks author-written (isStableId);
   *   5. recorded CSS path — only when it passes isStableSelectorPath;
   *   6. null — never invent a text/label selector. "Click the element whose
   *      text says Delete" is not a selector and would bind to whatever matches
   *      first at replay time.
   */
  function bestSelector(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return null;

    const testId = firstString(descriptor, ['testId', 'testid', 'dataTestid', 'dataTestId', 'data-testid']);
    if (testId) {
      const v = cssAttrValue(testId);
      if (v) return `[data-testid="${v}"]`;
    }

    const aria = firstString(descriptor, ['ariaLabel', 'aria-label', 'aria']);
    if (aria) {
      const v = cssAttrValue(aria);
      if (v) return `[aria-label="${v}"]`;
    }

    const name = firstString(descriptor, ['name', 'fieldName']);
    if (name) {
      const v = cssAttrValue(name);
      if (v) return `[name="${v}"]`;
    }

    const id = firstString(descriptor, ['id', 'elementId']);
    if (id && isStableId(id)) return `#${id}`;

    const path = firstString(descriptor, ['selector', 'cssPath', 'css', 'path']);
    if (path && isStableSelectorPath(path)) return path;

    return null;
  }

  // ──────── normalisation ────────

  function maskInfo(value) {
    const m = MASK_RE.exec(String(value ?? '').trim());
    return m ? { needsValue: true, valueHint: m[1].toLowerCase() } : null;
  }

  function noteText(raw) {
    const text = String(raw.text ?? raw.label ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, NOTE_MAX) : '';
  }

  /**
   * A URL a routine may replay. Shared by normaliseEvent and validateSteps so
   * the planner can never emit a step that validation would reject — the
   * recorder→plan pipeline must always produce a runnable routine.
   * http(s) only: javascript:/data: would turn a replay into injected code.
   */
  function isSafeNavigateUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return false;
    let parsed = null;
    try { parsed = new URL(url.trim()); } catch { return false; }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  function isSelectLike(raw) {
    const tag = String(raw.tag ?? '').toUpperCase();
    const inputType = String(raw.inputType ?? raw.type ?? '').toLowerCase();
    return tag === 'SELECT' || inputType === 'select-one' || inputType === 'select-multiple' || inputType === 'select';
  }

  function isToggleLike(raw) {
    const tag = String(raw.tag ?? '').toUpperCase();
    const inputType = String(raw.inputType ?? raw.type ?? '').toLowerCase();
    return ['checkbox', 'radio'].includes(inputType) || tag === 'CHECKBOX' || tag === 'RADIO';
  }

  /**
   * One recorder payload → one step, or null when it cannot be replayed safely.
   *
   * Null cases: missing/unknown discriminator, click without a stable selector,
   * type/select without a stable selector or without a value, navigate without
   * a url. Escape/Tab keydowns are dropped: they are navigation noise, not a
   * deterministic page action, and replaying them can dismiss dialogs the user
   * did not intend to touch.
   */
  function normaliseEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // `event` is what the recorder sends; `kind` is the documented legacy alias.
    const kind = String(raw.event ?? raw.kind ?? '').trim().toLowerCase();
    if (!kind) return null;
    const selector = bestSelector(raw);

    switch (kind) {
      case 'click': {
        if (!selector) return null;
        const note = noteText(raw);
        return note ? { action: 'click', selector, note } : { action: 'click', selector };
      }

      // The recorder funnels text inputs, selects and toggles through `fill`.
      case 'fill':
      case 'input':
      case 'change':
      case 'type':
      case 'select': {
        if (!selector) return null;
        // A checkbox/radio "value" is "on"/"true", not something you can type;
        // the replayable action is a click (which toggles it). Duplicate-click
        // collapsing in toSteps folds this together with a recorded click.
        if (isToggleLike(raw)) return { action: 'click', selector };

        const masked = maskInfo(raw.value) || maskInfo(raw.label);
        const value = raw.value == null ? '' : String(raw.value);
        if (!value.trim() && !masked) return null;

        const action = (kind === 'select' || isSelectLike(raw)) ? 'select' : 'type';
        const step = { action, selector, value };
        if (masked) {
          step.needsValue = true;
          step.valueHint = masked.valueHint;
        }
        return step;
      }

      case 'submit': {
        // Submitting a form is Enter on the form (or its submit control).
        const step = { action: 'press', key: 'Enter' };
        if (selector) step.selector = selector;
        return step;
      }

      case 'key':
      case 'keydown': {
        const key = String(raw.key ?? raw.keyName ?? '').trim();
        // Only Enter is a meaningful replay step; Escape/Tab are dropped.
        if (key.toLowerCase() !== 'enter') return null;
        const step = { action: 'press', key: 'Enter' };
        if (selector) step.selector = selector;
        return step;
      }

      case 'nav':
      case 'navigate':
      case 'navigation': {
        // The recorder attaches the landing URL to every payload, so a nav
        // event is the one place `url` is authoritative. A malformed/unsafe URL
        // is an unusable event (null), not a step that validation later rejects.
        const url = String(raw.url ?? raw.targetUrl ?? '').trim();
        if (!isSafeNavigateUrl(url)) return null;
        return { action: 'navigate', url };
      }

      default:
        return null;
    }
  }

  // ──────── coalescing ────────

  /**
   * Raw recorder events → replayable steps.
   *
   * Typing one character at a time must not become N steps: consecutive `type`
   * steps on the same selector collapse to the LAST value (that is the field's
   * final content). Duplicate clicks on the same selector within `idleGapMs`
   * collapse too — the recorder can emit click+click for one user action.
   * Gaps longer than `idleGapMs` become `waitMs` on the step that follows, so a
   * routine that waited for a slow page keeps that pacing (capped, see cap).
   *
   * Order is preserved: replay determinism depends on it.
   */
  function toSteps(events, { idleGapMs = 600 } = {}) {
    if (!Array.isArray(events)) return [];
    const gapMs = (typeof idleGapMs === 'number' && Number.isFinite(idleGapMs) && idleGapMs >= 0)
      ? idleGapMs : 600;

    // Pass 1: normalise, keeping timestamps for gap/duplicate decisions.
    const kept = [];
    for (const raw of events) {
      const step = normaliseEvent(raw);
      if (!step) continue;
      const ts = Number(raw && raw.ts);
      kept.push({ step, startTs: Number.isFinite(ts) ? ts : null, endTs: Number.isFinite(ts) ? ts : null });
    }

    // Pass 2: coalesce runs. The group keeps the FIRST start time (the wait
    // belongs before the group) and the LAST end time (the next gap starts
    // after the last keystroke).
    const groups = [];
    for (const item of kept) {
      const prev = groups[groups.length - 1];
      if (prev) {
        const sameTarget = prev.step.selector && prev.step.selector === item.step.selector;
        if (sameTarget && prev.step.action === 'type' && item.step.action === 'type') {
          // Last value wins; the placeholder/mask state travels with it.
          prev.step = { ...item.step };
          prev.endTs = item.endTs;
          continue;
        }
        if (sameTarget && prev.step.action === 'click' && item.step.action === 'click') {
          const known = prev.endTs != null && item.startTs != null;
          // When timestamps are missing we keep both clicks: dropping a real
          // second click is worse than replaying a redundant one.
          if (known && (item.startTs - prev.endTs) <= gapMs) {
            prev.endTs = item.endTs;
            continue;
          }
        }
      }
      groups.push({ step: { ...item.step }, startTs: item.startTs, endTs: item.endTs });
    }

    // Pass 3: materialise gaps as waitMs on the following step.
    const steps = [];
    let prevEnd = null;
    for (const g of groups) {
      const step = g.step;
      if (prevEnd != null && g.startTs != null) {
        const delta = g.startTs - prevEnd;
        if (delta > gapMs) step.waitMs = Math.min(Math.round(delta), WAIT_CAP_MS);
      }
      steps.push(step);
      prevEnd = g.endTs;
    }
    return steps;
  }

  // ──────── safety checks ────────

  /**
   * Should this step force a user confirmation before replay?
   *
   * HEURISTIC ONLY. It matches the destructive English verbs in
   * DESTRUCTIVE_RE against everything we know about the target (selector, and
   * the recorded element text we kept in `note`), plus Enter on a form-ish
   * target (which submits it). A false negative — a destructive action whose
   * wording is not in the list — remains possible, so the replay UI must not
   * treat "not destructive" as "safe to run unattended".
   */
  function isDestructiveStep(step) {
    if (!step || typeof step !== 'object') return false;
    const target = [
      step.selector, step.testId, step.ariaLabel, step.text, step.name, step.note
    ].filter(v => typeof v === 'string' && v).join(' ');

    if (step.action === 'press') {
      if (String(step.key ?? '').toLowerCase() !== 'enter') return false;
      // Enter submits when the focus target is (or is inside) a form.
      return /form|submit/i.test(target);
    }
    if (step.action === 'click') {
      return DESTRUCTIVE_RE.test(target);
    }
    return false;
  }

  /** Does this step still need a real value before it can run? */
  function stepNeedsValue(step) {
    if (!step || typeof step !== 'object') return false;
    if (step.needsValue === true) return true;
    return !!maskInfo(step.value);
  }

  function valueHintFor(step) {
    if (typeof step.valueHint === 'string' && step.valueHint) return step.valueHint;
    const m = maskInfo(step.value);
    return m ? m.valueHint : 'value';
  }

  // ──────── validation ────────

  /**
   * Validate a whole routine, collecting EVERY error (each naming its step) so
   * the user can fix the routine in one pass instead of one error per attempt.
   */
  function validateSteps(steps) {
    const errors = [];
    if (!Array.isArray(steps)) return { ok: false, errors: ['steps must be an array'] };
    if (steps.length === 0) return { ok: false, errors: ['routine has no steps'] };

    steps.forEach((step, i) => {
      const at = `step ${i + 1}`;
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        errors.push(`${at}: not an object`);
        return;
      }

      if (step.selector !== undefined && step.selector !== null &&
          (typeof step.selector !== 'string' || !step.selector.trim())) {
        errors.push(`${at}: selector must be a non-empty string`);
      }
      const selector = typeof step.selector === 'string' ? step.selector.trim() : '';

      const action = step.action;
      if (!action || typeof action !== 'string') {
        errors.push(`${at}: missing action`);
      } else if (!ACTIONS.has(action)) {
        errors.push(`${at}: unknown action "${action}"`);
      } else if (action === 'click') {
        if (!selector) errors.push(`${at}: click requires a selector`);
      } else if (action === 'type' || action === 'select') {
        if (!selector) errors.push(`${at}: ${action} requires a selector`);
        const value = step.value;
        const present =
          (typeof value === 'string' && value.trim() !== '') ||
          (typeof value === 'number' && Number.isFinite(value));
        // A masked step is structurally valid without a value: it is waiting
        // for the user to supply one at replay time.
        if (!present && step.needsValue !== true) {
          errors.push(`${at}: ${action} requires a value (or needsValue: true when it is masked)`);
        }
      } else if (action === 'navigate') {
        const url = typeof step.url === 'string' ? step.url.trim() : '';
        if (!url) {
          errors.push(`${at}: navigate requires a url`);
        } else if (!isSafeNavigateUrl(url)) {
          let parsed = null;
          try { parsed = new URL(url); } catch { /* not a URL at all */ }
          if (!parsed) errors.push(`${at}: navigate url is not a valid absolute URL`);
          else errors.push(`${at}: navigate url must be http(s) — refusing "${parsed.protocol}"`);
        }
      } else if (action === 'press') {
        if (typeof step.key !== 'string' || !step.key.trim()) {
          errors.push(`${at}: press requires a key (e.g. "Enter")`);
        }
      }

      if (step.waitMs !== undefined &&
          (typeof step.waitMs !== 'number' || !Number.isFinite(step.waitMs) || step.waitMs < 0)) {
        errors.push(`${at}: waitMs must be a non-negative number`);
      }
      if (step.needsValue !== undefined && typeof step.needsValue !== 'boolean') {
        errors.push(`${at}: needsValue must be a boolean`);
      }
      if (step.valueHint !== undefined && typeof step.valueHint !== 'string') {
        errors.push(`${at}: valueHint must be a string`);
      }
    });

    return { ok: errors.length === 0, errors };
  }

  // ──────── human-readable description ────────

  /** One numbered line per step; destructive steps are flagged with ⚠. */
  function describeRoutine(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '';
    return steps.map((step, i) => {
      if (!step || typeof step !== 'object') return `${i + 1}. (invalid step)`;

      const masked = stepNeedsValue(step);
      const hint = valueHintFor(step);
      // Show the value quoted so spaces/quotes are unambiguous; masked values
      // are shown as a prompt for the replier instead of the placeholder.
      const shown = masked
        ? `<${hint} required at replay>`
        : JSON.stringify(String(step.value ?? ''));

      let text;
      switch (step.action) {
        case 'click':
          text = `click ${step.selector ?? '?'}`;
          break;
        case 'type':
          text = `type ${shown} into ${step.selector ?? '?'}`;
          break;
        case 'select':
          text = `select ${shown} in ${step.selector ?? '?'}`;
          break;
        case 'navigate':
          text = `navigate to ${step.url ?? '?'}`;
          break;
        case 'press':
          text = step.selector ? `press ${step.key ?? 'Enter'} on ${step.selector}` : `press ${step.key ?? 'Enter'}`;
          break;
        default:
          text = `${String(step.action ?? 'unknown action')}`;
      }

      const wait = (typeof step.waitMs === 'number' && step.waitMs > 0)
        ? ` (wait ${step.waitMs}ms first)` : '';
      const flag = isDestructiveStep(step) ? '⚠ ' : '';
      return `${i + 1}. ${flag}${text}${wait}`;
    }).join('\n');
  }

  // ──────── replay plan ────────

  function clampTimeout(value) {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : DEFAULT_TIMEOUT_MS;
    return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Math.round(base)));
  }

  /** Copy only the contract's fields (drops recorder/bookkeeping leftovers). */
  function sanitiseStep(step) {
    const out = { action: step.action };
    if (typeof step.selector === 'string' && step.selector) out.selector = step.selector;
    if (typeof step.value === 'string') out.value = step.value;
    if (typeof step.url === 'string') out.url = step.url;
    if (typeof step.key === 'string') out.key = step.key;
    if (typeof step.note === 'string' && step.note) out.note = step.note;
    if (typeof step.waitMs === 'number' && Number.isFinite(step.waitMs)) {
      out.waitMs = Math.max(0, Math.min(WAIT_CAP_MS, Math.round(step.waitMs)));
    }
    if (step.needsValue === true) out.needsValue = true;
    if (typeof step.valueHint === 'string' && step.valueHint) out.valueHint = step.valueHint;
    return out;
  }

  /**
   * Validate a routine and return what the executor needs.
   *
   * Throws on an invalid routine — a caller that ignores validation must not be
   * able to start a half-specified replay. `needsValues` lists the 0-based
   * indices of steps still waiting for a user-supplied value (masked fields),
   * so the UI can prompt before replay starts.
   */
  function buildReplayPlan(routine, { defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const steps = Array.isArray(routine) ? routine : (routine && routine.steps);
    const check = validateSteps(steps);
    if (!check.ok) throw new Error(`invalid routine: ${check.errors.join('; ')}`);

    const requested = (routine && !Array.isArray(routine) && routine.timeoutMs !== undefined)
      ? routine.timeoutMs
      : defaultTimeoutMs;

    const needsValues = [];
    const planned = steps.map((step, i) => {
      if (stepNeedsValue(step)) needsValues.push(i);
      return sanitiseStep(step);
    });

    return { steps: planned, timeoutMs: clampTimeout(requested), needsValues };
  }

  window.KyotoRoutine = {
    normaliseEvent,
    toSteps,
    bestSelector,
    isDestructiveStep,
    validateSteps,
    describeRoutine,
    buildReplayPlan
  };
})();
