# Kyoto

**An AI browser agent for developers, in your Chrome side panel.**

Bring your own key for any OpenAI-compatible provider (OpenRouter, OpenCode Go, DeepSeek, MiniMax direct, Ollama, Groq, Together, Fireworks, Gemini-OAI, Anthropic-via-proxy, …), pick any model, and let it drive the browser: read DOM, inspect network, dump cookies, run JavaScript, click buttons, capture screenshots, search history, generate Postman collections, and call out to MCP servers. Per-tab sessions, OpenAI-style streaming tool calling with structured reasoning passthrough, models.dev + live-catalogue token budgeting.

> Loaded as an unpacked extension only — not on the Chrome Web Store. Chrome 116+.

---

## Highlights

- **Native Chrome side panel.** Toolbar icon or `Ctrl/Cmd+Shift+L`. Also opens inside DevTools (F12 → Kyoto tab) and as a pop-out window.
- **Address-bar entry.** Type `ky <prompt>` in the omnibox from any tab — no panel round-trip. `ky summarize: …` / `ky explain: …` expand into page prompts.
- **Command palette (`Ctrl/Cmd+K`).** One fuzzy launcher over every action, slash command, session, configured model, tool and settings pane — the fix for 150 tools being undiscoverable.
- **Voice in and out.** 🎤 dictation into the composer (Web Speech, no permission) and optional read-aloud of replies. The mic hides itself on browsers without speech support rather than showing a dead button.
- **Council mode.** `/council <question>` asks up to four configured models in parallel and shows the answers side by side with latency and cost — then adopt the winner with one click.
- **Routines.** Record a workflow once, replay it **with no model calls**: fast, deterministic and free, runnable by the agent or by cron.
- **Share a session as HTML.** `/share` exports a self-contained, secret-redacted page you can hand to someone else.
- **Any OpenAI-compatible provider, multiple at once.** Four first-class (OpenRouter / OpenCode Go / DeepSeek / MiniMax) plus an unlimited "custom" slot for Ollama, LM Studio, Groq, Together, Cerebras, Gemini-OAI, Anthropic-via-LiteLLM, your-own-proxy, etc.
- **Per-tab sessions.** Every tab owns its own conversation. Switching tabs swaps the visible session; in-flight streams keep running for the tabs you left.
- **Streaming tool-call loop.** Up to 12 round-trips per turn. Captures the reasoning channel — OpenRouter's `reasoning_details` (replayed verbatim, in order, encrypted blocks included), plus `reasoning_content` / `reasoning` from DeepSeek thinking-mode and other reasoning models.
- **~100 built-in tools** across browser, DOM, cookies, network, storage, devtools, debugger, history, memory, minimax, media, **shell** (with background jobs), **meta** (ask_user), devtools-export groups. Plus your own:
  - **Custom JS tools** — write a JS function body in Settings, model can call it.
  - **MCP server support** — JSON-RPC over HTTP; tools auto-registered as `mcp__<server>__<tool>`.
- **Cost & token visibility.** Each assistant message gets a `1.2K↧ · 0.4K↥ · $0.0021` chip. OpenRouter and OpenCode Go report their own per-request `cost` (including cache and reasoning token detail); other providers fall back to models.dev pricing.
- **Dynamic `max_tokens`** clamped from models.dev *and* the provider's live `/models` catalogue (which knows about models released after this extension shipped). No more 400s from over-asking.
- **Slash commands** — built-in (`/summarize`, `/cookies`, `/network`, `/see`, `/cost`, `/compact`, `/har`, `/postman`, `/ts`, `/search`, `/vlm`, `/npm`, `/pypi`, `/so`, …) plus user-defined.
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
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) — ~450 models across OpenAI, Anthropic, Google, Meta, DeepSeek, MiniMax, … |
| **OpenCode Go** | [opencode.ai/console](https://opencode.ai/console) → Account → Personal API keys (`oc_sk_…`) — subscription gateway; the $10/mo Go plan gives per-model monthly allowances across Claude, GPT, Gemini, GLM, Kimi, Qwen and more, all through one OpenAI-compatible endpoint. |
| **DeepSeek direct** | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) — cheapest path to V3 / Reasoner. |
| **MiniMax direct** | [minimax.io interface keys](https://www.minimax.io/platform/user-center/basic-information/interface-key) — MiniMax-M2 family + token-plan tools. |
| **Custom (any OpenAI-compatible endpoint)** | Settings → Custom OpenAI-compatible providers → add base URL + optional key. Works for Ollama (`http://localhost:11434/v1`, keyless), LM Studio (`http://localhost:1234/v1`), Groq (`https://api.groq.com/openai/v1`), Together, Fireworks, Cerebras, Cloudflare AI Gateway, Anthropic-via-LiteLLM, Gemini-OAI (`https://generativelanguage.googleapis.com/v1beta/openai`). |

Per-provider keys are stored independently; switching provider in Settings preserves each.

### OpenCode Go notes

Go is a separate product from pay-as-you-go "OpenCode Models" (`opencode.ai/zen`): same gateway and key type, different base path (`/inference/go` vs `/inference`) and different billing. Kyoto targets the Go subscription path:

- Chat: `https://opencode.ai/inference/go/openai/v1/chat/completions`
- Catalogue: `https://opencode.ai/inference/go/v1/models` — public, no key required, so the model picker fills in before you paste one.
- Auth: `Authorization: Bearer oc_sk_…` **plus** `x-opencode-session: ses_…`, which the Go gateway requires on every request (it returns `400 MissingSessionID` before it even checks the key). Kyoto derives that id deterministically from the conversation so it stays stable across turns.
- Every Go text model works through the OpenAI-compatible path — the gateway translates to the Anthropic/Gemini APIs server-side, so one code path drives Claude, Gemini and GPT models.
- The gateway sends no CORS headers on its POST endpoint. That is fine for an extension (host permissions bypass CORS) but means a plain web page cannot call it.

### OpenRouter routing & reasoning

Settings → **OpenRouter routing & reasoning** exposes the parts of OpenRouter that matter for an agent:

- **Reasoning effort** (`minimal` … `max`) → sent as `reasoning.effort`. Reasoning tokens are billed and count against `max_tokens`.
- **Provider sort** (`price` / `throughput` / `latency` / `exacto`) → `provider.sort`. `exacto` ranks providers by tool-calling quality.
- **Routing variant** (`:nitro`, `:floor`, `:exacto`) → appended to the model id at request time only; catalogue metadata still resolves against the base id. Catalog suffixes such as `:free` and `:batch` are real, separately-priced models and stay part of the id.
- **Data collection** → `provider.data_collection: "deny"` refuses training/logging providers. Note many `:free` models then become unusable, because free models require the training toggle on your account.
- `provider.require_parameters` is set automatically whenever tools are sent — without it OpenRouter *silently drops* `tools` when no provider supports them, and the agent loses the ability to act.

Reasoning is preserved across multi-step tool loops: OpenRouter returns `reasoning_details`, which must be echoed back **verbatim and in order** (encrypted blocks carry the provider signature). Kyoto persists the exact array on the assistant turn and replays it rather than re-serialising it. Streaming failures arrive in-band with HTTP 200 (`error` + `finish_reason:"error"`) and are surfaced as real errors instead of a silently truncated reply.

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
| `/cost` `/compact` | Spend/usage report · force a context compaction |
| `/council <q>` `/council-use provider:model` | Ask several models in parallel, then adopt one |
| `/routine list\|save <name>\|run <name>` | Recorded workflows: replay deterministically |
| `/share` | Export the session as standalone HTML |
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
| **shell** | `shell_exec` (sync, supports `idleTimeoutMs` — kills only when output goes silent), `shell_exec_bg` + `shell_poll` / `shell_wait` / `shell_kill` / `shell_jobs` (background jobs with idle-based killing), `shell_ping` (reports `jobsSupported`) |
| **meta** | `ask_user` (interactive chat-card prompt — agent pauses and waits for the user) |
| **fs** | Virtual workspace (IndexedDB, GB-scale): `fs_write`, `fs_append`, `fs_read` (offset/limit chunks), `fs_list`, `fs_stat`, `fs_delete`, `fs_move`, `fs_total`, `fs_zip` (download as ZIP), `fs_clear` |
| **platform** | Chrome platform surfaces: `tabgroup_list` / `_create` / `_add` / `_ungroup`, `session_recent` + `session_restore` (undo a closed tab/window), `power_keep_awake` (stop the machine sleeping mid-run), `page_capture_mhtml` (offline page archive), `site_data_clear` (per-origin "log me out"), `windows_inspect`, `tab_move_to_window`, `reading_list_add` + `_query`, `idle_state` |
| **routine** | `routine_list`, `routine_run`, `routine_save`, `routine_delete` — replay a recorded page workflow deterministically (no model calls). Pairs with cron for scheduled, free automation. |
| **intercept** | Request interception via `declarativeNetRequest`: `net_rules_list`, `net_rule_block` (kill a request → simulate outage), `net_rule_redirect` (point an API at a localhost mock), `net_rule_stub` (replace a body), `net_rule_remove`, `net_rule_clear` (restore normal networking) |

Plus any MCP-server tools (auto-namespaced `mcp__<server>__<tool>`) and custom JS tools you define.

## Chrome platform reach

Kyoto uses ~26 Chrome extension APIs. Beyond the tab/DOM/cookie basics, the newest additions target the friction that makes agents unreliable:

- **Tab groups** (`tabGroups`) — name/colour/close the tabs a task touched, so multi-tab work stays legible.
- **Undo closed** (`sessions`) — `session_recent` + `session_restore`: "reopen what I just closed" finally works.
- **Keep awake** (`power`) — long runs and cron jobs won't be interrupted by the machine sleeping.
- **Page archive** (`pageCapture`) — MHTML snapshot preserves a page offline (styles, images, inline JS), not just extracted text.
- **Start clean** (`browsingData`) — `site_data_clear` wipes one origin's cookies/cache/storage: sign out, or test as a new user.
- **Idle awareness** (`idle`) — heavy or scheduled work can defer while you're actually working.
- **Request interception** (`declarativeNetRequest`) — block requests to simulate an outage, or redirect an API at a localhost mock. Rules are browser-wide and persist until removed, so broad filters require an explicit `confirmBroad`: `net_rule_clear` is the reset. Note DNR cannot set a status code; `net_rule_stub` replaces a body and says so plainly.

See [CHROME-API-ROADMAP.md](CHROME-API-ROADMAP.md) for the full coverage map — what's used, what's worth adding next (`tabCapture`, `offscreen`, `identity`, `userScripts`, `contentSettings`, `processes`, `tts`) and what is deliberately skipped.

## Palette, voice, council, routines

Five features aimed at how the agent is *used*, not at what it can call.

**Command palette (`Ctrl/Cmd+K`).** A fuzzy launcher over actions, slash commands, sessions, configured models, all tools and settings. Results render grouped by source while `↑`/`↓` follow the rendered order (grouping the list but navigating by score makes the cursor appear to jump between sections).

**Voice.** The 🎤 button dictates into the composer — `interim` results replace each other (browsers resend the whole hypothesis) while `final` results append once, so nothing is duplicated. Replies can be read aloud (`speechSynthesis`), sentence-chunked so long answers don't arrive as one utterance. Speech is cancelled when a new turn starts.

**Council.** `/council <question>` fans out to up to four providers that actually have credentials, renders one block per model, and records the spend for each so the session cap and `/cost` stay truthful. A failing model becomes an error column, not a failed run.

**Routines.** The recorder already captures structured page events (with sensitive values masked as `«password»`/`«card»`/…). A routine turns them into steps once, then replays them exactly: no model, no tokens, deterministic. Selector quality is the whole game — the planner prefers `data-testid` → `aria-label` → `name` → a *stable* `#id` (generated ids are rejected) → a shallow CSS path, and returns nothing rather than inventing a text selector. Masked values are never replayed: the routine reports which steps need input and the caller supplies them. Steps that look destructive (`Delete`, `Pay`, `Submit`, …) are flagged so the user can be asked first.

**Share.** `/share` writes a single self-contained HTML file: inline CSS, no external requests, `_`-prefixed internals stripped, and API keys/Bearer tokens/JWTs/PEM blocks redacted before they can reach disk.

## Per-tab sessions

Each tab owns its own conversation.

- Tab switch → side panel swaps the visible session.
- Streams keep running in tabs you left. When the work completes it lands in that session's history.
- **A running session stays bound to its own tab.** Tab-scoped tools (`page_*`, `tab_*`, `cookies_*`, `network_capture_*`, `console_*`, `debugger_*`, `idb_*`, `youtube_*`, …) are pinned to the conversation's tab and never follow the tab you switch to — otherwise a background turn would start reading and clicking whatever page you happened to focus, and its context would quietly describe the wrong page. The cached page snapshot is tagged with the tab it came from and is only injected into the session that owns that tab, so switching tabs mid-turn can't leak another page into an in-flight conversation.
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

## Long sessions, cost and resilience

Three things that keep a long agent session from falling over.

**Auto-compaction.** An agent transcript only grows — tool results are bulky — and every model has a hard context window. Once the transcript passes it, *every* subsequent request fails with a context-length error and the session looks broken. Kyoto estimates the transcript before each model call (at ~3.6 chars/token, deliberately pessimistic) and, past ~75% of the window, folds the older turns into a single recap while keeping the recent turns verbatim. Pinned messages always survive.

The risky part is the cut point: a transcript may never split an assistant message carrying `tool_calls` from the `tool` results that answer it — every OpenAI-compatible server rejects that shape. `sidepanel/context.js` only ever cuts immediately before a `user` turn, which is structurally safe, and `test/context.test.js` asserts the invariant. If the summarising call fails, a deterministic fallback summary (the user's own requests plus the tools that ran) is used instead, so context is never dropped silently. `/compact` forces it; Settings can disable it or change how many turns stay verbatim.

**Spend guard.** Costs come from the provider's own `usage.cost` where it reports one (OpenRouter, OpenCode Go), falling back to models.dev pricing. `$` chips appear per message, `/cost` breaks down session vs. all-time, and **Settings → Spend cap** sets an optional per-session USD ceiling — the agent stops cleanly at the cap instead of running away mid-loop.

**Model fallback.** **Settings → Fallback models** takes one `provider:model` per line and is tried in order when the primary fails *transiently*: rate limits, provider overload, upstream disconnects, context overflow. It deliberately does **not** retry auth or credit failures on another model — those fail identically everywhere and retrying would just hide a bad key. A fallback is only taken when nothing has been streamed yet, so a reply is never stitched together from two different models, and the UI says which model took over.

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

Sync tools: **`shell_exec({ command, cwd?, timeoutMs?, idleTimeoutMs?, env? })`** (pass `idleTimeoutMs` instead of `timeoutMs` to kill only when output goes silent — no wall-clock cap), **`shell_ping`** (returns `jobsSupported: true` on v14.4+ hosts).

Background tools (run a job, do other work, poll/wait/kill): **`shell_exec_bg`** → `{ jobId }`, **`shell_poll`** → `{ stdout, stderr, done, exitCode, idleMs, elapsedMs, killedReason }`, **`shell_wait`** → blocks until done or `maxWaitMs`, **`shell_kill`**, **`shell_jobs`** (list all). Jobs auto-die if idle past `idleTimeoutMs` (default 60s).

Slash commands: **`/sh`**, **`/shell`**.

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
- `history`, `bookmarks`, `downloads` — the `browser-data` tools + audit-log download.
- `notifications`, `clipboardWrite`, `alarms` — utilities.
- `contextMenus` — right-click integration.
- `debugger` — CDP attach for response-body capture, full DevTools control, dispatch input events. Yellow banner shows when attached.
- `nativeMessaging` — the local shell/daemon bridge (`shell_*` tools).
- `tabGroups`, `sessions`, `power`, `pageCapture`, `browsingData`, `readingList`, `idle`, `omnibox` — the `platform` tools (tab groups, recently-closed restore, keep-awake, MHTML capture, site-data clearing, reading list, idle state, address-bar entry).
- `declarativeNetRequest`, `declarativeNetRequestWithHostAccess` — the `intercept` tools (block / redirect / stub requests). Rules are browser-wide and persist until removed; a match-everything filter needs `confirmBroad`, and a cross-origin redirect needs `confirmCrossOrigin`.
- `<all_urls>` host permission — required for the agent to read any tab you point it at.

No optional permissions are declared: every capability the extension ships is in the list above, and `test/audit.test.js` fails the build if a permission is declared but unused, or used but not declared.

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
  tools.js                   the ~100 built-in tools
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
