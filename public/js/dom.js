// Helpers de DOM. Textos sempre entram como text nodes (nunca innerHTML) — XSS-safe por construção.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['checked', 'disabled', 'selected', 'readOnly', 'multiple'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => (el.replaceChildren(), el);

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  check: 'M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h6',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M6 4l14 8-14 8z',
  power: 'M12 3v9M6.4 6.4a8 8 0 1011.2 0',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  stop: 'M6 6h12v12H6z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  auto: 'M3 5h18v12H3zM8 21h8M12 17v4',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  print: 'M7 9V4h10v5M7 17H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2M7 14h10v6H7z',
};
export function icon(name, size = 16) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  s.append(p);
  return s;
}

// ---------- formatação ----------
export function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  if (hh) return `${hh}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
  if (mm) return `${mm}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour12: false }) : '—');
export const fmtPct = (n) => (n == null ? '—' : `${n.toFixed(2).replace('.', ',')}%`);

// ---------- toasts ----------
export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 7000 : 3500);
  setTimeout(() => el.remove(), kind === 'error' ? 7400 : 3900);
}

// ---------- diálogos ----------
export function openDialog({ title, content, actions = [], wide = false }) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}` });
  const close = (result) => {
    dlg.returnValue = result ?? '';
    dlg.close();
  };
  dlg.append(
    h('header', {}, h('h3', {}, title), h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': 'Fechar', onclick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, content),
    h('footer', {}, ...actions.map((a) => h('button', { class: `btn ${a.kind ?? ''}`, type: 'button', id: a.id, onclick: () => a.onClick?.(close) }, a.label))),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  dlg.showModal();
  return { dlg, close };
}

/** Confirmação; se `requireText` for informado, o usuário precisa digitá-lo para habilitar o botão. */
export function confirmDialog({ title, message, requireText, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => {
      if (done) return;
      done = true;
      resolve(v);
      close?.();
    };
    const input = requireText ? h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: requireText, 'aria-label': 'Confirmação' }) : null;
    let okBtn;
    const { dlg } = openDialog({
      title,
      content: [h('p', {}, message), requireText ? h('p', { class: 'muted' }, 'Para confirmar, digite o nome do ambiente: ', h('code', {}, requireText)) : null, input],
      actions: [
        { label: 'Cancelar', onClick: (close) => finish(null, close) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', id: 'confirm-ok', onClick: (close) => finish({ text: input?.value ?? '' }, close) },
      ],
    });
    okBtn = dlg.querySelector('#confirm-ok');
    if (input) {
      okBtn.disabled = true;
      input.addEventListener('input', () => (okBtn.disabled = input.value !== requireText));
      input.focus();
    }
    dlg.addEventListener('close', () => finish(null));
  });
}

// ---------- componentes ----------
const STATE_PILL = {
  running: ['Ligado', 'ok'],
  stopped: ['Desligado', 'off'],
  partial: ['Parcial', 'warn'],
  transitioning: ['Em transição', 'info'],
  unknown: ['Desconhecido', 'off'],
  missing: ['Não encontrado', 'bad'],
  error: ['Erro', 'bad'],
};
export function statePill(state) {
  const [label, kind] = STATE_PILL[state] ?? [state ?? '—', 'off'];
  return h('span', { class: `pill ${kind}` }, h('i', { class: 'dot' }), label);
}

const VERDICT = { approved: ['Aprovado', 'ok'], failed: ['Reprovado', 'bad'], incomplete: ['Incompleto', 'warn'] };
export const verdictPill = (v) => {
  const [label, kind] = VERDICT[v] ?? ['—', 'off'];
  return h('span', { class: `pill ${kind}` }, label);
};

export const card = (title, { actions, class: cls = '' } = {}, ...body) =>
  h('section', { class: `card ${cls}` }, h('div', { class: 'card-h' }, h('h2', {}, title), h('div', { class: 'card-actions' }, actions)), h('div', { class: 'card-b' }, body));

export function btn(label, { kind = '', icon: ic, onClick, disabled, title, type = 'button' } = {}) {
  return h('button', { class: `btn ${kind}`, type, disabled, title, onclick: onClick }, ic ? icon(ic) : null, label);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', {}, title), h('p', { class: 'muted' }, text), action);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
