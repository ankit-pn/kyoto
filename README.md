# Kyoto

**An AI browser agent for developers, in your Chrome side panel.**

Bring your own key (OpenRouter, DeepSeek, or MiniMax), pick any model, and let it drive the browser: read DOM, inspect network, dump cookies, run JavaScript, click buttons, capture screenshots, search history, and call out to MCP servers. Per-tab sessions, OpenAI-style tool calling with streaming, models.dev-powered token budgeting.

> Status: usable but unpolished. Built fast, with rough edges. Loaded as an unpacked extension only — not on the Chrome Web Store.

---

## Features

- **Native Chrome side panel** — opens with the toolbar icon or `Ctrl/Cmd+Shift+L`. No content-script injection that breaks pages.
- **Three providers** — OpenRouter, DeepSeek, MiniMax. Per-provider API keys persist independently.
- **Streaming tool-call loop** — the model emits tool calls, the panel executes them, results stream back. Up to 12 tool round-trips per turn.
- **Per-tab sessions** — every tab has its own conversation. Switching tabs swaps the visible session; in-flight streams keep running for the tab you left.
- **Reasoning-model support** — captures `reasoning_content` / `reasoning` / `thinking` deltas and echoes them back on the next turn (required by DeepSeek thinking mode and some OpenRouter reasoning providers).
- **Dynamic `max_tokens`** — pulls per-model output caps from [models.dev](https://models.dev) (cached 24h with ETag) and clamps at request time. No more 400s from asking 32K of an 8K model.
- **MCP server support** — JSON-RPC over HTTP. Configure servers in Settings; their tools are namespaced as `mcp__<server>__<tool>` and offered to the model alongside built-ins.
- **30+ developer tools** across browser, DOM, cookies, network, storage, devtools, history, and debugger groups.
- **Right-click / context menus** — "Ask Kyoto about '<selection>'" sends selected text straight into chat.

## Installation

1. Clone:
   ```bash
   git clone https://github.com/ankit-pn/kyoto.git
   cd kyoto
   ```
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** (top right).
4. **Load unpacked** → select the cloned directory.
5. On install Chrome will warn about powerful permissions (debugger, all sites, etc.). Accept — Kyoto needs them to do what it does.
6. Pin the toolbar icon and click it. The side panel opens.

Chrome 116+ is required (uses `chrome.sidePanel`).

## Setup

Click the gear icon. Pick a provider, paste an API key, save. Models load automatically.

- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys). Gives access to ~350 models across OpenAI, Anthropic, Google, Meta, DeepSeek, MiniMax, and more.
- **DeepSeek direct** — [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). Best price for DeepSeek-V3 and Reasoner if you mostly use those.
- **MiniMax** — [minimax.io interface keys](https://www.minimax.io/platform/user-center/basic-information/interface-key). Direct access to MiniMax-M2 family.

Keys live in `chrome.storage.local`. They never leave your browser except in API calls to the provider you selected.

## What you can ask it

The empty-state chips are good starting points. Some practical examples:

- *"Summarize this page in 5 bullet points."* — uses the auto-extracted page text.
- *"List the cookies for this site, tell me which are auth/session, and export them as a Netscape cookies.txt."* — runs `cookies_analyze` + `cookies_export`.
- *"Start a tab-scoped network capture, click the Login button, then show me which API endpoint handled the login."* — `network_capture_start` → `page_click` → `network_capture_list`. For response bodies, use `page_fetch_intercept` (in-page hook) or `debugger_attach` + CDP `Network.getResponseBody`.
- *"Replay this fetch with my cookies and parse the JSON response."* — `network_fetch` (auto-includes cookies).
- *"Dump all top-level globals on this page that aren't standard browser objects."* — `page_eval`.
- *"Switch to my other tab, scrape the article, then come back and compare it to this one."* — tools work across tabs.

When the model uses a tool, the args and result are shown inline in a collapsible card.

## The tool catalog

Toggle groups on/off in Settings → Tool groups.

| Group | Tools |
|---|---|
| **browser** | `tabs_list`, `tab_active`, `tab_open`, `tab_navigate`, `tab_reload`, `tab_close`, `tab_screenshot`, `windows_list` |
| **page** | `page_content`, `page_html`, `page_query`, `page_click`, `page_fill`, `page_scroll`, `page_wait_for`, `page_eval` |
| **storage** | `page_local_storage`, `page_session_storage` |
| **cookies** | `cookies_list`, `cookies_get`, `cookies_set`, `cookies_remove`, `cookies_export` (netscape/json/header/curl-b), `cookies_analyze` (classifies session/auth/csrf/tracking) |
| **network** | `network_capture_*` (webRequest observer + ring buffer), `network_fetch` (with cookies), `page_fetch_intercept` + `_read` (in-page fetch/XHR hook with bodies) |
| **devtools** | `console_attach`, `console_read`, `page_performance` |
| **debugger** | `debugger_attach`, `debugger_detach`, `debugger_send` (raw CDP — `Runtime.evaluate`, `Network.getResponseBody`, `Input.dispatchKeyEvent`, …) |
| **browser-data** | `history_search`, `bookmarks_search`, `downloads_search` |
| **misc** | `clipboard_write`, `permission_request`, `permission_check` |

## Session cloning

The killer dev workflow: take an authenticated session in one browser and replay it elsewhere.

> "List cookies for this site, mark the important ones for cloning, and export them as a curl `-b` flag."

The model calls `cookies_analyze` (which tags every cookie as `session`/`auth`/`csrf`/`tracking`/`consent`), then `cookies_export` with `format: curl-b`. Paste the line into your terminal and you're authenticated. Netscape `cookies.txt` and `Cookie:` header formats are also available.

## MCP servers

Settings → MCP servers → **+ Add server**.

| Field | What |
|---|---|
| name | short label, used in tool namespace |
| url | the MCP server's HTTP endpoint |
| Authorization | optional, sent as `Authorization` header |
| on | enable this server |

On Save, Kyoto runs the JSON-RPC handshake (`initialize` → `tools/list`) and registers every advertised tool as `mcp__<name>__<tool>`. Tool calls route to that server via `tools/call`. **Test** button verifies the connection without saving. Supports both plain JSON and `text/event-stream` JSON-RPC responses (streamable-HTTP transport).

## Per-tab sessions

Each tab gets its own conversation. Some details:

- Tab switch → side panel swaps the visible session.
- Streams keep running in the tab you left. When the work completes it lands in that session's history.
- Open a previous session from the sessions menu (☰) — picking one **pins** it (auto-tab-swap disabled until you hit "New chat").
- Closed tabs don't delete their sessions, they unbind. The session lives on in the menu; rebind it from there.
- Storage: `kyoto_sessions_index` (sorted metadata) + `kyoto_session_<id>` (full history). Persisted on every mutation.

## Reasoning models

DeepSeek thinking mode and some OpenRouter providers stream a `reasoning_content` (or `reasoning` / `thinking`) channel separate from `content`. The API requires that channel to be echoed back unchanged in the next assistant message — otherwise multi-step tool loops fail with *"The reasoning_content in the thinking mode must be passed back to the API."*

Kyoto accumulates the reasoning channel, persists it on the assistant message under the original field name, and echoes it back. A collapsed "💭 thinking" card in the chat shows the live reasoning stream.

## Dynamic `max_tokens` (models.dev)

`max_tokens` caps the model's **response** length, not the input. The cap varies wildly by model — DeepSeek-V3.2 supports 64K+ output, MiniMax-M2.1 does 131K, plain GPT-4o-mini does 16K. Asking for more than the cap returns a 400.

Following the sst/opencode pattern, Kyoto fetches [`models.dev/api.json`](https://models.dev) on boot (cached 24h, ETag-revalidated, CORS-friendly), looks up `<provider>.models.<id>.limit.output`, and clamps `body.max_tokens = min(userPref, modelMax)` at request time. The header model badge shows the limits inline (`128K↧/8K↥`), and the settings drawer hint becomes dynamic.

## Permissions, what each one does

Required (in `permissions`):

- `storage` — saves keys, sessions, settings.
- `sidePanel` — the UI surface.
- `scripting` — page extraction, DOM tools.
- `tabs` — list / switch tabs, page context awareness.
- `cookies` — the cookie tools.
- `webRequest` — passive observation for `network_capture_*`. MV3-compatible (no blocking).
- `webNavigation` — refresh page context on navigation.
- `history`, `bookmarks`, `downloads` — the `browser-data` tools.
- `notifications`, `clipboardWrite`, `alarms` — small utilities.
- `contextMenus` — right-click integration.
- `debugger` — CDP attach for response-body capture and full DevTools control. Yellow banner shows when attached.
- `<all_urls>` host permission — required for the agent to read any tab you point it at.

Optional (requested at runtime via the model's `permission_request` tool):

- `clipboardRead`, `management`, `topSites`.

## Privacy

- Keys, sessions, and settings live in `chrome.storage.local`. They don't sync.
- The page content, your prompts, and tool results are sent to whichever LLM provider you've selected, when you send a message. That's the only outbound traffic apart from:
  - `models.dev/api.json` (once a day, no payload, public registry)
  - Each configured MCP server (when its tools are listed/called)
- The extension does not phone home. There is no analytics, telemetry, or "Sign in with Kyoto."

## Architecture

```
manifest.json
background.js              service worker: context menu, network capture, page extraction, debugger proxy
sidepanel/
  sidepanel.html           the side panel UI
  sidepanel.css
  sidepanel.js             chat loop, sessions, settings, streaming
  tools.js                 the ~30 built-in tools (browser/DOM/cookies/network/...)
  mcp.js                   minimal MCP JSON-RPC client (HTTP transport)
  models-registry.js       models.dev fetcher + static fallback table
  ../lib/marked.min.js     markdown renderer
icons/                     16/48/128 PNG (solid blue square, white K)
```

Tool calls route through one of two dispatchers:
- `KyotoTools.call(name, args)` — built-ins. Most run directly from the side panel via `chrome.*` APIs; a few proxy to the background SW for things like `webRequest` (must register in the SW for the listener to survive) or `debugger`.
- `KyotoMCP.call(name, args)` — anything registered from an MCP server. POSTs `tools/call` to the right server.

The chat loop in `sendMessage` is a multi-step streaming machine:
1. Stream a turn from the provider.
2. Accumulate text + reasoning_content + tool_calls deltas.
3. Push assistant message (with reasoning + tool_calls) to history; persist session.
4. For each tool call: execute, render a card, push a `role: tool` message with the result.
5. If there were tool calls, loop. Else, done.

## Known limitations

- `webRequest` in MV3 can't see response bodies. Use `page_fetch_intercept` (hooks `fetch`/`XHR` in the page MAIN world) or `debugger_attach` + CDP `Network.getResponseBody`.
- Side-panel `chrome.permissions.request()` is flaky for `debugger`; that's why `debugger` is a required permission, not optional.
- `models.dev` lags behind brand-new releases by hours/days. Newer OpenRouter models can fall through to the static fallback (8K) until the registry updates.
- No streaming for MCP tool results — they're returned synchronously after the JSON-RPC call.
- No options page; everything's in the side panel drawer.

## Roadmap (loose)

- Per-session model override (use one provider in one tab, a different one in another).
- HAR export from the network capture buffer.
- Better tool-permission gating (per-tool ask-before-running for write operations).
- Pluggable MCP transports (SSE-only servers).
- Per-tool kill-switch in the chat UI.

## Contributing

Issues and PRs welcome. The codebase is intentionally small — five hand-written JS files plus a few hundred lines of CSS — so it's easy to read through end-to-end.

Local dev:
```bash
git clone https://github.com/ankit-pn/kyoto.git
cd kyoto
# edit files, then reload the unpacked extension at chrome://extensions
```

No build step. No bundler. No framework. Plain MV3 + vanilla DOM.

## License

MIT.
