import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";

/**
 * Send a prompt via `promptAsync` and stream the answer to stdout via SSE.
 * Falls back to batch `prompt()` if promptAsync is unavailable.
 */
export async function streamResponse(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
): Promise<void> {
  let useBatchFallback = false;
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
    useBatchFallback = true;
  }

  if (useBatchFallback) {
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
    return;
  }

  // SSE streaming — skip first messageID (user echo), emit assistant diffs
  const sub = await client.event.subscribe();
  const seenText = new Map<string, string>();
  let userMessageID: string | undefined;

  try {
    for await (const event of sub.stream) {
      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.sessionID !== sessionID) break;

          if (part.type === "text") {
            if (userMessageID === undefined) {
              userMessageID = part.messageID;
            }
            if (part.messageID === userMessageID) break;

            const prev = seenText.get(part.id) ?? "";
            if (part.text.startsWith(prev)) {
              const diff = part.text.slice(prev.length);
              if (diff) process.stdout.write(diff);
              seenText.set(part.id, part.text);
            } else {
              process.stdout.write(part.text);
              seenText.set(part.id, part.text);
            }
          } else if (part.type === "tool") {
            process.stderr.write(`[tool: ${part.tool}...]\n`);
          }
          break;
        }
        case "session.status": {
          const props = event.properties;
          if (props.sessionID === sessionID && props.status.type === "idle") {
            process.stdout.write("\n");
            return;
          }
          break;
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`stream error: ${msg}`);
  }

  process.stdout.write("\n");
}
