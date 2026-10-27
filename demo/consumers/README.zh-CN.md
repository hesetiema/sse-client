# 消费侧示例

每个目录是一个独立、可直接运行的业务消费示例，共用 `demo/server.mjs` 的 16 个场景，不需要构建前端工程。
每个页面顶部都有可编辑的配置面板：改一项即按新配置重连，不用改代码再刷新。

```bash
pnpm build && pnpm demo:server
# 打开 http://127.0.0.1:8787/demo/consumers/<目录>/index.html
```

| 目录 | 业务场景 | 关键构件 | 看什么 |
| --- | --- | --- | --- |
| `alarm-center/` | 告警中心：一条不能漏、漏了要能证明 | `SSEClient` · `request` 组 · `retry` · `resume.persist` · `hooks.gap` / `hooks.resume` | 401 自愈、刷新后续传、按 id 去重 |
| `point-board/` | 测点看板：高频写入、内存恒定 | `createBatcher` · `fanout()` · `createRingBuffer` · `yieldEvery` | 300ms 窗口合并、每帧一次重绘、`evicted` 截断 |
| `multi-tab/` | 大屏多标签页 | `createMultiTabSSE` | leader 独占连接、follower 中继；关掉 leader 看接管 |
| `vue-shared/` | Vue 多组件 / 多租户切换 | `useSharedSSE` · `subscription` getter · `grace` | 切租户复用连接、卸载显式 `dispose` |

`shared/token.js` 是几个示例共用的 token 获取，不属于示例本身。

## 可编辑面板

每个页面用 `shared/panel.js` 渲染自己的控件（样式在 `shared/panel.css`）。改动 300ms
内合并成一次应用并重建连接；**恢复默认**回到出厂值，**重新连接**用当前值再连一次。
配置按页面存在 `sessionStorage`，刷新后沿用——`alarm-center` 刷新仍能续传也有它的一份。

| 页面 | 可调项 |
| --- | --- |
| `alarm-center` | 场景（`normal` / `slow` / `heartbeat` / `chunked` / `end`）、间隔、`idleTimeout`、是否跨刷新记住位点、起始位点 |
| `point-board` | 场景（`flood` / `burst` / `normal`）、间隔、每批条数、单条字节、`yieldEvery` |
| `multi-tab` | 场景（`normal` / `slow` / `heartbeat`）、间隔、`idleTimeout`——两个标签页请用相同值；接管时按本页配置续传 |
| `vue-shared` | 场景、间隔、`idleTimeout`——这些是 ref，改一个就换共享 key 并释放旧连接 |

面板顺带暴露了两个语义：

- `alarm-center` 的续传位点按「请求」派生 key，改场景等于换订阅（新 key、不继承旧位点），
  而不是去"续传"一条从未存在过的流。
- `point-board` 改配置只重建连接，环形缓冲原样保留，图表不会被清空。

破坏性观察建议：

- `alarm-center`：连上后点浏览器刷新（F5），日志应显示从上次位点续传，`resume` 行报告 `skipped=1` / `continuous=true`（`skipped` 是 `firstId - lastId`，0 表示服务端重放了最后一条）；再在服务端执行 `POST /auth/revoke` 吊销令牌，看 401 是否自愈。
- `point-board`：面板里选 `burst`、把每批条数改成 2000，单块一次性灌入；再对比 `yieldEvery` 设 0 / 20 时的主线程停顿（每次改动只重建连接，环形缓冲不丢）。
- `multi-tab`：同一地址开两个标签页，角色应是一个 `leader` 一个 `follower`，事件数同步增长而连接只有一条。
- `vue-shared`：切换租户会改变共享 key 并释放旧连接。共享范围是单个标签页（页内引用计数）：跨标签页只开一条连接请看 `multi-tab/`——那是 `createMultiTabSSE` 的职责，`useSharedSSE` 不跨页。
