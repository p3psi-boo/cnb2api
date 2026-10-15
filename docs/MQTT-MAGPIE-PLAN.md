# cnb2api → Magpie Provider：单 topic 发现多个实例

MQTT **只做控制面**：一个固定 topic，所有工作区往上发元数据
（当前 `*.cnb.run`、`PROXY_KEY`、实例 id）。插件订这一条，在本地
攒一份在线表。chat / SSE / 模型 / 用量仍 HTTPS 直连各实例自己的域名，
不进 Broker。

这就是 `cnb-register.py` 的多实例版：不再按实例拆 topic，也不再
每个工作区登录一次 Magpie。

---

## 1. 为什么是一条 topic

按实例派生 topic（`HMAC(psk, instanceId)`）会逼用户「登录 N 次、
事先知道每个 instanceId」。你要的是反过来：

- 插件启动后 **只订一个事先约定的 topic**
- 工作区开机自己上来报到
- 谁在线、现在的域名和 Key 是什么，都从这条流里长出来

```
                    MQTT  事先约定的那一条 topic
                    （多实例往上发心跳）
         ┌──────────────────────────────────────────────┐
         │  {instanceId, uri, apiKey, ts}  加密          │
         │                                              │
    Magpie 插件  ──订这一条──▶  内存表 A / B / C
         │
         │  HTTPS  选一个活着的实例
         ▼
    https://<sub-A>-9001.cnb.run     https://<sub-B>-9001.cnb.run
```

| 通道 | 承载 |
|---|---|
| MQTT × 1 topic | 实例 id、动态域名、API Key、up/down、时间戳 |
| HTTPS | chat、SSE、`/v1/models`、`/usage` |

---

## 2. 事先约定的三样（舰队契约）

Magpie 和所有实例**启动前就必须一致**，缺一不可。运行时不再协商。

| # | 约定 | 例子 | 谁填 |
|---|---|---|---|
| 1 | **MQTT 连接方式** | 默认 `wss://broker.emqx.io:8084/mqtt`（EMQX 公共），可改成自己的；可选用户名/密码 | 插件登录可留空；工作区可省略 `MQTT_BROKER` |
| 2 | **MQTT Topic** | `cnb2api/my-fleet/presence`（整支舰队同一条，自己起名） | 插件登录 + 工作区 `MQTT_TOPIC` |
| 3 | **对称密钥** | 长随机串，AES-256-GCM 加密心跳明文 | 插件登录（password）+ 工作区 `MQTT_PSK` |

这三样是唯一的预共享秘密。**不预共享、也不从密钥派生 topic。**
动态域名、`PROXY_KEY`、`instanceId` 都是实例上线后从加密心跳里长出来的。

插件登录三次提问，`authorize` 用这三样连上并订 topic；几秒内解开一条
URI 合法的心跳即成功。`accountId` 用 `sha256(broker + topic)` 短哈希，
同一契约重登覆盖同一账号。

工作区：

```
MQTT_BROKER=wss://broker.example.com/mqtt
MQTT_TOPIC=cnb2api/my-fleet/presence
MQTT_PSK=…
MQTT_INSTANCE_ID=ws-home    # 仅舰队内区分实例，插件事先不用知道
```

---

## 3. 为什么不能 retained

MQTT retained **按 topic 只留最后一条**。多实例共用一条 topic 时，
后上线的会盖掉先上线的，插件重启只能看到一个人。

所以：**不设 retained**。每个实例周期性 publish（建议 15–30s），
插件按 `instanceId` 做表，超过 2–3 个心跳没来的视为下线。

```
instances: Map<instanceId, { uri, apiKey, bootId, lastSeen, status }>
```

进程退出可再发一条 `{ status: "down", instanceId }`，没有也没关系，
靠 TTL 收尸。

---

## 4. 元数据（明文，发出前加密）

```json
{
  "v": 1,
  "instanceId": "ws-home",
  "status": "up",
  "uri": "https://abcd1234-9001.cnb.run",
  "apiKey": "<PROXY_KEY>",
  "bootId": "…",
  "ts": 1730000000
}
```

- `uri`：现有 `CNB_VSCODE_PROXY_URI`，正则仍与 `cnb-register.py` 相同，
  不匹配整条丢弃（防伪造把流量拐走）。
- `apiKey`：工作区自己的 `PROXY_KEY`。插件登录不再问 Key，
  HTTP 请求头用报文里这份。
- `instanceId`：工作区自己起的名字，表的主键；重复则视为同一实例刷新。

加密：`HKDF-SHA256(psk, salt="cnb2api-mqtt-v1", info=topic)` →
AES-256-GCM。AAD 绑约定 topic。`|now-ts| > 120s` 丢弃。
密钥只加密 MQTT 内容，不参与 HTTPS。

同一契约下的实例能互相解密——共用 topic + 共用密钥的代价。
Broker 运营方看不到域名和 Key。Topic 本身在共用 Broker 上可见，
所以不要用别人一眼能猜到的名字，但**安全不靠 topic 保密，靠密钥**。

---

## 5. 插件怎么用这张表

一次登录 = 一个 Magpie 账号 = 一支舰队。发现到的实例是账号内部状态，
**不要**给每个实例再 `client.auth.set` 成独立账号（Magpie 账号是登录时
创建的，MQTT 上后出现的实例对不上）。

`loader.fetch`：

1. 从表里挑一个 `status=up` 且未过期的实例（先最近成功的，再最新鲜的）
2. `fetch(${uri}${path}, { Authorization: Bearer ${apiKey}, ... })`
3. 连不上 / 5xx → 标坏，换下一个；都失败再把 502/504 交回 Magpie

`provider.models`：问一个活实例的 `/v1/models`，失败退回 `config` 默认列表。
`auth.usage`：问一个活实例的 `/usage`（第一期不跨实例加总）。

连接：插件进程里 **一条** MQTT 连接、 **一个** 订阅，按 `instanceId` 拆表。
不要按实例建连接。

---

## 6. 和旧中继的关系

| | nginx + `cnb-register.py` | 本插件 |
|---|---|---|
| 控制面 | 每中继一个 URI，POST `/ops/register` | 一条 topic，多实例心跳 |
| 数据面 | HTTPS → 固定域名 → 当前子域名 | HTTPS → 插件刚学到的子域名 |
| 凭证 | 客户端自己配 `PROXY_KEY` | Key 跟 URI 一起从心跳来 |

两套可以同时开。不配 `MQTT_*` 的工作区行为与现在完全一样。

---

## 7. 安全

| 威胁 | 对策 |
|---|---|
| Broker 读对话 | 对话不进 MQTT |
| Broker 读到域名 / API Key | 整包 AES-GCM |
| 他人订到同一 topic | 解不开密文（没有第 3 项密钥） |
| 伪造 URI / 换 Key | 解不开或 URI 正则失败则丢 |
| 重放已回收的旧 URI | ts 窗口；HTTPS 失败换实例 |
| 三样契约泄漏 | 等于加入舰队，换 topic 或换密钥 |

`CNB_TOKEN` 仍然不出工作区。

---

## 8. 落地顺序

1. 工作区：心跳 publish `{instanceId, uri, apiKey}` 到舰队 topic
2. 插件：单订阅、内存表、TTL、HTTPS `fetch` 选实例
3. 多实例同时在线时的选路 / 失败换人
4. 文档：三样契约怎么发给工作区和 Magpie；`MQTT_INSTANCE_ID` 不要撞名

不在范围：每实例一条 topic、SSE over MQTT、删掉 nginx 中继。
