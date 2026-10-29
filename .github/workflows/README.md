# Automacoes do GitHub Actions

| Workflow | Disparo | Funcao |
|---|---|---|
| [ci.yml](ci.yml) | Todos os pushes, pull request ou execucao manual | Tipos/build, unidade/API, navegador, backup, esquema/diagramas, verificacoes moveis e HTTPS local. |
| [docs.yml](docs.yml) | Push de documentacao/README ou execucao manual | Links locais e contratos documentados, sem iniciar servicos. |
| [android.yml](android.yml) | Manual ou chamada por outro workflow | Compilacao, inicializacao e ensaio integrado do APK. |

## Android

Selecionar o perfil `local` ou `cloud` e o modo:

- `build`: confere fontes e compila o APK, sem emulador.
- `startup`: compila ou baixa um APK e confere instalacao/tela de login no emulador, sem login de usuario nem alteracao de dados pela API.
- `integrated`: somente perfil local; testa atleta, treinador e administrador com API, PostgreSQL, SMTP capturado e S3 isolados.

`apk_run_id` e opcional: informa uma execucao deste workflow, neste mesmo repositorio, que gerou um APK do mesmo perfil. Vazio significa compilar novamente. Todos os modos verificam o SHA-256 depois de gerar ou baixar o arquivo, inclusive `build` com APK reutilizado. Commit do APK e do roteiro podem ser diferentes e devem ser conferidos no resultado. Runs do repositorio anterior continuam la e nao podem ser usados diretamente como `apk_run_id` no novo repositorio.

```powershell
gh workflow run android.yml --repo luccalck/linkatletas --ref main -f build_profile=cloud -f mode=build
gh workflow run android.yml --repo luccalck/linkatletas --ref main -f build_profile=local -f mode=integrated
```

O teste integrado nunca cria fixtures em producao. Nenhum modo autoriza automaticamente uma conta Google pessoal. APK usa assinatura de desenvolvimento; emulador nao comprova homologacao fisica, iOS ou publicacao em lojas. Os testes Android rodam no runner do GitHub, sem abrir emulador no computador do integrante.

## Resultados e configuracao

Consultar a aba Actions e o commit de cada execucao. A CI preserva `test-evidence` por 14 dias. APK e evidencias Android tem retencao de 30 dias; artefatos expirados precisam ser gerados novamente.

As credenciais de banco, SMTP e S3 declaradas nos ensaios sao exclusivas do ambiente local isolado. Valores reais devem permanecer em secrets dos provedores. IDs OAuth publicos podem ser configurados nas variaveis `GOOGLE_WEB_CLIENT_ID` e `GOOGLE_IOS_CLIENT_ID` do repositorio.

[Documentacao do projeto](../../docs/README.md)

## Check de publicacao

O job `LinkAtletas - validacao completa` tem nome estavel e responde a todos os pushes, inclusive documentacao, para permitir sua exigencia antes da promocao de um deployment. No projeto Vercel, esse check do repositorio conectado (`luccalck/linkatletas`) e exigido antes da promocao em Production. O repositorio e independente, nao um fork; resultados dos repositorios anteriores nao geram checks neste repositorio.

Nao renomear o job sem atualizar a configuracao correspondente na Vercel. CI aprovada comprova os testes executados, nao homologacao Google, cobrancas reais ou dispositivos fisicos.

Ao usar um fork pela primeira vez, abrir a aba Actions e confirmar a habilitacao dos workflows desse fork. O bloqueio inicial do GitHub pode impedir disparos automaticos mesmo quando a API informa workflows ativos e uma execucao manual funciona. Conferir um push real antes de depender do check para liberar producao.

## Versoes das Actions

As Actions abaixo usam runtime Node.js 24 e sao fixadas pelo SHA completo do release oficial. A versao do Node.js da aplicacao continua configurada separadamente em `node-version`.

| Action | Release | SHA |
|---|---|---|
| actions/checkout | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | [v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| actions/setup-java | [v6.1.0](https://github.com/actions/setup-java/releases/tag/v6.1.0) | `b843ebf9b913146b38da2eaa7aeddf76074ae1ad` |
| actions/cache | [v6.1.0](https://github.com/actions/cache/releases/tag/v6.1.0) | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| actions/upload-artifact | [v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| actions/download-artifact | [v8.0.2](https://github.com/actions/download-artifact/releases/tag/v8.0.2) | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |
| pnpm/action-setup | [v6.1.0](https://github.com/pnpm/action-setup/releases/tag/v6.1.0) | `ea17c68df8912ef543352723c149a84f56e3d413` |

Ao atualizar uma Action, conferir runtime, inputs e compatibilidade dos artefatos, substituir o SHA e executar a verificacao correspondente. Os jobs usam Ubuntu 24.04 para evitar troca automatica da imagem por `ubuntu-latest`; essa imagem tambem precisa de manutencao planejada. O checkout nao preserva credenciais Git no workspace do runner.

A concorrencia da CI separa push e pull request para que um evento nao cancele o check do outro. A verificacao rapida de documentacao possui timeout de dez minutos e cancela execucoes obsoletas.

Na execucao manual de `ci.yml`, `webkit_regression=true` repete tres vezes os cenarios de login e fluxo principal no WebKit, alem da suite normal. Os resultados adicionais ficam em `docs/evidencias/webkit-regression` no artefato, sem substituir o resultado da suite completa. A verificacao de pageerrors continua ativa e nao ha retries para ocultar falhas intermitentes.

## Protecao e Dependabot

No repositorio `luccalck/linkatletas`, main exige pull request, branch atualizada, conversas resolvidas e o check `LinkAtletas - validacao completa` emitido pelo GitHub Actions. Force push e exclusao estao bloqueados, inclusive para administradores. Nao e exigida aprovacao de outro integrante para manter o repositorio individual. Trabalhar em branch propria e integrar pelo PR apos a CI.

Dependabot alerts e PRs de seguranca estao habilitados, sem merge automatico. O [arquivo de configuracao](../dependabot.yml) agenda verificacoes semanais das Actions e dos dois pacotes npm, agrupando atualizacoes minor/patch e limitando PRs. Atualizacoes maiores exigem revisao individual. A matriz nativa do Expo deve ser respeitada mesmo quando o bot sugere uma versao mais recente.

As Actions permitidas no repositorio sao as oficiais do GitHub e `pnpm/action-setup`, com SHA completo obrigatorio. O token padrao e de leitura e nao pode aprovar PRs. Secret scanning e push protection estao habilitados. Os registros antigos permanecem nos seus repositorios de origem; a governanca descrita aqui se refere somente a `luccalck/linkatletas`.
