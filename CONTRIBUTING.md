# Como contribuir

1. Abra uma issue descrevendo o problema/ideia (para vulnerabilidades, veja [SECURITY.md](SECURITY.md)).
2. Faça um fork e crie uma branch; a `main` é protegida (PR + CI verde + revisão do dono).
3. Requisitos: Node ≥ 26. O app não tem dependências npm.
4. Rode `npm test` (75+ testes; usam `aws`, `kubectl` e `docker` **falsos** — nenhum recurso real é tocado).
5. Mudanças em provedores de infraestrutura precisam de testes com os fakes de `test/` e de nota no README.
6. Nunca inclua segredos, caminhos pessoais ou dados reais; imagens/vídeos da documentação usam dados fictícios
   (`docs/tools/run-capture.sh`).

O CI executa testes, build + smoke test + Trivy da imagem Docker, e gitleaks no histórico.

## Manutenção do repositório (donos)

A proteção da `main` e as configurações de segurança estão em código: `.github/harden-repo.sh`
(requer `gh` como admin). Rode-o de novo logo após tornar o repositório público para ativar os itens "só público"
(aprovação de PRs de forks, secret scanning com push protection e relato privado de vulnerabilidades).
