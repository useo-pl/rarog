/*
 * Strażnik przypiętych zależności natywnej apki. Jedyną zależnością zewnętrzną apki jest SwiftTerm (pakiet
 * `native/Rarog/Packages/RarogTerminal`); reguły zależności (wersja ≥ 7 dni, bez cichego podbicia) wymusza tu
 * repo, nie pamięć agenta:
 *
 * 1. każda zdalna zależność pakietów apki stoi na `exact:` (SwiftTerm `exact: "1.19.0"`, bo `main` jest
 *    w refaktorze pod 2.0);
 * 2. każdy `Package.resolved` pakietu (SwiftPM, `swift test`) ma piny RÓWNE pinom projektu (xcodebuild), a każdy
 *    pin projektu stoi w którymś pakiecie; rozjazd znaczyłby, że testy pakietu i apka budują się z różnych rewizji;
 * 3. każde wywołanie xcodebuild, które buduje (ios-check, ios-build), niesie flagi przypięcia
 *    (`-onlyUsePackageVersionsFromResolvedFile`, `-skipPackagePluginValidation`), a `swift test` pakietu
 *    z `Package.resolved` — `--force-resolved-versions`;
 * 4. każdy pin stoi w `native/Rarog/README.md` z wersją i początkiem rewizji (maintainer i licencja obok).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const PACKAGES = 'native/Rarog/Packages';
const PROJECT_RESOLVED = 'native/Rarog/Rarog.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved';
const FLAGS = ['-skipPackagePluginValidation', '-onlyUsePackageVersionsFromResolvedFile'];

interface Pin {
  identity: string;
  location: string;
  state: { revision: string; version?: string };
}

function pins(rel: string, root = repoRoot): Pin[] {
  const parsed = JSON.parse(readFileSync(path.join(root, rel), 'utf8')) as { pins: Pin[] };
  return [...parsed.pins].sort((a, b) => a.identity.localeCompare(b.identity));
}

/** `Package.resolved` wszystkich pakietów apki (ścieżki względem `root`). */
function packageResolved(root = repoRoot): string[] {
  return readdirSync(path.join(root, PACKAGES))
    .map((name) => `${PACKAGES}/${name}/Package.resolved`)
    .filter((rel) => existsSync(path.join(root, rel)))
    .sort();
}

const pinShape = (pin: Pin): string =>
  JSON.stringify([pin.identity, pin.location, pin.state.revision, pin.state.version ?? null]);

/**
 * Rozjazdy pinów: pin pakietu inny niż pin projektu o tej samej tożsamości albo nieobecny w projekcie, pin projektu
 * bez żadnego pakietu. Pusta lista = zgodne.
 */
function pinMismatches(root = repoRoot): string[] {
  const project = new Map(pins(PROJECT_RESOLVED, root).map((pin) => [pin.identity, pin]));
  const covered = new Set<string>();
  const out: string[] = [];
  for (const rel of packageResolved(root)) {
    for (const pin of pins(rel, root)) {
      covered.add(pin.identity);
      const theirs = project.get(pin.identity);
      if (!theirs) out.push(`${rel}: ${pin.identity} brak w projekcie`);
      else if (pinShape(theirs) !== pinShape(pin)) {
        out.push(`${rel}: ${pin.identity} ${pinShape(pin)} ≠ projekt ${pinShape(theirs)}`);
      }
    }
  }
  for (const identity of project.keys()) if (!covered.has(identity)) out.push(`projekt: ${identity} bez pakietu`);
  return out;
}

/** Wszystkie piny pakietów, bez powtórzeń tożsamości. */
function allPackagePins(root = repoRoot): Pin[] {
  const byIdentity = new Map<string, Pin>();
  for (const rel of packageResolved(root)) for (const pin of pins(rel, root)) byIdentity.set(pin.identity, pin);
  return [...byIdentity.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}

/** Wywołania polecenia w skrypcie bash: od linii z `marker` do pierwszej linii bez `\` na końcu. */
function commands(source: string, marker: RegExp): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!marker.test(lines[index] ?? '')) continue;
    let command = lines[index] ?? '';
    while (command.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      index += 1;
      command += `\n${lines[index] ?? ''}`;
    }
    out.push(command);
  }
  return out;
}

describe('natywna apka: przypięte zależności', () => {
  it('zdalne zależności pakietów stoją na `exact:`; SwiftTerm 1.19.0', () => {
    const manifests = readdirSync(path.join(repoRoot, PACKAGES))
      .map((name) => `${PACKAGES}/${name}/Package.swift`)
      .filter((rel) => existsSync(path.join(repoRoot, rel)));
    expect(manifests.length).toBeGreaterThanOrEqual(5);
    const remote = manifests.flatMap((rel) =>
      read(rel).split('\n').filter((line) => line.includes('.package(url:')).map((line) => ({ rel, line })));
    expect(remote.length).toBeGreaterThan(0);
    for (const { rel, line } of remote) expect(line, rel).toMatch(/exact:\s*"\d+\.\d+\.\d+"/);
    expect(read(`${PACKAGES}/RarogTerminal/Package.swift`))
      .toContain('.package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.19.0")');
  });

  it('Package.resolved każdego pakietu ma piny równe pinom projektu, projekt nie ma pinów spoza pakietów', () => {
    expect(existsSync(path.join(repoRoot, PROJECT_RESOLVED)), PROJECT_RESOLVED).toBe(true);
    expect(packageResolved()).toContain(`${PACKAGES}/RarogTerminal/Package.resolved`);
    expect(pinMismatches()).toEqual([]);
    const ofPackages = allPackagePins();
    const swiftTerm = ofPackages.find((pin) => pin.identity === 'swiftterm');
    expect(swiftTerm?.state.version).toBe('1.19.0');
    for (const pin of ofPackages) expect(pin.state.revision, pin.identity).toMatch(/^[0-9a-f]{40}$/);
  });

  describe('strażnik pinów na sztucznym drzewie', () => {
    const roots: string[] = [];
    afterAll(() => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });
    const pin = (identity: string, revision: string, version = '1.0.0'): Pin => ({
      identity, location: `https://example.invalid/${identity}`, state: { revision, version },
    });
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    /** Drzewo z `Package.resolved` pakietów (nazwa → piny) i projektu. */
    function tree(packages: Record<string, Pin[]>, project: Pin[]): string {
      const root = mkdtempSync(path.join(os.tmpdir(), 'rarog-pins-'));
      roots.push(root);
      const write = (rel: string, list: Pin[]) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), JSON.stringify({ pins: list, version: 3 }));
      };
      for (const [name, list] of Object.entries(packages)) write(`${PACKAGES}/${name}/Package.resolved`, list);
      mkdirSync(path.join(root, PACKAGES, 'BezZaleznosci'), { recursive: true });
      write(PROJECT_RESOLVED, project);
      return root;
    }

    it('dwa pakiety, projekt = suma ich pinów: zgodne', () => {
      const root = tree({ Term: [pin('swiftterm', a)], Iroh: [pin('iroh', b)] }, [pin('iroh', b), pin('swiftterm', a)]);
      expect(pinMismatches(root)).toEqual([]);
    });

    it('drugi pakiet z innym pinem tej samej zależności: rozjazd', () => {
      const root = tree({ Term: [pin('swiftterm', a)], Iroh: [pin('swiftterm', b)] }, [pin('swiftterm', a)]);
      expect(pinMismatches(root)).toEqual([
        expect.stringContaining(`${PACKAGES}/Iroh/Package.resolved: swiftterm`),
      ]);
    });

    it('inna wersja przy tej samej rewizji: rozjazd', () => {
      const root = tree({ Term: [pin('swiftterm', a, '1.0.1')] }, [pin('swiftterm', a)]);
      expect(pinMismatches(root)).toHaveLength(1);
    });

    it('pin pakietu nieobecny w projekcie i pin projektu bez pakietu: oba rozjazdy', () => {
      const root = tree({ Iroh: [pin('iroh', b)] }, [pin('swiftterm', a)]);
      expect(pinMismatches(root)).toEqual([
        `${PACKAGES}/Iroh/Package.resolved: iroh brak w projekcie`,
        'projekt: swiftterm bez pakietu',
      ]);
    });
  });

  it('flagi przypięcia mieszkają w jednym miejscu i niesie je każde budujące wywołanie xcodebuild', () => {
    const toolchain = read('scripts/xcode-toolchain.sh');
    expect(toolchain).toContain(`RAROG_XCODE_PACKAGE_ARGS=(${FLAGS.join(' ')})`);
    const uses = '"${RAROG_XCODE_PACKAGE_ARGS[@]}"';
    // Każde `xcrun xcodebuild` w bramce niesie flagi: cztery budujące (testy apki przez `xcode_tests`, testy UIKit
    // pakietu, build na urządzenie z podpisem i bez) i `-showBuildSettings` kroku języków, które też rozwiązuje pakiety.
    const check = commands(read('scripts/ios-check.sh'), /^[^#]*xcrun xcodebuild\b/);
    expect(check).toHaveLength(5);
    for (const command of check) expect(command).toContain(uses);
    for (const rel of ['scripts/ios-build.sh']) {
      const building = commands(read(rel), /^ios_xcodebuild\b/)
        .filter((command) => /^\s*(build|archive)\s*$/m.test(command));
      expect(building.length, rel).toBeGreaterThan(0);
      for (const command of building) expect(command, rel).toContain(uses);
    }
    expect(read('scripts/ios-check.sh')).toMatch(
      /\[\[ ! -f "\$package\/Package\.resolved" \]\] \|\| pins=\(--force-resolved-versions\)/);
  });

  it('każdy pin stoi w README apki z wersją i początkiem rewizji', () => {
    const readme = read('native/Rarog/README.md');
    for (const pin of allPackagePins()) {
      expect(readme, pin.identity).toContain(`${pin.state.version}** — `);
      expect(readme, pin.identity).toContain(`\`${pin.state.revision.slice(0, 8)}\``);
    }
  });
});
