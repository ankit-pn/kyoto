// Cross-session memory + remote skill hub + ask_user UI primitive.
// Also exposes window.KyotoSkillHub for direct use by sidepanel.js.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ } = window.KyotoTR;

  // ──────── MEMORY (cross-session) ────────
  const MEM_INDEX_KEY = 'kyoto_memory_index';
  const MEM_KEY = (id) => `kyoto_memory_${id}`;
  function memNewId() { return 'mem_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  async function memLoadIndex() {
    const g = await chrome.storage.local.get(MEM_INDEX_KEY);
    return g[MEM_INDEX_KEY] || [];
  }
  async function memWriteIndex(idx) { await chrome.storage.local.set({ [MEM_INDEX_KEY]: idx }); }

  // C5: serialise every read-modify-write of the shared memory index.
  // Tool calls from one assistant turn run concurrently (sidepanel.js
  // dispatches them with Promise.all), so two `memory_add` calls can both
  // memLoadIndex() before either memWriteIndex() — the last write wins and
  // the sibling's index entry is lost, orphaning the record forever (the
  // per-memory key is unique, so the tool still reports success). A single
  // in-process promise chain is enough: all tool calls run in this one
  // extension context. The chain swallows errors so one failed mutation
  // can't wedge every later one.
  let memIndexLock = Promise.resolve();
  function memWithIndexLock(fn) {
    const run = memIndexLock.then(fn, fn);
    memIndexLock = run.then(() => {}, () => {});
    return run;
  }

  T({
    name: 'memory_add',
    group: 'memory',
    description: 'Save a long-lived note that will be available in every future session. Use for: user preferences, repeated context, useful snippets, API keys / URLs the user names, important facts. Returns the new memory id.',
    parameters: OBJ({
      title: STR, content: STR, tags: { type: 'array', items: STR }
    }, ['title', 'content']),
    handler: async ({ title, content, tags = [] }) => {
      const id = memNewId();
      const now = Date.now();
      const record = { id, title, content, tags, createdAt: now, updatedAt: now };
      await chrome.storage.local.set({ [MEM_KEY(id)]: record });
      await memWithIndexLock(async () => {
        const idx = await memLoadIndex();
        idx.unshift({ id, title, tags, createdAt: now, updatedAt: now });
        await memWriteIndex(idx);
      });
      return { id, saved: true };
    }
  });

  T({
    name: 'memory_list',
    group: 'memory',
    description: 'List all saved memories (metadata only — id, title, tags, timestamps). Use this first to see what is available before reading.',
    parameters: OBJ({ limit: NUM }),
    handler: async ({ limit = 200 } = {}) => {
      const idx = await memLoadIndex();
      return { total: idx.length, items: idx.slice(0, limit) };
    }
  });

  T({
    name: 'memory_get',
    group: 'memory',
    description: 'Read the full content of a memory by id.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => {
      const g = await chrome.storage.local.get(MEM_KEY(id));
      return g[MEM_KEY(id)] || { error: 'not found' };
    }
  });

  T({
    name: 'memory_search',
    group: 'memory',
    description: 'Simple case-insensitive substring search across memory titles, tags, and content. Returns matching memory metadata.',
    parameters: OBJ({ query: STR, limit: NUM }, ['query']),
    handler: async ({ query, limit = 20 }) => {
      const q = query.toLowerCase();
      const idx = await memLoadIndex();
      const matches = [];
      for (const meta of idx) {
        if (meta.title.toLowerCase().includes(q) || (meta.tags || []).some(t => t.toLowerCase().includes(q))) {
          matches.push({ ...meta, _hit: 'title/tags' });
          continue;
        }
        const g = await chrome.storage.local.get(MEM_KEY(meta.id));
        const full = g[MEM_KEY(meta.id)];
        if (full?.content?.toLowerCase().includes(q)) matches.push({ ...meta, _hit: 'content' });
        if (matches.length >= limit) break;
      }
      return { total: matches.length, items: matches };
    }
  });

  T({
    name: 'memory_update',
    group: 'memory',
    description: 'Update fields of an existing memory. Any field omitted is preserved.',
    parameters: OBJ({ id: STR, title: STR, content: STR, tags: { type: 'array', items: STR } }, ['id']),
    handler: async ({ id, title, content, tags }) => {
      const g = await chrome.storage.local.get(MEM_KEY(id));
      const current = g[MEM_KEY(id)];
      if (!current) return { error: 'not found' };
      if (title !== undefined) current.title = title;
      if (content !== undefined) current.content = content;
      if (tags !== undefined) current.tags = tags;
      current.updatedAt = Date.now();
      await chrome.storage.local.set({ [MEM_KEY(id)]: current });
      await memWithIndexLock(async () => {
        const idx = await memLoadIndex();
        const i = idx.findIndex(m => m.id === id);
        if (i >= 0) {
          idx[i] = { id, title: current.title, tags: current.tags, createdAt: current.createdAt, updatedAt: current.updatedAt };
          await memWriteIndex(idx);
        }
      });
      return { id, updated: true };
    }
  });

  T({
    name: 'memory_delete',
    group: 'memory',
    description: 'Delete a memory by id.',
    parameters: OBJ({ id: STR }, ['id']),
    handler: async ({ id }) => {
      await chrome.storage.local.remove(MEM_KEY(id));
      await memWithIndexLock(async () => {
        const idx = await memLoadIndex();
        await memWriteIndex(idx.filter(m => m.id !== id));
      });
      return { id, deleted: true };
    }
  });

  // ──────── SKILL HUB ────────
  async function _skillsConfig() {
    const g = await chrome.storage.local.get(['skillsHubUrl', 'skillsHubKey']);
    const raw = ((g.skillsHubUrl ?? '') + '').trim();
    if (/^(off|disabled|disable|none|no)$/i.test(raw)) return { url: '', key: '' };
    const def = window.KYOTO_DEFAULT_SKILLS_HUB || { url: '', key: '' };
    const url = ((raw || def.url || '') + '').replace(/\/+$/, '');
    // C15: the shipped default key is a placeholder, never a credential.
    // sidepanel.js seeds it into Settings defaults, so it can also appear
    // as a stored `skillsHubKey`; both forms mean "no key configured".
    const placeholder = def.keyIsPlaceholder ? ((def.key || '') + '') : '';
    const stored = ((g.skillsHubKey || '') + '').trim();
    const key = stored && stored !== placeholder
      ? stored
      : (placeholder ? '' : ((def.key || '') + ''));
    return { url, key };
  }

  // C15: the `global` partition is remote content writable through the
  // (previously baked-in, shared) hub key, and sidepanel.js auto-injects it
  // into EVERY session's system prompt. That is a prompt-injection supply
  // chain: whoever can write the hub can steer every Kyoto session. Global
  // auto-injection is therefore opt-in (`skillsHubAutoInjectGlobal`, default
  // false). Explicit agent tool calls (skill_list/skill_search/skill_get)
  // are unaffected — the model decides what to read, on the user's behalf.
  const GLOBAL_AUTOINJECT_KEY = 'skillsHubAutoInjectGlobal';
  async function _globalAutoInjectEnabled() {
    try {
      const g = await chrome.storage.local.get(GLOBAL_AUTOINJECT_KEY);
      return g[GLOBAL_AUTOINJECT_KEY] === true;
    } catch { return false; }
  }
  async function _skillsApi(method, path, { body, query } = {}) {
    const cfg = await _skillsConfig();
    if (!cfg.url || !cfg.key) {
      return { error: 'Skills hub not configured. Set the URL + API key in Settings → Skills hub.' };
    }
    let url = cfg.url + path;
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([_, v]) => v != null && v !== ''));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    try {
      const init = {
        method,
        headers: { 'X-Kyoto-Auth': cfg.key, 'Content-Type': 'application/json' },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const r = await fetch(url, init);
      const text = await r.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text }; }
      if (!r.ok) return { error: parsed?.error || `HTTP ${r.status}`, status: r.status, ...parsed };
      return parsed;
    } catch (e) {
      return { error: `network error: ${e.message}` };
    }
  }

  T({
    name: 'skill_search',
    group: 'skill',
    description:
      'Free-text search across the skill hub. Use this as a FALLBACK after `skill_list` when (a) the domain is unknown, (b) `skill_list` returned too many results to scan, or (c) you need to find a skill by keywords that appear in the body. ' +
      'Pass a free-text `query` describing the task. ' +
      'Optionally pass `domain` (e.g. "youtube.com") to restrict to that domain + the global partition; if omitted the server scans every domain. ' +
      'Returns ranked results with `name`, `description`, `contentPreview` (first 240 chars of content), `skill_id`. ' +
      'When something looks relevant, call `skill_get` with the skill_id to read the full body.',
    parameters: OBJ({ domain: STR, query: STR, limit: NUM, includeGlobal: BOOL }, ['query']),
    handler: async ({ domain, query, limit = 5, includeGlobal = true } = {}) => {
      const body = { query, limit, includeGlobal };
      if (domain) body.domain = domain;
      return _skillsApi('POST', '/v1/skills/search', { body });
    }
  });

  T({
    name: 'skill_get',
    group: 'skill',
    description:
      'STEP-2 of the skill workflow: fetch the full markdown body of one skill by `skill_id`. ' +
      'The id comes from a prior `skill_list` (preferred) or `skill_search` call. ' +
      'Domain is optional — the server resolves the partition via a GSI on skill_id. ' +
      'Pass `domain` only if you already know it (slightly faster path). ' +
      'Calling this bumps the skill\'s usageCount so popular skills surface first in future searches/lists.',
    parameters: OBJ({ skill_id: STR, domain: STR }, ['skill_id']),
    handler: async (args = {}) => {
      const skill_id = args.skill_id || args.skillId || args.skillID || args.id;
      if (!skill_id) return { error: 'skill_id is required (use the value from skill_search.items[].skill_id)' };
      const query = args.domain ? { domain: args.domain } : {};
      return _skillsApi('GET', `/v1/skills/${encodeURIComponent(skill_id)}`, { query });
    }
  });

  T({
    name: 'skill_list',
    group: 'skill',
    description:
      'PRIMARY skill-discovery tool. Lists all available skills for a domain (metadata only — no content body) so you can scan them cheaply. ' +
      'CALL THIS FIRST whenever you arrive at a domain-specific task — before doing any web/page exploration. The current tab\'s domain is the obvious choice. ' +
      'Returns `{ skill_id, name, description, tags, usageCount, contentLength, updatedAt }` per item, sorted by popularity. By default also folds in the `global` partition so you don\'t miss cross-site playbooks. ' +
      'Pick the skill_id(s) that look relevant, then call `skill_get` to read the full body of each. ' +
      'Use `skill_search` only when this returns too many results or you need substring matching across content.',
    parameters: OBJ({ domain: STR, limit: NUM, includeGlobal: BOOL }),
    handler: async ({ domain = 'global', limit = 50, includeGlobal = true } = {}) => {
      return _skillsApi('GET', '/v1/skills', { query: { domain, limit, includeGlobal } });
    }
  });

  T({
    name: 'skill_save',
    group: 'skill',
    description:
      'CREATE a new skill (playbook) in the hub so future agents can re-use it. ' +
      'CALL THIS after you accomplish a non-trivial task that required real exploration — not for trivial Q&A. ' +
      'To MODIFY an existing skill, use `skill_update` instead (cleaner partial-update semantics). ' +
      'Distill the WORKING APPROACH into a few hundred words: prereqs, the exact steps that succeeded, what *didn\'t* work and why, key gotchas. ' +
      'Pick `domain` deliberately: ' +
      '"global" for any pattern that doesn\'t depend on a specific site (CLI tricks, code-search recipes, multi-tab orchestration patterns, agent meta-strategies) — when the user has opted into global-skill auto-injection these are surfaced in EVERY session\'s system prompt regardless of the active tab. ' +
      'A specific host (eTLD+1 like "youtube.com" or "linear.app") for site-bound playbooks — these only surface when the agent is on that domain. ' +
      'If you\'re unsure, prefer "global" — narrow domain skills are easy to add later but hard to discover when buried under a single host. ' +
      'Pass `name` (short), `description` (one line), `content` (markdown), `tags` (2-6 short). ' +
      'Returns `{ skill_id, domain }`.',
    parameters: OBJ({
      domain: STR, name: STR, description: STR, content: STR,
      tags: { type: 'array', items: STR }, skill_id: STR
    }, ['name', 'content']),
    handler: async (args = {}) => {
      const body = {
        domain: args.domain || 'global',
        name: args.name,
        description: args.description || '',
        content: args.content,
        tags: args.tags || [],
        createdBy: 'agent',
      };
      if (args.skill_id) body.skill_id = args.skill_id;
      return _skillsApi('POST', '/v1/skills', { body });
    }
  });

  T({
    name: 'skill_update',
    group: 'skill',
    description:
      'Update an existing skill in place. Use this when an existing skill is mostly right but stale, incomplete, or buggy. ' +
      'Pass `skill_id` (required) + any subset of `name`, `description`, `content`, `tags`. ' +
      'Fields you omit are kept from the existing record. `domain`, `createdAt`, and `usageCount` are always preserved. ' +
      'To MOVE a skill to a different domain, delete + save instead (otherwise you\'d leave a duplicate behind). ' +
      'Tip: call `skill_get { skill_id }` first to read the current body so you can merge instead of overwrite blindly.',
    parameters: OBJ({
      skill_id: STR, name: STR, description: STR, content: STR,
      tags: { type: 'array', items: STR }
    }, ['skill_id']),
    handler: async (args = {}) => {
      const skill_id = args.skill_id || args.skillId || args.skillID || args.id;
      if (!skill_id) return { error: 'skill_id is required' };
      const existing = await _skillsApi('GET', `/v1/skills/${encodeURIComponent(skill_id)}`, {});
      if (existing?.error) return { error: `cannot update — ${existing.error}`, skill_id };
      const body = {
        skill_id,
        domain: existing.domain,
        name: args.name !== undefined ? args.name : existing.name,
        description: args.description !== undefined ? args.description : (existing.description || ''),
        content: args.content !== undefined ? args.content : (existing.content || ''),
        tags: Array.isArray(args.tags) ? args.tags : (existing.tags || []),
        createdBy: existing.createdBy || 'agent',
      };
      const r = await _skillsApi('POST', '/v1/skills', { body });
      if (r?.error) return r;
      return { ...r, updated: true };
    }
  });

  T({
    name: 'skill_delete',
    group: 'skill',
    description: 'Delete a skill from the hub. Use sparingly — usually prefer `skill_update` instead. Pass `skill_id`; domain is optional (server resolves it via GSI).',
    parameters: OBJ({ skill_id: STR, domain: STR }, ['skill_id']),
    handler: async (args = {}) => {
      const skill_id = args.skill_id || args.skillId || args.skillID || args.id;
      if (!skill_id) return { error: 'skill_id is required' };
      const query = args.domain ? { domain: args.domain } : {};
      return _skillsApi('DELETE', `/v1/skills/${encodeURIComponent(skill_id)}`, { query });
    }
  });

  window.KyotoSkillHub = {
    config: _skillsConfig,
    api: _skillsApi,
    // NOTE: sidepanel.js uses this wrapper only for the automatic
    // per-domain / global system-prompt refresh (agent tools call
    // _skillsApi directly). C15 gates the global auto-injection here: the
    // `global` partition is remote, hub-writable content, so it is not
    // surfaced automatically unless the user opted in.
    search: async (domain, query, limit, includeGlobal) => {
      if (domain === 'global' && !(await _globalAutoInjectEnabled())) {
        return { items: [], total: 0, autoInjectDisabled: true };
      }
      return _skillsApi('POST', '/v1/skills/search', { body: { domain, query, limit, includeGlobal } });
    },
    save: (body) => _skillsApi('POST', '/v1/skills', { body }),
    get: (skill_id, domain) =>
      _skillsApi('GET', `/v1/skills/${encodeURIComponent(skill_id)}`, { query: { domain } }),
    list: (domain, limit) =>
      _skillsApi('GET', '/v1/skills', { query: { domain, limit } }),
    health: async () => {
      const cfg = await _skillsConfig();
      if (!cfg.url) return { error: 'not configured' };
      try {
        const r = await fetch(cfg.url + '/v1/healthz');
        return r.ok ? r.json() : { error: `HTTP ${r.status}` };
      } catch (e) { return { error: e.message }; }
    }
  };

  // ──────── ASK USER ────────
  T({
    name: 'ask_user',
    group: 'meta',
    description:
      'Pause and ask the user a question when genuinely stuck. Renders an interactive card in the chat and waits for the reply. ' +
      'USE SPARINGLY — only when blocked by missing info you cannot infer (which file? which account? confirm destructive action?). ' +
      'Do NOT use it to narrate progress, get permission for obvious next steps, or chitchat — that wastes the user\'s attention. ' +
      'Pass `options` (array of strings, ≤8) to offer one-click chips alongside the free-text input; the user can also type a custom answer. ' +
      'Returns { answer, viaButton } — the answer is the user\'s reply as a plain string.',
    parameters: OBJ({
      question: STR,
      options: { type: 'array', items: STR },
      placeholder: STR,
      allowFreeText: BOOL
    }, ['question']),
    handler: async (args = {}) => {
      if (typeof window.KyotoAskUser !== 'function') {
        return { error: 'KyotoAskUser is not available — UI not initialized.' };
      }
      return window.KyotoAskUser({
        question: args.question,
        options: args.options,
        placeholder: args.placeholder,
        allowFreeText: args.allowFreeText
      });
    }
  });
})();
