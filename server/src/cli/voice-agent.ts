/**
 * `rarog voice-agent set-key|set-model|status`: the OpenAI key (`OPENAI_API_KEY`, secrets file) and the Realtime
 * model (`RAROG_COMPANION_MODEL`, `config.json`) of the voice agent on this server (`docs/companion.md`). The key
 * stays on the server; the app gets only short-lived keys from `POST /api/companion/token`.
 *
 * - `set-key` writes the key through `secrets-file.ts`, the path of `rarog dictation set-key` (input never from argv,
 *   refusal under `service.wrapper` before asking, the Rarog lock after the question, atomic write, read-back).
 *   Then the flag rule ({@link voiceAgentKeysReady}): the voice agent speaks only with the Soniox voice, so without
 *   `SONIOX_API_KEY` in the secrets file it names `rarog dictation set-key` and writes no flag. With both keys, when
 *   `RAROG_COMPANION` in `config.json` is not `1` (missing or an explicit `0` alike), it asks in a terminal whether to
 *   turn the voice agent on; "y" writes `RAROG_COMPANION=1` with the `set-model` writer under the Rarog lock taken
 *   after the answer, both keys checked again under it. Without a terminal or without `config.json` it only prints
 *   the command that does it. Its output ends with the restart reminder.
 * - `set-model <model>` changes only `env.RAROG_COMPANION_MODEL` in `config.json`. It writes only a file in the exact
 *   layout `rarog setup` writes (`configFileText` in `serve.ts`), so every other byte stays; any other
 *   layout is a refusal with a hand-edit hint. A symlink is followed and its target is replaced (the link stays).
 *   The write (`config-rewrite.ts`) goes through a temporary file next to the target (`wx`, the target's mode,
 *   `fsync`) and `rename`;
 *   right before `rename` the target is read again, and other bytes, another inode or another link target is a
 *   refusal, the temporary file removed.
 * - `status` prints the state on disk, never the key.
 *
 * None of them restarts the server, calls OpenAI or starts a process; only `set-key` takes the `lock.ts` lock, for its
 * writes. The server reads the key, the model and the flags at start, so a change takes `rarog restart`.
 */
import path from 'node:path';
import { COMPANION_MODEL_DEFAULT, COMPANION_MODEL_PATTERN, parseCompanionEnabled } from '../config.ts';
import {
  COMPANION_ENV, COMPANION_MODEL_ENV, OPENAI_API_KEY_ENV, SONIOX_API_KEY_ENV,
} from '../config-env.ts';
import { REPAIR, rarogCli } from '../install/repair.ts';
import { CONFIG_WRITES, NOTHING_CHANGED, readSetupConfig, replaceConfig } from './config-rewrite.ts';
import type { ConfigWrites } from './config-rewrite.ts';
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, isYes, out } from './io.ts';
import type { CliIo } from './io.ts';
import type { Lock } from './lock.ts';
import { SECRET_WRITES, lockSecrets, saveSecret, shellEnvLine, unlockSecrets } from './secrets-file.ts';
import type { SecretWrites } from './secrets-file.ts';
import { CONFIG_FILENAME, rarogConfigDir, readPrivateEnv, readRarogConfig } from './serve.ts';
import { INTERRUPTED, hasValue, voiceAgentKeysReady } from './voice-keys.ts';
import { usageFor } from './screen/prose.ts';

export const VOICE_AGENT_USAGE = `  rarog voice-agent set-key
  rarog voice-agent set-model <model>
  rarog voice-agent status
      The OpenAI key and the Realtime model of the voice agent on this server. The voice agent speaks
      with the Soniox voice, so it also needs the dictation key (rarog dictation set-key). set-key reads
      the key from standard input (in a terminal it asks without echo) and saves it as OPENAI_API_KEY in
      ~/.config/rarog/secret/private.env, then, with the Soniox key too and RAROG_COMPANION not 1, asks
      whether to turn the voice agent on (RAROG_COMPANION=1 in ~/.config/rarog/config.json); set-model
      writes RAROG_COMPANION_MODEL in ~/.config/rarog/config.json (a gpt-realtime… name); status prints
      the state on disk, never a key. The server uses a new key or model after a restart.`;

export interface VoiceAgentDeps {
  readonly secretWrites?: SecretWrites;
  readonly configWrites?: ConfigWrites;
}

const PROMPT = 'OpenAI API key (typing is hidden; Enter saves, Ctrl-D cancels): ';

const restartLine = (): string => `The server reads the key and the model at start: restart it with ${REPAIR.restart}.`;

function setModel(io: CliIo, model: string, writes: ConfigWrites): number {
  if (!COMPANION_MODEL_PATTERN.test(model)) {
    throw new Refusal(`"${model}" is not an OpenAI Realtime model name (expected gpt-realtime…, lowercase letters,`
      + ` digits, dots and hyphens); ${NOTHING_CHANGED}.`);
  }
  const file = path.join(rarogConfigDir(io.env), CONFIG_FILENAME);
  const { first, parsed, env } = readSetupConfig(file, io.env, `"${COMPANION_MODEL_ENV}": "${model}"`);
  const old = typeof env[COMPANION_MODEL_ENV] === 'string' ? env[COMPANION_MODEL_ENV] : null;
  const before = old === null ? `not set (default ${COMPANION_MODEL_DEFAULT})` : old;
  if (old === model) {
    out(io, `${COMPANION_MODEL_ENV} in ${file} is already ${model}; nothing changed.`);
    return EXIT_OK;
  }
  replaceConfig(first, { ...parsed, env: { ...env, [COMPANION_MODEL_ENV]: model } }, writes, 'the new model');
  out(io, `${COMPANION_MODEL_ENV} in ${file}: ${before} → ${model}.`);
  out(io, restartLine());
  return EXIT_OK;
}

const VOICE_AGENT_QUESTION = 'Turn on the voice agent? [y/N] ';

/** The line when the Soniox key is missing: the step before the voice agent. */
const needsSonioxLine = (): string => `The voice agent stays off: it speaks only with the Soniox voice, and the secrets`
  + ` file has no ${SONIOX_API_KEY_ENV}. Save it with ${rarogCli('dictation set-key')}, then run`
  + ` ${rarogCli('voice-agent set-key')} again to turn the voice agent on.`;

/** The last line of `set-key`: the key and the flags take a restart. */
const setKeyRestartLine = (): string => `The server reads the key and the flags at start: run ${REPAIR.restart}.`;

/**
 * After the key is saved: the voice agent flag. Without the Soniox key: the line naming `rarog dictation set-key`, no
 * question. `RAROG_COMPANION` already `1` = nothing to do. Otherwise, in a terminal, the question; "y" writes
 * `RAROG_COMPANION=1` under the Rarog lock, taken only after the answer so it is never held while a human thinks; both
 * files are read again under it, and the flag rule is checked again there. Without a terminal or without
 * `config.json`: one line with the command, no write.
 */
async function offerVoiceAgent(io: CliIo, writes: ConfigWrites): Promise<void> {
  const file = path.join(rarogConfigDir(io.env), CONFIG_FILENAME);
  const config = readRarogConfig(io.env);
  if (config === null) {
    out(io, `The voice agent is off: ${file} does not exist; create it with ${rarogCli('setup')}, then run`
      + ` ${rarogCli('voice-agent set-key')} in a terminal to turn it on.`);
    return;
  }
  if (!voiceAgentKeysReady(readPrivateEnv(io.env).values)) {
    out(io, needsSonioxLine());
    return;
  }
  const flag = config.env[COMPANION_ENV];
  if (flag?.trim() === '1') return;
  const state = flag === undefined || flag.trim() === '' ? `${COMPANION_ENV} is not set` : `${COMPANION_ENV}=${flag}`;
  if (io.ask === undefined) {
    out(io, `${file}: ${state}, so the voice agent is off; run ${rarogCli('voice-agent set-key')} in a terminal to`
      + ' turn it on.');
    return;
  }
  out(io, `${file}: ${state}, so the voice agent is off.`);
  if (!isYes(await io.ask(VOICE_AGENT_QUESTION))) {
    out(io, `The voice agent stays off; ${file} is unchanged.`);
    return;
  }
  let lock: Lock;
  try {
    lock = lockSecrets(io.env, 'cannot turn on the voice agent now');
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    throw new Refusal(`${failure.message} ${NOTHING_CHANGED} in ${file}.`);
  }
  try {
    if (!voiceAgentKeysReady(readPrivateEnv(io.env).values)) {
      out(io, needsSonioxLine());
      return;
    }
    const name = `${COMPANION_ENV}=1`;
    const { first, parsed, env } = readSetupConfig(file, io.env, `"${COMPANION_ENV}": "1"`);
    if (env[COMPANION_ENV] === '1') {
      out(io, `${name} already in ${file}; nothing changed.`);
      return;
    }
    replaceConfig(first, { ...parsed, env: { ...env, [COMPANION_ENV]: '1' } }, writes, 'the voice agent flag');
    out(io, `Wrote ${name} in ${file}.`);
  } finally {
    unlockSecrets(lock);
  }
}

async function setKey(io: CliIo, secretWrites: SecretWrites, configWrites: ConfigWrites): Promise<number> {
  const saved = await saveSecret(io, secretWrites, {
    name: OPENAI_API_KEY_ENV, prompt: PROMPT, statusCommand: 'voice-agent status',
  });
  if (saved === INTERRUPTED) return EXIT_INTERRUPTED;
  out(io, `Saved ${OPENAI_API_KEY_ENV} in ${saved.file} (${saved.replaced ? 'replaced' : 'added'}).`);
  out(io, 'Every paired device can get short-lived keys paid by this key: use a key of a separate OpenAI project'
    + ' with only Realtime access and a budget limit.');
  const envLine = shellEnvLine(io.env, OPENAI_API_KEY_ENV);
  if (envLine !== null) out(io, `Warning: ${envLine}`);
  let code = EXIT_OK;
  try {
    await offerVoiceAgent(io, configWrites);
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    err(io, `rarog voice-agent set-key: ${failure.message} The key is saved; to turn the voice agent on, run`
      + ` ${rarogCli('voice-agent set-key')} again.`);
    code = EXIT_REFUSED;
  }
  out(io, setKeyRestartLine());
  return code;
}

function status(io: CliIo): number {
  const config = readRarogConfig(io.env);
  const secrets = readPrivateEnv(io.env);
  out(io, `config file: ${config?.file ?? path.join(rarogConfigDir(io.env), CONFIG_FILENAME)}`
    + ` (${config === null ? 'missing' : 'present'})`);
  out(io, `secrets file: ${secrets.file} (${secrets.present ? 'present' : 'missing'})`);
  if (config !== null && config.wrapper !== null) {
    out(io, `${OPENAI_API_KEY_ENV}: not checked (service.wrapper in ${config.file} supplies the secrets of the`
      + ' service; rarog does not run it and cannot see what it supplies)');
  } else {
    const openai = hasValue(secrets.values[OPENAI_API_KEY_ENV]);
    out(io, `${OPENAI_API_KEY_ENV}: ${openai ? 'set' : 'not set'} (secrets file)`);
    out(io, hasValue(secrets.values[SONIOX_API_KEY_ENV])
      ? `${SONIOX_API_KEY_ENV}: set (secrets file)`
      : `${SONIOX_API_KEY_ENV}: not set (secrets file; the voice agent needs it: ${rarogCli('dictation set-key')})`);
  }
  const model = config?.env[COMPANION_MODEL_ENV];
  if (model === undefined || model.trim() === '') {
    out(io, `model: ${COMPANION_MODEL_DEFAULT} (default; ${COMPANION_MODEL_ENV} is not in config.json)`);
  } else if (COMPANION_MODEL_PATTERN.test(model.trim())) {
    out(io, `model: ${model.trim()} (${COMPANION_MODEL_ENV} in config.json)`);
  } else {
    out(io, `model: "${model}" in config.json is not a Realtime model name; the server refuses to start with it`);
  }
  const flag = config?.env[COMPANION_ENV];
  let on = false;
  try {
    on = parseCompanionEnabled(flag);
  } catch {
    on = false;
  }
  out(io, on
    ? `${COMPANION_ENV}=1: the voice agent is on (it also needs the OpenAI and Soniox keys)`
    : `${COMPANION_ENV}=${flag ?? ''}: the voice agent is off, also with a key (set ${COMPANION_ENV}=1 in config.json)`);
  const envLine = shellEnvLine(io.env, OPENAI_API_KEY_ENV);
  if (envLine !== null) out(io, envLine);
  out(io, `This is the configuration on disk, not the state of the running server. ${restartLine()}`);
  return EXIT_OK;
}

/** `rarog voice-agent …`; `argv` starts with `voice-agent`. A wrong call = {@link Usage}. */
export async function voiceAgentCommand(
  argv: readonly string[], io: CliIo, deps: VoiceAgentDeps = {},
): Promise<number> {
  const [, sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h') {
    out(io, usageFor(io, `Usage:\n${VOICE_AGENT_USAGE}`));
    return EXIT_OK;
  }
  if (sub !== 'set-key' && sub !== 'set-model' && sub !== 'status') {
    throw new Usage(`rarog voice-agent: ${sub === undefined ? 'missing' : 'unknown'} subcommand`
      + ' (set-key, set-model or status).');
  }
  if (sub === 'set-model' && rest.length !== 1) {
    throw new Usage('rarog voice-agent set-model takes one argument: the model name.');
  }
  if (sub !== 'set-model' && rest.length > 0) {
    throw new Usage(`rarog voice-agent ${sub} takes no arguments${sub === 'set-key'
      ? ': it reads the key from standard input, never from the command line' : ''}.`);
  }
  try {
    if (sub === 'status') return status(io);
    if (sub === 'set-model') return setModel(io, rest[0] ?? '', deps.configWrites ?? CONFIG_WRITES);
    return await setKey(io, deps.secretWrites ?? SECRET_WRITES, deps.configWrites ?? CONFIG_WRITES);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog voice-agent ${sub}: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}
