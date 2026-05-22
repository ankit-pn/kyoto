# Kyoto

**An AI browser agent for developers, in your Chrome side panel.**

Bring your own key for any OpenAI-compatible provider (OpenRouter, DeepSeek, MiniMax direct, Ollama, Groq, Together, Fireworks, Gemini-OAI, Anthropic-via-proxy, …), pick any model, and let it drive the browser: read DOM, inspect network, dump cookies, run JavaScript, click buttons, capture screenshots, search history, generate Postman collections, and call out to MCP servers. Per-tab sessions, OpenAI-style streaming tool calling with reasoning support, models.dev-powered token budgeting.

> Loaded as an unpacked extension only — not on the Chrome Web Store. Chrome 116+.

---

## Highlights

- **Native Chrome side panel.** Toolbar icon or `Ctrl/Cmd+Shift+L`. Also opens inside DevTools (F12 → Kyoto tab) and as a pop-out window.
- **Any OpenAI-compatible provider, multiple at once.** Three first-class (OpenRouter / DeepSeek / MiniMax) plus an unlimited "custom" slot for Ollama, LM Studio, Groq, Together, Cerebras, Gemini-OAI, Anthropic-via-LiteLLM, your-own-proxy, etc.
- **Per-tab sessions.** Every tab owns its own conversation. Switching tabs swaps the visible session; in-flight streams keep running for the tabs you left.
- **Streaming tool-call loop.** Up to 12 round-trips per turn. Captures `reasoning_content` from DeepSeek thinking-mode and reasoning models, echoes it back as the API requires.
- **~50 built-in tools** across browser, DOM, cookies, network, storage, devtools, debugger, history, memory, minimax, media, **shell**, devtools-export groups. Plus your own:
  - **Custom JS tools** — write a JS function body in Settings, model can call it.
  - **MCP server support** — JSON-RPC over HTTP; tools auto-registered as `mcp__<server>__<tool>`.
- **Cost & token visibility.** `stream_options.include_usage` parsed; each assistant message gets a `1.2K↧ · 0.4K↥ · $0.0021` chip from models.dev pricing.
- **Dynamic `max_tokens`** clamped from models.dev per-model caps. No more 400s from over-asking.
- **Slash commands** — built-in (`/summarize`, `/cookies`, `/network`, `/see`, `/har`, `/postman`, `/ts`, `/search`, `/vlm`, `/npm`, `/pypi`, `/so`, …) plus user-defined.
- **Cross-session memory** — agent can `memory_add` / `_search` / `_get`; titles surface in the system prompt automatically.
- **Pinned messages, replay/edit, fork session, export to Markdown, full-content session search.**
- **Vision** — 📸 button or `/see` attaches a tab screenshot as OpenAI multimodal content; or `minimax_describe_tab` for round-trip-free vision via MiniMax.
- **Session cloning workflow** — `cookies_analyze` + `cookies_export` (Netscape / Cookie header / curl `-b` / JSON) in two tool calls.
- **Sensitive-value redaction** in tool-result display (Bearer tokens / JWTs / API keys / long hex). Model still sees raw values.
- **Audit log** of every tool call, downloadable as JSON.

## Install

```bash
git clone https://github.com/ankit-pn/kyoto.git
cd kyoto
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select the cloned directory.
4. Accept the install-time permissions warning (debugger, all sites, etc. — Kyoto needs them).
5. Pin the toolbar icon and click it. The side panel opens.

Chrome 116+ is required (uses `chrome.sidePanel`).

## Setup

Click the gear icon. Pick a provider, paste an API key, save. Models load automatically from the provider's `/models` endpoint; the header model badge becomes a clickable picker.

| Provider | Key URL |
|---|---|
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) — ~350 models across OpenAI, Anthropic, Google, Meta, DeepSeek, MiniMax, … |
| **DeepSeek direct** | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) — cheapest path to V3 / Reasoner. |
| **MiniMax direct** | [minimax.io interface keys](https://www.minimax.io/platform/user-center/basic-information/interface-key) — MiniMax-M2 family + token-plan tools. |
| **Custom (any OpenAI-compatible endpoint)** | Settings → Custom OpenAI-compatible providers → add base URL + optional key. Works for Ollama (`http://localhost:11434/v1`, keyless), LM Studio (`http://localhost:1234/v1`), Groq (`https://api.groq.com/openai/v1`), Together, Fireworks, Cerebras, Cloudflare AI Gateway, Anthropic-via-LiteLLM, Gemini-OAI (`https://generativelanguage.googleapis.com/v1beta/openai`). |

Per-provider keys are stored independently; switching provider in Settings preserves each.

## What you can ask it

A few concrete workflows:

- **Session cloning** — *"Analyze cookies on this site, export the auth ones as a curl `-b` flag."* → `cookies_analyze` + `cookies_export {format:"curl-b"}`. Paste into terminal; you're authenticated.
- **Reverse-engineer an API** — *"Start a tab-scoped network capture. I'll click Submit. Then show me the request, generate TypeScript types for the response, and emit a Postman collection."* → `network_capture_*` + `network_har_export` / `network_postman_export` + `json_to_typescript`.
- **OCR / "what's on this page"** — *"/see explain this layout"* or *"call `minimax_describe_tab` and tell me what's broken."*
- **Authenticated replay** — *"Replay this fetch with my cookies and parse the JSON."* → `network_fetch` (sends user cookies by default).
- **Cookie diff** — *"`cookies_snapshot` label='before'. Now I'll click Login. Then `cookies_diff` and tell me what set the session."*
- **Dev lookups** — *"`/npm next-auth` plus `/so next-auth jwt rotation` — compare."*
- **Cross-tab** — *"Switch to my React docs tab, read the Hooks section, come back and apply it to the snippet on this page."*
- **Run JS in MAIN world** — *"dump `window.__NEXT_DATA__`."* → `page_eval`.

Tool calls render inline as collapsible cards (args + result). Reasoning streams in a separate "💭 thinking" card you can collapse globally.

## Slash commands

Type `/help` in the composer for the full list. Built-ins:

| Command | What |
|---|---|
| `/help` `/clear` `/pin` `/sessions` `/settings` | Panel actions (don't go to the model) |
| `/summarize` `/explain` `/eli5` `/keypoints` | Quick page prompts |
| `/cookies` `/clone-session` `/curl` `/diffcookies` | Cookie workflows |
| `/network` `/api` `/har` `/postman` | Network inspection / export |
| `/eval <js>` `/inspect <selector>` `/perf` | DOM / devtools |
| `/screenshot` `/see <prompt>` `/vlm <prompt>` | Vision |
| `/memory` `/remember <text>` `/recall <q>` | Cross-session memory |
| `/search <q>` | MiniMax web search |
| `/npm <pkg>` `/pypi <pkg>` `/so <q>` | Dev lookups |
| `/ts <rootName>` | JSON → TypeScript types |

Templates use `{{args}}` as the placeholder. Add your own under **Settings → Custom slash commands**.

## The tool catalog

Toggle groups on/off in **Settings → Tool groups**.

| Group | Tools |
|---|---|
| **browser** | `tabs_list`, `tab_active`, `tab_open`, `tab_navigate`, `tab_reload`, `tab_close`, `tab_screenshot`, `windows_list` |
| **page** | `page_content`, `page_html`, `page_query`, `page_click`, `page_fill`, `page_fill_form`, `page_scroll`, `page_wait_for`, `page_eval` |
| **storage** | `page_local_storage` + `_set` / `_remove`, `page_session_storage` + `_set` / `_remove`, `idb_list_databases`, `idb_list_stores`, `idb_read` |
| **cookies** | `cookies_list`, `cookies_get`, `cookies_set`, `cookies_remove`, `cookies_export` (netscape / json / header / curl-b), `cookies_analyze`, `cookies_snapshot`, `cookies_diff` |
| **network** | `network_capture_*` (start / stop / clear / list / detail) + `network_har_export` + `network_postman_export`, `network_fetch` (with cookies), `page_fetch_intercept` + `_read` (in-page fetch/XHR hook with bodies), `web_fetch_extract` (URL → readable text + links), `curl_to_fetch`, `fetch_to_curl` |
| **devtools** | `console_attach`, `console_read`, `page_performance`, `json_to_typescript`, `npm_info`, `pypi_info`, `stackoverflow_search` |
| **debugger** | `debugger_attach`, `debugger_detach`, `debugger_send` (raw CDP — `Runtime.evaluate`, `Network.getResponseBody`, `Input.dispatchKeyEvent`, …) |
| **browser-data** | `history_search`, `bookmarks_search`, `downloads_search` |
| **misc** | `clipboard_write`, `permission_request`, `permission_check` |
| **memory** | `memory_add`, `memory_list`, `memory_get`, `memory_search`, `memory_update`, `memory_delete` |
| **minimax** | `minimax_web_search` (Google-grade web), `minimax_understand_image`, `minimax_describe_tab` (capture + analyze in one call) |
| **media** | `media_detect`, `media_download` (local or S3, for direct file URLs), `s3_upload`, **`yt_dlp_run`** (full-quality download via shell bridge), `youtube_extract`, `youtube_capture_streams`, `yt_dlp_command` |
| **shell** | `shell_exec` (run a command via the native messaging host), `shell_ping` |
| **fs** | Virtual workspace (IndexedDB, GB-scale): `fs_write`, `fs_append`, `fs_read` (offset/limit chunks), `fs_list`, `fs_stat`, `fs_delete`, `fs_move`, `fs_total`, `fs_zip` (download as ZIP), `fs_clear` |

Plus any MCP-server tools (auto-namespaced `mcp__<server>__<tool>`) and custom JS tools you define.

## Per-tab sessions

Each tab owns its own conversation.

- Tab switch → side panel swaps the visible session.
- Streams keep running in tabs you left. When the work completes it lands in that session's history.
- Manually opening a session from the popover **pins** it (auto-tab-swap disabled until you hit "New chat").
- Closed tabs don't delete their sessions, they unbind. Session lives on in the menu; rebind via the per-row action.
- Per-row actions: **rename**, **bind/unbind**, **fork** (duplicate as a new session), **export to Markdown**, **delete**.
- **Search** the sessions list. Queries ≥ 3 chars also deep-search history content (lazy-loaded, cached, debounced).
- Storage: `kyoto_sessions_index` + `kyoto_session_<id>`. Persisted on every mutation.

## Replay / edit

Hover any user message → ✎ button. Click to rewrite. Save truncates history to that point and regenerates from the edited message — the rest of the conversation is intentionally discarded.

## Cross-session memory

Six tools the agent can call: `memory_add`, `memory_list`, `memory_get`, `memory_search`, `memory_update`, `memory_delete`. Saved memories' titles are automatically surfaced in the system prompt so the model knows what's recallable.

> *"Remember that I use Bun + Vitest, and our staging API is at https://stg.example.com."* → `memory_add` invoked.

Later, in any tab: *"What testing setup do I use?"* → `memory_search` → `memory_get` → answer.

## MCP servers

Settings → MCP servers → **+ Add server**. Per-server fields: name, URL, optional `Authorization` header, on/off, **Test** button.

On Save, Kyoto runs `initialize` → `tools/list` and registers every advertised tool as `mcp__<name>__<tool>`. Tool calls route via `tools/call`. Supports both plain-JSON and `text/event-stream` JSON-RPC responses (streamable-HTTP transport).

**MiniMax MCP note**: MiniMax's official MCP server is stdio-only (`uvx minimax-coding-plan-mcp`) and not reachable from a browser. Kyoto ships the same two tools as native built-ins (`minimax_web_search`, `minimax_understand_image`, `minimax_describe_tab`) using your stored MiniMax key.

## Custom JS tools

Settings → **Custom JS tools** → + Add tool. Each entry has name, description, JSON-schema parameters, and a JS function body.

```js
// args: parsed input object (matches the JSON schema)
// chrome.* and fetch are global. Async ok.
const r = await fetch('https://api.github.com/repos/' + args.repo);
return await r.json();
```

The code runs in the side-panel context — full `chrome.*` and `fetch` access. The tool name is sanitised to snake_case and surfaced to the model alongside built-ins.

## Reasoning models

DeepSeek thinking mode and some OpenRouter providers stream a separate `reasoning_content` (or `reasoning` / `thinking`) channel. The API requires that channel to be echoed back unchanged on the next assistant turn — otherwise multi-step tool loops fail with *"The reasoning_content in the thinking mode must be passed back to the API."*

Kyoto accumulates the reasoning channel under whichever field name the provider used, stores it on the assistant message, and echoes it back automatically. A "💭 thinking" card shows the live reasoning stream (toggle globally in Settings → Appearance → Hide reasoning).

## Dynamic `max_tokens` (models.dev)

`max_tokens` caps the model's **response** length. The cap varies wildly per model.

Following the sst/opencode pattern, Kyoto fetches [`models.dev/api.json`](https://models.dev) on boot (cached 24h, ETag-revalidated, CORS-friendly), reads `<provider>.models.<id>.limit.output`, and clamps `body.max_tokens = min(userPref, modelMax)` at request time. The header model badge shows the limits inline as `<context>↧/<output>↥` with the data source in the tooltip.

Pricing from the same registry feeds the per-message cost chip.

## Vision

Two paths:

1. **📸 toggle** (composer row) or **`/see <prompt>`** — captures the visible tab via `chrome.tabs.captureVisibleTab` (JPEG q=80) and sends it as OpenAI multimodal content alongside your text. Works with any vision-capable model on the configured provider (GPT-4o family, Claude 3.5+, Gemini 2.x, Llama-vision via OpenRouter, …).
2. **`minimax_describe_tab`** (or `/vlm`) — captures + sends to MiniMax VLM in one tool call. The data URL never enters the conversation, so this is ~100× cheaper for tab-level vision than the multimodal-message route.

## Audit log + redaction

- **Audit log** (Settings → Backup section): every tool call is appended in-memory (capped 1000) with `{ ts, sessionId, tool, args, elapsedMs, isError, resultPreview }`. **Download audit log** writes a JSON file. **Clear** resets. Session-scoped; resets on panel reload.
- **Credential redaction** (Settings → Mask credentials in tool-result display, default on): Bearer tokens, JWT-shaped strings, `sk-…` keys, hex blobs ≥40 chars, and common key/value patterns (`api_key`, `secret`, `password`, …) are replaced with `<REDACTED>` in the rendered tool results. The model still receives raw values.

## Appearance

Settings → Appearance:

- **Theme**: System / Light / Dark (overrides `prefers-color-scheme`).
- **Density**: Comfortable / Compact (smaller paddings + font).
- **Hide reasoning cards** toggle.

## Shell bridge — run real commands on your machine

Kyoto can execute shell commands on your OS via Chrome's native messaging API. A tiny Python host lives under your home directory and Chrome speaks to it over stdio — no open ports, no sudo.

**Install (one-liner):**

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.sh \
  | bash -s -- <YOUR_EXTENSION_ID>
```

```powershell
# Windows (PowerShell)
$env:KYOTO_EXT_ID = "<YOUR_EXTENSION_ID>"
irm https://raw.githubusercontent.com/ankit-pn/kyoto-shell-bridge/main/install.ps1 | iex
```

Find `<YOUR_EXTENSION_ID>` at `chrome://extensions` (Developer mode enabled), or open Kyoto → ⚙ Settings → **Shell bridge** — the ID is shown with a copy button, and the install command is pre-filled with your ID.

Restart Chrome after install, then in Kyoto:

```
/sh echo hello
/sh ls ~/Downloads
/shell df -h
```

Or in normal chat: *"Run `git status` in `~/projects/foo` and tell me what's changed."*

The installer writes manifests for every installed Chromium browser it finds (Chrome, Chrome Beta/Canary, Chromium, Edge, Brave, Vivaldi, Opera, Arc on macOS).

Tools: **`shell_exec({ command, cwd?, timeoutMs?, env? })`**, **`shell_ping`**. Slash commands: **`/sh`**, **`/shell`**.

### Real YouTube / Instagram / Twitter / Vimeo / Twitch / TikTok / Bilibili downloads

Once the shell bridge is installed, **`yt_dlp_run`** does the actually-correct thing for ~1500 sites. Full speed (no n-param throttling), full quality (auto ffmpeg merge of separate streams), uses your browser cookies for age-gated / Premium / members-only content. On first call it auto-installs `yt-dlp` via `pipx` → `pip --user` if it's not already on your `PATH`.

```
/dl
/yt
```

`/dl` downloads the current tab. `/yt` is shorthand for "download this YouTube tab." Both go through `yt_dlp_run`. Tools: **`yt_dlp_run({ url, audioOnly?, format?, outputDir?, useBrowserCookies? })`**. The older `yt_dlp_command` is kept for the "give me the command, I'll run it myself" workflow.

## DevTools panel mode

Open Chrome DevTools (F12) → **Kyoto** tab next to Console / Network / Performance. The panel iframes the side panel — same JS, same storage. Settings, sessions, tools all work identically.

## Pop out

⤴ button in the header opens the side panel as a `chrome.windows` popup (480×720). Useful for multi-monitor / always-on display. Each popup is a fresh side-panel instance backed by the same storage.

## Backup

Settings → Backup:

- **Export settings** — JSON dump of all settings keys (apiKeys, customProviders, mcpServers, slash commands, customTools, prefs). Sessions, memories, audit log, cookie snapshots, and the models.dev cache are excluded.
- **Import settings** — file picker that validates the export envelope and merges back into `chrome.storage.local`. Asks for a reload to apply.

## Permissions

Required (in `permissions`):

- `storage` — keys, sessions, settings, memories.
- `sidePanel` — the UI surface.
- `scripting` — page extraction, DOM tools.
- `tabs` — list / switch tabs, page-context awareness.
- `cookies` — the cookie tools.
- `webRequest` — passive observation for `network_capture_*` (MV3-compatible, no blocking).
- `webNavigation` — refresh page context on navigation.
- `history`, `bookmarks`, `downloads` — the `browser-data` tools + audit-log download.
- `notifications`, `clipboardWrite`, `alarms` — utilities.
- `contextMenus` — right-click integration.
- `debugger` — CDP attach for response-body capture, full DevTools control, dispatch input events. Yellow banner shows when attached.
- `<all_urls>` host permission — required for the agent to read any tab you point it at.

Optional (requested via the model's `permission_request` tool):

- `clipboardRead`, `management`, `topSites`.

## Privacy

- Keys, sessions, memories, and settings live in `chrome.storage.local`. They don't sync.
- The page content, your prompts, and tool results are sent to whichever LLM provider you've selected, when you send a message. That's the only outbound traffic apart from:
  - `models.dev/api.json` (once a day, no payload, public registry).
  - Each configured MCP server (when its tools are listed/called).
  - Provider-specific tools you invoke (e.g. `minimax_*` hits `api.minimax.io`, `npm_info` hits `registry.npmjs.org`, `web_fetch_extract` hits whatever URL you pass).
- The extension does not phone home. No analytics, telemetry, or "Sign in with Kyoto."

## Architecture

```
manifest.json
background.js                service worker: context menu, network capture, page extraction, debugger proxy, HAR/Postman export
sidepanel/
  sidepanel.html             the side panel UI
  sidepanel.css
  sidepanel.js               chat loop, sessions, settings, streaming, slash commands, custom-tool compile
  tools.js                   the ~45 built-in tools
  mcp.js                     minimal MCP JSON-RPC client (HTTP transport)
  models-registry.js         models.dev fetcher + cost helper + static fallback table
  ../lib/marked.min.js       markdown renderer
devtools/
  devtools.html              DevTools loader page
  devtools.js                registers the Kyoto panel
  panel.html                 iframes sidepanel/sidepanel.html
icons/                       16/48/128 PNG (solid blue square, white K)
README.md  LICENSE  (MIT)
```

The chat loop in `runChatLoop(session)` is a multi-step streaming machine:

1. Stream a turn from the provider (`streamOnce`).
2. Accumulate text + reasoning + tool_calls deltas.
3. Push assistant message (with reasoning field + tool_calls) to history; persist.
4. For each tool_call: execute via `callToolOrMCP`, render a card, push a `role: tool` message. Audit-append every call.
5. If there were tool_calls, loop. Else, done.

`callToolOrMCP` routes by name: **MCP → custom → built-in**.

## Known limitations

- `webRequest` in MV3 can't see response bodies. Use `page_fetch_intercept` (hooks `fetch`/`XHR` in the page MAIN world), `debugger_attach` + CDP `Network.getResponseBody`, or `web_fetch_extract` for a known URL.
- `models.dev` lags behind brand-new releases by hours/days. Newer models can fall through to the static fallback (8K) until the registry updates.
- No streaming for MCP tool results — they're returned synchronously after the JSON-RPC call.
- `chrome.storage.local` quota is 10 MB. Vision messages with full base64 images add up; use `minimax_describe_tab` (no round-trip) instead of `tab_screenshot` + multimodal for heavy vision workflows.
- `page_fill_form` works for text inputs / textareas / contenteditable only. Checkboxes/radios need `page_click`.
- `chrome.tabs.query` from devtools-panel / pop-out contexts may not bind to the inspected tab — session is created unbound; user can rebind via the popover.
- No options page; everything's in the side panel drawer.

## Contributing

Issues and PRs welcome. Codebase is intentionally small — handful of vanilla JS files, no build step, no framework, no bundler.

```bash
git clone https://github.com/ankit-pn/kyoto.git
cd kyoto
# edit files, then reload the unpacked extension at chrome://extensions
```

Plain MV3 + vanilla DOM.

## License

MIT.
