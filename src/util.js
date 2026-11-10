// Utilitários gerais, sem dependências externas.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Erro com status HTTP, usado pela camada de API. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Erro de uso/negócio (mensagem segura para exibir ao usuário). */
export class UserError extends Error {}

export class AbortedError extends Error {
  constructor(message = 'Operação cancelada') {
    super(message);
    this.name = 'AbortedError';
  }
}

export const nowIso = () => new Date().toISOString();

export function uid(prefix = '') {
  return prefix + randomBytes(4).toString('hex');
}

export function runId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Dorme `ms` milissegundos; rejeita com AbortedError se o signal abortar. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Repete `fn` até retornar um valor truthy, respeitando timeout e abort.
 * Retorna o valor, ou lança Error('timeout') ao estourar o tempo.
 */
export async function waitFor(fn, { timeoutMs, intervalMs = 1000, signal, label = 'condição' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new AbortedError();
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) {
      const err = new Error(`Tempo esgotado aguardando ${label} (${Math.round(timeoutMs / 1000)}s)`);
      err.code = 'TIMEOUT';
      throw err;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/**
 * Divide uma linha de comando em argv, sem usar shell.
 * Suporta aspas simples/duplas e escape com barra invertida.
 */
export function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (quote) throw new UserError('Comando com aspas não fechadas');
  if (cur || has) out.push(cur);
  return out;
}

/** Acessa `a.b[0].c` em um objeto. */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Converte ISO-8601, epoch em segundos ou em milissegundos para Date (ou null). */
export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  let v = value;
  if (typeof v === 'string') {
    v = v.trim();
    if (/^\d+(\.\d+)?$/.test(v)) v = Number(v);
  }
  let d;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    d = new Date(v < 1e11 ? v * 1000 : v);
  } else {
    d = new Date(v);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Escrita atômica (arquivo temporário + rename). */
export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
