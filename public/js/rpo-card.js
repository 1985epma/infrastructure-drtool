// Cartão de configuração/teste da medição de RPO — usado na página do exercício e em Testes.
import { api } from './api.js';
import { btn, clear, fmtDateTime, fmtDur, h, toast } from './dom.js';
import { apiErrorText, field, numInput, selectInput, textInput } from './forms.js';
import { saveEnv } from './state.js';

const TYPES = [
  ['none', 'Não medir RPO'],
  ['canary', 'Canário de gravação (recomendado)'],
  ['http', 'Endpoint HTTP (JSON com timestamp)'],
  ['command', 'Comando (imprime timestamp)'],
  ['rds-instance', 'AWS RDS — instância (LatestRestorableTime)'],
  ['rds-cluster', 'AWS RDS/Aurora — cluster (LatestRestorableTime)'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);

export function buildRpoCard(env, { title = 'Medição de RPO' } = {}) {
  const s = { type: 'none', timeoutMs: 8000, timeoutSec: 30, intervalSeconds: 2, ...env.rpoSource };
  const type = selectInput(TYPES, s.type);
  const holder = h('div', { class: 'form-grid' });
  const result = h('div');
  const chip = h('span');
  let refs = {};

  function renderChip(t) {
    clear(chip).append(t === 'none' ? h('span', { class: 'pill warn' }, 'RPO não será medido') : h('span', { class: 'pill ok' }, `RPO: ${TYPE_LABEL[t]}`));
  }

  function render(values = s) {
    clear(holder);
    refs = {};
    const add = (key, label, input, hint, span) => {
      refs[key] = input;
      const f = field(label, input, hint);
      if (span) f.classList.add('span');
      holder.append(f);
    };
    const t = type.value;
    if (t === 'canary') {
      add('writeCommand', 'Comando de gravação', textInput(values.writeCommand ?? '', { placeholder: `sh -c 'redis-cli SET epma:canary "$CANARY_VALUE"'` }), 'Recebe a variável CANARY_VALUE (ISO-8601 do instante). Sucesso = código de saída 0. Sem shell: para expandir a variável use sh -c.', true);
      add('readCommand', 'Comando de leitura', textInput(values.readCommand ?? '', { placeholder: 'redis-cli GET epma:canary' }), 'Deve imprimir o último valor gravado que sobreviveu (ISO-8601 ou epoch).', true);
      add('intervalSeconds', 'Intervalo de gravação (s)', numInput(values.intervalSeconds ?? 2, { min: 1, max: 60 }), 'É também a resolução da medição de RPO.');
      add('timeoutSec', 'Timeout dos comandos (s)', numInput(values.timeoutSec ?? 20, { min: 1, max: 300 }));
    } else if (t === 'http') {
      add('url', 'URL', textInput(values.url ?? '', { placeholder: 'https://app.exemplo.com/internal/last-write' }), 'Endpoint que devolve o timestamp do dado durável mais recente. Use {{origin}} para o endereço deste console.', true);
      add('jsonPath', 'Caminho JSON do timestamp', textInput(values.jsonPath ?? '', { placeholder: 'lastWriteAt' }), 'Ex.: data.lastWriteAt · aceita ISO-8601 ou epoch. Vazio = corpo inteiro.');
      add('timeoutMs', 'Timeout (ms)', numInput(values.timeoutMs ?? 8000, { min: 200, max: 60000 }));
    } else if (t === 'command') {
      add('command', 'Comando', textInput(values.command ?? '', { placeholder: "psql -At -c 'select max(created_at) from orders'" }), 'Última linha da saída deve ser ISO-8601 ou epoch. Executado sem shell.', true);
      add('timeoutSec', 'Timeout (s)', numInput(values.timeoutSec ?? 30, { min: 1, max: 300 }));
    } else if (t === 'rds-instance' || t === 'rds-cluster') {
      add('identifier', t === 'rds-cluster' ? 'Identificador do cluster' : 'Identificador da instância', textInput(values.identifier ?? ''));
      add('region', 'Região', textInput(values.region ?? '', { placeholder: 'us-east-1' }));
      add('profile', 'Perfil AWS (opcional)', textInput(values.profile ?? ''));
    } else {
      holder.append(h('div', { class: 'note warn span' }, 'Sem fonte de RPO, o exercício mede apenas o RTO. Escolha o canário de gravação para medir também a perda de dados.'));
    }
    renderChip(t);
  }
  type.addEventListener('change', () => render({}));
  render();

  const read = () => ({ type: type.value, ...Object.fromEntries(Object.entries(refs).map(([k, el]) => [k, el.value])) });

  async function persist() {
    const draft = structuredClone(env);
    draft.rpoSource = read();
    try {
      Object.assign(env, await saveEnv(draft));
      renderChip(env.rpoSource.type);
      return true;
    } catch (err) {
      toast(apiErrorText(err), 'error');
      return false;
    }
  }

  async function save() {
    if (await persist()) toast('Medição de RPO salva.', 'ok');
  }

  async function test() {
    if (type.value === 'none') return toast('Escolha uma fonte de RPO para testar.', 'warn');
    if (!(await persist())) return;
    clear(result).append(h('span', { class: 'spinner' }));
    try {
      if (type.value === 'canary') {
        const r = await api(`/environments/${env.id}/rpo/canary-test`, { method: 'POST', body: {} });
        clear(result).append(h('div', { class: `note ${r.match ? '' : 'bad'}` }, `Gravou ${fmtDateTime(r.written)} → leu ${fmtDateTime(r.read)} — ${r.match ? 'o valor gravado foi lido de volta ✔' : 'o valor lido é mais antigo que o gravado ✘ (a gravação não está sendo persistida/lida corretamente)'}`));
      } else {
        const r = await api(`/environments/${env.id}/rpo/read`, { method: 'POST', body: {} });
        clear(result).append(h('div', { class: 'note' }, `Dado mais recente: ${fmtDateTime(r.at)} (há ${fmtDur(r.ageSec)}) — valor bruto: ${r.raw ?? ''}`));
      }
    } catch (err) {
      clear(result).append(h('div', { class: 'note bad' }, err.message));
    }
  }

  /** Preenche um exemplo funcional: canário em ConfigMap do Kubernetes (mecanismo; não é um datastore real). */
  function fillExample() {
    const ctx = env.custom?.kubeContext ? ` --context ${env.custom.kubeContext}` : '';
    type.value = 'canary';
    render({
      writeCommand: `sh -c 'kubectl${ctx} create configmap epma-canary --from-literal=ts="$CANARY_VALUE" --dry-run=client -o yaml | kubectl${ctx} apply -f -'`,
      readCommand: `kubectl${ctx} get configmap epma-canary -o jsonpath={.data.ts}`,
      intervalSeconds: 2,
      timeoutSec: 20,
    });
    toast('Exemplo preenchido — clique em Testar para validar.', 'info');
  }

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-h' }, h('div', { class: 'row' }, h('h2', {}, title), chip), h('div', { class: 'card-actions' }, btn('Exemplo (ConfigMap k8s)', { onClick: fillExample }), btn('Testar', { icon: 'refresh', onClick: test }), btn('Salvar', { kind: 'primary', onClick: save }))),
    h(
      'div',
      { class: 'card-b' },
      h('p', { class: 'muted' }, 'O RPO é a janela de dados que se aceita perder. No modo canário o console grava um valor com timestamp a cada poucos segundos até o instante da falha; depois da recuperação lê o valor de volta. RPO = o dado confirmado antes da falha que não voltou (zero = nada perdido).'),
      field('Como medir', type),
      holder,
      result,
    ),
  );
}
