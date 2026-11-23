/**
 * `--import` entry for a hook process in a test (`server/test/hook-work-area.test.ts`): records every path the
 * process hands to the synchronous `node:fs` calls that look at the disk (`lstatSync`, `statSync`, `realpathSync`,
 * `readlinkSync`, `readdirSync`, `opendirSync`, `existsSync`, `accessSync`, `readFileSync`), and for `realpathSync` and
 * `readlinkSync` also the path they lead to: a `realpath` that ends inside a folder has looked at that folder on its
 * way, while a `readlink` target is only the text of the link. The calls run as usual. `syncBuiltinESMExports()`
 * carries the wrappers to named ESM imports
 * (`import { lstatSync } from 'node:fs'` in the hooks and their modules).
 *
 * Log: JSON lines at `FS_RECORDER_LOG`, `{ fn, path, target? }`, written through a descriptor opened before the
 * wrappers, so writing the log is never recorded. The variable is test-only; no product code reads it.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = process.env.FS_RECORDER_LOG;
if (LOG === undefined || LOG === '') throw new Error('fs recorder: FS_RECORDER_LOG is not set');
const fd = fs.openSync(LOG, 'a', 0o600);

/** The path argument as an absolute path, or `null` for a descriptor or anything else. */
function pathOf(arg) {
  if (typeof arg === 'string') return path.resolve(arg);
  if (Buffer.isBuffer(arg)) return path.resolve(arg.toString('utf8'));
  if (arg instanceof URL && arg.protocol === 'file:') return fileURLToPath(arg);
  return null;
}

/** Where a `realpath` or `readlink` result leads: a relative link target counts from the link's folder. */
function targetOf(file, result) {
  if (typeof result !== 'string') return undefined;
  return path.resolve(path.dirname(file), result);
}

function record(name, original) {
  const wrapper = function recorded(...args) {
    const file = pathOf(args[0]);
    let result;
    try {
      result = Reflect.apply(original, this, args);
      return result;
    } finally {
      if (file !== null) {
        const target = name.startsWith('realpath') || name === 'readlinkSync' ? targetOf(file, result) : undefined;
        fs.writeSync(fd, `${JSON.stringify({ fn: name, path: file, ...(target === undefined ? {} : { target }) })}\n`);
      }
    }
  };
  if (typeof original.native === 'function') wrapper.native = record(`${name}.native`, original.native);
  return wrapper;
}

for (const name of [
  'lstatSync', 'statSync', 'realpathSync', 'readlinkSync', 'readdirSync', 'opendirSync', 'existsSync', 'accessSync',
  'readFileSync',
]) {
  fs[name] = record(name, fs[name]);
}
syncBuiltinESMExports();
