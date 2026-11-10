import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requisição crua (permite controlar Host/Origin/path, o que fetch não permite). */
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('integração (ambiente simulado)', () => {
  let dir;
  let app;
  let base;
  let port;
  const json = async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eksdr-'));
    app = await createApp({ dataDir: dir, port: 0 });
    await app.seedDemo();
    ({ port } = await app.listen());
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('exercício completo mede RTO/RPO e gera relatórios', { timeout: 90_000 }, async () => {
    const envs = (await json('/api/environments')).data;
    assert.equal(envs.length, 1);
    const env = envs[0];
    env.simulated = { stopSeconds: 1, startSeconds: 2, warmupSeconds: 1, replicationLagSeconds: 5 };
    const put = await json(`/api/environments/${env.id}`, { method: 'PUT', body: env });
    assert.equal(put.status, 200, JSON.stringify(put.data));

    const start = await json(`/api/environments/${env.id}/drill`, {
      method: 'POST',
      body: { params: { holdDownSeconds: 1, probeIntervalSeconds: 1, stableProbes: 2 } },
    });
    assert.equal(start.status, 200, JSON.stringify(start.data));

    // segunda operação simultânea deve ser recusada
    const dup = await json(`/api/environments/${env.id}/start`, { method: 'POST', body: {} });
    assert.equal(dup.status, 409);

    let job;
    for (let i = 0; i < 120; i++) {
      job = (await json('/api/job')).data;
      if (job.status !== 'running') break;
      await sleep(500);
    }
    assert.equal(job.status, 'succeeded', job.error);

    const runs = (await json(`/api/runs?envId=${env.id}`)).data;
    assert.equal(runs.length, 1);
    const run = (await json(`/api/runs/${runs[0].id}`)).data;
    assert.equal(run.kind, 'drill');
    assert.equal(run.evaluation.verdict, 'approved');
    assert.ok(run.metrics.rtoSec > 0, `rto=${run.metrics.rtoSec}`);
    assert.ok(Math.abs(run.metrics.rpoSec - 5) < 2.5, `rpo=${run.metrics.rpoSec}`);
    assert.ok(run.samples.length > 3);
    assert.ok(run.timestamps.detectedAt, 'indisponibilidade deveria ter sido detectada');

    for (const ext of ['html', 'md', 'csv', 'json']) {
      const r = await fetch(`${base}/api/runs/${run.id}/report.${ext}`);
      assert.equal(r.status, 200, ext);
      assert.ok((await r.text()).length > 50, ext);
    }
    const sum = await fetch(`${base}/api/reports/summary.html?envId=${env.id}`);
    assert.equal(sum.status, 200);

    // ambiente deve ter voltado a ficar ligado
    const st = (await json(`/api/environments/${env.id}/status?force=1`)).data;
    assert.equal(st.state, 'running');
  });

  it('Host inválido => 403 (DNS rebinding)', async () => {
    const r = await rawRequest(port, { path: '/api/meta', headers: { host: 'evil.example.com' } });
    assert.equal(r.status, 403);
  });

  it('Origin cruzado em POST => 403', async () => {
    const r = await rawRequest(port, {
      method: 'POST',
      path: '/api/job/cancel',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example.com', 'content-type': 'application/json', 'content-length': 2 },
      body: '{}',
    });
    assert.equal(r.status, 403);
  });

  it('POST sem Content-Type JSON => 415', async () => {
    const r = await rawRequest(port, { method: 'POST', path: '/api/job/cancel', headers: { 'content-length': 2 }, body: '{}' });
    assert.equal(r.status, 415);
  });

  it('ambiente não simulado exige confirmação para desligar', async () => {
    const created = await json('/api/environments', {
      method: 'POST',
      body: { name: 'prod-x', provider: 'custom', custom: { startCommand: 'true', stopCommand: 'true' } },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.id;
    const noConfirm = await json(`/api/environments/${id}/stop`, { method: 'POST', body: {} });
    assert.equal(noConfirm.status, 400);
    const wrong = await json(`/api/environments/${id}/drill`, { method: 'POST', body: { confirm: 'outro' } });
    assert.equal(wrong.status, 400);
    assert.equal((await json('/api/job')).data.status, 'succeeded'); // nada novo foi iniciado
    assert.equal((await json(`/api/environments/${id}`, { method: 'DELETE' })).status, 204);
  });

  it('path traversal em estáticos não vaza arquivos', async () => {
    for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..%2f..%2fserver.js', '/%00']) {
      const r = await rawRequest(port, { path, headers: { host: `127.0.0.1:${port}` } });
      assert.notEqual(r.status, 200, path);
      assert.ok(!r.body.includes('eks-dr-console'), `vazou conteúdo em ${path}`);
      assert.ok(!r.body.includes('createApp'), `vazou conteúdo em ${path}`);
    }
  });

  it('API desconhecida => 404 e método errado => 405', async () => {
    assert.equal((await json('/api/nao-existe')).status, 404);
    assert.equal((await json('/api/meta', { method: 'DELETE' })).status, 405);
  });
});

describe('autenticação por token', () => {
  let dir;
  let app;
  let base;
  const token = randomBytes(16).toString('hex'); // gerado a cada execução (sem literal no repositório)
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eksdr-auth-'));
    app = await createApp({ dataDir: dir, port: 0, adminToken: token });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('exige Bearer válido', async () => {
    assert.equal((await fetch(`${base}/api/meta`)).status, 401);
    assert.equal((await fetch(`${base}/api/meta`, { headers: { authorization: 'Bearer errado-errado-1234' } })).status, 401);
    assert.equal((await fetch(`${base}/api/meta`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });
});
