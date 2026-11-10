// Aplica o tema salvo ANTES da primeira pintura (evita "flash" de claro/escuro).
// Script clássico (não-módulo) para executar de forma síncrona no <head>.
(function () {
  var root = document.documentElement;
  root.setAttribute('data-style', 'm3');
  try {
    var mode = localStorage.getItem('epma-theme-mode');
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  } catch (e) {
    /* sem storage: segue o sistema */
  }
})();
