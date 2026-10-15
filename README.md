# cnb2api Magpie 插件方案

把 [cnb2api](https://github.com/p3psi-boo/cnb2api-magpie) 再注册成
[Magpie](https://usemagpie.ai/docs/zh/plugins) provider。

MQTT **只做控制面**：插件固定订一条由舰队 PSK 派生的 topic，
各工作区往同一条上发加密元数据（动态域名 + API Key）。
chat / SSE 仍直连 `https://<sub>-9001.cnb.run`。

设计见 [docs/MQTT-MAGPIE-PLAN.md](docs/MQTT-MAGPIE-PLAN.md)。
