# START HERE — HierarchyApp Session Bootstrap

Read this file at the start of every session to get full context.
Then read the files it references before doing any work.

---

## What this project is

A Progressive Web App for organizing everything in an infinite hierarchy of categories and items.
Built with vanilla HTML/CSS/JS — no framework, no build tools.

**Live URL:** https://bhargavram0611-arch.github.io/hierarchy-app/
**GitHub repo:** https://github.com/bhargavram0611-arch/hierarchy-app
**Local files:** `D:\projects\simple-hobby\dailyHelp\`

Git is already authenticated. Push with `git push` from the project directory.
After every push, user must **close and reopen the installed PWA** to get the update (service worker lifecycle).

---

## Files to read for context

| File | What it tells you |
|---|---|
| `README.md` | Complete feature list with usage details and data model |
| `progress.md` | Session history, completed work, and what to do next |
| `app.js` | All application logic — read relevant sections before editing |
| `styles.css` | All styling |
| `index.html` | All HTML — modals, overlays, structure |
| `sw.js` | Service worker — bump `CACHE` version on every push |
| `manifest.json` | PWA manifest including share_target |

---

## Key technical facts (memorize these)

- **Service worker cache name:** bump version string in `sw.js` on every code push (currently `hierarchy-v10`)
- **localStorage keys:** `hierarchyApp_enc_v1` (ciphertext), `hierarchyApp_salt_v1` (salt)
- **Encryption:** AES-256-GCM, PBKDF2 200k iterations. Password never stored.
- **Data model:** flat node map — `state.nodes[id]`, navigation via `state.path[]`
- **Node types:** `category` (has `children[]`) and `item` (has `notes`, `links[]`, `schedule`, `done`)
- **Tabs state:** `activeTab` ('tree'|'today'|'future'|'done'), `tabItemId` — module-level vars, not persisted
- **After every save:** call `save()` then `render()`
- **DOM helper:** `$(id)` = `document.getElementById(id)`, `el(tag, cls)` creates an element

---

## Current data model for an item node

```js
{
  id: "<uuid>",
  name: "string",
  type: "item",
  parentId: "<uuid>",
  notes: "string",
  links: [{ id, name, url }],
  schedule: null | { type:"once", date:"YYYY-MM-DD" }
                 | { type:"daily" }
                 | { type:"weekly", days:[0-6] },
  done: false,
  doneDate: null,   // "YYYY-MM-DD" — last completion date for recurring
  doneAt: null,     // timestamp — for once-off items
  createdAt: number
}
```

---

## Workflow for every session

1. Read `README.md` — full feature list, data model, and file descriptions
2. Read `progress.md` — session history, what was last worked on, and planned next steps
3. Read the relevant source files before making any changes
4. After coding: bump SW cache in `sw.js`, run `node --check app.js`, then `git add / commit / push`
5. Update `progress.md` with what was done this session and any new ideas or next steps
