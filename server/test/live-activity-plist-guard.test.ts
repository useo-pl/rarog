/**
 * Strażnik kluczy Live Activity w `Info.plist` apki (wzór: `privacy-manifest-guard.test.ts`).
 *
 * `NSSupportsLiveActivitiesFrequentUpdates = true` daje wyższy budżet aktualizacji o priorytecie 10 dla tego, co
 * serwer wysyła pilnie już dziś („czeka”, dźwięk „skończył”). Klucz działa tylko w plist celu `Rarog` (apki), nie
 * widżetu, więc strażnik sprawdza też, że oba ustawienia budowania celu `Rarog` biorą `Info.plist` z korzenia
 * projektu. Bez klucza nic nie pada w buildzie — kafel po prostu dostaje mniejszy budżet, dlatego ten test.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IS_MAC, macOnly } from './platform.ts';
import { PBXPROJ, REPO, readRepo } from './product-identity.ts';

const APP_PLIST = 'native/Rarog/Info.plist';

/** Obiekty projektu o tej nazwie w komentarzu i tym `isa` (obiekty stoją na dwóch tabulatorach). */
function pbxObjects(text: string, isa: string, name: string): { id: string; body: string }[] {
  const re = /^\t\t(\w{24}) \/\* ([^*]+) \*\/ = \{\n([\s\S]*?)^\t\t\};$/gm;
  return [...text.matchAll(re)]
    .filter((m) => m[2] === name && m[3]?.includes(`\t\t\tisa = ${isa};`))
    .map((m) => ({ id: m[1] ?? '', body: m[3] ?? '' }));
}

/** Ciało obiektu projektu o tym identyfikatorze. */
function pbxBody(text: string, id: string): string {
  return new RegExp(`^\\t\\t${id} /\\* [^*]+ \\*/ = \\{\\n([\\s\\S]*?)^\\t\\t\\};$`, 'm').exec(text)?.[1] ?? '';
}

/** Identyfikatory z listy `key = ( … );` w ciele obiektu. */
function listIds(body: string, key: string): string[] {
  const list = new RegExp(`\\t\\t\\t${key} = \\(\\n([\\s\\S]*?)\\t\\t\\t\\);`).exec(body)?.[1] ?? '';
  return [...list.matchAll(/(\w{24}) \/\*/g)].map((m) => m[1] ?? '');
}

describe('klucze Live Activity w `Info.plist` apki', () => {
  it('`Info.plist` z korzenia projektu to plist celu `Rarog` w obu konfiguracjach', () => {
    const pbx = readRepo(PBXPROJ);
    const [target, ...more] = pbxObjects(pbx, 'PBXNativeTarget', 'Rarog');
    expect(more, 'jeden cel Rarog').toEqual([]);
    const listId = /\t\t\tbuildConfigurationList = (\w{24}) /.exec(target?.body ?? '')?.[1] ?? '';
    const configs = listIds(pbxBody(pbx, listId), 'buildConfigurations');
    expect(configs, 'konfiguracje celu Rarog').toHaveLength(2);
    for (const id of configs) expect(pbxBody(pbx, id)).toContain('\t\t\t\tINFOPLIST_FILE = Info.plist;\n');
  });

  it.skipIf(!IS_MAC)(macOnly('`NSSupportsLiveActivities` i `NSSupportsLiveActivitiesFrequentUpdates` = true', 'plutil'), () => {
    const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(REPO, APP_PLIST)], { encoding: 'utf8' });
    expect(json.status, json.stderr).toBe(0);
    const plist = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(plist['NSSupportsLiveActivities']).toBe(true);
    expect(plist['NSSupportsLiveActivitiesFrequentUpdates']).toBe(true);
  });
});
