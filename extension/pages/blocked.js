'use strict';
// Warning page shown after a fake lock screen was stopped. Parameters come from
// the service worker. Reasons contain text quoted from the scam page, so they
// are rendered with textContent only, never as HTML.
(() => {
  // Lets the service worker know the tab really left the scam page.
  chrome.runtime.sendMessage({ type: 'blg:warning-shown' }).catch(() => {});

  const params = new URLSearchParams(location.search);

  const origin = params.get('origin');
  if (origin) document.getElementById('origin').textContent = origin;

  let reasons = [];
  try {
    const parsed = JSON.parse(params.get('reasons') || '[]');
    if (Array.isArray(parsed)) reasons = parsed.filter((r) => typeof r === 'string').slice(0, 10);
  } catch (_) {
    /* ignore malformed input */
  }
  if (!reasons.length) reasons = ['It looked like a fake system lock screen and tried to keep you on the page.'];
  const list = document.getElementById('reasons');
  for (const reason of reasons) {
    const li = document.createElement('li');
    li.textContent = reason;
    list.appendChild(li);
  }

  const currentTab = () => new Promise((resolve) => chrome.tabs.getCurrent(resolve));

  document.getElementById('new-tab').addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab) return;
    await chrome.tabs.update(tab.id, { muted: false }); // the scam page (and its audio) is gone
    chrome.tabs.update(tab.id, { url: 'chrome://newtab/' });
  });
  document.getElementById('close-tab').addEventListener('click', async () => {
    const tab = await currentTab();
    if (tab) chrome.tabs.remove(tab.id);
  });

  // False-positive override, offered only when the worker says reopening can work.
  const blobUrl = params.get('blob');
  if (blobUrl && origin) {
    document.getElementById('override').hidden = false;
    document.getElementById('override-origin').textContent = origin;
    document.getElementById('reopen').textContent = `I trust ${origin}. Reopen the page (not recommended)`;
    document.getElementById('reopen').addEventListener('click', async () => {
      const resp = await chrome.runtime.sendMessage({ type: 'blg:proceed', blobUrl, fromUrl: params.get('from') }).catch(() => null);
      if (!resp || !resp.ok) {
        const error = document.getElementById('reopen-error');
        error.textContent = (resp && resp.error) || 'The page could not be reopened.';
        error.hidden = false;
      }
    });
  }
  document.getElementById('new-tab').focus();
})();
