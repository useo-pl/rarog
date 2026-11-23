/**
 * Probe of the iroh native module for `rarog serve --check`: a separate short process loads
 * the library through `loadIroh()` and exits, without an endpoint and without binding a UDP port. The CLI process runs
 * it in the server's environment (`probeIrohModule` in `cli/serve.ts`), because the package loader reads process
 * environment variables (e.g. `NAPI_RS_NATIVE_LIBRARY_PATH`) that the server does not get from the variable
 * registry. Result: code 0 or code 1 and one line `IROH_PROBE_PREFIX<sentence>` on stderr. Nobody imports the file:
 * it is a process entry point.
 */
import { IROH_PROBE_PREFIX, IrohLoadError, loadIroh } from './adapter.ts';

try {
  await loadIroh();
} catch (failure) {
  const message = failure instanceof IrohLoadError ? failure.message : `ładowanie modułu: ${String(failure)}`;
  process.stderr.write(`${IROH_PROBE_PREFIX}${message.replace(/\s*\n\s*/g, ' ')}\n`);
  process.exitCode = 1;
}
