# Audit & test report — v14.25.0

Scope: the whole extension at `v14.24.0` (`a739e1f`), after five features and a
Chrome-API expansion landed in a single session.

Two things ran in parallel:

1. **Build the verification the code was missing** — the wiring layer had no tests.
2. **An independent audit** by a fresh reviewer (I wrote most of this code, so my
   own review of it is worth little). Full report: `kyoto-v1424-audit.md`.

---

## Coverage before → after

| Surface | Size | Before | After |
|---|---|---|---|
| Pure modules | ~2.6k lines | 351 tests | 351 tests |
| **`sidepanel/sidepanel.js` (UI + wiring)** | **7,391 lines** | **only 4 string-extracted functions** | **booted in jsdom; 17 end-to-end tests** |
| `sidepanel/tools/*.js` | 151 tools | ~15 behaviour-tested | **151 contract-tested** + destructive-guard checks |
| `background.js` (28 handlers) | 1,862 lines | cron only | **11 tests** incl. NET_FETCH, capture restart, menus, omnibox |
| Structural invariants | manifest/HTML/scripts/secrets | none | **9 audit tests** |
| **Total** | — | **351** | **396** (exit 0) |

New harnesses (reusable, no production impact):

- `test/helpers/chrome-stub.js` — recording `chrome` with real storage/DNR state.
- `test/helpers/panel-harness.js` — boots the **shipped** `sidepanel.html` and every
  shipped `<script>` in declaration order in jsdom. `jsdom` is a devDependency; it
  never enters the extension bundle.

What this buys: the panel now boots in CI with zero console errors, and the
palette / voice / council / routines / share wiring is exercised the way a user
drives it (real key events, real DOM, real message flow).

---

## Findings fixed

### High

**H1 — Destructive routine replay was unconfirmed.** `isDestructiveStep()` was
computed and rendered as a ⚠ but **nothing consulted it**: `/routine run` and the
agent-callable `routine_run` tool would replay a recorded Delete/Pay/Submit click
immediately. README claimed otherwise.
→ `runRoutine` now refuses when any step is destructive, lists the offending
steps, and requires `/routine run <name> --confirm` or `routine_run {confirm:true}`.
Tests: *"a destructive routine is refused until explicitly confirmed"*.

**H2 — Cross-origin intercept redirects were a silent exfiltration path.** DNR
rules are browser-wide and persist across restarts; a *precise* filter redirecting
to a different host can forward the original request's `Authorization`/`Cookie`
headers, and it needed no confirmation (only match-everything filters did).
→ `net_rule_redirect` now derives the filter's host and refuses a different target
host unless `confirmCrossOrigin: true`, with an error naming the risk.
Tests: *"a cross-origin intercept redirect is refused without explicit consent"*
(refused, confirmed-allowed, and same-host-allowed paths).

### Medium

**M1 — Second dictation inherited the first transcript.** `speechState` was never
reset, so the previous session's `finalText` was prepended.
→ reset on `startSpeech`; also added a monotonic token so events from a superseded
recognition are ignored (fixes L3 at the same time).

**M2 — Dictation overwrote text already in the composer.** `composerPristine` was
initialised to `''` and never captured.
→ captured at dictation start; dictation now appends.

**M3 — A share export was not inert.** `renderMarkdown` output was embedded
verbatim, and the bundled `marked` emits live `javascript:` hrefs — an export
opened by someone else could run script on click.
→ two layers: `sanitiseHtml()` strips script/iframe/object/embed/link/meta/form,
inline `on*` handlers and `javascript:`/`vbscript:`/`data:text/html` URLs from
renderer output; and the exported document now carries a CSP
(`default-src 'none'; img-src data:; style-src 'unsafe-inline'`), so a future
escaping bug stays inert.

**M4 — Wrapped credentials leaked their tail.** A key split across a line was
redacted on the first fragment only.
→ a line-wrapped pass now runs *before* the per-line patterns (order matters: they
were eating the prefix first). Prose such as `sk-learn` is unaffected.

### Low / hygiene

- **L1** `recordSpend(null)` threw after the money was spent → guarded.
- **L2** async palette actions could produce unhandled rejections → caught.
- **L3** stale recognition `onend` could null a newer session → token guard.
- **L4** dictation wrote the composer without an `input` event (autosize, slash
  palette, draft state never saw it) → dispatched.
- **L7** docs: permissions section listed `webNavigation` (unused) and omitted nine
  real permissions; tool-count claims corrected to 151.

### Found by the new tests (not by the reviewer)

- **4 dead permission grants removed** — `webNavigation` (required), and
  `clipboardRead`, `management`, `topSites` (optional, nothing ever requested
  them). Dead grants are install-warning budget spent on nothing.
- **`cookies_set` / `cookies_remove` returned the raw API result** (which is
  `undefined` on success) and did no validation. Now validated, returning a stable
  object.
- **`tab_close` called `chrome.tabs.remove(undefined)`** — throws in a real
  browser, killing the turn. Now validated.
- **`memory_add` persisted an empty memory** with no content — storage garbage that
  resurfaces in every future session. Now refused.
- **`cron_add` / `cron_remove` forwarded `undefined`** to the service worker.
- **Capture state hydration race (background.js)** — `hydrateCaptureState()` was
  fire-and-forget, so the first capture call after a service-worker restart could
  report `capturing:false` for a live capture. Capture handlers now `await` it.
  Pinned by a simulated SW-restart test.
- **Dead `els.pinSessionBtn` reference** to an element that does not exist.

---

## Not fixed — deliberate, with reasons

| Item | Why not now |
|---|---|
| **M5** replay never checks it is still on the recorded page (`rec.url` unused) | The right fix is a *policy* question (hard-fail vs warn-and-continue) that changes behaviour users may rely on. Documented; needs a decision, not a patch. |
| **M6** navigation splitting only recognises explicit `navigate` steps | A click that navigates aborts the rest of the chunk and is *reported* as a failed step, so it fails loudly rather than silently. Proper fix needs re-injection with resume semantics. |
| **M7** council has no abort/busy guard; spend recorded after the barrier | Correct fix is threading an `AbortController` through `oneShotCompletion` — a real feature, not a patch. |
| **L5** `site_data_clear` accepts `__proto__` as a data kind | No destructive escalation (it can only clear more broadly), and the object-literal keys need guarding in a shared helper. |
| **L6** omnibox suggestion embeds raw user text | Requires confirming Chrome's parser behaviour for the description field; low impact. |
| **L9** one chat message per speech error event | Cosmetic; needs a dedupe/duration policy. |
| **S1–S3** | Suspected only, and each depends on real browser Web-Speech behaviour. |

## Not verifiable here (needs a real browser)

Web Speech re-delivery and cancel-then-speak timing; `executeScript` behaviour when
a frame navigates mid-chunk; DNR header forwarding on cross-origin redirects;
whether the panel CSP blocks exported `javascript:` links; real platform-API
availability and messages (`debugger`, `pageCapture`, `browsingData`, `identity`);
tab-id reuse. These are listed rather than silently assumed.

---

## How to run

```bash
cd kyoto && bash test/run.sh          # 396 tests, ~32s
node test/panel-boot.test.js          # the panel-in-jsdom suite alone
node test/audit.test.js               # manifest / script-graph / DOM / secret audit
```

`test/audit.test.js` is the load-bearing one for maintenance: it fails if a
permission is declared but unused, a `chrome.*` namespace is used but undeclared, a
`<script>` is missing or misordered, a `$('id')` has no matching element, or a
credential is committed.
