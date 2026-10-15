import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const SALT = 'cnb2api-mqtt-v1';

export function deriveKey(psk, topic) {
  if (!psk) throw new Error('psk is required');
  if (!topic) throw new Error('topic is required');
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(psk), 'utf8'), SALT, String(topic), 32));
}

export function seal(plaintext, psk, topic) {
  const key = deriveKey(psk, topic);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(String(topic), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  });
}

export function open(envelope, psk, topic) {
  let parsed = envelope;
  if (typeof envelope === 'string') {
    try { parsed = JSON.parse(envelope); } catch { throw new Error('envelope is not JSON'); }
  }
  if (!parsed || parsed.v !== 1 || !parsed.nonce || !parsed.ct || !parsed.tag) {
    throw new Error('envelope missing fields');
  }
  const key = deriveKey(psk, topic);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.nonce, 'base64'));
  decipher.setAAD(Buffer.from(String(topic), 'utf8'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]).toString('utf8');
}
