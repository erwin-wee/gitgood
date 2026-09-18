# Development

## Getting started

```bash
npm install
npm run dev          # electron-vite dev server with hot reload
npm test             # vitest: pure unit tests plus fixture tests against real temp git repos
npm run test:unit    # just the pure unit tests (diff parser, patch builder, git output parsers, ...)
npm run test:fixture # git/gh wrapper tests against real temporary repos and a stub gh/claude on PATH
npm run test:smoke   # builds the app and drives it offscreen (no visible window) through real user flows; GITGOOD_SMOKE_SHOW=1 to watch
npm run typecheck    # main + renderer TypeScript
```

`npm run test:smoke` needs a display server on Linux — it uses `xvfb-run` automatically when available (see `scripts/smoke.mjs`), and runs directly against a real display on Windows/macOS or a machine that already has one.

## Code layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the directory map and how the main/renderer processes talk to each other.

## Building packages and cutting a release

See [RELEASING.md](RELEASING.md).
