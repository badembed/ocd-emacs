/**
 * Format OpenCode SDK / Hey API errors for stderr and thrown messages.
 * Avoids useless `String(error)` → `[object Object]`.
 */
export function formatSdkError(err: unknown): string {
  if (err === undefined || err === null) return "unknown error";
  if (typeof err === "string") {
    const t = err.trim();
    return t.length > 0 ? t : "unknown error";
  }
  if (err instanceof Error) {
    const msg = err.message.trim();
    return msg.length > 0 ? msg : err.name || "Error";
  }
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : undefined;

    if (typeof obj.data === "object" && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.message === "string" && data.message.trim().length > 0) {
        const ref = typeof data.ref === "string" ? data.ref : undefined;
        let out = data.message.trim();
        if (name) out = `${name}: ${out}`;
        if (ref) out = `${out} [${ref}]`;
        return out;
      }
    }

    if (typeof obj.message === "string" && obj.message.trim().length > 0) {
      return name ? `${name}: ${obj.message.trim()}` : obj.message.trim();
    }

    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      // fall through
    }
  }
  const fallback = String(err);
  return fallback === "[object Object]" ? "unknown error" : fallback;
}
