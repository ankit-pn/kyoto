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
        id: m.id, name: m.name || m.id,
        group: m.id.includes('/') ? m.id.split('/')[0] : 'other',
        context: m.context_length,
        supportsTools: m.supported_parameters?.includes('tools') ?? true
      })),
      defaultModel: 'openai/gpt-4o-mini'
    },
    deepseek: {
      label: 'DeepSeek',
      chatUrl: 'https://api.deepseek.com/v1/chat/completions',
      modelsUrl: 'https://api.deepseek.com/v1/models',
      keysUrl: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-…',
      headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }),
      parseModels: (data) => (data.data || []).map(m => ({
        id: m.id, name: m.id, group: 'deepseek', supportsTools: true
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
    useContext: $('useContext'),
    toolsEnabled: $('toolsEnabled'),
    toolGroups: $('toolGroups'),
    opencodeUrl: $('opencodeUrl'),
    opencodeToken: $('opencodeToken'),
    opencodePath: $('opencodePath'),
    debuggerStatus: $('debuggerStatus'),
    requestDebuggerBtn: $('requestDebuggerBtn')
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

  function renderMarkdown(text) {
    try { return window.marked ? marked.parse(text || '') : escapeHtml(text || ''); }
    catch { return escapeHtml(text || ''); }
  }

  // ── Settings persistence ─────────────────────────────
  const defaults = {
    provider: 'openrouter',
    apiKey: '',
    model: '',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096,
    toolsEnabled: true,
    enabledGroups: ['browser', 'page', 'storage', 'cookies', 'network', 'devtools', 'browser-data', 'misc', 'opencode'],
    opencodeUrl: '',
    opencodeToken: '',
    opencodePath: '/api/message'
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
    if (!model) { els.modelLineText.textContent = PROVIDERS[provider].label; return; }
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

  // ── Model popover ────────────────────────────────────
  async function toggleModelPopover() {
    if (!els.modelPopover.classList.contains('hidden')) { closeModelPopover(); return; }
    if (!state.settings.apiKey) { openDrawer(); return; }
    els.modelPopover.classList.remove('hidden');
    els.popoverSearch.value = '';
    if (!state.allModels.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">Loading…</p>';
      await fetchModels(state.settings.provider, state.settings.apiKey);
    }
    renderPopoverList();
    setTimeout(() => els.popoverSearch.focus(), 0);
  }
  function closeModelPopover() { els.modelPopover.classList.add('hidden'); }
  function renderPopoverList() {
    if (!state.allModels.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">No models. Check your key in Settings.</p>';
      return;
    }
    const q = els.popoverSearch.value.trim().toLowerCase();
    const filtered = q ? state.allModels.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : state.allModels;
    if (!filtered.length) { els.popoverList.innerHTML = '<p class="popover-empty">No matches.</p>'; return; }
    const groups = {};
    filtered.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
    const parts = [];
    Object.keys(groups).sort().forEach(g => {
      parts.push(`<div class="popover-group">${escapeHtml(g)}</div>`);
      groups[g].forEach(m => {
        const active = m.id === state.settings.model ? ' active' : '';
        parts.push(`<div class="popover-item${active}" data-model="${escapeHtml(m.id)}"><span>${escapeHtml(m.name)}</span><span class="check">✓</span></div>`);
      });
    });
    els.popoverList.innerHTML = parts.join('');
  }

  // ── Page context ─────────────────────────────────────
  async function refreshPageContext() {
    els.ctxDot.className = 'dot load';
    els.ctxTxt.textContent = 'Reading page…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PAGE_EXTRACT_CONTENT' });
      if (!res?.ok || !res.data?.content) {
        state.page = null;
        els.ctxDot.className = 'dot err';
        els.ctxTxt.textContent = res?.error ? `No access: ${res.error}` : 'Page not readable';
        return;
      }
      state.page = res.data;
      els.ctxDot.className = 'dot ok';
      els.ctxTxt.textContent = state.page.title || state.page.url || 'Page loaded';
      els.ctxTxt.title = `${state.page.title || ''}\n${state.page.url || ''}\n${state.page.content.length} chars`;
    } catch {
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
    if (els.empty && !els.empty.classList.contains('hidden')) els.empty.classList.add('hidden');
  }
  function scrollToBottom() { els.chat.scrollTop = els.chat.scrollHeight; }

  function addMessage(role, content, opts = {}) {
    ensureEmptyHidden();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.error ? ' error' : ''}`;
    const label = document.createElement('div');
    label.className = `msg-role ${opts.error ? 'error' : role}`;
    label.textContent = opts.error ? 'Error' : role === 'user' ? 'You' : 'Assistant';
    const body = document.createElement('div');
    body.className = 'msg-body';
    if (role === 'assistant' || opts.error) body.innerHTML = renderMarkdown(content);
    else body.textContent = content;
    wrap.appendChild(label);
    wrap.appendChild(body);
    els.chat.appendChild(wrap);
    scrollToBottom();
    return { wrap, body };
  }

  function addToolCallCard(name, argsPreview) {
    ensureEmptyHidden();
    const card = document.createElement('details');
    card.className = 'tool-card';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(name)}</span><span class="tool-state running">running…</span>`;
    card.appendChild(summary);

    const inner = document.createElement('div');
    inner.className = 'tool-card-body';
    const argsBlock = document.createElement('pre');
    argsBlock.className = 'tool-args';
    argsBlock.textContent = argsPreview;
    inner.appendChild(makeLabel('args'));
    inner.appendChild(argsBlock);

    const resultBlock = document.createElement('pre');
    resultBlock.className = 'tool-result';
    resultBlock.textContent = '…';
    inner.appendChild(makeLabel('result'));
    inner.appendChild(resultBlock);
    card.appendChild(inner);
    els.chat.appendChild(card);
    scrollToBottom();
    return { card, summary, resultBlock };
  }
  function makeLabel(t) {
    const d = document.createElement('div');
    d.className = 'tool-label';
    d.textContent = t;
    return d;
  }

  // ── Chat loop ────────────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim()) return;
    if (!state.settings.apiKey) {
      addMessage('assistant', 'No API key set. Open Settings and add your OpenRouter or DeepSeek key.', { error: true });
      openDrawer(); return;
    }
    if (!state.settings.model) {
      addMessage('assistant', 'No model selected. Open Settings and pick a model.', { error: true });
      openDrawer(); return;
    }

    addMessage('user', text);
    state.history.push({ role: 'user', content: text });

    els.sendBtn.disabled = true;
    els.stopBtn.classList.remove('hidden');
    state.abort = new AbortController();

    try {
      // Multi-step loop (tool calls).
      const maxSteps = 12;
      for (let step = 0; step < maxSteps; step++) {
        const { text: assistantText, toolCalls } = await streamOnce(state.abort.signal);

        const assistantMsg = { role: 'assistant', content: assistantText || '' };
        if (toolCalls.length) {
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments || '{}' }
          }));
        }
        state.history.push(assistantMsg);

        if (!toolCalls.length) break;

        for (const tc of assistantMsg.tool_calls) {
          let args;
          try { args = JSON.parse(tc.function.arguments || '{}'); }
          catch { args = { _raw: tc.function.arguments }; }
          const argsPreview = (() => {
            try { return JSON.stringify(args, null, 2).slice(0, 2000); } catch { return String(args); }
          })();
          const card = addToolCallCard(tc.function.name, argsPreview);

          let result;
          try {
            result = await window.KyotoTools.call(tc.function.name, args);
          } catch (e) {
            result = { error: e?.message || String(e) };
          }
          const resultStr = (() => {
            try { return JSON.stringify(result, null, 2); } catch { return String(result); }
          })();
          card.resultBlock.textContent = resultStr.length > 8000 ? resultStr.slice(0, 8000) + '\n…' : resultStr;
          card.summary.querySelector('.tool-state').textContent = result?.error ? 'error' : 'done';
          card.summary.querySelector('.tool-state').className = `tool-state ${result?.error ? 'err' : 'ok'}`;

          state.history.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: resultStr.length > 60000 ? resultStr.slice(0, 60000) + '\n…[truncated]' : resultStr
          });
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        addMessage('assistant', `**Error:** ${e.message}`, { error: true });
      }
    } finally {
      state.abort = null;
      els.sendBtn.disabled = false;
      els.stopBtn.classList.add('hidden');
      els.input.focus();
    }
  }

  // One streamed model call. Returns accumulated text + tool calls.
  async function streamOnce(signal) {
    const { provider, apiKey, model, temperature, maxTokens, toolsEnabled, enabledGroups } = state.settings;
    const cfg = PROVIDERS[provider];

    const messages = buildMessages();
    const tools = toolsEnabled
      ? window.KyotoTools.schemas(new Set(enabledGroups))
      : undefined;

    const body = {
      model,
      messages,
      temperature: Number(temperature),
      max_tokens: Number(maxTokens),
      stream: true
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers: cfg.headers(apiKey),
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }

    let textAcc = '';
    const toolBuf = []; // index -> { id, function: { name, arguments } }
    let textTarget = null;

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
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (delta.content) {
          if (!textTarget) {
            const m = addMessage('assistant', '');
            textTarget = m.body;
            textTarget.classList.add('cursor');
          }
          textAcc += delta.content;
          textTarget.innerHTML = renderMarkdown(textAcc);
          scrollToBottom();
        }
        if (delta.tool_calls) {
          for (const inc of delta.tool_calls) {
            const idx = inc.index ?? 0;
            if (!toolBuf[idx]) toolBuf[idx] = { id: '', function: { name: '', arguments: '' } };
            const slot = toolBuf[idx];
            if (inc.id) slot.id = inc.id;
            if (inc.function?.name) slot.function.name = inc.function.name;
            if (inc.function?.arguments) slot.function.arguments += inc.function.arguments;
          }
        }
      }
    }

    if (textTarget) textTarget.classList.remove('cursor');
    return { text: textAcc, toolCalls: toolBuf.filter(Boolean) };
  }

  function buildMessages() {
    const systemParts = [];
    systemParts.push(
      'You are Kyoto, an AI browser agent embedded in a Chrome side panel. ' +
      'You have tool access to: open tabs, run JS in pages, read DOM, inspect & modify cookies (including export for session cloning), ' +
      'observe network requests, intercept fetch/XHR bodies, attach the Chrome DevTools Protocol (after the user grants the optional `debugger` permission), ' +
      'search history/bookmarks/downloads, and offload non-browser work to an opencode server. ' +
      'Prefer reading before writing. When the user asks for "session cloning" or "auth cookies", use `cookies_analyze` + `cookies_export`. ' +
      'When inspecting an API, use `network_capture_start`, perform the action, then `network_capture_list`/`network_capture_detail` (response bodies require `page_fetch_intercept` or debugger). ' +
      'Render responses in Markdown.'
    );
    if (state.settings.systemPrompt) systemParts.push(state.settings.systemPrompt);
    if (els.useContext.checked && state.page?.content) {
      systemParts.push(
        `Current page context:\nTitle: ${state.page.title}\nURL: ${state.page.url}\n\n--- PAGE CONTENT ---\n${state.page.content}\n--- END PAGE CONTENT ---`
      );
    }
    return [{ role: 'system', content: systemParts.join('\n\n') }, ...state.history];
  }

  // ── Drawer / settings ────────────────────────────────
  function openDrawer() {
    els.drawer.classList.remove('hidden');
    els.overlay.classList.remove('hidden');
    els.apiKey.value = state.settings.apiKey;
    els.provider.value = state.settings.provider;
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.maxTokens.value = state.settings.maxTokens;
    els.toolsEnabled.checked = !!state.settings.toolsEnabled;
    els.opencodeUrl.value = state.settings.opencodeUrl || '';
    els.opencodeToken.value = state.settings.opencodeToken || '';
    els.opencodePath.value = state.settings.opencodePath || '/api/message';
    renderToolGroupCheckboxes();
    refreshDebuggerStatus();
    reflectProvider(state.settings.provider);
    if (state.settings.apiKey) fetchModels(state.settings.provider, state.settings.apiKey);
  }
  function closeDrawer() {
    els.drawer.classList.add('hidden');
    els.overlay.classList.add('hidden');
  }

  function renderToolGroupCheckboxes() {
    const groups = window.KyotoTools.groups();
    els.toolGroups.innerHTML = '';
    for (const g of groups) {
      const id = `grp-${g}`;
      const wrap = document.createElement('label');
      wrap.className = 'grp';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.dataset.group = g;
      cb.checked = state.settings.enabledGroups.includes(g);
      const txt = document.createElement('span');
      txt.textContent = g;
      wrap.appendChild(cb);
      wrap.appendChild(txt);
      els.toolGroups.appendChild(wrap);
    }
  }

  async function refreshDebuggerStatus() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_PERMISSION', args: { permissions: ['debugger'] } });
      const has = res?.data?.has;
      els.debuggerStatus.textContent = has ? 'Granted ✓' : 'Not granted';
      els.debuggerStatus.className = `permstatus ${has ? 'ok' : 'err'}`;
      els.requestDebuggerBtn.textContent = has ? 'Revoke debugger' : 'Grant debugger';
    } catch {
      els.debuggerStatus.textContent = 'Unknown';
    }
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
  els.stopBtn.addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  els.newChatBtn.addEventListener('click', clearChat);
  els.settingsBtn.addEventListener('click', openDrawer);
  els.closeDrawerBtn.addEventListener('click', closeDrawer);
  els.overlay.addEventListener('click', closeDrawer);
  els.reloadCtxBtn.addEventListener('click', refreshPageContext);

  els.modelBtn.addEventListener('click', toggleModelPopover);
  els.popoverSearch.addEventListener('input', renderPopoverList);
  document.addEventListener('click', (e) => {
    if (els.modelPopover.classList.contains('hidden')) return;
    if (!els.modelPopover.contains(e.target) && !els.modelBtn.contains(e.target)) closeModelPopover();
  });
  els.popoverList.addEventListener('click', async (e) => {
    const item = e.target.closest('.popover-item');
    if (!item?.dataset.model) return;
    await saveSettings({ model: item.dataset.model });
    updateModelLine();
    closeModelPopover();
  });

  els.revealBtn.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });
  els.provider.addEventListener('change', () => {
    reflectProvider(els.provider.value);
    state.allModels = [];
    els.model.innerHTML = '';
    els.modelHint.textContent = 'Enter an API key to load models.';
    if (els.apiKey.value.trim()) fetchModels(els.provider.value, els.apiKey.value.trim());
  });

  let keyDebounce;
  els.apiKey.addEventListener('input', () => {
    clearTimeout(keyDebounce);
    const key = els.apiKey.value.trim();
    if (key.length < 10) return;
    keyDebounce = setTimeout(() => fetchModels(els.provider.value, key), 400);
  });
  els.modelSearch.addEventListener('input', renderModelOptions);

  els.requestDebuggerBtn.addEventListener('click', async () => {
    const has = els.debuggerStatus.textContent.startsWith('Granted');
    if (has) {
      await chrome.permissions.remove({ permissions: ['debugger'] });
    } else {
      await chrome.permissions.request({ permissions: ['debugger'] });
    }
    refreshDebuggerStatus();
  });

  els.saveBtn.addEventListener('click', async () => {
    const provider = els.provider.value;
    const apiKey = els.apiKey.value.trim();
    const model = els.model.value;
    const systemPrompt = els.systemPrompt.value.trim();
    const temperature = Math.max(0, Math.min(2, Number(els.temperature.value) || 0.7));
    const maxTokens = Math.max(64, Math.min(32000, Number(els.maxTokens.value) || 4096));
    const toolsEnabled = !!els.toolsEnabled.checked;
    const enabledGroups = Array.from(els.toolGroups.querySelectorAll('input[type=checkbox]'))
      .filter(c => c.checked).map(c => c.dataset.group);
    const opencodeUrl = els.opencodeUrl.value.trim();
    const opencodeToken = els.opencodeToken.value.trim();
    const opencodePath = els.opencodePath.value.trim() || '/api/message';

    if (!apiKey) { els.saveStatus.textContent = 'API key required.'; els.saveStatus.className = 'status err'; return; }
    if (!model) { els.saveStatus.textContent = 'Select a model from the list.'; els.saveStatus.className = 'status err'; return; }

    await saveSettings({
      provider, apiKey, model, systemPrompt, temperature, maxTokens,
      toolsEnabled, enabledGroups, opencodeUrl, opencodeToken, opencodePath
    });
    updateModelLine();
    els.saveStatus.textContent = 'Saved.';
    els.saveStatus.className = 'status ok';
    setTimeout(() => { els.saveStatus.textContent = ''; closeDrawer(); }, 600);
  });

  els.chat.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip?.dataset.prompt) { sendMessage(chip.dataset.prompt); return; }
    const copy = e.target.closest('.copy-btn');
    if (copy?.dataset.code) {
      navigator.clipboard.writeText(decodeURIComponent(copy.dataset.code)).then(() => {
        const orig = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = orig; }, 1200);
      });
    }
  });

  // ── External triggers ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ASK_SELECTION' && msg.text) {
      const q = `Regarding this selection:\n\n> ${msg.text.split('\n').join('\n> ')}\n\nWhat does this mean / explain it?`;
      sendMessage(q);
    } else if (msg?.type === 'ASK_PAGE') {
      els.input.focus();
    }
  });

  chrome.tabs.onActivated.addListener(refreshPageContext);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete') refreshPageContext();
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
