import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";

const STREAM_TIMEOUT_MS = 120_000;

/**
 * Send a prompt via `promptAsync` and stream the answer to stdout via SSE.
 * Falls back to batch `prompt()` if promptAsync is unavailable.
 */
export async function streamResponse(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
): Promise<void> {
  // Subscribe BEFORE prompting to avoid missing early SSE events.
  let sub: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> | undefined;
  try {
    sub = await client.event.subscribe();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `warning: event subscribe failed (${msg}), using batch mode`,
    );
    await batchPrompt(client, sessionID, parts);
    return;
  }

  try {
    const result = await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts },
    });
    if (result.error) {
      throw new Error(String(result.error));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `warning: promptAsync unavailable (${msg}), using batch mode`,
    );
    await batchPrompt(client, sessionID, parts);
    return;
  }

  const seenText = new Map<string, string>();
  let userMessageID: string | undefined;
  let sawAssistantText = false;

  const streamLoop = (async () => {
    for await (const event of sub!.stream) {
      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.sessionID !== sessionID) break;

          if (part.type === "text") {
            if (userMessageID === undefined) {
              userMessageID = part.messageID;
            }
            if (part.messageID === userMessageID) break;

            const delta = event.properties.delta;
            if (delta !== undefined && delta.length > 0) {
              process.stdout.write(delta);
              seenText.set(part.id, (seenText.get(part.id) ?? "") + delta);
              sawAssistantText = true;
            } else {
              const prev = seenText.get(part.id) ?? "";
              if (part.text.startsWith(prev)) {
                const diff = part.text.slice(prev.length);
                if (diff) {
                  process.stdout.write(diff);
                  sawAssistantText = true;
                }
                seenText.set(part.id, part.text);
              } else if (part.text) {
                process.stdout.write(part.text);
                seenText.set(part.id, part.text);
                sawAssistantText = true;
              }
            }
          } else if (part.type === "tool") {
            process.stderr.write(`[tool: ${part.tool}...]\n`);
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
          if (props.sessionID !== undefined && props.sessionID !== sessionID) {
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${STREAM_TIMEOUT_MS / 1000}s waiting for OpenCode response`,
        ),
      );
    }, STREAM_TIMEOUT_MS);
  });

  try {
    await Promise.race([streamLoop, timeout]);
    process.stdout.write("\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out")) {
      if (!sawAssistantText) {
        await flushSessionText(client, sessionID);
      } else {
        process.stdout.write("\n");
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
  }
}

async function batchPrompt(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
): Promise<void> {
  const result = await client.session.prompt({
    path: { id: sessionID },
    body: { parts },
  });
  if (result.error) {
    throw new Error(`prompt failed: ${String(result.error)}`);
  }
  if (result.data) {
    for (const part of result.data.parts) {
      if (
        part.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true
      ) {
        process.stdout.write(part.text);
      }
    }
  }
  process.stdout.write("\n");
}

/** Best-effort dump of assistant text if SSE ended early / timed out. */
async function flushSessionText(
  client: OpencodeClient,
  sessionID: string,
): Promise<void> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    if (msgs.error || !msgs.data) return;
    for (const msg of msgs.data) {
      if (msg.info.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          process.stdout.write(part.text);
        }
      }
    }
    process.stdout.write("\n");
  } catch {
    // ignore flush failures
  }
}
