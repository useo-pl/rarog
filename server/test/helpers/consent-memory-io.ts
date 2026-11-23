/**
 * The consent cycle's file IO in memory (`ConsentCycleIo` of `layer1/cycle.ts`): answer files under their path in a
 * map, records not written. For tests that run the real cycle and observation without the cycle touching the disk.
 */
import { basename, dirname, join } from 'node:path';
import type { ConsentCycleIo } from '../../src/herdr/dialogs/layer1/cycle.ts';

/** Pliki odpowiedzi cyklu w pamięci (`<katalog>/<nazwa>`), jak hook i cykl widzą katalog `consent/<sesja>/`. */
export function memoryIo(files: Map<string, string>): Partial<ConsentCycleIo> {
  return {
    writeRecord: () => {},
    writeFile: (dir, name, body) => { files.set(join(dir, name), body); },
    rename: (from, to) => {
      const body = files.get(from);
      if (body === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.delete(from);
      files.set(to, body);
    },
    exists: (path) => files.has(path),
    list: (dir) => [...files.keys()].filter((path) => dirname(path) === dir).map((path) => basename(path)),
    read: (path) => files.get(path) ?? null,
  };
}
