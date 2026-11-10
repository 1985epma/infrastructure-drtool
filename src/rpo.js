// Leitura do "dado durável mais recente" — base do cálculo de RPO.
//
// O RPO medido no exercício é: instante da falha − timestamp do dado mais recente que
// SOBREVIVEU (ver README). Cada fonte abaixo devolve esse timestamp.
import { run } from './exec.js';
import { awsJson } from './providers/eks.js';
import { expandOrigin, httpProbe } from './checks.js';
import { getPath, parseTimestamp, tokenize } from './util.js';

export async function readLastData(env, { origin, signal } = {}) {
  const src = env.rpoSource ?? { type: 'none' };
  switch (src.type) {
    case 'none':
      return { type: 'none', at: null };

    case 'http': {
      const url = expandOrigin(src.url, origin);
      const r = await httpProbe(url, { timeoutMs: src.timeoutMs, insecure: src.insecureTls, wantBody: true, signal });
      if (r.status < 200 || r.status > 299) throw new Error(`Fonte de RPO respondeu HTTP ${r.status}`);
      let raw = r.body.trim();
      if (src.jsonPath) {
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error('A resposta da fonte de RPO não é JSON válido');
        }
        raw = getPath(json, src.jsonPath);
        if (raw === undefined) throw new Error(`Caminho "${src.jsonPath}" não encontrado na resposta`);
      }
      const at = parseTimestamp(raw);
      if (!at) throw new Error(`Valor não reconhecido como data/hora: "${String(raw).slice(0, 60)}"`);
      return { type: 'http', at, raw: String(raw) };
    }

    case 'command':
    case 'canary': {
      const line = src.type === 'canary' ? src.readCommand : src.command;
      const argv = tokenize(line);
      const r = await run(argv[0], argv.slice(1), { timeoutMs: src.timeoutSec * 1000, signal });
      if (r.code !== 0) throw new Error(`Comando de RPO saiu com código ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
      const last = r.stdout.trim().split('\n').pop()?.trim() ?? '';
      const at = parseTimestamp(last);
      if (!at) throw new Error(`Saída não reconhecida como data/hora: "${last.slice(0, 60)}"`);
      return { type: src.type, at, raw: last };
    }

    case 'rds-instance':
    case 'rds-cluster': {
      const isCluster = src.type === 'rds-cluster';
      const data = await awsJson(
        { region: src.region, profile: src.profile },
        isCluster ? ['rds', 'describe-db-clusters', '--db-cluster-identifier', src.identifier] : ['rds', 'describe-db-instances', '--db-instance-identifier', src.identifier],
        { signal },
      );
      const item = isCluster ? data.DBClusters?.[0] : data.DBInstances?.[0];
      const at = parseTimestamp(item?.LatestRestorableTime);
      if (!at) throw new Error('LatestRestorableTime indisponível (backups automáticos/PITR habilitados?)');
      return { type: src.type, at, raw: item.LatestRestorableTime };
    }

    default:
      throw new Error(`Fonte de RPO desconhecida: ${src.type}`);
  }
}

/**
 * Canário: grava `CANARY_VALUE` (ISO-8601 do instante da gravação) com o comando configurado.
 * O comando é executado sem shell; para expandir a variável use `sh -c '… "$CANARY_VALUE" …'`.
 * Retorna o instante gravado (Date). Sucesso = código de saída 0 (gravação confirmada).
 */
export async function canaryWrite(src, { signal } = {}) {
  const value = new Date().toISOString();
  const argv = tokenize(src.writeCommand);
  const r = await run(argv[0], argv.slice(1), { env: { CANARY_VALUE: value }, timeoutMs: src.timeoutSec * 1000, signal });
  if (r.code !== 0) throw new Error(`Comando de gravação saiu com código ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return new Date(value);
}

/** Teste rápido do canário: grava e lê de volta. */
export async function testCanary(env, { signal } = {}) {
  const written = await canaryWrite(env.rpoSource, { signal });
  const read = await readLastData(env, { signal });
  return { written: written.toISOString(), read: read.at.toISOString(), raw: read.raw, match: read.at.getTime() >= written.getTime() };
}

/**
 * RPO do canário = dado confirmado antes da falha que NÃO voltou após a recuperação.
 * (O escritor para no instante da falha, então a leitura não é "mascarada" por gravações novas.)
 */
export function computeCanaryRpoSeconds({ lastAcked, readBack }) {
  if (!(lastAcked instanceof Date) || !(readBack instanceof Date)) return null;
  return Math.max(0, (lastAcked.getTime() - readBack.getTime()) / 1000);
}

/**
 * RPO = max(0, falha − min(dado antes da falha, dado depois da recuperação)).
 *  - se o dado regrediu após a recuperação (after < before) houve perda real;
 *  - se não regrediu, o RPO é a defasagem que já existia no instante da falha.
 */
export function computeRpoSeconds({ failureAt, before, after }) {
  const candidates = [before, after].filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
  if (candidates.length === 0) return null;
  const oldest = Math.min(...candidates.map((d) => d.getTime()));
  return Math.max(0, (failureAt - oldest) / 1000);
}
