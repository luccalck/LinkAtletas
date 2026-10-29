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

Os scripts de backup atuais em `scripts/banco` atendem à instalação com Docker. Não apresentá-los como agendamento de backup remoto do Neon. A implantação de cópia independente exige definir destino privado, retenção, execução e teste de restauração, incluindo a preservação da chave AES original e dos objetos Tigris.

O plano atual não oferece allowlist de IPs/VPC nem a proteção de branch exibida na integração. A conexão pública autenticada permanece necessária para a Vercel. Não desligar a rede pública nem contratar um plano automaticamente para encerrar um checklist. Escala a zero está configurada em cinco minutos e compute em 0,25 CU.

Referências: [pooling no Neon](https://neon.com/docs/connect/connection-pooling), [roles e privilégios](https://neon.com/docs/manage/roles), [eventos do pool node-postgres](https://node-postgres.com/apis/pool).
