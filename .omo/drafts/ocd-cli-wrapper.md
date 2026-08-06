# ocd-cli-wrapper — Draft

- **intent**: clear
- **review_required**: false
- **status**: approved
- **slug**: ocd-cli-wrapper
- **created**: 2026-08-06

## Decisions

| # | Fork | Decision | Rationale |
|---|------|----------|-----------|
| 1 | Language/runtime | TypeScript + Bun | `@opencode-ai/sdk` is TypeScript-native; bun compiles to single binary |
| 2 | Output mode | Real-time streaming | SSE `message.part.updated` deltas → stdout |
| 3 | Scope | Full feature set | file, folder, -p clipboard, -s sessions, --list-sessions |
| 4 | Test strategy | Agent-executed QA | Run binary against real opencode sessions |
| 5 | Packaging | `bun build --compile` | Single binary, no Node.js dep, macOS+Linux |
| 6 | Sessions | Named (`-s auth`), auto-create+resume | Mapping in `~/.ocd/sessions.json` |
| 7 | Clipboard | `-p` flag, `clipboardy` package | Cross-platform (pbpaste/xclip/wl-paste/PowerShell) |
| 8 | OpenCode discovery | PATH → OPENCODE_BIN_PATH → OCD_SERVER_URL | Compatible with custom builds/forks |

## Components

| # | Component | Outcome | Status |
|---|-----------|---------|--------|
| 1 | CLI argument parser | Parses `ocd [file|folder] ["q"]`, `-s`, `-p`, `--list-sessions` | pending |
| 2 | OpenCode client | `createOpencode()` or `createOpencodeClient({ baseUrl })` with SSE streaming | pending |
| 3 | Context assembly | Injects file content, folder listing, clipboard text into prompt parts | pending |
| 4 | Output rendering | Streams text deltas to stdout, handles errors | pending |
| 5 | Session manager | Named-session CRUD in `~/.ocd/sessions.json` | pending |
| 6 | Build & cross-platform | `bun build --compile` for macOS arm64/x64 + Linux x64/arm64 | pending |

## Approval gate

- Approved by user: "пиши план"
- Next: scaffold plan skeleton, run Metis, append todos
