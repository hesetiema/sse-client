// Shared by the consumer demos: one cached bearer token, reissued on demand.
// Not part of the example — every demo would otherwise repeat the same six lines.

const TTL = 60_000;
let cached = "";

/** Drop the cached token; the next `authHeaders()` mints a new one. */
export function resetToken() {
  cached = "";
}

/** Header factory for `SSEClient`: called before every (re)connect. */
export async function authHeaders() {
  if (!cached) {
    const response = await fetch(`/auth/token?ttl=${TTL}`, { method: "POST" });
    cached = (await response.json()).token;
  }
  return { authorization: `Bearer ${cached}` };
}
