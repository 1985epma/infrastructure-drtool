// Exercício RTO/RPO: configuração, acompanhamento ao vivo e resultado.
import { api } from '../api.js';
import { btn, clear, confirmDialog, emptyState, fmtDur, fmtTime, h, toast, verdictPill } from '../dom.js';
import { apiErrorText, checkField, field, numInput } from '../forms.js';
import { buildRpoCard } from '../rpo-card.js';
import { currentEnv, jobRunning, on, startJob, state } from '../state.js';

const PHASES = [
  ['preflight', 'Pré-verificações'],
  ['baseline', 'Linha de base'],
  ['failure', 'Falha'],
  ['hold', 'Acionamento'],
  ['recovery', 'Recuperação'],
  ['validate', 'Validação'],
  ['rpo', 'Medição de RPO'],
  ['finalize', 'Relatório'],
];

const MARKS = [
  ['failureAt', 'Falha injetada'],
  ['detectedAt', 'Indisponibilidade detectada'],
  ['recoveryStartAt', 'Recuperação iniciada'],
  ['infraReadyAt', 'Infra pronta'],
  ['restoredAt', 'Serviço restaurado (RTO)'],
  ['rpoStartAt', 'Medição de RPO iniciada'],
  ['rpoDoneAt', 'RPO apurado'],
];

export function mount(root) {
  const env = currentEnv();
  if (!env) {
    root.append(emptyState('Nenhum ambiente configurado', '', h('a', { class: 'btn primary', href: '#/config' }, 'Configurar ambiente')));
    return;
  }
  const offs = [];
  const isDrill = () => state.job?.kind === 'drill' && state.job.envId === env.id;

  // ---------- configuração ----------
  const d = env.drill;
  const inputs = {
    holdDownSeconds: numInput(d.holdDownSeconds, { min: 0, max: 7200 }),
    probeIntervalSeconds: numInput(d.probeIntervalSeconds, { min: 1, max: 300 }),
    stableProbes: numInput(d.stableProbes, { min: 1, max: 60 }),
    maxRecoverySeconds: numInput(d.maxRecoverySeconds, { min: 30, max: 14400 }),
  };
  const store = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignora */
    }
  };
  const autoOpen = checkField('Abrir o relatório automaticamente ao finalizar', localStorage.getItem('eksdr-autoreport') !== '0');
  const autoDl = checkField('Baixar também o relatório em HTML ao finalizar', localStorage.getItem('eksdr-autodownload') === '1');
  autoOpen.input.addEventListener('change', () => store('eksdr-autoreport', autoOpen.input.checked ? '1' : '0'));
  autoDl.input.addEventListener('change', () => store('eksdr-autodownload', autoDl.input.checked ? '1' : '0'));
  const startBtn = btn('Iniciar exercício', { kind: 'danger', icon: 'play', onClick: start });

  async function start() {
    const params = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const ok = await confirmDialog({
      title: 'Iniciar exercício de RTO/RPO',
      message: `O exercício vai DESLIGAR "${env.name}", derrubando as aplicações, e depois religá-lo medindo o tempo de recuperação.`,
      requireText: env.provider === 'simulated' ? null : env.name,
      confirmLabel: 'Desligar e medir',
      danger: true,
    });
    if (!ok) return;
    try {
      await startJob('drill', { confirm: ok.text, params });
    } catch (err) {
      toast(apiErrorText(err), 'error');
    }
  }

  const configCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', {}, 'Configurar exercício'), h('div', { class: 'card-actions' }, startBtn)),
    h(
      'div',
      { class: 'card-b' },
      h('div', { class: 'note warn' }, h('strong', {}, 'Atenção: '), `este exercício DESLIGA o ambiente "${env.name}". As aplicações ficarão indisponíveis até a recuperação terminar. Use apenas em janelas planejadas.`),
      h(
        'div',
        { class: 'form-grid' },
        field('Tempo de acionamento simulado (s)', inputs.holdDownSeconds, 'Espera mínima desde a falha até iniciar a recuperação (decisão da equipe).'),
        field('Intervalo entre testes (s)', inputs.probeIntervalSeconds, 'Resolução das medições.'),
        field('Testes estáveis para restaurar', inputs.stableProbes, 'Amostras consecutivas saudáveis para declarar o serviço restaurado.'),
        field('Limite de recuperação (s)', inputs.maxRecoverySeconds, 'Após isso o exercício termina como tempo esgotado.'),
      ),
      h('div', { class: 'row', style: 'margin-top:14px;gap:24px' }, autoOpen.el, autoDl.el),
      h('p', { class: 'muted', style: 'margin:12px 0 0' }, `Metas: RTO ${fmtDur(env.targets.rtoSeconds)} · RPO ${fmtDur(env.targets.rpoSeconds)} · ${env.checks.filter((c) => c.critical).length} teste(s) crítico(s).`),
    ),
  );

  // ---------- painel ao vivo ----------
  const stepper = h('div', { class: 'stepper' });
  const timer = h('div', { class: 'big-timer' }, '0s');
  const timerLabel = h('div', { class: 'muted' });
  const svcPill = h('span', {});
  const strip = h('div', { class: 'strip', 'aria-label': 'Últimas amostras de disponibilidade' });
  const marks = h('div', { class: 'marks' });
  const consoleBox = h('div', { class: 'console', role: 'log', 'aria-label': 'Registro do exercício' });
  const liveActions = h('div', { class: 'card-actions' });
  const liveTitle = h('h2', {}, 'Acompanhamento ao vivo');
  const resultBox = h('div');
  const liveCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-h' }, liveTitle, liveActions),
    h('div', { class: 'card-b', style: 'display:flex;flex-direction:column;gap:16px' }, stepper, h('div', { class: 'row', style: 'gap:24px;align-items:flex-end' }, h('div', {}, timerLabel, timer), svcPill), strip, marks, resultBox, consoleBox),
  );

  async function cancel() {
    try {
      await api('/job/cancel', { method: 'POST', body: {} });
      toast('Cancelamento solicitado — o ambiente será religado por segurança.', 'warn');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  let renderedFor = null;
  let renderedCount = 0;

  function renderLive() {
    const j = state.job;
    const show = isDrill();
    liveCard.hidden = !show;
    startBtn.disabled = jobRunning();
    if (!show) return;
    const live = j.live ?? {};
    const running = j.status === 'running';

    clear(liveActions);
    if (running) liveActions.append(h('span', { class: 'pill info' }, h('span', { class: 'spinner' }), live.phaseLabel ?? 'Iniciando'), btn('Cancelar', { icon: 'stop', onClick: cancel }));
    else liveActions.append(j.status === 'succeeded' ? h('span', { class: 'pill ok' }, 'Concluído') : j.status === 'cancelled' ? h('span', { class: 'pill warn' }, 'Cancelado') : h('span', { class: 'pill bad' }, 'Falhou'));

    // stepper
    const idx = PHASES.findIndex(([k]) => k === live.phase);
    clear(stepper);
    PHASES.forEach(([, label], i) => {
      const cls = !running && j.status === 'succeeded' ? 'done' : i < idx ? 'done' : i === idx ? (running ? 'active' : 'done') : '';
      stepper.append(h('div', { class: `step ${cls}` }, h('span', { class: 'n' }, i + 1), label));
    });

    // serviço agora
    clear(svcPill);
    if (running && live.upNow !== undefined) svcPill.append(h('span', { class: `pill ${live.upNow ? 'ok' : 'bad'}` }, h('i', { class: 'dot' }), live.upNow ? 'Serviço no ar' : 'Serviço fora do ar'));

    // faixa de amostras
    clear(strip);
    const samples = live.samples ?? [];
    const total = 60;
    const shown = samples.slice(-total);
    for (let i = 0; i < total - shown.length; i++) strip.append(h('i', { class: 'empty' }));
    for (const s of shown) strip.append(h('i', { class: s.ok ? '' : 'bad', title: fmtTime(s.t) }));

    // marcos
    clear(marks);
    for (const [k, label] of MARKS) {
      const t = live[k];
      marks.append(h('div', { class: `mark ${t ? 'hit' : ''}` }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, t ? fmtTime(t) : '—')));
    }

    renderResult(j);
    tick();

    // console
    if (renderedFor !== j.id) {
      clear(consoleBox);
      renderedFor = j.id;
      renderedCount = 0;
    }
    const near = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 40;
    for (; renderedCount < state.jobLog.length; renderedCount++) {
      const e = state.jobLog[renderedCount];
      consoleBox.append(h('div', { class: e.level }, h('span', { class: 't' }, fmtTime(e.t)), e.msg));
    }
    if (near) consoleBox.scrollTop = consoleBox.scrollHeight;
  }

  function renderResult(j) {
    clear(resultBox);
    if (j.status === 'running') return;
    if (j.error && j.status !== 'succeeded') resultBox.append(h('div', { class: `note ${j.status === 'cancelled' ? 'warn' : 'bad'}` }, j.error));
    const ev = j.result?.evaluation;
    if (!ev) return;
    const kpi = (label, value, sub, cls) => h('div', { class: `kpi ${cls}` }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub));
    resultBox.append(
      h(
        'div',
        { class: 'row', style: 'margin-bottom:8px' },
        h('strong', {}, 'Resultado:'),
        verdictPill(ev.verdict),
        j.live?.runId ? h('a', { class: 'btn primary', href: `#/relatorios?run=${encodeURIComponent(j.live.runId)}` }, 'Abrir relatório') : null,
      ),
      h(
        'div',
        { class: 'grid kpis' },
        kpi('RTO medido', fmtDur(ev.rto.actualSec), `meta ${fmtDur(ev.rto.targetSec)}`, ev.rto.actualSec == null ? '' : ev.rto.pass ? 'ok' : 'bad'),
        kpi('RPO medido', ev.rpo.measured ? fmtDur(ev.rpo.actualSec) : 'não medido', ev.rpo.measured ? `meta ${fmtDur(ev.rpo.targetSec)}` : 'configure a fonte de RPO no cartão acima', !ev.rpo.measured ? 'warn' : ev.rpo.pass ? 'ok' : 'bad'),
        kpi('Disponibilidade', j.result.metrics?.availabilityPct == null ? '—' : `${j.result.metrics.availabilityPct.toFixed(2).replace('.', ',')}%`, `indisponível ${fmtDur(j.result.metrics?.downtimeSec)}`, ''),
      ),
    );
  }

  // timer: indisponibilidade = falha → (restaurado ou agora)
  function tick() {
    const j = state.job;
    if (!isDrill()) return;
    const live = j.live ?? {};
    timer.className = 'big-timer';
    if (!live.failureAt) {
      timerLabel.textContent = 'Aguardando a injeção da falha';
      timer.textContent = '—';
      return;
    }
    const end = live.restoredAt ?? (j.status === 'running' ? Date.now() : (j.result?.finishedAt ? new Date(j.result.finishedAt).getTime() : Date.now()));
    timer.textContent = fmtDur((end - live.failureAt) / 1000);
    if (live.restoredAt) {
      timer.classList.add('done');
      timerLabel.textContent = 'RTO medido (falha → serviço restaurado)';
    } else {
      timer.classList.add('down');
      timerLabel.textContent = 'Tempo desde a falha (RTO em curso)';
    }
  }

  root.append(
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, 'Exercício de RTO/RPO'), h('p', {}, 'Desliga o ambiente, mede quanto tempo as aplicações levam para voltar (RTO) e quanto dado se perde (RPO), e gera o relatório.'))),
    configCard,
    buildRpoCard(env),
    liveCard,
  );
  liveCard.hidden = true;
  renderLive();
  offs.push(on('job', renderLive));
  const timerId = setInterval(tick, 500);

  return () => {
    offs.forEach((o) => o());
    clearInterval(timerId);
  };
}
