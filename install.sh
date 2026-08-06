#!/usr/bin/env bash
set -euo pipefail

# Install ocd binary into ~/.local/bin
DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/ocd"
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST_DIR"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "${uname_s}-${uname_m}" in
  Darwin-arm64)  BIN="${ROOT}/dist/ocd-darwin-arm64" ;;
  Darwin-x86_64) BIN="${ROOT}/dist/ocd-darwin-x64" ;;
  Linux-x86_64)  BIN="${ROOT}/dist/ocd-linux-x64" ;;
  Linux-aarch64) BIN="${ROOT}/dist/ocd-linux-arm64" ;;
  *)
    echo "error: unsupported platform ${uname_s}/${uname_m}" >&2
    echo "Build with: bun run build:all" >&2
    exit 1
    ;;
esac

if [[ ! -f "$BIN" ]]; then
  # Fallback to locally-built binary
  if [[ -f "${ROOT}/dist/ocd" ]]; then
    BIN="${ROOT}/dist/ocd"
  else
    echo "error: binary not found at ${BIN}" >&2
    echo "Build first: bun run build:all  (or bun run build)" >&2
    exit 1
  fi
fi

cp "$BIN" "$DEST"
chmod +x "$DEST"
echo "Installed ${DEST}"

case ":${PATH}:" in
  *":${DEST_DIR}:"*) ;;
  *)
    echo "Note: add ${DEST_DIR} to PATH if 'ocd' is not found"
    ;;
esac
