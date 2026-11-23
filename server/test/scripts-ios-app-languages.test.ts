/*
 * `scripts/ios-app-languages.sh` — języki zbudowanej apki (`docs/localization.md`, „How the app picks its
 * language”). Drzewo `Rarog.app` jest syntetyczne, a `plutil` to atrapa na PATH: oddaje `CFBundleLocalizations`
 * z pliku `Info.plist.languages` obok `Info.plist`, więc test chodzi też poza macOS. Pakiety z copy skrypt bierze
 * z repo, tak jak na prawdziwym buildzie (`scripts/ios-check.sh` woła go po buildzie na urządzenie).
 *
 * Lint skryptu jedzie w `pnpm run check` (glob `scripts/*.sh`), nie tutaj.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts/ios-app-languages.sh');
const PACKAGES = path.join(REPO, 'native/Rarog/Packages');
/** Pakiety z katalogiem copy, w kolejności globu skryptu. */
const COPY = readdirSync(PACKAGES).filter((name) =>
  existsSync(path.join(PACKAGES, name, 'Sources', name, 'Copy', 'Localizable.xcstrings'))).sort();

const temporary: string[] = [];
afterAll(() => {
  for (const made of temporary.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** Klucze `loc-key` pusha w katalogu głównego celu apki i widżetu (`scripts/l10n-check.mjs`, `LOC_KEYS`). */
const LOC_KEYS = ['push.chime.body', 'push.chime.title', 'push.placeholder.body', 'push.placeholder.title'];

interface Layout {
  /** Języki `CFBundleLocalizations` per kontener (`.` = apka); `null` = bez klucza. */
  readonly declared?: Record<string, string[] | null>;
  /** Pliki do pominięcia (ścieżki względem `Rarog.app`). */
  readonly skip?: readonly string[];
  /** Klucze w `<język>.lproj/Localizable.strings` per plik (ścieżka względem `Rarog.app`); domyślnie {@link LOC_KEYS}. */
  readonly locKeys?: Record<string, readonly string[]>;
}

/**
 * Atrapa `plutil` i drzewo `Rarog.app`: apka z katalogiem `loc-key`, widżet z RarogActivity, RarogContract
 * i katalogiem `loc-key`, NSE z RarogContract. Atrapa oddaje przy `-convert` sam plik: test pisze w nim od razu JSON.
 */
function makeApp(layout: Layout = {}): { app: string; bin: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rarog-app-languages-'));
  temporary.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'plutil'), '#!/bin/bash\nfile="${*: -1}"\n'
    + 'if [[ "$1" == -convert ]]; then [[ -f "$file" ]] || exit 1; cat "$file"; exit 0; fi\n'
    + '[[ -f "$file.languages" ]] || exit 1\ncat "$file.languages"\n', { mode: 0o755 });
  const app = path.join(root, 'Rarog.app');
  const files = new Map<string, string>();
  const container = (rel: string, packages: readonly string[]): void => {
    files.set(path.join(rel, 'Info.plist'), '<plist/>');
    const declared = layout.declared?.[rel] === undefined ? ['en', 'pl'] : layout.declared[rel];
    if (declared) files.set(path.join(rel, 'Info.plist.languages'), JSON.stringify(declared));
    for (const name of packages) {
      for (const language of ['en', 'pl']) {
        files.set(path.join(rel, `${name}_${name}.bundle`, `${language}.lproj`, 'Localizable.strings'), '"k" = "v";');
      }
    }
  };
  const locKeys = (rel: string): void => {
    for (const language of ['en', 'pl']) {
      const file = path.join(rel, `${language}.lproj`, 'Localizable.strings');
      const keys = layout.locKeys?.[file] ?? LOC_KEYS;
      files.set(file, JSON.stringify(Object.fromEntries(keys.map((key) => [key, `${language} ${key}`]))));
    }
  };
  container('.', COPY);
  for (const language of ['en', 'pl']) files.set(path.join(language + '.lproj', 'InfoPlist.strings'), '"k" = "v";');
  locKeys('.');
  container('PlugIns/RarogWidgets.appex', ['RarogActivity', 'RarogContract']);
  locKeys('PlugIns/RarogWidgets.appex');
  container('PlugIns/RarogNotificationService.appex', ['RarogContract']);
  for (const [rel, text] of files) {
    if (layout.skip?.some((skipped) => rel === skipped || rel.startsWith(`${skipped}/`))) continue;
    mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    writeFileSync(path.join(app, rel), text);
  }
  return { app, bin };
}

const run = (args: string[], bin: string) => spawnSync('/bin/bash', [SCRIPT, ...args], {
  encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` }, timeout: 15_000,
});

describe('ios-app-languages: języki zbudowanej apki', () => {
  it('repo ma cztery pakiety z copy, które skrypt znajdzie (RarogContract: katalog zdań serwera)', () => {
    expect(COPY).toEqual(['RarogActivity', 'RarogContract', 'RarogCore', 'RarogUI']);
  });

  it('komplet: apka, widżet i NSE deklarują en i pl, zasoby pakietów mają oba .lproj, klucze loc-key — kod 0', () => {
    const { app, bin } = makeApp();
    const result = run([app], bin);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ios-app-languages: green (en, pl in Rarog.app, 2 extensions, package '
      + 'resources: RarogActivity_RarogActivity.bundle RarogContract_RarogContract.bundle RarogCore_RarogCore.bundle '
      + 'RarogUI_RarogUI.bundle '
      + 'PlugIns/RarogNotificationService.appex/RarogContract_RarogContract.bundle '
      + 'PlugIns/RarogWidgets.appex/RarogActivity_RarogActivity.bundle '
      + 'PlugIns/RarogWidgets.appex/RarogContract_RarogContract.bundle, '
      + 'push loc-keys: Rarog.app PlugIns/RarogWidgets.appex)');
  });

  it('NSE bez pl.lproj w zasobach RarogContract — kod 1 z listą', () => {
    const { app, bin } = makeApp({
      skip: ['PlugIns/RarogNotificationService.appex/RarogContract_RarogContract.bundle/pl.lproj'],
    });
    const result = run([app], bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe([
      `ios-app-languages: 1 problem(s) in ${app}:`,
      '  PlugIns/RarogNotificationService.appex/RarogContract_RarogContract.bundle: no pl.lproj',
      '',
    ].join('\n'));
  });

  it('zasoby RarogContract wymagane w widżecie i NSE, samo NSE też', () => {
    const noContract = makeApp({ skip: ['PlugIns/RarogNotificationService.appex/RarogContract_RarogContract.bundle',
      'PlugIns/RarogWidgets.appex/RarogContract_RarogContract.bundle'] });
    expect(run([noContract.app], noContract.bin).stderr).toBe([
      `ios-app-languages: 2 problem(s) in ${noContract.app}:`,
      '  PlugIns/RarogNotificationService.appex: no RarogContract_RarogContract.bundle',
      '  PlugIns/RarogWidgets.appex: no RarogContract_RarogContract.bundle',
      '',
    ].join('\n'));
    const noService = makeApp({ skip: ['PlugIns/RarogNotificationService.appex'] });
    const result = run([noService.app], noService.bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('  PlugIns: no RarogNotificationService.appex\n');
  });

  it('klucze loc-key: brak klucza w języku i brak pliku w widżecie to braki z miejscem — kod 1', () => {
    const { app, bin } = makeApp({
      locKeys: { [path.join('pl.lproj', 'Localizable.strings')]: LOC_KEYS.filter((key) => key !== 'push.chime.body') },
      skip: ['PlugIns/RarogWidgets.appex/en.lproj/Localizable.strings'],
    });
    const result = run([app], bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe([
      `ios-app-languages: 2 problem(s) in ${app}:`,
      '  Rarog.app: pl.lproj/Localizable.strings has no push.chime.body (push loc-key)',
      '  PlugIns/RarogWidgets.appex: no en.lproj/Localizable.strings (push loc-keys)',
      '',
    ].join('\n'));
  });

  it('każdy brak z miejscem: deklaracja, tekst zgody, zasoby pakietu i ich język, sam widżet — kod 1', () => {
    const { app, bin } = makeApp({
      declared: { '.': ['en'], 'PlugIns/RarogNotificationService.appex': null },
      skip: ['pl.lproj/InfoPlist.strings', 'RarogCore_RarogCore.bundle',
        'PlugIns/RarogWidgets.appex/RarogActivity_RarogActivity.bundle/pl.lproj'],
    });
    const result = run([app], bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe([
      `ios-app-languages: 5 problem(s) in ${app}:`,
      '  Rarog.app: CFBundleLocalizations is missing pl',
      '  Rarog.app: no pl.lproj/InfoPlist.strings (usage descriptions)',
      '  Rarog.app: no RarogCore_RarogCore.bundle',
      '  PlugIns/RarogNotificationService.appex: Info.plist has no CFBundleLocalizations',
      '  PlugIns/RarogWidgets.appex/RarogActivity_RarogActivity.bundle: no pl.lproj',
      '',
    ].join('\n'));
  });

  it('widżet bez zasobów RarogActivity i apka bez widżetu to braki', () => {
    const noCopy = makeApp({ skip: ['PlugIns/RarogWidgets.appex/RarogActivity_RarogActivity.bundle'] });
    expect(run([noCopy.app], noCopy.bin).stderr)
      .toContain('  PlugIns/RarogWidgets.appex: no RarogActivity_RarogActivity.bundle\n');
    const noWidget = makeApp({ skip: ['PlugIns/RarogWidgets.appex'] });
    const result = run([noWidget.app], noWidget.bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('  PlugIns: no RarogWidgets.appex\n');
  });

  it('złe wywołanie: bez argumentu albo katalog bez Info.plist — kod 2', () => {
    const { app, bin } = makeApp({ skip: ['Info.plist'] });
    expect(run([], bin).status).toBe(2);
    const result = run([app], bin);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is not a built app (no Info.plist)');
  });
});
