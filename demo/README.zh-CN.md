# 联调 demo

[English](./README.md) · 简体中文

覆盖提测清单里用 mock 测不出来的部分：真实浏览器、真实 Nginx、真实的流式响应。

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 零依赖 SSE 服务端（`127.0.0.1:8787`）：Bearer 鉴权、`Last-Event-ID` 续传、16 个故障 / 边界 / 压力场景 |
| `index.html` + `main.js` | 浏览器联调台：入口切换、场景切换，所有客户端开关都摆在界面上；带内存采样面板，支持中英切换 |
| `smoke.mjs` | 无浏览器冒烟：直连 / 网关 / 续传一条命令搞定，可进 CI |
| `browser-matrix.mjs` | 真实 Chrome / Edge 自动化：基于 CDP 跑 20 个场景，不依赖 Playwright |
| `memory-probe.mjs` | 内存压测：flood 灌流 + CDP 堆采样 + GC 归零对比，回答「长连接会不会涨内存」 |
| `consumers-check.mjs` | 驱动四个消费示例页：角色分配与接管、F5 续传、401 自愈、切租户换 key |
| `nginx.conf` | 本机 Nginx：8081 正确，8082 故意配错 |
| `nginx.docker.conf` | Docker 版，仅 upstream 地址不同 |
| `consumers/` | 消费侧示例：告警中心 / 测点看板 / 多标签页 / Vue 共享订阅，按业务层消费方式组织；每页都有可编辑配置面板 |

## 按业务场景索引

不同业务场景各跑哪些 demo（场景参数与预期见 [§ 3 场景与预期](#3-场景与预期)）：

| 业务场景 | 用这里的什么 | 怎么跑 |
| --- | --- | --- |
| 告警中心 / 不能丢事件 | `smoke.mjs`：`Last-Event-ID: 5` 续传断言（从 id=6 恢复） | `pnpm demo:smoke` |
| 设备测点大数据 / 高频采集 | `memory-probe.mjs`：flood 灌流 + burst 单块 + GC 归零对比（§ 6） | `pnpm demo:memory` |
| 实时大屏 / 多标签页 / 后台 | browser-matrix：后台挂起→恢复、隐藏中构造（§ 5.1） | `pnpm demo:matrix` |
| 移动端 / 弱网巡检 | browser-matrix：断网 0.8s 恢复、`silent` + `idleTimeout`（§ 5.1） | `pnpm demo:matrix` |
| 网关与链路验收 | 8081 正确 / 8082 配错对照、`accel` 上游自救（§ 2、§ 4） | `pnpm demo:smoke` |
| 渲染卡顿 / 长任务 | `yieldEvery` A/B +「处理耗时」忙等模拟（§ 6.1） | `pnpm demo:memory --handler=1 --yield=20` |
| 鉴权过期自愈 | 联调台「401 自动刷新 token」× `error401` 场景（§ 3） | `pnpm demo:server` 后手动操作 |

## 1. 启动服务端

```bash
pnpm build          # 页面 import 的是 dist/，必须先构建
pnpm demo:server    # 等价于 node demo/server.mjs
```

打开 <http://127.0.0.1:8787/demo/index.html>，点 **Connect**，事件应逐条到达。

> 只验接口不验页面时不用 `pnpm build`，服务端本身零依赖。

## 2. 启动 Nginx

Docker（Windows 推荐）：

```bash
# 容器要访问宿主机，服务端需监听 0.0.0.0
HOST=0.0.0.0 pnpm demo:server
# PowerShell: $env:HOST='0.0.0.0'; pnpm demo:server

docker run --rm -p 8081:8081 -p 8082:8082 \
  -v "${PWD}/demo/nginx.docker.conf:/etc/nginx/nginx.conf:ro" nginx:alpine
```

> `nginx.docker.conf` 是完整配置（含 `worker_processes` / `events` / `http`），
> 必须挂到 `/etc/nginx/nginx.conf`；挂进 `conf.d/` 会报
> `"worker_processes" directive is not allowed here`。

本机 Nginx（在仓库根目录执行）：

```bash
nginx -p demo -c nginx.conf
# 停止
nginx -p demo -c nginx.conf -s stop
```

联调台提供三个入口：

| 入口 | 含义 |
| --- | --- |
| 直连 `:8787` | 无网关基线 |
| `:8081` | `proxy_buffering off` + `gzip off`，应与基线一致 |
| `:8082` | 三个错法叠加，复现「连上了但一条都收不到」 |

8082 叠了三个问题，任何一个都会让 SSE 卡住：

1. `proxy_http_version 1.0` —— 网关看不到上游的 chunk 边界，只能攒满再发（确定性最强，任何客户端都复现）；
2. `proxy_buffering on` + 大缓冲区 —— 老版本 Nginx、HTTP/1.0 上游时必现；
3. `gzip on` + `gzip_types text/event-stream` —— 浏览器一定带 `Accept-Encoding`，压缩会攒块。

>> 实测（nginx 1.29 / alpine）：只开 `proxy_buffering on` 而保留 HTTP/1.1 上游时，
>> 小报文仍会被逐个放行，所以配置里用 HTTP/1.0 + gzip 来保证**稳定复现**。
>> 用 curl 手工验 gzip 那条路径需要加 `--compressed`。

## 3. 场景与预期

| 场景 | 预期表现 | 验证能力 |
| --- | --- | --- |
| `normal` | 按间隔推事件，id 递增，UTF-8 载荷完整 | 基础流式 + 解码 |
| `chunked` | 一帧拆 3 次写、切在 3 字节字符中间，仍然干净 | `TextDecoder({stream})` |
| `heartbeat` | `idleTimeout=1000` → heartbeat 错误并重连；`6000` → 保持 open | 心跳 vs 看门狗 |
| `silent` | `idleTimeout=3000` → 3 秒后 heartbeat 错误，不死等 | 僵尸连接 |
| `end` | 开启重连则自动重连；否则 `closed`，reason 为 `end` | `reconnectOnEnd` |
| `done` | 收到 `data: [DONE]` 立即关闭，且无 JSON 解析错误 | `endSignal` |
| `retry-field` | 断流后约 2 秒重连（对比日志时间戳） | 服务端 `retry:` |
| `huge` | 2MB 单条消息 → `protocol` 错误，`closed`；勾选「超限消息丢弃」则只丢该条、连接保持 | `maxBufferSize` + `overflowPolicy` |
| `no-blank-line` | 累计超 1MB → `protocol` 错误（旧版本会一路涨内存） | 事件级缓冲上限 |
| `slow` | `connecting` 持续 3 秒（网关默认 60s 读超时会断） | 慢握手 |
| `accel` | `X-Accel-Buffering: no` 绕过 8082 的缓冲 | 上游自救开关 |
| `html` | 200 + `text/html` → `protocol` 错误，只请求一次 | 网关登录页 |
| `error500` | 指数退避重连，`maxRetry` 用尽后 `closed` | 退避 + 重试预算 |
| `error401` | 默认一次请求后 `closed`；勾选「401 自动刷新 token」后可自愈 | 终态错误 + `retry` 策略 |
| `flood` | 每批 `burst` 条 × 每 `interval` 一次，持续灌流：堆呈锯齿、`dom` 持平、不报错 | 高频长连接不累积 |
| `burst` | 一次写入 `burst` 条（默认 2000 ≈ 400KB）：单个同步解析任务，主线程有一次性停顿 | 大块解析成本 |

`flood` / `burst` 的载荷由表单里的「每批条数」「单条字节」控制，也是 `memory-probe.mjs` 使用的入口。

## 4. 命令行验证

```bash
# 一条命令：直连是否通、两个网关入口是否符合预期、续传是否生效
pnpm build && pnpm demo:smoke
# 输出 PASS/FAIL 与退出码，可直接塞进 CI
```

8082 配错时的实测输出：

```text
Direct       http://127.0.0.1:8787       received 13 events live
             first: ALARM:1, ALARM:2
Nginx :8081  http://127.0.0.1:8081       received 12 events live
Nginx :8082  http://127.0.0.1:8082       no data (status=connecting, typical gateway buffering)

Last-Event-ID resume: RESUME → ALARM:6 → ALARM:7
PASS  direct endpoint receives events
PASS  resume starts at id=6
```

同一个流用 curl 验：

```bash
# 取 token
curl -X POST "http://127.0.0.1:8787/auth/token?ttl=60000"

# 直连（-N 关闭 curl 自己的缓冲）
curl -N -X POST "http://127.0.0.1:8787/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'

# 同一路流走两个网关：8081 实时刷出，8082 长时间空白
curl -N -X POST "http://localhost:8081/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
curl -N -X POST "http://localhost:8082/subscribe?scenario=normal&interval=500" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
```

## 5. 浏览器矩阵

### 5.1 自动化（Chromium 内核）

```bash
pnpm build && pnpm demo:server          # 终端 1
docker run ...                          # 终端 2，见第 2 节
pnpm demo:matrix                        # Chrome + Edge，各 20 个场景
pnpm demo:matrix --only=edge            # 只跑一个浏览器
node demo/browser-matrix.mjs --shots=D:\shots   # 指定截图目录（默认 %TEMP%\sse-matrix）

pnpm demo:consumers                     # 四个消费示例页，各 12 条断言
pnpm demo:consumers --only=edge
```

用 CDP + Node 内置 WebSocket 直接驱动真实浏览器，不依赖 Playwright：

| 场景 | 断言 |
| --- | --- |
| 直连推流 | ≥4 条，`open` |
| Nginx 8081（正确） | ≥4 条，`open` |
| Nginx 8082（配错） | 0 条，停在 `connecting` |
| 分块 + 多字节 | ≥2 条，无 `U+FFFD` 乱码 |
| 2MB 超上限 | `protocol` 错误，`closed` |
| `[DONE]` 终止 | 2 条后 `closed`，reason 为 `end` |
| 服务端结束流不重连 | 3 条后 `closed` |
| 静默流 + idleTimeout | `heartbeat` 错误并重试 |
| 断网 0.8s 恢复 | 回到 `open`，无 `close error`，事件继续增长 |
| 后台挂起后恢复 | 隐藏时 `idle` 且无新增，恢复后 `open` 并继续收流 |
| 隐藏页构造后激活 | 激活前 0 条 / `idle`，激活后开始收流（P0 回归） |
| 心跳注释 + idleTimeout | 0 条（注释不是事件）、`heartbeat` 错误、至少 1 次重试 |
| `retry:` 字段 | 重连后 ≥2 条，无 `protocol` 错误 |
| 未终止事件触顶 | `protocol` 错误、`closed`（4KB 行一直不写空行） |
| 慢握手 | 2 秒时仍 `connecting`、0 条 |
| 200 + text/html | `protocol` 错误、`closed`、只尝试 1 次 |
| 500 退避后耗尽 | 至少 2 次尝试后 `closed` |
| 401 终止 | 只尝试 1 次即 `closed` |
| accel 的 `X-Accel-Buffering` | ≥4 条、`open`（该响应头在 :8082 上的效果留给手动演示） |

`consumers-check.mjs` 断言的是每个示例页存在的理由：leader/follower 分工与 leader
关闭后的接管、切租户换共享 key、压力下环形缓冲持续填充、F5 续传（`skipped=1`，
即干净衔接）、以及吊销令牌后经 401 重试自愈。

最近一次结果：Chrome 155.0.8059.85 / Edge 155.0.4283.62，矩阵 **40/40 PASS**，
消费示例 **20/20 PASS**，重复跑稳定。

已知限制：

- 只覆盖 Chromium 内核。Windows 上可自动化的只有 Chrome / Edge，Safari 与 iOS WebView 需要真机（见 5.2）。
- headless 无法真实切换标签可见性：后台标签仍是 `visible`，`Page.setWebLifecycleState("active")`
  也不会还原 `visibilityState`。因此两个后台场景只伪造 `document.hidden`，
  `visibilitychange` 事件与客户端处理链路都是真实的。
- 8082 的失败依赖 `HTTP/1.0 + gzip` 组合；只开 `proxy_buffering on` 在 nginx 1.29 上复现不出来。

### 5.2 真机手动清单

每个内核各跑一遍（Chrome / Edge / Safari / iOS Safari 真机；微信或 App WebView 视情况）：

- [ ] `normal` 实时到达，UTF-8 载荷完整
- [ ] 勾选 `pauseWhenHidden`，切后台 5 分钟再回来，能继续收流（本版修复的 P0）
- [ ] 断网 10 秒后恢复：自动重连，`lastEventId` 不清零
- [ ] 吊销 token 后重启：勾选刷新策略能自愈，不勾选则只请求一次
- [ ] `idleTimeout` + `heartbeat` 组合不会误杀健康连接
- [ ] `rotateInterval=30000` 轮转期间不丢事件，`lastEventId` 连续
- [ ] 8082 入口能复现卡顿 → 证明根因是网关配置，不是客户端
- [ ] 关闭页面 / 卸载组件后，服务端确实看到连接断开

## 6. 高频 / 内存实测

「SSE 长连接会不会把 tab 内存堆到几个 G」不能靠推理，跑一遍：

```bash
pnpm build && pnpm demo:server                          # 终端 1
pnpm demo:memory                                        # 默认：10 条 × 1KB / 20ms，60 秒
pnpm demo:memory --seconds=30 --burst=50 --size=8192    # 重压：≈12 MB/s
pnpm demo:memory --lang=zh --shots=%TEMP%\shots         # 顺带截一张中文界面
```

探针做三件事：先 `HeapProfiler.collectGarbage` 归零再读堆（只有 GC 后的增量才能区分「在缓冲」和「在泄漏」）、用
`Performance.getMetrics` 取主线程耗时、页面内 `performance.memory` 交叉验证。

实测（Chrome 155 headless，`--enable-precise-memory-info`，单 tab）：

| 场景 | 时长 | 事件 | 收到数据 | 堆峰值 | GC 后 | 相对基线 | DOM 节点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 默认 10×1KB / 20ms | 60s | 19,620 | 16.4 MB | 1.7 MB | 0.9 MB | +0.3 MB | 117 → 117 |
| 重压 50×8KB / 20ms | 30s | 48,000 | 368.3 MB | 4.6 MB | 0.8 MB | +0.2 MB | 117 → 117 |
| 单块 burst | 2.5s | 2,000 | 0.2 MB | 1.9 MB | 0.8 MB | +0.2 MB | 117 → 117 |

结论：**368 MB 灌进来，堆峰值 4.6 MB，GC 后回到基线**。长连接自己不留历史数据，峰值只是还没回收的临时对象（锯齿）；
重压 30 秒主线程占用约 2.7 秒（≈9%），无报错、无断流、DOM 节点数完全不变。

必须说明的几点：

- 采样期间探针会调 `__setLogEnabled(false)` 关掉事件日志。联调台日志有 400 行上限，不关的话先涨的是 DOM，
  测出来的数字与流式链路无关。人手看界面时日志是开着的，超过约 20 行/秒会自动降采样并提示。
- 灌流过程中页面内 `performance.memory` 会明显高于 CDP 读数（未回收的年轻代），GC 后两者收敛到 0.9 MB 左右。
  这正是「看到几个 G」的典型误判来源：先在 DevTools 里点垃圾桶强制 GC 再看。
- 真会涨到 G 级的三种情况都不在客户端库里：业务把每条消息塞进数组 / 响应式 store、开着 DevTools 的 Network
  面板看流（会缓存每一帧）、没开 `pauseWhenHidden` 而后台页面一直往状态里写。
- 想验证更长时间不泄漏：`--seconds=600`，采样点上限 300 个，不会自己涨。

### 6.1 长任务与让出主线程

联调台新增两个旋钮：`yieldEvery`（每 N 条让出主线程）和「处理耗时（ms/条）」（用忙等模拟真实的每条渲染成本）。
把后者设成 1ms、`flood` 用 25 条/50ms、单块 `burst` 灌 2000 条，A/B 结果：

```bash
pnpm demo:memory --seconds=12 --interval=50 --burst=25 --size=512 --handler=1 --yield=0
pnpm demo:memory --seconds=12 --interval=50 --burst=25 --size=512 --handler=1 --yield=20
```

| `yieldEvery` | burst 单次最长阻塞 | burst 主线程总耗时 | 收到事件 |
| --- | --- | --- | --- |
| `0` | **1467 ms** | 2032 ms | 2000 |
| `20` | **117 ms** | 2046 ms | 2000 |

总工作量一模一样（切片不省时间），最长阻塞降到 1/12。残余的 ~117ms 不是切片粒度问题：调到
`yieldEvery: 5` 也是 117ms——2 秒的总积压会持续压住渲染，切片只能保证没有单次超长任务。

`overflowPolicy` 同样在界面上（勾选框「超限消息丢弃、不断开」）。勾上后跑 `huge`：连接保持 `open`，
只丢那一条，日志出现 `gap` 行（`reason: drop`）——丢消息是连续性问题而不是传输失败，所以走 gap 信号，
累计条数看 `client.dropped`；不勾则是原来的 `protocol` 错误 + `closed`。

## 注意

- demo 是明文 HTTP + `Access-Control-Allow-Origin: *`，只在本机联调使用。
- `main.js` 引用 `dist/index.js`，改完 `src/` 记得重新 `pnpm build`。
- token 只存在服务端内存里，重启即失效；页面会自动重新签发。
