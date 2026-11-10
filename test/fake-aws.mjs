#!/usr/bin/env node
// `aws` CLI FALSO usado só nos testes (test/resources.test.js).
// Estado: JSON em FAKE_AWS_STATE · Log: uma linha JSON por chamada em FAKE_AWS_LOG.
// Opcional: FAKE_AWS_STORE_STATE = arquivo de estado do Store; seu conteúdo é anexado ao log das
// operações que mudam algo (`storeState`), para provar que a config foi gravada ANTES do delete.
//
// Transições (stopping→stopped, creating→available, deleting→some…) avançam a cada `describe` do
// próprio recurso (state.ticks, padrão 2). Erros imitam a CLI real: stderr
// "An error occurred (X) when calling the Y operation: msg" e exit code 254.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_AWS_STATE;
const LOG = process.env.FAKE_AWS_LOG;
// `node --test` executa todo .mjs dentro de test/: sem estado configurado, sai sem fazer nada.
if (!STATE) process.exit(0);
const [service, op, ...rest] = process.argv.slice(2);

class FakeError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new FakeError(code, msg);
};
const pascal = (s) => s.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

function parseFlags(list) {
  const f = {};
  let cur = null;
  for (const a of list) {
    if (a.startsWith('--')) {
      cur = a.slice(2);
      f[cur] = [];
    } else if (cur) f[cur].push(a);
  }
  return f;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
const clone = (o) => JSON.parse(JSON.stringify(o));
const one = (f, k) => f[k]?.[0];

// ---------- lock (RDS ‖ ElastiCache chamam o fake em paralelo) ----------
const lockDir = `${STATE}.lock`;
function lock() {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 4000; i++) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      Atomics.wait(sab, 0, 0, 5);
    }
  }
  throw new Error('fake-aws: lock timeout');
}

// ---------- handlers ----------
const handlers = {};
const H = (name, fn) => (handlers[name] = fn);
const step = (obj, done) => {
  if (obj._ticks > 0 && --obj._ticks === 0) done(obj);
};

// ===== EC2 =====
const ec2Done = (i) => {
  i.State = { Code: i._next === 'running' ? 16 : 80, Name: i._next };
  delete i._next;
};
H('ec2 describe-instances', ({ st, f }) => {
  const all = st.ec2 ?? {};
  for (const i of Object.values(all)) step(i, ec2Done);
  let list = Object.values(all);
  if (f['instance-ids']) {
    list = f['instance-ids'].map((id) => all[id] ?? fail('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`));
  }
  for (const spec of f.filters ?? []) {
    const m = /^Name=([^,]+),Values=(.*)$/.exec(spec);
    const [, name, values] = m;
    const vals = values.split(',');
    if (name.startsWith('tag:')) list = list.filter((i) => i.Tags?.some((t) => t.Key === name.slice(4) && vals.includes(t.Value)));
    else if (name === 'instance-state-name') list = list.filter((i) => vals.includes(i.State.Name));
  }
  return { Reservations: list.length ? [{ ReservationId: 'r-0001', Instances: list.map(clean) }] : [] };
});
const ec2Change = (from, to, mid, key) => ({ st, f }) => {
  const out = [];
  for (const id of f['instance-ids'] ?? []) {
    const i = st.ec2?.[id] ?? fail('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
    if (i.State.Name !== from) fail('IncorrectInstanceState', `The instance '${id}' is not in a state from which it can be ${to === 'stopped' ? 'stopped' : 'started'}.`);
    const prev = i.State.Name;
    i.State = { Code: 0, Name: mid };
    i._next = to;
    i._ticks = st.ticks ?? 2;
    out.push({ InstanceId: id, CurrentState: { Name: mid }, PreviousState: { Name: prev } });
  }
  return { [key]: out };
};
H('ec2 stop-instances', ec2Change('running', 'stopped', 'stopping', 'StoppingInstances'));
H('ec2 start-instances', ec2Change('stopped', 'running', 'pending', 'StartingInstances'));

// ===== RDS =====
function rdsKind({ coll, id, notFound, key, statusKey, label }) {
  const get = (st, ident) => st.rds?.[coll]?.[ident] ?? fail(notFound, `${label} ${ident} not found.`);
  const done = (x) => {
    x[statusKey] = x._next;
    delete x._next;
  };
  return {
    describe: ({ st, f }) => {
      const x = get(st, one(f, id));
      step(x, done);
      return { [key]: [clean(x)] };
    },
    change: (from, to, mid, wrap) => ({ st, f }) => {
      const x = get(st, one(f, id));
      const bad = `${label} ${one(f, id)} is not in a valid state for this operation (${x[statusKey]}).`;
      if (x[statusKey] !== from) fail(coll === 'instances' ? 'InvalidDBInstanceState' : 'InvalidDBClusterStateFault', bad);
      if (coll === 'instances' && (x.DBClusterIdentifier || x.ReadReplicaSourceDBInstanceIdentifier)) {
        fail('InvalidDBInstanceState', `${label} ${one(f, id)} cannot be stopped/started individually (cluster member or read replica).`);
      }
      x[statusKey] = mid;
      x._next = to;
      x._ticks = st.ticks ?? 2;
      return { [wrap]: clean(x) };
    },
  };
}
const rdsI = rdsKind({ coll: 'instances', id: 'db-instance-identifier', notFound: 'DBInstanceNotFound', key: 'DBInstances', statusKey: 'DBInstanceStatus', label: 'DBInstance' });
const rdsC = rdsKind({ coll: 'clusters', id: 'db-cluster-identifier', notFound: 'DBClusterNotFoundFault', key: 'DBClusters', statusKey: 'Status', label: 'DBCluster' });
H('rds describe-db-instances', rdsI.describe);
H('rds stop-db-instance', rdsI.change('available', 'stopped', 'stopping', 'DBInstance'));
H('rds start-db-instance', rdsI.change('stopped', 'available', 'starting', 'DBInstance'));
H('rds describe-db-clusters', rdsC.describe);
H('rds stop-db-cluster', rdsC.change('available', 'stopped', 'stopping', 'DBCluster'));
H('rds start-db-cluster', rdsC.change('stopped', 'available', 'starting', 'DBCluster'));

// ===== ElastiCache =====
const ecs = (st) => (st.elasticache ??= {});
const rgs = (st) => (ecs(st).rgs ??= {});
const snaps = (st) => (ecs(st).snapshots ??= {});
const svs = (st) => (ecs(st).serverless ??= {});
const arnOf = (name) => `arn:aws:elasticache:us-east-1:123456789012:snapshot:${name}`;

function stepRg(st, id) {
  const rg = rgs(st)[id];
  if (rg) {
    step(rg, (x) => {
      if (x.Status === 'deleting') delete rgs(st)[id];
      else x.Status = 'available';
    });
  }
  if (!rgs(st)[id]) fail('ReplicationGroupNotFoundFault', `ReplicationGroup ${id} not found.`);
  return rgs(st)[id];
}
H('elasticache describe-replication-groups', ({ st, f }) => {
  const id = one(f, 'replication-group-id');
  if (!id) return { ReplicationGroups: Object.values(rgs(st)).map(clean) };
  return { ReplicationGroups: [clean(stepRg(st, id))] };
});
H('elasticache describe-cache-clusters', ({ st, f }) => {
  const id = one(f, 'cache-cluster-id');
  const cc = ecs(st).cacheClusters?.[id] ?? fail('CacheClusterNotFound', `CacheCluster not found: ${id}`);
  return { CacheClusters: [cc] };
});
H('elasticache list-tags-for-resource', ({ st, f }) => ({ TagList: ecs(st).tags?.[one(f, 'resource-name')] ?? [] }));

H('elasticache describe-snapshots', ({ st, f }) => {
  const name = one(f, 'snapshot-name');
  const s = snaps(st)[name] ?? fail('SnapshotNotFoundFault', `Snapshot ${name} not found.`);
  step(s, (x) => (x.SnapshotStatus = 'available'));
  return { Snapshots: [clean(s)] };
});
const newSnapshot = (st, name, source, extra) => {
  if (snaps(st)[name]) fail('SnapshotAlreadyExistsFault', `Snapshot already exists: ${name}`);
  snaps(st)[name] = { SnapshotName: name, SnapshotStatus: 'creating', ARN: arnOf(name), _ticks: st.ticks ?? 2, _source: clone(source), ...extra };
};

H('elasticache delete-replication-group', ({ st, f }) => {
  const id = one(f, 'replication-group-id');
  const rg = rgs(st)[id] ?? fail('ReplicationGroupNotFoundFault', `ReplicationGroup ${id} not found.`);
  if (rg.Status !== 'available') fail('InvalidReplicationGroupState', `Replication group not in available state (${rg.Status}).`);
  const snap = one(f, 'final-snapshot-identifier');
  if (snap) newSnapshot(st, snap, rg, { ReplicationGroupId: id });
  rg.Status = 'deleting';
  rg._ticks = st.ticks ?? 2;
  return { ReplicationGroup: clean(rg) };
});
H('elasticache create-replication-group', ({ st, f }) => {
  const id = one(f, 'replication-group-id');
  if (rgs(st)[id]) fail('ReplicationGroupAlreadyExistsFault', `The replication group ${id} already exists.`);
  const snapName = one(f, 'snapshot-name');
  let rg;
  if (snapName) {
    const s = snaps(st)[snapName] ?? fail('SnapshotNotFoundFault', `Snapshot ${snapName} not found.`);
    if (s.SnapshotStatus !== 'available') fail('InvalidSnapshotState', `Snapshot ${snapName} is not in available state.`);
    rg = clone(s._source);
  } else {
    rg = { ReplicationGroupId: id, MemberClusters: [`${id}-001`], NodeGroups: [{ NodeGroupId: '0001', NodeGroupMembers: [{ CacheClusterId: `${id}-001` }] }] };
  }
  rg.ReplicationGroupId = id;
  rg.Status = 'creating';
  rg._ticks = st.ticks ?? 2;
  const addr = ecs(st).endpointOnCreate;
  if (addr) {
    if (rg.ConfigurationEndpoint) rg.ConfigurationEndpoint.Address = addr;
    else if (rg.NodeGroups?.[0]?.PrimaryEndpoint) rg.NodeGroups[0].PrimaryEndpoint.Address = addr;
  }
  rgs(st)[id] = rg;
  (ecs(st).creates ??= []).push({ id, flags: f });
  return { ReplicationGroup: clean(rg) };
});

// serverless
function stepSv(st, name) {
  const sv = svs(st)[name];
  if (sv) {
    step(sv, (x) => {
      if (x.Status === 'deleting') delete svs(st)[name];
      else x.Status = 'available';
    });
  }
  if (!svs(st)[name]) fail('ServerlessCacheNotFoundFault', `Serverless cache ${name} not found.`);
  return svs(st)[name];
}
H('elasticache describe-serverless-caches', ({ st, f }) => {
  const name = one(f, 'serverless-cache-name');
  if (!name) return { ServerlessCaches: Object.values(svs(st)).map(clean) };
  return { ServerlessCaches: [clean(stepSv(st, name))] };
});
H('elasticache delete-serverless-cache', ({ st, f }) => {
  const name = one(f, 'serverless-cache-name');
  const sv = svs(st)[name] ?? fail('ServerlessCacheNotFoundFault', `Serverless cache ${name} not found.`);
  if (sv.Status !== 'available') fail('InvalidServerlessCacheStateFault', `Serverless cache not available (${sv.Status}).`);
  const snap = one(f, 'final-snapshot-name');
  if (snap) newSnapshot(st, snap, sv, { ServerlessCacheName: name });
  sv.Status = 'deleting';
  sv._ticks = st.ticks ?? 2;
  return { ServerlessCache: clean(sv) };
});
H('elasticache create-serverless-cache', ({ st, f }) => {
  const name = one(f, 'serverless-cache-name');
  if (svs(st)[name]) fail('ServerlessCacheAlreadyExistsFault', `Serverless cache ${name} already exists.`);
  const arn = one(f, 'snapshot-arns-to-restore');
  let sv = { ServerlessCacheName: name, Engine: one(f, 'engine') };
  if (arn) {
    const s = Object.values(snaps(st)).find((x) => x.ARN === arn) ?? fail('SnapshotNotFoundFault', `Snapshot ${arn} not found.`);
    if (s.SnapshotStatus !== 'available') fail('InvalidSnapshotState', `Snapshot ${arn} is not available.`);
    sv = clone(s._source);
  }
  sv.Status = 'creating';
  sv._ticks = st.ticks ?? 2;
  const addr = ecs(st).endpointOnCreate;
  if (addr && sv.Endpoint) sv.Endpoint.Address = addr;
  svs(st)[name] = sv;
  (ecs(st).svCreates ??= []).push({ name, flags: f });
  return { ServerlessCache: clean(sv) };
});

// ---------- flag "ambiente ligado" (lida pelo servidor HTTP dos testes) ----------
function writeFlag(st) {
  const fl = st.flag;
  if (!fl) return;
  const ec2ok = Object.values(st.ec2 ?? {}).every((i) => i.State.Name === 'running');
  const rdsok = Object.values(st.rds?.instances ?? {}).every((i) => i.DBInstanceStatus === 'available') && Object.values(st.rds?.clusters ?? {}).every((c) => c.Status === 'available');
  const rgok = (fl.rgs ?? []).every((id) => rgs(st)[id]?.Status === 'available');
  writeFileSync(fl.file, ec2ok && rdsok && rgok ? '1' : '0');
}

// ---------- main ----------
const MUTATING = /^(stop|start|delete|create)-/;
lock();
let exitCode = 0;
try {
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  const entry = { t: Date.now(), service, op, argv: [service, op, ...rest] };
  if (MUTATING.test(op) && process.env.FAKE_AWS_STORE_STATE && existsSync(process.env.FAKE_AWS_STORE_STATE)) {
    entry.storeState = JSON.parse(readFileSync(process.env.FAKE_AWS_STORE_STATE, 'utf8'));
  }
  let out;
  try {
    const h = handlers[`${service} ${op}`];
    if (!h) fail('UnknownOperationException', `fake-aws: operação não implementada: ${service} ${op}`);
    out = h({ st, f: parseFlags(rest) });
  } catch (e) {
    if (!(e instanceof FakeError)) throw e;
    entry.error = e.code;
    process.stderr.write(`\nAn error occurred (${e.code}) when calling the ${pascal(op)} operation: ${e.message}\n`);
    exitCode = 254;
  }
  writeFileSync(STATE, JSON.stringify(st, null, 1)); // mutações feitas antes do erro (ex.: grupo que sumiu) são intencionais
  writeFlag(st);
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  if (!exitCode) process.stdout.write(JSON.stringify(out ?? {}));
} finally {
  rmdirSync(lockDir);
}
process.exit(exitCode);
