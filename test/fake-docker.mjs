#!/usr/bin/env node
// `docker` FALSO usado só nos testes (test/k8s-discover.test.js).
// Estado: JSON em FAKE_DOCKER_STATE ({ containers: [{Names, Image, Status, State, Ports}], fail?: "msg" }).
import { appendFileSync, readFileSync } from 'node:fs';

const STATE = process.env.FAKE_DOCKER_STATE;
// `node --test` executa todo .mjs dentro de test/: sem estado configurado, sai sem fazer nada.
if (!STATE) process.exit(0);
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ args })}\n`);
const s = JSON.parse(readFileSync(STATE, 'utf8'));

if (args[0] === '--version') {
  console.log('Docker version 99.0.0, build fake');
} else if (args[0] === 'ps') {
  if (s.fail) {
    process.stderr.write(`${s.fail}\n`);
    process.exit(1);
  }
  for (const c of s.containers ?? []) console.log(JSON.stringify(c));
} else {
  process.stderr.write(`fake-docker: comando não suportado: ${args.join(' ')}\n`);
  process.exit(2);
}
