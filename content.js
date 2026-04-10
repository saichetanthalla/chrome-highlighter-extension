/**
 * Content Script — Highlighter Extension
 * Handles: floating toolbar, highlight creation, notes, tooltips, restore, edit/delete
 */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────

  const COLORS = [
    { name: 'Important', color: '#FFEB3B', label: '🟡' },
    { name: 'Question', color: '#FF8A80', label: '🔴' },
    { name: 'Agree', color: '#B9F6CA', label: '🟢' },
    { name: 'Research', color: '#82B1FF', label: '🔵' }
  ];

  const QUICK_TAGS = ['#important', '#question', '#todo', '#research'];

  // ── State ──────────────────────────────────────────────

  let currentToolbar = null;
  let currentPopup = null;
  let currentTooltip = null;
  let tooltipTimeout = null;
  let highlightsEnabled = true;
  let activeHighlights = new Map(); // id → highlight data

  // ── Initialization ─────────────────────────────────────

  async function init() {
    const settings = await HNStorage.getSettings();
    highlightsEnabled = settings.highlightsEnabled !== false;
    
    // Apply initial theme
    applyTheme(settings.theme || 'dark');

    if (highlightsEnabled) {
      await restoreHighlights();
    }

    setupEventListeners();
    setupStorageListener();
  }

  // ── Event Listeners ────────────────────────────────────

  function setupEventListeners() {
    // Show floating toolbar on text selection
    document.addEventListener('mouseup', onMouseUp);

    // Hide toolbar on click elsewhere
    document.addEventListener('mousedown', (e) => {
      if (currentToolbar && !currentToolbar.contains(e.target)) {
        removeToolbar();
      }
      // Don't close popup when clicking inside it
      if (currentPopup && !currentPopup.contains(e.target) &&
          !e.target.closest('mark.hn-highlight')) {
        removePopup();
      }
    });

    // Hover tooltip for highlights
    document.addEventListener('mouseover', onHighlightMouseOver);
    document.addEventListener('mouseout', onHighlightMouseOut);

    // Hide toolbar on scroll
    document.addEventListener('scroll', () => {
      removeToolbar();
    }, { passive: true });

    // Listen for messages from popup/sidebar
    chrome.runtime.onMessage.addListener(onMessage);
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' || area === 'local') {
        // Check if any of our keys changed
        const relevantChange = Object.keys(changes).some(key => key.startsWith('hn:'));
        if (relevantChange) {
          refreshHighlights();
        }
      }
    });
  }

  // ── Message Handler ────────────────────────────────────

  function onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'THEME_CHANGED':
        applyTheme(message.theme);
        sendResponse({ success: true });
        break;

      case 'TOGGLE_HIGHLIGHTS':
        highlightsEnabled = message.enabled;
        if (highlightsEnabled) {
          restoreHighlights();
        } else {
          removeAllHighlightsFromDOM();
        }
        sendResponse({ success: true });
        break;

      case 'SCROLL_TO_HIGHLIGHT':
        const mark = document.querySelector(`mark.hn-highlight[data-highlight-id="${message.id}"]`);
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          mark.style.transition = 'box-shadow 0.3s ease';
          mark.style.boxShadow = '0 0 0 3px rgba(99, 102, 241, 0.5)';
          setTimeout(() => {
            mark.style.boxShadow = '';
          }, 2000);
        }
        sendResponse({ success: !!mark });
        break;

      case 'REFRESH_HIGHLIGHTS':
        refreshHighlights();
        sendResponse({ success: true });
        break;

      case 'CONTEXT_HIGHLIGHT':
        // Triggered by right-click → "Highlight selection"
        (async () => {
          try {
            const settings = await HNStorage.getSettings();
            const color = settings.defaultColor || COLORS[0].color;
            await createHighlightFromSelection(color);
            sendResponse({ success: true });
          } catch (err) {
            console.error('[HN] Context highlight failed:', err);
            sendResponse({ success: false, error: err.message });
          }
        })();
        break;

      case 'TOGGLE_HIGHLIGHT_MODE':
        // Triggered by Alt+H keyboard shortcut
        highlightsEnabled = !highlightsEnabled;
        HNStorage.saveSettings({ highlightsEnabled });
        if (highlightsEnabled) {
          restoreHighlights();
        } else {
          removeAllHighlightsFromDOM();
        }
        sendResponse({ success: true, enabled: highlightsEnabled });
        break;
    }
    return true; // keep message channel open for async
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-hn-theme', theme);
  }

  // ── Phase 2a: Floating Toolbar ─────────────────────────

  function onMouseUp(e) {
    // Don't show toolbar if clicking on our UI
    if (e.target.closest('.hn-ui')) return;
    if (e.target.closest('mark.hn-highlight')) return;

    // Small delay to let selection finalize
    setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection ? selection.toString().trim() : '';

      if (!selectedText || selectedText.length < 2) {
        return;
      }

      showToolbar(e.clientX, e.clientY);
    }, 10);
  }

  function showToolbar(x, y) {
    removeToolbar();

    const toolbar = document.createElement('div');
    toolbar.className = 'hn-ui hn-floating-toolbar';
    toolbar.addEventListener('mousedown', (e) => {
      e.preventDefault(); // crucial to preserve text selection during clicks
    });

    // Highlight icon
    const highlightBtn = document.createElement('button');
    highlightBtn.className = 'hn-toolbar-btn';
    highlightBtn.innerHTML = '✏️';
    highlightBtn.title = 'Highlight with default color';
    highlightBtn.addEventListener('click', () => {
      createHighlightFromSelection(COLORS[0].color);
    });
    toolbar.appendChild(highlightBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'hn-toolbar-divider';
    toolbar.appendChild(divider);

    // Color swatches
    COLORS.forEach(({ color, name }) => {
      const swatch = document.createElement('button');
      swatch.className = 'hn-color-swatch';
      swatch.style.backgroundColor = color;
      swatch.title = name;
      swatch.addEventListener('click', () => {
        createHighlightFromSelection(color);
      });
      toolbar.appendChild(swatch);
    });

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hn-toolbar-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', removeToolbar);
    toolbar.appendChild(closeBtn);

    document.body.appendChild(toolbar);
    currentToolbar = toolbar;

    // Position: above selection, centered
    const rect = toolbar.getBoundingClientRect();
    let left = x - rect.width / 2;
    let top = y - rect.height - 12;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top = Math.max(8, top);

    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
  }

  function removeToolbar() {
    if (currentToolbar) {
      currentToolbar.remove();
      currentToolbar = null;
    }
  }

  // ── Phase 2b: Highlight Creation ───────────────────────

  async function createHighlightFromSelection(color) {
    const selInfo = HNHighlighter.getSelectionInfo();
    if (!selInfo) return;

    const id = HNStorage.generateId();

    // Wrap the selection
    const mark = HNHighlighter.wrapRange(selInfo.range, id, color);
    if (!mark) return;

    // Save to storage
    const highlightData = {
      id,
      selectedText: selInfo.selectedText,
      xpath: selInfo.xpath,
      startOffset: selInfo.startOffset,
      endOffset: selInfo.endOffset,
      textContext: selInfo.textContext,
      color,
      note: '',
      tags: [],
      timestamp: Date.now()
    };

    try {
      const saved = await HNStorage.saveHighlight(location.href, highlightData);
      activeHighlights.set(id, saved);

      // Clear selection and toolbar
      window.getSelection().removeAllRanges();
      removeToolbar();

      // Show note popup
      showNotePopup(mark, id, saved);
    } catch (err) {
      console.error('[HN] Failed to save highlight:', err);
      HNHighlighter.unwrapHighlight(id);
    }
  }

  // ── Phase 2c: Note + Tag Popup ─────────────────────────

  function showNotePopup(anchorElement, highlightId, highlightData, isEdit = false) {
    removePopup();

    const popup = document.createElement('div');
    popup.className = 'hn-ui hn-note-popup';

    const data = highlightData || activeHighlights.get(highlightId) || {};
    let currentTags = [...(data.tags || [])];

    // Header
    const header = document.createElement('div');
    header.className = 'hn-note-popup-header';

    const title = document.createElement('div');
    title.className = 'hn-note-popup-title';
    title.textContent = isEdit ? 'Edit Note' : 'Add Note';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'hn-note-popup-close';
    closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', removePopup);
    header.appendChild(closeBtn);

    popup.appendChild(header);

    // Selected text preview
    const preview = document.createElement('div');
    preview.className = 'hn-selected-text-preview';
    preview.textContent = '"' + (data.selectedText || '').substring(0, 120) + (data.selectedText && data.selectedText.length > 120 ? '…' : '') + '"';
    popup.appendChild(preview);

    // Textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'hn-note-textarea';
    textarea.placeholder = 'Add a note about this highlight…';
    textarea.value = data.note || '';
    popup.appendChild(textarea);

    // Tag section
    const tagSection = document.createElement('div');
    tagSection.className = 'hn-tag-section';

    const tagLabel = document.createElement('span');
    tagLabel.className = 'hn-tag-label';
    tagLabel.textContent = 'Tags';
    tagSection.appendChild(tagLabel);

    // Tag input with pills
    const tagInputWrap = document.createElement('div');
    tagInputWrap.className = 'hn-tag-input-wrap';

    function renderTagPills() {
      // Remove existing pills
      tagInputWrap.querySelectorAll('.hn-tag-pill').forEach(p => p.remove());

      currentTags.forEach((tag, index) => {
        const pill = document.createElement('span');
        pill.className = 'hn-tag-pill';
        pill.textContent = tag;

        const removeBtn = document.createElement('span');
        removeBtn.className = 'hn-tag-pill-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          currentTags.splice(index, 1);
          renderTagPills();
          updateQuickTags();
        });
        pill.appendChild(removeBtn);

        tagInputWrap.insertBefore(pill, tagInput);
      });
    }

    const tagInput = document.createElement('input');
    tagInput.className = 'hn-tag-input';
    tagInput.type = 'text';
    tagInput.placeholder = currentTags.length === 0 ? 'Type tag + Enter' : '';

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag(tagInput.value);
      }
      if (e.key === 'Backspace' && !tagInput.value && currentTags.length > 0) {
        currentTags.pop();
        renderTagPills();
        updateQuickTags();
      }
    });

    function addTag(value) {
      let tag = value.trim().toLowerCase();
      if (!tag) return;
      if (!tag.startsWith('#')) tag = '#' + tag;
      if (!currentTags.includes(tag)) {
        currentTags.push(tag);
        renderTagPills();
        updateQuickTags();
      }
      tagInput.value = '';
    }

    tagInputWrap.appendChild(tagInput);
    tagSection.appendChild(tagInputWrap);

    // Quick tags
    const quickTagsWrap = document.createElement('div');
    quickTagsWrap.className = 'hn-quick-tags';

    function updateQuickTags() {
      quickTagsWrap.innerHTML = '';
      QUICK_TAGS.forEach(tag => {
        const btn = document.createElement('button');
        btn.className = 'hn-quick-tag' + (currentTags.includes(tag) ? ' active' : '');
        btn.textContent = tag;
        btn.addEventListener('click', () => {
          if (currentTags.includes(tag)) {
            currentTags = currentTags.filter(t => t !== tag);
          } else {
            currentTags.push(tag);
          }
          renderTagPills();
          updateQuickTags();
        });
        quickTagsWrap.appendChild(btn);
      });
    }

    tagSection.appendChild(quickTagsWrap);
    popup.appendChild(tagSection);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'hn-note-actions';

    if (isEdit) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'hn-btn hn-btn-danger';
      deleteBtn.textContent = '🗑 Delete';
      deleteBtn.addEventListener('click', async () => {
        await deleteHighlight(highlightId);
        removePopup();
      });
      actions.appendChild(deleteBtn);
    } else {
      // Spacer
      const spacer = document.createElement('div');
      actions.appendChild(spacer);
    }

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'hn-btn hn-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (!isEdit && !data.note && data.tags.length === 0) {
        // If new highlight with no data, keep the highlight but close popup
      }
      removePopup();
    });
    btnGroup.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'hn-btn hn-btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const note = textarea.value.trim();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const updated = await HNStorage.updateHighlight(location.href, highlightId, {
          note,
          tags: currentTags
        });
        if (updated) {
          activeHighlights.set(highlightId, updated);
        }
      } catch (err) {
        console.error('[HN] Failed to save note:', err);
      } finally {
        removePopup();
      }
    });
    btnGroup.appendChild(saveBtn);

    actions.appendChild(btnGroup);
    popup.appendChild(actions);

    // Add to page
    document.body.appendChild(popup);
    currentPopup = popup;

    // Render initial state
    renderTagPills();
    updateQuickTags();

    // Position near the anchor element
    positionPopup(popup, anchorElement);

    // Prevent host page from stealing keyboard inputs
    popup.addEventListener('keydown', (e) => e.stopPropagation());
    popup.addEventListener('keyup', (e) => e.stopPropagation());
    popup.addEventListener('keypress', (e) => e.stopPropagation());

    // Focus textarea
    setTimeout(() => textarea.focus(), 50);
  }

  function positionPopup(popup, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();

    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    // Keep within viewport
    if (left + popupRect.width > window.innerWidth - 16) {
      left = window.innerWidth - popupRect.width - 16;
    }
    if (left < 8) left = 8;

    if (top + popupRect.height > window.innerHeight - 16) {
      top = anchorRect.top - popupRect.height - 8;
    }
    if (top < 8) top = 8;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function removePopup() {
    if (currentPopup) {
      currentPopup.remove();
      currentPopup = null;
    }
  }

  // ── Phase 2d: Hover Tooltip ────────────────────────────

  function onHighlightMouseOver(e) {
    const mark = e.target.closest('mark.hn-highlight');
    if (!mark) return;

    // Cancel pending hide
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }

    const id = mark.dataset.highlightId;
    const data = activeHighlights.get(id);
    if (!data) return;

    // Don't show if popup is open for this highlight
    if (currentPopup) return;

    showTooltip(mark, data);
  }

  function onHighlightMouseOut(e) {
    const mark = e.target.closest('mark.hn-highlight');
    if (!mark && !e.target.closest('.hn-tooltip')) return;

    tooltipTimeout = setTimeout(() => {
      removeTooltip();
    }, 300);
  }

  function showTooltip(mark, data) {
    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'hn-ui hn-tooltip';

    // Note text
    const noteDiv = document.createElement('div');
    noteDiv.className = 'hn-tooltip-note';
    noteDiv.textContent = data.note || '';
    tooltip.appendChild(noteDiv);

    // Tags
    if (data.tags && data.tags.length > 0) {
      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'hn-tooltip-tags';
      data.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'hn-tooltip-tag';
        tagEl.textContent = tag;
        tagsDiv.appendChild(tagEl);
      });
      tooltip.appendChild(tagsDiv);
    }

    // Click hint
    const hint = document.createElement('div');
    hint.className = 'hn-tooltip-hint';
    hint.textContent = 'Click to edit';
    tooltip.appendChild(hint);

    // Click to open edit popup
    tooltip.addEventListener('click', () => {
      removeTooltip();
      showNotePopup(mark, data.id, data, true);
    });

    // Handle mouse entering/leaving tooltip
    tooltip.addEventListener('mouseenter', () => {
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
    });

    tooltip.addEventListener('mouseleave', () => {
      tooltipTimeout = setTimeout(removeTooltip, 300);
    });

    // Click on mark to edit
    mark.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeTooltip();
      showNotePopup(mark, data.id, data, true);
    }, { once: true });

    document.body.appendChild(tooltip);
    currentTooltip = tooltip;

    // Position above the mark
    const markRect = mark.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = markRect.left + markRect.width / 2 - tooltipRect.width / 2;
    let top = markRect.top - tooltipRect.height - 8;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
    if (top < 8) {
      top = markRect.bottom + 8;
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function removeTooltip() {
    if (currentTooltip) {
      currentTooltip.remove();
      currentTooltip = null;
    }
  }

  // ── Phase 2e: Restore Highlights ───────────────────────

  async function restoreHighlights() {
    try {
      const highlights = await HNStorage.getHighlights(location.href);

      for (const highlight of highlights) {
        const range = HNHighlighter.createRangeForHighlight(highlight);

        if (range) {
          const mark = HNHighlighter.wrapRange(range, highlight.id, highlight.color);
          if (mark) {
            activeHighlights.set(highlight.id, highlight);
          }
        } else {
          // Mark as orphaned
          activeHighlights.set(highlight.id, { ...highlight, _orphaned: true });
          await HNStorage.updateHighlight(location.href, highlight.id, { _orphaned: true });
        }
      }
    } catch (err) {
      console.error('[HN] Failed to restore highlights:', err);
    }
  }

  async function refreshHighlights() {
    removeAllHighlightsFromDOM();
    activeHighlights.clear();
    if (highlightsEnabled) {
      await restoreHighlights();
    }
  }

  function removeAllHighlightsFromDOM() {
    document.querySelectorAll('mark.hn-highlight').forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  // ── Phase 2f: Delete ───────────────────────────────────

  async function deleteHighlight(id) {
    HNHighlighter.unwrapHighlight(id);
    activeHighlights.delete(id);
    await HNStorage.deleteHighlight(location.href, id);
  }

  // ── Start ──────────────────────────────────────────────

  init();
})();
