# Progress Log — HierarchyApp

Update this file at the end of every session. Add a new entry under Session History.

---

## Current State (as of 2026-06-30)

The app is fully functional and deployed. All core features are working.
SW cache is at `hierarchy-v12`. Session closed cleanly — no pending work.

**What works:**
- Full hierarchy navigation (infinite nesting)
- Item notes with auto-save
- Multiple links per item (YouTube thumbnails + platform icons)
- Drag to reorder (items and categories)
- Global search (names + notes)
- Move item/category to any other category
- AES-256-GCM password encryption with lock screen
- Web Share Target (share URLs from Instagram/YouTube/etc. into the app)
- Schedule system (once / daily / weekly) with Today / Upcoming / Done tabs
- Completed items show strikethrough in hierarchy list
- Track tab — lap-based streak tracker (Start/Stop, live counter, history)

---

## Session History

### Session 2 — 2026-06-30
**Added:**
- Track tab (5th tab) — lap-based streak/reset tracker
- Start button begins counting days and hours from current moment
- Stop button freezes the run, saves to history, resets to idle
- Only one active run at a time; live counter updates every 30 seconds
- History list shows all past runs: run #, total duration, date range
- Delete button on each history run (confirms before removing)
- Data stored in encrypted state (`state.runs[]`) alongside existing data
- SW cache bumped to `hierarchy-v12`

---

### Session 1 — 2026-06-29
**Built from scratch:**
- Project scaffolding (index.html, app.js, styles.css, sw.js, manifest.json, icon.svg)
- Core hierarchy: categories, items, infinite nesting, breadcrumb navigation
- GitHub repo created and deployed to GitHub Pages
- PWA manifest + service worker for installability

**Added iteratively:**
1. Item notes editor (auto-save, save status indicator)
2. Drag-to-reorder (Pointer Events API, works on touch and mouse)
3. Global search (names + notes, path display, snippet highlight)
4. Password encryption (AES-256-GCM, PBKDF2, lock screen, change password)
5. Move item/category to another category
6. Web Share Target — share URLs from other apps into the hierarchy
7. Multiple links per item — custom names, YouTube thumbnails, platform icons, add/rename/delete
8. Schedule system — once/daily/weekly, Today/Upcoming/Done tabs, mark done, overdue indicator
9. Strikethrough on completed items in hierarchy list view
10. README.md with full feature documentation
11. starthere.md and progress.md (this file)

---

## Ideas / Planned Features

These were discussed with the user. Pick from here in future sessions.

| Feature | Notes |
|---|---|
| **Checkboxes on items** | Toggle done/pending, show completion count on category cards |
| **Custom emoji icon** | Let user set any emoji as icon for category or item |
| **Color labels** | Tag items/categories with a color dot for visual grouping |
| **Sort options** | Sort children by name A→Z, date created, or manual (current drag order) |
| **Collapse categories** | Fold/unfold a category in-place without navigating into it |
| **Export / Import** | Download data as JSON for backup; import to restore (localStorage can be wiped by OS) |
| **Undo delete** | 5-second toast with Undo button after deleting anything |
| **Accent color picker** | Choose theme color instead of always indigo |
| **Image attachments** | Store images via IndexedDB (base64 or blob); share target already captures URLs |
| **Pin to top** | Pin important items or categories so they always appear first |
| **Rich text / Markdown** | Basic markdown rendering in notes (bold, italic, lists) |

---

## Known Issues / Watch Out For

- After every push, user must **close and reopen** the installed PWA (SW cache lifecycle)
- Web Share Target only works when the app is **installed** (not from browser tab)
- iOS share target has partial support (iOS 17+)
- `migrateData()` runs on every `sanitizePath()` call — it's idempotent so fine, but worth noting
- `activeTab` and `tabItemId` are module-level vars (not in encrypted state) — they reset on every lock/unlock
