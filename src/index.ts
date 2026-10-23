export { SSEClient } from "./client.js";
export type { FetchLike, RetryContext, RetryPolicy, SSEClientOptions } from "./client.js";

export { SSEError, isRetryableStatus, toSSEError } from "./errors.js";

export { createSSEParser } from "./parser.js";
export type { ParsedEvent, SSEParser, SSEParserOptions } from "./parser.js";

export { createBatcher } from "./batch.js";
export type { Batcher, BatcherOptions } from "./batch.js";

export { createSSEMessageStream } from "./stream.js";
export type { SSEMessageStreamOptions } from "./stream.js";

export {
  acquireSSEClient,
  closeAllSharedSSEClients,
  getSharedSSEClientCount,
} from "./share.js";
export type { SharedSSEHandle } from "./share.js";

export type { SSECloseReason, SSEEventMap, SSEMessage, SSEStatus, Unsubscribe } from "./types.js";
