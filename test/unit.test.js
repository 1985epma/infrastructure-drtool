import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeRpoSeconds } from '../src/rpo.js';
import { renderRunCsv, renderRunHtml, esc } from '../src/report.js';
import { HttpError, UserError, fmtDuration, getPath, parseTimestamp, tokenize } from '../src/util.js';
import { normalizeCheck, normalizeEnvironment, statusMatches } from '../src/validate.js';

describe('util', () => {
  it('tokenize respeita aspas e escapes', () => {
    assert.deepEqual(tokenize('a "b c" d\\ e'), ['a', 'b c', 'd e']);
    assert.deepEqual(tokenize("terraform apply -var 'x=1 2'"), ['terraform', 'apply', '-var', 'x=1 2']);
    assert.deepEqual(tokenize('  '), []);
    assert.deepEqual(tokenize('a "" b'), ['a', '', 'b']);
  });
  it('tokenize rejeita aspas não fechadas', () => {
    assert.throws(() => tokenize('a "b'), UserError);
  });
  it('tokenize não interpreta metacaracteres de shell', () => {
    assert.deepEqual(tokenize('echo a;rm -rf /'), ['echo', 'a;rm', '-rf', '/']);
  });
  it('getPath', () => {
    const o = { a: { b: [{ c: 7 }] } };
    assert.equal(getPath(o, 'a.b[0].c'), 7);
    assert.equal(getPath(o, 'a.x.y'), undefined);
    assert.equal(getPath(o, ''), o);
  });
  it('parseTimestamp', () => {
    assert.equal(parseTimestamp('2026-01-01T00:00:00Z').toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(parseTimestamp(1767225600).toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(parseTimestamp('1767225600000').toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('nope'), null);
    assert.equal(parseTimestamp(null), null);
  });
  it('fmtDuration', () => {
    assert.equal(fmtDuration(5), '5s');
    assert.equal(fmtDuration(65), '1m 05s');
    assert.equal(fmtDuration(3725), '1h 02m 05s');
    assert.equal(fmtDuration(null), '—');
  });
});

describe('validate', () => {
  it('statusMatches', () => {
    assert.equal(statusMatches('200-299', 204), true);
    assert.equal(statusMatches('200', 404), false);
    assert.equal(statusMatches('200,404', 404), true);
    assert.equal(statusMatches('lixo', 301), true); // padrão 200-399
  });
  it('normalizeEnvironment aceita EKS válido e aplica padrões', () => {
    const env = normalizeEnvironment({ name: 'prod', provider: 'eks', eks: { clusterName: 'meu-cluster', region: 'us-east-1' } });
    assert.equal(env.provider, 'eks');
    assert.equal(env.targets.rtoSeconds, 900);
    assert.equal(env.drill.stableProbes, 3);
    assert.deepEqual(env.checks, []);
  });
  it('rejeita cluster e região inválidos', () => {
    for (const eks of [
      { clusterName: 'x; rm -rf /', region: 'us-east-1' },
      { clusterName: '--profile', region: 'us-east-1' },
      { clusterName: 'ok', region: 'mars' },
      { clusterName: '', region: 'us-east-1' },
    ]) {
      assert.throws(() => normalizeEnvironment({ name: 'x', provider: 'eks', eks }), (e) => e instanceof HttpError && e.status === 400 && e.details.length > 0);
    }
  });
  it('exige comandos no provider custom e valida aspas', () => {
    assert.throws(() => normalizeEnvironment({ name: 'x', provider: 'custom', custom: {} }), HttpError);
    assert.throws(() => normalizeEnvironment({ name: 'x', provider: 'custom', custom: { startCommand: 'a "b', stopCommand: 'true' } }), HttpError);
    assert.ok(normalizeEnvironment({ name: 'x', provider: 'custom', custom: { startCommand: 'true', stopCommand: 'true' } }));
  });
  it('normalizeCheck', () => {
    const c = normalizeCheck({ name: 'api', type: 'http', url: '{{origin}}/health' });
    assert.equal(c.method, 'GET');
    assert.equal(c.expectStatus, '200-399');
    assert.equal(c.critical, true);
    assert.throws(() => normalizeCheck({ name: 'x', type: 'http', url: 'ftp://a' }), HttpError);
    assert.throws(() => normalizeCheck({ name: 'x', type: 'http', url: 'http://a', expectStatus: 'abc' }), HttpError);
    assert.throws(() => normalizeCheck({ name: 'x', type: 'tcp', host: 'a b', port: 80 }), HttpError);
    assert.throws(() => normalizeCheck({ name: 'x', type: 'tcp', host: 'a', port: 70000 }), HttpError);
    const k = normalizeCheck({ name: 'rótulo', type: 'k8s', resource: 'api', namespace: 'prod' });
    assert.equal(k.name, 'rótulo');
    assert.equal(k.resource, 'api');
  });
});

describe('rpo', () => {
  const failureAt = Date.parse('2026-01-01T00:10:00Z');
  const d = (s) => new Date(failureAt - s * 1000);
  it('regressão do dado => perda real', () => {
    assert.equal(computeRpoSeconds({ failureAt, before: d(2), after: d(120) }), 120);
  });
  it('sem regressão => defasagem existente na falha', () => {
    assert.equal(computeRpoSeconds({ failureAt, before: d(5), after: new Date(failureAt + 60_000) }), 5);
  });
  it('somente um lado', () => {
    assert.equal(computeRpoSeconds({ failureAt, before: null, after: d(30) }), 30);
    assert.equal(computeRpoSeconds({ failureAt, before: d(7), after: null }), 7);
  });
  it('nenhum lado => null; nunca negativo', () => {
    assert.equal(computeRpoSeconds({ failureAt, before: null, after: null }), null);
    assert.equal(computeRpoSeconds({ failureAt, before: new Date(failureAt + 5000), after: null }), 0);
  });
});

describe('report', () => {
  const evil = '<script>alert(1)</script>';
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const run = {
    id: 'r1',
    kind: 'drill',
    envName: evil,
    env: { provider: 'simulated' },
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date(t0 + 60000).toISOString(),
    durationSec: 60,
    status: 'completed',
    warnings: [evil],
    params: { probeIntervalSeconds: 1, holdDownSeconds: 1, stableProbes: 2 },
    timestamps: { failureAt: new Date(t0 + 5000).toISOString(), restoredAt: new Date(t0 + 25000).toISOString() },
    metrics: { rtoSec: 20, rpoSec: 5, availabilityPct: 80, downtimeSec: 20, sampleCount: 2, stopSec: 1, holdSec: 1, infraStartSec: 10, appReadySec: 8 },
    rpoDetail: { source: 'http', error: evil },
    evaluation: { rto: { targetSec: 90, actualSec: 20, pass: true }, rpo: { targetSec: 30, actualSec: 5, measured: true, pass: true }, verdict: 'approved' },
    checks: [{ id: 'c1', name: evil, type: 'http', critical: true }, { id: 'c2', name: '=cmd|calc', type: 'http', critical: false }],
    baseline: [{ name: evil, type: 'http', ok: true, detail: evil }],
    samples: [{ t: t0, ok: true, r: [1, 1], l: [3, 4] }, { t: t0 + 1000, ok: false, r: [0, 1], l: [0, 4] }],
    outages: [],
    events: [{ t: new Date(t0).toISOString(), level: 'info', msg: evil }],
    notes: evil,
  };
  it('esc escapa HTML', () => {
    assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
  it('HTML nunca contém dados do usuário crus (XSS)', () => {
    const html = renderRunHtml(run);
    assert.ok(!html.includes(evil), 'tag <script> crua vazou no relatório');
    assert.ok(!/<script/i.test(html));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
  it('CSV prefixa células com fórmula', () => {
    const header = renderRunCsv(run).split('\n')[0];
    assert.ok(header.includes("'=cmd|calc"), header);
    assert.ok(header.includes("'<script>") === false); // texto comum não é prefixado
  });
});
