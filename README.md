# ocd

CLI wrapper around the [OpenCode](https://github.com/sst/opencode) Agent SDK, plus an optional Emacs front-end for multi-turn chat.

- **`ocd`** — one-shot (and streaming) questions from the terminal
- **`opencode-chat.el`** — each Emacs buffer is a session file with live streaming replies

## Requirements

- [Bun](https://bun.sh) (build / run from source)
- A running OpenCode server (auto-started on `127.0.0.1:4097` when needed), or set `OCD_SERVER_URL`
- Emacs 27.1+ for the chat package

## Install

```bash
bun install
bun run build          # → dist/ocd for this platform
./install.sh           # copies binary to ~/.local/bin/ocd
```

Or run from source (recommended if `bun --compile` misbehaves with the SDK):

```bash
# wrapper, e.g. ~/bin/ocd
#!/bin/bash
exec /path/to/bun run /path/to/this/repo/src/ocd.ts "$@"
```

Cross-platform binaries:

```bash
bun run build:all      # darwin/linux × arm64/x64 under dist/
```

## CLI usage

```bash
ocd "what is 2+2?"
ocd file.ts "refactor this"
ocd folder/ "what lives here?"
ocd -p "explain the clipboard"
ocd -s auth "continue"           # named session
ocd -l                           # list named sessions
ocd -v "question"                # reasoning + tools on stderr
ocd --auto "question"            # auto-approve permissions once
```

### Multi-turn stream

```bash
# Human-readable plain text on stdout
echo -e "what is 2+2?\nnow multiply by 3\nquit" | ocd --stream --name math

# JSON Lines for machine clients (Emacs)
ocd --stream --jsonl --name math
```

Exit the loop with `quit`, stdin EOF, or idle SIGINT. Mid-stream SIGINT aborts the current answer and waits for the next prompt.

| Flag | Meaning |
|------|---------|
| `--stream` | Read prompts from stdin, one line per turn |
| `-n, --name` | Session name (**required** with `--stream`) |
| `--jsonl` | Emit `{"type":"session_id"\|"text",...}` lines |
| `--auto` | Auto-approve OpenCode permissions |

## Emacs (`opencode-chat.el`)

1. Put `opencode-chat.el` on `load-path` (or symlink into `~/.emacs.d/private/local/opencode-chat/`).
2. Point `opencode-chat-ocd-program` at your `ocd` wrapper.
3. Optionally enable auto-approve: `(setq opencode-chat-auto-approve t)`.

```elisp
(add-to-list 'load-path "~/path/to/repo") ; or private/local/opencode-chat/
(require 'opencode-chat)
(setq opencode-chat-ocd-program (expand-file-name "~/bin/ocd"))
```

| Command | Binding | Action |
|---------|---------|--------|
| `opencode-chat-open` | — | New anon session (`C-u` → named) |
| `opencode-chat-send` | `C-c C-c` | Send prompt |
| `opencode-chat-abort` | `C-c C-k` | Abort stream |
| `opencode-chat-rename-session` | `C-c C-r` | Rename |
| `opencode-chat-list-sessions` | `C-c C-l` | List via `ocd -l` |
| `opencode-chat-resume` | — | Open existing session file |
| `opencode-chat-kill-session` | — | `quit` + kill buffer |

Sessions live in `~/.opencode-chat/sessions/<name>.md` (file-local vars at **end of file** for restore).

## Environment

| Variable | Meaning |
|----------|---------|
| `OCD_SERVER_URL` | Explicit OpenCode URL (no auto-start on failure) |
| `OCD_VERBOSE` | `1` / `true` — reasoning + tools on stderr |
| `OCD_AUTO` | `1` / `true` — auto-approve permissions |

## Project layout

```
src/ocd.ts           CLI entry (commander)
src/client.ts        OpenCode client / daemon
src/sessions.ts      Named session store (~/.ocd/sessions.json)
src/context.ts       Workspace + prompt parts
src/stream.ts        SSE streaming (+ optional JSONL)
src/permissions.ts   Permission prompts
src/repl.ts          --stream read loop
opencode-chat.el     Emacs major mode
install.sh           Install dist binary to ~/.local/bin
```

## Development

```bash
bun install
bunx tsc --noEmit
bun run src/ocd.ts --help
```

Agent-oriented notes: see [AGENTS.md](./AGENTS.md).

## License

No license file is included yet — add one before making the repo public if you care about redistribution terms.
