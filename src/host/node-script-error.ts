/**
 * Unwraps a `PluginAPI.executeNodeScript` failure into a plain message.
 *
 * On failure the spawned Node process writes
 * `JSON.stringify({ __error: message })` to stderr (see
 * `electron/plugin-node-executor.ts`, mirrored in
 * `test/host-script.test.cjs`). Observed against a real app build: that raw
 * JSON string arrives here as `error` itself, unparsed, rather than already
 * unwrapped into `{ message }` — so a plain string is checked for the
 * `__error` shape before being used as-is.
 */
export const describeNodeScriptError = (
  error: string | { message?: string } | undefined,
): string => {
  if (typeof error === 'string') {
    return unwrapHostErrorString(error) ?? error;
  }
  return error?.message ?? 'Unknown error';
};

const unwrapHostErrorString = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).__error === 'string'
    ) {
      return (parsed as Record<string, unknown>).__error as string;
    }
  } catch {
    // Not JSON — it's already a plain message.
  }
  return null;
};
