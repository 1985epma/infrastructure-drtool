// Painel: estado da infraestrutura, ligar/desligar, saúde das aplicações, console da operação.
import { api } from '../api.js';
import { btn, card, clear, confirmDialog, emptyState, fmtDateTime, fmtDur, fmtTime, h, statePill, toast, verdictPill } from '../dom.js';
import { currentEnv, jobRunning, loadRuns, on, refreshStatus, runChecks, startJob, state } from '../state.js';

const PROVIDER = { k8s: 'Kubernetes (kubectl)', eks: 'Amazon EKS (managed node groups)', custom: 'Comandos customizados', aws: 'Recursos AWS (EC2/RDS/ElastiCache)', simulated: 'Simulado (sem AWS)' };

const RES_TYPE = {
  ec2: 'EC2',
  'rds-instance': 'RDS (instância)',
  'rds-cluster': 'RDS/Aurora (cluster)',
  'elasticache-rg': 'ElastiCache (replication group)',
  'elasticache-serverless': 'ElastiCache Serverless',
};

/** Descreve o que Desligar/Ligar afetará nos recursos AWS anexados (null se não houver). */
function affectedResources(env, kind) {
  const r = env.resources;
  if (!r || env.provider === 'simulated') return null;
  const items = [];
  const ids = r.ec2?.instanceIds ?? [];
  if (ids.length || r.ec2?.tagKey) {
    const parts = [ids.length ? `${ids.length} instância(s): ${ids.join(', ')}` : null, r.ec2.tagKey ? `tag ${r.ec2.tagKey}=${r.ec2.tagValue ?? ''}` : null].filter(Boolean);
    items.push(`EC2 — ${kind === 'stop' ? 'parar' : 'iniciar'} ${parts.join(' + ')}`);
  }
  const inst = r.rds?.instances ?? [];
  const clu = r.rds?.clusters ?? [];
  if (inst.length) items.push(`RDS — ${kind === 'stop' ? 'parar' : 'iniciar'} instância(s): ${inst.join(', ')}`);
  if (clu.length) items.push(`Aurora — ${kind === 'stop' ? 'parar' : 'iniciar'} cluster(s): ${clu.join(', ')}`);
  const ec = [...(r.elasticache?.replicationGroups ?? []), ...(r.elasticache?.serverlessCaches ?? [])];
  if (ec.length) items.push(`ElastiCache — ${kind === 'stop' ? 'EXCLUIR (com snapshot final)' : 'recriar a partir do snapshot'}: ${ec.join(', ')}`);
  return items.length ? { items, hasElasticache: ec.length > 0 } : null;
}

function impactBlock(env, kind) {
  const a = affectedResources(env, kind);
  if (!a) return null;
  return h(
    'div',
    {},
    h('p', { class: 'muted' }, 'Recursos AWS afetados:'),
    h('ul', { class: 'affected' }, ...a.items.map((t) => h('li', {}, t))),
    a.hasElasticache
      ? h('div', { class: 'note warn' }, kind === 'stop' ? 'Atenção: o ElastiCache será EXCLUÍDO (com snapshot final) e o endpoint pode mudar quando for recriado.' : 'O ElastiCache será recriado a partir do snapshot: o endpoint pode mudar e o cache volta com os dados do snapshot.')
      : null,
  );
}

export function mount(root) {
  const env = currentEnv();
  if (!env) {
    root.append(emptyState('Nenhum ambiente configurado', 'Crie um ambiente para começar a medir RTO/RPO.', h('a', { class: 'btn primary', href: '#/config' }, 'Configurar ambiente')));
    return;
  }
  const offs = [];
  const timers = [];

  // ---------- ações de energia ----------
  async function power(kind) {
    try {
      if (kind === 'stop') {
        const ok = await confirmDialog({
          title: 'Desligar ambiente',
          message: h(
            'div',
            {},
            h('p', {}, env.provider === 'aws' ? `Isto desliga os recursos AWS de "${env.name}" e derruba as aplicações que dependem deles.` : `Isto zera a capacidade de computação de "${env.name}" e derruba as aplicações. A escala original fica salva para religar depois.`),
            impactBlock(env, 'stop'),
          ),
          requireText: env.provider === 'simulated' ? null : env.name,
          confirmLabel: 'Desligar',
          danger: true,
        });
        if (ok) await startJob('stop', { confirm: ok.text });
      } else {
        const ok = await confirmDialog({ title: 'Ligar ambiente', message: h('div', {}, h('p', {}, `Restaura a capacidade de "${env.name}" e aguarda as aplicações ficarem saudáveis.`), impactBlock(env, 'start')), confirmLabel: 'Ligar' });
        if (ok) await startJob('start');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- card: infraestrutura ----------
  const infraActions = h('div', { class: 'card-actions' });
  const infraBody = h('div', { class: 'card-b' });

  function renderInfra() {
    const st = state.status;
    const busy = jobRunning();
    clear(infraActions).append(
      st ? statePill(st.state) : h('span', { class: 'spinner' }),
      btn('Ligar', { kind: 'primary', icon: 'power', onClick: () => power('start'), disabled: busy || st?.state === 'running' }),
      btn('Desligar', { kind: 'danger', icon: 'stop', onClick: () => power('stop'), disabled: busy || st?.state === 'stopped' }),
      btn('', { icon: 'refresh', title: 'Atualizar estado', kind: 'ghost icon-btn', onClick: () => refreshStatus(true), disabled: state.statusLoading }),
    );
    clear(infraBody);
    if (!st) return infraBody.append(h('div', { class: 'muted' }, 'Consultando o ambiente…'));
    if (st.note) infraBody.append(h('div', { class: `note ${['error', 'missing'].includes(st.state) ? 'bad' : ''}` }, st.note));
    const dl = h('dl', { class: 'dl' }, h('dt', {}, 'Provider'), h('dd', {}, PROVIDER[env.provider]));
    const cluster = st.cluster?.name ?? env.eks?.clusterName;
    if (env.provider === 'k8s' && env.k8s?.context) dl.append(h('dt', {}, 'Contexto'), h('dd', { class: 'mono' }, env.k8s.context));
    if (cluster) dl.append(h('dt', {}, 'Cluster'), h('dd', {}, cluster, st.cluster?.version ? ` · Kubernetes ${st.cluster.version}` : ''));
    if (env.provider === 'eks') dl.append(h('dt', {}, 'Região'), h('dd', {}, env.eks.region + (env.eks.profile ? ` · perfil ${env.eks.profile}` : '')));
    else if (env.provider === 'aws' && env.resources?.region) dl.append(h('dt', {}, 'Região'), h('dd', {}, env.resources.region + (env.resources.profile ? ` · perfil ${env.resources.profile}` : '')));
    if (st.nodes) dl.append(h('dt', {}, 'Nós Ready'), h('dd', {}, `${st.nodes.ready}/${st.nodes.total}`));
    if (st.saved) {
      const parts = Object.entries(st.saved.nodegroups).map(([n, s]) => `${n}=${s.desired}`);
      dl.append(h('dt', {}, 'Escala salva'), h('dd', {}, `${parts.join(', ')} · ${fmtDateTime(st.saved.savedAt)}`));
    }
    dl.append(h('dt', {}, 'Consultado'), h('dd', { class: 'muted' }, fmtTime(st.checkedAt ?? state.statusAt)));
    infraBody.append(dl);
    if (st.resources?.length) {
      infraBody.append(
        h('h3', { class: 'res-sub' }, 'Recursos AWS'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Tipo'), h('th', {}, 'Identificador'), h('th', {}, 'Estado'), h('th', {}, 'Detalhe'))),
            h('tbody', {}, ...st.resources.map((x) => h('tr', {}, h('td', {}, RES_TYPE[x.type] ?? x.type), h('td', { class: 'mono' }, x.id), h('td', {}, statePill(x.state)), h('td', { class: 'muted' }, x.detail ?? '')))),
          ),
        ),
      );
    }
    if (st.workloads?.length) {
      infraBody.append(
        h('h3', { class: 'res-sub' }, 'Workloads'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Workload'), h('th', {}, 'Tipo'), h('th', { class: 'num' }, 'Desejado'), h('th', { class: 'num' }, 'Prontas'))),
            h('tbody', {}, ...st.workloads.map((w) => h('tr', {}, h('td', { class: 'mono' }, `${w.namespace}/${w.name}`), h('td', { class: 'muted' }, w.kind), h('td', { class: 'num' }, h('strong', {}, w.desired)), h('td', { class: 'num' }, w.ready ?? 0)))),
          ),
        ),
      );
    }
    if (st.nodegroups?.length) {
      infraBody.append(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('thead', {}, h('tr', {}, ...['Node group', 'Status', 'Mín', 'Desejado', 'Máx', 'Instância'].map((t, i) => h('th', { class: i >= 2 && i <= 4 ? 'num' : '' }, t)))),
            h(
              'tbody',
              {},
              ...st.nodegroups.map((g) =>
                h(
                  'tr',
                  {},
                  h('td', {}, g.name),
                  h('td', {}, g.status, g.issues?.length ? h('div', { class: 'muted' }, g.issues.join('; ')) : null),
                  h('td', { class: 'num' }, g.min),
                  h('td', { class: 'num' }, h('strong', {}, g.desired)),
                  h('td', { class: 'num' }, g.max),
                  h('td', { class: 'muted' }, [...(g.instanceTypes ?? []), g.capacityType].filter(Boolean).join(' · ')),
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  // ---------- card: aplicações ----------
  const appsBody = h('div', { class: 'card-b flush' });
  const autoBox = h('input', { type: 'checkbox', id: 'auto', checked: localStorage.getItem('eksdr-auto') !== '0' });
  autoBox.addEventListener('change', () => localStorage.setItem('eksdr-auto', autoBox.checked ? '1' : '0'));
  let running = false;
  const runAll = async () => {
    if (running || !env.checks.length) return;
    running = true;
    renderApps();
    try {
      await runChecks();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      running = false;
      renderApps();
    }
  };
  const runBtn = btn('Executar testes', { icon: 'play', onClick: runAll });

  function renderApps() {
    runBtn.disabled = running || !env.checks.length;
    clear(appsBody);
    if (!env.checks.length) {
      return appsBody.append(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Nenhum teste cadastrado.'), h('a', { class: 'btn', href: '#/testes' }, 'Cadastrar testes')));
    }
    const res = state.results[env.id] ?? {};
    for (const c of env.checks) {
      const r = res[c.id];
      appsBody.append(
        h(
          'div',
          { class: 'chk' },
          h('i', { class: `led ${r ? (r.ok ? 'ok' : 'bad') : ''}` }),
          h('div', { class: 'name' }, c.name, ' ', h('span', { class: 'tag' }, c.type), c.critical ? null : h('span', { class: 'tag' }, 'não crítico'), h('div', { class: 'detail' }, r ? r.detail : 'ainda não executado')),
          h('div', { class: 'muted num' }, r ? `${Math.round(r.ms)} ms` : ''),
        ),
      );
    }
  }

  // ---------- KPIs ----------
  const kpis = h('div', { class: 'grid kpis' });
  function renderKpis() {
    clear(kpis);
    const drills = state.runs.filter((r) => r.kind === 'drill');
    const last = drills[0];
    const lastStart = state.runs.find((r) => r.kind === 'start' && r.status === 'completed');
    const k = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub));
    const ev = last?.evaluation;
    kpis.append(
      k('Último RTO medido', fmtDur(last?.metrics?.rtoSec), `meta ${fmtDur(env.targets.rtoSeconds)}${last ? ` · ${fmtDateTime(last.startedAt)}` : ''}`, ev?.rto?.actualSec == null ? '' : ev.rto.pass ? 'ok' : 'bad'),
      k('Último RPO medido', ev?.rpo?.measured ? fmtDur(last.metrics.rpoSec) : '—', `meta ${fmtDur(env.targets.rpoSeconds)}`, !ev?.rpo?.measured ? '' : ev.rpo.pass ? 'ok' : 'bad'),
      k('Exercícios', String(drills.length), `${drills.filter((d) => d.evaluation?.verdict === 'approved').length} aprovado(s)`),
      k('Último religamento', fmtDur(lastStart?.durationSec), lastStart ? `até a infra e apps prontas · ${fmtDateTime(lastStart.startedAt)}` : 'nenhum registrado'),
    );
  }

  // ---------- console ----------
  const consoleActions = h('div', { class: 'card-actions' });
  const consoleBox = h('div', { class: 'console', role: 'log', 'aria-label': 'Registro da operação' });
  const consoleHead = h('div', { class: 'row', style: 'margin-bottom:10px' });
  let renderedFor = null;
  let renderedCount = 0;

  function renderConsole() {
    const j = state.job;
    clear(consoleActions);
    clear(consoleHead);
    if (!j) {
      consoleBox.textContent = 'Nenhuma operação executada nesta sessão. Use Ligar/Desligar ou inicie um exercício.';
      renderedFor = null;
      return;
    }
    const pill = j.status === 'running' ? h('span', { class: 'pill info' }, h('span', { class: 'spinner' }), 'Em andamento') : j.status === 'succeeded' ? h('span', { class: 'pill ok' }, 'Concluído') : j.status === 'cancelled' ? h('span', { class: 'pill warn' }, 'Cancelado') : h('span', { class: 'pill bad' }, 'Falhou');
    consoleHead.append(
      ...[
        h('strong', {}, j.title),
        pill,
        j.live?.phaseLabel && j.status === 'running' ? h('span', { class: 'muted' }, j.live.phaseLabel) : null,
        j.error && j.status !== 'cancelled' ? h('span', { class: 'muted' }, j.error) : null,
      ].filter(Boolean),
    );
    if (j.status === 'running') consoleActions.append(btn('Cancelar', { icon: 'stop', onClick: cancelJob }));
    else if (j.live?.runId) consoleActions.append(h('a', { class: 'btn', href: `#/relatorios?run=${encodeURIComponent(j.live.runId)}` }, 'Ver relatório'));
    if (renderedFor !== j.id) {
      clear(consoleBox);
      renderedFor = j.id;
      renderedCount = 0;
    }
    const nearBottom = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 40;
    for (; renderedCount < state.jobLog.length; renderedCount++) {
      const e = state.jobLog[renderedCount];
      consoleBox.append(h('div', { class: e.level }, h('span', { class: 't' }, fmtTime(e.t)), e.msg));
    }
    if (nearBottom) consoleBox.scrollTop = consoleBox.scrollHeight;
  }

  async function cancelJob() {
    try {
      await api('/job/cancel', { method: 'POST', body: {} });
      toast('Cancelamento solicitado…', 'warn');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- montagem ----------
  root.append(
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, env.name), env.description ? h('p', {}, env.description) : null)),
    kpis,
    h(
      'div',
      { class: 'grid two' },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Infraestrutura'), infraActions), infraBody),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Saúde das aplicações'), h('div', { class: 'card-actions' }, h('label', { class: 'row muted', for: 'auto' }, autoBox, 'a cada 10s'), runBtn)), appsBody),
    ),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Console da operação'), consoleActions), h('div', { class: 'card-b' }, consoleHead, consoleBox)),
  );

  renderInfra();
  renderApps();
  renderKpis();
  renderConsole();

  offs.push(on('status', renderInfra), on('status-loading', renderInfra), on('checks', renderApps), on('runs', renderKpis), on('job', () => (renderConsole(), renderInfra())));
  if (!state.status) refreshStatus();
  loadRuns();
  if (env.checks.length) runAll();
  timers.push(
    setInterval(() => !document.hidden && refreshStatus(), 15_000),
    setInterval(() => !document.hidden && autoBox.checked && runAll(), 10_000),
  );

  return () => {
    offs.forEach((o) => o());
    timers.forEach(clearInterval);
  };
}
