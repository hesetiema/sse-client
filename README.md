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
- **Resume** with `Last-Event-ID`, so a reconnect can pick up where it left off — and across reloads with `persistKey`
- **Gap signal** (`onSuspectGap`): the client says when it cannot prove the stream was continuous, so the app can refetch a snapshot instead of showing a silently wrong number
- **Resume verification** (`onResume`): after a reconnect it reports how far the new stream jumped (`skipped`, `continuous`), and stays quiet when ids are opaque
- **Typed event routing**: one connection serves many subscribers, `on()` infers payload types from an event map
- **Idle watchdog** for streams that go quiet, and **proactive rotation** for connections that stay open but stop receiving data
- **Offline-aware**: pauses while the network is down, reconnects as soon as it is back
- **Pluggable retry policy**, including async policies such as "refresh the token, then retry"
- **Shared connections** by key with reference counting, and **one connection for every tab** (`./multi-tab`)
- **Bounded history**: `createRingBuffer`, with `createBatcher` coalescing (optional leading edge) in front of it
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
import { computed, onUnmounted } from "vue";
import { useSSE } from "@songfreedom/sse-client/vue";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
}

const { status, lastEvent, on, dispose } = useSSE<Events>({
  url: "/api/push/alarm",
  body: { topics: ["alarm"] },
  parse: (raw) => JSON.parse(raw),
});

on("ALARM", (alarm) => console.log(alarm.level));

onUnmounted(dispose);

const connected = computed(() => status.value === "open");
</script>
```

`useSSE` is deliberately thin: refs for `status` / `lastEvent` / `error`, `on()` for
routing, and a `dispose()` that unsubscribes everything the composable registered and
closes the connection.

**There is no history array.** How many messages a view keeps, whether it downsamples
them and how often it repaints are business decisions the library cannot make for you —
a built-in default would quietly fit nobody. Compose the buffer with `createRingBuffer`
(see [Large lists and charts](#large-lists-and-charts-compose-the-view-window)).

Cleanup is explicit rather than scope-based. `getCurrentScope()` returns `undefined`
when the app and the library resolve *different copies* of Vue — the usual case in a
qiankun sub-app — and the guarded call then leaks the connection silently. `dispose()`
is idempotent, so calling it twice is harmless. `stop()` closes the connection but keeps
the composable usable; `dispose()` is the real teardown.

Pass `shared: true` (or `{ grace, keyOf }`) to put every component describing the same
subscription on one connection: releases are reference counted, so one unmount no longer
cuts the others off.

## API

### `new SSEClient(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | — | Request URL, including your gateway prefix |
| `method` | `"GET" \| "POST"` | `"POST"` | HTTP method |
| `body` | `unknown` | — | Serialized as JSON; strings, `Blob` and `FormData` are sent as-is |
| `headers` | `HeadersInit \| () => HeadersInit \| Promise<HeadersInit>` | — | Pass a function to recompute headers on every (re)connect |
| `parse` | `(raw: string) => unknown` | identity | Payload decoder; `jsonParse` from the package keeps the raw text when a frame is not JSON |
| `resumeFrom` | `string` | — | Resume point for the first request, sent as `Last-Event-ID`; use it to continue where a previous page load stopped |
| `persistKey` | `string \| boolean` | — | Keep `lastEventId` in storage across reloads. `true` derives the key from the subscription; writes are throttled to 1/s and flushed on close and `pagehide` |
| `persistStorage` | `ResumeStorage \| null` | `sessionStorage` | Where `persistKey` reads and writes; `null` disables it (SSR, sandboxed iframes) |
| `onSuspectGap` | `(info: SSEGapInfo) => void` | — | The stream may not be continuous (`reconnect` / `resume` / `rotate` / `drop` / `promote`); fires once per episode |
| `onResume` | `(info: SSEResumeInfo) => void` | — | First identified event after a reconnect: how far the new stream jumped (`skipped`, `continuous`) |
| `idleTimeout` | `number` | `0` | Reconnect when no bytes arrive for this long. Set it to ~3× the heartbeat interval |
| `rotateInterval` | `number` | `0` | Reconnect on a schedule, even if the connection looks healthy |
| `rotateMode` | `"restart" \| "overlap"` | `"restart"` | `restart` reconnects; `overlap` takes over a pre-opened replacement instead (no gap) |
| `rotateTimeout` | `number` | `30000` | Time budget for the replacement connection in `overlap` mode |
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
`onClose`, `onOverflow`, `onSuspectGap`, `onResume`) or subscribed later; both forms are
equivalent.

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
| `setResumePoint(id)` | Replace the resume point used by the **next** connection, e.g. with a snapshot id after a gap |
| `on(event, handler)` | Subscribe to one event name; returns an unsubscribe function |
| `on("*", handler)` | Subscribe to every message |
| `once(event, handler)` | Subscribe for a single delivery |
| `onMessage` / `onStatus` / `onError` / `onOpen` / `onClose` / `onOverflow` / `onSuspectGap` / `onResume` | Lifecycle subscriptions |

`start()` also queues itself when a `close()` has not finished unwinding yet, so
`stop(); start();` in the same tick reconnects instead of doing nothing.

### `useSharedSSEClient(config?)`

`acquireSSEClient` covers "one subscription, many consumers". This covers the harder half:
**the subscription itself changes** (floor, tenant, filter, time range) while the consumer
stays mounted.

The handle you get back is not a connection. It owns *your subscription description and
your listeners*; the connection belongs to a key and is shared with everybody on that key.

```ts
const sse = useSharedSSEClient({ grace: 5_000 });

sse.on("IOT", apply);                              // buffered: nothing connects yet
sse.configure({ url, body: [{ floorId: "F1" }] }); // open or reuse the matching connection
watch(floorId, (id) => sse.configure({ url, body: [{ floorId: id }] }));
onScopeDispose(() => sse.release());
```

`configure` does four things: derive the key, return early when it is unchanged, detach
your listeners from the old client, attach them to the matching one (reusing it when a peer
already holds it), and finally decrement the old key's reference count. That last step is
why switching floors does not disturb a second component still watching the previous one.

| Call | Effect |
| --- | --- |
| `configure(sameKey)` | Nothing; returns the key. Safe from a watcher that fires often. |
| `configure(newKey)` | Listeners move to the new connection; the old one loses a reference and is closed immediately (**no grace**). |
| `configure()` / `configure({})` | Stop consuming, keep the handle usable. |
| `close()` | Detach listeners, drop a reference, keep the handle. A later `configure` re-attaches them. |
| `release()` | Final: idempotent, further `configure` calls return `null`. |

Properties: `key`, `client`, `status`, `configured`. `client` is a **getter** — it can be a
different instance after a switch, so do not cache it. `status` is `idle` before the first
`configure`.

Continuity signals belong to the handle for the same reason: `onSuspectGap` and `onResume`
are re-attached on every switch, while a listener bound to a cached `client` goes silent
the moment the subscription moves.

Four things that surprise people:

- **Same body, different `parse` collapse into one connection.** The key only covers
  `url` / `method` / `body` / `events`, and the *first* caller's `parse` wins — the second
  consumer receives whatever it returns. Pass `keyOf` to separate them.
- **Switching is not grace-protected.** `F1 → F2 → F1` is two reconnects. Debounce the
  switch, or bucket the filter into the key (round the time range to a minute) instead of
  letting a slider produce a new key per pixel.
- **`grace` only applies to `close()`.** It exists for remounts (route changes), not for
  subscription changes.
- **`useSSE({ shared: true })` is the fixed-subscription flavour** and does not expose
  `configure`. Use the handle directly when the subscription moves.

`config`: `grace` (ms an unreferenced connection stays open, default 0), `keyOf` (defaults
to `deriveShareKey`), `create` (client factory, defaults to `new SSEClient`).

Reach for `acquireSSEClient` instead when the subscription never changes — it needs no
listener bookkeeping. Use a plain `SSEClient` for a single consumer, and
`createMultiTabSSE` when the duplication is across tabs rather than components.

### `deriveShareKey(options)`

Stable key from `url`, `method`, `body` and `events`; object keys are sorted and arrays
are compared as sets. Exposed so an explicit `key` can follow the same rules.

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

### `SSEResumeInfo`

The argument of `onResume`, reported only for connections whose request carried a
`Last-Event-ID`:

```ts
interface SSEResumeInfo {
  lastId: string;                   // the resume point that was sent
  firstId: string;                  // first event with an id on the new connection
  skipped: number | undefined;      // firstId - lastId; undefined for opaque ids
  continuous: boolean | undefined;  // true when skipped <= 1; undefined without numeric ids
  attempt: number;                  // which attempt the new connection belongs to
}
```

`skipped: undefined` does not mean "nothing was skipped" — it means the client refuses
to guess. SSE ids are opaque strings and the spec never promises they are ordered, so
the two fields are only conclusive when the server sends incrementing integers.

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

An `http` error carries `retryAfter` (ms) when the response had a `Retry-After`
header, and the built-in backoff uses it — clamped between 200ms and `retryMaxDelay`
— instead of the exponential curve. A custom `retry` policy can read the same field.

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

### Resume across a reload

`lastEventId` lives in memory, so an F5 restarts the stream at "now" and silently skips
whatever the server produced while the page was loading. Persist the point instead:

```ts
new SSEClient({
  url,
  persistKey: "alarm",   // sessionStorage under this key
  // persistKey: true    // key derived from url/method/body
});
```

The stored point is read before the first request. While streaming, writes are coalesced to
one per second and flushed on close, on suspend and on `pagehide`, so a fast stream does not
turn into one synchronous storage write per message. Use `resumeFrom` when the point comes
from somewhere else (a snapshot API, the URL, another tab).

### Resync after a gap

The client cannot know what a reconnect skipped — only that it cannot prove continuity.
`onSuspectGap` turns that into an actionable event:

```ts
const client = new SSEClient({
  url,
  persistKey: "iot",
  onSuspectGap: async ({ reason, lastId }) => {
    const snapshot = await fetchSnapshot(); // { id: "9042", data: [...] }
    store.replaceAll(snapshot.data);
    client.setResumePoint(snapshot.id);      // the next connection continues from here
  },
});
```

Reasons are `reconnect`, `resume` (hidden page or offline), `rotate` (`restart` mode only),
`drop` (a message exceeded `maxBufferSize`) and `promote` (a multi-tab follower took over
from a leader that went away). It fires once per episode, so a ten-minute outage does not
trigger twenty snapshot requests. `setResumePoint` never interrupts the running stream:
rewriting `Last-Event-ID` mid-stream would desynchronise the parser instead of healing the
gap.

### Did the resume actually resume?

`onSuspectGap` says "I cannot prove continuity". `onResume` answers the question it leaves
open, once the first event of the new connection arrives:

```ts
const client = new SSEClient({
  url,
  onResume: ({ firstId, skipped, continuous }) => {
    if (continuous === false) {
      metrics.increment("sse.resume.skipped", { skipped });
    }
    cursor.moveTo(firstId);
  },
});
```

`skipped` is `firstId - lastId` when both ids are integers: `0` means the server replayed
the last event, `> 1` means events are missing. Both `skipped` and `continuous` stay
`undefined` for opaque ids — a client that invented an ordering would report a confident
lie, so it reports nothing instead. Use it for observability, and keep `onSuspectGap` as
the hook that triggers a snapshot refetch.

### Share one connection

HTTP/1.1 allows six connections per origin, and a push channel holds one open indefinitely.
Share it instead of opening one per component:

```ts
import { acquireSSEClient } from "@songfreedom/sse-client";

const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, body }));
onScopeDispose(release); // closes when the last consumer releases
```

### Share a subscription that changes

A floor switcher where three components watch the same stream and the floor can change at
runtime:

```vue
<script setup lang="ts">
const props = defineProps<{ floorId: string }>();

const sse = useSharedSSEClient({ grace: 5_000 });
sse.on("IOT", (point) => dock.apply(point)); // buffered until a connection exists

watch(
  () => props.floorId,
  (floorId) => sse.configure({ url, body: [{ floorId }] }),
  { immediate: true },
);

onUnmounted(() => sse.release());            // refcount, not a hard close
</script>
```

All three components land on one connection because the key is derived from the
subscription itself (`url`, `method`, `body`, `events`; arrays compared as sets) — they
never have to agree on a string. Switching the floor moves all of them together and closes
the old connection only once the last one has moved off it.

The behaviour table, `close()` versus `release()`, and the traps (a shared `parse`, no
grace when switching) live in [`useSharedSSEClient`](#usesharedsseclientconfig).

### One connection for every tab

Six dashboard tabs are six connections to the same stream. With Web Locks and
`BroadcastChannel` the tabs elect one leader and the rest replay what the leader relays:

```ts
import { createMultiTabSSE } from "@songfreedom/sse-client/multi-tab";

const sse = createMultiTabSSE({ url: "/api/push", body: { topics: ["iot"] } });
sse.on("IOT", (point) => store.apply(point)); // every tab, one connection
sse.role;                                     // "leader" | "follower" | "solo"
```

When the leader tab closes, a queued follower takes the lock and resumes from the last id
it saw, so the handover costs one `Last-Event-ID` gap instead of a full resubscribe.
Continuity signals cross the relay as well: the taking-over tab reports
`onSuspectGap({ reason: "promote" })`, and `onResume` is relayed from whichever tab owns
the connection.
Without Web Locks or `BroadcastChannel` every tab reports `solo` and connects on its own —
a degraded but honest fallback, rather than a hand-rolled protocol that can split-brain.
`parse` must return structured-cloneable data, and `onOpen` fires on the leader only,
because a `Response` cannot be relayed.

### Large lists and charts: compose the view window

The client stops at "message dispatched". What a view keeps, and how often it repaints,
belongs to the app — two building blocks cover most dashboards:

```ts
import { shallowRef, onUnmounted } from "vue";
import { createRingBuffer, useSSE, jsonParse } from "@songfreedom/sse-client";

const ring = createRingBuffer<Point>({ capacity: 2_000 }); // memory bound
const rows = shallowRef<Point[]>([]);
let frame = 0;

const schedule = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    rows.value = ring.toArray(); // one array per frame, not per message
  });
};

const { dispose } = useSSE({
  url: "/api/push",
  parse: jsonParse,
  onMessage: (message) => {
    ring.push(message.data as Point);
    schedule();
  },
});

onUnmounted(dispose);
```

Capacity and publish volume are the same number here on purpose: `toArray()` costs
O(capacity) per frame, so a buffer that is cheap to keep is also cheap to publish. When
those two pull apart (keep 6000 points, render 500), publish a slice or virtualize the
list — do not raise the capacity and hope.

`ring.evicted` counts what was overwritten, so the UI can be honest instead of
pretending the list is complete:

```ts
const truncated = computed(() => ring.evicted > 0); // "last 2000 points"
```

Size with `capacity = seconds × rate`. If the number keeps growing, the view is the wrong
home for that data: downsample on the server (1s/1min aggregates) or page it from a query
endpoint. Never compress an event list client-side — sampling a list of alarms silently
deletes alarms, and nothing on screen says so.

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

Pass `leading: true` for a sparse stream: the first value of an idle window is delivered
immediately — a panel that updates once a minute is no longer shown one interval late —
while the burst behind it is still coalesced into the trailing flush.

Two things matter when a shared connection feeds several consumers: `batcher.subscribe(fn)` adds
listeners next to `onFlush`, so the window is written to state once and every consumer is notified
from the same batch; `chunkSize` hands a large window over in slices, yielding between them, so
5000 entities do not become one long task.

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

This relies on the server honouring `Last-Event-ID`. When it does not — or when a gap is
unacceptable — rotate without a gap instead:

```ts
new SSEClient({ url, rotateInterval: 30 * 60_000, rotateMode: "overlap", rotateTimeout: 30_000 });
```

`overlap` requests the replacement *while the current connection keeps streaming*, and takes
it over only once it is accepted: the old attempt is aborted, the candidate is read from the
buffer it already filled, so no event is lost and none is replayed. A candidate that cannot
be opened (502, wrong content-type, timeout) is dropped and reported through `onError`, while
the running connection stays untouched — a scheduled rotation never trades a working stream
for a broken one.

`restart` (the default) closes first and reopens, which is cheaper on the server and safe
when `Last-Event-ID` is supported.

## Low-level building blocks

The client is assembled from small pieces that are exported for advanced use:

```ts
import {
  createSSEParser,
  createSSEMessageStream,
  createBatcher,
  createRingBuffer,
} from "@songfreedom/sse-client";

// bytes → messages, as a standard TransformStream
const messages = response.body!.pipeThrough(createSSEMessageStream({ parse: JSON.parse }));

// raw frames, if you want to drive the loop yourself
const parser = createSSEParser({ onEvent: (event) => console.log(event) });
parser.feed("event: ping\ndata: 1\n\n");

// fixed-capacity history: O(1) push, one allocation, oldest value overwritten
const ring = createRingBuffer<SSEMessage>({ capacity: 500 });
ring.push(message);
ring.toArray(); // a fresh array, safe to hand to a reactive ref
ring.into(reused); // same order, into an existing array, no allocation
```

A ring buffer is a *storage* bound, not a sliding window: it answers "the last N values",
not "the values of the last T seconds". Aggregating across a known gap produces a
number that is wrong without being obviously wrong, so keep business windows on the
server and use the buffer for what the chart displays.

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
pnpm coverage     # vitest + the thresholds in vitest.config.ts
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # dist/ + dist/package.json
```

Integration demo (real browser + real Nginx, plus a headless smoke run):
see [demo/README.md](./demo/README.md) — `pnpm demo:server` / `pnpm demo:smoke` /
`pnpm demo:matrix` / `pnpm demo:memory`.

CI runs the whole pipeline on Node 18, 20 and 22; coverage thresholds and the headless
demo smoke run once, on Node 20.

Releasing: add the CHANGELOG entry, bump the version, tag the commit, then

```bash
git tag -a v0.1.4 -m "v0.1.4"
pnpm publish:npm  # build + publish to npmjs (access: public)
```

## License

[MIT](./LICENSE)
