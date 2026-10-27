// Vue 共享订阅：subscription getter 读到的 ref 变化时，自动换到对应 key 的连接。
// 同一页面内多个组件描述同一订阅时，实际只有一条物理连接（页内引用计数）；
// 跨标签页的共享要换成 createMultiTabSSE（见 ../multi-tab/）。
// 顶部面板把场景 / 间隔 / idleTimeout 也做成 ref：改一个值就等价于「订阅变了」，
// 共享 key 随之改变，旧连接按引用计数释放。
import { createApp, ref, shallowRef, computed, onUnmounted } from "vue";
import { useSharedSSE } from "/dist/vue.js";
import { createRingBuffer } from "/dist/index.js";
import { createPanel } from "../shared/panel.js";
import { authHeaders } from "../shared/token.js";

// #panel 在 #app 之外：Vue 挂载会清空容器，面板必须自己活着。
const scenario = ref("normal");
const interval = ref(700);
const idleTimeout = ref(15_000);

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
    defaults: { scenario: "normal", interval: 700, idleTimeout: 15_000 },
    storageKey: "demo:vue-shared:config",
    onApply: (config) => {
      // 只是改 ref：useSharedSSE 的 subscription getter 会重算 key 并切换连接。
      scenario.value = config.scenario;
      interval.value = Number(config.interval);
      idleTimeout.value = Number(config.idleTimeout);
    },
  },
);

createApp({
  setup() {
    const tenants = ["acme", "globex", "initech"];
    const tenant = ref("acme");

    const ring = createRingBuffer({ capacity: 500 });
    const rows = shallowRef([]);
    let frame = 0;

    const sse = useSharedSSE({
      grace: 5_000, // 路由来回切时不立刻断连
      subscription: () => ({
        url: `/subscribe?scenario=${scenario.value}&interval=${interval.value}`,
        request: {
          body: { tenantId: tenant.value }, // 读到的 ref 会被跟踪：切租户即换 key
          headers: authHeaders,
        },
        parse: (raw) => JSON.parse(raw),
        stream: { idleTimeout: Number(idleTimeout.value) },
      }),
    });

    sse.on("ALARM", (alarm) => {
      ring.push(alarm);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        rows.value = ring.toArray().slice(-20).reverse();
      });
    });

    onUnmounted(() => {
      if (frame) cancelAnimationFrame(frame);
      sse.dispose(); // 释放本组件的引用；最后一个引用释放时才真正断连
    });

    return {
      tenants,
      tenant,
      rows,
      status: sse.status,
      key: sse.key,
      count: computed(() => rows.value.length),
    };
  },
}).mount("#app");
