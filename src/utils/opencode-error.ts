export function isExpectedOpencodeUnavailableError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  // Empty error object from OpenCode API response — likely a transient server-side error
  // (e.g. Effect-TS fiber interruption that serializes as {} in the response)
  if (typeof error === "object" && !Array.isArray(error) && Object.keys(error).length === 0) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("fetch failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("connectex") ||
    // OpenCode server internal fiber interruption (transient server-side error)
    normalized.includes("interrupterror") ||
    normalized.includes("all fibers interrupted")
  );
}
