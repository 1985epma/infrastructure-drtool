// Provider 'k8s' (kubectl), validação, endpoints de descoberta (/api/discover/*) e exercício completo,
// tudo contra binários FALSOS no PATH: test/fake-kubectl.mjs, fake-docker.mjs, fake-aws-discover.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// precisa vir ANTES de importar os módulos (POLL_MS é lido na carga)
process.env.EPMA_POLL_MS = '30';
const { createApp } = await import('../src/app.js');
const { Store } = await import('../src/store.js');
const { createProvider } = await import('../src/providers/index.js');
const { normalizeEnvironment } = await import('../src/validate.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIG_PATH = process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- infraestrutura de teste
let root;
let seq = 0;
const files = {};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'epma-k8s-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const [cmd, script] of [['kubectl', 'fake-kubectl.mjs'], ['docker', 'fake-docker.mjs'], ['aws', 'fake-aws-discover.mjs']]) {
    await writeFile(join(bin, cmd), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, script)}" "$@"\n`, { mode: 0o755 });
  }
  Object.assign(files, {
    kube: join(root, 'kube.json'),
    kubeLog: join(root, 'kube.log'),
    docker: join(root, 'docker.json'),
    dockerLog: join(root, 'docker.log'),
    awsd: join(root, 'awsd.json'),
    awsdLog: join(root, 'awsd.log'),
  });
  process.env.PATH = `${bin}:${ORIG_PATH}`;
  process.env.FAKE_KUBE_STATE = files.kube;
  process.env.FAKE_KUBE_LOG = files.kubeLog;
  process.env.FAKE_DOCKER_STATE = files.docker;
  process.env.FAKE_DOCKER_LOG = files.dockerLog;
  process.env.FAKE_AWSD_STATE = files.awsd;
  process.env.FAKE_AWSD_LOG = files.awsdLog;
});
after(async () => {
  process.env.PATH = ORIG_PATH;
  await rm(root, { recursive: true, force: true });
});

const wl = (desired = 0, ready = desired, current = desired) => ({ desired, ready, current, settle: 0 });
const DEFAULT_WL = () => ({ 'default/deployment/api': wl(2), 'default/statefulset/db': wl(1) });

function resetKube(workloads = DEFAULT_WL(), extra = {}) {
  writeFileSync(files.kube, JSON.stringify({ contexts: ['ctx-a', 'docker-desktop', 'kind-x'], current: 'docker-desktop', ticks: 2, workloads, ...extra }));
  writeFileSync(files.kubeLog, '');
}
const kubeState = () => JSON.parse(readFileSync(files.kube, 'utf8'));
const readLog = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const kubeCalls = (cmd) => readLog(files.kubeLog).filter((c) => !cmd || c.args[0] === cmd);
const scaleCalls = () => kubeCalls('scale');

const setAwsd = (state) => {
  writeFileSync(files.awsd, JSON.stringify(state));
  writeFileSync(files.awsdLog, '');
};
const setDocker = (state) => {
  writeFileSync(files.docker, JSON.stringify(state));
  writeFileSync(files.dockerLog, '');
};

async function mkStore() {
  const store = new Store(join(root, `data-${++seq}`));
  await store.init();
  return store;
}
const WORKLOADS = [
  { namespace: 'default', kind: 'deployment', name: 'api' },
  { namespace: 'default', kind: 'statefulset', name: 'db' },
];
const mkEnv = (k8s = {}, extra = {}) =>
  normalizeEnvironment({ name: 'k8s-test', provider: 'k8s', k8s: { context: 'ctx-a', kubeconfig: '/tmp/kc-test', timeoutSec: 30, workloads: WORKLOADS, ...k8s }, ...extra });
const mkCtx = () => {
  const logs = [];
  return { logs, log: (l, m) => logs.push(`${l}: ${m}`), signal: new AbortController().signal };
};
/** Prepara provider + store com o snapshot do Store observável pelo fake (FAKE_KUBE_STORE_STATE). */
async function mkProvider(env = mkEnv()) {
  const store = await mkStore();
  process.env.FAKE_KUBE_STORE_STATE = join(store.stateDir, `${env.id}.json`);
  return { env, store, provider: createProvider(env, { store }) };
}
const details = (input) => {
  try {
    normalizeEnvironment(input);
  } catch (err) {
    return (err.details ?? [err.message]).join(' | ');
  }
  return '';
};

// ================================================================= (A) provider k8s
describe('provider k8s (kubectl falso)', () => {
  it('status: running / partial / transitioning / stopped', async () => {
    const { provider } = await mkProvider();

    resetKube();
    let st = await provider.status();
    assert.equal(st.state, 'running');
    assert.equal(st.cluster.name, 'ctx-a');
    assert.deepEqual(st.workloads.map((w) => [w.name, w.desired, w.ready]), [['api', 2, 2], ['db', 1, 1]]);

    resetKube({ 'default/deployment/api': wl(0), 'default/statefulset/db': wl(1) });
    assert.equal((await provider.status()).state, 'partial');

    resetKube({ 'default/deployment/api': wl(2, 0, 2), 'default/statefulset/db': wl(1) });
    assert.equal((await provider.status()).state, 'transitioning');

    resetKube({ 'default/deployment/api': wl(0), 'default/statefulset/db': wl(0) });
    assert.equal((await provider.status()).state, 'stopped');
  });

  it('status: workload inexistente → error com nota; cluster inacessível → error; contexto inexistente → error', async () => {
    resetKube();
    const ghost = await mkProvider(mkEnv({ workloads: [...WORKLOADS, { namespace: 'default', kind: 'deployment', name: 'ghost' }] }));
    const st = await ghost.provider.status();
    assert.equal(st.state, 'error');
    assert.match(st.note, /ghost/);
    assert.match(st.note, /não encontrado/);

    resetKube(DEFAULT_WL(), { unreachable: true });
    const down = await (await mkProvider()).provider.status();
    assert.equal(down.state, 'error');
    assert.match(down.note, /Não foi possível consultar o cluster \(ctx-a\)/);

    resetKube();
    const noCtx = await (await mkProvider(mkEnv({ context: 'nope' }))).provider.status();
    assert.equal(noCtx.state, 'error');
    assert.match(noCtx.note, /does not exist/);
  });

  it('stop: grava as réplicas originais ANTES de escalar e espera chegar a 0', async () => {
    resetKube();
    const { env, store, provider } = await mkProvider();
    const ctx = mkCtx();
    await provider.stop(ctx);

    const saved = (await store.getState(env.id)).k8s;
    assert.deepEqual(saved.replicas, { 'default/deployment/api': 2, 'default/statefulset/db': 1 });
    assert.ok(saved.savedAt);

    // no instante do 1º `scale` o snapshot já estava em disco
    const scales = scaleCalls();
    assert.equal(scales.length, 2);
    assert.deepEqual(scales[0].storeState.k8s.replicas, { 'default/deployment/api': 2, 'default/statefulset/db': 1 });
    assert.ok(scales.every((c) => c.args.includes('--replicas=0')));

    // só retornou depois das réplicas realmente a 0 (convergência exige >1 leitura)
    const s = kubeState().workloads;
    assert.equal(s['default/deployment/api'].current, 0);
    assert.equal(s['default/statefulset/db'].current, 0);
    assert.match(ctx.logs.join('\n'), /Workloads desligados/);
  });

  it('stop duas vezes: não sobrescreve o snapshot com zeros e não escala de novo', async () => {
    resetKube();
    const { env, store, provider } = await mkProvider();
    await provider.stop(mkCtx());
    const first = (await store.getState(env.id)).k8s.replicas;
    const callsAfterFirst = scaleCalls().length;

    const ctx = mkCtx();
    await provider.stop(ctx);
    assert.deepEqual((await store.getState(env.id)).k8s.replicas, first);
    assert.deepEqual(first, { 'default/deployment/api': 2, 'default/statefulset/db': 1 });
    assert.equal(scaleCalls().length, callsAfterFirst, 'não deveria escalar workloads que já estão em 0');
    assert.match(ctx.logs.join('\n'), /já está em 0/);
  });

  it('start: restaura a escala do snapshot, espera ficar pronto e é idempotente', async () => {
    resetKube({ 'default/deployment/api': wl(0), 'default/statefulset/db': wl(0) });
    const { env, store, provider } = await mkProvider();
    await store.updateState(env.id, (s) => ((s.k8s = { replicas: { 'default/deployment/api': 3, 'default/statefulset/db': 2 } }), s));

    const ctx = mkCtx();
    await provider.start(ctx);
    const s = kubeState().workloads;
    assert.deepEqual([s['default/deployment/api'].desired, s['default/deployment/api'].ready], [3, 3]);
    assert.deepEqual([s['default/statefulset/db'].desired, s['default/statefulset/db'].ready], [2, 2]);
    assert.deepEqual(scaleCalls().map((c) => c.args.find((a) => a.startsWith('--replicas=')).split('=')[1]).sort(), ['2', '3']);
    assert.match(ctx.logs.join('\n'), /religados e prontos/);

    const before = scaleCalls().length;
    const again = mkCtx();
    await provider.start(again);
    assert.equal(scaleCalls().length, before, 'start idempotente não deve escalar de novo');
    assert.match(again.logs.join('\n'), /já está com 3 réplica/);
  });

  it('start sem snapshot: usa 1 réplica e avisa', async () => {
    resetKube({ 'default/deployment/api': wl(0), 'default/statefulset/db': wl(0) });
    const { provider } = await mkProvider();
    const ctx = mkCtx();
    await provider.start(ctx);
    const s = kubeState().workloads;
    assert.equal(s['default/deployment/api'].ready, 1);
    assert.equal(s['default/statefulset/db'].ready, 1);
    assert.match(ctx.logs.join('\n'), /warn: default\/deployment\/api: sem escala salva — usando 1 réplica/);
  });

  it('ida e volta: stop → start devolve a escala original (e o snapshot permanece)', async () => {
    resetKube();
    const { env, store, provider } = await mkProvider();
    await provider.stop(mkCtx());
    await provider.start(mkCtx());
    const s = kubeState().workloads;
    assert.deepEqual([s['default/deployment/api'].ready, s['default/statefulset/db'].ready], [2, 1]);
    assert.equal((await provider.status()).state, 'running');
    assert.deepEqual((await store.getState(env.id)).k8s.replicas, { 'default/deployment/api': 2, 'default/statefulset/db': 1 });
  });

  it('todas as chamadas usam --context/--kubeconfig; kube() devolve os mesmos args', async () => {
    resetKube();
    const { provider } = await mkProvider();
    await provider.status();
    await provider.stop(mkCtx());
    await provider.start(mkCtx());
    const calls = kubeCalls();
    assert.ok(calls.length > 6);
    for (const c of calls) {
      assert.equal(c.globals.context, 'ctx-a', JSON.stringify(c.argv));
      assert.equal(c.globals.kubeconfig, '/tmp/kc-test', JSON.stringify(c.argv));
    }
    assert.deepEqual((await provider.kube()).args, ['--kubeconfig', '/tmp/kc-test', '--context', 'ctx-a']);

    // sem kubeconfig: só --context
    const noKc = await mkProvider(mkEnv({ kubeconfig: '' }));
    assert.deepEqual((await noKc.provider.kube()).args, ['--context', 'ctx-a']);
  });
});

// ================================================================= (B) validação
describe('validação do provider k8s', () => {
  const base = (k8s) => ({ name: 'x', provider: 'k8s', k8s });

  it('aceita strings "ns/tipo/nome" e objetos, e normaliza', () => {
    const env = normalizeEnvironment(base({ context: 'ctx-a', workloads: ['prod/deployment/api', { namespace: 'prod', kind: 'statefulset', name: 'db' }] }));
    assert.deepEqual(env.k8s.workloads, [
      { namespace: 'prod', kind: 'deployment', name: 'api' },
      { namespace: 'prod', kind: 'statefulset', name: 'db' },
    ]);
    assert.equal(env.k8s.timeoutSec, 300);
    assert.equal(env.k8s.kubeconfig, '');
    // texto separado por espaço/vírgula/quebra de linha
    const txt = normalizeEnvironment(base({ context: 'ctx-a', workloads: 'a/deployment/x, b/statefulset/y\nc/deployment/z' }));
    assert.equal(txt.k8s.workloads.length, 3);
  });

  it('exige contexto e ao menos um workload', () => {
    assert.match(details(base({ workloads: ['a/deployment/x'] })), /k8s\.context/);
    assert.match(details(base({ context: 'ctx-a', workloads: [] })), /k8s\.workloads: informe ao menos um workload/);
    assert.match(details(base({ context: 'ctx-a' })), /k8s\.workloads/);
  });

  it('rejeita contexto, nome, namespace e tipo inválidos', () => {
    assert.match(details(base({ context: 'ctx a', workloads: ['a/deployment/x'] })), /contexto inválido/);
    assert.match(details(base({ context: 'c;rm', workloads: ['a/deployment/x'] })), /contexto inválido/);
    assert.match(details(base({ context: 'ctx', workloads: ['a/deployment/Api'] })), /workloads\[0\]\.name/);
    assert.match(details(base({ context: 'ctx', workloads: ['A_B/deployment/api'] })), /workloads\[0\]\.namespace/);
    assert.match(details(base({ context: 'ctx', workloads: ['a/StatefulSet/api'] })), /workloads\[0\]\.kind/);
    assert.match(details(base({ context: 'ctx', workloads: ['a/daemonset/api'] })), /workloads\[0\]\.kind/);
    assert.match(details(base({ context: 'ctx', workloads: ['só-dois/campos'] })), /workloads\[0\]\./);
  });

  it('respeita os limites (200 workloads, timeout 30..3600)', () => {
    const many = Array.from({ length: 201 }, (_, i) => `ns/deployment/w${i}`);
    assert.match(details(base({ context: 'ctx', workloads: many })), /máximo de 200 workloads/);
    const exactly = Array.from({ length: 200 }, (_, i) => `ns/deployment/w${i}`);
    assert.equal(details(base({ context: 'ctx', workloads: exactly })), '');
    assert.match(details(base({ context: 'ctx', workloads: ['a/deployment/x'], timeoutSec: 10 })), /k8s\.timeoutSec/);
    assert.match(details(base({ context: 'ctx', workloads: ['a/deployment/x'], timeoutSec: 4000 })), /k8s\.timeoutSec/);
    assert.equal(details(base({ context: 'ctx', workloads: ['a/deployment/x'], timeoutSec: 3600 })), '');
  });

  it('outros providers não exigem k8s (objeto vazio normalizado)', () => {
    const env = normalizeEnvironment({ name: 'x', provider: 'simulated' });
    assert.deepEqual(env.k8s.workloads, []);
    assert.equal(env.k8s.context, '');
  });
});

// ================================================================= (C) descoberta
describe('endpoints /api/discover/*', () => {
  let app;
  let base;
  let dir;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  before(async () => {
    dir = await mkdtemp(join(root, 'app-'));
    app = await createApp({ dataDir: dir, port: 0 });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => app.close());

  it('tools', async () => {
    setAwsd({});
    setDocker({ containers: [] });
    resetKube();
    const { status, data } = await get('/api/discover/tools');
    assert.equal(status, 200);
    assert.equal(data.aws.ok, true);
    assert.match(data.aws.version, /aws-cli/);
    assert.match(data.kubectl.version, /Client Version/);
    assert.match(data.docker.version, /Docker version/);
  });

  it('aws/profiles lista perfis com a região (vazia quando não configurada)', async () => {
    setAwsd({ profiles: { default: 'us-east-1', 'epma-prd': '' } });
    const { status, data } = await get('/api/discover/aws/profiles');
    assert.equal(status, 200);
    assert.deepEqual(data.profiles, [{ name: 'default', region: 'us-east-1' }, { name: 'epma-prd', region: '' }]);
    assert.equal(typeof data.defaultRegion, 'string');
  });

  it('aws/identity: sucesso usa o perfil; credencial expirada → 422 com mensagem útil', async () => {
    setAwsd({});
    const ok = await get('/api/discover/aws/identity?profile=epma-prd&region=us-east-1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { account: '123456789012', arn: 'arn:aws:iam::123456789012:user/tester' });
    const call = readLog(files.awsdLog).find((c) => c.argv[0] === 'sts');
    assert.equal(call.env.AWS_PROFILE, 'epma-prd');

    setAwsd({ identityError: { code: 'ExpiredToken', message: 'The security token included in the request is expired' } });
    const bad = await get('/api/discover/aws/identity?profile=epma-prd');
    assert.equal(bad.status, 422);
    assert.match(bad.data.error, /expired|credenciais/i);
    assert.match(bad.data.error, /aws sso login --profile epma-prd/);
  });

  it('eks: clusters com node groups', async () => {
    setAwsd({
      eks: {
        alpha: { version: '1.31', status: 'ACTIVE', nodegroups: { 'ng-apps': { status: 'ACTIVE', desired: 3, min: 1, max: 6, instanceTypes: ['m5.large'] }, 'ng-sys': { status: 'UPDATING', desired: 0, min: 0, max: 2, instanceTypes: ['t3.medium'] } } },
        beta: { version: '1.30', status: 'ACTIVE', nodegroups: {} },
      },
    });
    const { status, data } = await get('/api/discover/eks?profile=default&region=us-east-1');
    assert.equal(status, 200);
    assert.deepEqual(data.clusters.map((c) => c.name), ['alpha', 'beta']);
    const alpha = data.clusters[0];
    assert.equal(alpha.version, '1.31');
    assert.deepEqual(alpha.nodegroups.find((g) => g.name === 'ng-apps'), { name: 'ng-apps', status: 'ACTIVE', desired: 3, min: 1, max: 6, instanceTypes: ['m5.large'] });
    assert.equal(alpha.nodegroups.find((g) => g.name === 'ng-sys').status, 'UPDATING');
    assert.deepEqual(data.clusters[1].nodegroups, []);
    // região repassada à CLI
    assert.ok(readLog(files.awsdLog).some((c) => c.argv[0] === 'eks' && c.argv.includes('--region') && c.argv.includes('us-east-1')));
  });

  it('ec2: Spot e Auto Scaling vêm com skip; ordenado por nome/id', async () => {
    const i = (id, extra = {}, tags = []) => ({ InstanceId: id, InstanceType: 't3.micro', State: { Name: 'running' }, PrivateIpAddress: '10.0.0.1', Tags: tags, ...extra });
    setAwsd({
      ec2: {
        Reservations: [
          { Instances: [i('i-0000000000000001', {}, [{ Key: 'Name', Value: 'zeta' }]), i('i-0000000000000002', { InstanceLifecycle: 'spot' }, [{ Key: 'Name', Value: 'beta-spot' }])] },
          { Instances: [i('i-0000000000000003', {}, [{ Key: 'aws:autoscaling:groupName', Value: 'asg-web' }, { Key: 'Name', Value: 'asg-node' }]), i('i-0000000000000004', { PublicIpAddress: '3.3.3.3' }, [{ Key: 'Name', Value: 'alpha' }]), i('i-0000000000000000')] },
        ],
      },
    });
    const { status, data } = await get('/api/discover/ec2?region=us-east-1');
    assert.equal(status, 200);
    assert.deepEqual(data.instances.map((x) => x.name || x.id), ['alpha', 'asg-node', 'beta-spot', 'i-0000000000000000', 'zeta']);
    const by = Object.fromEntries(data.instances.map((x) => [x.id, x]));
    assert.match(by['i-0000000000000002'].skip, /Spot/);
    assert.equal(by['i-0000000000000002'].spot, true);
    assert.match(by['i-0000000000000003'].skip, /Auto Scaling "asg-web"/);
    assert.equal(by['i-0000000000000003'].asg, 'asg-web');
    assert.equal(by['i-0000000000000004'].skip, null);
    assert.equal(by['i-0000000000000004'].publicIp, '3.3.3.3');
  });

  it('rds: membro de cluster e réplica com skip; clusters Aurora', async () => {
    setAwsd({
      rdsInstances: [
        { DBInstanceIdentifier: 'solo', Engine: 'postgres', DBInstanceStatus: 'available', DBInstanceClass: 'db.t3.micro', MultiAZ: true, Endpoint: { Address: 'solo.x.rds.amazonaws.com', Port: 5432 } },
        { DBInstanceIdentifier: 'aurora-1', Engine: 'aurora-postgresql', DBInstanceStatus: 'available', DBInstanceClass: 'db.r5.large', DBClusterIdentifier: 'aurora' },
        { DBInstanceIdentifier: 'solo-replica', Engine: 'postgres', DBInstanceStatus: 'available', DBInstanceClass: 'db.t3.micro', ReadReplicaSourceDBInstanceIdentifier: 'solo' },
      ],
      rdsClusters: [{ DBClusterIdentifier: 'aurora', Engine: 'aurora-postgresql', Status: 'available', Endpoint: 'aurora.cluster-x.rds.amazonaws.com', Port: 5432 }],
    });
    const { status, data } = await get('/api/discover/rds?region=us-east-1');
    assert.equal(status, 200);
    const by = Object.fromEntries(data.instances.map((x) => [x.id, x]));
    assert.equal(by.solo.skip, null);
    assert.deepEqual([by.solo.endpoint, by.solo.port, by.solo.multiAz, by.solo.class], ['solo.x.rds.amazonaws.com', 5432, true, 'db.t3.micro']);
    assert.match(by['aurora-1'].skip, /membro do cluster Aurora "aurora"/);
    assert.match(by['solo-replica'].skip, /réplica de leitura/);
    assert.equal(by['solo-replica'].replica, 'solo');
    assert.deepEqual(data.clusters, [{ id: 'aurora', engine: 'aurora-postgresql', status: 'available', endpoint: 'aurora.cluster-x.rds.amazonaws.com', port: 5432 }]);
  });

  it('elasticache: AUTH token / Global Datastore / Memcached serverless com skip', async () => {
    setAwsd({
      rg: [
        { ReplicationGroupId: 'ok-rg', Status: 'available', Engine: 'valkey', CacheNodeType: 'cache.t3.micro' },
        { ReplicationGroupId: 'auth-rg', Status: 'available', CacheNodeType: 'cache.t3.micro', AuthTokenEnabled: true },
        { ReplicationGroupId: 'global-rg', Status: 'available', CacheNodeType: 'cache.r5.large', GlobalReplicationGroupInfo: { GlobalReplicationGroupId: 'g-1' } },
      ],
      sv: [
        { ServerlessCacheName: 'sv-valkey', Status: 'available', Engine: 'valkey' },
        { ServerlessCacheName: 'sv-mem', Status: 'available', Engine: 'memcached' },
      ],
    });
    const { status, data } = await get('/api/discover/elasticache?region=us-east-1');
    assert.equal(status, 200);
    const rg = Object.fromEntries(data.replicationGroups.map((x) => [x.id, x]));
    assert.equal(rg['ok-rg'].skip, null);
    assert.equal(rg['ok-rg'].engine, 'valkey');
    assert.equal(rg['auth-rg'].engine, 'redis', 'engine ausente assume redis');
    assert.match(rg['auth-rg'].skip, /AUTH token/);
    assert.match(rg['global-rg'].skip, /Global Datastore/);
    const sv = Object.fromEntries(data.serverless.map((x) => [x.id, x]));
    assert.equal(sv['sv-valkey'].skip, null);
    assert.match(sv['sv-mem'].skip, /Memcached/);
    assert.deepEqual(data.warnings, []);
  });

  it('elasticache: falha parcial vira warnings; falha total → 422', async () => {
    setAwsd({ rg: [{ ReplicationGroupId: 'only', Status: 'available', CacheNodeType: 'cache.t3.micro' }], svError: { code: 'AccessDeniedException', message: 'not authorized to perform: elasticache:DescribeServerlessCaches' } });
    const partial = await get('/api/discover/elasticache?region=us-east-1');
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.data.replicationGroups.map((x) => x.id), ['only']);
    assert.deepEqual(partial.data.serverless, []);
    assert.equal(partial.data.warnings.length, 1);
    assert.match(partial.data.warnings[0], /DescribeServerlessCaches/);

    setAwsd({ rgError: { code: 'AccessDeniedException', message: 'nope rg' }, svError: { code: 'AccessDeniedException', message: 'nope sv' } });
    const total = await get('/api/discover/elasticache?region=us-east-1');
    assert.equal(total.status, 422);
    assert.match(total.data.error, /nope/);
  });

  it('k8s/contexts e k8s/workloads (deployments + statefulsets)', async () => {
    resetKube({
      'kube-system/deployment/coredns': wl(2),
      'shop/statefulset/db': wl(1, 0, 1),
      'shop/deployment/web': wl(3),
      'shop/daemonset/agent': wl(1), // não deve aparecer
    });
    const ctxs = await get('/api/discover/k8s/contexts');
    assert.equal(ctxs.status, 200);
    assert.equal(ctxs.data.current, 'docker-desktop');
    assert.deepEqual(ctxs.data.contexts, [
      { name: 'ctx-a', dockerDesktop: false },
      { name: 'docker-desktop', dockerDesktop: true },
      { name: 'kind-x', dockerDesktop: false },
    ]);

    const w = await get('/api/discover/k8s/workloads?context=docker-desktop');
    assert.equal(w.status, 200);
    assert.deepEqual(w.data.workloads, [
      { namespace: 'kube-system', kind: 'deployment', name: 'coredns', replicas: 2, ready: 2 },
      { namespace: 'shop', kind: 'statefulset', name: 'db', replicas: 1, ready: 0 },
      { namespace: 'shop', kind: 'deployment', name: 'web', replicas: 3, ready: 3 },
    ]);
    const call = kubeCalls('get').at(-1);
    assert.equal(call.globals.context, 'docker-desktop');

    // contexto que não existe no kubeconfig → 422 com a mensagem do kubectl
    const bad = await get('/api/discover/k8s/workloads?context=ghost-ctx');
    assert.equal(bad.status, 422);
    assert.match(bad.data.error, /does not exist/);
  });

  it('docker/containers classifica redis / postgres / mysql / other', async () => {
    const c = (Names, Image) => ({ Names, Image, Status: 'Up 2 hours', State: 'running', Ports: '0.0.0.0:1->1/tcp' });
    setDocker({ containers: [c('cache', 'redis:7-alpine'), c('cache2', 'valkey/valkey:8'), c('db', 'postgres:16-alpine'), c('maria,alias', 'mariadb:11'), c('mysqld', 'mysql:8'), c('web', 'nginx:1.27')] });
    const { status, data } = await get('/api/discover/docker/containers');
    assert.equal(status, 200);
    assert.deepEqual(data.containers.map((x) => [x.name, x.kind]), [['cache', 'redis'], ['cache2', 'redis'], ['db', 'postgres'], ['maria', 'mysql'], ['mysqld', 'mysql'], ['web', 'other']]);
    assert.equal(data.containers[0].image, 'redis:7-alpine');
    assert.equal(data.containers[0].status, 'Up 2 hours');

    setDocker({ fail: 'Cannot connect to the Docker daemon' });
    const down = await get('/api/discover/docker/containers');
    assert.equal(down.status, 422);
    assert.match(down.data.error, /Docker daemon/);
  });

  it('parâmetros inválidos → 400 e NENHUM comando é executado', async () => {
    setAwsd({});
    resetKube();
    setDocker({ containers: [] });
    const bad = [
      '/api/discover/aws/identity?profile=a;b',
      '/api/discover/aws/identity?profile=$(id)',
      '/api/discover/aws/identity?profile=ok&region=XX',
      '/api/discover/eks?region=us-east-1;rm',
      '/api/discover/ec2?profile=a%20b',
      '/api/discover/rds?region=nowhere',
      '/api/discover/elasticache?profile=a|b',
      '/api/discover/k8s/workloads?context=x%20y',
      '/api/discover/k8s/workloads?context=a;b',
      '/api/discover/k8s/workloads',
    ];
    for (const path of bad) {
      const r = await get(path);
      assert.equal(r.status, 400, path);
      assert.ok(r.data.error, path);
    }
    assert.equal(readLog(files.awsdLog).length, 0, 'aws não deveria ter sido chamado');
    assert.equal(readLog(files.kubeLog).length, 0, 'kubectl não deveria ter sido chamado');
    assert.equal(readLog(files.dockerLog).length, 0, 'docker não deveria ter sido chamado');
  });
});

// ================================================================= (D) exercício completo
describe('exercício completo com provider k8s', () => {
  let app;
  let base;
  let web;
  let webPort;
  let dir;
  const json = async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
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
    // "aplicação": responde 200 só enquanto o kubectl falso tem réplicas prontas do deployment api
    web = http.createServer((req, res) => {
      let up = false;
      try {
        up = JSON.parse(readFileSync(files.kube, 'utf8')).workloads['default/deployment/api'].ready > 0;
      } catch {
        /* leitura concorrente com escrita do fake */
      }
      res.writeHead(up ? 200 : 503);
      res.end(up ? 'ok' : 'down');
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    webPort = web.address().port;
    dir = await mkdtemp(join(root, 'drill-'));
    app = await createApp({ dataDir: dir, port: 0 });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await app.close();
    web.closeAllConnections?.();
    await new Promise((r) => web.close(r));
  });

  it('desliga, mede o RTO, religa e gera relatório (veredito aprovado)', { timeout: 120_000 }, async () => {
    resetKube({ 'default/deployment/api': wl(2), 'default/statefulset/db': wl(1) }, { ticks: 2 });
    const name = 'drill-k8s';
    const created = await json('/api/environments', {
      method: 'POST',
      body: {
        name,
        provider: 'k8s',
        k8s: { context: 'ctx-a', timeoutSec: 60, workloads: WORKLOADS },
        checks: [
          { name: 'HTTP da aplicação', type: 'http', url: `http://127.0.0.1:${webPort}/health`, expectStatus: '200', timeoutMs: 1500 },
          { name: 'Deployment api (k8s)', type: 'k8s', kind: 'deployment', namespace: 'default', resource: 'api' },
        ],
        rpoSource: { type: 'none' },
        targets: { rtoSeconds: 120, rpoSeconds: 60 },
        drill: { holdDownSeconds: 1, probeIntervalSeconds: 1, stableProbes: 2, maxRecoverySeconds: 60 },
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const env = created.data;

    // ambiente não simulado exige confirmação pelo nome
    const noConfirm = await json(`/api/environments/${env.id}/drill`, { method: 'POST', body: {} });
    assert.equal(noConfirm.status, 400);

    const st = await json(`/api/environments/${env.id}/status`);
    assert.equal(st.data.state, 'running');
    assert.equal(st.data.workloads.length, 2);

    const start = await json(`/api/environments/${env.id}/drill`, { method: 'POST', body: { confirm: name } });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    let job;
    for (let i = 0; i < 220; i++) {
      job = (await json('/api/job')).data;
      if (job.status !== 'running') break;
      await sleep(500);
    }
    assert.equal(job.status, 'succeeded', job.error);

    const runs = (await json(`/api/runs?envId=${env.id}`)).data;
    assert.equal(runs.length, 1);
    const run = (await json(`/api/runs/${runs[0].id}`)).data;
    assert.equal(run.kind, 'drill');
    assert.equal(run.env.provider, 'k8s');
    assert.equal(run.env.clusterName, 'ctx-a');
    assert.equal(run.status, 'completed');
    assert.equal(run.evaluation.verdict, 'approved', JSON.stringify(run.evaluation));
    assert.ok(run.metrics.rtoSec > 0, `rto=${run.metrics.rtoSec}`);
    assert.ok(run.timestamps.detectedAt, 'a indisponibilidade deveria ter sido detectada');
    assert.ok(run.outages.length >= 1);

    // ambiente religado no fim, com a escala original
    const s = kubeState().workloads;
    assert.deepEqual([s['default/deployment/api'].desired, s['default/deployment/api'].ready], [2, 2]);
    assert.deepEqual([s['default/statefulset/db'].desired, s['default/statefulset/db'].ready], [1, 1]);
    assert.equal((await json(`/api/environments/${env.id}/status`)).data.state, 'running');
    assert.ok(scaleCalls().some((c) => c.args.includes('--replicas=0')));

    const html = (await json(`/api/runs/${run.id}/report.html`)).data;
    assert.match(html, /Kubernetes \(kubectl\)/);
    assert.match(html, /ctx-a/);
  });
});
