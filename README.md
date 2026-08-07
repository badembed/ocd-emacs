# ocd

CLI wrapper around the [OpenCode](https://github.com/sst/opencode) Agent SDK, plus an optional Emacs front-end for multi-turn chat.

- **`ocd`** — one-shot (and streaming) questions from the terminal
- **`opencode-chat.el`** — each Emacs buffer is a session file with live streaming replies

## Requirements

| Tool | Why |
|------|-----|
| [Bun](https://bun.sh) | Run `ocd` from source (`bun run`) |
| [OpenCode](https://github.com/sst/opencode) CLI (`opencode` on `PATH`) | Daemon `opencode serve --pure` on `:4097` (auto-started by `ocd`) |
| Emacs 27.1+ / [Spacemacs](https://www.spacemacs.org/) | Optional front-end (`opencode-chat.el`) |

Configure OpenCode providers/auth the usual way (`opencode` itself) before expecting answers from models.

## Setup on a new machine

### 1. Install prerequisites

```bash
# Bun — https://bun.sh
curl -fsSL https://bun.sh/install | bash

# OpenCode CLI — follow upstream install docs, then:
opencode --version
# log in / configure providers as required by your OpenCode setup
```

Ensure `bun` and `opencode` are on your `PATH` in both shells and GUI Emacs (macOS GUI apps often miss `~/bin` — set `exec-path` / `PATH` in Emacs if needed).

### 2. Clone and install dependencies

```bash
git clone https://github.com/badembed/ocd-emacs.git ~/src/ocd-emacs
cd ~/src/ocd-emacs
bun install
```

### 3. Install the `ocd` command (wrapper only)

Use a thin shell wrapper that runs the TypeScript entry with Bun. **Do not use
`bun build --compile` / `dist/ocd` for real work** — the bundler tree-shakes the
OpenCode SDK client and drops methods such as `session.prompt` /
`event.subscribe`, so streaming and prompts fail at runtime.

```bash
mkdir -p ~/bin
cat > ~/bin/ocd <<'EOF'
#!/usr/bin/env bash
# Point REPO at your clone:
REPO="${OCD_REPO:-$HOME/src/ocd-emacs}"
exec bun run "$REPO/src/ocd.ts" "$@"
EOF
chmod +x ~/bin/ocd
```

Or from the repo: `./install.sh` (installs the same wrapper to `~/.local/bin/ocd`).

Add `~/bin` (or `~/.local/bin`) to `PATH` (e.g. in `~/.zshrc`: `export PATH="$HOME/bin:$PATH"`).

Ensure `which ocd` resolves to that wrapper — not an old compiled binary under
`~/tools/ocd` or `dist/`.

### 4. Smoke-test the CLI

```bash
ocd --help
ocd "what is 2+2?"                 # starts daemon on :4097 if needed
echo quit | ocd --stream --name smoke
```

Named CLI sessions are stored under `~/.ocd/`. Override the server with `OCD_SERVER_URL` if you already run OpenCode elsewhere.

### 5. Emacs / Spacemacs (`opencode-chat`)

#### Plain Emacs

```elisp
(add-to-list 'load-path "~/src/ocd-emacs") ; directory that contains opencode-chat.el
(require 'opencode-chat)
(setq opencode-chat-ocd-program (expand-file-name "~/bin/ocd"))
;; optional:
;; (setq opencode-chat-auto-approve t)
```

#### Spacemacs

1. Symlink the package into the private local tree (survives layer reloads):

```bash
mkdir -p ~/.emacs.d/private/local/opencode-chat
ln -sf ~/src/ocd-emacs/opencode-chat.el \
  ~/.emacs.d/private/local/opencode-chat/opencode-chat.el
```

2. In `.spacemacs`, inside `dotspacemacs/user-config`:

```elisp
(defun dotspacemacs/user-config ()
  ;; …your other config…

  (add-to-list 'load-path
               (expand-file-name "~/.emacs.d/private/local/opencode-chat"))
  (require 'opencode-chat)
  (setq opencode-chat-ocd-program (expand-file-name "~/bin/ocd"))
  ;; (setq opencode-chat-auto-approve t)

  ;; Optional Spacemacs leader bindings (SPC o c …)
  (spacemacs/declare-prefix "o c" "opencode-chat")
  (spacemacs/set-leader-keys
    "o c o" #'opencode-chat-open
    "o c s" #'opencode-chat-send
    "o c k" #'opencode-chat-abort
    "o c r" #'opencode-chat-rename-session
    "o c l" #'opencode-chat-list-sessions
    "o c u" #'opencode-chat-resume
    "o c q" #'opencode-chat-kill-session))
```

3. Restart Emacs / Spacemacs (`SPC q r`) or `M-x load-file` the package, then:

- `M-x opencode-chat-open` (or `SPC o c o`) — new chat buffer  
- type a prompt, `C-c C-c` (or `SPC o c s`) to send  

Chat files live in `~/.opencode-chat/sessions/<name>.md`. Emacs talks to `ocd` as:

`ocd --stream --jsonl --name <session> [--auto]`

When OpenCode asks for a permission, Emacs shows `read-multiple-choice`
(`once` / `always` / `reject`) and replies over JSONL. With
`opencode-chat-auto-approve` non-nil, `ocd` gets `--auto` and skips the prompt.

If the buffer says there is no subprocess, `opencode-chat-ocd-program` is wrong or not executable — check with `M-: (executable-find opencode-chat-ocd-program)`.

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

With `--jsonl`, permission asks are machine-readable:

```text
← {"type":"permission","id":"…","permission":"bash","title":"…"}
→ {"type":"permission_reply","id":"…","response":"once"}
```

In a plain TTY `--stream` (no `--jsonl`), permissions use stderr prompts (`y`/`a`/`n`).

| Flag | Meaning |
|------|---------|
| `--stream` | Read prompts from stdin, one line per turn |
| `-n, --name` | Session name (**required** with `--stream`) |
| `--jsonl` | Emit `session_id` / `text` / `permission` JSON lines |
| `--auto` | Auto-approve OpenCode permissions |

## Emacs reference (`opencode-chat.el`)

Install steps: [Setup on a new machine](#setup-on-a-new-machine). In-buffer keys:

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
src/errors.ts        SDK error formatting
src/repl.ts          --stream read loop
opencode-chat.el     Emacs major mode
install.sh           Install bun-run wrapper to ~/.local/bin
```

## Development

```bash
bun install
bunx tsc --noEmit
bun run src/ocd.ts --help
# Prefer bun run / the wrapper. Do not rely on bun build --compile.
```

Agent-oriented notes: see [AGENTS.md](./AGENTS.md).

## License

No license file is included yet — add one before making the repo public if you care about redistribution terms.
