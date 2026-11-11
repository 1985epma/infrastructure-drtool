#!/bin/sh
# Gera um kubeconfig MÍNIMO (só um contexto) para o container do console enxergar um cluster local
# (Docker Desktop, kind…). Dentro do container, 127.0.0.1 é o próprio container; por isso o servidor
# é reescrito para host.docker.internal, mantendo a verificação de TLS (tls-server-name=localhost,
# que consta no certificado do apiserver).
#
# Uso:  scripts/kubeconfig-for-container.sh [contexto] [arquivo-de-saída]
#       (padrão: docker-desktop → secrets/kubeconfig-docker-desktop.yaml)
# Depois: docker compose -f compose.yaml -f compose.k8s.yaml up -d
#
# O Docker Desktop muda a porta do apiserver ao reiniciar o Kubernetes: rode o script de novo.
set -eu
CTX="${1:-docker-desktop}"
OUT="${2:-secrets/kubeconfig-$CTX.yaml}"

umask 077 # o arquivo contém credenciais do cluster
mkdir -p "$(dirname "$OUT")"
kubectl config view --minify --flatten --context "$CTX" > "$OUT"

get() { kubectl config view --kubeconfig "$OUT" -o "jsonpath=$1"; }
server=$(get '{.clusters[0].cluster.server}')
cluster=$(get '{.clusters[0].name}')

case "$server" in
  https://127.0.0.1:*|https://localhost:*)
    port=${server##*:}
    kubectl config set-cluster "$cluster" --kubeconfig "$OUT" \
      --server="https://host.docker.internal:${port%/}" --tls-server-name=localhost >/dev/null
    ;;
  *) echo "aviso: servidor $server não é local; mantido como está." >&2 ;;
esac

echo "kubeconfig do contexto '$CTX' gravado em $OUT (servidor: $(get '{.clusters[0].cluster.server}'))"
