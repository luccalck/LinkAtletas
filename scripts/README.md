# Scripts de manutenção e verificação

Ferramentas executadas sob demanda para manter, documentar e verificar o projeto. Não são telas nem rotas da API. Algumas participam da inicialização do contêiner ou dos workflows; outras são utilitários locais e geradores históricos.

Executar a partir da **raiz do repositório**, com as dependências instaladas. Preferir os atalhos do [package.json](../package.json). TypeScript usa Node 24 e `tsx`; Python, Docker e Android SDK só são necessários nas áreas que dependem deles.

## Organização

| Pasta | Finalidade | Comandos principais |
|---|---|---|
| [banco](banco/README.md) | Backup/restauração Docker e Neon, helpers e metadados | Comandos e destinos no guia da pasta. |
| [operacao](operacao/README.md) | Dois arquivos: configuração e entrada do contêiner | `pnpm production:init`; Docker usa o script de entrada. |
| [verificacao](verificacao/README.md) | Cinco arquivos: smoke, carga, backup e TLS | `pnpm test:smoke`, `pnpm test:load`, `pnpm test:backup`, `pnpm test:tls` |
| [documentacao](documentacao/README.md) | Quatro arquivos: links, OpenAPI e diagramas | `pnpm docs:check`, `pnpm api:export` |
| [android](android/README.md) | Três arquivos: conexão USB, emulador e ensaio do APK | `pnpm mobile:connect` e workflow Android. |

## Comandos e efeitos

| Comando | O que faz | Efeito importante |
|---|---|---|
| `pnpm docs:check` | Confere links locais e coerência entre OpenAPI, metadados e diagramas. | Atualiza o JSON de conferência; não testa endpoints nem a diagramação do PDF. |
| `pnpm api:export` | Exporta os contratos registrados no Fastify. | Escreve `openapi.json`; não consulta uma API externa de CREF. |
| `pnpm test:load` | Mede busca com 500 treinadores e 200 requisições locais. | Limpa `users` e dependências no banco exclusivo `_load_test`. |
| `pnpm test:backup` | Cria dados fictícios, faz backup e restaura em destinos isolados. | Cria e preserva bancos, buckets e arquivos de teste. |
| `pnpm test:tls` | Verifica a instalação HTTPS do Compose. | Cadastra atleta fictício e reinicia o contêiner da aplicação. |
| `pnpm test:smoke` | Executa a mesma verificação de `test:tls`. | Não é checagem somente de leitura do site público. |
| `pnpm production:init` | Gera configuração exclusiva para o Compose com TLS local. | Cria arquivos secretos ignorados pelo Git; não publica na Vercel. |
| `pnpm mobile:connect` | Conecta o APK local à API do computador por ADB. | Configura encaminhamento USB e pode instalar um APK informado. |

Os [testes automatizados](../tests/README.md) continuam em `tests`; esta pasta contém os utilitários e ensaios complementares.

## Ambientes e saídas

- O PostgreSQL do Docker e o Neon são independentes. Os comandos originais `backup.ts`/`restore.ts` usam `docker exec`; definir `DATABASE_URL` não os transforma em backup remoto. Os comandos `neon-*` e seu workflow atendem ao Neon, conforme o [guia](../docs/operacao/neon.md#backup-independente-no-tigris).
- Backup de banco/S3 exige suspender escritas para obter um conjunto consistente. Preservar a chave AES separadamente. Não publicar dumps, manifestos privados, `.env` ou tokens.
- Resultados ficam em `docs/evidencias`, `tmp/` ou `emulator-evidence/`, conforme o script. Os ensaios de backup preservam recursos para inspeção; selecionar somente os recursos daquele ensaio na limpeza.
- Carga, TLS, backup privado e Android têm efeitos sobre dados ou disponibilidade; usar instalações de teste, conforme os guias.

Os caminhos usados pelo Docker, pelos comandos e workflows foram mantidos. `__pycache__` e `.pyc` são caches locais ignorados, não arquivos de entrega.

[Auditoria da pasta](https://github.com/DaviSouza78/LinkAtletas/blob/9d62794a8bb84aa77f41de2bab91ebe15b4060d2/docs/testes/revisoes/auditoria-scripts-2026-10-28.md) · [Manual](../docs/operacao/manual.md) · [Servidor](../server/README.md)

[Documentação e diagramas](documentacao/README.md): ferramentas atuais de conferência e exportação.
