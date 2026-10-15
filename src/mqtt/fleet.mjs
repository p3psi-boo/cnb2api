// In-memory table of live cnb2api instances learned from one MQTT topic.

export const DEFAULT_TTL_MS = 75_000;

export function createFleet({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const instances = new Map();
  let preferred = '';

  const prune = () => {
    const t = now();
    for (const [id, row] of instances) {
      if (t - row.lastSeen > ttlMs) instances.delete(id);
    }
    if (preferred && !instances.has(preferred)) preferred = '';
  };

  return {
    apply(message) {
      if (!message?.instanceId) return;
      if (message.status === 'down') {
        instances.delete(message.instanceId);
        if (preferred === message.instanceId) preferred = '';
        return;
      }
      instances.set(message.instanceId, {
        instanceId: message.instanceId,
        uri: message.uri.replace(/\/+$/, ''),
        apiKey: message.apiKey,
        bootId: message.bootId || '',
        lastSeen: now(),
      });
    },
    list() {
      prune();
      return [...instances.values()];
    },
    pick() {
      prune();
      if (preferred && instances.has(preferred)) return instances.get(preferred);
      const first = instances.values().next().value;
      if (first) preferred = first.instanceId;
      return first || null;
    },
    markBad(instanceId) {
      if (!instanceId) return;
      instances.delete(instanceId);
      if (preferred === instanceId) preferred = '';
    },
    remember(instanceId) {
      if (instanceId && instances.has(instanceId)) preferred = instanceId;
    },
    size() {
      prune();
      return instances.size;
    },
  };
}

export function rewriteToInstance(input, instanceUri) {
  const raw = typeof input === 'string' ? input : input?.url;
  const incoming = new URL(raw);
  const base = instanceUri.replace(/\/+$/, '');
  return `${base}${incoming.pathname}${incoming.search}`;
}

export function withInstanceAuth(init, apiKey) {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${apiKey}`);
  if (!headers.has('content-type') && init?.body) headers.set('content-type', 'application/json');
  return { ...init, headers };
}

export function fleetAccountId(broker, topic) {
  const src = `${String(broker || '').trim()}\n${String(topic || '').trim()}`;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `cnb2api-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
