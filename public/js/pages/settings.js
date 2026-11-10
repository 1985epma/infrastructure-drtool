// Ambientes: listar, criar (a partir de modelos), editar e excluir.
import { api } from '../api.js';
import { btn, card, clear, confirmDialog, emptyState, fmtDur, h, toast } from '../dom.js';
import { apiErrorText, checkField, field, numInput, selectInput, textArea, textInput } from '../forms.js';
import { currentEnv, emit, jobRunning, loadEnvs, loadRuns, refreshStatus, saveEnv, selectEnv, state } from '../state.js';
import { mountWizard, parseWorkloadLines, workloadsToText } from '../wizard.js';

const PROVIDER = { k8s: 'Kubernetes (kubectl) — workloads', eks: 'Amazon EKS', custom: 'Comandos customizados', aws: 'Recursos AWS (EC2/RDS/ElastiCache)', simulated: 'Simulado' };

const RESOURCES_DEFAULT = {
  region: '',
  profile: '',
  timeoutSec: 3600,
  ec2: { instanceIds: [], tagKey: '', tagValue: '' },
  rds: { instances: [], clusters: [] },
  elasticache: { replicationGroups: [], serverlessCaches: [], acknowledgeDelete: false },
};

/** Mescla o que veio do servidor com os padrões (listas sempre arrays). */
function mergeResources(r) {
  const d = structuredClone(RESOURCES_DEFAULT);
  if (!r) return d;
  return {
    region: r.region ?? d.region,
    profile: r.profile ?? d.profile,
    timeoutSec: r.timeoutSec ?? d.timeoutSec,
    ec2: { ...d.ec2, ...(r.ec2 ?? {}) },
    rds: { ...d.rds, ...(r.rds ?? {}) },
    elasticache: { ...d.elasticache, ...(r.elasticache ?? {}) },
  };
}

/** Resumo curto, ex.: "2 EC2 · 1 RDS · 1 ElastiCache" (vazio se nada configurado). */
export function resourceSummary(resources) {
  const r = mergeResources(resources);
  const ids = r.ec2.instanceIds.length;
  const ec2 = ids ? `${ids} EC2${r.ec2.tagKey ? ' + tag' : ''}` : r.ec2.tagKey ? 'EC2 (por tag)' : null;
  const rds = r.rds.instances.length + r.rds.clusters.length;
  const ec = r.elasticache.replicationGroups.length + r.elasticache.serverlessCaches.length;
  return [ec2, rds ? `${rds} RDS` : null, ec ? `${ec} ElastiCache` : null].filter(Boolean).join(' · ');
}

/** "a, b  c\nd" -> ['a','b','c','d'] */
const parseList = (text) => String(text ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const joinList = (arr) => (Array.isArray(arr) ? arr.join('\n') : (arr ?? ''));

const DEFAULTS = {
  k8s: { context: '', kubeconfig: '', timeoutSec: 300, workloads: [] },
  eks: { clusterName: '', region: '', profile: '', nodegroups: [], fallbackDesired: 2, useKubectl: true, scaleWorkloads: false, workloadNamespaces: [], readyTimeoutSec: 1200 },
  custom: { cwd: '', statusCommand: '', startCommand: '', stopCommand: '', timeoutSec: 3600, kubeconfig: '', kubeContext: '' },
  simulated: { stopSeconds: 4, startSeconds: 12, warmupSeconds: 6, replicationLagSeconds: 5 },
  targets: { rtoSeconds: 900, rpoSeconds: 300 },
  drill: { holdDownSeconds: 30, probeIntervalSeconds: 5, stableProbes: 3, maxRecoverySeconds: 1800 },
};

const TEMPLATES = [
  ['k8s', 'Kubernetes (kubectl) — workloads', 'Zera e restaura as réplicas de Deployments/StatefulSets escolhidos (ex.: Docker Desktop, kind).'],
  ['eks', 'Amazon EKS', 'Liga/desliga zerando os managed node groups do cluster e restaurando a escala original.'],
  ['custom', 'Comandos customizados', 'Você informa os comandos de ligar/desligar (terraform, eksctl, scripts).'],
  ['aws', 'Recursos AWS (EC2/RDS/ElastiCache)', 'Sem Kubernetes: desliga e religa instâncias EC2, bancos RDS/Aurora e caches ElastiCache.'],
  ['simulated', 'Simulado', 'Sem AWS: ideal para treinar o fluxo e validar relatórios.'],
];

const newEnv = (provider) => ({
  name: '',
  description: '',
  provider,
  k8s: { ...DEFAULTS.k8s, workloads: [] },
  eks: { ...DEFAULTS.eks },
  custom: { ...DEFAULTS.custom },
  simulated: { ...DEFAULTS.simulated },
  resources: structuredClone(RESOURCES_DEFAULT),
  targets: { ...DEFAULTS.targets },
  drill: { ...DEFAULTS.drill },
  rpoSource: { type: 'none' },
  checks: [],
});

const list = (v) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

export function mount(root) {
  let view = 'list'; // 'list' | 'form'

  const wrap = h('div', { class: 'page-wrap', style: 'display:flex;flex-direction:column;gap:18px' });
  root.append(wrap);

  // ---------- lista ----------
  function renderList() {
    view = 'list';
    clear(wrap);
    wrap.append(
      h(
        'div',
        { class: 'page-h' },
        h('div', {}, h('h1', {}, 'Ambientes'), h('p', {}, 'Cada ambiente define o cluster, as metas de RTO/RPO e os padrões do exercício.')),
        btn('Novo ambiente', { kind: 'primary', icon: 'plus', onClick: renderWizard }),
      ),
    );
    if (!state.envs.length) {
      wrap.append(emptyState('Nenhum ambiente', 'Crie o primeiro ambiente para começar.'));
      return;
    }
    const cur = currentEnv();
    wrap.append(
      h(
        'div',
        { class: 'grid two' },
        ...state.envs.map((env) => {
          const isCur = env.id === cur?.id;
          const where = env.provider === 'k8s' ? `${env.k8s?.context || 'contexto padrão'} · ${env.k8s?.workloads?.length ?? 0} workload(s)` : env.provider === 'eks' ? `${env.eks.clusterName} · ${env.eks.region}` : env.provider === 'custom' ? env.custom.startCommand : env.provider === 'aws' ? env.resources?.region || 'AWS' : 'sem AWS';
          const resSummary = resourceSummary(env.resources);
          return h(
            'section',
            { class: 'card' },
            h('div', { class: 'card-h' }, h('h2', {}, env.name), isCur ? h('span', { class: 'pill info' }, 'em uso') : null),
            h(
              'div',
              { class: 'card-b' },
              env.description ? h('p', { class: 'muted' }, env.description) : null,
              h(
                'dl',
                { class: 'dl' },
                h('dt', {}, 'Provider'),
                h('dd', {}, PROVIDER[env.provider]),
                h('dt', {}, 'Destino'),
                h('dd', { class: 'mono' }, where),
                resSummary ? [h('dt', {}, 'Recursos AWS'), h('dd', {}, resSummary)] : null,
                h('dt', {}, 'Metas'),
                h('dd', {}, `RTO ${fmtDur(env.targets.rtoSeconds)} · RPO ${fmtDur(env.targets.rpoSeconds)}`),
                h('dt', {}, 'Testes'),
                h('dd', {}, String(env.checks.length)),
              ),
              h(
                'div',
                { class: 'row' },
                btn('Usar', { kind: 'primary', disabled: isCur || jobRunning(), onClick: () => selectEnv(env.id) }),
                btn('Editar', { icon: 'edit', onClick: () => renderForm(env) }),
                btn('Excluir', { icon: 'trash', kind: 'ghost', disabled: jobRunning(), onClick: () => remove(env) }),
              ),
            ),
          );
        }),
      ),
    );
  }

  async function remove(env) {
    const ok = await confirmDialog({
      title: 'Excluir ambiente',
      message: `Excluir "${env.name}" remove a configuração, os testes e a escala salva. Os relatórios já gerados são mantidos. A infraestrutura real não é alterada.`,
      requireText: env.name,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    const wasCurrent = env.id === state.envId;
    try {
      await api(`/environments/${env.id}`, { method: 'DELETE' });
      await loadEnvs();
      if (wasCurrent) {
        state.status = null;
        emit('env');
        refreshStatus(true);
        loadRuns();
      }
      toast('Ambiente excluído.', 'ok');
      renderList();
    } catch (err) {
      toast(apiErrorText(err), 'error');
    }
  }

  // ---------- assistente ----------
  function renderWizard() {
    view = 'wizard';
    clear(wrap);
    mountWizard(wrap, { onCancel: renderList, onManual: renderTemplates });
  }

  // ---------- escolha de modelo ----------
  function renderTemplates() {
    clear(wrap);
    wrap.append(
      h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, 'Novo ambiente'), h('p', {}, 'Escolha um modelo inicial.')), h('div', { class: 'row' }, btn('Voltar ao assistente', { onClick: renderWizard }), btn('Cancelar', { onClick: renderList }))),
      h(
        'div',
        { class: 'grid two' },
        ...TEMPLATES.map(([key, title, text]) =>
          h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, title)), h('div', { class: 'card-b' }, h('p', { class: 'muted' }, text), btn('Usar este modelo', { kind: 'primary', onClick: () => renderForm(newEnv(key), true) }))),
        ),
      ),
    );
  }

  // ---------- formulário ----------
  function renderForm(env, creating = false) {
    view = 'form';
    const refs = {};
    const name = textInput(env.name, { placeholder: 'Ex.: Produção — us-east-1' });
    const desc = textArea(env.description ?? '', { rows: 2 });
    const provider = selectInput(Object.entries(PROVIDER), env.provider);
    const specific = h('div');
    const errBox = h('div');

    const grid = (...items) => h('div', { class: 'form-grid' }, ...items);
    const span = (el) => (el.classList.add('span'), el);
    const reg = (key, label, input, hint) => ((refs[key] = input), field(label, input, hint));
    const regCheck = (key, label, checked, hint) => {
      const c = checkField(label, checked, hint);
      refs[key] = c.input;
      return c.el;
    };

    function renderSpecific() {
      clear(specific);
      const p = provider.value;
      for (const k of Object.keys(refs)) delete refs[k];
      if (p === 'k8s') {
        const k = { ...DEFAULTS.k8s, ...env.k8s };
        specific.append(
          h(
            'fieldset',
            {},
            h('legend', {}, 'Kubernetes (kubectl)'),
            h('div', { class: 'note' }, '"Desligar" zera as réplicas dos workloads listados (guardando os valores originais em disco) e "Ligar" os restaura. O cluster/nó continua rodando. Requer kubectl com acesso ao cluster.'),
            grid(
              reg('k8s.context', 'Contexto do kubectl', textInput(k.context, { placeholder: 'docker-desktop' }), 'Vazio usa o contexto atual do kubeconfig.'),
              reg('k8s.kubeconfig', 'Kubeconfig (opcional)', textInput(k.kubeconfig), 'Vazio usa o padrão (~/.kube/config ou KUBECONFIG).'),
              reg('k8s.timeoutSec', 'Tempo máximo por operação (s)', numInput(k.timeoutSec, { min: 10, max: 14400 })),
              span(reg('k8s.workloads', 'Workloads (um por linha)', textArea(workloadsToText(k.workloads), { rows: 5, placeholder: 'kube-system/deployment/coredns', spellcheck: 'false' }), 'Formato: namespace/tipo/nome (tipo = deployment ou statefulset).')),
            ),
          ),
        );
      } else if (p === 'eks') {
        const e = { ...DEFAULTS.eks, ...env.eks };
        specific.append(
          h(
            'fieldset',
            {},
            h('legend', {}, 'Amazon EKS'),
            h('div', { class: 'note' }, 'O plano de controle do EKS não pode ser desligado. "Desligar" zera o desiredSize dos managed node groups (guardando a escala original em disco) e "Ligar" restaura essa escala e aguarda os nós ficarem Ready. Requer aws CLI configurada (e kubectl, opcional).'),
            grid(
              reg('eks.clusterName', 'Nome do cluster', textInput(e.clusterName)),
              reg('eks.region', 'Região', textInput(e.region, { placeholder: 'us-east-1' })),
              reg('eks.profile', 'Perfil AWS (opcional)', textInput(e.profile), 'Ex.: o perfil de aws sso login.'),
              span(reg('eks.nodegroups', 'Node groups', textInput(list(e.nodegroups)), 'Lista separada por vírgula. Vazio = todos os managed node groups.')),
              reg('eks.fallbackDesired', 'Nós por node group se não houver escala salva', numInput(e.fallbackDesired, { min: 1, max: 500 })),
              reg('eks.readyTimeoutSec', 'Tempo máximo para nós Ready (s)', numInput(e.readyTimeoutSec, { min: 60, max: 7200 })),
              span(regCheck('eks.useKubectl', 'Usar kubectl (confirma nós Ready/removidos e checks k8s)', e.useKubectl)),
              span(regCheck('eks.scaleWorkloads', 'Escalar Deployments/StatefulSets para 0 antes de desligar (e restaurar ao ligar)', e.scaleWorkloads)),
              span(reg('eks.workloadNamespaces', 'Namespaces dos workloads', textInput(list(e.workloadNamespaces)), 'Obrigatório se a opção acima estiver ativa. Separe por vírgula.')),
            ),
          ),
        );
      } else if (p === 'custom') {
        const c = { ...DEFAULTS.custom, ...env.custom };
        specific.append(
          h(
            'fieldset',
            {},
            h('legend', {}, 'Comandos customizados'),
            h('div', { class: 'note' }, 'Comandos são executados sem shell (argv; aspas são suportadas). Exemplos: terraform -chdir=infra apply -auto-approve · terraform -chdir=infra destroy -auto-approve · eksctl scale nodegroup --cluster meu --name ng-1 --nodes 0 · ./scripts/ligar.sh'),
            grid(
              span(reg('custom.startCommand', 'Comando para ligar', textInput(c.startCommand, { placeholder: 'terraform -chdir=infra apply -auto-approve' }))),
              span(reg('custom.stopCommand', 'Comando para desligar', textInput(c.stopCommand, { placeholder: 'terraform -chdir=infra destroy -auto-approve' }))),
              span(reg('custom.statusCommand', 'Comando de status (opcional)', textInput(c.statusCommand), 'Deve imprimir na última linha: running | stopped | partial | transitioning.')),
              reg('custom.cwd', 'Diretório de trabalho', textInput(c.cwd)),
              reg('custom.timeoutSec', 'Timeout por comando (s)', numInput(c.timeoutSec, { min: 10, max: 14400 })),
              reg('custom.kubeconfig', 'Kubeconfig (para testes k8s)', textInput(c.kubeconfig)),
              reg('custom.kubeContext', 'Contexto kubectl', textInput(c.kubeContext)),
            ),
          ),
        );
      } else if (p === 'aws') {
        specific.append(
          h(
            'fieldset',
            {},
            h('legend', {}, 'Recursos AWS'),
            h('div', { class: 'note' }, 'Este modelo não usa Kubernetes: "Desligar" e "Ligar" atuam apenas nos recursos informados em "Recursos AWS" abaixo. Requer aws CLI configurada.'),
          ),
        );
      } else {
        const s = { ...DEFAULTS.simulated, ...env.simulated };
        specific.append(
          h(
            'fieldset',
            {},
            h('legend', {}, 'Simulação'),
            h('div', { class: 'note' }, 'Nenhuma conta AWS é tocada. Os tempos abaixo controlam o comportamento do cluster simulado.'),
            grid(
              reg('simulated.stopSeconds', 'Tempo para desligar (s)', numInput(s.stopSeconds, { min: 1, max: 600 })),
              reg('simulated.startSeconds', 'Tempo para ligar (s)', numInput(s.startSeconds, { min: 1, max: 600 })),
              reg('simulated.warmupSeconds', 'Aquecimento das aplicações (s)', numInput(s.warmupSeconds, { min: 0, max: 600 })),
              reg('simulated.replicationLagSeconds', 'Defasagem de replicação / RPO (s)', numInput(s.replicationLagSeconds, { min: 0, max: 86400 })),
            ),
          ),
        );
      }
    }
    provider.addEventListener('change', () => {
      renderSpecific();
      syncRes();
    });

    // ---------- recursos AWS (EC2 / RDS / ElastiCache) ----------
    const res = mergeResources(env.resources);
    const resRefs = {};
    const regRes = (key, label, input, hint) => ((resRefs[key] = input), field(label, input, hint));
    const listArea = (key, label, values, placeholder, hint) => regRes(key, label, textArea(joinList(values), { rows: 2, placeholder, spellcheck: 'false' }), hint);
    const ack = checkField('Entendo que o ElastiCache será EXCLUÍDO (com snapshot final) ao desligar e recriado a partir do snapshot ao ligar', res.elasticache.acknowledgeDelete);
    const sub = (title) => span(h('h3', { class: 'res-sub' }, title));
    const resBox = h(
      'fieldset',
      { id: 'res-box' },
      h('legend', {}, 'Recursos AWS (opcional)'),
      h('p', { class: 'muted' }, 'Recursos adicionais desligados e religados junto com o ambiente. Disponível para EKS, comandos customizados e o modelo de recursos AWS.'),
      grid(
        regRes('region', 'Região', textInput(res.region, { placeholder: 'us-east-1' })),
        regRes('profile', 'Perfil AWS (opcional)', textInput(res.profile)),
        regRes('timeoutSec', 'Tempo máximo por operação (s)', numInput(res.timeoutSec, { min: 60, max: 86400 })),
        sub('EC2'),
        span(listArea('ec2.instanceIds', 'IDs das instâncias', res.ec2.instanceIds, 'i-0123456789abcdef0', 'Separe por vírgula, espaço ou quebra de linha.')),
        regRes('ec2.tagKey', 'Selecionar por tag — chave', textInput(res.ec2.tagKey, { placeholder: 'Environment' })),
        regRes('ec2.tagValue', 'Selecionar por tag — valor', textInput(res.ec2.tagValue, { placeholder: 'staging' })),
        span(h('div', { class: 'note' }, 'Instâncias em Auto Scaling Group ou Spot são ignoradas (use o provider EKS/comandos para escalar grupos).')),
        sub('RDS'),
        listArea('rds.instances', 'Instâncias RDS', res.rds.instances, 'meu-banco-1', 'Identificadores (DBInstanceIdentifier).'),
        listArea('rds.clusters', 'Clusters Aurora', res.rds.clusters, 'meu-aurora', 'Identificadores (DBClusterIdentifier).'),
        span(h('div', { class: 'note' }, 'O RDS religa sozinho após 7 dias parado (limite da AWS) — planeje exercícios mais curtos que isso.')),
        sub('ElastiCache'),
        listArea('elasticache.replicationGroups', 'Replication groups (Redis/Valkey)', res.elasticache.replicationGroups, 'meu-redis', 'ReplicationGroupId.'),
        listArea('elasticache.serverlessCaches', 'Serverless caches', res.elasticache.serverlessCaches, 'meu-cache-serverless', 'ServerlessCacheName.'),
        span(h('div', { class: 'note warn' }, 'O ElastiCache não tem stop/start: ao desligar o recurso é EXCLUÍDO (com snapshot final) e, ao ligar, recriado a partir do snapshot. O endpoint pode mudar após a recriação. Não suportados: Memcached, auth token e Global Datastore.')),
        span(ack.el),
      ),
    );
    const syncRes = () => {
      resBox.hidden = provider.value === 'simulated';
    };
    syncRes();

    const t = { ...DEFAULTS.targets, ...env.targets };
    const d = { ...DEFAULTS.drill, ...env.drill };
    const targets = grid(
      reg('targets.rtoSeconds', 'Meta de RTO (s)', numInput(t.rtoSeconds, { min: 1, max: 604800 }), 'Tempo máximo aceitável para restaurar o serviço.'),
      reg('targets.rpoSeconds', 'Meta de RPO (s)', numInput(t.rpoSeconds, { min: 0, max: 604800 }), 'Janela máxima aceitável de perda de dados.'),
    );
    const drill = grid(
      reg('drill.holdDownSeconds', 'Acionamento simulado (s)', numInput(d.holdDownSeconds, { min: 0, max: 7200 }), 'Espera antes de iniciar a recuperação (decisão da equipe).'),
      reg('drill.probeIntervalSeconds', 'Intervalo das amostras (s)', numInput(d.probeIntervalSeconds, { min: 1, max: 300 }), 'Define a resolução do RTO medido.'),
      reg('drill.stableProbes', 'Amostras estáveis para restaurar', numInput(d.stableProbes, { min: 1, max: 60 })),
      reg('drill.maxRecoverySeconds', 'Limite de recuperação (s)', numInput(d.maxRecoverySeconds, { min: 30, max: 14400 })),
    );

    function collect() {
      const out = { ...env, name: name.value, description: desc.value, provider: provider.value, checks: env.checks ?? [], rpoSource: env.rpoSource ?? { type: 'none' } };
      for (const key of ['k8s', 'eks', 'custom', 'simulated', 'targets', 'drill']) out[key] = { ...(env[key] ?? {}) };
      for (const [path, el] of Object.entries(refs)) {
        const [group, k] = path.split('.');
        out[group][k] = el.type === 'checkbox' ? el.checked : el.value;
      }
      if (provider.value === 'k8s') out.k8s.workloads = parseWorkloadLines(refs['k8s.workloads']?.value);
      const v = (k) => resRefs[k].value;
      out.resources =
        provider.value === 'simulated'
          ? structuredClone(RESOURCES_DEFAULT)
          : {
              region: v('region'),
              profile: v('profile'),
              timeoutSec: v('timeoutSec'),
              ec2: { instanceIds: parseList(v('ec2.instanceIds')), tagKey: v('ec2.tagKey'), tagValue: v('ec2.tagValue') },
              rds: { instances: parseList(v('rds.instances')), clusters: parseList(v('rds.clusters')) },
              elasticache: {
                replicationGroups: parseList(v('elasticache.replicationGroups')),
                serverlessCaches: parseList(v('elasticache.serverlessCaches')),
                acknowledgeDelete: ack.input.checked,
              },
            };
      return out;
    }

    async function save() {
      clear(errBox);
      const body = collect();
      const ec = body.resources.elasticache;
      if ((ec.replicationGroups.length || ec.serverlessCaches.length) && !ec.acknowledgeDelete) {
        errBox.append(h('div', { class: 'note bad' }, 'Há recursos ElastiCache listados: marque a confirmação de que eles serão EXCLUÍDOS (com snapshot final) ao desligar.'));
        toast('Confirme a exclusão do ElastiCache para salvar.', 'error');
        ack.input.focus();
        return;
      }
      try {
        if (creating) {
          const created = await api('/environments', { method: 'POST', body });
          await loadEnvs();
          selectEnv(created.id);
          toast('Ambiente criado.', 'ok');
        } else {
          await saveEnv(body);
          state.status = null;
          refreshStatus(true);
          toast('Ambiente salvo.', 'ok');
        }
        renderList();
      } catch (err) {
        errBox.append(h('div', { class: 'note bad', style: 'white-space:pre-wrap' }, apiErrorText(err)));
        toast('Corrija os campos destacados.', 'error');
      }
    }

    renderSpecific();
    clear(wrap).append(
      h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, creating ? 'Novo ambiente' : `Editar: ${env.name}`)), h('div', { class: 'row' }, btn('Voltar', { onClick: renderList }), btn('Salvar', { kind: 'primary', onClick: save }))),
      errBox,
      card('Geral', {}, grid(span(field('Nome', name)), span(field('Descrição', desc)), field('Provider', provider))),
      specific,
      resBox,
      card('Metas', {}, targets),
      card('Padrões do exercício', {}, drill),
      h('div', { class: 'row' }, btn('Voltar', { onClick: renderList }), btn('Salvar', { kind: 'primary', onClick: save })),
    );
  }

  renderList();
  return () => {
    view = null;
  };
}
