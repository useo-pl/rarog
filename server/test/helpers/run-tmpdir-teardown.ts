/**
 * Global setup of `vitest.config.ts`: its teardown removes the run directory that the config created
 * (`server/test/helpers/run-tmpdir.ts`). Vitest runs it in the main process after all test files, also after
 * failures.
 */
import { removeRunTmpdir } from './run-tmpdir.ts';

export default function setup(): () => void {
  return () => removeRunTmpdir(process.env);
}
