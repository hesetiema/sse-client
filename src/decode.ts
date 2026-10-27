/**
 * Payload decoders for the `parse` option.
 *
 * The client drops a message whose `parse` throws, which is the right default —
 * a decoder that cannot read the payload usually means a protocol problem. For
 * backends that mix JSON and plain text on the same channel, `jsonParse` keeps
 * the raw frame instead of losing it.
 */

/** Parse JSON, falling back to the raw text when the frame is not valid JSON. */
export function jsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
