// Shell: navegação, seletor de ambiente, indicador de operação e roteador por hash.
import { api, setAuthHandler } from './api.js';
import { $, clear, h, icon, openDialog, statePill, toast } from './dom.js';
import { currentEnv, emit, jobRunning, loadEnvs, loadRuns, on, pollJob, refreshStatus, selectEnv, state } from './state.js';
import * as dashboard from './pages/dashboard.js';
import * as tests from './pages/tests.js';
import * as drill from './pages/drill.js';
import * as reports from './pages/reports.js';
import * as settings from './pages/settings.js';
import { MODES, applyTheme, getMode, setMode } from './theme.js';

const MODE_ICON = { system: 'auto', light: 'sun', dark: 'moon' };

/** Seletor de modo de cor: Auto / Claro / Escuro. */
function themeControls() {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Modo de cor' });
  const renderSeg = () => {
    clear(seg);
    for (const [key, label] of MODES) {
      seg.append(
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(getMode() === key),
            title: `Modo ${label.toLowerCase()}`,
            onclick: () => {
              setMode(key);
              renderSeg();
            },
          },
          icon(MODE_ICON[key], 16),
          h('span', {}, label),
        ),
      );
    }
  };
  renderSeg();
  return seg;
}

const ROUTES = {
  painel: { label: 'Painel', icon: 'grid', page: dashboard },
  testes: { label: 'Testes', icon: 'check', page: tests },
  exercicio: { label: 'Exercício RTO/RPO', icon: 'pulse', page: drill },
  relatorios: { label: 'Relatórios', icon: 'file', page: reports },
  config: { label: 'Ambientes', icon: 'cog', page: settings },
};

let cleanup = null;
let pageRoot;
let navEl;
let envSelect;
let statusSlot;
let jobSlot;

setAuthHandler(
  () =>
    new Promise((resolve) => {
      const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'ADMIN_TOKEN' });
      let value = null;
      const { dlg } = openDialog({
        title: 'Autenticação necessária',
        content: [h('p', {}, 'Este console exige o token definido em ADMIN_TOKEN.'), input],
        actions: [{ label: 'Entrar', kind: 'primary', onClick: (close) => ((value = input.value), close()) }],
      });
      input.addEventListener('keydown', (e) => e.key === 'Enter' && ((value = input.value), dlg.close()));
      dlg.addEventListener('close', () => resolve(value));
      input.focus();
    }),
);

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, queryStr = ''] = hash.split('?');
  return { name: ROUTES[name] ? name : 'painel', query: new URLSearchParams(queryStr) };
}

function mountPage() {
  cleanup?.();
  cleanup = null;
  const { name, query } = route();
  for (const a of navEl.querySelectorAll('a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  clear(pageRoot);
  document.title = `${ROUTES[name].label} · EPMA | Infrastructure & DR Tool`;
  cleanup = ROUTES[name].page.mount(pageRoot, { query }) ?? null;
}

function renderTop() {
  clear(envSelect);
  for (const e of state.envs) envSelect.append(h('option', { value: e.id, selected: e.id === state.envId }, e.name));
  envSelect.disabled = jobRunning();
}

function renderStatus() {
  clear(statusSlot);
  if (!currentEnv()) return;
  statusSlot.append(state.statusLoading && !state.status ? h('span', { class: 'spinner', title: 'Consultando…' }) : statePill(state.status?.state ?? 'unknown'));
}

function renderJob() {
  clear(jobSlot);
  const j = state.job;
  if (jobRunning()) {
    jobSlot.append(
      h('a', { href: j.kind === 'drill' ? '#/exercicio' : '#/painel', class: 'pill info', title: 'Operação em andamento' }, h('span', { class: 'spinner' }), ` ${j.title}`),
    );
  }
  envSelect.disabled = jobRunning();
}

async function init() {
  applyTheme();
  const app = $('#app');
  navEl = h('nav', { class: 'nav', 'aria-label': 'Principal' }, ...Object.entries(ROUTES).map(([key, r]) => h('a', { href: `#/${key}`, 'data-route': key }, icon(r.icon, 18), r.label)));
  envSelect = h('select', { id: 'env-select', 'aria-label': 'Ambiente', onchange: (e) => selectEnv(e.target.value) });
  statusSlot = h('span', {});
  jobSlot = h('span', {});
  pageRoot = h('main', { class: 'page', id: 'page' });
  const toolsSlot = h('div', { class: 'side-foot' });
  app.append(
    h(
      'div',
      { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, 'EPMA', h('small', {}, 'Infrastructure & DR Tool'))), navEl, toolsSlot),
      h('div', { class: 'main' }, h('header', { class: 'top' }, h('label', { for: 'env-select' }, 'Ambiente'), envSelect, statusSlot, h('span', { class: 'grow' }), jobSlot, themeControls()), pageRoot),
    ),
  );

  try {
    state.meta = await api('/meta');
  } catch (err) {
    pageRoot.append(h('div', { class: 'note bad' }, `Não foi possível falar com o servidor: ${err.message}`));
    return;
  }
  const t = state.meta.tools;
  toolsSlot.append(
    h('div', { class: 'tool', title: t.aws.version ?? t.aws.error }, h('i', { class: `led ${t.aws.ok ? 'ok' : 'bad'}` }), 'aws CLI'),
    h('div', { class: 'tool', title: t.kubectl.version ?? t.kubectl.error }, h('i', { class: `led ${t.kubectl.ok ? 'ok' : 'bad'}` }), 'kubectl'),
    h('div', {}, `Node ${state.meta.node}`),
  );

  await loadEnvs();
  renderTop();
  renderStatus();

  on('envs', () => (renderTop(), renderStatus()));
  on('env', () => {
    renderTop();
    renderStatus();
    mountPage();
  });
  on('status', renderStatus);
  on('status-loading', renderStatus);
  on('job', () => (renderJob(), renderTop()));
  window.addEventListener('hashchange', mountPage);

  mountPage();
  if (currentEnv()) {
    refreshStatus();
    loadRuns();
  }
  pollJob(); // retoma o acompanhamento se já houver operação em andamento
}

init().catch((err) => {
  console.error(err);
  toast(`Erro ao iniciar: ${err.message}`, 'error');
});
