/**
 * Sidebar Script — Highlighter Extension
 * Notes list, tag filter, search, export
 * Supports "Current Page" and "All Pages" views
 */

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────

  let allHighlights = [];
  let activeTags = [];
  let searchQuery = '';
  let sortOrder = 'newest';
  let currentTabId = null;
  let currentTabUrl = '';
  let viewScope = 'current';

  // ── DOM Elements ───────────────────────────────────────

  const elements = {
    pageTitle: document.getElementById('pageTitle'),
    searchInput: document.getElementById('searchInput'),
    tagFilter: document.getElementById('tagFilter'),
    sortNewest: document.getElementById('sortNewest'),
    sortOldest: document.getElementById('sortOldest'),
    highlightCount: document.getElementById('highlightCount'),
    highlightsList: document.getElementById('highlightsList'),
    emptyState: document.getElementById('emptyState'),
    quotaWarning: document.getElementById('quotaWarning'),
    exportBtn: document.getElementById('exportBtn'),
    copyBtn: document.getElementById('copyBtn'),
    toggleHighlights: document.getElementById('toggleHighlights'),
    colorPicker: document.getElementById('colorPicker'),
    scopeCurrentPage: document.getElementById('scopeCurrentPage'),
    scopeAllPages: document.getElementById('scopeAllPages'),
    settingsToggleBtn: document.getElementById('settingsToggleBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    themeSelect: document.getElementById('themeSelect')
  };

  // ── Initialization ─────────────────────────────────────

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentTabId = tab.id;
        currentTabUrl = tab.url;
        elements.pageTitle.textContent = tab.title || tab.url;
      }
    } catch (err) {
      console.warn('[HN Sidebar] Could not get active tab:', err);
    }

    await loadHighlights();
    await checkQuota();
    await loadSettings();
    setupListeners();

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' || area === 'local') {
        const relevantChange = Object.keys(changes).some(key => key.startsWith('hn:'));
        if (relevantChange) {
          await loadHighlights();
        }
      }
    });
  }

  async function loadSettings() {
    const settings = await HNStorage.getSettings();

    // Theme (Default: Dark)
    const theme = settings.theme || 'dark';
    if (elements.themeSelect) elements.themeSelect.value = theme;
    applyTheme(theme);

    // Toggle
    elements.toggleHighlights.checked = settings.highlightsEnabled !== false;

    // Default color
    const colorOptions = elements.colorPicker.querySelectorAll('.hn-color-option');
    colorOptions.forEach(opt => {
      opt.classList.toggle('active', opt.dataset.color === settings.defaultColor);
    });


  }

  function setupListeners() {
    // Settings Toggle
    if (elements.settingsToggleBtn && elements.settingsPanel) {
      elements.settingsToggleBtn.addEventListener('click', () => {
        const isHidden = elements.settingsPanel.style.display === 'none';
        elements.settingsPanel.style.display = isHidden ? 'flex' : 'none';
      });
    }

    // Scope toggle
    elements.scopeCurrentPage.addEventListener('click', () => {
      viewScope = 'current';
      elements.scopeCurrentPage.classList.add('active');
      elements.scopeAllPages.classList.remove('active');
      loadHighlights();
    });

    elements.scopeAllPages.addEventListener('click', () => {
      viewScope = 'all';
      elements.scopeAllPages.classList.add('active');
      elements.scopeCurrentPage.classList.remove('active');
      loadHighlights();
    });

    // Search
    elements.searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderHighlights();
    });

    // Sort
    elements.sortNewest.addEventListener('click', () => {
      sortOrder = 'newest';
      elements.sortNewest.classList.add('active');
      elements.sortOldest.classList.remove('active');
      renderHighlights();
    });

    elements.sortOldest.addEventListener('click', () => {
      sortOrder = 'oldest';
      elements.sortOldest.classList.add('active');
      elements.sortNewest.classList.remove('active');
      renderHighlights();
    });

    // Export
    elements.exportBtn.addEventListener('click', exportMarkdown);

    // Copy
    elements.copyBtn.addEventListener('click', copyToClipboard);

    // Toggle Highlights
    elements.toggleHighlights.addEventListener('change', async () => {
      const enabled = elements.toggleHighlights.checked;
      await HNStorage.saveSettings({ highlightsEnabled: enabled });

      // Send to all active tabs
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HIGHLIGHTS', enabled });
        } catch (err) {
          // Ignored if tab has no content script
        }
      }
    });

    // Default Color Picker
    elements.colorPicker.addEventListener('click', async (e) => {
      const opt = e.target.closest('.hn-color-option');
      if (!opt) return;

      elements.colorPicker.querySelectorAll('.hn-color-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');

      await HNStorage.saveSettings({ defaultColor: opt.dataset.color });
    });

    // Theme Switcher
    if (elements.themeSelect) {
      elements.themeSelect.addEventListener('change', async (e) => {
        const theme = e.target.value;
        await HNStorage.saveSettings({ theme });
        applyTheme(theme);

        // Broadcast theme change to content scripts
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'THEME_CHANGED', theme });
          } catch (err) {}
        }
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.hnTheme = theme;
  }

  // ── Data Loading ───────────────────────────────────────

  async function loadHighlights() {
    try {
      if (viewScope === 'all') {
        allHighlights = await HNStorage.getAllHighlights();
      } else {
        if (currentTabUrl) {
          const highlights = await HNStorage.getHighlights(currentTabUrl);
          allHighlights = highlights.map(h => ({
            ...h,
            _pageUrl: currentTabUrl,
            _pageTitle: elements.pageTitle.textContent || currentTabUrl
          }));
        } else {
          allHighlights = [];
        }
      }

      renderTags();
      renderHighlights();
    } catch (err) {
      console.error('[HN Sidebar] Failed to load highlights:', err);
    }
  }

  // ── Filtering ──────────────────────────────────────────

  function filterHighlights(highlights, tags, query) {
    return highlights.filter(h => {
      const matchesTags = tags.length === 0 ||
        tags.every(tag => h.tags && h.tags.includes(tag));

      const q = query.toLowerCase();
      const matchesSearch = !q ||
        (h.selectedText && h.selectedText.toLowerCase().includes(q)) ||
        (h.note && h.note.toLowerCase().includes(q)) ||
        (h.tags && h.tags.some(t => t.toLowerCase().includes(q))) ||
        (h._pageTitle && h._pageTitle.toLowerCase().includes(q));

      return matchesTags && matchesSearch;
    });
  }

  function sortHighlights(highlights) {
    return [...highlights].sort((a, b) => {
      if (sortOrder === 'newest') {
        return (b.timestamp || 0) - (a.timestamp || 0);
      }
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
  }

  // ── Tag Rendering ──────────────────────────────────────

  function renderTags() {
    const allTags = new Set();
    allHighlights.forEach(h => {
      if (h.tags) h.tags.forEach(t => allTags.add(t));
    });

    elements.tagFilter.innerHTML = '';
    if (allTags.size === 0) return;

    const allPill = createTagPill('#all', activeTags.length === 0);
    allPill.addEventListener('click', () => {
      activeTags = [];
      renderTags();
      renderHighlights();
    });
    elements.tagFilter.appendChild(allPill);

    [...allTags].sort().forEach(tag => {
      const pill = createTagPill(tag, activeTags.includes(tag));
      pill.addEventListener('click', () => {
        if (activeTags.includes(tag)) {
          activeTags = activeTags.filter(t => t !== tag);
        } else {
          activeTags.push(tag);
        }
        renderTags();
        renderHighlights();
      });
      elements.tagFilter.appendChild(pill);
    });
  }

  function createTagPill(text, isActive) {
    const btn = document.createElement('button');
    btn.className = 'hn-filter-tag' + (isActive ? ' active' : '');
    btn.textContent = text;
    return btn;
  }

  // ── Highlights Rendering ───────────────────────────────

  function renderHighlights() {
    const filtered = filterHighlights(allHighlights, activeTags, searchQuery);
    const sorted = sortHighlights(filtered);

    elements.highlightCount.textContent = `${sorted.length} highlight${sorted.length !== 1 ? 's' : ''}`;

    if (sorted.length === 0) {
      elements.highlightsList.style.display = 'none';
      elements.emptyState.style.display = 'flex';
    } else {
      elements.highlightsList.style.display = 'block';
      elements.emptyState.style.display = 'none';
    }

    elements.highlightsList.innerHTML = '';

    if (viewScope === 'all' && sorted.length > 0) {
      const groupedByPage = new Map();
      sorted.forEach(h => {
        const pageKey = h._pageUrl || 'unknown';
        if (!groupedByPage.has(pageKey)) {
          groupedByPage.set(pageKey, {
            title: h._pageTitle || pageKey,
            url: pageKey,
            highlights: []
          });
        }
        groupedByPage.get(pageKey).highlights.push(h);
      });

      groupedByPage.forEach((group) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'hn-page-group';

        const header = document.createElement('div');
        header.className = 'hn-page-group-header';
        header.title = group.url;

        const icon = document.createElement('span');
        icon.className = 'hn-page-group-icon';
        icon.textContent = '🌐';
        header.appendChild(icon);

        const title = document.createElement('span');
        title.className = 'hn-page-group-title';
        title.textContent = group.title;
        header.appendChild(title);

        const count = document.createElement('span');
        count.className = 'hn-page-group-count';
        count.textContent = group.highlights.length;
        header.appendChild(count);

        header.addEventListener('click', () => {
          chrome.tabs.create({ url: group.url });
        });

        groupEl.appendChild(header);

        group.highlights.forEach(h => {
          const card = createHighlightCard(h);
          groupEl.appendChild(card);
        });

        elements.highlightsList.appendChild(groupEl);
      });
    } else {
      sorted.forEach(h => {
        const card = createHighlightCard(h);
        elements.highlightsList.appendChild(card);
      });
    }
  }

  function createHighlightCard(highlight) {
    const card = document.createElement('div');
    card.className = 'hn-card';

    const colorBar = document.createElement('div');
    colorBar.className = 'hn-card-color-bar';
    colorBar.style.backgroundColor = highlight.color || '#FFEB3B';
    card.appendChild(colorBar);

    const text = document.createElement('div');
    text.className = 'hn-card-text';
    text.textContent = highlight.selectedText || '';
    card.appendChild(text);

    if (highlight.note) {
      const note = document.createElement('div');
      note.className = 'hn-card-note';
      note.textContent = highlight.note;
      card.appendChild(note);
    }

    const footer = document.createElement('div');
    footer.className = 'hn-card-footer';

    if (highlight.tags && highlight.tags.length > 0) {
      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'hn-card-tags';
      highlight.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'hn-card-tag';
        tagEl.textContent = tag;
        tagsDiv.appendChild(tagEl);
      });
      footer.appendChild(tagsDiv);
    }

    const date = document.createElement('span');
    date.className = 'hn-card-date';
    date.textContent = formatDate(highlight.timestamp);

    if (highlight._localOnly) {
      const badge = document.createElement('span');
      badge.className = 'hn-card-local-badge';
      badge.textContent = 'LOCAL ONLY';
      date.appendChild(badge);
    }

    footer.appendChild(date);
    card.appendChild(footer);

    const actions = document.createElement('div');
    actions.className = 'hn-card-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'hn-card-action-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Go to highlight';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      goToHighlight(highlight);
    });
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'hn-card-action-btn delete';
    deleteBtn.textContent = '🗑️';
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteHighlight(highlight);
    });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);

    card.addEventListener('click', () => {
      goToHighlight(highlight);
    });

    return card;
  }

  // ── Helpers ────────────────────────────────────────────

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function goToHighlight(highlight) {
    const highlightUrl = highlight._pageUrl || currentTabUrl;

    if (viewScope === 'all' && highlightUrl && highlightUrl !== currentTabUrl) {
      chrome.tabs.create({ url: highlightUrl }, (newTab) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === newTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => {
              chrome.tabs.sendMessage(newTab.id, { type: 'SCROLL_TO_HIGHLIGHT', id: highlight.id });
            }, 500);
          }
        });
      });
    } else if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { type: 'SCROLL_TO_HIGHLIGHT', id: highlight.id });
    }
  }

  async function deleteHighlight(highlight) {
    try {
      const url = highlight._pageUrl || currentTabUrl;
      if (!url) return;

      await HNStorage.deleteHighlight(url, highlight.id);

      if (currentTabId && url === currentTabUrl) {
        chrome.tabs.sendMessage(currentTabId, { type: 'REFRESH_HIGHLIGHTS' });
      }

      await loadHighlights();
    } catch (err) {
      console.error('[HN Sidebar] Failed to delete:', err);
    }
  }

  // ── Quota Check ────────────────────────────────────────

  async function checkQuota() {
    try {
      const quota = await HNStorage.checkQuota();
      elements.quotaWarning.style.display = quota.isWarning ? 'block' : 'none';
    } catch (err) {
      // Ignore
    }
  }

  // ── Export ─────────────────────────────────────────────

  function exportMarkdown() {
    const sorted = sortHighlights(filterHighlights(allHighlights, activeTags, searchQuery));
    let md = '';

    if (viewScope === 'all') {
      md += `# All Highlights\n`;
      md += `Exported: ${new Date().toLocaleDateString()}\n`;
      md += `Total: ${sorted.length} highlights\n\n`;

      const grouped = new Map();
      sorted.forEach(h => {
        const key = h._pageUrl || 'unknown';
        if (!grouped.has(key)) {
          grouped.set(key, { title: h._pageTitle || key, url: key, highlights: [] });
        }
        grouped.get(key).highlights.push(h);
      });

      grouped.forEach((group) => {
        md += `## ${group.title}\nURL: ${group.url}\n\n`;
        group.highlights.forEach((h, i) => {
          md += `### Highlight ${i + 1}\n\n> "${h.selectedText}"\n\n`;
          if (h.note) md += `**Note:** ${h.note}\n\n`;
          if (h.tags && h.tags.length > 0) md += `**Tags:** ${h.tags.join(', ')}\n\n`;
          md += `**Date:** ${formatDate(h.timestamp)}\n\n---\n\n`;
        });
      });
    } else {
      md += `# Notes: ${elements.pageTitle.textContent}\n`;
      md += `Exported: ${new Date().toLocaleDateString()}\n\n## Your Highlights\n\n`;

      sorted.forEach((h, i) => {
        md += `### Highlight ${i + 1}\n\n> "${h.selectedText}"\n\n`;
        if (h.note) md += `**Note:** ${h.note}\n\n`;
        if (h.tags && h.tags.length > 0) md += `**Tags:** ${h.tags.join(', ')}\n\n`;
        md += `**Date:** ${formatDate(h.timestamp)}\n\n---\n\n`;
      });
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `highlights-${viewScope === 'all' ? 'all-pages' : 'current-page'}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyToClipboard() {
    const sorted = sortHighlights(filterHighlights(allHighlights, activeTags, searchQuery));
    let text = '';

    if (viewScope === 'all') {
      const grouped = new Map();
      sorted.forEach(h => {
        const key = h._pageUrl || 'unknown';
        if (!grouped.has(key)) {
          grouped.set(key, { title: h._pageTitle || key, highlights: [] });
        }
        grouped.get(key).highlights.push(h);
      });

      grouped.forEach((group) => {
        text += `📄 ${group.title}\n${'─'.repeat(40)}\n`;
        group.highlights.forEach((h, i) => {
          text += `[${i + 1}] "${h.selectedText}"`;
          if (h.note) text += `\n   Note: ${h.note}`;
          if (h.tags && h.tags.length > 0) text += `\n   Tags: ${h.tags.join(', ')}`;
          text += `\n   Date: ${formatDate(h.timestamp)}\n\n`;
        });
      });
    } else {
      sorted.forEach((h, i) => {
        text += `[${i + 1}] "${h.selectedText}"`;
        if (h.note) text += `\n   Note: ${h.note}`;
        if (h.tags && h.tags.length > 0) text += `\n   Tags: ${h.tags.join(', ')}`;
        text += `\n   Date: ${formatDate(h.timestamp)}\n\n`;
      });
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard!');
    } catch (err) {
      console.error('[HN Sidebar] Failed to copy:', err);
    }
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'hn-copy-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // ── Start ──────────────────────────────────────────────

  init();
})();
