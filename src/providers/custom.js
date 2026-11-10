// Provider por comandos: o usuário informa os comandos de ligar/desligar (terraform, eksctl,
// scripts…). Os comandos são executados sem shell (argv), com a saída transmitida ao console.
import { run } from '../exec.js';
import { tokenize } from '../util.js';

const STATES = ['running', 'stopped', 'partial', 'transitioning'];

export function createCustomProvider(env) {
  const cfg = env.custom;

  async function exec(line, ctx, timeoutMs = cfg.timeoutSec * 1000) {
    const argv = tokenize(line);
    ctx.log('info', `$ ${line}`);
    const r = await run(argv[0], argv.slice(1), {
      cwd: cfg.cwd || undefined,
      timeoutMs,
      signal: ctx.signal,
      onLine: (l, stream) => ctx.log(stream === 'stderr' ? 'warn' : 'info', l),
    });
    if (r.code !== 0) throw new Error(`Comando falhou com código ${r.code}: ${line}`);
    return r;
  }

  return {
    kind: 'custom',
    label: 'Comandos customizados',

    async status({ signal } = {}) {
      if (!cfg.statusCommand) {
        return { state: 'unknown', note: 'Nenhum comando de status configurado — o estado não é monitorado.' };
      }
      const argv = tokenize(cfg.statusCommand);
      try {
        const r = await run(argv[0], argv.slice(1), { cwd: cfg.cwd || undefined, timeoutMs: 60_000, signal });
        const last = r.stdout.trim().split('\n').pop()?.trim().toLowerCase() ?? '';
        const state = STATES.find((s) => last.includes(s));
        if (r.code !== 0) return { state: 'unknown', note: `Comando de status saiu com código ${r.code}` };
        return { state: state ?? 'unknown', note: state ? undefined : `Saída não reconhecida: "${last.slice(0, 80)}" (esperado: ${STATES.join(' | ')})` };
      } catch (err) {
        if (err.name === 'AbortedError') throw err;
        return { state: 'unknown', note: err.message };
      }
    },

    async stop(ctx) {
      await exec(cfg.stopCommand, ctx);
      ctx.log('ok', 'Comando de desligamento concluído.');
    },

    async start(ctx) {
      await exec(cfg.startCommand, ctx);
      ctx.log('ok', 'Comando de religamento concluído.');
    },

    async kube() {
      const args = [];
      if (cfg.kubeconfig) args.push('--kubeconfig', cfg.kubeconfig);
      if (cfg.kubeContext) args.push('--context', cfg.kubeContext);
      return { args, env: {} };
    },
  };
}
