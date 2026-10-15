# cnb2api Magpie 插件方案

这个仓库用来把 [cnb2api](https://github.com/p3psi-boo/cnb2api-magpie) 在现有
HTTP 网关之外，再注册成一个 [Magpie](https://usemagpie.ai/docs/zh/plugins) provider 插件。

插件用**共用 MQTT Broker + 每实例对称加密**，替代
[`cnb-register.py` 固定域名转发](https://github.com/dengyie/cnb2api/blob/main/docs/DEPLOY.md)，
并让一个 Magpie 供应商同时接入多个 cnb2api 工作区。

完整设计见 [docs/MQTT-MAGPIE-PLAN.md](docs/MQTT-MAGPIE-PLAN.md)。

当前还没有实现代码，先对照上游仓库把协议和插件钩子定下来。
