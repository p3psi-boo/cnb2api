import { randomBytes } from 'node:crypto';
import { connectMqtt } from './client.mjs';
import { encodePresence, validUri } from './presence.mjs';
import { log } from '../log.mjs';

export async function startAdvertise({
  brokerUrl,
  topic,
  psk,
  username,
  password,
  instanceId,
  uri,
  apiKey,
  intervalMs = 20_000,
  allowLocalUri = false,
  connect = connectMqtt,
}) {
  if (!brokerUrl || !topic || !psk) throw new Error('MQTT_BROKER, MQTT_TOPIC and MQTT_PSK are required to advertise');
  if (!validUri(uri, { allowLocal: allowLocalUri })) {
    throw new Error(`MQTT advertise URI is missing or not a CNB port-proxy: ${uri || '(empty)'}`);
  }

  const bootId = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  const clientId = `cnb2api-a-${instanceId}-${randomBytes(3).toString('hex')}`;
  const client = await connect(brokerUrl, { clientId, username, password });

  const publish = (status) => {
    const packet = encodePresence({
      instanceId,
      status,
      uri,
      apiKey,
      bootId,
      ts: Math.floor(Date.now() / 1000),
    }, psk, topic);
    client.publish(topic, packet, { qos: 1, retain: false });
  };

  publish('up');
  const timer = setInterval(() => {
    try { publish('up'); } catch (e) {
      log.warn('-', 'mqtt heartbeat failed', { err: String(e).slice(0, 160) });
    }
  }, intervalMs);
  timer.unref?.();

  const stop = async () => {
    clearInterval(timer);
    try { publish('down'); } catch { /* closing */ }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 800);
      client.end(false, {}, () => { clearTimeout(t); resolve(); });
    });
  };

  return { stop, client, bootId };
}
