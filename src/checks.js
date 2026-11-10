// Testes de aplicação: HTTP, TCP, recurso Kubernetes e comando.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { run } from './exec.js';
import { tokenize, waitFor } from './util.js';
import { statusMatches } from './validate.js';

export const expandOrigin = (s, origin) => String(s ?? '').replaceAll('{{origin}}', origin);

function friendlyNetError(err) {
  const code = err.code;
  if (code === 'ECONNREFUSED') return 'conexão recusada';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS não resolveu o host';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'tempo esgotado';
  if (code === 'ECONNRESET') return 'conexão encerrada pelo servidor';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host inacessível';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(String(code))) return `certificado TLS inválido (${code}) — marque "Ignorar TLS" se for autoassinado`;
  return err.message || String(code || 'erro');
}

/** Requisição HTTP(S) simples com tempo total limitado e medição de latência. */
export function httpProbe(urlStr, { method = 'GET', timeoutMs = 5000, insecure = false, wantBody = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error('URL inválida'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const req = lib.request(
      u,
      {
        method,
        agent: false,
        rejectUnauthorized: !insecure,
        headers: { 'user-agent': 'eks-dr-console/1.0', accept: '*/*', connection: 'close' },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (wantBody && size < 256 * 1024) {
            chunks.push(c);
            size += c.length;
          }
        });
        res.on('end', () => finish(resolve, { status: res.statusCode, ms: performance.now() - t0, body: wantBody ? Buffer.concat(chunks).toString('utf8') : '' }));
        res.on('error', (e) => finish(reject, e));
        if (!wantBody) res.resume();
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' })), timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error('cancelado'), { code: 'ABORT' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const sock = net.connect({ host: host.replace(/^\[|\]$/g, ''), port });
    const timer = setTimeout(() => sock.destroy(Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' })), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(performance.now() - t0);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function k8sProbe(check, ctx) {
  if (ctx.provider?.k8sCheck) return ctx.provider.k8sCheck(check);
  const base = await ctx.provider?.kube?.();
  if (!base) return { ok: false, detail: 'sem acesso ao cluster via kubectl (configure o kubeconfig do ambiente)' };
  const r = await run('kubectl', [...base.args, '--request-timeout=10s', 'get', check.kind, check.resource, '-n', check.namespace, '-o', 'json'], {
    env: base.env,
    timeoutMs: 20_000,
    signal: ctx.signal,
  });
  if (r.code !== 0) return { ok: false, detail: r.stderr.trim().split('\n').pop()?.slice(0, 200) || `kubectl saiu com código ${r.code}` };
  const o = JSON.parse(r.stdout);
  if (check.kind === 'daemonset') {
    const want = o.status?.desiredNumberScheduled ?? 0;
    const ready = o.status?.numberReady ?? 0;
    return { ok: want > 0 && ready >= want, detail: `prontos ${ready}/${want}` };
  }
  const want = o.spec?.replicas ?? 0;
  const ready = o.status?.readyReplicas ?? 0;
  return { ok: want > 0 && ready >= want, detail: want === 0 ? 'escalado para 0 réplicas' : `prontas ${ready}/${want}` };
}

export async function runCheck(check, ctx) {
  const base = { id: check.id, name: check.name, type: check.type, critical: check.critical };
  const t0 = performance.now();
  try {
    if (check.type === 'http') {
      const url = expandOrigin(check.url, ctx.origin);
      const r = await httpProbe(url, { method: check.method, timeoutMs: check.timeoutMs, insecure: check.insecureTls, wantBody: Boolean(check.contains), signal: ctx.signal });
      let ok = statusMatches(check.expectStatus, r.status);
      let detail = `HTTP ${r.status} · ${Math.round(r.ms)} ms`;
      if (!ok) detail += ` (esperado ${check.expectStatus})`;
      if (ok && check.contains && !r.body.includes(check.contains)) {
        ok = false;
        detail += ` · corpo não contém "${check.contains}"`;
      }
      if (ok && check.maxLatencyMs > 0 && r.ms > check.maxLatencyMs) {
        ok = false;
        detail += ` · acima do limite de ${check.maxLatencyMs} ms`;
      }
      return { ...base, ok, ms: r.ms, detail };
    }
    if (check.type === 'tcp') {
      const ms = await tcpProbe(check.host, check.port, check.timeoutMs);
      return { ...base, ok: true, ms, detail: `conectou em ${Math.round(ms)} ms` };
    }
    if (check.type === 'k8s') {
      const r = await k8sProbe(check, ctx);
      return { ...base, ok: r.ok, ms: performance.now() - t0, detail: r.detail };
    }
    if (check.type === 'command') {
      const argv = tokenize(check.command);
      const r = await run(argv[0], argv.slice(1), { timeoutMs: check.timeoutSec * 1000, signal: ctx.signal });
      const out = (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200) ?? '';
      return { ...base, ok: r.code === 0, ms: r.ms, detail: r.code === 0 ? out || 'exit 0' : `exit ${r.code}${out ? ` · ${out}` : ''}` };
    }
    return { ...base, ok: false, ms: 0, detail: `tipo desconhecido: ${check.type}` };
  } catch (err) {
    if (err.name === 'AbortedError') throw err;
    return { ...base, ok: false, ms: performance.now() - t0, detail: friendlyNetError(err) };
  }
}

export function runChecks(env, ctx) {
  return Promise.all(env.checks.map((c) => runCheck(c, ctx)));
}

export const allCriticalOk = (results) => results.filter((r) => r.critical).every((r) => r.ok);

/** Aguarda todos os testes críticos passarem. Retorna os segundos decorridos. */
export async function waitHealthy(env, ctx, { timeoutMs, intervalMs = 3000 }) {
  const t0 = Date.now();
  await waitFor(async () => allCriticalOk(await runChecks(env, ctx)), { timeoutMs, intervalMs, signal: ctx.signal, label: 'aplicações saudáveis' });
  return (Date.now() - t0) / 1000;
}
