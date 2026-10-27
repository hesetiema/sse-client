/**
 * djb2 — used only to keep keys short (share keys, storage keys). The serialized
 * form stays the source of truth; a collision would merge two unrelated
 * subscriptions, which the full string comparison in `deriveShareKey` prevents.
 */
export function hashKey(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
