// Public EMQX broker (https://www.emqx.com/en/mqtt/public-mqtt5-broker).
// Editable everywhere: leave the field empty or omit MQTT_BROKER to use this.
export const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';

export function resolveBroker(url) {
  const s = String(url || '').trim();
  return s || DEFAULT_BROKER;
}
