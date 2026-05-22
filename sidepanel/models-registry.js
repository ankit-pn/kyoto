// Pulls model metadata (context window, max output tokens) from
// models.dev/api.json — the same registry that sst/opencode uses.
// Cached in chrome.storage.local with a 24h TTL and ETag revalidation.
// Falls back to a small static table for cold start / network failure.
//
// window.KyotoModels:
//   await init()              -> boolean (have data)
//   get(provider, modelId)    -> { context, output, name } | null
//   maxOutput(provider, id)   -> number (output token cap, with fallback)
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
          name: m.name || modelId,
          source: 'models.dev'
        };
      }
    }
    const s = STATIC[provider]?.[modelId] || STATIC[provider]?._default;
    if (s) return { ...s, name: modelId, source: 'static' };
    return null;
  }

  function maxOutput(provider, modelId, fallback = 8192) {
    const info = get(provider, modelId);
    return info?.output || fallback;
  }
  function contextLength(provider, modelId) {
    return get(provider, modelId)?.context || null;
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
    contextLength,
    formatN,
    getRegistry: () => registry,
    lastFetchedAt: () => lastFetchedAt
  };
})();
