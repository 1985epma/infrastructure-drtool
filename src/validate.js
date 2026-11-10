// Validação/normalização das configurações. Nada que o usuário digita vira argumento
// de shell: tudo é validado aqui e depois passado como argv.
import { HttpError, tokenize, uid } from './util.js';

const KUBE_CTX_RE = /^[\w.@:/=+-]{1,200}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/; // cluster, nodegroup, deployment, db id
const REGION_RE = /^[a-z]{2,3}(-[a-z]+)+-\d$/;
const PROFILE_RE = /^[\w.@+=,-]{1,100}$/;
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253})$|^\[[0-9A-Fa-f:]+\]$/;
const EC2_ID_RE = /^i-[0-9a-f]{8,17}$/;
const RDS_ID_RE = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const CACHE_ID_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const TAG_RE = /^[\w.:/=+@ -]{1,128}$/; // sem vírgula/aspas: vai dentro de --filters Name=…,Values=…

/** O ambiente tem EC2/RDS/ElastiCache configurados? */
export function hasResources(env) {
  const r = env?.resources;
  if (!r) return false;
  return Boolean(r.ec2.instanceIds.length || r.ec2.tagKey || r.rds.instances.length || r.rds.clusters.length || r.elasticache.replicationGroups.length || r.elasticache.serverlessCaches.length);
}

class Collector {
  constructor() {
    this.errors = [];
  }
  fail(path, msg) {
    this.errors.push(`${path}: ${msg}`);
  }
  str(v, path, { max = 200, required = false, pattern, patternMsg, def = '' } = {}) {
    if (v == null || v === '') {
      if (required) this.fail(path, 'obrigatório');
      return def;
    }
    if (typeof v !== 'string') {
      this.fail(path, 'deve ser texto');
      return def;
    }
    const s = v.trim();
    if (s.length > max) this.fail(path, `máximo de ${max} caracteres`);
    if (pattern && s && !pattern.test(s)) this.fail(path, patternMsg ?? 'formato inválido');
    return s;
  }
  int(v, path, { min, max, def }) {
    if (v == null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      this.fail(path, `inteiro entre ${min} e ${max}`);
      return def;
    }
    return n;
  }
  bool(v, def = false) {
    return v == null ? def : v === true || v === 'true';
  }
  oneOf(v, path, allowed, def) {
    if (v == null || v === '') return def;
    if (!allowed.includes(v)) {
      this.fail(path, `valores aceitos: ${allowed.join(', ')}`);
      return def;
    }
    return v;
  }
  strList(v, path, itemOpts) {
    if (v == null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
    return arr.map((x) => String(x).trim()).filter(Boolean).map((x, i) => this.str(x, `${path}[${i}]`, itemOpts));
  }
}

/** Valida URL permitindo o placeholder {{origin}}. */
function checkUrl(c, v, path) {
  const s = c.str(v, path, { required: true, max: 2000 });
  if (!s) return s;
  try {
    const u = new URL(s.replaceAll('{{origin}}', 'http://127.0.0.1:1'));
    if (!['http:', 'https:'].includes(u.protocol)) c.fail(path, 'use http:// ou https://');
  } catch {
    c.fail(path, 'URL inválida');
  }
  return s;
}

export function parseStatusSpec(spec) {
  const ranges = [];
  for (const part of String(spec ?? '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(p);
    if (!m) return null;
    ranges.push([Number(m[1]), Number(m[2] ?? m[1])]);
  }
  return ranges.length ? ranges : null;
}

export function statusMatches(spec, status) {
  const ranges = parseStatusSpec(spec) ?? [[200, 399]];
  return ranges.some(([a, b]) => status >= a && status <= b);
}

export function normalizeCheck(input, path = 'check') {
  const c = new Collector();
  const out = normalizeCheckInto(c, input ?? {}, path);
  if (c.errors.length) throw new HttpError(400, 'Teste inválido', c.errors);
  return out;
}

function normalizeCheckInto(c, i, path) {
  const type = c.oneOf(i.type, `${path}.type`, ['http', 'tcp', 'k8s', 'command'], 'http');
  const out = {
    id: c.str(i.id, `${path}.id`, { max: 40, pattern: /^[\w-]+$/ }) || uid('c'),
    name: c.str(i.name, `${path}.name`, { required: true, max: 80 }),
    type,
    critical: c.bool(i.critical, true),
  };
  if (type === 'http') {
    out.url = checkUrl(c, i.url, `${path}.url`);
    out.method = c.oneOf(i.method, `${path}.method`, ['GET', 'HEAD'], 'GET');
    out.expectStatus = c.str(i.expectStatus, `${path}.expectStatus`, { max: 60, def: '200-399' }) || '200-399';
    if (!parseStatusSpec(out.expectStatus)) c.fail(`${path}.expectStatus`, 'use o formato 200, 200-299 ou 200,204');
    out.contains = c.str(i.contains, `${path}.contains`, { max: 200 });
    out.timeoutMs = c.int(i.timeoutMs, `${path}.timeoutMs`, { min: 200, max: 60000, def: 5000 });
    out.maxLatencyMs = c.int(i.maxLatencyMs, `${path}.maxLatencyMs`, { min: 0, max: 60000, def: 0 });
    out.insecureTls = c.bool(i.insecureTls, false);
  } else if (type === 'tcp') {
    out.host = c.str(i.host, `${path}.host`, { required: true, max: 255, pattern: HOST_RE, patternMsg: 'host inválido' });
    out.port = c.int(i.port, `${path}.port`, { min: 1, max: 65535, def: 443 });
    out.timeoutMs = c.int(i.timeoutMs, `${path}.timeoutMs`, { min: 200, max: 60000, def: 3000 });
  } else if (type === 'k8s') {
    out.kind = c.oneOf(i.kind, `${path}.kind`, ['deployment', 'statefulset', 'daemonset'], 'deployment');
    out.namespace = c.str(i.namespace, `${path}.namespace`, { max: 63, def: 'default', pattern: K8S_NAME_RE }) || 'default';
    out.resource = c.str(i.resource, `${path}.resource`, { required: true, max: 253, pattern: K8S_NAME_RE });
  } else if (type === 'command') {
    out.command = c.str(i.command, `${path}.command`, { required: true, max: 500 });
    out.timeoutSec = c.int(i.timeoutSec, `${path}.timeoutSec`, { min: 1, max: 300, def: 20 });
    try {
      if (out.command && tokenize(out.command).length === 0) c.fail(`${path}.command`, 'vazio');
    } catch (err) {
      c.fail(`${path}.command`, err.message);
    }
  }
  return out;
}

export function normalizeRpoSource(i, c, path = 'rpoSource') {
  i = i ?? {};
  const type = c.oneOf(i.type, `${path}.type`, ['none', 'canary', 'http', 'command', 'rds-instance', 'rds-cluster'], 'none');
  const out = { type };
  if (type === 'canary') {
    out.writeCommand = c.str(i.writeCommand, `${path}.writeCommand`, { required: true, max: 500 });
    out.readCommand = c.str(i.readCommand, `${path}.readCommand`, { required: true, max: 500 });
    out.intervalSeconds = c.int(i.intervalSeconds, `${path}.intervalSeconds`, { min: 1, max: 60, def: 2 });
    out.timeoutSec = c.int(i.timeoutSec, `${path}.timeoutSec`, { min: 1, max: 300, def: 20 });
    for (const k of ['writeCommand', 'readCommand']) {
      try {
        if (out[k] && tokenize(out[k]).length === 0) c.fail(`${path}.${k}`, 'vazio');
      } catch (err) {
        c.fail(`${path}.${k}`, err.message);
      }
    }
  }
  if (type === 'http') {
    out.url = checkUrl(c, i.url, `${path}.url`);
    out.jsonPath = c.str(i.jsonPath, `${path}.jsonPath`, { max: 200 });
    out.timeoutMs = c.int(i.timeoutMs, `${path}.timeoutMs`, { min: 200, max: 60000, def: 8000 });
    out.insecureTls = c.bool(i.insecureTls, false);
  } else if (type === 'command') {
    out.command = c.str(i.command, `${path}.command`, { required: true, max: 500 });
    out.timeoutSec = c.int(i.timeoutSec, `${path}.timeoutSec`, { min: 1, max: 300, def: 30 });
  } else if (type === 'rds-instance' || type === 'rds-cluster') {
    out.identifier = c.str(i.identifier, `${path}.identifier`, { required: true, max: 100, pattern: NAME_RE });
    out.region = c.str(i.region, `${path}.region`, { max: 30, pattern: REGION_RE, patternMsg: 'região inválida (ex.: us-east-1)' });
    out.profile = c.str(i.profile, `${path}.profile`, { max: 100, pattern: PROFILE_RE });
  }
  return out;
}

export function normalizeEnvironment(input, { existing } = {}) {
  const c = new Collector();
  const i = input ?? {};
  const provider = c.oneOf(i.provider, 'provider', ['eks', 'custom', 'k8s', 'aws', 'simulated'], 'simulated');
  const env = {
    id: existing?.id ?? uid('env-'),
    name: c.str(i.name, 'name', { required: true, max: 80 }),
    description: c.str(i.description, 'description', { max: 500 }),
    provider,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const eks = i.eks ?? {};
  env.eks = {
    clusterName: c.str(eks.clusterName, 'eks.clusterName', { required: provider === 'eks', max: 100, pattern: NAME_RE, patternMsg: 'use letras, números, - _ .' }),
    region: c.str(eks.region, 'eks.region', { required: provider === 'eks', max: 30, pattern: REGION_RE, patternMsg: 'região inválida (ex.: us-east-1)' }),
    profile: c.str(eks.profile, 'eks.profile', { max: 100, pattern: PROFILE_RE }),
    nodegroups: c.strList(eks.nodegroups, 'eks.nodegroups', { max: 100, pattern: NAME_RE }),
    fallbackDesired: c.int(eks.fallbackDesired, 'eks.fallbackDesired', { min: 1, max: 500, def: 2 }),
    useKubectl: c.bool(eks.useKubectl, true),
    scaleWorkloads: c.bool(eks.scaleWorkloads, false),
    workloadNamespaces: c.strList(eks.workloadNamespaces, 'eks.workloadNamespaces', { max: 63, pattern: K8S_NAME_RE }),
    readyTimeoutSec: c.int(eks.readyTimeoutSec, 'eks.readyTimeoutSec', { min: 60, max: 7200, def: 1200 }),
  };
  if (env.eks.scaleWorkloads && env.eks.workloadNamespaces.length === 0) {
    c.fail('eks.workloadNamespaces', 'informe ao menos um namespace para escalar workloads');
  }

  // ---- recursos AWS anexáveis (EC2 / RDS / ElastiCache) ----
  const rs = i.resources ?? {};
  const rEc2 = rs.ec2 ?? {};
  const rRds = rs.rds ?? {};
  const rCache = rs.elasticache ?? {};
  env.resources = {
    region: c.str(rs.region, 'resources.region', { max: 30, pattern: REGION_RE, patternMsg: 'região inválida (ex.: us-east-1)' }),
    profile: c.str(rs.profile, 'resources.profile', { max: 100, pattern: PROFILE_RE }),
    timeoutSec: c.int(rs.timeoutSec, 'resources.timeoutSec', { min: 60, max: 14400, def: 3600 }),
    ec2: {
      instanceIds: c.strList(rEc2.instanceIds, 'resources.ec2.instanceIds', { max: 30, pattern: EC2_ID_RE, patternMsg: 'ID de instância inválido (i-xxxxxxxx)' }),
      tagKey: c.str(rEc2.tagKey, 'resources.ec2.tagKey', { max: 128, pattern: TAG_RE, patternMsg: 'caracteres inválidos' }),
      tagValue: c.str(rEc2.tagValue, 'resources.ec2.tagValue', { max: 128, pattern: TAG_RE, patternMsg: 'caracteres inválidos (sem vírgula)' }),
    },
    rds: {
      instances: c.strList(rRds.instances, 'resources.rds.instances', { max: 63, pattern: RDS_ID_RE, patternMsg: 'identificador RDS inválido' }),
      clusters: c.strList(rRds.clusters, 'resources.rds.clusters', { max: 63, pattern: RDS_ID_RE, patternMsg: 'identificador RDS inválido' }),
    },
    elasticache: {
      replicationGroups: c.strList(rCache.replicationGroups, 'resources.elasticache.replicationGroups', { max: 40, pattern: CACHE_ID_RE, patternMsg: 'identificador ElastiCache inválido' }),
      serverlessCaches: c.strList(rCache.serverlessCaches, 'resources.elasticache.serverlessCaches', { max: 40, pattern: CACHE_ID_RE, patternMsg: 'identificador ElastiCache inválido' }),
      acknowledgeDelete: c.bool(rCache.acknowledgeDelete, false),
    },
  };
  if (provider !== 'simulated') {
    const res = env.resources;
    const any = hasResources(env);
    if (provider === 'aws' && !any) c.fail('resources', 'informe ao menos um recurso (EC2, RDS ou ElastiCache)');
    if (any && !res.region && !(provider === 'eks' && env.eks.region)) c.fail('resources.region', 'obrigatório quando há recursos AWS');
    if (res.ec2.tagKey && !res.ec2.tagValue) c.fail('resources.ec2.tagValue', 'informe o valor da tag');
    if ((res.elasticache.replicationGroups.length || res.elasticache.serverlessCaches.length) && !res.elasticache.acknowledgeDelete) {
      c.fail('resources.elasticache.acknowledgeDelete', 'ElastiCache não tem stop/start: ao desligar o recurso é EXCLUÍDO (com snapshot final) e recriado ao ligar. Confirme que entende isso.');
    }
  }

  // ---- Kubernetes via kubectl (Docker Desktop, kind, minikube…): liga/desliga workloads ----
  const k = i.k8s ?? {};
  const rawWl = Array.isArray(k.workloads) ? k.workloads : typeof k.workloads === 'string' ? k.workloads.split(/[\s,]+/).filter(Boolean) : [];
  if (rawWl.length > 200) c.fail('k8s.workloads', 'máximo de 200 workloads');
  env.k8s = {
    context: c.str(k.context, 'k8s.context', { required: provider === 'k8s', max: 200, pattern: KUBE_CTX_RE, patternMsg: 'contexto inválido' }),
    kubeconfig: c.str(k.kubeconfig, 'k8s.kubeconfig', { max: 500 }),
    workloads: rawWl.slice(0, 200).map((w, idx) => {
      let ns;
      let kind;
      let name;
      if (typeof w === 'string') [ns, kind, name] = w.split('/');
      else ({ namespace: ns, kind, name } = w ?? {});
      const p = `k8s.workloads[${idx}]`;
      return {
        namespace: c.str(ns, `${p}.namespace`, { required: true, max: 63, pattern: K8S_NAME_RE }),
        kind: c.oneOf(kind, `${p}.kind`, ['deployment', 'statefulset'], 'deployment'),
        name: c.str(name, `${p}.name`, { required: true, max: 253, pattern: K8S_NAME_RE }),
      };
    }),
    timeoutSec: c.int(k.timeoutSec, 'k8s.timeoutSec', { min: 30, max: 3600, def: 300 }),
  };
  if (provider === 'k8s' && !env.k8s.workloads.length) c.fail('k8s.workloads', 'informe ao menos um workload (namespace/tipo/nome)');

  const cu = i.custom ?? {};
  env.custom = {
    cwd: c.str(cu.cwd, 'custom.cwd', { max: 500 }),
    statusCommand: c.str(cu.statusCommand, 'custom.statusCommand', { max: 500 }),
    startCommand: c.str(cu.startCommand, 'custom.startCommand', { required: provider === 'custom', max: 500 }),
    stopCommand: c.str(cu.stopCommand, 'custom.stopCommand', { required: provider === 'custom', max: 500 }),
    timeoutSec: c.int(cu.timeoutSec, 'custom.timeoutSec', { min: 10, max: 14400, def: 3600 }),
    kubeconfig: c.str(cu.kubeconfig, 'custom.kubeconfig', { max: 500 }),
    kubeContext: c.str(cu.kubeContext, 'custom.kubeContext', { max: 200 }),
  };
  for (const k of ['statusCommand', 'startCommand', 'stopCommand']) {
    try {
      if (env.custom[k]) tokenize(env.custom[k]);
    } catch (err) {
      c.fail(`custom.${k}`, err.message);
    }
  }

  const sim = i.simulated ?? {};
  env.simulated = {
    stopSeconds: c.int(sim.stopSeconds, 'simulated.stopSeconds', { min: 1, max: 600, def: 4 }),
    startSeconds: c.int(sim.startSeconds, 'simulated.startSeconds', { min: 1, max: 600, def: 12 }),
    warmupSeconds: c.int(sim.warmupSeconds, 'simulated.warmupSeconds', { min: 0, max: 600, def: 6 }),
    replicationLagSeconds: c.int(sim.replicationLagSeconds, 'simulated.replicationLagSeconds', { min: 0, max: 86400, def: 5 }),
  };

  const t = i.targets ?? {};
  env.targets = {
    rtoSeconds: c.int(t.rtoSeconds, 'targets.rtoSeconds', { min: 1, max: 604800, def: 900 }),
    rpoSeconds: c.int(t.rpoSeconds, 'targets.rpoSeconds', { min: 0, max: 604800, def: 300 }),
  };

  const d = i.drill ?? {};
  env.drill = {
    holdDownSeconds: c.int(d.holdDownSeconds, 'drill.holdDownSeconds', { min: 0, max: 7200, def: 30 }),
    probeIntervalSeconds: c.int(d.probeIntervalSeconds, 'drill.probeIntervalSeconds', { min: 1, max: 300, def: 5 }),
    stableProbes: c.int(d.stableProbes, 'drill.stableProbes', { min: 1, max: 60, def: 3 }),
    maxRecoverySeconds: c.int(d.maxRecoverySeconds, 'drill.maxRecoverySeconds', { min: 30, max: 14400, def: 1800 }),
  };

  env.rpoSource = normalizeRpoSource(i.rpoSource, c);

  const rawChecks = Array.isArray(i.checks) ? i.checks : [];
  if (rawChecks.length > 50) c.fail('checks', 'máximo de 50 testes por ambiente');
  const seen = new Set();
  env.checks = rawChecks.slice(0, 50).map((raw, idx) => {
    const chk = normalizeCheckInto(c, raw, `checks[${idx}]`);
    while (seen.has(chk.id)) chk.id = uid('c');
    seen.add(chk.id);
    return chk;
  });

  if (c.errors.length) throw new HttpError(400, 'Configuração inválida', c.errors);
  return env;
}

export function normalizeDrillParams(input, env) {
  const c = new Collector();
  const i = input ?? {};
  const p = {
    holdDownSeconds: c.int(i.holdDownSeconds, 'holdDownSeconds', { min: 0, max: 7200, def: env.drill.holdDownSeconds }),
    probeIntervalSeconds: c.int(i.probeIntervalSeconds, 'probeIntervalSeconds', { min: 1, max: 300, def: env.drill.probeIntervalSeconds }),
    stableProbes: c.int(i.stableProbes, 'stableProbes', { min: 1, max: 60, def: env.drill.stableProbes }),
    maxRecoverySeconds: c.int(i.maxRecoverySeconds, 'maxRecoverySeconds', { min: 30, max: 14400, def: env.drill.maxRecoverySeconds }),
  };
  if (c.errors.length) throw new HttpError(400, 'Parâmetros inválidos', c.errors);
  return p;
}
