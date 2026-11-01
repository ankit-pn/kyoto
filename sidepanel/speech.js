// Voice input state machine + chunking helpers for the Web Speech API.
//
// Loaded before sidepanel.js as `window.KyotoSpeech`; PURE (no chrome.*, no
// document, no SpeechRecognition). sidepanel.js owns the recognition object,
// the microphone button and the UI; this module owns the two pieces that are
// easy to get wrong:
//
// 1. reduceSpeech — browsers deliver *incremental* results. An `interim` result
//    is the current hypothesis for an utterance the user has not finished; the
//    engine RESENDS THE WHOLE HYPOTHESIS on every event, so it must replace the
//    previous interim, never append to it (appending is the classic "hello hello
//    hello wor" bug). A `final` result is committed once, but Chrome can
//    re-deliver the same final result (e.g. after the recognizer restarts), so
//    a repeated identical final must not be appended a second time.
//
// 2. chunkForSpeech — Chrome's speechSynthesis truncates or drops very long
//    utterances, so long replies are spoken in sentence-sized pieces. Splitting
//    mid-word makes the voice pause in the middle of a word, so the splitter
//    only breaks at sentence boundaries, then whitespace, and keeps a single
//    word that is longer than the limit intact (see below).
//
// reduceSpeech is immutable: it always returns a new state object and never
// touches the one it was given. sidepanel.js can therefore keep the previous
// state around for rendering/diffing without defensive copies.

(() => {
  'use strict';

  const DEFAULT_MAX_CHARS = 220;

  function toText(value) {
    if (typeof value === 'string') return value;
    return value == null ? '' : String(value);
  }

  // Collapse runs of whitespace and trim. Used for committed text (so the
  // transcript can never contain double spaces) and for chunking input.
  function normaliseSpoken(value) {
    return toText(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Can this scope do speech recognition? Checks the standards name and the
   * legacy webkit-prefixed one. Accepts an explicit scope so tests (and any
   * future non-window caller) can pass a fake; defaults to globalThis.
   */
  function supportsSpeech(scope = globalThis) {
    if (!scope || typeof scope !== 'object') return false;
    return Boolean(scope.SpeechRecognition || scope.webkitSpeechRecognition);
  }

  function initialState() {
    return { finalText: '', interim: '', listening: false, error: null };
  }

  /** Space-join two committed fragments, guaranteeing exactly one separator. */
  function joinFinal(existing, addition) {
    const a = normaliseSpoken(existing);
    const b = normaliseSpoken(addition);
    if (!b) return a;
    if (!a) return b;
    return `${a} ${b}`;
  }

  // Has `text` already been committed as the trailing utterance? The state
  // shape is fixed (`finalText, interim, listening, error`) and we deliberately
  // do not add a hidden "lastFinal" field to it, so the previous utterance is
  // recovered from finalText: either it IS the whole transcript, or it is the
  // last space-separated segment. Comparison is case-insensitive because a
  // re-run final pass can capitalise the same hypothesis differently.
  //
  // Trade-off (accepted): if the user really says the same word twice in a row
  // after a pause, the second one is dropped. Spurious duplication corrupts the
  // transcript invisibly; a dropped repeated word is visible and the user can
  // just say it again.
  function isDuplicateFinal(finalText, text) {
    const existing = normaliseSpoken(finalText);
    const incoming = normaliseSpoken(text);
    if (!existing || !incoming) return false;
    const a = existing.toLowerCase();
    const b = incoming.toLowerCase();
    return a === b || a.endsWith(` ${b}`);
  }

  /**
   * Apply one speech event, returning a NEW state.
   *
   * Events:
   *   {type:'start'}                 -> listening: true, error: null
   *   {type:'interim', text}         -> interim REPLACES (engine resends it)
   *   {type:'final', text}           -> append to finalText, clear interim
   *   {type:'error', message}        -> listening: false, error set, text kept
   *   {type:'end'}                   -> listening: false, text kept
   *   {type:'reset'}                 -> initialState()
   *
   * @param {{finalText?:string,interim?:string,listening?:boolean,error?:string|null}} state
   * @param {{type:string, text?:string, message?:string}} event
   * @returns {{finalText:string, interim:string, listening:boolean, error:string|null}}
   */
  function reduceSpeech(state, event) {
    const base = state && typeof state === 'object' ? state : initialState();
    const next = {
      finalText: typeof base.finalText === 'string' ? base.finalText : '',
      interim: typeof base.interim === 'string' ? base.interim : '',
      listening: base.listening === true,
      error: base.error == null ? null : String(base.error)
    };

    const type = event && typeof event === 'object' ? event.type : '';

    switch (type) {
      case 'start':
        // A new recognition session starts clean of the previous error, but
        // keeps any text the user already committed.
        return { ...next, listening: true, error: null };

      case 'interim':
        // REPLACE, never append: every interim event carries the full current
        // hypothesis for this utterance.
        return { ...next, interim: toText(event.text) };

      case 'final': {
        const text = normaliseSpoken(event.text);
        // An empty final carries no words; just drop the stale hypothesis.
        if (!text) return { ...next, interim: '' };
        // Re-delivered final (recognizer restart): committing it again would
        // duplicate the phrase in the transcript.
        if (isDuplicateFinal(next.finalText, text)) return { ...next, interim: '' };
        return {
          ...next,
          finalText: joinFinal(next.finalText, text),
          interim: '' // the hypothesis is now committed text
        };
      }

      case 'error':
        // Microphone/permission/network errors end the session. Text already
        // committed is preserved; an in-flight interim is left untouched so the
        // UI can show exactly what was heard before the failure.
        return {
          ...next,
          listening: false,
          error: normaliseSpoken(event.message) || 'speech recognition error'
        };

      case 'end':
        // The engine stopped on its own (silence, tab hidden, stop()). Text the
        // user already produced is the whole point of recognition — keep it.
        return { ...next, listening: false };

      case 'reset':
        return initialState();

      default:
        // Unknown event: hand back a copy so callers can always treat
        // reduceSpeech as "returns new state".
        return next;
    }
  }

  // Split on sentence-ending punctuation, keeping the terminator and any
  // closing quotes/brackets attached to the sentence. Split only when the
  // punctuation is followed by whitespace or end-of-text, so decimals ("3.14")
  // and ellipses ("...") do not produce fragments.
  function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (!/[.!?]/.test(text[i])) continue;
      let j = i + 1;
      while (j < text.length && /["'\u201d\u2019)\]]/.test(text[j])) j++;
      if (j >= text.length || text[j] === ' ') {
        out.push(text.slice(start, j));
        start = j;
        i = j - 1;
      }
    }
    if (start < text.length) out.push(text.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  }

  // Whitespace fallback: greedy word packing. Never breaks a word.
  function splitWords(text, maxChars) {
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (!word) continue;
      if (word.length > maxChars) {
        // A single word longer than maxChars cannot be divided without being
        // corrupted (and the engine would speak the syllables as nonsense).
        // Return it whole: one over-long chunk is better than silently losing
        // the user's word or emitting garbage.
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word);
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    return out;
  }

  /**
   * Split text into chunks of at most `maxChars` characters for speech.
   *
   * Preference order: sentence boundary -> whitespace -> (only as a last
   * resort) an indivisible word longer than the limit, which is returned as its
   * own over-long chunk. Empty chunks are never returned; already-short text
   * comes back as a single chunk.
   *
   * @param {string} text
   * @param {number} [maxChars=220]
   * @returns {string[]}
   */
  function chunkForSpeech(text, maxChars = DEFAULT_MAX_CHARS) {
    const requested = Number(maxChars);
    const max =
      Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : DEFAULT_MAX_CHARS;

    const clean = normaliseSpoken(text);
    if (!clean) return [];
    if (clean.length <= max) return [clean];

    const chunks = [];
    let current = '';
    const flush = () => {
      if (current) {
        chunks.push(current);
        current = '';
      }
    };

    for (const sentence of splitSentences(clean)) {
      if (sentence.length > max) {
        // Too long to keep as a sentence: fall back to word packing.
        flush();
        for (const piece of splitWords(sentence, max)) chunks.push(piece);
        continue;
      }
      if (!current) current = sentence;
      else if (current.length + 1 + sentence.length <= max) current += ` ${sentence}`;
      else {
        flush();
        current = sentence;
      }
    }
    flush();

    return chunks;
  }

  window.KyotoSpeech = {
    supportsSpeech,
    initialState,
    reduceSpeech,
    chunkForSpeech
  };
})();
