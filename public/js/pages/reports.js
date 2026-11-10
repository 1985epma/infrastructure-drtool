// Relatórios: histórico de execuções, visualização do relatório, downloads e observações.
import { api, apiText, download, openInTab } from '../api.js';
import { btn, card, clear, confirmDialog, emptyState, fmtDateTime, fmtDur, h, toast, verdictPill } from '../dom.js';
import { apiErrorText, textArea } from '../forms.js';
import { currentEnv, loadRuns, on, state } from '../state.js';

const KIND = { drill: 'Exercício', start: 'Ligar', stop: 'Desligar' };
const STATUS = { completed: ['Concluído', 'ok'], failed: ['Falhou', 'bad'], timeout: ['Tempo esgotado', 'bad'], cancelled: ['Cancelado', 'warn'] };

export function mount(root, { query } = {}) {
  const env = currentEnv();
  if (!env) {
    root.append(emptyState('Nenhum ambiente configurado', 'Crie um ambiente para gerar relatórios.', h('a', { class: 'btn primary', href: '#/config' }, 'Configurar ambiente')));
    return;
  }
  const offs = [];
  let selected = query?.get('run') || null; // id da execução, ou 'summary'
  let loadToken = 0;

  const tbody = h('tbody');
  const viewer = h('div', { class: 'card-b' });
  const viewerActions = h('div', { class: 'card-actions' });
  const viewerTitle = h('h2', {}, 'Relatório');

  const select = (id) => {
    const q = id ? `?run=${encodeURIComponent(id)}` : '';
    location.hash = `#/relatorios${q}`; // dispara remontagem com a nova seleção
  };

  // ---------- lista ----------
  function renderList() {
    clear(tbody);
    if (!state.runs.length) {
      tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Nenhuma execução registrada ainda. Execute um exercício ou ligue/desligue o ambiente.')));
      return;
    }
    for (const r of state.runs) {
      const [stLabel, stKind] = STATUS[r.status] ?? [r.status, 'off'];
      const status = r.kind === 'drill' && r.evaluation ? verdictPill(r.evaluation.verdict) : h('span', { class: `pill ${stKind}` }, stLabel);
      const rpo = r.kind === 'drill' && r.evaluation?.rpo?.measured ? fmtDur(r.metrics?.rpoSec) : '—';
      tbody.append(
        h(
          'tr',
          { class: `click${r.id === selected ? ' sel' : ''}`, tabindex: 0, onclick: () => select(r.id), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select(r.id)) },
          h('td', {}, fmtDateTime(r.startedAt)),
          h('td', {}, KIND[r.kind] ?? r.kind),
          h('td', {}, status),
          h('td', { class: 'num' }, r.kind === 'drill' ? fmtDur(r.metrics?.rtoSec) : fmtDur(r.durationSec)),
          h('td', { class: 'num' }, rpo),
        ),
      );
    }
  }

  // ---------- visualização ----------
  const dlBtn = (label, path, filename) =>
    btn(label, {
      icon: 'download',
      onClick: async () => {
        try {
          await download(path, filename);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });

  const openBtn = (path, print) =>
    btn(print ? 'Abrir / Imprimir (PDF)' : 'Abrir em nova aba', {
      icon: print ? 'print' : 'file',
      onClick: () => openInTab(path, { print }).catch((err) => toast(err.message, 'error')),
    });

  async function showSummary(token) {
    const path = `/reports/summary.html?envId=${encodeURIComponent(env.id)}`;
    viewerTitle.textContent = 'Relatório consolidado';
    clear(viewerActions).append(openBtn(path, true), dlBtn('HTML', `${path}&download=1`, 'relatorio-consolidado.html'));
    clear(viewer).append(h('span', { class: 'spinner' }));
    try {
      const html = await apiText(path);
      if (token !== loadToken) return;
      clear(viewer).append(h('iframe', { class: 'frame', sandbox: '', title: 'Relatório consolidado', srcdoc: html }));
    } catch (err) {
      if (token === loadToken) clear(viewer).append(h('div', { class: 'note bad' }, err.message));
    }
  }

  async function showRun(id, token) {
    const base = `/runs/${encodeURIComponent(id)}`;
    const meta = state.runs.find((r) => r.id === id);
    viewerTitle.textContent = meta ? `${KIND[meta.kind] ?? 'Relatório'} · ${fmtDateTime(meta.startedAt)}` : 'Relatório';
    clear(viewer).append(h('span', { class: 'spinner' }));
    clear(viewerActions);
    let run;
    let html;
    try {
      [run, html] = await Promise.all([api(base), apiText(`${base}/report.html`)]);
    } catch (err) {
      if (token === loadToken) clear(viewer).append(h('div', { class: 'note bad' }, err.status === 404 ? 'Execução não encontrada (talvez tenha sido excluída).' : err.message));
      return;
    }
    if (token !== loadToken) return;

    const name = (ext) => `relatorio-${run.kind}-${run.id}.${ext}`;
    viewerActions.append(
      openBtn(`${base}/report.html`, true),
      dlBtn('HTML', `${base}/report.html?download=1`, name('html')),
      dlBtn('Markdown', `${base}/report.md?download=1`, name('md')),
      run.kind === 'drill' ? dlBtn('CSV', `${base}/report.csv?download=1`, name('csv')) : null,
      dlBtn('JSON', `${base}/report.json?download=1`, name('json')),
      btn('Excluir', { kind: 'danger', icon: 'trash', onClick: () => remove(run) }),
    );

    const notes = textArea(run.notes ?? '', { maxlength: 5000, placeholder: 'Observações do exercício (aparecem no relatório)…', 'aria-label': 'Observações' });
    const saveBtn = btn('Salvar observações', {
      kind: 'primary',
      onClick: async () => {
        saveBtn.disabled = true;
        try {
          await api(base, { method: 'PATCH', body: { notes: notes.value } });
          toast('Observações salvas.', 'ok');
          const fresh = await apiText(`${base}/report.html`);
          const frame = viewer.querySelector('iframe');
          if (frame && token === loadToken) frame.srcdoc = fresh;
        } catch (err) {
          toast(apiErrorText(err), 'error');
        } finally {
          saveBtn.disabled = false;
        }
      },
    });

    clear(viewer).append(
      h('iframe', { class: 'frame', sandbox: '', title: `Relatório ${run.id}`, srcdoc: html }),
      h('div', { class: 'field', style: 'margin-top:14px' }, h('label', {}, 'Observações'), notes, h('div', { class: 'row' }, saveBtn)),
    );
  }

  async function remove(run) {
    const ok = await confirmDialog({ title: 'Excluir execução', message: `Excluir permanentemente o registro ${run.id} (${fmtDateTime(run.startedAt)})? Esta ação não pode ser desfeita.`, confirmLabel: 'Excluir', danger: true });
    if (!ok) return;
    try {
      await api(`/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
      toast('Execução excluída.', 'ok');
      await loadRuns();
      select(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderViewer() {
    const token = ++loadToken;
    if (selected === 'summary') return showSummary(token);
    if (selected) return showRun(selected, token);
    viewerTitle.textContent = 'Relatório';
    clear(viewerActions);
    clear(viewer).append(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Selecione uma execução na lista ou abra o relatório consolidado.')));
  }

  // ---------- montagem ----------
  root.append(
    h(
      'div',
      { class: 'page-h' },
      h('div', {}, h('h1', {}, 'Relatórios'), h('p', {}, `Histórico de exercícios e operações de "${env.name}".`)),
      btn('Relatório consolidado', { icon: 'file', kind: selected === 'summary' ? 'primary' : '', onClick: () => select('summary') }),
    ),
    h(
      'div',
      { class: 'reports' },
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', {}, 'Execuções'), h('div', { class: 'card-actions' }, btn('', { icon: 'refresh', kind: 'ghost icon-btn', title: 'Atualizar', onClick: loadRuns }))),
        h('div', { class: 'card-b flush table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Tipo'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'RTO / duração'), h('th', { class: 'num' }, 'RPO'))), tbody)),
      ),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, viewerTitle, viewerActions), viewer),
    ),
  );

  renderList();
  renderViewer();
  offs.push(on('runs', renderList));
  loadRuns();
  return () => {
    loadToken++;
    offs.forEach((o) => o());
  };
}
