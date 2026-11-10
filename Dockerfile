# syntax=docker/dockerfile:1.7
#
# EPMA | Infrastructure & DR Tool — imagem endurecida.
#
#   docker build -t infrastructure-drtool .
#   docker build --build-arg RUN_TESTS=true -t infrastructure-drtool .   # roda a suíte no build
#   docker build --build-arg WITH_TOOLS=false -t infrastructure-drtool:slim .   # sem aws CLI/kubectl
#
# Endurecimento aplicado:
#   • base fixada por digest (reprodutível; atualize o digest para receber patches de segurança)
#   • multi-stage: o estágio final não tem testes, caches nem ferramentas de build
#   • sem dependências npm (o app usa só a stdlib do Node): superfície mínima na cadeia de suprimentos
#   • npm/npx/corepack/yarn removidos; apk removido (nada instala pacotes em runtime); bits setuid/setgid zerados
#   • código em /app pertence ao root e é somente leitura; único diretório gravável é /data
#   • usuário não-root (uid 10001), sem shell de login, tini como PID 1
#   • Node Permission Model: o processo só lê /app, /data e /run/secrets, só grava em /data e não carrega addons/WASI/workers
#   • escuta em 0.0.0.0 mas recusa subir sem token (ADMIN_TOKEN ou ADMIN_TOKEN_FILE)
#   • HEALTHCHECK sem depender de curl/wget; sem segredos nas camadas
#
# Pin atual: node:26-alpine (Node 26.13.0 / Alpine 3.24.4).
ARG NODE_IMAGE=node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

# ---------------------------------------------------------------------------
# Estágio 1 — valida e monta a árvore da aplicação
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src

COPY package.json server.js LICENSE README.md ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# falha cedo se algum arquivo JS não compila
RUN set -eu; for f in server.js src/*.js src/providers/*.js; do node --check "$f"; done

# opcional: roda a suíte de testes dentro do build
ARG RUN_TESTS=false
RUN if [ "$RUN_TESTS" = "true" ]; then node --test; fi

# descarta o que não vai para a imagem final e remove permissão de escrita para group/other
RUN rm -rf test && chmod +x scripts/*.sh && chmod -R go-w /src

# ---------------------------------------------------------------------------
# Estágio 2 — runtime mínimo
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=dev
ARG VCS_REF=unknown
# WITH_TOOLS=false gera uma imagem enxuta (~260 MB contra ~600 MB) sem aws CLI/kubectl: serve para provider simulado/custom
# ou quando as credenciais e comandos ficam fora. Com WITH_TOOLS=true (padrão) a imagem inclui ambos.
ARG WITH_TOOLS=true
LABEL org.opencontainers.image.title="EPMA | Infrastructure & DR Tool" \
      org.opencontainers.image.description="Console web para exercícios de RTO/RPO (EKS, EC2, RDS, ElastiCache, Kubernetes local)" \
      org.opencontainers.image.source="https://github.com/1985epma/infrastructure-drtool" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# Ferramentas que o console aciona (aws CLI v2, kubectl) + tini (PID 1 / reaping de processos filhos).
# `docker-cli` NÃO é instalado de propósito: usar o Docker do host exigiria montar o docker.sock (equivale a root no host).
RUN set -eu; \
    apk add --no-cache tini; \
    if [ "$WITH_TOOLS" = "true" ]; then apk add --no-cache aws-cli kubectl; fi; \
    # remove o que não é usado em runtime (menos superfície, menos CVEs)
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/docker-entrypoint.sh /opt/* /root/.npm /root/.cache /var/cache/apk/* /tmp/*; \
    # usuário dedicado, sem shell de login e sem senha
    addgroup -g 10001 -S app; \
    adduser -u 10001 -S -G app -h /home/app -s /sbin/nologin app; \
    mkdir -p /data /home/app; \
    chown -R app:app /data /home/app; \
    chmod 700 /data /home/app; \
    # zera setuid/setgid e impede instalar pacotes em runtime
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + 2>/dev/null || true; \
    rm -f /sbin/apk

# código: dono root, somente leitura para o usuário do app
COPY --from=build --chown=root:root /src /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/data \
    HOME=/home/app \
    AWS_PAGER="" \
    AWS_CLI_AUTO_PROMPT=off

USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3001
STOPSIGNAL SIGTERM

# `node` sem shell no caminho de execução; healthcheck na UI estática (não exige token).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Permission Model do Node: leitura só em /app, /data e /run/secrets; escrita só em /data.
# --allow-child-process: o console precisa executar aws/kubectl/comandos configurados.
# --allow-net: necessário para escutar a porta e fazer os testes HTTP/TCP (no Node 26 a rede também é restrita).
ENTRYPOINT ["/sbin/tini", "--", "node", \
  "--permission", \
  "--allow-fs-read=/app", "--allow-fs-read=/data", "--allow-fs-read=/run/secrets", \
  "--allow-fs-write=/data", \
  "--allow-child-process", \
  "--allow-net", \
  "--disable-proto=delete", \
  "/app/server.js"]
