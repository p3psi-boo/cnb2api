# 接入 Magpie

## 1. 约定三样

```
MQTT_BROKER=wss://your-broker.example/mqtt
MQTT_TOPIC=cnb2api/my-fleet/presence
MQTT_PSK=$(openssl rand -hex 24)
```

Topic 自己起名，舰队里所有工作区和 Magpie 登录填同一串。
安全靠 PSK，不靠 topic 保密。

## 2. 工作区

私有 Fork 本仓，在 `.cnb.yml` 填 `PROXY_KEY` 和上面三样，再加
`MQTT_INSTANCE_ID`（每个工作区不同）。启动云开发。

构建日志出现 `MQTT advertise enabled` 和 `PROXY_URI=https://…cnb.run` 即可。

## 3. Magpie

```
magpie plugin add github:owner/this-repo
magpie plugin login cnb2api
```

登录问：Broker URL、Topic、encryption key（即 PSK）。
连得上 Broker 即成功；工作区稍后上线，插件会从心跳里长出实例。

模型形如 `cnb2api/deepseek-v4.1-flash`。再开一个工作区、换一个
`MQTT_INSTANCE_ID`、同一套三件套，插件会自动多一个可选实例。
