// Provider EKS contra `aws`/`kubectl` FALSOS (um único script, criado dentro do teste).
// Foco: a escala original dos workloads precisa estar em disco ANTES de cada `kubectl scale`,
// para que uma falha no meio do "desligar" ainda permita restaurar tudo no "ligar".
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { Store } = await import('../src/store.js');
const { createProvider } = await import('../src/providers/index.js');
const { normalizeEnvironment } = await import('../src/validate.js');

const FAKE_SRC = `
import { readFileSync, writeFileSync } from 'node:fs';
const [tool, ...argv] = process.argv.slice(2);
const S = JSON.parse(readFileSync(process.env.FAKE_EKS_STATE, 'utf8'));
const save = () => writeFileSync(process.env.FAKE_EKS_STATE, JSON.stringify(S));
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };

if (tool === 'aws') {
  const [svc, op] = argv;
  if (svc === 'eks' && op === 'update-kubeconfig') process.exit(0);
  if (svc === 'eks' && op === 'list-nodegroups') out({ nodegroups: Object.keys(S.nodegroups) });
  if (svc === 'eks' && op === 'describe-nodegroup') {
    const n = flag('--nodegroup-name'); const g = S.nodegroups[n];
    out({ nodegroup: { nodegroupName: n, status: 'ACTIVE', scalingConfig: { minSize: g.min, maxSize: g.max, desiredSize: g.desired }, instanceTypes: ['m5.large'] } });
  }
  if (svc === 'eks' && op === 'update-nodegroup-config') {
    const sc = Object.fromEntries(flag('--scaling-config').split(',').map((kv) => kv.split('=')));
    Object.assign(S.nodegroups[flag('--nodegroup-name')], { min: +sc.minSize, max: +sc.maxSize, desired: +sc.desiredSize });
    save(); out({});
  }
  die('fake aws: nao suportado: ' + argv.join(' '));
}

// kubectl
const args = argv.filter((a, i) => !(a === '--kubeconfig' || argv[i - 1] === '--kubeconfig' || a.startsWith('--request-timeout')));
if (args[0] === 'get' && args[1] === 'deployments,statefulsets') {
  const ns = flag('-n');
  const items = Object.entries(S.workloads).filter(([k]) => k.startsWith(ns + '/')).map(([k, w]) => {
    const [, kind, name] = k.split('/');
    return { kind: kind === 'deployment' ? 'Deployment' : 'StatefulSet', metadata: { name }, spec: { replicas: w.desired } };
  });
  out({ items });
}
if (args[0] === 'scale') {
  const [kind, name] = args[3].split('/'); // scale -n <ns> <kind/name> --replicas=N
  const key = flag('-n') + '/' + kind + '/' + name;
  if (S.failScaleOn === key) die('Error from server (Forbidden): scale ' + key + ' denied');
  S.workloads[key].desired = Number(args.find((a) => a.startsWith('--replicas=')).split('=')[1]);
  S.scaleCalls.push(key + '=' + S.workloads[key].desired);
  save(); console.log('scaled'); process.exit(0);
}
die('fake kubectl: nao suportado: ' + args.join(' '));
`;

const ORIG_PATH = process.env.PATH;
const dirs = [];
after(async () => {
  process.env.PATH = ORIG_PATH;
  delete process.env.FAKE_EKS_STATE;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(state) {
  const dir = await mkdtemp(join(tmpdir(), 'epma-eks-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const fake = join(dir, 'fake-eks.mjs');
  await writeFile(fake, FAKE_SRC);
  for (const t of ['aws', 'kubectl']) await writeFile(join(bin, t), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${t} "$@"\n`, { mode: 0o755 });
  const stateFile = join(dir, 'cluster.json');
  writeFileSync(stateFile, JSON.stringify({ scaleCalls: [], ...state }));
  process.env.PATH = `${bin}:${ORIG_PATH}`;
  process.env.FAKE_EKS_STATE = stateFile;
  const store = new Store(join(dir, 'data'));
  await store.init();
  return {
    store,
    cluster: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    patch(fn) {
      const s = JSON.parse(readFileSync(stateFile, 'utf8'));
      fn(s);
      writeFileSync(stateFile, JSON.stringify(s));
    },
  };
}

const mkEnv = () =>
  normalizeEnvironment({
    name: 'eks-test',
    provider: 'eks',
    eks: { clusterName: 'dr-cluster', region: 'us-east-1', useKubectl: false, scaleWorkloads: true, workloadNamespaces: ['prod'], readyTimeoutSec: 60 },
  });
const mkCtx = () => {
  const logs = [];
  return { logs, log: (l, m) => logs.push(`${l}: ${m}`), signal: new AbortController().signal };
};
const wl = (desired) => ({ desired });

describe('provider EKS — escala de workloads', () => {
  it('falha no meio do "desligar": a escala original já está em disco e o "ligar" restaura tudo', async () => {
    const h = await setup({
      nodegroups: { ng1: { min: 1, max: 4, desired: 2 } },
      workloads: { 'prod/deployment/a': wl(2), 'prod/deployment/b': wl(3), 'prod/statefulset/c': wl(1) },
      failScaleOn: 'prod/deployment/b',
    });
    const env = mkEnv();
    const p = createProvider(env, { store: h.store });

    await assert.rejects(p.stop(mkCtx()), /Forbidden/);

    // `a` já foi zerado, `b` falhou, `c` nem foi tentado
    assert.equal(h.cluster().workloads['prod/deployment/a'].desired, 0);
    assert.equal(h.cluster().workloads['prod/deployment/b'].desired, 3);

    // regressão: antes, nada era gravado quando o scale falhava no meio
    const saved = (await h.store.getState(env.id)).workloads;
    assert.equal(saved['prod/deployment/a'], 2, 'o que foi zerado precisa estar salvo');
    assert.equal(saved['prod/deployment/b'], 3, 'o salvamento acontece ANTES do scale');

    // recuperação (ex.: a rede de segurança do exercício): restaura o que foi salvo
    h.patch((s) => delete s.failScaleOn);
    const ctx = mkCtx();
    await p.start(ctx);
    assert.equal(h.cluster().workloads['prod/deployment/a'].desired, 2, 'a restaurado');
    assert.equal(h.cluster().workloads['prod/deployment/b'].desired, 3, 'b segue intacto');
    assert.ok(!ctx.logs.some((l) => /Nenhum workload salvo/.test(l)));
  });

  it('ida e volta: stop → start devolve as réplicas originais e o snapshot não é sobrescrito com zeros', async () => {
    const h = await setup({
      nodegroups: { ng1: { min: 1, max: 4, desired: 2 } },
      workloads: { 'prod/deployment/a': wl(2), 'prod/statefulset/c': wl(1) },
    });
    const env = mkEnv();
    const p = createProvider(env, { store: h.store });

    await p.stop(mkCtx());
    assert.deepEqual(
      Object.values(h.cluster().workloads).map((w) => w.desired),
      [0, 0],
    );
    assert.equal(h.cluster().nodegroups.ng1.desired, 0);

    await p.stop(mkCtx()); // 2º "desligar": já está tudo em 0 — não pode apagar a escala salva
    const saved = await h.store.getState(env.id);
    assert.deepEqual(saved.workloads, { 'prod/deployment/a': 2, 'prod/statefulset/c': 1 });
    assert.equal(saved.nodegroups.ng1.desired, 2);

    await p.start(mkCtx());
    assert.equal(h.cluster().nodegroups.ng1.desired, 2);
    assert.equal(h.cluster().workloads['prod/deployment/a'].desired, 2);
    assert.equal(h.cluster().workloads['prod/statefulset/c'].desired, 1);
  });
});
