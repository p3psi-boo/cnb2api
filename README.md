# cnb2api Magpie 插件方案

把 [cnb2api](https://github.com/p3psi-boo/cnb2api-magpie) 在现有 HTTP
网关之外，再注册成 [Magpie](https://usemagpie.ai/docs/zh/plugins) provider。

MQTT **只替代** [`cnb-register.py`](https://github.com/dengyie/cnb2api/blob/main/docs/DEPLOY.md)
那一次动态域名登记。chat / SSE / 模型 / 用量仍直连
`https://<sub>-9001.cnb.run`，不进 Broker。

一个 Magpie 供应商可以登录多个工作区账号。

设计见 [docs/MQTT-MAGPIE-PLAN.md](docs/MQTT-MAGPIE-PLAN.md)。
