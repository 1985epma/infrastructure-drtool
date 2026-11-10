// Recursos AWS gerenciados fora do Kubernetes: EC2, RDS/Aurora e ElastiCache.
//
//  • EC2         stop-instances / start-instances (ignora Spot e membros de Auto Scaling).
//  • RDS/Aurora  stop-db-instance|cluster / start-… (a AWS religa sozinha após 7 dias parado).
//  • ElastiCache NÃO tem stop/start. "Desligar" = excluir COM snapshot final; "Ligar" = recriar a
//                partir desse snapshot usando a configuração capturada antes da exclusão.
//                Suporta replication groups (Redis/Valkey) e caches Serverless.
//
// Semântica: o conjunto configurado é tratado como um todo — "desligar" para o que está ligado,
// "ligar" liga o que está parado. Só o ElastiCache guarda estado em disco (snapshot + config).
import { nowIso, waitFor } from '../util.js';
import { awsJson } from './eks.js';

const POLL_MS = Number(process.env.EPMA_POLL_MS) || 10_000; // reduzido apenas nos testes

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const tagged = (ctx, t) => ({ ...ctx, log: (lvl, msg) => ctx.log(lvl, `[${t}] ${msg}`) });

/** Aguarda todas as promessas; se alguma falhar, lança erro agregado (cancelamento tem prioridade). */
async function settleAll(promises) {
  const res = await Promise.allSettled(promises);
  const failed = res.filter((r) => r.status === 'rejected');
  if (!failed.length) return;
  const aborted = failed.find((f) => f.reason?.name === 'AbortedError');
  if (aborted) throw aborted.reason;
  throw new Error(failed.map((f) => f.reason?.message ?? String(f.reason)).join(' | '));
}

// ---------- construção dos comandos de recriação (funções puras, testáveis) ----------
export function buildCreateReplicationGroupArgs(id, c, snapshotName) {
  const a = ['elasticache', 'create-replication-group', '--replication-group-id', id, '--replication-group-description', c.description || id, '--snapshot-name', snapshotName, '--cache-node-type', c.nodeType, '--engine', c.engine];
  if (c.engineVersion) a.push('--engine-version', c.engineVersion);
  if (c.clusterEnabled) a.push('--num-node-groups', String(c.numNodeGroups), '--replicas-per-node-group', String(c.replicasPerNodeGroup));
  else {
    a.push('--num-cache-clusters', String(c.numCacheClusters));
    if (c.preferredAzs?.length) a.push('--preferred-cache-cluster-azs', ...c.preferredAzs);
  }
  a.push(c.automaticFailover ? '--automatic-failover-enabled' : '--no-automatic-failover-enabled');
  a.push(c.multiAz ? '--multi-az-enabled' : '--no-multi-az-enabled');
  if (c.subnetGroup) a.push('--cache-subnet-group-name', c.subnetGroup);
  if (c.securityGroupIds?.length) a.push('--security-group-ids', ...c.securityGroupIds);
  if (c.parameterGroup) a.push('--cache-parameter-group-name', c.parameterGroup);
  if (c.port) a.push('--port', String(c.port));
  if (c.snapshotRetentionLimit != null) a.push('--snapshot-retention-limit', String(c.snapshotRetentionLimit));
  if (c.snapshotWindow) a.push('--snapshot-window', c.snapshotWindow);
  if (c.maintenanceWindow) a.push('--preferred-maintenance-window', c.maintenanceWindow);
  if (c.userGroupIds?.length) a.push('--user-group-ids', ...c.userGroupIds);
  if (c.kmsKeyId) a.push('--kms-key-id', c.kmsKeyId);
  a.push(c.transitEncryption ? '--transit-encryption-enabled' : '--no-transit-encryption-enabled');
  a.push(c.atRestEncryption ? '--at-rest-encryption-enabled' : '--no-at-rest-encryption-enabled');
  const tags = (c.tags ?? []).filter((t) => !String(t.Key).startsWith('aws:'));
  if (tags.length) a.push('--tags', JSON.stringify(tags));
  return a;
}

export function buildCreateServerlessArgs(name, c, snapshotArn) {
  const a = ['elasticache', 'create-serverless-cache', '--serverless-cache-name', name, '--engine', c.engine, '--snapshot-arns-to-restore', snapshotArn];
  if (c.majorEngineVersion) a.push('--major-engine-version', c.majorEngineVersion);
  if (c.description) a.push('--description', c.description);
  if (c.subnetIds?.length) a.push('--subnet-ids', ...c.subnetIds);
  if (c.securityGroupIds?.length) a.push('--security-group-ids', ...c.securityGroupIds);
  if (c.kmsKeyId) a.push('--kms-key-id', c.kmsKeyId);
  if (c.cacheUsageLimits && Object.keys(c.cacheUsageLimits).length) a.push('--cache-usage-limits', JSON.stringify(c.cacheUsageLimits));
  if (c.snapshotRetentionLimit != null) a.push('--snapshot-retention-limit', String(c.snapshotRetentionLimit));
  if (c.dailySnapshotTime) a.push('--daily-snapshot-time', c.dailySnapshotTime);
  if (c.userGroupId) a.push('--user-group-id', c.userGroupId);
  const tags = (c.tags ?? []).filter((t) => !String(t.Key).startsWith('aws:'));
  if (tags.length) a.push('--tags', JSON.stringify(tags));
  return a;
}

export function createResources(env, { store }) {
  const r = env.resources;
  const cfg = { region: r.region || env.eks?.region || '', profile: r.profile || env.eks?.profile || '' };
  const aws = (args, o) => awsJson(cfg, args, o);
  const timeoutMs = r.timeoutSec * 1000;
  const mutate = (fn) =>
    store.updateState(env.id, (s) => {
      s.resources ??= {};
      s.resources.elasticache ??= { replicationGroups: {}, serverless: {}, history: [] };
      fn(s.resources.elasticache);
      return s;
    });
  const readCache = async () => (await store.getState(env.id)).resources?.elasticache ?? { replicationGroups: {}, serverless: {}, history: [] };
  const wait = (fn, label, ctx) => waitFor(fn, { timeoutMs, intervalMs: POLL_MS, signal: ctx.signal, label });
  const notFound = (err) => err.code === 'NOT_FOUND';

  // =====================================================================================
  // EC2
  // =====================================================================================
  const instTag = (i, k) => i.Tags?.find((t) => t.Key === k)?.Value;

  async function ec2List(signal, ids) {
    const found = new Map();
    const add = (d) => {
      for (const res of d.Reservations ?? []) for (const i of res.Instances ?? []) found.set(i.InstanceId, i);
    };
    const want = ids ?? r.ec2.instanceIds;
    if (want.length) add(await aws(['ec2', 'describe-instances', '--instance-ids', ...want], { signal }));
    if (!ids && r.ec2.tagKey) {
      add(await aws(['ec2', 'describe-instances', '--filters', `Name=tag:${r.ec2.tagKey},Values=${r.ec2.tagValue}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped'], { signal }));
    }
    return [...found.values()]
      .filter((i) => !['terminated', 'shutting-down'].includes(i.State?.Name))
      .map((i) => {
        const spot = i.InstanceLifecycle === 'spot';
        const asg = instTag(i, 'aws:autoscaling:groupName');
        return { id: i.InstanceId, state: i.State.Name, name: instTag(i, 'Name'), type: i.InstanceType, skip: spot ? 'instância Spot não pode ser parada' : asg ? `pertence ao Auto Scaling "${asg}" (o ASG a substituiria)` : null };
      });
  }

  async function ec2Wait(ctx, ids, want) {
    let last = '';
    await wait(
      async () => {
        const list = await ec2List(ctx.signal, ids);
        const txt = list.map((i) => `${i.id}:${i.state}`).join(' ');
        if (txt !== last) ctx.log('info', txt);
        last = txt;
        return list.every((i) => i.state === want);
      },
      `EC2 ${want}`,
      ctx,
    );
  }

  async function ec2Settle(ctx) {
    await wait(async () => (await ec2List(ctx.signal)).every((i) => ['running', 'stopped'].includes(i.state) || i.skip), 'EC2 estabilizar', ctx);
    return ec2List(ctx.signal);
  }

  async function ec2Stop(ctx) {
    const c = tagged(ctx, 'EC2');
    const list = await ec2Settle(c);
    if (!list.length) return c.log('warn', 'Nenhuma instância encontrada para os seletores configurados.');
    for (const i of list.filter((x) => x.skip)) c.log('warn', `${i.id}: ignorada — ${i.skip}.`);
    const ids = list.filter((i) => !i.skip && i.state === 'running').map((i) => i.id);
    if (!ids.length) return c.log('info', 'Nenhuma instância em execução para parar.');
    c.log('info', `Parando ${ids.length} instância(s): ${ids.join(', ')}`);
    await aws(['ec2', 'stop-instances', '--instance-ids', ...ids], { signal: ctx.signal });
    await ec2Wait(c, ids, 'stopped');
    c.log('ok', 'Instâncias paradas.');
  }

  async function ec2Start(ctx) {
    const c = tagged(ctx, 'EC2');
    const list = await ec2Settle(c);
    const ids = list.filter((i) => !i.skip && i.state === 'stopped').map((i) => i.id);
    if (!ids.length) return c.log('info', 'Nenhuma instância parada para iniciar.');
    c.log('info', `Iniciando ${ids.length} instância(s): ${ids.join(', ')}`);
    await aws(['ec2', 'start-instances', '--instance-ids', ...ids], { signal: ctx.signal });
    await ec2Wait(c, ids, 'running');
    c.log('ok', 'Instâncias em execução.');
  }

  // =====================================================================================
  // RDS / Aurora
  // =====================================================================================
  const RDS = {
    instance: { get: ['rds', 'describe-db-instances', '--db-instance-identifier'], stop: 'stop-db-instance', start: 'start-db-instance', flag: '--db-instance-identifier', label: 'RDS' },
    cluster: { get: ['rds', 'describe-db-clusters', '--db-cluster-identifier'], stop: 'stop-db-cluster', start: 'start-db-cluster', flag: '--db-cluster-identifier', label: 'Aurora' },
  };
  const rdsNorm = (s) => (s === 'available' ? 'running' : s === 'stopped' ? 'stopped' : /^(failed|inaccessible|incompatible|storage-full|restore-error)/.test(s) ? 'error' : 'transitioning');

  async function rdsGet(kind, id, signal) {
    const d = await aws([...RDS[kind].get, id], { signal });
    const x = kind === 'instance' ? d.DBInstances?.[0] : d.DBClusters?.[0];
    if (!x) throw new Error(`${RDS[kind].label} "${id}" não encontrado`);
    return kind === 'instance' ? { status: x.DBInstanceStatus, cluster: x.DBClusterIdentifier, replica: x.ReadReplicaSourceDBInstanceIdentifier, engine: x.Engine } : { status: x.Status, engine: x.Engine };
  }

  async function rdsWait(kind, id, accept, ctx) {
    let last = '';
    return wait(
      async () => {
        const info = await rdsGet(kind, id, ctx.signal);
        if (info.status !== last) ctx.log('info', `status: ${info.status}`);
        last = info.status;
        if (rdsNorm(info.status) === 'error') throw new Error(`${RDS[kind].label} "${id}" em estado ${info.status}`);
        return accept.includes(info.status) ? info : null;
      },
      `${RDS[kind].label} ${accept.join('/')}`,
      ctx,
    );
  }

  async function rdsStop(kind, id, ctx) {
    const c = tagged(ctx, `${RDS[kind].label} ${id}`);
    let info = await rdsGet(kind, id, ctx.signal);
    if (kind === 'instance' && info.cluster) return c.log('warn', `membro do cluster Aurora "${info.cluster}" — configure o cluster em "Clusters Aurora", não a instância.`);
    if (info.replica) return c.log('warn', `réplica de leitura de "${info.replica}" — a AWS não permite parar réplicas.`);
    if (info.status === 'stopped') return c.log('info', 'já está parado.');
    if (!['available', 'stopping'].includes(info.status)) {
      c.log('info', `aguardando estado estável (atual: ${info.status})…`);
      info = await rdsWait(kind, id, ['available', 'stopped'], c);
      if (info.status === 'stopped') return c.log('info', 'já está parado.');
    }
    if (info.status === 'available') {
      c.log('info', 'Parando…');
      await aws(['rds', RDS[kind].stop, RDS[kind].flag, id], { signal: ctx.signal });
    }
    await rdsWait(kind, id, ['stopped'], c);
    c.log('ok', 'parado. Atenção: a AWS religa instâncias RDS automaticamente após 7 dias paradas.');
  }

  async function rdsStart(kind, id, ctx) {
    const c = tagged(ctx, `${RDS[kind].label} ${id}`);
    let info = await rdsGet(kind, id, ctx.signal);
    if (info.status === 'available') return c.log('info', 'já está disponível.');
    if (kind === 'instance' && info.cluster) return c.log('warn', `membro do cluster Aurora "${info.cluster}" — use o cluster.`);
    if (!['stopped', 'starting'].includes(info.status)) {
      c.log('info', `aguardando estado estável (atual: ${info.status})…`);
      info = await rdsWait(kind, id, ['available', 'stopped'], c);
      if (info.status === 'available') return c.log('info', 'já está disponível.');
    }
    if (info.status === 'stopped') {
      c.log('info', 'Iniciando…');
      await aws(['rds', RDS[kind].start, RDS[kind].flag, id], { signal: ctx.signal });
    }
    await rdsWait(kind, id, ['available'], c);
    c.log('ok', 'disponível.');
  }

  // =====================================================================================
  // ElastiCache (excluir com snapshot final / recriar do snapshot)
  // =====================================================================================
  async function snapshotGet(name, signal) {
    try {
      return (await aws(['elasticache', 'describe-snapshots', '--snapshot-name', name], { signal })).Snapshots?.[0] ?? null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async function snapshotWait(name, ctx) {
    return wait(
      async () => {
        const s = await snapshotGet(name, ctx.signal);
        if (s?.SnapshotStatus === 'failed') throw new Error(`O snapshot "${name}" falhou — os dados do cache podem estar perdidos. Verifique o console do ElastiCache.`);
        return s?.SnapshotStatus === 'available' ? s : null;
      },
      `snapshot ${name} available`,
      ctx,
    );
  }

  async function tagsOf(arn, signal) {
    if (!arn) return [];
    try {
      return (await aws(['elasticache', 'list-tags-for-resource', '--resource-name', arn], { signal })).TagList ?? [];
    } catch {
      return [];
    }
  }

  // ----- replication groups -----
  async function rgGet(id, signal) {
    try {
      return (await aws(['elasticache', 'describe-replication-groups', '--replication-group-id', id], { signal })).ReplicationGroups?.[0] ?? null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async function captureRg(rg, signal) {
    if (rg.GlobalReplicationGroupInfo?.GlobalReplicationGroupId) throw new Error(`"${rg.ReplicationGroupId}" faz parte de um Global Datastore — não suportado (excluir quebraria a replicação global).`);
    if (rg.AuthTokenEnabled) throw new Error(`"${rg.ReplicationGroupId}" usa AUTH token, que não pode ser recuperado ao recriar. Nada foi excluído.`);
    const member = rg.MemberClusters?.[0];
    if (!member) throw new Error(`"${rg.ReplicationGroupId}" não tem nós membros.`);
    const cc = (await aws(['elasticache', 'describe-cache-clusters', '--cache-cluster-id', member], { signal })).CacheClusters?.[0];
    if (!cc) throw new Error('Não foi possível ler a configuração do nó membro.');
    const groups = rg.NodeGroups ?? [];
    const first = groups[0];
    const endpoint = rg.ConfigurationEndpoint ?? first?.PrimaryEndpoint;
    return {
      description: rg.Description,
      engine: cc.Engine,
      engineVersion: cc.EngineVersion,
      nodeType: rg.CacheNodeType,
      clusterEnabled: Boolean(rg.ClusterEnabled),
      numNodeGroups: groups.length || 1,
      replicasPerNodeGroup: Math.max(0, (first?.NodeGroupMembers?.length ?? 1) - 1),
      numCacheClusters: rg.MemberClusters.length,
      preferredAzs: (first?.NodeGroupMembers ?? []).map((m) => m.PreferredAvailabilityZone).filter(Boolean),
      automaticFailover: ['enabled', 'enabling'].includes(rg.AutomaticFailover),
      multiAz: rg.MultiAZ === 'enabled',
      subnetGroup: cc.CacheSubnetGroupName,
      securityGroupIds: (cc.SecurityGroups ?? []).map((s) => s.SecurityGroupId),
      parameterGroup: cc.CacheParameterGroup?.CacheParameterGroupName,
      port: endpoint?.Port,
      transitEncryption: Boolean(rg.TransitEncryptionEnabled),
      atRestEncryption: Boolean(rg.AtRestEncryptionEnabled),
      kmsKeyId: rg.KmsKeyId,
      snapshotRetentionLimit: rg.SnapshotRetentionLimit,
      snapshotWindow: rg.SnapshotWindow,
      maintenanceWindow: cc.PreferredMaintenanceWindow,
      userGroupIds: rg.UserGroupIds ?? [],
      endpointBefore: endpoint?.Address,
      arn: rg.ARN,
      tags: await tagsOf(rg.ARN, signal),
    };
  }

  const rgNorm = (rg) => (rg.Status === 'available' || rg.Status === 'snapshotting' ? 'running' : ['create-failed'].includes(rg.Status) ? 'error' : 'transitioning');

  async function rgStop(id, ctx) {
    const c = tagged(ctx, `ElastiCache ${id}`);
    const saved = (await readCache()).replicationGroups[id];
    let rg = await rgGet(id, ctx.signal);
    if (!rg) return c.log(saved ? 'info' : 'warn', saved ? `já desligado (excluído; snapshot "${saved.snapshotName}" guardado).` : 'não encontrado e sem snapshot registrado — nada a fazer.');
    if (rg.Status === 'deleting') {
      c.log('info', 'exclusão já em andamento — aguardando…');
    } else {
      if (rg.Status !== 'available') {
        c.log('info', `aguardando estado available (atual: ${rg.Status})…`);
        rg = await wait(async () => ((rg = await rgGet(id, ctx.signal)) && rg.Status === 'available' ? rg : null), 'replication group available', ctx);
      }
      const config = await captureRg(rg, ctx.signal); // valida ANTES de qualquer exclusão
      const snapshotName = `${id}-epma-${stamp()}`;
      // grava config + nome do snapshot ANTES de excluir: sem isso não há como recriar
      await mutate((ec) => {
        ec.replicationGroups[id] = { config, snapshotName, state: 'deleting', at: nowIso() };
      });
      c.log('warn', `EXCLUINDO o replication group (snapshot final "${snapshotName}"). O ElastiCache não tem stop/start.`);
      await aws(['elasticache', 'delete-replication-group', '--replication-group-id', id, '--final-snapshot-identifier', snapshotName], { signal: ctx.signal });
    }
    await wait(async () => (await rgGet(id, ctx.signal)) === null, 'exclusão do replication group', ctx);
    const entry = (await readCache()).replicationGroups[id];
    if (!entry) throw new Error(`"${id}" foi excluído fora desta ferramenta: não há snapshot/configuração registrados para recriá-lo.`);
    c.log('info', `aguardando o snapshot "${entry.snapshotName}" ficar disponível…`);
    await snapshotWait(entry.snapshotName, c);
    await mutate((ec) => {
      ec.replicationGroups[id].state = 'deleted';
    });
    c.log('ok', `excluído; snapshot "${entry.snapshotName}" disponível para recriação.`);
  }

  async function rgStart(id, ctx) {
    const c = tagged(ctx, `ElastiCache ${id}`);
    let saved = (await readCache()).replicationGroups[id];
    let rg = await rgGet(id, ctx.signal);
    if (rg?.Status === 'deleting' && saved) {
      c.log('info', 'exclusão em andamento — aguardando terminar para recriar…');
      await wait(async () => (await rgGet(id, ctx.signal)) === null, 'exclusão do replication group', ctx);
      rg = null;
    }
    if (rg) {
      if (saved) await mutate((ec) => delete ec.replicationGroups[id]); // registro obsoleto (exclusão não chegou a ocorrer)
      if (rg.Status !== 'available') await wait(async () => ((rg = await rgGet(id, ctx.signal)) && rg.Status === 'available' ? rg : null), 'replication group available', ctx);
      return c.log('info', 'já está disponível.');
    }
    if (!saved) throw new Error(`Replication group "${id}" não existe e não há snapshot registrado para recriá-lo.`);
    c.log('info', `aguardando o snapshot "${saved.snapshotName}"…`);
    await snapshotWait(saved.snapshotName, c);
    c.log('info', 'Recriando a partir do snapshot…');
    await aws(buildCreateReplicationGroupArgs(id, saved.config, saved.snapshotName), { signal: ctx.signal });
    rg = await wait(async () => ((rg = await rgGet(id, ctx.signal)) && rg.Status === 'available' ? rg : null), 'replication group available', ctx);
    const now = rg.ConfigurationEndpoint?.Address ?? rg.NodeGroups?.[0]?.PrimaryEndpoint?.Address;
    if (saved.config.endpointBefore && now && now !== saved.config.endpointBefore) {
      c.log('warn', `O endpoint MUDOU: ${saved.config.endpointBefore} → ${now}. Atualize as aplicações (ou use um CNAME no Route 53).`);
    }
    await mutate((ec) => {
      ec.history.push({ type: 'replication-group', id, snapshotName: saved.snapshotName, restoredAt: nowIso() });
      delete ec.replicationGroups[id];
    });
    c.log('ok', `recriado e disponível. O snapshot "${saved.snapshotName}" foi mantido (custo de armazenamento): exclua-o quando não precisar mais.`);
  }

  // ----- serverless -----
  async function svGet(name, signal) {
    try {
      return (await aws(['elasticache', 'describe-serverless-caches', '--serverless-cache-name', name], { signal })).ServerlessCaches?.[0] ?? null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async function svStop(name, ctx) {
    const c = tagged(ctx, `ElastiCache Serverless ${name}`);
    const saved = (await readCache()).serverless[name];
    let sv = await svGet(name, ctx.signal);
    if (!sv) return c.log(saved ? 'info' : 'warn', saved ? `já desligado (excluído; snapshot "${saved.snapshotName}" guardado).` : 'não encontrado e sem snapshot registrado — nada a fazer.');
    if (sv.Status !== 'deleting') {
      if (/memcached/i.test(sv.Engine)) throw new Error(`"${name}" é Memcached Serverless: não há snapshot para restaurar os dados. Nada foi excluído.`);
      if (sv.Status !== 'available') sv = await wait(async () => ((sv = await svGet(name, ctx.signal)) && sv.Status === 'available' ? sv : null), 'cache serverless available', ctx);
      const config = {
        description: sv.Description,
        engine: sv.Engine,
        majorEngineVersion: sv.MajorEngineVersion,
        subnetIds: sv.SubnetIds ?? [],
        securityGroupIds: sv.SecurityGroupIds ?? [],
        kmsKeyId: sv.KmsKeyId,
        cacheUsageLimits: sv.CacheUsageLimits,
        snapshotRetentionLimit: sv.SnapshotRetentionLimit,
        dailySnapshotTime: sv.DailySnapshotTime,
        userGroupId: sv.UserGroupId,
        endpointBefore: sv.Endpoint?.Address,
        arn: sv.ARN,
        tags: await tagsOf(sv.ARN, ctx.signal),
      };
      const snapshotName = `${name}-epma-${stamp()}`;
      await mutate((ec) => {
        ec.serverless[name] = { config, snapshotName, state: 'deleting', at: nowIso() };
      });
      c.log('warn', `EXCLUINDO o cache serverless (snapshot final "${snapshotName}").`);
      await aws(['elasticache', 'delete-serverless-cache', '--serverless-cache-name', name, '--final-snapshot-name', snapshotName], { signal: ctx.signal });
    }
    await wait(async () => (await svGet(name, ctx.signal)) === null, 'exclusão do cache serverless', ctx);
    const entry = (await readCache()).serverless[name];
    if (!entry) throw new Error(`"${name}" foi excluído fora desta ferramenta: não há snapshot/configuração registrados para recriá-lo.`);
    await snapshotWait(entry.snapshotName, c);
    await mutate((ec) => {
      ec.serverless[name].state = 'deleted';
    });
    c.log('ok', `excluído; snapshot "${entry.snapshotName}" disponível.`);
  }

  async function svStart(name, ctx) {
    const c = tagged(ctx, `ElastiCache Serverless ${name}`);
    const saved = (await readCache()).serverless[name];
    let sv = await svGet(name, ctx.signal);
    if (sv?.Status === 'deleting' && saved) {
      await wait(async () => (await svGet(name, ctx.signal)) === null, 'exclusão do cache serverless', ctx);
      sv = null;
    }
    if (sv) {
      if (saved) await mutate((ec) => delete ec.serverless[name]);
      if (sv.Status !== 'available') await wait(async () => ((sv = await svGet(name, ctx.signal)) && sv.Status === 'available' ? sv : null), 'cache serverless available', ctx);
      return c.log('info', 'já está disponível.');
    }
    if (!saved) throw new Error(`Cache serverless "${name}" não existe e não há snapshot registrado para recriá-lo.`);
    const snap = await snapshotWait(saved.snapshotName, c);
    c.log('info', 'Recriando a partir do snapshot…');
    await aws(buildCreateServerlessArgs(name, saved.config, snap.ARN), { signal: ctx.signal });
    sv = await wait(async () => ((sv = await svGet(name, ctx.signal)) && sv.Status === 'available' ? sv : null), 'cache serverless available', ctx);
    if (saved.config.endpointBefore && sv.Endpoint?.Address && sv.Endpoint.Address !== saved.config.endpointBefore) {
      c.log('warn', `O endpoint MUDOU: ${saved.config.endpointBefore} → ${sv.Endpoint.Address}.`);
    }
    await mutate((ec) => {
      ec.history.push({ type: 'serverless', id: name, snapshotName: saved.snapshotName, restoredAt: nowIso() });
      delete ec.serverless[name];
    });
    c.log('ok', `recriado. O snapshot "${saved.snapshotName}" foi mantido: exclua-o quando não precisar mais.`);
  }

  // =====================================================================================
  // interface pública
  // =====================================================================================
  const dataJobs = (fnRds, fnRg, fnSv, ctx) => [
    ...r.rds.instances.map((id) => fnRds('instance', id, ctx)),
    ...r.rds.clusters.map((id) => fnRds('cluster', id, ctx)),
    ...r.elasticache.replicationGroups.map((id) => fnRg(id, ctx)),
    ...r.elasticache.serverlessCaches.map((id) => fnSv(id, ctx)),
  ];

  return {
    hasEc2: Boolean(r.ec2.instanceIds.length || r.ec2.tagKey),
    hasData: Boolean(r.rds.instances.length || r.rds.clusters.length || r.elasticache.replicationGroups.length || r.elasticache.serverlessCaches.length),

    /** Estado de cada recurso, para o painel. Falhas individuais viram itens "error". */
    async describe(signal) {
      const out = [];
      const jobs = [];
      const job = (type, id, fn) =>
        jobs.push(
          fn().catch((err) => {
            if (err.name === 'AbortedError') throw err;
            out.push({ type, id, state: 'error', detail: err.message });
          }),
        );
      if (r.ec2.instanceIds.length || r.ec2.tagKey) {
        jobs.push(
          ec2List(signal)
            .then((list) => {
              if (!list.length) out.push({ type: 'ec2', id: '(seletor)', state: 'missing', detail: 'nenhuma instância encontrada' });
              for (const i of list) {
                out.push({ type: 'ec2', id: i.name ? `${i.id} (${i.name})` : i.id, state: i.state === 'running' ? 'running' : i.state === 'stopped' ? 'stopped' : 'transitioning', ignored: Boolean(i.skip), detail: i.skip ? `ignorada: ${i.skip}` : `${i.state} · ${i.type}` });
              }
            })
            .catch((err) => out.push({ type: 'ec2', id: '(seletor)', state: 'error', detail: err.message })),
        );
      }
      for (const kind of ['instance', 'cluster']) {
        for (const id of r.rds[kind === 'instance' ? 'instances' : 'clusters']) {
          job(`rds-${kind}`, id, async () => {
            const info = await rdsGet(kind, id, signal);
            const skip = kind === 'instance' && (info.cluster ? `membro do cluster ${info.cluster}` : info.replica ? 'réplica de leitura' : null);
            out.push({ type: `rds-${kind}`, id, state: rdsNorm(info.status), ignored: Boolean(skip), detail: skip ? `ignorado: ${skip}` : `${info.status} · ${info.engine}` });
          });
        }
      }
      const cache = await readCache();
      for (const id of r.elasticache.replicationGroups) {
        job('elasticache-rg', id, async () => {
          const rg = await rgGet(id, signal);
          const saved = cache.replicationGroups[id];
          if (rg) out.push({ type: 'elasticache-rg', id, state: rgNorm(rg), detail: `${rg.Status} · ${rg.CacheNodeType}` });
          else if (saved) out.push({ type: 'elasticache-rg', id, state: 'stopped', detail: `excluído · snapshot ${saved.snapshotName}` });
          else out.push({ type: 'elasticache-rg', id, state: 'missing', detail: 'não encontrado e sem snapshot registrado' });
        });
      }
      for (const id of r.elasticache.serverlessCaches) {
        job('elasticache-serverless', id, async () => {
          const sv = await svGet(id, signal);
          const saved = cache.serverless[id];
          if (sv) out.push({ type: 'elasticache-serverless', id, state: sv.Status === 'available' ? 'running' : 'transitioning', detail: `${sv.Status} · ${sv.Engine}` });
          else if (saved) out.push({ type: 'elasticache-serverless', id, state: 'stopped', detail: `excluído · snapshot ${saved.snapshotName}` });
          else out.push({ type: 'elasticache-serverless', id, state: 'missing', detail: 'não encontrado e sem snapshot registrado' });
        });
      }
      await Promise.all(jobs);
      return out;
    },

    // camada de aplicação (EC2) e camada de dados (RDS + ElastiCache, em paralelo)
    stopApp: (ctx) => (r.ec2.instanceIds.length || r.ec2.tagKey ? ec2Stop(ctx) : undefined),
    startApp: (ctx) => (r.ec2.instanceIds.length || r.ec2.tagKey ? ec2Start(ctx) : undefined),
    stopData: (ctx) => settleAll(dataJobs(rdsStop, rgStop, svStop, ctx)),
    startData: (ctx) => settleAll(dataJobs(rdsStart, rgStart, svStart, ctx)),
  };
}
