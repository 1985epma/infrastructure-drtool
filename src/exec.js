// Execução de processos externos (aws, kubectl, comandos customizados) SEM shell.
import { spawn } from 'node:child_process';
import { AbortedError } from './util.js';

const MAX_CAPTURE = 1024 * 1024; // 1 MiB por stream
const MAX_LINE = 64 * 1024; // linha sem \n acima disso é emitida em pedaços (evita crescimento ilimitado)

/**
 * Executa `cmd` com `args` (argv, nunca interpretado por shell).
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ms:number}>}
 */
export function run(cmd, args = [], opts = {}) {
  const { env, cwd, timeoutMs = 120_000, signal, onLine, input } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        shell: false,
        stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const pending = { out: '', err: '' };

    const feed = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < MAX_CAPTURE) stdout += text;
      } else if (stderr.length < MAX_CAPTURE) stderr += text;
      if (onLine) {
        pending[which] += text;
        let idx;
        while ((idx = pending[which].indexOf('\n')) >= 0) {
          const line = pending[which].slice(0, idx).replace(/\r$/, '');
          pending[which] = pending[which].slice(idx + 1);
          if (line.trim()) onLine(line, which === 'out' ? 'stdout' : 'stderr');
        }
        while (pending[which].length > MAX_LINE) {
          onLine(pending[which].slice(0, MAX_LINE), which === 'out' ? 'stdout' : 'stderr');
          pending[which] = pending[which].slice(MAX_LINE);
        }
      }
    };
    child.stdout.on('data', (c) => feed('out', c));
    child.stderr.on('data', (c) => feed('err', c));

    const kill = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onLine) {
        for (const w of ['out', 'err']) {
          if (pending[w].trim()) onLine(pending[w].replace(/\r$/, ''), w === 'out' ? 'stdout' : 'stderr');
        }
      }
      fn();
    };

    child.on('error', (err) =>
      finish(() => {
        if (err.code === 'ENOENT') {
          const e = new Error(`Comando "${cmd}" não encontrado no PATH`);
          e.code = 'ENOENT';
          reject(e);
        } else reject(err);
      }),
    );
    child.on('close', (code) =>
      finish(() => {
        if (aborted) return reject(new AbortedError());
        if (timedOut) {
          const e = new Error(`Comando "${cmd}" excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s`);
          e.code = 'TIMEOUT';
          return reject(e);
        }
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      }),
    );
    if (input != null) child.stdin.end(input);
  });
}

/** Verifica se um binário existe e retorna a versão (best-effort). */
export async function probeTool(cmd, args) {
  try {
    const r = await run(cmd, args, { timeoutMs: 10_000 });
    const text = (r.stdout || r.stderr).trim().split('\n')[0];
    return { ok: r.code === 0 || Boolean(text), version: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
