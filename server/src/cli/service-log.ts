/**
 * The server log of the service (`<dataDir>/server.log`) before launchd or systemd opens it: `rarog service install`
 * creates the file with mode 0600 and sets an existing one to 0600. Both supervisors open the log for appending and
 * keep its mode, so the server process umask stays as it is (directories the server creates keep their modes).
 * A path that is not a regular file (a symlink, a FIFO) is left alone, and an error is one line, not a failure: the
 * install has already stopped the server, and the service starts with the log as it was.
 */
import { chmodSync, lstatSync, writeFileSync } from 'node:fs';
import { type CliIo, out } from './io.ts';

const LOG_MODE = 0o600;

/** Creates the log with mode 0600 or sets a regular file to 0600, and prints one line about it. */
export function prepareServiceLog(io: CliIo, file: string): void {
  try {
    const found = lstatSync(file, { throwIfNoEntry: false });
    if (found !== undefined && !found.isFile()) {
      out(io, `  server log ${file}: not a regular file, mode left as it is`);
      return;
    }
    writeFileSync(file, '', { flag: 'a', mode: LOG_MODE });
    chmodSync(file, LOG_MODE);
    out(io, `  server log ${file} (mode 0600)`);
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code ?? String(failure);
    out(io, `  server log ${file}: mode 0600 not set (${code}), the service appends to it as it is`);
  }
}
