# Serviços externos do LinkAtletas

A aplicação pública usa os serviços abaixo e funciona com o computador e o Docker dos integrantes desligados. Os cenários executados e seus limites estão no [registro de implantação](../evidencias/relatorios/implantacao-2026-10-26.md).

## Serviços em nuvem

| Serviço | Função | Referência |
|---|---|---|
| GitHub | Código, documentos e histórico de contribuições. O repositório atual é independente, administrado por Lucca. | [Repositório atual](https://github.com/luccalck/linkatletas). O repositório anterior do grupo e o fork preservam o histórico de execução anterior. |
| GitHub Actions | Automações de testes, verificações e compilação Android. | [Execuções atuais de CI](https://github.com/luccalck/linkatletas/actions). Compilação não equivale a publicação em loja. |
| Vercel | Hospeda a interface React/Vite e executa a API Node/Fastify por HTTPS. | [Site](https://link-atletas.vercel.app/) e [API](https://link-atletas.vercel.app/api/docs/). Vite prepara a interface; Fastify atende às requisições da API. |
| Neon | PostgreSQL remoto: contas, perfis, vínculos, treinos, mensagens e metadados dos arquivos. | [Saúde da aplicação](https://link-atletas.vercel.app/api/health), [dicionário](../banco/dicionario-dados.md) e tabelas no painel autorizado. |
| Tigris | Arquivos em buckets privados compatíveis com S3, com cifra e acesso controlados pelo servidor. O Neon guarda as referências aos arquivos. | [Verificação de produção](../evidencias/nuvem/tigris-2026-10-26.json) e upload pela aplicação. |
| Brevo | SMTP para envio de e-mails, incluindo recuperação de senha. SMTP é o protocolo; Brevo é o fornecedor. | [SMTP](../evidencias/nuvem/brevo-2026-10-26.json) e [recuperação](../evidencias/nuvem/vercel-recuperacao-2026-10-26.json). Aceite SMTP não garante chegada à caixa de entrada. |
| cron-job.org | Chama periodicamente a rota protegida de tarefas da API. A API processa os trabalhos pendentes. | [Execução ativada](../evidencias/nuvem/cron-producao-ativo-2026-10-26.png). O agendador não hospeda a aplicação nem armazena seu banco. |

Produção e Preview têm configurações próprias de banco e armazenamento. Não mostre valores de variáveis, chaves, cabeçalhos de autorização ou senhas ao compartilhar a tela. As senhas das contas de demonstração ficam fora do repositório.

## Ambiente local

| Componente | Finalidade |
|---|---|
| Docker Compose | Sobe os serviços locais de desenvolvimento e testes do [compose.yaml](../../compose.yaml). Desligá-lo não desliga a implantação pública. |
| PostgreSQL local | Banco de desenvolvimento separado do Neon. Testes usam bases com sufixo `_test`. Não existe sincronização automática entre esses bancos. |
| SeaweedFS | Armazenamento S3 local para testar arquivos; na nuvem essa função é do Tigris. |
| Mailpit | Captura e-mails locais para inspeção, sem entrega na internet; na nuvem o envio é pelo Brevo. |
| Caddy | Proxy HTTPS da [implantação alternativa em contêineres](../../compose.production.yaml). A implantação atual usa HTTPS da Vercel. |

React, Vite, Fastify, React Native e Expo são tecnologias do código, não provedores de banco ou armazenamento. O aplicativo usa a mesma API; consulte os [resultados e limites do Android](https://github.com/DaviSouza78/LinkAtletas/blob/9d62794a8bb84aa77f41de2bab91ebe15b4060d2/docs/evidencias/android/mobile-verificacao.md).

## Integrações sem ativação externa

| Integração | Situação |
|---|---|
| Asaas | Adaptador implementado e [testes HTTP controlados](../../tests/integration/billing.test.ts). A demonstração usa modo acadêmico, sem cobrança real. Credenciais e homologação externas são necessárias antes de ativar pagamentos. |
| Google Calendar/Meet | Integração complementar condicionada a configuração e autorização externas. A agenda própria funciona no banco do projeto; a integração Google não está homologada. |
| CREF | Não há API externa ativa. O requisito atual é conferência manual pelo administrador, com registro da decisão. Aprovação de perfil fictício não comprova habilitação profissional. |
| Play Store e App Store | Sem publicação nas lojas. APK compilado ou bundle gerado não equivale a distribuição homologada. |
