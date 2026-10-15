import { randomBytes } from 'node:crypto';
import { connectMqtt, payloadText } from './client.mjs';
import { decodePresence } from './presence.mjs';
import { createFleet } from './fleet.mjs';

export async function subscribeFleet({
  brokerUrl,
  topic,
  psk,
  username,
  password,
  allowLocalUri = false,
  connect = connectMqtt,
  onLog,
}) {
  const fleet = createFleet();
  const clientId = `cnb2api-p-${randomBytes(4).toString('hex')}`;
  const client = await connect(brokerUrl, { clientId, username, password });

  client.on('message', (_topic, payload) => {
    const decoded = decodePresence(payloadText(payload), psk, topic, { allowLocal: allowLocalUri });
    if (!decoded.ok) {
      onLog?.(`drop presence: ${decoded.error}`);
      return;
    }
    fleet.apply(decoded.message);
  });

  if (typeof client.subscribeAsync === 'function') {
    await client.subscribeAsync(topic, { qos: 1 });
  } else {
    await new Promise((resolve, reject) => {
      client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  const waitForInstance = (timeoutMs = 8000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const inst = fleet.pick();
      if (inst) return resolve(inst);
      if (Date.now() - t0 >= timeoutMs) return reject(new Error('no instance advertised on this topic yet'));
      setTimeout(tick, 150);
    };
    tick();
  });

  const stop = async () => {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 800);
      client.end(false, {}, () => { clearTimeout(t); resolve(); });
    });
  };

  return { fleet, client, waitForInstance, stop };
}
