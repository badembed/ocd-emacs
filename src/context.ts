import {
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import type { TextPartInput } from "@opencode-ai/sdk";
import clipboardy from "clipboardy";

/**
 * Build prompt parts in order: clipboard → file/folder → question.
 * Returns `TextPartInput[]` for the prompt body.
 */
export function assembleParts(
  path: string | undefined,
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

  if (path) {
    try {
      const stat = statSync(path);
      if (stat.isFile()) {
        const content = readFileSync(path, "utf-8");
        if (content.includes("\0")) {
          console.error("cannot read binary file: " + path);
          throw new Error("cannot read binary file: " + path);
        }
        parts.push({
          type: "text",
          text: `--- File: ${path} ---\n${content}`,
        });
      } else if (stat.isDirectory()) {
        const entries = readdirSync(path);
        parts.push({
          type: "text",
          text: `--- Folder: ${path} ---\n${entries.join("\n")}`,
        });
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.startsWith("cannot read binary file")
      ) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error("path not found: " + path + (msg ? ` (${msg})` : ""));
    }
  }

  parts.push({ type: "text", text: question });
  return parts;
}
