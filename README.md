# GATE PYQ Tracker

Web version of my GATE CSE PYQ sheet (GATE Overflow Vol 1 + Vol 2, 2580 questions).
Use it from any laptop with a password, no Google login needed. Progress is stored in Neon Postgres.

## Deploy (Render + Neon)
1. Neon: create a database (e.g. `gate_pyq`) and copy its connection string.
2. Push this folder to GitHub, then in Render go to **New → Blueprint** and pick the repo (it reads `render.yaml`).
3. Set the env vars:
   - `DATABASE_URL`: Neon connection string
   - `APP_PASSWORD`: the password you'll type on each laptop
   - `SESSION_SECRET`: Render generates this for you
4. On first boot the app creates the table and loads `data/questions.json` into it.

## Local run
```
npm install
$env:DATABASE_URL="..."; $env:APP_PASSWORD="..."; $env:SESSION_SECRET="anything"; npm start
```

## Features
- Dashboard: per-subject Solved / Wrong / Shaky / Unsolved, % solved, and how many ★ questions are still pending
- Question list: filter by subject, topic, volume, status, difficulty, ★, and free-text search
- One-click status buttons (U/S/W/K). Last-attempted gets stamped automatically. Notes save when you leave the box.
- Export CSV for a backup
- Reloads data when you come back to the tab, so changes from the other laptop show up

`scripts/extract_xlsx.py` regenerates `data/questions.json` from the original xlsx.

## PDFs + annotations
- PDFs live in Postgres (`pdf_files`), not in git. To (re)upload, put `volume1.pdf` / `volume2.pdf` in this folder and run
  `node --env-file=.env scripts/upload_pdfs.js` (skips unchanged files).
- Clicking 📄 on a question opens `/viewer.html?vol=vol2&page=57`: PDF.js viewer with pen (blue/red/green),
  highlighter, eraser, undo/redo. Keys: V hand, P pen, H highlighter, E eraser, Ctrl+Z / Ctrl+Y.
- Strokes are saved per page in the `annotations` table (autosave; queued in localStorage while offline).
- The bottom bar lists the questions on the current page with status buttons.
- "Annotated PDF" bakes your marks into a downloadable copy (originals are never modified).
