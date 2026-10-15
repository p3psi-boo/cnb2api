# cnb2api → Magpie Provider + MQTT 隧道方案

本文是对照 [p3psi-boo/cnb2api-magpie](https://github.com/p3psi-boo/cnb2api-magpie)
（与 [dengyie/cnb2api](https://github.com/dengyie/cnb2api) 同构）以及
[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) 之后的落地设计。
**现有 HTTP 网关与 `cnb-register.py` 中继继续保留**；MQTT 是给 Magpie
用的第二条出站通道，用来去掉「VPS + 固定域名 + nginx 热更新」这条路径。

---

## 1. 现状：现在为什么需要 `cnb-register.py`

CNB 工作区里的 `https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions`
只在工作区内网可达，且必须用流水线临时 `CNB_TOKEN`。所以反代必须跑在
工作区里。但工作区子域名 `<sub>-<port>.cnb.run` **每次重启都会变**，
平台还会过夜回收。

当前自愈闭环：

```
客户端 ──HTTPS──▶ 自建 nginx 固定域名
                     │  map $cnb_ai_upstream
                     ▼
              <漂移子域名>-9001.cnb.run
                     │
                     ▼
              cnb2api HTTP (src/server.mjs)
                     │  Bearer CNB_TOKEN
                     ▼
              CNB 内网 AI
```

`deploy/start.sh` 开机后把 `CNB_VSCODE_PROXY_URI` POST 到
`REGISTER_URL`（`X-Reg-Token`）。`cnb-register.py` 校验 URI 形态，
原子改写 nginx `map`，`nginx -t` 通过才 reload，失败回滚。

这条路的硬伤：

| 点 | 后果 |
|---|---|
| 一台 VPS + 域名 + TLS + systemd | Magpie 用户本机已经有网关，却还要再养一台中继 |
| nginx `map` 只有一个 `$cnb_ai_upstream` | **一个中继只能跟一个工作区** |
| 工作区入站靠 CNB 端口代理 | 子域名漂移、需要注册、需要探活 `/health` |
| keepalive cron 探的是固定域名 | 注册失败 = 整条公网路径假死 |

Magpie 插件跑在用户本机的 Bun 宿主里，本来就可以**主动出站**。
工作区也可以出站。两边都连同一台 MQTT Broker，就不再需要任何入站端口、
固定域名，也不再需要 `cnb-register.py` 改 nginx。

---

## 2. 目标形态

```
Agent ──▶ Magpie 网关 ──▶ 本插件 fetch()
                              │  AES-256-GCM 帧
                              ▼
                       共用 MQTT Broker（不可信）
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         cnb2api A       cnb2api B       cnb2api C
         (工作区)         (工作区)         (工作区)
              │
              ▼
         CNB 内网 AI
```

约束：

1. **同一仓库双入口**：继续当 cnb2api（HTTP / Claude Code / 旧中继）；
   根目录 `package.json` 再按 Magpie 规则注册成 provider 插件。
2. **Broker 共用且不可信**：payload 必须对称加密；topic 不可枚举。
3. **一个插件、多个实例**：每个 cnb2api 工作区 = Magpie 的一个账号；
   故障切换、额度、并发上限走 Magpie 现成机制。
4. **HTTP 路径零破坏**：不设 MQTT 环境变量时，行为与现在完全一致。
5. **工作区侧尽量不引入 npm 依赖**：MQTT 客户端与编解码用 Node 22 内置
   `net` / `crypto` / `buffer` 手写（MQTT 3.1.1 + WebSocket 可选）。
   插件侧可用同一份代码，Bun 宿主也能跑。

---

## 3. 为什么「多实例」应对齐 Magpie 账号，而不是插件自己做池

Magpie 对一个 `auth.provider` 可以登录多次：

- 第一个账号存在供应商 id 下，其余是 `id#xxxxxx`
- 每个账号有自己的 `getAuth()`、`provider.models`、`auth.usage`、并发上限
- 限流 / 5xx / 抛错会切到下一个账号
- 文档明确要求：**账号状态按 `getAuth()` 存，不要放进以供应商为键的模块变量**

因此产品模型是：

```
magpie plugin login cnb2api     # 第 1 个工作区
magpie plugin login cnb2api     # 第 2 个工作区
# 模型形如 cnb2api/deepseek-v4.1-flash，Magpie 在账号之间切换
```

一次登录对应一份：

| 字段 | 来源 | 作用 |
|---|---|---|
| `brokerUrl` | prompt，可有默认共用 Broker | `wss://…` 优先（443 出站更不容易被挡） |
| `instanceId` | prompt，建议 `openssl rand -hex 16` | 账号名 / topic 隔离 |
| `psk` | `type: "password"` | AES-256-GCM 密钥材料 |
| `accountId` | `instanceId` | Magpie 用来区分、覆盖重登 |

不把「一个 master key 发现全部实例」做成第一期：Magpie 的账号是登录时创建的，
动态发现的实例无法自动变成账号，额度与 failover 也会糊成一锅。第一期用
多次登录；若以后要「一键导入舰队」，再在 `authorize()` 里吃一份 JSON 清单、
循环 `client.auth.set` 写多个账号。

---

## 4. Magpie 插件怎么挂

文档要求（[usemagpie.ai/docs/zh/plugins](https://usemagpie.ai/docs/zh/plugins)）：

- 根目录 `package.json`，`exports["./server"]` 或 `main` 指向插件入口
- 只导出插件函数（辅助函数挂 `export const _internal`）
- keywords：`opencode`、`opencode-plugin`、`cnb`
- `"magpie": { "icon", "maxConcurrency" }`
- GitHub topic：`magpie-plugin`（发现页「非官方 · GitHub」）
- 供应商 id 避开内置名（`openai` / `anthropic` / `google` / `magpie`）
  → 用 **`cnb2api`**

```text
package.json
  name: cnb2api
  main / exports["./server"]: ./plugin/index.mjs
  keywords: [opencode, opencode-plugin, cnb]
  magpie.maxConcurrency: 2          # 单工作区别打太满
  scripts.start: node src/server.mjs   # 原 HTTP 入口不动

plugin/index.mjs                    # Magpie / OpenCode 插件
src/                                # 现有 cnb2api
src/mqtt/                           # 插件与工作区共用的协议栈
  codec.mjs                         # 帧、分片、seq
  crypto.mjs                        # AES-256-GCM + HKDF
  topics.mjs                        # topic 派生
  client.mjs                        # 最小 MQTT 3.1.1 客户端
src/mqtt-agent.mjs                  # 工作区侧：订阅 req，回 res
```

`config` 钩子声明供应商（models.dev 没有 `cnb2api`）：

```js
cfg.provider["cnb2api"] ??= {
  name: "CNB2API",
  npm: "@ai-sdk/openai-compatible",   // Magpie 已把任意 Agent API 转成 chat completions
  models: {
    "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 128000, output: 8192 }, tool_call: true },
    "glm-5.3-flash": { name: "GLM 5.3 Flash", limit: { context: 128000, output: 8192 }, tool_call: true },
    "kimi-k3": { name: "Kimi K3", limit: { context: 128000, output: 8192 }, tool_call: true },
  },
}
```

选 `@ai-sdk/openai-compatible` 而不是 Anthropic：Magpie 网关会先把
Claude / Responses / Gemini 转成 `/chat/completions`，插件 `fetch` 收到的
就是 cnb2api 原生会的那条路径。工作区里的 `/v1/messages` 翻译留给
「直连 Claude Code、不经过 Magpie」的旧用户。

`auth.methods`：一组 prompts（broker、instanceId）+ `type: "api"` 的 PSK
（或 `type: "password"` prompt + `authorize` 校验后写入 `key`/`metadata`）。
`authorize` 里做一次 MQTT `ping` RPC（`GET /health`），失败则
`{ type: "failed", error }`，避免登录一个永远连不上的账号。

`loader(getAuth)`：

- **按账号**缓存一条 MQTT 连接（key = `instanceId`，禁止用供应商级单例）
- `baseURL` 用占位 `http://cnb2api.local/v1`（真实出站走 MQTT，不走 HTTP）
- `fetch(input, init)`：把 method / path / headers / body / `signal`
  打成加密帧发出去，把对端的 `head + chunk* + end` 拼回 `Response`
  （流式正文必须删掉 `content-length` / `content-encoding`）

`provider.models`：对这个账号 RPC `GET /v1/models`；失败原样返回
`provider.models`（Magpie 会保留旧列表）。401 类错误抛
`{ signIn: "expired" }`。

`auth.usage`：RPC `GET /usage`，再映射成 Magpie windows
（credits 百分比、`display: "320 / 1000 cr"`）。工作区里已有
`usage.mjs` 快照；若要把官方 Charge 额度也带出来，agent 侧用现成的
`quota.mjs` + 当次流水线 `CNB_TOKEN` 做短缓存，**不要把 CNB_TOKEN
传到插件或 Broker**。

---

## 5. MQTT 协议（插件 ↔ 工作区）

### 5.1 Topic（Broker 上不可枚举）

共用 Broker 通常没有按用户隔离的 ACL。topic 不能是
`cnb2api/home/req/...` 这种可猜的。

```
ns = base64url( HMAC-SHA256(psk, "cnb2api/mqtt/v1/" + instanceId) [0:16] )

presence  cnb2api/v1/{ns}/presence          retained, QoS 1
req       cnb2api/v1/{ns}/req/{rid}         plugin → agent
res       cnb2api/v1/{ns}/res/{rid}         agent → plugin
abort     cnb2api/v1/{ns}/abort/{rid}       plugin → agent（用户取消）
```

不知道 PSK 就订不到 topic，即使订到也解不开。`instanceId` 仍然明文
存在 Magpie 账号里，只用于 UI 和派生，不进 topic。

ClientId：

- 工作区：`cnb2api-a-{instanceId}-{bootId}`
- 插件：`cnb2api-p-{instanceId}-{random}`

### 5.2 对称加密

- 密钥：`HKDF-SHA256(ikm=psk, salt="cnb2api-mqtt-v1", info=instanceId, len=32)`
- 算法：AES-256-GCM
- 每帧独立 `nonce`（12 字节随机）
- AAD = `topic || rid || seq || kind`，密文和路由绑死，防跨 topic 重放
- 明文外再包一层：`{ v:1, ts, nonce, ct }`
- 收端丢弃 `|now - ts| > 120s` 的帧；同一 `(rid, seq, kind)` 只接受一次

PSK **每实例一把**。一把 master 开所有实例会在某个工作区泄露时
连坐整个舰队。

### 5.3 帧（明文，加密前）

请求（可分片，默认 16 KiB，躲开多数 Broker 的 256 KiB 上限；
cnb2api 自身 body 上限是 4 MiB）：

```
{ kind:"req", rid, seq, last, method, path, headers, body_b64 }
```

响应：

```
{ kind:"head",  rid, status, headers }
{ kind:"chunk", rid, seq, data_b64 }      # SSE / JSON 原文
{ kind:"end",   rid, seq }
{ kind:"err",   rid, status, message }
```

取消：`{ kind:"abort", rid }`。工作区侧接到后走现有
`proxy.mjs` 的 `AbortController`（客户端断开就停上游，避免空烧额度）。

`rid`：插件生成的 16 字节 hex。一条 Magpie `fetch` = 一条 rid，
一条 MQTT 连接上多路复用。

QoS 1。请求超时：连接 / 首字节沿用 `PROXY_UPSTREAM_TIMEOUT_MS`（15s），
流空闲沿用 `PROXY_IDLE_TIMEOUT_MS`（300s）。超时或 Broker 断开 →
插件 `fetch` 抛错或返回 504，Magpie 切下一个账号。

### 5.4 Presence

工作区连上后发 retained：

```
{ status:"up", instanceId, bootId, models[], startedAt }
```

每 30s 再发一次（或 MQTT keepalive 25s）。优雅退出发
`{ status:"down" }` 并清 retained。插件 `authorize` / `models` /
`usage` 先看 presence：长期 `down` 或没有消息 → 账号当不可用
（不要标 `signIn: "expired"`，那是密钥错了；这是工作区休眠，
Magpie 应按 5xx 切号）。

这替代了 `cnb-register.py` 的「告诉中继我现在的地址」。
地址不再需要：出站连上 Broker 就是注册。

---

## 6. 工作区侧改动（cnb2api 本体）

`src/server.mjs` 在 HTTP `listen` 之后，若配置了 MQTT 就再拉起 agent：

```
MQTT_BROKER=wss://broker.example.com/mqtt
MQTT_INSTANCE_ID=…
MQTT_PSK=…                 # 与 Magpie 登录时同一把
# 可选：MQTT_TOPIC_NS 若要手工覆盖派生值
```

agent 职责：

1. 连 Broker，发 presence
2. 订阅 `req/+` 与 `abort/+`
3. 解密、拼装分片，当成一次内部 HTTP 调用
4. **不要再走一遍外网 HTTP**。抽一层 `handleRequest({ method, path, headers, body, signal })`，
   `server.mjs` 的 Node `http` 与 mqtt-agent 共用：`/health`、`/usage`、
   `/v1/models`、`/v1/chat/completions`（流式用现有 `forward()`）
5. 把 `head/chunk/end` 加密发回 `res/{rid}`

`deploy/start.sh`：MQTT 配齐时不再依赖 `REGISTER_URL`。
HTTP 自检 `/health` 保留。可加一句「MQTT connected, ns=…」方便看构建日志。

`.cnb.yml` keepalive：

- 没配固定域名时，现状已经是「工作区 running 就结束」——MQTT 路径够用
- `FIXED=` 探活只留给还在用 nginx 中继的人
- `cnb-watchdog.sh` 同样只服务 HTTP 中继；Magpie 用户靠 cron 拉起工作区
  + 插件 failover，不必再 curl 公网域名

`cnb-register.py` / `docs/DEPLOY.md` **不删**，README 改成：

- 直连 / Claude Code / 旧客户端 → 继续走固定域名中继
- Magpie → 只配 MQTT，不要 `REGISTER_URL`

---

## 7. 共用 Broker 怎么选

| 方案 | 适用 | 注意 |
|---|---|---|
| 项目自己挂一台 EMQX / HiveMQ Cloud（WSS:443 + 匿名或共享用户） | 推荐的「共用」 | 当不可信：仍然强制加密；可再加 ACL 把 topic 限制在 `cnb2api/v1/#` |
| 用户自带 Broker | 企业 / 不想走公共机 | 登录 prompt 填 URL |
| 公共测试 Broker（HiveMQ Public 等） | 仅开发 | 掉线、限流、payload 上限、有人会扫 topic |

插件默认 `brokerUrl` 可以写成文档里那台共用 Broker，用户改得掉。
**不要把 PSK 写进默认值。**

工作区出站优先 WSS/443。纯 `mqtt://:1883` 在部分云桌面会被墙。
手写客户端第一期先做 MQTT 3.1.1 over TCP，WSS 作为紧接着的第二期
（CNB 工作区若 1883 不通就必须先做 WSS）。

---

## 8. 请求生命周期（Magpie 路径）

```
1. Magpie 网关把 Agent 请求译成 POST /v1/chat/completions
2. 插件 loader.fetch
     · getAuth() → broker / instanceId / psk
     · 确保该账号的 MQTT 连接活着
     · 加密分片 publish → req/{rid}
     · subscribe res/{rid}（或连接期通配 res/+，按 rid 分发）
3. 工作区 mqtt-agent
     · 解密拼装 → handleRequest
     · checkAuth：MQTT 路径用「PSK 已校验」代替 PROXY_KEY
       （HTTP 路径仍要 PROXY_KEY，互不影响）
     · forward() 上游，SSE 边读边 chunk 回 res/{rid}
     · 收到 abort 或插件断开 → abort 上游
4. 插件把 head+chunk 变成 Response，Magpie 原样流回 Agent
5. 非 2xx 原样返回，Magpie 按自己的规则切账号
```

并发：一个账号一条 MQTT 连接，靠 `rid` 多路复用。
`magpie.maxConcurrency` 建议 2～4，避免单个 CNB 工作区被打满。

---

## 9. 安全边界

| 威胁 | 对策 |
|---|---|
| 共用 Broker 运营方读对话 | AES-256-GCM，PSK 不经过 Broker |
| 他人订阅你的 topic | topic = HMAC(psk, instanceId)，不可猜 |
| 重放旧帧 | ts 窗口 + (rid,seq,kind) 去重 + AAD 绑 topic |
| 工作区被回收后幽灵响应 | bootId 写进 presence；插件丢弃非当前会话的 rid |
| PSK 泄漏 | 每实例一把；Magpie 存在 `plugin-auth.json`（0600） |
| CNB_TOKEN 外泄 | 永远不出工作区，与现在 DESIGN.md 第 4 节一致 |
| 插件日志把对话打出去 | 沿用现有 `log.mjs` 纪律：不记 body |

HTTP `PROXY_KEY` 与 MQTT `PSK` 是两套凭证。一个人可以同时：
对 Cherry Studio 走 nginx+PROXY_KEY，对 Magpie 走 MQTT+PSK。

---

## 10. 测试

工作区侧（继续 `node --test`，零依赖）：

- `crypto.mjs`：加解密、AAD 绑错失败、过期 ts 丢弃
- `codec.mjs`：4 MiB 分片往返、乱序拒绝、缺 last 超时
- mqtt-agent + 本地 mock Broker（或 loopback client）跑
  `/health`、`/v1/models`、非流式补全、SSE 分片、abort 停上游

插件侧（`bun test`，测 `_internal`）：

- `fetch` 把 `Request` 转成帧、把帧拼回流式 `Response`
- 账号 A 的连接不能响应账号 B
- presence down → models 回退默认列表

沙箱（文档里的 `HOME=` 隔离）：

```
magpie plugin add ./
magpie plugin login cnb2api
magpie provider test cnb2api
magpie quota
```

---

## 11. 建议的落地顺序

**P0 — 协议库**  
`src/mqtt/{crypto,codec,topics}.mjs` + 单测。不连网也能合。

**P1 — 工作区 agent**  
抽出 `handleRequest`，HTTP 与 MQTT 共用。`MQTT_*` 配齐才连。
`start.sh` 打 MQTT 连接日志。1883 先打通，WSS 紧随其后。

**P2 — Magpie 插件**  
`plugin/index.mjs`：login / loader.fetch / models / usage。
根目录 `package.json` 补 `exports`、`keywords`、`magpie` 字段。
仓库打 `magpie-plugin` topic。

**P3 — 多实例**  
文档写清「登录两次 = 两个工作区」。确认 Magpie failover
在一个实例 presence down 时会切到另一个。
`maxConcurrency` 按账号生效。

**P4 — 文档**  
README 增加「Magpie 接入」一节：共用 Broker、PSK、与旧中继的对照表。
`DEPLOY.md` 开头声明「仅 HTTP 固定域名需要本章」。

不在第一期做的：

- 删 `cnb-register.py`
- 插件自己做实例池 / 加权负载
- 在 Broker 上做 ACL 用户体系（加密已经够；ACL 是加固，不是前提）
- 把 `/v1/messages` 再暴露成 Magpie 的 Anthropic 供应商（网关会先翻译）

---

## 12. 和旧中继的分工（给用户看的一句话）

- 还要给 **Cursor / Claude Code / New API** 一个 `https://ai.example.com/v1`
  → 继续 `cnb-register.py` + nginx。
- 只用 **Magpie（以及其它跑 OpenCode 插件的宿主）**
  → 工作区出站连共用 MQTT，本机插件入站，不再需要 VPS 转发。
- 两套可以同时开在同一个 cnb2api 进程上。
