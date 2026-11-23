/**
 * Jedno przypięcie SDK Claude w trzech plikach: `server/package.json` (klon repo, workspace), `sdk-package.json`
 * i `sdk-lock.json` (`server/src/install/`, `rarog setup` w paczce npm kładzie je przed `npm ci`). Obie instalacje
 * mają dostać ten sam tarball: wersja dokładna `x.y.z` wszędzie, `integrity` lockfile'a npm równe temu
 * z `pnpm-lock.yaml`, każde `resolved` z rejestru npm. Pliki pisze `node scripts/sdk-lock.mjs`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_PACKAGE, parseSdkPin, readSdkPin } from '../src/install/sdk.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const EXACT = /^\d+\.\d+\.\d+$/u;
const REGISTRY = 'https://registry.npmjs.org/';

const serverVersion = record(json('server/package.json')['dependencies'])[SDK_PACKAGE];
const manifest = json('server/src/install/sdk-package.json');
const lock = json('server/src/install/sdk-lock.json');
const packages = record(lock['packages']);
const sdkEntry = record(packages[`node_modules/${SDK_PACKAGE}`]);

/** `integrity` wpisu `<nazwa>@<wersja>` z sekcji `packages:` w `pnpm-lock.yaml`. */
function pnpmIntegrity(name: string, version: string): string | null {
  const lines = read('pnpm-lock.yaml').split('\n');
  const at = lines.indexOf(`  '${name}@${version}':`);
  const resolution = at < 0 ? undefined : lines[at + 1];
  return /integrity: (sha512-[A-Za-z0-9+/=]+)/u.exec(resolution ?? '')?.[1] ?? null;
}

describe('przypięcie SDK', () => {
  it('`server/package.json` ma dokładną wersję x.y.z', () => {
    expect(serverVersion).toMatch(EXACT);
  });

  it('`sdk-package.json`: `name`, `private` i ta sama wersja jako jedyna zależność', () => {
    expect(manifest).toEqual({ name: 'rarog-sdk', private: true, dependencies: { [SDK_PACKAGE]: serverVersion } });
  });

  it('`sdk-lock.json`: lockfile npm v3 z korzeniem o tej samej nazwie i wersji', () => {
    expect(lock['name']).toBe('rarog-sdk');
    expect(lock['lockfileVersion']).toBe(3);
    expect(record(packages['']).dependencies).toEqual({ [SDK_PACKAGE]: serverVersion });
    expect(sdkEntry['version']).toBe(serverVersion);
  });

  it('`integrity` SDK w `sdk-lock.json` = `pnpm-lock.yaml`', () => {
    const integrity = pnpmIntegrity(SDK_PACKAGE, String(serverVersion));
    expect(integrity).toMatch(/^sha512-/u);
    expect(sdkEntry['integrity']).toBe(integrity);
  });

  it('każde `resolved` z rejestru npm, każdy wpis z `integrity` i dokładną wersją', () => {
    const entries = Object.entries(packages).filter(([key]) => key !== '');
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value] of entries) {
      const entry = record(value);
      expect(String(entry['resolved']).startsWith(REGISTRY), key).toBe(true);
      expect(String(entry['integrity']), key).toMatch(/^sha512-/u);
      expect(String(entry['version']), key).toMatch(EXACT);
    }
  });

  it('bez `^` i `~` w zależnościach przypięcia', () => {
    for (const spec of [
      ...Object.values(record(manifest['dependencies'])),
      ...Object.values(record(record(packages['']).dependencies)),
      ...Object.values(record(sdkEntry['optionalDependencies'])),
    ]) {
      expect(String(spec)).toMatch(EXACT);
    }
  });

  it('`readSdkPin` czyta tę wersję, a `parseSdkPin` odrzuca rozjazd i zakres', () => {
    expect(readSdkPin().version).toBe(serverVersion);
    const lockText = read('server/src/install/sdk-lock.json');
    const other = JSON.stringify({ ...manifest, dependencies: { [SDK_PACKAGE]: '0.0.1' } });
    const range = JSON.stringify({ ...manifest, dependencies: { [SDK_PACKAGE]: `^${String(serverVersion)}` } });
    expect(() => parseSdkPin(other, lockText)).toThrow(/the same x\.y\.z version/u);
    expect(() => parseSdkPin(range, lockText)).toThrow(/the same x\.y\.z version/u);
  });
});
