// Assistente de novo ambiente: descobre recursos (Docker Desktop/k8s local, EKS, EC2, RDS, ElastiCache)
// e monta o ambiente com poucos cliques. A descoberta nunca trava o fluxo: todo passo tem
// estado de carregamento, erro com "Tentar de novo" e alternativa de digitar manualmente.
import { api } from './api.js';
import { btn, clear, h, toast } from './dom.js';
import { apiErrorText, field, numInput, selectInput, textArea, textInput } from './forms.js';
import { loadEnvs, selectEnv } from './state.js';

// ---------- constantes e utilitários ----------
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'me-south-1', 'af-south-1'];
const REGION_RE = /^[a-z]{2,3}(-[a-z]+)+-\d$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:@/=-]+$/; // seguro para embutir em comandos (container, contexto)
const STEP_LABEL = { basic: 'Básico', aws: 'Conta AWS', eks: 'Cluster EKS', k8s: 'Kubernetes local', ec2: 'EC2', rds: 'RDS', cache: 'ElastiCache', checks: 'Testes', rpo: 'RPO e metas', review: 'Revisão' };

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
const parseList = (text) => String(text ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const wkKey = (w) => `${w.namespace}/${w.kind}/${w.name}`;
const KIND_ALIAS = { deploy: 'deployment', deployment: 'deployment', deployments: 'deployment', sts: 'statefulset', statefulset: 'statefulset', statefulsets: 'statefulset' };

/** "ns/kind/nome" (ou "ns/nome" = deployment), um por linha → [{namespace,kind,name}] */
export function parseWorkloadLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('/').map((s) => s.trim());
    if (parts.length === 2) out.push({ namespace: parts[0], kind: 'deployment', name: parts[1] });
    else if (parts.length === 3) out.push({ namespace: parts[0], kind: KIND_ALIAS[parts[1].toLowerCase()] ?? parts[1].toLowerCase(), name: parts[2] });
  }
  return out;
}
export const workloadsToText = (list) => (Array.isArray(list) ? list.map(wkKey).join('\n') : '');

function initialState() {
  return {
    step: 'basic',
    name: '',
    description: '',
    base: 'k8s', // 'k8s' | 'eks' | 'aws'
    addons: { ec2: false, rds: false, cache: false },
    aws: { profile: '', region: 'us-east-1', regionTouched: false, check: null },
    eks: { clusterName: '', nodegroups: new Set(), manual: false, manualNodegroups: '', useKubectl: true, scaleWorkloads: false, workloadNamespaces: '' },
    k8s: { context: '', selected: new Set(), selectedFor: null, manual: false, manualText: '' },
    ec2: { selected: new Set(), tagKey: '', tagValue: '', manual: false, manualIds: '' },
    rds: { instances: new Set(), clusters: new Set(), manual: false, manualInstances: '', manualClusters: '' },
    cache: { rgs: new Set(), serverless: new Set(), manual: false, manualRgs: '', manualServerless: '', ack: false },
    checkOv: {}, // sobrescritas por chave: { enabled, critical, name }
    extra: [], // testes adicionais: { name, check }
    extraDraft: { type: 'http', name: '', url: '', host: '', port: '' },
    rpo: { method: null, redis: '', rdsTarget: '' },
    targets: { rto: 900, rpo: 300 },
    targetsTouched: false,
    drill: { holdDownSeconds: 30, probeIntervalSeconds: 5, stableProbes: 3, maxRecoverySeconds: 1800 },
    d: {}, // cache das descobertas: chave → { path, status, data, error }
    submitting: false,
    submitError: null,
  };
}

/**
 * Monta o wizard dentro de `container`.
 * @param {{onCancel:()=>void, onManual:()=>void}} opts
 */
export function mountWizard(container, { onCancel, onManual }) {
  const W = initialState();
  const bodyEl = h('div', { class: 'wz-body' });
  const stepsEl = h('ol', { class: 'wz-steps' });
  const hintEl = h('span', { class: 'wz-hint', role: 'status' });
  const backBtn = btn('Voltar', { onClick: goBack });
  const nextBtn = btn('Avançar', { kind: 'primary', onClick: goNext });

  // ---------- fluxo ----------
  function stepsFor() {
    const s = ['basic'];
    const addon = W.addons.ec2 || W.addons.rds || W.addons.cache;
    if (W.base === 'eks' || W.base === 'aws' || addon) s.push('aws');
    if (W.base === 'eks') s.push('eks');
    if (W.base === 'k8s') s.push('k8s');
    if (W.addons.ec2) s.push('ec2');
    if (W.addons.rds) s.push('rds');
    if (W.addons.cache) s.push('cache');
    s.push('checks', 'rpo', 'review');
    return s;
  }

  function goNext() {
    if (W.step === 'review') return create();
    if (validate(W.step)) return;
    const s = stepsFor();
    const i = s.indexOf(W.step);
    W.step = s[Math.min(s.length - 1, i + 1)];
    render();
  }
  function goBack() {
    const s = stepsFor();
    const i = s.indexOf(W.step);
    if (i <= 0) return onCancel();
    W.step = s[i - 1];
    W.submitError = null;
    render();
  }

  // ---------- descoberta (com cache por caminho) ----------
  function discover(key, path) {
    const cur = W.d[key];
    if (cur && cur.path === path && cur.status !== 'error') return cur;
    if (cur && cur.path === path && cur.status === 'error') return cur;
    const slot = { path, status: 'loading', data: null, error: null };
    W.d[key] = slot;
    api(path)
      .then((data) => {
        slot.status = 'ok';
        slot.data = data;
      })
      .catch((err) => {
        slot.status = 'error';
        slot.error = err.message;
      })
      .finally(() => {
        if (W.d[key] === slot) renderBody({ focus: false });
      });
    return slot;
  }
  const retry = (key) => {
    delete W.d[key];
    renderBody({ focus: false });
  };
  const awsQs = () => qs({ profile: W.aws.profile.trim(), region: W.aws.region.trim() });

  // ---------- seleções derivadas ----------
  const k8sWorkloads = () => W.d.workloads?.data?.workloads ?? [];
  const k8sSelected = () => (W.k8s.manual ? parseWorkloadLines(W.k8s.manualText) : k8sWorkloads().filter((w) => W.k8s.selected.has(wkKey(w))));
  const ec2Ids = () => [...new Set([...(W.ec2.manual ? [] : W.ec2.selected), ...parseList(W.ec2.manualIds)])];
  const rdsInstanceIds = () => [...new Set([...(W.rds.manual ? [] : W.rds.instances), ...parseList(W.rds.manualInstances)])];
  const rdsClusterIds = () => [...new Set([...(W.rds.manual ? [] : W.rds.clusters), ...parseList(W.rds.manualClusters)])];
  const cacheRgIds = () => [...new Set([...(W.cache.manual ? [] : W.cache.rgs), ...parseList(W.cache.manualRgs)])];
  const cacheSvIds = () => [...new Set([...(W.cache.manual ? [] : W.cache.serverless), ...parseList(W.cache.manualServerless)])];
  const ekscluster = () => (W.d.eks?.data?.clusters ?? []).find((c) => c.name === W.eks.clusterName);

  // ---------- validação por etapa (retorna o motivo, ou null se válida) ----------
  function validate(step) {
    switch (step) {
      case 'basic':
        if (!W.name.trim()) return 'Informe o nome do ambiente.';
        if (W.base === 'aws' && !(W.addons.ec2 || W.addons.rds || W.addons.cache)) return 'Selecione ao menos um recurso AWS (EC2, RDS ou ElastiCache).';
        return null;
      case 'aws':
        return REGION_RE.test(W.aws.region.trim()) ? null : 'Informe uma região válida (ex.: us-east-1).';
      case 'eks':
        if (!W.eks.clusterName.trim()) return 'Escolha (ou digite) o cluster EKS.';
        if (!W.eks.manual && ekscluster() && W.eks.nodegroups.size === 0) return 'Selecione ao menos um node group.';
        if (W.eks.scaleWorkloads && parseList(W.eks.workloadNamespaces).length === 0) return 'Informe os namespaces dos workloads a escalar.';
        return null;
      case 'k8s':
        if (!W.k8s.context.trim()) return 'Escolha (ou digite) o contexto do kubectl.';
        return k8sSelected().length ? null : 'Selecione ao menos um workload.';
      case 'ec2':
        if (!!W.ec2.tagKey.trim() !== !!W.ec2.tagValue.trim()) return 'Para selecionar por tag, informe chave e valor.';
        return ec2Ids().length || W.ec2.tagKey.trim() ? null : 'Selecione ao menos uma instância (ou informe uma tag).';
      case 'rds':
        return rdsInstanceIds().length + rdsClusterIds().length ? null : 'Selecione ao menos uma instância ou cluster.';
      case 'cache':
        if (cacheRgIds().length + cacheSvIds().length === 0) return 'Selecione ao menos um recurso do ElastiCache.';
        return W.cache.ack ? null : 'Confirme que entende que o ElastiCache será excluído e recriado.';
      case 'checks':
        return buildChecks().some((c) => c.critical) ? null : 'Mantenha ao menos um teste crítico: é ele que define quando o serviço está disponível.';
      case 'rpo':
        if (!(Number(W.targets.rto) >= 1)) return 'A meta de RTO deve ser de ao menos 1 segundo.';
        if (!(Number(W.targets.rpo) >= 0)) return 'A meta de RPO deve ser 0 ou mais.';
        return null;
      default:
        return null;
    }
  }

  // ---------- testes sugeridos ----------
  function suggestions() {
    const out = [];
    for (const w of k8sSelected()) out.push({ key: `k8s:${wkKey(w)}`, check: { type: 'k8s', kind: w.kind, namespace: w.namespace, resource: w.name }, defaultName: w.name });
    const rdsData = W.d.rds?.data;
    for (const id of rdsInstanceIds()) {
      const i = rdsData?.instances?.find((x) => x.id === id);
      if (i?.endpoint) out.push({ key: `tcp:rds:${id}`, check: { type: 'tcp', host: i.endpoint, port: i.port || 5432 }, defaultName: `RDS ${id}` });
    }
    for (const id of rdsClusterIds()) {
      const c = rdsData?.clusters?.find((x) => x.id === id);
      if (c?.endpoint) out.push({ key: `tcp:aurora:${id}`, check: { type: 'tcp', host: c.endpoint, port: c.port || 5432 }, defaultName: `Aurora ${id}` });
    }
    W.extra.forEach((e, i) => out.push({ key: `extra:${i}`, check: e.check, defaultName: e.name, extraIndex: i }));
    return out.map((s) => {
      const o = W.checkOv[s.key] ?? {};
      return { ...s, enabled: o.enabled ?? true, critical: o.critical ?? true, name: o.name ?? s.defaultName };
    });
  }
  const buildChecks = () => suggestions().filter((s) => s.enabled).map((s) => ({ ...s.check, name: (s.name || s.defaultName).slice(0, 80), critical: s.critical }));
  const checkTarget = (c) => (c.type === 'k8s' ? `${c.kind} ${c.namespace}/${c.resource}` : c.type === 'tcp' ? `${c.host}:${c.port}` : c.url);

  // ---------- RPO ----------
  function rpoOptions() {
    const opts = [];
    const containers = W.d.docker?.status === 'ok' ? (W.d.docker.data.containers ?? []).filter((c) => c.kind === 'redis' && SAFE_TOKEN_RE.test(c.name)) : [];
    if (containers.length) opts.push({ id: 'redis', title: 'Canário no Redis do Docker Desktop', text: 'Grava um timestamp a cada 2 s numa chave epma:canary do Redis e lê de volta após a recuperação.', containers });
    if (W.base === 'k8s' && SAFE_TOKEN_RE.test(W.k8s.context)) opts.push({ id: 'configmap', title: 'Canário em ConfigMap Kubernetes', text: 'Valida o mecanismo sem banco de dados (o ConfigMap sobrevive ao desligamento das réplicas, então o RPO tende a 0).' });
    const rdsTargets = [...rdsInstanceIds().map((id) => ({ id, kind: 'instance' })), ...rdsClusterIds().map((id) => ({ id, kind: 'cluster' }))];
    if (W.addons.rds && rdsTargets.length) opts.push({ id: 'rds', title: 'RDS — LatestRestorableTime', text: 'Usa o ponto mais recente restaurável (PITR) do banco escolhido como dado durável.', rdsTargets });
    opts.push({ id: 'none', title: 'Não medir RPO', text: 'O exercício mede apenas o RTO. Você pode configurar o RPO depois, na página do exercício.' });
    return opts;
  }
  function defaultRpoMethod(opts) {
    return (opts.find((o) => o.id === 'redis') ?? opts.find((o) => o.id === 'configmap') ?? opts.find((o) => o.id === 'rds') ?? opts.at(-1)).id;
  }
  function buildRpoSource() {
    const opts = rpoOptions();
    const o = opts.find((x) => x.id === W.rpo.method) ?? opts.at(-1);
    if (o.id === 'redis') {
      const c = W.rpo.redis && o.containers.some((x) => x.name === W.rpo.redis) ? W.rpo.redis : o.containers[0].name;
      return { type: 'canary', writeCommand: `sh -c 'docker exec ${c} redis-cli SET epma:canary "$CANARY_VALUE"'`, readCommand: `docker exec ${c} redis-cli GET epma:canary`, intervalSeconds: 2, timeoutSec: 20 };
    }
    if (o.id === 'configmap') {
      const ctx = ` --context ${W.k8s.context}`;
      return {
        type: 'canary',
        writeCommand: `sh -c 'kubectl${ctx} create configmap epma-canary --from-literal=ts="$CANARY_VALUE" --dry-run=client -o yaml | kubectl${ctx} apply -f -'`,
        readCommand: `kubectl${ctx} get configmap epma-canary -o jsonpath={.data.ts}`,
        intervalSeconds: 2,
        timeoutSec: 20,
      };
    }
    if (o.id === 'rds') {
      const t = o.rdsTargets.find((x) => `${x.kind}:${x.id}` === W.rpo.rdsTarget) ?? o.rdsTargets[0];
      return { type: t.kind === 'cluster' ? 'rds-cluster' : 'rds-instance', identifier: t.id, region: W.aws.region.trim(), profile: W.aws.profile.trim() };
    }
    return { type: 'none' };
  }

  // ---------- payload ----------
  function buildPayload() {
    const usesAws = W.base === 'eks' || W.base === 'aws' || W.addons.ec2 || W.addons.rds || W.addons.cache;
    const body = {
      name: W.name.trim(),
      description: W.description.trim(),
      provider: W.base,
      checks: buildChecks(),
      rpoSource: buildRpoSource(),
      targets: { rtoSeconds: Number(W.targets.rto), rpoSeconds: Number(W.targets.rpo) },
      drill: { ...W.drill },
    };
    if (W.base === 'k8s') body.k8s = { context: W.k8s.context.trim(), workloads: k8sSelected().map(({ namespace, kind, name }) => ({ namespace, kind, name })), timeoutSec: 300 };
    if (W.base === 'eks') {
      const c = ekscluster();
      const all = c && W.eks.nodegroups.size === c.nodegroups.length;
      body.eks = {
        clusterName: W.eks.clusterName.trim(),
        region: W.aws.region.trim(),
        profile: W.aws.profile.trim(),
        nodegroups: W.eks.manual || !c ? parseList(W.eks.manualNodegroups) : all ? [] : [...W.eks.nodegroups],
        useKubectl: W.eks.useKubectl,
        scaleWorkloads: W.eks.scaleWorkloads,
        workloadNamespaces: parseList(W.eks.workloadNamespaces),
        fallbackDesired: 2,
        readyTimeoutSec: 1200,
      };
    }
    body.resources = {
      region: usesAws ? W.aws.region.trim() : '',
      profile: usesAws ? W.aws.profile.trim() : '',
      timeoutSec: 3600,
      ec2: { instanceIds: W.addons.ec2 ? ec2Ids() : [], tagKey: W.addons.ec2 ? W.ec2.tagKey.trim() : '', tagValue: W.addons.ec2 ? W.ec2.tagValue.trim() : '' },
      rds: { instances: W.addons.rds ? rdsInstanceIds() : [], clusters: W.addons.rds ? rdsClusterIds() : [] },
      elasticache: { replicationGroups: W.addons.cache ? cacheRgIds() : [], serverlessCaches: W.addons.cache ? cacheSvIds() : [], acknowledgeDelete: W.addons.cache ? W.cache.ack : false },
    };
    return body;
  }

  async function create() {
    if (W.submitting) return;
    W.submitting = true;
    W.submitError = null;
    updateNav();
    try {
      const env = await api('/environments', { method: 'POST', body: buildPayload() });
      await loadEnvs();
      selectEnv(env.id);
      toast('Ambiente criado.', 'ok');
      location.hash = '#/painel';
    } catch (err) {
      W.submitError = apiErrorText(err); // mantém todo o progresso para corrigir e tentar de novo
      W.submitting = false;
      renderBody({ focus: false });
      updateNav();
    }
  }

  // ---------- blocos de UI ----------
  const section = (title, text, ...children) => h('div', { class: 'wz-section' }, h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : null, ...children);
  const loadingBox = (text) => h('div', { class: 'wz-loading' }, h('span', { class: 'spinner' }), ` ${text}`);
  const errorBox = (key, slot, onManual2, manualLabel = 'Digitar manualmente') =>
    h('div', { class: 'note bad' }, h('strong', {}, 'Falha na descoberta: '), slot.error, h('div', { class: 'row wz-mt' }, btn('Tentar de novo', { icon: 'refresh', onClick: () => retry(key) }), btn(manualLabel, { onClick: onManual2 })));
  const emptyBox = (text, onManual2) => h('div', { class: 'note warn' }, text, onManual2 ? h('div', { class: 'row wz-mt' }, btn('Digitar manualmente', { onClick: onManual2 })) : null);

  function optCard({ type, name, checked, title, text, onChange, disabled }) {
    const input = h('input', { type, name, checked, disabled });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: `wz-opt${disabled ? ' wz-off' : ''}` }, input, h('span', { class: 'wz-opt-t' }, h('strong', {}, title), h('span', { class: 'muted' }, text)));
  }

  /** Tabela com checkboxes. rows: [{key, label, cells:[], reason}] */
  function pickTable({ headers, rows, selected, onChange }) {
    const enabled = rows.filter((r) => !r.reason);
    const boxes = [];
    const all = h('input', { type: 'checkbox', 'aria-label': 'Selecionar todos', checked: enabled.length > 0 && enabled.every((r) => selected.has(r.key)), disabled: enabled.length === 0 });
    all.addEventListener('change', () => {
      for (const r of enabled) all.checked ? selected.add(r.key) : selected.delete(r.key);
      for (const b of boxes) if (!b.disabled) b.checked = all.checked;
      onChange();
    });
    const trs = rows.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: selected.has(r.key) && !r.reason, disabled: Boolean(r.reason), 'aria-label': `Selecionar ${r.label}` });
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(r.key) : selected.delete(r.key);
        all.checked = enabled.every((x) => selected.has(x.key));
        onChange();
      });
      boxes.push(cb);
      return h('tr', { class: r.reason ? 'wz-off' : '' }, h('td', { class: 'wz-chk' }, cb), ...r.cells.map((c, i) => h('td', {}, c, i === 0 && r.reason ? h('div', { class: 'muted' }, `Ignorada: ${r.reason}`) : null)));
    });
    return h('div', { class: 'table-wrap wz-table' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { class: 'wz-chk' }, all), ...headers.map((t) => h('th', {}, t)))), h('tbody', {}, ...trs)));
  }

  const bind = (input, apply) => {
    input.addEventListener('input', () => {
      apply(input.value);
      updateNav();
    });
    return input;
  };
  const tools = () => {
    const slot = discover('tools', '/discover/tools');
    return slot.status === 'ok' ? slot.data : null;
  };

  // =====================================================================================
  // etapas
  // =====================================================================================
  function stepBasic() {
    const name = bind(textInput(W.name, { placeholder: 'Ex.: Produção — us-east-1', maxlength: 80, 'data-autofocus': '1' }), (v) => (W.name = v));
    const desc = bind(textArea(W.description, { rows: 2 }), (v) => (W.description = v));
    const bases = [
      ['k8s', 'Kubernetes local — Docker Desktop / kind', 'Liga/desliga zerando e restaurando as réplicas dos workloads escolhidos (via kubectl).'],
      ['eks', 'Amazon EKS', 'Zera os managed node groups do cluster (guardando a escala original) e restaura ao ligar.'],
      ['aws', 'Somente recursos AWS', 'Sem Kubernetes: atua apenas em EC2, RDS/Aurora e ElastiCache.'],
    ];
    const addon = (key, title, text) => optCard({ type: 'checkbox', name: `addon-${key}`, checked: W.addons[key], title, text, onChange: (v) => ((W.addons[key] = v), renderSteps(), updateNav()) });
    return [
      section('Vamos começar', 'Dê um nome ao ambiente e escolha o que será ligado e desligado.', h('div', { class: 'form-grid' }, h('div', { class: 'span' }, field('Nome do ambiente', name)), h('div', { class: 'span' }, field('Descrição (opcional)', desc)))),
      section(
        'Base de computação',
        null,
        h('div', { class: 'wz-opts', role: 'radiogroup', 'aria-label': 'Base de computação' }, ...bases.map(([id, t, x]) => optCard({ type: 'radio', name: 'base', checked: W.base === id, title: t, text: x, onChange: (v) => v && ((W.base = id), renderSteps(), updateNav()) }))),
      ),
      section(
        'Recursos AWS adicionais',
        W.base === 'aws' ? 'Selecione ao menos um.' : 'Opcional: desligados e religados junto com o ambiente.',
        h('div', { class: 'wz-opts' }, addon('ec2', 'EC2', 'Para e inicia instâncias.'), addon('rds', 'RDS / Aurora', 'Para e inicia bancos (a AWS religa sozinha após 7 dias).'), addon('cache', 'ElastiCache', 'Sem stop/start: exclui com snapshot e recria.')),
      ),
    ];
  }

  function stepAws() {
    const profSlot = discover('profiles', '/discover/aws/profiles');
    const profiles = profSlot.status === 'ok' ? profSlot.data.profiles ?? [] : [];
    const t = tools();
    const profile = textInput(W.aws.profile, { placeholder: '(padrão do ambiente)', list: 'wz-profiles', 'data-autofocus': '1' });
    profile.addEventListener('input', () => ((W.aws.profile = profile.value), (W.aws.check = null), updateNav()));
    profile.addEventListener('change', () => {
      const p = profiles.find((x) => x.name === profile.value);
      if (p?.region && !W.aws.regionTouched) {
        W.aws.region = p.region;
        region.value = p.region;
        updateNav();
      }
    });
    const region = textInput(W.aws.region, { placeholder: 'us-east-1', list: 'wz-regions' });
    region.addEventListener('input', () => ((W.aws.region = region.value), (W.aws.regionTouched = true), (W.aws.check = null), updateNav()));
    const regionList = [...new Set([...profiles.map((p) => p.region).filter(Boolean), ...REGIONS])];
    const result = h('div', { class: 'wz-mt' });
    const c = W.aws.check;
    if (c?.status === 'loading') result.append(loadingBox('Validando credenciais…'));
    else if (c?.status === 'ok') result.append(h('div', { class: 'note' }, h('strong', {}, '✔ Credenciais válidas. '), `Conta ${c.account} · ${c.arn}`));
    else if (c?.status === 'error') result.append(h('div', { class: 'note bad' }, h('strong', {}, 'Não foi possível validar: '), c.error, h('div', { class: 'wz-mt' }, W.aws.profile.trim() ? ['Se usa SSO, execute: ', h('code', {}, `aws sso login --profile ${W.aws.profile.trim()}`)] : ['Configure credenciais (', h('code', {}, 'aws configure'), ' ou variáveis AWS_*) ou informe um perfil.'])));
    return [
      section(
        'Conta AWS',
        'Perfil e região usados para descobrir e operar os recursos. As credenciais continuam no seu aws CLI — o console não as armazena.',
        t && !t.aws?.ok ? h('div', { class: 'note bad' }, 'aws CLI não encontrado no PATH: a descoberta automática não vai funcionar (você ainda pode digitar os identificadores manualmente).') : null,
        h('div', { class: 'form-grid' }, field('Perfil AWS', profile, profiles.length ? `${profiles.length} perfil(is) encontrado(s) em ~/.aws — escolha ou digite.` : 'Opcional. Vazio usa o perfil padrão / variáveis de ambiente.'), field('Região', region, 'Escolha na lista ou digite.')),
        h('datalist', { id: 'wz-profiles' }, ...profiles.map((p) => h('option', { value: p.name }, p.region ?? ''))),
        h('datalist', { id: 'wz-regions' }, ...regionList.map((r) => h('option', { value: r }))),
        h('div', { class: 'row wz-mt' }, btn('Validar credenciais', { icon: 'check', disabled: c?.status === 'loading', onClick: validateCreds })),
        result,
      ),
    ];
  }
  async function validateCreds() {
    if (!REGION_RE.test(W.aws.region.trim())) return toast('Informe uma região válida antes de validar.', 'warn');
    W.aws.check = { status: 'loading' };
    renderBody({ focus: false });
    try {
      const r = await api(`/discover/aws/identity${awsQs()}`);
      W.aws.check = { status: 'ok', account: r.account, arn: r.arn };
    } catch (err) {
      W.aws.check = { status: 'error', error: err.message };
    }
    renderBody({ focus: false });
  }

  function stepEks() {
    const title = 'Cluster EKS';
    const sub = 'Escolha o cluster e quais managed node groups serão desligados. O plano de controle do EKS não pode ser desligado: o que se zera é a capacidade de computação.';
    const slot = discover('eks', `/discover/eks${awsQs()}`);
    const manualForm = () => [
      h('div', { class: 'form-grid' }, field('Nome do cluster', bind(textInput(W.eks.clusterName, { 'data-autofocus': '1' }), (v) => (W.eks.clusterName = v))), field('Node groups (vazio = todos)', bind(textInput(W.eks.manualNodegroups, { placeholder: 'ng-apps, ng-system' }), (v) => (W.eks.manualNodegroups = v)), 'Separe por vírgula.')),
      h('div', { class: 'row wz-mt' }, btn('Usar descoberta automática', { icon: 'refresh', onClick: () => ((W.eks.manual = false), retry('eks')) })),
    ];
    const advanced = h(
      'details',
      { class: 'wz-adv' },
      h('summary', {}, 'Opções avançadas'),
      h('div', { class: 'form-grid wz-mt' },
        h('div', { class: 'span' }, optCard({ type: 'checkbox', name: 'kubectl', checked: W.eks.useKubectl, title: 'Usar kubectl', text: 'Confirma nós Ready/removidos e habilita testes k8s.', onChange: (v) => (W.eks.useKubectl = v) })),
        h('div', { class: 'span' }, optCard({ type: 'checkbox', name: 'scale', checked: W.eks.scaleWorkloads, title: 'Escalar workloads para 0 antes de desligar', text: 'Desliga Deployments/StatefulSets de forma graciosa e os restaura ao ligar.', onChange: (v) => ((W.eks.scaleWorkloads = v), updateNav()) })),
        h('div', { class: 'span' }, field('Namespaces dos workloads', bind(textInput(W.eks.workloadNamespaces, { placeholder: 'default, apps' }), (v) => (W.eks.workloadNamespaces = v)), 'Obrigatório se a opção acima estiver marcada.')),
      ),
    );
    if (W.eks.manual) return [section(title, sub, ...manualForm()), advanced];
    if (slot.status === 'loading') return [section(title, sub, loadingBox('Procurando clusters EKS…'))];
    if (slot.status === 'error') return [section(title, sub, errorBox('eks', slot, () => ((W.eks.manual = true), renderBody())))];
    const clusters = slot.data.clusters ?? [];
    if (!clusters.length) return [section(title, sub, emptyBox(`Nenhum cluster EKS encontrado em ${W.aws.region}.`, () => ((W.eks.manual = true), renderBody()))), advanced];
    if (!W.eks.clusterName && clusters.length === 1) selectCluster(clusters[0]);
    const cur = ekscluster();
    return [
      section(
        title,
        sub,
        h('div', { class: 'wz-opts', role: 'radiogroup', 'aria-label': 'Cluster EKS' }, ...clusters.map((c) => optCard({ type: 'radio', name: 'eks-cluster', checked: W.eks.clusterName === c.name, title: c.name, text: `Kubernetes ${c.version ?? '?'} · ${c.status ?? ''} · ${c.nodegroups?.length ?? 0} node group(s)`, onChange: (v) => v && (selectCluster(c), renderBody({ focus: false })) }))),
        cur
          ? [
              h('h3', { class: 'wz-sub' }, 'Node groups a desligar'),
              cur.nodegroups?.length
                ? pickTable({ headers: ['Node group', 'Status', 'Mín', 'Desejado', 'Máx', 'Instâncias'], rows: cur.nodegroups.map((n) => ({ key: n.name, label: n.name, cells: [n.name, n.status, n.min, h('strong', {}, n.desired), n.max, (n.instanceTypes ?? []).join(', ')] })), selected: W.eks.nodegroups, onChange: updateNav })
                : h('div', { class: 'note warn' }, 'Este cluster não tem managed node groups (Fargate/Karpenter/self-managed?). Use o provider de comandos customizados.'),
            ]
          : null,
        h('div', { class: 'row wz-mt' }, btn('Digitar manualmente', { onClick: () => ((W.eks.manual = true), renderBody()) })),
      ),
      advanced,
    ];
  }
  function selectCluster(c) {
    W.eks.clusterName = c.name;
    W.eks.nodegroups = new Set((c.nodegroups ?? []).map((n) => n.name));
  }

  function stepK8s() {
    const title = 'Kubernetes local (Docker Desktop / kind)';
    const sub = '"Desligar" zera as réplicas dos workloads escolhidos (guardando os valores originais) e "Ligar" os restaura. O cluster e o nó continuam rodando.';
    const t = tools();
    const warn = t && !t.kubectl?.ok ? h('div', { class: 'note bad' }, 'kubectl não encontrado no PATH: o ambiente precisa dele para operar o cluster.') : null;
    const ctxSlot = discover('ctx', '/discover/k8s/contexts');
    const manualForm = () => [
      h('div', { class: 'form-grid' },
        field('Contexto kubectl', bind(textInput(W.k8s.context, { placeholder: 'docker-desktop', 'data-autofocus': '1' }), (v) => (W.k8s.context = v))),
        h('div', { class: 'span' }, field('Workloads (um por linha)', bind(textArea(W.k8s.manualText, { rows: 5, placeholder: 'kube-system/deployment/coredns', spellcheck: 'false' }), (v) => (W.k8s.manualText = v)), 'Formato: namespace/tipo/nome (tipo = deployment ou statefulset).')),
      ),
      h('div', { class: 'row wz-mt' }, btn('Usar descoberta automática', { icon: 'refresh', onClick: () => ((W.k8s.manual = false), delete W.d.ctx, delete W.d.workloads, renderBody({ focus: false })) })),
    ];
    if (W.k8s.manual) return [section(title, sub, warn, ...manualForm())];
    if (ctxSlot.status === 'loading') return [section(title, sub, warn, loadingBox('Procurando contextos do kubectl…'))];
    if (ctxSlot.status === 'error') return [section(title, sub, warn, errorBox('ctx', ctxSlot, () => ((W.k8s.manual = true), renderBody())))];
    const contexts = ctxSlot.data.contexts ?? [];
    if (!contexts.length) return [section(title, sub, warn, emptyBox('Nenhum contexto encontrado no kubeconfig. Ative o Kubernetes no Docker Desktop ou crie um cluster kind.', () => ((W.k8s.manual = true), renderBody())))];
    if (!W.k8s.context) W.k8s.context = (contexts.find((c) => c.dockerDesktop || c.name === 'docker-desktop') ?? contexts.find((c) => c.name === ctxSlot.data.current) ?? contexts[0]).name;
    const sel = selectInput(contexts.map((c) => [c.name, c.dockerDesktop ? `${c.name} (Docker Desktop)` : c.name]), W.k8s.context);
    sel.setAttribute('data-autofocus', '1');
    sel.addEventListener('change', () => {
      W.k8s.context = sel.value;
      W.k8s.selectedFor = null;
      W.k8s.selected = new Set();
      renderBody({ focus: false });
    });
    const wsSlot = discover('workloads', `/discover/k8s/workloads${qs({ context: W.k8s.context })}`);
    let list;
    if (wsSlot.status === 'loading') list = loadingBox('Listando workloads…');
    else if (wsSlot.status === 'error') list = errorBox('workloads', wsSlot, () => ((W.k8s.manual = true), renderBody()));
    else {
      const ws = wsSlot.data.workloads ?? [];
      if (W.k8s.selectedFor !== W.k8s.context) {
        W.k8s.selectedFor = W.k8s.context;
        const nonSystem = ws.filter((w) => w.namespace !== 'kube-system');
        W.k8s.selected = new Set((nonSystem.length ? nonSystem : ws).map(wkKey));
      }
      list = ws.length
        ? pickTable({ headers: ['Workload', 'Tipo', 'Réplicas', 'Prontas'], rows: ws.map((w) => ({ key: wkKey(w), label: wkKey(w), cells: [h('span', { class: 'mono' }, `${w.namespace}/${w.name}`), w.kind, w.replicas, w.ready ?? 0] })), selected: W.k8s.selected, onChange: updateNav })
        : emptyBox('Nenhum Deployment/StatefulSet encontrado neste contexto.', () => ((W.k8s.manual = true), renderBody()));
    }
    return [section(title, sub, warn, h('div', { class: 'form-grid' }, field('Contexto do kubectl', sel, 'O Docker Desktop usa o contexto "docker-desktop".')), h('h3', { class: 'wz-sub' }, 'Workloads a desligar'), list, h('div', { class: 'row wz-mt' }, btn('Digitar manualmente', { onClick: () => ((W.k8s.manual = true), renderBody()) })))];
  }

  function stepEc2() {
    const title = 'Instâncias EC2';
    const sub = 'Instâncias paradas com stop-instances e iniciadas com start-instances. Spot e membros de Auto Scaling são ignorados.';
    const slot = discover('ec2', `/discover/ec2${awsQs()}`);
    const tag = h('fieldset', { class: 'wz-fs' }, h('legend', {}, 'Ou selecionar por tag'), h('div', { class: 'form-grid' }, field('Chave', bind(textInput(W.ec2.tagKey, { placeholder: 'Environment' }), (v) => (W.ec2.tagKey = v))), field('Valor', bind(textInput(W.ec2.tagValue, { placeholder: 'staging' }), (v) => (W.ec2.tagValue = v)))));
    const manualBox = () => field('IDs das instâncias', bind(textArea(W.ec2.manualIds, { rows: 3, placeholder: 'i-0123456789abcdef0', spellcheck: 'false', 'data-autofocus': '1' }), (v) => (W.ec2.manualIds = v)), 'Separe por vírgula, espaço ou quebra de linha.');
    if (W.ec2.manual) return [section(title, sub, manualBox(), h('div', { class: 'row wz-mt' }, btn('Usar descoberta automática', { icon: 'refresh', onClick: () => ((W.ec2.manual = false), retry('ec2')) })), tag)];
    if (slot.status === 'loading') return [section(title, sub, loadingBox('Procurando instâncias EC2…'))];
    if (slot.status === 'error') return [section(title, sub, errorBox('ec2', slot, () => ((W.ec2.manual = true), renderBody())), tag)];
    const list = slot.data.instances ?? [];
    return [
      section(
        title,
        sub,
        list.length
          ? pickTable({ headers: ['Instância', 'Estado', 'Tipo', 'IP'], rows: list.map((i) => ({ key: i.id, label: i.name || i.id, reason: i.skip, cells: [h('span', {}, i.name || i.id, i.name ? h('div', { class: 'muted mono' }, i.id) : null), i.state, i.type, i.publicIp || i.privateIp || '—'] })), selected: W.ec2.selected, onChange: updateNav })
          : emptyBox(`Nenhuma instância EC2 encontrada em ${W.aws.region}.`, () => ((W.ec2.manual = true), renderBody())),
        h('div', { class: 'row wz-mt' }, btn('Digitar IDs manualmente', { onClick: () => ((W.ec2.manual = true), renderBody()) })),
        tag,
      ),
    ];
  }

  function stepRds() {
    const title = 'RDS / Aurora';
    const sub = 'Bancos parados com stop-db-instance / stop-db-cluster e iniciados novamente ao ligar. Réplicas de leitura e membros de cluster Aurora são ignorados.';
    const note = h('div', { class: 'note warn' }, 'A AWS religa sozinha um RDS parado após 7 dias — mantenha os exercícios mais curtos que isso.');
    const slot = discover('rds', `/discover/rds${awsQs()}`);
    if (W.rds.manual) {
      return [section(title, sub, note, h('div', { class: 'form-grid' }, field('Instâncias RDS', bind(textArea(W.rds.manualInstances, { rows: 2, placeholder: 'meu-banco-1', spellcheck: 'false', 'data-autofocus': '1' }), (v) => (W.rds.manualInstances = v))), field('Clusters Aurora', bind(textArea(W.rds.manualClusters, { rows: 2, placeholder: 'meu-aurora', spellcheck: 'false' }), (v) => (W.rds.manualClusters = v)))), h('div', { class: 'row wz-mt' }, btn('Usar descoberta automática', { icon: 'refresh', onClick: () => ((W.rds.manual = false), retry('rds')) })))];
    }
    if (slot.status === 'loading') return [section(title, sub, note, loadingBox('Procurando bancos RDS…'))];
    if (slot.status === 'error') return [section(title, sub, note, errorBox('rds', slot, () => ((W.rds.manual = true), renderBody())))];
    const inst = slot.data.instances ?? [];
    const clu = slot.data.clusters ?? [];
    if (!inst.length && !clu.length) return [section(title, sub, note, emptyBox(`Nenhum banco RDS encontrado em ${W.aws.region}.`, () => ((W.rds.manual = true), renderBody())))];
    return [
      section(
        title,
        sub,
        note,
        inst.length
          ? [h('h3', { class: 'wz-sub' }, 'Instâncias'), pickTable({ headers: ['Instância', 'Engine', 'Status', 'Classe', 'Endpoint'], rows: inst.map((i) => ({ key: i.id, label: i.id, reason: i.skip, cells: [i.id, i.engine, i.status, `${i.class ?? ''}${i.multiAz ? ' · Multi-AZ' : ''}`, h('span', { class: 'mono muted' }, i.endpoint ?? '—')] })), selected: W.rds.instances, onChange: updateNav })]
          : null,
        clu.length ? [h('h3', { class: 'wz-sub' }, 'Clusters Aurora'), pickTable({ headers: ['Cluster', 'Engine', 'Status', 'Endpoint'], rows: clu.map((c) => ({ key: c.id, label: c.id, reason: c.skip, cells: [c.id, c.engine, c.status, h('span', { class: 'mono muted' }, c.endpoint ?? '—')] })), selected: W.rds.clusters, onChange: updateNav })] : null,
        h('div', { class: 'row wz-mt' }, btn('Digitar manualmente', { onClick: () => ((W.rds.manual = true), renderBody()) })),
      ),
    ];
  }

  function stepCache() {
    const title = 'ElastiCache';
    const sub = 'Replication groups (Redis/Valkey) e caches Serverless.';
    const warn = h('div', { class: 'note warn' }, h('strong', {}, 'O ElastiCache não tem stop/start. '), 'Ao desligar, o recurso é EXCLUÍDO (com snapshot final) e, ao ligar, recriado a partir desse snapshot. O endpoint pode mudar, dados gravados depois do snapshot se perdem e os snapshots ficam retidos (geram custo).');
    const ack = h('input', { type: 'checkbox', checked: W.cache.ack });
    ack.addEventListener('change', () => ((W.cache.ack = ack.checked), updateNav()));
    const ackEl = h('label', { class: 'wz-ack' }, ack, h('span', {}, 'Entendo que o ElastiCache será EXCLUÍDO (com snapshot final) ao desligar e recriado a partir do snapshot ao ligar.'));
    const slot = discover('cache', `/discover/elasticache${awsQs()}`);
    if (W.cache.manual) {
      return [section(title, sub, warn, h('div', { class: 'form-grid' }, field('Replication groups', bind(textArea(W.cache.manualRgs, { rows: 2, placeholder: 'meu-redis', spellcheck: 'false', 'data-autofocus': '1' }), (v) => (W.cache.manualRgs = v))), field('Serverless caches', bind(textArea(W.cache.manualServerless, { rows: 2, placeholder: 'meu-cache', spellcheck: 'false' }), (v) => (W.cache.manualServerless = v)))), ackEl, h('div', { class: 'row wz-mt' }, btn('Usar descoberta automática', { icon: 'refresh', onClick: () => ((W.cache.manual = false), retry('cache')) })))];
    }
    if (slot.status === 'loading') return [section(title, sub, warn, loadingBox('Procurando recursos do ElastiCache…'))];
    if (slot.status === 'error') return [section(title, sub, warn, errorBox('cache', slot, () => ((W.cache.manual = true), renderBody())))];
    const rgs = slot.data.replicationGroups ?? [];
    const sv = slot.data.serverless ?? [];
    if (!rgs.length && !sv.length) return [section(title, sub, warn, emptyBox(`Nenhum recurso ElastiCache encontrado em ${W.aws.region}.`, () => ((W.cache.manual = true), renderBody())))];
    return [
      section(
        title,
        sub,
        warn,
        rgs.length ? [h('h3', { class: 'wz-sub' }, 'Replication groups'), pickTable({ headers: ['Grupo', 'Engine', 'Status', 'Nó'], rows: rgs.map((r) => ({ key: r.id, label: r.id, reason: r.skip, cells: [r.id, r.engine, r.status, r.nodeType ?? ''] })), selected: W.cache.rgs, onChange: updateNav })] : null,
        sv.length ? [h('h3', { class: 'wz-sub' }, 'Caches Serverless'), pickTable({ headers: ['Cache', 'Engine', 'Status'], rows: sv.map((r) => ({ key: r.id, label: r.id, reason: r.skip, cells: [r.id, r.engine, r.status] })), selected: W.cache.serverless, onChange: updateNav })] : null,
        ackEl,
        h('div', { class: 'row wz-mt' }, btn('Digitar manualmente', { onClick: () => ((W.cache.manual = true), renderBody()) })),
      ),
    ];
  }

  function stepChecks() {
    const items = suggestions();
    const setOv = (key, patch) => {
      W.checkOv[key] = { ...(W.checkOv[key] ?? {}), ...patch };
      updateNav();
    };
    const rows = items.map((s) => {
      const use = h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': `Usar o teste ${s.name}` });
      use.addEventListener('change', () => setOv(s.key, { enabled: use.checked }));
      const nm = textInput(s.name, { 'aria-label': 'Nome do teste', maxlength: 80 });
      nm.addEventListener('input', () => setOv(s.key, { name: nm.value }));
      const crit = h('input', { type: 'checkbox', checked: s.critical, 'aria-label': `Crítico: ${s.name}` });
      crit.addEventListener('change', () => setOv(s.key, { critical: crit.checked }));
      return h('tr', {}, h('td', { class: 'wz-chk' }, use), h('td', {}, nm), h('td', {}, h('span', { class: 'tag' }, s.check.type), ' ', h('span', { class: 'mono muted' }, checkTarget(s.check))), h('td', { class: 'wz-chk' }, crit), h('td', { class: 'wz-chk' }, s.extraIndex != null ? btn('', { icon: 'trash', kind: 'ghost icon-btn', title: 'Remover teste', onClick: () => (W.extra.splice(s.extraIndex, 1), delete W.checkOv[s.key], renderBody({ focus: false })) }) : null));
    });
    const dr = W.extraDraft;
    const typeSel = selectInput([['http', 'HTTP(S)'], ['tcp', 'Porta TCP']], dr.type);
    typeSel.addEventListener('change', () => ((dr.type = typeSel.value), renderBody({ focus: false })));
    const draftFields =
      dr.type === 'http'
        ? [field('URL de saúde', bind(textInput(dr.url, { placeholder: 'https://app.exemplo.com/health' }), (v) => (dr.url = v)))]
        : [field('Host', bind(textInput(dr.host, { placeholder: 'db.exemplo.com' }), (v) => (dr.host = v))), field('Porta', bind(numInput(dr.port, { min: 1, max: 65535 }), (v) => (dr.port = v)))];
    const addExtra = () => {
      const name = dr.name.trim() || (dr.type === 'http' ? dr.url : `${dr.host}:${dr.port}`);
      if (dr.type === 'http') {
        if (!/^https?:\/\/\S+$/i.test(dr.url.trim())) return toast('Informe uma URL http:// ou https:// válida.', 'warn');
        W.extra.push({ name, check: { type: 'http', url: dr.url.trim(), expectStatus: '200-399' } });
      } else {
        const port = Number(dr.port);
        if (!dr.host.trim() || !(port >= 1 && port <= 65535)) return toast('Informe host e porta válidos.', 'warn');
        W.extra.push({ name, check: { type: 'tcp', host: dr.host.trim(), port } });
      }
      W.extraDraft = { type: dr.type, name: '', url: '', host: '', port: '' };
      renderBody({ focus: false });
    };
    return [
      section(
        'Testes de aplicação',
        'Os testes críticos definem quando o serviço está disponível — são a base do cálculo do RTO. Sugeri testes a partir do que você escolheu; ajuste como quiser.',
        rows.length
          ? h('div', { class: 'table-wrap wz-table' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { class: 'wz-chk' }, 'Usar'), h('th', {}, 'Nome'), h('th', {}, 'Tipo / destino'), h('th', { class: 'wz-chk' }, 'Crítico'), h('th', { class: 'wz-chk' }))), h('tbody', {}, ...rows)))
          : h('div', { class: 'note warn' }, 'Não há sugestões automáticas para as suas escolhas. Adicione ao menos um teste HTTP ou TCP abaixo.'),
      ),
      h('fieldset', { class: 'wz-fs' }, h('legend', {}, 'Adicionar teste'), h('div', { class: 'form-grid' }, field('Tipo', typeSel), field('Nome (opcional)', bind(textInput(dr.name, { placeholder: 'API de pagamentos' }), (v) => (dr.name = v))), ...draftFields), h('div', { class: 'row wz-mt' }, btn('Adicionar teste', { icon: 'plus', onClick: addExtra }))),
    ];
  }

  function stepRpo() {
    const dockerSlot = discover('docker', '/discover/docker/containers');
    const opts = rpoOptions();
    // enquanto o usuário não escolher, o padrão acompanha as opções disponíveis (a descoberta do Docker é assíncrona)
    if (!W.rpo.userChosen || !opts.some((o) => o.id === W.rpo.method)) W.rpo.method = defaultRpoMethod(opts);
    if (!W.targetsTouched) W.targets = W.base === 'k8s' ? { rto: 120, rpo: 60 } : { rto: 900, rpo: 300 };
    const radios = opts.map((o) => {
      let extra = null;
      if (o.id === 'redis' && o.containers.length > 1) {
        const sel = selectInput(o.containers.map((c) => [c.name, `${c.name} (${c.image})`]), W.rpo.redis || o.containers[0].name);
        sel.addEventListener('change', () => (W.rpo.redis = sel.value));
        extra = field('Container Redis', sel);
      } else if (o.id === 'redis') W.rpo.redis = o.containers[0].name;
      if (o.id === 'rds' && o.rdsTargets.length > 1) {
        const sel = selectInput(o.rdsTargets.map((t) => [`${t.kind}:${t.id}`, `${t.id} (${t.kind === 'cluster' ? 'cluster Aurora' : 'instância'})`]), W.rpo.rdsTarget || `${o.rdsTargets[0].kind}:${o.rdsTargets[0].id}`);
        sel.addEventListener('change', () => (W.rpo.rdsTarget = sel.value));
        extra = field('Banco para medir', sel);
      }
      return h('div', {}, optCard({ type: 'radio', name: 'rpo', checked: W.rpo.method === o.id, title: o.title, text: o.text, onChange: (v) => v && ((W.rpo.method = o.id), (W.rpo.userChosen = true)) }), extra ? h('div', { class: 'wz-opt-extra' }, extra) : null);
    });
    const tgt = (k, label, hint, min) => field(label, bind(numInput(W.targets[k], { min }), (v) => ((W.targets[k] = v), (W.targetsTouched = true))), hint);
    const dv = (k, label, min, max) => field(label, bind(numInput(W.drill[k], { min, max }), (v) => (W.drill[k] = Number(v))));
    return [
      section(
        'Como medir o RPO',
        'O RPO é a janela de dados que se aceita perder. O canário grava um valor com timestamp até a falha e o lê de volta após a recuperação.',
        dockerSlot.status === 'loading' ? loadingBox('Procurando containers Docker (Redis)…') : null,
        dockerSlot.status === 'error' ? h('div', { class: 'note' }, 'Não foi possível consultar o Docker — a opção de canário em Redis não será oferecida.') : null,
        h('div', { class: 'wz-opts wz-opts-col', role: 'radiogroup', 'aria-label': 'Método de RPO' }, ...radios),
      ),
      section('Metas', 'Tempos máximos aceitáveis. O relatório compara o que foi medido com estas metas.', h('div', { class: 'form-grid' }, tgt('rto', 'Meta de RTO (segundos)', 'Tempo máximo para restaurar o serviço.', 1), tgt('rpo', 'Meta de RPO (segundos)', 'Janela máxima de perda de dados.', 0))),
      h('details', { class: 'wz-adv' }, h('summary', {}, 'Padrões do exercício'), h('div', { class: 'form-grid wz-mt' }, dv('holdDownSeconds', 'Acionamento simulado (s)', 0, 7200), dv('probeIntervalSeconds', 'Intervalo das amostras (s)', 1, 300), dv('stableProbes', 'Amostras estáveis para restaurar', 1, 60), dv('maxRecoverySeconds', 'Limite de recuperação (s)', 30, 14400))),
    ];
  }

  function stepReview() {
    const p = buildPayload();
    const baseLabel = { k8s: 'Kubernetes local (kubectl)', eks: 'Amazon EKS', aws: 'Somente recursos AWS' }[p.provider];
    const rows = [['Nome', p.name], p.description ? ['Descrição', p.description] : null, ['Base', baseLabel]];
    if (p.provider === 'k8s') rows.push(['Contexto', p.k8s.context], ['Workloads', `${p.k8s.workloads.length}: ${p.k8s.workloads.map(wkKey).join(', ')}`]);
    if (p.provider === 'eks') rows.push(['Cluster', `${p.eks.clusterName} · ${p.eks.region}`], ['Node groups', p.eks.nodegroups.length ? p.eks.nodegroups.join(', ') : 'todos']);
    if (p.resources.region) rows.push(['Conta AWS', `região ${p.resources.region}${p.resources.profile ? ` · perfil ${p.resources.profile}` : ''}`]);
    const r = p.resources;
    if (r.ec2.instanceIds.length || r.ec2.tagKey) rows.push(['EC2', [...r.ec2.instanceIds, r.ec2.tagKey ? `tag ${r.ec2.tagKey}=${r.ec2.tagValue}` : null].filter(Boolean).join(', ')]);
    if (r.rds.instances.length) rows.push(['RDS', r.rds.instances.join(', ')]);
    if (r.rds.clusters.length) rows.push(['Aurora', r.rds.clusters.join(', ')]);
    if (r.elasticache.replicationGroups.length || r.elasticache.serverlessCaches.length) rows.push(['ElastiCache', `${[...r.elasticache.replicationGroups, ...r.elasticache.serverlessCaches].join(', ')} (será excluído e recriado)`]);
    rows.push(['Testes', `${p.checks.length} (${p.checks.filter((c) => c.critical).length} crítico(s)): ${p.checks.map((c) => c.name).join(', ')}`]);
    const rs = p.rpoSource;
    rows.push(['Medição de RPO', rs.type === 'none' ? 'não medir' : rs.type === 'canary' ? 'canário de gravação' : `${rs.type} (${rs.identifier})`]);
    rows.push(['Metas', `RTO ${p.targets.rtoSeconds}s · RPO ${p.targets.rpoSeconds}s`]);
    return [
      section('Revisão', 'Confira o resumo. Nada é criado na sua infraestrutura agora: o ambiente só guarda a configuração.', h('dl', { class: 'dl wz-review' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
      W.submitError ? h('div', { class: 'note bad', style: 'white-space:pre-wrap' }, W.submitError) : null,
    ];
  }

  const STEP_FN = { basic: stepBasic, aws: stepAws, eks: stepEks, k8s: stepK8s, ec2: stepEc2, rds: stepRds, cache: stepCache, checks: stepChecks, rpo: stepRpo, review: stepReview };

  // =====================================================================================
  // renderização
  // =====================================================================================
  function renderSteps() {
    const s = stepsFor();
    const idx = s.indexOf(W.step);
    clear(stepsEl);
    s.forEach((id, i) => {
      const st = i < idx ? 'done' : i === idx ? 'current' : '';
      stepsEl.append(h('li', { class: `wz-step ${st}`, 'aria-current': i === idx ? 'step' : null }, h('span', { class: 'n' }, i < idx ? '✓' : i + 1), h('span', { class: 't' }, STEP_LABEL[id])));
    });
  }

  function updateNav() {
    const s = stepsFor();
    const first = s.indexOf(W.step) <= 0;
    const why = validate(W.step);
    backBtn.textContent = first ? 'Cancelar' : 'Voltar';
    backBtn.disabled = W.submitting;
    nextBtn.textContent = W.step === 'review' ? (W.submitting ? 'Criando…' : 'Criar ambiente') : 'Avançar';
    nextBtn.disabled = Boolean(why) || W.submitting;
    hintEl.textContent = why ?? '';
  }

  const FIELDS = 'input,select,textarea,button';

  function renderBody({ focus = true } = {}) {
    // re-renderizações internas (descoberta assíncrona, seleção de cluster…) preservam foco e cursor
    const active = document.activeElement;
    const idx = !focus && bodyEl.contains(active) ? [...bodyEl.querySelectorAll(FIELDS)].indexOf(active) : -1;
    const caret = idx >= 0 && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const keep = bodyEl.scrollTop;
    clear(bodyEl);
    const out = STEP_FN[W.step]();
    for (const part of [out].flat(Infinity)) if (part) bodyEl.append(part);
    bodyEl.scrollTop = keep;
    updateNav();
    if (focus) {
      const el = bodyEl.querySelector('[data-autofocus]') ?? bodyEl.querySelector('input,select,textarea');
      el?.focus({ preventScroll: true });
    } else if (idx >= 0) {
      const el = bodyEl.querySelectorAll(FIELDS)[idx];
      if (el) {
        el.focus({ preventScroll: true });
        if (caret) el.setSelectionRange?.(caret[0], caret[1]);
      }
    }
  }

  function render() {
    renderSteps();
    renderBody();
    window.scrollTo?.({ top: 0 });
  }

  const root = h(
    'div',
    { class: 'wz' },
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, 'Novo ambiente'), h('p', {}, 'O assistente descobre os seus recursos e monta o ambiente — você só confirma.')), h('div', { class: 'row' }, btn('Configurar manualmente', { onClick: onManual }))),
    h('section', { class: 'card wz-card' }, h('nav', { class: 'wz-nav', 'aria-label': 'Etapas do assistente' }, stepsEl), bodyEl, h('div', { class: 'wz-foot' }, h('div', { class: 'row' }, backBtn, hintEl), nextBtn)),
  );
  container.append(root);
  render();
}
