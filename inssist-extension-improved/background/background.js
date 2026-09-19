// background.js — service worker v8

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openBulkWindow') {
    const tabId = sender.tab.id;
    chrome.windows.create({
      url: chrome.runtime.getURL(`popup/popup.html?bulk=${msg.username}&tabId=${tabId}`),
      type: 'popup',
      width: 450,
      height: 600
    });
    sendResponse({ ok: true });
  }
  return true;
});
