// Gera as 19 imagens do guia (docs/img/*.png) dirigindo o Chrome contra uma instância isolada.
// Dados 100% FICTÍCIOS: ver seedEnvironment() em lib.mjs e o kubectl/docker falsos de run-capture.sh.
//
//   docs/tools/run-capture.sh images            # tudo
//   ONLY=02,03 docs/tools/run-capture.sh images # só as imagens cujo nome começa com 02 ou 03
import { BASE, ENV_NAME, api, launch, seedEnvironment, sleep } from './lib.mjs';
import { boxOf, scrollToTop, shot, unionBox } from './shots.mjs';

const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (prefix) => !ONLY.length || ONLY.some((o) => prefix.startsWith(o));
const failures = [];

async function step(name, fn) {
  if (!want(name)) return;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err.message.split('\n')[0]}`);
    console.error(`  ✘ ${name}: ${err.message.split('\n')[0]}`);
  }
}

const WIDTH = 1200;
const DSF = 1.5;
const next = (page) => page.locator('.wz-foot').getByRole('button', { name: /Avançar|Criar ambiente/ });
const allGreen = (page, n = 3) => page.waitForFunction((k) => document.querySelectorAll('.chk .led.ok').length >= k, n, { timeout: 30_000 });
const card = (page, title) => page.locator(`section.card:has(h2:text-is("${title}"))`);

/** Aguarda o job atual terminar (via API) e devolve o último estado. */
async function waitJob(maxSec = 120) {
  for (let i = 0; i < maxSec * 2; i++) {
    const j = await api('/job');
    if (j.status !== 'running' && j.status !== 'idle') return j;
    await sleep(500);
  }
  throw new Error('o exercício não terminou a tempo');
}

/** Navega (hash do SPA) e volta ao topo: a rolagem da etapa anterior não pode vazar para a imagem. */
async function go(p, hash) {
  await p.goto(`${BASE}/${hash}`);
  await p.evaluate(() => window.scrollTo(0, 0));
}

const env = await seedEnvironment();
console.log(`▶ ambiente fictício: ${env.name}`);

const browser = await launch();
const newContext = (colorScheme = 'light') =>
  browser.newContext({ viewport: { width: WIDTH, height: 760 }, deviceScaleFactor: DSF, colorScheme, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });

const ctx = await newContext('light');
// relatório automático desligado: a tela do exercício precisa mostrar o resultado antes de redirecionar
await ctx.addInitScript(() => localStorage.setItem('eksdr-autoreport', '0'));
await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: '#toasts{display:none !important}' }))));
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

// ============================================================ 02–06 — Wizard
await step('02', async () => {
  await go(page, '#/config');
  await page.getByRole('button', { name: /Novo ambiente/ }).click();
  await page.getByLabel('Nome do ambiente').fill('Acme Pagamentos — Staging (fictício)');
  await page.getByLabel(/Descrição/).fill('Cópia de staging do ambiente fictício, usada como exemplo no guia.');
  await shot(page, '02-wizard-basico', {
    height: 1040,
    marks: [
      { box: unionBox(await boxOf(page, '.field:has(label:text("Nome do ambiente"))'), await boxOf(page, '.field:has(label:text("Descrição"))')), n: 1 },
      { target: '[role=radiogroup][aria-label="Base de computação"]', n: 2 },
      { target: '.wz-opts:not([role=radiogroup])', n: 3 },
    ],
  });
});

await step('03', async () => {
  await next(page).click();
  await page.waitForSelector('.wz-table tbody tr');
  await page.waitForSelector('.wz-loading', { state: 'detached' });
  await shot(page, '03-wizard-kubernetes', {
    height: 1000,
    marks: [
      { target: '.field:has(label:text("Contexto do kubectl"))', n: 1 },
      { target: '.wz-table', n: 2 },
    ],
  });
});

await step('04', async () => {
  await next(page).click();
  await page.waitForSelector('text=Testes de aplicação');
  await page.waitForSelector('.wz-table tbody tr');
  const th = await boxOf(page, '.wz-table th:has-text("Crítico")');
  const lastCell = await boxOf(page, '.wz-table tbody tr:last-child td:nth-child(4)');
  await shot(page, '04-wizard-testes', {
    height: 960,
    marks: [
      { target: '.wz-table', n: 1 },
      { box: unionBox(th, lastCell), n: 2, corner: 'tr' },
      { target: 'fieldset.wz-fs', n: 3 },
    ],
  });
});

await step('05', async () => {
  await next(page).click();
  await page.waitForSelector('text=Como medir o RPO');
  await page.waitForSelector('.wz-loading', { state: 'detached' });
  await page.getByLabel('Meta de RTO (segundos)').fill('90');
  await page.getByLabel('Meta de RPO (segundos)').fill('30');
  await shot(page, '05-wizard-rpo-metas', {
    height: 1040,
    marks: [
      { target: '[role=radiogroup][aria-label="Método de RPO"]', n: 1 },
      { target: '.wz-section:has(h2:text-is("Metas"))', n: 2 },
      { target: 'details.wz-adv', n: 3 },
    ],
  });
});

await step('06', async () => {
  await next(page).click();
  await page.waitForSelector('.wz-review');
  await shot(page, '06-wizard-revisao', {
    height: 820,
    marks: [
      { target: '.wz-review', n: 1 },
      { target: next(page), n: 2 },
    ],
  });
  // NÃO cria o ambiente: sai do wizard
  await go(page, '#/painel');
});

// ============================================================ 07–08 — Testes
await step('07', async () => {
  await go(page, '#/testes');
  await page.getByRole('button', { name: 'Executar todos' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody .pill.ok').length >= 3);
  const row = 'tbody tr:first-child';
  await shot(page, '07-testes-lista', {
    height: 900,
    marks: [
      { target: page.getByRole('button', { name: 'Executar todos' }), n: 1 },
      { target: page.getByRole('button', { name: 'Novo teste' }), n: 2 },
      { box: unionBox(await boxOf(page, `${row} td:nth-child(3)`), await boxOf(page, 'tbody tr:last-child td:nth-child(3)')), n: 3 },
      { box: unionBox(await boxOf(page, `${row} td:last-child`), await boxOf(page, 'tbody tr:last-child td:last-child')), n: 4, corner: 'tr' },
    ],
  });
});

await step('08', async () => {
  await go(page, '#/testes');
  await page.getByRole('button', { name: 'Novo teste' }).click();
  await page.waitForSelector('dialog.modal[open]');
  await page.locator('dialog.modal input[type=text]').first().fill('API de Pagamentos — /health (exemplo)');
  const dlg = page.locator('dialog.modal');
  await shot(page, '08-testes-novo-teste', {
    height: 900,
    marks: [
      { box: unionBox(await boxOf(page, dlg.locator('.field:has(label:text-is("Nome"))')), await boxOf(page, dlg.locator('.field:has(label:text-is("Tipo"))'))), n: 1 },
      { target: dlg.locator('.field.check').first(), n: 2 },
      { target: dlg.locator('.form-grid .form-grid').first(), n: 3 },
    ],
  });
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
});

// ============================================================ 09 — RPO (canário)
await step('09', async () => {
  await go(page, '#/exercicio');
  const rpo = card(page, 'Medição de RPO');
  await rpo.waitFor();
  await rpo.locator('select').selectOption('canary');
  await rpo.getByLabel('Comando de gravação').fill(`sh -c 'redis-cli SET epma:canary "$CANARY_VALUE"'`);
  await rpo.getByLabel('Comando de leitura').fill('redis-cli GET epma:canary');
  await page.setViewportSize({ width: WIDTH, height: 780 });
  await scrollToTop(page, rpo, 150);
  await shot(page, '09-rpo-canario', {
    height: 780,
    marks: [
      { target: rpo.locator('.field:has(label:text-is("Como medir")) select'), n: 1, pad: 4 },
      { box: unionBox(await boxOf(page, rpo.getByLabel('Comando de gravação')), await boxOf(page, rpo.getByLabel('Comando de leitura'))), n: 2, pad: 4, corner: 'bl' },
      { target: rpo.locator('.card-actions'), n: 3 },
    ],
  });
  // não salva: recarrega para descartar a edição
  await go(page, '#/painel');
});

// ============================================================ 10–14 — Exercício
await step('10', async () => {
  await page.evaluate(() => localStorage.setItem('eksdr-autoreport', '1')); // mostra o padrão (marcado)
  await go(page, '#/painel');
  await go(page, '#/exercicio');
  await card(page, 'Configurar exercício').waitFor();
  const cfg = card(page, 'Configurar exercício');
  await shot(page, '10-exercicio-config', {
    height: 900,
    marks: [
      { target: cfg.locator('.form-grid').first(), n: 1, pad: 2 },
      { target: cfg.locator('.row:has(label:has-text("Abrir o relatório"))'), n: 2, pad: 2, corner: 'tr' },
      { target: cfg.locator('p:has-text("Metas:")'), n: 3, pad: 2, corner: 'tr' },
      { target: cfg.getByRole('button', { name: 'Iniciar exercício' }), n: 4 },
    ],
  });
  await page.evaluate(() => localStorage.setItem('eksdr-autoreport', '0')); // o exercício seguinte precisa mostrar o resultado na página
  await go(page, '#/painel');
});

// 11 — diálogo de confirmação: só pede o nome em ambientes NÃO simulados; usa um ambiente temporário fictício
await step('11-exercicio-confirmacao', async () => {
  const tmp = await api('/environments', {
    method: 'POST',
    body: {
      name: 'Acme Pagamentos — Homologação (fictício)',
      description: 'Ambiente temporário só para fotografar o diálogo de confirmação.',
      provider: 'custom',
      custom: { startCommand: 'echo ligar-exemplo', stopCommand: 'echo desligar-exemplo' },
      checks: [{ name: 'API de Pagamentos — /health', type: 'http', url: 'http://127.0.0.1:9/health' }],
    },
  });
  try {
    await go(page, '#/exercicio');
    await page.reload();
    await page.selectOption('#env-select', tmp.id);
    await card(page, 'Configurar exercício').waitFor();
    await page.getByRole('button', { name: 'Iniciar exercício' }).click();
    await page.waitForSelector('dialog.modal[open]');
    const dlg = page.locator('dialog.modal');
    await dlg.locator('input').fill(tmp.name);
    await sleep(300);
    await shot(page, '11-exercicio-confirmacao', {
      height: 760,
      marks: [
        { target: dlg.locator('.modal-body p').first(), n: 1 },
        { target: dlg.locator('input'), n: 2 },
        { target: dlg.locator('#confirm-ok'), n: 3 },
      ],
    });
    await dlg.getByRole('button', { name: 'Cancelar' }).click();
  } finally {
    await api(`/environments/${tmp.id}`, { method: 'DELETE' });
    await go(page, '#/painel');
    await page.reload();
  }
});

// 12–14 compartilham o MESMO exercício (cada fase dura poucos segundos)
if (want('12') || want('13') || want('14')) {
  try {
    await go(page, '#/exercicio');
    await card(page, 'Configurar exercício').waitFor();
    await page.getByRole('button', { name: 'Iniciar exercício' }).click();
    await page.waitForSelector('dialog.modal[open]');
    await page.locator('dialog.modal #confirm-ok').click(); // ambiente simulado: sem digitar o nome

    const live = card(page, 'Acompanhamento ao vivo');
    await live.waitFor();
    await step('12-exercicio-falha', async () => {
      await page.waitForSelector('.step.active:has-text("Acionamento")');
      await sleep(1500);
      await scrollToTop(page, live, 150);
      await shot(page, '12-exercicio-falha', {
        height: 960,
        marks: [
          { target: live.locator('.stepper'), n: 1 },
          { target: live.locator('div:has(> .big-timer)').first(), n: 2 },
          { target: live.locator('.pill.bad').first(), n: 3 },
          { target: live.locator('.strip'), n: 4 },
          { target: live.locator('.marks'), n: 5 },
          { target: live.locator('.console'), n: 6 },
        ],
      });
    });
    await step('13-exercicio-recuperacao', async () => {
      await page.waitForSelector('.step.active:has-text("Validação")');
      await page.waitForFunction(() => {
        const last = [...document.querySelectorAll('.strip i')].at(-1);
        return last && !last.classList.contains('bad') && !last.classList.contains('empty') && document.querySelector('.step.active')?.textContent.includes('Validação');
      }, undefined, { timeout: 30_000, polling: 100 });
      await scrollToTop(page, live, 150);
      await shot(page, '13-exercicio-recuperacao', {
        height: 960,
        wait: 0,
        marks: [
          { target: live.locator('.step.active'), n: 1 },
          { target: live.locator('.strip'), n: 2 },
          { target: live.locator('.marks'), n: 3 },
        ],
      });
    });
    await step('14-exercicio-resultado', async () => {
      await page.waitForSelector('text=Resultado:');
      await sleep(800);
      await scrollToTop(page, live, 150);
      const res = live.locator('div.row:has(strong:text-is("Resultado:"))');
      await shot(page, '14-exercicio-resultado', {
        height: 960,
        marks: [
          { target: res.locator('.pill'), n: 1, pad: 3, corner: 'tr' },
          { target: live.locator('.kpi').nth(0), n: 2, pad: 3, corner: 'bl' },
          { target: live.locator('.kpi').nth(1), n: 3, pad: 3, corner: 'bl' },
          { target: live.locator('.kpi').nth(2), n: 4, pad: 3, corner: 'br' },
          { target: res.getByRole('link', { name: 'Abrir relatório' }), n: 5, pad: 3, corner: 'tr' },
        ],
      });
    });
    await waitJob();
  } catch (err) {
    failures.push(`12-14: ${err.message.split('\n')[0]}`);
    console.error(`  ✘ 12-14: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================ 15–18 — Relatórios
// segundo exercício (mais rápido) para o consolidado ter mais de um ponto
if (want('15') || want('16') || want('17') || want('18')) {
  const [cur] = await api('/environments');
  cur.simulated = { stopSeconds: 2, startSeconds: 5, warmupSeconds: 2, replicationLagSeconds: 6 };
  cur.drill = { holdDownSeconds: 4, probeIntervalSeconds: 1, stableProbes: 3, maxRecoverySeconds: 120 };
  await api(`/environments/${cur.id}`, { method: 'PUT', body: cur });
  if ((await api(`/runs?envId=${cur.id}`)).length < 2) {
    await api(`/environments/${cur.id}/drill`, { method: 'POST', body: {} });
    await waitJob();
  }
}

const runs = await api(`/runs?envId=${env.id}`);
const latest = runs.find((r) => r.kind === 'drill');

await step('15', async () => {
  await go(page, '#/relatorios');
  await page.waitForSelector('tbody tr.click');
  await page.locator('tbody tr.click').first().click();
  await page.frameLocator('iframe.frame').locator('h1').waitFor();
  await sleep(500);
  const viewer = page.locator('.reports > .card').nth(1);
  const compact = await page.addStyleTag({ content: 'iframe.frame{height:480px !important;min-height:0 !important}' });
  await shot(page, '15-relatorios-lista', {
    height: 1180,
    marks: [
      { target: page.locator('.reports > .card').first(), n: 1 },
      { target: page.locator('iframe.frame'), n: 2 },
      { target: viewer.getByRole('button', { name: 'Abrir / Imprimir (PDF)' }).locator('xpath=..'), n: 3 },
      { target: page.getByRole('button', { name: 'Relatório consolidado' }), n: 4 },
      { target: page.locator('.field:has(textarea[aria-label="Observações"])'), n: 5 },
    ],
  });
  await compact.evaluate((el) => el.remove());
});

const reportPage = await ctx.newPage();
reportPage.setDefaultTimeout(60_000);
await reportPage.setViewportSize({ width: 1100, height: 900 });

await step('16', async () => {
  await reportPage.goto(`${BASE}/api/runs/${latest.id}/report.html`);
  await reportPage.waitForSelector('.kpis');
  await shot(reportPage, '16-relatorio-resumo', {
    height: 940,
    marks: [
      { target: '.head', n: 1 },
      { target: 'h2:text-is("Resumo") + .box', n: 2 },
      { target: '.kpis', n: 3 },
      { target: 'h2:text-is("Linha do tempo") + table', n: 4 },
    ],
  });
});

await step('17', async () => {
  await reportPage.goto(`${BASE}/api/runs/${latest.id}/report.html`);
  await reportPage.waitForSelector('.kpis');
  await scrollToTop(reportPage, 'h2:text-is("Composição do RTO")', 24);
  await shot(reportPage, '17-relatorio-detalhes', {
    height: 1000,
    marks: [
      { box: unionBox(await boxOf(reportPage, '.bar'), await boxOf(reportPage, '.legend')), n: 1 },
      { target: 'svg', n: 2 },
      { target: 'h2:text-is("RPO") + table', n: 3 },
    ],
  });
});

await step('18', async () => {
  await reportPage.goto(`${BASE}/api/reports/summary.html?envId=${encodeURIComponent(env.id)}`);
  await reportPage.waitForSelector('svg');
  await shot(reportPage, '18-relatorio-consolidado', {
    height: 1030,
    marks: [
      { target: '.kpis', n: 1 },
      { box: unionBox(await boxOf(reportPage, 'h2:text-is("Evolução do RTO")'), await boxOf(reportPage, 'h2:text-is("Evolução do RPO") + svg')), n: 2 },
      { target: 'h2:text-is("Exercícios") + table', n: 3 },
    ],
  });
});

// ============================================================ 01 — Painel (depois dos exercícios: KPIs e console preenchidos)
await step('01-painel', async () => {
  await go(page, '#/painel');
  await page.reload();
  await page.waitForSelector('text=Saúde das aplicações');
  await page.waitForSelector('.console .ok, .console div');
  await allGreen(page);
  await sleep(600);
  await shot(page, '01-painel', {
    height: 1340,
    marks: [
      { target: '#env-select', n: 1 },
      { box: unionBox(await boxOf(page, card(page, 'Infraestrutura').locator('.card-actions')), await boxOf(page, card(page, 'Infraestrutura').locator('.pill').first())), n: 2 },
      { target: card(page, 'Saúde das aplicações'), n: 3 },
      { target: card(page, 'Console da operação'), n: 4 },
    ],
  });
});

// ============================================================ 19 — Modo escuro
await step('19', async () => {
  const dark = await newContext('dark');
  const p = await dark.newPage();
  p.setDefaultTimeout(60_000);
  await p.goto(`${BASE}/#/painel`);
  await p.waitForSelector('text=Saúde das aplicações');
  await allGreen(p);
  await sleep(600);
  await shot(p, '19-modo-escuro', { height: 860 });
  await dark.close();
});

await browser.close();
if (failures.length) {
  console.error(`\n✘ ${failures.length} imagem(ns) com problema:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✔ imagens geradas em docs/img/');
