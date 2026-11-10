#!/usr/bin/env node
// Ponto de entrada (também o executável `epma-drtool` do pacote npm).
// Configuração por variáveis de ambiente:
//   PORT (3001) · HOST (127.0.0.1) · DATA_DIR (./data, relativo à pasta onde o comando roda)
//   ADMIN_TOKEN (ou ADMIN_TOKEN_FILE: caminho de um arquivo/secret com o token) · ALLOWED_HOSTS (lista separada por vírgula)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, isLoopback } from './src/app.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`EPMA | Infrastructure & DR Tool v${pkg.version}

Uso: epma-drtool [--help] [--version]

Variáveis de ambiente:
  PORT           porta HTTP (padrão 3001)
  HOST           endereço de escuta (padrão 127.0.0.1; outro valor exige ADMIN_TOKEN)
  DATA_DIR       pasta de dados: ambientes, relatórios e estado (padrão ./data)
  ADMIN_TOKEN    token (mín. 16 caracteres) exigido pela API; obrigatório fora do localhost
  ADMIN_TOKEN_FILE  alternativa ao ADMIN_TOKEN: arquivo com o token (ex.: Docker secret em /run/secrets/…)
  ALLOWED_HOSTS  hosts adicionais aceitos no cabeçalho Host, separados por vírgula

Requer Node >= ${pkg.engines.node.replace('>=', '')}. Opcionais: aws CLI, kubectl e docker.`);
  process.exit(0);
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
let adminToken = process.env.ADMIN_TOKEN || '';
if (!adminToken && process.env.ADMIN_TOKEN_FILE) {
  try {
    adminToken = readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch (err) {
    console.error(`Não foi possível ler ADMIN_TOKEN_FILE: ${err.message}`);
    process.exit(1);
  }
}
const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Esta ferramenta liga/desliga infraestrutura: só aceita conexões externas com token.
if (!isLoopback(host) && !adminToken) {
  console.error(`Recusando iniciar em HOST=${host} sem ADMIN_TOKEN.\nDefina ADMIN_TOKEN=<segredo longo> para expor o console além do localhost.`);
  process.exit(1);
}
if (adminToken && adminToken.length < 16) {
  console.error('ADMIN_TOKEN muito curto: use ao menos 16 caracteres.');
  process.exit(1);
}

// Os dados ficam na pasta de trabalho (não dentro do pacote instalado, que é substituído nas atualizações).
const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const app = await createApp({ host, port, adminToken, allowedHosts, dataDir });
const seeded = await app.seedDemo();
const { port: actual } = await app.listen();

console.log(`EPMA | Infrastructure & DR Tool rodando em http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}  (Node ${process.version})`);
console.log(`Dados em ${dataDir}`);
if (seeded) console.log('Ambiente de demonstração (simulado) criado — experimente o fluxo completo sem AWS.');
if (adminToken) console.log('Autenticação por token habilitada.');

const shutdown = async (sig) => {
  console.log(`\n${sig} recebido, encerrando…`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
