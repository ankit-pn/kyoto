# Kyoto — Chrome API coverage & what to build next

Goal stated: *"use all the Chrome APIs Chrome offers for extensions"*.

Honest answer up front: **covering every API is the wrong target.** Each permission
is an install-time warning ("Read and change all your data on all websites",
"Manage your downloads", …), each surface is code you must maintain, and many APIs
are irrelevant or harmful to an AI browser agent (VPN provider, printer provider,
input IME, GCM push). What makes an extension feel GOAT is **the small set of
platform surfaces that remove friction** — and never failing because of one.

Measured 2026-11-01 against the repo at `v14.22.0`.

---

## 1. Current surface (before this change)

**Permissions declared (16):** `storage`, `sidePanel`, `scripting`, `contextMenus`,
`tabs`, `cookies`, `webRequest`, `webNavigation`, `history`, `bookmarks`,
`downloads`, `notifications`, `clipboardWrite`, `alarms`, `debugger`,
`nativeMessaging`. Optional: `clipboardRead`, `management`, `topSites`.
Host: `<all_urls>`.

**APIs in actual use:** `runtime` (messaging, onInstalled, onMessage, connectNative,
ports), `storage.local` + `storage.session` + `storage.onChanged`, `tabs`
(query/get/create/update/remove/captureVisibleTab/onCreated/onUpdated/onRemoved/
onActivated), `scripting.executeScript` (ISOLATED + MAIN world), `alarms`,
`cookies`, `webRequest` (5 event types, observe-only), `webNavigation`,
`history`, `bookmarks`, `downloads` (+ `onChanged`), `notifications`,
`sidePanel.open`, `contextMenus`, `debugger` (CDP), `permissions`, `windows`
(partial: `getAll`/`create`), `commands` (action shortcut).

That is already a serious surface — roughly 20 of the ~60 APIs that could apply
to an agent.

---

## 2. Added in this change (`v14.23.0`)

New permissions: `tabGroups`, `sessions`, `power`, `pageCapture`, `browsingData`,
`readingList`, `idle`, `omnibox`, `declarativeNetRequest`,
`declarativeNetRequestWithHostAccess`.

| Capability | API | Why it matters for an agent |
|---|---|---|
| Address-bar entry | `omnibox` | `ky <prompt>` from any tab, no panel round-trip. Fastest path to "ask about this page". |
| Tab grouping | `tabs.group` + `tabGroups` | Group the tabs a task touched, colour/name/collapse them, close the group when done. Makes multi-tab work legible. |
| Undo closed | `sessions` | "Reopen what I just closed" is a top real-world request, and the agent currently cannot. |
| Keep awake | `power` | Long runs and cron jobs must not be interrupted by the machine sleeping. |
| Page archive | `pageCapture` | MHTML snapshot preserves a page offline (CSS/images/inline JS) — evidence, not just text. |
| Start clean | `browsingData` | Clear cookies/cache/storage for one origin: "log me out", "test as a new user". |
| Save for later | `readingList` | Durable "read this later" that survives session deletion. |
| Idle awareness | `idle` | Cron/heavy work can defer while the user is actively working, or run when locked. |
| Request interception | `declarativeNetRequest` | Block trackers/analytics, redirect an API at a localhost mock, stub a response to test the failure path. |

---

## 3. The rest of the platform — what's left and whether it earns its keep

### Tier A — worth building next (high value, contained cost)

| API | Permission | Idea |
|---|---|---|
| `tabCapture` / `desktopCapture` | `tabCapture`, `desktopCapture` | **Record the tab** as video and/or audio for a bounded window. Turns "the agent saw it" into evidence you can replay, and gives transcripts of audio-only pages (meetings, podcasts). Needs a user gesture and a MediaRecorder pipeline; store to the workspace. |
| `offscreen` | `offscreen` | Run DOM-dependent work with no visible page: decode audio for transcription, canvas manipulation, large clipboard formatting, ML inference. Lets audio capture work without hijacking the side panel. |
| `identity` | `identity` | `launchWebAuthFlow` for provider OAuth (GitHub/Google/custom) so users sign in instead of pasting keys — and unlock Google APIs (Gmail/Drive/Calendar) as agent tools. |
| `userScripts` | `userScripts` (+ host) | Persist the agent's injected JS across page loads — a workflow it discovered stays installed, instead of being re-injected every turn. |
| `contentSettings` | `contentSettings` | Per-site toggles (JS on/off, images, popups) so an agent can test a page with JS disabled or reproduce a user's real settings. |
| `processes` | `processes` | Per-tab CPU/memory. Pairs with the existing `page_performance`: "which of these 12 tabs is eating the machine?" |
| `windows` (full) | — (uses `tabs`) | Window inventory, focus, move/merge windows, "put all research tabs in one window". Already half-wired. |
| `tts` | `tts` | Read answers aloud — accessibility win, and genuinely nice for long summaries while you do something else. |

### Tier B — nice to have

`privacy` (toggle "do not track"/safe browsing for a test), `proxy` (point the
browser at a mitm proxy for debugging), `devtools.network` (HAR from the DevTools
panel, complementing the existing webRequest capture), `declarativeContent`
(surface the action when a page matches — mostly superseded by better UX),
`system.cpu`/`system.memory`/`system.storage` (throttle back heavy tooling under
pressure), `search` (programmatic search-engine query), `i18n` (localise the UI —
reach, not capability), `fontSettings`/`accessibilityFeatures` (respect user
settings), `management` (already optional).

### Tier C — deliberately skip

`gcm`/`instanceID` (dead), `certificateProvider`, `platformKeys`,
`enterprise.*`, `vpnProvider`, `printerProvider`, `printingMetrics`,
`fileSystemProvider`, `fileBrowserHandler`, `input.ime`, `wallpaper`,
`documentScan`, `webAuthenticationProxy`, `certificateProvider`,
`tabCapture`-adjacent `webbundle`/`prerendering`… These serve Chrome-OS/kiosk/
enterprise products, not a developer agent. Adding them buys permission warnings
and maintenance with no user benefit.

---

## 4. Permission cost — the part that decides "GOAT"

Install warnings are the real constraint. Rough ranking of what a user sees:

- **Silent:** `storage`, `alarms`, `sidePanel`, `idle`, `power`, `tabGroups`,
  `readingList`, `omnibox`, `contextMenus`, `notifications`, `unlimitedStorage`.
- **Mild:** `sessions`, `pageCapture`, `tabs` ("Read your browsing history").
- **Loud:** `browsingData` ("Clear your browsing data"), `processes`,
  `declarativeNetRequest` (tied to host access), `debugger` ("Show a warning
  when debugging"), `nativeMessaging`, `<all_urls>`.

Kyoto already carries the loudest ones (`<all_urls>`, `debugger`,
`nativeMessaging`), so adding `browsingData` etc. changes the *text* of the
warning little. That is an argument for adding now rather than later: the
permission ask is already at its ceiling.

**Rule to keep:** don't declare a permission no tool uses. Chrome surfaces
permission warnings even for unused grants, and reviewers ask. Every permission
here maps to at least one shipped tool.

---

## 5. Two structural upgrades worth more than more APIs

1. **Optional permissions instead of up-front.** The loud capabilities
   (`debugger`, `browsingData`, `tabCapture`, `identity`) could move to
   `optional_permissions` and be requested at first use — which is already the
   pattern for `debugger`. This measurably improves install conversion and is a
   better "GOAT" move than adding surface area.
2. **A capability manifest in the UI.** Show which platform surfaces are granted
   and what each unlocks, so the agent's abilities are legible instead of
   discovered by accident.
