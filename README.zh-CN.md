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
- **断点续传**：通过 `Last-Event-ID` 让重连从断开处继续；配合 `persistKey` 还能跨页面刷新延续
- **漏数据信号**（`onSuspectGap`）：客户端无法证明流连续时主动上报，让应用重拉快照，而不是把错数字静默画出来
- **续传校验**（`onResume`）：重连后上报新流跳过了多少（`skipped`、`continuous`）；id 不透明时明确保持沉默
- **带类型的事件分发**：一条连接服务多个订阅者，`on()` 会根据事件表推导载荷类型
- **空闲看门狗**：应对静默的流；**主动轮转**：应对连接还活着但收不到数据的场景
- **离线感知**：断网时暂停，网络恢复后立即重连
- **可插拔的重试策略**，包括「刷新 token 后重试」这类异步策略
- **连接复用**：按 key 共享连接并做引用计数；**多标签页共用一条连接**（`./multi-tab`）
- **有界历史**：`createRingBuffer`，配合 `createBatcher`（支持前导触发）在写状态前合并
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
import { computed, onUnmounted } from "vue";
import { useSSE } from "@songfreedom/sse-client/vue";

interface Events {
  ALARM: { level: "high" | "low"; deviceId: string };
}

const { status, lastEvent, on, dispose } = useSSE<Events>({
  url: "/api/push/alarm",
  body: { topics: ["alarm"] },
  parse: (raw) => JSON.parse(raw),
});

on("ALARM", (alarm) => console.log(alarm.level));

onUnmounted(dispose);

const connected = computed(() => status.value === "open");
</script>
```

`useSSE` 刻意做得很薄：`status` / `lastEvent` / `error` 三个 ref、用于分发的 `on()`，
以及一个 `dispose()`——退掉本组合式函数注册的所有订阅并关闭连接。

**它不提供历史数组。** 视图要留多少条、要不要降采样、多久重绘一次，都是业务决策，
库给不出合适的默认值——给了也只会悄悄谁都不合适。缓冲区用 `createRingBuffer` 自己组合
（见[大列表与图表：视图窗口自己组合](#大列表与图表视图窗口自己组合)）。

清理是显式的，不依赖作用域。宿主与库解析到**不同副本的 Vue** 时（qiankun 子应用
的常见情况），`getCurrentScope()` 会返回 `undefined`，带守卫的自动清理就变成静默的
连接泄漏。`dispose()` 是幂等的，重复调用无害。`stop()` 关闭连接但保留组合式函数可用，
`dispose()` 才是真正的销毁。

加上 `shared: true`（或 `{ grace, keyOf }`）后，描述同一订阅的多个组件共用一条连接：
释放按引用计数，某个组件卸载不会再顺带掐掉其它组件的连接。

订阅目标还不确定时加 `when`。返回 false 期间一个请求都不发，详情页就不会先为「没有实例」
开一条一次性订阅、紧接着又换掉：

```ts
const instanceId = ref<string>();
const { status } = useSSE({
  url: "/api/push",
  when: () => !!instanceId.value,
  body: () => [{ instanceId: instanceId.value }],
});
```

`when` 与 `body` 工厂都会被响应式重读：`useSharedSSE` 的 `subscription` getter、`useSSE` 的
`when`，以及它们读到的任何 ref，变化后都会重新求值。`when` 的优先级高于 `immediate`：门没开
就一个请求都不发；门关着的时候上报的状态是 `idle` 而不是 `closed`——流不是结束了，是还没开始。

## API

### `new SSEClient(options)`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | — | 请求地址，包含网关前缀 |
| `method` | `"GET" \| "POST"` | `"POST"` | HTTP 方法 |
| `body` | `unknown \| (() => unknown)` | — | 序列化为 JSON；字符串、`Blob`、`FormData` 原样发送。传函数则每次（重）连前重新求值，可跟随响应式筛选条件。请保持纯函数：`deriveShareKey` 也会求值 |
| `credentials` | `RequestCredentials` | `"same-origin"` | 订阅接口跨域且靠 cookie 鉴权时传 `"include"` |
| `flags` | `string[]` | — | 拼在 URL 上的无值标记：`["GRID_MAP"]` → `.../subscribe?GRID_MAP`。参与共享 key |
| `headers` | `HeadersInit \| () => HeadersInit \| Promise<HeadersInit>` | — | 传函数可在每次（重）连时重新计算请求头 |
| `parse` | `(raw: string) => unknown` | 原样返回 | 载荷解码器；可用包内的 `jsonParse`，非 JSON 帧保留原文而不是丢弃 |
| `resumeFrom` | `string` | — | 首次请求的续传位点，作为 `Last-Event-ID` 发送；用于从上次页面停留处继续 |
| `persistKey` | `string \| boolean` | — | 把 `lastEventId` 落到存储，跨刷新延续。`true` 时按订阅推导键；写入节流到 1 次/秒，并在关闭、`pagehide` 时立即落盘 |
| `persistStorage` | `ResumeStorage \| null` | `sessionStorage` | `persistKey` 使用的存储；传 `null` 关闭（SSR、受限 iframe） |
| `onSuspectGap` | `(info: SSEGapInfo) => void` | — | 流可能不连续（`reconnect` / `resume` / `rotate` / `drop` / `promote`）；每次「一段」只上报一次 |
| `onResume` | `(info: SSEResumeInfo) => void` | — | 重连后第一条可识别事件：新流跳过多少（`skipped` / `continuous`） |
| `idleTimeout` | `number` | `0` | 超过该时长没有收到任何字节就重连，建议设为心跳间隔的 3 倍左右 |
| `rotateInterval` | `number` | `0` | 按固定周期重连，即使连接看起来正常 |
| `rotateMode` | `"restart" \| "overlap"` | `"restart"` | `restart` 先关后开；`overlap` 接管预先建立好的替换连接（无空档） |
| `rotateTimeout` | `number` | `30000` | `overlap` 模式下替换连接的等待上限 |
| `retry` | `(ctx) => number \| false \| Promise<number \| false>` | — | 自定义重试策略，会覆盖内置退避 |
| `maxRetry` | `number` | `Infinity` | 重试次数上限（仅在未提供 `retry` 时生效） |
| `retryBaseDelay` | `number` | `1000` | 首次重试前的等待时间（ms） |
| `retryMaxDelay` | `number` | `30000` | 退避上限（ms） |
| `reconnectOnEnd` | `boolean` | `true` | 服务端正常结束流后是否重连 |
| `stableAfter` | `number` | `10000` | 一次连接存活超过该时长后重置重试计数 |
| `strictContentType` | `boolean` | `true` | 要求响应为 `content-type: text/event-stream` |
| `maxBufferSize` | `number` | `1MB` | 单条消息缓冲区上限（字符数） |
| `overflowPolicy` | `"close" \| "drop"` | `"close"` | 超限时：断开（终态 `protocol` 错误）或只丢该条、连接继续 |
| `yieldEvery` | `number` | `0` | 每个任务最多解析多少条事件，然后让出主线程；`0` 表示整块一次处理 |
| `endSignal` | `string` | — | 把这个 `data` 值视为流结束，例如 `"[DONE]"` |
| `events` | `string[]` | — | 事件名白名单 |
| `pauseWhenHidden` | `boolean` | `false` | 页面隐藏时挂起，页面可见时重连 |
| `autoStart` | `boolean` | `true` | 在构造函数里直接建立连接 |
| `fetch` | `FetchLike` | 全局 `fetch` | 自定义传输实现 |
| `onHandlerError` | `(error) => void` | `console.error` | 回调抛错时的兜底处理 |

生命周期钩子既可以通过选项传入（`onOpen`、`onMessage`、`onStatus`、`onError`、
`onClose`、`onOverflow`、`onSuspectGap`、`onResume`），也可以稍后用方法订阅，两种写法等价。

#### 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `SSEStatus` | `idle` · `connecting` · `open` · `reconnecting` · `closed` |
| `closed` | `boolean` | 终态；为 `true` 时不会再重连 |
| `attempts` | `number` | 连续重试次数，连接稳定后重置 |
| `lastEventId` | `string` | 最新事件 id，重连时会带回服务端 |
| `url` | `string` | 实际请求的地址，`flags` 已拼接 |
| `dropped` | `number` | 因超限被丢弃的消息数（`overflowPolicy: "drop"` 时才会增长） |
| `done` | `Promise<void>` | 连接终止时兑现，永不 reject |

#### 方法

| 方法 | 说明 |
| --- | --- |
| `start()` | 建立连接（运行中或挂起时为空操作） |
| `close()` | 关闭并停止重连 |
| `restart()` | 先关闭再重连，同时保留 `lastEventId` |
| `setResumePoint(id)` | 替换**下一次**连接的续传位点，例如漏数据后重拉快照拿到的 id |
| `on(event, handler)` | 订阅单个事件名，返回取消订阅函数 |
| `on("*", handler)` | 订阅所有消息 |
| `once(event, handler)` | 只订阅一次投递 |
| `onMessage` / `onStatus` / `onError` / `onOpen` / `onClose` / `onOverflow` / `onSuspectGap` / `onResume` | 生命周期订阅 |
| `fanout()` | 一个 `"*"` 订阅派发给多个消费者，并为每个事件保留最新值（同一实例） |
| `use(plugin)` | 挂载插件；插件返回的函数在连接关闭时执行一次 |

`start()` 在 `close()` 尚未卸载完毕时会自我排队，因此同一 tick 里的 `stop(); start();`
是真的重连，而不是什么都不做。

### `useSharedSSEClient(config?)`

`acquireSSEClient` 覆盖的是「一个订阅、多个消费者」；这里覆盖更难的另一半：
**订阅本身会变**（楼层、租户、筛选、时间范围），而使用方一直挂在页面上。

拿到的 handle 不是一条连接。它持有的是**你的订阅描述和你的监听器**；连接属于某个 key，
由该 key 上的所有使用方共享。

```ts
const sse = useSharedSSEClient({ grace: 5_000 });

sse.on("IOT", apply);                              // 先排队，此时还没建连
sse.configure({ url, body: [{ floorId: "F1" }] }); // 复用或新建匹配的连接
watch(floorId, (id) => sse.configure({ url, body: [{ floorId: id }] }));
onScopeDispose(() => sse.release());
```

`configure` 做四件事：算出 key；key 没变就直接返回；把监听器从旧 client 上解绑；挂到
匹配的连接上（已有人持有就复用）；最后把旧 key 的引用计数减一。最后一步正是「切楼层
不会打扰另一个仍在看旧楼层」的原因。

| 调用 | 行为 |
| --- | --- |
| `configure(同 key)` | 什么都不做，返回 key。放在频繁触发的 watch 里是安全的 |
| `configure(新 key)` | 监听搬到新连接；旧连接引用减一后**立即**关闭（不享受 grace） |
| `configure()` / `configure({})` | 停止消费，handle 仍可用 |
| `close()` | 解绑监听、引用减一，handle 保留；之后再 `configure` 会重新挂上 |
| `release()` | 最终释放，幂等；之后再 `configure` 返回 `null` |

属性：`key`、`client`、`status`、`configured`。`client` 是 **getter**，切换后可能是另一个
实例，不要缓存；首次 `configure` 之前 `status` 为 `idle`。

连续性信号也属于 handle，理由相同：`onSuspectGap` 与 `onResume` 会随切换重新绑定，而挂在
缓存下来的 `client` 上的监听，会在订阅搬走的那一刻静默失效。

四个容易踩的点：

- **body 相同但 `parse` 不同会被合并**。key 只覆盖 `url` / `method` / `body` / `events` / `flags`，
  而且**先创建的那个 `parse` 获胜**——第二个使用方拿到的是它的返回值。需要区分就传 `keyOf`。
- **切换不受 grace 保护**。`F1 → F2 → F1` 就是两次重连。要么 debounce 切换，要么把筛选
  条件分桶进 key（时间范围取整到分钟），别让滑块每一像素产生一个新 key。
- **`grace` 只作用于 `close()`**。它是为路由来回切导致的重挂准备的，不负责订阅切换。
- **`useSSE({ shared: true })` 是固定订阅版本**，不暴露 `configure`。订阅要动就直接用 handle。

`config`：`grace`（无引用后连接保留多久，毫秒，默认 0）、`keyOf`（默认 `deriveShareKey`）、
`create`（客户端工厂，默认 `new SSEClient`）。

订阅永远不变时用 `acquireSSEClient` 更合适——不需要那套监听簿记。只有一个消费者时直接
`new SSEClient`；重复发生在标签页之间而不是组件之间时用 `createMultiTabSSE`。

### `deriveShareKey(options)`

由 `url`、`method`、`body`、`events`、`flags` 生成稳定 key：对象键排序，数组按集合比较。
`body` 传函数时会先求值再入 key，因此筛选条件变化就是换 key。导出它，是为了手写 `key`
时能沿用同一套规则。

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

### `SSEResumeInfo`

`onResume` 的入参，只在这次请求带过 `Last-Event-ID` 时上报：

```ts
interface SSEResumeInfo {
  lastId: string;                   // 作为 Last-Event-ID 发出去的位点
  firstId: string;                  // 新连接上收到的第一条带 id 的事件
  skipped: number | undefined;      // firstId - lastId；id 不是整数时为 undefined
  continuous: boolean | undefined;  // skipped <= 1 时为 true；非数值 id 时为 undefined
  attempt: number;                  // 新连接属于第几次尝试
}
```

`skipped` 为 `undefined` 不是「没有跳过」，而是「客户端拒绝猜」——SSE 的 id 是
不透明字符串，规范从未承诺它们有序。只有服务端发递增整数时，这两个字段才足以
判断新流到底接上了没有。

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

响应带 `Retry-After` 头时，`http` 错误会带上 `retryAfter`（ms），内置退避用它
——夹在 200ms 与 `retryMaxDelay` 之间——替代指数曲线；自定义 `retry` 策略可以
读同一个字段。

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

### 跨页面刷新续传

`lastEventId` 只存在内存里，所以 F5 会让流从「现在」重新开始，页面加载期间服务端产生
的数据被静默跳过。把位点持久化即可：

```ts
new SSEClient({
  url,
  persistKey: "alarm",   // 存到 sessionStorage 的这个键
  // persistKey: true    // 按 url/method/body 推导键
});
```

存储的位点会在首次请求之前读取。流式过程中写入被合并到最多 1 次/秒，并在关闭、挂起和
`pagehide` 时立即落盘——不会变成每条消息一次同步写存储。位点来自别处（快照接口、URL、
另一个标签页）时用 `resumeFrom`。

### 漏数据后重同步

客户端不可能知道重连期间跳过了什么，它只能表示「无法证明连续」。`onSuspectGap` 把这个
不确定性变成可执行的事件：

```ts
const client = new SSEClient({
  url,
  persistKey: "iot",
  onSuspectGap: async ({ reason, lastId }) => {
    const snapshot = await fetchSnapshot(); // { id: "9042", data: [...] }
    store.replaceAll(snapshot.data);
    client.setResumePoint(snapshot.id);      // 下一次连接从这里继续
  },
});
```

`reason` 取值为 `reconnect`、`resume`（页面隐藏或断网）、`rotate`（仅 `restart` 模式）、
`drop`（单条消息超过 `maxBufferSize`）和 `promote`（多标签页中 leader 消失，本标签页接管）。
每「一段」只上报一次，所以十分钟的断线不会触发二十次快照请求。`setResumePoint` 不会打断
正在运行的流：中途改写 `Last-Event-ID` 只会让解析器错位，而不是修复缺口。

### 续传到底接上了没有

`onSuspectGap` 说的是「我无法证明连续」。等新连接的第一条事件到达后，`onResume` 回答它
留下的问题：

```ts
const client = new SSEClient({
  url,
  onResume: ({ firstId, skipped, continuous }) => {
    if (continuous === false) {
      metrics.increment("sse.resume.skipped", { skipped });
    }
    cursor.moveTo(firstId);
  },
});
```

两个 id 都是整数时，`skipped` 就是 `firstId - lastId`：`0` 表示服务端重放了最后一条，
`> 1` 表示中间有事件丢了。id 不是整数时 `skipped` 与 `continuous` 都是 `undefined`——编造
一个排序会得到看起来很有底气的错误结论，所以客户端选择什么都不说。它适合做观测；
真正触发快照重拉的仍是 `onSuspectGap`。

### 多标签页共用一条连接

六个看板标签页就是六条指向同一路流的连接。借助 Web Locks 和 `BroadcastChannel`，标签页
之间选出一个 leader，其它标签页回放 leader 中继过来的消息：

```ts
import { createMultiTabSSE } from "@songfreedom/sse-client/multi-tab";

const sse = createMultiTabSSE({ url: "/api/push", body: { topics: ["iot"] } });
sse.on("IOT", (point) => store.apply(point)); // 每个标签页都有，只有一条连接
sse.role;                                     // "leader" | "follower" | "solo"
```

leader 标签页关闭后，排队中的 follower 接管锁，并从它最后看到的 id 续传——交接代价是
一个 `Last-Event-ID` 缺口，而不是整条订阅重来。连续性信号同样会跨中继：接管的标签页上报
`onSuspectGap({ reason: "promote" })`，`onResume` 则由当前持有连接的那个标签页转发。
不支持 Web Locks 或 `BroadcastChannel` 时，
每个标签页都报告 `solo` 并各自连接：这是降级但诚实的行为，好过一个可能脑裂的自研协议。
`parse` 必须返回可结构化克隆的数据；`onOpen` 只在 leader 上触发，因为 `Response` 无法中继。

### 一个连接，多个消费者

`on("*")` 也能用，但每个消费者各自付一份通配符处理成本，而且没人记得上一条载荷。
`fanout()` 给出一条订阅，外加每个事件的最新快照，晚挂载的组件可以立刻渲染而不是等下一次推送：

```ts
const feed = client.fanout();

feed.on("IOT_DATA_CHANGE", applyPoint);   // 每个消费者各有自己的取消订阅
feed.on("ABNORMAL_EVENT", pushAlarm);

feed.latest("IOT_DATA_CHANGE");           // 最近一次载荷，没有则 undefined
feed.count("IOT_DATA_CHANGE");            // 有多少消费者在监听
```

某个消费者抛错会经 `onHandlerError` 上报，不影响其它人。`dispose()` 丢掉全部消费者与源订阅；
在那之前快照一直可读。

### 共用一条连接

HTTP/1.1 同源最多 6 条连接，而一个推送通道会长期占住其中一条。
与其每个组件各开一条，不如共享：

```ts
import { acquireSSEClient } from "@songfreedom/sse-client";

const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, body }));
onScopeDispose(release); // 最后一个使用者释放时才会真正关闭
```

### 订阅会变的时候用 handle

一个楼层切换器，三个组件同时看同一路流，而楼层会在运行时变化：

```vue
<script setup lang="ts">
const props = defineProps<{ floorId: string }>();

const sse = useSharedSSEClient({ grace: 5_000 });
sse.on("IOT", (point) => dock.apply(point)); // 先排队，等连接建好再挂上

watch(
  () => props.floorId,
  (floorId) => sse.configure({ url, body: [{ floorId }] }),
  { immediate: true },
);

onUnmounted(() => sse.release());            // 引用计数，而不是直接断开
</script>
```

三个组件落到同一条连接上，是因为 key 由订阅自身推导（`url`、`method`、`body`、`events`、
`flags`，数组按集合比较）——它们不需要事先约定一个字符串。切换楼层时三者一起搬走，旧连接
只有在最后一个使用方也离开后才关闭。

行为对照表、`close()` 与 `release()` 的区别、以及那些坑（共享 `parse`、切换不享受 grace）
都在 [`useSharedSSEClient`](#usesharedsseclientconfig)。

### 不用服务端的测试

客户端只依赖 `fetch`，所以包里自带一个假的。重连、续传、卡死的网关、轮转都能在进程内
确定性地复现，Node 与浏览器 runner 都一样：

```ts
import { SSEClient } from "@songfreedom/sse-client";
import { createMockSSEFetch } from "@songfreedom/sse-client/testing";

const mock = createMockSSEFetch({
  script: attempt =>
    attempt === 0
      ? [{ id: "1", event: "ALARM", data: { level: "high" } }]
      : [{ id: "2", event: "ALARM", data: { level: "low" } }],
});

const client = new SSEClient({
  url: "/push",
  body: { topics: ["alarm"] },
  fetch: mock.fetch,
  parse: JSON.parse,
  maxRetry: 1,        // 脚本跑完重连一次就收工，`done` 才会兑现
  retryBaseDelay: 0,
});
client.on("ALARM", handler);
await client.done;

expect(mock.calls[1].headers.get("last-event-id")).toBe("1");
expect(mock.lastBody()).toEqual({ topics: ["alarm"] });
```

`keepOpen` 模拟持续订阅，`hang` 模拟迟迟不响应的网关，`script` 收到的参数是第几次尝试，
因此重连可以返回不同的数据。

### 大列表与图表：视图窗口自己组合

客户端到「消息已分发」为止。视图留多少、多久重绘一次属于应用，两个构件覆盖大多数看板：

```ts
import { shallowRef, onUnmounted } from "vue";
import { createRingBuffer, useSSE, jsonParse } from "@songfreedom/sse-client";

const ring = createRingBuffer<Point>({ capacity: 2000 }); // 内存上限
const rows = shallowRef<Point[]>([]);
let frame = 0;

const schedule = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    rows.value = ring.toArray(); // 每帧一个数组，而不是每条消息一个
  });
};

const { dispose } = useSSE({
  url: "/api/push",
  parse: jsonParse,
  onMessage: (message) => {
    ring.push(message.data as Point);
    schedule();
  },
});

onUnmounted(dispose);
```

这里容量和发布量故意是同一个数：`toArray()` 每帧的成本是 O(capacity)，所以「留得起」
的缓冲同时也是「发得起」的。两者一旦分家（留 6000 点、只渲染 500 条），应该是发布切片
或者上虚拟列表，而不是调大容量然后再想办法。

`ring.evicted` 记录被覆盖的条数，让界面可以诚实标注，而不是假装列表是完整的：

```ts
const truncated = computed(() => ring.evicted > 0); // 仅显示最近 2000 点
```

容量按 `时长 × 频率` 估算。这个数一旦开始变大，说明视图不是它该待的地方：要么服务端
下采样（1s / 1min 聚合），要么改成分页查询。**不要在客户端压缩事件列表**——对报警列表
做采样等于静默删掉几条报警，屏幕上没有任何东西会提示这一点。

### 合并高频更新

同一个实体每几百毫秒推一次时，写进状态前先做合并：

```ts
import { createBatcher } from "@songfreedom/sse-client";

const batcher = createBatcher<string, Point>({
  key: (point) => `${point.objectId}::${point.code}`,
  interval: 300,
  maxPending: 2000, // 窗口内最多攒 2000 个实体
  onFlush: (points) => store.applyPoints(points),
});

client.on("IOT", (payload) => payload.data.forEach((p) => batcher.push(p)));
```

`maxPending` 缺省不设上限；一旦触发上限，淘汰**最久没有被更新**的 key，丢弃数记在 `batcher.dropped`。
`dispose()` 之后 `push()` 变成空操作并计数，避免组件卸载后回调又把定时器重新拉起来。

稀疏流量用 `leading: true`：空闲窗口的第一个值立即交付（一分钟才更新一次的看板不会晚
一个窗口才变），跟在后面的突发仍然在尾窗里合并。

一条共享连接被多个使用方消费时还有两点：`batcher.subscribe(fn)` 在 `onFlush` 之外增加订阅者，
同一批数据只写一次状态、所有使用方都收到通知；`chunkSize` 把大窗口切片交付、切片之间让出主线程，
5000 个实体不会变成一次长任务。

### 高频与大流量：内存会不会涨

不会无界增长，前提是三层的上限都在：

1. **网络层**：读循环是 pull 模型（`await reader.read()`），处理慢了就不拉下一块，浏览器停止消费 socket，
   TCP 窗口耗尽后服务端 `write()` 阻塞——背压天然传导到上游，不需要额外的流控协议。
2. **解析层**：`buffer` 与「一个事件累计的 data 行」都受 `maxBufferSize`（默认 1MB）约束，超了默认
   报 `protocol` 错误并断开。这是硬保护，不是"丢弃旧数据"策略：`huge`（单条 2MB）与 `no-blank-line`
   （永不空行）两个场景走的就是这里。如果业务能接受丢帧但不能断，改成 `overflowPolicy: "drop"`：
   只丢掉超限的那条（`dropped` 计数、`onOverflow` 回调），连接继续，并在下一个空行边界重新对齐。
3. **应用层**：库自己不保存历史，消息派发完即可回收。要涨只能是业务囤：数组、响应式 store、日志表。

实测（demo 里的 `flood` 场景 + `pnpm demo:memory`，Chrome 单 tab）：30 秒灌入 **368 MB**、48,000 条事件，
堆峰值 4.6 MB，强制 GC 后回到 0.8 MB（基线 0.6 MB），DOM 节点数 117 → 117 不变。锯齿是没回收的临时对象，
不是泄漏。细节与复现脚本见 [`demo/README.zh-CN.md`](./demo/README.zh-CN.md#6-高频--内存实测)。

需要自己兜住的两件事：处理函数里别囤数据；单条消息都很大时，可以调低 `maxBufferSize` 让异常更早暴露。

### 长任务：让出主线程

`feed()` 是同步的：一个 chunk 里有多少条事件，就在同一个任务里解析并派发多少条。解析本身很便宜
（实测约 3–10µs/条），真正会把主线程卡住的是**你自己的处理函数**——一条 1ms 的渲染乘以一个 chunk 里的
1500 条，就是一次 1.4 秒的卡顿。`yieldEvery` 在解析和派发之间切片：

```ts
new SSEClient({ url, yieldEvery: 20 }); // 每 20 条让出一次，再继续
```

让出用 `scheduler.yield()`（不可用时退回 `setTimeout(0)`），abort 期间被打断与 `reader.read()` 的表现一致。

demo 实测（`pnpm demo:memory --handler=1`，每条事件模拟 1ms 处理耗时，单块灌入 2000 条）：

| `yieldEvery` | 单次最长阻塞 | 主线程总耗时 | 收到事件 |
| --- | --- | --- | --- |
| `0` | **1467 ms** | 2032 ms | 2000 |
| `20` | **117 ms** | 2046 ms | 2000 |

总工作量不变（切片不省时间），但最长阻塞降到 1/12。注意残余的 ~117ms 不是切片粒度造成的——把
`yieldEvery` 调到 5 也是 117ms：2 秒的总积压会持续压住渲染，切片只能保证"没有单次超长任务"。
要彻底不卡，得减少每条的渲染成本或做批量合并（见上面的 `createBatcher`）。

### 轮转与重连的区别

连接可能还活着，但服务端的订阅已经没了。轮转（`rotateInterval`）会按周期重连，
以避开这类僵尸连接，同时保留 `lastEventId` 保证不丢事件：

```ts
new SSEClient({ url, rotateInterval: 30 * 60_000 });
```

这依赖服务端正确处理 `Last-Event-ID`。如果服务端不支持，或者完全不能接受空档，改用重叠轮换：

```ts
new SSEClient({ url, rotateInterval: 30 * 60_000, rotateMode: "overlap", rotateTimeout: 30_000 });
```

`overlap` 会在**当前连接继续推送的同时**请求替换连接，只有替换连接被接受后才切换：
旧的 attempt 被中止，新的流从它已经缓冲好的位置继续读，因此既不会丢事件也不会重放。
替换连接打不开（502、content-type 不对、超时）就丢弃并通过 `onError` 上报，
**正在跑的那条连接不受影响**——定时轮转不会拿一条好连接去换一条坏连接。

`restart`（默认）先关后开，对服务端更轻，且在有 `Last-Event-ID` 支持时同样安全。

## 底层构件

客户端由若干小构件拼成，它们也被导出，便于高级用法：

```ts
import {
  createSSEParser,
  createSSEMessageStream,
  createBatcher,
  createRingBuffer,
} from "@songfreedom/sse-client";

// 字节 → 消息，标准的 TransformStream
const messages = response.body!.pipeThrough(createSSEMessageStream({ parse: JSON.parse }));

// 只要原始帧，想自己驱动循环时用
const parser = createSSEParser({ onEvent: (event) => console.log(event) });
parser.feed("event: ping\ndata: 1\n\n");

// 定容历史：push 是 O(1)，只分配一次，满了覆盖最旧值
const ring = createRingBuffer<SSEMessage>({ capacity: 500 });
ring.push(message);
ring.toArray();    // 新数组，可以直接交给响应式 ref
ring.into(reused); // 同样的顺序写进已有数组，不产生分配
```

环形缓冲区是**存储**上限，不是滑动窗口：它回答「最近 N 个值」，不回答「最近 T 秒的值」。
跨已知缺口做聚合会得到一个「看不出错」的错数字，所以业务窗口留在服务端，缓冲区只服务
于图表要展示的东西。

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
pnpm coverage     # vitest + vitest.config.ts 里的覆盖率阈值
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # dist/ + dist/package.json
```

联调 demo（真实浏览器 + 真实 Nginx，另有命令行冒烟与内存压测）：
见 [demo/README.zh-CN.md](./demo/README.zh-CN.md)，命令为 `pnpm demo:server` / `pnpm demo:smoke` /
`pnpm demo:matrix` / `pnpm demo:memory`。

CI 在 Node 18、20、22 上跑完整流水线；覆盖率阈值与无浏览器冒烟只在 Node 20 上跑一次。

发版：先补 CHANGELOG 条目、升版本号、打 tag，然后

```bash
git tag -a v0.1.4 -m "v0.1.4"
pnpm publish:npm  # 构建并发布到 npmjs（access: public）
```

## 许可证

[MIT](./LICENSE)
