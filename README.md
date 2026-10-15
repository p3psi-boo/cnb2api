# cnb2api（Magpie 插件）

把 CNB 工作区内网 AI 做成 [Magpie](https://usemagpie.ai/docs/zh/plugins) 供应商。

MQTT **只传控制面**：动态 `*.cnb.run` 域名和实例自己的 `PROXY_KEY`。
对话、SSE、模型列表仍走 HTTPS，不进 Broker。

事先只共享三样：

1. MQTT 连接方式（Broker URL，可选用户名/密码）
2. MQTT Topic（整支舰队同一条）
3. 对称密钥（AES-256-GCM，加密心跳）

```
magpie plugin add .
magpie plugin login cnb2api
# 填 broker / topic / 密钥，与工作区 MQTT_* 一致
```

多个工作区往同一条 topic 发心跳，插件选一个活着的实例去打 `/v1/chat/completions`。

## 工作区

在 CNB 私有仓库里设：

```
PROXY_KEY          实例 HTTP 鉴权（会随心跳发给插件）
MQTT_BROKER        例如 mqtt://broker.example.com:1883 或 wss://…
MQTT_TOPIC         例如 cnb2api/my-fleet/presence
MQTT_PSK           长随机串
MQTT_INSTANCE_ID   舰队内唯一，如 ws-home
```

`deploy/start.sh` 拉起 `src/server.mjs`。进程在 `/health` 就绪后按约 20s 往 topic 发加密 presence（不使用 MQTT retained）。

本机：

```
cp .env.example .env
npm install
npm start
npm test
```

## 只接 Magpie 时去掉了什么

| 去掉 | 原因 |
|---|---|
| `cnb-register.py` + nginx 固定域名 | 插件自己记住当前 URI |
| `cnb-watchdog.sh` | 盯的是固定域名 |
| `/v1/messages` Anthropic 适配 | Magpie 会先转成 chat completions |
| `REGISTER_URL` / `REG_TOKEN` | 改成 MQTT 三件套 |

还在的：HTTP 反代、鉴权、SSE、模型嗅探、`/usage`、额度 CLI、cron 拉起工作区。

设计背景见 [docs/MQTT-MAGPIE-PLAN.md](docs/MQTT-MAGPIE-PLAN.md)。
