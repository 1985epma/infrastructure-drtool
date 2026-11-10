// Cliente da API. Se o servidor exigir token (ADMIN_TOKEN), pede uma vez e guarda na sessão.
let token = '';
try {
  token = sessionStorage.getItem('eksdr-token') ?? '';
} catch {
  /* storage indisponível */
}
let askToken = null;

export const setAuthHandler = (fn) => (askToken = fn);

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !retried && askToken) {
    const t = await askToken();
    if (t) {
      token = t;
      try {
        sessionStorage.setItem('eksdr-token', t);
      } catch {
        /* ignora */
      }
      return request(path, { method, body }, true);
    }
  }
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* corpo não-JSON */
    }
    throw new ApiError(data.error ?? `Erro HTTP ${res.status}`, res.status, data.details);
  }
  return res;
}

export async function api(path, opts) {
  const res = await request(path, opts);
  if (res.status === 204) return null;
  return res.json();
}

export async function apiText(path) {
  return (await request(path)).text();
}

/** Baixa um recurso autenticado como arquivo. */
export async function download(path, filename) {
  const res = await request(path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Abre um relatório HTML em nova aba (opcionalmente já abrindo o diálogo de impressão/PDF). */
export async function openInTab(path, { print = false } = {}) {
  const html = await apiText(path);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const w = window.open(url, '_blank');
  if (w && print) w.addEventListener('load', () => w.print());
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
