// 测点看板：内存与渲染节奏优先。
// 一条连接 → fanout 扇出 → batcher 按设备合并 → ring buffer 定容 → rAF 每帧重绘一次
// 顶部面板可改场景 / 频率 / 每批条数 / 单条大小 / yieldEvery，改动只重建连接，
// 环形缓冲与合并窗口保持原样（这正是它们存在的意义：换配置不丢历史）。
import { SSEClient, createBatcher, createRingBuffer } from "/dist/index.js";
import { createPanel } from "../shared/panel.js";
import { authHeaders } from "../shared/token.js";

const canvas = document.querySelector("#chart");
const ctx = canvas.getContext("2d");
const rowsEl = document.querySelector("#rows");
const statusEl = document.querySelector("#status");
const statsEl = document.querySelector("#stats");

const CAPACITY = 2000;
const ring = createRingBuffer({ capacity: CAPACITY });
const latest = new Map();

// 同一台设备 300ms 内可能推很多次：窗口只保留最新值，一次 flush 写一次状态
const batcher = createBatcher({
  key: (point) => point.device,
  interval: 300,
  maxPending: 500,
  onFlush: (points) => {
    for (const point of points) {
      ring.push(point);
      latest.set(point.device, point);
      if (latest.size > 64) latest.delete(latest.keys().next().value);
    }
    schedule();
  },
});

let client = null;
let generation = 0;

createPanel(
  document.querySelector("#panel"),
  [
    {
      key: "scenario",
      label: "场景",
      type: "select",
      options: [
        ["flood", "flood 持续压力"],
        ["burst", "burst 单块 2000 条"],
        ["normal", "normal 正常推流"],
      ],
    },
    { key: "interval", label: "间隔 ms", type: "number", min: 10, max: 2_000, step: 10 },
    { key: "burst", label: "每批条数", type: "number", min: 1, max: 2_000, step: 1 },
    { key: "size", label: "单条字节", type: "number", min: 64, max: 8_192, step: 64 },
    { key: "yieldEvery", label: "yieldEvery", type: "number", min: 0, max: 500, step: 1 },
  ],
  {
    defaults: { scenario: "flood", interval: 50, burst: 25, size: 256, yieldEvery: 20 },
    storageKey: "demo:point-board:config",
    onApply: connect,
  },
);

function connect(config) {
  client?.close();
  generation += 1;
  document.body.dataset.generation = String(generation);
  statusEl.textContent = "idle";
  statusEl.dataset.status = "idle";

  const params = new URLSearchParams({
    scenario: config.scenario,
    interval: String(config.interval),
    burst: String(config.burst),
    size: String(config.size),
  });

  const instance = new SSEClient({
    url: `/subscribe?${params.toString()}`,
    request: { body: { topics: ["points"] }, headers: authHeaders },
    parse: (raw) => JSON.parse(raw),
    stream: { idleTimeout: 20_000 },
    limits: { yieldEvery: Number(config.yieldEvery) }, // 一个 chunk 里的事件先解析 N 条，再让出主线程
    hooks: {
      status: (status) => {
        statusEl.textContent = status;
        statusEl.dataset.status = status;
      },
    },
  });

  client = instance;
  // 一条物理订阅，多个消费者；feed.latest("ALARM") 可拿到最新值
  instance.fanout().on("ALARM", (point) => batcher.push(point));
}

let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
    renderRows();
  });
}

function draw() {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const points = ring.toArray().slice(-400);
  if (points.length < 2) return;
  const max = Math.max(...points.map((point) => point.seq)) || 1;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = 4 + (index / (points.length - 1)) * (width - 8);
    const y = height - 8 - (point.seq / max) * (height - 16);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#5b9dff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function renderRows() {
  const rows = [...latest.values()].sort((a, b) => b.seq - a.seq).slice(0, 8);
  rowsEl.innerHTML = rows
    .map(
      (point) =>
        `<tr><td>${point.device}</td><td>${point.seq}</td><td>${new Date(point.at).toLocaleTimeString()}</td></tr>`,
    )
    .join("");
  const heap = performance.memory
    ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
    : "n/a";
  statsEl.textContent =
    `窗口 ${ring.length}/${CAPACITY} · 覆盖 ${ring.evicted} · 待合并 ${batcher.pending} · ` +
    `合并丢弃 ${batcher.dropped} · 堆 ${heap}`;
}
