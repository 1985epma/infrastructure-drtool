// Provider EKS.
//
// O plano de controle do EKS não pode ser "desligado": o que se desliga é a capacidade de
// computação. "Desligar" = zerar o desiredSize dos managed node groups (guardando a escala
// original num snapshot em disco); "Ligar" = restaurar esse snapshot e aguardar os nós Ready.
// Opcionalmente também escala Deployments/StatefulSets para 0 (e restaura depois).
import { run } from '../exec.js';
import { waitFor, nowIso } from '../util.js';

const NODEGROUP_LABEL = 'eks.amazonaws.com/nodegroup';
const KUBECONFIG_TTL_MS = 30 * 60 * 1000;

export function awsEnv(cfg) {
  const e = { AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
  if (cfg.profile) e.AWS_PROFILE = cfg.profile;
  if (cfg.region) {
    e.AWS_REGION = cfg.region;
    e.AWS_DEFAULT_REGION = cfg.region;
  }
  return e;
}

export async function awsJson(cfg, args, { signal, timeoutMs = 90_000 } = {}) {
  const full = [...args, '--output', 'json', '--no-cli-pager'];
  if (cfg.region) full.push('--region', cfg.region);
  const r = await run('aws', full, { env: awsEnv(cfg), signal, timeoutMs });
  if (r.code !== 0) {
    const stderr = r.stderr.trim();
    const err = new Error(stderr.split('\n').slice(-3).join(' ').slice(0, 600) || `aws saiu com código ${r.code}`);
    // cobre ResourceNotFoundException, DBInstanceNotFound, ReplicationGroupNotFoundFault,
    // ServerlessCacheNotFoundFault, SnapshotNotFoundFault, InvalidInstanceID.NotFound…
    if (/NotFound|No cluster found|NoSuchEntity/i.test(stderr)) err.code = 'NOT_FOUND';
    else if (/ExpiredToken|Unable to locate credentials|token.*expired|InvalidClientTokenId|SSO|AccessDenied|UnauthorizedOperation/i.test(stderr)) {
      err.code = 'AUTH';
      err.message += cfg.profile
        ? ` — verifique as credenciais (ex.: aws sso login --profile ${cfg.profile})`
        : ' — verifique as credenciais AWS (variáveis de ambiente ou perfil)';
    }
    throw err;
  }
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : {};
}

export function createEksProvider(env, { store }) {
  const cfg = env.eks;
  const kubePath = store.kubeconfigPath(env.id);
  let kubeReadyAt = 0;

  const aws = (args, opts) => awsJson(cfg, args, opts);

  // ---------- kubectl ----------
  async function ensureKubeconfig(signal) {
    if (Date.now() - kubeReadyAt < KUBECONFIG_TTL_MS) return;
    const args = ['eks', 'update-kubeconfig', '--name', cfg.clusterName, '--region', cfg.region, '--kubeconfig', kubePath];
    if (cfg.profile) args.push('--profile', cfg.profile);
    const r = await run('aws', args, { env: awsEnv(cfg), signal, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`update-kubeconfig falhou: ${r.stderr.trim().slice(0, 300)}`);
    kubeReadyAt = Date.now();
  }

  async function kubectl(args, { signal, timeoutMs = 45_000 } = {}) {
    await ensureKubeconfig(signal);
    const r = await run('kubectl', ['--kubeconfig', kubePath, '--request-timeout=20s', ...args], { env: awsEnv(cfg), signal, timeoutMs });
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400) || `kubectl saiu com código ${r.code}`);
    return r.stdout;
  }

  async function countNodes(signal) {
    const data = JSON.parse(await kubectl(['get', 'nodes', '-o', 'json'], { signal }));
    const managed = data.items.filter((n) => n.metadata?.labels?.[NODEGROUP_LABEL]);
    const ready = managed.filter((n) => n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
    return { ready: ready.length, total: managed.length };
  }

  // ---------- node groups ----------
  async function describeNodegroups(signal) {
    let names = (await aws(['eks', 'list-nodegroups', '--cluster-name', cfg.clusterName], { signal })).nodegroups ?? [];
    if (cfg.nodegroups.length) names = names.filter((n) => cfg.nodegroups.includes(n));
    return Promise.all(
      names.map(async (name) => {
        const { nodegroup: g } = await aws(['eks', 'describe-nodegroup', '--cluster-name', cfg.clusterName, '--nodegroup-name', name], { signal });
        return {
          name: g.nodegroupName,
          status: g.status,
          min: g.scalingConfig?.minSize ?? 0,
          max: g.scalingConfig?.maxSize ?? 0,
          desired: g.scalingConfig?.desiredSize ?? 0,
          instanceTypes: g.instanceTypes ?? [],
          capacityType: g.capacityType,
          issues: (g.health?.issues ?? []).map((x) => x.message || x.code),
        };
      }),
    );
  }

  async function setScaling(g, { min, max, desired }, ctx) {
    ctx.log('info', `Node group "${g.name}": min=${min} desired=${desired} max=${max}`);
    await aws(
      ['eks', 'update-nodegroup-config', '--cluster-name', cfg.clusterName, '--nodegroup-name', g.name, '--scaling-config', `minSize=${min},maxSize=${max},desiredSize=${desired}`],
      { signal: ctx.signal },
    );
  }

  async function waitGroups(ctx, predicate, label, timeoutMs) {
    let last = '';
    await waitFor(
      async () => {
        const gs = await describeNodegroups(ctx.signal);
        const summary = gs.map((g) => `${g.name}: ${g.status} (desired ${g.desired})`).join(' · ');
        if (summary !== last) {
          ctx.log('info', summary);
          last = summary;
        }
        return predicate(gs);
      },
      { timeoutMs, intervalMs: 10_000, signal: ctx.signal, label },
    );
  }

  // ---------- workloads (opcional) ----------
  async function scaleWorkloadsDown(ctx, snapshot) {
    snapshot.workloads ??= {};
    for (const ns of cfg.workloadNamespaces) {
      const data = JSON.parse(await kubectl(['get', 'deployments,statefulsets', '-n', ns, '-o', 'json'], { signal: ctx.signal }));
      for (const item of data.items) {
        const replicas = item.spec?.replicas ?? 0;
        const key = `${ns}/${item.kind.toLowerCase()}/${item.metadata.name}`;
        if (replicas > 0) snapshot.workloads[key] = replicas;
        if (replicas > 0) {
          await kubectl(['scale', '-n', ns, `${item.kind.toLowerCase()}/${item.metadata.name}`, '--replicas=0'], { signal: ctx.signal });
          ctx.log('info', `Escalado para 0: ${key} (era ${replicas})`);
        }
      }
    }
  }

  async function restoreWorkloads(ctx, snapshot) {
    const entries = Object.entries(snapshot.workloads ?? {});
    if (!entries.length) return ctx.log('warn', 'Nenhum workload salvo para restaurar.');
    for (const [key, replicas] of entries) {
      const [ns, kind, name] = key.split('/');
      await kubectl(['scale', '-n', ns, `${kind}/${name}`, `--replicas=${replicas}`], { signal: ctx.signal });
      ctx.log('info', `Restaurado: ${key} → ${replicas} réplica(s)`);
    }
  }

  return {
    kind: 'eks',
    label: 'Amazon EKS (managed node groups)',

    async status({ signal } = {}) {
      let cluster;
      try {
        cluster = (await aws(['eks', 'describe-cluster', '--name', cfg.clusterName], { signal })).cluster;
      } catch (err) {
        if (err.code === 'NOT_FOUND') return { state: 'missing', note: `Cluster "${cfg.clusterName}" não encontrado em ${cfg.region}.` };
        throw err;
      }
      const groups = await describeNodegroups(signal);
      let state;
      if (cluster.status !== 'ACTIVE') state = ['FAILED'].includes(cluster.status) ? 'error' : 'transitioning';
      else if (groups.length === 0) state = 'unknown';
      else if (groups.some((g) => ['CREATING', 'UPDATING', 'DELETING'].includes(g.status))) state = 'transitioning';
      else if (groups.every((g) => g.desired === 0)) state = 'stopped';
      else if (groups.every((g) => g.desired > 0)) state = 'running';
      else state = 'partial';

      let nodes = null;
      if (cfg.useKubectl && state !== 'stopped') {
        try {
          nodes = await countNodes(signal);
        } catch {
          nodes = null; // kubectl é opcional para o status
        }
      }
      const snap = await store.getState(env.id);
      return {
        state,
        note: groups.length === 0 ? 'Cluster sem managed node groups (Fargate/Karpenter/self-managed?). Use o provider por comandos.' : undefined,
        cluster: { name: cluster.name, status: cluster.status, version: cluster.version, platformVersion: cluster.platformVersion, endpoint: cluster.endpoint },
        nodegroups: groups,
        nodes,
        saved: snap.savedAt ? { savedAt: snap.savedAt, nodegroups: snap.nodegroups ?? {}, workloads: Object.keys(snap.workloads ?? {}).length } : null,
      };
    },

    async stop(ctx) {
      ctx.log('info', `Lendo node groups do cluster ${cfg.clusterName} (${cfg.region})…`);
      const groups = await describeNodegroups(ctx.signal);
      if (groups.length === 0) throw new Error('Nenhum managed node group encontrado — nada para desligar.');

      const snapshot = await store.getState(env.id);
      snapshot.nodegroups ??= {};

      if (cfg.scaleWorkloads) {
        ctx.log('info', 'Escalando workloads para 0 antes de remover os nós…');
        await scaleWorkloadsDown(ctx, snapshot);
      }

      // Nunca sobrescreve um snapshot válido com valores zerados (ex.: dois "desligar" seguidos).
      for (const g of groups) {
        if (g.desired > 0 || !snapshot.nodegroups[g.name]) {
          snapshot.nodegroups[g.name] = { min: g.min, max: g.max, desired: g.desired };
        }
      }
      snapshot.savedAt = nowIso();
      await store.setState(env.id, snapshot);
      ctx.log('ok', `Escala original salva (${groups.map((g) => `${g.name}=${snapshot.nodegroups[g.name].desired}`).join(', ')}).`);

      // aguarda updates anteriores terminarem
      await waitGroups(ctx, (gs) => gs.every((g) => g.status === 'ACTIVE' || g.status === 'DEGRADED'), 'node groups ficarem ACTIVE', 10 * 60_000);

      for (const g of groups) {
        if (g.desired === 0 && g.min === 0) {
          ctx.log('info', `Node group "${g.name}" já está em zero.`);
          continue;
        }
        await setScaling(g, { min: 0, max: Math.max(g.max, 1), desired: 0 }, ctx);
      }
      await waitGroups(ctx, (gs) => gs.every((g) => g.desired === 0 && (g.status === 'ACTIVE' || g.status === 'DEGRADED')), 'node groups em zero', cfg.readyTimeoutSec * 1000);

      if (cfg.useKubectl) {
        try {
          await waitFor(async () => (await countNodes(ctx.signal)).total === 0, { timeoutMs: 5 * 60_000, intervalMs: 10_000, signal: ctx.signal, label: 'remoção dos nós' });
          ctx.log('ok', 'Todos os nós foram removidos do cluster.');
        } catch (err) {
          if (err.name === 'AbortedError') throw err;
          ctx.log('warn', `Não foi possível confirmar a remoção dos nós via kubectl: ${err.message}`);
        }
      }
      ctx.log('ok', 'Cluster desligado (capacidade de computação zerada).');
    },

    async start(ctx) {
      ctx.log('info', `Lendo node groups do cluster ${cfg.clusterName} (${cfg.region})…`);
      const groups = await describeNodegroups(ctx.signal);
      if (groups.length === 0) throw new Error('Nenhum managed node group encontrado.');
      const snapshot = await store.getState(env.id);
      if (!snapshot.nodegroups) ctx.log('warn', `Sem snapshot de escala salvo — usando fallback de ${cfg.fallbackDesired} nó(s) por node group.`);

      await waitGroups(ctx, (gs) => gs.every((g) => g.status === 'ACTIVE' || g.status === 'DEGRADED'), 'node groups ficarem ACTIVE', 10 * 60_000);

      let needNodes = 0;
      for (const g of groups) {
        const saved = snapshot.nodegroups?.[g.name];
        if (g.desired > 0) {
          ctx.log('info', `Node group "${g.name}" já está com ${g.desired} nó(s).`);
          needNodes += g.desired;
          continue;
        }
        const desired = saved?.desired > 0 ? saved.desired : cfg.fallbackDesired;
        if (!(saved?.desired > 0)) ctx.log('warn', `Node group "${g.name}": sem escala salva, usando ${desired}.`);
        const min = Math.min(saved?.min ?? 0, desired);
        const max = Math.max(saved?.max ?? desired, desired);
        await setScaling(g, { min, max, desired }, ctx);
        needNodes += desired;
      }
      await waitGroups(ctx, (gs) => gs.every((g) => g.desired > 0 && (g.status === 'ACTIVE' || g.status === 'DEGRADED')), 'node groups ACTIVE', cfg.readyTimeoutSec * 1000);

      if (cfg.useKubectl) {
        ctx.log('info', `Aguardando ${needNodes} nó(s) Ready…`);
        let lastCount = '';
        await waitFor(
          async () => {
            try {
              const n = await countNodes(ctx.signal);
              const txt = `${n.ready}/${needNodes}`;
              if (txt !== lastCount) {
                ctx.log('info', `Nós Ready: ${txt}`);
                lastCount = txt;
              }
              return n.ready >= needNodes;
            } catch (err) {
              if (err.name === 'AbortedError') throw err;
              if (lastCount !== 'err') ctx.log('warn', `kubectl: ${err.message}`);
              lastCount = 'err';
              return false;
            }
          },
          { timeoutMs: cfg.readyTimeoutSec * 1000, intervalMs: 10_000, signal: ctx.signal, label: 'nós Ready' },
        );
      }
      if (cfg.scaleWorkloads) {
        ctx.log('info', 'Restaurando workloads…');
        await restoreWorkloads(ctx, snapshot);
      }
      ctx.log('ok', 'Infraestrutura religada (nós prontos).');
    },

    async kube() {
      await ensureKubeconfig();
      return { args: ['--kubeconfig', kubePath], env: awsEnv(cfg) };
    },
  };
}
