// Persistência em arquivos JSON (escrita atômica). Sem banco de dados externo.
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, readJson, writeJsonAtomic } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function assertId(id) {
  if (!ID_RE.test(String(id))) throw new HttpError(400, 'Identificador inválido');
  return String(id);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.envFile = join(dir, 'environments.json');
    this.stateDir = join(dir, 'state');
    this.runsDir = join(dir, 'runs');
    this.kubeDir = join(dir, 'kubeconfig');
    this.inflightDir = join(dir, 'inflight');
    this._writeChain = Promise.resolve();
  }

  async init() {
    await Promise.all([this.dir, this.stateDir, this.runsDir, this.kubeDir, this.inflightDir].map((d) => mkdir(d, { recursive: true, mode: 0o700 })));
  }

  // serializa gravações para evitar corridas entre requisições
  _serial(fn) {
    const next = this._writeChain.then(fn, fn);
    this._writeChain = next.catch(() => {});
    return next;
  }

  // ---------- ambientes ----------
  async listEnvironments() {
    const data = await readJson(this.envFile, { environments: [] });
    return data.environments ?? [];
  }

  async getEnvironment(id) {
    const env = (await this.listEnvironments()).find((e) => e.id === id);
    if (!env) throw new HttpError(404, 'Ambiente não encontrado');
    return env;
  }

  saveEnvironment(env) {
    return this._serial(async () => {
      const list = await this.listEnvironments();
      const idx = list.findIndex((e) => e.id === env.id);
      if (idx >= 0) list[idx] = env;
      else list.push(env);
      await writeJsonAtomic(this.envFile, { environments: list });
      return env;
    });
  }

  /**
   * Lê-modifica-grava UM ambiente dentro da fila de escrita (sem lost update entre PUTs concorrentes).
   * `mutator(existing)` devolve o novo ambiente (ou lança para abortar).
   */
  updateEnvironment(id, mutator) {
    return this._serial(async () => {
      const list = await this.listEnvironments();
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) throw new HttpError(404, 'Ambiente não encontrado');
      const env = await mutator(list[idx]);
      list[idx] = env;
      await writeJsonAtomic(this.envFile, { environments: list });
      return env;
    });
  }

  /**
   * Remove o ambiente e seus arquivos auxiliares (snapshot de escala, kubeconfig — pode conter credenciais — e marcador de operação).
   * As execuções (relatórios) são MANTIDAS: são histórico de auditoria e carregam o nome do ambiente.
   */
  deleteEnvironment(id) {
    return this._serial(async () => {
      assertId(id);
      const list = await this.listEnvironments();
      if (!list.some((e) => e.id === id)) throw new HttpError(404, 'Ambiente não encontrado');
      await writeJsonAtomic(this.envFile, { environments: list.filter((e) => e.id !== id) });
      await Promise.all([join(this.stateDir, `${id}.json`), this.kubeconfigPath(id), join(this.inflightDir, `${id}.json`)].map((f) => rm(f, { force: true })));
    });
  }

  // ---------- marcador de operação em andamento (sobrevive a crash do processo) ----------
  markInflight(envId, info) {
    return this._serial(() => writeJsonAtomic(join(this.inflightDir, `${assertId(envId)}.json`), { envId, ...info }));
  }

  clearInflight(envId) {
    return this._serial(() => rm(join(this.inflightDir, `${assertId(envId)}.json`), { force: true }));
  }

  async getInflight(envId) {
    return readJson(join(this.inflightDir, `${assertId(envId)}.json`), null);
  }

  async listInflight() {
    let files = [];
    try {
      files = (await readdir(this.inflightDir)).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const out = [];
    for (const f of files) {
      const m = await readJson(join(this.inflightDir, f), null).catch(() => null);
      if (m) out.push(m);
    }
    return out;
  }

  // ---------- snapshot de escala (necessário para religar) ----------
  async getState(envId) {
    return readJson(join(this.stateDir, `${assertId(envId)}.json`), {});
  }

  setState(envId, state) {
    return this._serial(() => writeJsonAtomic(join(this.stateDir, `${assertId(envId)}.json`), state));
  }

  /** Lê-modifica-grava o estado dentro da fila de escrita (seguro para operações em paralelo). */
  updateState(envId, mutator) {
    return this._serial(async () => {
      const file = join(this.stateDir, `${assertId(envId)}.json`);
      const state = await readJson(file, {});
      const out = (await mutator(state)) ?? state;
      await writeJsonAtomic(file, out);
      return out;
    });
  }

  kubeconfigPath(envId) {
    return join(this.kubeDir, `${assertId(envId)}.yaml`);
  }

  // ---------- execuções (exercícios e operações) ----------
  async saveRun(run) {
    assertId(run.id);
    await this._serial(() => writeJsonAtomic(join(this.runsDir, `${run.id}.json`), run));
    return run;
  }

  async getRun(id) {
    const run = await readJson(join(this.runsDir, `${assertId(id)}.json`), null);
    if (!run) throw new HttpError(404, 'Execução não encontrada');
    return run;
  }

  async deleteRun(id) {
    await this.getRun(id);
    await this._serial(() => rm(join(this.runsDir, `${assertId(id)}.json`), { force: true }));
  }

  /** Lista execuções (mais recentes primeiro), sem os campos pesados. */
  async listRuns({ envId, full = false } = {}) {
    let files = [];
    try {
      files = (await readdir(this.runsDir)).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const runs = [];
    for (const f of files) {
      try {
        const run = JSON.parse(await readFile(join(this.runsDir, f), 'utf8'));
        if (envId && run.envId !== envId) continue;
        runs.push(full ? run : slim(run));
      } catch {
        /* arquivo corrompido é ignorado */
      }
    }
    runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return runs;
  }
}

function slim(run) {
  const { samples, events, checks, ...rest } = run;
  return { ...rest, sampleCount: samples?.length ?? 0 };
}
