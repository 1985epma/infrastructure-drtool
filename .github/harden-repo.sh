#!/usr/bin/env bash
# Aplica (de forma idempotente) a proteção da `main` e as configurações de segurança do repositório.
#
#   .github/harden-repo.sh [dono/repo]        (padrão: 1985epma/infrastructure-drtool)
#
# Requer `gh` autenticado como ADMIN do repositório. Rode de novo logo DEPOIS de tornar o repositório
# público: alguns itens (marcados "só público") não existem enquanto ele é privado e são pulados.
set -uo pipefail
R="${1:-1985epma/infrastructure-drtool}"

step() { printf '\n== %s\n' "$1"; }
try() { local out; if out=$("$@" 2>&1); then echo "  ok"; else echo "  pulado: $(printf '%s' "$out" | head -c 170)"; fi; }

step "Proteção da branch main (PR + revisão do dono + CI verde + histórico linear, sem force-push/exclusão)"
try gh api -X PUT "repos/$R/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Testes (Node 26)", "Imagem Docker (build, smoke, Trivy)", "Segredos (gitleaks)"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "allow_fork_syncing": true
}
JSON

step "Actions: GITHUB_TOKEN somente leitura por padrão; Actions não aprova PRs"
try gh api -X PUT "repos/$R/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

step "Repositório: apagar branch após o merge, sem wiki/projects, sem merge commit"
try gh api -X PATCH "repos/$R" -F delete_branch_on_merge=true -F has_wiki=false -F has_projects=false \
  -F allow_merge_commit=false -F allow_squash_merge=true -F allow_rebase_merge=true

step "Alertas do Dependabot"
try gh api -X PUT "repos/$R/vulnerability-alerts"

step "[só público] PRs de forks: exigir aprovação manual para TODO colaborador externo"
try gh api -X PUT "repos/$R/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors

step "[só público] Secret scanning + push protection"
try gh api -X PATCH "repos/$R" --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON

step "[só público] Relato privado de vulnerabilidades (Security → Report a vulnerability)"
try gh api -X PUT "repos/$R/private-vulnerability-reporting"

printf '\nPronto. Confira em: https://github.com/%s/settings/branches\n' "$R"
