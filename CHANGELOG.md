# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Resume-point hygiene, and the second channel a freshly opened page needs. The theme is
the one thing a client can still get wrong after it has a cursor: a cursor the server
cannot match.

### Added

- `isValidEventId(id)`: an id must be non-empty, free of `\r`/`\n`/`\0`, and free of
  leading/trailing whitespace to survive the `Last-Event-ID` round trip. Exported so a
  server and its tests use the same rule.
- Inbound ids are validated **before** they are accepted. An unmatchable id no longer
  advances the resume point: the message is still delivered under the previous id, the
  event is counted in `invalidIds`, and `hooks.gap` reports it once with `reason: "id"`.
  The report has its own slot, so a contract violation early in the stream cannot mask the
  `reconnect` gap that follows it.
- `resume.dedupe`: suppress events whose id was already delivered, across reconnects. Off by
  default — the client reports inclusive replays through `hooks.resume` (`skipped === 0`)
  instead of dropping them. Counted in `duplicates`.
- `createJoinClient()` / `deriveJoinUrl()` / `JOIN_START_OFFSET`: a read-only `GET` replay of
  a run from its first event, for a new tab or a reload. It sends no `Last-Event-ID`, does not
  reconnect past the end, and resolves `done` with the tail id to hand to `setResumePoint`.
- README: a server-contract section covering what `Last-Event-ID` needs to be trustworthy —
  unique ids, persist-before-send, disconnect ≠ cancel, the read-only join route, and the
  snapshot semantics `hooks.gap` assumes.

### Changed

- `setResumePoint(id)` refuses an id that cannot be echoed back (keeping the previous point
  and counting it) instead of installing it and breaking the next connection.
- A resume point restored from storage through the same check: a poisoned
  `sessionStorage` entry is dropped rather than reused on every reconnect.

## [0.2.0] — 2026-10-27

The release that makes the option list readable — six groups instead of 38 top-level
fields — and turns the sharing helpers into things you import on purpose.

### Added

- `client.fanout()`: one `"*"` subscription behind many consumers, each with its own
  unsubscribe, plus a latest-payload snapshot per event name.
- `client.use(plugin)`: cross-cutting behaviour (metrics, logging, gap accounting) attached
  once; a returned function runs on close.
- `body` accepts a factory, re-evaluated before every (re)connect, so a subscription can
  follow reactive filters without rebuilding the client.
- `credentials` (defaults to `"same-origin"`).
- Readiness gate `when` for `useSSE` / `useSharedSSE`: no request is issued while it
  returns false, and the connection is released when it shuts.
- `@songfreedom/sse-client/testing`: `createMockSSEFetch` drives reconnects, resume, hung
  gateways and rotation in-process, without a server or a test runner dependency.
- `demo/consumers-check.mjs` (`pnpm demo:consumers`): drives the four consumer examples in a
  real browser — leader/follower split and takeover, F5 resume, 401 self-heal, tenant switch,
  ring buffer under pressure, and a config edit landing as a rebuild / new share key. These
  pages had no automated coverage before.
- The consumer example pages can be driven from the browser: a shared config panel
  (`demo/consumers/shared/panel.js`) exposes scenario, interval, `idleTimeout`,
  `yieldEvery` and friends, applies edits after 300ms by rebuilding the connection, and
  keeps the values in `sessionStorage`.
- `demo/browser-matrix.mjs` now covers every fault scenario in `demo/server.mjs`: 11 → 20
  cases, adding heartbeat + `idleTimeout`, the `retry:` field, an unterminated event hitting
  the buffer cap, slow headers, `200 + text/html`, `500` backoff exhaustion, terminal `401`
  and the `accel` upstream escape hatch.

### Changed

- `deriveShareKey` resolves a `body` factory, so two filter values never share a connection
  by accident.
- A plugin that throws is reported through `onHandlerError` like any other callback;
  `console.error` remains the fallback when no handler is configured.
- `useSSE({ when })` reports `idle` while the gate is shut instead of `closed`, matching
  the shared flavour — a pause is not the end of the stream.
- Options are grouped by what they affect — `request`, `resume`, `retry`, `stream`,
  `limits`, `hooks` — instead of 38 top-level fields. The flat spelling still works
  (deprecated, one minor version) and a grouped value wins when both are set, so adoption
  can be incremental per call site.
- `createMultiTabSSE` is only importable from `./multi-tab`. Re-exporting it from `.` put
  the election and relay code in every bundle, including the ones that never share across
  tabs.
- The shared-registry helpers (`getSharedSSEClients`, `getSharedSSEClientCount`,
  `closeAllSharedSSEClients`) moved from `.` to `./testing`: they exist for tests and
  teardown, not for application code.
- Documentation is organised by decision instead of by API: a selection table for every way in
  (with what each one costs), a one-page continuity model that separates
  `hooks.gap` from `hooks.resume`, and a "use when / not for" line on every recipe.

### Removed

- `flags`: put the query string into `url` instead. It was only appended to the request
  and folded into the share key, so nothing else changes.
- `onOverflow` (the option, the method, and the same member on `useSharedSSEClient` and
  `createMultiTabSSE`). A dropped message is a continuity problem: it is reported through
  `hooks.gap` / `onSuspectGap` with `reason: "drop"`, and `dropped` keeps the count.

### Fixed

- The browser matrix's `silent` case returned an interpolated string where a boolean was
  expected, so it could never fail; it now asserts the `heartbeat` error and a retry.
- The mock wrote a multi-line payload as one `data:` line, ending the field early and
  dropping the rest.
- The mock lost custom headers when they were passed as a `Headers` instance or tuples,
  and kept a cancelled stream's controller alive.

## [0.1.4] — 2026-10-27

The release that turns "the connection came back" into "we know how much of the stream
we still have".

### Added

- **Resume verification**: `onResume` / `SSEResumeInfo` report how far the new stream
  jumped after a reconnect (`lastId`, `firstId`, `skipped`, `continuous`). `skipped` and
  `continuous` stay `undefined` for opaque ids instead of guessing an order the spec
  never promised.
- **Gap signal**: `onSuspectGap` / `SSEGapInfo` / `SSEGapReason` fire once per episode when
  the client cannot prove continuity (`reconnect`, `resume`, `rotate`, `drop`, `promote`).
- **Cross-reload resume**: `resumeFrom` seeds the first `Last-Event-ID`; `persistKey` /
  `persistStorage` keep `lastEventId` in storage (throttled to 1/s, flushed on close and
  `pagehide`).
- **Gap-free rotation**: `rotateMode: "overlap"` opens the replacement while the current
  stream keeps flowing and takes it over only once it is accepted; `rotateTimeout` bounds
  the wait. A rejected candidate is reported through `onError` and leaves the running
  connection untouched.
- `setResumePoint(id)` replaces the resume point used by the **next** connection, so an
  `onSuspectGap` handler can heal the gap without desynchronising the live parser.
- **`Retry-After` support**: an `http` error carries `retryAfter` (ms), and the built-in
  backoff uses it — clamped between 200ms and `retryMaxDelay` — instead of the exponential
  curve. Custom `retry` policies can read the same field.
- **New `./multi-tab` entry**: `createMultiTabSSE` elects one leader tab (Web Locks by
  default), relays events over `BroadcastChannel`, reports `onRole`, and emits
  `reason: "promote"` when a follower takes over with a resume point it did not own.
- **Shared connections**: `acquireSSEClient`, `useSharedSSEClient` (re-configurable
  handle with reference counting and an optional `grace`), `deriveShareKey`,
  `getSharedSSEClients`, `getSharedSSEClientCount`, `closeAllSharedSSEClients`.
- **Vue adapters**: `useSSE` (with `shared` mode) and `useSharedSSE` (reactive
  `subscription` getter), both with explicit `dispose()`.
- **Building blocks**: `createRingBuffer` for fixed-capacity history, `jsonParse` for a
  decoder that keeps unparsable frames, `deriveResumeKey` / `RESUME_KEY_PREFIX`.

### Changed

- `useSharedSSEClient` returns a handle whose `configure()` can move a consumer to another
  subscription without cutting peers off, and whose listeners are re-attached whenever the
  underlying client changes.
- `SSEClient.on()` keeps payload types inferred from the event map, including `on("*")`.

### Fixed

- `start()` called while a `close()` is still unwinding now queues itself, so
  `stop(); start();` in the same tick actually reconnects instead of doing nothing.

## [0.1.3] — 2026-10-26

### Added

- `yieldEvery`: parse at most N events per task, then yield to the event loop, so a burst
  no longer blocks input and paint.
- `maxBufferSize` and `overflowPolicy: "close" | "drop"`: an oversized message either ends
  the stream with a terminal `protocol` error or is discarded while streaming continues
  (`dropped` counts them).
- Bounded batching window in `createBatcher`.

### Fixed

- Resumed clients reconnected after a suspend instead of staying suspended.
- `restart()` issued while the previous read loop was still unwinding is honoured.

## [0.1.2] — 2026-10-23

### Changed

- Repository metadata points at GitHub; publish flow documented.

## [0.1.0] — 2026-10-23

### Added

- First release: `fetch`-based SSE transport, typed event routing, reconnect with
  `Last-Event-ID` resume, idle watchdog, scheduled rotation, pluggable retry policy and
  the optional Vue 3 entry point.

[0.2.0]: https://github.com/hesetiema/sse-client/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/hesetiema/sse-client/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/hesetiema/sse-client/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/hesetiema/sse-client/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/hesetiema/sse-client/releases/tag/v0.1.0
