# cnb2api → Magpie Provider：MQTT 只传动态域名

对照 [p3psi-boo/cnb2api-magpie](https://github.com/p3psi-boo/cnb2api-magpie)
和 [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)。

**MQTT 是控制面，只替代 `cnb-register.py` 那一次「当前子域名是什么」。**
对话、模型列表、用量、SSE 全部仍走 HTTPS，直连
`https://<sub>-9001.cnb.run`。Broker 上看不到 chat。

上一版曾把整段 `/v1/chat/completions` 打成 MQTT 隧道，范围过大，已废弃。

---

## 1. `cnb-register.py` 实际在传什么

它不转发 token，也不碰补全请求。`start.sh` 开机只 POST 一件事：

```json
{ "uri": "https://<subdomain>-{{port}}.cnb.run" }
```

中继校验 URI，改 nginx `map`，客户端继续打固定域名。chat 始终是：

```
客户端 ──HTTPS──▶ nginx ──HTTPS──▶ <漂移子域名>-9001.cnb.run ──▶ cnb2api
```

Magpie 插件跑在用户本机，自己就能 `fetch` 那个 `*.cnb.run`。
缺的只是「现在的子域名」——正好是 register 那条消息。用共用 MQTT
把这条消息发给插件，nginx / VPS / 固定域名都可以去掉。

---

## 2. 目标形态

```
                    MQTT（加密，仅 presence / 当前 URI）
         ┌──────────────────────────────────────────────┐
         │                                              │
    Magpie 插件                                    各 cnb2api 工作区
    记下 A/B/C 的当前 URL                            开机 publish 一次
         │                                              │  漂移了再发
         │  HTTPS  chat / models / usage / SSE          │
         └──────────▶ https://<sub>-9001.cnb.run  ◀─────┘
```

| 通道 | 承载 | 不承载 |
|---|---|---|
| MQTT | 当前 `PROXY_URI`、up/down、`bootId`、可选模型兜底列表 | 请求体、SSE、`CNB_TOKEN`、对话 |
| HTTPS | 现有 `src/server.mjs` 的全部 API | — |

约束：

1. 同一仓库双入口：cnb2api HTTP 原样保留；根目录再注册 Magpie 插件。
2. Broker 共用且不可信：presence 对称加密，topic 不可枚举。
3. 一个插件多个实例：每个工作区 = 一个 Magpie 账号。
4. 不配 MQTT 时，工作区行为与现在完全一致（仍可走 `cnb-register.py`）。

---

## 3. 多实例 = 多次登录

Magpie 对一个 `auth.provider` 可以登录多次，5xx 自动切号。每个账号一份：

| 字段 | 作用 |
|---|---|
| `brokerUrl` | 共用 Broker，优先 `wss://` |
| `instanceId` | 账号名，派生 topic |
| `psk` | 只解 MQTT presence，**不是** chat 密钥 |
| `key`（`PROXY_KEY`） | 打 `*.cnb.run` 时的 Bearer，和现在客户端一样 |
| `metadata.baseURL` | 最近一次解密到的 `https://<sub>-9001.cnb.run` |

不在第一期做「一把 master key 发现全部实例」。

---

## 4. Magpie 钩子

供应商 id：`cnb2api`（避开内置名）。
`npm: "@ai-sdk/openai-compatible"`，Magpie 已把任意 Agent API 转成
`/v1/chat/completions`。

```
package.json
  main / exports["./server"]: ./plugin/index.mjs
  keywords: [opencode, opencode-plugin, cnb]
  magpie.maxConcurrency: 2
  scripts.start: node src/server.mjs
```

`authorize`：用 PSK 订 presence，解开一条合法 URI（或超时失败）。
顺手 `GET {uri}/health` 确认端口代理活着。

`loader.fetch`：

1. `getAuth()` 取 `PROXY_KEY` + 缓存的 `baseURL`
2. 若 MQTT 推来了新 URI，写成 `metadata.baseURL`（`client.auth.set` 合并）
3. **普通 `fetch(https://<sub>-9001.cnb.run/v1/…)`**，带 Bearer，
   流式 `Response` 原样返回
4. 连接失败 / 超时 → 等下一条 presence，或让 Magpie 切号

`provider.models` / `auth.usage`：同样 HTTPS 打当前 `baseURL` 的
`/v1/models`、`/usage`。MQTT 不传这些。

---

## 5. MQTT 消息（很小）

Topic（不可猜）：

```
ns = base64url( HMAC-SHA256(psk, "cnb2api/mqtt/v1/" + instanceId) [0:16] )
cnb2api/v1/{ns}/presence      retained, QoS 1
```

明文（加密前），大约几百字节：

```json
{
  "v": 1,
  "status": "up",
  "uri": "https://abcd1234-9001.cnb.run",
  "bootId": "…",
  "ts": 1730000000
}
```

关机或进程退出：`{ "status": "down", "ts": … }`，清掉 retained。
**没有 req/res/abort，没有分片，没有 chat 帧。**

加密：`HKDF-SHA256(psk, salt="cnb2api-mqtt-v1", info=instanceId)` →
AES-256-GCM。AAD 绑 topic。丢弃 `|now-ts| > 120s` 的帧。
PSK 每实例一把。

URI 仍用现在的正则闸门（与 `cnb-register.py` 相同）：

```
^https://([a-z0-9]+)-(?:\{\{port\}\}|[0-9]+)\.cnb\.run$
```

不匹配就丢。防止伪造 presence 把插件拐到任意主机（否则
`PROXY_KEY` 和对话会跟过去）。

工作区侧：`start.sh` / 进程内在 HTTP listen 成功后 publish 一次；
子域名不变就只靠 retained + 30s 心跳刷新 `ts`。这替代
`REGISTER_URL` + `X-Reg-Token`。`CNB_TOKEN` 不出工作区。

---

## 6. 工作区改动

新环境变量（可选）：

```
MQTT_BROKER=wss://broker.example.com/mqtt
MQTT_INSTANCE_ID=…
MQTT_PSK=…
```

配齐则向 Broker 发 presence，**不改变 HTTP 服务**。
`REGISTER_URL` 仍可用，两套控制面可以同时开。

手写最小 MQTT 3.1.1 客户端即可（消息就一条）。出站优先 WSS/443。

`cnb-register.py`、`DEPLOY.md`、`cnb-watchdog.sh` 不删。
还要给 Cursor / Claude Code / New API 固定域名的人继续走 nginx。

---

## 7. 安全

| 威胁 | 对策 |
|---|---|
| Broker 运营方读对话 | 对话根本不进 MQTT |
| 他人看到你的当前子域名 | presence 加密 + topic = HMAC(psk) |
| 伪造 URI 把流量拐走 | AES-GCM 认证 + `*.cnb.run` 正则 |
| 重放已回收的旧 URI | ts 窗口；HTTPS 失败则等新 presence / 切号 |
| `PROXY_KEY` 泄漏 | 只存在 Magpie `plugin-auth.json`，不进 MQTT |
| `CNB_TOKEN` 外泄 | 永远不出工作区 |

---

## 8. 落地顺序

1. 工作区：开机 / 心跳 publish 加密 presence（URI + up/down）
2. 插件：登录、订 presence、校验 URI、HTTPS `fetch` 当前域名
3. 多账号登录 + Magpie 切号
4. 文档：对照「MQTT = 新 register；chat = 原 HTTPS」

不在范围：SSE over MQTT、4MiB 分片、插件自己做加权池、删掉 nginx 中继。
