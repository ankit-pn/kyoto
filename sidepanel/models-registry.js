// Pulls model metadata (context window, max output tokens) from
// models.dev/api.json — the same registry that sst/opencode uses.
// Cached in chrome.storage.local with a 24h TTL and ETag revalidation.
// Falls back to a small static table for cold start / network failure.
//
// window.KyotoModels:
//   await init()              -> boolean (have data)
//   get(provider, modelId)    -> { context, output, name } | null
//   maxOutput(provider, id)   -> number (output token cap, with fallback)
//   resolveMaxOutput(p, id, requested) -> number (auto when requested <= 0)
//   contextLength(provider, id) -> number | null
//   getRegistry()             -> raw models.dev object

(() => {
  'use strict';

  const URL = 'https://models.dev/api.json';
  const CACHE_KEY = 'kyoto_models_dev_cache';
  const TTL_MS = 24 * 60 * 60 * 1000;

  // Conservative static fallback (only used until the live registry
  // fetch completes on first run, or if models.dev is unreachable).
  const STATIC = {
    openrouter: {
      _default: { context: 128000, output: 8192 }
    },
    'opencode-go': {
      // Cold-start defaults only — the public /models catalogue replaces
      // these as soon as the provider's key is present (see register()).
      'glm-5.3':       { context: 1000000, output: 131072 },
      'deepseek-v4.1-flash': { context: 1000000, output: 384000 },
      _default:        { context: 200000,  output: 32768 }
    },
    deepseek: {
      'deepseek-chat':     { context: 128000, output: 8192 },
      'deepseek-reasoner': { context: 64000,  output: 8192 },
      _default:            { context: 64000,  output: 8192 }
    },
    minimax: {
      'MiniMax-M2':        { context: 204800, output: 8192 },
      'MiniMax-M2.1':      { context: 204800, output: 131072 },
      'MiniMax-Text-01':   { context: 1000000, output: 8192 },
      'abab6.5s-chat':     { context: 245760, output: 8192 },
      _default:            { context: 64000,  output: 8192 }
    }
  };

  let registry = null;
  let lastFetchedAt = 0;

  // Per-provider metadata parsed from a provider's own /models endpoint.
  // This is the freshest source for limits, vision and pricing — models.dev
  // lags behind new releases, and some providers (OpenCode Go) carry
  // capability flags that models.dev does not model at all.
  // provider -> Map(modelId -> {context, maxOutput, modalities, reasoning, pricing, ...})
  const catalogue = new Map();

  function register(provider, list) {
    if (!provider) return;
    const map = new Map();
    for (const item of list || []) {
      const id = item?.id || item?.model || item?.name;
      if (!id) continue;
      map.set(String(id), item);
    }
    if (map.size) catalogue.set(provider, map);
  }

  async function loadCache() {
    const g = await chrome.storage.local.get(CACHE_KEY);
    return g[CACHE_KEY] || null;
  }
  async function saveCache(payload, etag) {
    lastFetchedAt = Date.now();
    await chrome.storage.local.set({
      [CACHE_KEY]: { payload, etag: etag || null, fetchedAt: lastFetchedAt }
    });
  }

  async function fetchFresh(etag) {
    const headers = { 'Accept': 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(URL, { headers });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const newEtag = res.headers.get('ETag') || null;
    const data = await res.json();
    return { payload: data, etag: newEtag };
  }

  async function init({ force = false } = {}) {
    try {
      const cached = await loadCache();
      const stale = !cached || (Date.now() - (cached.fetchedAt || 0) > TTL_MS);
      if (cached?.payload) {
        registry = cached.payload;
        lastFetchedAt = cached.fetchedAt || 0;
      }
      if (force || stale) {
        try {
          const r = await fetchFresh(cached?.etag);
          if (r.notModified && cached) {
            await saveCache(cached.payload, cached.etag);
          } else if (r.payload) {
            registry = r.payload;
            await saveCache(r.payload, r.etag);
          }
        } catch (e) {
          // ignore — cached value (or static fallback) keeps us alive
          console.warn('[Kyoto] models.dev fetch failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[Kyoto] models registry init failed:', e.message);
    }
    return !!registry;
  }

  function get(provider, modelId) {
    if (!modelId) return null;
    if (registry) {
      const p = registry[provider];
      const m = p?.models?.[modelId];
      if (m) {
        return {
          context: m.limit?.context,
          output: m.limit?.output,
          cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
          name: m.name || modelId,
          modalities: m.modalities || null,
          source: 'models.dev'
        };
      }
    }
    // The provider's own catalogue beats our static table: it is the only
    // source that knows about models released after this extension shipped.
    const pm = catalogue.get(provider)?.get(modelId);
    if (pm) {
      return {
        context: pm.context ?? null,
        output: pm.maxOutput ?? null,
        cost: pm.pricing ? { input: pm.pricing.prompt, output: pm.pricing.completion } : null,
        name: pm.name || modelId,
        modalities: pm.modalities || null,
        reasoning: pm.reasoning || null,
        supportsTools: pm.supportsTools !== false,
        source: 'catalogue'
      };
    }
    const s = STATIC[provider]?.[modelId] || STATIC[provider]?._default;
    if (s) return { ...s, name: modelId, source: 'static' };
    return null;
  }

  // Reasoning capability for the active model, from whichever source knows.
  // Returns {supported, efforts[], defaultEffort, mandatory} or null.
  function reasoningFor(provider, modelId) {
    const direct = catalogue.get(provider)?.get(modelId)?.reasoning;
    if (direct) return direct;
    return get(provider, modelId)?.reasoning || null;
  }

  // Does this model accept image inputs in its prompt? Falls back to
  // provider-aware heuristics when models.dev hasn't loaded or doesn't
  // list modalities. The caller uses this to hide redundant external
  // VLM tools (minimax_describe_tab, minimax_understand_image) when
  // the chosen model can see images natively.
  function supportsVision(provider, modelId) {
    if (!modelId) return false;
    const info = get(provider, modelId);
    const mods = info?.modalities?.input;
    if (Array.isArray(mods)) return mods.includes('image');
    // Heuristic fallback — biased to recall (true) over precision so we
    // don't expose duplicate tools by mistake. The rule: any model
    // from a provider where the current line is multimodal-by-default.
    const id = String(modelId).toLowerCase();
    // Codex models DON'T accept images even though their gpt-5 prefix
    // would otherwise match — exclude before the prefix tests.
    if (/codex/i.test(id)) return false;
    if (provider === 'openai') {
      // Every chat model OpenAI currently ships accepts images. The
      // deprecated text-only ones (gpt-3.5-turbo, text-davinci, etc.)
      // are out of the picker entirely.
      return /^(gpt-[45]|gpt-5|o[134])/.test(id);
    }
    if (provider === 'openrouter') {
      // OpenRouter passes through; inspect the slug.
      return /openai\/gpt-(4o|4\.1|5)|anthropic\/claude-(3\.5|3\.7|4)|google\/gemini|mistralai\/pixtral|meta-llama\/llama-3\.2(?!-1b|-3b)/.test(id);
    }
    if (provider === 'minimax') {
      return /vl|vision/.test(id);
    }
    // DeepSeek + most others: text-only by default.
    return false;
  }

  function maxOutput(provider, modelId, fallback = 8192) {
    const info = get(provider, modelId);
    return info?.output || fallback;
  }
  /**
   * How many output tokens to actually request.
   *
   * `requested <= 0` means AUTO: use the model's documented cap. That is the
   * entire point of reading models.dev — knowing a model can write 384K and then
   * asking for 8K regardless is a bug, not caution. An explicit value is honoured
   * but never exceeds what the model supports, because asking for more is a 400.
   *
   * The old hardcoded 8 192 default made every modern model run at 1/47th of its
   * capability unless the user went looking for this field.
   */
  function resolveMaxOutput(provider, modelId, requested, { fallback = 8192 } = {}) {
    const modelMax = get(provider, modelId)?.output || fallback;
    const n = Number(requested);
    // Auto when absent/empty/zero/negative/NaN — the user's intent is "the model's max".
    const want = Number.isFinite(n) && n > 0 ? n : modelMax;
    // Never below a usable floor, never above what the model reports.
    return Math.max(64, Math.min(want, modelMax));
  }

  function contextLength(provider, modelId) {
    return get(provider, modelId)?.context || null;
  }

  // usage = { prompt_tokens, completion_tokens } (OpenAI shape)
  // returns USD cost as a number, or null when unknown
  function costFor(provider, modelId, usage) {
    if (!usage) return null;
    const info = get(provider, modelId);
    if (!info?.cost) return null;
    const inUsd = (usage.prompt_tokens || 0) * (info.cost.input || 0) / 1_000_000;
    const outUsd = (usage.completion_tokens || 0) * (info.cost.output || 0) / 1_000_000;
    return inUsd + outUsd;
  }

  function formatUsd(n) {
    if (n == null) return '';
    if (n === 0) return '$0';
    if (n < 0.0001) return '<$0.0001';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  function formatN(n) {
    if (!n) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  }

  window.KyotoModels = {
    init,
    get,
    maxOutput,
    resolveMaxOutput,
    contextLength,
    costFor,
    supportsVision,
    reasoningFor,
    register,
    formatN,
    formatUsd,
    getRegistry: () => registry,
    lastFetchedAt: () => lastFetchedAt
  };
})();
