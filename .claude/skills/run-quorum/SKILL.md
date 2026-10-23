---
name: run-quorum
description: Build, run, and drive the Quorum Electron desktop app. Use when asked to start the app, screenshot it, or interact with its UI.
---

Quorum is an Electron desktop app (main = CJS via tsc, renderer = Vite/React).
For agent/automated use, drive it via the Playwright REPL under
`.claude/skills/run-quorum/driver.mjs`.

## Build

```bash
npm install
npm run build:main      # tsc → dist/main, dist/preload, dist/shared (CommonJS)
npm run build:renderer  # vite → dist/renderer
```

## Run (agent path)

```bash
node .claude/skills/run-quorum/driver.mjs
# then: launch → ss <name> → emit <json> → quit
```

Or the one-shot UI check (launches, injects synthetic events, screenshots):

```bash
SCREENSHOT_DIR=/tmp/shots node scripts/verify-ui.mjs
```

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app (no live sessions), wait for `.app` |
| `ss [name]` | screenshot → `$SCREENSHOT_DIR/<name>.png` |
| `emit <json>` | inject a synthetic QuorumEvent into the renderer store |
| `click <sel>` / `type <text>` / `text [sel]` | interact / read |
| `quit` | close, exit |

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1` in the environment** makes Electron run as plain
  Node — no window, and `require('electron')` returns a path string (so
  `app.isPackaged` throws). The driver and verify script `delete` it from the
  child env. If you launch Electron by hand, prefix with `env -u ELECTRON_RUN_AS_NODE`.
- **Dev vs prod load:** unpackaged, the app loads `http://localhost:5173` (Vite).
  For a standalone launch without the dev server, set `QUORUM_PROD=1` to load
  `dist/renderer` from disk.
- **No-quota UI mode:** `QUORUM_NO_SESSIONS=1` renders the roster/panels without
  spawning `claude` child sessions. The driver sets this by default.
- **The Agent SDK is ESM-only**; the CJS main loads it via dynamic `import()`
  (see `src/session.ts`, `src/tools.ts`). Don't convert those back to static imports.
