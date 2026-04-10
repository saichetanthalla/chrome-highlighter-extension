/**
 * Background Service Worker — Highlighter Extension
 * Context menu, keyboard commands, side panel
 */

// ── Context Menu Setup ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.contextMenus.create({
    id: 'hn-highlight-selection',
    title: 'Highlight selection',
    contexts: ['selection']
  });

  // Inject content scripts into existing HTTP/HTTPS tabs
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        try {
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['utils/storage.js', 'utils/highlighter.js', 'content.js']
          });
        } catch (err) {
          // Ignore errors on restricted pages
        }
      }
    }
  } catch (err) {
    console.warn('[HN BG] Could not query tabs for injection:', err);
  }
});

// ── Context Menu Click ─────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'hn-highlight-selection' && tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CONTEXT_HIGHLIGHT',
        text: info.selectionText
      });
    } catch (err) {
      console.warn('[HN BG] Could not send context highlight message:', err);
    }
  }
});

// ── Message Listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_SIDE_PANEL') {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ success: true });
  }
});
