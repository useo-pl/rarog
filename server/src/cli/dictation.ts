/**
 * `rarog dictation set-key|status`: the Soniox key of the server (`SONIOX_API_KEY`) in the secrets file
 * `~/.config/rarog/secret/private.env`, which `rarog serve` reads (`serve.ts`). The permanent key stays on the
 * server; the app gets only temporary keys from it.
 *
 * `set-key` writes the key through the shared path of `secrets-file.ts` (steps 1–7: input never from argv, refusal
 * under `service.wrapper`, the Rarog lock taken after the question, the file read again under it, atomic write,
 * read-back), then prints the file, "added" or "replaced", the restart and the EU region; a warning when the name is
 * set in the command's environment.
 *
 * What the command does not do: it does not restart the server, ask Soniox, start processes or log anything; it holds
 * the `lock.ts` lock only for the write, never while waiting for the key. The value never reaches stdout, stderr or
 * any file other than the secrets file.
 */
import { parseVoiceEnabled } from '../config.ts';
import { SONIOX_API_KEY_ENV, VOICE_ENV } from '../config-env.ts';
import { REPAIR } from '../install/repair.ts';
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, out } from './io.ts';
import type { CliIo } from './io.ts';
import { SECRET_WRITES, saveSecret, shellEnvLine } from './secrets-file.ts';
import type { SecretWrites } from './secrets-file.ts';
import { readPrivateEnv, readRarogConfig } from './serve.ts';
import { INTERRUPTED } from './voice-keys.ts';
import { usageFor } from './screen/prose.ts';

export const DICTATION_USAGE = `  rarog dictation set-key
  rarog dictation status
      The Soniox key for dictation on this server. set-key reads the key from standard input (in a terminal it
      asks without echo) and saves it as SONIOX_API_KEY in ~/.config/rarog/secret/private.env; status says
      whether a key is set, never the value. The server uses a new key after a restart.`;

export interface DictationDeps {
  readonly writes?: SecretWrites;
}

const PROMPT = 'Soniox API key (typing is hidden; Enter saves, Ctrl-D cancels): ';

async function setKey(io: CliIo, writes: SecretWrites): Promise<number> {
  const saved = await saveSecret(io, writes, {
    name: SONIOX_API_KEY_ENV, prompt: PROMPT, statusCommand: 'dictation status',
  });
  if (saved === INTERRUPTED) return EXIT_INTERRUPTED;
  out(io, `Saved ${SONIOX_API_KEY_ENV} in ${saved.file} (${saved.replaced ? 'replaced' : 'added'}).`);
  out(io, `The server uses the new key after a restart: ${REPAIR.restart}.`);
  out(io, 'The key must come from a Soniox project in the EU region: the server asks api.eu.soniox.com, which'
    + ' rejects a key from another region (401).');
  const envLine = shellEnvLine(io.env, SONIOX_API_KEY_ENV);
  if (envLine !== null) out(io, `Warning: ${envLine}`);
  return EXIT_OK;
}

function status(io: CliIo): number {
  const config = readRarogConfig(io.env);
  const secrets = readPrivateEnv(io.env);
  out(io, `secrets file: ${secrets.file} (${secrets.present ? 'present' : 'missing'})`);
  const set = (secrets.values[SONIOX_API_KEY_ENV] ?? '').trim() !== '';
  out(io, `${SONIOX_API_KEY_ENV}: ${set ? 'set' : 'not set'}`);
  if (config !== null && config.wrapper !== null) {
    out(io, `service.wrapper in ${config.file}: the service gets its secrets from it, and a name it exports`
      + ' overrides the file; rarog does not run it and cannot see what it supplies.');
  }
  const voice = config?.env[VOICE_ENV];
  if (config !== null && !parseVoiceEnabled(voice)) {
    out(io, `${VOICE_ENV}=${voice ?? ''} in ${config.file}: dictation is off, also with a key.`);
  }
  const envLine = shellEnvLine(io.env, SONIOX_API_KEY_ENV);
  if (envLine !== null) out(io, envLine);
  return EXIT_OK;
}

/** `rarog dictation …`; `argv` starts with `dictation`. A bad call = {@link Usage} (without echoing the argument). */
export async function dictationCommand(argv: readonly string[], io: CliIo, deps: DictationDeps = {}): Promise<number> {
  const [, sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h') {
    out(io, usageFor(io, `Usage:\n${DICTATION_USAGE}`));
    return EXIT_OK;
  }
  if (sub !== 'set-key' && sub !== 'status') {
    throw new Usage(`rarog dictation: ${sub === undefined ? 'missing' : 'unknown'} subcommand (set-key or status).`);
  }
  if (rest.length > 0) {
    throw new Usage(`rarog dictation ${sub} takes no arguments${sub === 'set-key'
      ? ': it reads the key from standard input, never from the command line' : ''}.`);
  }
  try {
    return sub === 'status' ? status(io) : await setKey(io, deps.writes ?? SECRET_WRITES);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog dictation ${sub}: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}
