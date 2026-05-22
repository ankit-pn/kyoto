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
    empty: $('empty'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    newChatBtn: $('newChatBtn'),
    sessionsBtn: $('sessionsBtn'),
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
    allModels: [],
    mcpTools: [],                // dynamically-added tool defs
    visionPending: false         // one-shot: attach screenshot to next message
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
    '/postman':    'Export the captured network buffer as a Postman v2.1 collection using `network_postman_export`. Show me the host breakdown.'
  };

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
    enabledGroups: ['browser', 'page', 'storage', 'cookies', 'network', 'devtools', 'browser-data', 'misc', 'memory', 'minimax'],
    mcpServers: [],
    redactSensitive: true,
    auditEnabled: true,
    // Agentic loop limits. opencode's pattern: high default, exposed
    // as config. Too low and complex multi-tool tasks die half-way.
    maxAgentSteps: 50,
    maxAutoContinues: 2,
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
  async function fetchModels(provider, apiKey) {
    const cfg = getProviderConfig(provider);
    if (!cfg) {
      els.modelHint.textContent = `Unknown provider: ${provider}`;
      return;
    }
    // Custom providers may not need an API key (e.g. local Ollama).
    if (!apiKey && !cfg.isCustom) {
      state.allModels = [];
      els.model.innerHTML = '';
      els.modelHint.textContent = 'Enter an API key to load models.';
      return;
    }
    els.modelHint.textContent = 'Loading models…';
    try {
      const res = await fetch(cfg.modelsUrl, { headers: cfg.headers(apiKey) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const parsed = cfg.parseModels(data).filter(m => m.id);
      if (!parsed.length && cfg.fallbackModels) {
        state.allModels = cfg.fallbackModels;
        els.modelHint.textContent = `${state.allModels.length} models (fallback list).`;
      } else {
        state.allModels = parsed.sort((a, b) => a.id.localeCompare(b.id));
        els.modelHint.textContent = `${state.allModels.length} models. Pick one and Save.`;
      }
      renderModelOptions();
    } catch (e) {
      if (cfg.fallbackModels) {
        state.allModels = cfg.fallbackModels;
        renderModelOptions();
        els.modelHint.textContent = `${state.allModels.length} models (fallback — /models endpoint unreachable: ${e.message}).`;
      } else {
        state.allModels = [];
        els.model.innerHTML = '';
        els.modelHint.textContent = `Failed: ${e.message}`;
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
    if (!currentApiKey()) { openDrawer(); return; }
    els.modelPopover.classList.remove('hidden');
    els.popoverSearch.value = '';
    if (!state.allModels.length) {
      els.popoverList.innerHTML = '<p class="popover-empty">Loading…</p>';
      await fetchModels(state.settings.provider, currentApiKey());
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
    const fmt = window.KyotoModels?.formatN || ((n) => String(n || '—'));
    const provider = state.settings.provider;
    Object.keys(groups).sort().forEach(g => {
      parts.push(`<div class="popover-group">${esc(g)}</div>`);
      groups[g].forEach(m => {
        const active = m.id === state.settings.model ? ' active' : '';
        const info = window.KyotoModels?.get(provider, m.id);
        const caps = info ? `<span class="popover-caps" title="ctx ${info.context ?? '?'} / out ${info.output ?? '?'} · ${info.source}">${fmt(info.context)} / ${fmt(info.output)}</span>` : '';
        parts.push(`<div class="popover-item${active}" data-model="${esc(m.id)}"><span class="popover-mname">${esc(m.name)}</span>${caps}<span class="check">✓</span></div>`);
      });
    });
    els.popoverList.innerHTML = parts.join('');
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
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
        state.visionPending = false;
        updateVisionUI();
        return sendMessage([
          { type: 'text', text },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]);
      } catch (e) {
        // Restore the user's typed text so they can retry without losing it.
        if (els.input) { els.input.value = text; els.input.dispatchEvent(new Event('input')); }
        addMessage('assistant', `Screenshot failed: ${e.message}. Your message has been restored to the composer.`, { error: true });
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

      // If we exited via the for-loop condition (not via break), we ran
      // out of steps with the agent still wanting to act. Make that
      // visible so the user doesn't think the agent "just stopped".
      if (stoppedReason === 'maxSteps') {
        const note = `_Reached the max agent-steps cap (${maxSteps}). The agent still wanted to continue. Raise the limit in **Settings → Max agent steps per turn**, or just say "continue" to keep going._`;
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
    });
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = els.input.value; els.input.value = ''; els.input.style.height = 'auto';
        submitInput(v);
      }
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
      await saveSettings({ model: item.dataset.model });
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
      state.allModels = [];
      els.model.innerHTML = '';
      els.modelHint.textContent = 'Enter an API key to load models.';
      if (els.apiKey.value.trim()) fetchModels(p, els.apiKey.value.trim());
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

      await saveSettings({
        provider, model, systemPrompt, temperature, maxTokens,
        toolsEnabled, maxAgentSteps, maxAutoContinues, enabledGroups,
        apiKeys, mcpServers, customProviders, customSlashCommands, customTools,
        redactSensitive, auditEnabled, hideReasoning, theme, density
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
      }
    });

    // Keep state.memoryIndex in sync when memory tools mutate storage.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.kyoto_memory_index) {
        state.memoryIndex = changes.kyoto_memory_index.newValue || [];
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
    refreshPageContext();

    // Init MCP servers in background
    if (window.KyotoMCP && (state.settings.mcpServers || []).length) {
      const mcpRes = await window.KyotoMCP.init(state.settings.mcpServers);
      state.mcpTools = mcpRes.tools;
    }

    els.input.focus();
  })();
})();
