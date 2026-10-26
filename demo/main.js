// Console logic: exposes every SSEClient switch so QA can drive scenarios by hand.
// Also holds the EN / 中文 copy; the page is bilingual without a build step.
// Depends on dist/: run `pnpm build` first.
import { SSEClient } from "../dist/index.js";

const ENDPOINTS = {
  direct: "http://127.0.0.1:8787",
  nginx: "http://localhost:8081",
  broken: "http://localhost:8082",
};

const I18N = {
  en: {
    "app.title": "SSE console",
    "app.subtitle": "@songfreedom/sse-client · real browser + real Nginx + real streaming",
    "pill.attempts": "attempts",
    "pill.events": "events",
    "field.endpoint": "Endpoint",
    "field.scenario": "Scenario",
    "field.interval": "Interval (ms)",
    "field.idle": "idleTimeout (ms)",
    "field.rotate": "rotateInterval (ms)",
    "field.maxRetry": "maxRetry",
    "field.ttl": "token TTL (ms)",
    "field.burst": "burst (flood / burst)",
    "field.size": "payload bytes (flood / burst)",
    "endpoint.direct": "Direct :8787 (no gateway)",
    "endpoint.nginx": "Nginx :8081 (correct)",
    "endpoint.broken": "Nginx :8082 (misconfigured)",
    "opt.pauseHidden": "pauseWhenHidden (suspend in background)",
    "opt.refreshToken": "Refresh token on 401, then retry",
    "opt.reconnectOnEnd": "Reconnect when the server ends the stream",
    "btn.connect": "Connect",
    "btn.restart": "Restart (keep lastEventId)",
    "btn.close": "Close",
    "btn.revoke": "Revoke token",
    "btn.clear": "Clear log",
    "log.title": "Event log",
    "hint.default": "Pick a scenario to see what to watch for.",
    "log.token": "issued {token} (valid for {ttl}ms)",
    "log.refresh": "401 → refreshing the token, retrying immediately",
    "log.restart": "reconnecting, keeping lastEventId={id}",
    "log.noConnection": "no active connection, click Connect first",
    "log.closed": "closed manually",
    "log.revoked": "server revoked {count} token(s); the client still holds the old one",
    "log.initFailed": "could not load the scenario list — is the server up? try pnpm demo:server",
    "log.open": "response headers received, reading the stream",
    "log.networkHint": "is the demo server running? try pnpm demo:server",
    "log.unauthorizedHint": "token expired? tick 'Refresh token on 401' or click Connect again",
    "log.sampled": "log sampled: {n} events were not rendered (rate {rate}/s)",
    "mem.title": "Memory sampler",
    "mem.rate": "rate",
    "mem.delta": "Δ heap",
    "mem.unavailable": "performance.memory unavailable — use Chrome, or read the heap in DevTools",
    "mem.legend": "heap {heap} · dom {dom} · peak {peak}",
  },
  zh: {
    "app.title": "SSE 联调台",
    "app.subtitle": "@songfreedom/sse-client · 真实浏览器 + 真实 Nginx + 真实流式传输",
    "pill.attempts": "重试",
    "pill.events": "事件",
    "field.endpoint": "入口",
    "field.scenario": "场景",
    "field.interval": "推送间隔（ms）",
    "field.idle": "空闲超时（ms）",
    "field.rotate": "轮转周期（ms）",
    "field.maxRetry": "最大重试次数",
    "field.ttl": "token 有效期（ms）",
    "field.burst": "每批条数（flood / burst）",
    "field.size": "单条字节（flood / burst）",
    "endpoint.direct": "直连 :8787（无网关）",
    "endpoint.nginx": "Nginx :8081（正确配置）",
    "endpoint.broken": "Nginx :8082（故意配错）",
    "opt.pauseHidden": "后台挂起（pauseWhenHidden）",
    "opt.refreshToken": "401 时自动刷新 token 再重试",
    "opt.reconnectOnEnd": "服务端结束流后自动重连",
    "btn.connect": "连接",
    "btn.restart": "重启（保留 lastEventId）",
    "btn.close": "关闭",
    "btn.revoke": "吊销 token",
    "btn.clear": "清空日志",
    "log.title": "事件日志",
    "hint.default": "选择场景后，这里会显示观察要点。",
    "log.token": "已签发 {token}（有效期 {ttl}ms）",
    "log.refresh": "401 → 刷新 token 后立即重试",
    "log.restart": "重连并保留 lastEventId={id}",
    "log.noConnection": "当前没有连接，请先点「连接」",
    "log.closed": "已手动关闭",
    "log.revoked": "服务端已吊销 {count} 个 token（客户端仍持旧 token）",
    "log.initFailed": "获取场景列表失败，服务端没起来？试一下 pnpm demo:server",
    "log.open": "已收到响应头，开始读流",
    "log.networkHint": "服务端没起来？先跑 pnpm demo:server",
    "log.unauthorizedHint": "token 过期了？勾选「401 时自动刷新 token」或再点一次「连接」",
    "log.sampled": "日志降采样：{n} 条事件未渲染（速率 {rate}/s）",
    "mem.title": "内存采样",
    "mem.rate": "速率",
    "mem.delta": "堆变化",
    "mem.unavailable": "performance.memory 不可用——请用 Chrome，或在 DevTools 里看堆",
    "mem.legend": "heap {heap} · dom {dom} · peak {peak}",
  },
};

const HINTS = {
  en: {
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
    flood:
      "Sustained pressure: burst × interval (default 10 per 20ms ≈ 500 events/s). Watch the sampler: heap should saw-tooth and return to its baseline after Close, and dom must stay flat.",
    burst:
      "2000 frames in one write ≈ 400KB: one synchronous parse task. Watch the event loop stall and the saw-tooth, not a leak.",
  },
  zh: {
    normal: "事件应按间隔实时到达。再切到「Nginx :8082」对比：那边会卡住，直到网关缓冲区写满才吐出来。",
    chunked: "一帧被拆成 3 次写入，切点落在 3 字节字符中间：不应出现乱码或丢帧。",
    heartbeat: "把 idleTimeout 设成 1000（小于 2s 心跳）应触发重连；设成 6000 则一直保持 open。",
    silent: "idleTimeout 设 3000：3 秒后应报 heartbeat 错误并重连，而不是死等。",
    end: "勾选「服务端结束流后自动重连」→ 会自动重连；取消勾选 → status 变 closed，原因为 end。",
    done: "收到 data: [DONE] 后应立即 closed，不重连，也不报 JSON 解析错误。",
    "retry-field": "服务端下发 retry: 2000：断流后应等约 2 秒再重连，看两条日志的时间差。",
    huge: "单条 2MB 超过默认 1MB 上限：应报 protocol 错误并 closed，不重连、不吃内存。",
    "no-blank-line": "只发 data 行、永不空行：累计超过 1MB 后应报 protocol 错误（旧版本会一路涨内存）。",
    slow: "3 秒后才回响应头：观察 connecting 停留时间；网关默认 60s 读超时会直接断开。",
    accel: "服务端带 X-Accel-Buffering: no：能绕过 8082 的 proxy_buffering，但 gzip 仍可能造成延迟。",
    html: "200 + text/html：应报 protocol 错误且只请求一次（网关登录页的典型表现）。",
    error500: "应进入指数退避重连，直到 maxRetry 用尽后 closed。",
    error401: "默认只请求一次就 closed；勾选「401 时自动刷新 token」后应先换 token 再重连成功。",
    flood:
      "持续压力：每批条数 × 间隔（默认 10 条 / 20ms ≈ 500 条/秒）。看采样面板：堆应是锯齿形，点「关闭」后回落到基线；dom 必须保持平直。",
    burst:
      "一次写入 2000 帧 ≈ 400KB：单个同步解析任务。应看到主线程停顿与锯齿，而不是持续上涨。",
  },
};

/** Chinese scenario labels; the server only ships English ones. */
const SCENARIO_ZH = {
  normal: "normal — 每个间隔推一条 ALARM（UTF-8 载荷）",
  chunked: "chunked — 一帧拆 3 次写，切在 3 字节字符中间",
  heartbeat: "heartbeat — 只发 `: ping` 注释，没有业务数据",
  silent: "silent — 握手后一个字节都不发",
  end: "end — 推 3 条后服务端主动结束流",
  done: "done — 推 2 条后发 data: [DONE]",
  "retry-field": "retry-field — 下发 retry: 2000 后断开",
  huge: "huge — 单条 2MB 的 data",
  "no-blank-line": "no-blank-line — 只发 data 行，永不出现空行",
  slow: "slow — 3 秒后才回响应头",
  accel: "accel — normal + X-Accel-Buffering: no",
  html: "html — 200 + text/html（网关登录页）",
  error500: "error500 — 直接 500",
  error401: "error401 — 直接 401（token 失效）",
  flood: "flood — 每批多条、固定载荷，持续压力测试",
  burst: "burst — 一次写入一批（默认 2000 条），测单块解析",
};

/**
 * Used when /scenarios is unreachable, so the dropdown never looks half-empty.
 * Keep the ids in sync with SCENARIOS in server.mjs.
 */
const FALLBACK_SCENARIOS = [
  { id: "normal", label: "normal — one ALARM per interval" },
  { id: "chunked", label: "chunked — one frame in 3 writes" },
  { id: "heartbeat", label: "heartbeat — comments only" },
  { id: "silent", label: "silent — nothing after the handshake" },
  { id: "end", label: "end — 3 events, then the server ends" },
  { id: "done", label: "done — 2 events, then [DONE]" },
  { id: "retry-field", label: "retry-field — retry: 2000, then disconnect" },
  { id: "huge", label: "huge — a single 2MB data line" },
  { id: "no-blank-line", label: "no-blank-line — never a blank line" },
  { id: "slow", label: "slow — headers after 3s" },
  { id: "accel", label: "accel — normal + X-Accel-Buffering: no" },
  { id: "html", label: "html — 200 + text/html" },
  { id: "error500", label: "error500 — plain 500" },
  { id: "error401", label: "error401 — plain 401" },
  { id: "flood", label: "flood — burst events per interval" },
  { id: "burst", label: "burst — 2000 events in one write" },
];

const LOG_LIMIT = 400;
const LANG_KEY = "sse-demo-lang";
const $ = (id) => document.getElementById(id);

let client = null;
let token = null;
let tokenExpiresAt = 0;
let refreshes = 0;
let eventCount = 0;
let scenarios = [];
let lang = detectLang();

/* ---------------- i18n ---------------- */

function detectLang() {
  // ?lang=zh keeps links shareable, then the saved choice, then the browser locale.
  const fromQuery = new URLSearchParams(location.search).get("lang");
  if (fromQuery === "en" || fromQuery === "zh") return fromQuery;
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // storage may be unavailable (file://, private mode); fall back to the browser
  }
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key, vars) {
  const template = I18N[lang][key] ?? I18N.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

function scenarioLabel(item) {
  if (lang === "zh") return SCENARIO_ZH[item.id] ?? item.label;
  return item.label;
}

function applyLang(next) {
  lang = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  document.title = t("app.title");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  $("lang-en").classList.toggle("active", lang === "en");
  $("lang-zh").classList.toggle("active", lang === "zh");
  renderScenarioOptions();
  updateHint();
}

function setLang(next) {
  if (next !== "en" && next !== "zh") return;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // ignore storage failures, the switch still applies for this session
  }
  applyLang(next);
}

// Exposed for the browser matrix, which pins the UI to English before asserting.
window.__setLang = setLang;

/* ---------------- logging ---------------- */

/**
 * The probe turns the log off while it measures: otherwise the 400-row cap means
 * the DOM, not the client, is what grows first, and the numbers say nothing about
 * the streaming path.
 */
let logEnabled = true;

function log(kind, title, detail) {
  if (!logEnabled) return;
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

/* ---------------- memory sampler ---------------- */

const SAMPLE_LIMIT = 300;
const SAMPLE_INTERVAL = 1000;
const LOG_ROWS_PER_SECOND = 20;

const HEAP_SUPPORTED = typeof performance !== "undefined" && "memory" in performance;

const metrics = {
  /** Characters received; ≈ bytes for the ASCII JSON payloads the demo sends. */
  bytes: 0,
  samples: [],
  baseline: null,
  peak: 0,
  rate: 0,
  eventsAtLastSample: 0,
  suppressed: 0,
  errors: 0,
  lastError: null,
  tokens: LOG_ROWS_PER_SECOND,
  lastRefill: performance.now(),
};

function heapMB() {
  const bytes = HEAP_SUPPORTED ? performance.memory.usedJSHeapSize : undefined;
  return typeof bytes === "number" ? bytes / 1048576 : null;
}

const domNodes = () => document.getElementsByTagName("*").length;
const fmtMB = (value) => (value == null ? "n/a" : `${value.toFixed(1)} MB`);

/**
 * Token bucket for the log. At 500 events/s rendering four DOM nodes per event
 * would make the log, not the client, the memory driver — the measurement would
 * be meaningless. Rows are capped at ~20/s and the skipped ones are reported.
 */
function allowLogRow() {
  const now = performance.now();
  metrics.tokens = Math.min(
    LOG_ROWS_PER_SECOND,
    metrics.tokens + ((now - metrics.lastRefill) / 1000) * LOG_ROWS_PER_SECOND,
  );
  metrics.lastRefill = now;
  if (metrics.tokens < 1) {
    metrics.suppressed += 1;
    return false;
  }
  metrics.tokens -= 1;
  return true;
}

function sampleMetrics() {
  const heap = heapMB();
  const dom = domNodes();
  if (metrics.baseline == null && heap != null) metrics.baseline = heap;
  if (heap != null && heap > metrics.peak) metrics.peak = heap;

  metrics.rate = eventCount - metrics.eventsAtLastSample;
  metrics.eventsAtLastSample = eventCount;
  metrics.samples.push({ t: Date.now(), heap, dom, events: eventCount, bytes: metrics.bytes });
  if (metrics.samples.length > SAMPLE_LIMIT) metrics.samples.shift();

  const delta = heap != null && metrics.baseline != null ? heap - metrics.baseline : null;
  $("heap").textContent = fmtMB(heap);
  $("peak").textContent = metrics.peak ? fmtMB(metrics.peak) : "-";
  const deltaNode = $("heapDelta");
  deltaNode.textContent = delta == null ? "-" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} MB`;
  deltaNode.className = delta == null ? "" : delta > 40 ? "bad" : delta > 12 ? "warn" : "";
  $("recv").textContent = `${(metrics.bytes / 1048576).toFixed(2)} MB`;
  $("rate").textContent = `${metrics.rate} /s`;
  $("dom").textContent = String(dom);
  $("memLegend").textContent = t("mem.legend", {
    heap: fmtMB(heap),
    dom,
    peak: metrics.peak ? fmtMB(metrics.peak) : "-",
  });

  if (metrics.suppressed > 0) {
    log("system", "log", t("log.sampled", { n: metrics.suppressed, rate: metrics.rate }));
    metrics.suppressed = 0;
  }
  drawChart();
}

/** Two series, each scaled to its own range: heap (area) and DOM nodes (line). */
function drawChart() {
  const canvas = $("chart");
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 1000;
  const height = 96;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "#161f29";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    ctx.beginPath();
    ctx.moveTo(0, (height / 4) * i);
    ctx.lineTo(width, (height / 4) * i);
    ctx.stroke();
  }

  const points = (pick) => {
    const values = metrics.samples.map(pick);
    const numeric = values.filter((value) => value != null);
    if (numeric.length < 2) return null;
    const max = Math.max(...numeric);
    const min = Math.min(...numeric);
    const span = Math.max(max - min, max * 0.3, 1);
    const floor = Math.max(min - span * 0.15, 0);
    const stepX = width / Math.max(values.length - 1, 1);
    return values.map((value, index) => ({
      x: index * stepX,
      y: height - 3 - (((value ?? floor) - floor) / span) * (height - 8),
    }));
  };

  const trace = (list) => {
    ctx.beginPath();
    list.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  };

  const heapLine = points((sample) => sample.heap);
  if (heapLine) {
    trace(heapLine);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = "rgba(76, 154, 255, 0.16)";
    ctx.fill();
    trace(heapLine);
    ctx.strokeStyle = "#4c9aff";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  const domLine = points((sample) => sample.dom);
  if (domLine) {
    trace(domLine);
    ctx.strokeStyle = "#d29922";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function resetMetrics() {
  metrics.bytes = 0;
  metrics.samples = [];
  metrics.peak = 0;
  metrics.rate = 0;
  metrics.suppressed = 0;
  metrics.errors = 0;
  metrics.lastError = null;
  metrics.eventsAtLastSample = eventCount;
  metrics.baseline = heapMB();
  metrics.tokens = LOG_ROWS_PER_SECOND;
  metrics.lastRefill = performance.now();
  drawChart();
}

// Automation reads this instead of scraping the DOM.
window.__sseMetrics = () => ({
  events: eventCount,
  rate: metrics.rate,
  bytes: metrics.bytes,
  heapMB: heapMB(),
  peakMB: metrics.peak || null,
  baselineMB: metrics.baseline,
  dom: domNodes(),
  errors: metrics.errors,
  lastError: metrics.lastError,
  samples: metrics.samples,
});
window.__resetMetrics = resetMetrics;
window.__setLogEnabled = (value) => {
  logEnabled = Boolean(value);
  if (!logEnabled) $("log").replaceChildren();
  return logEnabled;
};

if (!HEAP_SUPPORTED) log("error", "metrics", t("mem.unavailable"));
setInterval(sampleMetrics, SAMPLE_INTERVAL);

/* ---------------- auth ---------------- */

async function fetchToken() {
  const ttl = Number($("ttl").value) || 60000;
  const response = await fetch(`${endpoint()}/auth/token?ttl=${ttl}`, { method: "POST" });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  const data = await response.json();
  token = data.token;
  tokenExpiresAt = Date.now() + ttl;
  refreshes = 0;
  log("system", "token", t("log.token", { token, ttl }));
  return token;
}

async function ensureToken() {
  // Renew before it expires: reusing a dead token turns every restart into a 401,
  // which the client correctly treats as terminal.
  const ttl = Number($("ttl").value) || 60000;
  const margin = Math.min(5000, ttl / 5);
  if (!token || Date.now() > tokenExpiresAt - margin) await fetchToken();
  return token;
}

async function retryPolicy({ error, attempt }) {
  if (error?.status === 401 && refreshes < 2) {
    refreshes += 1;
    log("system", "refresh", t("log.refresh"));
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
  // Δ on the sampler is measured from the moment the connection opens.
  resetMetrics();

  const scenario = $("scenario").value || "normal";
  const params = new URLSearchParams({
    scenario,
    interval: $("interval").value || "1000",
  });
  // Only the pressure scenarios look at these; harmless for the rest.
  if ($("burst").value.trim()) params.set("burst", $("burst").value.trim());
  if ($("size").value.trim()) params.set("size", $("size").value.trim());
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
    onOpen: () => log("open", "open", t("log.open")),
    onStatus: (status) => log("status", "status", status),
    onError: (error, attempt) => {
      metrics.errors += 1;
      metrics.lastError = `${error.kind}${error.status ? ` ${error.status}` : ""} · ${error.message}`;
      const head = `${error.kind}${error.status ? ` ${error.status}` : ""} · ${error.message}`;
      // Raw errors do not say what to do next; the common cases get a one-line hint.
      let hintText = "";
      if (error.kind === "network") hintText = t("log.networkHint");
      else if (error.status === 401) hintText = t("log.unauthorizedHint");
      log("error", `error #${attempt}`, hintText ? `${head} · ${hintText}` : head);
    },
    onClose: (reason, error) => log("close", "close", error ? `${reason} · ${error.message}` : reason),
    onMessage: (message) => {
      eventCount += 1;
      metrics.bytes += message.raw?.length ?? 0;
      $("count").textContent = String(eventCount);
      if (!allowLogRow()) return;
      log("msg", message.event, `id=${message.id || "-"} ${preview(message.data)}`);
    },
  };

  if ($("refreshToken").checked) options.retry = retryPolicy;

  client = new SSEClient(options);
  $("endpointLabel").textContent = `${endpoint()} · ${scenario}`;
  // Keep the hint in sync when the scenario was set programmatically (scripts).
  updateHint();
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

/* ---------------- boot ---------------- */

function renderScenarioOptions() {
  const select = $("scenario");
  if (!scenarios.length) return;
  const current = select.value || "normal";
  select.replaceChildren(
    ...scenarios.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = scenarioLabel(item);
      return option;
    }),
  );
  select.value = current;
}

function updateHint() {
  const scenario = $("scenario").value;
  $("hint").textContent = HINTS[lang][scenario] ?? t("hint.default");
}

async function loadScenarios() {
  let list = [];
  try {
    const response = await fetch(`${ENDPOINTS.direct}/scenarios`);
    list = await response.json();
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) {
    // Keep the dropdown complete, but say why the list is local.
    list = FALLBACK_SCENARIOS;
    log("error", "scenarios", t("log.initFailed"));
  }
  scenarios = list;
  renderScenarioOptions();
  updateHint();
}

$("lang-en").addEventListener("click", () => setLang("en"));
$("lang-zh").addEventListener("click", () => setLang("zh"));

/** Pressure scenarios are only meaningful at their own tick rate. */
const SCENARIO_DEFAULTS = {
  flood: { interval: "20", burst: "10", size: "1024" },
  burst: { interval: "1000", burst: "2000", size: "200" },
};

function applyScenarioDefaults(scenario) {
  const preset = SCENARIO_DEFAULTS[scenario];
  if (!preset) return;
  for (const [id, value] of Object.entries(preset)) {
    const field = $(id);
    if (field) field.value = value;
  }
}

$("scenario").addEventListener("change", () => {
  applyScenarioDefaults($("scenario").value);
  updateHint();
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
    log("error", "restart", t("log.noConnection"));
    return;
  }
  log("system", "restart", t("log.restart", { id: client.lastEventId || "-" }));
  client.restart();
});

$("close").addEventListener("click", () => {
  if (!client) return;
  log("system", "close", t("log.closed"));
  stop();
  paint();
});

$("revoke").addEventListener("click", async () => {
  try {
    const response = await fetch(`${endpoint()}/auth/revoke`, { method: "POST" });
    const data = await response.json();
    log("system", "revoke", t("log.revoked", { count: data.revoked }));
  } catch (error) {
    log("error", "revoke", String(error));
  }
});

$("clear").addEventListener("click", () => {
  $("log").replaceChildren();
  eventCount = 0;
  $("count").textContent = "0";
  resetMetrics();
});

$("endpoint").addEventListener("change", () => {
  $("endpointLabel").textContent = endpoint();
});

applyLang(lang);
loadScenarios();
paint();
resetMetrics();

// Signals index.html that the module booted; a stale/missing bundle leaves it unset
// and the page shows an explicit error instead of dead buttons.
window.__sseDemoReady = true;
