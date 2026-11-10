#!/usr/bin/env node
// `aws` CLI FALSO usado só nos testes de DESCOBERTA (test/k8s-discover.test.js; não confundir com fake-aws.mjs).
// Estado: JSON em FAKE_AWSD_STATE com respostas prontas · Log: FAKE_AWSD_LOG (argv + AWS_PROFILE/AWS_REGION).
// Erros imitam a CLI real: stderr "An error occurred (X) when calling the Y operation: msg", exit 254.
import { appendFileSync, readFileSync } from 'node:fs';

const STATE = process.env.FAKE_AWSD_STATE;
// `node --test` executa todo .mjs dentro de test/: sem estado configurado, sai sem fazer nada.
if (!STATE) process.exit(0);

const argv = process.argv.slice(2);
if (process.env.FAKE_AWSD_LOG) {
  appendFileSync(process.env.FAKE_AWSD_LOG, `${JSON.stringify({ argv, env: { AWS_PROFILE: process.env.AWS_PROFILE ?? null, AWS_REGION: process.env.AWS_REGION ?? null } })}\n`);
}
const S = JSON.parse(readFileSync(STATE, 'utf8'));
const [service, op, ...rest] = argv;
const flags = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1];

const pascal = (s) => s.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const fail = (code, msg) => {
  process.stderr.write(`\nAn error occurred (${code}) when calling the ${pascal(op)} operation: ${msg}\n`);
  process.exit(254);
};
const out = (o) => console.log(JSON.stringify(o));

if (service === '--version') {
  console.log('aws-cli/2.0.0 Python/3.x FakeOS/fake');
  process.exit(0);
}

if (service === 'configure') {
  if (op === 'list-profiles') {
    console.log(Object.keys(S.profiles ?? {}).join('\n'));
  } else if (op === 'get') {
    const region = (S.profiles ?? {})[flags.profile];
    if (!region) process.exit(1); // sem região configurada (como a CLI real)
    console.log(region);
  }
  process.exit(0);
}

if (service === 'sts' && op === 'get-caller-identity') {
  if (S.identityError) fail(S.identityError.code, S.identityError.message);
  out({ UserId: 'AIDAFAKE', Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/tester' });
  process.exit(0);
}

if (service === 'eks') {
  const clusters = S.eks ?? {};
  if (op === 'list-clusters') out({ clusters: Object.keys(clusters) });
  else if (op === 'describe-cluster') {
    const c = clusters[flags.name];
    if (!c) fail('ResourceNotFoundException', `No cluster found for name: ${flags.name}.`);
    out({ cluster: { name: flags.name, version: c.version, status: c.status } });
  } else if (op === 'list-nodegroups') out({ nodegroups: Object.keys(clusters[flags['cluster-name']]?.nodegroups ?? {}) });
  else if (op === 'describe-nodegroup') {
    const g = clusters[flags['cluster-name']].nodegroups[flags['nodegroup-name']];
    out({ nodegroup: { nodegroupName: flags['nodegroup-name'], status: g.status, scalingConfig: { minSize: g.min, maxSize: g.max, desiredSize: g.desired }, instanceTypes: g.instanceTypes } });
  }
  process.exit(0);
}

if (service === 'ec2' && op === 'describe-instances') {
  if (S.ec2Error) fail(S.ec2Error.code, S.ec2Error.message);
  out(S.ec2 ?? { Reservations: [] });
  process.exit(0);
}

if (service === 'rds') {
  if (S.rdsError) fail(S.rdsError.code, S.rdsError.message);
  if (op === 'describe-db-instances') out({ DBInstances: S.rdsInstances ?? [] });
  else if (op === 'describe-db-clusters') out({ DBClusters: S.rdsClusters ?? [] });
  process.exit(0);
}

if (service === 'elasticache') {
  if (op === 'describe-replication-groups') {
    if (S.rgError) fail(S.rgError.code, S.rgError.message);
    out({ ReplicationGroups: S.rg ?? [] });
  } else if (op === 'describe-serverless-caches') {
    if (S.svError) fail(S.svError.code, S.svError.message);
    out({ ServerlessCaches: S.sv ?? [] });
  }
  process.exit(0);
}

process.stderr.write(`fake-aws-discover: comando não suportado: ${argv.join(' ')}\n`);
process.exit(2);
