#!/usr/bin/env bash
set -euo pipefail

# Install an ocd *wrapper* (bun run src/ocd.ts) into ~/.local/bin.
# Do NOT install a bun --compile binary: it tree-shakes the OpenCode SDK
# and breaks session.prompt / event.subscribe at runtime.

DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/ocd"
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST_DIR"

cat > "$DEST" <<EOF
#!/usr/bin/env bash
exec bun run "${ROOT}/src/ocd.ts" "\$@"
EOF
chmod +x "$DEST"
echo "Installed ${DEST} → bun run ${ROOT}/src/ocd.ts"

case ":${PATH}:" in
  *":${DEST_DIR}:"*) ;;
  *)
    echo "Note: add ${DEST_DIR} to PATH if 'ocd' is not found"
    ;;
esac
