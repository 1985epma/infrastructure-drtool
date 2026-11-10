// Helpers de captura de imagens: caixas (uniões de elementos), anotações numeradas e screenshot da viewport.
import { join } from 'node:path';
import { IMG } from './lib.mjs';

/** Caixa (coordenadas da viewport) de um Locator ou seletor. */
export async function boxOf(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`Elemento não visível: ${typeof target === 'string' ? target : 'locator'}`);
  return box;
}

/** Menor retângulo que contém todas as caixas. */
export function unionBox(...boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.width));
  const b = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: r - x, height: b - y };
}

/**
 * Anel + marcador numerado sobre CAIXAS já calculadas.
 * items: [{ box, n, pad?, corner?: 'tl'|'tr'|'bl'|'br' }]
 */
export async function annotateBoxes(page, items) {
  await page.evaluate((list) => {
    const COLOR = '#ff6d00';
    // <dialog> modal vive na camada superior do navegador: as anotações precisam ficar DENTRO dele
    const host = document.querySelector('dialog[open]') ?? document.body;
    for (const { box, n, pad = 6, corner = 'tl' } of list) {
      const ring = document.createElement('div');
      ring.className = '__ann';
      Object.assign(ring.style, { position: 'fixed', left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`, border: `3px solid ${COLOR}`, borderRadius: '12px', boxShadow: '0 0 0 2px rgba(255,255,255,.85)', pointerEvents: 'none', zIndex: 2147483000 });
      const badge = document.createElement('div');
      badge.className = '__ann';
      badge.textContent = String(n);
      const left = corner.endsWith('r') ? box.x + box.width + pad - 14 : box.x - pad - 14;
      const top = corner.startsWith('b') ? box.y + box.height + pad - 14 : box.y - pad - 14;
      Object.assign(badge.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, width: '28px', height: '28px', borderRadius: '50%', background: COLOR, color: '#fff', font: '700 16px/28px system-ui, sans-serif', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.45), 0 0 0 2px #fff', pointerEvents: 'none', zIndex: 2147483001 });
      host.append(ring, badge);
    }
  }, items);
}

/**
 * Tira o screenshot da viewport em docs/img/<name>.png.
 * marks: [{ target?: Locator|seletor, box?: caixa, n, pad?, corner? }] — desenhados antes e removidos depois.
 */
export async function shot(page, name, { marks = [], height, wait = 500 } = {}) {
  const vp = page.viewportSize();
  if (height && vp.height !== height) await page.setViewportSize({ width: vp.width, height });
  await page.waitForTimeout(wait);
  const items = [];
  for (const m of marks) items.push({ box: m.box ?? (await boxOf(page, m.target)), n: m.n, pad: m.pad, corner: m.corner });
  await annotateBoxes(page, items);
  await page.screenshot({ path: join(IMG, `${name}.png`) });
  await page.evaluate(() => document.querySelectorAll('.__ann').forEach((e) => e.remove()));
  console.log(`  ✔ ${name}.png`);
}

/** Rola até o elemento deixando `offset` px livres acima (a barra superior do app é fixa). */
export async function scrollToTop(page, target, offset = 120) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  await loc.evaluate((el, off) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off), offset);
  await page.waitForTimeout(250);
}
