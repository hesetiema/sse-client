# Consumer examples

Each folder is a standalone, runnable example of how a business layer consumes the client.
They all reuse the 16 scenarios in `demo/server.mjs` and need no frontend build.
Every page carries an editable config panel: change a field and the page reconnects with
the new settings, no edit-and-reload.

```bash
pnpm build && pnpm demo:server
# open http://127.0.0.1:8787/demo/consumers/<folder>/index.html
```

| Folder | Business scenario | Building blocks | What to look at |
| --- | --- | --- | --- |
| `alarm-center/` | Alarm center: not one event lost, and provable | `SSEClient` · `request` group · `retry` · `resume.persist` · `hooks.gap` / `hooks.resume` | 401 self-healing, resume after reload, dedupe by id |
| `point-board/` | Point dashboard: high write rate, constant memory | `createBatcher` · `fanout()` · `createRingBuffer` · `yieldEvery` | 300ms coalescing, one repaint per frame, `evicted` |
| `multi-tab/` | Big screen open in several tabs | `createMultiTabSSE` | leader owns the connection, followers relay; close the leader to watch takeover |
| `vue-shared/` | Vue components and tenant switches | `useSharedSSE` · `subscription` getter · `grace` | switching tenants reuses the connection; explicit `dispose` on unmount |

`shared/token.js` is the token helper the examples share; it is not part of any example.

## Editable panel

Each page renders its controls from `shared/panel.js` (styles in `shared/panel.css`).
Edits apply after 300ms and rebuild the connection; **恢复默认** restores the shipped
values, **重新连接** re-applies the current ones unchanged. Settings live in
`sessionStorage` per page, so a reload keeps them — which is also why `alarm-center`
still resumes after F5.

| Page | Fields |
| --- | --- |
| `alarm-center` | scenario (`normal` / `slow` / `heartbeat` / `chunked` / `end`), interval, `idleTimeout`, remember-the-resume-point, explicit start position |
| `point-board` | scenario (`flood` / `burst` / `normal`), interval, frames per batch, payload bytes, `yieldEvery` |
| `multi-tab` | scenario (`normal` / `slow` / `heartbeat`), interval, `idleTimeout` — keep both tabs on the same values; a promoted tab resumes with its own |
| `vue-shared` | scenario, interval, `idleTimeout` — these are refs, so editing one changes the share key and releases the old connection |

Two things the panel makes visible:

- `alarm-center` keys the resume point by the request, so switching the scenario opens a
  fresh subscription (new key, no stale position) instead of "resuming" a stream that
  never existed.
- `point-board` keeps its ring buffer across a config change, so editing a field does not
  wipe the chart — only the connection is rebuilt.

Things worth breaking on purpose:

- `alarm-center`: hit F5 while connected — the log should resume from the last id and report `skipped=1` / `continuous=true` (`skipped` is `firstId - lastId`, so 0 would mean the server replayed the last event); then `POST /auth/revoke` on the server and watch the 401 heal itself.
- `point-board`: pick `burst` in the panel and set frames per batch to 2000 to push 2000 events in one chunk; compare `yieldEvery` 0 vs 20 for the longest main-thread block (each change rebuilds the client, the ring buffer survives).
- `multi-tab`: open the same URL in two tabs — one `leader`, one `follower`, event counters moving together while only one connection exists.
- `vue-shared`: switching tenants changes the share key and releases the old connection. Sharing is per tab (in-page reference counting): for one connection across tabs, `multi-tab/` is the example — `createMultiTabSSE` is what spans tabs, `useSharedSSE` does not.
