// 告警中心：准确优先。
// - headers 传函数：token 在流中途过期，下一次（重）连会重新取
// - resume.persist：刷新页面后从上次的 id 续传
// - 续传可能重放最后一条，按 id 去重
// - hooks.gap 只负责「报疑」，补洞动作由业务做（这里是注释说明）
// - 顶部面板可改场景 / 间隔 / idleTimeout / 是否记住位点，改动会重建连接
import { SSEClient } from "/dist/index.js";
import { createPanel } from "../shared/panel.js";
import { authHeaders, resetToken } from "../shared/token.js";

const list = document.querySelector("#list");
const statusEl = document.querySelector("#status");
const statsEl = document.querySelector("#stats");

// 「已见过的 id」只在一条订阅内有效：换配置后服务端可能从 1 重新开始，
// 复用旧集合会把新流整段当成重放丢掉。
const seen = new Set();
let received = 0;
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
        ["normal", "normal 正常推流"],
        ["slow", "slow 慢握手（3s）"],
        ["heartbeat", "heartbeat 只有心跳"],
        ["chunked", "chunked 分块 + 多字节"],
        ["end", "end 服务端结束"],
      ],
    },
    { key: "interval", label: "间隔 ms", type: "number", min: 200, max: 10_000, step: 100 },
    { key: "idleTimeout", label: "idleTimeout ms", type: "number", min: 0, max: 120_000, step: 1_000 },
    { key: "persist", label: "跨刷新记住位点", type: "checkbox" },
    { key: "resumeFrom", label: "起始位点", type: "text", placeholder: "留空=服务端当前位置" },
  ],
  {
    defaults: {
      scenario: "normal",
      interval: 800,
      idleTimeout: 15_000,
      persist: true,
      resumeFrom: "",
    },
    storageKey: "demo:alarm-center:config",
    onApply: connect,
  },
);

function connect(config) {
  client?.close();
  seen.clear();
  received = 0;
  generation += 1;
  document.body.dataset.generation = String(generation);
  statusEl.textContent = "idle";
  statusEl.dataset.status = "idle";
  statsEl.textContent = "";

  const params = new URLSearchParams({
    scenario: config.scenario,
    interval: String(config.interval),
  });

  const instance = new SSEClient({
    url: `/subscribe?${params.toString()}`,
    request: { body: { topics: ["alarm"] }, headers: authHeaders },
    parse: (raw) => JSON.parse(raw),
    // 关掉「记住位点」时不传 persist：位点只存在内存里，刷新即丢。
    resume: config.persist
      ? { persist: "demo:alarm-center", from: config.resumeFrom || undefined }
      : {},
    stream: { idleTimeout: Number(config.idleTimeout) },
    retry: async ({ error, attempt }) => {
      if (error?.status === 401) {
        resetToken(); // 令牌过期：丢掉缓存，下一次尝试重新签发
        return 0; // 立即重试
      }
      return attempt > 5 ? false : Math.min(30_000, 500 * 2 ** attempt);
    },
    hooks: {
      status: (status) => {
        statusEl.textContent = status;
        statusEl.dataset.status = status;
      },
      error: (error) => add(`error ${error.kind}${error.status ? ` ${error.status}` : ""}`, "err"),
      gap: ({ reason, lastId }) => {
        // 生产里：重拉快照 → 用 snapshot.id 调 setResumePoint，再继续渲染
        add(`gap(${reason}) 位点=${lastId || "无"}，真实业务此处应重拉快照`, "warn");
      },
      resume: ({ skipped, continuous }) =>
        add(`resume skipped=${skipped ?? "?"} continuous=${continuous ?? "?"}`),
    },
  });

  client = instance;

  instance.on("ALARM", (alarm) => {
    const id = instance.lastEventId;
    if (id && seen.has(id)) return; // 续传重放的最后一条
    if (id) {
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
    }
    received += 1;
    add(`#${alarm.seq} ${String(alarm.level).toUpperCase()} ${alarm.deviceName}`);
    statsEl.textContent = `收到 ${received} 条 · dropped ${instance.dropped}`;
  });
}

function add(text, kind = "") {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  if (kind) li.className = kind;
  list.prepend(li);
  while (list.children.length > 200) list.lastElementChild.remove();
}
