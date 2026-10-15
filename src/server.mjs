// http server + Magpie-facing OpenAI routes + optional MQTT presence
import http from 'node:http';
import { config } from './config.mjs';
import { checkAuth } from './auth.mjs';
import { forward } from './proxy.mjs';
import { log, newReqId } from './log.mjs';
import { snapshot as usageSnapshot } from './usage.mjs';
import { list as listModels } from './models.mjs';
import { startAdvertise } from './mqtt/advertise.mjs';

function send(res, status, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  res.writeHead(status, headers);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      if (oversized) return;
      size += c.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        settle(reject, Object.assign(new Error('body too large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!oversized) { settle(resolve, Buffer.concat(chunks).toString('utf8')); } });
    const onGone = () => {
      if (settled || oversized || req.complete) return;
      settle(reject, Object.assign(new Error('client aborted mid-body'), { code: 'CLIENT_ABORTED' }));
    };
    req.on('error', onGone);
    req.on('close', onGone);
  });
}

function sendAuthFailure(res, auth, reqId, path) {
  log.warn(reqId, 'auth failed', { status: auth.status, path });
  const h = auth.retryAfterSec ? { 'Retry-After': String(auth.retryAfterSec) } : {};
  return send(res, auth.status, auth.body, h);
}

async function readJsonBody(req, res, reqId) {
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    if (e.code === 413) send(res, 413, { error: { message: 'request body exceeds limit', type: 'invalid_request_error' } });
    else if (e.code !== 'CLIENT_ABORTED') throw e;
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    send(res, 400, { error: { message: 'request body is not valid JSON', type: 'invalid_request_error' } });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    send(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return null;
  }
  return parsed;
}

async function handleChatCompletions(req, res, reqId) {
  const auth = checkAuth(req);
  if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);

  const parsed = await readJsonBody(req, res, reqId);
  if (parsed === null) return;

  const wantStream = parsed.stream === true;
  const out = await forward({ reqId, payload: parsed, wantStream, res });
  if (out.handled) return;
  return send(res, out.status, out.body);
}

const server = http.createServer(async (req, res) => {
  const reqId = newReqId();
  const started = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.url === '/health') {
      return send(res, 200, { status: 'ok', uptime_sec: Math.round(process.uptime()) });
    }

    if (req.url === '/usage') {
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);
      return send(res, 200, usageSnapshot());
    }

    if (req.url === '/v1/models' || req.url === '/models') {
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);
      return send(res, 200, { object: 'list', data: listModels().map((id) => ({ id, object: 'model', owned_by: 'cnb' })) });
    }

    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')) {
      await handleChatCompletions(req, res, reqId);
      return;
    }

    return send(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    log.error(reqId, 'handler crash', { err: String(e).slice(0, 300) });
    return send(res, 500, { error: { message: 'internal error' } });
  } finally {
    log.info(reqId, 'request', { method: req.method, path: req.url, ms: Date.now() - started });
  }
});

let advertiser = null;

server.listen(config.port, '0.0.0.0', () => {
  log.info('-', 'listening', { port: config.port, upstream: config.upstreamUrl, models: config.models });
  if (config.mqttBroker && config.mqttTopic && config.mqttPsk) {
    startAdvertise({
      brokerUrl: config.mqttBroker,
      topic: config.mqttTopic,
      psk: config.mqttPsk,
      username: config.mqttUser,
      password: config.mqttPass,
      instanceId: config.mqttInstanceId || `ws-${process.pid.toString(36)}`,
      uri: config.mqttAdvertiseUri,
      apiKey: config.proxyKey,
      intervalMs: config.mqttHeartbeatMs,
      allowLocalUri: config.mqttAllowLocalUri,
    }).then((handle) => {
      advertiser = handle;
      log.info('-', 'mqtt advertise started', { topic: config.mqttTopic, instanceId: config.mqttInstanceId || `ws-${process.pid.toString(36)}` });
    }).catch((e) => {
      log.error('-', 'mqtt advertise failed', { err: String(e).slice(0, 240) });
    });
  } else {
    log.info('-', 'mqtt advertise skipped', { reason: 'MQTT_TOPIC / MQTT_PSK not set (broker defaults to EMQX public)' });
  }
});

async function shutdown(sig) {
  log.info('-', `got ${sig}, closing`);
  try { await advertiser?.stop(); } catch { /* already gone */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { shutdown(sig); });
}
