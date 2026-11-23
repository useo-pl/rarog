/**
 * Wejście CLI `rarog` WYŁĄCZNIE dla testów gałęzi Linuksa: to samo co `bin/rarog.mjs`
 * (tsx i `server/src/cli/main.ts`), ale `CliIo` dostaje platformę `linux` i katalog procfs z `RAROG_TEST_PROC`.
 * Gałęzie `systemd --user` biegną dzięki temu na macOS, na atrapach `systemctl`, `busctl`, `loginctl`, `uname`, `ps`
 * i `ss` z `PATH`, w procesie potomnym: wyjście `restart.sh` (dziedziczone stdio) trafia do testu, a nie do vitest.
 * Produkcja zawsze idzie przez `bin/rarog.mjs`, gdzie platforma to `process.platform`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { register } = await import('tsx/esm/api');
register({ tsconfig: path.join(root, 'tsconfig.json') });
const { main } = await import('../src/cli/main.ts');

const procRoot = process.env.RAROG_TEST_PROC;
try {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    env: process.env,
    cwd: process.cwd(),
    platform: 'linux',
    ...(procRoot === undefined ? {} : { procRoot }),
  });
} catch (failure) {
  process.stderr.write(`rarog: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
}
