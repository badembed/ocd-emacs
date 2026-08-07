import {
  existsSync,
  readFileSync,
  readSync,
  openSync,
  closeSync,
  statSync,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { TextPartInput } from "@opencode-ai/sdk";
import clipboardy from "clipboardy";

/** Files larger than this are sent as path + metadata, not full contents. */
export const INLINE_MAX_BYTES = 4 * 1024;

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
 * Small files are inlined; large files are referenced by path only.
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
    parts.push(filePart(file, st.size));
  }

  parts.push({ type: "text", text: question });
  return parts;
}

/**
 * Build stream-turn parts: path attachments (via disk `filePart`) then question.
 * Missing paths are skipped with a stderr warning. No attachment `content`
 * field — OpenCode reads/edits files on disk.
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
      parts.push(filePart(path, st.size));
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

function filePart(path: string, size: number): TextPartInput {
  if (size > INLINE_MAX_BYTES) {
    assertNotBinary(path, size);
    console.error(
      `warning: ${path} is ${formatBytes(size)} (>${formatBytes(INLINE_MAX_BYTES)}), sending path only`,
    );
    return {
      type: "text",
      text:
        `--- File: ${path} (${formatBytes(size)}, not inlined) ---\n` +
        `This file is too large to embed in the prompt. ` +
        `Read it with your file tools as needed (path: ${path}).`,
    };
  }

  const content = readFileSync(path, "utf-8");
  if (content.includes("\0")) {
    console.error("cannot read binary file: " + path);
    throw new Error("cannot read binary file: " + path);
  }
  return {
    type: "text",
    text: `--- File: ${path} ---\n${content}`,
  };
}

/** Peek at the start of a large file to reject binaries without a full read. */
function assertNotBinary(path: string, size: number): void {
  const peekLen = Math.min(8192, size);
  if (peekLen <= 0) return;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(peekLen);
    readSync(fd, buf, 0, peekLen, 0);
    if (buf.includes(0)) {
      console.error("cannot read binary file: " + path);
      throw new Error("cannot read binary file: " + path);
    }
  } finally {
    closeSync(fd);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
