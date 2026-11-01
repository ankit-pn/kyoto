// Context management — decides when a conversation is about to overflow the
// model's context window and how to compact it safely.
//
// Loaded before sidepanel.js as a plain IIFE that attaches `window.KyotoContext`.
// Every export is a PURE function (no chrome.*, no DOM) so the cut-point logic
// — the part that silently corrupts a transcript when it is wrong — can be
// unit-tested in node. See test/context.test.js.
//
// Why this exists: an agent session grows monotonically. Tool results are
// large, and once the transcript exceeds the model's context window every
// subsequent request fails with a hard 400 from the provider. The agent then
// looks "broken" even though nothing is wrong with the task. Compaction folds
// the older half of the transcript into a summary and keeps the recent turns
// verbatim.
//
// The dangerous part is choosing the cut point. Chat APIs require that an
// assistant message carrying `tool_calls` is immediately followed by a `tool`
// message for every call id. Cutting in the middle of such a group produces a
// transcript that every OpenAI-compatible server rejects. So the cut is only
// ever placed immediately before a `user` message, which by construction
// starts a fresh group.

(() => {
  'use strict';

  // Rough token estimate. Deliberately pessimistic: we would rather compact a
  // little early than hit a hard 400. ~4 chars/token is the usual English
  // heuristic; JSON-heavy tool output skews lower, hence the 3.6 divisor.
  const CHARS_PER_TOKEN = 3.6;
  // Fixed per-message overhead (role markers, separators).
  const PER_MESSAGE_TOKENS = 4;

  function messageText(m) {
    if (!m) return '';
    const c = m.content;
    let s = '';
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (typeof p === 'string') s += p;
        else if (p && p.type === 'text') s += p.text || '';
        else if (p && p.type === 'image_url') s += ' [image] ';
      }
    } else if (c && typeof c === 'object') {
      try { s = JSON.stringify(c); } catch { s = ''; }
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        s += (tc?.function?.name || '') + (tc?.function?.arguments || '');
      }
    }
    if (typeof m.reasoning === 'string') s += m.reasoning;
    return s;
  }

  /** Estimated prompt tokens for a transcript. */
  function estimateTokens(history) {
    if (!Array.isArray(history)) return 0;
    let chars = 0;
    for (const m of history) chars += messageText(m).length;
    return Math.ceil(chars / CHARS_PER_TOKEN) + history.length * PER_MESSAGE_TOKENS;
  }

  function isPinned(m) { return !!(m && m._pinned); }
  function hasToolCalls(m) { return Array.isArray(m?.tool_calls) && m.tool_calls.length > 0; }

  /**
   * Find a safe cut point: the index of the `keepTurns`-th most recent user
   * message. Everything before it is summarised; everything from it onward is
   * kept verbatim.
   *
   * A cut immediately before a `user` message is always structurally safe: no
   * `tool` message can be orphaned, because tool results always sit between the
   * assistant turn that requested them and the next user turn.
   *
   * Returns -1 when no safe cut exists (e.g. the history has fewer user turns
   * than we want to keep).
   */
  function findCutIndex(history, keepTurns) {
    if (!Array.isArray(history) || history.length === 0) return -1;
    let seen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role !== 'user') continue;
      seen++;
      if (seen === keepTurns) return i;
    }
    return -1;
  }

  /**
   * Decide whether/how to compact.
   *
   * @param {Array} history
   * @param {{contextTokens?:number, threshold?:number, keepTurns?:number,
   *          force?:boolean, minDropped?:number}} opts
   * @returns {null | {cutIndex:number, droppedCount:number, keptCount:number,
   *                   pinned:Array, tokensBefore:number, tokensAfterEstimate:number}}
   */
  function planCompaction(history, opts = {}) {
    const {
      contextTokens = 128000,
      threshold = 0.75,
      keepTurns = 6,
      force = false,
      minDropped = 3
    } = opts;

    if (!Array.isArray(history) || history.length < 2) return null;

    const tokensBefore = estimateTokens(history);
    const budget = Math.max(1, contextTokens) * Math.max(0.1, Math.min(0.95, threshold));
    if (!force && tokensBefore < budget) return null;

    const cutIndex = findCutIndex(history, Math.max(1, keepTurns));
    // Nothing safe to drop, or dropping would not help.
    if (cutIndex <= 0) return null;
    if (cutIndex < minDropped) return null;

    const dropped = history.slice(0, cutIndex);
    const kept = history.slice(cutIndex);
    // Pinned messages survive compaction — that is the point of pinning.
    const pinned = dropped.filter(isPinned);

    // Estimate the post-compaction size: kept turns + a summary of roughly
    // 1/20th of the dropped text, floored at ~120 tokens.
    const summaryTokens = Math.max(120, Math.ceil(estimateTokens(dropped) / 20));
    const tokensAfterEstimate = estimateTokens(kept) + summaryTokens;

    // Refuse a compaction that would not meaningfully help.
    if (!force && tokensAfterEstimate >= tokensBefore * 0.9) return null;

    return {
      cutIndex,
      droppedCount: dropped.length,
      keptCount: kept.length,
      pinned,
      tokensBefore,
      tokensAfterEstimate
    };
  }

  /**
   * Build the new transcript: a single "compacted" user turn carrying the
   * summary, then any pinned messages that were dropped, then the verbatim
   * recent turns.
   *
   * The summary is inserted as a USER message rather than a system message:
   * providers disagree about system messages appearing mid-conversation.
   */
  function buildCompactedHistory(history, plan, summaryText) {
    if (!plan || plan.cutIndex <= 0) return history;
    const summary = String(summaryText || '').trim() || '(no summary available)';
    const header =
      `[Earlier conversation compacted: ${plan.droppedCount} messages summarised ` +
      `to stay inside the model's context window. This summary is authoritative ` +
      `for what happened before this point.]`;
    const recap = { role: 'user', content: `${header}\n\n${summary}` };
    const pinned = (plan.pinned || []).filter(m => m && m.role !== 'user');
    const tail = history.slice(plan.cutIndex);
    return [recap, ...pinned, ...tail];
  }

  /**
   * Deterministic last-resort summary used when the model call fails: pull the
   * user's own words plus the names of tools that ran. Loses nuance but never
   * leaves the transcript in a broken state.
   */
  function fallbackSummary(history, plan) {
    const dropped = Array.isArray(history) ? history.slice(0, plan?.cutIndex ?? 0) : [];
    const users = [];
    const tools = new Set();
    for (const m of dropped) {
      if (m?.role === 'user' && typeof m.content === 'string') {
        const line = m.content.replace(/\s+/g, ' ').trim();
        if (line) users.push(line.slice(0, 200));
      }
      for (const tc of (m?.tool_calls || [])) {
        if (tc?.function?.name) tools.add(tc.function.name);
      }
      if (m?.role === 'tool' && m.name) tools.add(m.name);
    }
    const parts = [];
    if (users.length) {
      parts.push('Earlier requests from the user, in order:');
      for (const u of users.slice(-12)) parts.push(`- ${u}`);
    }
    if (tools.size) parts.push(`Tools used earlier: ${[...tools].slice(0, 20).join(', ')}.`);
    return parts.join('\n') || '(earlier conversation omitted)';
  }

  /** Prompt used to summarise the dropped range. */
  function summarisePrompt(history, plan) {
    const dropped = Array.isArray(history) ? history.slice(0, plan?.cutIndex ?? 0) : [];
    const lines = [];
    for (const m of dropped) {
      const role = m?.role || '?';
      const text = messageText(m).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Keep tool chatter short: names matter, bulk payloads do not.
      const cap = role === 'tool' ? 300 : 900;
      lines.push(`${role}: ${text.slice(0, cap)}`);
    }
    return (
      'Summarise the conversation below so another assistant can continue the work without seeing it. ' +
      'Preserve, in this order and as compactly as possible:\n' +
      '1. The user\'s goal and any constraints they stated.\n' +
      '2. Decisions made and approaches already RULED OUT (so they are not retried).\n' +
      '3. Concrete facts learned: URLs, file paths, selectors, API endpoints, credentials-free identifiers, error messages.\n' +
      '4. What was in progress and what the next step should be.\n' +
      'Omit pleasantries and redundant tool output. Use terse bullets. Do not invent anything.\n\n' +
      '--- CONVERSATION ---\n' + lines.join('\n') + '\n--- END ---'
    );
  }

  /**
   * Parse the Settings fallback textarea: one candidate per line, formatted
   * `provider:model`. The FIRST colon separates them because provider ids may
   * contain '-' and model ids contain '/' (e.g.
   * `openrouter:anthropic/claude-3.5-haiku`, `opencode-go:glm-5.3`).
   * Blank lines and `#` comments are ignored; duplicates are dropped.
   */
  function parseFallbackChain(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split('\n');
    const out = [];
    const seen = new Set();
    for (const line of raw) {
      const t = String(line || '').trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf(':');
      if (idx <= 0) continue;
      const provider = t.slice(0, idx).trim();
      const model = t.slice(idx + 1).trim();
      if (!provider || !model) continue;
      const key = `${provider}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, model });
    }
    return out;
  }

  /** Does an error look worth retrying on another model? */
  function isRetryableError(message) {
    const s = String(message || '');
    // Context overflow: another model with a bigger window often helps.
    if (/\bcontext (length|window)\b|too many tokens|maximum context/i.test(s)) return true;
    if (/\bHTTP (429|500|502|503|504)\b/.test(s)) return true;
    if (/rate limit|overloaded|temporarily unavailable|server error|bad gateway|timed out|fetch failed|network/i.test(s)) return true;
    // Upstream provider failures are worth another try; auth/quota are not.
    if (/stream error|provider disconnected|server_error/i.test(s)) return true;
    return false;
  }

  window.KyotoContext = {
    estimateTokens,
    findCutIndex,
    planCompaction,
    buildCompactedHistory,
    fallbackSummary,
    summarisePrompt,
    isRetryableError,
    parseFallbackChain,
    CHARS_PER_TOKEN
  };
})();
