# Lock-Screen Scam Guard

A Chrome (Manifest V3) extension that detects fake "your computer has been locked" tech-support-scam pages that are generated inside the browser as `blob:` documents, and gets the user out of them. Legitimate uses of the same mechanism, such as report, PDF and image previews, editors and slideshows, are left alone.

- **Load it:** open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked* and select the `extension/` folder.
- **Try it:** `npm run serve`, then open <http://127.0.0.1:8080/test-pages/> (an index of every malicious and benign scenario). Serve over HTTP: when pages are opened from `file://`, their blob URLs get an opaque `blob:null` origin.
- **Test it:** `npm install`, then `npm test` (60 unit tests, under 0.1 s) and `npm run test:e2e` (29 tests in real Chromium with the extension loaded, about 80 s). Measured: blocked a median of **19 ms** after the blob page commits, and rescued about **105 ms** after install.
- **Written note:** [`NOTE.md`](NOTE.md).
- **Acceptance:** criteria were pre-registered in [`ACCEPTANCE_CRITERIA.md`](ACCEPTANCE_CRITERIA.md), with results at the bottom. Manual steps are in [`MANUAL_TEST_SCENARIOS.md`](MANUAL_TEST_SCENARIOS.md).

---

## Written note

[`NOTE.md`](NOTE.md) is the short version. It covers how the attack is detected, why this approach, its known false-positive and false-negative risks, and how detection would extend to related techniques that show deceptive content without a normal, scannable URL. The full reasoning follows below, and the longer list of related techniques is in *Further techniques*.

---

## Detection in detail

**How the attack is detected.** The page builds HTML in JavaScript, wraps it in a `Blob` and navigates to the `blob:` URL. The content never lives at a scannable address, so URL reputation can't help, and the extension has to judge the rendered page. Only **top-level `blob:` documents** are inspected. Every other page is skipped after a single protocol check. Inside a blob document, three independent groups of signals are collected:

1. **Content.** Does it read like a lock screen? Signals are lock wording ("computer has been locked", "do not restart"), scareware wording, a push to call "support", a phone number, an impersonated vendor, a fake error code and an alarming title. Text is normalised first (Unicode NFKC, invisible characters stripped, Cyrillic/Greek look-alikes mapped), so simple keyword obfuscation does not work.
2. **Trapping.** Does the page try to stop the user leaving? Hooks installed before any page script record `beforeunload`, full screen, Keyboard Lock, pointer lock, dialog bursts and history floods. Synthetic, cancelable probe events check whether the page cancels Esc, F5, F11, F12, Ctrl/Cmd+R/L/W, Alt+F4 or right-click. A *real* escape attempt that the page cancels is the strongest signal of all.
3. **Arrival.** Did the page open itself? A self-replacing navigation during load means there was no user gesture (the HTML spec turns it into a history *replace*), and `webNavigation` reports a `client_redirect`. A blob opened into a new tab after a click looks like the benign sample.

The decision lives in one pure, unit-tested function. It blocks when **content of at least 5 and traps of at least 2**, or when a **strong trap** (full screen, Keyboard Lock, dialog loop, history flood, cancelled real escape) coincides with **content of at least 4** that includes lock or threat wording. Content alone is enough only for a blatant lock screen (a score of 8 or more, with lock wording) that **opened itself**, and only after the trap probes have run. A blob document is never blocked just for being a blob, and arrival never decides on its own.

**Why this approach.** It is a scaled-down version of what browsers ship. Chrome 137 runs its on-device scam model only after cheap triggers such as the Keyboard Lock API. Edge's Scareware Blocker activates when a page goes full screen. Both pair a cheap behavioural trigger with a content check. Requiring *both* scam content *and* trapping behaviour is what separates the attack from legitimate blob use. An editor has `beforeunload` but harmless text. A security report or a scam-awareness handout has scary text but no traps. A slideshow goes full screen but shows neutral content.

**Known false-positive risks**
- A blob document that combines lock-screen wording with key blocking, for example a kiosk or exam app whose own text says "this device is locked".
- A self-opened blob page that quotes a lock screen verbatim. (The same handout opened by a click is tested and *not* blocked.)
- Probes are synthetic key and right-click events. They are sent only to pages whose content already scores as suspicious, but they do run that page's handlers.
- **Recourse:** the warning page has a collapsed *Details* section with "I trust this site. Reopen the page (not recommended)".
  - It allows that exact origin for the browser session only.
  - It reopens the page in a **defanged** mode: shown, but unable to raise "Leave site?" or lock the keyboard, and still rescued from `alert()` loops.
  - It needs no extra permission (see *How it works*).

**Known false-negative risks**
- Lock screens drawn on a canvas, in an image or in a video, so there is no DOM text.
- Non-English lock screens. The vocabulary is English-only.
- Scams that are not top-level `blob:` documents: full-viewport `data:`/`srcdoc`/blob iframes or overlays on ordinary `https:` pages.
- A page that deliberately defeats the instrumentation, for example by taking pristine functions from a fresh iframe, ignoring untrusted events (`isTrusted`), or delaying its traps and content past the user's patience. The isolated-world observers (real cancelled escape attempts, `fullscreenchange`) are harder to dodge than the page-world hooks.
- Re-enabling a *disabled* extension does not fire `runtime.onInstalled`, so a tab trapped while the extension was off is not swept. Installing and updating are covered.

---

## How it works

```
 blob: document (top frame only)                          service worker
┌──────────────────────────────────────────────┐        ┌─────────────────────────────┐
│ MAIN world  content/main-world.js            │        │ background.js               │
│  • hooks (document_start, before page code): │        │  • webNavigation, filtered  │
│    addEventListener, fullscreen, keyboard    │        │    to blob: (arrival)       │
│    lock, pointer lock, alert…, pushState     │        │  • lib/detector.js          │
│  • probes: synthetic Esc/F5/…/right-click    │ report │    evaluate() → verdict     │
│  • disarm: kill beforeunload, exit full      │───────▶│  • block:                   │
│    screen / keyboard / pointer lock          │◀───────│     disarm → mute →         │
│        ▲ DOM events ▼                        │probe / │     navigate to warning     │
│ ISOLATED world  content/isolated.js          │ block  │     page, or replace the    │
│  • visible-text snapshot, late-content       │        │     tab if it is stuck      │
│    MutationObserver                          │        │  • onInstalled: sweep       │
│  • real cancelled escapes, fullscreenchange  │        │    already-open tabs        │
└──────────────────────────────────────────────┘        └─────────────────────────────┘
```

- **Gate (performance).** Both content scripts are declared at `document_start` with `match_origin_as_fallback`, which is required to run inside `blob:` documents. Their first statement returns unless the document is a top-level `blob:`. On normal pages nothing is patched, read, observed or sent, and the service worker's navigation listeners are URL-filtered to `blob:`, so ordinary browsing never wakes it. Both properties are covered by tests: a VM-based unit test and an e2e test that checks native functions on http pages.
- **Two-step evaluation.** The first report carries content plus hook data. If the content is suspicious (a score of 3 or more), the worker asks the page to **probe**, and a second report carries the probe results. Neutral blob documents are never probed. Late-rendered content is re-checked through a throttled `MutationObserver`, at most one report per 250 ms, and only when the text changes.
- **Response.** The page disarms itself: `beforeunload` handlers are neutralised, full screen, keyboard lock and pointer lock are released, dialogs and `pushState` become no-ops, media is muted and the DOM is wiped. The tab is then muted and navigated to the bundled warning page, which shows the reasons and the **origin that generated the blob**, the one scannable clue the attack leaves. The worker never uses `history.back()`, because the launcher either replaced itself or would redirect again. If the warning page has not loaded within 1.5 s (the page never yields, e.g. an `alert()` loop), the trapped tab is closed and the warning opens in a new tab at the same position.
- **False-positive override.**
  - Choosing *reopen* under *Details* sends `blg:proceed` from the warning page. The worker accepts it only from that page and re-derives the origin and target from the blob URL.
  - **The allow-list is a dynamically registered content script**: `content/allow-defang.js`, page world, `document_start`, `matchOriginAsFallback`, `persistAcrossSessions: false`, matching `<origin>/*`. That makes it session-only by construction, runs it before the page's own code, and needs only the existing `scripting` permission.
  - It switches the page-world sensor into *defanged* mode: `beforeunload` is suppressed, `navigator.keyboard.lock()` becomes a no-op, and full screen is still allowed for legitimate slides and kiosks.
  - Reports from allowed origins are not blocked and never probed, except when a dialog loop has frozen the page.
  - The tab reopens the launcher page (taken from `navigation.activation.from`, same origin only), or the blob URL if the launcher is still open in another tab.
- **Already on the page at install.** `runtime.onInstalled` sweeps open tabs. A tiny injected check skips tabs that are not `blob:` and tabs that are already instrumented; the rest get both scripts. Listener registrations made before injection can't be seen, but the probes find the trapping behaviour anyway.
- **Hardening.** The isolated script merges page-world signals monotonically, so a page that forges the internal event can only *add* evidence. The single-instance guard lives in the isolated world, where the page can't reach it. The warning page renders page-derived text with `textContent` only.

## Further trapping layers (implemented)

| Layer | Why it matters | Handling |
|---|---|---|
| **Full screen + Keyboard Lock** | In full screen Chrome passes *all* shortcuts except exit-fullscreen to the page, so Ctrl+W and Ctrl+T reach the page (Chromium `IsReservedCommandOrKey`). Keyboard Lock turns Esc into press-and-hold. The planned permission prompt was cancelled ("We have decided not to launch the Keyboard Lock and Pointer Lock permissions"). | Hooked. A strong signal, the same trigger Chrome uses. The response exits full screen and keyboard lock, and resets the window if needed. |
| **`alert()` loops** | They block the page's event loop, including the content script inside it. | Each dialog call is reported synchronously. On a loop the worker replaces the tab immediately. The user dismisses at most one dialog. |
| **History flooding** | Breaks Back. | `pushState` bursts are a strong signal, and `pushState` is a no-op after disarming. |
| **Pointer lock, pop-up floods, audio** | Disorientation and pressure. | Recorded as signals. The tab is muted on block. |
| **`beforeunload` after user interaction** | Measured: `tabs.update` *does* raise "Leave site?" once the page has had user activation. | Disarmed before navigating. Verified with prior clicks, both for fresh pages and after install. |

## Further techniques: related "no scannable URL" attacks (described)

1. **Same trick, different container.** `data:`, `srcdoc`, `blob:` or `about:blank` + `document.write` iframes stretched over an ordinary page, and `about:blank` pop-ups filled by script. Extend the content scripts to `all_frames` (with `match_origin_as_fallback`/`match_about_blank`) and score each frame with the same detector, weighted by *visual dominance*: the share of the viewport it covers, fixed positioning, z-index. Respond by removing the frame or navigating the top document.
2. **No special URL at all.** Full-viewport overlays on a compromised or legitimate-looking `https:` page, and content synthesised by a service worker or cloaked from scanners, where the URL is scannable but the scanner sees something else. Stop gating on the URL scheme and gate on **behaviour** instead: full screen, Keyboard Lock, dialog bursts and cancelled real escapes are cheap to observe everywhere (`fullscreenchange` and trusted key events can be seen from the isolated world for almost nothing). Run content scoring only after such a trigger fires. That is the Chrome/Edge pattern.
3. **Text the DOM does not contain.** Fake blue screens rendered as images, canvas or video, CSS-generated text, icon fonts. After a trigger, take `chrome.tabs.captureVisibleTab` and classify it on-device with bundled WASM OCR, a small image model (Edge's approach), or Chrome's built-in AI where available. Read closed shadow roots with `chrome.dom.openOrClosedShadowRoot`.
4. **Other carriers.** Document Picture-in-Picture windows, which are always on top (hook `documentPictureInPicture.requestWindow` and inspect the PiP document); browser-in-the-browser fake windows (visual dominance plus content); "ClickFix" fake CAPTCHAs that write shell commands to the clipboard (watch `navigator.clipboard.writeText` on suspicious pages).
5. **Language coverage.** Localised vocabularies, or an on-device language model for intent, as Chrome does with Gemini Nano.
6. **Feedback loop.** The blob's creator origin *is* scannable. With a backend (out of scope here), report it to URL reputation so the launcher gets blocked at the source.

## What I measured before building

A throwaway extension was run in Chrome for Testing 156 (Puppeteer) to settle behaviour that is undocumented or disputed:

| Question | Result |
|---|---|
| Does a MAIN-world `document_start` script run before a top-level blob page's inline script? | Yes. It sees the page register its `contextmenu`, `keydown` and `beforeunload` listeners. |
| Can `scripting.executeScript` reach a blob tab that was open before install? | Yes, both worlds. That is why the install sweep works. |
| Does `tabs.update` trigger the page's "Leave site?" prompt? | **Yes**, once the page has user activation, unless it is disarmed first. |
| `webNavigation` for the two samples | Malicious: `link` + `client_redirect`. Benign: `onCreatedNavigationTarget` + `link`, no qualifiers. |
| Back after leaving | `chrome-error`: the blob URL dies with the launcher document. |
| Can a stuck `alert()` loop be escaped? | A navigation never commits, but `tabs.remove` works (38 ms). That led to the tab-replacement fallback. |
| Blob tab URLs without the `tabs` permission? | Not readable, so the install sweep asks each tab instead. |

Two points on which published sources disagree were checked against primary sources: the Keyboard Lock permission prompt was cancelled, and full screen delivers browser shortcuts to the page.

## Tests

| Suite | What it covers |
|---|---|
| `tests/unit/detector.test.js` | Content scoring on the real sample text and variants: wording, vendor, missing phone number, obfuscation. Phone-number false positives (hex codes, dates, IDs). Trap scoring and thresholds. Arrival. Decision boundaries, including false-positive and false-negative edge cases. URL helpers, and the override's origin pattern and reopen-target validation. |
| `tests/unit/gate.test.js` | Runs both content scripts in a VM where every browser API access is recorded. Zero access on non-blob pages and blob sub-frames, with a blob positive control. |
| `tests/unit/manifest.test.js` | MV3 shape, minimal permissions, referenced files exist, no network APIs, `eval` or remote URLs, no `innerHTML` on the warning page. |
| `tests/e2e/*.test.js` | Real Chromium plus the unpacked extension: every malicious and benign page, timings (within 2 s), dialogs, muting, Back, warning page buttons, install-while-trapped, full screen and Keyboard Lock, history flood, alert loops at human and machine speed, native functions intact on http pages, no network requests. |
| `tests/e2e/override.test.js` | *Reopen* flow: launcher reloaded, page shown and defanged (no "Leave site?" after interaction), session-only exact-origin registration, other origins still blocked, dialog loops still rescued, new-tab pattern reopens the blob. |

## Project layout

```
extension/            the unpacked extension
  manifest.json
  background.js       service worker: arrival tracking, decisions, response, install sweep
  lib/detector.js     pure detection logic (shared by the worker and the unit tests)
  content/main-world.js   page-world hooks, probes, disarm
  content/isolated.js     isolated-world snapshot, observers, relay
  content/allow-defang.js registered at runtime for origins the user chose to trust
  pages/blocked.*     warning page
test-pages/           malicious and benign variants, plus an index page
malicious.html, benign.html   reference samples: the attack and a legitimate use
tests/                unit, e2e, support (static server, Puppeteer harness, fixtures)
tools/make-icons.js   regenerates the icons
```

## References

- Google: on-device Gemini Nano against tech-support scams in Chrome 137, triggered by signals such as the Keyboard Lock API. <https://blog.google/security/using-ai-to-stop-tech-support-scams-in/>
- Microsoft Edge Scareware Blocker: full-screen trigger plus a local vision model. <https://blogs.windows.com/msedgedev/2025/01/27/stand-up-to-scareware-with-scareware-blocker/>
- Miramirkhani et al., *Dial One for Scam: A Large-Scale Analysis of Technical Support Scams*, NDSS 2017. <https://arxiv.org/abs/1607.06891>
- Chrome extensions: content scripts and `match_origin_as_fallback`. <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- Keyboard Lock / Pointer Lock permission prompt, cancelled before launch. <https://developer.chrome.com/blog/keyboard-lock-pointer-lock-permission>
- Chromium `browser_command_controller.cc`: shortcuts delivered to full-screen pages. <https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/browser_command_controller.cc>
- Chrome 60: top-level `data:` navigations blocked (blob URLs are not). <https://developer.chrome.com/blog/chrome-60-deprecations/>
