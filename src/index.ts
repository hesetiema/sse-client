export { SSEClient } from "./client.js";
export type { FetchLike, RetryContext, RetryPolicy, SSEClientOptions } from "./client.js";

export { SSEError, isRetryableStatus, toSSEError } from "./errors.js";

export { createSSEParser } from "./parser.js";
export type { OverflowPolicy, ParsedEvent, SSEParser, SSEParserOptions } from "./parser.js";

export { createBatcher } from "./batch.js";
export type { Batcher, BatcherOptions } from "./batch.js";

export { createRingBuffer } from "./ring.js";
export type { RingBuffer, RingBufferOptions } from "./ring.js";

export { createSSEMessageStream } from "./stream.js";
export type { SSEMessageStreamOptions } from "./stream.js";

export { jsonParse } from "./decode.js";

export { deriveResumeKey, RESUME_KEY_PREFIX } from "./resume.js";
export type { ResumeStorage } from "./resume.js";

export {
  acquireSSEClient,
  closeAllSharedSSEClients,
  deriveShareKey,
  getSharedSSEClientCount,
  getSharedSSEClients,
  useSharedSSEClient,
} from "./share.js";
export type {
  SharedSSEClientConfig,
  SharedSSEClientHandle,
  SharedSSEHandle,
} from "./share.js";

export { createMultiTabSSE } from "./multi-tab.js";
export type {
  BroadcastChannelLike,
  LockRequester,
  MultiTabRole,
  MultiTabSSE,
  MultiTabSSEDeps,
  MultiTabSSEOptions,
} from "./multi-tab.js";

export type {
  SSECloseReason,
  SSEEventMap,
  SSEGapInfo,
  SSEGapReason,
  SSEMessage,
  SSEResumeInfo,
  SSEStatus,
  Unsubscribe,
} from "./types.js";
