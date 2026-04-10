# Chrome Extension — Web Highlighter + Notes + AI Summary

## Project Overview

Build a Chrome extension that lets users highlight text on any webpage, attach tagged notes to highlights, and get an AI-powered summary of the page with their notes in context. All highlights and notes persist per URL and are restored automatically on revisit.

---

## Final Requirements

### Phase 1 — Core (build and ship first)
- Highlight any selected text on a webpage
- Attach a typed note to each highlight
- Assign one or more tags to each note (e.g. `#research`, `#todo`, `#question`, `#important`)
- Persist and sync all highlights + notes via `chrome.storage.sync` — automatically available across all Chrome devices the user is signed into (Mac, iPhone, iPad, etc.)
- Auto-restore highlights and notes when the user revisits the same page on any device

### Phase 2 — Highlighting & Notes UX
- Color-coded highlights (yellow = important, red = question, green = agree, blue = research)
- Inline note + tag preview on hover (tooltip)
- Edit and delete highlights directly on the page
- Small floating toolbar appears on text selection with: highlight button + color picker

### Phase 3 — Sidebar Panel
- Slide-in sidebar showing all highlights on the current page
- Each entry shows: highlighted text snippet, note, tags, timestamp
- **Tag filter bar** at the top — click a tag to filter highlights by it
- **Search input** — searches across highlighted text, notes, and tags
- Combined search + tag filtering (e.g. filter by `#todo` then search within results)
- Sort options: newest first / oldest first

### Phase 4 — Export & Settings
- Export all highlights + notes as a Markdown (`.md`) file
- Copy all notes to clipboard in clean format
- Toggle highlights on/off for the current page
- Default highlight color picker
- Keyboard shortcut reminder (e.g. `Alt+H` to enter highlight mode)

---

## Add-on: AI Summary (Claude API)
> Build this only after Phase 1–4 are fully working. It is an optional enhancement, not a dependency of the core product.

- "Summarize this page" button in the sidebar
- Sends full page text + all user notes/tags to Claude API
- Claude returns:
  1. Concise page summary (3–5 sentences)
  2. "Your Notes in Context" — each highlight explained in relation to the page
- "Ask a question about this page" chat input in the sidebar
- Loading spinner during API call
- Export includes AI summary if it has been generated
- API key input in popup settings (stored in `chrome.storage.sync`)
- If no API key is set, the "Summarize" button shows a prompt to add one — the rest of the extension works normally without it

---

## File Structure

```
highlighter-extension/
├── manifest.json
├── background.js            # Claude API calls, message routing
├── content.js               # Highlight logic, note rendering, page text extraction
├── content.css              # Highlight styles, tooltip, floating toolbar
├── sidebar/
│   ├── sidebar.html
│   ├── sidebar.js           # Notes list, tag filter, search, export
│   └── sidebar.css
├── popup/
│   ├── popup.html
│   └── popup.js             # Toggle, API key, settings
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── utils/
    ├── storage.js           # chrome.storage read/write helpers
    └── highlighter.js      # DOM text-finding and range restoration logic
```

---

## Data Model & Storage Strategy

### Storage: `chrome.storage.sync`

Using `chrome.storage.sync` instead of `chrome.storage.sync` means data is tied to the user's Google account and automatically syncs across every Chrome device they are signed into — Mac, iPhone, iPad, Windows, etc. No backend or login required.

#### Sync storage limits (Chrome enforces these hard):
| Limit | Value |
|---|---|
| Total storage | 100 KB |
| Per key | 8 KB |
| Max keys | 512 |
| Writes per minute | 120 |

#### Key structure — split per highlight to stay under 8 KB/key:

Do NOT store all highlights for a URL in one key. Store each highlight individually:

```
"hn:index:{urlHash}"       → { url, title, ids: ["abc123", "def456"] }
"hn:item:{urlHash}:abc123" → single highlight object
```

Use a short 8-char hash of the URL to keep keys compact.

#### Per-highlight object:
```json
{
  "id": "abc123",
  "urlHash": "a1b2c3d4",
  "selectedText": "the exact highlighted text",
  "note": "user's note here",
  "tags": ["#research", "#important"],
  "color": "#FFEB3B",
  "timestamp": 1712345678000,
  "xpath": "//div[@id='article']/p[2]",
  "startOffset": 14,
  "endOffset": 47,
  "syncedAt": 1712345680000
}
```

### Settings key: `"hn:settings"`
```json
{
  "apiKey": "sk-ant-...",
  "defaultColor": "#FFEB3B",
  "highlightsEnabled": true
}
```

### Quota handling
- Before every write, check `chrome.storage.sync.getBytesInUse()` against the 100 KB cap
- If within 10 KB of the limit, show a warning banner in sidebar: *"Sync storage is almost full."*
- If over the limit, fall back to `chrome.storage.local` for new highlights and mark them with a "local only" badge in the sidebar

### Real-time cross-device sync
```javascript
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    // Another device added/edited/deleted a highlight — re-render the page
    refreshHighlightsOnPage();
  }
});
```
Changes from one device appear on others within seconds, without a page reload.

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "Highlighter — Notes & AI Summary",
  "version": "1.0.0",
  "description": "Highlight text, add tagged notes, and get AI summaries on any webpage.",
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "contextMenus",
    "sidePanel"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": {
    "default_path": "sidebar/sidebar.html"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "commands": {
    "toggle-highlight-mode": {
      "suggested_key": { "default": "Alt+H" },
      "description": "Toggle highlight mode"
    }
  }
}
```

---

## Implementation Plan

Build in this exact order. Each phase is independently testable.

---

### Phase 1 — Storage Utilities (`utils/storage.js`)

Build first. Everything else depends on it.

- `getHighlights(url)` → returns array of highlights for that URL
- `saveHighlight(url, highlightObj)` → appends to array
- `updateHighlight(url, id, changes)` → merges changes into matching highlight
- `deleteHighlight(url, id)` → removes by id
- `getSettings()` → returns settings object
- `saveSettings(changes)` → merges changes into settings

---

### Phase 2 — Content Script (`content.js` + `content.css`)

#### 2a — Floating toolbar on text selection
- Listen for `mouseup`
- If `window.getSelection().toString().trim()` is non-empty, show a small floating toolbar near the selection
- Toolbar contains: highlight icon + 4 color swatches + close button
- Clicking a color triggers the highlight flow

#### 2b — Highlight creation
- Wrap selected range in a `<mark>` element with:
  - `data-highlight-id` attribute
  - Inline `background-color` from chosen color
  - Class `hn-highlight`
- Record XPath + offsets for persistence
- Save to storage immediately

#### 2c — Note + tag attachment
- After creating a highlight, show a small popup anchored to the `<mark>` element
- Popup contains:
  - Textarea for the note
  - Tag input: type a tag and press Enter or comma to add it (rendered as pills)
  - Predefined quick-tags: `#important`, `#question`, `#todo`, `#research`
  - Save button + Cancel button
- On save: update the highlight in storage with the note and tags

#### 2d — Hover tooltip
- On `mouseenter` over `.hn-highlight`: show a tooltip with note text + tag pills
- On `mouseleave`: hide tooltip after 300ms delay (cancel if cursor re-enters)
- Clicking the tooltip opens the edit popup

#### 2e — Restoring highlights on page load
- On `document_idle`, call `getHighlights(location.href)`
- For each highlight, use `TreeWalker` to find the matching text node
- Re-wrap in `<mark>` with same styles
- If text is not found (page changed), skip silently and flag as "orphaned" in storage

#### 2f — Edit and delete
- Edit popup has a delete button (trash icon) at the bottom right
- On delete: remove `<mark>` from DOM, call `deleteHighlight()`

---

### Phase 3 — Background Service Worker (`background.js`)

#### 3a — Claude API call
```javascript
async function callClaude(prompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  return data.content[0].text;
}
```

#### 3b — Message listener
Listen for messages from sidebar:
- `{ type: "SUMMARIZE", pageText, notes, apiKey }` → build summary prompt → call Claude → return result
- `{ type: "ASK", question, pageText, apiKey }` → build QA prompt → return answer

#### 3c — Prompts

**Summary prompt:**
```
You are summarizing a webpage for the user.

PAGE CONTENT (truncated to 6000 words):
{{pageText}}

USER'S HIGHLIGHTS AND NOTES:
{{notes.map(n => `- Highlighted: "${n.selectedText}" | Tags: ${n.tags.join(", ")} | Note: "${n.note}"`).join("\n")}}

Return your response in two clearly labeled sections:
1. Page Summary (3–5 sentences)
2. Your Notes in Context (for each highlight, briefly explain how it relates to the page's main argument)
```

**QA prompt:**
```
The user is reading a webpage. Answer their question based on the page content below.

PAGE CONTENT:
{{pageText}}

USER QUESTION: {{question}}

Be concise and cite where in the page the answer comes from.
```

---

### Phase 4 — Sidebar (`sidebar/`)

#### 4a — Layout (sidebar.html)
```
┌─────────────────────────────────┐
│  [Search input..................]│
│  Tags: [#all] [#research] [#todo]│
│  ─────────────────────────────  │
│  Sort: [Newest] [Oldest]        │
│                                 │
│  ┌─────────────────────────┐   │
│  │ "highlighted text..."   │   │
│  │ Note: my note here      │   │
│  │ #research  #important   │   │
│  │ Apr 8, 2026      ✏ 🗑  │   │
│  └─────────────────────────┘   │
│  ┌─────────────────────────┐   │
│  │ ...                     │   │
│  └─────────────────────────┘   │
│                                 │
│  ─────────────────────────────  │
│  [Summarize page]  [Export .md] │
│                                 │
│  [AI Summary shows here...]     │
│                                 │
│  ─────────────────────────────  │
│  Ask: [type a question....] [→] │
└─────────────────────────────────┘
```

#### 4b — Tag filter logic (sidebar.js)
- On load: read all highlights → extract unique tags → render as clickable pills
- Active tag pills are highlighted (filled)
- Multiple tags can be selected at once (AND filter — highlight must have ALL selected tags)
- A special `#all` pill deselects all tag filters
- Search input filters by text match across `selectedText`, `note`, and `tags`
- Tag filter and search work together

```javascript
function filterHighlights(highlights, activeTags, searchQuery) {
  return highlights.filter(h => {
    const matchesTags = activeTags.length === 0 ||
      activeTags.every(tag => h.tags.includes(tag));
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q ||
      h.selectedText.toLowerCase().includes(q) ||
      h.note.toLowerCase().includes(q) ||
      h.tags.some(t => t.toLowerCase().includes(q));
    return matchesTags && matchesSearch;
  });
}
```

#### 4c — Summarize button
- Gets page text from content script via `chrome.tabs.sendMessage`
- Gets all highlights from storage
- Sends to background.js for Claude API call
- Renders result in an expandable section below the button
- Shows spinner while loading

#### 4d — Export as Markdown
```markdown
# Notes: {{page title}}
URL: {{url}}
Exported: {{date}}

## AI Summary
{{summary text}}

## Your Highlights

### Highlight 1
> "highlighted text here"
**Note:** my note
**Tags:** #research, #important
**Date:** Apr 8, 2026
```

#### 4e — Ask a question
- Input + send button at the bottom of sidebar
- Response appears in a chat-bubble style below the input
- Maintains a short conversation array, sends full history each time

---

### Phase 5 — Popup (`popup/`)

Simple settings panel:

- Toggle switch: "Show highlights on this page"
- Default color picker (4 swatches)
- API key input (password field) + save button
- Link: "Open sidebar"
- Keyboard shortcut reminder: `Alt+H`

---

## Edge Cases to Handle

| Case | Handling |
|---|---|
| Text not found on re-visit | Skip silently, mark highlight as orphaned with a faded style |
| Empty tags | Allow highlights with no tags |
| Duplicate tags | Deduplicate on input |
| Multiple highlights on same text | Allow, each gets its own ID and note |
| User not signed into Chrome | `storage.sync` still works locally but won't sync — show a one-time tip: "Sign into Chrome to sync across devices" |
| Sync quota nearly full (>90 KB) | Show warning banner in sidebar: "Sync storage almost full — older highlights may not sync" |
| Sync quota exceeded (100 KB) | Fall back to `chrome.storage.local` for new highlights, show a "local only" badge on affected entries in the sidebar |
| Highlight added on another device | `storage.onChanged` listener re-renders highlights on current page automatically |
| Conflicting edits from two devices | Last-write-wins (Chrome sync default) — acceptable for a notes tool |
| Page text too long (add-on only) | Trim `pageText` to first 6000 words before sending to Claude |
| No API key set (add-on only) | Show a prompt in sidebar to enter API key in popup |
| No notes on page (add-on only) | Still summarize; skip "Your Notes in Context" section |
| API error (add-on only) | Show error message in sidebar, do not crash |

---

## CSS Design Notes

- Use CSS custom properties for colors so dark mode can be supported later
- Highlight marks: `border-radius: 2px`, `cursor: pointer`
- Sidebar: fixed width `320px`, slides in from right, `z-index: 999999`
- Tooltip: `position: absolute`, max-width `260px`, white card with subtle border
- Floating toolbar: `position: fixed`, near cursor, disappears on scroll

```css
:root {
  --hn-yellow: #FFEB3B;
  --hn-red: #FF8A80;
  --hn-green: #B9F6CA;
  --hn-blue: #82B1FF;
  --hn-sidebar-width: 320px;
  --hn-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --hn-radius: 8px;
  --hn-shadow: 0 2px 12px rgba(0,0,0,0.12);
}
```

---

## Build Order Summary

### Core build (ship this first)
```
1. utils/storage.js          ← foundation, everything depends on this
2. content.js Phase 2a–2b    ← highlight creation works
3. content.js Phase 2c       ← notes + tags work
4. content.js Phase 2d–2f    ← hover, restore, edit/delete
5. sidebar Phase 4a–4b       ← sidebar renders + tag filter + search
6. popup/                    ← settings (toggle, default color, shortcuts)
7. Export (.md + clipboard)  ← works without AI
8. End-to-end test           ← full core flow on 3 different sites
```

### Add-on build (only after core is stable)
```
9.  background.js            ← Claude API call setup
10. sidebar Phase 4c         ← Summarize button + spinner + result
11. sidebar Phase 4e         ← Ask a question / Q&A chat
12. popup API key input       ← save key to storage
13. Export update             ← include AI summary in .md if available
14. End-to-end test           ← AI flow on 3 different sites
```

---

## Testing Checklist

### Core
- [ ] Highlight text on a static page → note and tags save correctly
- [ ] Refresh page → highlights restore in correct positions
- [ ] Add multiple tags → tag filter in sidebar works
- [ ] Search by note text → correct highlights shown
- [ ] Search by tag name → correct highlights shown
- [ ] Combined tag filter + search → works correctly
- [ ] Export → `.md` file downloads with all highlights
- [ ] Copy to clipboard → clean formatted output
- [ ] Delete a highlight → removed from page and storage
- [ ] Edit a note → changes persist after page reload
- [ ] Page with no highlights → sidebar shows empty state message
- [ ] Multiple highlights on same text → each gets own note/tags

### Add-on (AI Summary)
- [ ] No API key → sidebar shows friendly prompt, rest of extension unaffected
- [ ] Click "Summarize" → Claude returns summary with notes in context
- [ ] Ask a question → Claude answers accurately
- [ ] Export with summary → `.md` includes AI section
- [ ] Very long page → summary still works (text truncated to 6000 words)
- [ ] API error → friendly error shown in sidebar, does not crash
