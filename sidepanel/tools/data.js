// Data tools: TS inference, package registries, search, MiniMax VLM/search.

(() => {
  'use strict';
  const { T, STR, NUM, OBJ } = window.KyotoTR;

  // ──────── JSON → TS ────────
  function inferTSType(value, depth = 0) {
    if (depth > 6) return 'unknown';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      if (!value.length) return 'unknown[]';
      const sample = value.slice(0, 8);
      const types = new Set(sample.map(v => inferTSType(v, depth + 1)));
      return types.size === 1
        ? `${[...types][0]}[]`
        : `(${[...types].join(' | ')})[]`;
    }
    const t = typeof value;
    if (t === 'string') return 'string';
    if (t === 'number') return Number.isInteger(value) ? 'number' : 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'object') return '__object__';
    return 'unknown';
  }
  function mergeShape(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      if (!(k in out)) { out[k] = { ...b[k], optional: true }; continue; }
      out[k] = { type: out[k].type === b[k].type ? out[k].type : `${out[k].type} | ${b[k].type}`, optional: out[k].optional && b[k].optional };
    }
    for (const k of Object.keys(out)) {
      if (!(k in b)) out[k].optional = true;
    }
    return out;
  }
  function collectShapes(value, name, shapes, depth = 0) {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const el of value.slice(0, 8)) collectShapes(el, name, shapes, depth + 1);
      return;
    }
    const shape = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      const t = inferTSType(v);
      if (t === '__object__' && v && !Array.isArray(v)) {
        const childName = name + capitalise(k);
        collectShapes(v, childName, shapes, depth + 1);
        shape[k] = { type: childName, optional: false };
      } else if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
        const childName = name + capitalise(k.replace(/s$/, '')) || (name + capitalise(k));
        collectShapes(v, childName, shapes, depth + 1);
        shape[k] = { type: childName + '[]', optional: false };
      } else {
        shape[k] = { type: t, optional: false };
      }
    }
    shapes.set(name, shapes.has(name) ? mergeShape(shapes.get(name), shape) : shape);
  }
  function capitalise(s) { return s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^([a-z])/, (_, c) => c.toUpperCase()) || 'X'; }
  function renderShapes(shapes) {
    const parts = [];
    for (const [name, shape] of shapes) {
      const lines = [`export interface ${name} {`];
      for (const k of Object.keys(shape)) {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const s = shape[k];
        lines.push(`  ${key}${s.optional ? '?' : ''}: ${s.type};`);
      }
      lines.push('}');
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  T({
    name: 'json_to_typescript',
    group: 'devtools',
    description: 'Infer TypeScript interface definitions from a JSON sample (object or array of objects). Returns a string with the generated `export interface` blocks plus a root type name. Handles nested objects, arrays-of-objects, and merges shapes when multiple samples disagree.',
    parameters: OBJ({ json: {}, rootName: STR }, ['json']),
    handler: async ({ json, rootName = 'Root' } = {}) => {
      let value = json;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
      }
      const safeName = capitalise(rootName) || 'Root';
      const shapes = new Map();
      if (Array.isArray(value)) {
        collectShapes(value, safeName, shapes);
        const root = `export type ${safeName}List = ${safeName}[];`;
        return { types: [renderShapes(shapes), root].filter(Boolean).join('\n\n'), root: `${safeName}List` };
      }
      if (value && typeof value === 'object') {
        collectShapes(value, safeName, shapes);
        return { types: renderShapes(shapes), root: safeName };
      }
      return { types: `export type ${safeName} = ${inferTSType(value)};`, root: safeName };
    }
  });

  // ──────── PACKAGE LOOKUPS ────────
  async function getJson(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r.json();
  }

  T({
    name: 'npm_info',
    group: 'devtools',
    description: 'Look up an npm package: latest version, description, license, repository, homepage, tarball URL, recent versions. Hits registry.npmjs.org (no auth).',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name }) => {
      const d = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      const latest = d['dist-tags']?.latest;
      const v = d.versions?.[latest] || {};
      return {
        name: d.name, latest, description: d.description,
        license: v.license, homepage: v.homepage || d.homepage,
        repository: v.repository?.url || d.repository?.url,
        time: d.time?.[latest],
        recentVersions: Object.keys(d.versions || {}).slice(-15),
        tarball: v.dist?.tarball,
        dependencies: v.dependencies,
        peerDependencies: v.peerDependencies
      };
    }
  });

  T({
    name: 'pypi_info',
    group: 'devtools',
    description: 'Look up a PyPI package: latest version, summary, home/project URLs, license, releases. Hits pypi.org JSON API (no auth).',
    parameters: OBJ({ name: STR }, ['name']),
    handler: async ({ name }) => {
      const d = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      const info = d.info || {};
      return {
        name: info.name, version: info.version,
        summary: info.summary, author: info.author,
        license: info.license,
        home_page: info.home_page,
        project_urls: info.project_urls,
        requires_python: info.requires_python,
        recentReleases: Object.keys(d.releases || {}).slice(-15)
      };
    }
  });

  T({
    name: 'stackoverflow_search',
    group: 'devtools',
    description: 'Search Stack Overflow titles. Returns top matching questions with title, score, answer count, link. Uses the Stack Exchange API (no auth, rate-limited).',
    parameters: OBJ({ query: STR, tagged: STR, limit: NUM }, ['query']),
    handler: async ({ query, tagged, limit = 10 }) => {
      const params = new URLSearchParams({
        order: 'desc', sort: 'relevance',
        intitle: query, site: 'stackoverflow', pagesize: String(Math.min(limit, 30))
      });
      if (tagged) params.set('tagged', tagged);
      const d = await getJson(`https://api.stackexchange.com/2.3/search?${params.toString()}`);
      return {
        total: d.total ?? d.items?.length ?? 0,
        items: (d.items || []).map(it => ({
          title: it.title, score: it.score, answers: it.answer_count, accepted: it.is_answered,
          link: it.link, tags: it.tags, asked: it.creation_date
        }))
      };
    }
  });

  // ──────── MINIMAX ────────
  const MINIMAX_API_BASE = 'https://api.minimax.io';

  async function minimaxKey() {
    const got = await chrome.storage.local.get('apiKeys');
    const k = got.apiKeys?.minimax;
    if (!k) throw new Error('No MiniMax API key in Settings. Add one (Provider = MiniMax) — required for token-plan tools.');
    return k;
  }
  async function minimaxFetch(path, body) {
    const apiKey = await minimaxKey();
    const res = await fetch(MINIMAX_API_BASE + path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'MM-API-Source': 'Kyoto-Extension'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`MiniMax non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown error'}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message || text.slice(0, 200)}`);
    return data;
  }

  async function toDataUrl(input) {
    if (!input) throw new Error('image_url required');
    if (input.startsWith('data:')) return input;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const r = await fetch(input);
      if (!r.ok) throw new Error(`Failed to fetch image: HTTP ${r.status}`);
      const blob = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onloadend = () => res(fr.result);
        fr.onerror = () => rej(new Error('FileReader failed'));
        fr.readAsDataURL(blob);
      });
    }
    throw new Error('image_url must start with http://, https://, or data:');
  }

  T({
    name: 'minimax_web_search',
    group: 'minimax',
    description: 'Web search via MiniMax token-plan (Google-grade results). Returns organic results { title, link, snippet, date } and related search suggestions. Requires a MiniMax API key in Settings — works even if MiniMax is not the active chat provider. Best with 3–5 keyword queries; include the year for time-sensitive topics.',
    parameters: OBJ({ query: STR }, ['query']),
    handler: async ({ query }) => {
      if (!query || !query.trim()) throw new Error('query required');
      const data = await minimaxFetch('/v1/coding_plan/search', { q: query });
      return { organic: data.organic || [], related_searches: data.related_searches || [] };
    }
  });

  T({
    name: 'minimax_understand_image',
    group: 'minimax',
    description: 'Vision/VLM analysis via MiniMax token-plan. Pass a `prompt` describing what to extract and an `image_url` (http(s) URL or data URL). Supports JPEG/PNG/WebP. Returns a text description. For analyzing the current tab, prefer `minimax_describe_tab` which avoids round-tripping a large base64 string through the conversation.',
    parameters: OBJ({ prompt: STR, image_url: STR }, ['prompt', 'image_url']),
    handler: async ({ prompt, image_url }) => {
      if (!prompt) throw new Error('prompt required');
      const dataUrl = await toDataUrl(image_url);
      const data = await minimaxFetch('/v1/coding_plan/vlm', { prompt, image_url: dataUrl });
      return { content: data.content || '' };
    }
  });

  T({
    name: 'minimax_describe_tab',
    group: 'minimax',
    description: 'Capture a screenshot of a tab (default: active tab in this window; pass `tabId` to target a specific tab) and analyze it via MiniMax VLM in one tool call. Use for "what is on this page", OCR, layout analysis, accessibility checks. Returns only the model\'s text — the screenshot data URL never enters the conversation, so this is the cheap way to do tab-level vision.',
    parameters: OBJ({
      prompt: STR,
      format: { type: 'string', enum: ['jpeg', 'png'] },
      quality: NUM,
      tabId: { type: 'number' }
    }, ['prompt']),
    handler: async ({ prompt, format = 'jpeg', quality = 80, tabId }) => {
      if (!prompt) throw new Error('prompt required');
      const { activeTab } = window.KyotoTR;
      tabId = tabId ?? (await activeTab()).id;
      let windowId;
      try { windowId = (await chrome.tabs.get(tabId))?.windowId; } catch {}
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && !t.active) await chrome.tabs.update(tabId, { active: true });
      } catch {}
      const dataUrl = windowId != null
        ? await chrome.tabs.captureVisibleTab(windowId, { format, quality })
        : await chrome.tabs.captureVisibleTab({ format, quality });
      const data = await minimaxFetch('/v1/coding_plan/vlm', { prompt, image_url: dataUrl });
      return { content: data.content || '', screenshotBytes: dataUrl.length, tabId };
    }
  });
})();
