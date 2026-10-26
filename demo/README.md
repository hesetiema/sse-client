# Integration demo

English · [简体中文](./README.zh-CN.md)

Covers everything the checklist cannot test with mocks: a real browser, a real Nginx
and a real streaming response.

| File | Purpose |
| --- | --- |
| `server.mjs` | Dependency-free SSE server (`127.0.0.1:8787`): Bearer auth, `Last-Event-ID` resume, 16 fault/boundary/pressure scenarios |
| `index.html` + `main.js` | Browser console: endpoint switch, scenario switch, every client option exposed, plus a memory sampler; the UI toggles between EN and 中文 |
| `smoke.mjs` | Headless smoke test: direct / gateway / resume in one command, CI-friendly |
| `browser-matrix.mjs` | Real Chrome / Edge automation: 11 scenarios over CDP, no Playwright |
| `memory-probe.mjs` | Memory pressure test: flood the stream, sample the heap over CDP, compare before/after GC |
| `nginx.conf` | Local Nginx: 8081 correct, 8082 deliberately broken |
| `nginx.docker.conf` | Same for Docker, only the upstream address differs |

## 1. Start the server

```bash
pnpm build          # the page imports dist/, so build first
pnpm demo:server    # same as node demo/server.mjs
```

Open <http://127.0.0.1:8787/demo/index.html>, click **Connect**, events should stream in.

> Testing the API only? Skip `pnpm build`; the server itself has no dependencies.

## 2. Start Nginx

Docker (recommended on Windows):

```bash
# The container reaches the host, so the server must listen on 0.0.0.0
HOST=0.0.0.0 pnpm demo:server
# PowerShell: $env:HOST='0.0.0.0'; pnpm demo:server

docker run --rm -p 8081:8081 -p 8082:8082 \
  -v "${PWD}/demo/nginx.docker.conf:/etc/nginx/nginx.conf:ro" nginx:alpine
```

> `nginx.docker.conf` is a full config (`worker_processes` / `events` / `http`), so it must
> be mounted at `/etc/nginx/nginx.conf`. Mounting it into `conf.d/` fails with
> `"worker_processes" directive is not allowed here`.

Local Nginx (from the repo root):

```bash
nginx -p demo -c nginx.conf
# stop
nginx -p demo -c nginx.conf -s stop
```

The console offers three endpoints:

| Endpoint | Meaning |
| --- | --- |
| Direct `:8787` | Baseline without a gateway |
| `:8081` | `proxy_buffering off` + `gzip off`, should match the baseline |
| `:8082` | Three mistakes at once, reproduces "connected but nothing arrives" |

8082 stacks three problems, any one of which stalls SSE:

1. `proxy_http_version 1.0` — no chunk boundaries upstream, so the gateway can only flush when full (most deterministic, any client);
2. `proxy_buffering on` with large buffers — guaranteed on older Nginx and HTTP/1.0 upstreams;
3. `gzip on` + `gzip_types text/event-stream` — browsers always send `Accept-Encoding`, and compression buffers.

>> Measured (nginx 1.29 / alpine): with `proxy_buffering on` alone and an HTTP/1.1 upstream,
>> small frames still get through, so the config combines HTTP/1.0 and gzip to make the
>> failure reproducible. Verifying the gzip path with curl requires `--compressed`.

## 3. Scenario expectations

| Scenario | Expected | What it validates |
| --- | --- | --- |
| `normal` | Events on every interval, ids increasing, UTF-8 payload intact | Basic streaming + decoding |
| `chunked` | One frame in 3 writes, cut inside a 3-byte character, still clean | `TextDecoder({stream})` |
| `heartbeat` | `idleTimeout=1000` → heartbeat error and reconnect; `6000` → stays open | Heartbeat vs watchdog |
| `silent` | `idleTimeout=3000` → heartbeat error after 3s, no dead waiting | Zombie connections |
| `end` | Reconnect when enabled; otherwise `closed` with reason `end` | `reconnectOnEnd` |
| `done` | `data: [DONE]` closes immediately with no JSON error | `endSignal` |
| `retry-field` | Reconnect roughly 2s after the drop (compare timestamps) | Server `retry:` |
| `huge` | 2MB message → `protocol` error, `closed`; with "Drop oversized messages" ticked only that message is lost | `maxBufferSize` + `overflowPolicy` |
| `no-blank-line` | Past 1MB → `protocol` error (older builds grew the buffer) | Per-event buffer cap |
| `slow` | `connecting` lasts 3s (a gateway's 60s read timeout would cut it) | Slow handshake |
| `accel` | `X-Accel-Buffering: no` bypasses the 8082 buffering | Upstream escape hatch |
| `html` | 200 + `text/html` → `protocol` error, single request | Gateway login page |
| `error500` | Exponential backoff, `closed` once `maxRetry` is spent | Backoff + retry budget |
| `error401` | One request then `closed`; with "Refresh token on 401" it recovers | Terminal errors + `retry` policy |
| `flood` | `burst` events every `interval`, sustained: heap saw-tooths, `dom` stays flat, no errors | High-frequency long-lived connection |
| `burst` | `burst` events (default 2000 ≈ 400KB) in one write: a single synchronous parse task | Cost of one big chunk |

`flood` / `burst` take their payload from the "burst" and "payload bytes" fields; they are
what `memory-probe.mjs` drives.

## 4. Command-line checks

```bash
# One command: direct reachable, both gateway entries behave, resume works.
pnpm build && pnpm demo:smoke
# PASS/FAIL plus an exit code, ready for CI
```

Measured output with 8082 misconfigured:

```text
Direct       http://127.0.0.1:8787       received 13 events live
             first: ALARM:1, ALARM:2
Nginx :8081  http://127.0.0.1:8081       received 12 events live
Nginx :8082  http://127.0.0.1:8082       no data (status=connecting, typical gateway buffering)

Last-Event-ID resume: RESUME → ALARM:6 → ALARM:7
PASS  direct endpoint receives events
PASS  resume starts at id=6
```

The same stream with curl:

```bash
# token
curl -X POST "http://127.0.0.1:8787/auth/token?ttl=60000"

# direct (‑N disables curl's own buffering)
curl -N -X POST "http://127.0.0.1:8787/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'

# through both gateways: 8081 streams, 8082 stays silent
curl -N -X POST "http://localhost:8081/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
curl -N -X POST "http://localhost:8082/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
```

## 5. Browser matrix

### 5.1 Automated (Chromium)

```bash
pnpm build && pnpm demo:server          # terminal 1
docker run ...                          # terminal 2, see section 2
pnpm demo:matrix                        # Chrome + Edge, 11 scenarios each
pnpm demo:matrix --only=edge            # a single browser
node demo/browser-matrix.mjs --shots=D:\shots   # custom screenshot dir (default %TEMP%\sse-matrix)
```

Drives real browsers over CDP with Node's built-in WebSocket, no Playwright:

| Scenario | Assertion |
| --- | --- |
| Direct stream | ≥4 events, `open` |
| Nginx 8081 (correct) | ≥4 events, `open` |
| Nginx 8082 (misconfigured) | 0 events, stuck in `connecting` |
| Chunked + multibyte | ≥2 events, no `U+FFFD` |
| 2MB over the cap | `protocol` error, `closed` |
| `[DONE]` terminates | 2 events then `closed`, reason `end` |
| Server end, no reconnect | 3 events then `closed` |
| Silent stream + idleTimeout | `heartbeat` error and a retry |
| Offline 0.8s recovery | back to `open`, no `close error`, events keep growing |
| Background suspend → resume | `idle` and silent while hidden, `open` and streaming after |
| Constructed while hidden | 0 events/`idle` before, streaming after (P0 regression) |

Last run: Chrome 155.0.8059.85 / Edge 155.0.4283.62, **22/22 PASS**, stable across repeated runs.

Known limits:

- Chromium only. Chrome and Edge are the only automatable browsers on Windows; Safari and iOS WebView need a device (see 5.2).
- Headless cannot toggle tab visibility for real: background tabs stay `visible` and
  `Page.setWebLifecycleState("active")` never restores `visibilityState`. The two background
  scenarios therefore fake `document.hidden` only; the `visibilitychange` event and the
  client handling are real.
- The 8082 failure depends on the `HTTP/1.0 + gzip` combination; `proxy_buffering on` alone
  does not reproduce on nginx 1.29.

### 5.2 Manual device checklist

Run once per engine (Chrome / Edge / Safari / iOS Safari on a device; WeChat or an App WebView when relevant):

- [ ] `normal` arrives live, UTF-8 payload intact
- [ ] Enable `pauseWhenHidden`, send the tab to the background for 5 minutes, come back: streaming resumes (the P0 fixed here)
- [ ] Disconnect the network for 10s, reconnect: automatic recovery, `lastEventId` preserved
- [ ] Revoke the token and restart: with the refresh policy it self-heals, without it exactly one request
- [ ] `idleTimeout` + `heartbeat` does not kill a healthy connection
- [ ] `rotateInterval=30000` loses no events and `lastEventId` stays continuous
- [ ] 8082 endpoint reproduces the stall → proves the gateway config is the root cause, not the client
- [ ] After closing the page or unmounting the component, the server sees the connection go away

## 6. High frequency / memory measurement

"Will a long-lived SSE connection push a tab to several GB?" is not a question to answer by
reasoning. Measure it:

```bash
pnpm build && pnpm demo:server                          # terminal 1
pnpm demo:memory                                        # default: 10 × 1KB / 20ms for 60s
pnpm demo:memory --seconds=30 --burst=50 --size=8192    # heavy: ≈12 MB/s
pnpm demo:memory --lang=zh --shots=%TEMP%\shots         # also grabs a 中文 screenshot
```

The probe does three things: it forces `HeapProfiler.collectGarbage` before reading the heap
(only the post-GC delta separates "buffering" from "leaking"), it takes main-thread time from
`Performance.getMetrics`, and it cross-checks `performance.memory` from inside the page.

Measured (Chrome 155 headless, `--enable-precise-memory-info`, single tab):

| Phase | Duration | Events | Received | Peak heap | After GC | vs baseline | DOM nodes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default 10×1KB / 20ms | 60s | 19,620 | 16.4 MB | 1.7 MB | 0.9 MB | +0.3 MB | 117 → 117 |
| heavy 50×8KB / 20ms | 30s | 48,000 | 368.3 MB | 4.6 MB | 0.8 MB | +0.2 MB | 117 → 117 |
| single-chunk burst | 2.5s | 2,000 | 0.2 MB | 1.9 MB | 0.8 MB | +0.2 MB | 117 → 117 |

**368 MB in, 4.6 MB peak, back to baseline after GC.** The connection keeps no history of its
own; the peak is unreclaimed garbage (a saw-tooth). The heavy phase used ~2.7s of main thread
(≈9%) over 30s, with no errors, no disconnects and a constant DOM node count.

Worth knowing:

- The probe calls `__setLogEnabled(false)` while sampling. The console's log is capped at 400
  rows, so leaving it on makes the DOM — not the stream — the thing that grows, and the numbers
  stop meaning anything. With a human watching, the log stays on and self-throttles to ~20
  rows/s, reporting how many events it skipped.
- In-page `performance.memory` runs well above the CDP reading during a flood (young generation
  not yet collected) and converges to ~0.9 MB after GC. That gap is the usual source of "the tab
  is using gigabytes" reports: click the trash icon in DevTools to force a GC first.
- The three ways a tab really does reach GBs are all outside this library: the app keeping every
  message in an array or a reactive store, DevTools' Network panel recording every frame, or
  `pauseWhenHidden` left off while a background page keeps writing into state.
- For a longer soak use `--seconds=600`; the sample ring is capped at 300 entries, so the probe
  itself does not grow.

### 6.1 Long tasks and yielding

The console gained two knobs: `yieldEvery` (yield to the main thread every N events) and "handler cost
(ms/msg)", which busy-waits to mimic real per-message rendering. Set the latter to 1ms, run `flood`
at 25 per 50ms, and put 2000 events into one `burst` chunk:

```bash
pnpm demo:memory --seconds=12 --interval=50 --burst=25 --size=512 --handler=1 --yield=0
pnpm demo:memory --seconds=12 --interval=50 --burst=25 --size=512 --handler=1 --yield=20
```

| `yieldEvery` | Longest burst block | Burst main-thread total | Events |
| --- | --- | --- | --- |
| `0` | **1467 ms** | 2032 ms | 2000 |
| `20` | **117 ms** | 2046 ms | 2000 |

The total work is identical — slicing saves no time — but the longest block drops by 12x. The
residual ~117ms is not a slice-size artefact: `yieldEvery: 5` measures the same 117ms, because two
seconds of backlog keeps rendering starved. Slicing only guarantees there is no single runaway task.

`overflowPolicy` is exposed too (the "Drop oversized messages instead of closing" checkbox). Tick it
and run `huge`: the connection stays `open`, only that message is discarded, and the log shows an
`overflow` row with the running count. Unticked, it is the old `protocol` error plus `closed`.

## Notes

- The demo is plain HTTP with `Access-Control-Allow-Origin: *`; local use only.
- `main.js` imports `dist/index.js`, so rebuild after changing `src/`.
- Tokens live in memory on the server and die on restart; the page re-issues them automatically.
