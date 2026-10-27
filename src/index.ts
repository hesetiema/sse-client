export { SSEClient } from "./client.js";
export type { FetchLike, RetryContext, RetryPolicy, SSEClientOptions, SsePlugin } from "./client.js";
export type {
  HookOptions,
  LimitOptions,
  RequestOptions,
  ResumeOptions,
  RetryOptions,
  RotateOptions,
  StreamOptions,
} from "./options.js";

export { createFanout } from "./fanout.js";
export type { SseEventHandler, SseFanout, SseFanoutOptions, SseFanoutSource } from "./fanout.js";

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

// Shared connections. The registry helpers behind them (`getSharedSSEClients`,
// `getSharedSSEClientCount`, `closeAllSharedSSEClients`) live on the testing
// entry: they exist for tests and teardown, not for application code.
export { acquireSSEClient, deriveShareKey, useSharedSSEClient } from "./share.js";
export type {
  SharedSSEClientConfig,
  SharedSSEClientHandle,
  SharedSSEHandle,
} from "./share.js";

// `createMultiTabSSE` is deliberately not re-exported here: it is one import
// path, `@songfreedom/sse-client/multi-tab`, so the leader election and relay
// (13 kB) never land in a bundle that only needs a single connection.
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
