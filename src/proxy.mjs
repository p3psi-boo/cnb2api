// 上游转发：超时 + 双向取消（客户端断开 → abort 上游，停止空读烧额度）
import { config } from './config.mjs';
import { log } from './log.mjs';
import { aggregate } from './sse.mjs';
import { record as recordUsage } from './usage.mjs';
import { observe as observeModel } from './models.mjs';

const REASONING_TRIGGERS = ['reasoning_effort', 'reasoning', 'enable_thinking', 'thinking'];

function stripReasoningTriggers(payload) {
  if (!REASONING_TRIGGERS.some((k) => k in payload)) return payload;
  const out = { ...payload };
  for (const k of REASONING_TRIGGERS) delete out[k];
  return out;
}

export async function forward({ reqId, payload, wantStream, res }) {
  const started = Date.now();
  const ac = new AbortController();
  const abortUpstream = () => ac.abort();
  res.on('close', () => { if (!res.writableEnded) abortUpstream(); });

  const timer = setTimeout(abortUpstream, config.upstreamTimeoutMs);
  let up;
  try {
    up = await fetch(config.upstreamUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.upstreamToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stripReasoningTriggers(payload), stream: true }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return { handled: true, status: null };
    recordUsage({ errors: 1 });
    if (ac.signal.aborted) {
      log.warn(reqId, 'upstream connect timeout', { ms: config.upstreamTimeoutMs });
      return { handled: false, status: 504, body: { error: { message: 'upstream connect timeout' } } };
    }
    log.error(reqId, 'upstream fetch failed', { err: String(e).slice(0, 200) });
    return { handled: false, status: 502, body: { error: { message: 'upstream connect failed' } } };
  }
  clearTimeout(timer);

  if (!up.ok) {
    const t = await up.text().catch(() => '');
    log.warn(reqId, 'upstream error', { status: up.status, preview: t.slice(0, 200) });
    recordUsage({ errors: 1 });
    return { handled: false, status: up.status, body: safeJsonOrText(t) };
  }

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let idle;
    let sseTail = '';
    let usage = null;
    let ok = false;
    let clientGone = false;
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { return; }
      if (j.usage) usage = j.usage;
      if (j.model) observeModel(j.model);
    };
    const decodeAndParse = (value) => {
      const text = sseTail + (value === null ? dec.decode() : dec.decode(value, { stream: true }));
      const lines = text.split('\n');
      sseTail = lines.pop() ?? '';
      for (const line of (value === null ? [...lines, sseTail] : lines)) handleLine(line);
      if (value === null) sseTail = '';
    };
    const readChunk = () => new Promise((resolve, reject) => {
      idle = setTimeout(() => reject(new Error('stream idle timeout')), config.idleTimeoutMs);
      reader.read().then(
        (r) => { clearTimeout(idle); resolve(r); },
        (e) => { clearTimeout(idle); reject(e); },
      );
    });
    try {
      for (;;) {
        if (res.destroyed || ac.signal.aborted) { clientGone = true; await reader.cancel().catch(() => {}); break; }
        const { done, value } = await readChunk();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        }
        decodeAndParse(value);
      }
      decodeAndParse(null);
      if (!res.destroyed) res.end();
      ok = true;
    } catch (e) {
      clearTimeout(idle);
      await reader.cancel().catch(() => {});
      ac.abort();
      if (res.destroyed || res.writableEnded) clientGone = true;
      if (!res.destroyed) res.end();
      log.warn(reqId, 'stream aborted', { err: String(e).slice(0, 120) });
    } finally {
      clearTimeout(idle);
    }
    recordUsage({
      prompt: usage?.prompt_tokens || 0,
      completion: usage?.completion_tokens || 0,
      errors: ok || clientGone ? 0 : 1,
    });
    log.info(reqId, 'stream done', { ms: Date.now() - started, usage: usage ? 'exact' : 'none' });
    return { handled: true, status: 200 };
  }

  const idleTimer = setTimeout(abortUpstream, config.idleTimeoutMs);
  let text = '';
  try {
    text = await up.text();
  } catch {
    clearTimeout(idleTimer);
    if (!(res.writableEnded || res.destroyed)) recordUsage({ errors: 1 });
    return { handled: false, status: 504, body: { error: { message: 'upstream stream timeout' } } };
  }
  clearTimeout(idleTimer);
  const body = aggregate(text);
  if (body.model) observeModel(body.model);
  recordUsage({ prompt: body.usage.prompt_tokens || 0, completion: body.usage.completion_tokens || 0 });
  log.info(reqId, 'chat done', { ms: Date.now() - started, out: body.usage.completion_tokens });
  return { handled: false, status: 200, body };
}

function safeJsonOrText(t) {
  try { return JSON.parse(t); } catch { return { error: { message: t.slice(0, 500) || 'upstream error' } }; }
}
