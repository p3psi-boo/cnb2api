// Central env loading + fail-fast validation.
// The proxy refuses to start with a missing/weak key instead of running exposed.
import { resolveBroker } from './mqtt/defaults.mjs';

export const config = {
  port: Number(process.env.PROXY_PORT || 9001),
  repo: process.env.CNB_REPO_SLUG || process.env.CNB_BUILD_REPO || '',
  proxyKey: process.env.PROXY_KEY || '',
  upstreamToken: process.env.CNB_TOKEN || '',
  models: (process.env.PROXY_MODELS || 'deepseek-v4.1-flash,glm-5.3-flash,kimi-k3').split(',').map((s) => s.trim()).filter(Boolean),
  modelsStatePath: process.env.PROXY_MODELS_STATE || 'models-state.json',
  maxBodyBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 15_000),
  idleTimeoutMs: Number(process.env.PROXY_IDLE_TIMEOUT_MS || 300_000),
  authFailWindowMs: 60_000,
  authFailMax: 10,
  upstreamUrl: '',
  mqttBroker: resolveBroker(process.env.MQTT_BROKER),
  mqttTopic: (process.env.MQTT_TOPIC || '').trim(),
  mqttPsk: process.env.MQTT_PSK || '',
  mqttUser: process.env.MQTT_USER || '',
  mqttPass: process.env.MQTT_PASS || '',
  mqttInstanceId: (process.env.MQTT_INSTANCE_ID || '').trim(),
  mqttAdvertiseUri: (process.env.MQTT_ADVERTISE_URI || process.env.CNB_VSCODE_PROXY_URI || '').trim(),
  mqttHeartbeatMs: Number(process.env.MQTT_HEARTBEAT_MS || 20_000),
  mqttAllowLocalUri: process.env.MQTT_ALLOW_LOCAL_URI === '1',
};

if (!config.upstreamUrl) {
  config.upstreamUrl = process.env.UPSTREAM_OVERRIDE
    || (config.repo ? `https://api.cnb.cool/${config.repo}/-/ai/chat/completions` : '');
}

if (!config.proxyKey) {
  console.error('[config] PROXY_KEY is required (env). Refusing to start with a default key.');
  process.exit(1);
}
if (!config.upstreamToken) {
  console.error('[config] CNB_TOKEN is required (env, injected by the pipeline stage). Refusing to start.');
  process.exit(1);
}
if (!config.upstreamUrl) {
  console.error('[config] upstream URL is empty: set CNB_REPO_SLUG (org/repo) or UPSTREAM_OVERRIDE. Refusing to start.');
  process.exit(1);
}
for (const [key, env] of [
  ['upstreamTimeoutMs', 'PROXY_UPSTREAM_TIMEOUT_MS'],
  ['idleTimeoutMs', 'PROXY_IDLE_TIMEOUT_MS'],
  ['mqttHeartbeatMs', 'MQTT_HEARTBEAT_MS'],
]) {
  if (!Number.isFinite(config[key]) || config[key] <= 0) {
    console.error(`[config] ${env} must be a positive number (ms), got "${process.env[env]}". Refusing to start.`);
    process.exit(1);
  }
}
