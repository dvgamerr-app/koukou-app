# Koukou — guide for AI coding agents

Koukou is a fork of Coucou (MIT) that keeps only the Tauri app for Windows and Linux. Mochi, a small animated character at the top of the screen, shows AI coding agent sessions (Claude Code, Codex and more) and a few integrations, and lets the user approve, answer, chat and drop files from the island.

## Where things are
- `src/` — front end (TypeScript, no framework): `mochi/`, `island/`, `views/`, `settings/`, `core/`.
- `src-tauri/` — Rust backend (window, named pipe / Unix socket, Claude API, pollers). Platform code is in `src-tauri/src/platform/`.
- `hook/` — `koukou-hook`, the Claude Code relay.
- `sounds/` — the 28 WAV sounds, served and bundled by `vite.config.ts`.
- `scripts/` — icon generator and installer packaging. `docs/` — GitHub Pages site and notes inherited from Coucou. `relay/` — Cloudflare Worker inherited from Coucou.

## Build
```
npm install
npm run tauri dev      # development
npm run pack           # installers in release/
```

## Rules
- Secrets live in the OS keyring, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never approve a Claude Code or Codex permission without an explicit click.
- Do not use TypeScript 7 (typescript-eslint does not support it yet).
- The Coucou name, Mochi character, icons and sounds are not MIT; see `LICENSE-ASSETS.md`.
