import mqtt from 'mqtt';

export function connectMqtt(brokerUrl, { clientId, username, password } = {}) {
  if (!brokerUrl) throw new Error('MQTT broker URL is required');
  const opts = {
    clientId,
    protocolVersion: 4,
    reconnectPeriod: 2000,
    connectTimeout: 12_000,
    clean: true,
  };
  if (username) opts.username = username;
  if (password) opts.password = password;
  return mqtt.connectAsync(brokerUrl, opts);
}

export function payloadText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return Buffer.from(payload).toString('utf8');
}
