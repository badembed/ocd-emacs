import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";
import { setActiveAbort, clearActiveAbort } from "./client";
import {
  handlePermission,
  normalizePermissionEvent,
  type PermissionMode,
  type WaitPermissionReply,
} from "./permissions";
import { formatSdkError } from "./errors";

const STREAM_TIMEOUT_MS = 120_000;

export type StreamOptions = {
  /** Log reasoning + tool calls to stderr (`-v` / `OCD_VERBOSE`). */
  verbose?: boolean;
  /** How to answer OpenCode permission.updated prompts. */
  permissionMode?: PermissionMode;
  /**
   * Emit assistant text as JSON Lines for machine clients (Emacs
   * `opencode-chat.el`). Each chunk becomes
   * `{"type":"text","text":"..."}\n`. Plain CLI mode (default) keeps
   * raw text on stdout.
   */
  jsonl?: boolean;
  /**
   * Wait for a JSONL `permission_reply` from the stdin demux (Emacs).
   * Required when `permissionMode` is `jsonl`.
   */
  waitPermissionReply?: WaitPermissionReply;
};

/** Write assistant text to stdout in plain or JSONL form. */
function writeStdoutText(text: string, jsonl: boolean): void {
  if (!text) return;
  if (jsonl) {
    process.stdout.write(JSON.stringify({ type: "text", text }) + "\n");
  } else {
    process.stdout.write(text);
  }
}

/** Terminate a plain-text response; no-op in JSONL mode (each event is a line). */
function writeStdoutEnd(jsonl: boolean): void {
  if (!jsonl) {
    process.stdout.write("\n");
  }
}

/**
 * Send a prompt via `promptAsync` and stream the answer to stdout via SSE.
 * Falls back to batch `prompt()` if promptAsync is unavailable.
 */
export async function streamResponse(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
  options: StreamOptions = {},
): Promise<void> {
  const verbose = options.verbose === true;
  const jsonl = options.jsonl === true;
  const permissionMode: PermissionMode =
    options.permissionMode ?? "reject";
  const waitPermissionReply = options.waitPermissionReply;
  const controller = new AbortController();
  const { signal } = controller;

  setActiveAbort(() => {
    if (!signal.aborted) controller.abort();
    void client.session.abort({ path: { id: sessionID } }).catch(() => {});
  });

  try {
    // Subscribe BEFORE prompting to avoid missing early SSE events.
    let sub: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> | undefined;
    try {
      sub = await client.event.subscribe({
        signal,
      } as Parameters<OpencodeClient["event"]["subscribe"]>[0]);
    } catch (err: unknown) {
      if (signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `warning: event subscribe failed (${msg}), using batch mode`,
      );
      await batchPrompt(client, sessionID, parts, jsonl);
      return;
    }

    let promptSent = false;
    try {
      const result = await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts },
      });
      if (result.error) {
        throw new Error(formatSdkError(result.error));
      }
      promptSent = true;
    } catch (err: unknown) {
      if (signal.aborted) throw err;
      if (!promptSent) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `warning: promptAsync unavailable (${msg}), using batch mode`,
        );
        await batchPrompt(client, sessionID, parts, jsonl);
        return;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    const seenText = new Map<string, string>();
    const seenReasoning = new Map<string, string>();
    const roles = new Map<string, "user" | "assistant">();
    /** Part IDs known to be assistant answer text (not reasoning/tool). */
    const textPartIDs = new Set<string>();
    /** Part IDs known to be reasoning (stderr when verbose). */
    const reasoningPartIDs = new Set<string>();
    /** Tool parts that already logged a start / end line (dedupe SSE updates). */
    const toolStarted = new Set<string>();
    const toolFinished = new Set<string>();
    const answeredPermissions = new Set<string>();
    let sawAssistantText = false;
    let reasoningOpen = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((err: Error) => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const armTimeout = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        rejectTimeout?.(
          new Error(
            `timed out after ${STREAM_TIMEOUT_MS / 1000}s waiting for OpenCode response`,
          ),
        );
      }, STREAM_TIMEOUT_MS);
    };
    const pauseTimeout = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    armTimeout();

    const isUserMessage = (messageID: string): boolean =>
      roles.get(messageID) === "user";

    const writeAssistantText = (partID: string, chunk: string): void => {
      if (!chunk) return;
      if (verbose && reasoningOpen) {
        process.stderr.write("\n");
        reasoningOpen = false;
      }
      writeStdoutText(chunk, jsonl);
      seenText.set(partID, (seenText.get(partID) ?? "") + chunk);
      sawAssistantText = true;
    };

    const writeReasoning = (partID: string, chunk: string): void => {
      if (!verbose || !chunk) return;
      process.stderr.write(chunk);
      seenReasoning.set(partID, (seenReasoning.get(partID) ?? "") + chunk);
      reasoningOpen = true;
    };

    const streamLoop = (async () => {
      for await (const event of sub!.stream) {
        if (signal.aborted) return;

        // Newer OpenCode emits this; @opencode-ai/sdk@1.18 types omit it.
        if ((event as { type: string }).type === "message.part.delta") {
          const props = (
            event as unknown as {
              properties: {
                sessionID: string;
                messageID: string;
                partID: string;
                field: string;
                delta: string;
              };
            }
          ).properties;
          if (
            props.sessionID === sessionID &&
            !isUserMessage(props.messageID) &&
            props.field === "text"
          ) {
            if (textPartIDs.has(props.partID)) {
              writeAssistantText(props.partID, props.delta);
            } else if (reasoningPartIDs.has(props.partID)) {
              writeReasoning(props.partID, props.delta);
            }
          }
          continue;
        }

        // permission.asked (current) / permission.updated (SDK 1.18 types)
        {
          const et = (event as { type: string }).type;
          if (et === "permission.asked" || et === "permission.updated") {
            const perm = normalizePermissionEvent(
              et,
              (event as { properties: unknown }).properties,
            );
            if (perm && perm.sessionID === sessionID) {
              pauseTimeout();
              try {
                await handlePermission({
                  client,
                  sessionID,
                  perm,
                  mode: permissionMode,
                  signal,
                  answered: answeredPermissions,
                  waitPermissionReply,
                });
              } finally {
                if (!signal.aborted) armTimeout();
              }
            }
            continue;
          }
        }

        switch (event.type) {
          case "message.updated": {
            const info = event.properties.info;
            if (info.sessionID !== sessionID) break;
            if (info.role === "user" || info.role === "assistant") {
              roles.set(info.id, info.role);
            }
            break;
          }
          case "message.part.updated": {
            const part = event.properties.part;
            if (part.sessionID !== sessionID) break;
            // OpenCode often emits assistant text parts BEFORE message.updated
            // sets role=assistant. Skip only known user messages.
            if (isUserMessage(part.messageID)) break;

            if (part.type === "text") {
              textPartIDs.add(part.id);
              if (part.synthetic === true || part.ignored === true) break;

              const delta = event.properties.delta;
              if (delta !== undefined && delta.length > 0) {
                writeAssistantText(part.id, delta);
              } else {
                const prev = seenText.get(part.id) ?? "";
                if (part.text.startsWith(prev)) {
                  writeAssistantText(part.id, part.text.slice(prev.length));
                  seenText.set(part.id, part.text);
                } else if (part.text) {
                  writeAssistantText(part.id, part.text);
                  seenText.set(part.id, part.text);
                }
              }
            } else if (part.type === "reasoning" && verbose) {
              reasoningPartIDs.add(part.id);
              const delta = event.properties.delta;
              if (delta !== undefined && delta.length > 0) {
                writeReasoning(part.id, delta);
              } else {
                const prev = seenReasoning.get(part.id) ?? "";
                const text = part.text ?? "";
                if (text.startsWith(prev)) {
                  writeReasoning(part.id, text.slice(prev.length));
                  seenReasoning.set(part.id, text);
                } else if (text) {
                  writeReasoning(part.id, text);
                  seenReasoning.set(part.id, text);
                }
              }
            } else if (part.type === "tool" && verbose) {
              if (reasoningOpen) {
                process.stderr.write("\n");
                reasoningOpen = false;
              }
              const status = part.state.status;
              if (status === "pending" || status === "running") {
                if (toolStarted.has(part.id)) break;
                const input = part.state.input;
                // pending often arrives with {} before args are filled — wait.
                if (
                  status === "pending" &&
                  Object.keys(input).length === 0
                ) {
                  break;
                }
                toolStarted.add(part.id);
                const title =
                  status === "running" ? part.state.title : undefined;
                process.stderr.write(
                  formatToolStart(part.tool, input, title),
                );
              } else if (status === "completed") {
                if (toolFinished.has(part.id)) break;
                toolFinished.add(part.id);
                if (!toolStarted.has(part.id)) {
                  toolStarted.add(part.id);
                  process.stderr.write(
                    formatToolStart(
                      part.tool,
                      part.state.input,
                      part.state.title,
                    ),
                  );
                }
                process.stderr.write(formatToolDone(part.tool, part.state));
              } else if (status === "error") {
                if (toolFinished.has(part.id)) break;
                toolFinished.add(part.id);
                if (!toolStarted.has(part.id)) {
                  toolStarted.add(part.id);
                  process.stderr.write(
                    formatToolStart(part.tool, part.state.input),
                  );
                }
                process.stderr.write(formatToolError(part.tool, part.state));
              }
            }
            break;
          }
          case "session.status": {
            const props = event.properties;
            if (props.sessionID === sessionID && props.status.type === "idle") {
              return;
            }
            break;
          }
          case "session.idle": {
            if (event.properties.sessionID === sessionID) {
              return;
            }
            break;
          }
          case "session.error": {
            const props = event.properties;
            if (
              props.sessionID !== undefined &&
              props.sessionID !== sessionID
            ) {
              break;
            }
            const errMsg =
              props.error !== undefined
                ? JSON.stringify(props.error)
                : "unknown session error";
            throw new Error(`OpenCode session error: ${errMsg}`);
          }
        }
      }
    })();

    try {
      await Promise.race([streamLoop, timeout]);
      if (verbose && reasoningOpen) {
        process.stderr.write("\n");
        reasoningOpen = false;
      }
      // Role/text events can race; if SSE printed nothing, pull final assistant text.
      if (!sawAssistantText) {
        await flushSessionText(client, sessionID, jsonl);
      } else {
        writeStdoutEnd(jsonl);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        if (!signal.aborted) controller.abort();
        await client.session
          .abort({ path: { id: sessionID } })
          .catch(() => {});
        if (!sawAssistantText) {
          await flushSessionText(client, sessionID, jsonl);
        } else {
          writeStdoutEnd(jsonl);
        }
        throw new Error(
          `${msg}\n` +
            `OpenCode stayed busy (title/model call often hangs). ` +
            `Retry, or point OCD_SERVER_URL at a running \`opencode serve\`.`,
        );
      }
      if (msg.startsWith("OpenCode session error:")) {
        throw err instanceof Error ? err : new Error(msg);
      }
      throw new Error(`stream error: ${msg}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (!signal.aborted) controller.abort();
    }
  } finally {
    clearActiveAbort();
  }
}

async function batchPrompt(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
  jsonl = false,
): Promise<void> {
  const result = await client.session.prompt({
    path: { id: sessionID },
    body: { parts },
  });
  if (result.error) {
    throw new Error(`prompt failed: ${formatSdkError(result.error)}`);
  }
  if (result.data) {
    for (const part of result.data.parts) {
      if (
        part.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true
      ) {
        writeStdoutText(part.text, jsonl);
      }
    }
  }
  writeStdoutEnd(jsonl);
}

const TOOL_LOG_MAX = 800;

function truncateLog(text: string, max = TOOL_LOG_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…(+${text.length - max}b)`;
}

function formatToolInput(input: { [key: string]: unknown }): string {
  // Prefer common command-like fields for readable one-liners.
  for (const key of ["command", "cmd", "path", "filePath", "pattern", "query"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) {
      return truncateLog(`${key}=${JSON.stringify(v)}`);
    }
  }
  try {
    return truncateLog(JSON.stringify(input));
  } catch {
    return String(input);
  }
}

function formatToolStart(
  tool: string,
  input: { [key: string]: unknown },
  title?: string,
): string {
  const titleBit =
    typeof title === "string" && title.length > 0 ? ` ${title}` : "";
  const args = formatToolInput(input);
  return `[tool:${tool}] start${titleBit}\n  ${args}\n`;
}

function formatToolDone(
  tool: string,
  state: {
    output: string;
    title: string;
    time: { start: number; end: number };
  },
): string {
  const ms = Math.max(0, state.time.end - state.time.start);
  const out = truncateLog(state.output.replace(/\s+$/, ""));
  const indented = out
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `[tool:${tool}] done ${ms}ms\n${indented}\n`;
}

function formatToolError(
  tool: string,
  state: {
    error: string;
    time: { start: number; end: number };
  },
): string {
  const ms = Math.max(0, state.time.end - state.time.start);
  return `[tool:${tool}] error ${ms}ms\n  ${truncateLog(state.error)}\n`;
}

/** Best-effort dump of the latest assistant text if SSE ended early / timed out.
 * Only the most recent assistant message is written — dumping the full
 * multi-turn history would replay prior answers into `--stream` clients.
 */
async function flushSessionText(
  client: OpencodeClient,
  sessionID: string,
  jsonl = false,
): Promise<void> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    if (msgs.error || !msgs.data) return;
    for (let i = msgs.data.length - 1; i >= 0; i--) {
      const msg = msgs.data[i];
      if (msg.info.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          writeStdoutText(part.text, jsonl);
        }
      }
      writeStdoutEnd(jsonl);
      return;
    }
  } catch {
    // ignore flush failures
  }
}
