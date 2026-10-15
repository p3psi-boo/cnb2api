import { subscribeFleet } from './mqtt/subscribe.mjs';
import { fleetAccountId, rewriteToInstance, withInstanceAuth } from './mqtt/fleet.mjs';

const PROVIDER = 'cnb2api';
const FALLBACK_MODELS = {
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', limit: { context: 128000, output: 8192 }, tool_call: true },
  'glm-5.3-flash': { name: 'GLM 5.3 Flash', limit: { context: 128000, output: 8192 }, tool_call: true },
  'kimi-k3': { name: 'Kimi K3', limit: { context: 128000, output: 8192 }, tool_call: true },
};

const sessions = new Map();

function contractOf(auth) {
  const broker = auth?.metadata?.broker || '';
  const topic = auth?.metadata?.topic || '';
  const psk = auth?.key || '';
  return { broker, topic, psk, username: auth?.metadata?.username || '', password: auth?.metadata?.password || '' };
}

function sessionKey(auth) {
  const c = contractOf(auth);
  return `${c.broker}\n${c.topic}\n${c.psk}`;
}

async function sessionFor(auth, { allowLocalUri = false } = {}) {
  const key = sessionKey(auth);
  if (sessions.has(key)) return sessions.get(key);
  const c = contractOf(auth);
  if (!c.broker || !c.topic || !c.psk) throw new Error('MQTT broker, topic and key are required');
  const pending = subscribeFleet({
    brokerUrl: c.broker,
    topic: c.topic,
    psk: c.psk,
    username: c.username,
    password: c.password,
    allowLocalUri,
  }).then((sub) => {
    sessions.set(key, sub);
    return sub;
  }).catch((err) => {
    sessions.delete(key);
    throw err;
  });
  sessions.set(key, pending);
  return pending;
}

function noInstanceResponse() {
  return new Response(JSON.stringify({ error: { message: 'no live cnb2api instance on this topic', type: 'api_error' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

async function fetchViaFleet(input, init, fleet) {
  const tried = new Set();
  for (;;) {
    const inst = fleet.pick();
    if (!inst || tried.has(inst.instanceId)) return noInstanceResponse();
    tried.add(inst.instanceId);
    const url = rewriteToInstance(input, inst.uri);
    try {
      const res = await fetch(url, withInstanceAuth(init, inst.apiKey));
      if (res.status >= 500 || res.status === 404) {
        fleet.markBad(inst.instanceId);
        continue;
      }
      fleet.remember(inst.instanceId);
      return res;
    } catch {
      fleet.markBad(inst.instanceId);
    }
  }
}

export async function createCnb2apiPlugin(_input, options) {
  const allowLocalUri = options?.allowLocalUri === true || process.env.MQTT_ALLOW_LOCAL_URI === '1';

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: 'CNB2API',
        npm: '@ai-sdk/openai-compatible',
        models: { ...FALLBACK_MODELS },
      };
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 2,
      methods: [{
        type: 'api',
        label: 'MQTT encryption key',
        placeholder: 'fleet PSK',
        prompts: [
          { type: 'text', key: 'broker', message: 'MQTT broker URL', placeholder: 'wss://broker.example.com/mqtt' },
          { type: 'text', key: 'topic', message: 'MQTT topic', placeholder: 'cnb2api/my-fleet/presence' },
        ],
        async authorize(inputs = {}) {
          const psk = String(inputs.psk || inputs.key || inputs.apiKey || '').trim();
          const broker = String(inputs.broker || '').trim();
          const topic = String(inputs.topic || '').trim();
          if (!broker || !topic || !psk) {
            return { type: 'failed', error: 'broker URL, topic and encryption key are all required' };
          }
          try {
            const sub = await subscribeFleet({ brokerUrl: broker, topic, psk, allowLocalUri });
            try {
              await sub.waitForInstance(3000).catch(() => {});
            } finally {
              await sub.stop();
            }
          } catch (e) {
            return { type: 'failed', error: String(e.message || e).slice(0, 500) };
          }
          return {
            type: 'success',
            key: psk,
            metadata: { broker, topic },
            accountId: fleetAccountId(broker, topic),
          };
        },
      }],

      async loader(getAuth) {
        return {
          baseURL: 'https://cnb2api.invalid/v1',
          async fetch(input, init) {
            const auth = await getAuth();
            const sub = await sessionFor(auth, { allowLocalUri });
            return fetchViaFleet(input, init, sub.fleet);
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        let sub;
        try { sub = await sessionFor(auth, { allowLocalUri }); } catch (e) {
          return { error: String(e.message || e), windows: [] };
        }
        const inst = sub.fleet.pick();
        if (!inst) return { error: 'no live instance', windows: [] };
        try {
          const res = await fetch(`${inst.uri}/usage`, { headers: { authorization: `Bearer ${inst.apiKey}` } });
          if (!res.ok) return { error: `instance answered ${res.status}`, windows: [] };
          const snap = await res.json();
          const prompt = Number(snap?.totals?.prompt) || 0;
          const completion = Number(snap?.totals?.completion) || 0;
          return {
            user: inst.instanceId,
            windows: [{
              name: 'this boot',
              display: `${prompt + completion} tokens · ${snap?.totals?.requests ?? 0} req`,
              used: 0,
              aside: true,
            }],
          };
        } catch (e) {
          return { error: String(e.message || e).slice(0, 200), windows: [] };
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth?.key) return provider.models;
        try {
          const sub = await sessionFor(auth, { allowLocalUri });
          const inst = sub.fleet.pick();
          if (!inst) return provider.models;
          const res = await fetch(`${inst.uri}/v1/models`, { headers: { authorization: `Bearer ${inst.apiKey}` } });
          if (!res.ok) return provider.models;
          const body = await res.json();
          const data = Array.isArray(body?.data) ? body.data : [];
          if (!data.length) return provider.models;
          const base = Object.values(provider.models)[0] || FALLBACK_MODELS['deepseek-v4.1-flash'];
          return Object.fromEntries(data.map((m) => {
            const id = m.id || m;
            return [id, { ...base, id, name: m.name || id }];
          }));
        } catch {
          return provider.models;
        }
      },
    },
  };
}

export { fetchViaFleet, noInstanceResponse };

export const _internal = {
  PROVIDER,
  FALLBACK_MODELS,
  contractOf,
  sessionKey,
  fetchViaFleet,
  noInstanceResponse,
  sessions,
};
