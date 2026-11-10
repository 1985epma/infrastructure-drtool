// Ponto de entrada. Configuração por variáveis de ambiente:
//   PORT (3001) · HOST (127.0.0.1) · DATA_DIR (./data) · ADMIN_TOKEN · ALLOWED_HOSTS (lista separada por vírgula)
import { createApp, isLoopback } from './src/app.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const adminToken = process.env.ADMIN_TOKEN || '';
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

const app = await createApp({ host, port, adminToken, allowedHosts, dataDir: process.env.DATA_DIR || undefined });
const seeded = await app.seedDemo();
const { port: actual } = await app.listen();

console.log(`EPMA | Infrastructure & DR Tool rodando em http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}  (Node ${process.version})`);
if (seeded) console.log('Ambiente de demonstração (simulado) criado — experimente o fluxo completo sem AWS.');
if (adminToken) console.log('Autenticação por token habilitada.');

const shutdown = async (sig) => {
  console.log(`\n${sig} recebido, encerrando…`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
