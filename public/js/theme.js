// Tema: Material Design 3 (único estilo) com modo Auto/Claro/Escuro, persistido no navegador.
const K_MODE = 'epma-theme-mode';

export const MODES = [
  ['system', 'Auto'],
  ['light', 'Claro'],
  ['dark', 'Escuro'],
];

export function getMode() {
  try {
    const v = localStorage.getItem(K_MODE);
    return MODES.some(([k]) => k === v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme() {
  const root = document.documentElement;
  const mode = getMode();
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  root.setAttribute('data-style', 'm3');
}

export function setMode(mode) {
  try {
    localStorage.setItem(K_MODE, mode);
  } catch {
    /* storage indisponível: vale só nesta sessão */
  }
  applyTheme();
}

// limpa a preferência do antigo seletor de estilo (removido)
try {
  localStorage.removeItem('epma-theme-style');
} catch {
  /* ignora */
}
