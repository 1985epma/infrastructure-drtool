// Regressões dos bugs B3–B11 da revisão de arquitetura (cada teste falha no código anterior à correção).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { run } from '../src/exec.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dirs = [];
const tmp = async (p) => {
  const d = await mkdtemp(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function boot(opts = {}) {
  const dataDir = opts.dataDir ?? (await tmp('epma-hard-'));
  const app = await createApp({ dataDir, port: 0, ...opts });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const json = async (path, o = {}) => {
    const res = await fetch(`${base}${path}`, { ...o, headers: { 'content-type': 'application/json', ...o.headers }, body: o.body ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
  return { app, base, json, dataDir, port };
}

async function waitJob(json, secs = 60) {
  let job;
  for (let i = 0; i < secs * 4; i++) {
    job = (await json('/api/job')).data;
    if (job.status !== 'running') return job;
    await sleep(250);
  }
  throw new Error('job não terminou');
}

describe('B4 — URL malformada', () => {
  let h;
  before(async () => (h = await boot()));
  after(() => h.app.close());
  it('parâmetro com %-encoding inválido => 400 (não 500)', async () => {
    const r = await h.json('/api/runs/%E0%A4%A');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /inválido/i);
  });
});

describe('B5 — PUT concorrente de ambiente', () => {
  let h;
  before(async () => {
    h = await boot();
    await h.app.seedDemo();
  });
  after(() => h.app.close());
  it('duas edições a partir da mesma versão: uma vence, a outra recebe 409 (sem lost update)', async () => {
    const [env] = (await h.json('/api/environments')).data;
    const a = { ...env, name: 'Edição A' };
    const b = { ...env, name: 'Edição B' };
    const res = await Promise.all([h.json(`/api/environments/${env.id}`, { method: 'PUT', body: a }), h.json(`/api/environments/${env.id}`, { method: 'PUT', body: b })]);
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    const winner = res.find((r) => r.status === 200).data;
    assert.equal((await h.json(`/api/environments/${env.id}`)).data.name, winner.name, 'o que ficou gravado é o que recebeu 200');
  });
  it('sem updatedAt no corpo (clientes antigos) continua aceito', async () => {
    const [env] = (await h.json('/api/environments')).data;
    const { updatedAt, ...semVersao } = env;
    const r = await h.json(`/api/environments/${env.id}`, { method: 'PUT', body: { ...semVersao, name: 'Sem versão' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });
});

describe('B6 — excluir ambiente remove kubeconfig/estado, mas mantém o histórico', () => {
  let h;
  before(async () => {
    h = await boot();
    await h.app.seedDemo();
  });
  after(() => h.app.close());
  it('kubeconfig (credenciais) e snapshot somem; relatórios ficam', async () => {
    const [env] = (await h.json('/api/environments')).data;
    const kube = h.app.store.kubeconfigPath(env.id);
    await writeFile(kube, 'apiVersion: v1\nkind: Config\n');
    await h.app.store.setState(env.id, { nodegroups: {} });
    await h.app.store.markInflight(env.id, { kind: 'drill', since: new Date().toISOString() });
    await h.app.store.saveRun({ id: 'run-antigo', kind: 'stop', envId: env.id, startedAt: new Date().toISOString() });

    assert.equal((await h.json(`/api/environments/${env.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(existsSync(kube), false, 'kubeconfig órfão');
    assert.deepEqual(await h.app.store.getState(env.id), {});
    assert.equal(await h.app.store.getInflight(env.id), null);
    assert.equal((await h.json('/api/runs/run-antigo')).status, 200, 'histórico é mantido');
  });
});

describe('B7 — erro de status não fica em cache', () => {
  const ORIG_PATH = process.env.PATH;
  after(() => {
    process.env.PATH = ORIG_PATH;
  });
  it('uma falha transitória não é repetida do cache na consulta seguinte', async () => {
    const bin = await tmp('epma-bin-');
    process.env.PATH = `${bin}:${ORIG_PATH}`;
    const h = await boot();
    try {
      const create = await h.json('/api/environments', { method: 'POST', body: { name: 'eks-flap', provider: 'eks', eks: { clusterName: 'c', region: 'us-east-1', useKubectl: false } } });
      assert.equal(create.status, 200, JSON.stringify(create.data));
      const id = create.data.id;
      await writeFile(join(bin, 'aws'), '#!/bin/sh\necho "falha-1" >&2\nexit 1\n', { mode: 0o755 });
      const first = (await h.json(`/api/environments/${id}/status`)).data;
      assert.equal(first.state, 'error');
      await writeFile(join(bin, 'aws'), '#!/bin/sh\necho "falha-2" >&2\nexit 1\n', { mode: 0o755 });
      const second = (await h.json(`/api/environments/${id}/status`)).data; // dentro dos 4s de cache
      assert.equal(second.state, 'error');
      assert.notEqual(second.note, first.note, 'o 2º status foi servido do cache de erro');
    } finally {
      await h.app.close();
    }
  });
});

describe('B8 — freio de força bruta no token', () => {
  const token = randomBytes(16).toString('hex');
  let h;
  before(async () => (h = await boot({ adminToken: token })));
  after(() => h.app.close());
  it('após 10 tokens errados o IP recebe 429 com Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${h.base}/api/meta`, { headers: { authorization: `Bearer errado-${i}-xxxxxxxx` } });
      assert.equal(r.status, 401);
    }
    const blocked = await fetch(`${h.base}/api/meta`, { headers: { authorization: 'Bearer errado-final-xxxx' } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

describe('B8 — token válido de tamanho diferente não vaza por comprimento', () => {
  const token = randomBytes(16).toString('hex');
  let h;
  before(async () => (h = await boot({ adminToken: token })));
  after(() => h.app.close());
  it('curto, longo e correto', async () => {
    for (const bad of ['x', `${token}${token}`]) assert.equal((await fetch(`${h.base}/api/meta`, { headers: { authorization: `Bearer ${bad}` } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/meta`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });
});

describe('B9 — erro interno não vaza detalhes ao cliente', () => {
  it('arquivo de dados corrompido => 500 genérico', async () => {
    const dataDir = await tmp('epma-corrupt-');
    const h = await boot({ dataDir });
    const origError = console.error;
    console.error = () => {}; // o detalhe vai para o log do servidor (esperado)
    try {
      await writeFile(join(dataDir, 'environments.json'), '{ isto nao e json /home/segredo/caminho');
      const r = await h.json('/api/environments');
      assert.equal(r.status, 500);
      assert.doesNotMatch(JSON.stringify(r.data), /JSON|segredo|position|Unexpected/i);
    } finally {
      console.error = origError;
      await h.app.close();
    }
  });
});

describe('B10 — publicDir relativo', () => {
  it('serve a UI mesmo com caminho relativo', async () => {
    const h = await boot({ publicDir: `./${relative(process.cwd(), join(ROOT, 'public'))}` });
    try {
      const r = await fetch(`${h.base}/`);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /<html/i);
      assert.equal((await fetch(`${h.base}/..%2f..%2fpackage.json`)).status, 404, 'path traversal continua bloqueado');
    } finally {
      await h.app.close();
    }
  });
});

describe('B11 — linha gigante sem \\n não cresce sem limite', () => {
  it('onLine recebe pedaços de até 64 KiB e nada se perde', async () => {
    const total = 300_000;
    const lens = [];
    const r = await run(process.execPath, ['-e', `process.stdout.write('a'.repeat(${total}))`], { onLine: (l) => lens.push(l.length) });
    assert.equal(r.code, 0);
    assert.equal(lens.reduce((a, b) => a + b, 0), total);
    assert.ok(Math.max(...lens) <= 64 * 1024, `maior pedaço: ${Math.max(...lens)}`);
  });
});

describe('B3 — operação interrompida (crash no meio do exercício)', () => {
  let h;
  before(async () => {
    h = await boot();
    await h.app.seedDemo();
  });
  after(() => h.app.close());

  it('durante o exercício há marcador em disco; ao terminar ele é removido', { timeout: 90_000 }, async () => {
    const [env] = (await h.json('/api/environments')).data;
    env.simulated = { stopSeconds: 1, startSeconds: 2, warmupSeconds: 1, replicationLagSeconds: 5 };
    assert.equal((await h.json(`/api/environments/${env.id}`, { method: 'PUT', body: env })).status, 200);
    assert.equal((await h.json(`/api/environments/${env.id}/drill`, { method: 'POST', body: { params: { holdDownSeconds: 4, probeIntervalSeconds: 1, stableProbes: 2 } } })).status, 200);

    let marker = null;
    for (let i = 0; i < 120 && !marker; i++) {
      marker = await h.app.store.getInflight(env.id);
      if (!marker) await sleep(100);
    }
    assert.ok(marker, 'marcador deveria existir após a injeção da falha');
    assert.equal(marker.kind, 'drill');
    // durante o job o aviso de "interrompido" não aparece (a operação está viva)
    assert.equal((await h.json(`/api/environments/${env.id}/status`)).data.interrupted, undefined);

    const job = await waitJob(h.json);
    assert.equal(job.status, 'succeeded', job.error);
    assert.equal(await h.app.store.getInflight(env.id), null, 'recuperação concluída limpa o marcador');
  });

  it('marcador órfão (processo morreu) é reportado; religar limpa', { timeout: 60_000 }, async () => {
    const [env] = (await h.json('/api/environments')).data;
    // simula "crash": ambiente desligado + marcador deixado em disco, sem nenhum job vivo
    assert.equal((await h.json(`/api/environments/${env.id}/stop`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await waitJob(h.json)).status, 'succeeded');
    await h.app.store.markInflight(env.id, { kind: 'drill', runId: 'run-x', envName: env.name, since: new Date().toISOString() });

    const meta = (await h.json('/api/meta')).data;
    assert.deepEqual(meta.interrupted.map((m) => m.envId), [env.id]);
    const st = (await h.json(`/api/environments/${env.id}/status?force=1`)).data;
    assert.equal(st.state, 'stopped');
    assert.equal(st.interrupted.runId, 'run-x');

    assert.equal((await h.json(`/api/environments/${env.id}/start`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await waitJob(h.json)).status, 'succeeded');
    assert.equal(await h.app.store.getInflight(env.id), null);
    assert.equal((await h.json(`/api/environments/${env.id}/status?force=1`)).data.interrupted, undefined);
  });

  it('se o ambiente já voltou a "running" (religado por fora), o aviso some sozinho', async () => {
    const [env] = (await h.json('/api/environments')).data;
    await h.app.store.markInflight(env.id, { kind: 'drill', since: new Date().toISOString() });
    const st = (await h.json(`/api/environments/${env.id}/status?force=1`)).data;
    assert.equal(st.state, 'running');
    assert.equal(st.interrupted, undefined);
    assert.equal(await h.app.store.getInflight(env.id), null);
  });
});
