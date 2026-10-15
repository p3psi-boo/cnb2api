import { seal, open } from './crypto.mjs';

export const CNB_URI_RE = /^https:\/\/([a-z0-9]+)-(?:\{\{port\}\}|[0-9]+)\.cnb\.run$/;
export const LOCAL_URI_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
export const STALE_MS = 120_000;

export function validUri(uri, { allowLocal = false } = {}) {
  if (typeof uri !== 'string' || !uri) return false;
  if (CNB_URI_RE.test(uri)) return true;
  return allowLocal && LOCAL_URI_RE.test(uri);
}

export function encodePresence(fields, psk, topic) {
  const body = {
    v: 1,
    instanceId: String(fields.instanceId || ''),
    status: fields.status === 'down' ? 'down' : 'up',
    uri: String(fields.uri || ''),
    apiKey: String(fields.apiKey || ''),
    bootId: String(fields.bootId || ''),
    ts: Number(fields.ts) || Math.floor(Date.now() / 1000),
  };
  return seal(JSON.stringify(body), psk, topic);
}

export function decodePresence(envelope, psk, topic, { nowMs = Date.now(), allowLocal = false } = {}) {
  const plain = open(envelope, psk, topic);
  let msg;
  try { msg = JSON.parse(plain); } catch { return { ok: false, error: 'payload is not JSON' }; }
  if (!msg || msg.v !== 1) return { ok: false, error: 'unsupported payload version' };
  if (!msg.instanceId || typeof msg.instanceId !== 'string') return { ok: false, error: 'missing instanceId' };
  const tsMs = Number(msg.ts) > 1e12 ? Number(msg.ts) : Number(msg.ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > STALE_MS) return { ok: false, error: 'stale or missing ts' };
  if (msg.status !== 'down' && !validUri(msg.uri, { allowLocal })) return { ok: false, error: 'uri not a CNB port-proxy' };
  if (msg.status !== 'down' && !msg.apiKey) return { ok: false, error: 'missing apiKey' };
  return {
    ok: true,
    message: {
      instanceId: msg.instanceId,
      status: msg.status === 'down' ? 'down' : 'up',
      uri: String(msg.uri || ''),
      apiKey: String(msg.apiKey || ''),
      bootId: String(msg.bootId || ''),
      ts: tsMs,
    },
  };
}
