// Geração de relatórios: HTML autônomo (imprimível/PDF), Markdown, CSV e consolidado.
// Todo texto dinâmico passa por esc() — nomes de testes, mensagens e notas são dados do usuário.
import { fmtDuration } from './util.js';

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VERDICT = {
  approved: { label: 'APROVADO', color: '#15803d', bg: '#dcfce7' },
  failed: { label: 'REPROVADO', color: '#b91c1c', bg: '#fee2e2' },
  incomplete: { label: 'INCOMPLETO', color: '#a16207', bg: '#fef3c7' },
};
const KIND_LABEL = { drill: 'Exercício de RTO/RPO', start: 'Operação: ligar ambiente', stop: 'Operação: desligar ambiente' };
const STATUS_LABEL = { completed: 'Concluído', failed: 'Falhou', timeout: 'Tempo esgotado', cancelled: 'Cancelado' };
const PROVIDER_LABEL = { eks: 'Amazon EKS', custom: 'Comandos customizados',
  k8s: 'Kubernetes (kubectl)', aws: 'Recursos AWS (EC2/RDS/ElastiCache)', simulated: 'Simulado' };

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour12: false }) : '—');
const fmtPct = (n) => (n == null ? '—' : `${n.toFixed(2).replace('.', ',')}%`);
const offset = (iso, base) => (iso && base ? `+${fmtDuration((new Date(iso) - new Date(base)) / 1000)}` : '—');

// ---------- texto ----------
export function recommendations(run) {
  const out = [];
  if (run.kind !== 'drill') return out;
  const { evaluation: ev, metrics: m } = run;
  if (run.status === 'timeout') out.push('O serviço não voltou dentro do limite. Investigue o que impediu a restauração (pods pendentes, quotas, imagens, dependências externas) antes de repetir o exercício.');
  if (!ev.rto.pass && ev.rto.actualSec != null) {
    const parts = [
      ['infraStartSec', 'a inicialização da infraestrutura (nós)'],
      ['appReadySec', 'a subida das aplicações após a infraestrutura'],
      ['holdSec', 'o tempo de acionamento da equipe'],
    ]
      .map(([k, label]) => [m[k] ?? 0, label])
      .sort((a, b) => b[0] - a[0]);
    out.push(`O RTO excedeu a meta em ${fmtDuration(ev.rto.actualSec - ev.rto.targetSec)}. A maior parcela foi ${parts[0][1]} (${fmtDuration(parts[0][0])}).`);
    if (m.infraStartSec != null && m.infraStartSec >= (m.appReadySec ?? 0)) {
      out.push('Reduza o tempo de provisionamento de nós: mantenha um warm pool/capacidade mínima, use AMIs otimizadas, pré-carregue imagens (ex.: cache de imagens no nó) e considere Karpenter com consolidação controlada.');
    } else {
      out.push('Reduza o tempo de subida das aplicações: revise readiness/startup probes, init containers, migrações no boot, tamanho das imagens e dependências que precisam estar prontas antes (banco, filas, secrets).');
    }
    if ((m.holdSec ?? 0) > 0) out.push('O tempo de acionamento simulado faz parte do RTO: automatize a decisão/execução da recuperação (runbook automatizado, pipelines, alarmes que disparam a restauração).');
  }
  if (m.detectionSec != null && m.detectionSec > 60) out.push(`A indisponibilidade levou ${fmtDuration(m.detectionSec)} para ser detectada. Reveja alarmes e health checks (intervalos, limiares e canais de notificação).`);
  if (ev.rpo.measured && !ev.rpo.pass) {
    out.push(`O RPO medido (${fmtDuration(ev.rpo.actualSec)}) excede a meta (${fmtDuration(ev.rpo.targetSec)}). Reduza a janela de perda: backups/snapshots mais frequentes, PITR habilitado, replicação síncrona/assíncrona com menor atraso ou fila durável antes do armazenamento.`);
  }
  if (!ev.rpo.measured) out.push('O RPO não foi medido neste exercício. Configure uma fonte de RPO (endpoint, comando ou RDS PITR) para validar também a perda de dados.');
  if (run.warnings?.length) out.push('Há avisos neste exercício (veja a seção "Avisos") que podem afetar a confiabilidade das medições.');
  if (out.length === 0) out.push('Metas atendidas. Mantenha a rotina: repita o exercício periodicamente e após mudanças relevantes de arquitetura.');
  return out;
}

export function summaryText(run) {
  if (run.kind !== 'drill') {
    return `${KIND_LABEL[run.kind]} no ambiente "${run.envName}" — ${STATUS_LABEL[run.status] ?? run.status} em ${fmtDuration(run.durationSec)}.`;
  }
  const { evaluation: ev, metrics: m } = run;
  const parts = [`Em ${fmtDateTime(run.startedAt)}, o exercício no ambiente "${run.envName}" desligou a infraestrutura e mediu o tempo até as aplicações voltarem a responder.`];
  if (ev.rto.actualSec != null) parts.push(`RTO medido: ${fmtDuration(ev.rto.actualSec)} (meta ${fmtDuration(ev.rto.targetSec)}) — ${ev.rto.pass ? 'dentro da meta' : 'fora da meta'}.`);
  else parts.push('O RTO não pôde ser medido (o serviço não foi restaurado).');
  if (ev.rpo.measured) parts.push(`RPO medido: ${fmtDuration(ev.rpo.actualSec)} (meta ${fmtDuration(ev.rpo.targetSec)}) — ${ev.rpo.pass ? 'dentro da meta' : 'fora da meta'}.`);
  else parts.push('RPO não medido.');
  if (m.availabilityPct != null) parts.push(`Disponibilidade observada na janela do exercício: ${fmtPct(m.availabilityPct)}.`);
  return parts.join(' ');
}

// ---------- SVG ----------
function timelineSvg(run) {
  const samples = run.samples ?? [];
  if (!samples.length) return '';
  const W = 860;
  const left = 170;
  const rowH = 20;
  const top = 34;
  const rows = [{ name: 'Serviço (todos os críticos)', get: (s) => s.ok }, ...run.checks.map((c, i) => ({ name: c.name + (c.critical ? '' : ' (não crítico)'), get: (s) => s.r[i] === 1 }))];
  const H = top + rows.length * rowH + 22;
  const t0 = samples[0].t;
  const step = run.params?.probeIntervalSeconds ? run.params.probeIntervalSeconds * 1000 : 5000;
  const t1 = samples.at(-1).t + step;
  const x = (t) => left + ((t - t0) / (t1 - t0)) * (W - left - 10);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Linha do tempo de disponibilidade por teste" font-family="system-ui,sans-serif" font-size="11">`];
  rows.forEach((row, ri) => {
    const y = top + ri * rowH;
    parts.push(`<text x="${left - 8}" y="${y + 13}" text-anchor="end" fill="#334155">${esc(row.name.length > 26 ? `${row.name.slice(0, 25)}…` : row.name)}</text>`);
    samples.forEach((s, i) => {
      const xa = x(s.t);
      const xb = x(samples[i + 1]?.t ?? s.t + step);
      parts.push(`<rect x="${xa.toFixed(1)}" y="${y + 2}" width="${Math.max(1, xb - xa).toFixed(1)}" height="${rowH - 5}" fill="${row.get(s) ? '#22c55e' : '#ef4444'}"/>`);
    });
  });
  const ts = run.timestamps ?? {};
  const marks = [
    ['failureAt', 'Falha', '#b91c1c'],
    ['recoveryStartAt', 'Recuperação', '#1d4ed8'],
    ['restoredAt', 'Restaurado', '#15803d'],
  ];
  const used = [];
  for (const [k, label, color] of marks) {
    if (!ts[k]) continue;
    const xx = x(new Date(ts[k]).getTime());
    const lvl = used.filter((u) => Math.abs(u - xx) < 70).length;
    used.push(xx);
    parts.push(`<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${top - 6 - lvl * 0}" y2="${H - 20}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${(xx + 3).toFixed(1)}" y="${12 + lvl * 11}" fill="${color}" font-weight="600">${label}</text>`);
  }
  parts.push(`<text x="${left}" y="${H - 5}" fill="#64748b">${esc(fmtTime(new Date(t0).toISOString()))}</text>`);
  parts.push(`<text x="${W - 10}" y="${H - 5}" text-anchor="end" fill="#64748b">${esc(fmtTime(new Date(t1).toISOString()))}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

function breakdownBar(run) {
  const m = run.metrics;
  const segs = [
    ['Falha/desligamento', m.stopSec, '#ef4444'],
    ['Acionamento', m.holdSec, '#f59e0b'],
    ['Infra religando', m.infraStartSec, '#3b82f6'],
    ['Aplicações subindo', m.appReadySec, '#22c55e'],
  ].map(([label, v, color]) => ({ label, v: v ?? 0, color }));
  const total = segs.reduce((a, s) => a + s.v, 0);
  if (total <= 0) return '';
  const bar = segs
    .filter((s) => s.v > 0)
    .map((s) => `<div class="seg" style="flex:${s.v};background:${s.color}" title="${esc(s.label)}: ${esc(fmtDuration(s.v))}"></div>`)
    .join('');
  const legend = segs.map((s) => `<tr><td><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</td><td class="num">${esc(fmtDuration(s.v))}</td><td class="num">${((s.v / total) * 100).toFixed(0)}%</td></tr>`).join('');
  return `<div class="bar">${bar}</div><table class="legend"><tbody>${legend}</tbody></table>`;
}

// ---------- HTML ----------
const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#fff;margin:0;padding:32px;max-width:960px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
.muted{color:#64748b}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;letter-spacing:.04em}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}
.kpi{border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}
.kpi .l{font-size:12px;color:#64748b}.kpi .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .s{font-size:12px}
.ok{color:#15803d}.bad{color:#b91c1c}.warn{color:#a16207}
table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
th{font-size:12px;color:#475569;background:#f8fafc}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:8px 0}.seg{min-width:2px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.legend{width:auto;min-width:380px}.legend td{border:0;padding:2px 10px 2px 0}
.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px}
.warnbox{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px}
.log{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.log .e{color:#fca5a5}.log .w{color:#fcd34d}.log .o{color:#86efac}
svg{max-width:100%;height:auto}
footer{margin-top:32px;font-size:12px;color:#94a3b8}
@media print{body{padding:0}h2{break-after:avoid}table,.kpi,svg{break-inside:avoid}}
`;

const page = (title, body) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<footer>Gerado por EPMA | Infrastructure &amp; DR Tool em ${esc(fmtDateTime(new Date().toISOString()))}.</footer></body></html>`;

const kpi = (label, value, sub, cls = '') => `<div class="kpi"><div class="l">${esc(label)}</div><div class="v ${cls}">${esc(value)}</div><div class="s muted">${sub}</div></div>`;

export function renderRunHtml(run) {
  const verdict = run.kind === 'drill' ? VERDICT[run.evaluation.verdict] : null;
  const head = `<div class="head"><div><h1>${esc(KIND_LABEL[run.kind] ?? run.kind)}</h1><div class="muted">${esc(run.envName)} · ${esc(PROVIDER_LABEL[run.env?.provider] ?? run.env?.provider ?? '')}${run.env?.clusterName ? ` · ${esc(run.env.clusterName)}${run.env.region ? ` (${esc(run.env.region)})` : ''}` : ''}<br>${esc(fmtDateTime(run.startedAt))} → ${esc(fmtDateTime(run.finishedAt))} · ID ${esc(run.id)}</div></div>${
    verdict ? `<div class="badge" style="color:${verdict.color};background:${verdict.bg}">${verdict.label}</div>` : `<div class="badge" style="color:#334155;background:#e2e8f0">${esc(STATUS_LABEL[run.status] ?? run.status)}</div>`
  }</div>`;

  let body = head;
  body += `<h2>Resumo</h2><div class="box">${esc(summaryText(run))}</div>`;
  if (run.error) body += `<p class="bad"><strong>Erro:</strong> ${esc(run.error)}</p>`;
  if (run.warnings?.length) body += `<h2>Avisos</h2><div class="warnbox"><ul>${run.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;

  if (run.kind === 'drill') {
    const { evaluation: ev, metrics: m, timestamps: ts } = run;
    body += `<div class="kpis">
      ${kpi('RTO medido', fmtDuration(ev.rto.actualSec), `meta ${esc(fmtDuration(ev.rto.targetSec))} · ${ev.rto.actualSec == null ? '—' : ev.rto.pass ? '✔ dentro da meta' : '✘ fora da meta'}`, ev.rto.actualSec == null ? '' : ev.rto.pass ? 'ok' : 'bad')}
      ${kpi('RPO medido', ev.rpo.measured ? fmtDuration(ev.rpo.actualSec) : 'não medido', `meta ${esc(fmtDuration(ev.rpo.targetSec))}${ev.rpo.measured ? ` · ${ev.rpo.pass ? '✔ dentro da meta' : '✘ fora da meta'}` : ''}`, !ev.rpo.measured ? 'warn' : ev.rpo.pass ? 'ok' : 'bad')}
      ${kpi('Disponibilidade', fmtPct(m.availabilityPct), `indisponível ${esc(fmtDuration(m.downtimeSec))} (${m.sampleCount} amostras)`)}
      ${kpi('Recuperação ativa', fmtDuration(m.activeRecoverySec), 'do início da recuperação ao serviço restaurado')}
    </div>`;

    body += `<h2>Linha do tempo</h2><table><thead><tr><th>Marco</th><th>Horário</th><th class="num">Desde a falha</th></tr></thead><tbody>
      ${[
        ['Falha injetada (desligamento iniciado)', ts.failureAt],
        ['Desligamento concluído', ts.stoppedAt],
        ['Indisponibilidade detectada pelos testes', ts.detectedAt],
        ['Recuperação iniciada', ts.recoveryStartAt],
        ['Infraestrutura pronta (nós Ready)', ts.infraReadyAt],
        ['Serviço restaurado (testes críticos saudáveis) — RTO apurado', ts.restoredAt],
        ['Medição de RPO iniciada automaticamente', ts.rpoStartAt],
        ['RPO apurado', ts.rpoDoneAt],
      ].filter(([, t]) => t)
        .map(([l, t]) => `<tr><td>${esc(l)}</td><td>${esc(fmtTime(t))}</td><td class="num">${t === ts.failureAt ? '0s' : esc(offset(t, ts.failureAt))}</td></tr>`)
        .join('')}
    </tbody></table>`;

    const bb = breakdownBar(run);
    if (bb) body += `<h2>Composição do RTO</h2>${bb}<p class="muted">RTO = ${esc(fmtDuration(ev.rto.actualSec))} (da falha ao serviço restaurado). A detecção ocorreu ${esc(fmtDuration(m.detectionSec))} após a falha.</p>`;

    const svg = timelineSvg(run);
    if (svg) body += `<h2>Disponibilidade por teste</h2>${svg}<p class="muted">Verde = teste passando · vermelho = falhando. Resolução = intervalo entre amostras (${esc(run.params?.probeIntervalSeconds)}s).</p>`;

    if (run.outages?.length) {
      body += `<h2>Janelas de indisponibilidade</h2><table><thead><tr><th>Início</th><th>Fim</th><th class="num">Duração</th></tr></thead><tbody>${run.outages.map((o) => `<tr><td>${esc(fmtTime(o.from))}</td><td>${esc(fmtTime(o.to))}</td><td class="num">${esc(fmtDuration(o.durationSec))}</td></tr>`).join('')}</tbody></table>`;
    }

    body += `<h2>RPO</h2><table><tbody>
      <tr><td>Fonte</td><td>${esc(run.rpoDetail?.source ?? 'none')}</td></tr>
      ${run.rpoDetail?.canary ? `<tr><td>Canário de gravação</td><td>${esc(run.rpoDetail.canary.writesOk)} gravação(ões) confirmada(s), ${esc(run.rpoDetail.canary.writesFailed)} falha(s) · intervalo ${esc(run.rpoDetail.canary.intervalSeconds)}s (resolução da medição)</td></tr>` : ''}
      ${ts.rpoStartAt ? `<tr><td>Medição</td><td>iniciada às ${esc(fmtTime(ts.rpoStartAt))} (logo após o RTO) e concluída às ${esc(fmtTime(ts.rpoDoneAt))} — ${esc(fmtDuration(m.rpoMeasureSec))}</td></tr>` : ''}
      ${run.rpoDetail?.canary && run.rpoDetail.canary.writeAfterRecovery != null ? `<tr><td>Gravação pós-recuperação</td><td class="${run.rpoDetail.canary.writeAfterRecovery ? 'ok' : 'bad'}">${run.rpoDetail.canary.writeAfterRecovery ? '✔ caminho de escrita restabelecido' : '✘ o canário não conseguiu gravar após a recuperação'}</td></tr>` : ''}
      <tr><td>Dado mais recente antes da falha</td><td>${esc(run.rpoDetail?.before ? fmtDateTime(run.rpoDetail.before) : '—')}</td></tr>
      <tr><td>Dado mais recente após a recuperação</td><td>${esc(run.rpoDetail?.after ? fmtDateTime(run.rpoDetail.after) : '—')}</td></tr>
      ${run.rpoDetail?.error ? `<tr><td>Erro</td><td class="bad">${esc(run.rpoDetail.error)}</td></tr>` : ''}
      <tr><td>RPO</td><td><strong>${ev.rpo.measured ? esc(fmtDuration(ev.rpo.actualSec)) : 'não medido'}</strong></td></tr>
    </tbody></table>`;

    const rows = (list) =>
      (list ?? []).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔ OK' : '✘ Falha'}</td><td>${esc(r.detail)}</td></tr>`).join('');
    body += `<h2>Testes de aplicação</h2><h3 style="font-size:13px;margin:8px 0">Linha de base (antes da falha)</h3><table><thead><tr><th>Teste</th><th>Tipo</th><th>Resultado</th><th>Detalhe</th></tr></thead><tbody>${rows(run.baseline)}</tbody></table>`;
    if (run.finalChecks) body += `<h3 style="font-size:13px;margin:14px 0 8px">Validação final (após a recuperação)</h3><table><thead><tr><th>Teste</th><th>Tipo</th><th>Resultado</th><th>Detalhe</th></tr></thead><tbody>${rows(run.finalChecks)}</tbody></table>`;

    body += `<h2>Parâmetros e método</h2><div class="box"><ul>
      <li>Tempo de acionamento simulado: ${esc(fmtDuration(run.params?.holdDownSeconds))} · intervalo das amostras: ${esc(run.params?.probeIntervalSeconds)}s · amostras estáveis para declarar restauração: ${esc(run.params?.stableProbes)}.</li>
      <li><strong>RTO</strong> = instante em que o serviço voltou a passar nos testes críticos (primeira amostra da sequência estável) − instante em que a falha foi injetada.</li>
      ${
        run.rpoDetail?.mode === 'canary'
          ? '<li><strong>RPO (canário)</strong> = último valor gravado com confirmação antes da falha − valor lido após a recuperação. O escritor para no instante da falha; zero significa que nenhum dado confirmado foi perdido.</li>'
          : '<li><strong>RPO</strong> = instante da falha − timestamp do dado mais antigo entre “antes da falha” e “após a recuperação” (se o dado regrediu, houve perda real; se não, é a defasagem existente na falha).</li>'
      }
      <li>A resolução das medições é o intervalo de amostragem; o relógio é o do servidor do console.</li>
    </ul></div>`;
  } else {
    body += `<div class="kpis">${kpi('Duração', fmtDuration(run.durationSec), esc(STATUS_LABEL[run.status] ?? run.status))}${run.metrics?.healthyAfterInfraSec != null ? kpi('Aplicações saudáveis', fmtDuration(run.metrics.healthyAfterInfraSec), 'após a infraestrutura ficar pronta') : ''}</div>`;
  }

  const recs = recommendations(run);
  if (recs.length) body += `<h2>Recomendações</h2><ul>${recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  if (run.notes) body += `<h2>Observações</h2><div class="box" style="white-space:pre-wrap">${esc(run.notes)}</div>`;

  const cls = { error: 'e', warn: 'w', ok: 'o' };
  body += `<h2>Registro de eventos</h2><div class="log">${(run.events ?? []).map((e) => `<span class="${cls[e.level] ?? ''}">${esc(fmtTime(e.t))}  ${esc(e.msg)}</span>`).join('\n')}</div>`;
  return page(`${KIND_LABEL[run.kind] ?? 'Relatório'} — ${run.envName}`, body);
}

// ---------- Markdown ----------
const md = (s) => String(s ?? '').replace(/[|\\`*_{}[\]<>#]/g, '\\$&').replace(/\n/g, ' ');

export function renderRunMarkdown(run) {
  const L = [];
  L.push(`# ${KIND_LABEL[run.kind] ?? run.kind} — ${md(run.envName)}`, '');
  L.push(`- **ID:** ${run.id}`, `- **Início:** ${fmtDateTime(run.startedAt)}`, `- **Fim:** ${fmtDateTime(run.finishedAt)}`, `- **Status:** ${STATUS_LABEL[run.status] ?? run.status}`);
  if (run.kind === 'drill') {
    const { evaluation: ev, metrics: m, timestamps: ts } = run;
    L.push(`- **Veredito:** ${VERDICT[ev.verdict].label}`, '', '## Resultados', '', '| Métrica | Medido | Meta | Resultado |', '|---|---|---|---|');
    L.push(`| RTO | ${fmtDuration(ev.rto.actualSec)} | ${fmtDuration(ev.rto.targetSec)} | ${ev.rto.actualSec == null ? '—' : ev.rto.pass ? 'OK' : 'FORA'} |`);
    L.push(`| RPO | ${ev.rpo.measured ? fmtDuration(ev.rpo.actualSec) : 'não medido'} | ${fmtDuration(ev.rpo.targetSec)} | ${!ev.rpo.measured ? '—' : ev.rpo.pass ? 'OK' : 'FORA'} |`);
    L.push(`| Disponibilidade | ${fmtPct(m.availabilityPct)} | — | — |`, '', '## Linha do tempo', '', '| Marco | Horário | Desde a falha |', '|---|---|---|');
    for (const [l, t] of [['Falha injetada', ts.failureAt], ['Desligamento concluído', ts.stoppedAt], ['Detecção', ts.detectedAt], ['Recuperação iniciada', ts.recoveryStartAt], ['Infra pronta', ts.infraReadyAt], ['Serviço restaurado (RTO apurado)', ts.restoredAt], ['Medição de RPO iniciada (automática)', ts.rpoStartAt], ['RPO apurado', ts.rpoDoneAt]]) {
      if (!t) continue;
      L.push(`| ${l} | ${fmtTime(t)} | ${t === ts.failureAt ? '0s' : offset(t, ts.failureAt)} |`);
    }
    L.push('', '## Composição do RTO', '', `- Desligamento: ${fmtDuration(m.stopSec)}`, `- Acionamento: ${fmtDuration(m.holdSec)}`, `- Infra religando: ${fmtDuration(m.infraStartSec)}`, `- Aplicações subindo: ${fmtDuration(m.appReadySec)}`);
  } else {
    L.push(`- **Duração:** ${fmtDuration(run.durationSec)}`);
  }
  if (run.warnings?.length) L.push('', '## Avisos', '', ...run.warnings.map((w) => `- ${md(w)}`));
  const recs = recommendations(run);
  if (recs.length) L.push('', '## Recomendações', '', ...recs.map((r) => `- ${md(r)}`));
  if (run.notes) L.push('', '## Observações', '', md(run.notes));
  return `${L.join('\n')}\n`;
}

// ---------- CSV ----------
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita injeção de fórmula em planilhas
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function renderRunCsv(run) {
  const checks = run.checks ?? [];
  const failure = run.timestamps?.failureAt ? new Date(run.timestamps.failureAt).getTime() : null;
  const header = ['timestamp', 'offset_s', 'servico_ok', ...checks.flatMap((c) => [`${c.name}`, `${c.name} (ms)`])];
  const lines = [header.map(csvCell).join(',')];
  for (const s of run.samples ?? []) {
    lines.push([new Date(s.t).toISOString(), failure ? ((s.t - failure) / 1000).toFixed(1) : '', s.ok ? 1 : 0, ...checks.flatMap((_, i) => [s.r[i], s.l[i]])].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------- consolidado ----------
function trendSvg(runs, key, targetKey, title) {
  const pts = runs.filter((r) => r.metrics?.[key] != null).reverse();
  if (!pts.length) return `<p class="muted">Sem dados de ${esc(title)}.</p>`;
  const W = 860;
  const H = 190;
  const pad = { l: 56, r: 16, t: 14, b: 30 };
  const maxV = Math.max(...pts.map((r) => r.metrics[key]), ...pts.map((r) => r.targets?.[targetKey] ?? 0), 1) * 1.15;
  const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);
  const last = pts.at(-1);
  const target = last.targets?.[targetKey];
  const poly = pts.map((r, i) => `${x(i).toFixed(1)},${y(r.metrics[key]).toFixed(1)}`).join(' ');
  const dots = pts.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r.metrics[key]).toFixed(1)}" r="4" fill="${(r.targets?.[targetKey] ?? Infinity) >= r.metrics[key] ? '#16a34a' : '#dc2626'}"><title>${esc(fmtDateTime(r.startedAt))}: ${esc(fmtDuration(r.metrics[key]))}</title></circle>`).join('');
  const labels = pts.map((r, i) => (pts.length <= 12 || i % Math.ceil(pts.length / 12) === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="#64748b">${esc(new Date(r.startedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }))}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" font-family="system-ui,sans-serif" font-size="11">
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="#cbd5e1"/>
    <text x="${pad.l - 6}" y="${y(0) + 4}" text-anchor="end" fill="#64748b">0</text>
    <text x="${pad.l - 6}" y="${y(maxV) + 10}" text-anchor="end" fill="#64748b">${esc(fmtDuration(maxV))}</text>
    ${target != null ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(target)}" y2="${y(target)}" stroke="#f59e0b" stroke-dasharray="5 4"/><text x="${W - pad.r}" y="${y(target) - 4}" text-anchor="end" fill="#b45309">meta ${esc(fmtDuration(target))}</text>` : ''}
    <polyline points="${poly}" fill="none" stroke="#3b82f6" stroke-width="2"/>${dots}${labels}</svg>`;
}

export function renderSummaryHtml(runs, env) {
  const drills = runs.filter((r) => r.kind === 'drill');
  const rtos = drills.map((r) => r.metrics?.rtoSec).filter((v) => v != null).sort((a, b) => a - b);
  const approved = drills.filter((r) => r.evaluation?.verdict === 'approved').length;
  const pct = (p) => (rtos.length ? rtos[Math.min(rtos.length - 1, Math.ceil((p / 100) * rtos.length) - 1)] : null);
  let body = `<h1>Relatório consolidado de RTO/RPO</h1><div class="muted">${esc(env?.name ?? 'Todos os ambientes')} · ${drills.length} exercício(s) · gerado em ${esc(fmtDateTime(new Date().toISOString()))}</div>`;
  if (env) body += `<div class="kpis">${kpi('Meta de RTO', fmtDuration(env.targets.rtoSeconds), 'configurada hoje')}${kpi('Meta de RPO', fmtDuration(env.targets.rpoSeconds), 'configurada hoje')}${kpi('Aprovados', `${approved}/${drills.length}`, drills.length ? `${Math.round((approved / drills.length) * 100)}% dos exercícios` : '—')}${kpi('RTO p50 / p95 / máx', rtos.length ? `${fmtDuration(pct(50))}` : '—', rtos.length ? `p95 ${esc(fmtDuration(pct(95)))} · máx ${esc(fmtDuration(rtos.at(-1)))}` : '—')}</div>`;
  body += `<h2>Evolução do RTO</h2>${trendSvg(drills, 'rtoSec', 'rtoSeconds', 'RTO')}<h2>Evolução do RPO</h2>${trendSvg(drills, 'rpoSec', 'rpoSeconds', 'RPO')}`;
  body += `<h2>Exercícios</h2><table><thead><tr><th>Data</th><th>Ambiente</th><th class="num">RTO</th><th class="num">Meta</th><th class="num">RPO</th><th class="num">Meta</th><th class="num">Disp.</th><th>Veredito</th></tr></thead><tbody>${
    drills
      .map((r) => {
        const v = VERDICT[r.evaluation?.verdict] ?? VERDICT.incomplete;
        return `<tr><td>${esc(fmtDateTime(r.startedAt))}</td><td>${esc(r.envName)}</td><td class="num">${esc(fmtDuration(r.metrics?.rtoSec))}</td><td class="num">${esc(fmtDuration(r.targets?.rtoSeconds))}</td><td class="num">${esc(r.evaluation?.rpo?.measured ? fmtDuration(r.metrics?.rpoSec) : '—')}</td><td class="num">${esc(fmtDuration(r.targets?.rpoSeconds))}</td><td class="num">${esc(fmtPct(r.metrics?.availabilityPct))}</td><td style="color:${v.color};font-weight:700">${v.label}</td></tr>`;
      })
      .join('') || '<tr><td colspan="8" class="muted">Nenhum exercício executado ainda.</td></tr>'
  }</tbody></table>`;
  const ops = runs.filter((r) => r.kind !== 'drill');
  if (ops.length) {
    body += `<h2>Operações manuais (ligar/desligar)</h2><table><thead><tr><th>Data</th><th>Operação</th><th>Status</th><th class="num">Duração</th></tr></thead><tbody>${ops.map((r) => `<tr><td>${esc(fmtDateTime(r.startedAt))}</td><td>${esc(KIND_LABEL[r.kind])}</td><td>${esc(STATUS_LABEL[r.status] ?? r.status)}</td><td class="num">${esc(fmtDuration(r.durationSec))}</td></tr>`).join('')}</tbody></table>`;
  }
  return page('Relatório consolidado de RTO/RPO', body);
}
