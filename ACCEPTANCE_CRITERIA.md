# Acceptance Criteria (pre-registered)

Registered **2026-11-09, before any implementation code was written.**
The criteria below are frozen. If implementation forces a change, the original text stays and the change is logged under *Amendments* at the bottom with a justification.

Each criterion maps to the project requirements (R-xx, B-xx) listed first, and names how it will be verified:
**U** = automated unit test, **E** = automated end-to-end test in a real Chromium with the extension loaded, **M** = manual scenario (see `MANUAL_TEST_SCENARIOS.md`), **R** = code/document review.

## Requirements

| ID | Requirement |
|---|---|
| R-01 | Chrome MV3 extension; content script + background service worker; loadable unpacked via `chrome://extensions` |
| R-02 | Detects when the active tab displays a scam "lock screen" delivered without navigating to an external, scannable URL |
| R-03 | Tells malicious use of the mechanism apart from legitimate use (e.g. in-browser file previews) |
| R-04 | Copes with pages that block the usual escapes (right-click, keyboard shortcuts, standard navigation) |
| R-05 | On detection, stops it: navigates away or otherwise ensures the user can leave |
| R-06 | Otherwise takes no action; the page behaves normally |
| R-07 | Works when the user arrives fresh **and** when the user is already on the malicious page when the extension is installed |
| R-08 | Does not affect the user's browsing performance |
| R-09 | Client-side only: no backend, telemetry or reporting |
| R-10 | JavaScript/TypeScript, standard WebExtension (MV3) APIs |
| R-11 | Short written note: how the attack is detected, why, known false-positive / false-negative risks |
| B-01 | Bonus: handle a further layer of trapping on top of the base technique |
| B-02 | Bonus: describe how detection would extend to related "no scannable URL" techniques |

## Criteria

### Packaging and platform

- **AC-01: Loads unpacked (R-01, R-10).** `extension/` is a Manifest V3 extension with a background service worker and content scripts, written in plain JavaScript with standard `chrome.*` APIs. It loads unpacked with no manifest errors and no errors logged by the service worker on startup. *Verify: E, M.*
- **AC-02: Minimal, local-only permissions (R-09).** The extension requests only what it uses (`scripting`, `webNavigation`, host access). It contains no remote code and makes no network requests (no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or remote script URLs). *Verify: R, E (no extension-initiated requests observed).*

### Detection: malicious cases (R-02, R-04)

- **AC-03: Fresh arrival, base sample.** Opening `malicious.html` over `http://localhost` results in the tab leaving the lock screen and showing the extension's warning page within **2 s** of the blob page committing. *Verify: E, M.*
- **AC-04: Not overfitted to the sample.** Lock-screen variants that change the wording, the impersonated vendor (e.g. Apple instead of Microsoft), omit the phone number, or block a different set of keys are still detected. *Verify: U (scoring), E (variant pages).*
- **AC-05: Late-rendered content.** A blob page that first renders a neutral placeholder and swaps in the lock screen later (1.5 s or more) is detected within **2 s** of the lock screen appearing. *Verify: E.*
- **AC-06: Arrival-independent.** An attacker who mimics the benign arrival pattern (opening the blob in a new tab after a user click, or launching it through a script-clicked `<a>` link) is still detected when lock-screen content and trapping behaviour are both present. *Verify: E.*

### Response (R-04, R-05)

- **AC-07: Escape blocking does not stop the response.** The response succeeds even though the page blocks right-click, keyboard shortcuts and registers `beforeunload`. No "Leave site?" dialog is shown during the extension's navigation, **including when the user has already clicked or typed on the page** (sticky activation). *Verify: E, M.*
- **AC-08: The user can actually leave.** After the response the tab shows an extension-owned warning page that offers a way out (new tab / close tab). The tab is muted. Pressing Back does not put the user back into a live, trapping lock screen. *Verify: E, M.*
- **AC-09: Explainable.** The warning page lists the human-readable reasons for the decision and the origin of the site that generated the blob. *Verify: E, M.*

### Legitimate use (R-03, R-06)

- **AC-10: Benign sample untouched.** In `benign.html`, clicking "View Generated Report" opens the blob report in a new tab. It is still displayed, on its `blob:` URL, unmodified, **5 s** later. The extension shows no warning page, does not mute the tab and shows no dialogs. *Verify: E, M.*
- **AC-11: Benign variants of the same mechanism untouched.** All of the following stay unaffected for at least 5 s, with no warning page and no muting:
  - a blob preview opened in the **same tab** after a click;
  - a blob-hosted editor that registers `beforeunload` and intercepts `Ctrl+S`;
  - a blob page that legitimately shows a support phone number but does not trap the user;
  - a blob full-screen viewer (slideshow) with neutral content that handles `Escape`;
  - a PDF and an image opened as blob previews.

  *Verify: E, M.*

### Lifecycle (R-07)

- **AC-12: Already on the page at install.** If the malicious blob page is already open when the extension is installed (or reloaded/updated), it is detected and stopped within **3 s** of installation. A benign blob page that is open at install time is left untouched. *Verify: E, M.*

### Performance (R-08)

- **AC-13: No work on normal pages.** On non-`blob:` pages the content scripts exit after a single protocol check. They do not patch prototypes, register no listeners, read no DOM and send no messages. The service worker's navigation listeners are filtered to `blob:` URLs, so ordinary navigations do not wake it. *Verify: E (native `addEventListener` intact and no extension globals on an http page), R, U (gate function).*

### Bonus

- **AC-14: Further trapping layer: fullscreen + Keyboard Lock (B-01).** A blob lock screen that enters fullscreen and calls `navigator.keyboard.lock()` on the user's first click is detected. After the response, the window is no longer in HTML fullscreen and the keyboard is no longer locked. *Verify: E, M.*
- **AC-15: Additional trap signals (B-01).** History flooding (`pushState` bursts), dialog loops (`alert`/`confirm`/`prompt` bursts) and pointer lock are recorded as trapping signals and feed the decision. *Verify: U; E for the history-flood variant.*
- **AC-16: Related techniques described (B-02).** The README describes how detection extends to related "no scannable URL" techniques. *Verify: R.*

### Quality and documentation

- **AC-17: Unit tests.** All pure logic (text/content scoring, phone-number detection, the decision rule including false-positive and false-negative boundary cases, the protocol gate and blob-origin parsing) is covered by unit tests that pass with `npm test`. *Verify: U.*
- **AC-18: Written note and manual scenarios (R-11).** The README explains how the attack is detected, why that approach was chosen, and its known false-positive and false-negative risks. `MANUAL_TEST_SCENARIOS.md` lists manual scenarios that together cover every requirement R-01 to R-11 and B-01 to B-02, with a traceability table. *Verify: R.*

## Out of scope (stated up front)

- Deceptive content that is **not** a top-level `blob:` document: full-viewport iframes or overlays on normal `https:` pages, and `data:`/`srcdoc` iframes. These are described for B-02 but not implemented.
- Text rendered into canvas, images or video, and non-English lock screens. Both are known false negatives.
- Browsers other than Chromium-based ones.
- Samples opened from `file://`. These produce opaque `blob:null` URLs, so manual testing uses a local HTTP server.

## Amendments

The criteria text above was not edited after registration. These notes record where implementation clarified a criterion or its verification scope.

- **A-1 (AC-08): stuck pages.** Testing showed that when a page keeps re-opening `alert()` dialogs, its renderer never yields and an in-place navigation cannot commit. For such pages (a detected dialog loop, or the warning page not loading within 1.5 s), the trapped tab is **closed and the warning page opens in a new tab at the same position**. "The tab is muted" applies to the in-place path. In the replacement path the trapped tab no longer exists, and the Back requirement holds trivially.
- **A-2 (AC-12): verification scope.** Install is verified end-to-end. Reload/update use the same `runtime.onInstalled` code path, but there is no reachable manual flow for them: with the extension active, the page is blocked before a reload could matter. So they are covered by code review only. **Re-enabling a disabled extension does not fire `onInstalled`** and is not covered; this is a known gap, documented in the README.
- **A-4 (AC-01/AC-02): override implementation.**
  - The minimum Chrome version rose from 111 to **119**, because `matchOriginAsFallback` for runtime-registered content scripts needs it. AC-01 does not name a version; the README and manual setup were updated.
  - AC-19 needed **no new permission**: the session allow-list is a runtime-registered content script, not `chrome.storage`. AC-02 holds unchanged.
- **A-5 (AC-16, AC-18): where the note lives.** The written note and the short answer on related techniques were moved out of the README into their own document, `NOTE.md`, which the README links to. Each is a few sentences, as the requirement asks. The README keeps the longer list under *Further techniques*.
- **A-6 (all): editorial pass.** On 2026-11-09 every document went through a de-AI style check. Typography (dashes, arrows, comparison signs), some wording and the reopen button's label ("I trust this site. Reopen the page") changed. No criterion changed in meaning.
- **A-3 (AC-14): "keyboard no longer locked".** Verified indirectly. The locking document is replaced, which releases Keyboard Lock. The e2e test checks the window state and `document.fullscreenElement`; manual scenario M-10 checks that Ctrl/Cmd+L reaches the browser.

## Criteria added later (registered before their implementation)

### Registered 2026-11-09: a false-positive override

- **AC-19: Override to recover from a false positive.**
  1. The warning page offers a *low-prominence* action, inside a collapsed "Details" section, to reopen the page: "I trust this site. Reopen the page (not recommended)". It is offered only when the generating origin is known (not for `blob:null`).
  2. Using it allows **that exact origin** (scheme, host and port) **for the current browser session only**. Nothing is kept across browser restarts, and no new permission is requested. The tab then reopens the launcher page, or the blob page itself when the launcher is unknown.
  3. On an allowed origin, the page is displayed and not blocked, but it stays **defanged**:
     - its "Leave site?" prompt is suppressed;
     - `navigator.keyboard.lock()` does nothing;
     - `alert()` loops are still rescued, because a frozen page cannot be defanged.
  4. Pages from other origins are still blocked.

  *Verify: U (origin/target helpers), E (block, then reopen: page displayed and defanged, other origin still blocked, dialog loop still rescued), M.*

## Verification results (2026-11-09)

Environment: macOS, Node 20.20.2, Chrome for Testing 156.0.8078.47 (Puppeteer 25.16.0). `npm test`: **60/60 unit tests pass**. `npm run test:e2e`: **29/29 e2e tests pass**, including the AC-19 suite (3 consecutive full runs after it was added). One full e2e run had a single intermittent failure in the "alert loop, instant dismissal" test. Its cause was not identified; the test was then hardened (it ignores leftover warning tabs and prints diagnostics). Since that failure, the test passed in 17 further runs (4 alone, 13 with its file) and in 9 consecutive full e2e runs. The last 2 of those used the final 24-test suite.

| AC | Status | Evidence |
|---|---|---|
| AC-01 | Met | e2e `platform`: MV3 worker starts, no console errors/warnings · unit `manifest` · M-01 |
| AC-02 | Met | unit `manifest`: no network/eval/remote URLs in the code · e2e `platform`: no requests from the worker or caused in pages · M-02 |
| AC-03 | Met | e2e `malicious` AC-03/AC-09. Measured from blob commit to warning page: **median 19 ms, max 48 ms** (10 runs; budget 2 s) |
| AC-04 | Met | unit: Apple, Defender, browser-locked and obfuscated variants · e2e: `mal-apple-no-phone` (no phone, legacy keyCode trapping) |
| AC-05 | Met | e2e `mal-delayed`: not blocked while only the placeholder shows; blocked within 2 s after the lock screen appears |
| AC-06 | Met | e2e `mal-new-tab-click` (new tab after a click) and `mal-anchor-click` (script-clicked link) |
| AC-07 | Met | e2e `mal-delayed` after a user click and key press: no dialog · e2e install test after a user click: no dialog. Measured: *without* disarming, `tabs.update` does raise "Leave site?" |
| AC-08 | Met (A-1) | e2e: tab muted; Back shows no live lock screen; "Open a new tab" leaves and unmutes; "Close this tab" closes; a second scam in the same tab is blocked too |
| AC-09 | Met | e2e: warning page shows the generating origin and at least 4 reasons, including the phone number and blocked keys |
| AC-10 | Met | e2e `benign.html`: report stays on its blob URL for 5 s, content intact, no dialogs, no muting, no block |
| AC-11 | Met | e2e: same-tab preview, editor (its own "Leave site?" still works), receipt with support number, security report, scam-awareness handout, full-screen slideshow, PDF and PNG previews. All untouched for 5 s |
| AC-12 | Met for install (A-2) | e2e install test: rescued **~105 ms** after install (3 runs; budget 3 s), no dialog despite prior user activation, open benign report untouched |
| AC-13 | Met | unit `gate` (VM): zero browser-API access on non-blob pages and blob sub-frames · e2e: native functions intact on http pages, zero reports from them · the worker's `webNavigation` listeners are URL-filtered to `blob:` (code review; M-13 checks the worker stays inactive) |
| AC-14 | Met (A-3) | e2e `mal-fullscreen-keylock`: not blocked before trapping, blocked on the full-screen request, window not left in full screen |
| AC-15 | Met | unit: dialog/history/pointer-lock/pop-up thresholds · e2e: history flood (verdict names `history-flood`); alert loop at human speed (at most 2 dialogs) and at machine speed (stuck tab replaced) |
| AC-16 | Met | `NOTE.md`, section *Extending to related techniques* (short answer) · README, *Further techniques* (long list) |
| AC-17 | Met | `npm test`: 49 tests covering scoring, phone detection, decision boundaries (both false-positive and false-negative sides), gate, URL helpers |
| AC-18 | Met (A-5) | `NOTE.md` (linked from the README) · `MANUAL_TEST_SCENARIOS.md` with traceability for R-01 to R-11 and B-01 to B-02 |
| AC-19 | Met (A-4) | unit: exact-origin pattern (port, host, scheme), reopen-target validation (same-origin launcher only, blob fallback, `blob:null` refused) · e2e `override`: collapsed Details; reopen reloads the launcher and the page stays; page-world sensor reports `defanged`; no "Leave site?" after interaction; registration is `persistAcrossSessions: false` and `<origin>/*` only; the same scam from `localhost` is still blocked; an alert loop on the allowed origin is still rescued; the new-tab pattern reopens the blob URL. Keyboard Lock's effect in real full screen is manual only (headless Chrome does not enter full screen): M-15 step 6 |

*Pre-registration note:* the criteria were written before the implementation, but the git history starts after it. The registration times in this file are therefore self-attested.
