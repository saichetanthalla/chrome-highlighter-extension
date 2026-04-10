/**
 * Storage Utilities for Highlighter Extension
 * Uses chrome.storage.sync with fallback to chrome.storage.local
 * Key structure:
 *   "hn:index:{urlHash}"       → { url, title, ids: [...] }
 *   "hn:item:{urlHash}:{id}"   → single highlight object
 *   "hn:settings"              → settings object
 */

const HNStorage = (() => {
  // ── Helpers ──────────────────────────────────────────────

  /**
   * Generate an 8-char hash from a URL for compact storage keys
   */
  function hashUrl(url) {
    let hash = 0;
    const normalized = url.split('#')[0].split('?')[0]; // strip hash & query
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to base36 and pad/trim to 8 chars
    const base36 = Math.abs(hash).toString(36);
    return base36.padStart(8, '0').slice(0, 8);
  }

  /**
   * Generate a short unique ID for a highlight
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Get the index key for a URL hash
   */
  function indexKey(urlHash) {
    return `hn:index:${urlHash}`;
  }

  /**
   * Get the item key for a specific highlight
   */
  function itemKey(urlHash, id) {
    return `hn:item:${urlHash}:${id}`;
  }

  // ── Quota Management ─────────────────────────────────────

  const SYNC_QUOTA_BYTES = 102400; // 100 KB
  const QUOTA_WARNING_THRESHOLD = 92160; // 90 KB (90%)

  /**
   * Check current sync storage usage and return status
   */
  async function checkQuota() {
    return new Promise((resolve) => {
      chrome.storage.sync.getBytesInUse(null, (bytesInUse) => {
        resolve({
          bytesInUse,
          totalQuota: SYNC_QUOTA_BYTES,
          percentUsed: Math.round((bytesInUse / SYNC_QUOTA_BYTES) * 100),
          isWarning: bytesInUse >= QUOTA_WARNING_THRESHOLD,
          isFull: bytesInUse >= SYNC_QUOTA_BYTES
        });
      });
    });
  }

  /**
   * Choose storage area based on quota status
   * Falls back to chrome.storage.local when sync is full
   */
  async function getStorageArea() {
    const quota = await checkQuota();
    if (quota.isFull) {
      return { area: chrome.storage.local, isLocal: true };
    }
    return { area: chrome.storage.sync, isLocal: false };
  }

  // ── Core CRUD ────────────────────────────────────────────

  /**
   * Get all highlights for a given URL
   * Reads from both sync and local storage
   */
  async function getHighlights(url) {
    const urlHash = hashUrl(url);
    const idxKey = indexKey(urlHash);

    // Read from sync
    const syncData = await new Promise((resolve) => {
      chrome.storage.sync.get(idxKey, (result) => resolve(result));
    });

    // Also read from local (fallback highlights)
    const localData = await new Promise((resolve) => {
      chrome.storage.local.get(idxKey, (result) => resolve(result));
    });

    // Merge IDs from both sources
    const docTitle = (typeof document !== 'undefined' && document.title) ? document.title : '';
    const syncIndex = syncData[idxKey] || { url, title: docTitle, ids: [] };
    const localIndex = localData[idxKey] || { ids: [] };
    const allIds = [...new Set([...syncIndex.ids, ...localIndex.ids])];

    if (allIds.length === 0) return [];

    // Fetch all individual highlights
    const syncKeys = allIds.map(id => itemKey(urlHash, id));
    const localKeys = [...syncKeys]; // check both

    const syncItems = await new Promise((resolve) => {
      chrome.storage.sync.get(syncKeys, (result) => resolve(result));
    });

    const localItems = await new Promise((resolve) => {
      chrome.storage.local.get(localKeys, (result) => resolve(result));
    });

    // Merge: local overrides sync for same key (local = newer fallback)
    const merged = { ...syncItems, ...localItems };

    const highlights = allIds
      .map(id => merged[itemKey(urlHash, id)])
      .filter(Boolean);

    // Sort by timestamp, newest first
    highlights.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return highlights;
  }

  /**
   * Save a new highlight for a URL
   */
  async function saveHighlight(url, highlightData) {
    const urlHash = hashUrl(url);
    const id = highlightData.id || generateId();
    const highlight = {
      id,
      urlHash,
      selectedText: highlightData.selectedText || '',
      note: highlightData.note || '',
      tags: highlightData.tags || [],
      color: highlightData.color || '#FFEB3B',
      timestamp: highlightData.timestamp || Date.now(),
      xpath: highlightData.xpath || '',
      startOffset: highlightData.startOffset || 0,
      endOffset: highlightData.endOffset || 0,
      textContext: highlightData.textContext || '',
      syncedAt: Date.now()
    };

    const { area, isLocal } = await getStorageArea();
    const idxKey = indexKey(urlHash);
    const itmKey = itemKey(urlHash, id);

    // Read existing index from the target area
    const data = await new Promise((resolve) => {
      area.get(idxKey, (result) => resolve(result));
    });

    const docTitle2 = (typeof document !== 'undefined' && document.title) ? document.title : '';
    const index = data[idxKey] || { url, title: docTitle2, ids: [] };
    if (!index.ids.includes(id)) {
      index.ids.push(id);
    }

    // Write both index and item
    await new Promise((resolve, reject) => {
      area.set({ [idxKey]: index, [itmKey]: highlight }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });

    // Mark as local-only if stored in local storage
    if (isLocal) {
      highlight._localOnly = true;
    }

    return highlight;
  }

  /**
   * Update an existing highlight (merge changes)
   */
  async function updateHighlight(url, id, changes) {
    const urlHash = hashUrl(url);
    const itmKey = itemKey(urlHash, id);

    // Try sync first, then local
    let existing = await new Promise((resolve) => {
      chrome.storage.sync.get(itmKey, (result) => resolve(result[itmKey]));
    });

    let area = chrome.storage.sync;

    if (!existing) {
      existing = await new Promise((resolve) => {
        chrome.storage.local.get(itmKey, (result) => resolve(result[itmKey]));
      });
      area = chrome.storage.local;
    }

    if (!existing) return null;

    const updated = {
      ...existing,
      ...changes,
      syncedAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      area.set({ [itmKey]: updated }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });

    return updated;
  }

  /**
   * Delete a highlight by ID
   */
  async function deleteHighlight(url, id) {
    const urlHash = hashUrl(url);
    const idxKey = indexKey(urlHash);
    const itmKey = itemKey(urlHash, id);

    // Remove from both sync and local
    const areas = [chrome.storage.sync, chrome.storage.local];

    for (const area of areas) {
      // Update index
      const data = await new Promise((resolve) => {
        area.get(idxKey, (result) => resolve(result));
      });

      const index = data[idxKey];
      if (index) {
        index.ids = index.ids.filter(existingId => existingId !== id);
        if (index.ids.length === 0) {
          // Remove the index key entirely if no highlights remain
          await new Promise((resolve) => {
            area.remove(idxKey, resolve);
          });
        } else {
          await new Promise((resolve) => {
            area.set({ [idxKey]: index }, resolve);
          });
        }
      }

      // Remove the item
      await new Promise((resolve) => {
        area.remove(itmKey, resolve);
      });
    }

    return true;
  }

  // ── Get ALL Highlights (all URLs) ─────────────────────────

  /**
   * Get all highlights across all URLs from both sync and local storage.
   * Returns an array of highlight objects, each enriched with _pageUrl and _pageTitle.
   */
  async function getAllHighlights() {
    // Read everything from both sync and local
    const syncAll = await new Promise((resolve) => {
      chrome.storage.sync.get(null, (result) => resolve(result || {}));
    });

    const localAll = await new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => resolve(result || {}));
    });

    // Find all index keys (hn:index:*)
    const allData = { ...syncAll, ...localAll };
    const indexKeys = Object.keys(allData).filter(k => k.startsWith('hn:index:'));

    const allHighlights = [];

    for (const idxKey of indexKeys) {
      const index = allData[idxKey];
      if (!index || !index.ids || index.ids.length === 0) continue;

      const urlHash = idxKey.replace('hn:index:', '');
      const pageUrl = index.url || '';
      const pageTitle = index.title || pageUrl;

      for (const id of index.ids) {
        const itmKey = itemKey(urlHash, id);
        const highlight = allData[itmKey];
        if (highlight) {
          allHighlights.push({
            ...highlight,
            _pageUrl: pageUrl,
            _pageTitle: pageTitle
          });
        }
      }
    }

    // Sort by timestamp, newest first
    allHighlights.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return allHighlights;
  }

  // ── Settings ─────────────────────────────────────────────

  const SETTINGS_KEY = 'hn:settings';

  const DEFAULT_SETTINGS = {
    defaultColor: '#FFEB3B',
    highlightsEnabled: true
  };

  /**
   * Get extension settings
   */
  async function getSettings() {
    const data = await new Promise((resolve) => {
      chrome.storage.sync.get(SETTINGS_KEY, (result) => resolve(result));
    });
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  }

  /**
   * Save/merge settings changes
   */
  async function saveSettings(changes) {
    const current = await getSettings();
    const updated = { ...current, ...changes };

    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [SETTINGS_KEY]: updated }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });

    return updated;
  }

  // ── Public API ───────────────────────────────────────────

  return {
    hashUrl,
    generateId,
    getHighlights,
    getAllHighlights,
    saveHighlight,
    updateHighlight,
    deleteHighlight,
    getSettings,
    saveSettings,
    checkQuota
  };
})();
