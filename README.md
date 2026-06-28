# HierarchyApp

A Progressive Web App for organizing everything in an infinite hierarchy of categories and items. Works offline, installable on mobile, and fully encrypted.

**Live app:** https://bhargavram0611-arch.github.io/hierarchy-app/

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript — no framework, no build tools |
| Storage | `localStorage` (AES-256-GCM encrypted) |
| Offline | Service Worker (cache-first) |
| Hosting | GitHub Pages (HTTPS required for PWA install) |
| Crypto | Web Crypto API — PBKDF2 key derivation + AES-GCM encryption |

---

## Features

### 1. Infinite Hierarchy
- Create **categories** (folders) and **items** (leaves) at any depth
- Navigate by tapping a category to go into it
- **Breadcrumb bar** shows your current path; tap any crumb to jump back
- **Back button** in the header navigates up one level

### 2. Item Detail — Notes
- Tap any item to open its detail view
- Full-screen **notes textarea** with auto-save (saves 600ms after you stop typing)
- "✓ Saved" confirmation appears briefly after each save
- First line of notes is shown as a preview on the item card in the list

### 3. Multiple Links per Item
- Each item can hold **unlimited links** (URLs), each with a custom name
- Inside an item, tap **"Add Link"** → paste a URL → name is auto-detected from the platform
- Change the name to anything you want
- Links are numbered (1. 2. 3…)
- **YouTube links** show the actual video thumbnail (fetched from img.youtube.com — no API key needed)
- **Instagram / Facebook / TikTok / X / other** links show a coloured platform icon card
- Tap a link card → opens in browser
- ✎ button → rename the link
- ✕ button → delete the link
- Link count is shown in the item card subtitle in the list

### 4. Drag to Reorder
- Every card has a **drag handle** (⠿ dots) on the left
- Drag any item or category up or down to reorder within its parent
- Works on both touch (mobile) and mouse (desktop) via the Pointer Events API
- A blue line indicator shows where the card will drop

### 5. Global Search
- Tap the **🔍 search icon** in the header
- Searches **all items and categories** across every level simultaneously
- Matches against both **name** and **notes**
- Results show the full **path** (e.g. Work › Projects › Design)
- Matching text is **highlighted** in results
- A **note snippet** with context is shown for note matches
- Tap a result to navigate directly to that item/category

### 6. Move Item or Category
- Tap **⋮** on any card → **Move to…**
- A searchable list of all categories appears
- Tap the destination category to move it there instantly
- The current parent is labelled "current" and is not selectable

### 7. Password Encryption
- On first launch, you are asked to **set a password** (minimum 4 characters)
- All data is encrypted with **AES-256-GCM** before being written to localStorage
- The password is **never stored** — only a random salt and the ciphertext are saved
- The AES-GCM authentication tag acts as implicit password verification (wrong password causes decrypt to fail, not return garbage)
- Key derivation uses **PBKDF2 with 200,000 SHA-256 iterations** (OWASP 2024 recommendation)
- Every app open shows a **lock screen** — enter your password to decrypt and load data
- **Lock App** button (🔒 in the header → Security) instantly locks and clears the key from memory
- **Change Password** re-derives a new key and re-encrypts all data

### 8. Web Share Target (Share URLs from other apps)
- When the app is **installed** on Android, it appears in the system share sheet
- Share any link from Instagram, YouTube, Facebook, TikTok, or any website → tap **HierarchyApp**
- The app opens with a **"Save Link" dialog** pre-filled with the URL and auto-detected name
- Choose which category to save to (defaults to Home / root)
- Saves as a new item with the URL stored as its first link
- On iOS 17+, partial support via the same mechanism

### 9. Schedule System
Items can have a schedule, making them appear in the Today / Upcoming / Done views.

**Schedule types:**
| Type | Behaviour |
|---|---|
| **Once** | Appears on the specific date you pick. If the date has passed and it's not done, it shows as Overdue in Today. |
| **Every day** | Appears in Today every single day until marked done for that day. |
| **Weekly** | Choose specific days (e.g. Mon + Wed + Fri). Appears in Today on those days. |

**Setting a schedule:**
- Open any item → tap **📅 Set schedule** at the top of the detail view
- Pick Once / Every day / Weekly
- For Once: date picker appears
- For Weekly: tap the day buttons to toggle them (they highlight when selected)
- Tap Save

**The four tabs** (bar below the header):

| Tab | Shows |
|---|---|
| **All** | Normal hierarchy tree — browse categories as usual |
| **Today** | All items due today (once with date ≤ today + recurring matches) — red badge shows count |
| **Upcoming** | Once-off items with a future date, sorted by date |
| **Done** | Once-off items marked as completed, newest first |

**Marking done:**
- In Today tab: tap the ○ circle on a card — it fills ✓ and the card leaves Today
- In item detail: tap **"Mark done"** button next to the schedule chip
- **Once** items: move permanently to Done tab; show strikethrough in the category list
- **Daily / Weekly** items: disappear for today, reappear tomorrow / next matching day

**Overdue items** (once-off with past date, not done) appear in Today with a red chip.

**Strikethrough:** Completed items show a strikethrough on their name in the hierarchy list view.

---

## Data Model

All data lives in a flat node map in `localStorage` (encrypted):

```
state = {
  nodes: {
    "root": { id, name, type: "category", parentId: null, children: [...ids] },
    "<uuid>": {
      id, name, type: "category" | "item",
      parentId, children?,          // categories only
      notes?,                       // items only
      links?: [{ id, name, url }],  // items only
      schedule?: {
        type: "once" | "daily" | "weekly",
        date?: "YYYY-MM-DD",        // once only
        days?: [0,1,2,3,4,5,6]     // weekly only (0=Sun)
      },
      done?: boolean,
      doneDate?: "YYYY-MM-DD",      // last completion date (recurring)
      doneAt?: number,              // timestamp (once-off)
      createdAt: number
    }
  },
  path: ["root", ...ids]            // current navigation breadcrumb
}
```

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell — all HTML elements, modals, overlays |
| `app.js` | All application logic — state, render, crypto, events |
| `styles.css` | Mobile-first CSS with dark mode (`prefers-color-scheme`) |
| `sw.js` | Service worker — cache-first offline strategy |
| `manifest.json` | PWA manifest — icons, display, share target |
| `icon.svg` | App icon (hierarchy tree SVG) |

---

## Installing on Mobile

**Android (Chrome):**
1. Open the app URL in Chrome
2. Tap the three-dot menu → "Add to Home screen"
3. The app installs and appears as a standalone app
4. Share URLs from other apps: tap Share → HierarchyApp

**iOS (Safari):**
1. Open the app URL in Safari
2. Tap the Share icon → "Add to Home Screen"
3. Works as a standalone app; share target has partial support on iOS 17+

---

## Updating the App

Every code push bumps the service worker cache version. After a push:
- Close the app completely (remove from recent apps on mobile)
- Reopen — the new version loads automatically
