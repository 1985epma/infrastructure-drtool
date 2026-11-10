// Provider Kubernetes via kubectl (Docker Desktop, kind, minikube, qualquer contexto).
//
// Não dá para "desligar" o nó de um cluster local sem quebrar a ferramenta que o gerencia; então
// "Desligar" = zerar as réplicas dos Deployments/StatefulSets escolhidos (guardando os valores
// originais em disco) e "Ligar" = restaurar esses valores e aguardar as réplicas ficarem prontas.
import { run } from '../exec.js';
import { nowIso, waitFor } from '../util.js';

const POLL_MS = Number(process.env.EPMA_POLL_MS) || 2000;
const keyOf = (w) => `${w.namespace}/${w.kind}/${w.name}`;

export function createK8sProvider(env, { store }) {
  const cfg = env.k8s;
  const baseArgs = () => [...(cfg.kubeconfig ? ['--kubeconfig', cfg.kubeconfig] : []), '--context', cfg.context];

  async function kubectl(args, { signal, timeoutMs = 60_000 } = {}) {
    const r = await run('kubectl', [...baseArgs(), '--request-timeout=20s', ...args], { signal, timeoutMs });
    if (r.code !== 0) {
      const msg = r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400) || `kubectl saiu com código ${r.code}`;
      const err = new Error(msg);
      if (/NotFound/i.test(r.stderr)) err.code = 'NOT_FOUND';
      throw err;
    }
    return r.stdout;
  }

  async function read(w, signal) {
    const o = JSON.parse(await kubectl(['get', w.kind, w.name, '-n', w.namespace, '-o', 'json'], { signal }));
    return { desired: o.spec?.replicas ?? 0, ready: o.status?.readyReplicas ?? 0, current: o.status?.replicas ?? 0 };
  }

  const scale = (w, n, signal) => kubectl(['scale', `${w.kind}/${w.name}`, '-n', w.namespace, `--replicas=${n}`], { signal });

  return {
    kind: 'k8s',
    label: 'Kubernetes (kubectl)',

    async status({ signal } = {}) {
      const items = await Promise.all(
        cfg.workloads.map(async (w) => {
          try {
            return { ...w, ...(await read(w, signal)) };
          } catch (err) {
            if (err.name === 'AbortedError') throw err;
            return { ...w, error: err.message, missing: err.code === 'NOT_FOUND' };
          }
        }),
      );
      const errs = items.filter((i) => i.error);
      const ok = items.filter((i) => !i.error);
      const snap = (await store.getState(env.id)).k8s;
      let state;
      let note;
      if (errs.length) {
        state = 'error';
        note = errs.length === items.length ? `Não foi possível consultar o cluster (${cfg.context}): ${errs[0].error}` : `${errs.length} workload(s) com erro: ${errs.map((e) => `${keyOf(e)} (${e.missing ? 'não encontrado' : e.error})`).join('; ')}`;
      } else {
        const stopped = ok.filter((i) => i.desired === 0).length;
        const starting = ok.filter((i) => i.desired > 0 && i.ready < i.desired).length;
        const ready = ok.filter((i) => i.desired > 0 && i.ready >= i.desired).length;
        state = starting ? 'transitioning' : stopped === ok.length ? 'stopped' : ready === ok.length ? 'running' : 'partial';
      }
      return {
        state,
        note,
        cluster: { name: cfg.context },
        workloads: items.map(({ namespace, kind, name, desired, ready, error }) => ({ namespace, kind, name, desired, ready, error })),
        saved: snap?.savedAt ? { savedAt: snap.savedAt, workloads: Object.keys(snap.replicas ?? {}).length } : null,
      };
    },

    async stop(ctx) {
      ctx.log('info', `Lendo ${cfg.workloads.length} workload(s) no contexto ${cfg.context}…`);
      const cur = await Promise.all(cfg.workloads.map(async (w) => ({ w, ...(await read(w, ctx.signal)) })));
      // grava as réplicas originais ANTES de zerar; nunca sobrescreve um valor válido com zero
      await store.updateState(env.id, (s) => {
        s.k8s ??= { replicas: {} };
        for (const c of cur) if (c.desired > 0) s.k8s.replicas[keyOf(c.w)] = c.desired;
        s.k8s.savedAt = nowIso();
        return s;
      });
      ctx.log('ok', `Escala original salva (${cur.filter((c) => c.desired > 0).map((c) => `${c.w.name}=${c.desired}`).join(', ') || 'nada a salvar'}).`);
      await Promise.all(
        cur.map(async (c) => {
          if (c.desired === 0) return ctx.log('info', `${keyOf(c.w)} já está em 0.`);
          await scale(c.w, 0, ctx.signal);
          ctx.log('info', `${keyOf(c.w)} → 0 (era ${c.desired})`);
        }),
      );
      let last = '';
      await waitFor(
        async () => {
          const now = await Promise.all(cfg.workloads.map((w) => read(w, ctx.signal)));
          const left = now.reduce((n, x) => n + x.current, 0);
          if (String(left) !== last) ctx.log('info', `Réplicas restantes: ${left}`);
          last = String(left);
          return left === 0;
        },
        { timeoutMs: cfg.timeoutSec * 1000, intervalMs: POLL_MS, signal: ctx.signal, label: 'réplicas encerradas' },
      );
      ctx.log('ok', 'Workloads desligados (0 réplicas).');
    },

    async start(ctx) {
      const saved = (await store.getState(env.id)).k8s?.replicas ?? {};
      ctx.log('info', `Restaurando ${cfg.workloads.length} workload(s) no contexto ${cfg.context}…`);
      await Promise.all(
        cfg.workloads.map(async (w) => {
          const cur = await read(w, ctx.signal);
          if (cur.desired > 0) return ctx.log('info', `${keyOf(w)} já está com ${cur.desired} réplica(s).`);
          const target = saved[keyOf(w)] ?? 1;
          if (saved[keyOf(w)] == null) ctx.log('warn', `${keyOf(w)}: sem escala salva — usando ${target} réplica.`);
          await scale(w, target, ctx.signal);
          ctx.log('info', `${keyOf(w)} → ${target}`);
        }),
      );
      let last = '';
      await waitFor(
        async () => {
          const now = await Promise.all(cfg.workloads.map((w) => read(w, ctx.signal)));
          const txt = now.map((x, i) => `${cfg.workloads[i].name} ${x.ready}/${x.desired}`).join(' · ');
          if (txt !== last) ctx.log('info', txt);
          last = txt;
          return now.every((x) => x.desired > 0 && x.ready >= x.desired);
        },
        { timeoutMs: cfg.timeoutSec * 1000, intervalMs: POLL_MS, signal: ctx.signal, label: 'réplicas prontas' },
      );
      ctx.log('ok', 'Workloads religados e prontos.');
    },

    async kube() {
      return { args: baseArgs(), env: {} };
    },
  };
}
