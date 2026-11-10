// Utilitários compartilhados pelos scripts que geram as imagens e o vídeo do guia.
// Tudo roda contra uma instância ISOLADA (ver run-capture.sh) e usa apenas dados FICTÍCIOS.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3099';
export const DOCS = resolve(process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
export const IMG = join(DOCS, 'img');
export const VIDEO = join(DOCS, 'video');
mkdirSync(IMG, { recursive: true });
mkdirSync(VIDEO, { recursive: true });

export const ENV_NAME = 'Acme Pagamentos — Produção (fictício)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- navegador ----------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function chromePath() {
  const p = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new Error('Chrome/Chromium não encontrado. Defina CHROME_PATH.');
  return p;
}

export const launch = () => chromium.launch({ executablePath: chromePath(), headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });

// ---------- API ----------
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error ?? ''} ${(data?.details ?? []).join('; ')}`);
  return data;
}

/**
 * Transforma o ambiente de demonstração (simulado) em um ambiente FICTÍCIO "Acme Pagamentos".
 * Idempotente. Retorna o ambiente salvo.
 */
export async function seedEnvironment() {
  const [env] = await api('/environments');
  const names = ['API de Pagamentos — /health', 'Portal do Cliente', 'Worker de Pedidos (k8s)'];
  Object.assign(env, {
    name: ENV_NAME,
    description: 'Ambiente FICTÍCIO usado neste guia. Nomes, dados e métricas não representam nenhum sistema real.',
    targets: { rtoSeconds: 90, rpoSeconds: 30 },
    drill: { holdDownSeconds: 6, probeIntervalSeconds: 1, stableProbes: 3, maxRecoverySeconds: 120 },
    simulated: { stopSeconds: 3, startSeconds: 8, warmupSeconds: 4, replicationLagSeconds: 8 },
  });
  env.checks = env.checks.map((c, i) => ({ ...c, name: names[i] ?? c.name, ...(c.type === 'k8s' ? { namespace: 'pagamentos', resource: 'worker-pedidos' } : {}) }));
  return api(`/environments/${env.id}`, { method: 'PUT', body: env });
}

// ---------- anotações numeradas (para as imagens) ----------
const resolveBox = async (page, target) => {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`Elemento não visível para anotar: ${typeof target === 'string' ? target : 'locator'}`);
  return box;
};

/**
 * Desenha anel + marcador numerado sobre elementos. Use só em screenshots da viewport (não fullPage).
 * marks: [{ target: Locator|seletor, n: 1, pad?: 6, corner?: 'tl'|'tr'|'bl'|'br' }]
 */
export async function annotate(page, marks) {
  const boxes = [];
  for (const { target, n, pad, corner } of marks) boxes.push({ n, pad, corner, box: await resolveBox(page, target) }); // sem o Locator (não serializa)
  await page.evaluate((items) => {
    const COLOR = '#ff6d00';
    for (const { box, n, pad = 6, corner = 'tl' } of items) {
      const ring = document.createElement('div');
      ring.className = '__ann';
      Object.assign(ring.style, { position: 'fixed', left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`, border: `3px solid ${COLOR}`, borderRadius: '12px', boxShadow: '0 0 0 2px rgba(255,255,255,.85)', pointerEvents: 'none', zIndex: 2147483000 });
      const badge = document.createElement('div');
      badge.className = '__ann';
      badge.textContent = String(n);
      const left = corner.endsWith('r') ? box.x + box.width + pad - 14 : box.x - pad - 14;
      const top = corner.startsWith('b') ? box.y + box.height + pad - 14 : box.y - pad - 14;
      Object.assign(badge.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, width: '28px', height: '28px', borderRadius: '50%', background: COLOR, color: '#fff', font: '700 16px/28px system-ui, sans-serif', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.45), 0 0 0 2px #fff', pointerEvents: 'none', zIndex: 2147483001 });
      document.body.append(ring, badge);
    }
  }, boxes);
}

export const clearAnnotations = (page) => page.evaluate(() => document.querySelectorAll('.__ann').forEach((e) => e.remove()));

// ---------- cursor visível, legenda e cartões (para o vídeo) ----------
/** Injeta cursor, barra de legenda e cartões de título/fim em TODA página do contexto. */
export async function installOverlays(context) {
  await context.addInitScript(() => {
    const init = () => {
      if (document.getElementById('__cursor')) return;
      const css = document.createElement('style');
      css.textContent = `
        #__cursor{position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,109,0,.35);border:3px solid #ff6d00;z-index:2147483646;pointer-events:none;transition:transform .12s}
        #__cursor.down{transform:scale(.7);background:rgba(255,109,0,.7)}
        #__caption{position:fixed;left:50%;bottom:26px;transform:translate(-50%,16px);max-width:86%;padding:12px 22px;border-radius:14px;background:rgba(32,26,38,.94);color:#fff;font:500 21px/1.3 system-ui,-apple-system,sans-serif;letter-spacing:.2px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .35s,transform .35s;z-index:2147483645;pointer-events:none}
        #__caption.on{opacity:1;transform:translate(-50%,0)}
        #__card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:linear-gradient(135deg,#3b2a6d,#6750a4 55%,#9a82db);color:#fff;font-family:system-ui,-apple-system,sans-serif;text-align:center;z-index:2147483647;opacity:0;pointer-events:none;transition:opacity .6s}
        #__card.on{opacity:1}
        #__card h1{margin:0;font-size:54px;font-weight:600;letter-spacing:-.5px}
        #__card h2{margin:0;font-size:24px;font-weight:400;opacity:.92}
        #__card p{margin:18px 0 0;font-size:19px;opacity:.85;font-family:ui-monospace,Menlo,monospace}`;
      const cur = Object.assign(document.createElement('div'), { id: '__cursor' });
      const cap = Object.assign(document.createElement('div'), { id: '__caption' });
      const card = Object.assign(document.createElement('div'), { id: '__card' });
      document.head.append(css);
      document.body.append(cur, cap, card);
      addEventListener('mousemove', (e) => { cur.style.left = `${e.clientX}px`; cur.style.top = `${e.clientY}px`; }, true);
      addEventListener('mousedown', () => cur.classList.add('down'), true);
      addEventListener('mouseup', () => cur.classList.remove('down'), true);
      window.__setCaption = (t) => { if (t) { cap.textContent = t; cap.classList.add('on'); } else cap.classList.remove('on'); };
      window.__setCard = (c) => {
        if (!c) return card.classList.remove('on');
        card.replaceChildren();
        for (const [tag, text] of [['h1', c.title], ['h2', c.subtitle], ['p', c.footer]]) if (text) card.append(Object.assign(document.createElement(tag), { textContent: text }));
        card.classList.add('on');
      };
    };
    if (document.body) init();
    else addEventListener('DOMContentLoaded', init);
  });
}

export const caption = (page, text) => page.evaluate((t) => window.__setCaption?.(t), text ?? null);
export const showCard = (page, card) => page.evaluate((c) => window.__setCard?.(c), card);
export const hideCard = (page) => page.evaluate(() => window.__setCard?.(null));

/** Move o cursor (com trajetória suave) até o centro do elemento. */
export async function moveTo(page, target, { steps = 28, dx = 0, dy = 0 } = {}) {
  const box = await resolveBox(page, target);
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps });
}

/** Move o cursor até o elemento e clica. */
export async function click(page, target, opts = {}) {
  await moveTo(page, target, opts);
  await sleep(150);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
