(() => {
  'use strict';

  // ── Provider configs ─────────────────────────────────
  const PROVIDERS = {
    openrouter: {
      label: 'OpenRouter',
      chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      keysUrl: 'https://openrouter.ai/keys',
      placeholder: 'sk-or-v1-…',
      headers: (key) => ({
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/page-chat-extension',
        'X-Title': 'Kyoto'
      }),
      parseModels: (data) => (data.data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        group: m.id.includes('/') ? m.id.split('/')[0] : 'other',
        context: m.context_length
      })),
      defaultModel: 'openai/gpt-4o-mini'
    },
    deepseek: {
      label: 'DeepSeek',
      chatUrl: 'https://api.deepseek.com/v1/chat/completions',
      modelsUrl: 'https://api.deepseek.com/v1/models',
      keysUrl: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-…',
      headers: (key) => ({
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }),
      parseModels: (data) => (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        group: 'deepseek'
      })),
      defaultModel: 'deepseek-chat'
    }
  };

  // ── DOM refs ─────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    chat: $('chat'),
    empty: $('empty'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    newChatBtn: $('newChatBtn'),
    settingsBtn: $('settingsBtn'),
    closeDrawerBtn: $('closeDrawerBtn'),
    drawer: $('drawer'),
    overlay: $('overlay'),
    provider: $('provider'),
    apiKey: $('apiKey'),
    revealBtn: $('revealBtn'),
    keyLabel: $('keyLabel'),
    keyHint: $('keyHint'),
    model: $('model'),
    modelSearch: $('modelSearch'),
    modelHint: $('modelHint'),
    systemPrompt: $('systemPrompt'),
    temperature: $('temperature'),
    maxTokens: $('maxTokens'),
    saveBtn: $('saveBtn'),
    saveStatus: $('saveStatus'),
    modelBtn: $('modelBtn'),
    modelLineText: $('modelLineText'),
    modelPopover: $('modelPopover'),
    popoverSearch: $('popoverSearch'),
    popoverList: $('popoverList'),
    ctxDot: $('ctxDot'),
    ctxTxt: $('ctxTxt'),
    reloadCtxBtn: $('reloadCtxBtn'),
    useContext: $('useContext')
  };

  // ── State ────────────────────────────────────────────
  const state = {
    settings: null,
    history: [],
    page: null,
    allModels: [],
    abort: null
  };

  // ── Marked setup ─────────────────────────────────────
  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
    const origCode = marked.Renderer.prototype.code;
    const origLink = marked.Renderer.prototype.link;
    marked.Renderer.prototype.code = function (token) {
      const lang = (token.lang || '').trim();
      const code = token.text || '';
      let html = origCode.call(this, token);
      const bar = `<div class="code-bar"><span>${escapeHtml(lang)}</span><button class="copy-btn" data-code="${encodeURIComponent(code)}">Copy</button></div>`;
      return html.replace('<pre>', `<pre>${bar}`);
    };
    marked.Renderer.prototype.link = function (token) {
      return origLink.call(this, token).replace('<a ', '<a target="_blank" rel="noopener" ');
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ── Settings persistence ─────────────────────────────
  const defaults = {
    provider: 'openrouter',
    apiKey: '',
    model: '',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096
  };

  async function loadSettings() {
    const stored = await chrome.storage.local.get(Object.keys(defaults));
    state.settings = { ...defaults, ...stored };
    return state.settings;
  }

  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    await chrome.storage.local.set(patch);
  }

  // ── Provider UI ──────────────────────────────────────
  function reflectProvider(provider) {
    const cfg = PROVIDERS[provider];
    els.keyLabel.textContent = `${cfg.label} API key`;
    els.apiKey.placeholder = cfg.placeholder;
    els.keyHint.innerHTML = `Get a key at <a href="${cfg.keysUrl}" target="_blank" rel="noopener">${new URL(cfg.keysUrl).host}</a>.`;
  }

  function updateModelLine() {
    const { provider, model } = state.settings;
    if (!model) {
      els.modelLineText.textContent = PROVIDERS[provider].label;
      return;
    }
    const short = model.includes('/') ? model.split('/').slice(1).join('/') : model;
    els.modelLineText.textContent = `${PROVIDERS[provider].label} · ${short}`;
  }

  // ── Models ───────────────────────────────────────────
  async function fetchModels(provider, apiKey) {
    if (!apiKey) {
      state.allModels = [];
      els.model.innerHTML = '';
      els.modelHint.textContent = 'Enter an API key to load models.';
      return;
    }
    els.modelHint.textContent = 'Loading models…';
    const cfg = PROVIDERS[provider];
    try {
      const res = await fetch(cfg.modelsUrl, { headers: cfg.headers(apiKey) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      state.allModels = cfg.parseModels(data).sort((a, b) => a.id.localeCompare(b.id));
      renderModelOptions();
      els.modelHint.textContent = `${state.allModels.length} models. Pick one and Save.`;
    } catch (e) {
      state.allModels = [];
      els.model.innerHTML = '';
      els.modelHint.textContent = `Failed: ${e.message}`;
    }
  }

  function renderModelOptions() {
    const q = els.modelSearch.value.trim().toLowerCase();
    const filtered = q
      ? state.allModels.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : state.allModels;

    const groups = {};
    filtered.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));

    els.model.innerHTML = '';
    Object.keys(groups).sort().forEach(g => {
      const og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        og.appendChild(opt);
      });
      els.model.appendChild(og);
    });
    if (state.settings.model && els.model.querySelector(`option[value="${CSS.escape(state.settings.model)}"]`)) {
      els.model.value = state.settings.model;
    }
  }

  // ── Model picker popover (header) ────────────────────
  async function toggleModelPopover() {
    if (!els.modelPopover.classList.contains('hidden')) {
      closeModelPopover();
      return;
    }
    if (!state.settings.apiKey) {
      openDrawer();
      return;
    }
    els.modelPopover.classList.remove('hidden');
    els.popoverSearch.value = '';
    if (!state.allModels.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">Loading…</p>';
      await fetchModels(state.settings.provider, state.settings.apiKey);
    }
    renderPopoverList();
    setTimeout(() => els.popoverSearch.focus(), 0);
  }

  function closeModelPopover() {
    els.modelPopover.classList.add('hidden');
  }

  function renderPopoverList() {
    if (!state.allModels.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">No models. Check your key in Settings.</p>';
      return;
    }
    const q = els.popoverSearch.value.trim().toLowerCase();
    const filtered = q
      ? state.allModels.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : state.allModels;

    if (!filtered.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">No matches.</p>';
      return;
    }

    const groups = {};
    filtered.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));

    const parts = [];
    Object.keys(groups).sort().forEach(g => {
      parts.push(`<div class="popover-group">${escapeHtml(g)}</div>`);
      groups[g].forEach(m => {
        const active = m.id === state.settings.model ? ' active' : '';
        parts.push(
          `<div class="popover-item${active}" data-model="${escapeHtml(m.id)}">` +
          `<span>${escapeHtml(m.name)}</span><span class="check">✓</span></div>`
        );
      });
    });
    els.popoverList.innerHTML = parts.join('');
  }

  // ── Page context ─────────────────────────────────────
  async function refreshPageContext() {
    els.ctxDot.className = 'dot load';
    els.ctxTxt.textContent = 'Reading page…';
    try {
      const page = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' });
      if (page?.error || !page?.content) {
        state.page = null;
        els.ctxDot.className = 'dot err';
        els.ctxTxt.textContent = page?.error ? `No access: ${page.error}` : 'Page not readable';
        return;
      }
      state.page = page;
      els.ctxDot.className = 'dot ok';
      els.ctxTxt.textContent = page.title || page.url || 'Page loaded';
      els.ctxTxt.title = `${page.title || ''}\n${page.url || ''}\n${page.content.length} chars`;
    } catch (e) {
      state.page = null;
      els.ctxDot.className = 'dot err';
      els.ctxTxt.textContent = 'Cannot read this page';
    }
  }

  // ── Chat rendering ───────────────────────────────────
  function clearChat() {
    state.history = [];
    els.chat.innerHTML = '';
    els.chat.appendChild(els.empty);
    els.empty.classList.remove('hidden');
  }

  function ensureEmptyHidden() {
    if (els.empty && !els.empty.classList.contains('hidden')) {
      els.empty.classList.add('hidden');
    }
  }

  function addMessage(role, content, opts = {}) {
    ensureEmptyHidden();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.error ? ' error' : ''}`;

    const label = document.createElement('div');
    label.className = `msg-role ${opts.error ? 'error' : role}`;
    label.textContent = opts.error ? 'Error' : role === 'user' ? 'You' : 'Assistant';

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (role === 'assistant' || opts.error) {
      body.innerHTML = renderMarkdown(content);
    } else {
      body.textContent = content;
    }

    wrap.appendChild(label);
    wrap.appendChild(body);
    els.chat.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  function renderMarkdown(text) {
    try {
      return window.marked ? marked.parse(text || '') : escapeHtml(text || '');
    } catch {
      return escapeHtml(text || '');
    }
  }

  function scrollToBottom() {
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  // ── Streaming chat ───────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim()) return;
    if (!state.settings.apiKey) {
      addMessage('assistant', 'No API key set. Open Settings and add your OpenRouter or DeepSeek key.', { error: true });
      openDrawer();
      return;
    }
    if (!state.settings.model) {
      addMessage('assistant', 'No model selected. Open Settings and pick a model.', { error: true });
      openDrawer();
      return;
    }

    addMessage('user', text);
    state.history.push({ role: 'user', content: text });

    const messages = buildMessages();
    const targetBody = addMessage('assistant', '');
    targetBody.classList.add('cursor');

    els.sendBtn.disabled = true;
    els.stopBtn.classList.remove('hidden');
    state.abort = new AbortController();

    let acc = '';
    try {
      await streamChat(messages, (chunk) => {
        acc += chunk;
        targetBody.innerHTML = renderMarkdown(acc);
        scrollToBottom();
      }, state.abort.signal);

      targetBody.classList.remove('cursor');
      targetBody.innerHTML = renderMarkdown(acc);
      state.history.push({ role: 'assistant', content: acc });
    } catch (e) {
      targetBody.classList.remove('cursor');
      const isAbort = e.name === 'AbortError';
      if (isAbort && acc) {
        targetBody.innerHTML = renderMarkdown(acc + '\n\n_[stopped]_');
        state.history.push({ role: 'assistant', content: acc });
      } else if (isAbort) {
        targetBody.parentElement.remove();
      } else {
        targetBody.innerHTML = renderMarkdown(`**Error:** ${e.message}`);
        targetBody.parentElement.classList.add('error');
        targetBody.previousElementSibling.textContent = 'Error';
        targetBody.previousElementSibling.className = 'msg-role error';
      }
    } finally {
      state.abort = null;
      els.sendBtn.disabled = false;
      els.stopBtn.classList.add('hidden');
      els.input.focus();
    }
  }

  function buildMessages() {
    const msgs = [];
    const systemParts = [];
    if (state.settings.systemPrompt) systemParts.push(state.settings.systemPrompt);
    if (els.useContext.checked && state.page?.content) {
      systemParts.push(
        `The user is asking about the following web page.\n\nTitle: ${state.page.title}\nURL: ${state.page.url}\n\n--- PAGE CONTENT ---\n${state.page.content}\n--- END PAGE CONTENT ---\n\nAnswer using this content where relevant. If the question is unrelated, answer normally. Format responses in Markdown.`
      );
    }
    if (systemParts.length) msgs.push({ role: 'system', content: systemParts.join('\n\n') });
    return [...msgs, ...state.history];
  }

  async function streamChat(messages, onChunk, signal) {
    const { provider, apiKey, model, temperature, maxTokens } = state.settings;
    const cfg = PROVIDERS[provider];

    const res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers: cfg.headers(apiKey),
      body: JSON.stringify({
        model,
        messages,
        temperature: Number(temperature),
        max_tokens: Number(maxTokens),
        stream: true
      }),
      signal
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }

    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {}
      }
    }
  }

  // ── Drawer ───────────────────────────────────────────
  function openDrawer() {
    els.drawer.classList.remove('hidden');
    els.overlay.classList.remove('hidden');
    els.apiKey.value = state.settings.apiKey;
    els.provider.value = state.settings.provider;
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.maxTokens.value = state.settings.maxTokens;
    reflectProvider(state.settings.provider);
    if (state.settings.apiKey) fetchModels(state.settings.provider, state.settings.apiKey);
  }

  function closeDrawer() {
    els.drawer.classList.add('hidden');
    els.overlay.classList.add('hidden');
  }

  // ── Event wiring ─────────────────────────────────────
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = els.input.value;
      els.input.value = '';
      els.input.style.height = 'auto';
      sendMessage(v);
    }
  });
  els.sendBtn.addEventListener('click', () => {
    const v = els.input.value;
    els.input.value = '';
    els.input.style.height = 'auto';
    sendMessage(v);
  });
  els.stopBtn.addEventListener('click', () => {
    if (state.abort) state.abort.abort();
  });
  els.newChatBtn.addEventListener('click', clearChat);
  els.settingsBtn.addEventListener('click', openDrawer);
  els.modelBtn.addEventListener('click', toggleModelPopover);
  els.popoverSearch.addEventListener('input', renderPopoverList);
  document.addEventListener('click', (e) => {
    if (els.modelPopover.classList.contains('hidden')) return;
    if (!els.modelPopover.contains(e.target) && !els.modelBtn.contains(e.target)) {
      closeModelPopover();
    }
  });
  els.closeDrawerBtn.addEventListener('click', closeDrawer);
  els.overlay.addEventListener('click', closeDrawer);
  els.reloadCtxBtn.addEventListener('click', refreshPageContext);

  els.revealBtn.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });

  els.provider.addEventListener('change', () => {
    reflectProvider(els.provider.value);
    state.allModels = [];
    els.model.innerHTML = '';
    els.modelHint.textContent = 'Enter an API key to load models.';
    if (els.apiKey.value.trim()) {
      fetchModels(els.provider.value, els.apiKey.value.trim());
    }
  });

  let keyDebounce;
  els.apiKey.addEventListener('input', () => {
    clearTimeout(keyDebounce);
    const key = els.apiKey.value.trim();
    if (key.length < 10) return;
    keyDebounce = setTimeout(() => fetchModels(els.provider.value, key), 400);
  });

  els.modelSearch.addEventListener('input', renderModelOptions);

  els.saveBtn.addEventListener('click', async () => {
    const provider = els.provider.value;
    const apiKey = els.apiKey.value.trim();
    const model = els.model.value;
    const systemPrompt = els.systemPrompt.value.trim();
    const temperature = Math.max(0, Math.min(2, Number(els.temperature.value) || 0.7));
    const maxTokens = Math.max(64, Math.min(32000, Number(els.maxTokens.value) || 4096));

    if (!apiKey) {
      els.saveStatus.textContent = 'API key required.';
      els.saveStatus.className = 'status err';
      return;
    }
    if (!model) {
      els.saveStatus.textContent = 'Select a model from the list.';
      els.saveStatus.className = 'status err';
      return;
    }

    await saveSettings({ provider, apiKey, model, systemPrompt, temperature, maxTokens });
    updateModelLine();
    els.saveStatus.textContent = 'Saved.';
    els.saveStatus.className = 'status ok';
    setTimeout(() => {
      els.saveStatus.textContent = '';
      closeDrawer();
    }, 600);
  });

  els.popoverList.addEventListener('click', async (e) => {
    const item = e.target.closest('.popover-item');
    if (!item) return;
    const modelId = item.dataset.model;
    if (!modelId) return;
    await saveSettings({ model: modelId });
    updateModelLine();
    closeModelPopover();
  });

  els.chat.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip?.dataset.prompt) {
      sendMessage(chip.dataset.prompt);
      return;
    }
    const copy = e.target.closest('.copy-btn');
    if (copy?.dataset.code) {
      navigator.clipboard.writeText(decodeURIComponent(copy.dataset.code)).then(() => {
        const orig = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = orig; }, 1200);
      });
    }
  });

  // ── Listen for background actions ────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ASK_SELECTION' && msg.text) {
      const q = `Regarding this selection from the page:\n\n> ${msg.text.split('\n').join('\n> ')}\n\nWhat does this mean / explain it?`;
      sendMessage(q);
    } else if (msg?.type === 'ASK_PAGE') {
      els.input.focus();
    }
  });

  // Re-read page when tab changes
  chrome.tabs.onActivated.addListener(refreshPageContext);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') refreshPageContext();
  });

  // ── Boot ─────────────────────────────────────────────
  (async () => {
    await loadSettings();
    reflectProvider(state.settings.provider);
    updateModelLine();
    refreshPageContext();
    els.input.focus();
  })();
})();
