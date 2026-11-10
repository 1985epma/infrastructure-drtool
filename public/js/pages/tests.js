// Testes de aplicação (HTTP/TCP/k8s/comando) e fonte de dados para o RPO.
import { api } from '../api.js';
import { btn, clear, confirmDialog, emptyState, fmtDateTime, fmtDur, h, openDialog, toast } from '../dom.js';
import { apiErrorText, checkField, field, numInput, selectInput, textInput } from '../forms.js';
import { currentEnv, on, runChecks, saveEnv, state } from '../state.js';
import { buildRpoCard } from '../rpo-card.js';

const TYPE_LABEL = { http: 'HTTP(S)', tcp: 'Porta TCP', k8s: 'Kubernetes', command: 'Comando' };

function summary(c) {
  switch (c.type) {
    case 'http':
      return `${c.method} ${c.url}`;
    case 'tcp':
      return `${c.host}:${c.port}`;
    case 'k8s':
      return `${c.kind} ${c.namespace}/${c.resource}`;
    default:
      return c.command;
  }
}

/** Formulário de um teste. Retorna { el, read } — read() devolve o objeto cru para a API validar. */
function checkForm(initial) {
  const c = { type: 'http', critical: true, method: 'GET', expectStatus: '200-399', timeoutMs: 5000, maxLatencyMs: 0, kind: 'deployment', namespace: 'default', port: 443, timeoutSec: 20, ...initial };
  const name = textInput(c.name ?? '', { placeholder: 'Ex.: API de pagamentos /health' });
  const type = selectInput(Object.entries(TYPE_LABEL), c.type);
  const crit = checkField('Crítico (define se o serviço está disponível)', c.critical);
  const specific = h('div', { class: 'form-grid' });
  let refs = {};

  function renderSpecific() {
    clear(specific);
    refs = {};
    const t = type.value;
    const add = (key, label, input, hint, span) => {
      refs[key] = input;
      const f = field(label, input, hint);
      if (span) f.classList.add('span');
      specific.append(f);
    };
    if (t === 'http') {
      add('url', 'URL', textInput(c.url ?? '', { placeholder: 'https://app.exemplo.com/health ou {{origin}}/…' }), 'Use {{origin}} para o endereço deste console.', true);
      add('method', 'Método', selectInput([['GET', 'GET'], ['HEAD', 'HEAD']], c.method));
      add('expectStatus', 'Status esperado', textInput(c.expectStatus), 'Ex.: 200 · 200-299 · 200,204');
      add('contains', 'Corpo deve conter (opcional)', textInput(c.contains ?? ''));
      add('timeoutMs', 'Timeout (ms)', numInput(c.timeoutMs, { min: 200, max: 60000 }));
      add('maxLatencyMs', 'Latência máxima (ms, 0 = sem limite)', numInput(c.maxLatencyMs, { min: 0, max: 60000 }));
      const tls = checkField('Ignorar erros de certificado TLS (autoassinado)', c.insecureTls);
      refs.insecureTls = tls.input;
      specific.append(h('div', { class: 'span' }, tls.el));
    } else if (t === 'tcp') {
      add('host', 'Host', textInput(c.host ?? '', { placeholder: 'db.interno.exemplo.com' }));
      add('port', 'Porta', numInput(c.port, { min: 1, max: 65535 }));
      add('timeoutMs', 'Timeout (ms)', numInput(c.timeoutMs ?? 3000, { min: 200, max: 60000 }));
    } else if (t === 'k8s') {
      add('kind', 'Tipo', selectInput([['deployment', 'Deployment'], ['statefulset', 'StatefulSet'], ['daemonset', 'DaemonSet']], c.kind));
      add('namespace', 'Namespace', textInput(c.namespace));
      add('resource', 'Nome do recurso', textInput(c.resource ?? ''), 'Passa quando todas as réplicas estão prontas (requer kubectl/kubeconfig).');
    } else {
      add('command', 'Comando', textInput(c.command ?? '', { placeholder: 'curl -fsS https://… ou ./scripts/smoke.sh' }), 'Executado sem shell (argv). Sucesso = código de saída 0.', true);
      add('timeoutSec', 'Timeout (s)', numInput(c.timeoutSec, { min: 1, max: 300 }));
    }
  }
  type.addEventListener('change', renderSpecific);
  renderSpecific();

  return {
    el: h('div', { class: 'form-grid' }, h('div', { class: 'span' }, field('Nome', name)), field('Tipo', type), h('div', { style: 'align-self:end' }, crit.el), h('div', { class: 'span' }, specific)),
    read() {
      const out = { id: initial?.id, name: name.value, type: type.value, critical: crit.input.checked };
      for (const [k, el] of Object.entries(refs)) out[k] = el.type === 'checkbox' ? el.checked : el.value;
      return out;
    },
  };
}

export function mount(root) {
  const env = currentEnv();
  if (!env) return root.append(emptyState('Nenhum ambiente configurado', '', h('a', { class: 'btn primary', href: '#/config' }, 'Configurar ambiente')));
  const offs = [];

  async function persist(mutator) {
    const draft = structuredClone(env);
    mutator(draft);
    try {
      const saved = await saveEnv(draft);
      Object.assign(env, saved);
      return true;
    } catch (err) {
      toast(apiErrorText(err), 'error');
      return false;
    }
  }

  function editCheck(existing) {
    const form = checkForm(existing);
    openDialog({
      title: existing ? 'Editar teste' : 'Novo teste',
      content: form.el,
      wide: true,
      actions: [
        { label: 'Cancelar', onClick: (close) => close() },
        {
          label: 'Salvar',
          kind: 'primary',
          onClick: async (close) => {
            const data = form.read();
            const ok = await persist((d) => {
              const i = d.checks.findIndex((c) => c.id === existing?.id);
              if (i >= 0) d.checks[i] = data;
              else d.checks.push(data);
            });
            if (ok) {
              close();
              renderChecks();
              runChecks(existing?.id).catch(() => {});
            }
          },
        },
      ],
    });
  }

  async function removeCheck(c) {
    const ok = await confirmDialog({ title: 'Excluir teste', message: `Excluir o teste "${c.name}"?`, confirmLabel: 'Excluir', danger: true });
    if (ok && (await persist((d) => (d.checks = d.checks.filter((x) => x.id !== c.id))))) renderChecks();
  }

  // ---------- lista de testes ----------
  const tbody = h('tbody');
  const runAllBtn = btn('Executar todos', { icon: 'play', onClick: runAll });
  let busy = new Set();

  async function runOne(id) {
    busy.add(id ?? '*');
    renderChecks();
    try {
      await runChecks(id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy.delete(id ?? '*');
      renderChecks();
    }
  }
  function runAll() {
    return runOne(undefined);
  }

  function renderChecks() {
    runAllBtn.disabled = busy.size > 0 || env.checks.length === 0;
    clear(tbody);
    const res = state.results[env.id] ?? {};
    if (!env.checks.length) {
      tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Nenhum teste cadastrado. Cadastre ao menos um teste crítico para poder executar exercícios.')));
      return;
    }
    for (const c of env.checks) {
      const r = res[c.id];
      tbody.append(
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted mono' }, summary(c))),
          h('td', {}, h('span', { class: 'tag' }, TYPE_LABEL[c.type]), ' ', c.critical ? h('span', { class: 'pill info' }, 'crítico') : h('span', { class: 'tag' }, 'não crítico')),
          h('td', {}, busy.has(c.id) || busy.has('*') ? h('span', { class: 'spinner' }) : r ? h('span', { class: `pill ${r.ok ? 'ok' : 'bad'}` }, r.ok ? 'OK' : 'Falha') : h('span', { class: 'muted' }, '—'), r ? h('div', { class: 'muted' }, r.detail) : null),
          h('td', { class: 'num muted' }, r ? `${Math.round(r.ms)} ms` : ''),
          h('td', { class: 'num' }, btn('', { icon: 'play', kind: 'ghost icon-btn', title: 'Executar', onClick: () => runOne(c.id) }), btn('', { icon: 'edit', kind: 'ghost icon-btn', title: 'Editar', onClick: () => editCheck(c) }), btn('', { icon: 'trash', kind: 'ghost icon-btn', title: 'Excluir', onClick: () => removeCheck(c) })),
        ),
      );
    }
  }

  root.append(
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, 'Testes de aplicação'), h('p', {}, `Os testes críticos definem quando "${env.name}" está disponível — são a base do cálculo de RTO.`))),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, `Testes (${env.checks.length})`), h('div', { class: 'card-actions' }, runAllBtn, btn('Novo teste', { kind: 'primary', icon: 'plus', onClick: () => editCheck(null) }))),
      h('div', { class: 'card-b flush table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Teste'), h('th', {}, 'Tipo'), h('th', {}, 'Último resultado'), h('th', { class: 'num' }, 'Latência'), h('th', {}))), tbody)),
    ),
    buildRpoCard(env, { title: "Fonte de dados para o RPO" }),
  );
  renderChecks();
  offs.push(on('checks', renderChecks));
  return () => offs.forEach((o) => o());
}
