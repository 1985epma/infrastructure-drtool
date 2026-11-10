#!/usr/bin/env bash
# Gera as imagens (docs/img) e o vídeo de 60 s (docs/video) do guia de testes, com dados FICTÍCIOS.
#
#   docs/tools/run-capture.sh [images|video|all]      (padrão: all)
#
# Sobe uma instância ISOLADA do console (pasta de dados temporária, porta própria, `kubectl` e `docker`
# falsos com contextos/workloads/containers fictícios) e dirige o Chrome com Playwright.
# Requisitos: Node >= 26, Google Chrome (ou CHROME_PATH), ffmpeg (só para o vídeo).
# Variáveis: PORT (padrão 3099), CHROME_PATH.
set -euo pipefail

MODE="${1:-all}"
TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
PORT="${PORT:-3099}"
WORK="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin" "$WORK/data"

# kubectl/docker FALSOS (os mesmos dos testes) — só o wizard os usa, para listar contextos e workloads fictícios
for tool in kubectl docker; do
  printf '#!/bin/sh\nexec node "%s/test/fake-%s.mjs" "$@"\n' "$ROOT" "$tool" > "$WORK/bin/$tool"
  chmod +x "$WORK/bin/$tool"
done
cat > "$WORK/kube.json" <<'JSON'
{
  "contexts": ["docker-desktop", "acme-staging"],
  "current": "docker-desktop",
  "ticks": 1,
  "workloads": {
    "pagamentos/deployment/api-pagamentos": { "desired": 3, "ready": 3, "current": 3 },
    "pagamentos/deployment/portal-cliente": { "desired": 2, "ready": 2, "current": 2 },
    "pagamentos/deployment/worker-pedidos": { "desired": 2, "ready": 2, "current": 2 },
    "pagamentos/statefulset/fila-eventos": { "desired": 1, "ready": 1, "current": 1 },
    "kube-system/deployment/coredns": { "desired": 2, "ready": 2, "current": 2 }
  }
}
JSON
cat > "$WORK/docker.json" <<'JSON'
{
  "containers": [
    { "Names": "acme-redis", "Image": "redis:7-alpine", "Status": "Up 3 hours", "State": "running", "Ports": "0.0.0.0:6379->6379/tcp" },
    { "Names": "acme-postgres", "Image": "postgres:16-alpine", "Status": "Up 3 hours", "State": "running", "Ports": "0.0.0.0:5432->5432/tcp" }
  ]
}
JSON

echo "▶ subindo instância isolada em http://127.0.0.1:$PORT (dados fictícios)…"
FAKE_KUBE_STATE="$WORK/kube.json" FAKE_DOCKER_STATE="$WORK/docker.json" \
PATH="$WORK/bin:$PATH" DATA_DIR="$WORK/data" PORT="$PORT" \
  node "$ROOT/server.js" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$PORT/api/meta" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fs "http://127.0.0.1:$PORT/api/meta" >/dev/null || { echo "servidor não subiu:"; cat "$WORK/server.log"; exit 1; }

cd "$TOOLS"
[ -d node_modules ] || npm install --no-audit --no-fund
export BASE_URL="http://127.0.0.1:$PORT"

case "$MODE" in
  images) node capture-images.mjs ;;
  video)  node record-video.mjs ;;
  all)    node capture-images.mjs && node record-video.mjs ;;
  *) echo "uso: $0 [images|video|all]"; exit 2 ;;
esac
# prévia em GIF (aparece inline no README do GitHub; o MP4 completo fica linkado)
if [ "$MODE" != "images" ] && [ -f "$ROOT/docs/video/demo-60s.mp4" ]; then
  ffmpeg -v error -y -i "$ROOT/docs/video/demo-60s.mp4" \
    -vf "fps=6,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop 0 "$ROOT/docs/video/demo-preview.gif"
fi
echo "✔ concluído."
