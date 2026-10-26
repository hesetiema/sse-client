// Dependency-free SSE server for integration testing.
//
// Covers the real-world cases from the test checklist: POST + JSON body + Bearer
// auth, multi-byte chunk splitting, heartbeats, Last-Event-ID resume, server
// `retry:`, gateway error pages and buffer-busting payloads.
//
//   node demo/server.mjs            # 127.0.0.1:8787 by default
//   PORT=9000 node demo/server.mjs
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Scenario catalogue; the browser console builds its dropdown from this. */
const SCENARIOS = [
  { id: "normal", label: "normal — one ALARM per interval (UTF-8 payload)" },
  { id: "chunked", label: "chunked — one frame in 3 writes, split inside a 3-byte char" },
  { id: "heartbeat", label: "heartbeat — only `: ping` comments, no data" },
  { id: "silent", label: "silent — not a single byte after the handshake" },
  { id: "end", label: "end — 3 events, then the server ends the stream" },
  { id: "done", label: "done — 2 events, then data: [DONE]" },
  { id: "retry-field", label: "retry-field — sends retry: 2000, then disconnects" },
  { id: "huge", label: "huge — a single 2MB data line" },
  { id: "no-blank-line", label: "no-blank-line — data lines only, never a blank line" },
  { id: "slow", label: "slow — response headers after 3s" },
  { id: "accel", label: "accel — normal + X-Accel-Buffering: no" },
  { id: "html", label: "html — 200 + text/html (gateway login page)" },
  { id: "error500", label: "error500 — plain 500" },
  { id: "error401", label: "error401 — plain 401 (expired token)" },
  { id: "flood", label: "flood — burst events per interval, fixed payload size (pressure test)" },
  { id: "burst", label: "burst — burst events in ONE write, then idle (single-chunk parse)" },
];

const tokens = new Map();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function issueToken(ttlMs) {
  const token = `tk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  tokens.set(token, Date.now() + ttlMs);
  return { token, expiresIn: ttlMs };
}

function authorize(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith("Bearer ")) return false;
  const token = value.slice("Bearer ".length).trim();
  const expiresAt = tokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, last-event-id, accept",
  "Access-Control-Max-Age": "600",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** One complete SSE frame. */
function frame(id, event, data) {
  let out = "";
  if (id !== null && id !== undefined) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  out += `data: ${data}\n\n`;
  return out;
}

function payload(seq) {
  return JSON.stringify({
    seq,
    topic: "alarm",
    level: seq % 2 ? "high" : "low",
    deviceName: `Cooling-Tower-${seq}`,
    note: "UTF-8 probe: Ünïcödé ✓ 😀",
    at: new Date().toISOString(),
  });
}

/** Large payload for the pressure scenarios; the filler is built once per connection. */
function bigPayload(seq, filler) {
  return JSON.stringify({
    seq,
    topic: "alarm",
    level: "high",
    device: `pump-${seq % 64}`,
    at: Date.now(),
    filler,
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(""));
  });
}

function scenarioFromBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (Array.isArray(parsed)) return undefined;
    return typeof parsed?.scenario === "string" ? parsed.scenario : undefined;
  } catch {
    return undefined;
  }
}

async function handleSubscribe(req, res, url) {
  const body = req.method === "POST" ? await readBody(req) : "";
  const params = url.searchParams;
  const scenario = params.get("scenario") ?? scenarioFromBody(body) ?? "normal";
  const interval = clamp(Number(params.get("interval") ?? 1000), 20, 120_000);
  const count = clamp(Number(params.get("count") ?? 0), 0, 1_000_000);
  // Pressure scenarios only: events per tick and payload size used to build the burst.
  const burstDefault = scenario === "burst" ? 2000 : 10;
  const burst = clamp(Number(params.get("burst") ?? burstDefault), 1, 20_000);
  const size = clamp(Number(params.get("size") ?? 1024), 64, 256 * 1024);
  const retryMs = clamp(Number(params.get("retry") ?? 0), 0, 120_000);
  const delay = clamp(Number(params.get("delay") ?? 3000), 0, 120_000);
  const lastEventId = req.headers["last-event-id"];

  // Failures before the handshake: the client should classify these as terminal
  // or retryable in openOnce().
  if (scenario === "html") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body>Please sign in (simulated gateway login page)</body></html>");
    return;
  }
  if (scenario === "error500") {
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
    return;
  }
  if (scenario === "error401") {
    res.writeHead(401, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "token expired" }));
    return;
  }
  if (scenario === "slow") await sleep(delay);

  res.writeHead(200, {
    ...CORS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Demo-Scenario": scenario,
    // Server-side escape hatch: only the accel scenario sends it, to show that
    // an upstream can opt out of gateway buffering.
    ...(scenario === "accel" ? { "X-Accel-Buffering": "no" } : {}),
  });
  res.flushHeaders?.();

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  req.on("close", stop);
  res.on("close", stop);
  res.on("error", stop);

  const write = (chunk) => {
    if (!stopped) res.write(chunk);
  };

  const emit = (seq, event = "ALARM") => write(frame(seq, event, payload(seq)));

  /**
   * Backpressure-aware write: `res.write()` returning false means the socket
   * buffer is full, so wait for "drain" instead of queueing chunks in memory.
   * Without this a fast producer grows the server's own buffer without bound.
   */
  const writeDrained = (chunk) =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      if (res.write(chunk)) {
        resolve();
        return;
      }
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });

  try {
    switch (scenario) {
      case "normal":
      case "accel": {
        if (retryMs) write(`retry: ${retryMs}\n\n`);
        const header = Number(lastEventId);
        let seq = Number.isFinite(header) && header > 0 ? header : 0;
        if (seq > 0) {
          write(
            frame(
              null,
              "RESUME",
              JSON.stringify({ from: seq, note: "server resumed from Last-Event-ID, no replay" }),
            ),
          );
        }
        let sent = 0;
        for (;;) {
          if (stopped) break;
          seq += 1;
          sent += 1;
          emit(seq);
          if (count > 0 && sent >= count) break;
          await sleep(interval);
        }
        break;
      }

      case "chunked": {
        let seq = 0;
        for (;;) {
          if (stopped) break;
          seq += 1;
          const buffer = Buffer.from(frame(seq, "ALARM", payload(seq)));
          // Put the cut inside the 3 UTF-8 bytes of "✓" to exercise the
          // streaming TextDecoder on the client side.
          const marker = Buffer.from("✓");
          const index = buffer.indexOf(marker);
          const cut = index >= 0 ? index + 1 : Math.floor(buffer.length / 2);
          write(buffer.subarray(0, cut));
          await sleep(150);
          write(buffer.subarray(cut, cut + 2));
          await sleep(150);
          write(buffer.subarray(cut + 2));
          await sleep(interval);
        }
        break;
      }

      case "heartbeat": {
        for (;;) {
          if (stopped) break;
          write(": ping\n\n");
          await sleep(interval);
        }
        break;
      }

      case "silent": {
        // Keep the connection open without a single byte: the idle watchdog
        // should treat it as a zombie and reconnect.
        while (!stopped) await sleep(1000);
        break;
      }

      case "end": {
        for (let seq = 1; seq <= 3; seq += 1) {
          emit(seq);
          await sleep(interval);
        }
        break;
      }

      case "done": {
        emit(1);
        emit(2);
        write("data: [DONE]\n\n");
        break;
      }

      case "retry-field": {
        write("retry: 2000\n\n");
        emit(1);
        await sleep(200);
        break;
      }

      case "huge": {
        // maxBufferSize defaults to 1MB, so this always trips a protocol error.
        write(`data: ${"x".repeat(2 * 1024 * 1024)}\n\n`);
        await sleep(interval);
        break;
      }

      case "no-blank-line": {
        // Every line is small, but the event is never terminated: the old
        // maxBufferSize check could not see the accumulated payload.
        const line = `data: ${"x".repeat(4096)}\n`;
        for (;;) {
          if (stopped) break;
          write(line);
          await sleep(10);
        }
        break;
      }

      case "flood": {
        // Sustained pressure: `burst` frames every `interval`, each `size` bytes.
        // Defaults are 10 frames per 20ms tick ≈ 500 events/s at ~1KB each.
        const filler = "x".repeat(Math.max(0, size - 240));
        let seq = 0;
        for (;;) {
          if (stopped) break;
          let chunk = "";
          for (let i = 0; i < burst; i += 1) {
            if (count > 0 && seq >= count) break;
            seq += 1;
            chunk += frame(seq, "ALARM", bigPayload(seq, filler));
          }
          if (chunk) await writeDrained(chunk);
          if (count > 0 && seq >= count) break;
          await sleep(interval);
        }
        break;
      }

      case "burst": {
        // A single write carrying `burst` frames (default 2000 ≈ 400KB): the
        // client parses the whole chunk in one task, which is where main-thread
        // long tasks come from. The connection then stays open but idle.
        const filler = "x".repeat(Math.max(0, size - 240));
        let chunk = "";
        for (let seq = 1; seq <= burst; seq += 1) {
          chunk += frame(seq, "ALARM", bigPayload(seq, filler));
        }
        await writeDrained(chunk);
        while (!stopped) await sleep(1000);
        break;
      }

      default: {
        // Headers are already sent, so report the bad scenario as an event.
        write(
          `event: DEMO_ERROR\ndata: ${JSON.stringify({ error: `unknown scenario: ${scenario}` })}\n\n`,
        );
      }
    }
  } finally {
    res.end();
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (pathname === "/health") {
      json(res, 200, { ok: true, port: PORT, uptime: Math.round(process.uptime()), scenarios: SCENARIOS.length });
      return;
    }
    if (pathname === "/scenarios") {
      json(res, 200, SCENARIOS);
      return;
    }
    if (pathname === "/auth/token") {
      const ttl = clamp(Number(url.searchParams.get("ttl") ?? 60_000), 1_000, 24 * 3600_000);
      json(res, 200, issueToken(ttl));
      return;
    }
    if (pathname === "/auth/revoke") {
      const revoked = tokens.size;
      tokens.clear();
      json(res, 200, { revoked });
      return;
    }
    if (pathname === "/auth/verify") {
      const ok = authorize(req.headers.authorization);
      json(res, ok ? 200 : 401, { ok });
      return;
    }
    if (pathname === "/subscribe") {
      if (!authorize(req.headers.authorization)) {
        json(res, 401, { error: "unauthorized", hint: "POST /auth/token first" });
        return;
      }
      await handleSubscribe(req, res, url);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(res, pathname);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function serveStatic(res, pathname) {
  if (pathname === "/") {
    // Land in /demo/ so relative imports resolve to /demo/main.js
    res.writeHead(302, { Location: "/demo/index.html" });
    res.end();
    return;
  }
  const file = resolve(ROOT, `.${pathname}`);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    json(res, 404, { error: "not found", path: pathname });
    return;
  }
  if (!info.isFile()) {
    json(res, 404, { error: "not a file", path: pathname });
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`[demo] SSE demo server listening on http://${HOST}:${PORT}/demo/index.html`);
  console.log(`[demo] issue a token: POST http://${HOST}:${PORT}/auth/token?ttl=60000`);
});
