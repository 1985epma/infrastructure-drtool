// Testes dos recursos AWS (EC2 / RDS / ElastiCache) contra um `aws` CLI FALSO (test/fake-aws.mjs).
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// precisa vir ANTES de importar os módulos (POLL_MS é lido na carga)
process.env.EPMA_POLL_MS = '30';
const { createApp } = await import('../src/app.js');
const { Store } = await import('../src/store.js');
const { createProvider } = await import('../src/providers/index.js');
const { buildCreateReplicationGroupArgs, buildCreateServerlessArgs } = await import('../src/providers/aws-resources.js');
const { combineStates } = await import('../src/providers/with-resources.js');
const { normalizeEnvironment } = await import('../src/validate.js');

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-aws.mjs');
const ORIG_PATH = process.env.PATH;
const dirs = [];
after(async () => {
  process.env.PATH = ORIG_PATH;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- infraestrutura de teste
async function setup(state = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'epma-aws-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'calls.log');
  await writeFile(stateFile, JSON.stringify({ ticks: 2, ...state }));
  await writeFile(logFile, '');
  process.env.PATH = `${bin}:${ORIG_PATH}`;
  process.env.FAKE_AWS_STATE = stateFile;
  process.env.FAKE_AWS_LOG = logFile;
  delete process.env.FAKE_AWS_STORE_STATE;
  const store = new Store(join(dir, 'data'));
  await store.init();
  const h = {
    dir,
    store,
    stateFile,
    logFile,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    patch(fn) {
      const s = h.state();
      fn(s);
      writeFileSync(stateFile, JSON.stringify(s));
    },
    calls: (op) =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((c) => !op || c.op === op),
    watch(env) {
      process.env.FAKE_AWS_STORE_STATE = join(store.stateDir, `${env.id}.json`);
    },
  };
  return h;
}

const mkEnv = (resources, extra = {}) => normalizeEnvironment({ name: 'dr-test', provider: 'aws', resources: { region: 'us-east-1', ...resources }, ...extra });
const mkCtx = () => {
  const logs = [];
  return { logs, log: (l, m) => logs.push(`${l}: ${m}`), signal: new AbortController().signal };
};
const flagValue = (args, name) => args[args.indexOf(name) + 1];

// ---------------------------------------------------------------- fixtures
const inst = (id, state = 'running', tags = [], extra = {}) => ({ InstanceId: id, InstanceType: 't3.micro', State: { Code: state === 'running' ? 16 : 80, Name: state }, Tags: tags, ...extra });
const ec2State = (...list) => Object.fromEntries(list.map((i) => [i.InstanceId, i]));

const ARN_RG = (id) => `arn:aws:elasticache:us-east-1:123456789012:replicationgroup:${id}`;
function rgFixture(id, o = {}) {
  const mk = (n) => ({
    NodeGroupId: `000${n}`,
    Status: 'available',
    NodeGroupMembers: [
      { CacheClusterId: `${id}-000${n}-001`, PreferredAvailabilityZone: 'us-east-1a', CurrentRole: 'primary' },
      { CacheClusterId: `${id}-000${n}-002`, PreferredAvailabilityZone: 'us-east-1b', CurrentRole: 'replica' },
    ],
  });
  return {
    ReplicationGroupId: id,
    Description: 'cache de teste',
    Status: 'available',
    ClusterEnabled: true,
    CacheNodeType: 'cache.r6g.large',
    AutomaticFailover: 'enabled',
    MultiAZ: 'enabled',
    AuthTokenEnabled: false,
    TransitEncryptionEnabled: true,
    AtRestEncryptionEnabled: true,
    KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
    SnapshotRetentionLimit: 5,
    SnapshotWindow: '03:00-04:00',
    ARN: ARN_RG(id),
    MemberClusters: [`${id}-0001-001`, `${id}-0001-002`, `${id}-0002-001`, `${id}-0002-002`],
    NodeGroups: [mk(1), mk(2)],
    ConfigurationEndpoint: { Address: `${id}.abc123.clustercfg.use1.cache.amazonaws.com`, Port: 6379 },
    ...o,
  };
}
const ccFixture = () => ({
  CacheClusterId: 'cache-a-0001-001',
  Engine: 'valkey',
  EngineVersion: '7.2.6',
  CacheSubnetGroupName: 'subnet-g',
  SecurityGroups: [
    { SecurityGroupId: 'sg-1', Status: 'active' },
    { SecurityGroupId: 'sg-2', Status: 'active' },
  ],
  CacheParameterGroup: { CacheParameterGroupName: 'default.valkey7.cluster.on' },
  PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
});
const cacheState = (id = 'cache-a', rgOver = {}, extra = {}) => ({
  elasticache: {
    rgs: { [id]: rgFixture(id, rgOver) },
    cacheClusters: { [`${id}-0001-001`]: { ...ccFixture(), CacheClusterId: `${id}-0001-001` } },
    tags: {
      [ARN_RG(id)]: [
        { Key: 'app', Value: 'x' },
        { Key: 'aws:cloudformation:stack-name', Value: 's' },
      ],
    },
    snapshots: {},
    serverless: {},
    creates: [],
    ...extra,
  },
});

const SV_ARN = 'arn:aws:elasticache:us-east-1:123456789012:serverlesscache:cache-sv';
const svFixture = (o = {}) => ({
  ServerlessCacheName: 'cache-sv',
  Status: 'available',
  Engine: 'valkey',
  MajorEngineVersion: '7',
  Description: 'sv de teste',
  SubnetIds: ['subnet-1', 'subnet-2'],
  SecurityGroupIds: ['sg-9'],
  CacheUsageLimits: { DataStorage: { Maximum: 10, Unit: 'GB' }, ECPUPerSecond: { Maximum: 5000 } },
  SnapshotRetentionLimit: 1,
  DailySnapshotTime: '04:00',
  ARN: SV_ARN,
  Endpoint: { Address: 'cache-sv.xxx.serverless.use1.cache.amazonaws.com', Port: 6379 },
  ...o,
});

// ================================================================= (1) EC2
describe('EC2', () => {
  const fixture = () =>
    ec2State(
      inst('i-0aaa1111', 'running', [{ Key: 'Name', Value: 'web' }]),
      inst('i-0bbb2222', 'running', [{ Key: 'Env', Value: 'dr' }]),
      inst('i-0ccc3333', 'running', [{ Key: 'Env', Value: 'dr' }], { InstanceLifecycle: 'spot' }),
      inst('i-0ddd4444', 'running', [
        { Key: 'Env', Value: 'dr' },
        { Key: 'aws:autoscaling:groupName', Value: 'asg-1' },
      ]),
      inst('i-0eee5555', 'stopped', [{ Key: 'Env', Value: 'dr' }]),
    );

  it('seleciona por IDs e por tag, ignora Spot e Auto Scaling, e é idempotente', async () => {
    const h = await setup({ ec2: fixture() });
    const env = mkEnv({ ec2: { instanceIds: ['i-0aaa1111'], tagKey: 'Env', tagValue: 'dr' } });
    const p = createProvider(env, { store: h.store });
    const ctx = mkCtx();

    let st = await p.status({});
    assert.equal(st.state, 'partial'); // 0eee5555 está parada, o resto rodando
    assert.equal(st.resources.filter((r) => r.ignored).length, 2);

    await p.stop(ctx);
    const stops = h.calls('stop-instances');
    assert.equal(stops.length, 1);
    const stopped = stops[0].argv.slice(stops[0].argv.indexOf('--instance-ids') + 1).filter((a) => a.startsWith('i-'));
    assert.deepEqual(stopped.sort(), ['i-0aaa1111', 'i-0bbb2222']);
    const s = h.state().ec2;
    assert.equal(s['i-0aaa1111'].State.Name, 'stopped');
    assert.equal(s['i-0bbb2222'].State.Name, 'stopped');
    assert.equal(s['i-0ccc3333'].State.Name, 'running', 'Spot não deve ser tocada');
    assert.equal(s['i-0ddd4444'].State.Name, 'running', 'membro de ASG não deve ser tocado');
    assert.ok(ctx.logs.some((l) => /Spot/.test(l)));
    assert.ok(ctx.logs.some((l) => /Auto Scaling/.test(l)));

    await p.stop(ctx); // 2ª vez: nada a fazer
    assert.equal(h.calls('stop-instances').length, 1);
    st = await p.status({});
    assert.equal(st.state, 'stopped', 'recursos ignorados não contam no estado');

    await p.start(ctx);
    const starts = h.calls('start-instances');
    assert.equal(starts.length, 1);
    const started = starts[0].argv.filter((a) => a.startsWith('i-'));
    assert.deepEqual(started.sort(), ['i-0aaa1111', 'i-0bbb2222', 'i-0eee5555']); // conjunto configurado tratado como um todo
    assert.equal(h.state().ec2['i-0aaa1111'].State.Name, 'running');
    await p.start(ctx);
    assert.equal(h.calls('start-instances').length, 1);
    assert.equal((await p.status({})).state, 'running');
  });

  it('nunca chama stop/start em estado inválido (o fake rejeitaria)', async () => {
    const h = await setup({ ec2: ec2State(inst('i-0aaa1111', 'running')) });
    const p = createProvider(mkEnv({ ec2: { instanceIds: ['i-0aaa1111'] } }), { store: h.store });
    await p.stop(mkCtx());
    await p.stop(mkCtx());
    await p.start(mkCtx());
    assert.equal(h.calls().filter((c) => c.error).length, 0);
  });
});

// ================================================================= (2) RDS
describe('RDS / Aurora', () => {
  const fixture = () => ({
    rds: {
      instances: {
        'db-main': { DBInstanceIdentifier: 'db-main', DBInstanceStatus: 'available', Engine: 'postgres' },
        'db-aur-1': { DBInstanceIdentifier: 'db-aur-1', DBInstanceStatus: 'available', Engine: 'aurora-postgresql', DBClusterIdentifier: 'aur-c' },
        'db-rep': { DBInstanceIdentifier: 'db-rep', DBInstanceStatus: 'available', Engine: 'postgres', ReadReplicaSourceDBInstanceIdentifier: 'db-main' },
      },
      clusters: { 'aur-c': { DBClusterIdentifier: 'aur-c', Status: 'available', Engine: 'aurora-postgresql' } },
    },
  });

  it('para/liga instância e cluster Aurora; ignora membro de cluster e réplica', async () => {
    const h = await setup(fixture());
    const env = mkEnv({ rds: { instances: ['db-main', 'db-aur-1', 'db-rep'], clusters: ['aur-c'] } });
    const p = createProvider(env, { store: h.store });
    const ctx = mkCtx();

    let st = await p.status({});
    assert.equal(st.state, 'running');
    assert.deepEqual(st.resources.filter((r) => r.ignored).map((r) => r.id).sort(), ['db-aur-1', 'db-rep']);

    await p.stop(ctx);
    assert.equal(h.calls('stop-db-instance').length, 1);
    assert.equal(flagValue(h.calls('stop-db-instance')[0].argv, '--db-instance-identifier'), 'db-main');
    assert.equal(flagValue(h.calls('stop-db-cluster')[0].argv, '--db-cluster-identifier'), 'aur-c');
    const s = h.state().rds;
    assert.equal(s.instances['db-main'].DBInstanceStatus, 'stopped');
    assert.equal(s.clusters['aur-c'].Status, 'stopped');
    assert.equal(s.instances['db-rep'].DBInstanceStatus, 'available');
    assert.ok(ctx.logs.some((l) => /réplica de leitura/.test(l)));
    assert.ok(ctx.logs.some((l) => /cluster Aurora/.test(l)));
    assert.ok(ctx.logs.some((l) => /7 dias/.test(l)));

    await p.stop(ctx);
    assert.equal(h.calls('stop-db-instance').length, 1, 'parar de novo não repete a chamada');
    assert.equal((await p.status({})).state, 'stopped');

    await p.start(ctx);
    assert.equal(h.calls('start-db-instance').length, 1);
    assert.equal(h.calls('start-db-cluster').length, 1);
    assert.equal(h.state().rds.instances['db-main'].DBInstanceStatus, 'available');
    assert.equal(h.state().rds.clusters['aur-c'].Status, 'available');
    assert.equal(h.calls().filter((c) => c.error).length, 0);
  });
});

// ================================================================= (3) ElastiCache replication group
describe('ElastiCache replication group', () => {
  const env0 = () => mkEnv({ elasticache: { replicationGroups: ['cache-a'], acknowledgeDelete: true } });

  it('captura config, grava estado ANTES de excluir, recria do snapshot com os args certos', async () => {
    const h = await setup({ ...cacheState('cache-a', {}, { endpointOnCreate: 'cache-a.new999.clustercfg.use1.cache.amazonaws.com' }) });
    const env = env0();
    h.watch(env);
    const p = createProvider(env, { store: h.store });
    const ctx = mkCtx();

    await p.stop(ctx);

    // estado persistido antes do delete
    const del = h.calls('delete-replication-group');
    assert.equal(del.length, 1);
    const snapName = flagValue(del[0].argv, '--final-snapshot-identifier');
    assert.match(snapName, /^cache-a-epma-\d{14}$/);
    const before = del[0].storeState?.resources?.elasticache?.replicationGroups?.['cache-a'];
    assert.ok(before, 'config deve estar em disco antes do delete');
    assert.equal(before.snapshotName, snapName);
    assert.equal(before.state, 'deleting');
    assert.ok(!del[0].argv.includes('--retain-primary-cluster'));

    // depois da exclusão
    assert.equal(h.state().elasticache.rgs['cache-a'], undefined);
    assert.equal(h.state().elasticache.snapshots[snapName].SnapshotStatus, 'available');
    const saved = (await h.store.getState(env.id)).resources.elasticache.replicationGroups['cache-a'];
    assert.equal(saved.state, 'deleted');
    const c = saved.config;
    assert.equal(c.engine, 'valkey');
    assert.equal(c.engineVersion, '7.2.6');
    assert.equal(c.nodeType, 'cache.r6g.large');
    assert.equal(c.clusterEnabled, true);
    assert.equal(c.numNodeGroups, 2);
    assert.equal(c.replicasPerNodeGroup, 1);
    assert.equal(c.subnetGroup, 'subnet-g');
    assert.deepEqual(c.securityGroupIds, ['sg-1', 'sg-2']);
    assert.equal(c.parameterGroup, 'default.valkey7.cluster.on');
    assert.equal(c.automaticFailover, true);
    assert.equal(c.multiAz, true);
    assert.equal(c.transitEncryption, true);
    assert.equal(c.atRestEncryption, true);
    assert.equal(c.port, 6379);
    assert.equal(c.tags.length, 2);

    let st = await p.status({});
    assert.equal(st.state, 'stopped');
    const item = st.resources.find((r) => r.type === 'elasticache-rg');
    assert.equal(item.state, 'stopped');
    assert.match(item.detail, new RegExp(snapName));

    // 2º stop é idempotente
    await p.stop(ctx);
    assert.equal(h.calls('delete-replication-group').length, 1);
    assert.ok(ctx.logs.some((l) => /já desligado/.test(l)));

    // recriação
    await p.start(ctx);
    const create = h.calls('create-replication-group');
    assert.equal(create.length, 1);
    const expected = buildCreateReplicationGroupArgs('cache-a', saved.config, snapName);
    assert.deepEqual(create[0].argv.slice(0, expected.length), expected);
    const flags = h.state().elasticache.creates[0].flags;
    assert.deepEqual(flags['snapshot-name'], [snapName]);
    assert.deepEqual(flags['num-node-groups'], ['2']);
    assert.deepEqual(flags['replicas-per-node-group'], ['1']);
    assert.equal(flags['num-cache-clusters'], undefined, 'cluster mode enabled não usa num-cache-clusters');
    assert.deepEqual(flags['cache-subnet-group-name'], ['subnet-g']);
    assert.deepEqual(flags['security-group-ids'], ['sg-1', 'sg-2']);
    assert.deepEqual(flags['cache-parameter-group-name'], ['default.valkey7.cluster.on']);
    assert.deepEqual(flags['cache-node-type'], ['cache.r6g.large']);
    assert.deepEqual(flags.engine, ['valkey']);
    assert.ok('automatic-failover-enabled' in flags);
    assert.ok('multi-az-enabled' in flags);
    assert.ok('transit-encryption-enabled' in flags);
    assert.deepEqual(JSON.parse(flags.tags[0]), [{ Key: 'app', Value: 'x' }], 'tags aws:* não podem ser reaplicadas');

    // endpoint mudou → aviso; histórico; registro removido
    assert.ok(ctx.logs.some((l) => /warn: .*MUDOU/.test(l)));
    const ec = (await h.store.getState(env.id)).resources.elasticache;
    assert.equal(ec.replicationGroups['cache-a'], undefined);
    assert.equal(ec.history.length, 1);
    assert.equal(ec.history[0].snapshotName, snapName);
    assert.equal(h.state().elasticache.rgs['cache-a'].Status, 'available');
    st = await p.status({});
    assert.equal(st.state, 'running');
    assert.equal(h.calls().filter((x) => x.error && x.op !== 'describe-replication-groups' && x.op !== 'describe-snapshots').length, 0);
  });

  it('modo cluster desabilitado usa num-cache-clusters e AZs preferidas (builder)', () => {
    const args = buildCreateReplicationGroupArgs(
      'rg1',
      { description: 'd', engine: 'redis', engineVersion: '7.0', nodeType: 'cache.t4g.small', clusterEnabled: false, numCacheClusters: 2, preferredAzs: ['us-east-1a', 'us-east-1b'], automaticFailover: false, multiAz: false, transitEncryption: false, atRestEncryption: false },
      'snap1',
    );
    assert.equal(flagValue(args, '--num-cache-clusters'), '2');
    assert.ok(!args.includes('--num-node-groups'));
    assert.deepEqual(args.slice(args.indexOf('--preferred-cache-cluster-azs') + 1, args.indexOf('--preferred-cache-cluster-azs') + 3), ['us-east-1a', 'us-east-1b']);
    assert.ok(args.includes('--no-automatic-failover-enabled'));
    assert.ok(args.includes('--no-multi-az-enabled'));
    assert.equal(flagValue(args, '--snapshot-name'), 'snap1');
  });

  it('recusa sem excluir nada: AUTH token e Global Datastore', async () => {
    for (const [over, re] of [
      [{ AuthTokenEnabled: true }, /AUTH/],
      [{ GlobalReplicationGroupInfo: { GlobalReplicationGroupId: 'g1' } }, /Global Datastore/],
    ]) {
      const h = await setup(cacheState('cache-a', over));
      const env = env0();
      const p = createProvider(env, { store: h.store });
      await assert.rejects(p.stop(mkCtx()), re);
      assert.equal(h.calls('delete-replication-group').length, 0);
      assert.equal(h.state().elasticache.rgs['cache-a'].Status, 'available');
      const ec = (await h.store.getState(env.id)).resources?.elasticache;
      assert.deepEqual(ec?.replicationGroups ?? {}, {}, 'nenhum registro deve ser gravado quando a captura é recusada');
    }
  });

  it('start com exclusão em andamento espera terminar e recria', async () => {
    const h = await setup(cacheState('cache-a', { Status: 'deleting' }));
    const env = env0();
    const snapName = 'cache-a-epma-20260101000000';
    h.patch((s) => {
      s.elasticache.rgs['cache-a']._ticks = 2;
      s.elasticache.snapshots[snapName] = { SnapshotName: snapName, SnapshotStatus: 'available', ARN: `arn:aws:elasticache:us-east-1:123456789012:snapshot:${snapName}`, _source: rgFixture('cache-a') };
    });
    await h.store.updateState(env.id, (s) => {
      s.resources = {
        elasticache: {
          replicationGroups: { 'cache-a': { snapshotName: snapName, state: 'deleting', config: { description: 'd', engine: 'valkey', nodeType: 'cache.r6g.large', clusterEnabled: true, numNodeGroups: 2, replicasPerNodeGroup: 1, automaticFailover: true, multiAz: true, tags: [] } } },
          serverless: {},
          history: [],
        },
      };
      return s;
    });
    const p = createProvider(env, { store: h.store });
    await p.start(mkCtx());
    assert.equal(h.calls('create-replication-group').length, 1);
    assert.equal(h.state().elasticache.rgs['cache-a'].Status, 'available');
  });

  it('start sem registro e sem grupo falha; registro obsoleto com grupo existente é limpo', async () => {
    const h = await setup({ elasticache: { rgs: {}, snapshots: {}, serverless: {}, cacheClusters: {}, tags: {} } });
    const p = createProvider(env0(), { store: h.store });
    await assert.rejects(p.start(mkCtx()), /não existe e não há snapshot/);

    const h2 = await setup(cacheState('cache-a'));
    const env = env0();
    await h2.store.updateState(env.id, (s) => {
      s.resources = { elasticache: { replicationGroups: { 'cache-a': { snapshotName: 'x', state: 'deleting', config: {} } }, serverless: {}, history: [] } };
      return s;
    });
    await createProvider(env, { store: h2.store }).start(mkCtx());
    assert.equal(h2.calls('create-replication-group').length, 0);
    assert.deepEqual((await h2.store.getState(env.id)).resources.elasticache.replicationGroups, {});
  });
});

// ================================================================= (4) ElastiCache serverless
describe('ElastiCache serverless', () => {
  const env0 = () => mkEnv({ elasticache: { serverlessCaches: ['cache-sv'], acknowledgeDelete: true } });
  const base = (sv) => ({ elasticache: { rgs: {}, snapshots: {}, serverless: { 'cache-sv': sv }, cacheClusters: {}, tags: { [SV_ARN]: [{ Key: 'team', Value: 'dr' }] }, creates: [] } });

  it('exclui com --final-snapshot-name e recria com --snapshot-arns-to-restore <ARN do snapshot>', async () => {
    const h = await setup(base(svFixture()));
    const env = env0();
    h.watch(env);
    const p = createProvider(env, { store: h.store });
    await p.stop(mkCtx());

    const del = h.calls('delete-serverless-cache');
    assert.equal(del.length, 1);
    const snap = flagValue(del[0].argv, '--final-snapshot-name');
    assert.match(snap, /^cache-sv-epma-\d{14}$/);
    assert.equal(del[0].storeState.resources.elasticache.serverless['cache-sv'].snapshotName, snap);
    assert.equal(h.state().elasticache.serverless['cache-sv'], undefined);
    assert.equal((await p.status({})).state, 'stopped');

    const saved = (await h.store.getState(env.id)).resources.elasticache.serverless['cache-sv'];
    assert.equal(saved.config.engine, 'valkey');
    assert.deepEqual(saved.config.subnetIds, ['subnet-1', 'subnet-2']);

    await p.start(mkCtx());
    const create = h.calls('create-serverless-cache');
    assert.equal(create.length, 1);
    const snapArn = h.state().elasticache.snapshots[snap].ARN;
    assert.equal(flagValue(create[0].argv, '--snapshot-arns-to-restore'), snapArn);
    assert.match(snapArn, /^arn:aws:elasticache:us-east-1:\d+:snapshot:cache-sv-epma-/);
    const expected = buildCreateServerlessArgs('cache-sv', saved.config, snapArn);
    assert.deepEqual(create[0].argv.slice(0, expected.length), expected);
    const flags = h.state().elasticache.svCreates[0].flags;
    assert.deepEqual(JSON.parse(flags['cache-usage-limits'][0]), svFixture().CacheUsageLimits);
    assert.deepEqual(flags['subnet-ids'], ['subnet-1', 'subnet-2']);
    assert.deepEqual(flags['security-group-ids'], ['sg-9']);
    assert.equal(h.state().elasticache.serverless['cache-sv'].Status, 'available');
    assert.equal((await p.status({})).state, 'running');
    assert.equal((await h.store.getState(env.id)).resources.elasticache.history.length, 1);
  });

  it('recusa Memcached Serverless sem excluir', async () => {
    const h = await setup(base(svFixture({ Engine: 'memcached' })));
    const p = createProvider(env0(), { store: h.store });
    await assert.rejects(p.stop(mkCtx()), /Memcached/);
    assert.equal(h.calls('delete-serverless-cache').length, 0);
  });
});

// ================================================================= (5) estado combinado
describe('estado combinado', () => {
  it('combineStates', () => {
    assert.equal(combineStates([]), 'unknown');
    assert.equal(combineStates([null, 'running']), 'running');
    assert.equal(combineStates(['stopped', 'stopped']), 'stopped');
    assert.equal(combineStates(['running', 'stopped']), 'partial');
    assert.equal(combineStates(['running', 'transitioning']), 'transitioning');
    assert.equal(combineStates(['running', 'error']), 'error');
    assert.equal(combineStates(['running', 'missing']), 'error');
    assert.equal(combineStates(['unknown', 'running']), 'running');
    assert.equal(combineStates(['unknown']), 'unknown');
    assert.equal(combineStates(['ignored', 'stopped']), 'stopped');
  });

  it('status integrado: ignorados não contam; ElastiCache excluído com snapshot conta como stopped', async () => {
    const h = await setup({
      ec2: ec2State(inst('i-0aaa1111'), inst('i-0ccc3333', 'running', [], { InstanceLifecycle: 'spot' })),
      rds: { instances: { 'db-main': { DBInstanceIdentifier: 'db-main', DBInstanceStatus: 'available', Engine: 'postgres' } }, clusters: {} },
      ...cacheState('cache-a'),
    });
    const env = mkEnv({ ec2: { instanceIds: ['i-0aaa1111', 'i-0ccc3333'] }, rds: { instances: ['db-main'] }, elasticache: { replicationGroups: ['cache-a'], acknowledgeDelete: true } });
    const p = createProvider(env, { store: h.store });
    let st = await p.status({});
    assert.equal(st.state, 'running');
    assert.deepEqual(st.resources.map((r) => r.type).sort(), ['ec2', 'ec2', 'elasticache-rg', 'rds-instance']);
    await p.stop(mkCtx());
    st = await p.status({});
    assert.equal(st.state, 'stopped');
    assert.equal(h.state().ec2['i-0ccc3333'].State.Name, 'running');
    assert.equal(st.resources.find((r) => r.type === 'elasticache-rg').state, 'stopped');
  });

  it('recurso com erro no describe vira item "error" e estado "error"', async () => {
    const h = await setup({ ec2: ec2State(inst('i-0aaa1111')) });
    const p = createProvider(mkEnv({ ec2: { instanceIds: ['i-0aaa1111'] }, rds: { instances: ['nao-existe'] } }), { store: h.store });
    const st = await p.status({});
    assert.equal(st.state, 'error');
    assert.equal(st.resources.find((r) => r.id === 'nao-existe').state, 'error');
  });
});

// ================================================================= (6) validação
describe('validação (normalizeEnvironment)', () => {
  const bad = (input, re) =>
    assert.throws(
      () => normalizeEnvironment(input),
      (e) => e.status === 400 && e.details.some((d) => re.test(d)),
    );
  it('rejeita configurações inseguras ou incompletas', () => {
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', elasticache: { replicationGroups: ['c1'] } } }, /acknowledgeDelete/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', elasticache: { serverlessCaches: ['c1'] } } }, /acknowledgeDelete/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', ec2: { instanceIds: ['i-xyz'] } } }, /ID de instância inválido/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', ec2: { tagKey: 'Env' } } }, /tagValue/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', ec2: { tagKey: 'Env', tagValue: 'a,b' } } }, /sem vírgula/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1' } }, /ao menos um recurso/);
    bad({ name: 'x', provider: 'aws', resources: { ec2: { instanceIds: ['i-0aaa1111'] } } }, /resources\.region/);
    bad({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', rds: { instances: ['-ruim'] } } }, /RDS inválido/);
  });
  it('aceita recursos válidos; região do EKS serve de padrão; simulated ignora recursos', () => {
    const ok = normalizeEnvironment({ name: 'x', provider: 'aws', resources: { region: 'us-east-1', ec2: { instanceIds: 'i-0aaa1111, i-0bbb2222' }, elasticache: { replicationGroups: ['c1'], acknowledgeDelete: true } } });
    assert.deepEqual(ok.resources.ec2.instanceIds, ['i-0aaa1111', 'i-0bbb2222']);
    const eks = normalizeEnvironment({ name: 'x', provider: 'eks', eks: { clusterName: 'c', region: 'us-east-1' }, resources: { rds: { instances: ['db1'] } } });
    assert.equal(eks.resources.rds.instances[0], 'db1');
    const sim = normalizeEnvironment({ name: 'x', provider: 'simulated', resources: { elasticache: { replicationGroups: ['c1'] } } });
    assert.equal(sim.provider, 'simulated');
  });
});

// ================================================================= (7) exercício completo via API (provider 'aws')
describe('exercício completo (EC2 + RDS + ElastiCache)', { timeout: 180_000 }, () => {
  it('desliga na ordem certa, mede RTO e religa tudo', async () => {
    const h = await setup({
      ec2: ec2State(inst('i-0aaa1111')),
      rds: { instances: { 'db-main': { DBInstanceIdentifier: 'db-main', DBInstanceStatus: 'available', Engine: 'postgres' } }, clusters: {} },
      ...cacheState('cache-a'),
    });
    const flagFile = join(h.dir, 'flag');
    await writeFile(flagFile, '1');
    h.patch((s) => (s.flag = { file: flagFile, rgs: ['cache-a'] }));

    // "aplicação": responde 200 só enquanto o fake estiver ligado
    const app = http.createServer((req, res) => {
      const on = readFileSync(flagFile, 'utf8') === '1';
      res.writeHead(on ? 200 : 503).end(on ? 'ok' : 'down');
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const appPort = app.address().port;

    const dataDir = join(h.dir, 'app-data');
    const server = await createApp({ dataDir, port: 0, host: '127.0.0.1' });
    const { port } = await server.listen();
    const base = `http://127.0.0.1:${port}/api`;
    const api = async (path, opts = {}) => {
      const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };

    try {
      const payload = {
        name: 'dr-aws',
        provider: 'aws',
        resources: { region: 'us-east-1', ec2: { instanceIds: ['i-0aaa1111'] }, rds: { instances: ['db-main'] }, elasticache: { replicationGroups: ['cache-a'], acknowledgeDelete: true } },
        targets: { rtoSeconds: 600, rpoSeconds: 60 },
        drill: { holdDownSeconds: 0, probeIntervalSeconds: 1, stableProbes: 2, maxRecoverySeconds: 120 },
        checks: [{ name: 'app', type: 'http', url: `http://127.0.0.1:${appPort}/`, expectStatus: '200', timeoutMs: 2000, critical: true }],
      };
      // validação também pela API
      const noAck = await api('/environments', { method: 'POST', body: { ...payload, resources: { ...payload.resources, elasticache: { replicationGroups: ['cache-a'] } } } });
      assert.equal(noAck.status, 400);
      assert.ok(noAck.data.details.some((d) => /acknowledgeDelete/.test(d)));

      const created = await api('/environments', { method: 'POST', body: payload });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      const id = created.data.id;

      const st0 = await api(`/environments/${id}/status?force=1`);
      assert.equal(st0.data.state, 'running');
      assert.equal(st0.data.resources.length, 3);

      // sem confirmação de nome → 400
      assert.equal((await api(`/environments/${id}/drill`, { method: 'POST', body: {} })).status, 400);

      const start = await api(`/environments/${id}/drill`, { method: 'POST', body: { confirm: 'dr-aws' } });
      assert.equal(start.status, 200, JSON.stringify(start.data));
      let job;
      const deadline = Date.now() + 150_000;
      do {
        await new Promise((r) => setTimeout(r, 500));
        job = (await api('/job')).data;
      } while (job.status === 'running' && Date.now() < deadline);

      assert.equal(job.status, 'succeeded', JSON.stringify(job.events?.slice(-8)));
      assert.equal(job.result.evaluation.verdict, 'approved');
      assert.ok(job.result.metrics.rtoSec > 0);

      // tudo ligado novamente
      const fin = h.state();
      assert.equal(fin.ec2['i-0aaa1111'].State.Name, 'running');
      assert.equal(fin.rds.instances['db-main'].DBInstanceStatus, 'available');
      assert.equal(fin.elasticache.rgs['cache-a'].Status, 'available');
      assert.equal(readFileSync(flagFile, 'utf8'), '1');
      assert.equal((await api(`/environments/${id}/status?force=1`)).data.state, 'running');

      // ordem: stop EC2 → (stop RDS ‖ delete ElastiCache) → (start RDS ‖ create ElastiCache) → start EC2
      const ops = h.calls().map((c) => c.op);
      const idx = (op) => ops.indexOf(op);
      const stopEc2 = idx('stop-instances');
      const stopData = [idx('stop-db-instance'), idx('delete-replication-group')];
      const startData = [idx('start-db-instance'), idx('create-replication-group')];
      const startEc2 = idx('start-instances');
      for (const i of [stopEc2, ...stopData, ...startData, startEc2]) assert.ok(i >= 0, `operação ausente no log: ${ops.join(',')}`);
      assert.ok(stopEc2 < Math.min(...stopData), 'EC2 para antes da camada de dados');
      assert.ok(Math.max(...stopData) < Math.min(...startData), 'dados desligam antes de religar');
      assert.ok(Math.max(...startData) < startEc2, 'dados religam antes do EC2');

      // relatório menciona os recursos
      const run = (await api(`/runs/${job.id}`)).data;
      assert.deepEqual(run.env.resources, { ec2: 1, rds: 1, elasticache: 1 });
      assert.equal(h.calls().filter((c) => c.error && !/^describe-/.test(c.op)).length, 0);
    } finally {
      await server.close();
      await new Promise((r) => app.close(r));
    }
  });
});
