// Provider simulado: permite experimentar todo o fluxo (ligar, desligar, exercício, relatório)
// sem tocar em nenhuma conta AWS. Também alimenta os endpoints /demo/* usados nos testes de exemplo.
import { sleep } from '../util.js';

const sims = new Map(); // envId -> estado em memória

export function getSim(envId, cfg = {}) {
  let s = sims.get(envId);
  if (!s) {
    s = { state: 'running', appReadyAt: 0, appDownAt: 0, frozenDurableAt: 0, cfg };
    sims.set(envId, s);
  }
  s.cfg = { ...s.cfg, ...cfg };
  return s;
}

export function dropSim(envId) {
  sims.delete(envId);
}

export function simAppUp(s, now = Date.now()) {
  if (s.state === 'running') return now >= s.appReadyAt;
  if (s.state === 'stopping') return now < s.appDownAt;
  return false;
}

/** Último "dado durável" visível: acompanha o relógio com um atraso fixo enquanto ligado. */
export function simLastDurable(s, now = Date.now()) {
  const lag = (s.cfg.replicationLagSeconds ?? 5) * 1000;
  if (s.state === 'running') return now - lag;
  return s.frozenDurableAt || now - lag;
}

export function createSimulatedProvider(env) {
  const sim = getSim(env.id, env.simulated);
  const groups = [
    { name: 'ng-apps', min: 1, max: 6, desired: 3, instanceTypes: ['m6i.large'], capacityType: 'ON_DEMAND' },
    { name: 'ng-system', min: 1, max: 3, desired: 2, instanceTypes: ['t3.medium'], capacityType: 'ON_DEMAND' },
  ];
  const totalNodes = groups.reduce((n, g) => n + g.desired, 0);

  return {
    kind: 'simulated',
    label: 'Simulado (sem AWS)',

    async status() {
      sim.cfg = env.simulated;
      const running = sim.state === 'running';
      const transitioning = sim.state === 'starting' || sim.state === 'stopping';
      return {
        state: transitioning ? 'transitioning' : running ? 'running' : 'stopped',
        cluster: { name: 'cluster-simulado', status: 'ACTIVE', version: '1.31 (simulado)' },
        nodegroups: groups.map((g) => ({
          ...g,
          status: transitioning ? 'UPDATING' : 'ACTIVE',
          desired: running ? g.desired : 0,
          min: running ? g.min : 0,
          issues: [],
        })),
        nodes: { ready: running ? totalNodes : 0, total: running ? totalNodes : 0 },
      };
    },

    async stop({ log, signal }) {
      sim.cfg = env.simulated;
      if (sim.state === 'stopped') return log('info', 'Ambiente já estava desligado (nada a fazer).');
      if (sim.state === 'running') sim.frozenDurableAt = Date.now() - sim.cfg.replicationLagSeconds * 1000;
      sim.state = 'stopping';
      sim.appDownAt = Date.now() + 1500;
      log('info', 'Escalando node groups para zero (simulado)…');
      try {
        const steps = Math.max(1, sim.cfg.stopSeconds);
        for (let i = 1; i <= steps; i++) {
          await sleep(1000, signal);
          const left = Math.max(0, Math.round(totalNodes * (1 - i / steps)));
          log('info', `Drenando nós… ${left}/${totalNodes} restantes`);
        }
      } finally {
        sim.state = 'stopped';
      }
      log('ok', 'Todos os nós foram encerrados.');
    },

    async start({ log, signal }) {
      sim.cfg = env.simulated;
      if (sim.state === 'running') return log('info', 'Ambiente já estava ligado (nada a fazer).');
      sim.state = 'starting';
      log('info', 'Restaurando escala dos node groups (simulado)…');
      let ok = false;
      try {
        const steps = Math.max(1, sim.cfg.startSeconds);
        for (let i = 1; i <= steps; i++) {
          await sleep(1000, signal);
          log('info', `Nós Ready: ${Math.round((totalNodes * i) / steps)}/${totalNodes}`);
        }
        ok = true;
      } finally {
        if (ok) {
          sim.state = 'running';
          sim.appReadyAt = Date.now() + sim.cfg.warmupSeconds * 1000;
        } else sim.state = 'stopped';
      }
      log('ok', `Nós prontos. Aplicações aquecendo por ~${sim.cfg.warmupSeconds}s.`);
    },

    /** Teste do tipo k8s sem cluster real. */
    async k8sCheck(check) {
      const up = simAppUp(sim);
      return { ok: up, detail: up ? 'prontas 2/2 (simulado)' : 'sem réplicas prontas (simulado)' };
    },

    async kube() {
      return null;
    },
  };
}
