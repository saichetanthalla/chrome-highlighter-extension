/**
 * Highlighter Utility
 * DOM text-finding, XPath generation, and range restoration logic
 */

const HNHighlighter = (() => {

  // ── XPath Utilities ──────────────────────────────────────

  /**
   * Generate an XPath for a given DOM node
   */
  function getXPath(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return getXPath(node.parentNode) + '/text()[' + getTextNodeIndex(node) + ']';
    }
    if (node === document.body) return '/html/body';
    if (node === document.documentElement) return '/html';

    const parent = node.parentNode;
    if (!parent) return '';

    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === node.tagName
    );

    if (siblings.length === 1) {
      return getXPath(parent) + '/' + node.tagName.toLowerCase();
    }

    const index = siblings.indexOf(node) + 1;
    return getXPath(parent) + '/' + node.tagName.toLowerCase() + '[' + index + ']';
  }

  /**
   * Get the index of a text node among its sibling text nodes
   */
  function getTextNodeIndex(textNode) {
    let index = 1;
    let sibling = textNode.previousSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        index++;
      }
      sibling = sibling.previousSibling;
    }
    return index;
  }

  /**
   * Evaluate an XPath and return the node
   */
  function resolveXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue;
    } catch (e) {
      console.warn('[HN] XPath resolution failed:', xpath, e);
      return null;
    }
  }

  // ── Text Search via TreeWalker ───────────────────────────

  /**
   * Find the text node and offset for a given text string
   * Uses TreeWalker for robust text finding even when DOM structure changes
   */
  function findTextInDOM(searchText, contextXPath, startOffset) {
    // First try XPath-based restoration
    if (contextXPath) {
      const node = resolveXPath(contextXPath);
      if (node && node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text.substring(startOffset).startsWith(searchText.substring(0, Math.min(20, searchText.length)))) {
          return { node, offset: startOffset };
        }
      }
      // If XPath points to an element, search within it
      if (node && node.nodeType === Node.ELEMENT_NODE) {
        const result = searchInElement(node, searchText);
        if (result) return result;
      }
    }

    // Fallback: search the entire body using TreeWalker
    return searchInElement(document.body, searchText);
  }

  /**
   * Search for text within an element using TreeWalker
   */
  function searchInElement(root, searchText) {
    if (!root || !searchText) return null;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip our own UI elements
          if (node.parentElement && node.parentElement.closest('.hn-ui')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Build a concatenated text map to handle text split across nodes
    const textNodes = [];
    let fullText = '';

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      textNodes.push({
        node: currentNode,
        start: fullText.length,
        length: currentNode.textContent.length
      });
      fullText += currentNode.textContent;
    }

    // Find the search text in the concatenated text
    const searchIndex = fullText.indexOf(searchText);
    if (searchIndex === -1) return null;

    // Map back to the specific text node
    for (const entry of textNodes) {
      if (searchIndex >= entry.start && searchIndex < entry.start + entry.length) {
        return {
          node: entry.node,
          offset: searchIndex - entry.start
        };
      }
    }

    return null;
  }

  // ── Range Creation ───────────────────────────────────────

  /**
   * Create a DOM Range for a stored highlight
   */
  function createRangeForHighlight(highlight) {
    const { selectedText, xpath, startOffset, endOffset, textContext } = highlight;

    // Try to find the start of the text
    const start = findTextInDOM(selectedText, xpath, startOffset);
    if (!start) return null;

    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);

      // Calculate end position
      const endPos = start.offset + selectedText.length;

      if (endPos <= start.node.textContent.length) {
        // Text fits within a single text node
        range.setEnd(start.node, endPos);
      } else {
        // Text spans multiple nodes — use TreeWalker to find the end
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );

        walker.currentNode = start.node;
        let remaining = selectedText.length - (start.node.textContent.length - start.offset);

        let endNode = start.node;
        let endNodeOffset = start.node.textContent.length;

        while (remaining > 0 && walker.nextNode()) {
          const node = walker.currentNode;
          if (node.parentElement && node.parentElement.closest('.hn-ui')) continue;

          if (remaining <= node.textContent.length) {
            endNode = node;
            endNodeOffset = remaining;
            remaining = 0;
          } else {
            remaining -= node.textContent.length;
          }
        }

        range.setEnd(endNode, endNodeOffset);
      }

      return range;
    } catch (e) {
      console.warn('[HN] Failed to create range:', e);
      return null;
    }
  }

  // ── Wrapping & Unwrapping ────────────────────────────────

  /**
   * Wrap a Range in a <mark> element for highlighting
   */
  function wrapRange(range, id, color) {
    if (!range) return null;

    // Handle ranges that span multiple nodes
    const fragment = range.extractContents();
    const mark = document.createElement('mark');
    mark.className = 'hn-highlight';
    mark.dataset.highlightId = id;
    mark.style.backgroundColor = color;
    mark.appendChild(fragment);

    range.insertNode(mark);

    // Normalize to merge adjacent text nodes
    if (mark.parentNode) {
      mark.parentNode.normalize();
    }

    return mark;
  }

  /**
   * Remove a highlight <mark> element and restore the text
   */
  function unwrapHighlight(id) {
    const mark = document.querySelector(`mark.hn-highlight[data-highlight-id="${id}"]`);
    if (!mark) return false;

    const parent = mark.parentNode;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();

    return true;
  }

  /**
   * Get info about the current text selection for saving
   */
  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const selectedText = selection.toString().trim();
    if (!selectedText) return null;

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const startOffset = range.startOffset;
    const endOffset = range.endOffset;

    // Generate XPath for the start container
    const xpath = getXPath(startNode);

    // Get some surrounding text for context
    let textContext = '';
    if (startNode.nodeType === Node.TEXT_NODE) {
      const fullText = startNode.textContent;
      const contextStart = Math.max(0, startOffset - 30);
      const contextEnd = Math.min(fullText.length, startOffset + selectedText.length + 30);
      textContext = fullText.substring(contextStart, contextEnd);
    }

    return {
      selectedText,
      xpath,
      startOffset,
      endOffset,
      textContext,
      range
    };
  }

  // ── Public API ───────────────────────────────────────────

  return {
    getXPath,
    resolveXPath,
    findTextInDOM,
    createRangeForHighlight,
    wrapRange,
    unwrapHighlight,
    getSelectionInfo
  };
})();
