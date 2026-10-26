# @songfreedom/sse-client

English · [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/%40songfreedom%2Fsse-client)](https://www.npmjs.com/package/@songfreedom/sse-client)
[![license](https://img.shields.io/npm/l/%40songfreedom%2Fsse-client)](./LICENSE)
[![minzip size](https://img.shields.io/bundlephobia/minzip/%40songfreedom%2Fsse-client)](https://bundlephobia.com/package/@songfreedom/sse-client)

A small, dependency-free Server-Sent Events client for the browser.
`fetch` transport, typed event routing, automatic reconnection with `Last-Event-ID` resume,
an idle watchdog and shared connections.

```ts
import { SSEClient } from "@songfreedom/sse-client";

const client = new SSEClient({
  url: "/api/push/subscribe",
  body: { topics: ["alarm"] },
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  parse: (raw) => JSON.parse(raw),
});

client.on("ALARM", (alarm) => console.log(alarm.level));
```

## Why not `EventSource`?

| Option | Problem |
| --- | --- |
| Native `EventSource` | Cannot set request headers (no way to send an auth token), GET only, no request body, no control over reconnection |
| [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source) | Archived. Non-2xx responses must be rejected by hand in `onopen`, otherwise it silently reconnects forever; fixed retry interval; no `Last-Event-ID` persistence |
| `axios` | Cannot read a streaming response in the browser (`responseType: "stream"` is Node-only). Concatenating `responseText` in `onDownloadProgress` corrupts multi-byte characters |

This library is roughly 3 kB gzipped, has no runtime dependencies, and only needs `fetch`
and `ReadableStream`.

## Features

- **POST + JSON body**, arbitrary headers, and header functions re-evaluated on every reconnect
- **Reconnects** with exponential backoff and jitter; terminal errors (401/403/404) stop immediately
- **Resume** with `Last-Event-ID`, so a reconnect can pick up where it left off
- **Typed event routing**: one connection serves many subscribers, `on()` infers payload types from an event map
- **Idle watchdog** for streams that go quiet, and **proactive rotation** for connections that stay open but stop receiving data
- **Offline-aware**: pauses while the network is down, reconnects as soon as it is back
- **Pluggable retry policy**, including async policies such as "refresh the token, then retry"
- **Shared connections** by key with reference counting
- Optional **Vue 3** composable in a separate entry point

## Installation

```bash
pnpm add @songfreedom/sse-client
# or
npm install @songfreedom/sse-client
```

The Vue entry needs `vue` as a peer dependency (it is optional, so non-Vue users do not install it):

```bash
pnpm add @songfreedom/sse-client vue
```

Requires a browser with `fetch` and `ReadableStream` (all evergreen browsers), or Node 18+ for SSR and tests.

## Quick start

### Framework-agnostic

```ts
import { SSEClient } from "@songfreedom/sse-client";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
  IOT: { objectId: string; value: string };
}

const client = new SSEClient<Events>({
  url: `${gateway}/server-event/sse/subscribe`,
  method: "POST",
  body: [{ subscribeType: "SE", instanceType: "PROJECT" }],
  headers: () => authHeaders(),          // re-evaluated before every attempt
  parse: (raw) => JSON.parse(raw),
  idleTimeout: 45_000,                   // if the server sends a heartbeat every 15s
});

const off = client.on("ALARM", (alarm) => {
  // `alarm` is typed as Events["ALARM"]
  console.log(alarm.deviceId);
});

// Later
off();
client.close();
```

### Vue 3

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useSSE } from "@songfreedom/sse-client/vue";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
}

const { status, lastEvent, on } = useSSE<Events>({
  url: "/api/push/alarm",
  body: { topics: ["alarm"] },
  parse: (raw) => JSON.parse(raw),
});

on("ALARM", (alarm) => {
  // unsubscribed automatically on unmount
  console.log(alarm.level);
});

const connected = computed(() => status.value === "open");
</script>
```

`useSSE` adds two things on top of the client: a ring buffer of recent messages
(`lastEvent`, `events`, `maxEvents`) and scope-bound cleanup — unmounting the component,
or a qiankun sub-app, closes the connection.

## API

### `new SSEClient(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | — | Request URL, including your gateway prefix |
| `method` | `"GET" \| "POST"` | `"POST"` | HTTP method |
| `body` | `unknown` | — | Serialized as JSON; strings, `Blob` and `FormData` are sent as-is |
| `headers` | `HeadersInit \| () => HeadersInit \| Promise<HeadersInit>` | — | Pass a function to recompute headers on every (re)connect |
| `parse` | `(raw: string) => unknown` | identity | Payload decoder |
| `idleTimeout` | `number` | `0` | Reconnect when no bytes arrive for this long. Set it to ~3× the heartbeat interval |
| `rotateInterval` | `number` | `0` | Reconnect on a schedule, even if the connection looks healthy |
| `retry` | `(ctx) => number \| false \| Promise<number \| false>` | — | Custom retry policy, overrides the built-in backoff |
| `maxRetry` | `number` | `Infinity` | Retry limit (only when `retry` is omitted) |
| `retryBaseDelay` | `number` | `1000` | Delay before the first retry (ms) |
| `retryMaxDelay` | `number` | `30000` | Upper bound for backoff (ms) |
| `reconnectOnEnd` | `boolean` | `true` | Reconnect when the server ends the stream normally |
| `stableAfter` | `number` | `10000` | An attempt that lived this long resets the retry counter |
| `strictContentType` | `boolean` | `true` | Require `content-type: text/event-stream` |
| `maxBufferSize` | `number` | `1MB` | Cap for a single message buffer (characters) |
| `overflowPolicy` | `"close" \| "drop"` | `"close"` | On overflow: disconnect with a terminal `protocol` error, or drop that message and keep streaming |
| `yieldEvery` | `number` | `0` | Parse at most this many events per task, then yield; `0` keeps a whole chunk in one task |
| `endSignal` | `string` | — | Treat this `data` value as end-of-stream, e.g. `"[DONE]"` |
| `events` | `string[]` | — | Allow-list of event names |
| `pauseWhenHidden` | `boolean` | `false` | Suspend while the page is hidden, reconnect when visible |
| `autoStart` | `boolean` | `true` | Connect in the constructor |
| `fetch` | `FetchLike` | global `fetch` | Custom transport |
| `onHandlerError` | `(error) => void` | `console.error` | Fallback when a callback throws |

Lifecycle hooks can be passed as options (`onOpen`, `onMessage`, `onStatus`, `onError`,
`onClose`, `onOverflow`) or subscribed later; both forms are equivalent.

#### Properties

| Property | Type | Description |
| --- | --- | --- |
| `status` | `SSEStatus` | `idle` · `connecting` · `open` · `reconnecting` · `closed` |
| `closed` | `boolean` | Terminal state; the client will not reconnect |
| `attempts` | `number` | Consecutive retries; resets after a stable connection |
| `lastEventId` | `string` | Latest event id, sent back on reconnect |
| `dropped` | `number` | Messages discarded by the cap (only grows with `overflowPolicy: "drop"`) |
| `done` | `Promise<void>` | Resolves when the connection terminates; never rejects |

#### Methods

| Method | Description |
| --- | --- |
| `start()` | Open the connection (no-op while running or suspended) |
| `close()` | Close and stop reconnecting |
| `restart()` | Close, then reconnect while keeping `lastEventId` |
| `on(event, handler)` | Subscribe to one event name; returns an unsubscribe function |
| `on("*", handler)` | Subscribe to every message |
| `once(event, handler)` | Subscribe for a single delivery |
| `onMessage` / `onStatus` / `onError` / `onOpen` / `onClose` / `onOverflow` | Lifecycle subscriptions |

### `SSEMessage`

```ts
interface SSEMessage<T = unknown> {
  id: string;          // event id, inherited from the previous event when omitted
  event: string;       // "message" when the server sends no `event:` field
  data: T;             // `parse` output
  raw: string;         // raw payload text
  receivedAt: number;  // client receive timestamp
}
```

### Error kinds

`SSEError.kind` is meant for logging and for branching inside a retry policy:

| `kind` | Meaning | Retried by default |
| --- | --- | --- |
| `http` | Non-2xx response (`status` is set) | Yes for 408/425/429/5xx, otherwise no |
| `network` | DNS failure, connection reset, … | Yes |
| `heartbeat` | Idle timeout, the connection looks zombie | Yes |
| `protocol` | Wrong `content-type`, buffer overflow, unreadable body | No |
| `aborted` | Interrupted (hidden page, offline, manual close) | No |
| `retry-exhausted` | Retry budget spent | No |

## Recipes

### Refresh the token on 401

A retry policy may be async, so the refresh can complete before the next attempt:

```ts
let refreshed = false;

const client = new SSEClient({
  url,
  retry: async ({ error, attempt }) => {
    if (error?.status === 401 && !refreshed) {
      await refreshToken();
      refreshed = true;
      return 0; // retry immediately
    }
    return attempt > 5 ? false : Math.min(30_000, 1000 * 2 ** attempt);
  },
});
```

### Share one connection

HTTP/1.1 allows six connections per origin, and a push channel holds one open indefinitely.
Share it instead of opening one per component:

```ts
import { acquireSSEClient } from "@songfreedom/sse-client";

const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, body }));
onScopeDispose(release); // closes when the last consumer releases
```

### Batch high-frequency updates

When the same entity is pushed every few hundred milliseconds, coalesce before writing to state:

```ts
import { createBatcher } from "@songfreedom/sse-client";

const batcher = createBatcher<string, Point>({
  key: (point) => `${point.objectId}::${point.code}`,
  interval: 300,
  maxPending: 2000, // at most 2000 entities per window
  onFlush: (points) => store.applyPoints(points),
});

client.on("IOT", (payload) => payload.data.forEach((p) => batcher.push(p)));
```

`maxPending` is unlimited by default; when it is reached the entry that has not been updated for the
longest time is evicted, and the count shows up in `batcher.dropped`. After `dispose()`, `push()`
becomes a no-op (also counted), so a late callback cannot restart the timer.

### High frequency and large payloads: does memory grow?

Not without bound, as long as the three caps are in place:

1. **Network.** The read loop is pull-based (`await reader.read()`): a slow handler stops the
   next read, the browser stops draining the socket, and the exhausted TCP window blocks the
   server's `write()`. Backpressure propagates upstream without any extra flow-control protocol.
2. **Parser.** The line `buffer` and the accumulated `data` lines of one event are both capped by
   `maxBufferSize` (1MB by default); exceeding it raises a `protocol` error and disconnects by
   default — the `huge` and `no-blank-line` demo scenarios exercise that path. If losing a message
   is acceptable but disconnecting is not, use `overflowPolicy: "drop"`: only that message is
   discarded (counted in `dropped`, reported through `onOverflow`), the connection stays open and
   the parser resynchronises on the next blank line.
3. **Application.** The client keeps no history: a message is collectable as soon as it is
   dispatched. Growth only comes from what your code retains — arrays, reactive stores, log tables.

Measured (the demo's `flood` scenario via `pnpm demo:memory`, one Chrome tab): **368 MB** and
48,000 events in 30 seconds, 4.6 MB peak heap, 0.8 MB after a forced GC (0.6 MB baseline), DOM
nodes 117 → 117. The saw-tooth is unreclaimed garbage, not a leak. Details and the reproduction
script are in [`demo/README.md`](./demo/README.md#6-high-frequency--memory-measurement).

Two things remain yours to handle: do not accumulate messages in the handler, and lower
`maxBufferSize` if every message is large and you want anomalies to surface sooner.

### Long tasks: yielding the main thread

`feed()` is synchronous: a chunk carrying N events parses and dispatches all N in the same task.
Parsing itself is cheap (measured at roughly 3–10µs per event); what actually blocks the page is
**your handler** — 1ms of rendering per message times 1500 messages in one chunk is a 1.4s stall.
`yieldEvery` slices between parse and dispatch:

```ts
new SSEClient({ url, yieldEvery: 20 }); // parse 20 events, yield, continue
```

Yielding uses `scheduler.yield()` when available and falls back to `setTimeout(0)`; an abort during
the pause behaves exactly like an abort inside `reader.read()`.

Measured in the demo (`pnpm demo:memory --handler=1`, 1ms simulated work per message, 2000 events
in one chunk):

| `yieldEvery` | Longest single block | Total main-thread time | Events |
| --- | --- | --- | --- |
| `0` | **1467 ms** | 2032 ms | 2000 |
| `20` | **117 ms** | 2046 ms | 2000 |

The total work is identical (slicing does not save time) but the longest block drops by 12x. Note
that the residual ~117ms is not a slice-size artefact — `yieldEvery: 5` measures the same 117ms:
two seconds of backlog keeps rendering starved, so slicing only guarantees "no single runaway task".
To stop the jank entirely, reduce the per-message cost or coalesce (see `createBatcher` above).

### Rotation vs reconnect

A connection can stay alive while the server-side subscription is already gone. Rotation
reconnects on a schedule (`rotateInterval`) to avoid such zombie connections, keeping
`lastEventId` so nothing is missed:

```ts
new SSEClient({ url, rotateInterval: 30 * 60_000 });
```

This relies on the server honouring `Last-Event-ID`. An alternative is overlapping
connections (open a replacement, then close the old one), which avoids the gap but can
deliver duplicates when the server pushes per connection.

## Low-level building blocks

The client is assembled from small pieces that are exported for advanced use:

```ts
import { createSSEParser, createSSEMessageStream, createBatcher } from "@songfreedom/sse-client";

// bytes → messages, as a standard TransformStream
const messages = response.body!.pipeThrough(createSSEMessageStream({ parse: JSON.parse }));

// raw frames, if you want to drive the loop yourself
const parser = createSSEParser({ onEvent: (event) => console.log(event) });
parser.feed("event: ping\ndata: 1\n\n");
```

## Server requirements

- Respond with `Content-Type: text/event-stream` (a `;charset=UTF-8` suffix is fine).
- Do not buffer the response: `proxy_buffering off; proxy_cache off;` at the gateway,
  and do not gzip the stream.
- Send a heartbeat comment (`: ping\n\n`) every 15–30s, otherwise most load balancers
  close the connection after 60s of silence. Pair it with `idleTimeout`.
- Support `Last-Event-ID` if you want gap-free reconnects; the client sends the header but
  does not de-duplicate events.

## Design notes

- No business logic: the client does not know about tokens, stores, toasts or routing.
  Authentication is injected through `headers`.
- Errors never escape as exceptions from callbacks; a throwing handler is isolated and
  reported through `onHandlerError` while the stream keeps flowing.
- Timers are always cleared on close, and the connection loop only exits when the client is
  finally closed, so suspending and resuming cannot leak a loop.

## Development

```bash
pnpm install
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # dist/ + dist/package.json
```

Integration demo (real browser + real Nginx, plus a headless smoke run):
see [demo/README.md](./demo/README.md) — `pnpm demo:server` / `pnpm demo:smoke` /
`pnpm demo:matrix` / `pnpm demo:memory`.

Releasing: bump the version, then

```bash
pnpm publish:npm  # build + publish to npmjs (access: public)
```

## License

[MIT](./LICENSE)
