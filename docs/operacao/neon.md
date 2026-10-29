# Operação do PostgreSQL no Neon

O Neon hospeda o PostgreSQL da aplicação publicada. O PostgreSQL do Docker continua separado, para desenvolvimento e testes. Não existe sincronização automática entre eles.

## Ambientes e contas

| Ambiente | Base | Conta de execução |
|---|---|---|
| Production | `neondb` | `linkatletas_production_runtime` |
| Preview | `linkatletas_preview`, em branch separado | `linkatletas_preview_runtime` |

As contas de execução não são proprietárias do banco nem das tabelas. Recebem `CONNECT`, `USAGE` e operações de dados necessárias; `schema_migrations` e `metric_types` são somente leitura. Não recebem criação de esquema, `TRUNCATE`, criação de roles/bancos, replicação ou bypass de RLS. A autorização por usuário e recurso é aplicada pela API; o navegador não recebe a conexão PostgreSQL.

Cada deployment recebe apenas `DATABASE_URL`, como segredo no ambiente correspondente. Não manter aliases com senha ou URL de proprietário junto da conta limitada. Contas de manutenção e suas senhas ficam fora do deploy e do repositório. Usar conexão direta de manutenção para migrations e ferramentas administrativas.

## Conexões e limites

- Aplicação: endpoint com `-pooler` e `sslmode=verify-full`, validando o certificado do servidor.
- Cada pool da API admite até dez conexões e espera até cinco segundos para conectar.
- A role limita consultas a 30 segundos, espera por locks a cinco segundos e transações ociosas a um minuto. O cliente também limita a espera de consulta a 35 segundos.
- A transação que mantém a trava do agendador usa uma exceção local de cinco minutos, correspondente ao máximo da função Vercel. Assim, processamento de filas e serviços externos não libera a trava antecipadamente; o rollback restaura o limite normal.
- Definir os parâmetros na role e na base correspondente. O proxy/pooler pode não preservar parâmetros enviados no startup do cliente. Verificar os valores efetivos com `current_setting`.
- Alterações nas configurações de role afetam novas sessões; conexões já abertas podem manter valores antigos. Preparar e validar uma conta nova antes de trocar o segredo do deploy.
- Desconexões ociosas ou de clientes em uso são tratadas sem registrar a mensagem original, que pode conter dados privados. A consulta continua rejeitando a falha; o tratamento impede o encerramento por evento sem listener e evita registrar o mesmo erro duas vezes.

Exemplo de configuração por ambiente, executado por manutenção:

```sql
ALTER ROLE linkatletas_production_runtime IN DATABASE neondb SET statement_timeout = '30s';
ALTER ROLE linkatletas_production_runtime IN DATABASE neondb SET lock_timeout = '5s';
ALTER ROLE linkatletas_production_runtime IN DATABASE neondb SET idle_in_transaction_session_timeout = '60s';
```

Não usar os limites de execução da aplicação para cargas administrativas longas sem avaliar a operação. Verificar o ambiente antes de rodar qualquer comando.

## Esquema e publicação

As migrations em `server/db/migrations` são a fonte de evolução do esquema. O executor utiliza transação e trava para evitar aplicações concorrentes. Não editar migrations aplicadas; acrescentar um novo SQL.

Antes de publicar, aplicar e testar a mudança em banco isolado. Conferir os dados existentes antes de adicionar restrições, usar conexão de manutenção direta e limitar a espera por locks. Se a validação falhar, corrigir a causa; não remover dados automaticamente para forçar a migração.

A migração 007 vincula os participantes de cada avaliação ao contrato, limita a comissão de assinaturas às regras existentes e cria índices de apoio às FKs sem duplicar um índice já utilizável. O [dicionário](../banco/dicionario-dados.md), o [DER](../diagramas/der.mmd) e os metadados são gerados a partir do esquema migrado. A nulabilidade é registrada nas colunas, mantendo a exportação compatível entre PostgreSQL 17 local e 18 do Neon.

## Recuperação e limites do serviço

No plano Free verificado, a janela de histórico está no máximo de seis horas; não representa backup independente de longo prazo. Antes de uma migração importante, confirmar que o histórico está disponível. Restaurar primeiro para um ambiente isolado e conferir dados, cifra e arquivos; não restaurar diretamente sobre produção sem planejamento.

Os comandos originais `backup.ts` e `restore.ts` atendem à instalação com Docker. O backup remoto utiliza comandos e credenciais exclusivos, conforme o procedimento abaixo.

O plano atual não oferece allowlist de IPs/VPC nem a proteção de branch exibida na integração. A conexão pública autenticada permanece necessária para a Vercel. Não desligar a rede pública nem contratar um plano automaticamente para encerrar um checklist. Escala a zero está configurada em cinco minutos e compute em 0,25 CU.

Referências: [pooling no Neon](https://neon.com/docs/connect/connection-pooling), [roles e privilégios](https://neon.com/docs/manage/roles), [eventos do pool node-postgres](https://node-postgres.com/apis/pool).

## Backup independente no Tigris

O [workflow](../../.github/workflows/neon-backup.yml) executa diariamente às 06:30 UTC (03:30 em São Paulo) e também aceita disparo manual na aba Actions. O agendamento do GitHub pode atrasar e depende do repositório e das Actions permanecerem ativos; conferir a última execução e as notificações de falha.

1. A conta `linkatletas_backup_reader` acessa o Neon diretamente com TLS validado, somente leitura e sem propriedade ou criação de objetos.
2. Uma transação de leitura exporta o mesmo snapshot usado no `pg_dump` PostgreSQL 18. O manifesto registra tabelas, contagens e migrations desse snapshot.
3. Dump e manifesto recebem cifra AES-256-GCM com chave exclusiva. A cópia vai para `linkatletas-backups-production`, privado, em São Paulo. A credencial S3 tem acesso somente a esse bucket, sem administração dos demais.
4. O processo baixa e autentica a cópia, compara o dump e exige recusa do acesso anônimo. Somente então remove backups desse processo com mais de sete dias; não usa exclusão por prefixo genérico em buckets da aplicação.
5. Cada execução restaura o arquivo em PostgreSQL 18 temporário do runner, em base vazia com sufixo `_test`, e confere tabelas, contagens, migrations e restrições. Produção nunca é destino da restauração de teste.

Consultar o resultado em **Actions → Backup cifrado do Neon**. Sucesso exige tanto a cópia quanto a restauração. Os logs contêm somente metadados operacionais; dumps não são anexados como artifacts do GitHub.

### Configuração restrita

Secrets do repositório: `NEON_BACKUP_DATABASE_URL`, `NEON_BACKUP_ENCRYPTION_KEY`, `NEON_BACKUP_ACCESS_KEY` e `NEON_BACKUP_SECRET_KEY`. Variáveis: `NEON_BACKUP_S3_ENDPOINT`, `NEON_BACKUP_BUCKET` e `NEON_BACKUP_DATA_KEY_FINGERPRINT`. A conexão de leitura e a chave do bucket são exclusivas do backup; não usar as contas runtime, de manutenção ou as credenciais dos arquivos da aplicação.

A chave do backup contém 32 bytes em base64. Preservar uma cópia segura dela e da **DATA_ENCRYPTION_KEY original**, separadas dos dumps e do Git. O fingerprint apenas identifica a chave de dados; não permite recuperá-la. Sem a chave original, os campos privados continuam ilegíveis após restaurar o banco. Se a chave de dados mudar, manter as versões necessárias e atualizar o fingerprint conscientemente.

### Recuperação e limites

Para uma recuperação real, baixar a cópia autorizada e executar `node --import tsx scripts/banco/neon-restore-test.ts <chave-do-objeto>` com as variáveis de backup e `NEON_BACKUP_RESTORE_URL` apontando para PostgreSQL 18 local, vazio, com nome terminado em `_test`. O comando recusa outro host e banco ocupado, incluindo tabelas, funções e tipos no esquema `public`. Remove apenas o esquema padrão comprovadamente vazio, sem `CASCADE`, para que o dump recrie sua estrutura original. Conferir o resultado antes de planejar a migração de recuperação; esse comando não substitui produção automaticamente.

A cópia cobre o esquema `public` e os registros da aplicação. Não inclui roles, configuração do provedor nem os bytes dos arquivos guardados nos outros buckets Tigris. Os metadados desses arquivos estão no banco; os objetos e a chave AES original precisam de preservação própria. O teste confirma a restauração e as contagens, sem enviar conteúdo de usuários para logs.

O limite de arquivo cifrado é 128 MiB, com falha explícita ao exceder a memória prevista. A capacidade deve ser revisada conforme o banco cresce. Além da limpeza do workflow, uma regra nativa do Tigris expira objetos do prefixo exclusivo `neon/` após sete dias, mesmo se o agendamento parar. A execução dessa política é assíncrona no provedor; conferir a regra no painel ao alterar o bucket. A rotina não contrata planos, mas o uso deve permanecer dentro das franquias dos provedores. Backups também contêm dados posteriormente excluídos: ao recuperar, reaplicar as eliminações necessárias antes de reabrir o serviço.
