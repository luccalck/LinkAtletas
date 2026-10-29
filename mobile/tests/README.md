# Testes do cliente móvel

| Arquivo | O que verifica |
|---|---|
| [api.test.ts](api.test.ts) | Login/restauração dos três papéis, cadastro público, SecureStore/Bearer, recusa de papel inválido, expiração/logout, erros, WebSocket, arquivos e limpeza de cache privado. |
| [config.test.ts](config.test.ts) | Perfil local, URL do emulador, exigência de HTTPS no perfil normal e recusa de destinos/configurações impróprios. |
| [navigation.test.ts](navigation.test.ts) | Destinos e separação dos três papéis; recusa de destinos e identidades desconhecidos. |
| [workouts.test.ts](workouts.test.ts) | Serialização/limites dos blocos, referência HTTPS em texto, datas e preservação de ficha executada/vínculo. |
| [screens.test.tsx](screens.test.tsx) | Renderização React com primitivas nativas controladas, menus/restauração/logout, decisão de vínculos, CREF, moderação, configuração financeira, publicação de treino, retorno do atleta, resposta e conclusão de agenda. |
| [hooks.test.tsx](hooks.test.tsx) | Descarte de resposta atrasada, polling somente em primeiro plano, ausência de polling em perfil e bloqueio de envio duplicado. |
| [google-calendar.test.ts](google-calendar.test.ts) | Autorização Google e criação de evento com SDK/HTTP controlados; cancelamento, escopos, conflitos, tokens e limites. Não comprova consentimento real. |
| [external-links.test.ts](external-links.test.ts) | Recusa de endereços externos inseguros antes de acionar a abertura nativa. |
| [dependencies.test.ts](dependencies.test.ts) | Prototype poisoning em CJS/UMD, preservação de dados válidos em placeholders, modificações reais de configuração Expo em fixtures e compatibilidade das schemas da CLI com Zod corrigido. |

Executar `pnpm test` em `mobile`, ou `pnpm --dir mobile test` na raiz. A configuração está em [vitest.config.ts](../vitest.config.ts); consultar a saída de cada execução para contagem e resultado atuais.

Usa Vitest em Node, React Test Renderer na mesma versão de React do app e módulos nativos/HTTP controlados. Não exige Docker nem altera contas reais. Os testes de resposta 403 verificam o tratamento do cliente, não a autorização real do servidor. A suíte da raiz não inclui automaticamente estes arquivos; o workflow chama o comando móvel separadamente.

Tipos, compatibilidade e exportação são verificações complementares: `pnpm typecheck`, `pnpm check` e `pnpm export`. Nenhuma substitui instalar e operar o APK. O [workflow Android](../../.github/workflows/android.yml) possui ensaio separado por UIAutomator. O modo integrado utiliza `mobile/scripts/verify-roles.py` para os tres perfis. O roteiro legado em `scripts/android/verify-integrated.py` continua como auxiliar e diagnostico; seus resultados anteriores nao comprovam os novos fluxos.

[Aplicativo](../README.md) · [Relatório geral](../../docs/evidencias/relatorio-testes.md)
