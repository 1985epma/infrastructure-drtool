#!/usr/bin/env node
// `kubectl` FALSO usado só nos testes (test/k8s-discover.test.js).
// Estado: JSON em FAKE_KUBE_STATE · Log: uma linha JSON por chamada em FAKE_KUBE_LOG.
// FAKE_KUBE_STORE_STATE (opcional): arquivo de estado do Store; seu conteúdo é anexado ao log de `scale`
// (`storeState`) para provar que o snapshot foi gravado ANTES de escalar.
//
// Estado: { contexts, current, ticks, unreachable, workloads: { "ns/kind/nome": {desired, ready, current, settle} } }
// Convergência: após um `scale`, as réplicas só convergem depois de `ticks` leituras (get) do workload.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_KUBE_STATE;
const LOG = process.env.FAKE_KUBE_LOG;
// `node --test` executa todo .mjs dentro de test/: sem estado configurado, sai sem fazer nada.
if (!STATE) process.exit(0);

const argv = process.argv.slice(2);
const globals = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--kubeconfig' || a === '--context') globals[a.slice(2)] = argv[++i];
  else if (!a.startsWith('--request-timeout')) args.push(a);
}

// lock por diretório (o provider chama o kubectl em paralelo)
const LOCK = `${STATE}.lock`;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 2000; i++) {
  try {
    mkdirSync(LOCK);
    break;
  } catch {
    nap(5);
  }
}
const unlock = () => {
  try {
    rmdirSync(LOCK);
  } catch {
    /* já liberado */
  }
};
process.on('exit', unlock);

const s = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(s));
const log = (extra = {}) => LOG && appendFileSync(LOG, `${JSON.stringify({ argv, globals, args, ...extra })}\n`);
const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const KINDS = { deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet' };
const singular = (k) => String(k).replace(/s$/, '');
const key = (ns, kind, name) => `${ns}/${kind}/${name}`;

/** Avança a convergência (uma "leitura") e devolve o objeto no formato do kubectl. */
function view(k) {
  const w = s.workloads[k];
  const [namespace, kind, name] = k.split('/');
  if (w.settle > 0 && --w.settle === 0) {
    w.current = w.desired;
    w.ready = w.desired;
  }
  return {
    apiVersion: 'apps/v1',
    kind: KINDS[kind],
    metadata: { name, namespace },
    spec: { replicas: w.desired },
    status: { replicas: w.current || undefined, readyReplicas: w.ready || undefined },
  };
}

const cmd = args[0];
if (cmd === 'version') {
  log();
  console.log('Client Version: v0.0.0-fake');
  process.exit(0);
}
if (cmd === 'config') {
  log();
  if (args[1] === 'get-contexts') console.log((s.contexts ?? []).join('\n'));
  else if (args[1] === 'current-context') {
    if (!s.current) die('error: current-context is not set');
    console.log(s.current);
  }
  process.exit(0);
}

// demais comandos falam com o "cluster"
let extra = {};
if (cmd === 'scale') {
  let storeState = null;
  try {
    storeState = JSON.parse(readFileSync(process.env.FAKE_KUBE_STORE_STATE, 'utf8'));
  } catch {
    /* sem estado ainda */
  }
  extra = { storeState };
}
log(extra);
if (globals.context && s.contexts && !s.contexts.includes(globals.context)) die(`error: context "${globals.context}" does not exist`);
if (s.unreachable) die('The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?');

if (cmd === 'get') {
  if (args.includes('-A')) {
    const kinds = args[1].split(',').map(singular);
    const items = Object.keys(s.workloads)
      .filter((k) => kinds.includes(k.split('/')[1]))
      .map(view);
    save();
    console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
    process.exit(0);
  }
  const kind = singular(args[1]);
  const name = args[2];
  const ns = flag('-n') ?? 'default';
  const k = key(ns, kind, name);
  if (!s.workloads[k]) die(`Error from server (NotFound): ${kind}s.apps "${name}" not found`);
  const out = view(k);
  save();
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (cmd === 'scale') {
  const [kind, name] = args[1].split('/');
  const ns = flag('-n') ?? 'default';
  const replicas = Number((args.find((a) => a.startsWith('--replicas=')) ?? '').split('=')[1]);
  const k = key(ns, kind, name);
  if (!s.workloads[k]) die(`Error from server (NotFound): ${kind}s.apps "${name}" not found`);
  const w = s.workloads[k];
  w.desired = replicas;
  if (replicas > 0) w.current = replicas; // pods "criados", ainda não prontos
  w.settle = s.ticks ?? 2;
  save();
  console.log(`${kind}.apps/${name} scaled`);
  process.exit(0);
}

die(`fake-kubectl: comando não suportado: ${args.join(' ')}`, 2);
