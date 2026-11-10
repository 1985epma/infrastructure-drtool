# Política de segurança

Esta ferramenta **liga, desliga e (no caso do ElastiCache) exclui** recursos de infraestrutura. Tratamos vulnerabilidades com seriedade.

## Versões suportadas

Recebe correções de segurança a **última versão publicada** (1.x).

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o relato privado do GitHub:
**Security → Report a vulnerability** neste repositório
(<https://github.com/1985epma/infrastructure-drtool/security/advisories/new>).

Inclua: versão, passos para reproduzir, impacto esperado e, se possível, uma sugestão de correção.
Respondemos em até 7 dias e coordenamos a divulgação após a correção.

## Modelo de ameaça (resumo)

- O console escuta apenas em `127.0.0.1` por padrão e **recusa subir fora do localhost sem `ADMIN_TOKEN`**.
- Operações destrutivas exigem confirmação pelo nome do ambiente; a API valida `Host`/`Origin` (DNS rebinding/CSRF).
- Comandos externos (`aws`, `kubectl`, comandos configurados) rodam **sem shell** (argv). Comandos configurados pelo operador
  são código do operador: não exponha o console a usuários não confiáveis.
- Credenciais AWS não são armazenadas; vêm do ambiente/perfil. Não commite `data/`, kubeconfigs nem tokens.
- A imagem Docker roda sem root, com rootfs somente leitura e sem capabilities (veja o README).

Fora de escopo: ataques que exigem acesso já privilegiado à máquina onde o console roda.
