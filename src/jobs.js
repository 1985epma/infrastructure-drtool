// Gerenciador de operações de longa duração (ligar, desligar, exercício).
// Apenas UMA operação por vez em todo o processo — evita corridas sobre o mesmo cluster.
import { AbortedError, HttpError, nowIso, runId } from './util.js';

const MAX_EVENTS = 5000;

export class JobManager {
  constructor() {
    this.current = null;
  }

  get running() {
    return this.current?.status === 'running';
  }

  start({ kind, env, title }, fn) {
    if (this.running) throw new HttpError(409, `Já existe uma operação em andamento: ${this.current.title}`);
    const controller = new AbortController();
    const job = {
      id: runId(),
      kind,
      envId: env.id,
      envName: env.name,
      title,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      events: [],
      live: { phase: null },
      result: null,
      error: null,
      controller,
    };
    job.log = (level, msg) => {
      if (job.events.length < MAX_EVENTS) job.events.push({ t: Date.now(), level, msg: String(msg) });
    };
    this.current = job;
    job.promise = (async () => {
      try {
        job.result = await fn(job, controller.signal);
        job.status = 'succeeded';
      } catch (err) {
        if (err instanceof AbortedError || err.name === 'AbortedError') {
          job.status = 'cancelled';
          job.error = 'Cancelado pelo usuário';
        } else {
          job.status = 'failed';
          job.error = err.message;
          job.log('error', err.message);
        }
      } finally {
        job.finishedAt = nowIso();
      }
    })();
    return job;
  }

  cancel() {
    if (!this.running) throw new HttpError(409, 'Nenhuma operação em andamento');
    this.current.log('warn', 'Cancelamento solicitado…');
    this.current.controller.abort();
  }

  /** Visão pública do job (eventos a partir de `since`). */
  snapshot(since = 0) {
    const j = this.current;
    if (!j) return null;
    return {
      id: j.id,
      kind: j.kind,
      envId: j.envId,
      envName: j.envName,
      title: j.title,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      error: j.error,
      live: j.live,
      result: j.result,
      events: j.events.slice(since),
      next: j.events.length,
    };
  }
}
