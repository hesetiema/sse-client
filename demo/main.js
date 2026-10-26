// Console logic: exposes every SSEClient switch so QA can drive scenarios by hand.
// Depends on dist/: run `pnpm build` first.
import { SSEClient } from "../dist/index.js";

const ENDPOINTS = {
  direct: "http://127.0.0.1:8787",
  nginx: "http://localhost:8081",
  broken: "http://localhost:8082",
};

const HINTS = {
  normal:
    "Events should arrive on the interval. Then switch to 'Nginx :8082' and compare: the stream stalls until the gateway buffer fills.",
  chunked: "One frame is written in 3 chunks, cutting inside a 3-byte character. No mojibake, no lost frames.",
  heartbeat: "Set idleTimeout to 1000 (below the 2s heartbeat) to force a reconnect; 6000 keeps it open.",
  silent: "idleTimeout 3000: expect a heartbeat error and a reconnect after 3s instead of a dead connection.",
  end: "With 'Reconnect when the server ends the stream' on it reconnects; turn it off and status becomes closed with reason=end.",
  done: "After data: [DONE] the client should close immediately, with no reconnect and no JSON parse error.",
  "retry-field": "The server sends retry: 2000, so the reconnect after the drop should wait about 2s (compare log timestamps).",
  huge: "A 2MB message exceeds the 1MB default: expect a protocol error, closed, no reconnect and no memory growth.",
  "no-blank-line":
    "Data lines without a terminating blank line: past 1MB the client should report a protocol error (older builds kept growing the buffer).",
  slow: "Headers arrive after 3s: watch how long connecting lasts; a gateway's default 60s read timeout would cut it.",
  accel: "The server sends X-Accel-Buffering: no, which bypasses :8082's proxy_buffering; gzip can still add delay.",
  html: "200 + text/html: expect a protocol error with a single request (the classic gateway login page).",
  error500: "Expect exponential backoff until maxRetry is exhausted, then closed.",
  error401: "By default one request then closed; tick 'Refresh token on 401' to swap the token and recover.",
};

const LOG_LIMIT = 400;
const $ = (id) => document.getElementById(id);

let client = null;
let token = null;
let refreshes = 0;
let eventCount = 0;

/* ---------------- logging ---------------- */

function log(kind, title, detail) {
  const row = document.createElement("div");
  row.className = "row";

  const time = document.createElement("span");
  time.className = "t";
  time.textContent =
    new Date().toLocaleTimeString("en-GB", { hour12: false }) +
    `.${String(Date.now() % 1000).padStart(3, "0")}`;

  const label = document.createElement("span");
  label.className = `k ${kind}`;
  label.textContent = kind;

  const name = document.createElement("span");
  name.className = "title";
  name.textContent = title;

  const text = document.createElement("span");
  text.className = "detail";
  text.textContent = detail ?? "";
  text.title = detail ?? "";

  row.append(time, label, name, text);
  const box = $("log");
  box.append(row);
  while (box.childElementCount > LOG_LIMIT) box.firstElementChild?.remove();
  box.scrollTop = box.scrollHeight;
}

function preview(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

/* ---------------- auth ---------------- */

async function fetchToken() {
  const ttl = Number($("ttl").value) || 60000;
  const response = await fetch(`${endpoint()}/auth/token?ttl=${ttl}`, { method: "POST" });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  const data = await response.json();
  token = data.token;
  refreshes = 0;
  log("system", "token", `issued ${token} (valid for ${ttl}ms)`);
  return token;
}

async function ensureToken() {
  if (!token) await fetchToken();
  return token;
}

async function retryPolicy({ error, attempt }) {
  if (error?.status === 401 && refreshes < 2) {
    refreshes += 1;
    log("system", "refresh", "401 → refreshing the token, retrying immediately");
    await fetchToken();
    return 0;
  }
  const max = Number($("maxRetry").value || 0);
  if (attempt > max) return false;
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

/* ---------------- connection ---------------- */

function endpoint() {
  return ENDPOINTS[$("endpoint").value] ?? ENDPOINTS.direct;
}

function stop() {
  if (!client) return;
  client.close();
  client = null;
}

function connect() {
  stop();
  eventCount = 0;
  $("count").textContent = "0";

  const scenario = $("scenario").value || "normal";
  const params = new URLSearchParams({
    scenario,
    interval: $("interval").value || "1000",
  });
  const maxRetryRaw = $("maxRetry").value.trim();

  const options = {
    url: `${endpoint()}/subscribe?${params.toString()}`,
    method: "POST",
    body: { topics: ["alarm"], scenario },
    // Re-evaluated on every (re)connect, which also proves a refreshed token is used.
    headers: async () => ({ authorization: `Bearer ${await ensureToken()}` }),
    parse: (raw) => JSON.parse(raw),
    idleTimeout: Number($("idle").value) || 0,
    rotateInterval: Number($("rotate").value) || 0,
    reconnectOnEnd: $("reconnectOnEnd").checked,
    pauseWhenHidden: $("pauseHidden").checked,
    endSignal: "[DONE]",
    maxRetry: maxRetryRaw === "" ? Infinity : Number(maxRetryRaw),
    onOpen: () => log("open", "open", "response headers received, reading the stream"),
    onStatus: (status) => log("status", "status", status),
    onError: (error, attempt) =>
      log(
        "error",
        `error #${attempt}`,
        `${error.kind}${error.status ? ` ${error.status}` : ""} · ${error.message}`,
      ),
    onClose: (reason, error) => log("close", "close", error ? `${reason} · ${error.message}` : reason),
    onMessage: (message) => {
      eventCount += 1;
      $("count").textContent = String(eventCount);
      log("msg", message.event, `id=${message.id || "-"} ${preview(message.data)}`);
    },
  };

  if ($("refreshToken").checked) options.retry = retryPolicy;

  client = new SSEClient(options);
  $("endpointLabel").textContent = `${endpoint()} · ${scenario}`;
  log("system", "connect", `POST ${endpoint()}/subscribe?scenario=${scenario}`);
}

/* ---------------- status bar ---------------- */

function paint() {
  const status = client?.status ?? "idle";
  const pill = $("status");
  pill.textContent = status;
  pill.dataset.status = status;
  $("attempts").textContent = String(client?.attempts ?? 0);
  $("lastId").textContent = client?.lastEventId || "-";
}

setInterval(paint, 300);

/* ---------------- bootstrap ---------------- */

async function loadScenarios() {
  const select = $("scenario");
  let list = [];
  try {
    const response = await fetch(`${ENDPOINTS.direct}/scenarios`);
    list = await response.json();
  } catch {
    log("error", "init", "could not load the scenario list — is the server up? try pnpm demo:server");
  }
  if (!Array.isArray(list) || !list.length) list = [{ id: "normal", label: "normal" }];
  select.replaceChildren(
    ...list.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      return option;
    }),
  );
  select.value = "normal";
  $("hint").textContent = HINTS.normal;
}

$("scenario").addEventListener("change", () => {
  $("hint").textContent = HINTS[$("scenario").value] ?? "";
});

$("connect").addEventListener("click", () => {
  try {
    connect();
  } catch (error) {
    log("error", "connect", error instanceof Error ? error.message : String(error));
  }
});

$("restart").addEventListener("click", () => {
  if (!client) {
    log("error", "restart", "no active connection, click Connect first");
    return;
  }
  log("system", "restart", `reconnecting, keeping lastEventId=${client.lastEventId || "-"}`);
  client.restart();
});

$("close").addEventListener("click", () => {
  if (!client) return;
  log("system", "close", "closed manually");
  stop();
  paint();
});

$("revoke").addEventListener("click", async () => {
  try {
    const response = await fetch(`${endpoint()}/auth/revoke`, { method: "POST" });
    const data = await response.json();
    log("system", "revoke", `server revoked ${data.revoked} token(s); the client still holds the old one`);
  } catch (error) {
    log("error", "revoke", String(error));
  }
});

$("clear").addEventListener("click", () => {
  $("log").replaceChildren();
  eventCount = 0;
  $("count").textContent = "0";
});

$("endpoint").addEventListener("change", () => {
  $("endpointLabel").textContent = endpoint();
});

loadScenarios();
paint();
