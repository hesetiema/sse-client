import { SSEClient } from "./client.js";
import type { SSEClientOptions } from "./options.js";
import type { SSEEventMap } from "./types.js";

/**
 * Offset that asks the server to replay a run from its first event.
 *
 * A `Last-Event-ID` header is an *incremental* cursor: it says "continue after
 * this". It cannot express "start this run over", which is exactly what a fresh
 * tab, a reload, or a multi-tab takeover needs — the new reader has seen nothing
 * yet. That is a second, read-only channel: no messages are posted, no producer
 * is started, the log is just replayed.
 */
export const JOIN_START_OFFSET = "-1";

/** Which run to replay and what the query parameters are called. */
export interface JoinOptions {
  /** Run (or any opaque subscription) id to replay. */
  runId: string;
  /**
   * Query parameter names. Defaults to `offset` and `runId`;
   * name them after the backend when it already has its own spelling.
   */
  params?: { offset?: string; runId?: string };
  /** Value that means "from the beginning". Defaults to {@link JOIN_START_OFFSET}. */
  startOffset?: string;
}

/** A live-client config plus the join it should be derived from. */
export interface JoinClientOptions extends SSEClientOptions {
  join: JoinOptions;
}

export interface JoinHandle<E extends object = SSEEventMap> {
  /** The read-only replay client. `close()` aborts the replay. */
  client: SSEClient<E>;
  /**
   * Resolves with the last id the replay delivered once the stream ends.
   *
   * Hand it to the live client with `setResumePoint(id)`: the replay has just
   * walked the run to its tail, so that id is the only correct place to continue
   * from. It stays `""` when the server sent no ids at all — in that case there is
   * nothing to continue from and the snapshot is the only source of truth.
   */
  done: Promise<string>;
}

/**
 * Build the read-only replay URL for a run.
 *
 * Existing query parameters and a hash fragment are preserved, so a gateway
 * prefix or a cache-busting parameter survives:
 * `deriveJoinUrl("/api/chat?tenant=t1", { runId: "r9" })`
 * → `/api/chat?tenant=t1&offset=-1&runId=r9`.
 */
export function deriveJoinUrl(url: string, join: JoinOptions): string {
  const offsetParam = join.params?.offset ?? "offset";
  const runIdParam = join.params?.runId ?? "runId";
  return appendSearchParams(url, [
    [offsetParam, join.startOffset ?? JOIN_START_OFFSET],
    [runIdParam, join.runId],
  ]);
}

/**
 * Replay a run from the beginning over a read-only GET, then hand its tail back.
 *
 * ```ts
 * const live = new SSEClient({ url: "/api/chat", request: { body: { threadId } } });
 *
 * // A fresh tab has seen nothing: replay the run, then continue live from its tail.
 * const { done } = createJoinClient({
 *   url: "/api/chat",
 *   join: { runId },
 *   parse: JSON.parse,
 * });
 * live.setResumePoint(await done);
 * ```
 *
 * Deliberate choices, all of them about not asking two questions at once:
 *
 * - `Last-Event-ID` is **not** sent. `offset` is the cursor on this route; adding a
 *   stale header would let the server pick whichever one it prefers.
 * - `reconnectOnEnd` is off. A replay is finite: reconnecting past its final
 *   offset would open an empty window and, with a live-tailing server, park
 *   forever.
 * - `method` is `GET` and no body is sent, so the server cannot mistake the replay
 *   for a new subscription.
 * - Persistence is off. A replay is a reader, not the owner of the subscription:
 *   writing its progress into the same storage key would race the live client, and
 *   an aborted replay would leave a half-consumed position behind. `done` is the
 *   only handover, and it is explicit.
 *
 * The replay starts immediately; `autoStart: false` is ignored on purpose, so
 * `done` always has a loop behind it.
 */
export function createJoinClient<E extends object = SSEEventMap>(
  options: JoinClientOptions,
): JoinHandle<E> {
  const { join, ...rest } = options;
  const client = new SSEClient<E>({
    ...rest,
    url: deriveJoinUrl(rest.url, join),
    request: { ...rest.request, method: "GET", body: undefined },
    stream: { ...rest.stream, reconnectOnEnd: false },
    resume: { ...rest.resume, from: "", persist: false },
    autoStart: false,
  });
  client.start();
  return { client, done: client.done.then(() => client.lastEventId) };
}

/** Append query parameters without disturbing the existing ones or the hash. */
function appendSearchParams(url: string, values: Array<[string, string]>): string {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = new URLSearchParams(queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1));
  for (const [key, value] of values) {
    search.set(key, value);
  }
  const query = search.toString();
  return `${base}${query.length === 0 ? "" : `?${query}`}${hash}`;
}
