/**
 * Strażnik granicy hooka zgód: kod, który Claude Code wykonuje poza sandboksem, NIE leży w checkoutcie.
 *
 * Agent w sandboksie zapisuje katalog roboczy, więc `scripts/hooks/*.mjs` w repo może podmienić (pomiar na
 * CLI 2.1.311). Hook odpala się przy każdym dialogu zgody w każdej sesji konta, z pełnymi prawami użytkownika.
 * Dlatego komenda w ustawieniach wskazuje KOPIĘ w `~/.claude/hooks/rarog/` (ścieżka chroniona przez Claude Code),
 * a kopię robi wyłącznie ręczna komenda `pnpm run hooks:install`. Trzy reguły, każda z negatywem na kopii pliku
 * w katalogu tymczasowym:
 *
 * 1. `hookCommand(home)` wskazuje `<home>/.claude/hooks/rarog/rarog-pending.mjs` w apostrofach i nie zawiera
 *    korzenia repo; blok `print` niesie tylko tę komendę.
 * 2. Domknięcie importów: każdy plik z `HOOK_INSTALL_FILES` sięga wyłącznie po moduły `node:` i po pliki z tej
 *    samej listy. Zapomniany plik obok hooka cicho wyłączyłby funkcję (strażnik wysokości ładuje się `try`),
 *    a import spoza listy wykonywałby kod z checkoutu albo spod dowolnej ścieżki. `import(…)` z argumentem innym
 *    niż literał, `require`, `createRequire` i `import.meta.dirname` przewracają test bez wyjątków.
 *    Skrypt `statusLine` (`STATUSLINE_INSTALL_FILES`, ta sama kopia) sięga wyłącznie po moduły `node:`.
 * 3. Instalatory kopii (jedyne zapisy pod `~/.claude`) woła tylko CLI: `installHookCopy`
 *    `server/src/cli/hooks.ts` (`rarog hooks install` i podkładka `pnpm run hooks:install`) i `server/src/cli/setup.ts`
 *    (aktualizacja kopii różnej od źródła w kroku hooka, po `git log` albo różnicy i „t”), a
 *    `installMissingHookCopy` i `installStatuslineCopy` (zapis tylko brakujących plików) wyłącznie `setup.ts`
 *    (`rarog setup`); żaden moduł serwera ani inny plik CLI. Że serwer nie sięga do `server/src/cli/`, pilnuje
 *    `server/test/rarog-cli.test.ts`.
 * 4. W trybie paczki źródłem kopii jest katalog instalacji, który pod nvm albo pnpm leży w domu
 *    zapisywalnym z sandboksa. Każda z trzech ścieżek instalacji pokazuje różnicę przed zapisem i pisze tylko
 *    zweryfikowane bufory: te, które człowiek widział w różnicy, nawet gdy plik źródła zmieni się w trakcie pytania.
 *    „Nie” i brak pytania (wywołanie bez terminala) nie zapisują niczego; gita paczka nie potrzebuje. Bramy źródła
 *    (`committedSources`, `installedSources`) woła wyłącznie `reviewedSources`, a lista instalatorów w `hook-config.ts`
 *    jest równa liście z reguły 3, więc nowa ścieżka zapisu nie ominie różnicy po cichu.
 *    Różnica zostaje zawsze, a pytanie po niej odpada wyłącznie w `rarog update --finish` wersji, którą ten sam
 *    przebieg aktualizacji właśnie zainstalował: pole `copyWithoutQuestion` kontekstu setupu ustawia tylko
 *    `server/src/cli/update.ts`, z `justInstalledHere` (znacznik `installed` blokady aktualizacji z `installed.root`
 *    równym tej instalacji); `rarog setup` daje `false`, a `rarog hooks install` pola nie zna. Różnica idzie wtedy
 *    do logu przebiegu; zachowanie sprawdza `server/test/rarog-update.test.ts`.
 * 5. Kopię obok usługi pisze tylko instalacja, którą usługa startuje (`serviceRefusal`, obowiązkowe w
 *    `HookInstallOptions`): przy usłudze innej instalacji każda z trzech ścieżek odmawia przed różnicą i pytaniem,
 *    a usługa przepięta w trakcie pytania daje odmowę po „t”; w obu razach nic nie zapisane. Kopia już z tymi bajtami
 *    przechodzi (zmienia się tylko manifest).
 * 6. Wpisy hooków w `~/.claude/settings.json` pisze tylko pisarz ustawień `server/src/cli/claude-settings.ts`,
 *    a importują go wyłącznie `server/src/cli/setup-settings.ts` (krok ustawień `rarog setup`),
 *    `server/src/cli/hooks.ts` i `server/src/cli/service.ts` (zdjęcie wpisów przy `rarog service uninstall`): import statyczny, dynamiczny i re-eksport z innego pliku
 *    `server/src`, `scripts` albo `bin` przewraca test. Zapis idzie zawsze po różnicy i „y”, więc CLI
 *    (`server/src/cli/`, `bin/`, `scripts/hooks-config.ts`) nie ma flagi, która pomija pytanie: `--yes`, `-y`,
 *    `--force`, `--assume-yes` i podobne jako literał albo w tekście użycia przewracają test.
 * 7. Katalog kopii usuwa tylko `removeHookCopy` (`hook-config.ts`), a woła je wyłącznie `server/src/cli/service.ts`
 *    (`rarog service uninstall` w paczce, po pytaniu); wywołanie z innego pliku `server/src` albo `scripts` przewraca
 *    test. Znikają wyłącznie nazwy z zamkniętej listy w kodzie (bieżący zestaw, manifest i plik wejściowy pod starą
 *    nazwą produktu), każda jako plik zwykły, a katalog tylko pusty; reszta zostaje, a nazwa z manifestu niczego do
 *    listy nie dodaje. Przed usunięciem dowód pochodzenia: manifest wymienia wyłącznie nazwy z listy i co najmniej
 *    jeden wymieniony plik ma skrót z manifestu. Dowiązanie w miejscu katalogu albo manifestu, katalog podmieniony po
 *    pytaniu, katalog bez dowodu oraz ścieżka, która przez dowiązanie przodka wypada na sam katalog domowy, dają
 *    odmowę bez usuwania (negatywy na katalogu tymczasowym; podmiana w trakcie usuwania i błąd `unlink`:
 *    `hook-copy-removal.test.ts`).
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitArgsRunner } from '../src/git-status.ts';
import {
  HOOK_ANSWER_WAIT_S, HOOK_INSTALL_DIR_REL, HOOK_INSTALL_FILES, HOOK_MANIFEST_FILENAME, STATUSLINE_INSTALL_FILES,
  hookBlock, hookCommand, hookCopyDirState, hookInstallDir, installHookCopy, installMissingHookCopy,
  installStatuslineCopy, removeHookCopy, renderHookBlock, repoRoot, statuslineCommand,
  type HookCopyReview, type HookInstallOptions, type HookInstallResult,
} from '../src/herdr/hook-config.ts';
import { OLD_ENTRY_FILE } from '../src/herdr/hook-commands.ts';
import { realRarogDirsCreated, tempHome, type TempHome } from './rarog-home.ts';
import { scan, unbalanced } from './source-scan.ts';

const REPO = join(import.meta.dirname, '..', '..');
const HOOKS_DIR = join(REPO, 'scripts', 'hooks');
const HOME = '/Users/ktos';

/** Zestaw kopii, w którym plik wolno importować z `./` (nazwa listy tylko do komunikatu). */
interface Zestaw {
  readonly nazwa: string;
  readonly pliki: readonly string[];
}

const HOOK: Zestaw = { nazwa: 'HOOK_INSTALL_FILES', pliki: HOOK_INSTALL_FILES };
/** Skrypt `statusLine` nie importuje niczego poza `node:` — lista `./` to on sam. */
const STATUSLINE: Zestaw = { nazwa: 'STATUSLINE_INSTALL_FILES', pliki: STATUSLINE_INSTALL_FILES };

/** Naruszenia reguły 2 w jednym pliku hooka (`nazwa` tylko do komunikatu). */
function importyHooka(nazwa: string, source: string, zestaw: Zestaw = HOOK): string[] {
  const { code, skeleton } = scan(source);
  const out: string[] = [];
  const zly = unbalanced(skeleton);
  if (zly !== null) out.push(`${nazwa}: skaner zgubił kod (${zly})`);
  const dozwolony = (spec: string): boolean => spec.startsWith('node:')
    || (spec.startsWith('./') && zestaw.pliki.includes(spec.slice(2)));
  const sprawdz = (spec: string, skad: string): void => {
    if (!dozwolony(spec)) out.push(`${nazwa}: ${skad} ${JSON.stringify(spec)} spoza \`node:\` i ${zestaw.nazwa}`);
  };
  for (const m of code.matchAll(/\bimport\s+(?!\()(?:[\w$\s{},*]+?\s+from\s*)?(['"])([^'"]*)\1/g)) {
    sprawdz(m[2] ?? '', 'import');
  }
  for (const m of code.matchAll(/\bexport\s+[^;'"]*?\bfrom\s*(['"])([^'"]*)\1/g)) sprawdz(m[2] ?? '', 're-eksport');
  for (const m of code.matchAll(/\bimport\s*\(/g)) {
    const reszta = code.slice((m.index ?? 0) + m[0].length);
    const literal = /^\s*(['"])([^'"]*)\1\s*\)/.exec(reszta)
      ?? /^\s*new\s+URL\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)\.href\s*\)/.exec(reszta);
    if (literal === null) out.push(`${nazwa}: import() z argumentem innym niż literał: ${reszta.slice(0, 60)}`);
    else sprawdz(literal[2] ?? '', 'import()');
  }
  for (const m of code.matchAll(/\bnew\s+URL\s*\(/g)) {
    const reszta = code.slice((m.index ?? 0) + m[0].length);
    const literal = /^\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)/.exec(reszta);
    if (literal !== null) sprawdz(literal[2] ?? '', 'new URL');
    else if (/^[^)]*import\.meta\.url/.test(reszta)) out.push(`${nazwa}: new URL(…, import.meta.url) bez literału`);
  }
  if (/\brequire\s*\(/.test(code)) out.push(`${nazwa}: require()`);
  if (/\bcreateRequire\b/.test(code)) out.push(`${nazwa}: createRequire`);
  if (/\bimport\.meta\.(?:dirname|filename|resolve)\b|\b__dirname\b|\b__filename\b/.test(code)) {
    out.push(`${nazwa}: ścieżka obok modułu poza new URL(literał, import.meta.url)`);
  }
  return out;
}

/** Reguła 2 dla katalogu z plikami zestawu (repo albo kopia w katalogu tymczasowym). */
function domkniecie(dir: string, zestaw: Zestaw = HOOK): string[] {
  return zestaw.pliki.flatMap((name) => importyHooka(name, readFileSync(join(dir, name), 'utf8'), zestaw));
}

/** Pliki `.ts` (albo z `rozszerzenia`) pod `dir` korzenia `root`: ścieżka względna → treść. */
function zrodla(root: string, dir: string, rozszerzenia: readonly string[] = ['.ts']): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const item of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, item.name);
      if (item.isDirectory()) walk(path);
      else if (rozszerzenia.some((ext) => item.name.endsWith(ext))) out.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(join(root, dir));
  return out;
}

const DEFINICJA = 'server/src/herdr/hook-config.ts';
const CLI = 'server/src/cli/hooks.ts';
const SETUP = 'server/src/cli/setup.ts';
const SERVICE = 'server/src/cli/service.ts';

/** Instalatory kopii i pliki, które wolno im je wołać. */
const WOLAJACY: Readonly<Record<string, readonly string[]>> = {
  installHookCopy: [CLI, SETUP],
  installMissingHookCopy: [SETUP],
  installStatuslineCopy: [SETUP],
};

/** Reguła 7: usunięcie katalogu kopii i pliki, które wolno je wołać. */
const USUWAJACY: Readonly<Record<string, readonly string[]>> = {
  removeHookCopy: [SERVICE],
};

/**
 * Reguły 3 i 7: instalatory i usunięcie kopii wołane wyłącznie z dozwolonych plików CLI (definicja w `hook-config.ts`
 * nie wchodzi w rachubę).
 */
function wolajacyInstalacji(
  pliki: ReadonlyMap<string, string>, mapa: Readonly<Record<string, readonly string[]>> = { ...WOLAJACY, ...USUWAJACY },
): string[] {
  const out: string[] = [];
  for (const [plik, source] of pliki) {
    const { code } = scan(source);
    code.split('\n').forEach((line, i) => {
      for (const [funkcja, dozwolone] of Object.entries(mapa)) {
        if (!new RegExp(`\\b${funkcja}\\b`).test(line)) continue;
        if (plik === DEFINICJA && new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${funkcja}\\s*\\(`).test(line)) {
          continue;
        }
        if (dozwolone.includes(plik)) continue;
        out.push(`${plik}:${String(i + 1)}: ${line.trim()}`);
      }
    });
  }
  return out;
}

const PISARZ = 'server/src/cli/claude-settings.ts';
/** Pliki, którym wolno importować pisarza ustawień Claude Code (reguła 6). */
const SETUP_SETTINGS = 'server/src/cli/setup-settings.ts';
const IMPORTUJACY_PISARZA: readonly string[] = [CLI, SETUP_SETTINGS, SERVICE];
/** Specyfikator modułu, który prowadzi do pisarza ustawień (z rozszerzeniem albo bez). */
const DO_PISARZA = /(?:^|\/)claude-settings(?:\.[cm]?[jt]s)?$/;

/** Reguła 6: literały w kodzie (bez komentarzy) innych plików niż CLI, które wskazują moduł pisarza ustawień. */
function importujacyPisarza(pliki: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [plik, source] of pliki) {
    if (plik === PISARZ || IMPORTUJACY_PISARZA.includes(plik)) continue;
    for (const literal of scan(source).literals) {
      if (DO_PISARZA.test(literal.text)) out.push(`${plik}: ${JSON.stringify(literal.text)}`);
    }
  }
  return out;
}

/** Flagi, które pomijałyby pytanie `[y/N]` przed zapisem ustawień (reguła 6: takiej flagi nie ma). */
const FLAGI_BEZ_PYTANIA = [
  '--yes', '-y', '--force', '--assume-yes', '--yes-to-all', '--no-confirm', '--no-prompt', '--non-interactive',
  '--noninteractive', '--auto-approve', '--unattended', '--batch',
];
const FLAGA_BEZ_PYTANIA = new RegExp(`(?:^|[\\s\\[|,(])(${FLAGI_BEZ_PYTANIA.join('|')})(?=$|[\\s\\]|,)=])`);

/** Pliki CLI z regułą „bez flagi pomijającej pytanie”: `server/src/cli/`, `bin/` i podkładka `hooks:*`. */
function plikiCli(): Map<string, string> {
  return new Map([
    ...zrodla(REPO, 'server/src/cli'), ...zrodla(REPO, 'bin', ['.mjs', '.ts']),
    ['scripts/hooks-config.ts', readFileSync(join(REPO, 'scripts', 'hooks-config.ts'), 'utf8')],
  ]);
}

/** Reguła 6: literały plików CLI (sama flaga albo tekst użycia), w których stoi flaga pomijająca pytanie. */
function flagiBezPytania(pliki: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [plik, source] of pliki) {
    for (const literal of scan(source).literals) {
      const flaga = FLAGA_BEZ_PYTANIA.exec(literal.text)?.[1];
      if (flaga !== undefined) out.push(`${plik}: ${flaga}`);
    }
  }
  return out;
}

describe('strażnik granicy hooka: komenda wskazuje kopię, nie checkout', () => {
  it('komenda: `node \'<home>/.claude/hooks/rarog/rarog-pending.mjs\' --answer-wait=86398`', () => {
    const command = hookCommand(HOME);
    expect(command).toBe(`node '${HOME}/${HOOK_INSTALL_DIR_REL}/rarog-pending.mjs' --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`);
    expect(hookInstallDir(HOME)).toBe(`${HOME}/.claude/hooks/rarog`);
    expect(command, 'komenda nie może prowadzić do checkoutu').not.toContain(repoRoot());
    expect(command).not.toContain('scripts/hooks');
  });

  it('apostrof w ścieżce domu nie rozrywa komendy (cytowanie powłoki)', () => {
    expect(hookCommand("/Users/o'neil")).toBe(
      `node '/Users/o'\\''neil/${HOOK_INSTALL_DIR_REL}/rarog-pending.mjs' --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`);
  });

  it('blok do wklejenia niesie tylko komendę kopii', () => {
    const text = renderHookBlock(hookCommand(HOME));
    expect(text).not.toContain(repoRoot());
    expect(text).not.toContain('scripts/hooks');
    expect(JSON.parse(text)).toEqual(hookBlock(hookCommand(HOME)));
  });

  it('instalatory kopii woła tylko CLI: `hooks.ts` i `setup.ts`', () => {
    const pliki = new Map([...zrodla(REPO, 'server/src'), ...zrodla(REPO, 'scripts')]);
    expect(pliki.get(CLI), 'CLI przestało instalować kopię').toMatch(/\binstallHookCopy\(/);
    expect(pliki.get(SETUP), 'setup przestał instalować kopię skryptu').toMatch(/\binstallStatuslineCopy\(/);
    expect(pliki.get(SETUP), 'setup przestał instalować brakującą kopię').toMatch(/\binstallMissingHookCopy\(/);
    expect(pliki.get(SETUP), 'setup przestał aktualizować kopię różną od źródła (E5)').toMatch(/\binstallHookCopy\(/);
    expect(wolajacyInstalacji(pliki)).toEqual([]);
  });
});

describe('strażnik granicy hooka: domknięcie importów `HOOK_INSTALL_FILES`', () => {
  it('lista to sześć plików z `scripts/hooks/` (z kanałem zgód, filtrem `cwd` i hookiem kontekstu); moduły przed'
    + ' hookiem', () => {
    expect([...HOOK_INSTALL_FILES].sort()).toEqual([
      'canon.mjs', 'consent.mjs', 'rarog-context.mjs', 'rarog-pending.mjs', 'tall-dialog.mjs', 'work-area.mjs',
    ]);
    expect(HOOK_INSTALL_FILES.at(-1), 'hook instalowany po swoich modułach').toBe('rarog-pending.mjs');
    expect(HOOK_INSTALL_FILES.indexOf('canon.mjs'), '`consent.mjs` importuje `canon.mjs`')
      .toBeLessThan(HOOK_INSTALL_FILES.indexOf('consent.mjs'));
    expect(HOOK_INSTALL_FILES.indexOf('work-area.mjs'), 'oba hooki importują `work-area.mjs`')
      .toBeLessThan(HOOK_INSTALL_FILES.indexOf('rarog-context.mjs'));
    for (const name of HOOK_INSTALL_FILES) expect(readFileSync(join(HOOKS_DIR, name), 'utf8').length).toBeGreaterThan(0);
  });

  it('pliki z repo sięgają tylko po `node:` i po siebie nawzajem', () => {
    expect(domkniecie(HOOKS_DIR)).toEqual([]);
  });

  it('skrypt `statusLine`: jeden plik z `scripts/hooks/`, sięga wyłącznie po `node:`', () => {
    expect([...STATUSLINE_INSTALL_FILES]).toEqual(['rarog-statusline.mjs']);
    expect(domkniecie(HOOKS_DIR, STATUSLINE)).toEqual([]);
    // Import pliku hooka ze skryptu `statusLine` przewraca strażnika: zestawy kopii są rozłączne.
    const source = `${readFileSync(join(HOOKS_DIR, 'rarog-statusline.mjs'), 'utf8')}\nimport './tall-dialog.mjs';\n`;
    expect(importyHooka('rarog-statusline.mjs', source, STATUSLINE)).toEqual([
      'rarog-statusline.mjs: import "./tall-dialog.mjs" spoza `node:` i STATUSLINE_INSTALL_FILES',
    ]);
  });

  it('komenda `statusLine` wskazuje kopię, nie checkout; łańcuch jako jeden argument powłoki', () => {
    expect(statuslineCommand(HOME)).toBe(`node '${HOME}/${HOOK_INSTALL_DIR_REL}/rarog-statusline.mjs'`);
    expect(statuslineCommand(HOME, "a 'b'")).toBe(
      `RAROG_STATUSLINE_CHAIN='a '\\''b'\\''' node '${HOME}/${HOOK_INSTALL_DIR_REL}/rarog-statusline.mjs'`);
    expect(statuslineCommand(HOME)).not.toContain(repoRoot());
  });

  it('dynamiczny import strażnika wysokości jest rozpoznany (literał w new URL)', () => {
    expect(importyHooka('x.mjs', "await import(new URL('./spoza.mjs', import.meta.url).href);"))
      .toEqual(['x.mjs: import() "./spoza.mjs" spoza `node:` i HOOK_INSTALL_FILES', 'x.mjs: new URL "./spoza.mjs" spoza `node:` i HOOK_INSTALL_FILES']);
  });
});

describe('strażnik granicy hooka: mutacje kopii plików hooka w katalogu tymczasowym', () => {
  let dir = '';
  let pending = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-hook-granica-'));
    for (const name of HOOK_INSTALL_FILES) await writeFile(join(dir, name), await readFile(join(HOOKS_DIR, name)));
    pending = await readFile(join(dir, 'rarog-pending.mjs'), 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Naruszenia kopii po dopisaniu `tail` do hooka; plik wraca do oryginału przed końcem. */
  async function poMutacji(tail: string): Promise<string[]> {
    await writeFile(join(dir, 'rarog-pending.mjs'), `${pending}\n${tail}\n`);
    try {
      return domkniecie(dir);
    } finally {
      await writeFile(join(dir, 'rarog-pending.mjs'), pending);
    }
  }

  it('niezmieniona kopia przechodzi', () => {
    expect(domkniecie(dir)).toEqual([]);
  });

  it('import spoza listy, ścieżka bezwzględna i moduł bez `node:` przewracają strażnika', async () => {
    for (const tail of [
      "import { x } from '../../server/src/config.ts';",
      "import '/Users/ktos/zly.mjs';",
      "import fs from 'fs';",
      "export { y } from './inny.mjs';",
      "const m = await import('./inny.mjs');",
      "const m = await import('file:///tmp/zly.mjs');",
      "const u = new URL('../../package.json', import.meta.url);",
    ]) {
      const out = await poMutacji(tail);
      expect(out, tail).toHaveLength(1);
      expect(out[0], tail).toMatch(/^rarog-pending\.mjs: .* spoza `node:` i HOOK_INSTALL_FILES$/);
    }
  });

  it('import() bez literału, require, createRequire i import.meta.dirname przewracają strażnika', async () => {
    for (const [tail, powod] of [
      ["const name = './tall-dialog.mjs';\nawait import(name);", 'import() z argumentem innym niż literał'],
      ['await import(`./${"tall-dialog"}.mjs`);', 'import() z argumentem innym niż literał'],
      ["const fs = require('node:fs');", 'require()'],
      ["import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);", 'createRequire'],
      ["const p = join(import.meta.dirname, 'x.mjs');", 'ścieżka obok modułu'],
    ] as const) {
      const out = await poMutacji(tail);
      expect(out, tail).toEqual([expect.stringContaining(powod)]);
    }
  });

  it('wywołanie `installHookCopy` z modułu serwera przewraca strażnika', async () => {
    const copy = join(dir, 'index.ts');
    await writeFile(copy, `${readFileSync(join(REPO, 'server/src/index.ts'), 'utf8')}\nvoid installHookCopy({});\n`);
    const pliki = new Map([...zrodla(REPO, 'server/src'), ['server/src/index.ts', await readFile(copy, 'utf8')]]);
    expect(wolajacyInstalacji(pliki)).toEqual([expect.stringMatching(/^server\/src\/index\.ts:\d+: void installHookCopy/)]);
  });

  it('wywołanie `installHookCopy` z innego pliku CLI niż `hooks.ts` i `setup.ts` przewraca strażnika', async () => {
    const copy = join(dir, 'doctor.ts');
    await writeFile(copy, `${readFileSync(join(REPO, 'server/src/cli/doctor.ts'), 'utf8')}\nvoid installHookCopy({});\n`);
    const pliki = new Map([...zrodla(REPO, 'server/src'), ['server/src/cli/doctor.ts', await readFile(copy, 'utf8')]]);
    expect(wolajacyInstalacji(pliki)).toEqual([
      expect.stringMatching(/^server\/src\/cli\/doctor\.ts:\d+: void installHookCopy/),
    ]);
  });

  it('wywołanie `installStatuslineCopy` spoza dozwolonego CLI przewraca strażnika', async () => {
    const copy = join(dir, 'index.ts');
    await writeFile(copy, `${readFileSync(join(REPO, 'server/src/index.ts'), 'utf8')}\nvoid installStatuslineCopy({});\n`);
    const pliki = new Map([...zrodla(REPO, 'server/src'), ['server/src/index.ts', await readFile(copy, 'utf8')]]);
    expect(wolajacyInstalacji(pliki)).toEqual([
      expect.stringMatching(/^server\/src\/index\.ts:\d+: void installStatuslineCopy/),
    ]);
  });
});

/** Ścieżka instalacji w trybie paczki: nazwa do komunikatu, pliki źródła i wywołanie instalatora. */
interface Sciezka {
  readonly nazwa: string;
  readonly pliki: readonly string[];
  readonly manifest: boolean;
  readonly instaluj: (opts: HookInstallOptions) => Promise<HookInstallResult>;
}

const SCIEZKI: readonly Sciezka[] = [
  {
    nazwa: 'installHookCopy', pliki: [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], manifest: true,
    instaluj: installHookCopy,
  },
  {
    nazwa: 'installMissingHookCopy', pliki: [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], manifest: true,
    instaluj: installMissingHookCopy,
  },
  { nazwa: 'installStatuslineCopy', pliki: STATUSLINE_INSTALL_FILES, manifest: false, instaluj: installStatuslineCopy },
];

/** Eksportowane funkcje `source`, których sygnatura zwraca `HookInstallResult` (instalatory kopii). */
function instalatoryW(source: string): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const name = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(line)?.[1];
    if (name === undefined) return;
    let end = i;
    while (end < lines.length - 1 && !/\)\s*(?::.*)?\{\s*$/.test(lines[end] ?? '')) end += 1;
    if (lines.slice(i, end + 1).join('\n').includes('HookInstallResult')) out.push(name);
  });
  return out;
}

/** Nazwy funkcji najwyższego poziomu w `source`, w których stoi wywołanie `funkcja(` (bez linii definicji). */
function wolaneW(source: string, funkcja: string): string[] {
  const out: string[] = [];
  let biezaca = '';
  for (const line of scan(source).code.split('\n')) {
    const definicja = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (definicja !== null) biezaca = definicja[1] ?? '';
    if (definicja?.[1] === funkcja) continue;
    if (new RegExp(`\\b${funkcja}\\(`).test(line)) out.push(biezaca);
  }
  return out;
}

describe('strażnik granicy hooka (tryb paczki): różnica przed zapisem, zapis tylko zweryfikowanych buforów', () => {
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  /** Paczka nie ma gita: wywołanie runnera to błąd ścieżki paczki. */
  const bezGita: GitArgsRunner = () => Promise.reject(new Error('git w trybie paczki'));
  let t: TempHome;
  let home = '';
  let pkg = '';

  beforeEach(async () => {
    t = tempHome('rarog-hook-granica-paczka-');
    home = join(t.home, 'h');
    pkg = join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(pkg, 'scripts', 'hooks'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version: '2.0.0' }));
    for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
      await copyFile(join(HOOKS_DIR, name), join(pkg, 'scripts', 'hooks', name));
    }
  });

  afterEach(() => { t.cleanup(); });

  afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

  /** Pliki w katalogu kopii (pusta lista bez katalogu). */
  const wKopii = (): string[] => {
    try {
      return readdirSync(hookInstallDir(home)).sort();
    } catch {
      return [];
    }
  };

  it('instalatory w `hook-config.ts` to dokładnie ścieżki z reguły 3; bramy źródła woła tylko `reviewedSources`', () => {
    const source = readFileSync(join(REPO, DEFINICJA), 'utf8');
    expect(instalatoryW(source).sort()).toEqual(Object.keys(WOLAJACY).sort());
    expect(instalatoryW('export async function zapisz(\n  a: number,\n): Promise<HookInstallResult> {\n}\n'))
      .toEqual(['zapisz']);
    expect(SCIEZKI.map((one) => one.nazwa).sort()).toEqual(Object.keys(WOLAJACY).sort());
    expect(wolaneW(source, 'installedSources')).toEqual(['reviewedSources']);
    expect(wolaneW(source, 'committedSources')).toEqual(['reviewedSources']);
    // Negatyw: drugi odczyt źródła w instalatorze wychodzi poza `reviewedSources`.
    expect(wolaneW(`${source}\nexport async function installX() {\n  installedSources(root, names);\n}\n`,
      'installedSources')).toEqual(['reviewedSources', 'installX']);
  });

  for (const sciezka of SCIEZKI) {
    it(`${sciezka.nazwa}: różnica przed zapisem; zapis = bufory z różnicy, choć źródło zmieniło się w trakcie pytania`, async () => {
      let pytania = 0;
      let widziane: HookCopyReview | null = null;
      const result = await sciezka.instaluj({
        home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => null,
        review: async (review) => {
          pytania += 1;
          widziane = review;
          expect(wKopii(), 'przed odpowiedzią nic nie zapisane').toEqual([]);
          for (const name of sciezka.pliki) await appendFile(join(pkg, 'scripts', 'hooks', name), '// podmiana\n');
          return true;
        },
      });
      expect(result, sciezka.nazwa).toMatchObject({ ok: true, commit: null, version: '2.0.0' });
      expect(pytania).toBe(1);
      const review = widziane as HookCopyReview | null;
      expect([...new Set(review?.changes.map((one) => one.name))].sort()).toEqual([...sciezka.pliki].sort());
      for (const change of review?.changes ?? []) {
        const zapisane = readFileSync(join(hookInstallDir(home), change.name));
        expect(sha256(zapisane), `${change.name}: zapisany bufor z różnicy`).toBe(change.sourceSha);
        expect(zapisane.toString('utf8')).not.toContain('// podmiana');
      }
      if (sciezka.manifest) {
        const manifest = JSON.parse(readFileSync(join(hookInstallDir(home), HOOK_MANIFEST_FILENAME), 'utf8')) as
          Record<string, unknown>;
        expect(manifest['version']).toBe('2.0.0');
        expect(manifest).not.toHaveProperty('commit');
      }
    });

    it(`${sciezka.nazwa}: usługa innej instalacji → odmowa przed różnicą i pytaniem, nic nie zapisane`, async () => {
      let pytania = 0;
      let sprawdzenia = 0;
      const result = await sciezka.instaluj({
        home, root: pkg, mode: 'package', git: bezGita,
        serviceRefusal: () => {
          sprawdzenia += 1;
          return 'usługa wskazuje inną instalację';
        },
        review: () => {
          pytania += 1;
          return Promise.resolve(true);
        },
      });
      expect(result).toEqual({ ok: false, reason: 'usługa wskazuje inną instalację' });
      expect(pytania).toBe(0);
      expect(sprawdzenia).toBe(1);
      expect(wKopii()).toEqual([]);
    });

    it(`${sciezka.nazwa}: usługa przepięta w trakcie pytania → odmowa po „t”, nic nie zapisane`, async () => {
      let pytania = 0;
      const result = await sciezka.instaluj({
        home, root: pkg, mode: 'package', git: bezGita,
        serviceRefusal: () => (pytania === 0 ? null : 'usługa wskazuje inną instalację'),
        review: () => {
          pytania += 1;
          return Promise.resolve(true);
        },
      });
      expect(result).toEqual({ ok: false, reason: 'usługa wskazuje inną instalację' });
      expect(pytania).toBe(1);
      expect(wKopii()).toEqual([]);
    });

    it(`${sciezka.nazwa}: „nie” i brak pytania (bez terminala) → nic nie zapisane`, async () => {
      const nie = await sciezka.instaluj({
        home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => null, review: () => Promise.resolve(false),
      });
      expect(nie).toMatchObject({ ok: false, declined: true });
      expect(wKopii()).toEqual([]);
      const bez = await sciezka.instaluj({ home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => null });
      expect(bez.ok).toBe(false);
      expect(bez.ok ? null : bez.review?.changes.length).toBeGreaterThan(0);
      expect(wKopii()).toEqual([]);
    });
  }

  it('usługa innej instalacji, kopia już z tymi bajtami: zapis przechodzi, zmienia się tylko manifest', async () => {
    const pierwsza = await installHookCopy({
      home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => null, review: () => Promise.resolve(true),
    });
    expect(pierwsza.ok).toBe(true);
    const pliki = wKopii().filter((name) => name !== HOOK_MANIFEST_FILENAME);
    const przed = pliki.map((name) => sha256(readFileSync(join(hookInstallDir(home), name))));
    // `rename` z pliku tymczasowego daje nowy i-węzeł: ten sam = pliku kodu nikt nie zapisał.
    const wezly = (): number[] => pliki.map((name) => statSync(join(hookInstallDir(home), name)).ino);
    const wezlyPrzed = wezly();
    const manifest = join(hookInstallDir(home), HOOK_MANIFEST_FILENAME);
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version: '2.0.1' }));
    const druga = await installHookCopy({
      home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => 'usługa wskazuje inną instalację',
    });
    expect(druga).toMatchObject({ ok: true, version: '2.0.1' });
    expect(pliki.map((name) => sha256(readFileSync(join(hookInstallDir(home), name))))).toEqual(przed);
    expect(wezly()).toEqual(wezlyPrzed);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ version: '2.0.1' });

    // Instalacja usługi zmienia kopię po sprawdzeniu (`now` biegnie po bramie, przed zapisem): zmiana zostaje,
    // manifest też, a instalator odmawia.
    const kanon = join(hookInstallDir(home), 'canon.mjs');
    const manifestPrzed = readFileSync(manifest, 'utf8');
    const wyscig = await installHookCopy({
      home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => 'usługa wskazuje inną instalację',
      now: () => {
        appendFileSync(kanon, '// nowsza wersja z instalacji usługi\n');
        return 1;
      },
    });
    expect(wyscig.ok ? null : wyscig.reason).toMatch(/changed during the install/);
    expect(readFileSync(kanon, 'utf8')).toMatch(/\/\/ nowsza wersja z instalacji usługi\n$/);
    expect(readFileSync(manifest, 'utf8')).toBe(manifestPrzed);
    await writeFile(kanon, readFileSync(join(pkg, 'scripts', 'hooks', 'canon.mjs')));
    // Jeden bajt inny w źródle: ta sama usługa daje już odmowę, kopia bez zmian.
    await appendFile(join(pkg, 'scripts', 'hooks', 'canon.mjs'), '// inny bajt\n');
    const trzecia = await installHookCopy({
      home, root: pkg, mode: 'package', git: bezGita, serviceRefusal: () => 'usługa wskazuje inną instalację',
      review: () => Promise.resolve(true),
    });
    expect(trzecia).toEqual({ ok: false, reason: 'usługa wskazuje inną instalację' });
    expect(pliki.map((name) => sha256(readFileSync(join(hookInstallDir(home), name))))).toEqual(przed);
  });
});

/** Reguła 4: kopia bez pytania tylko przy znaczniku `installed` blokady aktualizacji. */
const BEZ_PYTANIA = 'copyWithoutQuestion';
const UPDATE = 'server/src/cli/update.ts';
const SETUP_CONTEXT = 'server/src/cli/setup-context.ts';

/** Linie kodu (bez komentarzy), w których pole kopii bez pytania stoi, i miejsca, w których wolno mu stać. */
const BEZ_PYTANIA_DOZWOLONE: Readonly<Record<string, readonly RegExp[]>> = {
  // Deklaracja pola kontekstu i parametru `finishSteps`.
  [SETUP_CONTEXT]: [/^readonly copyWithoutQuestion: boolean;$/],
  [SETUP]: [
    /^readonly copyWithoutQuestion: boolean;$/,
    // `rarog setup`: nigdy; `finishSteps`: to, co podaje `update.ts`.
    /, copyWithoutQuestion: false,$/,
    /, copyWithoutQuestion: run\.copyWithoutQuestion,$/,
    // Jedyne użycie: pytanie o kopię odpada, różnica zostaje (`review` instalatora).
    /\(question === null \|\| ctx\.copyWithoutQuestion \? ctx\.ask !== null$/,
  ],
  [UPDATE]: [
    /^const copyWithoutQuestion = justInstalledHere\(installed, update\.root\);$/,
    /^if \(copyWithoutQuestion\) view\.log\.line\(/,
    /^copyWithoutQuestion,$/,
  ],
};

/** Linie z polem kopii bez pytania poza {@link BEZ_PYTANIA_DOZWOLONE}: `plik:linia: kod`. */
function kopiaBezPytania(pliki: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [plik, source] of pliki) {
    scan(source).code.split('\n').forEach((line, i) => {
      if (!line.includes(BEZ_PYTANIA)) return;
      const kod = line.trim();
      if ((BEZ_PYTANIA_DOZWOLONE[plik] ?? []).some((wzorzec) => wzorzec.test(kod))) return;
      out.push(`${plik}:${String(i + 1)}: ${kod}`);
    });
  }
  return out;
}

describe('strażnik granicy hooka (reguła 4): kopia bez pytania tylko przy znaczniku `installed`', () => {
  const cli = (): Map<string, string> => zrodla(REPO, 'server/src');

  it('pole ustawia tylko `update.ts` ze znacznika blokady; setup daje `false`, `hooks install` pola nie zna', () => {
    const pliki = cli();
    expect(kopiaBezPytania(pliki)).toEqual([]);
    for (const plik of [SETUP_CONTEXT, SETUP, UPDATE]) {
      expect(scan(pliki.get(plik) ?? '').code, `${plik} przestał nieść pole`).toContain(BEZ_PYTANIA);
    }
    expect(scan(pliki.get(CLI) ?? '').code).not.toContain(BEZ_PYTANIA);
    // Znacznik: `installed` z blokady, jego korzeń równy tej instalacji, jego wersja równa tej wersji.
    const update = scan(pliki.get(UPDATE) ?? '').code;
    const cialo = update.slice(update.indexOf('function justInstalledHere('));
    expect(cialo.slice(0, cialo.indexOf('\n}\n'))).toMatch(
      /return installed !== null && sameDir\(installed\.root, root\) && installed\.version === readPackageVersion\(\);/u,
    );
  });

  it('pole ustawione na `true` w setup, w `hooks.ts` albo poza znacznikiem w `update.ts` przewraca strażnika', () => {
    for (const [plik, linia] of [
      [SETUP, '  copyWithoutQuestion: true,'],
      [CLI, 'const copyWithoutQuestion = true;'],
      [UPDATE, 'const copyWithoutQuestion = update.lock.inherited;'],
      ['server/src/cli/main.ts', 'export const copyWithoutQuestion = true;'],
    ] as const) {
      const pliki = new Map([[plik, `${readFileSync(join(REPO, plik), 'utf8')}\n${linia}\n`]]);
      expect(kopiaBezPytania(pliki), linia).toEqual([expect.stringMatching(new RegExp(`^${plik}:\\d+: `, 'u'))]);
    }
    // Komentarz z nazwą pola nie jest kodem.
    const komentarz = new Map([[CLI, `${readFileSync(join(REPO, CLI), 'utf8')}\n// copyWithoutQuestion: true\n`]]);
    expect(kopiaBezPytania(komentarz)).toEqual([]);
  });
});

describe('strażnik kanału zgód: decyzja hooka wyłącznie z przejętego, podpisanego pliku', () => {
  const pending = scan(readFileSync(join(HOOKS_DIR, 'rarog-pending.mjs'), 'utf8')).code;
  const consent = scan(readFileSync(join(HOOKS_DIR, 'consent.mjs'), 'utf8')).code;

  /** Treść funkcji `async function nazwa(` do pierwszej linii `}` na początku wiersza. */
  function body(code: string, name: string): string {
    const start = code.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return code.slice(start, code.indexOf('\n}\n', start));
  }

  it('w kodzie nie ma `interrupt`; `updatedPermissions` raz, w `consentOutput`, z listy ze stdin na zamkniętej liście',
    () => {
      for (const [name, code] of [['rarog-pending.mjs', pending], ['consent.mjs', consent]] as const) {
        expect(code, name).not.toMatch(/\binterrupt\b/);
      }
      expect(pending).not.toMatch(/\bupdatedPermissions\b/);
      expect([...consent.matchAll(/\bupdatedPermissions\b[^,}]*/g)].map((hit) => hit[0]))
        .toEqual(['updatedPermissions: suggestions ']);
      const output = body(consent, 'consentOutput');
      expect(output).toContain('!alwaysAllowed(suggestions)');
      expect(output.indexOf('!alwaysAllowed(suggestions)')).toBeLessThan(output.indexOf('updatedPermissions'));
      // `suggestions` w wyjściu to ta sama wartość ze stdin, która poszła do rejestracji, nie treść pliku odpowiedzi.
      expect(body(pending, 'consentChannel')).toContain('const suggestions = consent.carriedSuggestions(request.permissionSuggestions);');
      expect(body(pending, 'consentChannel')).toMatch(/consentOutput\(file, \{[^}]*\bsuggestions,\n/);
    });

  it('`updatedInput` wyłącznie z wejścia ze stdin: plan w kanale zgód, odpowiedzi na pytanie w kanale pytań', () => {
    expect([...consent.matchAll(/\bupdatedInput\b[^,}]*/g)].map((hit) => hit[0])).toEqual(['updatedInput: toolInput ']);
    expect(body(consent, 'consentOutput')).toContain('toolName === PLAN_TOOL');
    expect([...pending.matchAll(/\bupdatedInput\b/g)]).toHaveLength(1);
    expect(body(pending, 'consentChannel')).not.toMatch(/\bupdatedInput\b/);
  });

  it('`consent.mjs` ładowany dynamicznie w `try`, bez importu statycznego', () => {
    const load = "try {\n    consent = await import(new URL('./consent.mjs', import.meta.url).href);\n  } catch {";
    expect(pending).toContain(load);
    expect(pending.split("'./consent.mjs'")).toHaveLength(2);
    expect(pending).not.toMatch(/^import [^;]*'\.\/consent\.mjs'/m);
  });

  it('teksty `message` decyzji to wyłącznie tekst odmowy z listy `CONSENT_REASONS`', () => {
    expect([...consent.matchAll(/\bmessage: [^,}]+/g)].map((hit) => hit[0].trim()).sort()).toEqual([
      'message: DENY_MESSAGE', 'message: DENY_MESSAGE', 'message: null', 'message: null', 'message: null',
      'message: reason.message',
    ]);
    expect(body(pending, 'consentChannel')).not.toMatch(/\bmessage\b/);
  });

  it('treść odpowiedzi czytana wyłącznie z `.claimed` po `rename`: bez `readFileSync` w kanale i w module', () => {
    expect(consent).not.toMatch(/\breadFileSync\b|\breadFile\b|\bcreateReadStream\b/);
    expect(body(pending, 'consentChannel')).not.toMatch(/\breadFileSync\b|\bopenSync\b/);
    const claim = body(consent, 'claimConsentFile');
    expect(claim.indexOf('io.rename(')).toBeGreaterThan(-1);
    expect(claim.indexOf('io.rename(')).toBeLessThan(claim.indexOf('io.readClaimed('));
    expect(claim).toContain('io.readClaimed(claimed)');
    expect([...consent.matchAll(/\bopenSync\(/g)]).toHaveLength(1);
    expect(body(consent, 'readClaimed')).toContain('openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW');
  });
});

describe('strażnik granicy ustawień Claude Code: pisarz tylko z CLI, zawsze z pytaniem', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-pisarz-granica-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Źródła `server/src`, `scripts` i `bin` (`.ts` i `.mjs`) — tu szuka się importów pisarza. */
  const wszystkie = (): Map<string, string> => new Map([
    ...zrodla(REPO, 'server/src', ['.ts', '.mjs']), ...zrodla(REPO, 'scripts', ['.ts', '.mjs']),
    ...zrodla(REPO, 'bin', ['.ts', '.mjs']),
  ]);

  /** Treść `plik` z dopiskiem `tail` przez kopię w katalogu tymczasowym (repo zostaje nietknięte). */
  async function kopiaZ(plik: string, tail: string): Promise<string> {
    const copy = join(dir, plik.replaceAll('/', '_'));
    await writeFile(copy, `${readFileSync(join(REPO, plik), 'utf8')}\n${tail}\n`);
    return readFile(copy, 'utf8');
  }

  it('pisarza importują tylko `setup-settings.ts`, `hooks.ts` i `service.ts`', () => {
    const pliki = wszystkie();
    expect(pliki.has(PISARZ), 'pisarz ustawień zniknął albo zmienił miejsce').toBe(true);
    expect(pliki.get(SETUP_SETTINGS), 'setup przestał pisać wpisy hooków').toMatch(/from '\.\/claude-settings\.ts'/);
    expect(pliki.get(CLI), '`hooks install` przestał pisać wpisy hooków').toMatch(/from '\.\/claude-settings\.ts'/);
    expect(pliki.get(SERVICE), '`service uninstall` przestał zdejmować wpisy').toMatch(/from '\.\/claude-settings\.ts'/);
    expect(importujacyPisarza(pliki)).toEqual([]);
  });

  it('import pisarza z modułu serwera, import dynamiczny i re-eksport z innego pliku CLI przewracają strażnika', async () => {
    for (const [plik, tail, spec] of [
      ['server/src/index.ts', "import { writeClaudeSettings } from './cli/claude-settings.ts';", './cli/claude-settings.ts'],
      ['server/src/herdr/hook-config.ts', "const pisarz = await import('../cli/claude-settings.js');",
        '../cli/claude-settings.js'],
      ['server/src/cli/main.ts', "export { writeClaudeSettings } from './claude-settings';", './claude-settings'],
      ['scripts/hooks-config.ts', "import '../server/src/cli/claude-settings.ts';", '../server/src/cli/claude-settings.ts'],
    ] as const) {
      const pliki = new Map([...wszystkie(), [plik, await kopiaZ(plik, tail)]]);
      expect(importujacyPisarza(pliki), plik).toEqual([`${plik}: ${JSON.stringify(spec)}`]);
    }
    // Komentarz z nazwą pliku pisarza nie jest importem.
    const komentarz = new Map([['server/src/index.ts', await kopiaZ('server/src/index.ts', '// zob. ./cli/claude-settings.ts')]]);
    expect(importujacyPisarza(komentarz)).toEqual([]);
  });

  it('CLI nie ma flagi, która pomija pytanie przed zapisem', () => {
    expect(flagiBezPytania(plikiCli())).toEqual([]);
  });

  it('flaga pomijająca pytanie w `setup.ts` (literał albo tekst użycia) i w `bin/rarog.mjs` przewraca strażnika', async () => {
    for (const [plik, tail, flaga] of [
      [SETUP, "const skip = args.includes('--yes');", '--yes'],
      [SETUP, "const USAGE_X = 'Usage: rarog setup [--assume-yes] [--data-dir <dir>]';", '--assume-yes'],
      [SETUP, 'const y = `-y`;', '-y'],
      [CLI, "if (arg === '--force=1') return 0;", '--force'],
      ['bin/rarog.mjs', "const flags = ['--no-confirm'];", '--no-confirm'],
    ] as const) {
      const pliki = new Map([[plik, await kopiaZ(plik, tail)]]);
      expect(flagiBezPytania(pliki), tail).toEqual([`${plik}: ${flaga}`]);
    }
    // Słowa w zdaniu i inne flagi nie są flagą pomijającą pytanie.
    const zdanie = new Map([[SETUP, await kopiaZ(SETUP, "const t = 'answer yes to write --yesterday --data-dir';")]]);
    expect(flagiBezPytania(zdanie)).toEqual([]);
  });
});

/** Skrót wpisu manifestu, którego treść żadnego pliku w testach nie ma. */
const OBCY_SKROT = 'a'.repeat(64);

/**
 * Manifest kopii Raroga w kształcie z instalacji (wersja paczki, chwila, skróty `names`): plik zwykły, który leży
 * w `dir`, dostaje skrót swojej treści, a nieobecny albo inny niż plik zwykły {@link OBCY_SKROT}.
 */
function manifestKopii(dir: string, names: readonly string[]): string {
  const files = Object.fromEntries(names.map((name) => {
    const plik = join(dir, name);
    let sha = OBCY_SKROT;
    try {
      if (lstatSync(plik).isFile()) sha = createHash('sha256').update(readFileSync(plik)).digest('hex');
    } catch {
      // Pliku nie ma: wpis ze skrótem, którego nic nie ma.
    }
    return [name, sha];
  }));
  return `${JSON.stringify({ version: '1.0.0', at: 1, files }, null, 2)}\n`;
}

/**
 * Drzewo katalogu do porównania przed i po: ścieżka względna → treść pliku, `<dir>` albo cel dowiązania (`lstat`,
 * bez wchodzenia w dowiązania).
 */
function drzewo(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const sciezka = rel === '' ? name : `${rel}/${name}`;
    const info = lstatSync(join(root, sciezka));
    if (info.isSymbolicLink()) out[sciezka] = `-> ${readlinkSync(join(root, sciezka))}`;
    else if (info.isDirectory()) Object.assign(out, { [sciezka]: '<dir>' }, drzewo(root, sciezka));
    else out[sciezka] = readFileSync(join(root, sciezka), 'utf8');
  }
  return out;
}

describe('strażnik granicy kopii (reguła 7): katalog kopii usuwa tylko `rarog service uninstall`', () => {
  let t: TempHome;
  let home = '';

  beforeEach(() => {
    t = tempHome('rarog-kopia-usun-');
    home = join(t.home, 'h');
    mkdirSync(hookInstallDir(home), { recursive: true });
    writeFileSync(join(hookInstallDir(home), 'rarog-pending.mjs'), '// kopia\n');
    writeFileSync(join(hookInstallDir(home), HOOK_MANIFEST_FILENAME),
      manifestKopii(hookInstallDir(home), ['rarog-pending.mjs']));
  });

  afterEach(() => { t.cleanup(); });

  afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

  it('`removeHookCopy` woła tylko `service.ts`; wywołanie z modułu serwera albo z setup przewraca strażnika', async () => {
    const pliki = new Map([...zrodla(REPO, 'server/src'), ...zrodla(REPO, 'scripts')]);
    expect(pliki.get(SERVICE), '`service uninstall` przestał usuwać kopię').toMatch(/\bremoveHookCopy\(/);
    expect(wolajacyInstalacji(pliki, USUWAJACY)).toEqual([]);
    for (const plik of ['server/src/index.ts', SETUP]) {
      const source = `${readFileSync(join(REPO, plik), 'utf8')}\nremoveHookCopy(seen);\n`;
      expect(wolajacyInstalacji(new Map([[plik, source]]), USUWAJACY), plik)
        .toEqual([expect.stringMatching(/:\d+: removeHookCopy\(seen\);$/)]);
    }
  });

  it('prawdziwy katalog: pliki kopii, usunięcie po tym samym i-węźle, manifest na końcu, potem katalog', () => {
    const seen = hookCopyDirState(home);
    expect(seen).toMatchObject({
      kind: 'dir', dir: hookInstallDir(home), remove: [HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs'], keep: [],
    });
    if (seen.kind !== 'dir') return;
    expect(removeHookCopy(seen)).toEqual({
      ok: true, dirRemoved: true, removed: ['rarog-pending.mjs', HOOK_MANIFEST_FILENAME], left: [],
    });
    expect(existsSync(hookInstallDir(home))).toBe(false);
    expect(hookCopyDirState(home)).toEqual({ kind: 'missing', dir: hookInstallDir(home) });
  });

  it('manifest podmieniony w czasie pytania (ten sam katalog) → stop przed pierwszym usunięciem, pliki nietknięte', () => {
    const seen = hookCopyDirState(home);
    if (seen.kind !== 'dir') throw new Error(`oczekiwany katalog kopii, jest ${seen.kind}`);
    const manifest = join(hookInstallDir(home), HOOK_MANIFEST_FILENAME);
    const cudzy = '{"name":"My web app","icons":[]}\n';
    writeFileSync(manifest, cudzy);
    const result = removeHookCopy(seen);
    expect(result).toMatchObject({ ok: false, why: 'changed', removed: [] });
    expect(readFileSync(manifest, 'utf8')).toBe(cudzy);
    expect(readdirSync(hookInstallDir(home)).sort()).toEqual([HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs']);
  });

  it('`~/.claude/hooks` dowiązane do `~/Projects`: projekt `~/Projects/rarog` bez manifestu kopii → odmowa, projekt'
    + ' nietknięty', () => {
    const hooks = dirname(hookInstallDir(home));
    rmSync(hooks, { recursive: true });
    const projekt = join(home, 'Projects', 'rarog');
    mkdirSync(join(projekt, 'src'), { recursive: true });
    writeFileSync(join(projekt, 'package.json'), '{"name":"rarog-app"}\n');
    writeFileSync(join(projekt, 'src', 'app.ts'), 'export {};\n');
    // Manifest aplikacji webowej i plik o nazwie z kopii to jeszcze nie kopia Raroga.
    writeFileSync(join(projekt, HOOK_MANIFEST_FILENAME), '{"name":"Rarog","icons":[]}\n');
    writeFileSync(join(projekt, 'rarog-pending.mjs'), '// plik projektu\n');
    symlinkSync(join(home, 'Projects'), hooks);
    const przed = drzewo(projekt);
    const seen = hookCopyDirState(home);
    if (seen.kind === 'dir') removeHookCopy(seen);
    expect(drzewo(projekt)).toEqual(przed);
    expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('no Rarog copy manifest') });
  });

  it('`~/.claude/hooks` dowiązane do katalogu nad domem: kopia wypada na sam dom → odmowa, dom nietknięty', () => {
    const dom = join(t.home, 'home', 'rarog');
    const hooks = dirname(hookInstallDir(dom));
    mkdirSync(dirname(hooks), { recursive: true });
    symlinkSync(dirname(dom), hooks);
    // Nawet manifest kopii ze zgodnym skrótem i plik z zestawu w domu nie robią z domu katalogu kopii.
    writeFileSync(join(dom, 'rarog-pending.mjs'), '// w domu\n');
    writeFileSync(join(dom, HOOK_MANIFEST_FILENAME), manifestKopii(dom, ['rarog-pending.mjs']));
    writeFileSync(join(dom, 'notatki.txt'), 'moje\n');
    const przed = drzewo(dom);
    const seen = hookCopyDirState(dom);
    if (seen.kind === 'dir') removeHookCopy(seen);
    expect(existsSync(dom) ? drzewo(dom) : null).toEqual(przed);
    expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('the home directory') });
  });

  it('znikają tylko pliki kopii; obcy plik, podkatalog i dowiązanie pod nazwą z zestawu zostają z katalogiem', () => {
    const dir = hookInstallDir(home);
    writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), manifestKopii(dir, ['rarog-pending.mjs', 'canon.mjs']));
    writeFileSync(join(dir, 'notatki.txt'), 'moje\n');
    mkdirSync(join(dir, 'moje'));
    writeFileSync(join(dir, 'moje', 'plik'), 'x\n');
    const cel = join(t.home, 'cel.mjs');
    writeFileSync(cel, '// cel\n');
    symlinkSync(cel, join(dir, 'canon.mjs'));
    const seen = hookCopyDirState(home);
    const removal = seen.kind === 'dir' ? removeHookCopy(seen) : null;
    expect(drzewo(dir)).toEqual({
      'canon.mjs': `-> ${cel}`, moje: '<dir>', 'moje/plik': 'x\n', 'notatki.txt': 'moje\n',
    });
    expect(readFileSync(cel, 'utf8')).toBe('// cel\n');
    expect(seen).toMatchObject({
      kind: 'dir', remove: [HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs'], keep: ['canon.mjs', 'moje/', 'notatki.txt'],
    });
    expect(removal).toEqual({
      ok: true, dirRemoved: false, removed: ['rarog-pending.mjs', HOOK_MANIFEST_FILENAME],
      left: ['canon.mjs', 'moje/', 'notatki.txt'],
    });
  });

  it('plik wejściowy pod starą nazwą produktu (zamknięta lista) znika; plik spoza listy zostaje', () => {
    const dir = hookInstallDir(home);
    writeFileSync(join(dir, OLD_ENTRY_FILE), '// poprzednia instalacja\n');
    writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), manifestKopii(dir, ['rarog-pending.mjs', OLD_ENTRY_FILE]));
    writeFileSync(join(dir, 'inny-stary.mjs'), '// spoza listy\n');
    const seen = hookCopyDirState(home);
    if (seen.kind === 'dir') removeHookCopy(seen);
    expect(drzewo(dir)).toEqual({ 'inny-stary.mjs': '// spoza listy\n' });
    expect(seen).toMatchObject({
      kind: 'dir', remove: [HOOK_MANIFEST_FILENAME, OLD_ENTRY_FILE, 'rarog-pending.mjs'], keep: ['inny-stary.mjs'],
    });
  });

  it('podrobiony manifest z obcą nazwą i niezgodnym skrótem (`~/.claude/hooks` → `~/Projects`) → odmowa, nic nie'
    + ' znika', () => {
    const hooks = dirname(hookInstallDir(home));
    rmSync(hooks, { recursive: true });
    const projekt = join(home, 'Projects', 'rarog');
    mkdirSync(projekt, { recursive: true });
    writeFileSync(join(projekt, 'notatki.txt'), 'moje\n');
    writeFileSync(join(projekt, HOOK_MANIFEST_FILENAME),
      `${JSON.stringify({ version: '1.0.0', at: 1, files: { 'notatki.txt': 'c'.repeat(64) } })}\n`);
    symlinkSync(join(home, 'Projects'), hooks);
    const przed = drzewo(projekt);
    const seen = hookCopyDirState(home);
    if (seen.kind === 'dir') removeHookCopy(seen);
    expect(drzewo(projekt)).toEqual(przed);
    expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a Rarog copy') });
  });

  it('obca nazwa w manifeście → odmowa, choćby jej skrót i skrót pliku kopii się zgadzały', () => {
    const dir = hookInstallDir(home);
    writeFileSync(join(dir, 'notatki.txt'), 'moje\n');
    writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), manifestKopii(dir, ['rarog-pending.mjs', 'notatki.txt']));
    const przed = drzewo(dir);
    const seen = hookCopyDirState(home);
    if (seen.kind === 'dir') removeHookCopy(seen);
    expect(drzewo(dir)).toEqual(przed);
    expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('"notatki.txt"') });
    expect(seen).toMatchObject({ reason: expect.stringContaining('not a Rarog copy') });
  });

  for (const nazwa of ['../x', 'a/b', '/abs']) {
    it(`nazwa ${JSON.stringify(nazwa)} w manifeście → odmowa, nic nie znika`, () => {
      const dir = hookInstallDir(home);
      writeFileSync(join(dirname(dir), 'x'), 'obok kopii\n');
      const manifest = JSON.parse(manifestKopii(dir, ['rarog-pending.mjs'])) as { files: Record<string, string> };
      manifest.files[nazwa] = 'b'.repeat(64);
      writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), `${JSON.stringify(manifest)}\n`);
      const przed = drzewo(dirname(dir));
      const seen = hookCopyDirState(home);
      if (seen.kind === 'dir') removeHookCopy(seen);
      expect(drzewo(dirname(dir))).toEqual(przed);
      expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a Rarog copy') });
    });
  }

  it('żaden plik z manifestu nie ma skrótu z manifestu (inna treść albo brak pliku) → odmowa, nic nie znika', () => {
    const dir = hookInstallDir(home);
    for (const manifest of [
      `${JSON.stringify({ version: '1.0.0', at: 1, files: { 'rarog-pending.mjs': OBCY_SKROT } })}\n`,
      `${JSON.stringify({ version: '1.0.0', at: 1, files: { 'canon.mjs': OBCY_SKROT } })}\n`,
    ]) {
      writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), manifest);
      const przed = drzewo(dir);
      const seen = hookCopyDirState(home);
      if (seen.kind === 'dir') removeHookCopy(seen);
      expect(drzewo(dir), manifest).toEqual(przed);
      expect(seen, manifest).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a Rarog copy') });
    }
  });

  it('manifest jako dowiązanie do poprawnego manifestu albo jako katalog → odmowa, nic nie znika', () => {
    const dir = hookInstallDir(home);
    const obok = join(t.home, 'manifest-obok.json');
    writeFileSync(obok, manifestKopii(dir, ['rarog-pending.mjs']));
    unlinkSync(join(dir, HOOK_MANIFEST_FILENAME));
    symlinkSync(obok, join(dir, HOOK_MANIFEST_FILENAME));
    for (const rodzaj of ['dowiązanie', 'katalog']) {
      if (rodzaj === 'katalog') {
        unlinkSync(join(dir, HOOK_MANIFEST_FILENAME));
        mkdirSync(join(dir, HOOK_MANIFEST_FILENAME));
      }
      const przed = drzewo(dir);
      const seen = hookCopyDirState(home);
      if (seen.kind === 'dir') removeHookCopy(seen);
      expect(drzewo(dir), rodzaj).toEqual(przed);
      expect(seen, rodzaj)
        .toMatchObject({ kind: 'refused', reason: expect.stringContaining('no Rarog copy manifest') });
    }
    expect(readFileSync(obok, 'utf8')).toBe(manifestKopii(dir, ['rarog-pending.mjs']));
  });

  const bezManifestu = [['bez manifestu', null], ['manifest nie z kopii Raroga', '// manifest\n']] as const;
  for (const [nazwa, manifest] of bezManifestu) {
    it(`${nazwa} → odmowa, nic nie usunięte`, () => {
      const dir = hookInstallDir(home);
      if (manifest === null) unlinkSync(join(dir, HOOK_MANIFEST_FILENAME));
      else writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), manifest);
      const przed = drzewo(dir);
      const seen = hookCopyDirState(home);
      if (seen.kind === 'dir') removeHookCopy(seen);
      expect(drzewo(dir)).toEqual(przed);
      expect(seen).toMatchObject({ kind: 'refused', reason: expect.stringContaining('no Rarog copy manifest') });
    });
  }

  it('dowiązanie w miejscu katalogu → odmowa; katalog podmieniony po pytaniu → odmowa, nic nie usunięte', () => {
    const seen = hookCopyDirState(home);
    if (seen.kind !== 'dir') throw new Error('brak katalogu');
    const inny = join(t.home, 'inny');
    renameSync(hookInstallDir(home), inny);
    symlinkSync(inny, hookInstallDir(home));
    expect(hookCopyDirState(home)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('is a symlink') });
    expect(removeHookCopy(seen)).toMatchObject({ ok: false, reason: expect.stringContaining('changed during') });
    expect(readFileSync(join(inny, 'rarog-pending.mjs'), 'utf8')).toBe('// kopia\n');
    unlinkSync(hookInstallDir(home));
    mkdirSync(hookInstallDir(home));
    expect(removeHookCopy(seen)).toMatchObject({ ok: false, reason: expect.stringContaining('changed during') });
    expect(existsSync(hookInstallDir(home))).toBe(true);
  });
});
