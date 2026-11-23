/**
 * Named demo content sets (`RAROG_DEMO_CONTENT`): a set is a module in {@link DEMO_SET_DIR} of the install whose
 * default export is a {@link DemoContent}. One resolver ({@link demoSetFile}) serves the check at start
 * (`parseDemoContent`, so `loadConfig` and `rarog serve --check` refuse a missing set) and the load in the demo
 * ({@link loadDemoSet}). A build without the directory has no named set and refuses every name. Importing this module
 * loads no set: the production process reaches it only through the check at start.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, DEMO_CONTENT_ENV } from '../../config-env.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../../install/mode.ts';
import type { InstallMode } from '../../install/mode.ts';
import type { DemoContent } from './types.ts';

/** Directory of the named sets, relative to the install root. */
export const DEMO_SET_DIR = 'server/src/demo/content/sets';

/** Shape of a set name, which is also the file name of its module without the extension. */
export const DEMO_SET_NAME = /^[a-z][a-z0-9-]*$/u;

/** The set directory of this install. */
export const DEMO_SET_ROOT: string = path.join(INSTALL_ROOT, DEMO_SET_DIR);

/**
 * The module of the set `name` in `root`, or `null` when there is none or the name has another shape. The clone runs
 * TypeScript through tsx, the package runs the JavaScript built from it (`install/mode.ts`).
 */
export function demoSetFile(
  name: string, root: string = DEMO_SET_ROOT, mode: InstallMode = INSTALL_MODE,
): string | null {
  if (!DEMO_SET_NAME.test(name)) return null;
  const file = path.join(root, `${name}${mode === 'package' ? '.js' : '.ts'}`);
  return existsSync(file) ? file : null;
}

/** The refusal of a name without a module in this build. */
export function noSuchDemoSet(name: string): ConfigError {
  return new ConfigError(`${DEMO_CONTENT_ENV}=${name}: no such demo set in this build.`);
}

/**
 * The set `name` from `root`: the default export of its module. A missing module is the refusal of the start; an
 * error of an existing module (syntax, a failing import) comes out as it is, so it does not read as a missing set.
 */
export async function loadDemoSet(name: string, root: string = DEMO_SET_ROOT): Promise<DemoContent> {
  const file = demoSetFile(name, root);
  if (file === null) throw noSuchDemoSet(name);
  const loaded: unknown = await import(pathToFileURL(file).href);
  const content = isRecord(loaded) ? loaded['default'] : undefined;
  if (!isDemoContent(content)) throw new Error(`${file}: the default export is not a demo content set`);
  return content;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Enough of the shape to fail at load instead of deep in the demo: the project names and the seed builder. */
function isDemoContent(value: unknown): value is DemoContent {
  return isRecord(value) && isRecord(value['projects']) && typeof value['seeds'] === 'function';
}
