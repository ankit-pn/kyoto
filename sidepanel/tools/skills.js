// Cross-session memory + ask_user UI primitive.


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
    handler: async ({ title, content, tags = [] } = {}) => {
      // An empty memory is pure storage garbage and will resurface in future
      // sessions' memory listings — refuse it instead of writing it.
      if (typeof content !== 'string' || !content.trim()) {
        return { error: 'content is required (a memory with no content is not saveable)' };
      }
      const safeTitle = (typeof title === 'string' && title.trim()) ? title.trim() : content.trim().slice(0, 60);
      const id = memNewId();
      title = safeTitle;
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
