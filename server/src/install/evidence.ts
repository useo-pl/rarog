/**
 * Rejestr faktów o menedżerach paczek i układach instalacji, na których stoi kod `server/src/install/`: co zmierzono,
 * i na jakich wersjach npm, pnpm i Node. Kod czyta stąd wartości, które od tych faktów zależą (segment cache
 * `npx`, znacznik `pnpm dlx`, flagi `npm ci`), więc zmiana zachowania menedżera ma jedno miejsce do poprawy. Jak
 * fakty odświeżyć: `docs/distribution.md`, „After an npm or pnpm update”.
 */

/** Facts from a measurement; the versions are exactly those the fact was measured on. */
export const EVIDENCE = {
  /**
   * `npm ci` z `sdk-lock.json` w pustym katalogu: dokładnie jedna paczka (`@anthropic-ai/claude-agent-sdk`,
   * 4 805 217 B plików) na każdej parze npm i Node z listy, także przy `include=optional` w `npm_config_include`
   * i `include=peer`/`include=optional` w `--userconfig` albo w `.npmrc` katalogu: `--include=prod` je zastępuje.
   * Kontrola: bez `--include=prod` `npm_config_include=optional` dokłada paczkę platformy (2 paczki, 237 879 313 B).
   * Lockfile z `npm install --package-lock-only --legacy-peer-deps`: 9 wpisów paczek i korzeń, identyczny na npm
   * 11.20.0 i 12.2.1.
   */
  sdkInstall: {
    flags: ['--legacy-peer-deps', '--include=prod', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
    packages: 1,
    bytes: 4_805_217,
    lockEntries: 9,
    npmNode: ['11.20.0/22.22.3', '11.20.0/24.11.1', '12.2.1/22.22.3', '11.19.1/26.10.0', '12.2.1/26.10.0'],
  },
  /**
   * `listSessions({ dir: <pusty katalog>, limit: 1 })` z pakietu załadowanego po jawnej ścieżce (`exports['.']`
   * z warunkiem `default`, `./sdk.mjs`): `[]` w 47–51 ms; na kontrolowanym magazynie (`CLAUDE_CONFIG_DIR`
   * z jednym plikiem sesji) jeden wpis z `sessionId`, `summary`, `lastModified`, `cwd`, `firstPrompt`, `gitBranch`.
   */
  sdkProbe: { sdk: '0.3.247', node: ['22.22.3', '24.11.1', '26.10.0'] },
  /**
   * `npm` obok węzła to dowiązanie do `npm-cli.js` paczki npm: nvm `<prefiks>/bin/npm` →
   * `../lib/node_modules/npm/bin/npm-cli.js`, Homebrew `Cellar/node/<wersja>/bin/npm` →
   * `<prefiks Homebrew>/lib/node_modules/npm/bin/npm-cli.js`. Sam plik to skrypt `#!/usr/bin/env node`, więc
   * wołany wprost wziąłby `node` z `PATH`; `rarog setup` woła go węzłem tego procesu.
   */
  npmCli: { file: 'npm-cli.js', layouts: ['nvm, Node 22.22.3 i 24.11.1', 'Homebrew, node 26.10.0'] },
  /** `npm exec` (`npx`) rozpakowuje paczkę do `<cache npm>/_npx/<skrót>/node_modules/<paczka>`. */
  npx: { segment: '_npx', npm: '11.20.0' },
  /**
   * `pnpm dlx`: dowiązanie wykonywalne w `<cache pnpm>/dlx/<skrót>/<id>/node_modules/.bin/`, a sama paczka (także
   * `import.meta.url` modułu) w `<sklep>/v11/links/@/<nazwa>/<wersja>/<skrót>/node_modules/<nazwa>` — tak samo jak po
   * `pnpm add -g`, więc ścieżka instalacji dlx nie wyróżnia. Proces dostaje od pnpm
   * `npm_config_user_agent=pnpm/<wersja> …`, a dowiązanie globalnej instalacji niczego do środowiska nie dokłada.
   */
  pnpmDlx: { userAgentPrefix: 'pnpm/', pnpm: '11.4.0' },
  /**
   * Paczka globalna po instalacji tarballa: npm (`npm i -g`, także z `--prefix`) kładzie katalog paczki w
   * `<prefiks>/lib/node_modules/<nazwa>`; pnpm 11 (`pnpm add -g`) w sklepie,
   * `<sklep>/v11/links/@/<nazwa>/<wersja>/<skrót>/node_modules/<nazwa>` (paczka bez zakresu), z dowiązaniem
   * z katalogu globalnego; `realpath` korzenia to ścieżka w sklepie. Polecenie `rarog` pnpm w `--global-bin-dir` to
   * skrypt sh z `exec node …/bin/rarog.mjs`, czyli `node` z `PATH`.
   */
  globalLayouts: {
    npm: { segments: ['lib', 'node_modules'], npm: '11.20.0' },
    pnpm: { storeSegment: 'links', scopePrefix: '@', pnpm: '11.4.0' },
    node: '22.22.3',
  },
  /**
   * Homebrew 7.0.12, formuła `node` 26.10.0_2: `<prefiks>/opt/node` to dowiązanie do `../Cellar/node/26.10.0_2`
   * (aliasy `opt/node.js` i `opt/nodejs` też), a `process.execPath` węzła uruchomionego z `<prefiks>/bin/node` albo
   * `<prefiks>/opt/node/bin/node` to ścieżka w `Cellar`. Według dokumentacji Homebrew `brew upgrade` przestawia
   * `opt/<formuła>` na nową wersję, a `brew cleanup` usuwa starą z `Cellar` (na usłudze niezmierzone), więc usługa
   * wskazuje węzeł przez `opt/<formuła>`.
   */
  homebrew: { cellar: 'Cellar', opt: 'opt', brew: '7.0.12', formula: 'node 26.10.0_2' },
} as const;
