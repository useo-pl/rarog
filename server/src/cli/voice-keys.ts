/**
 * The voice keys of this server in the secrets file: the Soniox key `SONIOX_API_KEY` (dictation, and the voice of the
 * voice agent) and the OpenAI key `OPENAI_API_KEY` (the voice agent). The flag rule of the voice agent
 * ({@link voiceAgentKeysReady}), the check of a typed key ({@link checkKey}) and the key read from the one available
 * input ({@link readKey}). The module reads no file and writes nothing: the callers read the secrets file and write it
 * through `secrets-file.ts`.
 */
import { OPENAI_API_KEY_ENV, SONIOX_API_KEY_ENV } from '../config-env.ts';
import { Refusal } from './io.ts';
import type { CliIo } from './io.ts';
import { SECRET_MAX_BYTES, SecretInputInterrupted, SecretInputTooLong } from './secret-input.ts';

const NOTHING_CHANGED = 'nothing changed';
/** A white or control character: space, tab, CR, LF, NUL, DEL and the rest. */
const NOT_ONE_TOKEN = /[\s\p{Cc}]/u;
/** Ctrl-C during the question: {@link saveSecret} wrote nothing. */
export const INTERRUPTED = Symbol('interrupted');

const errnoCode = (failure: unknown, fallback = 'error'): string => {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : fallback;
};

export const hasValue = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/**
 * The flag rule of the voice agent: `RAROG_COMPANION=1` only with both keys in the secrets file, the OpenAI key
 * and the Soniox key, because the voice agent speaks only with the Soniox voice.
 */
export function voiceAgentKeysReady(secrets: Readonly<Record<string, string>>): boolean {
  return hasValue(secrets[OPENAI_API_KEY_ENV]) && hasValue(secrets[SONIOX_API_KEY_ENV]);
}

const tooLong = (): Refusal =>
  new Refusal(`The key is longer than ${String(SECRET_MAX_BYTES)} bytes; ${NOTHING_CHANGED}.`);

/**
 * A typed key, trimmed, or why it is not one: empty (only white space), longer than {@link SECRET_MAX_BYTES} bytes, or
 * not one line without spaces. No network call: a wrong key shows in the first use.
 */
export type KeyCheck =
  | { readonly key: string }
  | { readonly fault: 'empty' | 'too-long' | 'not-one-token' };

export function checkKey(raw: string): KeyCheck {
  if (Buffer.byteLength(raw, 'utf8') > SECRET_MAX_BYTES) return { fault: 'too-long' };
  const value = raw.trim();
  if (value === '') return { fault: 'empty' };
  if (NOT_ONE_TOKEN.test(value)) return { fault: 'not-one-token' };
  return { key: value };
}

/** The value from the one available input; {@link INTERRUPTED} = Ctrl-C. */
export async function readKey(io: CliIo, prompt: string): Promise<string | typeof INTERRUPTED> {
  let raw: string | null;
  try {
    if (io.askSecret !== undefined) raw = await io.askSecret(prompt);
    else if (io.readStdin !== undefined) raw = await io.readStdin(SECRET_MAX_BYTES);
    else raw = null;
  } catch (failure) {
    if (failure instanceof SecretInputInterrupted) return INTERRUPTED;
    if (failure instanceof SecretInputTooLong) throw tooLong();
    throw new Refusal(`Cannot read the key (${errnoCode(failure, 'input error')}); ${NOTHING_CHANGED}.`);
  }
  if (raw === null) throw new Refusal(`No key given (end of input); ${NOTHING_CHANGED}.`);
  const checked = checkKey(raw);
  if ('key' in checked) return checked.key;
  switch (checked.fault) {
    case 'too-long':
      throw tooLong();
    case 'empty':
      throw new Refusal(`The key is empty; ${NOTHING_CHANGED}.`);
    case 'not-one-token':
      throw new Refusal('The key has a space, a line break or a control character: expected one line without spaces;'
        + ` ${NOTHING_CHANGED}.`);
  }
}
