# Manual acceptance test scenarios

These scenarios together cover every requirement (R-01 to R-11), both bonus items (B-01, B-02) and the false-positive override added later (AC-19). See the traceability table at the end. Criterion IDs (AC-xx) refer to [`ACCEPTANCE_CRITERIA.md`](ACCEPTANCE_CRITERIA.md). Most scenarios are also automated in `tests/e2e/`; doing them by hand checks the real, headed browser experience.

## Setup

1. **Browser.** Desktop Google Chrome (or Chromium/Edge) 119 or later. Results were verified on Chrome for Testing 156.
2. **Serve the pages** from the project root with `npm run serve`, which serves at `http://127.0.0.1:8080`. Alternatively, run `python3 -m http.server 8080 --bind 127.0.0.1`.
   *Do not open the pages from `file://`: blob URLs then get an opaque `blob:null` origin, which is out of scope.*
3. **Load the extension:** open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked* and select `extension/`.
4. **Test index:** <http://127.0.0.1:8080/test-pages/>.
5. Unless a step says otherwise, start each scenario in a new tab. "Warning page" means the extension page titled *"Scam page blocked"* with the heading *"Your computer is not locked"*.

---

## Packaging and platform

### M-01: Extension loads unpacked (R-01, R-10, AC-01)
1. Load `extension/` as in Setup step 3.
2. On the extension card, click *service worker* to open its DevTools.

Expected:
- The card shows "Lock-Screen Scam Guard 1.0.0" with no *Errors* button.
- The service worker console is empty.
- `extension/manifest.json` requests only `scripting`, `webNavigation` and host access `<all_urls>`. Chrome's *Details* page shows the matching warnings: site access to all sites, and browsing-history access from `webNavigation`.

### M-02: No network traffic (R-09, AC-02)
1. Keep the service worker DevTools from M-01 open on the **Network** tab.
2. Run M-03 and M-07.

Expected:
- The worker makes no requests.
- On the scam and benign pages, every request goes to `127.0.0.1:8080`, to `blob:`, or to the extension's own files (`chrome-extension://…`).

---

## Malicious pages are stopped

### M-03: Reference malicious sample, fresh arrival (R-02, R-04, R-05, R-07 "fresh", AC-03, AC-09)
1. Open <http://127.0.0.1:8080/malicious.html>.

Expected:
- Within about 1 s (2 s at most), the blue "Your computer has been locked" screen is replaced by the warning page.
- The warning page names the generating site `http://127.0.0.1:8080` and lists the reasons, including the phone number `1-800-555-0199`, "Blocks escape keys: Esc, F5, F11, F12, Ctrl+R, Ctrl+L, Ctrl+W", "Blocks right-click" and the "Leave site?" attempt.
- The tab strip shows the tab as muted.
- No "Leave site?" dialog appears.

### M-04: Getting out and staying out (R-05, AC-08)
1. On the warning page from M-03, press the browser's **Back** button (or Alt+Left arrow / Cmd+[).
2. Repeat M-03, then click **Open a new tab**.
3. Repeat M-03, then click **Close this tab**.

Expected:
1. You do not see a working lock screen. Chrome shows an error page for the dead blob URL, or the warning page again.
2. The New Tab page opens in the same tab and the mute icon disappears.
3. The tab closes.

### M-05: Escape-blocking after the user has interacted (R-04, AC-05, AC-07)
1. Open <http://127.0.0.1:8080/test-pages/mal-delayed.html>.
2. Within the first 2 s, while it still shows the "Loading your content" placeholder, click the page and press a key. This gives the page permission to show a "Leave site?" prompt.
3. Wait.

Expected:
- Nothing happens while only the placeholder is shown.
- About 2 s after load the Windows Defender lock screen flashes up and is replaced by the warning page within about 1 s (2 s at most).
- No "Leave site?" dialog appears, even though the page asked for one and was allowed to.

### M-06: Variants are not overfitted to the sample (R-02, AC-04, AC-06)
Open each page; expected result: the warning page.

| Page | Variation |
|---|---|
| `test-pages/mal-apple-no-phone.html` | Apple, *no phone number*, legacy `onkeydown`/`keyCode` trapping. Reasons include Cmd+R and no phone. |
| `test-pages/mal-new-tab-click.html`, then click **Play video** | Opens in a new tab after a click, the same arrival as the benign sample. The new tab is blocked. |
| `test-pages/mal-anchor-click.html` | Launched through a script-clicked `<a>`. |
| `test-pages/mal-no-traps.html` | No trapping code at all, but a blatant lock screen that opened itself. |

### M-07: Already on the page when the extension is installed or re-enabled (R-07 "installed", R-04, AC-12)
1. On `chrome://extensions`, **Remove** the extension.
2. Open <http://127.0.0.1:8080/benign.html>, click **View Generated Report**, and leave the report tab open.
3. In another tab, open <http://127.0.0.1:8080/malicious.html>. Observe that right-click does nothing and F5 does nothing. **Click on the page** (this allows a "Leave site?" prompt).
4. Install it again: *Load unpacked*, then select `extension/`.
5. Switch to the lock-screen tab.

Expected:
- Within 1 to 2 s of installing (3 s at most), the lock-screen tab shows the warning page, with no "Leave site?" dialog.
- The benign report tab is unchanged.

Then repeat with the on/off switch:

6. On `chrome://extensions`, switch the extension off.
7. Open <http://127.0.0.1:8080/malicious.html> in a new tab and click the page.
8. Switch the extension back on, then go back to the lock-screen tab.

Expected: the lock-screen tab shows the warning page within about 1 s of switching the extension on. Chrome does not fire `onInstalled` on enable; the start-up sweep handles it.

---

## Legitimate uses are untouched

For every page in this section, expected:
- the blob page stays open, working and unmodified for at least 5 s and while you interact with it;
- no warning page;
- no mute icon;
- no dialogs other than the page's own.

### M-08: Reference benign sample (R-03, R-06, AC-10)
1. Open <http://127.0.0.1:8080/benign.html> and click **View Generated Report**.
2. In the report tab, select text, right-click (the context menu opens), and press F5. The page reloads normally.

### M-09: Benign variants of the same mechanism (R-03, R-06, AC-11)

| Page and action | Extra checks |
|---|---|
| `test-pages/ben-same-tab-preview.html`, then **Preview quarterly export** | Opens in the *same* tab, as the attack does. Stays. |
| `test-pages/ben-editor.html`, then **Open scratchpad editor**; type text; press Ctrl/Cmd+S; press Esc | "Saved." appears and the tip hides. Then type again (unsaved) and close the tab: the editor's *own* "Leave site?" prompt still appears (choose *Cancel*). The extension did not neuter a legitimate page. |
| `test-pages/ben-support-receipt.html`, then **View receipt** | Shows "Microsoft 365" and a toll-free support number; no action. |
| `test-pages/ben-security-report.html`, then **Generate weekly security report** | Full of malware, suspicious activity, Microsoft Defender, an error code and a phone number; no action. |
| `test-pages/ben-scam-awareness.html`, then **Open module 3 handout** | Quotes a scam lock screen word for word, opened by you; no action. |
| `test-pages/ben-slideshow.html`, then **Open Q3 review deck**, then **Start presentation**; press the Right arrow, then Esc | Goes full screen, arrows change slides, Esc exits full screen; no action. |
| `test-pages/ben-file-previews.html`, then **Preview PDF invoice** and **Preview chart image** | The PDF opens in Chrome's viewer and the PNG displays; no action. |

---

## Bonus: further trapping layers (B-01)

### M-10: Full screen + Keyboard Lock (AC-14)
1. Open `test-pages/mal-fullscreen-keylock.html` and click **Open player**. The lock screen appears. It has not been blocked yet, because it hasn't trapped anything.
2. Click anywhere on the lock screen.

Expected:
- The page starts to go full screen and is immediately replaced by the warning page.
- The window is not left in full screen.
- Ctrl/Cmd+L focuses the address bar, which shows the keyboard isn't locked.
- The reasons include "Forces full screen to hide the browser".

*Optional demo of the threat:* disable the extension and repeat. In full screen, Ctrl+W/Ctrl+T go to the page, and Esc has to be held to exit.

### M-11: History flooding (AC-15)
1. Open `test-pages/mal-history-flood.html` and click **Continue**.

Expected: the warning page appears; the reasons include "Floods browser history to break the Back button".

### M-12: `alert()` loop (AC-15)
1. Open `test-pages/mal-alert-loop.html` and click **Continue**.
2. An alert appears. Click **OK** once.

Expected: when the second alert appears, the trapped tab is closed and the warning page opens in a new tab at the same position. No further dialogs appear.

---

## Performance (R-08, AC-13)

### M-13: Normal browsing is not touched
1. Browse a few ordinary sites: a news site, a web app, a search engine.
2. On any of them, open the DevTools Console and run `EventTarget.prototype.addEventListener.toString()`.
3. On `chrome://extensions`, wait until the extension card shows *service worker (Inactive)* (about 30 s after its last event). Then keep browsing normal sites and refresh `chrome://extensions`.

Expected:
- Step 2 prints `function addEventListener() { [native code] }`: nothing is hooked.
- Pages load and behave exactly as without the extension.
- The service worker stays Inactive during normal browsing; it only wakes for `blob:` navigations.
- *Contrast:* in a blob page (e.g. M-08's report tab), the same command shows a wrapped function, which is the instrumentation working where it should.

---

## Documentation (R-11, B-02)

### M-14: Written note and bonus write-up (R-11, B-02, AC-16, AC-18)
1. Read [`NOTE.md`](NOTE.md) and [`README.md`](README.md).

Expected:
- `NOTE.md` explains, in a few sentences, how the attack is detected, why that approach was chosen, and the known false-positive and false-negative risks.
- The README section *Extending detection to related techniques* (and *Further techniques*) describes how detection would extend to related "no scannable URL" techniques.

---

## False-positive override (AC-19)

### M-15: "I trust this site. Reopen the page"
1. Open <http://127.0.0.1:8080/malicious.html>. The warning page appears.
2. Check that the *Details* section is collapsed, below the two main buttons. Expand it.
3. Click **I trust http://127.0.0.1:8080. Reopen the page (not recommended)**.
4. On the reopened lock screen, click once, then try to leave: type another address in the address bar, or close the tab.
5. Open <http://localhost:8080/malicious.html>, the same page from a different origin.
6. Open `test-pages/mal-fullscreen-keylock.html`, click **Open player**, then click the lock screen. It goes full screen. Press Esc once.
7. Quit Chrome completely, start it again, and open <http://127.0.0.1:8080/malicious.html>.

Expected:
- Step 3: the tab reloads `malicious.html`, which opens the lock screen again. This time it stays.
- Step 4: you leave without a "Leave site?" prompt.
- Step 5: blocked as usual. The allow-list is exact to the origin.
- Step 6: allowed, so not blocked, but a single Esc press exits full screen. No press-and-hold is needed, because Keyboard Lock is neutralised.
- Step 7: blocked again. The allow-list is session-only.

---

## Traceability

| Requirement | Scenarios |
|---|---|
| R-01 MV3, content script + service worker, unpacked | M-01 |
| R-02 Detects the blob lock screen | M-03, M-05, M-06 |
| R-03 Distinguishes legitimate use | M-08, M-09 |
| R-04 Copes with escape blocking | M-03, M-05, M-07 |
| R-05 Stops it; the user can leave | M-03, M-04 |
| R-06 No action otherwise | M-08, M-09 |
| R-07 Fresh arrival / already there at install | M-03 / M-07 |
| R-08 No performance impact | M-13 |
| R-09 Client-side only | M-02 |
| R-10 JS + standard MV3 APIs | M-01 (and code review) |
| R-11 Written note | M-14 |
| B-01 Further trapping layer | M-10, M-11, M-12 |
| B-02 Related techniques described | M-14 |
| *Added:* false-positive override (AC-19; supports R-03/R-06 when the heuristic is wrong) | M-15 |
