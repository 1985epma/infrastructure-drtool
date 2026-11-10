// Montagem da aplicação: rotas da API, segurança e ciclo de vida do servidor.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './checks.js';
import * as discover from './discover.js';
import { runDrill, runPowerOperation } from './drill.js';
import { probeTool } from './exec.js';
import { JobManager } from './jobs.js';
import { createProvider } from './providers/index.js';
import { dropSim, getSim, simAppUp, simLastDurable } from './providers/sim.js';
import { readLastData, testCanary } from './rpo.js';
import { renderRunCsv, renderRunHtml, renderRunMarkdown, renderSummaryHtml } from './report.js';
import { Router, SECURITY_HEADERS, raw, readJsonBody, sendJson, sendRaw, serveStatic } from './http.js';
import { Store } from './store.js';
import { HttpError, UserError } from './util.js';
import { normalizeDrillParams, normalizeEnvironment } from './validate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopback = (host) => LOOPBACK.has(String(host).toLowerCase());

export async function createApp({ dataDir = join(ROOT, 'data'), host = '127.0.0.1', port = 3001, adminToken = '', allowedHosts = [], publicDir = join(ROOT, 'public') } = {}) {
  const store = new Store(resolve(dataDir));
  await store.init();
  const jobs = new JobManager();
  const hostAllow = new Set([...LOOPBACK, ...allowedHosts.map((h) => h.toLowerCase())]);
  const tokenBuf = adminToken ? Buffer.from(adminToken) : null;
  let actualPort = port;
  const origin = () => `http://127.0.0.1:${actualPort}`;

  // ---------- providers e status (cache curto) ----------
  const providers = new Map();
  const getProvider = (env) => {
    const key = `${env.id}:${env.updatedAt}`;
    if (!providers.has(key)) {
      for (const k of providers.keys()) if (k.startsWith(`${env.id}:`)) providers.delete(k);
      providers.set(key, createProvider(env, { store }));
    }
    return providers.get(key);
  };
  const statusCache = new Map();
  const getStatus = (env, force) => {
    const hit = statusCache.get(env.id);
    if (hit && !force && Date.now() - hit.at < 4000) return hit.promise;
    const promise = getProvider(env)
      .status({})
      .catch((err) => ({ state: 'error', note: err.message }));
    statusCache.set(env.id, { at: Date.now(), promise });
    return promise;
  };

  // ---------- ferramentas instaladas ----------
  let toolsPromise = null;
  const getTools = (refresh) => {
    if (!toolsPromise || refresh) {
      toolsPromise = Promise.all([probeTool('aws', ['--version']), probeTool('kubectl', ['version', '--client'])]).then(([aws, kubectl]) => ({ aws, kubectl }));
    }
    return toolsPromise;
  };

  const requireEnv = (id) => store.getEnvironment(id);
  const needConfirm = (env, body) => {
    if (env.provider === 'simulated') return;
    if (body?.confirm !== env.name) throw new HttpError(400, `Confirmação necessária: envie "confirm" com o nome exato do ambiente ("${env.name}").`);
  };

  // ---------- rotas ----------
  const r = new Router();

  r.get('/api/meta', async ({ query }) => ({
    version: PKG_VERSION,
    node: process.version,
    tools: await getTools(query.get('refresh') === '1'),
    authRequired: Boolean(tokenBuf),
    origin: origin(),
  }));

  r.get('/api/environments', () => store.listEnvironments());
  r.post('/api/environments', async ({ body }) => {
    const env = normalizeEnvironment(body);
    await store.saveEnvironment(env);
    return env;
  });
  r.get('/api/environments/:id', ({ params }) => requireEnv(params.id));
  r.put('/api/environments/:id', async ({ params, body }) => {
    const existing = await requireEnv(params.id);
    if (jobs.running && jobs.current.envId === existing.id) throw new HttpError(409, 'Há uma operação em andamento neste ambiente.');
    const env = normalizeEnvironment(body, { existing });
    await store.saveEnvironment(env);
    statusCache.delete(env.id);
    return env;
  });
  r.delete('/api/environments/:id', async ({ params }) => {
    const env = await requireEnv(params.id);
    if (jobs.running && jobs.current.envId === env.id) throw new HttpError(409, 'Há uma operação em andamento neste ambiente.');
    await store.deleteEnvironment(env.id);
    statusCache.delete(env.id);
    dropSim(env.id);
  });

  r.get('/api/environments/:id/status', async ({ params, query }) => {
    const env = await requireEnv(params.id);
    return { ...(await getStatus(env, query.get('force') === '1')), checkedAt: new Date().toISOString() };
  });

  const startJob = (kind, env, body) => {
    const provider = getProvider(env);
    const base = { env, provider, store, origin: origin() };
    if (kind === 'drill') {
      const params = normalizeDrillParams(body?.params, env);
      return jobs.start({ kind, env, title: `Exercício RTO/RPO — ${env.name}` }, (job, signal) => runDrill({ ...base, params }, job, signal));
    }
    return jobs.start({ kind, env, title: `${kind === 'stop' ? 'Desligar' : 'Ligar'} — ${env.name}` }, (job, signal) => runPowerOperation(kind, base, job, signal));
  };

  r.post('/api/environments/:id/start', async ({ params, body }) => {
    const env = await requireEnv(params.id);
    const job = startJob('start', env, body);
    statusCache.delete(env.id);
    return { jobId: job.id };
  });
  r.post('/api/environments/:id/stop', async ({ params, body }) => {
    const env = await requireEnv(params.id);
    needConfirm(env, body);
    const job = startJob('stop', env, body);
    statusCache.delete(env.id);
    return { jobId: job.id };
  });
  r.post('/api/environments/:id/drill', async ({ params, body }) => {
    const env = await requireEnv(params.id);
    needConfirm(env, body);
    const job = startJob('drill', env, body);
    statusCache.delete(env.id);
    return { jobId: job.id };
  });

  r.get('/api/job', ({ query }) => jobs.snapshot(Math.max(0, Number(query.get('since')) || 0)) ?? { status: 'idle' });
  r.post('/api/job/cancel', () => {
    jobs.cancel();
    return { ok: true };
  });

  r.post('/api/environments/:id/checks/run', async ({ params, body }) => {
    const env = await requireEnv(params.id);
    const target = body?.checkId ? { ...env, checks: env.checks.filter((c) => c.id === body.checkId) } : env;
    const results = await runChecks(target, { origin: origin(), provider: getProvider(env) });
    return { results, at: new Date().toISOString() };
  });

  r.post('/api/environments/:id/rpo/read', async ({ params }) => {
    const env = await requireEnv(params.id);
    if (env.rpoSource.type === 'none') throw new HttpError(400, 'Nenhuma fonte de RPO configurada.');
    try {
      const res = await readLastData(env, { origin: origin() });
      return { type: res.type, at: res.at.toISOString(), raw: res.raw, ageSec: (Date.now() - res.at.getTime()) / 1000 };
    } catch (err) {
      throw new HttpError(422, err.message);
    }
  });

  r.post('/api/environments/:id/rpo/canary-test', async ({ params }) => {
    const env = await requireEnv(params.id);
    if (env.rpoSource.type !== 'canary') throw new HttpError(400, 'A fonte de RPO deste ambiente não é um canário.');
    try {
      return await testCanary(env);
    } catch (err) {
      throw new HttpError(422, err.message);
    }
  });

  // ---------- descoberta de recursos (wizard) — somente leitura ----------
  r.get('/api/discover/tools', () => discover.tools());
  r.get('/api/discover/aws/profiles', () => discover.awsProfiles());
  r.get('/api/discover/aws/identity', ({ query }) => discover.awsIdentity(discover.awsParams(query)));
  r.get('/api/discover/eks', ({ query }) => discover.eksClusters(discover.awsParams(query)));
  r.get('/api/discover/ec2', ({ query }) => discover.ec2Instances(discover.awsParams(query)));
  r.get('/api/discover/rds', ({ query }) => discover.rdsResources(discover.awsParams(query)));
  r.get('/api/discover/elasticache', ({ query }) => discover.elasticacheResources(discover.awsParams(query)));
  r.get('/api/discover/k8s/contexts', () => discover.k8sContexts());
  r.get('/api/discover/k8s/workloads', ({ query }) => discover.k8sWorkloads(discover.contextParam(query)));
  r.get('/api/discover/docker/containers', () => discover.dockerContainers());

  // ---------- execuções e relatórios ----------
  r.get('/api/runs', ({ query }) => store.listRuns({ envId: query.get('envId') || undefined }));
  r.get('/api/runs/:id', ({ params }) => store.getRun(params.id));
  r.patch('/api/runs/:id', async ({ params, body }) => {
    const run = await store.getRun(params.id);
    if (typeof body?.notes !== 'string' || body.notes.length > 5000) throw new HttpError(400, '"notes" deve ser texto de até 5000 caracteres');
    run.notes = body.notes;
    await store.saveRun(run);
    return { ok: true };
  });
  r.delete('/api/runs/:id', async ({ params }) => {
    if (jobs.running && jobs.current.id === params.id) throw new HttpError(409, 'Execução em andamento.');
    await store.deleteRun(params.id);
  });

  const filename = (run, ext) => `relatorio-${run.kind}-${run.id}.${ext}`;
  const disposition = (query, name) => (query.get('download') === '1' ? { 'content-disposition': `attachment; filename="${name}"` } : {});
  r.get('/api/runs/:id/report.html', async ({ params, query }) => {
    const run = await store.getRun(params.id);
    return raw(200, 'text/html; charset=utf-8', renderRunHtml(run), disposition(query, filename(run, 'html')));
  });
  r.get('/api/runs/:id/report.md', async ({ params, query }) => {
    const run = await store.getRun(params.id);
    return raw(200, 'text/markdown; charset=utf-8', renderRunMarkdown(run), disposition(query, filename(run, 'md')));
  });
  r.get('/api/runs/:id/report.csv', async ({ params, query }) => {
    const run = await store.getRun(params.id);
    if (run.kind !== 'drill') throw new HttpError(400, 'CSV disponível apenas para exercícios.');
    return raw(200, 'text/csv; charset=utf-8', renderRunCsv(run), disposition(query, filename(run, 'csv')));
  });
  r.get('/api/runs/:id/report.json', async ({ params, query }) => {
    const run = await store.getRun(params.id);
    return raw(200, 'application/json; charset=utf-8', JSON.stringify(run, null, 2), disposition(query, filename(run, 'json')));
  });
  r.get('/api/reports/summary.html', async ({ query }) => {
    const envId = query.get('envId') || undefined;
    const env = envId ? await requireEnv(envId) : null;
    const runs = await store.listRuns({ envId });
    return raw(200, 'text/html; charset=utf-8', renderSummaryHtml(runs, env), disposition(query, 'relatorio-consolidado.html'));
  });

  // ---------- endpoints da demonstração (ambiente simulado) ----------
  const demoEnv = async (id) => {
    const env = await store.getEnvironment(id).catch(() => null);
    if (!env || env.provider !== 'simulated') throw new HttpError(404, 'Não encontrado');
    return getSim(env.id, env.simulated);
  };
  r.get('/demo/:id/health', async ({ params }) => {
    const sim = await demoEnv(params.id);
    return simAppUp(sim) ? { status: 'ok', service: 'api-simulada' } : raw(503, 'application/json; charset=utf-8', JSON.stringify({ status: 'unavailable' }));
  });
  r.get('/demo/:id/web', async ({ params }) => {
    const sim = await demoEnv(params.id);
    return simAppUp(sim) ? raw(200, 'text/html; charset=utf-8', '<!doctype html><title>App</title><h1>Aplicação simulada</h1>') : raw(502, 'text/plain; charset=utf-8', 'Bad Gateway');
  });
  r.get('/demo/:id/data', async ({ params }) => {
    const sim = await demoEnv(params.id);
    return { lastWriteAt: new Date(simLastDurable(sim)).toISOString() };
  });

  // ---------- servidor ----------
  const server = createServer(async (req, res) => {
    try {
      const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
      if (!hostAllow.has(hostname)) throw new HttpError(403, 'Host não permitido (proteção contra DNS rebinding). Ajuste ALLOWED_HOSTS.');
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const isApi = pathname.startsWith('/api/');

      if (isApi || pathname.startsWith('/demo/')) {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        const m = r.match(method, pathname);
        if (!m.handler) {
          if (m.pathMatched) throw new HttpError(405, 'Método não permitido');
          throw new HttpError(404, 'Rota não encontrada');
        }
        if (isApi) {
          if (tokenBuf) {
            const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
            if (got.length !== tokenBuf.length || !timingSafeEqual(got, tokenBuf)) throw new HttpError(401, 'Token ausente ou inválido');
          }
          if (!['GET', 'HEAD'].includes(req.method)) {
            const o = req.headers.origin;
            if (o) {
              let oh;
              try {
                oh = new URL(o).host;
              } catch {
                oh = '';
              }
              if (oh.toLowerCase() !== String(req.headers.host).toLowerCase()) throw new HttpError(403, 'Origem não permitida');
            }
          }
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
        const out = await m.handler({ req, res, params: m.params, query: url.searchParams, body });
        if (out === undefined) {
          res.writeHead(204, SECURITY_HEADERS);
          return res.end();
        }
        if (out?.__raw) return sendRaw(res, out);
        return sendJson(res, 200, out);
      }

      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Método não permitido');
      if (await serveStatic(req, res, publicDir, pathname)) return;
      throw new HttpError(404, 'Não encontrado');
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, details: err.details });
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      console.error('[erro]', err);
      return sendJson(res, 500, { error: err.message || 'Erro interno' });
    }
  });

  server.requestTimeout = 120_000;

  return {
    server,
    store,
    jobs,
    get origin() {
      return origin();
    },
    listen() {
      return new Promise((resolveP, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          actualPort = server.address().port;
          resolveP({ port: actualPort });
        });
      });
    },
    async close() {
      if (jobs.running) {
        jobs.cancel();
        await jobs.current.promise.catch(() => {});
      }
      server.closeAllConnections?.();
      await new Promise((res) => server.close(res));
    },
    /** Cria o ambiente de demonstração se ainda não houver nenhum ambiente. */
    async seedDemo() {
      if ((await store.listEnvironments()).length) return false;
      const base = normalizeEnvironment({ name: 'Demonstração (simulado)', provider: 'simulated' });
      const id = base.id;
      const env = normalizeEnvironment(
        {
          ...base,
          description: 'Ambiente simulado para experimentar o console sem AWS. Os testes apontam para endpoints locais (/demo) que reagem ao liga/desliga simulado.',
          targets: { rtoSeconds: 90, rpoSeconds: 30 },
          drill: { holdDownSeconds: 10, probeIntervalSeconds: 2, stableProbes: 3, maxRecoverySeconds: 120 },
          simulated: { stopSeconds: 4, startSeconds: 12, warmupSeconds: 6, replicationLagSeconds: 5 },
          rpoSource: { type: 'http', url: `{{origin}}/demo/${id}/data`, jsonPath: 'lastWriteAt' },
          checks: [
            { name: 'API /health', type: 'http', url: `{{origin}}/demo/${id}/health`, expectStatus: '200', contains: 'ok', timeoutMs: 2000, critical: true },
            { name: 'Frontend', type: 'http', url: `{{origin}}/demo/${id}/web`, expectStatus: '200', timeoutMs: 2000, critical: true },
            { name: 'Deployment api (k8s)', type: 'k8s', kind: 'deployment', namespace: 'prod', resource: 'api', critical: false },
          ],
        },
        { existing: base },
      );
      await store.saveEnvironment(env);
      return true;
    },
  };
}
