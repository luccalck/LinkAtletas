# Patches de dependências

O pnpm aplica [deepmerge@4.3.1.patch](deepmerge@4.3.1.patch) durante a instalação, com conteúdo e hash registrados no manifesto e lockfile. Usar `pnpm install --frozen-lockfile`; não editar `node_modules` manualmente.

O patch trata [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), sem versão corrigida publicada na revisão de 29/10/2026. Bloqueia `__proto__`, `constructor` e `prototype` ao copiar origem e destino e escreve propriedades com `Object.defineProperty`. Preserva o tratamento original de valores nulos e primitivos, permitindo substituí-los por objetos válidos. Abrange o fonte e os bundles CJS/UMD distribuídos pelo pacote.

[dependencies.test.ts](../tests/dependencies.test.ts) reproduz a exploração com objetos nulos, primitivos e objetos sem protótipo, verifica os bundles CJS/UMD e preservação de configuração, arrays e símbolos. Controles misturam propriedades válidas e maliciosas para detectar perda de dados legítimos. A API real `@expo/config.modifyConfigAsync` também é exercitada em fixtures temporárias, sem alterar o aplicativo. Os testes confirmam o bloqueio do ataque e a preservação das atualizações válidas. Executar `pnpm exec vitest run tests/dependencies.test.ts` em `mobile`.

O número original da versão é preservado. Por isso o Dependabot e `pnpm audit` podem continuar exibindo esse alerta, embora o código instalado esteja corrigido para os cenários testados. Não há regra para ignorar ou encerrar o aviso. Quando houver release corrigido compatível, substituir o patch pela atualização e repetir os testes.

Os overrides do manifesto fixam `node-forge` em 1.4.2 e o Zod da CLI Expo em 4.6.6. A compatibilidade das schemas da CLI é verificada pela suíte, além das verificações de tipos, exportação e compilação Android. Atualizações do SDK devem reavaliar esses overrides e este patch.
