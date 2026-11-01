// Minimal MCP (Model Context Protocol) client.
// HTTP/JSON-RPC transport — POSTs a JSON-RPC request, expects a JSON-RPC
// response in the same response body. Compatible with MCP servers using
// the "Streamable HTTP" transport in request/response mode.
//
// Exposes window.KyotoMCP:
//   init(servers)           -> { connected, total, tools[] }
//   probe(url, auth)        -> { ok, serverInfo, toolCount }
//   call(toolName, args)    -> tool result (or { error })

(() => {
  'use strict';

  const PROTOCOL_VERSION = '2025-06-18';
  const CLIENT_INFO = { name: 'Kyoto', version: '5.0.0' };
  // C8: browsers give fetch no default timeout, and an MCP server can accept
  // the POST and then stall (proxy/VPN, pending auth, silent hang) — one such
  // server used to be able to block init()/a tool call forever. Bound every
  // request; tools/call gets a longer budget because those can legitimately run.
  const DEFAULT_TIMEOUT_MS = 20_000;
  const CALL_TIMEOUT_MS = 60_000;

  // Internal state — maps tool name -> { server, originalName }
  const toolRouteByName = new Map();
  const connectedServers = []; // [{ name, url, auth, tools, serverInfo }]

  function newId() { return Math.floor(Math.random() * 1e9); }

  async function rpc(url, auth, method, params, { signal: outerSignal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (auth) headers['Authorization'] = auth.startsWith('Bearer ') || auth.includes(' ') ? auth : `Bearer ${auth}`;
    const body = { jsonrpc: '2.0', id: newId(), method, params: params ?? {} };

    // AbortSignal.timeout() alone can't also honour a caller-supplied signal,
    // so build the controller manually.
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error(`MCP request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onOuterAbort = () => ctrl.abort(outerSignal.reason);
    if (outerSignal) {
      if (outerSignal.aborted) onOuterAbort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        // Read SSE until first "data:" frame carrying our id. Keep-alive
        // frames, "[DONE]" markers and plain-text events are dropped: only
        // a real JSON-RPC error may fail the request.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const event = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            const data = dataLine.slice(5).trim();
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }
            if (parsed.id === body.id) {
              if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
              return parsed.result;
            }
          }
        }
        throw new Error('SSE stream ended without response');
      } else {
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.result;
      }
    } catch (e) {
      if (timedOut) throw new Error(`MCP request timed out after ${timeoutMs} ms (${method})`);
      throw e;
    } finally {
      clearTimeout(timer);
      if (outerSignal && typeof outerSignal.removeEventListener === 'function') {
        outerSignal.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  function safeName(serverName) {
    return (serverName || 'mcp').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 24) || 'mcp';
  }

  function namespaceTool(serverName, toolName) {
    return `mcp__${safeName(serverName)}__${toolName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  }

  async function initServer(s) {
    if (!s.enabled || !s.url) return null;
    try {
      // initialize handshake
      const initResp = await rpc(s.url, s.auth, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, sampling: {} },
        clientInfo: CLIENT_INFO
      });
      // notifications/initialized — fire-and-forget per spec (we ignore failures)
      try { await rpc(s.url, s.auth, 'notifications/initialized', {}); } catch {}

      // tools/list
      const toolsResp = await rpc(s.url, s.auth, 'tools/list', {});
      const tools = (toolsResp?.tools || []).map(t => ({
        type: 'function',
        function: {
          name: namespaceTool(s.name || initResp?.serverInfo?.name || 'mcp', t.name),
          description: `[MCP/${s.name || 'server'}] ${t.description || ''}`.trim(),
          parameters: t.inputSchema || { type: 'object', properties: {}, additionalProperties: false }
        },
        _mcpOriginal: t.name,
        _mcpServer: { url: s.url, auth: s.auth, name: s.name }
      }));
      return { server: s, serverInfo: initResp?.serverInfo || null, tools };
    } catch (e) {
      return { server: s, error: e.message || String(e), tools: [] };
    }
  }

  async function init(servers) {
    toolRouteByName.clear();
    connectedServers.length = 0;
    if (!Array.isArray(servers)) servers = [];

    const results = await Promise.all(servers.map(initServer));
    const allTools = [];
    const errors = [];
    let connected = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.error) {
        // Keep the failure: a server the user configured but that will not
        // connect silently reduced the tool set with no explanation.
        errors.push({
          name: r.server?.name || r.server?.url || '(unnamed)',
          url: r.server?.url || '',
          error: r.error
        });
        continue;
      }
      connected++;
      connectedServers.push(r);
      for (const t of r.tools) {
        toolRouteByName.set(t.function.name, t);
        // strip the route metadata from the public schema
        const { _mcpOriginal, _mcpServer, ...publicTool } = t;
        allTools.push(publicTool);
      }
    }
    return {
      connected,
      total: servers.filter(s => s.enabled && s.url).length,
      tools: allTools,
      errors
    };
  }

  async function probe(url, auth) {
    try {
      const initResp = await rpc(url, auth, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: CLIENT_INFO
      });
      try { await rpc(url, auth, 'notifications/initialized', {}); } catch {}
      const toolsResp = await rpc(url, auth, 'tools/list', {});
      return { ok: true, serverInfo: initResp?.serverInfo || null, toolCount: (toolsResp?.tools || []).length };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function call(toolName, args) {
    const t = toolRouteByName.get(toolName);
    if (!t) return { error: `Unknown MCP tool: ${toolName}` };
    try {
      const result = await rpc(t._mcpServer.url, t._mcpServer.auth, 'tools/call', {
        name: t._mcpOriginal,
        arguments: args || {}
      }, { timeoutMs: CALL_TIMEOUT_MS });
      // MCP tools/call result is typically { content: [...], isError?: bool }
      if (result?.isError) {
        return { error: 'tool reported error', content: result.content };
      }
      // Flatten content blocks into text where possible
      if (Array.isArray(result?.content)) {
        const flat = result.content.map(c => {
          if (c.type === 'text') return c.text;
          if (c.type === 'image') return `[image ${c.mimeType || ''}]`;
          if (c.type === 'resource') return `[resource ${c.resource?.uri || ''}]`;
          return JSON.stringify(c);
        }).join('\n');
        return { ok: true, content: flat, raw: result };
      }
      return { ok: true, result };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  window.KyotoMCP = { init, probe, call };
})();
