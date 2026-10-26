# Integration demo

Covers everything the checklist cannot test with mocks: a real browser, a real Nginx
and a real streaming response.

| File | Purpose |
| --- | --- |
| `server.mjs` | Dependency-free SSE server (`127.0.0.1:8787`): Bearer auth, `Last-Event-ID` resume, 14 fault/boundary scenarios |
| `index.html` + `main.js` | Browser console: endpoint switch, scenario switch, every client option exposed |
| `smoke.mjs` | Headless smoke test: direct / gateway / resume in one command, CI-friendly |
| `browser-matrix.mjs` | Real Chrome / Edge automation: 11 scenarios over CDP, no Playwright |
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
| `huge` | 2MB message → `protocol` error, `closed` | `maxBufferSize` |
| `no-blank-line` | Past 1MB → `protocol` error (older builds grew the buffer) | Per-event buffer cap |
| `slow` | `connecting` lasts 3s (a gateway's 60s read timeout would cut it) | Slow handshake |
| `accel` | `X-Accel-Buffering: no` bypasses the 8082 buffering | Upstream escape hatch |
| `html` | 200 + `text/html` → `protocol` error, single request | Gateway login page |
| `error500` | Exponential backoff, `closed` once `maxRetry` is spent | Backoff + retry budget |
| `error401` | One request then `closed`; with "Refresh token on 401" it recovers | Terminal errors + `retry` policy |

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

## Notes

- The demo is plain HTTP with `Access-Control-Allow-Origin: *`; local use only.
- `main.js` imports `dist/index.js`, so rebuild after changing `src/`.
- Tokens live in memory on the server and die on restart; the page re-issues them automatically.
