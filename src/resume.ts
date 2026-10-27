import { hashKey } from "./hash.js";

/**
 * The two methods `persistKey` actually needs. `Storage` satisfies it; so does a
 * plain object, which is what tests and non-browser hosts use.
 */
export interface ResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Namespace of the derived key, so application data in the same storage cannot collide. */
export const RESUME_KEY_PREFIX = "sse-client:resume:";

/**
 * Pick the storage used by `persistKey`.
 *
 * Defaults to `sessionStorage`: the resume point is only meaningful for the tab
 * that produced it, and session scope survives a reload without leaking a stale
 * position into a brand-new tab. Pass `null` to disable persistence entirely.
 */
export function resolveResumeStorage(explicit?: ResumeStorage | null): ResumeStorage | null {
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    // Accessing sessionStorage throws in sandboxed iframes and in some privacy modes,
    // which must not break constructing a client.
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Read a stored resume point; an empty string means "start from the server's current position". */
export function readResumePoint(storage: ResumeStorage | null, key: string): string {
  if (!storage || !key) {
    return "";
  }
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Write (or clear) a stored resume point. Storage failures are never fatal. */
export function writeResumePoint(storage: ResumeStorage | null, key: string, id: string): void {
  if (!storage || !key) {
    return;
  }
  try {
    if (id) {
      storage.setItem(key, id);
    } else {
      storage.removeItem(key);
    }
  } catch {
    // Quota exceeded or storage disabled: persistence is a convenience, not a requirement.
  }
}

/** Stable storage key for a subscription, used when `persistKey: true`. */
export function deriveResumeKey(options: { url: string; method?: string; body?: unknown }): string {
  let body = "";
  try {
    body = JSON.stringify(options.body ?? null) ?? "";
  } catch {
    // Circular or otherwise unserializable bodies fall back to a url-only key.
    body = "";
  }
  return `${RESUME_KEY_PREFIX}${hashKey(`${options.method ?? "POST"} ${options.url} ${body}`)}`;
}
