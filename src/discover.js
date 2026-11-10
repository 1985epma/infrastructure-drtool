// Descoberta de recursos para o wizard de novo ambiente. Tudo SOMENTE LEITURA:
// aws … list/describe, kubectl … get, docker ps. Entradas da query são validadas e passadas como argv.
import { run, probeTool } from './exec.js';
import { awsJson } from './providers/eks.js';
import { HttpError } from './util.js';

const REGION_RE = /^[a-z]{2,3}(-[a-z]+)+-\d$/;
const PROFILE_RE = /^[\w.@+=,-]{1,100}$/;
const CONTEXT_RE = /^[\w.@:/=+-]{1,200}$/;

/** Lê e valida profile/region da query string. */
export function awsParams(query) {
  const profile = (query.get('profile') ?? '').trim();
  const region = (query.get('region') ?? '').trim();
  if (profile && !PROFILE_RE.test(profile)) throw new HttpError(400, 'Perfil AWS inválido');
  if (region && !REGION_RE.test(region)) throw new HttpError(400, 'Região inválida (ex.: us-east-1)');
  return { profile, region };
}

export function contextParam(query) {
  const ctx = (query.get('context') ?? '').trim();
  if (!ctx || !CONTEXT_RE.test(ctx)) throw new HttpError(400, 'Contexto Kubernetes inválido');
  return ctx;
}

async function awsCall(cfg, args) {
  try {
    return await awsJson(cfg, args, { timeoutMs: 60_000 });
  } catch (err) {
    throw new HttpError(422, err.message);
  }
}

async function tool(cmd, args, { timeoutMs = 20_000 } = {}) {
  try {
    const r = await run(cmd, args, { timeoutMs });
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400) || `${cmd} saiu com código ${r.code}`);
    return r.stdout;
  } catch (err) {
    throw new HttpError(422, err.message);
  }
}

const tagOf = (x, k) => x.Tags?.find((t) => t.Key === k)?.Value;

// ---------- ferramentas ----------
export async function tools() {
  const [aws, kubectl, docker] = await Promise.all([probeTool('aws', ['--version']), probeTool('kubectl', ['version', '--client']), probeTool('docker', ['--version'])]);
  return { aws, kubectl, docker };
}

// ---------- AWS: conta ----------
export async function awsProfiles() {
  const out = await tool('aws', ['configure', 'list-profiles']);
  const names = out.split('\n').map((s) => s.trim()).filter((n) => n && PROFILE_RE.test(n));
  const profiles = await Promise.all(
    names.map(async (name) => {
      const r = await run('aws', ['configure', 'get', 'region', '--profile', name], { timeoutMs: 10_000 }).catch(() => null);
      return { name, region: r?.code === 0 ? r.stdout.trim() : '' };
    }),
  );
  return { profiles, defaultRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '' };
}

export async function awsIdentity(cfg) {
  const r = await awsCall({ profile: cfg.profile }, ['sts', 'get-caller-identity']);
  return { account: r.Account, arn: r.Arn };
}

// ---------- EKS ----------
export async function eksClusters(cfg) {
  const names = ((await awsCall(cfg, ['eks', 'list-clusters'])).clusters ?? []).slice(0, 30);
  const clusters = await Promise.all(
    names.map(async (name) => {
      const [c, ngl] = await Promise.all([awsCall(cfg, ['eks', 'describe-cluster', '--name', name]), awsCall(cfg, ['eks', 'list-nodegroups', '--cluster-name', name])]);
      const nodegroups = await Promise.all(
        (ngl.nodegroups ?? []).map(async (n) => {
          const g = (await awsCall(cfg, ['eks', 'describe-nodegroup', '--cluster-name', name, '--nodegroup-name', n])).nodegroup;
          return { name: g.nodegroupName, status: g.status, desired: g.scalingConfig?.desiredSize ?? 0, min: g.scalingConfig?.minSize ?? 0, max: g.scalingConfig?.maxSize ?? 0, instanceTypes: g.instanceTypes ?? [] };
        }),
      );
      return { name, version: c.cluster?.version, status: c.cluster?.status, nodegroups };
    }),
  );
  return { clusters };
}

// ---------- EC2 ----------
export async function ec2Instances(cfg) {
  const d = await awsCall(cfg, ['ec2', 'describe-instances', '--filters', 'Name=instance-state-name,Values=pending,running,stopping,stopped']);
  const instances = [];
  for (const res of d.Reservations ?? []) {
    for (const i of res.Instances ?? []) {
      const asg = tagOf(i, 'aws:autoscaling:groupName') ?? null;
      const spot = i.InstanceLifecycle === 'spot';
      instances.push({
        id: i.InstanceId,
        name: tagOf(i, 'Name') ?? '',
        state: i.State?.Name,
        type: i.InstanceType,
        publicIp: i.PublicIpAddress ?? null,
        privateIp: i.PrivateIpAddress ?? null,
        asg,
        spot,
        skip: spot ? 'instância Spot não pode ser parada' : asg ? `pertence ao Auto Scaling "${asg}" (o ASG a substituiria)` : null,
      });
    }
  }
  instances.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return { instances };
}

// ---------- RDS ----------
export async function rdsResources(cfg) {
  const [di, dc] = await Promise.all([awsCall(cfg, ['rds', 'describe-db-instances']), awsCall(cfg, ['rds', 'describe-db-clusters'])]);
  const instances = (di.DBInstances ?? []).map((i) => ({
    id: i.DBInstanceIdentifier,
    engine: i.Engine,
    status: i.DBInstanceStatus,
    class: i.DBInstanceClass,
    multiAz: Boolean(i.MultiAZ),
    endpoint: i.Endpoint?.Address ?? null,
    port: i.Endpoint?.Port ?? null,
    cluster: i.DBClusterIdentifier ?? null,
    replica: i.ReadReplicaSourceDBInstanceIdentifier ?? null,
    skip: i.DBClusterIdentifier ? `membro do cluster Aurora "${i.DBClusterIdentifier}" — use o cluster` : i.ReadReplicaSourceDBInstanceIdentifier ? 'réplica de leitura não pode ser parada' : null,
  }));
  const clusters = (dc.DBClusters ?? []).map((c) => ({ id: c.DBClusterIdentifier, engine: c.Engine, status: c.Status, endpoint: c.Endpoint ?? null, port: c.Port ?? null }));
  return { instances, clusters };
}

// ---------- ElastiCache ----------
export async function elasticacheResources(cfg) {
  const warnings = [];
  const safe = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(err.message);
      return null;
    }
  };
  const [rg, sv] = await Promise.all([safe(() => awsCall(cfg, ['elasticache', 'describe-replication-groups'])), safe(() => awsCall(cfg, ['elasticache', 'describe-serverless-caches']))]);
  if (!rg && !sv) throw new HttpError(422, warnings[0]);
  const replicationGroups = (rg?.ReplicationGroups ?? []).map((g) => ({
    id: g.ReplicationGroupId,
    status: g.Status,
    engine: g.Engine ?? 'redis',
    nodeType: g.CacheNodeType,
    skip: g.GlobalReplicationGroupInfo?.GlobalReplicationGroupId ? 'faz parte de um Global Datastore' : g.AuthTokenEnabled ? 'usa AUTH token (não recuperável ao recriar)' : null,
  }));
  const serverless = (sv?.ServerlessCaches ?? []).map((s) => ({ id: s.ServerlessCacheName, status: s.Status, engine: s.Engine, skip: /memcached/i.test(s.Engine ?? '') ? 'Memcached Serverless não tem snapshot' : null }));
  return { replicationGroups, serverless, warnings };
}

// ---------- Kubernetes local ----------
export async function k8sContexts() {
  const names = (await tool('kubectl', ['config', 'get-contexts', '-o', 'name'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const current = (await run('kubectl', ['config', 'current-context'], { timeoutMs: 10_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : '')).catch(() => '')) || '';
  return { current, contexts: names.map((name) => ({ name, dockerDesktop: name === 'docker-desktop' })) };
}

export async function k8sWorkloads(context) {
  const out = await tool('kubectl', ['--context', context, '--request-timeout=15s', 'get', 'deployments,statefulsets', '-A', '-o', 'json'], { timeoutMs: 40_000 });
  const workloads = (JSON.parse(out).items ?? [])
    .map((i) => ({ namespace: i.metadata.namespace, kind: String(i.kind).toLowerCase(), name: i.metadata.name, replicas: i.spec?.replicas ?? 0, ready: i.status?.readyReplicas ?? 0 }))
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return { workloads };
}

// ---------- Docker ----------
export async function dockerContainers() {
  const out = await tool('docker', ['ps', '-a', '--format', '{{json .}}']);
  const containers = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const c = JSON.parse(line);
        const image = c.Image ?? '';
        return { name: String(c.Names ?? '').split(',')[0], image, status: c.Status, state: c.State, ports: c.Ports ?? '', kind: /redis|valkey/i.test(image) ? 'redis' : /postgres/i.test(image) ? 'postgres' : /mysql|mariadb/i.test(image) ? 'mysql' : 'other' };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { containers };
}
