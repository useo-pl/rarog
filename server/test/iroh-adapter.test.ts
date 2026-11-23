/**
 * Adapter biblioteki iroh (`server/src/iroh/adapter.ts`) bez kodu natywnego w procesie testów: czytelny błąd
 * przy braku modułu, wersje z manifestów i dowód, że import modułów `iroh/` nie ładuje biblioteki natywnej.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IROH_PACKAGE, IrohLoadError, irohModuleInfo, irohPlatform, loadIroh, openEndpoint } from '../src/iroh/adapter.ts';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';

const HINT = 'set RAROG_IROH=0 or run on Apple silicon or Linux';

async function loadError(importModule: () => Promise<unknown>): Promise<IrohLoadError> {
  const err: unknown = await loadIroh(importModule).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(IrohLoadError);
  return err as IrohLoadError;
}

describe('loadIroh: brak modułu natywnego', () => {
  it('brak paczki: zdanie z platformą i radą, przyczyna w `cause`', async () => {
    const missing = Object.assign(new Error(`Cannot find package '${IROH_PACKAGE}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    const err = await loadError(() => Promise.reject(missing));
    expect(err.message).toBe(
      `no native iroh module for ${irohPlatform()} (package ${IROH_PACKAGE} is not installed); ${HINT}`,
    );
    expect(err.cause).toBe(missing);
  });

  it('brak paczki z `require()` (`MODULE_NOT_FOUND`): to samo zdanie', async () => {
    const missing = Object.assign(new Error(`Cannot find module '${IROH_PACKAGE}'`), { code: 'MODULE_NOT_FOUND' });
    const err = await loadError(() => Promise.reject(missing));
    expect(err.message).toBe(
      `no native iroh module for ${irohPlatform()} (package ${IROH_PACKAGE} is not installed); ${HINT}`,
    );
  });

  it('brak paczki platformy (ładowacz napi-rs): pierwsze zdanie błędu ładowacza', async () => {
    const native = new Error('Cannot find native binding. npm has a bug related to optional dependencies.');
    const err = await loadError(() => Promise.reject(native));
    expect(err.message).toBe(
      `no native iroh module for ${irohPlatform()} (the native module does not load: Cannot find native binding); ${HINT}`,
    );
  });

  it('paczka bez `Endpoint.builder`: nieznany kształt', async () => {
    const err = await loadError(() => Promise.resolve({ default: {} }));
    expect(err.message).toContain('(unknown package shape)');
  });

  it('moduł CommonJS: biblioteka z `default`', async () => {
    const lib = { Endpoint: { builder: () => ({}) } };
    expect(await loadIroh(() => Promise.resolve({ default: lib }))).toBe(lib);
  });

  it('moduł CommonJS z `module.exports = …`: nazwane eksporty, gdy `default` to pusty pierwotny `exports`', async () => {
    const Endpoint = { builder: () => ({}) };
    const lib = await loadIroh(() => Promise.resolve({ default: {}, Endpoint }));
    expect(lib.Endpoint).toBe(Endpoint);
  });
});

describe('openEndpoint: walidacja przed biblioteką', () => {
  it('klucz innej długości niż 32 bajty: błąd bez ładowania biblioteki', async () => {
    await expect(openEndpoint({ secretKey: new Uint8Array(31), relay: null, port: null }))
      .rejects.toThrow('iroh: the server key must be 32 bytes');
  });
});

describe('irohModuleInfo: wersje z manifestów', () => {
  it('wersja paczki 1.2.0 i paczka platformy tego procesu', () => {
    const info = irohModuleInfo();
    expect(info.version).toBe('1.2.0');
    if (irohPlatform() === 'darwin-arm64') {
      expect(info).toEqual({ version: '1.2.0', platformPackage: `${IROH_PACKAGE}-darwin-arm64`, platformVersion: '1.2.0' });
    }
    if (irohPlatform() === 'darwin-x64') expect(info.platformPackage).toBeNull();
  });
});

describe('moduł natywny poza procesem bez prośby', () => {
  let dir = '';
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'rarog-iroh-adapter-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const nativeObjects = `process.report.getReport().sharedObjects.filter((path) => /iroh/i.test(path))`;

  it('import całego `server/src/iroh/` i `irohModuleInfo()` nie ładują kodu natywnego', async () => {
    const result = childJson<{ info: { version: string | null }; native: string[] }>(await runInChild(dir, `
import ${serverModule('iroh/listener.ts')};
import ${serverModule('iroh/socket.ts')};
import { irohModuleInfo } from ${serverModule('iroh/adapter.ts')};
const info = irohModuleInfo();
console.log(JSON.stringify({ info, native: ${nativeObjects} }));
`));
    expect(result.info.version).toBe('1.2.0');
    expect(result.native).toEqual([]);
  }, CHILD_TEST_TIMEOUT_MS);

  const hasPlatformPackage = irohModuleInfo().platformVersion !== null;
  it.runIf(hasPlatformPackage)('kontrola: `loadIroh()` ładuje kod natywny (requires the iroh platform package)',
    async () => {
      const result = childJson<{ native: string[] }>(await runInChild(dir, `
import { loadIroh } from ${serverModule('iroh/adapter.ts')};
await loadIroh();
console.log(JSON.stringify({ native: ${nativeObjects} }));
`));
      expect(result.native.some((path) => path.endsWith('.node'))).toBe(true);
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});
