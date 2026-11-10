// Orquestrador do exercício de RTO/RPO e das operações manuais de ligar/desligar.
//
// Linha do tempo de um exercício:
//   baseline ─► falha (desliga) ─► detecção ─► acionamento (espera) ─► recuperação (liga)
//            ─► aplicações saudáveis (RTO) ─► leitura de RPO ─► relatório
import { allCriticalOk, runChecks, waitHealthy } from './checks.js';
import { canaryWrite, computeCanaryRpoSeconds, computeRpoSeconds, readLastData } from './rpo.js';
import { AbortedError, UserError, nowIso, sleep, waitFor } from './util.js';

const PHASES = {
  preflight: 'Pré-verificações',
  baseline: 'Linha de base',
  failure: 'Falha injetada (desligando)',
  hold: 'Acionamento da recuperação',
  recovery: 'Recuperação (religando)',
  validate: 'Aguardando aplicações saudáveis',
  rpo: 'Medição de RPO',
  finalize: 'Consolidando relatório',
};

const envSnapshot = (env) => ({
  name: env.name,
  provider: env.provider,
  clusterName: env.provider === 'eks' ? env.eks.clusterName : env.provider === 'k8s' ? env.k8s.context : undefined,
  region: env.provider === 'eks' ? env.eks.region : undefined,
  nodegroups: env.provider === 'eks' ? env.eks.nodegroups : undefined,
  scaleWorkloads: env.provider === 'eks' ? env.eks.scaleWorkloads : undefined,
  rpoSourceType: env.rpoSource?.type,
  resources: env.resources
    ? {
        ec2: env.resources.ec2.instanceIds.length + (env.resources.ec2.tagKey ? 1 : 0),
        rds: env.resources.rds.instances.length + env.resources.rds.clusters.length,
        elasticache: env.resources.elasticache.replicationGroups.length + env.resources.elasticache.serverlessCaches.length,
      }
    : undefined,
});

const checkMeta = (checks) => checks.map(({ id, name, type, critical }) => ({ id, name, type, critical }));

/** Segundos entre dois instantes (ms) ou null. */
const secs = (a, b) => (a != null && b != null ? Math.max(0, (b - a) / 1000) : null);

export async function runDrill({ env, provider, store, origin, params }, job, signal) {
  const log = job.log;
  const checks = env.checks;
  if (!checks.length) throw new UserError('Cadastre ao menos um teste de aplicação (página Testes) antes de executar um exercício.');
  const critIdx = checks.map((c, i) => (c.critical ? i : -1)).filter((i) => i >= 0);
  if (!critIdx.length) throw new UserError('Marque ao menos um teste como crítico: é ele que define quando o serviço está disponível.');

  const startedAt = Date.now();
  const ts = {};
  const samples = [];
  const warnings = [];
  const intervalMs = params.probeIntervalSeconds * 1000;
  const ctx = { origin, provider, signal };
  const opCtx = { log, signal };
  const probeAbort = new AbortController();
  let failureInjected = false;
  let recoveryDone = false;
  let status = 'completed';
  let errorMessage = null;
  let rpoInfo = { source: env.rpoSource?.type ?? 'none', before: null, after: null, error: null };
  let baseline = null;
  let finalChecks = null;
  let caught = null;

  const setPhase = (key) => {
    job.live.phase = key;
    job.live.phaseLabel = PHASES[key];
    log('info', `▶ ${PHASES[key]}`);
  };
  job.live = { phase: null, startedAt, checks: checkMeta(checks), samples: [], params };

  // ---------- prober contínuo ----------
  const prober = (async () => {
    while (!probeAbort.signal.aborted) {
      const t0 = Date.now();
      let results;
      try {
        results = await runChecks(env, { ...ctx, signal: probeAbort.signal });
      } catch {
        break;
      }
      const s = { t: t0, ok: allCriticalOk(results), r: results.map((r) => (r.ok ? 1 : 0)), l: results.map((r) => Math.round(r.ms)) };
      samples.push(s);
      job.live.samples = samples.slice(-150);
      job.live.upNow = s.ok;
      const wait = intervalMs - (Date.now() - t0);
      if (wait > 0) await sleep(wait, probeAbort.signal).catch(() => {});
    }
  })();

  // ---------- canário de gravação (RPO) ----------
  const canarySrc = env.rpoSource?.type === 'canary' ? env.rpoSource : null;
  const canary = { lastAcked: null, ok: 0, fail: 0, stop: false, loop: null };
  const startCanary = () => {
    canary.loop = (async () => {
      while (!canary.stop && !signal.aborted) {
        const t0 = Date.now();
        try {
          canary.lastAcked = await canaryWrite(canarySrc, { signal });
          if (++canary.ok === 1) log('ok', `Canário: primeira gravação confirmada (${canary.lastAcked.toISOString()}).`);
        } catch (err) {
          if (err.name === 'AbortedError') break;
          if (++canary.fail <= 3) log('warn', `Canário: falha ao gravar — ${err.message}`);
        }
        const wait = canarySrc.intervalSeconds * 1000 - (Date.now() - t0);
        if (wait > 0 && !canary.stop) await sleep(wait, signal).catch(() => {});
      }
    })();
  };
  const stopCanary = async () => {
    canary.stop = true;
    await canary.loop;
  };

  const firstFailureAfter = (t) => samples.find((s) => s.t >= t && !s.ok);
  const findRestored = () => {
    if (ts.detectedAt == null) return null;
    let streak = 0;
    let start = null;
    for (const s of samples) {
      if (s.t <= ts.detectedAt) continue;
      if (s.ok) {
        if (streak === 0) start = s.t;
        if (++streak >= params.stableProbes) return start;
      } else {
        streak = 0;
        start = null;
      }
    }
    return null;
  };

  try {
    // ---------- 1. pré-verificações ----------
    setPhase('preflight');
    const st = await provider.status({ signal });
    if (st.state !== 'running') {
      throw new UserError(`O ambiente precisa estar ligado para iniciar o exercício (estado atual: ${st.state}). Ligue-o e confirme que os testes passam.`);
    }
    log('ok', 'Ambiente ligado.');

    // ---------- 2. linha de base ----------
    setPhase('baseline');
    baseline = await runChecks(env, ctx);
    for (const r of baseline) log(r.ok ? 'ok' : 'error', `${r.ok ? '✔' : '✘'} ${r.name}: ${r.detail}`);
    if (!allCriticalOk(baseline)) {
      throw new UserError('A linha de base tem testes críticos falhando — o exercício só é válido partindo de um ambiente saudável.');
    }
    if (canarySrc) {
      log('info', `Canário de gravação iniciado (a cada ${canarySrc.intervalSeconds}s).`);
      startCanary();
      // aquecimento: ao menos 3 gravações confirmadas, para haver histórico antes da falha
      await waitFor(() => canary.ok >= 3 || canary.fail >= 3, { timeoutMs: 120_000, intervalMs: 300, signal, label: 'aquecimento do canário (3 gravações)' });
    } else if (env.rpoSource?.type !== 'none') {
      try {
        const r = await readLastData(env, { origin, signal });
        rpoInfo.before = r.at;
        log('info', `Dado mais recente antes da falha: ${r.at.toISOString()}`);
      } catch (err) {
        if (err.name === 'AbortedError') throw err;
        warnings.push(`Falha ao ler a fonte de RPO antes da falha: ${err.message}`);
        log('warn', warnings.at(-1));
      }
    }
    // garante ao menos uma amostra saudável antes de injetar a falha
    await waitFor(() => samples.some((s) => s.ok), { timeoutMs: 60_000, intervalMs: 300, signal, label: 'primeira amostra saudável' });

    // o canário para ANTES da falha: o último valor confirmado é o "dado em risco"
    if (canarySrc) {
      await stopCanary();
      if (!canary.lastAcked) throw new UserError('O canário não conseguiu gravar nenhum valor antes da falha: verifique o comando de gravação (Testes → Fonte de RPO).');
      rpoInfo.before = canary.lastAcked;
      log('info', `Canário: ${canary.ok} gravação(ões) confirmada(s); última em ${canary.lastAcked.toISOString()}.`);
    }

    // ---------- 3. falha ----------
    setPhase('failure');
    ts.failureAt = Date.now();
    job.live.failureAt = ts.failureAt;
    failureInjected = true;
    log('warn', 'FALHA INJETADA — o relógio do RTO começou.');
    await provider.stop(opCtx);
    ts.stoppedAt = Date.now();
    job.live.stoppedAt = ts.stoppedAt;

    // detecção: aguarda uma amostra falha (com pequena tolerância após o término do desligamento)
    const grace = Math.max(15_000, intervalMs * 3);
    try {
      await waitFor(() => firstFailureAfter(ts.failureAt), { timeoutMs: grace, intervalMs: 300, signal, label: 'detecção da indisponibilidade' });
    } catch (err) {
      if (err.code !== 'TIMEOUT') throw err;
    }
    const failed = firstFailureAfter(ts.failureAt);
    if (failed) {
      ts.detectedAt = failed.t;
      log('warn', `Indisponibilidade detectada pelos testes ${secs(ts.failureAt, ts.detectedAt).toFixed(0)}s após a falha.`);
    } else {
      warnings.push('Os testes não detectaram indisponibilidade após o desligamento — verifique se são sensíveis à falha. O RTO pode estar subestimado.');
      log('warn', warnings.at(-1));
    }
    job.live.detectedAt = ts.detectedAt;

    // ---------- 4. acionamento ----------
    setPhase('hold');
    const holdUntil = ts.failureAt + params.holdDownSeconds * 1000;
    if (Date.now() < holdUntil) {
      log('info', `Aguardando ${Math.ceil((holdUntil - Date.now()) / 1000)}s para simular o tempo de decisão/acionamento da equipe…`);
      await sleep(holdUntil - Date.now(), signal);
    }

    // ---------- 5. recuperação ----------
    setPhase('recovery');
    ts.recoveryStartAt = Date.now();
    job.live.recoveryStartAt = ts.recoveryStartAt;
    log('info', 'Recuperação iniciada.');
    await provider.start(opCtx);
    recoveryDone = true;
    ts.infraReadyAt = Date.now();
    job.live.infraReadyAt = ts.infraReadyAt;

    // ---------- 6. validação ----------
    setPhase('validate');
    if (ts.detectedAt == null) {
      ts.restoredAt = ts.infraReadyAt;
      log('warn', 'Sem indisponibilidade detectada: considerando a infraestrutura pronta como instante de restauração.');
    } else {
      const remaining = Math.max(30_000, params.maxRecoverySeconds * 1000 - (Date.now() - ts.recoveryStartAt));
      try {
        await waitFor(() => findRestored() != null, { timeoutMs: remaining, intervalMs: 300, signal, label: 'serviço restaurado' });
        ts.restoredAt = findRestored();
        log('ok', `Serviço restaurado (${params.stableProbes} testes consecutivos saudáveis).`);
      } catch (err) {
        if (err.code !== 'TIMEOUT') throw err;
        status = 'timeout';
        errorMessage = `O serviço não foi restaurado dentro de ${params.maxRecoverySeconds}s após o início da recuperação.`;
        log('error', errorMessage);
      }
    }
    job.live.restoredAt = ts.restoredAt;

    // ---------- 7. medição de RPO (inicia automaticamente ao fim do RTO) ----------
    if (env.rpoSource?.type !== 'none' && status === 'completed') {
      setPhase('rpo');
      ts.rpoStartAt = Date.now();
      job.live.rpoStartAt = ts.rpoStartAt;
      log('info', 'RTO apurado — iniciando automaticamente a medição de RPO.');
      try {
        const r = await readLastData(env, { origin, signal });
        rpoInfo.after = r.at;
        log('info', `Dado mais recente após a recuperação: ${r.at.toISOString()}`);
      } catch (err) {
        if (err.name === 'AbortedError') throw err;
        rpoInfo.error = err.message;
        warnings.push(`Falha ao ler a fonte de RPO após a recuperação: ${err.message}`);
        log('warn', warnings.at(-1));
      }
      if (canarySrc) {
        // confirma que o caminho de escrita voltou (a leitura acima já foi feita, sem "mascaramento")
        try {
          await canaryWrite(canarySrc, { signal });
          canary.writeAfterRecovery = true;
          log('ok', 'Canário: gravação pós-recuperação confirmada — caminho de escrita restabelecido.');
        } catch (err) {
          if (err.name === 'AbortedError') throw err;
          canary.writeAfterRecovery = false;
          warnings.push(`O canário não conseguiu gravar após a recuperação: ${err.message}`);
          log('warn', warnings.at(-1));
        }
      }
      ts.rpoDoneAt = Date.now();
      job.live.rpoDoneAt = ts.rpoDoneAt;
    }

    // ---------- 8. fechamento ----------
    setPhase('finalize');
    if (status === 'completed') finalChecks = await runChecks(env, ctx);
  } catch (err) {
    caught = err;
    if (err instanceof AbortedError || err.name === 'AbortedError') {
      status = 'cancelled';
      errorMessage = 'Exercício cancelado pelo usuário.';
    } else {
      status = 'failed';
      errorMessage = err.message;
      log('error', err.message);
    }
  } finally {
    // Rede de segurança: nunca deixar o ambiente desligado por causa de um erro/cancelamento.
    if (failureInjected && !recoveryDone) {
      log('warn', 'Executando recuperação de segurança para não deixar o ambiente desligado…');
      try {
        await provider.start({ log, signal: new AbortController().signal });
        recoveryDone = true;
        ts.infraReadyAt ??= Date.now();
        log('ok', 'Recuperação de segurança concluída.');
      } catch (err) {
        warnings.push(`FALHA na recuperação de segurança — religue o ambiente manualmente: ${err.message}`);
        log('error', warnings.at(-1));
      }
    }
    canary.stop = true;
    await canary.loop;
    probeAbort.abort();
    await prober;
  }

  // Nada foi alterado no ambiente (falhou/cancelou antes da falha): não gera relatório.
  if (!failureInjected && caught) throw caught;

  // ---------- métricas ----------
  const finishedAt = Date.now();
  const rtoSec = status === 'completed' && ts.failureAt != null && ts.restoredAt != null ? secs(ts.failureAt, ts.restoredAt) : null;
  const rpoMeasured = status === 'completed' && (canarySrc ? Boolean(rpoInfo.before && rpoInfo.after) : Boolean(rpoInfo.before || rpoInfo.after));
  const rpoSec = !rpoMeasured ? null : canarySrc ? computeCanaryRpoSeconds({ lastAcked: rpoInfo.before, readBack: rpoInfo.after }) : computeRpoSeconds({ failureAt: ts.failureAt, before: rpoInfo.before, after: rpoInfo.after });

  if (rpoMeasured) log('ok', `RPO apurado: ${rpoSec.toFixed(1)}s (meta ${env.targets.rpoSeconds}s) — ${rpoSec <= env.targets.rpoSeconds ? 'dentro da meta' : 'FORA da meta'}.`);
  else if (status === 'completed' && env.rpoSource?.type !== 'none') log('warn', 'RPO não pôde ser apurado (veja os avisos).');

  // segmentos consecutivos do RTO
  const infraEnd = ts.restoredAt != null && ts.infraReadyAt != null ? Math.min(ts.infraReadyAt, ts.restoredAt) : ts.infraReadyAt;
  const breakdown = {
    detectionSec: secs(ts.failureAt, ts.detectedAt),
    stopSec: secs(ts.failureAt, ts.stoppedAt),
    holdSec: secs(ts.stoppedAt, ts.recoveryStartAt),
    infraStartSec: secs(ts.recoveryStartAt, infraEnd),
    appReadySec: ts.restoredAt != null && infraEnd != null ? secs(infraEnd, ts.restoredAt) : null,
    activeRecoverySec: secs(ts.recoveryStartAt, ts.restoredAt),
    rpoMeasureSec: secs(ts.rpoStartAt, ts.rpoDoneAt),
  };

  // disponibilidade e janelas de indisponibilidade observadas
  let downMs = 0;
  const outages = [];
  samples.forEach((s, i) => {
    const next = samples[i + 1]?.t ?? s.t + intervalMs;
    if (!s.ok) {
      downMs += next - s.t;
      const last = outages.at(-1);
      if (last && last.endT === s.t) last.endT = next;
      else outages.push({ startT: s.t, endT: next });
    }
  });
  const totalMs = samples.length ? samples.at(-1).t + intervalMs - samples[0].t : 0;
  const availabilityPct = totalMs > 0 ? Math.max(0, 100 - (downMs / totalMs) * 100) : null;

  const rto = { targetSec: env.targets.rtoSeconds, actualSec: rtoSec, pass: rtoSec != null && rtoSec <= env.targets.rtoSeconds };
  const rpo = { targetSec: env.targets.rpoSeconds, actualSec: rpoSec, measured: Boolean(rpoMeasured), pass: rpoSec != null && rpoSec <= env.targets.rpoSeconds };
  let verdict;
  if (status === 'completed') verdict = rto.pass && (!rpo.measured || rpo.pass) ? 'approved' : 'failed';
  else if (status === 'timeout') verdict = 'failed';
  else verdict = 'incomplete';

  const run = {
    id: job.id,
    kind: 'drill',
    envId: env.id,
    envName: env.name,
    env: envSnapshot(env),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationSec: (finishedAt - startedAt) / 1000,
    status,
    error: errorMessage,
    warnings,
    params,
    targets: env.targets,
    timestamps: Object.fromEntries(Object.entries(ts).map(([k, v]) => [k, v != null ? new Date(v).toISOString() : null])),
    metrics: { rtoSec, rpoSec, availabilityPct, downtimeSec: downMs / 1000, sampleCount: samples.length, ...breakdown },
    rpoDetail: {
      source: rpoInfo.source,
      mode: canarySrc ? 'canary' : 'timestamp',
      before: rpoInfo.before?.toISOString() ?? null,
      after: rpoInfo.after?.toISOString() ?? null,
      error: rpoInfo.error,
      canary: canarySrc ? { writesOk: canary.ok, writesFailed: canary.fail, intervalSeconds: canarySrc.intervalSeconds, writeAfterRecovery: canary.writeAfterRecovery ?? null } : undefined,
    },
    evaluation: { rto, rpo, verdict },
    outages: outages.map((o) => ({ from: new Date(o.startT).toISOString(), to: new Date(o.endT).toISOString(), durationSec: (o.endT - o.startT) / 1000 })),
    checks: checkMeta(checks),
    baseline,
    finalChecks,
    samples,
    events: job.events.map((e) => ({ t: new Date(e.t).toISOString(), level: e.level, msg: e.msg })),
    notes: '',
  };
  await store.saveRun(run);
  log('info', `Relatório salvo (${run.id}).`);
  job.live.runId = run.id;
  const { samples: _s, events: _e, baseline: _b, finalChecks: _f, ...summary } = run;
  if (status === 'cancelled') throw new AbortedError();
  if (status === 'failed') throw new Error(errorMessage);
  return summary;
}

/** Ligar/desligar manual — também registra a duração para o histórico. */
export async function runPowerOperation(kind, { env, provider, store, origin }, job, signal) {
  const log = job.log;
  const startedAt = Date.now();
  job.live = { phase: kind, phaseLabel: kind === 'stop' ? 'Desligando' : 'Ligando', startedAt };
  let status = 'completed';
  let errorMessage = null;
  let healthySec = null;
  const warnings = [];
  let failure = null;
  try {
    log('info', kind === 'stop' ? 'Desligando o ambiente…' : 'Ligando o ambiente…');
    await provider[kind]({ log, signal });
    if (kind === 'start' && env.checks.length) {
      log('info', 'Aguardando os testes das aplicações ficarem saudáveis…');
      job.live.phase = 'validate';
      job.live.phaseLabel = 'Aguardando aplicações saudáveis';
      try {
        healthySec = await waitHealthy(env, { origin, provider, signal }, { timeoutMs: env.drill.maxRecoverySeconds * 1000 });
        log('ok', `Aplicações saudáveis ${healthySec.toFixed(0)}s após a infraestrutura ficar pronta.`);
      } catch (err) {
        if (err.code !== 'TIMEOUT') throw err;
        warnings.push(`Aplicações não ficaram saudáveis em ${env.drill.maxRecoverySeconds}s.`);
        log('warn', warnings.at(-1));
      }
    }
  } catch (err) {
    failure = err;
    status = err.name === 'AbortedError' ? 'cancelled' : 'failed';
    errorMessage = status === 'cancelled' ? 'Cancelado pelo usuário' : err.message;
  }
  const finishedAt = Date.now();
  const run = {
    id: job.id,
    kind,
    envId: env.id,
    envName: env.name,
    env: envSnapshot(env),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    durationSec: (finishedAt - startedAt) / 1000,
    status,
    error: errorMessage,
    warnings,
    metrics: { durationSec: (finishedAt - startedAt) / 1000, healthyAfterInfraSec: healthySec },
    events: job.events.map((e) => ({ t: new Date(e.t).toISOString(), level: e.level, msg: e.msg })),
    notes: '',
  };
  await store.saveRun(run);
  if (failure) throw failure;
  const { events: _e, ...summary } = run;
  return summary;
}
