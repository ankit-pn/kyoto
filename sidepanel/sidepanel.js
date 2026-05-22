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
        'HTTP-Referer': 'https://github.com/ankit-pn/kyoto',
        'X-Title': 'Kyoto'
      }),
      parseModels: (data) => (data.data || []).map(m => ({
        id: m.id, name: m.name || m.id,
        group: m.id.includes('/') ? m.id.split('/')[0] : 'other',
        context: m.context_length,
        supportsTools: m.supported_parameters?.includes('tools') ?? true
      })),
      defaultModel: 'openai/gpt-4o-mini',
      // Used when /models is unreachable or returns an empty list.
      // Keeps the cross-provider picker functional even when one
      // provider's catalogue endpoint is having a bad day.
      fallbackModels: [
        { id: 'openai/gpt-4o-mini',                   name: 'GPT-4o mini',         group: 'openai' },
        { id: 'openai/gpt-4o',                        name: 'GPT-4o',              group: 'openai' },
        { id: 'anthropic/claude-3.5-sonnet',          name: 'Claude 3.5 Sonnet',   group: 'anthropic' },
        { id: 'anthropic/claude-3.5-haiku',           name: 'Claude 3.5 Haiku',    group: 'anthropic' },
        { id: 'google/gemini-2.0-flash-exp',          name: 'Gemini 2.0 Flash',    group: 'google' },
        { id: 'meta-llama/llama-3.3-70b-instruct',    name: 'Llama 3.3 70B',       group: 'meta-llama' },
        { id: 'deepseek/deepseek-chat',               name: 'DeepSeek V3',         group: 'deepseek' },
        { id: 'deepseek/deepseek-r1',                 name: 'DeepSeek R1',         group: 'deepseek' }
      ]
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
      defaultModel: 'deepseek-chat',
      fallbackModels: [
        { id: 'deepseek-chat',     name: 'deepseek-chat (V3.x)',  group: 'deepseek' },
        { id: 'deepseek-reasoner', name: 'deepseek-reasoner',     group: 'deepseek' }
      ]
    },
    minimax: {
      label: 'MiniMax',
      chatUrl: 'https://api.minimax.io/v1/chat/completions',
      modelsUrl: 'https://api.minimax.io/v1/models',
      keysUrl: 'https://www.minimax.io/platform/user-center/basic-information/interface-key',
      placeholder: 'MiniMax API key…',
      headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }),
      parseModels: (data) => (data.data || data.models || []).map(m => ({
        id: m.id || m.model || m.name,
        name: m.id || m.model || m.name,
        group: 'minimax',
        supportsTools: true
      })),
      defaultModel: 'MiniMax-M2',
      fallbackModels: [
        { id: 'MiniMax-M2', name: 'MiniMax-M2', group: 'minimax' },
        { id: 'MiniMax-Text-01', name: 'MiniMax-Text-01', group: 'minimax' },
        { id: 'abab6.5s-chat', name: 'abab6.5s-chat', group: 'minimax' }
      ]
    }
  };

  // ── DOM refs ─────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    chat: $('chat'),
    goalBar: $('goalBar'),
    empty: $('empty'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    newChatBtn: $('newChatBtn'),
    sessionsBtn: $('sessionsBtn'),
    captureBtn: $('captureBtn'),
    captureCount: $('captureCount'),
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
    maxTokensHint: $('maxTokensHint'),
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
    visionBtn: $('visionBtn'),
    slashPalette: $('slashPalette'),
    toolsEnabled: $('toolsEnabled'),
    maxAgentSteps: $('maxAgentSteps'),
    maxAutoContinues: $('maxAutoContinues'),
    toolGroups: $('toolGroups'),
    redactSensitive: $('redactSensitive'),
    auditEnabled: $('auditEnabled'),
    themeSelect: $('themeSelect'),
    densitySelect: $('densitySelect'),
    hideReasoning: $('hideReasoning'),
    testConnBtn: $('testConnBtn'),
    testConnStatus: $('testConnStatus'),
    popOutBtn: $('popOutBtn'),
    exportSettingsBtn: $('exportSettingsBtn'),
    importSettingsBtn: $('importSettingsBtn'),
    importSettingsInput: $('importSettingsInput'),
    backupStatus: $('backupStatus'),
    s3AccessKeyId: $('s3AccessKeyId'),
    s3SecretAccessKey: $('s3SecretAccessKey'),
    s3Region: $('s3Region'),
    s3Bucket: $('s3Bucket'),
    s3KeyPrefix: $('s3KeyPrefix'),
    s3Endpoint: $('s3Endpoint'),
    s3TestBtn: $('s3TestBtn'),
    s3Status: $('s3Status'),
    workspaceSummary: $('workspaceSummary'),
    workspaceZipBtn: $('workspaceZipBtn'),
    workspaceClearBtn: $('workspaceClearBtn'),
    shellExtId: $('shellExtId'),
    shellCopyIdBtn: $('shellCopyIdBtn'),
    shellInstallLabel: $('shellInstallLabel'),
    shellInstallCmd: $('shellInstallCmd'),
    shellInstallCopyBtn: $('shellInstallCopyBtn'),
    shellInstallToggleAltBtn: $('shellInstallToggleAltBtn'),
    shellInstallAltWrap: $('shellInstallAltWrap'),
    shellInstallAltLabel: $('shellInstallAltLabel'),
    shellInstallCmdAlt: $('shellInstallCmdAlt'),
    shellInstallCopyAltBtn: $('shellInstallCopyAltBtn'),
    shellTestBtn: $('shellTestBtn'),
    shellStatus: $('shellStatus'),
    skillsHubUrl: $('skillsHubUrl'),
    skillsHubKey: $('skillsHubKey'),
    skillsAutoSave: $('skillsAutoSave'),
    skillsHubTestBtn: $('skillsHubTestBtn'),
    skillsHubStatus: $('skillsHubStatus'),
    downloadAuditBtn: $('downloadAuditBtn'),
    clearAuditBtn: $('clearAuditBtn'),
    auditStatus: $('auditStatus'),
    debuggerStatus: $('debuggerStatus'),
    openExtPageBtn: $('openExtPageBtn'),
    sessionsPopover: $('sessionsPopover'),
    sessionsList: $('sessionsList'),
    sessionsSearch: $('sessionsSearch'),
    pinSessionBtn: $('pinSessionBtn'),
    mcpServersList: $('mcpServersList'),
    mcpAddBtn: $('mcpAddBtn'),
    mcpStatus: $('mcpStatus'),
    customProvidersList: $('customProvidersList'),
    customProviderAddBtn: $('customProviderAddBtn'),
    customSlashList: $('customSlashList'),
    customSlashAddBtn: $('customSlashAddBtn'),
    customToolsList: $('customToolsList'),
    customToolAddBtn: $('customToolAddBtn'),
    customToolStatus: $('customToolStatus')
  };

  // ── State ────────────────────────────────────────────
  const state = {
    settings: null,
    sessionsIndex: [],          // [{ id, title, tabId, url, createdAt, lastActive }]
    tabToSession: {},           // tabId -> sessionId
    activeSession: null,        // currently-loaded full session
    runtimes: {},               // sessionId -> { abort, busy }
    pinnedToSession: false,     // when true, tab switches do NOT swap session
    page: null,                 // page context for active tab
    allModels: [],               // models for the provider shown in the Settings drawer (legacy alias)
    modelsByProvider: new Map(), // providerId -> models[] — cross-provider header picker source
    mcpTools: [],                // dynamically-added tool defs
    visionPending: false,        // one-shot: attach screenshot to next message
    pendingAgentTabBind: null,   // when set, the next newly-created tab will inherit this session
    activeLoops: new Map()       // loopId -> { sessionId, intervalMs, prompt, count, intervalId }
  };

  // Tools.js calls this just before chrome.tabs.create so the new tab
  // adopts the active session's history instead of starting a fresh
  // conversation. The mapping is consumed (one-shot) by the
  // chrome.tabs.onCreated handler below.
  window.__kyotoMarkPendingTabBind = () => {
    state.pendingAgentTabBind = state.activeSession?.id || null;
  };

  // Read-only window into session storage for tools (chat_export, etc.).
  // Defined here so it's available before tools.js runs its tool registrations.
  // loadFullSession isn't defined yet at this top-level; we defer the lookup.
  window.KyotoSession = {
    active: () => state.activeSession,
    listIndex: () => [...(state.sessionsIndex || [])],
    load: (id) => (typeof loadFullSession === 'function' ? loadFullSession(id) : Promise.reject(new Error('not ready'))),
    settingsSnapshot: () => ({
      provider: state.settings?.provider,
      model: state.settings?.model
    })
  };

  // Interactive prompt surfaced by the `ask_user` tool. Renders a card
  // in the chat with the question, optional option chips, and a free-
  // text input. Returns a promise resolving to { answer, viaButton } —
  // or { cancelled: true } if the user dismisses it. The agent loop
  // simply awaits this from inside the tool handler.
  window.KyotoAskUser = function (opts = {}) {
    const question = String(opts.question || '').trim();
    if (!question) return Promise.resolve({ cancelled: true, error: 'empty question' });
    const options = Array.isArray(opts.options) ? opts.options.filter(Boolean).slice(0, 8) : [];
    const placeholder = String(opts.placeholder || 'Type your answer…');
    const allowFreeText = opts.allowFreeText !== false;

    return new Promise((resolve) => {
      const card = document.createElement('div');
      card.className = 'ask-card';
      const head = document.createElement('div');
      head.className = 'ask-head';
      head.textContent = '❓ Question for you';
      const body = document.createElement('div');
      body.className = 'ask-body';
      const q = document.createElement('div');
      q.className = 'ask-q';
      q.textContent = question;
      body.appendChild(q);

      let settled = false;
      let cardObserver = null;
      const finish = (answer, viaButton = false) => {
        if (settled) return;
        settled = true;
        if (cardObserver) { try { cardObserver.disconnect(); } catch {} cardObserver = null; }
        // Only render the resolved-state badge if the card is still
        // attached. If it was wiped by a session switch / chat clear,
        // there's nothing to decorate.
        if (card.isConnected) {
          card.classList.add('ask-done');
          const ans = document.createElement('div');
          ans.className = 'ask-answer';
          ans.textContent = `→ ${answer}`;
          body.appendChild(ans);
          for (const el of card.querySelectorAll('button, input')) el.disabled = true;
        }
        resolve({ answer, viaButton });
      };

      // Auto-cancel if the card is detached (session switch wipes
      // els.chat.innerHTML, a /clear nukes the chat, etc.). Without
      // this the promise hangs forever and the tool loop is stuck.
      cardObserver = new MutationObserver(() => {
        if (!settled && !card.isConnected) {
          finish('(cancelled — chat view changed)', false);
        }
      });
      cardObserver.observe(els.chat, { childList: true });

      if (options.length) {
        const chips = document.createElement('div');
        chips.className = 'ask-chips';
        for (const opt of options) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ask-chip';
          b.textContent = String(opt);
          b.addEventListener('click', () => finish(String(opt), true));
          chips.appendChild(b);
        }
        body.appendChild(chips);
      }

      if (allowFreeText) {
        const row = document.createElement('div');
        row.className = 'ask-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ask-input';
        input.placeholder = placeholder;
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'ask-send';
        send.textContent = 'Send';
        const submit = () => {
          const v = input.value.trim();
          if (!v) return;
          finish(v, false);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') finish('(cancelled)', false);
        });
        send.addEventListener('click', submit);
        row.appendChild(input);
        row.appendChild(send);
        body.appendChild(row);
        setTimeout(() => { try { input.focus(); } catch {} }, 50);
      }

      card.appendChild(head);
      card.appendChild(body);
      els.chat.appendChild(card);
      els.chat.scrollTop = els.chat.scrollHeight;
    });
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
      const bar = `<div class="code-bar"><span>${esc(lang)}</span><button class="copy-btn" data-code="${encodeURIComponent(code)}">Copy</button></div>`;
      return html.replace('<pre>', `<pre>${bar}`);
    };
    marked.Renderer.prototype.link = function (token) {
      return origLink.call(this, token).replace('<a ', '<a target="_blank" rel="noopener" ');
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function renderMarkdown(text) {
    try { return window.marked ? marked.parse(text || '') : esc(text || ''); }
    catch { return esc(text || ''); }
  }
  function jsonString(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }

  // Display-only redaction of common credentials. Model still receives
  // the raw values — this only affects what we render in the chat.
  function maskSensitive(str) {
    if (!state.settings?.redactSensitive) return str;
    return String(str)
      .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{16,}/g, '$1<REDACTED>')
      // 3-segment dot-delimited base64 JWT. Dot is NOT in the char class
      // so each segment is bounded cleanly (no greedy backtrack).
      .replace(/eyJ[A-Za-z0-9_\-+/=]+\.[A-Za-z0-9_\-+/=]+\.[A-Za-z0-9_\-+/=]+/g, 'eyJ<JWT-REDACTED>')
      .replace(/sk-(?:proj-|or-v1-)?[A-Za-z0-9_\-]{20,}/g, (m) => m.slice(0, 8) + '<REDACTED>')
      .replace(/\b[a-f0-9]{40,}\b/g, (m) => `${m.slice(0, 6)}<HEX-${m.length}-REDACTED>`)
      .replace(/(("?(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret|password|x-api-key))"?\s*[:=]\s*"?)[A-Za-z0-9._\-+/]{8,}/gi, '$1<REDACTED>');
  }

  function applyAppearance() {
    const theme = state.settings?.theme || 'system';
    document.body.classList.remove('theme-light', 'theme-dark');
    if (theme === 'light') document.body.classList.add('theme-light');
    else if (theme === 'dark') document.body.classList.add('theme-dark');
    document.body.classList.toggle('density-compact', state.settings?.density === 'compact');
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true })
      .catch(() => chrome.tabs.create({ url }));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function downloadText(text, filename, mime = 'text/markdown') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true })
      .catch(() => chrome.tabs.create({ url }));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function sessionToMarkdown(session) {
    const lines = [];
    lines.push(`# ${session.title || 'Untitled session'}`);
    lines.push('');
    lines.push(`- **Session id:** \`${session.id}\``);
    lines.push(`- **Created:** ${new Date(session.createdAt).toISOString()}`);
    if (session.url) lines.push(`- **URL:** ${session.url}`);
    if (session.provider) lines.push(`- **Provider/model:** ${session.provider} · ${session.model || ''}`);
    lines.push('');
    for (const m of session.history || []) {
      if (m.role === 'user') {
        lines.push('---');
        lines.push(`### 🧑 User${m._pinned ? ' ★' : ''}`);
        lines.push('');
        if (typeof m.content === 'string') lines.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === 'text') lines.push(part.text);
            else if (part.type === 'image_url') lines.push(`\n![image](${part.image_url?.url || ''})\n`);
          }
        }
        lines.push('');
      } else if (m.role === 'assistant') {
        lines.push(`### 🤖 Assistant${m._pinned ? ' ★' : ''}${m._error ? ' (error)' : ''}`);
        if (m._usage) lines.push(`*${m._usage.prompt_tokens || 0} in · ${m._usage.completion_tokens || 0} out tokens*`);
        lines.push('');
        if (m.content) lines.push(typeof m.content === 'string' ? m.content : contentText(m.content));
        if (m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            lines.push('');
            lines.push(`> ⚙ tool call: \`${tc.function.name}\``);
            lines.push('> ```json');
            try { JSON.parse(tc.function.arguments || '{}'); lines.push('> ' + (tc.function.arguments || '{}').split('\n').join('\n> ')); }
            catch { lines.push('> ' + tc.function.arguments); }
            lines.push('> ```');
          }
        }
        lines.push('');
      } else if (m.role === 'tool') {
        lines.push(`<details><summary>tool result: <code>${m.name || ''}</code></summary>`);
        lines.push('');
        lines.push('```json');
        lines.push((m.content || '').slice(0, 8000));
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  async function exportSessionMarkdown(sessionId) {
    const session = sessionId === state.activeSession?.id
      ? state.activeSession
      : await loadFullSession(sessionId);
    if (!session) return;
    const md = sessionToMarkdown(session);
    const safeTitle = (session.title || 'session').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    downloadText(md, `kyoto-${safeTitle}-${session.id.slice(-8)}.md`);
  }

  async function forkSession(sessionId) {
    const orig = await loadFullSession(sessionId);
    if (!orig) return;
    // Create unbound (tab = null) so the fork doesn't steal the original's
    // tab binding. User can bind it via the "bind" action if desired.
    const copy = createSessionObject(null);
    copy.title = (orig.title || 'session') + ' (fork)';
    copy.url = orig.url;
    copy.provider = orig.provider;
    copy.model = orig.model;
    // Deep clone history so subsequent edits don't leak back into the original.
    copy.history = JSON.parse(JSON.stringify(orig.history || []));
    await persistSession(copy);
    return copy;
  }

  async function testConnection() {
    if (!els.testConnStatus) return;
    const provider = els.provider.value;
    const apiKey = els.apiKey.value.trim();
    const model = els.model.value;
    const cfg = getProviderConfig(provider);
    if (!cfg) { els.testConnStatus.textContent = 'Unknown provider'; els.testConnStatus.className = 'status err'; return; }
    if (!model) { els.testConnStatus.textContent = 'Pick a model first'; els.testConnStatus.className = 'status err'; return; }
    if (!apiKey && !cfg.isCustom) { els.testConnStatus.textContent = 'API key required'; els.testConnStatus.className = 'status err'; return; }
    els.testConnStatus.textContent = 'Testing…'; els.testConnStatus.className = 'status';
    const t0 = Date.now();
    try {
      const res = await fetch(cfg.chatUrl, {
        method: 'POST',
        headers: cfg.headers(apiKey),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const txt = await res.text();
        els.testConnStatus.textContent = `HTTP ${res.status} in ${elapsed}ms — ${txt.slice(0, 160)}`;
        els.testConnStatus.className = 'status err';
        return;
      }
      const data = await res.json().catch(() => ({}));
      els.testConnStatus.textContent = `✓ ${elapsed}ms · ${cfg.label}`;
      els.testConnStatus.className = 'status ok';
    } catch (e) {
      els.testConnStatus.textContent = `Network error: ${e.message}`;
      els.testConnStatus.className = 'status err';
    }
  }

  async function exportSettings() {
    const dump = await chrome.storage.local.get(null);
    // Strip session bodies / huge keys; keep settings + secrets only.
    const filtered = {};
    for (const [k, v] of Object.entries(dump)) {
      if (k.startsWith('kyoto_session_')) continue;
      if (k.startsWith('kyoto_memory_')) continue;
      if (k === 'kyoto_sessions_index') continue;   // index would reference missing bodies after import
      if (k === 'kyoto_memory_index') continue;
      if (k === 'kyoto_audit_log') continue;
      if (k === 'kyoto_cookie_snapshot') continue;
      if (k === 'kyoto_models_dev_cache') continue;
      filtered[k] = v;
    }
    downloadJson({ kyoto: true, version: 9, exportedAt: new Date().toISOString(), settings: filtered },
      `kyoto-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    if (els.backupStatus) {
      els.backupStatus.textContent = 'Exported.';
      els.backupStatus.className = 'status ok';
    }
  }

  function importSettingsFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed?.kyoto || typeof parsed.settings !== 'object') {
          throw new Error('Not a Kyoto settings export.');
        }
        // Merge by setting every top-level key from settings into storage.
        await chrome.storage.local.set(parsed.settings);
        els.backupStatus.textContent = 'Imported — reload the side panel to apply.';
        els.backupStatus.className = 'status ok';
      } catch (e) {
        els.backupStatus.textContent = `Failed: ${e.message}`;
        els.backupStatus.className = 'status err';
      }
    };
    reader.readAsText(file);
  }

  function auditAppend(entry) {
    if (!state.settings?.auditEnabled) return;
    state.auditLog ||= [];
    state.auditLog.push({ ts: Date.now(), ...entry });
    if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 1000);
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diff = (now - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  function newId() { return 'sess_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function isActive(sessionId) { return state.activeSession?.id === sessionId; }

  // ── Slash commands ───────────────────────────────────
  // Built-in commands. {{args}} expands to whatever followed the command.
  // Commands prefixed with [CMD]: are handled inline by the panel, not
  // sent to the model.
  const BUILTIN_SLASH = {
    '/help':       '[CMD]:help',
    '/clear':      '[CMD]:clear',
    '/pin':        '[CMD]:pin_last_assistant',
    '/sessions':   '[CMD]:open_sessions',
    '/settings':   '[CMD]:open_settings',
    '/summarize':  'Summarize the current page in 5 concise bullet points.',
    '/explain':    'Explain the main concept on this page in simple terms. {{args}}',
    '/eli5':       "Explain this page like I'm 10 years old.",
    '/keypoints':  'What are the key takeaways from this page?',
    '/cookies':    'Use `cookies_analyze` on the current site, then summarise which cookies look like session/auth tokens vs tracking.',
    '/clone-session': 'Use `cookies_analyze`, then `cookies_export` with format "netscape" for this site. Show me the cookies.txt block.',
    '/curl':       'Use `cookies_export` with format "curl-b" for this site and give me a curl command I can paste.',
    '/network':    'Start a tab-scoped network capture via `network_capture_start`. List the latest requests with `network_capture_list`. Summarise interesting endpoints. {{args}}',
    '/api':        'Use `page_fetch_intercept` to hook fetch/XHR on this page, then tell me what API endpoints it calls and their shapes once I trigger some action. {{args}}',
    '/eval':       'Run this JS in the page via `page_eval` and report the result: {{args}}',
    '/screenshot': 'Capture a screenshot of this tab with `tab_screenshot` and describe what you see.',
    '/memory':     'List my saved memories using `memory_list`. {{args}}',
    '/remember':   'Save this as a long-lived memory using `memory_add`. Title and content based on: {{args}}',
    '/recall':     'Search my saved memories using `memory_search` for: {{args}}',
    '/inspect':    'Use `page_query` to inspect "{{args}}" on the current page and describe what you find (tag, attrs, text, visibility).',
    '/perf':       'Run `page_performance` on the current tab and summarise the navigation timing and paint metrics.',
    '/see':        '[CMD]:vision_one_shot',
    '/har':        'Export the captured network buffer as HAR using `network_har_export`. Show me a summary of how many entries and the top hosts.',
    '/diffcookies': 'First call `cookies_snapshot` for this site with label "before", then wait — when I say "now", call `cookies_diff` with label "before" and show what changed.',
    '/search':     'Use `minimax_web_search` to find: {{args}}. Then summarise the top 3 results with citations.',
    '/vlm':        'Use `minimax_describe_tab` to analyze the current tab. Prompt: {{args}}',
    '/npm':        'Look up the npm package "{{args}}" using `npm_info`. Show version, license, repo, and dependencies.',
    '/pypi':       'Look up the PyPI package "{{args}}" using `pypi_info`. Show version, summary, and project URLs.',
    '/so':         'Use `stackoverflow_search` for: {{args}}. Show the top 5 results with title, score, and link.',
    '/ts':         'Take the JSON I just pasted (or the latest tool result) and use `json_to_typescript` to generate the TypeScript interfaces. Root name: {{args}}',
    '/postman':    'Export the captured network buffer as a Postman v2.1 collection using `network_postman_export`. Show me the host breakdown.',
    '/py':         'Run this Python via `python_exec` and show me the value + stdout/stderr: {{args}}',
    '/pip':        'Install the package(s) "{{args}}" via micropip in the Python sandbox, then `python_exec` a small import test to confirm.',
    '/media':      'Use `media_detect` on this tab to list every media URL (video / audio / streams) found in the DOM and recent network traffic. For each candidate, recommend the best download method: `yt_dlp_run` for site URLs, `media_download` for direct file URLs.',
    '/dl':          'Download the current tab (or {{args}} if it looks like a URL) via `yt_dlp_run`. Use full-quality defaults. Tell the user the saved path when done.',
    '/download':   'Download a direct file URL via `media_download`: {{args}}. (For YouTube / Instagram / Twitter / etc., use `/dl` instead — it goes through yt-dlp.)',
    '/s3':         'Upload the URL/file described in "{{args}}" to S3 via `s3_upload` and return the resulting S3 URL.',
    '/yt':         'Download the current YouTube video. Preferred path: `yt_dlp_run { url: <this tab\'s URL> }` — full speed, handles ciphers and merging. If the shell bridge isn\'t installed (yt_dlp_run errors with "shell bridge not installed"), fall back: try `youtube_extract` for direct URLs, then `youtube_capture_streams` for throttled in-browser download, and only as a last resort suggest `yt_dlp_command` for manual paste.',
    '/ytdl':       'Use `yt_dlp_command` to generate a yt-dlp invocation for this tab WITHOUT running it (for users who prefer manual paste). For automatic download, use /yt or /dl. {{args}}',
    '/sh':         'Run this shell command on the user\'s machine via `shell_exec`: {{args}}',
    '/shell':      'Run this shell command on the user\'s machine via `shell_exec`: {{args}}',
    '/goal':       '[CMD]:goal',
    '/loop':       '[CMD]:loop',
    '/ls':         'Use `fs_list` to show every file in the workspace. Format as a small tree.',
    '/zip':        'Use `fs_zip` to package the entire workspace into a ZIP and download it.',
    '/clearfs':    '[CMD]:clearfs',
    '/export':     'Use `chat_export` to download the current chat. Default format: markdown. {{args}}',
    '/export-json':'Use `chat_export { format: "json" }` to download the current chat as JSON.',
    '/export-md':  'Use `chat_export { format: "markdown" }` to download the current chat as Markdown.',
    '/export-all': 'Use `chat_export { format: "json", scope: "all" }` to bundle every session into one JSON file.',
    '/save-skill': '[CMD]:save_skill',
    '/skills':     '[CMD]:skills_list'
  };

  // ── Goal + loop primitives (inspired by Claude Code) ─────────
  function fmtDuration(ms) {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(ms % 60_000 ? 1 : 0)}m`.replace('.0', '');
    return `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)}h`.replace('.0', '');
  }
  function parseDuration(s) {
    const m = String(s || '').match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|sec|min|hr|seconds?|minutes?|hours?)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    if (unit === 'ms') return Math.round(n);
    if (unit.startsWith('h')) return Math.round(n * 3_600_000);
    if (unit.startsWith('m') && !unit.startsWith('ms')) return Math.round(n * 60_000);
    return Math.round(n * 1_000);
  }

  // Loops are side-panel-resident (setInterval). They survive session
  // switches and tab changes but stop when the side panel itself closes.
  function setupLoop(sessionId, intervalMs, prompt) {
    const id = 'loop_' + Math.random().toString(36).slice(2, 9);
    const intervalId = setInterval(() => fireLoop(id), intervalMs);
    state.activeLoops.set(id, { sessionId, intervalMs, prompt, count: 0, intervalId });
    return id;
  }
  async function fireLoop(loopId) {
    const loop = state.activeLoops.get(loopId);
    if (!loop) return;
    loop.count++;
    let session = state.activeSession?.id === loop.sessionId
      ? state.activeSession
      : await loadFullSession(loop.sessionId);
    if (!session) {
      // session got deleted — kill the loop
      clearInterval(loop.intervalId);
      state.activeLoops.delete(loopId);
      updateGoalUI();
      return;
    }
    // Skip a tick if the session is already busy (last run hasn't finished)
    if (state.runtimes[session.id]?.busy) return;
    session.history.push({ role: 'user', content: loop.prompt, _loopFire: loopId });
    const idx = session.history.length - 1;
    if (isActive(session.id)) {
      const { wrap } = addMessage('user', `🔁 ${loop.prompt}`);
      decoratePinButton(wrap, idx, false);
    }
    await persistSession(session);
    runChatLoop(session).catch(() => {}).finally(updateGoalUI);
    updateGoalUI();
  }
  function stopLoopsForSession(sessionId) {
    let n = 0;
    for (const [id, l] of state.activeLoops) {
      if (!sessionId || l.sessionId === sessionId) {
        clearInterval(l.intervalId);
        state.activeLoops.delete(id);
        n++;
      }
    }
    return n;
  }
  function stopLoop(loopId) {
    const l = state.activeLoops.get(loopId);
    if (!l) return false;
    clearInterval(l.intervalId);
    state.activeLoops.delete(loopId);
    return true;
  }
  // Detect the "I'm done" signal from the model. Lenient about formatting.
  function isGoalDoneText(text) {
    if (!text) return false;
    return /\[\s*goal[_\s-]?done\s*\]|\[\s*goal[_\s-]?complete\s*\]|\[\s*task[_\s-]?complete\s*\]/i.test(text);
  }

  // Heuristic: pull a site domain out of a URL. Edge cases:
  //   - chrome://, about:, file:, data: → return 'global' (no real domain)
  //   - IPv4 / IPv6 / localhost → return the hostname as-is (the last-two-
  //     segments trick produces nonsense like "1.1" for 192.168.1.1).
  //   - Multi-part TLDs (co.uk, ne.jp, …) → returns "co.uk" which is wrong
  //     in principle but acceptable for the dev domains Kyoto sees.
  function urlDomain(u) {
    if (!u) return 'global';
    try {
      const parsed = new URL(u);
      if (!/^https?:/.test(parsed.protocol)) return 'global';
      const h = (parsed.hostname || '').replace(/^www\./, '');
      if (!h) return 'global';
      // IPv4
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
      // IPv6 (parsed.hostname returns "[::1]" without the brackets)
      if (h.includes(':')) return h;
      // localhost / single-label hostnames
      if (!h.includes('.')) return h;
      const parts = h.split('.');
      return parts.slice(-2).join('.');
    } catch { return 'global'; }
  }

  // Distil a session's recent task into a saved Skill via a one-shot LLM
  // call. Triggered automatically on goal_done OR via /save-skill.
  async function extractAndSaveSkill(session, { trigger, hint, force } = {}) {
    if (!window.KyotoSkillHub) {
      if (force && isActive(session.id)) addMessage('assistant', '_Skill hub not available (extension not fully loaded)._', { error: true });
      return;
    }
    const cfg = await window.KyotoSkillHub.config();
    if (!cfg.url || !cfg.key) {
      if (force && isActive(session.id)) addMessage('assistant', '_Skills hub not configured. Open Settings → Skills hub to paste your URL + API key._', { error: true });
      return;
    }

    // Summarise the recent activity. We trim aggressively so the
    // extraction call costs almost nothing in tokens.
    const hist = session.history || [];
    const toolCalls = [];
    let lastAssistantText = '';
    for (const m of hist) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = '';
          try { args = JSON.stringify(JSON.parse(tc.function.arguments || '{}')).slice(0, 200); }
          catch { args = (tc.function.arguments || '').slice(0, 200); }
          toolCalls.push({ name: tc.function.name, args, id: tc.id });
        }
      }
      if (m.role === 'tool' && m.tool_call_id) {
        const target = toolCalls.find(t => t.id === m.tool_call_id);
        if (target) {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          target.outcome = /(\\\"error\\\"|"error"|exit(Code)?: [^0])/i.test(c.slice(0, 400)) ? 'error' : 'ok';
        }
      }
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        lastAssistantText = m.content;
      }
    }

    if (!force && toolCalls.length < 2) {
      // Pure chit-chat / single tool — don't bother saving.
      return;
    }

    const tab = session.tabId ? await getTab(session.tabId) : null;
    const pageUrl = tab?.url || session.lastUrl || '';
    const domainHint = urlDomain(pageUrl) || 'global';

    const seq = toolCalls.slice(0, 30)
      .map((t, i) => `${i + 1}. ${t.name}(${t.args})  → ${t.outcome || 'ok'}`)
      .join('\n');

    const goal = session.goal || hint || (hist.find(m => m.role === 'user')?.content || '').slice(0, 400);

    const extractPrompt =
      'You are a skill-extractor. The user just had an AI agent accomplish a real task and you must distill the WORKING approach into a reusable playbook. ' +
      'Output ONLY one JSON object, no commentary, matching this shape:\n' +
      '{ "skip": true, "reason": "..." }   // if the task was trivial (single tool, pure Q&A, no exploration)\n' +
      '— or —\n' +
      '{\n' +
      '  "domain": "<eTLD+1 if site-bound, else \\"global\\">",\n' +
      '  "name": "<imperative title, <60 chars>",\n' +
      '  "description": "<one-line summary, <200 chars>",\n' +
      '  "content": "<markdown playbook: ### Prereqs, ### Steps (numbered), ### What does NOT work, ### Gotchas>",\n' +
      '  "tags": ["<kebab-case>", ...]   // 2-6 tags\n' +
      '}\n\n' +
      `Context — page URL: ${pageUrl || '(none)'}  · domain hint: ${domainHint}\n` +
      `User goal: ${goal}\n` +
      `Tool sequence (in order, max 30):\n${seq || '(none)'}\n` +
      `Final assistant reply (last 400 chars):\n${(lastAssistantText || '').slice(-400)}\n` +
      (hint ? `\nUser hint about the skill: ${hint}\n` : '');

    if (isActive(session.id)) addMessage('assistant', '_💡 Extracting skill from this turn…_');

    let raw;
    try { raw = await oneShotCompletion(extractPrompt, { maxTokens: 1200, temperature: 0.2 }); }
    catch (e) {
      if (isActive(session.id)) addMessage('assistant', `_Skill extraction failed: ${e.message}_`, { error: true });
      return;
    }

    // Pull out the first JSON object from the response.
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) {
      if (isActive(session.id)) addMessage('assistant', `_Skill extraction: model returned no JSON._`, { error: true });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch (e) {
      if (isActive(session.id)) addMessage('assistant', `_Skill extraction: bad JSON (${e.message})._`, { error: true });
      return;
    }
    if (parsed.skip) {
      if (isActive(session.id)) addMessage('assistant', `_Skill extraction skipped: ${parsed.reason || 'task was trivial'}._`);
      return;
    }
    if (!parsed.name || !parsed.content) {
      if (isActive(session.id)) addMessage('assistant', `_Skill extraction: missing required fields (name + content)._`, { error: true });
      return;
    }
    const cleanTags = (Array.isArray(parsed.tags) ? parsed.tags : [])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim().toLowerCase());
    const save = await window.KyotoSkillHub.save({
      domain: (typeof parsed.domain === 'string' && parsed.domain) ? parsed.domain : domainHint,
      name: parsed.name,
      description: (typeof parsed.description === 'string') ? parsed.description : '',
      content: parsed.content,
      tags: cleanTags,
      createdBy: trigger === 'manual' ? 'user' : 'agent',
    });
    if (save?.error) {
      if (isActive(session.id)) addMessage('assistant', `_Skill save failed: ${save.error}_`, { error: true });
      return;
    }
    if (isActive(session.id)) {
      const where = parsed.domain || domainHint;
      addMessage('assistant', `_💡 Saved skill **${parsed.name}** under \`${where}\` (\`${save.skill_id}\`)._`);
    }
  }

  // One-shot non-streaming completion using the active provider/model.
  // For internal helpers like skill extraction — no tools, no history,
  // returns plain text.
  // ─────────────── User-action capture ───────────────────
  // "Record button" pattern: while active, we inject a tiny event
  // listener into the page. It captures clicks, fills, submits, key
  // presses and navigations and forwards them here. On stop we ask
  // for a skill name + description and distil the timeline into a
  // markdown playbook via oneShotCompletion, then save to the hub.
  state.capture = { active: false, sessionId: null, events: [], tabId: null, startedAt: 0, startUrl: '' };

  // The function below is serialised + injected into the page by
  // chrome.scripting.executeScript. It must be self-contained: no
  // closures, no helpers from this file. Returns { ok } so the
  // injection promise can detect double-install.
  //
  // The session ID is stamped onto every fired event so the side
  // panel can drop events from a previous (now-stopped) capture
  // session — without it, listeners that survive across stop→start
  // cycles or live in the wrong tab can leak events into the new
  // session and silently corrupt the captured timeline.
  function _kyotoCaptureContentScript(sessionId) {
    // On re-injection (idempotent guard): just refresh the session ID
    // so existing listeners stamp the NEW value. This is the key trick
    // for cross-session safety.
    window.__kyotoCaptureSessionId = sessionId;
    if (window.__kyotoCaptureInstalled) return { ok: true, already: true };
    window.__kyotoCaptureInstalled = true;

    const esc = (window.CSS && CSS.escape) || (s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    const VISIBLE_TEXT_MAX = 80;
    const VALUE_MAX = 200;

    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + esc(el.id);
      const dt = el.getAttribute && el.getAttribute('data-testid');
      if (dt) return `[data-testid="${esc(dt)}"]`;
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria && aria.length < 40) return `[aria-label="${esc(aria)}"]`;
      const name = el.getAttribute && el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${esc(name)}"]`;
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && cur !== document.body && depth < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
        const sib = cur.parentNode ? Array.from(cur.parentNode.children).filter(s => s.tagName === cur.tagName) : [];
        if (sib.length > 1) {
          const idx = sib.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
        parts.unshift(part);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function visibleText(el) {
      if (!el) return '';
      const raw = (el.innerText || el.textContent || el.value || '').toString();
      return raw.replace(/\s+/g, ' ').trim().slice(0, VISIBLE_TEXT_MAX);
    }

    function maskValue(el) {
      if (!el) return '';
      const t = (el.type || '').toLowerCase();
      if (t === 'password') return '«password»';
      if (t === 'email')    return '«email»';
      if (t === 'tel')      return '«phone»';
      // Catch payment / OTP / secret-ish inputs that don't use a typed
      // <input>. Sniff name / aria-label / placeholder / autocomplete
      // for keywords the user would NOT want in a saved skill log.
      const hint = [
        el.getAttribute && el.getAttribute('name'),
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('placeholder'),
        el.getAttribute && el.getAttribute('autocomplete'),
        el.id,
      ].filter(Boolean).join(' ').toLowerCase();
      if (/\b(cc|card|ccv|cvv|cvc|exp|expiry|expir|pan)\b/.test(hint)) return '«card»';
      if (/\b(otp|totp|2fa|mfa|one[-_ ]?time|verif(?:y|ication)[-_ ]?code|auth[-_ ]?code)\b/.test(hint)) return '«otp»';
      if (/\b(secret|token|api[-_ ]?key|private[-_ ]?key|ssn|tax[-_ ]?id)\b/.test(hint)) return '«secret»';
      const v = String(el.value ?? '');
      return v.length > VALUE_MAX ? v.slice(0, VALUE_MAX) + '…' : v;
    }

    function fire(payload) {
      const sid = window.__kyotoCaptureSessionId;
      if (!sid) return;  // capture stopped — drop without sending
      try {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_EVENT',
          sessionId: sid,
          payload: {
            ...payload,
            url: location.href,
            title: document.title,
            ts: Date.now(),
          },
        });
      } catch (_e) {}
    }

    // De-duplicate change events from the same input within a short
    // window — typing fires many.
    const _lastFillKey = new Map();
    function recordFill(el) {
      const sel = buildSelector(el);
      const key = sel + '|' + (el.type || '');
      const now = Date.now();
      const last = _lastFillKey.get(key) || 0;
      _lastFillKey.set(key, now);
      // If we just fired for this input < 800 ms ago, replace by waiting
      // — naive but good enough. (We always send the latest value on
      // blur/change so it's not lossy.)
      if (now - last < 800) return;
      fire({
        event: 'fill',
        selector: sel,
        inputType: el.type || el.tagName.toLowerCase(),
        value: maskValue(el),
        label: visibleText(el.labels?.[0] || (el.closest ? el.closest('label') : null) || el),
      });
    }

    document.addEventListener('click', (e) => {
      const el = e.target.closest ? e.target.closest('a,button,[role="button"],input[type="submit"],input[type="button"],label,summary,[onclick]') || e.target : e.target;
      if (!el) return;
      fire({
        event: 'click',
        selector: buildSelector(el),
        text: visibleText(el),
        tag: el.tagName,
        href: el.href || null,
      });
    }, true);

    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      recordFill(el);
    }, true);

    // Also fire on blur for inputs so typing-then-tab gets recorded.
    document.addEventListener('blur', (e) => {
      const el = e.target;
      if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      if (el.value !== el.defaultValue) recordFill(el);
    }, true);

    document.addEventListener('submit', (e) => {
      fire({ event: 'submit', selector: buildSelector(e.target), tag: 'FORM' });
    }, true);

    document.addEventListener('keydown', (e) => {
      if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
        fire({
          event: 'key',
          key: e.key,
          selector: buildSelector(e.target),
          text: visibleText(e.target),
        });
      }
    }, true);

    fire({ event: 'nav', selector: 'window' });
    return { ok: true };
  }

  function updateCaptureUI() {
    if (!els.captureBtn) return;
    if (state.capture.active) {
      els.captureBtn.classList.add('recording');
      els.captureBtn.title = `Recording on this tab — click to stop (${state.capture.events.length} events)`;
      if (els.captureCount) els.captureCount.textContent = String(state.capture.events.length);
    } else {
      els.captureBtn.classList.remove('recording');
      els.captureBtn.title = 'Record a skill — capture user actions on this page and save them as a reusable playbook';
      if (els.captureCount) els.captureCount.textContent = '';
    }
  }

  async function startCapture() {
    if (state.capture.active) return;
    const tab = await chrome.tabs.query({ active: true, currentWindow: true }).then(arr => arr[0]);
    if (!tab || !tab.id) { addMessage('assistant', '_No active tab to capture._', { error: true }); return; }
    if (/^chrome|^edge|^about|^view-source/.test(tab.url || '')) {
      addMessage('assistant', `_Can\'t capture on \`${tab.url}\` (Chrome blocks content-script injection on internal pages)._`, { error: true });
      return;
    }
    const sessionId = 'cap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    state.capture = {
      active: true, sessionId, events: [], tabId: tab.id,
      startedAt: Date.now(), startUrl: tab.url || '',
    };
    updateCaptureUI();
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: _kyotoCaptureContentScript,
        args: [sessionId],
      });
    } catch (e) {
      state.capture = { active: false, sessionId: null, events: [], tabId: null, startedAt: 0, startUrl: '' };
      updateCaptureUI();
      addMessage('assistant', `_Capture failed: ${e.message}_`, { error: true });
      return;
    }
    // Re-inject after navigation — content scripts die on full reload.
    // We capture the sessionId at registration time so a navigation
    // event after stopCapture+startCapture re-injects with the NEW id.
    state.capture._navListener = (tabId, info) => {
      if (!state.capture.active) return;
      if (tabId !== state.capture.tabId || info.status !== 'complete') return;
      chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: _kyotoCaptureContentScript,
        args: [state.capture.sessionId],
      }).catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(state.capture._navListener);
    addMessage('assistant', `_● Recording on \`${urlDomain(tab.url || '')}\`. Do the workflow you want to teach the agent. Click the red dot in the header when done._`);
  }

  async function stopCapture() {
    if (!state.capture.active) return;
    const events = state.capture.events.slice();
    const startUrl = state.capture.startUrl;
    const tabId = state.capture.tabId;
    // Unregister BEFORE clearing state so the listener doesn't see a
    // partial state object during the removal window.
    if (state.capture._navListener) {
      try { chrome.tabs.onUpdated.removeListener(state.capture._navListener); } catch {}
    }
    // Tell the in-page listeners to start dropping events immediately
    // by zeroing the session id on the active page. Best-effort: if the
    // tab navigated/closed, this no-ops cleanly.
    if (tabId != null) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          func: () => { window.__kyotoCaptureSessionId = null; },
        });
      } catch {}
    }
    state.capture = { active: false, sessionId: null, events: [], tabId: null, startedAt: 0, startUrl: '' };
    updateCaptureUI();

    if (!events.length) {
      addMessage('assistant', '_Capture stopped — no events recorded. Try again on a page where you can interact._', { error: true });
      return;
    }

    const skip = await window.KyotoAskUser({
      question: `Captured ${events.length} actions on ${urlDomain(startUrl)}. What should this skill be called?`,
      placeholder: 'e.g. "Reply to a Linear ticket as resolved"',
      options: ['Discard recording'],
    });
    if (!skip || skip.answer === 'Discard recording') {
      addMessage('assistant', '_Recording discarded._');
      return;
    }
    const name = (skip.answer || '').trim();
    if (!name) { addMessage('assistant', '_No name provided — recording discarded._', { error: true }); return; }
    await saveCapturedSkill(name, events, startUrl);
  }

  async function saveCapturedSkill(name, events, startUrl) {
    addMessage('assistant', `_💡 Distilling ${events.length} captured actions into a skill…_`);
    const domain = urlDomain(startUrl) || 'global';

    // Compact serialisation — keep it tight to save tokens.
    const compact = events.slice(0, 200).map((e, i) => {
      const ts = (e.ts || 0) - (events[0]?.ts || e.ts || 0);
      const head = `[${(ts / 1000).toFixed(1)}s] ${e.event}`;
      const parts = [head];
      if (e.selector) parts.push(`sel=${e.selector}`);
      if (e.text)     parts.push(`text="${e.text.replace(/"/g, '\\"')}"`);
      if (e.value !== undefined && e.value !== '') parts.push(`value=${e.value}`);
      if (e.key)      parts.push(`key=${e.key}`);
      if (e.href)     parts.push(`href=${e.href}`);
      if (e.url && (i === 0 || e.url !== events[i - 1]?.url)) parts.push(`url=${e.url}`);
      return parts.join(' · ');
    }).join('\n');

    const prompt =
      'You are an automation skill writer. The user demonstrated a workflow on a website by recording their actions. ' +
      'Distil this into a clean, reproducible markdown playbook a future AI agent can follow with tools like page_click + page_fill + tab_navigate. ' +
      'Output ONLY a JSON object: { "description": "<one-line summary, <200 chars>", "content": "<markdown playbook>", "tags": ["<kebab-case>", "..."] }. ' +
      'In the content:\n' +
      '- Start with ### Goal (one sentence) then ### Prereqs (auth state, page).\n' +
      '- Then ### Steps — numbered list. Each step references the CSS selector AND the visible text/label so a future agent can find the element even if selectors drift. Quote concrete values that are NOT secrets; leave placeholders («password», «email», etc) as-is.\n' +
      '- Then ### Gotchas — anything tricky (multi-step modals, async loads, retries).\n' +
      '- Keep under ~400 words. Concise > comprehensive.\n\n' +
      `Skill name: ${name}\n` +
      `Starting URL: ${startUrl}\n` +
      `Domain: ${domain}\n` +
      `Captured events (${events.length}, abbreviated to 200):\n${compact}`;

    let raw;
    try { raw = await oneShotCompletion(prompt, { maxTokens: 1500, temperature: 0.2 }); }
    catch (e) { addMessage('assistant', `_Distillation failed: ${e.message}_`, { error: true }); return; }
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) { addMessage('assistant', '_Distillation returned no JSON — saving raw event log instead._'); }
    let parsed = {};
    try { parsed = m ? JSON.parse(m[0]) : {}; } catch (e) {
      addMessage('assistant', `_Bad JSON from model — saving raw event log. (${e.message})_`, { error: true });
    }
    // Coerce model output defensively — JSON can be the right SHAPE but
    // wrong types (tags=string, content=number, …).
    const content = (typeof parsed.content === 'string' && parsed.content.trim())
      ? parsed.content
      : ('### Captured event log\n\n```\n' + compact + '\n```');
    const description = (typeof parsed.description === 'string' && parsed.description.trim())
      ? parsed.description
      : `Recorded workflow on ${domain}`;
    const tags = (Array.isArray(parsed.tags) ? parsed.tags : ['recorded'])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim().toLowerCase());

    if (!window.KyotoSkillHub) { addMessage('assistant', '_Skill hub not available._', { error: true }); return; }
    const cfg = await window.KyotoSkillHub.config();
    if (!cfg.url || !cfg.key) {
      addMessage('assistant', '_Skills hub not configured. Set URL + API key in Settings → Skills hub, then re-record._', { error: true });
      return;
    }
    const save = await window.KyotoSkillHub.save({
      domain, name, description, content,
      tags: tags.slice(0, 6),
      createdBy: 'user',
    });
    if (save?.error) { addMessage('assistant', `_Skill save failed: ${save.error}_`, { error: true }); return; }
    addMessage('assistant', `_💡 Saved skill **${name}** under \`${domain}\` (\`${save.skill_id}\`). ${events.length} captured actions distilled into ${content.length} chars of playbook._`);
    // Refresh the per-domain cache so the system prompt picks it up.
    if (typeof refreshSkillsForDomain === 'function') {
      try { _skillsDomainCache.delete(domain); await refreshSkillsForDomain(domain); } catch {}
    }
  }

  async function oneShotCompletion(prompt, { maxTokens = 800, temperature = 0.2 } = {}) {
    const { provider, model } = state.settings;
    const cfg = getProviderConfig(provider);
    if (!cfg) throw new Error(`unknown provider: ${provider}`);
    const apiKey = keyFor(provider);
    if (!apiKey && !cfg.isCustom) throw new Error(`no API key for ${cfg.label}`);
    // Delegate header construction to the provider config so non-Bearer
    // schemes (Anthropic's `x-api-key`, custom providers with bespoke
    // headers) keep working. Previously hardcoded `authorization: Bearer …`
    // silently 401'd on non-OpenAI-compat providers.
    const headers = { 'content-type': 'application/json', ...cfg.headers(apiKey) };
    const res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  async function updateWorkspaceUI() {
    if (!els.workspaceSummary || !window.KyotoVFS) return;
    try {
      const t = await window.KyotoVFS.total();
      els.workspaceSummary.textContent = t.fileCount
        ? `${t.fileCount} file${t.fileCount === 1 ? '' : 's'} · ${fmtBytes(t.totalBytes)}`
        : 'empty';
    } catch (e) {
      els.workspaceSummary.textContent = `error: ${e.message}`;
    }
  }

  function updateGoalUI() {
    if (!els.goalBar) return;
    const session = state.activeSession;
    if (!session) {
      els.goalBar.classList.add('hidden');
      els.goalBar.innerHTML = '';
      return;
    }
    const items = [];
    if (session.goal) {
      items.push(`<div class="goal-item">🎯 <strong>Goal:</strong><span class="goal-text">${esc(session.goal)}</span><button class="goal-x" data-act="clear-goal" title="Clear goal">×</button></div>`);
    }
    for (const [id, l] of state.activeLoops) {
      if (l.sessionId !== session.id) continue;
      items.push(`<div class="goal-item">🔁 <strong>Loop:</strong><span class="goal-text">every ${fmtDuration(l.intervalMs)}: ${esc(l.prompt)} (${l.count} fired)</span><button class="goal-x" data-act="stop-loop" data-id="${esc(id)}" title="Stop loop">×</button></div>`);
    }
    if (!items.length) {
      els.goalBar.classList.add('hidden');
      els.goalBar.innerHTML = '';
      return;
    }
    els.goalBar.classList.remove('hidden');
    els.goalBar.innerHTML = items.join('');
  }

  function expandSlash(text) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return { kind: 'send', text };
    const spaceIdx = trimmed.search(/\s/);
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    // Look up: built-ins, then customs
    const custom = (state.settings.customSlashCommands || []).find(c => `/${c.name.replace(/^\/+/, '')}`.toLowerCase() === cmd);
    const template = custom?.prompt ?? BUILTIN_SLASH[cmd];
    if (!template) return { kind: 'send', text };
    if (typeof template === 'string' && template.startsWith('[CMD]:')) {
      return { kind: 'inline', action: template.slice(6), args };
    }
    const expanded = template.replace(/\{\{args\}\}/g, args).trim();
    return { kind: 'send', text: expanded };
  }

  async function clearChat() {
    if (!state.activeSession) return;
    state.activeSession.history = [];
    state.activeSession.title = 'New chat';
    await persistSession(state.activeSession);
    renderSessionHistoryFresh();
  }

  async function handleInlineSlash(action, args) {
    if (action === 'help') {
      const lines = Object.keys(BUILTIN_SLASH).sort().map(k => {
        const v = BUILTIN_SLASH[k];
        return `- \`${k}\` ${v.startsWith('[CMD]:') ? '_(panel action)_' : ''}`;
      });
      addMessage('assistant', `**Slash commands**\n\n${lines.join('\n')}\n\nUse \`{{args}}\` in custom prompts (Settings → Custom slash commands).`);
      return;
    }
    if (action === 'clear') {
      clearChat();
      return;
    }
    if (action === 'pin_last_assistant') {
      if (!state.activeSession) return;
      const hist = state.activeSession.history;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].role === 'assistant') {
          hist[i]._pinned = !hist[i]._pinned;
          await persistSession(state.activeSession);
          renderSessionHistoryFresh();
          return;
        }
      }
      addMessage('assistant', '_No assistant message to pin yet._', { error: true });
      return;
    }
    if (action === 'open_sessions') { toggleSessionsPopover(); return; }
    if (action === 'open_settings') { openDrawer(); return; }

    if (action === 'save_skill') {
      if (!state.activeSession) { addMessage('assistant', '_No active session._', { error: true }); return; }
      await extractAndSaveSkill(state.activeSession, { trigger: 'manual', force: true, hint: (args || '').trim() });
      return;
    }
    if (action === 'skills_list') {
      if (!window.KyotoSkillHub) { addMessage('assistant', '_Skill hub not loaded._', { error: true }); return; }
      const domain = (args || '').trim() || (state.page?.url ? urlDomain(state.page.url) : 'global');
      const r = await window.KyotoSkillHub.search(domain, '', 10, true);
      if (r?.error) { addMessage('assistant', `_Skill hub error: ${r.error}_`, { error: true }); return; }
      const items = r?.items || [];
      if (!items.length) { addMessage('assistant', `_No skills saved for \`${domain}\` yet._`); return; }
      const lines = items.map(i => `- **${i.name}** (\`${i.skill_id}\`, ${i.domain}) — ${i.description || '_no description_'}`);
      addMessage('assistant', `**Skills available for \`${domain}\`:**\n\n${lines.join('\n')}\n\nThe agent can pull any of these via \`skill_get\` when relevant.`);
      return;
    }

    if (action === 'clearfs') {
      if (!window.KyotoVFS) { addMessage('assistant', '_VFS not loaded._', { error: true }); return; }
      const t = await window.KyotoVFS.total();
      if (!t.fileCount) { addMessage('assistant', '_Workspace is already empty._'); return; }
      if (!confirm(`Delete all ${t.fileCount} workspace files (${(t.totalBytes / 1024).toFixed(1)} KB)? This can't be undone.`)) return;
      await window.KyotoVFS.clear();
      addMessage('assistant', `_Cleared workspace (${t.fileCount} files, ${(t.totalBytes / 1024).toFixed(1)} KB freed)._`);
      updateWorkspaceUI();
      return;
    }

    if (action === 'goal') {
      if (!state.activeSession) { addMessage('assistant', '_No active session — open or create one first._', { error: true }); return; }
      const session = state.activeSession;
      const trimmed = (args || '').trim();
      if (!trimmed || trimmed === 'clear' || trimmed === 'off' || trimmed === 'stop') {
        if (session.goal) {
          session.goal = null;
          await persistSession(session);
          addMessage('assistant', '_Goal cleared._');
        } else {
          addMessage('assistant', '_No active goal._', { error: true });
        }
        updateGoalUI();
        return;
      }
      if (trimmed === 'status' || trimmed === 'show') {
        if (session.goal) addMessage('assistant', `_Active goal:_ **${session.goal}**`);
        else addMessage('assistant', '_No active goal._');
        return;
      }
      session.goal = trimmed;
      await persistSession(session);
      updateGoalUI();
      // Kick off immediately — same wrapper text the loop appends so the
      // model knows how to signal completion.
      return sendMessage(
        `Goal: ${trimmed}\n\n` +
        `Work toward this goal using whatever tools you need. When you have fully completed it, include the literal token [GOAL_DONE] in your final reply so I know to stop. ` +
        `If you cannot make further progress without me, ask. Type \`/goal clear\` to abandon.`
      );
    }

    if (action === 'loop') {
      if (!state.activeSession) { addMessage('assistant', '_No active session — open or create one first._', { error: true }); return; }
      const trimmed = (args || '').trim();
      if (!trimmed || trimmed === 'list' || trimmed === 'status') {
        const mine = [...state.activeLoops].filter(([, l]) => l.sessionId === state.activeSession.id);
        if (!mine.length) { addMessage('assistant', '_No active loops in this session._'); return; }
        const lines = mine.map(([, l]) => `- every ${fmtDuration(l.intervalMs)} (${l.count} fired so far): ${l.prompt.slice(0, 100)}`);
        addMessage('assistant', '**Active loops in this session:**\n\n' + lines.join('\n') + '\n\n`/loop stop` clears them all.');
        return;
      }
      if (trimmed === 'stop' || trimmed === 'clear' || trimmed === 'off') {
        const n = stopLoopsForSession(state.activeSession.id);
        addMessage('assistant', n ? `_Stopped ${n} loop(s) in this session._` : '_No active loops to stop._');
        updateGoalUI();
        return;
      }
      const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        addMessage('assistant', '_Usage:_ `/loop <interval> <prompt>` — e.g. `/loop 5m /search latest AI news` or `/loop 30s check this page for changes`. Minimum 5s.', { error: true });
        return;
      }
      const ms = parseDuration(m[1]);
      const prompt = m[2].trim();
      if (!ms || ms < 5000) {
        addMessage('assistant', '_Interval must be at least 5s. Examples: `30s`, `5m`, `1h`._', { error: true });
        return;
      }
      setupLoop(state.activeSession.id, ms, prompt);
      addMessage('assistant', `_Loop active:_ every ${fmtDuration(ms)} running \`${prompt}\`. Type \`/loop stop\` to cancel. Loops stop when this side panel closes (not persisted across reloads).`);
      updateGoalUI();
      return;
    }
    if (action === 'vision_one_shot') {
      // /see <prompt> — capture screenshot now and send as a multimodal
      // user message. Also clears any pending toggle so the *next*
      // message doesn't double-attach.
      if (state.visionPending) { state.visionPending = false; updateVisionUI(); }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
        const prompt = args || 'Describe what you see in this screenshot in detail.';
        return sendMessage([
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]);
      } catch (e) {
        addMessage('assistant', `Screenshot failed: ${e.message}`, { error: true });
      }
      return;
    }
  }

  // ── Slash command palette ────────────────────────────
  // Live dropdown above the composer. Appears when the input starts
  // with "/" and the user hasn't typed a space yet (which would mean
  // the command is committed and they're typing args).
  function allSlashCommands() {
    // Dedup by name; customs override built-ins (matches expandSlash's
    // lookup order — otherwise the palette would show two rows for the
    // same command and the wrong one might be selected.)
    const byName = new Map();
    for (const [k, v] of Object.entries(BUILTIN_SLASH)) {
      byName.set(k.slice(1), {
        name: k.slice(1),
        template: v,
        builtin: true,
        action: typeof v === 'string' && v.startsWith('[CMD]:')
      });
    }
    for (const c of (state.settings?.customSlashCommands || [])) {
      if (!c.name || !c.prompt) continue;
      const n = c.name.replace(/^\/+/, '');
      byName.set(n, { name: n, template: c.prompt, builtin: false, action: false });
    }
    return [...byName.values()];
  }

  function refreshSlashPalette() {
    if (!els.slashPalette || !els.input) return;
    const val = els.input.value;
    if (!val.startsWith('/')) {
      els.slashPalette.classList.add('hidden');
      return;
    }
    // Once the user types whitespace after the command, the command is
    // committed — hide the palette so it doesn't get in the way of
    // typing arguments.
    const spaceIdx = val.search(/\s/);
    if (spaceIdx !== -1) {
      els.slashPalette.classList.add('hidden');
      return;
    }
    const query = val.slice(1).toLowerCase();
    const all = allSlashCommands();
    const filtered = (query
      ? all.filter(c => c.name.toLowerCase().includes(query))
      : all
    ).slice(0, 24);

    if (!filtered.length) {
      els.slashPalette.classList.add('hidden');
      return;
    }
    els.slashPalette.classList.remove('hidden');
    const html = filtered.map((c, i) => {
      let preview = '';
      if (c.action) {
        preview = 'panel action';
      } else if (typeof c.template === 'string') {
        preview = c.template.replace(/\s+/g, ' ').slice(0, 120);
      }
      const tag = c.action ? '<span class="slash-tag">action</span>'
                : c.builtin ? ''
                : '<span class="slash-tag">custom</span>';
      return `<div class="slash-item${i === 0 ? ' active' : ''}" data-name="${esc(c.name)}" data-action="${c.action ? '1' : '0'}" role="option">
        <span class="slash-name">/${esc(c.name)}</span>
        <span class="slash-preview">${esc(preview)}</span>
        ${tag}
      </div>`;
    }).join('') + '<div class="slash-hint">Tab/Enter → fill · ↑↓ → navigate · Esc → close</div>';
    els.slashPalette.innerHTML = html;
  }

  function slashPaletteVisible() {
    return els.slashPalette && !els.slashPalette.classList.contains('hidden');
  }
  function moveSlashSelection(delta) {
    const items = els.slashPalette?.querySelectorAll('.slash-item');
    if (!items?.length) return;
    let idx = -1;
    items.forEach((el, i) => { if (el.classList.contains('active')) idx = i; });
    idx = (idx + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
  }
  function fillFromSlashPalette() {
    const active = els.slashPalette?.querySelector('.slash-item.active');
    if (!active) return false;
    const name = active.dataset.name;
    const isAction = active.dataset.action === '1';
    // Action commands take no args — fill without trailing space so
    // an immediate Enter sends. Templated commands get a space so the
    // user can keep typing args.
    els.input.value = `/${name}${isAction ? '' : ' '}`;
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
    els.slashPalette.classList.add('hidden');
    return true;
  }

  function toggleVisionPending() {
    state.visionPending = !state.visionPending;
    updateVisionUI();
  }
  function updateVisionUI() {
    if (!els.visionBtn) return;
    els.visionBtn.classList.toggle('active', state.visionPending);
    els.visionBtn.title = state.visionPending
      ? 'Screenshot will be attached to the next message. Click to cancel.'
      : 'Attach a screenshot of the current tab with the next message (requires a vision-capable model)';
  }

  // ── Settings persistence ─────────────────────────────
  const defaults = {
    provider: 'openrouter',
    apiKey: '',
    model: '',
    apiKeys: {},                  // per-provider stored keys
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 8192,
    toolsEnabled: true,
    enabledGroups: ['browser', 'page', 'storage', 'cookies', 'network', 'devtools', 'browser-data', 'misc', 'memory', 'minimax', 'media', 'shell', 'fs', 'meta'],
    mcpServers: [],
    redactSensitive: true,
    auditEnabled: true,
    // Agentic loop limits. opencode's pattern: high default, exposed
    // as config. Too low and complex multi-tool tasks die half-way.
    maxAgentSteps: 50,
    maxAutoContinues: 2,
    // AWS S3 / S3-compatible (R2, Wasabi, MinIO, B2-S3) for the
    // s3_upload and media_download tools.
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3Region: 'us-east-1',
    s3Bucket: '',
    s3KeyPrefix: '',
    s3Endpoint: '',
    // Skills hub — domain-scoped playbook store backed by a remote API.
    // Leave blank to disable everything (skill_* tools no-op cleanly).
    skillsHubUrl: '',
    skillsHubKey: '',
    skillsAutoSave: true,
    theme: 'system',           // 'system' | 'light' | 'dark'
    density: 'comfortable',    // 'comfortable' | 'compact'
    hideReasoning: false,
    // Custom OpenAI-compat providers: [{ id, label, baseUrl, modelsPath, chatPath, authHeader, authPrefix }]
    // id is "custom_<slug>"; selected via the same provider dropdown.
    customProviders: [],
    // Built-in slash command map. Users can override via customSlashCommands.
    customSlashCommands: [],
    // User-defined tools registered alongside built-ins. Each:
    //   { name, description, parameters (JSON string), code (function body) }
    // Code receives `args` and `ctx` (chrome, fetch are global). Async ok.
    customTools: []
  };

  // Provider resolver — returns the same shape as the built-in PROVIDERS
  // entries (label, chatUrl, modelsUrl, keysUrl, placeholder, headers, parseModels)
  // for any provider id, whether built-in or custom.
  function getProviderConfig(providerKey) {
    if (!providerKey) return null;
    if (PROVIDERS[providerKey]) return PROVIDERS[providerKey];
    const cp = (state.settings?.customProviders || []).find(p => p.id === providerKey);
    if (!cp) return null;
    const base = (cp.baseUrl || '').replace(/\/+$/, '');
    const chatPath = cp.chatPath || '/chat/completions';
    const modelsPath = cp.modelsPath || '/models';
    const authHeader = cp.authHeader || 'Authorization';
    const authPrefix = cp.authPrefix ?? 'Bearer ';
    return {
      label: cp.label || cp.id,
      chatUrl: base + chatPath,
      modelsUrl: base + modelsPath,
      keysUrl: cp.keysUrl || base,
      placeholder: cp.placeholder || 'API key…',
      headers: (key) => {
        const h = { 'Content-Type': 'application/json' };
        if (key) h[authHeader] = `${authPrefix}${key}`;
        return h;
      },
      parseModels: (data) => (data.data || data.models || []).map(m => ({
        id: m.id || m.model || m.name,
        name: m.id || m.model || m.name,
        group: cp.id,
        supportsTools: true
      })),
      defaultModel: cp.defaultModel || '',
      isCustom: true,
      cp
    };
  }

  // List of every provider id (built-in + custom) in dropdown order.
  function allProviderKeys() {
    return [...Object.keys(PROVIDERS), ...(state.settings?.customProviders || []).map(p => p.id)];
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(Object.keys(defaults));
    state.settings = { ...defaults, ...stored };
    // One-time migrate: legacy single apiKey -> per-provider map, then
    // clear the legacy field so it can't be used as a wrong-provider
    // fallback later.
    if (state.settings.apiKey) {
      if (!state.settings.apiKeys[state.settings.provider]) {
        state.settings.apiKeys[state.settings.provider] = state.settings.apiKey;
      }
      state.settings.apiKey = '';
      await chrome.storage.local.set({
        apiKeys: state.settings.apiKeys,
        apiKey: ''
      });
    }
    // Migrate enabledGroups when a new group is added to defaults.
    if (Array.isArray(state.settings.enabledGroups)) {
      const missing = defaults.enabledGroups.filter(g => !state.settings.enabledGroups.includes(g));
      if (missing.length) {
        state.settings.enabledGroups = [...state.settings.enabledGroups, ...missing];
        await chrome.storage.local.set({ enabledGroups: state.settings.enabledGroups });
      }
    }
    return state.settings;
  }
  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    await chrome.storage.local.set(patch);
  }
  function keyFor(provider) { return state.settings.apiKeys?.[provider] || ''; }
  function currentApiKey() { return keyFor(state.settings.provider); }

  // ── Session storage ──────────────────────────────────
  const SESS_KEY = (id) => `kyoto_session_${id}`;
  const INDEX_KEY = 'kyoto_sessions_index';

  async function loadSessionsIndex() {
    const got = await chrome.storage.local.get(INDEX_KEY);
    return got[INDEX_KEY] || [];
  }
  async function loadFullSession(id) {
    const got = await chrome.storage.local.get(SESS_KEY(id));
    return got[SESS_KEY(id)] || null;
  }
  async function persistSession(s) {
    s.lastActive = Date.now();
    await chrome.storage.local.set({ [SESS_KEY(s.id)]: s });
    const idx = state.sessionsIndex.findIndex(x => x.id === s.id);
    const meta = { id: s.id, title: s.title, tabId: s.tabId, url: s.url, createdAt: s.createdAt, lastActive: s.lastActive };
    if (idx >= 0) state.sessionsIndex[idx] = meta;
    else state.sessionsIndex.unshift(meta);
    state.sessionsIndex.sort((a, b) => b.lastActive - a.lastActive);
    await chrome.storage.local.set({ [INDEX_KEY]: state.sessionsIndex });
    // Invalidate the deep-search content cache so the next search picks
    // up newly-added messages instead of returning stale matches.
    sessionContentCache?.delete?.(s.id);
  }
  async function deleteSession(id) {
    await chrome.storage.local.remove(SESS_KEY(id));
    state.sessionsIndex = state.sessionsIndex.filter(s => s.id !== id);
    await chrome.storage.local.set({ [INDEX_KEY]: state.sessionsIndex });
    for (const t of Object.keys(state.tabToSession)) {
      if (state.tabToSession[t] === id) delete state.tabToSession[t];
    }
    if (state.runtimes[id]?.abort) state.runtimes[id].abort.abort();
    delete state.runtimes[id];
    sessionContentCache?.delete?.(id);
    // Stop any /loop schedulers attached to this session — otherwise
    // setInterval keeps firing fireLoop() which then can't load the
    // session, fails silently, and leaves the row in the goal bar.
    if (typeof stopLoopsForSession === 'function') stopLoopsForSession(id);
    if (state.activeSession?.id === id) {
      state.activeSession = null;
      if (typeof updateGoalUI === 'function') updateGoalUI();
    } else if (typeof updateGoalUI === 'function') {
      updateGoalUI();
    }
  }
  function createSessionObject(tab) {
    const id = newId();
    return {
      id,
      title: 'New chat',
      tabId: tab?.id ?? null,
      url: tab?.url ?? null,
      createdAt: Date.now(),
      lastActive: Date.now(),
      provider: state.settings.provider,
      model: state.settings.model,
      history: []
    };
  }
  async function createSession(tab) {
    const s = createSessionObject(tab);
    await persistSession(s);
    if (s.tabId != null) state.tabToSession[s.tabId] = s.id;
    return s;
  }

  // ── Switch / render whole session ────────────────────
  async function switchToSession(session, { fromUser = false } = {}) {
    state.activeSession = session;
    if (fromUser) state.pinnedToSession = true;
    if (session.tabId != null) state.tabToSession[session.tabId] = session.id;
    renderSessionHistoryFresh();
    updateModelLine();
    updateSessionsButton();
    updateGoalUI();
    refreshPageContext();
  }

  function renderSessionHistoryFresh() {
    els.chat.innerHTML = '';
    els.chat.appendChild(els.empty);
    const session = state.activeSession;
    if (!session) return;
    if (!session.history.length) {
      els.empty.classList.remove('hidden');
      return;
    }
    els.empty.classList.add('hidden');
    session.history.forEach((m, i) => renderHistoryEntry(m, i));
    const rt = state.runtimes[session.id];
    if (rt?.busy) {
      const banner = document.createElement('div');
      banner.className = 'streaming-banner';
      banner.id = 'streaming-banner';
      banner.textContent = '⟲ This session is still streaming. New text will appear when the response completes.';
      els.chat.appendChild(banner);
      els.sendBtn.disabled = true;
      els.stopBtn.classList.remove('hidden');
    } else {
      els.sendBtn.disabled = false;
      els.stopBtn.classList.add('hidden');
    }
  }

  function renderHistoryEntry(m, idx) {
    ensureEmptyHidden();
    if (m.role === 'user') {
      const r = addMessage('user', m.content, { historyIndex: idx, pinned: !!m._pinned });
      decorateEditButton(r.wrap, idx);
    } else if (m.role === 'assistant') {
      // reasoning block first (if any)
      const rContent = m.reasoning_content || m.reasoning || m.thinking;
      if (rContent && !state.settings?.hideReasoning) {
        const card = addReasoningCard();
        card.body.textContent = rContent;
        const stateEl = card.summary.querySelector('.reasoning-state');
        if (stateEl) stateEl.textContent = `${rContent.length} chars`;
      }
      if (m.content) addMessage('assistant', m.content, { error: !!m._error, historyIndex: idx, pinned: !!m._pinned });
      // Token usage chip (replay)
      if (m._usage) renderUsageChip(m._usage, m._cost);
      // Tool calls (then matching tool results follow as separate history entries)
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let args; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
          const card = addToolCallCard(tc.function.name, jsonString(args).slice(0, 2000));
          card.card.dataset.toolCallId = tc.id;
        }
      }
    } else if (m.role === 'tool') {
      // Match it to the latest tool card with that id
      const card = els.chat.querySelector(`.tool-card[data-tool-call-id="${CSS.escape(m.tool_call_id || '')}"]`);
      if (card) {
        const resultBlock = card.querySelector('.tool-result');
        const txt = maskSensitive(m.content);
        resultBlock.textContent = txt.length > 8000 ? txt.slice(0, 8000) + '\n…' : txt;
        const stateEl = card.querySelector('.tool-state');
        if (stateEl) {
          let isErr = false;
          try { isErr = !!JSON.parse(m.content)?.error; } catch {}
          stateEl.textContent = isErr ? 'error' : 'done';
          stateEl.className = `tool-state ${isErr ? 'err' : 'ok'}`;
        }
      }
    }
    scrollToBottom();
  }

  function ensureEmptyHidden() {
    if (els.empty && !els.empty.classList.contains('hidden')) els.empty.classList.add('hidden');
  }
  function scrollToBottom() { els.chat.scrollTop = els.chat.scrollHeight; }

  // ── Message rendering primitives ─────────────────────
  function addMessage(role, content, opts = {}) {
    ensureEmptyHidden();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.error ? ' error' : ''}${opts.pinned ? ' pinned' : ''}`;
    const label = document.createElement('div');
    label.className = `msg-role ${opts.error ? 'error' : role}`;
    label.textContent = opts.error ? 'Error' : role === 'user' ? 'You' : 'Assistant';

    if (opts.historyIndex != null && !opts.error) {
      const pin = document.createElement('button');
      pin.className = 'pin-btn';
      pin.dataset.idx = opts.historyIndex;
      pin.title = opts.pinned ? 'Unpin' : 'Pin this message (always included in context)';
      pin.textContent = opts.pinned ? '★' : '☆';
      label.appendChild(pin);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (Array.isArray(content)) {
      // multimodal — text parts rendered as markdown, image parts as <img>
      for (const part of content) {
        if (part.type === 'text' && part.text) {
          const t = document.createElement('div');
          if (role === 'assistant' || opts.error) t.innerHTML = renderMarkdown(part.text);
          else t.textContent = part.text;
          body.appendChild(t);
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const img = document.createElement('img');
          img.src = part.image_url.url;
          img.className = 'msg-image';
          img.loading = 'lazy';
          body.appendChild(img);
        }
      }
    } else if (role === 'assistant' || opts.error) {
      body.innerHTML = renderMarkdown(content);
    } else {
      body.textContent = content;
    }
    wrap.appendChild(label);
    wrap.appendChild(body);
    els.chat.appendChild(wrap);
    scrollToBottom();
    return { wrap, body, label };
  }

  // Inject a pin button into a message wrapper that was rendered live
  // before we knew its index in history. Re-renderings (via
  // renderSessionHistoryFresh) include the button by default.
  function decoratePinButton(wrap, idx, pinned) {
    if (!wrap) return;
    const label = wrap.querySelector('.msg-role');
    if (!label || label.querySelector('.pin-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'pin-btn';
    btn.dataset.idx = String(idx);
    btn.title = pinned ? 'Unpin' : 'Pin this message (always included in context)';
    btn.textContent = pinned ? '★' : '☆';
    label.appendChild(btn);
    if (pinned) wrap.classList.add('pinned');
  }

  // Edit button — only on user messages. Lets the user rewrite an
  // earlier turn and regenerate from there (truncates everything after).
  function decorateEditButton(wrap, idx) {
    if (!wrap || !wrap.classList.contains('user')) return;
    const label = wrap.querySelector('.msg-role');
    if (!label || label.querySelector('.edit-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'edit-btn';
    btn.dataset.idx = String(idx);
    btn.title = 'Edit this message and regenerate the rest of the conversation';
    btn.textContent = '✎';
    label.appendChild(btn);
  }

  async function editUserMessage(idx) {
    if (!state.activeSession) return;
    const session = state.activeSession;
    const msg = session.history[idx];
    if (!msg || msg.role !== 'user') return;
    if (state.runtimes[session.id]?.busy) return;

    const wrap = els.chat.querySelector(`.msg.user .edit-btn[data-idx="${idx}"]`)?.closest('.msg');
    if (!wrap) return;
    const body = wrap.querySelector('.msg-body');
    if (!body || wrap.querySelector('.edit-area')) return;

    const current = contentText(msg.content);
    const editor = document.createElement('div');
    editor.className = 'edit-area';
    editor.innerHTML = `
      <textarea class="edit-textarea" rows="3"></textarea>
      <div class="edit-actions">
        <button class="btn-mini edit-cancel" type="button">Cancel</button>
        <button class="btn-mini edit-save" type="button">Save &amp; regenerate</button>
      </div>
    `;
    body.replaceWith(editor);
    const ta = editor.querySelector('.edit-textarea');
    ta.value = current;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    editor.querySelector('.edit-cancel').addEventListener('click', () => {
      // Restore the original body by re-rendering the whole session
      // (simplest reliable way; preserves tool cards and pins).
      renderSessionHistoryFresh();
    });
    editor.querySelector('.edit-save').addEventListener('click', async () => {
      const newText = ta.value;
      if (!newText.trim()) return;
      // Truncate everything from this message onward, then push the edited
      // message and run the chat loop afresh.
      session.history.splice(idx);
      session.history.push({ role: 'user', content: newText });
      await persistSession(session);
      renderSessionHistoryFresh();
      await runChatLoop(session);
    });
  }

  // Append a compact "tokens · $cost" chip under the last assistant message.
  function renderUsageChip(usage, costUsd) {
    if (!usage) return;
    const fmtN = window.KyotoModels?.formatN || ((n) => String(n));
    const fmtU = window.KyotoModels?.formatUsd || ((n) => `$${(n || 0).toFixed(4)}`);
    const lastMsg = els.chat.querySelector('.msg.assistant:last-of-type');
    if (!lastMsg) return;
    if (lastMsg.querySelector('.usage-chip')) return;
    const chip = document.createElement('div');
    chip.className = 'usage-chip';
    const parts = [
      `${fmtN(usage.prompt_tokens || 0)}↧`,
      `${fmtN(usage.completion_tokens || 0)}↥`
    ];
    if (costUsd != null) parts.push(fmtU(costUsd));
    chip.textContent = parts.join(' · ');
    chip.title = `Input ${usage.prompt_tokens || 0} · Output ${usage.completion_tokens || 0} · Total ${usage.total_tokens || 0}` + (costUsd != null ? ` · ${fmtU(costUsd)}` : '');
    lastMsg.appendChild(chip);
  }

  function addReasoningCard() {
    ensureEmptyHidden();
    const card = document.createElement('details');
    card.className = 'reasoning-card';
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="reasoning-name">💭 thinking</span><span class="reasoning-state">streaming…</span>';
    card.appendChild(summary);
    const body = document.createElement('pre');
    body.className = 'reasoning-body';
    card.appendChild(body);
    els.chat.appendChild(card);
    scrollToBottom();
    return { card, summary, body };
  }

  function addToolCallCard(name, argsPreview) {
    ensureEmptyHidden();
    const card = document.createElement('details');
    card.className = 'tool-card';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tool-name">⚙ ${esc(name)}</span><span class="tool-state running">running…</span>`;
    card.appendChild(summary);
    const inner = document.createElement('div');
    inner.className = 'tool-card-body';
    const argsBlock = document.createElement('pre');
    argsBlock.className = 'tool-args';
    argsBlock.textContent = argsPreview;
    inner.appendChild(label('args'));
    inner.appendChild(argsBlock);
    const resultBlock = document.createElement('pre');
    resultBlock.className = 'tool-result';
    resultBlock.textContent = '…';
    inner.appendChild(label('result'));
    inner.appendChild(resultBlock);
    card.appendChild(inner);
    els.chat.appendChild(card);
    scrollToBottom();
    return { card, summary, resultBlock };
  }
  function label(t) {
    const d = document.createElement('div');
    d.className = 'tool-label';
    d.textContent = t;
    return d;
  }

  // ── Provider UI ──────────────────────────────────────
  function reflectProvider(provider) {
    const cfg = getProviderConfig(provider) || { label: provider, placeholder: 'API key…', keysUrl: '' };
    els.keyLabel.textContent = `${cfg.label} API key`;
    els.apiKey.placeholder = cfg.placeholder;
    let hint = '';
    if (cfg.keysUrl) {
      try { hint = `Get a key at <a href="${cfg.keysUrl}" target="_blank" rel="noopener">${new URL(cfg.keysUrl).host}</a>.`; }
      catch { hint = `Get a key at <a href="${cfg.keysUrl}" target="_blank" rel="noopener">${cfg.keysUrl}</a>.`; }
    } else if (cfg.isCustom) {
      hint = `Custom OpenAI-compatible endpoint. Leave the key empty for local servers (Ollama, LM Studio) that don't require auth.`;
    }
    els.keyHint.innerHTML = hint;
  }
  function updateModelLine() {
    const provider = state.settings.provider;
    const model = state.settings.model;
    const cfg = getProviderConfig(provider) || { label: provider };
    if (!model) { els.modelLineText.textContent = cfg.label; return; }
    const short = model.includes('/') ? model.split('/').slice(1).join('/') : model;
    const info = window.KyotoModels?.get(provider, model);
    const fmt = window.KyotoModels?.formatN || ((n) => String(n));
    const caps = info ? ` · ${fmt(info.context)}↧/${fmt(info.output)}↥` : '';
    els.modelLineText.textContent = `${cfg.label} · ${short}${caps}`;
    els.modelLineText.title = info ? `Context ${info.context ?? '?'} · Max output ${info.output ?? '?'} · via ${info.source}` : '';
  }

  function updateMaxTokensHint() {
    if (!els.maxTokensHint) return;
    const provider = state.settings.provider;
    const model = state.settings.model;
    const info = model ? window.KyotoModels?.get(provider, model) : null;
    if (!info) return;
    const fmt = window.KyotoModels?.formatN || ((n) => String(n));
    const req = Number(els.maxTokens?.value) || state.settings.maxTokens;
    const effective = Math.min(req, info.output || req);
    els.maxTokensHint.innerHTML =
      `Selected model supports up to <strong>${fmt(info.output)}</strong> output tokens, context ${fmt(info.context)}. ` +
      `Your value will be clamped to <strong>${fmt(effective)}</strong> at request time. Source: ${info.source}.`;
  }

  function updateSessionsButton() {
    if (!els.sessionsBtn) return;
    const n = state.sessionsIndex.length;
    els.sessionsBtn.title = `Sessions (${n})${state.pinnedToSession ? ' · pinned' : ''}`;
  }

  // ── Models ───────────────────────────────────────────
  // "Shown provider" = whichever provider's models the user is
  // currently looking at in the SETTINGS DRAWER. That isn't always
  // state.settings.provider — when the user picks a different option
  // in the drawer's <select> without saving, the dropdown value
  // diverges. Use the dropdown's live value when available so a
  // pending fetch repaints the dropdown the user is actually staring
  // at.
  function isProviderShownInDrawer(provider) {
    if (els.provider && !els.drawer?.classList.contains('hidden')) {
      return els.provider.value === provider;
    }
    return state.settings.provider === provider;
  }

  async function fetchModels(provider, apiKey) {
    const cfg = getProviderConfig(provider);
    if (!cfg) {
      if (isProviderShownInDrawer(provider)) els.modelHint.textContent = `Unknown provider: ${provider}`;
      return;
    }
    // Custom providers may not need an API key (e.g. local Ollama).
    if (!apiKey && !cfg.isCustom) {
      if (isProviderShownInDrawer(provider)) {
        state.allModels = [];
        els.model.innerHTML = '';
        els.modelHint.textContent = 'Enter an API key to load models.';
      }
      return;
    }
    if (isProviderShownInDrawer(provider)) {
      els.modelHint.textContent = 'Loading models…';
    }
    const setModels = (list, statusText) => {
      // Always store into the cross-provider map (so the header picker
      // sees this provider's models even when another provider is the
      // current chat target). Only update the Settings drawer's
      // state.allModels and hint when it's the actively-shown provider.
      state.modelsByProvider.set(provider, list);
      if (isProviderShownInDrawer(provider)) {
        state.allModels = list;
        els.modelHint.textContent = statusText;
        renderModelOptions();
      }
      // Re-render the cross-provider header popover if it's open —
      // partial results appear as each provider finishes loading.
      if (els.modelPopover && !els.modelPopover.classList.contains('hidden')) {
        try { renderPopoverList(); } catch {}
      }
    };
    try {
      const res = await fetch(cfg.modelsUrl, { headers: cfg.headers(apiKey) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const parsed = cfg.parseModels(data).filter(m => m.id);
      if (!parsed.length && cfg.fallbackModels) {
        setModels(cfg.fallbackModels, `${cfg.fallbackModels.length} models (fallback list).`);
      } else {
        const sorted = parsed.sort((a, b) => a.id.localeCompare(b.id));
        setModels(sorted, `${sorted.length} models. Pick one and Save.`);
      }
    } catch (e) {
      if (cfg.fallbackModels) {
        setModels(cfg.fallbackModels, `${cfg.fallbackModels.length} models (fallback — /models endpoint unreachable: ${e.message}).`);
      } else {
        setModels([], `Failed: ${e.message}`);
        if (isProviderShownInDrawer(provider)) { state.allModels = []; els.model.innerHTML = ''; }
      }
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

  // ── Model header popover ─────────────────────────────
  async function toggleModelPopover() {
    if (!els.modelPopover.classList.contains('hidden')) { closeModelPopover(); return; }
    els.modelPopover.classList.remove('hidden');
    els.popoverSearch.value = '';
    // Render whatever we already have cached so the user sees something
    // immediately. The background refresh then re-renders when more
    // models arrive.
    renderPopoverList();
    if (els.popoverList.children.length === 0 || (els.popoverList.firstElementChild && els.popoverList.firstElementChild.classList.contains('popover-empty'))) {
      els.popoverList.innerHTML = '<p class="popover-empty">Loading models from configured providers…</p>';
    }
    try {
      await fetchAllProviderModels({ background: false });
    } catch {}
    renderPopoverList();
    setTimeout(() => els.popoverSearch.focus(), 0);
  }
  function closeModelPopover() { els.modelPopover.classList.add('hidden'); }

  // Collect every provider's models (built-in + custom) into a single
  // list with provider attached. Used by the header model picker so
  // the user can choose across all configured providers in one menu.
  function allConfiguredModels() {
    const out = [];
    for (const [provider, models] of state.modelsByProvider) {
      const cfg = getProviderConfig(provider);
      const label = cfg?.label || provider;
      for (const m of (models || [])) {
        out.push({ ...m, _provider: provider, _providerLabel: label });
      }
    }
    return out;
  }

  function renderPopoverList() {
    const all = allConfiguredModels();
    if (!all.length) {
      // Look at what providers are CONFIGURED (have keys / are custom)
      // so we can tell the user something useful: "we're still
      // loading X providers" vs. "you haven't added any keys".
      const keys = state.settings?.apiKeys || {};
      const configured = allProviderKeys().filter(p => {
        const cfg = getProviderConfig(p);
        return cfg?.isCustom || (keys[p] && keys[p].trim());
      });
      if (!configured.length) {
        els.popoverList.innerHTML = '<p class="popover-empty">No provider keys configured yet. Open Settings, paste a key for OpenRouter / DeepSeek / MiniMax (or add a custom provider) and save.</p>';
      } else {
        els.popoverList.innerHTML = `<p class="popover-empty">Loading models from ${configured.length} provider${configured.length === 1 ? '' : 's'}… If this stays empty, check the Settings drawer for fetch errors.</p>`;
      }
      return;
    }
    const q = els.popoverSearch.value.trim().toLowerCase();
    const filtered = q
      ? all.filter(m =>
          m.id.toLowerCase().includes(q)
          || m.name.toLowerCase().includes(q)
          || m._providerLabel.toLowerCase().includes(q))
      : all;
    if (!filtered.length) { els.popoverList.innerHTML = '<p class="popover-empty">No matches.</p>'; return; }
    // Group by provider so the menu reads "DeepSeek · MiniMax · OpenRouter".
    const groups = new Map();
    for (const m of filtered) {
      if (!groups.has(m._provider)) groups.set(m._provider, []);
      groups.get(m._provider).push(m);
    }
    const fmt = window.KyotoModels?.formatN || ((n) => String(n || '—'));
    const parts = [];
    [...groups.keys()].sort().forEach(provider => {
      const label = getProviderConfig(provider)?.label || provider;
      parts.push(`<div class="popover-group">${esc(label)}</div>`);
      for (const m of groups.get(provider)) {
        const active = (m._provider === state.settings.provider && m.id === state.settings.model) ? ' active' : '';
        const info = window.KyotoModels?.get(m._provider, m.id);
        const caps = info ? `<span class="popover-caps" title="ctx ${info.context ?? '?'} / out ${info.output ?? '?'} · ${info.source}">${fmt(info.context)} / ${fmt(info.output)}</span>` : '';
        parts.push(`<div class="popover-item${active}" data-model="${esc(m.id)}" data-provider="${esc(m._provider)}"><span class="popover-mname">${esc(m.name)}</span>${caps}<span class="check">✓</span></div>`);
      }
    });
    els.popoverList.innerHTML = parts.join('');
  }

  // Fetch every provider that has a key in apiKeys. Custom providers
  // without a key are skipped (only those that DO need one — Ollama
  // works keyless).
  async function fetchAllProviderModels({ background = true } = {}) {
    const keys = state.settings.apiKeys || {};
    const promises = [];
    for (const providerId of allProviderKeys()) {
      const cfg = getProviderConfig(providerId);
      const key = keys[providerId] || '';
      // Skip providers we have no way to call.
      if (!key && !cfg?.isCustom) continue;
      promises.push(fetchModels(providerId, key).catch(() => {}));
    }
    if (!background) await Promise.all(promises);
  }

  // ── Sessions popover ─────────────────────────────────
  function toggleSessionsPopover() {
    if (!els.sessionsPopover.classList.contains('hidden')) { closeSessionsPopover(); return; }
    els.sessionsPopover.classList.remove('hidden');
    els.sessionsSearch.value = '';
    renderSessionsList();
    setTimeout(() => els.sessionsSearch.focus(), 0);
  }
  function closeSessionsPopover() { els.sessionsPopover.classList.add('hidden'); }
  // In-memory cache for content search. Populated lazily.
  const sessionContentCache = new Map();
  let contentHits = new Set(); // session ids whose content matched the last deep search
  let lastSearchTerm = '';

  async function deepSearchSessions(q) {
    // Don't even try for very short queries — title/URL filter already covers them.
    contentHits = new Set();
    lastSearchTerm = q;
    if (!q || q.length < 3) return;
    const lq = q.toLowerCase();
    for (const meta of state.sessionsIndex) {
      // Skip ones whose title/URL already match — they'll show via the metadata filter.
      if ((meta.title || '').toLowerCase().includes(lq)) continue;
      if ((meta.url || '').toLowerCase().includes(lq)) continue;
      let full = sessionContentCache.get(meta.id);
      if (!full) {
        full = await loadFullSession(meta.id);
        sessionContentCache.set(meta.id, full);
      }
      if (full?.history?.some(m => contentText(m.content).toLowerCase().includes(lq))) {
        contentHits.add(meta.id);
      }
      // If the user has typed something newer in the meantime, abort.
      if (lastSearchTerm !== q) return;
    }
    // Re-render with the new hits if the query hasn't changed.
    if (lastSearchTerm === q) renderSessionsList();
  }

  function renderSessionsList() {
    const q = els.sessionsSearch.value.trim().toLowerCase();
    const items = state.sessionsIndex
      .filter(s => {
        if (!q) return true;
        if ((s.title || '').toLowerCase().includes(q)) return true;
        if ((s.url || '').toLowerCase().includes(q)) return true;
        return contentHits.has(s.id);
      })
      .slice(0, 200);
    if (!items.length) {
      const hint = q.length >= 3 ? 'No sessions match (searched titles, URLs, and history content).' : 'No sessions yet. Start a chat in any tab.';
      els.sessionsList.innerHTML = `<p class="popover-empty">${esc(hint)}</p>`;
      return;
    }
    const html = items.map(s => {
      const isCurrent = state.activeSession?.id === s.id;
      const busy = !!state.runtimes[s.id]?.busy;
      const dot = busy ? '<span class="sess-dot busy" title="Streaming"></span>' : (s.tabId != null ? '<span class="sess-dot bound" title="Bound to tab"></span>' : '<span class="sess-dot" title="Unbound"></span>');
      const url = s.url ? (() => { try { return new URL(s.url).host; } catch { return s.url; } })() : '—';
      const hitTag = q && contentHits.has(s.id) && !(s.title || '').toLowerCase().includes(q) && !(s.url || '').toLowerCase().includes(q)
        ? ' <span class="hit-tag">content match</span>' : '';
      return `
        <div class="sess-item${isCurrent ? ' active' : ''}" data-id="${esc(s.id)}">
          <div class="sess-row">
            ${dot}
            <span class="sess-title">${esc(s.title || 'Untitled')}${hitTag}</span>
            <span class="sess-time">${esc(fmtTime(s.lastActive))}</span>
          </div>
          <div class="sess-row sub">
            <span class="sess-url">${esc(url)}</span>
            <span class="sess-actions">
              <button class="sess-act" data-act="fork" title="Fork (duplicate as new)">⎘</button>
              <button class="sess-act" data-act="export" title="Export as Markdown">⇣</button>
              <button class="sess-act" data-act="rename" title="Rename">✎</button>
              <button class="sess-act" data-act="bind" title="${s.tabId != null ? 'Unbind from tab' : 'Bind to current tab'}">${s.tabId != null ? '⌧' : '⌘'}</button>
              <button class="sess-act" data-act="delete" title="Delete">×</button>
            </span>
          </div>
        </div>`;
    }).join('');
    els.sessionsList.innerHTML = html;
  }

  // ── Page context ─────────────────────────────────────
  // Per-domain skill cache for system-prompt enrichment. We re-fetch on
  // page change but skip if we already loaded this domain in the last
  // 5 min — keeps the hub call rate low and is fine: skills don't churn.
  const _skillsDomainCache = new Map(); // domain -> { at: ms, items: [...] }
  async function refreshSkillsForDomain(domain) {
    if (!domain) return;
    if (!window.KyotoSkillHub) return;
    const cfg = await window.KyotoSkillHub.config();
    if (!cfg.url || !cfg.key) return;
    const cached = _skillsDomainCache.get(domain);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      state.skillsForCurrentDomain = cached.items;
      state.skillsForCurrentDomainKey = domain;
      return;
    }
    try {
      const r = await window.KyotoSkillHub.search(domain, '', 8, true);
      if (r?.error) return;
      const items = (r.items || []).map(s => ({
        skill_id: s.skill_id, domain: s.domain, name: s.name, description: s.description,
      }));
      _skillsDomainCache.set(domain, { at: Date.now(), items });
      state.skillsForCurrentDomain = items;
      state.skillsForCurrentDomainKey = domain;
    } catch {}
  }

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
      // Update session.url whenever we can
      if (state.activeSession) {
        state.activeSession.url = state.page.url;
        await persistSession(state.activeSession);
      }
      // Refresh the per-domain skill list so the system prompt can surface
      // them. Best-effort, cached for ~5 min to avoid spamming the hub.
      refreshSkillsForDomain(urlDomain(state.page.url || '')).catch(() => {});
    } catch {
      state.page = null;
      els.ctxDot.className = 'dot err';
      els.ctxTxt.textContent = 'Cannot read this page';
    }
  }

  // ── Submit / slash command pre-processor ─────────────
  async function submitInput(raw) {
    if (!raw || !raw.trim()) return;
    const { kind, text, action, args } = expandSlash(raw);
    if (kind === 'inline') { await handleInlineSlash(action, args); return; }
    // Honour the one-shot vision toggle.
    if (state.visionPending) {
      // Always disarm the toggle FIRST so a failed capture doesn't
      // strand the user in a loop where every send retries the same
      // failing screenshot and silently replaces their text.
      state.visionPending = false;
      updateVisionUI();
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
        return sendMessage([
          { type: 'text', text },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]);
      } catch (e) {
        // Capture commonly fails on chrome:// / chrome-extension:// /
        // the Web Store. Restore the user's typed text + show a clear
        // explanation. Toggle is already off so they can just retry.
        if (els.input) { els.input.value = text; els.input.dispatchEvent(new Event('input')); }
        const hint = /Cannot access/i.test(e.message)
          ? 'Chrome blocks screenshots of this page (it\'s a chrome:// / chrome-extension:// / Web Store URL). Open a normal http(s) tab first.'
          : `Screenshot failed: ${e.message}`;
        addMessage('assistant', `${hint} The 📸 toggle has been turned off; your message is back in the composer.`, { error: true });
        return;
      }
    }
    return sendMessage(text);
  }

  // Extract plain text from either a string or an OpenAI-style
  // multi-modal content array.
  function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
    return '';
  }

  // ── Chat loop ────────────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim()) return;
    if (!state.activeSession) return;

    const session = state.activeSession;
    // Provider and model are global (state.settings) — sessions only own
    // their conversation history. Snapshot them onto the session for
    // historical record-keeping, but don't let stale values block a send.
    session.provider = state.settings.provider;
    session.model = state.settings.model;

    const sessCfg = getProviderConfig(session.provider);
    const needsKey = !sessCfg?.isCustom; // custom providers can be keyless (Ollama, LM Studio)
    if (needsKey && !keyFor(session.provider)) {
      addMessage(
        'assistant',
        `No API key for **${sessCfg?.label || session.provider}**. Open Settings, choose that provider, and add a key.`,
        { error: true }
      );
      openDrawer();
      return;
    }
    if (!session.model) {
      addMessage('assistant', 'No model selected. Pick one from the header (or Settings).', { error: true });
      openDrawer(); return;
    }
    // Bind to current tab if floating. If another session was previously
    // bound to this tab (e.g. user forked then started typing on the fork),
    // clean its tabId so we don't leave a stale reference.
    if (session.tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const prevId = state.tabToSession[tab.id];
        if (prevId && prevId !== session.id) {
          loadFullSession(prevId).then(prev => {
            if (prev) { prev.tabId = null; persistSession(prev); }
          });
        }
        session.tabId = tab.id;
        session.url = tab.url;
        state.tabToSession[tab.id] = session.id;
      }
    }
    // First user message → derive title
    if (!session.history.length) {
      const textForTitle = contentText(text);
      session.title = (textForTitle.split('\n')[0] || 'New chat').slice(0, 60);
    }

    session.history.push({ role: 'user', content: text });
    const userIdx = session.history.length - 1;
    if (isActive(session.id)) {
      const { wrap } = addMessage('user', text);
      decoratePinButton(wrap, userIdx, false);
      decorateEditButton(wrap, userIdx);
    }
    await persistSession(session);
    await runChatLoop(session);
  }

  // Re-runs the streaming + tool loop on a session whose history already
  // ends with the user message we want a response to. Used by both
  // sendMessage (after pushing) and the replay/edit path.
  async function runChatLoop(session) {
    const runtime = (state.runtimes[session.id] ??= {});
    runtime.busy = true;
    runtime.abort = new AbortController();
    if (isActive(session.id)) {
      els.sendBtn.disabled = true;
      els.stopBtn.classList.remove('hidden');
    }
    try {
      const maxSteps = Math.max(1, Math.min(200, Number(state.settings.maxAgentSteps) || 50));
      const maxAutoContinues = Math.max(0, Math.min(10, Number(state.settings.maxAutoContinues) || 2));
      let autoContinues = 0;
      let goalContinues = 0;
      let stoppedReason = 'maxSteps'; // overwritten if we break naturally

      stepLoop:
      for (let step = 0; step < maxSteps; step++) {
        const { text: at, toolCalls, reasoning, reasoningField, usage, finishReason } = await streamOnce(session, runtime.abort.signal);

        const msg = { role: 'assistant', content: at || '' };
        if (reasoning && reasoningField) msg[reasoningField] = reasoning;
        if (toolCalls.length) {
          msg.tool_calls = toolCalls.map(tc => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments || '{}' }
          }));
        }
        if (usage) {
          msg._usage = usage;
          const cost = window.KyotoModels?.costFor(state.settings.provider, state.settings.model, usage);
          if (cost != null) msg._cost = cost;
          if (isActive(session.id)) renderUsageChip(usage, msg._cost);
        }
        if (finishReason) msg._finishReason = finishReason;
        session.history.push(msg);
        const asstIdx = session.history.length - 1;
        // Decorate the live-streamed assistant message with a pin button.
        if (isActive(session.id) && msg.content) {
          const lastAsst = els.chat.querySelector('.msg.assistant:last-of-type');
          decoratePinButton(lastAsst, asstIdx, false);
        }
        await persistSession(session);

        // Branch on finish_reason + tool_calls:
        //   tool_calls (or non-empty toolCalls list) -> run tools, loop again
        //   length + no tools -> auto-continue (capped)
        //   stop / content_filter / other -> done
        if (!toolCalls.length) {
          // Goal mode: if the active session has a goal and the model
          // didn't emit a "done" marker, push a continue prompt and
          // keep looping. Capped at goalContinues to prevent runaway.
          const goal = session.goal;
          const lastText = msg.content || '';
          if (goal) {
            if (isGoalDoneText(lastText)) {
              session.goal = null;
              await persistSession(session);
              if (isActive(session.id)) {
                addMessage('assistant', '_Goal complete — agent reported [GOAL_DONE]. Goal cleared._');
                updateGoalUI();
              }
              stoppedReason = 'goal_done';
              break stepLoop;
            }
            const maxGoalContinues = 30;
            goalContinues = (goalContinues || 0) + 1;
            if (goalContinues > maxGoalContinues) {
              stoppedReason = 'goal_cap';
              if (isActive(session.id)) {
                addMessage('assistant', `_Goal cap (${maxGoalContinues}) reached. Continuing requires user input — clear the goal with \`/goal clear\` or run \`/goal status\`._`, { error: true });
              }
              break stepLoop;
            }
            session.history.push({
              role: 'user',
              content:
                `Goal: ${goal}\n\n` +
                `Keep working toward the goal. If the goal is fully complete, reply with the literal token [GOAL_DONE] (and only that line — no further actions). Otherwise, take the next concrete step.`
            });
            if (isActive(session.id)) addMessage('assistant', `_[goal continue ${goalContinues}/${maxGoalContinues}]_`);
            await persistSession(session);
            continue stepLoop;
          }

          if (finishReason === 'length' && autoContinues < maxAutoContinues) {
            autoContinues++;
            const note = `_[auto-continue ${autoContinues}/${maxAutoContinues} — model output was cut off by max_tokens]_`;
            session.history.push({ role: 'user', content: 'Continue from where you left off. Do not repeat content already shown.' });
            if (isActive(session.id)) addMessage('assistant', note);
            await persistSession(session);
            continue stepLoop;
          }
          stoppedReason = finishReason || 'done';
          break stepLoop;
        }

        for (const tc of msg.tool_calls) {
          let args; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
          let card = null;
          if (isActive(session.id)) {
            card = addToolCallCard(tc.function.name, jsonString(args).slice(0, 2000));
            card.card.dataset.toolCallId = tc.id;
          }

          let result;
          const tStart = Date.now();
          try { result = await callToolOrMCP(tc.function.name, args); }
          catch (e) { result = { error: e?.message || String(e) }; }
          const tElapsed = Date.now() - tStart;
          const resultStr = jsonString(result);
          if (card) {
            const masked = maskSensitive(resultStr);
            card.resultBlock.textContent = masked.length > 8000 ? masked.slice(0, 8000) + '\n…' : masked;
            const stateEl = card.summary.querySelector('.tool-state');
            stateEl.textContent = result?.error ? 'error' : 'done';
            stateEl.className = `tool-state ${result?.error ? 'err' : 'ok'}`;
          }

          auditAppend({
            sessionId: session.id,
            tool: tc.function.name,
            args,
            elapsedMs: tElapsed,
            isError: !!result?.error,
            resultPreview: resultStr.slice(0, 500)
          });

          session.history.push({
            role: 'tool', tool_call_id: tc.id, name: tc.function.name,
            content: resultStr.length > 60000 ? resultStr.slice(0, 60000) + '\n…[truncated]' : resultStr
          });
          await persistSession(session);
        }
      }

      // Auto-extract a skill when a /goal completes successfully. We
      // gate on goal_done (not 'done') because user-set goals are an
      // explicit "this is a task, not idle chitchat" signal. Fire-and-
      // forget so the UI isn't blocked.
      if (stoppedReason === 'goal_done' && state.settings.skillsAutoSave !== false) {
        extractAndSaveSkill(session, { trigger: 'goal_done' })
          .catch((e) => console.warn('skill auto-extract failed:', e?.message || e));
      }

      // If we exited via the for-loop condition (not via break), we ran
      // out of steps with the agent still wanting to act. Make that
      // visible so the user doesn't think the agent "just stopped".
      if (stoppedReason === 'maxSteps') {
        // If we hit maxSteps while a goal was active, surface that the
        // user must either /goal clear OR up the cap — otherwise the
        // next message will silently auto-continue the goal again.
        const goalSuffix = session.goal
          ? ` A goal is still active (\`${session.goal}\`) — type \`/goal clear\` if you want to stop chasing it.`
          : '';
        const note = `_Reached the max agent-steps cap (${maxSteps}). The agent still wanted to continue. Raise the limit in **Settings → Max agent steps per turn**, or just say "continue" to keep going.${goalSuffix}_`;
        session.history.push({ role: 'assistant', content: note, _capHit: true });
        if (isActive(session.id)) addMessage('assistant', note, { error: true });
        await persistSession(session);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        session.history.push({ role: 'assistant', content: '_[stopped]_', _error: true });
      } else {
        if (isActive(session.id)) addMessage('assistant', `**Error:** ${e.message}`, { error: true });
        session.history.push({ role: 'assistant', content: `Error: ${e.message}`, _error: true });
      }
      await persistSession(session);
    } finally {
      runtime.busy = false;
      runtime.abort = null;
      if (isActive(session.id)) {
        els.sendBtn.disabled = false;
        els.stopBtn.classList.add('hidden');
        const banner = document.getElementById('streaming-banner');
        if (banner) banner.remove();
        els.input.focus();
      }
    }
  }

  async function callToolOrMCP(name, args) {
    if (state.mcpTools.find(t => t.function.name === name)) {
      return window.KyotoMCP.call(name, args);
    }
    if (state.customToolHandlers?.has(name)) {
      try {
        const out = await state.customToolHandlers.get(name)(args || {});
        return out === undefined ? { ok: true } : out;
      } catch (e) {
        return { error: e?.message || String(e), stack: e?.stack };
      }
    }
    return window.KyotoTools.call(name, args);
  }

  // Compile user-defined tools into callable handlers + schemas.
  function compileCustomTools() {
    state.customToolHandlers = new Map();
    state.customToolSchemas = [];
    for (const t of (state.settings?.customTools || [])) {
      if (!t.name || !t.code) continue;
      let params;
      try { params = t.parameters ? JSON.parse(t.parameters) : { type: 'object', properties: {}, additionalProperties: false }; }
      catch { params = { type: 'object', properties: {}, additionalProperties: false }; }
      let fn;
      try {
        // The function body runs in the side-panel context with full chrome.*
        // and fetch access. The user wrote it; the user trusts it.
        fn = new Function('args', `return (async () => { ${t.code} })();`);
      } catch (e) {
        console.warn('[Kyoto] custom tool compile failed:', t.name, e.message);
        continue;
      }
      const name = t.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
      state.customToolHandlers.set(name, fn);
      state.customToolSchemas.push({
        type: 'function',
        function: {
          name,
          description: `[user] ${t.description || ''}`.trim(),
          parameters: params
        }
      });
    }
  }

  // One streamed model call. Returns accumulated text + tool calls + reasoning.
  async function streamOnce(session, signal) {
    const { provider, model, temperature, maxTokens, toolsEnabled, enabledGroups } = state.settings;
    const cfg = getProviderConfig(provider);
    if (!cfg) throw new Error(`Unknown provider: ${provider}`);
    const apiKey = keyFor(provider);
    if (!apiKey && !cfg.isCustom) {
      throw new Error(
        `No API key configured for ${cfg.label}. ` +
        `Open Settings, select "${cfg.label}" as the Provider, and enter your key.`
      );
    }

    const messages = buildMessages(session);
    const baseTools = toolsEnabled ? window.KyotoTools.schemas(new Set(enabledGroups)) : [];
    const tools = [...baseTools, ...state.mcpTools, ...(state.customToolSchemas || [])];

    // Clamp max_tokens to whatever models.dev (or our fallback table)
    // says this model actually supports, so we don't ask for 32K from a
    // model that maxes at 8K and get a 400.
    const modelMax = window.KyotoModels?.maxOutput(provider, model, 8192) ?? 8192;
    const requestedMax = Number(maxTokens) || 8192;
    const effectiveMax = Math.max(64, Math.min(requestedMax, modelMax));

    const body = {
      model,
      messages,
      temperature: Number(temperature),
      max_tokens: effectiveMax,
      stream: true,
      // Ask OpenAI-compat providers to include a final usage chunk so we
      // can show token counts and cost.
      stream_options: { include_usage: true }
    };
    if (tools.length) {
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
    let reasoningAcc = '';
    let reasoningField = null;
    let usage = null;
    let finishReason = null;
    const toolBuf = [];
    let textTarget = null;
    let reasoningTarget = null;

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
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.usage) usage = parsed.usage; // usage chunk (terminal in OAI-compat streams)
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason; // stop | length | tool_calls | content_filter
        const delta = choice.delta || {};

        const rChunk = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof rChunk === 'string' && rChunk.length) {
          if (!reasoningField) {
            if (delta.reasoning_content !== undefined) reasoningField = 'reasoning_content';
            else if (delta.reasoning !== undefined) reasoningField = 'reasoning';
            else reasoningField = 'thinking';
          }
          reasoningAcc += rChunk;
          if (isActive(session.id) && !state.settings?.hideReasoning) {
            if (!reasoningTarget) reasoningTarget = addReasoningCard();
            reasoningTarget.body.textContent = reasoningAcc;
            scrollToBottom();
          }
        }

        if (delta.content) {
          textAcc += delta.content;
          if (isActive(session.id)) {
            if (!textTarget) {
              const m = addMessage('assistant', '');
              textTarget = m.body;
              textTarget.classList.add('cursor');
            }
            textTarget.innerHTML = renderMarkdown(textAcc);
            scrollToBottom();
          }
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
    if (reasoningTarget) {
      const stateEl = reasoningTarget.summary.querySelector('.reasoning-state');
      if (stateEl) stateEl.textContent = `${reasoningAcc.length} chars`;
    }
    // If the user switched away mid-stream and came back, the live DOM
    // targets were wiped. Render the accumulated text/reasoning once on
    // completion so they don't end up only in history.
    if (isActive(session.id)) {
      if (reasoningAcc && !state.settings?.hideReasoning && (!reasoningTarget || !reasoningTarget.body.isConnected)) {
        const card = addReasoningCard();
        card.body.textContent = reasoningAcc;
        const stateEl = card.summary.querySelector('.reasoning-state');
        if (stateEl) stateEl.textContent = `${reasoningAcc.length} chars`;
      }
      if (textAcc && (!textTarget || !textTarget.isConnected)) {
        addMessage('assistant', textAcc);
      }
    }
    return {
      text: textAcc,
      toolCalls: toolBuf.filter(Boolean),
      reasoning: reasoningAcc,
      reasoningField,
      usage,
      finishReason
    };
  }

  function buildMessages(session) {
    const systemParts = [];
    systemParts.push(
      'You are Kyoto, an AI browser agent embedded in a Chrome side panel. ' +
      'You have tool access to: open/navigate tabs, run JS in pages, read DOM, inspect & modify cookies (including export for session cloning), ' +
      'observe network requests, intercept fetch/XHR bodies, attach the Chrome DevTools Protocol (after the user grants the optional `debugger` permission), ' +
      'search history/bookmarks/downloads, and call out to any configured MCP servers. ' +
      'Each session is bound to a tab; tab switches by the user do not interrupt your work in this session. ' +
      'Prefer reading before writing. When the user asks for "session cloning" or "auth cookies", use `cookies_analyze` + `cookies_export`. ' +
      'When inspecting an API, use `network_capture_start`, perform the action, then `network_capture_list`/`network_capture_detail`. ' +
      'Render responses in Markdown.'
    );
    if (state.settings.systemPrompt) systemParts.push(state.settings.systemPrompt);

    // Pinned-message awareness — purely advisory; pinned messages are
    // already present in history, but flagging them helps the model
    // weigh them appropriately.
    const pinnedTexts = session.history
      .filter(m => m._pinned && m.content)
      .map((m, i) => `[pinned ${i + 1}, role=${m.role}] ${contentText(m.content).slice(0, 800)}`);
    if (pinnedTexts.length) {
      systemParts.push(
        `The user has pinned the following messages — treat them as elevated context:\n\n${pinnedTexts.join('\n\n')}`
      );
    }

    // Cross-session memories — surface titles so the model knows what
    // memory_get / memory_search can return.
    if (state.memoryIndex?.length) {
      systemParts.push(
        `You have ${state.memoryIndex.length} saved memories available. Titles: ${state.memoryIndex.slice(0, 30).map(m => `"${m.title}"`).join(', ')}. Call \`memory_search\` or \`memory_get\` (with the id from \`memory_list\`) to read full content. Save new long-lived info with \`memory_add\`.`
      );
    }

    // Skills hub — surface skills already saved for this domain so the
    // model knows to call skill_get instead of rediscovering the workflow.
    // skillsForCurrentDomain is refreshed by refreshPageContext().
    if (state.skillsForCurrentDomain?.length) {
      const lines = state.skillsForCurrentDomain.slice(0, 8).map(s =>
        `- ${s.name} (id: ${s.skill_id}, domain: ${s.domain}) — ${s.description || '(no description)'}`
      );
      systemParts.push(
        `🪄 Skills already saved for this domain (\`${state.skillsForCurrentDomainKey || 'global'}\`). ` +
        `BEFORE you start exploring, call \`skill_get\` on any skill whose description matches the user\'s task — a 30s read can save 5-10 iterations. ` +
        `If your task isn\'t covered here, also try \`skill_search\` with a more specific query.\n` +
        lines.join('\n')
      );
    }

    if (els.useContext.checked && state.page?.content && isActive(session.id)) {
      systemParts.push(
        `Current page context:\nTitle: ${state.page.title}\nURL: ${state.page.url}\n\n--- PAGE CONTENT ---\n${state.page.content}\n--- END PAGE CONTENT ---`
      );
    }

    // Strip our UI-only fields from history copy. Kept fields: role,
    // content, tool_calls, tool_call_id, name, plus the reasoning field
    // we echo back (reasoning_content / reasoning / thinking).
    const cleaned = session.history.map(m => {
      const out = {};
      for (const k of Object.keys(m)) {
        if (k.startsWith('_')) continue;
        out[k] = m[k];
      }
      return out;
    });
    return [{ role: 'system', content: systemParts.join('\n\n') }, ...cleaned];
  }

  // ── Drawer / settings ────────────────────────────────
  function openDrawer() {
    els.drawer.classList.remove('hidden');
    els.overlay.classList.remove('hidden');
    els.provider.value = state.settings.provider;
    els.apiKey.value = currentApiKey();
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.maxTokens.value = state.settings.maxTokens;
    els.toolsEnabled.checked = !!state.settings.toolsEnabled;
    if (els.maxAgentSteps) els.maxAgentSteps.value = state.settings.maxAgentSteps ?? 50;
    if (els.maxAutoContinues) els.maxAutoContinues.value = state.settings.maxAutoContinues ?? 2;
    els.redactSensitive.checked = state.settings.redactSensitive !== false;
    els.auditEnabled.checked = state.settings.auditEnabled !== false;
    if (els.auditStatus) els.auditStatus.textContent = `${(state.auditLog || []).length} entries`;
    if (els.themeSelect) els.themeSelect.value = state.settings.theme || 'system';
    if (els.densitySelect) els.densitySelect.value = state.settings.density || 'comfortable';
    if (els.hideReasoning) els.hideReasoning.checked = !!state.settings.hideReasoning;
    if (els.testConnStatus) els.testConnStatus.textContent = '';
    if (els.backupStatus) els.backupStatus.textContent = '';
    if (els.s3AccessKeyId) els.s3AccessKeyId.value = state.settings.s3AccessKeyId || '';
    if (els.s3SecretAccessKey) els.s3SecretAccessKey.value = state.settings.s3SecretAccessKey || '';
    if (els.s3Region) els.s3Region.value = state.settings.s3Region || 'us-east-1';
    if (els.s3Bucket) els.s3Bucket.value = state.settings.s3Bucket || '';
    if (els.s3KeyPrefix) els.s3KeyPrefix.value = state.settings.s3KeyPrefix || '';
    if (els.s3Endpoint) els.s3Endpoint.value = state.settings.s3Endpoint || '';
    if (els.s3Status) els.s3Status.textContent = '';
    if (els.skillsHubUrl) els.skillsHubUrl.value = state.settings.skillsHubUrl || '';
    if (els.skillsHubKey) els.skillsHubKey.value = state.settings.skillsHubKey || '';
    if (els.skillsAutoSave) els.skillsAutoSave.checked = state.settings.skillsAutoSave !== false;
    if (els.skillsHubStatus) els.skillsHubStatus.textContent = '';
    const extId = chrome.runtime.id;
    if (els.shellExtId) els.shellExtId.value = extId;

    // OS-detect so we only show the relevant install command up front.
    // userAgentData is the modern API; fall back to UA string parsing.
    const os = (() => {
      const data = navigator.userAgentData;
      if (data?.platform) {
        const p = data.platform.toLowerCase();
        if (p.includes('mac')) return 'macos';
        if (p.includes('win')) return 'windows';
        if (p.includes('linux') || p.includes('chrome os')) return 'linux';
      }
      const ua = (navigator.userAgent || '').toLowerCase();
      if (/mac|iphone|ipad|ipod/.test(ua)) return 'macos';
      if (/win/.test(ua)) return 'windows';
      if (/linux|cros|x11/.test(ua)) return 'linux';
      return 'unknown';
    })();
    const unixCmd = `curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh | bash -s -- ${extId}`;
    const winCmd  = `$env:KYOTO_EXT_ID="${extId}"; irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex`;
    const isWin = os === 'windows';
    if (els.shellInstallLabel) els.shellInstallLabel.textContent = isWin
      ? 'One-line install (Windows · PowerShell)'
      : os === 'macos' ? 'One-line install (macOS · bash)'
      : os === 'linux' ? 'One-line install (Linux · bash)'
      : 'One-line install (Linux / macOS · bash)';
    if (els.shellInstallCmd) els.shellInstallCmd.value = isWin ? winCmd : unixCmd;
    if (els.shellInstallCmdAlt) els.shellInstallCmdAlt.value = isWin ? unixCmd : winCmd;
    if (els.shellInstallAltLabel) els.shellInstallAltLabel.textContent = isWin
      ? 'Linux / macOS · bash'
      : 'Windows · PowerShell';
    // Always start collapsed; user clicks "Show command for a different OS" to expand.
    if (els.shellInstallAltWrap) els.shellInstallAltWrap.classList.add('hidden');
    if (els.shellInstallToggleAltBtn) els.shellInstallToggleAltBtn.textContent = 'Show command for a different OS';

    if (els.shellStatus) els.shellStatus.textContent = '';
    updateWorkspaceUI();
    renderToolGroupCheckboxes();
    renderProviderDropdown();
    renderCustomProvidersList();
    renderCustomSlashList();
    renderCustomToolsList();
    renderMcpList();
    refreshDebuggerStatus();
    reflectProvider(state.settings.provider);
    updateMaxTokensHint();
    if (currentApiKey() || getProviderConfig(state.settings.provider)?.isCustom) {
      fetchModels(state.settings.provider, currentApiKey());
    }
  }
  function closeDrawer() {
    els.drawer.classList.add('hidden');
    els.overlay.classList.add('hidden');
  }

  function renderToolGroupCheckboxes() {
    const groups = window.KyotoTools.groups();
    els.toolGroups.innerHTML = '';
    for (const g of groups) {
      const wrap = document.createElement('label');
      wrap.className = 'grp';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
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
      const has = await chrome.permissions.contains({ permissions: ['debugger'] });
      els.debuggerStatus.textContent = has ? 'Granted ✓' : 'Not granted — reload via ⤴';
      els.debuggerStatus.className = `permstatus ${has ? 'ok' : 'err'}`;
    } catch (e) {
      els.debuggerStatus.textContent = `Error: ${e.message}`;
      els.debuggerStatus.className = 'permstatus err';
    }
  }

  function renderProviderDropdown() {
    if (!els.provider) return;
    const prev = els.provider.value;
    const opts = [];
    for (const key of Object.keys(PROVIDERS)) {
      opts.push(`<option value="${esc(key)}">${esc(PROVIDERS[key].label)}</option>`);
    }
    for (const cp of (state.settings.customProviders || [])) {
      opts.push(`<option value="${esc(cp.id)}">${esc(cp.label || cp.id)} (custom)</option>`);
    }
    els.provider.innerHTML = opts.join('');
    if (allProviderKeys().includes(prev)) els.provider.value = prev;
    else if (allProviderKeys().includes(state.settings.provider)) els.provider.value = state.settings.provider;
  }

  function renderCustomProvidersList() {
    const list = state.settings.customProviders || [];
    if (!list.length) {
      els.customProvidersList.innerHTML = '<p class="hint">No custom providers yet. Click + to add one.</p>';
      return;
    }
    els.customProvidersList.innerHTML = list.map((cp, i) => `
      <div class="mcp-row" data-idx="${i}">
        <div class="mcp-row-l">
          <input type="text" class="cp-label" placeholder="display name (e.g. Ollama)" value="${esc(cp.label || '')}" />
          <input type="text" class="cp-base" placeholder="base URL (e.g. http://localhost:11434/v1)" value="${esc(cp.baseUrl || '')}" />
          <input type="password" class="cp-key" placeholder="API key (optional for local servers)" value="${esc(state.settings.apiKeys?.[cp.id] || '')}" />
        </div>
        <div class="mcp-row-r">
          <button class="btn-mini cp-del" type="button">×</button>
        </div>
      </div>
    `).join('');
  }

  function renderCustomSlashList() {
    const list = state.settings.customSlashCommands || [];
    if (!list.length) {
      els.customSlashList.innerHTML = '<p class="hint">No custom commands yet. Click + to add one.</p>';
      return;
    }
    els.customSlashList.innerHTML = list.map((c, i) => `
      <div class="mcp-row" data-idx="${i}">
        <div class="mcp-row-l">
          <input type="text" class="cs-name" placeholder="name (without /)" value="${esc(c.name || '')}" />
          <input type="text" class="cs-prompt" placeholder="template — use {{args}} for arguments" value="${esc(c.prompt || '')}" />
        </div>
        <div class="mcp-row-r">
          <button class="btn-mini cs-del" type="button">×</button>
        </div>
      </div>
    `).join('');
  }

  function renderCustomToolsList() {
    const list = state.settings.customTools || [];
    if (!list.length) {
      els.customToolsList.innerHTML = '<p class="hint">No custom tools yet. Click + to define one. Example body: <code>return { ok: true, ts: Date.now() };</code></p>';
      return;
    }
    els.customToolsList.innerHTML = list.map((t, i) => `
      <div class="ct-row" data-idx="${i}">
        <div class="ct-head">
          <input type="text" class="ct-name" placeholder="tool_name (snake_case)" value="${esc(t.name || '')}" />
          <button class="btn-mini ct-del" type="button">×</button>
        </div>
        <input type="text" class="ct-desc" placeholder="What does this tool do? (model sees this)" value="${esc(t.description || '')}" />
        <textarea class="ct-params" rows="2" placeholder='JSON schema for args, e.g. { "type":"object", "properties":{ "q":{"type":"string"} }, "required":["q"] }'>${esc(t.parameters || '')}</textarea>
        <textarea class="ct-code" rows="5" placeholder="// Body of an async function. Receives args. Return a JSON-serialisable value.">${esc(t.code || '')}</textarea>
      </div>
    `).join('');
  }

  function renderMcpList() {
    const servers = state.settings.mcpServers || [];
    if (!servers.length) {
      els.mcpServersList.innerHTML = '<p class="hint">No MCP servers configured yet.</p>';
      return;
    }
    els.mcpServersList.innerHTML = servers.map((s, i) => `
      <div class="mcp-row" data-idx="${i}">
        <div class="mcp-row-l">
          <input type="text" class="mcp-name" placeholder="name" value="${esc(s.name || '')}" />
          <input type="text" class="mcp-url" placeholder="https://server/mcp" value="${esc(s.url || '')}" />
          <input type="text" class="mcp-auth" placeholder="Authorization header (optional)" value="${esc(s.auth || '')}" />
        </div>
        <div class="mcp-row-r">
          <label class="grp"><input type="checkbox" class="mcp-enabled" ${s.enabled ? 'checked' : ''}/><span>on</span></label>
          <button class="btn-mini mcp-test" type="button">Test</button>
          <button class="btn-mini mcp-del" type="button">×</button>
        </div>
      </div>
    `).join('');
  }

  // ── Event wiring ─────────────────────────────────────
  function wireEvents() {
    els.input.addEventListener('input', () => {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
      refreshSlashPalette();
    });
    els.input.addEventListener('keydown', (e) => {
      // Slash palette gets first pick at the keys
      if (slashPaletteVisible()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashSelection(-1); return; }
        if (e.key === 'Escape')    { e.preventDefault(); els.slashPalette.classList.add('hidden'); return; }
        if (e.key === 'Tab')       { e.preventDefault(); fillFromSlashPalette(); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (fillFromSlashPalette()) return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = els.input.value; els.input.value = ''; els.input.style.height = 'auto';
        els.slashPalette?.classList.add('hidden');
        submitInput(v);
      }
    });
    // Click to fill from palette
    if (els.slashPalette) {
      els.slashPalette.addEventListener('mousedown', (e) => {
        // mousedown so the input doesn't lose focus first
        const item = e.target.closest('.slash-item');
        if (!item) return;
        e.preventDefault();
        // Mark clicked item as active so fillFromSlashPalette picks it
        els.slashPalette.querySelectorAll('.slash-item').forEach(el => el.classList.toggle('active', el === item));
        fillFromSlashPalette();
        els.input.focus();
      });
    }
    // Dismiss palette on click outside
    document.addEventListener('mousedown', (e) => {
      if (!slashPaletteVisible()) return;
      if (els.slashPalette.contains(e.target) || els.input?.contains(e.target)) return;
      els.slashPalette.classList.add('hidden');
    });
    els.sendBtn.addEventListener('click', () => {
      const v = els.input.value; els.input.value = ''; els.input.style.height = 'auto';
      submitInput(v);
    });
    els.stopBtn.addEventListener('click', () => {
      const sid = state.activeSession?.id;
      if (sid && state.runtimes[sid]?.abort) state.runtimes[sid].abort.abort();
    });
    if (els.visionBtn) els.visionBtn.addEventListener('click', toggleVisionPending);

    if (els.goalBar) els.goalBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.goal-x');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'clear-goal' && state.activeSession?.goal) {
        state.activeSession.goal = null;
        await persistSession(state.activeSession);
        addMessage('assistant', '_Goal cleared._');
        updateGoalUI();
      } else if (act === 'stop-loop') {
        if (stopLoop(btn.dataset.id)) {
          addMessage('assistant', '_Loop stopped._');
          updateGoalUI();
        }
      }
    });

    if (els.downloadAuditBtn) els.downloadAuditBtn.addEventListener('click', () => {
      const log = state.auditLog || [];
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url,
        filename: `kyoto-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        saveAs: true
      }).catch(() => {
        // Fallback: open in a new tab
        chrome.tabs.create({ url });
      });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (els.auditStatus) {
        els.auditStatus.textContent = `Downloaded ${log.length} entries.`;
        els.auditStatus.className = 'status ok';
      }
    });
    if (els.clearAuditBtn) els.clearAuditBtn.addEventListener('click', () => {
      const n = (state.auditLog || []).length;
      state.auditLog = [];
      if (els.auditStatus) { els.auditStatus.textContent = `Cleared ${n} entries.`; els.auditStatus.className = 'status ok'; }
    });

    if (els.popOutBtn) els.popOutBtn.addEventListener('click', () => {
      chrome.windows.create({
        url: chrome.runtime.getURL('sidepanel/sidepanel.html'),
        type: 'popup',
        width: 480, height: 720
      }).catch(() => {});
    });

    if (els.testConnBtn) els.testConnBtn.addEventListener('click', testConnection);

    if (els.workspaceZipBtn) els.workspaceZipBtn.addEventListener('click', async () => {
      try {
        const r = await window.KyotoTools.call('fs_zip', {});
        if (r?.error) throw new Error(r.error);
        els.workspaceSummary.textContent = `Downloaded ${r.fileCount} files · ${fmtBytes(r.bytes)}`;
      } catch (e) {
        els.workspaceSummary.textContent = `Error: ${e.message}`;
      }
    });
    if (els.workspaceClearBtn) els.workspaceClearBtn.addEventListener('click', async () => {
      const t = await window.KyotoVFS.total();
      if (!t.fileCount) { els.workspaceSummary.textContent = 'empty'; return; }
      if (!confirm(`Delete all ${t.fileCount} workspace files (${fmtBytes(t.totalBytes)})? This can't be undone.`)) return;
      await window.KyotoVFS.clear();
      updateWorkspaceUI();
    });

    const copyToClipboard = (text, btn) => {
      const flash = (msg) => {
        const orig = btn.textContent;
        btn.textContent = msg;
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      };
      // navigator.clipboard works in extension pages; the textarea
      // fallback covers older Chromiums and the case where the
      // document isn't focused.
      (navigator.clipboard?.writeText?.(text) || Promise.reject())
        .then(() => flash('✓ Copied'))
        .catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); flash('✓ Copied'); }
          catch { flash('Copy failed'); }
          finally { ta.remove(); }
        });
    };
    if (els.shellInstallCopyBtn) els.shellInstallCopyBtn.addEventListener('click', () => {
      copyToClipboard(els.shellInstallCmd.value, els.shellInstallCopyBtn);
    });
    if (els.shellInstallCopyAltBtn) els.shellInstallCopyAltBtn.addEventListener('click', () => {
      copyToClipboard(els.shellInstallCmdAlt.value, els.shellInstallCopyAltBtn);
    });
    if (els.shellInstallToggleAltBtn) els.shellInstallToggleAltBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const wrap = els.shellInstallAltWrap;
      if (!wrap) return;
      const showing = wrap.classList.toggle('hidden');
      // toggle returns the new state of "is class present" — if it just
      // ADDED .hidden, we're hiding. Flip the label accordingly.
      els.shellInstallToggleAltBtn.textContent = showing
        ? 'Show command for a different OS'
        : 'Hide command for the other OS';
    });

    if (els.shellCopyIdBtn) els.shellCopyIdBtn.addEventListener('click', () => {
      const orig = els.shellCopyIdBtn.textContent;
      const flash = (label) => {
        els.shellCopyIdBtn.textContent = label;
        setTimeout(() => { els.shellCopyIdBtn.textContent = orig; }, 1200);
      };
      navigator.clipboard.writeText(chrome.runtime.id)
        .then(() => flash('✓'))
        .catch(() => flash('✗'));
    });
    if (els.shellTestBtn) els.shellTestBtn.addEventListener('click', async () => {
      if (!els.shellStatus) return;
      els.shellStatus.textContent = 'Pinging native host…';
      els.shellStatus.className = 'status';
      try {
        const r = await window.KyotoTools.call('shell_ping', {});
        if (r?.ok) {
          els.shellStatus.textContent = `✓ Connected · ${r.platform} · cwd ${r.cwd}`;
          els.shellStatus.className = 'status ok';
        } else {
          els.shellStatus.textContent = `${r?.error || 'Not connected'} — run the install command above, then click Test again.`;
          els.shellStatus.className = 'status err';
        }
      } catch (e) {
        els.shellStatus.textContent = `Error: ${e.message}`;
        els.shellStatus.className = 'status err';
      }
    });

    if (els.skillsHubTestBtn) els.skillsHubTestBtn.addEventListener('click', async () => {
      if (!els.skillsHubStatus) return;
      const url = (els.skillsHubUrl?.value || '').trim().replace(/\/+$/, '');
      const key = (els.skillsHubKey?.value || '').trim();
      if (!url || !key) {
        els.skillsHubStatus.textContent = 'Enter URL + API key first.';
        els.skillsHubStatus.className = 'status err';
        return;
      }
      els.skillsHubStatus.textContent = 'Pinging hub…';
      els.skillsHubStatus.className = 'status';
      try {
        // Use in-form values so the user can test BEFORE saving.
        const health = await fetch(url + '/v1/healthz').then(r => r.json()).catch(() => null);
        const search = await fetch(url + '/v1/skills/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Kyoto-Auth': key },
          body: JSON.stringify({ domain: 'global', query: '', limit: 1 }),
        });
        if (!search.ok) {
          els.skillsHubStatus.textContent = `Auth failed (HTTP ${search.status}). Check the API key.`;
          els.skillsHubStatus.className = 'status err';
          return;
        }
        const j = await search.json();
        els.skillsHubStatus.textContent = `✓ Connected · ${health?.service || 'kyoto-skills-hub'} · ${j.count} global skill(s)`;
        els.skillsHubStatus.className = 'status ok';
      } catch (e) {
        els.skillsHubStatus.textContent = `Error: ${e.message}`;
        els.skillsHubStatus.className = 'status err';
      }
    });

    if (els.s3TestBtn) els.s3TestBtn.addEventListener('click', async () => {
      // Use the in-form values so the user can test BEFORE saving.
      if (els.s3Status) { els.s3Status.textContent = 'Uploading…'; els.s3Status.className = 'status'; }
      const access = (els.s3AccessKeyId?.value || '').trim();
      const secret = (els.s3SecretAccessKey?.value || '').trim();
      const region = (els.s3Region?.value || '').trim() || 'us-east-1';
      const bucket = (els.s3Bucket?.value || '').trim();
      const endpoint = (els.s3Endpoint?.value || '').trim();
      if (!access || !secret || !bucket) {
        els.s3Status.textContent = 'Need access key, secret, and bucket.';
        els.s3Status.className = 'status err';
        return;
      }
      try {
        // Temporarily stash current settings, write the form values,
        // call the tool, then restore. Avoids duplicating the signing
        // logic that lives in tools.js.
        const prev = await chrome.storage.local.get(['s3AccessKeyId','s3SecretAccessKey','s3Region','s3Bucket','s3Endpoint','s3KeyPrefix']);
        await chrome.storage.local.set({
          s3AccessKeyId: access, s3SecretAccessKey: secret,
          s3Region: region, s3Bucket: bucket, s3Endpoint: endpoint,
          s3KeyPrefix: (els.s3KeyPrefix?.value || '').trim()
        });
        try {
          const res = await window.KyotoTools.call('s3_upload', {
            content: `Kyoto test upload at ${new Date().toISOString()}\n`,
            contentType: 'text/plain',
            key: `kyoto-test-${Date.now()}.txt`
          });
          if (res?.error) throw new Error(res.error);
          els.s3Status.innerHTML = `✓ Uploaded · <a href="${res.url}" target="_blank" rel="noopener">${res.url.length > 60 ? res.url.slice(0, 60) + '…' : res.url}</a>`;
          els.s3Status.className = 'status ok';
        } finally {
          await chrome.storage.local.set(prev);
        }
      } catch (e) {
        els.s3Status.textContent = `Failed: ${e.message}`;
        els.s3Status.className = 'status err';
      }
    });

    if (els.themeSelect) els.themeSelect.addEventListener('change', async () => {
      await saveSettings({ theme: els.themeSelect.value });
      applyAppearance();
    });
    if (els.densitySelect) els.densitySelect.addEventListener('change', async () => {
      await saveSettings({ density: els.densitySelect.value });
      applyAppearance();
    });

    if (els.exportSettingsBtn) els.exportSettingsBtn.addEventListener('click', exportSettings);
    if (els.importSettingsBtn) els.importSettingsBtn.addEventListener('click', () => els.importSettingsInput?.click());
    if (els.importSettingsInput) els.importSettingsInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) importSettingsFile(file);
      e.target.value = '';
    });
    els.newChatBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const session = await createSession(tab);
      state.pinnedToSession = false; // resume follow-tab behavior
      await switchToSession(session);
      updateSessionsButton();
    });
    els.settingsBtn.addEventListener('click', openDrawer);
    els.closeDrawerBtn.addEventListener('click', closeDrawer);
    els.overlay.addEventListener('click', closeDrawer);
    els.reloadCtxBtn.addEventListener('click', refreshPageContext);

    els.modelBtn.addEventListener('click', toggleModelPopover);
    els.popoverSearch.addEventListener('input', renderPopoverList);
    els.popoverList.addEventListener('click', async (e) => {
      const item = e.target.closest('.popover-item');
      if (!item?.dataset.model) return;
      const patch = { model: item.dataset.model };
      // The header picker shows cross-provider models — if the user
      // picked a model that belongs to a different provider, auto-switch
      // the active provider too. That's the whole point.
      const pickedProvider = item.dataset.provider;
      if (pickedProvider && pickedProvider !== state.settings.provider) {
        patch.provider = pickedProvider;
      }
      await saveSettings(patch);
      // Keep the Settings drawer in sync if the provider just changed.
      if (patch.provider) {
        state.allModels = state.modelsByProvider.get(pickedProvider) || [];
        if (els.provider) els.provider.value = pickedProvider;
        reflectProvider(pickedProvider);
      }
      updateModelLine();
      updateMaxTokensHint();
      closeModelPopover();
    });

    els.sessionsBtn.addEventListener('click', toggleSessionsPopover);
    let searchDebounce;
    els.sessionsSearch.addEventListener('input', () => {
      renderSessionsList();
      clearTimeout(searchDebounce);
      const q = els.sessionsSearch.value.trim();
      searchDebounce = setTimeout(() => deepSearchSessions(q), 250);
    });
    els.sessionsList.addEventListener('click', async (e) => {
      const act = e.target.closest('.sess-act');
      const item = e.target.closest('.sess-item');
      if (!item) return;
      const id = item.dataset.id;
      if (act) {
        e.stopPropagation();
        const action = act.dataset.act;
        const meta = state.sessionsIndex.find(s => s.id === id);
        if (!meta) return;
        if (action === 'rename') {
          const next = prompt('Rename session', meta.title || '');
          if (next != null) {
            const full = await loadFullSession(id);
            if (full) { full.title = next.trim() || 'Untitled'; await persistSession(full); }
            if (state.activeSession?.id === id) state.activeSession.title = full.title;
            renderSessionsList();
          }
        } else if (action === 'delete') {
          if (!confirm('Delete this session?')) return;
          await deleteSession(id);
          if (state.activeSession?.id === id) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const s = await createSession(tab);
            switchToSession(s, { fromUser: true });
          }
          renderSessionsList();
        } else if (action === 'bind') {
          const full = await loadFullSession(id);
          if (!full) return;
          if (full.tabId != null) {
            // unbind
            delete state.tabToSession[full.tabId];
            full.tabId = null;
          } else {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) { full.tabId = tab.id; state.tabToSession[tab.id] = full.id; }
          }
          await persistSession(full);
          renderSessionsList();
        } else if (action === 'fork') {
          const copy = await forkSession(id);
          if (copy) { closeSessionsPopover(); switchToSession(copy, { fromUser: true }); }
        } else if (action === 'export') {
          await exportSessionMarkdown(id);
        }
        return;
      }
      // Click on row → open that session
      const full = await loadFullSession(id);
      if (!full) return;
      closeSessionsPopover();
      switchToSession(full, { fromUser: true });
    });
    document.addEventListener('click', (e) => {
      if (!els.modelPopover.classList.contains('hidden')) {
        if (!els.modelPopover.contains(e.target) && !els.modelBtn.contains(e.target)) closeModelPopover();
      }
      if (!els.sessionsPopover.classList.contains('hidden')) {
        if (!els.sessionsPopover.contains(e.target) && !els.sessionsBtn.contains(e.target)) closeSessionsPopover();
      }
    });

    els.revealBtn.addEventListener('click', () => {
      els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
    });
    els.provider.addEventListener('change', () => {
      const p = els.provider.value;
      els.apiKey.value = state.settings.apiKeys?.[p] || '';
      reflectProvider(p);
      // Use the cross-provider cache if we already have this provider's
      // models — avoids the dropdown looking empty for a second.
      const cached = state.modelsByProvider.get(p);
      if (cached && cached.length) {
        state.allModels = cached;
        renderModelOptions();
        els.modelHint.textContent = `${cached.length} models (cached). Pick one and Save.`;
      } else {
        state.allModels = [];
        els.model.innerHTML = '';
        els.modelHint.textContent = 'Enter an API key to load models.';
      }
      const cfg = getProviderConfig(p);
      if (els.apiKey.value.trim() || cfg?.isCustom) {
        fetchModels(p, els.apiKey.value.trim());
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
    els.maxTokens.addEventListener('input', updateMaxTokensHint);
    els.model.addEventListener('change', updateMaxTokensHint);

    els.openExtPageBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    });

    els.customProviderAddBtn.addEventListener('click', () => {
      const id = 'custom_' + Math.random().toString(36).slice(2, 8);
      state.settings.customProviders = [
        ...(state.settings.customProviders || []),
        { id, label: 'My provider', baseUrl: '' }
      ];
      renderCustomProvidersList();
    });
    els.customProvidersList.addEventListener('click', (e) => {
      const row = e.target.closest('.mcp-row');
      if (!row || !e.target.classList.contains('cp-del')) return;
      const idx = Number(row.dataset.idx);
      const cp = (state.settings.customProviders || [])[idx];
      if (!cp) return;
      state.settings.customProviders.splice(idx, 1);
      if (state.settings.apiKeys?.[cp.id]) {
        delete state.settings.apiKeys[cp.id];
      }
      // If the deleted custom was the active provider, fall back to a built-in.
      if (state.settings.provider === cp.id) {
        state.settings.provider = 'openrouter';
        reflectProvider('openrouter');
        els.apiKey.value = state.settings.apiKeys?.openrouter || '';
      }
      renderCustomProvidersList();
      renderProviderDropdown();
    });

    els.customSlashAddBtn.addEventListener('click', () => {
      state.settings.customSlashCommands = [
        ...(state.settings.customSlashCommands || []),
        { name: '', prompt: '' }
      ];
      renderCustomSlashList();
    });
    els.customSlashList.addEventListener('click', (e) => {
      const row = e.target.closest('.mcp-row');
      if (!row || !e.target.classList.contains('cs-del')) return;
      const idx = Number(row.dataset.idx);
      state.settings.customSlashCommands.splice(idx, 1);
      renderCustomSlashList();
    });

    if (els.customToolAddBtn) els.customToolAddBtn.addEventListener('click', () => {
      state.settings.customTools = [
        ...(state.settings.customTools || []),
        { name: '', description: '', parameters: '{ "type": "object", "properties": {} }', code: '// args: parsed input object\nreturn { ok: true };' }
      ];
      renderCustomToolsList();
    });
    if (els.customToolsList) els.customToolsList.addEventListener('click', (e) => {
      const row = e.target.closest('.ct-row');
      if (!row || !e.target.classList.contains('ct-del')) return;
      const idx = Number(row.dataset.idx);
      state.settings.customTools.splice(idx, 1);
      renderCustomToolsList();
    });

    els.mcpAddBtn.addEventListener('click', () => {
      state.settings.mcpServers = [...(state.settings.mcpServers || []), { name: '', url: '', auth: '', enabled: true }];
      renderMcpList();
    });
    els.mcpServersList.addEventListener('click', async (e) => {
      const row = e.target.closest('.mcp-row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (e.target.classList.contains('mcp-del')) {
        state.settings.mcpServers.splice(idx, 1);
        renderMcpList();
      } else if (e.target.classList.contains('mcp-test')) {
        const url = row.querySelector('.mcp-url').value.trim();
        const auth = row.querySelector('.mcp-auth').value.trim();
        els.mcpStatus.textContent = 'Testing…';
        try {
          const r = await window.KyotoMCP.probe(url, auth);
          els.mcpStatus.textContent = r.ok ? `✓ ${r.serverInfo?.name || 'OK'} · ${r.toolCount} tools` : `Failed: ${r.error}`;
          els.mcpStatus.className = `status ${r.ok ? 'ok' : 'err'}`;
        } catch (err) {
          els.mcpStatus.textContent = `Failed: ${err.message}`;
          els.mcpStatus.className = 'status err';
        }
      }
    });

    els.saveBtn.addEventListener('click', async () => {
      const provider = els.provider.value;
      const apiKey = els.apiKey.value.trim();
      const model = els.model.value;
      const systemPrompt = els.systemPrompt.value.trim();
      const temperature = Math.max(0, Math.min(2, Number(els.temperature.value) || 0.7));
      const maxTokens = Math.max(64, Math.min(131072, Number(els.maxTokens.value) || 8192));
      const toolsEnabled = !!els.toolsEnabled.checked;
      const maxAgentSteps = Math.max(1, Math.min(200, Number(els.maxAgentSteps?.value) || 50));
      const maxAutoContinues = Math.max(0, Math.min(10, Number(els.maxAutoContinues?.value) || 2));
      const enabledGroups = Array.from(els.toolGroups.querySelectorAll('input[type=checkbox]'))
        .filter(c => c.checked).map(c => c.dataset.group);

      // Read back custom providers from the UI rows, preserving id/order.
      const existingCustom = state.settings.customProviders || [];
      const customProviders = Array.from(els.customProvidersList.querySelectorAll('.mcp-row')).map((row, i) => {
        const prev = existingCustom[i] || {};
        return {
          id: prev.id || 'custom_' + Math.random().toString(36).slice(2, 8),
          label: row.querySelector('.cp-label').value.trim() || 'Custom',
          baseUrl: row.querySelector('.cp-base').value.trim(),
          _formKey: row.querySelector('.cp-key').value.trim() // pulled out below
        };
      }).filter(p => p.baseUrl);

      // Per-custom-provider key into apiKeys; keep all built-in keys.
      // Empty form value explicitly removes the stored key (so users can
      // clear a custom-provider key for keyless local servers).
      const apiKeys = { ...(state.settings.apiKeys || {}) };
      for (const cp of customProviders) {
        if (cp._formKey) apiKeys[cp.id] = cp._formKey;
        else delete apiKeys[cp.id];
        delete cp._formKey;
      }
      // The "primary" provider key (selected in the form) goes in too.
      if (apiKey) apiKeys[provider] = apiKey;

      const customSlashCommands = Array.from(els.customSlashList.querySelectorAll('.mcp-row')).map(row => ({
        name: row.querySelector('.cs-name').value.trim().replace(/^\/+/, ''),
        prompt: row.querySelector('.cs-prompt').value.trim()
      })).filter(c => c.name && c.prompt);

      const s3AccessKeyId     = (els.s3AccessKeyId?.value     || '').trim();
      const s3SecretAccessKey = (els.s3SecretAccessKey?.value || '').trim();
      const s3Region          = (els.s3Region?.value          || '').trim() || 'us-east-1';
      const s3Bucket          = (els.s3Bucket?.value          || '').trim();
      const s3KeyPrefix       = (els.s3KeyPrefix?.value       || '').trim();
      const s3Endpoint        = (els.s3Endpoint?.value        || '').trim();

      const customTools = Array.from(els.customToolsList?.querySelectorAll('.ct-row') || []).map(row => ({
        name: row.querySelector('.ct-name').value.trim(),
        description: row.querySelector('.ct-desc').value.trim(),
        parameters: row.querySelector('.ct-params').value.trim(),
        code: row.querySelector('.ct-code').value
      })).filter(t => t.name && t.code);

      const mcpServers = Array.from(els.mcpServersList.querySelectorAll('.mcp-row')).map(row => ({
        name: row.querySelector('.mcp-name')?.value.trim() || '',
        url: row.querySelector('.mcp-url')?.value.trim() || '',
        auth: row.querySelector('.mcp-auth')?.value.trim() || '',
        enabled: row.querySelector('.mcp-enabled')?.checked || false
      })).filter(s => s.url);

      // Validation: built-ins need a key; customs may not.
      const isCustom = !PROVIDERS[provider];
      if (!isCustom && !apiKey) { els.saveStatus.textContent = 'API key required.'; els.saveStatus.className = 'status err'; return; }
      if (!model) { els.saveStatus.textContent = 'Select a model from the list.'; els.saveStatus.className = 'status err'; return; }

      const redactSensitive = !!els.redactSensitive.checked;
      const auditEnabled = !!els.auditEnabled.checked;
      const hideReasoning = !!els.hideReasoning?.checked;
      const theme = els.themeSelect?.value || state.settings.theme || 'system';
      const density = els.densitySelect?.value || state.settings.density || 'comfortable';

      const skillsHubUrl = (els.skillsHubUrl?.value || '').trim();
      const skillsHubKey = (els.skillsHubKey?.value || '').trim();
      const skillsAutoSave = !!(els.skillsAutoSave?.checked);

      // Hub URL/key changed → drop the per-domain cache so stale skills
      // from the old hub don't keep showing up in the system prompt.
      const hubChanged =
        skillsHubUrl !== (state.settings.skillsHubUrl || '') ||
        skillsHubKey !== (state.settings.skillsHubKey || '');
      if (hubChanged) {
        try { _skillsDomainCache.clear(); } catch {}
        state.skillsForCurrentDomain = [];
        state.skillsForCurrentDomainKey = null;
      }

      await saveSettings({
        provider, model, systemPrompt, temperature, maxTokens,
        toolsEnabled, maxAgentSteps, maxAutoContinues, enabledGroups,
        apiKeys, mcpServers, customProviders, customSlashCommands, customTools,
        redactSensitive, auditEnabled, hideReasoning, theme, density,
        s3AccessKeyId, s3SecretAccessKey, s3Region, s3Bucket, s3KeyPrefix, s3Endpoint,
        skillsHubUrl, skillsHubKey, skillsAutoSave,
      });
      applyAppearance();
      compileCustomTools();
      if (els.customToolStatus) {
        const n = state.customToolHandlers?.size || 0;
        els.customToolStatus.textContent = `${n} custom tool${n === 1 ? '' : 's'} registered`;
        els.customToolStatus.className = 'status ok';
      }

      // Re-init MCP tools after settings change
      els.mcpStatus.textContent = 'Reconnecting MCP servers…';
      const mcpRes = await window.KyotoMCP.init(mcpServers);
      state.mcpTools = mcpRes.tools;
      els.mcpStatus.textContent = `MCP: ${mcpRes.connected}/${mcpRes.total} servers, ${state.mcpTools.length} tools`;
      els.mcpStatus.className = `status ${mcpRes.connected ? 'ok' : ''}`;

      // Refresh the cross-provider model cache — keys / custom
      // providers / endpoints may all have just changed.
      fetchAllProviderModels({ background: true }).catch(() => {});

      updateModelLine();
      els.saveStatus.textContent = 'Saved.';
      els.saveStatus.className = 'status ok';
      setTimeout(() => { els.saveStatus.textContent = ''; closeDrawer(); }, 600);
    });

    els.chat.addEventListener('click', async (e) => {
      const chip = e.target.closest('.chip');
      if (chip?.dataset.prompt) { sendMessage(chip.dataset.prompt); return; }
      const copy = e.target.closest('.copy-btn');
      if (copy?.dataset.code) {
        navigator.clipboard.writeText(decodeURIComponent(copy.dataset.code)).then(() => {
          const orig = copy.textContent;
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = orig; }, 1200);
        });
        return;
      }
      const editBtn = e.target.closest('.edit-btn');
      if (editBtn) {
        const idx = Number(editBtn.dataset.idx);
        editUserMessage(idx);
        return;
      }
      const pinBtn = e.target.closest('.pin-btn');
      if (pinBtn && state.activeSession) {
        const idx = Number(pinBtn.dataset.idx);
        const msg = state.activeSession.history[idx];
        if (!msg) return;
        msg._pinned = !msg._pinned;
        await persistSession(state.activeSession);
        pinBtn.textContent = msg._pinned ? '★' : '☆';
        pinBtn.title = msg._pinned ? 'Unpin' : 'Pin this message (always included in context)';
        pinBtn.closest('.msg')?.classList.toggle('pinned', !!msg._pinned);
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'ASK_SELECTION' && msg.text) {
        const q = `Regarding this selection:\n\n> ${msg.text.split('\n').join('\n> ')}\n\nWhat does this mean / explain it?`;
        sendMessage(q);
      } else if (msg?.type === 'ASK_PAGE') {
        els.input.focus();
      } else if (msg?.type === 'CAPTURE_EVENT' && state.capture.active && msg.payload) {
        // Drop events stamped with a stale session id — guards against
        // cross-tab listeners + lingering messages from a prior session.
        if (msg.sessionId && msg.sessionId !== state.capture.sessionId) return;
        // Coalesce: drop trailing duplicate fill events for the same selector.
        const last = state.capture.events[state.capture.events.length - 1];
        if (last && last.event === 'fill' && msg.payload.event === 'fill' && last.selector === msg.payload.selector) {
          state.capture.events[state.capture.events.length - 1] = msg.payload;
        } else {
          state.capture.events.push(msg.payload);
        }
        updateCaptureUI();
      }
    });

    if (els.captureBtn) {
      els.captureBtn.addEventListener('click', async () => {
        if (state.capture.active) await stopCapture();
        else await startCapture();
      });
    }

    // Keep state.memoryIndex in sync when memory tools mutate storage.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.kyoto_memory_index) {
        state.memoryIndex = changes.kyoto_memory_index.newValue || [];
      }
    });

    // Agent-opened new tabs inherit the calling session, so a chain like
    // "find this song -> open YouTube -> play it" doesn't reset
    // when the new tab is created. The flag is set by tab_open's
    // handler in tools.js just before chrome.tabs.create; we consume it
    // here as the new tab's onCreated event fires (which the browser
    // dispatches strictly before onActivated for the same tab).
    chrome.tabs.onCreated.addListener((tab) => {
      const sid = state.pendingAgentTabBind;
      if (sid) {
        state.tabToSession[tab.id] = sid;
        state.pendingAgentTabBind = null;
      }
    });

    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      if (state.pinnedToSession) { refreshPageContext(); return; }
      const sid = state.tabToSession[tabId];
      let session;
      if (sid) {
        session = await loadFullSession(sid);
        if (!session) session = await createSession(await getTab(tabId));
      } else {
        session = await createSession(await getTab(tabId));
      }
      await switchToSession(session);
    });
    chrome.tabs.onUpdated.addListener((tid, info) => {
      if (info.status === 'complete') refreshPageContext();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      // Detach session from removed tab but keep the session
      const sid = state.tabToSession[tabId];
      if (sid) {
        delete state.tabToSession[tabId];
        (async () => {
          const s = await loadFullSession(sid);
          if (s) { s.tabId = null; await persistSession(s); }
          if (state.activeSession?.id === sid) state.activeSession.tabId = null;
        })();
      }
    });
  }

  async function getTab(tabId) {
    try { return await chrome.tabs.get(tabId); } catch { return null; }
  }

  // ── Boot ─────────────────────────────────────────────
  (async () => {
    await loadSettings();
    applyAppearance();
    compileCustomTools();
    // Kick off models.dev registry load (cached, non-blocking after first run)
    if (window.KyotoModels) window.KyotoModels.init().catch(() => {});
    state.sessionsIndex = await loadSessionsIndex();
    state.tabToSession = {};
    state.sessionsIndex.forEach(s => { if (s.tabId != null) state.tabToSession[s.tabId] = s.id; });

    // Load memory index so the system prompt can list available memories
    const memGot = await chrome.storage.local.get('kyoto_memory_index');
    state.memoryIndex = memGot.kyoto_memory_index || [];

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let session = null;
    if (tab) {
      const sid = state.tabToSession[tab.id];
      if (sid) session = await loadFullSession(sid);
    }
    if (!session) session = await createSession(tab);
    state.activeSession = session;

    reflectProvider(state.settings.provider);
    updateModelLine();
    updateSessionsButton();
    wireEvents();
    renderSessionHistoryFresh();
    updateGoalUI();
    updateWorkspaceUI();
    refreshPageContext();

    // Init MCP servers in background
    if (window.KyotoMCP && (state.settings.mcpServers || []).length) {
      const mcpRes = await window.KyotoMCP.init(state.settings.mcpServers);
      state.mcpTools = mcpRes.tools;
    }

    // Preload models for every provider that has a key — so the header
    // picker can show them all without waiting for the user to flip
    // providers in Settings first.
    fetchAllProviderModels({ background: true }).catch(() => {});

    els.input.focus();
  })();
})();
