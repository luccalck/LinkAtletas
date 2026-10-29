# Manual de instalação, execução e demonstração

Para desenvolvimento local use dados fictícios. A [aplicação pública](https://link-atletas.vercel.app) tem configuração independente de banco, arquivos e SMTP; consulte a [implantação verificada em 26/10/2026](../evidencias/relatorios/implantacao-2026-10-26.md). O modo financeiro acadêmico não cobra dinheiro. [API](../api/README.md), [limitações](../requisitos/backlog.md) e [resultados de testes](../evidencias/relatorio-testes.md) complementam este manual.

## Instalação local

Requisitos: Node.js 24.22.2, pnpm 10.34.9 e Docker Desktop com engine ativo. Na raiz do repositório:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm dev:all
```

`Copy-Item` é para primeira instalação: preserve um `.env` existente. Migrations aplicam somente arquivos ainda não registrados; não apague o volume para atualizar. Seed é explícito, de desenvolvimento, não substitui contas existentes. `docker compose down` para os serviços sem remover volumes.

| Serviço | Endereço local | Uso |
|---|---|---|
| Web | [localhost:5173](http://localhost:5173) | Atleta, treinador e administração |
| API / Swagger | [localhost:3001/api/docs](http://localhost:3001/api/docs) | Documentação interativa |
| Saúde API | `http://localhost:3001/api/health` | Disponibilidade do banco/API |
| Mailpit | [127.0.0.1:8025](http://127.0.0.1:8025) | Mensagens SMTP locais, incluindo recuperação |
| SMTP | `127.0.0.1:1025` | Captura local sem relay externo |
| S3 SeaweedFS | `http://127.0.0.1:8333` | API privada, não galeria pública |
| PostgreSQL | `127.0.0.1:54329` | Banco `linkatletas`; teste separado `linkatletas_test` |

Imagens/configuração estão em [compose.yaml](../../compose.yaml) e [S3 local](../../infra/s3.local.json). Portas locais são vinculadas a loopback. Não use as senhas locais de exemplo numa operação pública.

## Configuração e chave privada

Consulte [.env.example](../../.env.example). `APP_ORIGIN` deve corresponder exatamente à origem web. `DATABASE_URL` e `TEST_DATABASE_URL` não devem apontar para o mesmo banco. `API_PORT`/`VITE_PORT` permitem portas diferentes; altere a origem junto.

Se a porta 5173 estiver ocupada, confira a execução anterior e encerre-a com `Ctrl+C` no terminal correspondente antes de reiniciar. Para identificar apenas os processos que escutam as portas do projeto, use `Get-NetTCPConnection -State Listen -LocalPort 5173,3001 | Select-Object LocalPort,OwningProcess`; confira o PID com `Get-Process -Id <PID>`. Não finalize processos sem identificar a aplicação. Como alternativa, configure as variáveis no terminal PowerShell em que executará o projeto:

```powershell
$env:VITE_PORT = '5175'
$env:API_PORT = '3003'
$env:APP_ORIGIN = 'http://localhost:5175'
pnpm dev:all
```

Vite usa `API_PORT` do ambiente para o proxy e a API verifica a origem exata. Essas variáveis valem para a sessão atual do terminal.

Desenvolvimento gera `.data-key.local`, ignorado pelo Git, caso `DATA_ENCRYPTION_KEY` não esteja definido. Esse arquivo/chave é necessário para decifrar dados existentes. Preserve-o com acesso restrito e em canal separado dos dados de backup; não copie seu conteúdo para relatórios, commits ou chat. Produção exige `DATA_ENCRYPTION_KEY` de 32 bytes em base64 e configurações explícitas do banco/S3/SMTP/modo financeiro. Não troque a chave para resolver falha de decrypt: restaure a chave correspondente aos dados.

`JOBS_INTERVAL_MS` controla tarefas periódicas: outbox SMTP, expiração profissional, eventos/conciliação financeira e acesso vencido, além de sessões/tokens expirados. Execução pontual de jobs:

```powershell
pnpm exec tsx server/jobs.ts
```

## Contas fictícias e administração

| Papel | E-mail | Senha local |
|---|---|---|
| Atleta | `emailatleta@email.com` | `senhaatleta` |
| Treinador | `emailtreinador@email.com` | `senhatreinador` |
| Admin | `admin@linkatletas.local` | `SenhaAdmin123!` |

Novas contas de atleta/treinador podem ser criadas na interface. Admin próprio: definir `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` localmente e executar `pnpm db:admin`. Não existe cadastro público de administrador nem senha padrão de produção.

## Roteiro de demonstração

1. Em perfis de navegador separados, criar treinador e atleta. Completar perfis compatíveis; treinador envia CREF/evidência e documento imagem/PDF opcional. Admin decide com motivo e prazo. Mostrar que pendente e suspenso ficam fora da descoberta.
2. Atleta solicita; treinador aceita. Mostrar ciclo e aviso acadêmico sem cobrança. Em modo acadêmico, checkout fica indisponível de forma explícita.
3. Treinador cria rascunho, publica e envia orientação privada. Atleta registra blocos/métricas/esforço e observação. Recarregar as duas sessões e conferir persistência.
4. Atleta entra em Privacidade e concede performance; envia arquivo no treino. Treinador abre e registra correção técnica. Uma terceira conta não pode ler. Revogar performance remove mídia do titular conforme política.
5. Abrir Mensagens em duas sessões, enviar texto/anexo e conferir recepção sem recarga, leitura e histórico. Desconectar/reconectar recupera histórico pelo banco.
6. Agendar consultoria futura e tentar sobrepor horário; verificar erro claro. Reagendar/cancelar com motivo. Sem Google, agenda informa que não criou videoconferência externa.
7. Após período de elegibilidade (sete dias por padrão), atleta avalia; treinador responde; usuário denuncia e admin oculta. Testes acadêmicos usam fixtures/controlam relógio/configuração, sem simular sete dias de uso real.
8. Solicitar recuperação em login, abrir Mailpit, usar link de uma vez e verificar senha nova e sessão antiga negada. Não expor link/token em captura pública.
9. Exportar dados próprios e verificar consentimentos/saúde opcional. Usar conta fictícia descartável para encerramento com senha; verificar anonimização e sessão revogada. Financeiro precisa estar conciliado.
10. Mostrar encerramento e novo ciclo preservando fichas do ciclo antigo. Reabrir banco/API para conferir persistência. Demonstração não prova homologação externa.

## Financeiro e ativação Asaas

Padrão `BILLING_MODE=academic`: não cria cobrança ou repasse fictícios. Treinador pode salvar plano e referência de carteira, mas o checkout não produz pagamento.

Para homologar em sandbox, responsável configura `BILLING_MODE=asaas`, `ASAAS_ENVIRONMENT=sandbox`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` longo/aleatório no servidor, além de carteiras elegíveis e URL alcançável do webhook. Treinador informa wallet UUID no mesmo ambiente do provedor. Nenhuma chave privada vai no frontend ou app. Admin configura comissão/carência. Atleta prepara checkout depois de aceite; apenas webhook autenticado confirma pagamento. Testar duplicata, timeout, conciliação, vencimento, cancelamento e split antes de considerar sandbox validado. As evidências atuais de contrato HTTP usam servidor controlado e não extrato de conta real.

## Google Agenda e Meet

Opcional: OAuth Client ID público do tipo Web em `VITE_GOOGLE_CLIENT_ID`, Calendar API habilitada e origem JavaScript autorizada no Google Cloud. O Client Secret não vai para o frontend. Botão de criação é condicionado à configuração e exige ação explícita do treinador; OAuth cria evento na própria agenda, sem lista de convidados neste fluxo integrado. API guarda ID e link. Testes não acionam OAuth real. Alteração/cancelamento da consultoria local precisa ser refletido também na agenda externa; sincronização bidirecional automática não está homologada.

## Aplicativo Expo

No diretório [mobile](../../mobile):

```powershell
pnpm --dir mobile install --frozen-lockfile
Copy-Item mobile/.env.example mobile/.env
pnpm --dir mobile typecheck
pnpm --dir mobile check
pnpm --dir mobile export
pnpm --dir mobile start
```

`EXPO_PUBLIC_API_URL` contém somente URL pública da API. Em emulador Android, exemplo `http://10.0.2.2:3001/api`; dispositivo físico exige IP de rede acessível e configuração apropriada de bind/firewall da API. Não exponha serviços de banco/S3/SMTP para resolver acesso do app. Produção usa HTTPS. O app armazena token em SecureStore; chaves de serviço permanecem no servidor.

`pnpm --dir mobile android` exige Java/Android SDK/emulador ou aparelho; iOS exige macOS/Xcode ou serviço de build autorizado. Exportar bundles não gera APK/IPA assinado e não comprova câmera, performance, permissões ou execução em aparelho. Consulte o relatório antes de afirmar homologação.

## Verificações e solução de problemas

`pnpm typecheck`, `pnpm test`, `pnpm build` e `pnpm test:e2e`. Instalar browsers com `pnpm exec playwright install chromium firefox webkit` quando o ambiente de teste usar os três. Vitest/E2E podem limpar fixtures de banco `_test`: não execute ao mesmo tempo na mesma base.

- Conexão API falha: conferir containers saudáveis, URL/porta e logs; não publicar corpo de senha/token.
- Mutation 403 de origem: conferir `APP_ORIGIN`, protocolo e porta; não desabilitar verificação CSRF.
- Upload não funciona: conferir S3/credenciais/bucket, finalidade e consentimento; verificar extensão/MIME/assinatura/limite.
- Recuperação não chega: conferir Mailpit/outbox/jobs e SMTP; resposta genérica não confirma existência de conta.
- Ação bloqueada após aceite: conferir credencial profissional, situação financeira e ciclo; aceite esportivo não comprova pagamento.
- Mídia/dados não decifram: preservar dados e restaurar chave correspondente; não gerar chave substituta silenciosamente.

## Implantação e recuperação

Código de produção e scripts operacionais devem ser usados com segredos próprios, proxy HTTPS e banco/objetos protegidos. TLS local de teste não instala confiança no sistema e não constitui publicação pública. Restaurar backup primeiro em base isolada; conferir contagens/objetos e disponibilidade da chave. Pedidos de eliminação precisam ser reaplicados após restaurar um backup anterior. Os comandos e resultados operacionais finais são registrados no relatório e nos scripts versionados, sem presumir um domínio ou conta não fornecidos.

Arquivos: [compose de produção](../../compose.production.yaml), [gerador de configuração](../../scripts/operacao/init-production.ts), [verificação TLS](../../scripts/verificacao/verify-tls.ts), [backup](../../scripts/banco/backup.ts), [restauração](../../scripts/banco/restore.ts) e [ensaio de recuperação](../../scripts/verificacao/verify-backup.ts).

```powershell
pnpm exec tsx scripts/operacao/init-production.ts
docker compose --env-file .env.production.local -f compose.production.yaml up -d --build --wait
pnpm exec tsx scripts/verificacao/verify-tls.ts
pnpm test:smoke
pnpm exec tsx scripts/banco/backup.ts revisao-local
pnpm exec tsx scripts/verificacao/verify-backup.ts
```

`init-production.ts` preserva configurações já existentes e gera segredos em `.env.production.local`/`.s3-production.local` ignorados. O Compose usa banco/objetos próprios e somente proxy loopback 8443. `verify-tls.ts` lê a CA do container e a passa explicitamente: conexão sem confiança deve falhar, HTTPS autentica e cookie é Secure/HttpOnly, mutation sem Origin falha. A confiança global do sistema não é alterada. Para domínio público há [Caddyfile público](../../infra/Caddyfile.public), condicionado à configuração/conta/autorização do responsável, sem publicação automática.

`test:smoke` executa a mesma verificação TLS e reinicia somente o contêiner da aplicação LinkAtletas local, conferindo que sessão e perfil permanecem. Execute fora de um ensaio em andamento. Não reinicia PostgreSQL nem remove volumes; o smoke HTTP histórico permanece na branch `sprint-2`.


Antes de backup operacional, pause escritas: o snapshot SQL e a enumeração S3 não são transação distribuída. `backup.ts` usa `BACKUP_ROOT` (padrão `tmp/backups`), cifra dump, copia objetos já cifrados e grava manifesto/checksums/fingerprint da chave, sem guardar a chave. Defaults de desenvolvimento: container `linkatletas-db-1`, usuário/banco `linkatletas`; produção exige configurar `BACKUP_DB_CONTAINER`, `BACKUP_DB_NAME`, credenciais S3 e chave correspondentes. Worker `BACKUP_DOCKER_NETWORK` permite acesso S3 privado sem expor porta; conferir os parâmetros no [helper](../../scripts/banco/backup-shared.ts).

Restauração: `pnpm exec tsx scripts/banco/restore.ts <diretorio-backup> <banco_vazio_test> <bucket_vazio>`. O diretório precisa ficar estritamente dentro de `BACKUP_ROOT`; banco deve existir, estar vazio e terminar em `_test`; bucket precisa estar vazio. Script valida chave/checksums antes das alterações e compara contagens/objetos ao final; não apaga destino ocupado. A chave AES original deve estar disponível por canal protegido. `verify-backup.ts` cria/preserva bases isoladas próprias e testa SQL privado e S3, sem limpar a demonstração.

Medição reproduzível do match: [load-matching.ts](../../scripts/verificacao/load-matching.ts), comando `pnpm exec tsx scripts/verificacao/load-matching.ts`; usa dataset sintético e banco de teste isolado. Confirme o relatório/destinos antes de executar em ambiente compartilhado. Resultado real local em [carga-matchmaking.json](https://github.com/DaviSouza78/LinkAtletas/blob/9d62794a8bb84aa77f41de2bab91ebe15b4060d2/docs/evidencias/infraestrutura/carga-matchmaking.json) não comprova autoescala.

## APK local e ambiente recuperado

Para demonstrar o aplicativo com esta API sem hospedagem pública, usar o [manual do APK conectado por USB](manual-apk-local.md). O perfil local tem pacote e política de rede próprios; o perfil normal exige HTTPS. Consulte o [checklist de serviços](servicos-externos.md) antes de ativar fornecedores.


A rotina de backup passou a interpretar a variável AES vazia do exemplo como uso da chave local existente, preservando a recusa de chave não vazia inválida. Nunca trocar ou apagar uma chave para fazer o backup passar.

## Documentação e diagramas

`pnpm docs:check` confere links e contratos documentados. `pnpm api:export` exporta o OpenAPI da API própria. Para atualizar os diagramas, editar as fontes e conferir as imagens correspondentes; consultar o [índice de diagramas](../diagramas/README.md). A ERS oficial é fornecida e revisada pela equipe; não há geração automática da sua versão final.
