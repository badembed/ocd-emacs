# AGENTS.md — notes for coding agents

Last updated: 2026-08-07.

Human-facing docs: [README.md](./README.md).

## Scope

`ocd` = Bun/TypeScript CLI on `@opencode-ai/sdk`.  
`opencode-chat.el` = Emacs multi-turn UI over `ocd --stream --jsonl`.

Do **not** add: TUI, MCP/tool rendering, multimodal, Windows-specific code, heredoc multi-line protocol, startup session scans, auto-approve by default.

## Stream protocol

| Mode | stdout |
|------|--------|
| `ocd --stream` (default) | plain assistant text; TTY permissions on stderr (`y`/`a`/`n`) |
| `ocd --stream --jsonl` | `session_id` / `text` / `permission` JSON lines |

Emacs always passes `--jsonl`. Chat prompts are **one plain line** each (`quit` / EOF / idle SIGINT end the loop).

### JSONL permission handshake

Permission mode with `--jsonl` (unless `--auto`): stdin demux stays active during streams.

```text
← {"type":"permission","id":"…","permission":"bash","title":"…","patterns":["…"]}
→ {"type":"permission_reply","id":"…","response":"once"|"always"|"reject"}
```

- `permission_reply` lines are never chat prompts.
- Plain text lines during an in-flight stream are queued as the next prompts.
- `--auto` / `opencode-chat-auto-approve` skips the handshake (approve once).

## Emacs session files

- Path: `~/.opencode-chat/sessions/<name>.md`
- Live mark: text-property `opencode-response` (source of truth for prompt bounds)
- Persist: trailing `;; Local Variables:` with `opencode-chat--bounds` recomputed on save from properties
- Local Variables **must stay at end of file** (Emacs only scans the last ~3kB)

## Important implementation rules

1. No `process.exit()` inside `try` before `finally` cleanup.
2. Expected errors → stderr message + non-zero exit; no stack traces.
3. Strict TS: no `any` / `@ts-ignore` / `@ts-expect-error`.
4. User state only under `~/.ocd/` and `~/.opencode-chat/` — never commit it.
5. Do not commit `dist/`, `.omo/`, `*.elc`, `node_modules/`.
6. Process filters must `with-current-buffer (process-buffer proc)`.
7. `flushSessionText` must emit only the **latest** assistant message.
8. Persistent daemon on `:4097` must not be killed from `closeSpawnedServer()`.
9. With `--jsonl`, permission asks use stdout/stdin JSONL — never silent reject.
10. Stdin demux must keep reading during `streamResponse` so `permission_reply` can arrive.

## Known limitations

- `bun build --compile` may drop SDK methods; prefer `bun run src/ocd.ts` or a thin wrapper script.
- Compiled binary size is large (~90MB+); that is expected for `--compile`.

## Quality checks

```bash
bunx tsc --noEmit
bun run src/ocd.ts --help
printf '' | bun run src/ocd.ts --stream --name eoftest   # exit quickly
echo quit | bun run src/ocd.ts --stream --name quittest
emacs -Q -L . -l opencode-chat.el --batch --eval '(byte-compile-file "opencode-chat.el")'
```
