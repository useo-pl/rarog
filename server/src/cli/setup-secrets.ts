/**
 * Step 3 of `rarog setup`: the secrets file `secret/private.env` next to `config.json`, and the iroh server key
 * `RAROG_IROH_KEY` in it (also for step 2). Of the secrets only the iroh key is required, and only with
 * `RAROG_IROH=1`; setup generates it when it is missing and never changes a present one, its value never printed. A
 * present file is checked with the server's own rules; the step is skipped when `service.wrapper` supplies the
 * secrets. Every write goes through `secrets-file.ts` under the Rarog lock.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { IROH_ENV, IROH_KEY_ENV, SONIOX_API_KEY_ENV } from '../config-env.ts';
import { rarogCli } from '../install/repair.ts';
import { Refusal } from './io.ts';
import type { Lock } from './lock.ts';
import { SECRET_WRITES, ensureSecretDir, withSecretsLock, writeSecretLine } from './secrets-file.ts';
import { PRIVATE_ENV_FILENAME, SECRET_DIRNAME, rarogConfigDir, readPrivateEnv } from './serve.ts';
import { SCREEN_TITLE, confirm, entry, line, waitingStep } from './setup-context.ts';
import type { Ctx, Step } from './setup-context.ts';
import { irohConfigured } from './setup-transport.ts';

/** iroh server key: 32 bytes as 64 hex characters (the rule of `parseIroh` in `config.ts`). */
const IROH_KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * The iroh key in the secrets file: no file, a file without the key (also an empty or blank value, which the server
 * reads as missing), a valid key, or why the server would refuse it (without the value).
 */
export type KeyState = 'no-file' | 'no-key' | 'present' | { readonly problem: string };

export function irohKeyState(env: NodeJS.ProcessEnv): KeyState {
  let secrets;
  try {
    secrets = readPrivateEnv(env);
  } catch (failure) {
    if (failure instanceof Refusal) return { problem: failure.message };
    throw failure;
  }
  if (!secrets.present) return 'no-file';
  const value = (secrets.values[IROH_KEY_ENV] ?? '').trim();
  if (value === '') return 'no-key';
  if (IROH_KEY_RE.test(value)) return 'present';
  return {
    problem: `${secrets.file}: ${IROH_KEY_ENV} is not 64 hex characters, so the server refuses it; fix that line or`
      + ' remove it, then run rarog setup again',
  };
}

/** What setup does with the key (the plan line before the question). */
export function keyPlan(state: 'no-file' | 'no-key' | 'present', file: string): string {
  if (state === 'present') return `${IROH_KEY_ENV} is already in ${file} and stays`;
  return state === 'no-file'
    ? `${IROH_KEY_ENV} is created in ${file} (the value is never printed)`
    : `${IROH_KEY_ENV} is added to ${file}; its other lines stay as they are (the value is never printed)`;
}

/**
 * `fn` under the Rarog lock of the config directory (`lockSecrets` in `secrets-file.ts`, the lock of `set-key` and of
 * the Claude Code settings writer): a live other holder = problem with its PID, `fn` not run. `fn` is synchronous,
 * so setup never holds the lock across a question.
 */
export function underLock<T>(ctx: Ctx, fn: (held: Lock) => T): T | { readonly problem: string } {
  try {
    return withSecretsLock(ctx.io.env, 'rarog setup', fn);
  } catch (failure) {
    if (failure instanceof Refusal) return { problem: failure.message };
    throw failure;
  }
}

/**
 * The iroh server key in the secrets file, under the lock `held` by the caller ({@link underLock}). A valid key
 * stays. Otherwise a new key goes in through `writeSecretLine`: a missing file is created (0600 in a 0700
 * directory), an existing one keeps its other bytes, and a key line with an empty value gets the value in place;
 * then a read-back. The key's value is in no message.
 */
export function ensureIrohKey(ctx: Ctx, held: Lock):
  { readonly done: 'kept' | 'created' | 'added' } | { readonly problem: string } {
  const env = ctx.io.env;
  try {
    ensureSecretDir(env);
    const state = irohKeyState(env);
    if (typeof state !== 'string') return state;
    if (state === 'present') return { done: 'kept' };
    const key = randomBytes(32).toString('hex');
    writeSecretLine(held, env, SECRET_WRITES, { name: IROH_KEY_ENV, value: key, statusCommand: 'doctor' });
    return { done: state === 'no-file' ? 'created' : 'added' };
  } catch (failure) {
    if (failure instanceof Refusal) return { problem: failure.message };
    throw failure;
  }
}

/**
 * The question about a missing iroh server key in the secrets file (one line at 60 columns); the file
 * and the reason stand in the detail line before it, and the value is never printed.
 */
export const IROH_KEY_QUESTION = `Create the iroh server key ${IROH_KEY_ENV}?`;
/** What the iroh key is for, right above {@link IROH_KEY_QUESTION}. */
export const IROH_KEY_NOTE = 'Lets your phone recognise this computer; never leaves it.';

/**
 * `config.json` with `RAROG_IROH=1` but no key in the secrets file (iroh turned on by hand): a question, then the key
 * under the lock as in step 2. `null` = the key is there; otherwise the result of the step.
 */
async function irohKeyStep(ctx: Ctx, title: string, file: string): Promise<Step | null> {
  const state = irohKeyState(ctx.io.env);
  if (typeof state !== 'string') {
    line(ctx, state.problem);
    return { title, state: 'problem', summary: state.problem };
  }
  if (state === 'present') return null;
  line(ctx, `${IROH_ENV}=1 in config.json, but ${file} has no ${IROH_KEY_ENV}; the server does not start without it`);
  const missing: Step = {
    title, state: 'missing',
    summary: `${IROH_KEY_ENV} missing: run rarog setup in a terminal and answer y (the server does not start`
      + ' without it)',
  };
  if (!await confirm(ctx, IROH_KEY_QUESTION, IROH_KEY_NOTE)) {
    return missing;
  }
  const key = underLock(ctx, (held) => ensureIrohKey(ctx, held));
  if ('problem' in key) {
    line(ctx, key.problem);
    return { title, state: 'problem', summary: key.problem };
  }
  ctx.irohKeyCreated = true;
  line(ctx, `${file}: ${IROH_KEY_ENV} ${key.done === 'created' ? 'written' : 'added'}`);
  return null;
}

export async function stepSecrets(ctx: Ctx): Promise<Step> {
  const title = 'secrets file';
  const dir = path.join(rarogConfigDir(ctx.io.env), SECRET_DIRNAME);
  const file = path.join(dir, PRIVATE_ENV_FILENAME);
  if (ctx.config !== null && ctx.config.wrapper !== null) {
    ctx.secretsOk = true;
    line(ctx, 'skipped: service.wrapper from config.json supplies the secrets');
    return { title, state: 'ok', summary: 'secrets: supplied by service.wrapper' };
  }
  if (irohConfigured(ctx) && entry(file) === 'missing') {
    const key = await irohKeyStep(ctx, title, file);
    if (key !== null) return key;
  }
  const state = entry(file);
  if (state === 'missing') {
    // Without iroh the server needs no secret, so setup creates no file; a command saves the optional dictation key.
    ctx.secretsOk = true;
    line(ctx, `${file}: missing — optional (the Soniox key for dictation, SONIOX_API_KEY:`
      + ` ${rarogCli('dictation set-key', ctx.mode)})`);
    const summary = `${file}: missing (optional)`;
    // Without config.json nobody knows yet whether the server needs the key: the step waits for it.
    return ctx.config === null ? waitingStep(title, 'info', summary, ctx.configWaits ?? SCREEN_TITLE.config)
      : { title, state: 'info', summary };
  }
  if (typeof state !== 'string') {
    return { title, state: 'problem', summary: `${file}: unreadable (${state.code})` };
  }
  let values;
  try {
    values = readPrivateEnv(ctx.io.env).values;
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    line(ctx, failure.message);
    return { title, state: 'problem', summary: failure.message };
  }
  if (irohConfigured(ctx)) {
    const key = await irohKeyStep(ctx, title, file);
    if (key !== null) return key;
  }
  ctx.secretsOk = true;
  line(ctx, `${file}: present (permissions OK)${irohConfigured(ctx) ? `, ${IROH_KEY_ENV} set` : ''}`);
  if ((values[SONIOX_API_KEY_ENV] ?? '').trim() === '') {
    line(ctx, `${SONIOX_API_KEY_ENV} for dictation: not set (optional): ${rarogCli('dictation set-key', ctx.mode)}`);
  }
  // The screen line names the file next to config.json (the Config line above shows that directory): one line at 60.
  // A key this run wrote is news; a file that was there before has no line of its own.
  return ctx.irohKeyCreated
    ? { title, state: 'ok', summary: `${file}: present`, result: 'key created', changed: true }
    : { title, state: 'ok', summary: `${file}: present`, result: `${SECRET_DIRNAME}/${PRIVATE_ENV_FILENAME}: present` };
}
