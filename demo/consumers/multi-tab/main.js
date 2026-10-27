// 多标签页共享：同一个地址开 N 个标签页，只有 leader 真正建连，其余回放中继消息。
// 关掉 leader 后，排在锁队列里的 follower 接管并从最后看到的 id 续传。
// 顶部面板可改场景 / 间隔 / idleTimeout；两个标签页请用相同配置，接管时按本页配置续传。
import { createMultiTabSSE } from "/dist/multi-tab.js";
import { createPanel } from "../shared/panel.js";
import { authHeaders } from "../shared/token.js";

const roleEl = document.querySelector("#role");
const statsEl = document.querySelector("#stats");
const list = document.querySelector("#list");

// 固定频道名：改动查询串（场景/间隔）不会把两个标签页拆成两条连接。
const CHANNEL = "demo:multi-tab";

let received = 0;
let sse = null;
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
      ],
    },
    { key: "interval", label: "间隔 ms", type: "number", min: 200, max: 10_000, step: 100 },
    { key: "idleTimeout", label: "idleTimeout ms", type: "number", min: 0, max: 120_000, step: 1_000 },
  ],
  {
    defaults: { scenario: "normal", interval: 600, idleTimeout: 15_000 },
    storageKey: "demo:multi-tab:config",
    onApply: connect,
  },
);

function connect(config) {
  sse?.close();
  generation += 1;
  document.body.dataset.generation = String(generation);

  const params = new URLSearchParams({
    scenario: config.scenario,
    interval: String(config.interval),
  });

  const instance = createMultiTabSSE({
    url: `/subscribe?${params.toString()}`,
    channel: CHANNEL,
    request: { body: { topics: ["alarm"] }, headers: authHeaders },
    parse: (raw) => JSON.parse(raw),
    stream: { idleTimeout: Number(config.idleTimeout) },
  });
  sse = instance;

  // leader / follower / solo（缺 Web Locks 或 BroadcastChannel 时的降级）
  // `onRole` 只报变化，follower 在构造期就已确定，所以要先把当前值读出来。
  const showRole = (role) => {
    roleEl.textContent = role;
    roleEl.dataset.role = role;
  };
  showRole(instance.role);
  instance.onRole(showRole);

  instance.onSuspectGap(({ reason }) => {
    if (reason === "promote") {
      add(`本页接管了连接（promote），中间可能缺一段，真实业务应重拉快照`, "warn");
    }
  });

  instance.on("ALARM", (alarm) => {
    received += 1;
    add(`#${alarm.seq} ${alarm.deviceName}`);
    statsEl.textContent = `本页收到 ${received} 条 · 位点 ${instance.lastEventId} · 状态 ${instance.status}`;
  });
}

function add(text, kind = "") {
  const li = document.createElement("li");
  li.textContent = text;
  if (kind) li.className = kind;
  list.prepend(li);
  while (list.children.length > 50) list.lastElementChild.remove();
}
