/**
 * A stand-in for the folder helper: the line protocol of `server/src/folder-gate/wire.ts` (`{id, op, args}` in,
 * `{id, ok, value | error}` out), one request at a time, with behaviour chosen by the `path` argument of any operation:
 *
 * - `hang`: blocks this process's only thread for good, so it no longer reads stdin and only SIGKILL ends it, like a
 *   read that waits for a macOS consent window;
 * - `sleep:<ms>`: blocks for `<ms>`, then answers like `echo`; an `openRead` answers with handle 7;
 * - `crash`: exits with code 1 without answering;
 * - `pid`: answers with this process's pid;
 * - `eperm`: answers with an `EPERM` error;
 * - anything else (`echo`): answers with the arguments as they came.
 *
 * `argv[2]`, when given, is a file that gets every request line, so a test sees what reached the helper. The end of
 * stdin ends the process, as in the real helper.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.argv[2];
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (log !== undefined) appendFileSync(log, `${line}\n`);
  const { id, op, args } = JSON.parse(line);
  const command = typeof args?.path === 'string' ? args.path : '';
  const [verb, arg] = command.split(':');
  const answer = () => send({ id, ok: true, value: op === 'openRead' ? { handle: 7, stats: null } : args });
  switch (verb) {
    case 'hang':
      block(Infinity);
      return;
    case 'sleep':
      block(Number(arg));
      answer();
      return;
    case 'crash':
      process.exit(1);
      return;
    case 'pid':
      send({ id, ok: true, value: process.pid });
      return;
    case 'eperm':
      send({
        id, ok: false,
        error: { $err: { message: 'operation not permitted', code: 'EPERM', errno: -1, syscall: op, path: command } },
      });
      return;
    default:
      answer();
  }
});
lines.on('close', () => process.exit(0));
