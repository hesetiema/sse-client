# @songfreedom/sse-client

[English](./README.md) · 简体中文

[![npm version](https://img.shields.io/npm/v/%40songfreedom%2Fsse-client)](https://www.npmjs.com/package/@songfreedom/sse-client)
[![license](https://img.shields.io/npm/l/%40songfreedom%2Fsse-client)](./LICENSE)
[![minzip size](https://img.shields.io/bundlephobia/minzip/%40songfreedom%2Fsse-client)](https://bundlephobia.com/package/@songfreedom/sse-client)

一个小巧、零依赖的浏览器 Server-Sent Events 客户端。
基于 `fetch` 传输，支持带类型的多路事件分发、带 `Last-Event-ID` 续传的自动重连、
空闲看门狗以及连接复用。

```ts
import { SSEClient } from "@songfreedom/sse-client";

const client = new SSEClient({
  url: "/api/push/subscribe",
  body: { topics: ["alarm"] },
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  parse: (raw) => JSON.parse(raw),
});

client.on("ALARM", (alarm) => console.log(alarm.level));
```

## 为什么不用 `EventSource`？

| 方案 | 问题 |
| --- | --- |
| 原生 `EventSource` | 无法设置请求头（没法带鉴权 token）、只支持 GET、不能带请求体、重连行为不可控 |
| [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source) | 已归档。非 2xx 响应必须自己在 `onopen` 里拒绝，否则会静默无限重连；重试间隔固定；不保存 `Last-Event-ID` |
| `axios` | 浏览器里读不了流式响应（`responseType: "stream"` 只有 Node 支持）。在 `onDownloadProgress` 里拼接 `responseText` 会破坏多字节字符 |

本库 gzip 后约 3 kB，无运行时依赖，只要求环境提供 `fetch` 和 `ReadableStream`。

## 特性

- **POST + JSON 请求体**，支持任意请求头，也支持每次重连重新求值的请求头函数
- **自动重连**：指数退避 + 抖动；终态错误（401/403/404）立即停止
- **断点续传**：通过 `Last-Event-ID` 让重连从断开处继续
- **带类型的事件分发**：一条连接服务多个订阅者，`on()` 会根据事件表推导载荷类型
- **空闲看门狗**：应对静默的流；**主动轮转**：应对连接还活着但收不到数据的场景
- **离线感知**：断网时暂停，网络恢复后立即重连
- **可插拔的重试策略**，包括「刷新 token 后重试」这类异步策略
- **连接复用**：按 key 共享连接并做引用计数
- 独立入口提供可选的 **Vue 3** 组合式函数

## 安装

```bash
pnpm add @songfreedom/sse-client
# 或者
npm install @songfreedom/sse-client
```

Vue 入口需要把 `vue` 作为 peer 依赖（它是可选的，不用 Vue 的项目不会安装）：

```bash
pnpm add @songfreedom/sse-client vue
```

要求环境支持 `fetch` 和 `ReadableStream`（所有常青浏览器），SSR 与测试场景需要 Node 18+。

## 快速开始

### 框架无关

```ts
import { SSEClient } from "@songfreedom/sse-client";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
  IOT: { objectId: string; value: string };
}

const client = new SSEClient<Events>({
  url: `${gateway}/server-event/sse/subscribe`,
  method: "POST",
  body: [{ subscribeType: "SE", instanceType: "PROJECT" }],
  headers: () => authHeaders(),          // 每次尝试前重新求值
  parse: (raw) => JSON.parse(raw),
  idleTimeout: 45_000,                   // 服务端每 15s 发一次心跳时可这样设置
});

const off = client.on("ALARM", (alarm) => {
  // `alarm` 的类型是 Events["ALARM"]
  console.log(alarm.deviceId);
});

// 之后
off();
client.close();
```

### Vue 3

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useSSE } from "@songfreedom/sse-client/vue";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
}

const { status, lastEvent, on } = useSSE<Events>({
  url: "/api/push/alarm",
  body: { topics: ["alarm"] },
  parse: (raw) => JSON.parse(raw),
});

on("ALARM", (alarm) => {
  // 组件卸载时自动取消订阅
  console.log(alarm.level);
});

const connected = computed(() => status.value === "open");
</script>
```

`useSSE` 在客户端之上多做了两件事：一份最近消息的环形缓冲区
（`lastEvent`、`events`、`maxEvents`），以及随作用域自动清理——组件卸载、
或 qiankun 子应用卸载时自动关闭连接。

## API

### `new SSEClient(options)`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | — | 请求地址，包含网关前缀 |
| `method` | `"GET" \| "POST"` | `"POST"` | HTTP 方法 |
| `body` | `unknown` | — | 序列化为 JSON；字符串、`Blob`、`FormData` 原样发送 |
| `headers` | `HeadersInit \| () => HeadersInit \| Promise<HeadersInit>` | — | 传函数可在每次（重）连时重新计算请求头 |
| `parse` | `(raw: string) => unknown` | 原样返回 | 载荷解码器 |
| `idleTimeout` | `number` | `0` | 超过该时长没有收到任何字节就重连，建议设为心跳间隔的 3 倍左右 |
| `rotateInterval` | `number` | `0` | 按固定周期重连，即使连接看起来正常 |
| `retry` | `(ctx) => number \| false \| Promise<number \| false>` | — | 自定义重试策略，会覆盖内置退避 |
| `maxRetry` | `number` | `Infinity` | 重试次数上限（仅在未提供 `retry` 时生效） |
| `retryBaseDelay` | `number` | `1000` | 首次重试前的等待时间（ms） |
| `retryMaxDelay` | `number` | `30000` | 退避上限（ms） |
| `reconnectOnEnd` | `boolean` | `true` | 服务端正常结束流后是否重连 |
| `stableAfter` | `number` | `10000` | 一次连接存活超过该时长后重置重试计数 |
| `strictContentType` | `boolean` | `true` | 要求响应为 `content-type: text/event-stream` |
| `maxBufferSize` | `number` | `1MB` | 单条消息缓冲区上限（字符数） |
| `endSignal` | `string` | — | 把这个 `data` 值视为流结束，例如 `"[DONE]"` |
| `events` | `string[]` | — | 事件名白名单 |
| `pauseWhenHidden` | `boolean` | `false` | 页面隐藏时挂起，页面可见时重连 |
| `autoStart` | `boolean` | `true` | 在构造函数里直接建立连接 |
| `fetch` | `FetchLike` | 全局 `fetch` | 自定义传输实现 |
| `onHandlerError` | `(error) => void` | `console.error` | 回调抛错时的兜底处理 |

生命周期钩子既可以通过选项传入（`onOpen`、`onMessage`、`onStatus`、`onError`、
`onClose`），也可以稍后用方法订阅，两种写法等价。

#### 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `SSEStatus` | `idle` · `connecting` · `open` · `reconnecting` · `closed` |
| `closed` | `boolean` | 终态；为 `true` 时不会再重连 |
| `attempts` | `number` | 连续重试次数，连接稳定后重置 |
| `lastEventId` | `string` | 最新事件 id，重连时会带回服务端 |
| `done` | `Promise<void>` | 连接终止时兑现，永不 reject |

#### 方法

| 方法 | 说明 |
| --- | --- |
| `start()` | 建立连接（运行中或挂起时为空操作） |
| `close()` | 关闭并停止重连 |
| `restart()` | 先关闭再重连，同时保留 `lastEventId` |
| `on(event, handler)` | 订阅单个事件名，返回取消订阅函数 |
| `on("*", handler)` | 订阅所有消息 |
| `once(event, handler)` | 只订阅一次投递 |
| `onMessage` / `onStatus` / `onError` / `onOpen` / `onClose` | 生命周期订阅 |

### `SSEMessage`

```ts
interface SSEMessage<T = unknown> {
  id: string;          // 事件 id，服务端未提供时继承上一条
  event: string;       // 服务端没有 event: 字段时为 "message"
  data: T;             // parse 的输出
  raw: string;         // 原始载荷文本
  receivedAt: number;  // 客户端接收时间戳
}
```

### 错误类型

`SSEError.kind` 用于日志，也用于在重试策略里做分支：

| `kind` | 含义 | 默认是否重试 |
| --- | --- | --- |
| `http` | 非 2xx 响应（`status` 有值） | 408/425/429/5xx 重试，其余不重试 |
| `network` | DNS 失败、连接被重置等 | 重试 |
| `heartbeat` | 空闲超时，连接看起来已是僵尸 | 重试 |
| `protocol` | `content-type` 不对、缓冲区溢出、响应体读不了 | 不重试 |
| `aborted` | 被打断（页面隐藏、离线、手动关闭） | 不重试 |
| `retry-exhausted` | 重试次数用尽 | 不重试 |

## 常见配方

### 401 时刷新 token

重试策略可以是异步的，因此刷新可以在下一次尝试之前完成：

```ts
let refreshed = false;

const client = new SSEClient({
  url,
  retry: async ({ error, attempt }) => {
    if (error?.status === 401 && !refreshed) {
      await refreshToken();
      refreshed = true;
      return 0; // 立即重试
    }
    return attempt > 5 ? false : Math.min(30_000, 1000 * 2 ** attempt);
  },
});
```

### 共用一条连接

HTTP/1.1 同源最多 6 条连接，而一个推送通道会长期占住其中一条。
与其每个组件各开一条，不如共享：

```ts
import { acquireSSEClient } from "@songfreedom/sse-client";

const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, body }));
onScopeDispose(release); // 最后一个使用者释放时才会真正关闭
```

### 合并高频更新

同一个实体每几百毫秒推一次时，写进状态前先做合并：

```ts
import { createBatcher } from "@songfreedom/sse-client";

const batcher = createBatcher<string, Point>({
  key: (point) => `${point.objectId}::${point.code}`,
  interval: 300,
  onFlush: (points) => store.applyPoints(points),
});

client.on("IOT", (payload) => payload.data.forEach((p) => batcher.push(p)));
```

### 高频与大流量：内存会不会涨

不会无界增长，前提是三层的上限都在：

1. **网络层**：读循环是 pull 模型（`await reader.read()`），处理慢了就不拉下一块，浏览器停止消费 socket，
   TCP 窗口耗尽后服务端 `write()` 阻塞——背压天然传导到上游，不需要额外的流控协议。
2. **解析层**：`buffer` 与「一个事件累计的 data 行」都受 `maxBufferSize`（默认 1MB）约束，超了直接
   `protocol` 错误并断开。这是硬保护，不是"丢弃旧数据"策略：`huge`（单条 2MB）与 `no-blank-line`
   （永不空行）两个场景走的就是这里。
3. **应用层**：库自己不保存历史，消息派发完即可回收。要涨只能是业务囤：数组、响应式 store、日志表。

实测（demo 里的 `flood` 场景 + `pnpm demo:memory`，Chrome 单 tab）：30 秒灌入 **368 MB**、48,000 条事件，
堆峰值 4.6 MB，强制 GC 后回到 0.8 MB（基线 0.6 MB），DOM 节点数 117 → 117 不变。锯齿是没回收的临时对象，
不是泄漏。细节与复现脚本见 [`demo/README.zh-CN.md`](./demo/README.zh-CN.md#6-高频--内存实测)。

需要自己兜住的两件事：处理函数里别囤数据；单条消息都很大时，可以调低 `maxBufferSize` 让异常更早暴露。

### 轮转与重连的区别

连接可能还活着，但服务端的订阅已经没了。轮转（`rotateInterval`）会按周期重连，
以避开这类僵尸连接，同时保留 `lastEventId` 保证不丢事件：

```ts
new SSEClient({ url, rotateInterval: 30 * 60_000 });
```

这依赖服务端正确处理 `Last-Event-ID`。另一种做法是重叠连接（先开新连接再关旧的），
没有空档，但当服务端按连接推送时可能收到重复事件。

## 底层构件

客户端由若干小构件拼成，它们也被导出，便于高级用法：

```ts
import { createSSEParser, createSSEMessageStream, createBatcher } from "@songfreedom/sse-client";

// 字节 → 消息，标准的 TransformStream
const messages = response.body!.pipeThrough(createSSEMessageStream({ parse: JSON.parse }));

// 只要原始帧，想自己驱动循环时用
const parser = createSSEParser({ onEvent: (event) => console.log(event) });
parser.feed("event: ping\ndata: 1\n\n");
```

## 服务端要求

- 响应 `Content-Type: text/event-stream`（带 `;charset=UTF-8` 后缀也可以）。
- 不要缓冲响应：网关侧 `proxy_buffering off; proxy_cache off;`，也不要对流开 gzip。
- 每 15–30s 发一次心跳注释（`: ping\n\n`），否则多数负载均衡在静默 60s 后断开连接；
  配合 `idleTimeout` 使用。
- 想要无缝隙重连，服务端需支持 `Last-Event-ID`；客户端只负责发送该请求头，
  不做事件去重。

## 设计说明

- 不含业务逻辑：客户端不关心 token、store、toast 或路由，鉴权通过 `headers` 注入。
- 错误不会从回调里逃逸成异常：抛错的处理器被隔离，通过 `onHandlerError` 上报，
  数据流继续。
- 关闭时始终清理定时器；连接循环只在客户端最终关闭时退出，因此挂起与恢复不会泄漏循环。

## 开发

```bash
pnpm install
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # dist/ + dist/package.json
```

联调 demo（真实浏览器 + 真实 Nginx，另有命令行冒烟与内存压测）：
见 [demo/README.zh-CN.md](./demo/README.zh-CN.md)，命令为 `pnpm demo:server` / `pnpm demo:smoke` /
`pnpm demo:matrix` / `pnpm demo:memory`。

发版：先升版本号，然后

```bash
pnpm publish:npm  # 构建并发布到 npmjs（access: public）
```

## 许可证

[MIT](./LICENSE)
