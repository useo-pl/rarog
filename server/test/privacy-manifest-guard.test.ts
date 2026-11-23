/**
 * Strażnik manifestu prywatności apki (wzór: `product-identity-guard.test.ts`).
 *
 * Apple wymaga `PrivacyInfo.xcprivacy` (ITMS-91053 przy wysyłce do App Store Connect). Manifest jest
 * TYLKO w celu `Rarog`: rozszerzenia (NSE, widżet) nie wołają API z listy „required reason” — gdy mail Apple wskaże
 * `.appex`, manifest dostaje ono w następnym buildzie.
 *
 * Do udowodnienia:
 * - plik `native/Rarog/Rarog/PrivacyInfo.xcprivacy` jest w fazie Resources celu `Rarog`: folder `Rarog` to grupa
 *   synchronizowana z systemem plików (`PBXFileSystemSynchronizedRootGroup`, Xcode 16+) przypięta do celu `Rarog`
 *   (`fileSystemSynchronizedGroups`) bez wyjątków członkostwa celu `Rarog` (wyjątek dla innego celu dokłada mu
 *   pliki), cel ma fazę Resources, a projekt nie wymienia pliku z nazwy (wpis z nazwy to wyjątek albo ręczna
 *   referencja); foldery rozszerzeń manifestu nie mają;
 * - `plutil -lint` czysty;
 * - treść: `NSPrivacyTracking` = false i DOKŁADNIE trzy kategorie z kodami powodu — UserDefaults `CA92.1` (własne
 *   dane apki), SystemBootTime `35F9.1` (pomiar czasu w apce), FileTimestamp `C617.1` (SwiftTerm, transmisje
 *   plikowe Kitty); `NSPrivacyCollectedDataTypes` z jednym typem: identyfikator urządzenia (EndpointId apki w rejestrze
 *   relaya iroh), powiązany, bez śledzenia, do działania apki.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IS_MAC, macOnly } from './platform.ts';
import { PBXPROJ, REPO, readRepo } from './product-identity.ts';

const MANIFEST = 'native/Rarog/Rarog/PrivacyInfo.xcprivacy';

/** Obiekt projektu o tej nazwie w komentarzu i tym `isa` (obiekty stoją na dwóch tabulatorach). */
function pbxObjects(text: string, isa: string, name: string): { id: string; body: string }[] {
  const re = /^\t\t(\w{24}) \/\* ([^*]+) \*\/ = \{\n([\s\S]*?)^\t\t\};$/gm;
  return [...text.matchAll(re)]
    .filter((m) => m[2] === name && m[3]?.includes(`\t\t\tisa = ${isa};`))
    .map((m) => ({ id: m[1] ?? '', body: m[3] ?? '' }));
}

/** Identyfikatory z listy `key = ( … );` w ciele obiektu. */
function listIds(body: string, key: string): string[] {
  const list = new RegExp(`\\t\\t\\t${key} = \\(\\n([\\s\\S]*?)\\t\\t\\t\\);`).exec(body)?.[1] ?? '';
  return [...list.matchAll(/(\w{24}) \/\*/g)].map((m) => m[1] ?? '');
}

describe('manifest prywatności apki (`PrivacyInfo.xcprivacy`)', () => {
  const pbx = readRepo(PBXPROJ);

  it('plik leży w folderze celu `Rarog`, a folder jest w Resources celu bez wyjątków członkostwa tego celu', () => {
    expect(existsSync(path.join(REPO, MANIFEST)), MANIFEST).toBe(true);
    const [target, ...more] = pbxObjects(pbx, 'PBXNativeTarget', 'Rarog');
    expect(more, 'jeden cel Rarog').toEqual([]);
    expect(target, 'cel Rarog w project.pbxproj').toBeDefined();
    const body = target?.body ?? '';
    const [group] = pbxObjects(pbx, 'PBXFileSystemSynchronizedRootGroup', 'Rarog');
    expect(group?.body, 'grupa synchronizowana folderu Rarog').toContain('\t\t\tpath = Rarog;');
    // Wyjątek dla INNEGO celu dokłada mu pliki z folderu (testy UIKit biorą stąd kod apki); wyjątek dla celu `Rarog`
    // wyjąłby plik z jego Resources.
    const exceptionTargets = listIds(group?.body ?? '', 'exceptions').map((id) =>
      new RegExp(`^\\t\\t${id} /\\* [^*]+ \\*/ = \\{\\n[\\s\\S]*?^\\t\\t\\ttarget = (\\w{24}) `, 'm').exec(pbx)?.[1]);
    expect(exceptionTargets.every((id) => id !== undefined), 'każdy wyjątek grupy Rarog ma cel').toBe(true);
    expect(exceptionTargets, 'grupa Rarog bez wyjątków członkostwa celu Rarog').not.toContain(target?.id);
    expect(listIds(body, 'fileSystemSynchronizedGroups')).toEqual([group?.id]);
    const phases = listIds(body, 'buildPhases');
    expect(phases.some((id) => pbx.includes(`\t\t${id} /* Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;`)),
      'faza Resources celu Rarog').toBe(true);
    expect(pbx, 'projekt nie wymienia manifestu z nazwy (wyjątek albo ręczna referencja)')
      .not.toContain('PrivacyInfo.xcprivacy');
  });

  it('rozszerzenia (NSE, widżet) manifestu nie mają', () => {
    for (const folder of ['RarogNotificationService', 'RarogWidgets']) {
      expect(existsSync(path.join(REPO, 'native/Rarog', folder, 'PrivacyInfo.xcprivacy')), folder).toBe(false);
    }
  });

  it.skipIf(!IS_MAC)(macOnly('`plutil -lint` czysty', 'plutil'), () => {
    const lint = spawnSync('plutil', ['-lint', path.join(REPO, MANIFEST)], { encoding: 'utf8' });
    expect(lint.stdout + lint.stderr).toContain(': OK');
    expect(lint.status).toBe(0);
  });

  it.skipIf(!IS_MAC)(macOnly('treść: bez śledzenia, trzy kategorie z kodami powodu, jeden typ zbieranych danych (DeviceID)', 'plutil'), () => {
    const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(REPO, MANIFEST)], { encoding: 'utf8' });
    expect(json.status, json.stderr).toBe(0);
    const manifest = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(Object.keys(manifest).sort())
      .toEqual(['NSPrivacyAccessedAPITypes', 'NSPrivacyCollectedDataTypes', 'NSPrivacyTracking']);
    expect(manifest['NSPrivacyTracking']).toBe(false);
    // The iroh relay registry client sends the app's EndpointId (a device identifier) to the registry Worker.
    expect(manifest['NSPrivacyCollectedDataTypes']).toEqual([
      {
        NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
        NSPrivacyCollectedDataTypeLinked: true,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
      },
    ]);
    expect(manifest['NSPrivacyAccessedAPITypes']).toEqual([
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
    ]);
  });
});
