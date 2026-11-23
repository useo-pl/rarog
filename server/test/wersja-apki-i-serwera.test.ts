/**
 * Strażnik wersji serwera wydanej z apką: stała `ServerRelease.version` w RarogCore równa się polu `version`
 * w `package.json` korzenia repo. Apka porównuje z nią wersję z `GET /api/version` i pokazuje wiersz „Dostępna
 * aktualizacja serwera”, gdy serwer jest starszy, więc rozjazd zapisów dałby fałszywy wiersz albo żadnego.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RAROG_PACKAGE_NAME } from '../src/install/repair.ts';
import { RAROG_VERSION } from '../src/version.ts';

const SOURCE = new URL('../../native/Rarog/Packages/RarogCore/Sources/RarogCore/ServerRelease.swift', import.meta.url);

/** Literały `static let version = "…"` w pliku stałej (bez komentarzy `//`). */
function releaseVersions(source: string): string[] {
  const code = source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  return [...code.matchAll(/static\s+let\s+version\s*=\s*"([^"\\]*)"/g)].map((match) => match[1] ?? '');
}

/**
 * Package names in `static let installAndUpdateCommand = "npm i -g <name>@latest …"` (comments `//` skipped). The app
 * shows this command in the banner and in the server machine section, so a name the registry does not have gives
 * the user a command that fails.
 */
function installCommandPackages(source: string): string[] {
  const code = source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  return [...code.matchAll(/static\s+let\s+installAndUpdateCommand\s*=\s*"npm i -g (\S+)@latest\s/g)]
    .map((match) => match[1] ?? '');
}

describe('wersja serwera wydana z apką', () => {
  it('`ServerRelease.version` w RarogCore równa się `version` z `package.json`', () => {
    const versions = releaseVersions(readFileSync(SOURCE, 'utf8'));
    expect(versions, 'dokładnie jedna stała wersji w ServerRelease.swift').toHaveLength(1);
    expect(versions[0]).toBe(RAROG_VERSION);
  });

  it('`ServerRelease.installAndUpdateCommand` installs the package `RAROG_PACKAGE_NAME`', () => {
    const names = installCommandPackages(readFileSync(SOURCE, 'utf8'));
    expect(names, 'exactly one `npm i -g <name>@latest` install command in ServerRelease.swift').toHaveLength(1);
    expect(names[0]).toBe(RAROG_PACKAGE_NAME);
  });

  it('parser stałej: literał w komentarzu się nie liczy, dwie stałe to dwa wpisy', () => {
    expect(releaseVersions('// static let version = "9.9.9"\n  public static let version = "1.2.3"')).toEqual(['1.2.3']);
    expect(releaseVersions('static let version = "1"\nstatic let version = "2"')).toEqual(['1', '2']);
    expect(releaseVersions('static let updateCommand = "npm i -g rarog@latest"')).toEqual([]);
  });

  it('install command parser: a scoped name stays whole, a commented-out line does not count', () => {
    const line = 'static let installAndUpdateCommand = "npm i -g @rarog/server@latest && \\(updateOnlyCommand)"';
    expect(installCommandPackages(line)).toEqual(['@rarog/server']);
    expect(installCommandPackages(`// ${line}`)).toEqual([]);
  });
});
