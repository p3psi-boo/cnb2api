import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { seal, open } from '../src/mqtt/crypto.mjs';
import { encodePresence, decodePresence, validUri } from '../src/mqtt/presence.mjs';
import { createFleet, rewriteToInstance, withInstanceAuth, fleetAccountId } from '../src/mqtt/fleet.mjs';
import { startAdvertise } from '../src/mqtt/advertise.mjs';
import { subscribeFleet } from '../src/mqtt/subscribe.mjs';
import { fetchViaFleet } from '../src/plugin-hooks.mjs';
import { DEFAULT_BROKER, resolveBroker } from '../src/mqtt/defaults.mjs';

test('resolveBroker defaults to public EMQX and keeps edits', () => {
  assert.equal(resolveBroker(''), DEFAULT_BROKER);
  assert.equal(resolveBroker('   '), DEFAULT_BROKER);
  assert.equal(resolveBroker(undefined), DEFAULT_BROKER);
  assert.equal(DEFAULT_BROKER, 'wss://broker.emqx.io:8084/mqtt');
  assert.equal(resolveBroker('wss://mine.example/mqtt'), 'wss://mine.example/mqtt');
});

test('crypto roundtrip binds ciphertext to topic', () => {
  const env = seal('hello', 'psk', 'fleet/a');
  assert.equal(open(env, 'psk', 'fleet/a'), 'hello');
  assert.throws(() => open(env, 'wrong', 'fleet/a'));
  assert.throws(() => open(env, 'psk', 'fleet/other'));
});

test('validUri accepts CNB port-proxy and optional localhost', () => {
  assert.equal(validUri('https://abcd1234-9001.cnb.run'), true);
  assert.equal(validUri('https://evil.example/steal'), false);
  assert.equal(validUri('http://127.0.0.1:19111'), false);
  assert.equal(validUri('http://127.0.0.1:19111', { allowLocal: true }), true);
});

test('presence encode/decode + stale + bad uri', () => {
  const raw = encodePresence({
    instanceId: 'ws-1',
    uri: 'https://abcd1234-9001.cnb.run',
    apiKey: 'sk-test',
    bootId: 'b1',
    ts: Math.floor(Date.now() / 1000),
  }, 'psk', 't');
  const ok = decodePresence(raw, 'psk', 't');
  assert.equal(ok.ok, true);
  assert.equal(ok.message.apiKey, 'sk-test');

  const stale = encodePresence({
    instanceId: 'ws-1',
    uri: 'https://abcd1234-9001.cnb.run',
    apiKey: 'sk-test',
    ts: Math.floor(Date.now() / 1000) - 400,
  }, 'psk', 't');
  assert.equal(decodePresence(stale, 'psk', 't').ok, false);

  const bad = encodePresence({
    instanceId: 'ws-1',
    uri: 'https://evil.example',
    apiKey: 'sk-test',
    ts: Math.floor(Date.now() / 1000),
  }, 'psk', 't');
  assert.equal(decodePresence(bad, 'psk', 't').ok, false);
});

test('fleet table upsert, ttl, pick, markBad', () => {
  let now = 1_000_000;
  const fleet = createFleet({ ttlMs: 1_000, now: () => now });
  fleet.apply({ instanceId: 'a', status: 'up', uri: 'https://a-9001.cnb.run', apiKey: 'ka' });
  fleet.apply({ instanceId: 'b', status: 'up', uri: 'https://b-9001.cnb.run/', apiKey: 'kb' });
  assert.equal(fleet.size(), 2);
  assert.equal(fleet.pick().instanceId, 'a');
  fleet.markBad('a');
  assert.equal(fleet.pick().instanceId, 'b');
  fleet.apply({ instanceId: 'b', status: 'down' });
  assert.equal(fleet.pick(), null);
  fleet.apply({ instanceId: 'c', status: 'up', uri: 'https://c-9001.cnb.run', apiKey: 'kc' });
  now += 5_000;
  assert.equal(fleet.pick(), null);
});

test('rewriteToInstance keeps path from Magpie fetch URL', () => {
  assert.equal(
    rewriteToInstance('https://cnb2api.invalid/v1/chat/completions', 'https://abcd-9001.cnb.run'),
    'https://abcd-9001.cnb.run/v1/chat/completions',
  );
});

test('fleetAccountId is stable for the same broker+topic', () => {
  assert.equal(fleetAccountId('wss://b', 't1'), fleetAccountId('wss://b', 't1'));
  assert.notEqual(fleetAccountId('wss://b', 't1'), fleetAccountId('wss://b', 't2'));
});

function memoryBroker() {
  const subs = new Set();
  const connect = async () => {
    const client = {
      _handler: null,
      on(ev, fn) { if (ev === 'message') client._handler = fn; },
      publish(topic, payload) {
        for (const c of subs) c._handler?.(topic, Buffer.from(String(payload)));
      },
      async subscribeAsync() { subs.add(client); },
      end(_force, _opts, cb) { subs.delete(client); cb?.(); },
    };
    return client;
  };
  return { connect };
}

test('advertise + subscribe over an in-memory broker', async () => {
  const { connect } = memoryBroker();
  const topic = 'cnb2api/test/presence';
  const psk = 'fleet-psk';
  const sub = await subscribeFleet({
    brokerUrl: 'memory://',
    topic,
    psk,
    allowLocalUri: true,
    connect,
  });
  const adv = await startAdvertise({
    brokerUrl: 'memory://',
    topic,
    psk,
    instanceId: 'ws-local',
    uri: 'http://127.0.0.1:19111',
    apiKey: 'sk-from-instance',
    intervalMs: 60_000,
    allowLocalUri: true,
    connect,
  });
  const inst = await sub.waitForInstance(2000);
  assert.equal(inst.instanceId, 'ws-local');
  assert.equal(inst.apiKey, 'sk-from-instance');
  await adv.stop();
  await sub.stop();
});

test('fetchViaFleet uses instance URI + API key and fails over', async () => {
  const hits = [];
  const dead = http.createServer((_req, res) => { res.writeHead(500); res.end('no'); });
  const live = http.createServer((req, res) => {
    hits.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => dead.listen(0, r));
  await new Promise((r) => live.listen(0, r));
  const deadPort = dead.address().port;
  const livePort = live.address().port;

  const fleet = createFleet();
  fleet.apply({ instanceId: 'dead', status: 'up', uri: `http://127.0.0.1:${deadPort}`, apiKey: 'k-dead' });
  fleet.apply({ instanceId: 'live', status: 'up', uri: `http://127.0.0.1:${livePort}`, apiKey: 'k-live' });

  const res = await fetchViaFleet('https://cnb2api.invalid/v1/models', { method: 'GET' }, fleet);
  assert.equal(res.status, 200);
  assert.deepEqual(hits, ['Bearer k-live']);
  assert.equal((await res.json()).ok, true);

  dead.close();
  live.close();
});

test('withInstanceAuth sets bearer', () => {
  const init = withInstanceAuth({ headers: { 'x-unused': '1' } }, 'abc');
  assert.equal(init.headers.get('authorization'), 'Bearer abc');
});
