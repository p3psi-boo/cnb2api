# 接入 Magpie

## 1. 约定三样

```
MQTT_BROKER=wss://your-broker.example/mqtt
MQTT_TOPIC=cnb2api/my-fleet/presence
MQTT_PSK=$(openssl rand -hex 24)
```

Topic 自己起名，舰队里所有工作区和 Magpie 登录填同一串。
安全靠 PSK，不靠 topic 保密。

## 2. 工作区（`.cnb.yml`）

旧版的 `REGISTER_URL` / `REG_TOKEN` / `FIXED` 已经去掉。vscode 阶段改成：

```yaml
env:
  PROXY_KEY: "…"                 # 实例自己的 HTTP Key，会随心跳发给插件
  MQTT_BROKER: "wss://…/mqtt"    # 与 Magpie 登录第 1 项相同
  MQTT_TOPIC: "cnb2api/my-fleet/presence"
  MQTT_PSK: "…"                  # 与 Magpie 登录第 3 项相同
  MQTT_INSTANCE_ID: "ws-1"       # 仅工作区需要，舰队内别撞名
```

`CNB_VSCODE_PROXY_URI` 由平台注入，不用手写。keepalive cron 只负责
工作区停了就拉起，不再探固定域名、也不再 POST `/ops/register`。

私有 Fork 后替换占位符，启动云开发。日志里应有
`MQTT advertise enabled` 和 `PROXY_URI=https://…cnb.run`。

## 3. Magpie

```
magpie plugin add github:owner/this-repo
magpie plugin login cnb2api
```

登录问：Broker URL、Topic、encryption key（即 PSK）。
连得上 Broker 即成功；工作区稍后上线，插件会从心跳里长出实例。

模型形如 `cnb2api/deepseek-v4.1-flash`。再开一个工作区、换一个
`MQTT_INSTANCE_ID`、同一套三件套，插件会自动多一个可选实例。
