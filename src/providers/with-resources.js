// Compõe um provider base (EKS, comandos, nenhum) com recursos AWS (EC2/RDS/ElastiCache).
//
// Ordem ao DESLIGAR: aplicação primeiro (base k8s → EC2), depois a camada de dados (RDS ‖ ElastiCache).
// Ordem ao LIGAR:    dados primeiro (RDS ‖ ElastiCache), depois EC2 e por último o base k8s.
import { createResources } from './aws-resources.js';

/** Base "vazio" para o provider 'aws' (somente recursos). */
export function createNoopProvider() {
  return {
    kind: 'noop',
    label: 'Recursos AWS',
    async status() {
      return { state: null };
    },
    async stop() {},
    async start() {},
    async kube() {
      return null;
    },
  };
}

/** Combina estados individuais em um único estado do ambiente. */
export function combineStates(states) {
  const s = states.filter((x) => x && x !== 'ignored');
  if (!s.length) return 'unknown';
  if (s.includes('error') || s.includes('missing')) return 'error';
  if (s.includes('transitioning')) return 'transitioning';
  const known = s.filter((x) => x !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.every((x) => x === 'running')) return 'running';
  if (known.every((x) => x === 'stopped')) return 'stopped';
  return 'partial';
}

export function withResources(base, env, deps) {
  const res = createResources(env, deps);
  const noop = base.kind === 'noop';
  return {
    ...base,
    kind: noop ? 'aws' : `${base.kind}+aws`,
    label: noop ? 'Recursos AWS (EC2/RDS/ElastiCache)' : `${base.label} + recursos AWS`,

    async status(opts = {}) {
      const [b, items] = await Promise.all([base.status(opts), res.describe(opts.signal)]);
      const counted = items.filter((i) => !i.ignored);
      const notes = [b.note];
      const bad = counted.filter((i) => ['error', 'missing'].includes(i.state));
      if (bad.length) notes.push(`${bad.length} recurso(s) com problema: ${bad.map((i) => `${i.id} (${i.detail})`).join('; ')}`);
      return {
        ...b,
        state: combineStates([noop ? null : b.state, ...counted.map((i) => i.state)]),
        note: notes.filter(Boolean).join(' · ') || undefined,
        resources: items,
      };
    },

    async stop(ctx) {
      if (!noop) await base.stop(ctx);
      await res.stopApp(ctx);
      if (res.hasData) {
        ctx.log('info', 'Desligando a camada de dados (RDS / ElastiCache)…');
        await res.stopData(ctx);
      }
    },

    async start(ctx) {
      if (res.hasData) {
        ctx.log('info', 'Ligando a camada de dados (RDS / ElastiCache)…');
        await res.startData(ctx);
      }
      await res.startApp(ctx);
      if (!noop) await base.start(ctx);
    },

    k8sCheck: base.k8sCheck?.bind(base),
    kube: base.kube?.bind(base),
  };
}
