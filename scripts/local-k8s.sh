#!/bin/sh
# Liga/desliga workloads de um cluster Kubernetes LOCAL para exercícios de RTO/RPO.
# Uso: local-k8s.sh status|stop|start
# Só mexe nos deployments listados em WORKLOADS (formato namespace/nome:réplicas).
# Para outro cluster: KUBE_CONTEXT=kind-nuvem WORKLOADS="default/api:2" ./local-k8s.sh stop

CTX="${KUBE_CONTEXT:-docker-desktop}"
WORKLOADS="${WORKLOADS:-kube-system/coredns:2 local-path-storage/local-path-provisioner:1}"

k() { kubectl --context "$CTX" --request-timeout=15s "$@"; }

each() { # each <função>  — chama a função com ns, nome, réplicas
  for w in $WORKLOADS; do
    ns=${w%%/*}; rest=${w#*/}; name=${rest%%:*}; replicas=${rest##*:}
    "$1" "$ns" "$name" "$replicas" || return 1
  done
}

do_stop()  { echo "Escalando $1/$2 para 0"; k -n "$1" scale deploy "$2" --replicas=0; }
do_start() { echo "Restaurando $1/$2 para $3 réplica(s)"; k -n "$1" scale deploy "$2" --replicas="$3"; }
do_wait()  { k -n "$1" rollout status deploy/"$2" --timeout=180s; }

case "$1" in
  stop)
    each do_stop || exit 1
    sleep 2
    ;;
  start)
    each do_start || exit 1
    each do_wait || exit 1
    ;;
  status)
    total=0; zero=0; ready=0
    for w in $WORKLOADS; do
      ns=${w%%/*}; rest=${w#*/}; name=${rest%%:*}
      spec=$(k -n "$ns" get deploy "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || { echo unknown; exit 0; }
      rdy=$(k -n "$ns" get deploy "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
      total=$((total + 1))
      [ "${spec:-0}" -eq 0 ] && zero=$((zero + 1))
      [ "${spec:-0}" -gt 0 ] && [ "${rdy:-0}" -ge "${spec:-0}" ] && ready=$((ready + 1))
    done
    if [ "$zero" -eq "$total" ]; then echo stopped
    elif [ "$ready" -eq "$total" ]; then echo running
    else echo transitioning
    fi
    ;;
  *)
    echo "uso: $0 status|stop|start" >&2
    exit 2
    ;;
esac
