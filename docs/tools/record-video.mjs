// Grava o vídeo de ~60 s do guia (docs/video/demo-60s.mp4 + poster.jpg) com dados FICTÍCIOS.
// Uso: docs/tools/run-capture.sh video   (sobe a instância isolada e chama este script)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, ENV_NAME, VIDEO, caption, click, hideCard, installOverlays, launch, moveTo, seedEnvironment, showCard, sleep } from './lib.mjs';

const TARGET_SEC = 60; // duração final do vídeo
const TRIM_START = 0.5; // descarta os primeiros quadros (página em branco antes do cartão de abertura)
const REC_DIR = join(VIDEO, '_rec');
const OUT_MP4 = join(VIDEO, 'demo-60s.mp4');
const OUT_POSTER = join(VIDEO, 'poster.jpg');

rmSync(REC_DIR, { recursive: true, force: true });
rmSync(join(VIDEO, '_smoke'), { recursive: true, force: true });

const env = await seedEnvironment();
if (env.name !== ENV_NAME) throw new Error('seed não aplicou o ambiente fictício');

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: REC_DIR, size: { width: 1280, height: 720 } }, colorScheme: 'light', locale: 'pt-BR' });
await installOverlays(ctx);
const page = await ctx.newPage();
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const at = async (sec) => {
  const ms = t0 + sec * 1000 - Date.now();
  if (ms > 0) await sleep(ms);
};
const log = (m) => console.log(`[${elapsed().toFixed(1).padStart(5)}s] ${m}`);
const nav = (name) => page.getByRole('link', { name });
const card = (title) => page.locator('section.card', { has: page.getByRole('heading', { name: title }) }).first();

// ---------- 0–3,5 s: cartão de abertura ----------
await page.goto(`${BASE}/#/painel`, { waitUntil: 'domcontentloaded' });
await showCard(page, { title: 'Como testar RTO e RPO', subtitle: 'EPMA | Infrastructure & DR Tool — demonstração com dados fictícios' });
await page.waitForSelector('text=Saúde das aplicações');
await page.mouse.move(640, 360);
await at(3.5);
await hideCard(page);

// ---------- 3,5–11 s: Painel ----------
log('painel');
await caption(page, '1 · Painel: estado do ambiente e saúde das aplicações em tempo real');
await moveTo(page, page.locator('.kpi').first(), { steps: 45 });
await at(6);
await moveTo(page, card('Infraestrutura').getByRole('heading', { name: 'Infraestrutura' }), { steps: 35 });
await at(8);
await moveTo(page, card('Saúde das aplicações').locator('.chk').nth(1), { steps: 40 });
await at(9.8);
await moveTo(page, card('Console da operação').getByRole('heading', { name: 'Console da operação' }), { steps: 30 });
await at(11);

// ---------- 11–17 s: Testes ----------
log('testes');
await click(page, nav('Testes'), { steps: 35 });
await caption(page, '2 · Testes: HTTP, TCP, Kubernetes ou comando — os críticos definem a disponibilidade');
await page.getByRole('heading', { name: /^Testes \(/ }).waitFor();
await moveTo(page, page.locator('table.table tbody tr').first(), { steps: 35 });
await at(13.5);
await moveTo(page, page.locator('table.table tbody tr').nth(1), { steps: 20 });
await at(14.2);
for (let i = 0; i < 14; i++) {
  await page.mouse.wheel(0, 45);
  await sleep(70);
}
await moveTo(page, page.getByRole('heading', { name: 'Fonte de dados para o RPO' }), { steps: 25 });
await at(17);

// ---------- 17–23 s: Exercício ----------
log('exercicio');
await click(page, nav(/Exercício RTO\/RPO/), { steps: 35 });
await page.evaluate(() => window.scrollTo(0, 0));
await caption(page, '3 · Exercício: metas, parâmetros e medição de RPO automática');
await page.getByRole('heading', { name: 'Configurar exercício' }).waitFor();
await moveTo(page, page.locator('.form-grid input').first(), { steps: 35 });
await at(19.5);
await moveTo(page, page.getByText('Abrir o relatório automaticamente ao finalizar'), { steps: 25 });
await at(21);
await click(page, page.getByRole('button', { name: 'Iniciar exercício' }), { steps: 30 });
const confirm = page.getByRole('button', { name: 'Desligar e medir' });
await confirm.waitFor();
await sleep(900);
await click(page, confirm, { steps: 25 });
log('exercício iniciado');

// ---------- ao vivo: legenda conforme a fase ----------
await page.getByRole('heading', { name: 'Acompanhamento ao vivo' }).waitFor();
await page.getByRole('heading', { name: 'Acompanhamento ao vivo' }).evaluate((h) => h.scrollIntoView({ behavior: 'smooth', block: 'start' }));
await sleep(900);
await page.evaluate(() => window.scrollBy({ top: -150, behavior: 'smooth' })); // o topo fixo cobriria o passo a passo
const CAPTIONS = {
  falha: '4 · A falha é injetada: o relógio do RTO começa',
  recuperacao: '5 · Recuperação: o ambiente religa e os testes voltam a passar',
  rpo: '6 · RTO apurado — a medição de RPO inicia automaticamente',
};
const phaseOf = (t) => (/Medição de RPO|Relatório/.test(t) ? 'rpo' : /Recuperação|Validação/.test(t) ? 'recuperacao' : /Falha|Acionamento/.test(t) ? 'falha' : null);
let current = null;
let posterAt = null;
const liveDeadline = Date.now() + 90_000;
while (Date.now() < liveDeadline && !page.url().includes('#/relatorios')) {
  const txt = await page.locator('.step.active').first().textContent({ timeout: 400 }).catch(() => null);
  let phase = txt ? phaseOf(txt) : null;
  // o marco "Serviço restaurado" acende no instante em que o RTO é apurado (a fase de RPO dura milissegundos)
  if (phase === 'recuperacao' && (await page.locator('.mark.hit', { hasText: 'Serviço restaurado' }).count().catch(() => 0))) phase = 'rpo';
  if (phase && phase !== current) {
    current = phase;
    await caption(page, CAPTIONS[phase]);
    log(`fase: ${phase}`);
    if (phase === 'falha' && !posterAt) posterAt = elapsed() + 2.6; // timer do RTO correndo + faixa vermelha
  }
  await sleep(200);
}
if (!page.url().includes('#/relatorios')) throw new Error('o app não redirecionou para o relatório ao final do exercício');

// ---------- relatório automático ----------
log('relatório');
if (current !== 'rpo') await caption(page, CAPTIONS.rpo);
await sleep(3000);
await caption(page, '7 · Relatório automático: RTO, RPO, linha do tempo e disponibilidade');
const frame = page.locator('iframe.frame');
await frame.waitFor();
await moveTo(page, frame, { steps: 30 });
const endScroll = TARGET_SEC - 3.3; // o cartão final entra em ~56,7 s
const remainingMs = Math.max(2500, (t0 + endScroll * 1000) - Date.now());
const stepMs = 130;
const steps = Math.floor(remainingMs / stepMs);
const pxPerStep = Math.min(40, Math.round(2300 / steps));
for (let i = 0; i < steps; i++) {
  await page.mouse.wheel(0, pxPerStep);
  await sleep(stepMs);
}

// ---------- 57–60 s: cartão final ----------
await at(TARGET_SEC - 3.3);
await caption(page, null);
await showCard(page, { title: 'Guia completo no repositório', subtitle: 'docs/guia-de-testes.md', footer: 'github.com/1985epma/infrastructure-drtool' });
log('cartão final');
await at(TARGET_SEC + 1.6);

const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();
log(`gravado: ${webm}`);

// ---------- conversão (ffmpeg do sistema) ----------
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} falhou:\n${r.stderr}`);
  return r.stdout.trim();
};
const duration = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));

run('ffmpeg', ['-y', '-ss', String(TRIM_START), '-i', webm, '-t', String(TARGET_SEC), '-vf', 'fps=30,scale=1280:720,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', '-an', OUT_MP4]);
let dur = duration(OUT_MP4);
if (dur < TARGET_SEC - 0.5) {
  // faltou um pouco: repete o último quadro
  const tmp = join(VIDEO, '_pad.mp4');
  run('ffmpeg', ['-y', '-i', OUT_MP4, '-vf', `tpad=stop_mode=clone:stop_duration=${(TARGET_SEC - dur).toFixed(2)}`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', tmp]);
  run('mv', [tmp, OUT_MP4]);
  dur = duration(OUT_MP4);
}
console.log(`duração final: ${dur.toFixed(2)} s`);

// pôster: quadro da tela ao vivo (RTO correndo, faixa vermelha)
const posterTime = Math.max(1, (posterAt ?? 30) - TRIM_START);
run('ffmpeg', ['-y', '-ss', posterTime.toFixed(2), '-i', OUT_MP4, '-frames:v', '1', '-q:v', '3', OUT_POSTER]);
console.log(`pôster: t=${posterTime.toFixed(1)} s`);

// limpeza: fica só o mp4 e o jpg
rmSync(REC_DIR, { recursive: true, force: true });
for (const f of readdirSync(VIDEO)) if (!['demo-60s.mp4', 'poster.jpg'].includes(f)) rmSync(join(VIDEO, f), { recursive: true, force: true });
if (!existsSync(OUT_MP4) || !existsSync(OUT_POSTER)) throw new Error('arquivos finais ausentes');
console.log('ok:', OUT_MP4);
