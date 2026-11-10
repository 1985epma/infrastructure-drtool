// Medição de RPO por canário de gravação.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { computeCanaryRpoSeconds } from '../src/rpo.js';
import { normalizeEnvironment } from '../src/validate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('canário: cálculo e validação', () => {
  it('RPO = dado confirmado que não voltou (nunca negativo)', () => {
    const t = (s) => new Date(Date.parse('2026-11-10T12:00:00Z') + s * 1000);
    assert.equal(computeCanaryRpoSeconds({ lastAcked: t(10), readBack: t(10) }), 0);
    assert.equal(computeCanaryRpoSeconds({ lastAcked: t(10), readBack: t(4) }), 6);
    assert.equal(computeCanaryRpoSeconds({ lastAcked: t(10), readBack: t(12) }), 0);
    assert.equal(computeCanaryRpoSeconds({ lastAcked: t(10), readBack: null }), null);
  });

  it('valida a fonte canário', () => {
    const ok = normalizeEnvironment({ name: 'x', provider: 'simulated', rpoSource: { type: 'canary', writeCommand: 'echo a', readCommand: 'echo b' } });
    assert.equal(ok.rpoSource.intervalSeconds, 2);
    const details = (rpoSource) => {
      try {
        normalizeEnvironment({ name: 'x', provider: 'simulated', rpoSource });
      } catch (err) {
        return (err.details ?? []).join(' | ');
      }
      return '';
    };
    assert.match(details({ type: 'canary', writeCommand: 'echo a' }), /readCommand/);
    assert.match(details({ type: 'canary', writeCommand: "echo 'a", readCommand: 'x' }), /aspas/);
  });
});

describe('canário: exercício completo', () => {
  let dir;
  let app;
  let base;
  let file;
  const json = async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eksdr-canary-'));
    file = join(dir, 'canary.log');
    app = await createApp({ dataDir: join(dir, 'data'), port: 0 });
    await app.seedDemo();
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function runDrill(readCommand) {
    await writeFile(file, '');
    const env = (await json('/api/environments')).data[0];
    env.simulated = { stopSeconds: 1, startSeconds: 2, warmupSeconds: 1, replicationLagSeconds: 0 };
    // "armazenamento": arquivo append-only; escrita confirmada = linha gravada
    env.rpoSource = { type: 'canary', writeCommand: `sh -c 'echo "$CANARY_VALUE" >> "${file}"'`, readCommand: readCommand(file), intervalSeconds: 1, timeoutSec: 10 };
    const put = await json(`/api/environments/${env.id}`, { method: 'PUT', body: env });
    assert.equal(put.status, 200, JSON.stringify(put.data));

    const test = await json(`/api/environments/${env.id}/rpo/canary-test`, { method: 'POST', body: {} });
    assert.equal(test.status, 200, JSON.stringify(test.data));
    assert.equal(test.data.match, true);

    await writeFile(file, '');
    const start = await json(`/api/environments/${env.id}/drill`, { method: 'POST', body: { params: { holdDownSeconds: 1, probeIntervalSeconds: 1, stableProbes: 2 } } });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    let job;
    for (let i = 0; i < 160; i++) {
      job = (await json('/api/job')).data;
      if (job.status !== 'running') break;
      await sleep(500);
    }
    assert.equal(job.status, 'succeeded', job.error);
    const runs = (await json(`/api/runs?envId=${env.id}`)).data;
    return (await json(`/api/runs/${runs[0].id}`)).data;
  }

  it('sem perda: lê de volta o último valor gravado → RPO 0 e relatório explica o método', { timeout: 90_000 }, async () => {
    const run = await runDrill((f) => `tail -n 1 ${f}`);
    assert.equal(run.rpoDetail.mode, 'canary');
    assert.ok(run.rpoDetail.canary.writesOk >= 2, JSON.stringify(run.rpoDetail));
    assert.equal(run.evaluation.rpo.measured, true);
    assert.equal(run.metrics.rpoSec, 0);
    // a medição de RPO começa automaticamente logo após o RTO e entra na linha do tempo
    assert.ok(run.timestamps.rpoStartAt && run.timestamps.rpoDoneAt, JSON.stringify(run.timestamps));
    assert.ok(new Date(run.timestamps.rpoStartAt) >= new Date(run.timestamps.restoredAt));
    assert.ok(new Date(run.timestamps.rpoDoneAt) >= new Date(run.timestamps.rpoStartAt));
    assert.equal(run.rpoDetail.canary.writeAfterRecovery, true);
    assert.ok(run.events.some((e) => /iniciando automaticamente a medição de RPO/.test(e.msg)));
    assert.ok(run.events.some((e) => /RPO apurado: 0\.0s/.test(e.msg)));
    const html = await (await fetch(`${base}/api/runs/${run.id}/report.html`)).text();
    assert.match(html, /Medição de RPO iniciada automaticamente/);
    assert.match(html, /caminho de escrita restabelecido/);
    assert.match(html, /RPO \(canário\)/);
    assert.match(html, /gravação\(ões\) confirmada\(s\)/);
  });

  it('com perda: valor lido é mais antigo → RPO > 0', { timeout: 90_000 }, async () => {
    // simula perda de dados: a leitura devolve a penúltima gravação (~1 intervalo atrás)
    const run = await runDrill((f) => `sh -c 'tail -n 2 ${f} | head -n 1'`);
    assert.equal(run.evaluation.rpo.measured, true);
    assert.ok(run.metrics.rpoSec >= 0.5 && run.metrics.rpoSec <= 3, `rpo=${run.metrics.rpoSec}`);
    const written = (await readFile(file, 'utf8')).trim().split('\n').length;
    assert.ok(written >= 2);
  });
});
