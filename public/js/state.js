// Estado compartilhado + barramento de eventos simples.
import { api, download } from './api.js';
import { fmtDur, sleep, toast } from './dom.js';

export const state = {
  meta: null,
  envs: [],
  envId: null,
  status: null,
  statusAt: 0,
  statusLoading: false,
  job: null,
  jobId: null,
  jobSince: 0,
  jobLog: [],
  runs: [],
  results: {}, // envId -> { checkId -> resultado }
};
try {
  state.envId = localStorage.getItem('eksdr-env');
} catch {
  /* ignora */
}

const bus = new EventTarget();
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const currentEnv = () => state.envs.find((e) => e.id === state.envId) ?? state.envs[0] ?? null;
export const jobRunning = () => state.job?.status === 'running';

export async function loadEnvs() {
  state.envs = await api('/environments');
  const env = currentEnv();
  state.envId = env?.id ?? null;
  emit('envs');
}

export function selectEnv(id) {
  if (id === state.envId) return;
  state.envId = id;
  state.status = null;
  try {
    localStorage.setItem('eksdr-env', id);
  } catch {
    /* ignora */
  }
  emit('env');
  refreshStatus(true);
  loadRuns();
}

export async function refreshStatus(force = false) {
  const env = currentEnv();
  if (!env || state.statusLoading) return;
  state.statusLoading = true;
  emit('status-loading');
  try {
    const st = await api(`/environments/${env.id}/status${force ? '?force=1' : ''}`);
    if (env.id === state.envId) {
      state.status = st;
      state.statusAt = Date.now();
    }
  } catch (err) {
    state.status = { state: 'error', note: err.message };
  } finally {
    state.statusLoading = false;
    emit('status');
  }
}

export async function loadRuns() {
  const env = currentEnv();
  if (!env) return;
  try {
    state.runs = await api(`/runs?envId=${encodeURIComponent(env.id)}`);
    emit('runs');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function runChecks(checkId) {
  const env = currentEnv();
  if (!env) return [];
  const body = checkId ? { checkId } : {};
  const { results } = await api(`/environments/${env.id}/checks/run`, { method: 'POST', body });
  const map = (state.results[env.id] ??= {});
  for (const r of results) map[r.id] = { ...r, at: Date.now() };
  emit('checks');
  return results;
}

export async function saveEnv(env) {
  const saved = await api(`/environments/${env.id}`, { method: 'PUT', body: env });
  const i = state.envs.findIndex((e) => e.id === saved.id);
  if (i >= 0) state.envs[i] = saved;
  emit('envs');
  return saved;
}

export async function startJob(kind, body = {}) {
  const env = currentEnv();
  const res = await api(`/environments/${env.id}/${kind}`, { method: 'POST', body });
  state.jobId = res.jobId;
  seenRunning.add(res.jobId);
  state.jobSince = 0;
  state.jobLog = [];
  state.job = { id: res.jobId, status: 'running', kind, envId: env.id, title: '…', live: {}, events: [] };
  emit('job');
  pollJob();
}

let polling = false;
let notified = null;
const seenRunning = new Set();

/** Consulta o job atual enquanto estiver em execução (1 req/s). */
export async function pollJob() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      let j;
      try {
        j = await api(`/job?since=${state.jobSince}`);
      } catch (err) {
        await sleep(2000);
        continue;
      }
      if (j.status === 'idle') {
        state.job = null;
        emit('job');
        break;
      }
      if (j.id !== state.jobId) {
        state.jobId = j.id;
        state.jobLog = [];
        if (state.jobSince !== 0) {
          state.jobSince = 0;
          continue;
        }
      }
      state.jobLog.push(...j.events);
      state.jobSince = j.next;
      state.job = j;
      emit('job');
      if (j.status === 'running') seenRunning.add(j.id);
      if (j.status !== 'running') {
        // avisa/abre o relatório só se o job terminou enquanto acompanhávamos (não ao recarregar a página)
        if (seenRunning.has(j.id) && notified !== j.id) {
          notified = j.id;
          const label = { stop: 'Desligamento', start: 'Religamento', drill: 'Exercício' }[j.kind] ?? 'Operação';
          if (j.status === 'succeeded') toast(`${label} concluído.`, 'ok');
          else if (j.status === 'cancelled') toast(`${label} cancelado.`, 'warn');
          else toast(`${label} falhou: ${j.error ?? ''}`, 'error');
          emit('job-finished', j);
          autoReport(j);
          refreshStatus(true);
          loadRuns();
        }
        break;
      }
      await sleep(1000);
    }
  } finally {
    polling = false;
  }
}

export const elapsedSince = (iso) => fmtDur((Date.now() - new Date(iso).getTime()) / 1000);

/** Ao terminar um exercício: abre o relatório (e opcionalmente baixa o HTML). O servidor já gerou e salvou o relatório. */
function autoReport(j) {
  const runId = j.kind === 'drill' ? j.live?.runId : null;
  if (!runId) return;
  let open = true;
  let dl = false;
  try {
    open = localStorage.getItem('eksdr-autoreport') !== '0';
    dl = localStorage.getItem('eksdr-autodownload') === '1';
  } catch {
    /* ignora */
  }
  if (dl) download(`/runs/${encodeURIComponent(runId)}/report.html?download=1`, `relatorio-drill-${runId}.html`).catch(() => {});
  if (open) {
    toast('Relatório gerado — abrindo…', 'ok');
    location.hash = `#/relatorios?run=${encodeURIComponent(runId)}`;
  }
}
