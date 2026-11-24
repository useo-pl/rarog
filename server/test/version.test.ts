/**
 * Wersja serwera z jednego źródła (`server/src/version.ts`): pole `version` z `package.json`
 * korzenia repo, a nie literał w `config.ts`; lista możliwości i system maszyny dla `GET /api/version`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { SERVER_SYSTEMS } from '@rarog/shared/rest';
import {
  FILE_INDEX_CAPABILITY, FILES_CAPABILITY, INBOX_CAPABILITY, RAROG_VERSION, ROOT_PACKAGE_JSON, SERVER_CAPABILITIES,
  readPackageVersion, serverCapabilities, serverSystem,
} from '../src/version.ts';

const rootVersion = (JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { version: string }).version;

describe('wersja serwera', () => {
  it('to pole `version` z `package.json` korzenia repo, a `config.version` niesie ją dalej', () => {
    expect(ROOT_PACKAGE_JSON.pathname.endsWith('/package.json')).toBe(true);
    expect(readFileSync(ROOT_PACKAGE_JSON, 'utf8')).toContain('"name": "rarog"');
    expect(RAROG_VERSION).toBe(rootVersion);
    expect(loadConfig({ RAROG_DEMO: '1' }).version).toBe(RAROG_VERSION);
  });

  describe('readPackageVersion', () => {
    let dir = '';
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rarog-version-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const write = async (body: string): Promise<string> => {
      const file = join(dir, 'package.json');
      await writeFile(file, body);
      return file;
    };

    it('przyjmuje semver z dopiskiem', async () => {
      expect(readPackageVersion(await write('{"version":"1.2.3-rc.1+build.7"}'))).toBe('1.2.3-rc.1+build.7');
    });

    it('brak pola, zły typ, pusty łańcuch, znaki sterujące i nadmiar długości przewracają start', async () => {
      for (const body of [
        '{}', '{"version":1}', '{"version":""}', '{"version":"1.0.0\\nlinia"}', `{"version":"${'9'.repeat(65)}"}`,
        'null',
      ]) {
        const file = await write(body);
        expect(() => readPackageVersion(file), body).toThrow(/pole "version"/);
      }
    });
  });
});

describe('możliwości serwera (`capabilities`)', () => {
  // Lista i kolejność stoją w złotych odpowiedziach `shared/fixtures/rest/version.json` i `pair.json`.
  it('nazwy są krótkie, małymi literami z myślnikiem i bez powtórzeń', () => {
    for (const name of SERVER_CAPABILITIES) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(new Set(SERVER_CAPABILITIES).size).toBe(SERVER_CAPABILITIES.length);
  });

  it('`files` and `file-index` only when the caller says the file routes answer; a caller that does not say leaves '
    + 'them out', () => {
    expect(serverCapabilities({ inbox: true })).toEqual([...SERVER_CAPABILITIES, INBOX_CAPABILITY]);
    expect(serverCapabilities({ inbox: false, files: false })).toEqual([...SERVER_CAPABILITIES]);
    expect(serverCapabilities({ inbox: true, files: true }))
      .toEqual([...SERVER_CAPABILITIES, INBOX_CAPABILITY, FILES_CAPABILITY, FILE_INDEX_CAPABILITY]);
    expect(serverCapabilities({ inbox: false, files: true })).toEqual([...SERVER_CAPABILITIES, 'files', 'file-index']);
  });
});

describe('system maszyny (`system`)', () => {
  it('`darwin` → `macos`, `linux` → `linux`, każdy inny system → `other`', () => {
    expect(serverSystem('darwin')).toBe('macos');
    expect(serverSystem('linux')).toBe('linux');
    for (const platform of ['win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'] as const) {
      expect(serverSystem(platform), platform).toBe('other');
    }
  });

  it('bez argumentu mapuje `process.platform`, a wynik zawsze należy do kontraktu', () => {
    expect(serverSystem()).toBe(serverSystem(process.platform));
    expect(SERVER_SYSTEMS).toContain(serverSystem());
  });
});
