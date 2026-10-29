# Implantação na Vercel

A interface React/Vite e a API Node/Fastify usam o mesmo domínio. A configuração versionada em [vercel.json](../../vercel.json) define o builder, o build e o encaminhamento das requisições. O arquivo [server.ts](../../server.ts) exporta a aplicação para o runtime da Vercel.

O projeto `link-atletas` publica a branch `main` de [luccalck/linkatletas](https://github.com/luccalck/linkatletas), repositório independente administrado por Lucca. O domínio público continua `link-atletas.vercel.app`. A troca de origem Git preserva o projeto, suas variáveis e as integrações com os serviços.

## Serviços e ambientes

- **Neon:** PostgreSQL remoto acessado pela API usando `DATABASE_URL` com TLS.
- **Tigris:** buckets privados compatíveis com S3 para arquivos; o banco guarda metadados e relações.
- **Brevo:** servidor SMTP de envio de e-mails. Mailpit é a alternativa local.
- **cron-job.org:** aciona a rota protegida `/api/internal/jobs` para processar tarefas pendentes.

Produção e Preview devem ter banco, buckets e credenciais independentes. As variáveis necessárias estão em [.env.example](../../.env.example); seus valores reais são cadastrados privadamente nos provedores. Não copiar credenciais locais para produção nem expor segredos com prefixos públicos.

### Isolamento de Preview

Production e Preview usam conexões explícitas para branches e bases separados no Neon, sem criar branches automaticamente por deployment. Preview usa a base `linkatletas_preview`. Cada ambiente possui uma conta de execução sem propriedade das tabelas, `TRUNCATE`, `CREATEROLE`, `CREATEDB` ou `BYPASSRLS`. Credenciais de manutenção ficam fora do deploy; aplicar migrations com a conta de manutenção. Não clonar dados pessoais ou sessões de produção. Os deployments recebem somente `DATABASE_URL` como variável de conexão; aliases com credenciais de proprietário devem ser removidos. Consulte a [operação do Neon](neon.md).

O armazenamento utiliza buckets e chaves exclusivos. As variáveis `DATA_ENCRYPTION_KEY` e `CRON_SECRET` também devem ser distintas. Não substituir a chave de cifra de produção para organizar ambientes: isso impediria a leitura de dados já cifrados.

Em deployments com `VERCEL_ENV=preview`, o servidor exige `BILLING_MODE=academic` e bloqueia a entrega SMTP antes de consultar a fila ou abrir transporte. E-mails de recuperação ficam pendentes nesse ambiente; não são entregues. Preview não recebe a senha SMTP do Brevo de produção. O teste de entrega real deve ser feito em um ambiente autorizado próprio.

Quando disponível, `VERCEL_BRANCH_URL` define a origem HTTPS de Preview. Navegar pelo domínio estável do branch para operações autenticadas; uma URL específica de deployment pode não coincidir com a origem permitida.

Antes de liberar uma configuração nova, verificar conexão com TLS, negação de autenticação do banco com a credencial do outro ambiente, negação HTTP 403 entre buckets e cadastro/login com persistência somente em Preview. Deployments antigos conservam configurações antigas; não usá-los como ambiente de testes atual.

## Publicação

1. Instalar dependências e conferir `pnpm build` antes de publicar.
2. Configurar as variáveis do ambiente de destino e confirmar os serviços necessários.
3. Aplicar migrações com `pnpm db:migrate` apontando explicitamente para o banco correto. Não executar o seed de demonstração em produção.
4. Publicar a versão e consultar os logs da Vercel.
5. Conferir `/api/health`, login, persistência, permissões, envio de arquivos e processamento das tarefas.

O [manual](manual.md) descreve os comandos locais. Evidências já coletadas estão no [registro de implantação](../evidencias/relatorios/implantacao-2026-10-26.md); elas comprovam aquela execução, não o estado contínuo dos provedores.

## Cuidados

Uma CI aprovada, um commit enviado e um deployment em produção são eventos diferentes. Antes de usar um resultado como evidência, conferir ambiente, commit e data. WebSockets em serverless exigem considerar as limitações do provedor; o histórico de mensagens persiste no PostgreSQL.

Uploads grandes utilizam sessões autenticadas em partes. Conferir o [contrato da API](../api/README.md) e os limites do provedor antes de alterar essa configuração. Pagamentos reais, OAuth e publicação nas lojas têm requisitos próprios descritos em [continuidade](continuidade.md).

## Aprovação antes da produção

O Deployment Check `LinkAtletas - validacao completa`, importado do GitHub, é exigido para promoção em Production. Ele corresponde ao job de mesmo nome em `.github/workflows/ci.yml` no repositório independente conectado à Vercel. O build pode terminar antes dos testes; a liberação do domínio deve aguardar a aprovação desse check no mesmo commit.

O workflow responde a todos os pushes, inclusive documentação, e permite execução manual. Se uma publicação ficar aguardando, conferir o commit, a execução em `luccalck/linkatletas` e o nome do check antes de tentar novamente. Uma CI aprovada somente no repositório anterior não substitui o resultado do repositório conectado.

## Tarefas agendadas

O cron-job.org chama `GET https://link-atletas.vercel.app/api/internal/jobs` a cada minuto (`* * * * *`), no fuso `America/Sao_Paulo`, com timeout de 30 segundos. A autenticação utiliza `Authorization: Bearer <CRON_SECRET de produção>`; nunca colocar esse segredo na URL ou em arquivos versionados. Redirecionamentos HTTP 3xx não são considerados sucesso.

Manter somente um agendamento para essa URL. Não há cron nativo declarado em `vercel.json`; na Vercel, o intervalo local do servidor fica desligado. O executor também usa uma trava transacional no PostgreSQL para evitar trabalho simultâneo: `skipped: true` significa que outra execução já possui a trava, enquanto `skipped: false` acompanha o resultado do processamento.

O processamento verifica vencimentos profissionais, eventos e estados financeiros, e-mails pendentes, uploads incompletos, sessões e tokens expirados. O modo financeiro configurado determina o acesso ao provedor; não ativar cobranças reais para testar o agendador.

Os avisos estão configurados para três falhas consecutivas, recuperação após falha, desativação por excesso de falhas e certificado TLS próximo do vencimento (sete dias). O canal de e-mail da conta do cron-job.org deve permanecer habilitado. Não provocar falhas em produção para testar notificações.

Para conferir o serviço, consultar Cronjobs → History e executar Test run quando necessário. O retorno esperado é HTTP 200 com JSON de processamento; chamadas sem autorização ou com o segredo de Preview devem retornar 401. HTTP 200 não comprova chegada de e-mails à caixa de entrada: verificar também tentativas e pendências em `mail_outbox`, pois falhas SMTP são registradas na fila para nova tentativa. `sent: 0` pode simplesmente indicar fila vazia.

Se houver mudança de domínio, credencial ou provedor, atualizar o agendamento e validar uma execução completa. As respostas não são armazenadas no histórico do provedor; o status e a duração continuam disponíveis. Preservar os segredos ao compartilhar prints.
