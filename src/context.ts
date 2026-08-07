import { existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { TextPartInput } from "@opencode-ai/sdk";
import clipboardy from "clipboardy";

/** Path-only attachment from Emacs `@buffer` mentions (JSONL `prompt`). */
export type StreamAttachment = {
  name: string;
  path: string;
};

/** One multi-turn stream prompt, optionally with file path attachments. */
export type StreamPromptTurn = {
  text: string;
  attachments: StreamAttachment[];
};

export type Workspace = {
  /** OpenCode project root (x-opencode-directory). */
  directory: string;
  /** Absolute file path to attach as context, if any. */
  file?: string;
};

/**
 * Resolve the OpenCode working directory (and optional file) from a CLI path.
 * - folder → directory = that folder
 * - file   → directory = parent folder, file = that file
 * - none   → directory = cwd
 */
export function resolveWorkspace(path: string | undefined): Workspace {
  if (!path) {
    return { directory: process.cwd() };
  }

  try {
    const abs = resolvePath(path);
    const st = statSync(abs);
    if (st.isDirectory()) {
      return { directory: abs };
    }
    if (st.isFile()) {
      return { directory: dirname(abs), file: abs };
    }
    throw new Error("not a file or directory");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("path not found: " + path + (msg ? ` (${msg})` : ""));
  }
}

/**
 * Build prompt parts in order: clipboard → file (if any) → question.
 * Folders are handled via OpenCode directory, not listed into the prompt.
 * Files are always path stubs (never inlined) so the model uses read/edit tools.
 */
export function assembleParts(
  file: string | undefined,
  question: string,
  paste: boolean,
): TextPartInput[] {
  if (!question) {
    throw new Error("question required");
  }

  const parts: TextPartInput[] = [];

  if (paste) {
    try {
      const clipText = clipboardy.readSync();
      if (clipText && clipText.trim().length > 0) {
        parts.push({
          type: "text",
          text: `--- Clipboard ---\n${clipText}`,
        });
      } else {
        console.error("warning: clipboard is empty, skipping");
      }
    } catch {
      console.error("warning: clipboard is empty, skipping");
    }
  }

  if (file) {
    const st = statSync(file);
    parts.push(pathReferencePart(file, st.size));
  }

  parts.push({ type: "text", text: question });
  return parts;
}

/**
 * Build stream-turn parts: path-reference stubs for attachments, then question.
 * Never inlines file bodies — steers the model toward read/edit tools instead
 * of pasting diffs into chat. Missing paths are skipped with a stderr warning.
 */
export function assembleStreamParts(
  text: string,
  attachments: StreamAttachment[] = [],
): TextPartInput[] {
  const question = text.trim();
  if (!question) {
    throw new Error("question required");
  }

  const parts: TextPartInput[] = [];
  for (const att of attachments) {
    const path = typeof att.path === "string" ? att.path.trim() : "";
    if (!path) {
      console.error(
        `warning: attachment "${att.name || "?"}" missing path, skipping`,
      );
      continue;
    }
    if (!existsSync(path)) {
      console.error(`warning: attachment path not found, skipping: ${path}`);
      continue;
    }
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        console.error(`warning: attachment is not a file, skipping: ${path}`);
        continue;
      }
      parts.push(pathReferencePart(path, st.size, att.name));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`warning: cannot attach ${path} (${msg}), skipping`);
    }
  }
  parts.push({ type: "text", text: question });
  return parts;
}

/**
 * Parse a JSONL stdin control line for structured prompts.
 * Returns undefined when the line is not a `prompt` object.
 */
export function parsePromptTurn(line: string): StreamPromptTurn | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "prompt") return undefined;
  if (typeof obj.text !== "string" || obj.text.trim().length === 0) {
    console.error("warning: prompt JSON missing non-empty text, ignoring");
    return undefined;
  }

  const attachments: StreamAttachment[] = [];
  if (Array.isArray(obj.attachments)) {
    for (const raw of obj.attachments) {
      if (typeof raw !== "object" || raw === null) continue;
      const a = raw as Record<string, unknown>;
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (!path) continue;
      const name =
        typeof a.name === "string" && a.name.trim().length > 0
          ? a.name.trim()
          : path;
      attachments.push({ name, path });
    }
  }

  return { text: obj.text.trim(), attachments };
}

/**
 * Point the model at a disk path without embedding contents.
 * Used for one-shot `ocd file.ts …` and stream `@buffer` attachments.
 */
function pathReferencePart(
  path: string,
  size: number,
  label?: string,
): TextPartInput {
  const title = label && label !== path ? `${label} → ${path}` : path;
  return {
    type: "text",
    text:
      `--- File: ${title} (${formatBytes(size)}, path only) ---\n` +
      `Do not assume file contents from this message. ` +
      `Use your file tools to read and edit this path on disk: ${path}`,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
