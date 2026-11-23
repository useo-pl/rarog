/**
 * The voice questions of step 2 of `rarog setup`: dictation with Soniox, then, only with a Soniox key,
 * the voice agent with an OpenAI key. {@link askVoice} asks before the Rarog lock and writes nothing; under the lock
 * of step 2 {@link writeVoiceKeys} writes the typed keys before `config.json` and reads the flag rule
 * (`voiceAgentKeysReady`) from the secrets file; {@link reportVoice} prints the outcome. A key already in the secrets
 * file stays and is not asked for. A key's value reaches neither the screen nor the log.
 */
import { OPENAI_API_KEY_ENV, SONIOX_API_KEY_ENV } from '../config-env.ts';
import type { ServerEnvName } from '../config-env.ts';
import { rarogCli } from '../install/repair.ts';
import { Refusal } from './io.ts';
import type { Lock } from './lock.ts';
import { SECRET_MAX_BYTES, SecretInputInterrupted, SecretInputTooLong } from './secret-input.ts';
import { SECRET_WRITES, ensureSecretDir, writeSecretLine } from './secrets-file.ts';
import { readPrivateEnv } from './serve.ts';
import { SetupInterrupted, confirm, errnoCode, line } from './setup-context.ts';
import type { Ctx } from './setup-context.ts';
import { checkKey, hasValue, voiceAgentKeysReady } from './voice-keys.ts';

/** The question about dictation: "y" leads to the Soniox key prompt, "n" leaves it for later. */
export const DICTATION_QUESTION = 'Set up dictation with Soniox now?';
/** The question about the voice agent, asked only with a Soniox key. */
export const AGENT_QUESTION = 'Set up the voice agent now (OpenAI key, paid)?';
/** What each question is for and where its key comes from, right above it. */
export const DICTATION_NOTE = 'Voice typing in the app. Key: console.soniox.com (EU)';
export const AGENT_NOTE = 'Talks back to you. Key: platform.openai.com/api-keys';
/** The hidden key prompts: `? ` like every question of the step screen. */
export const SONIOX_PROMPT = '? Soniox EU key (hidden): ';
export const OPENAI_PROMPT = '? OpenAI API key (hidden): ';

/**
 * One voice key: of the voice feature, its variable, its `rarog … status` and `rarog … set-key` commands and the texts
 * around its prompt.
 */
interface VoiceKeySpec {
  readonly feature: string;
  readonly name: ServerEnvName;
  readonly label: string;
  readonly statusCommand: string;
  /** The command that sets the key up later, named when the feature stays off. */
  readonly setKeyCommand: string;
  /** The app page that shows where the key comes from (the app takes no key). */
  readonly appPage: string;
  readonly question: string;
  /** What the question is for and where the key comes from, right above the question. */
  readonly explanation: string;
  /**
   * One sentence after "y", right before the prompt; `null` = none, because the question says enough (the Soniox
   * question names the user's own EU key, and the first setup with both keys fits its budget).
   */
  readonly sentence: string | null;
  readonly prompt: string;
}

const SONIOX: VoiceKeySpec = {
  feature: 'dictation', name: SONIOX_API_KEY_ENV, label: 'Soniox', statusCommand: 'dictation status',
  setKeyCommand: 'dictation set-key', appPage: 'Settings → Dictation',
  question: DICTATION_QUESTION, explanation: DICTATION_NOTE, sentence: null,
  prompt: SONIOX_PROMPT,
};

const OPENAI: VoiceKeySpec = {
  feature: 'voice agent', name: OPENAI_API_KEY_ENV, label: 'OpenAI', statusCommand: 'voice-agent status',
  setKeyCommand: 'voice-agent set-key', appPage: 'Settings → Voice Agent',
  question: AGENT_QUESTION, explanation: AGENT_NOTE,
  sentence: 'Every paired phone uses this key; give it a budget limit.',
  prompt: OPENAI_PROMPT,
};

/**
 * One voice key after the questions: in the secrets file already (`kept`), typed now (`typed`), or none (`off`, with
 * the reason when the user said "y" and gave no usable key).
 */
export type VoiceKey =
  | { readonly kind: 'kept' }
  | { readonly kind: 'typed'; readonly value: string }
  | { readonly kind: 'off'; readonly why: string | null };

/** The answers of one run; `openai` is `null` when the agent question was not asked (no Soniox key). */
export interface VoiceAnswers {
  readonly soniox: VoiceKey;
  readonly openai: VoiceKey | null;
}

/** What happened under the lock: each typed key `saved`, found there meanwhile (`kept`) or not written. */
export interface VoiceWrites {
  soniox: 'saved' | 'kept' | 'none';
  openai: 'saved' | 'kept' | 'none';
  /** `RAROG_COMPANION=1` goes into the new `config.json`: both keys in the secrets file under the lock. */
  flag: boolean;
}

export const noVoiceWrites = (): VoiceWrites => ({ soniox: 'none', openai: 'none', flag: false });

const KEPT: VoiceKey = { kind: 'kept' };
const SKIPPED = 'skipped: no key';

/**
 * The questions of step 2, right before the Rarog lock: nothing without a hidden question on the terminal, and a key
 * the secrets file already has is not asked for. Ctrl-C at a prompt = {@link SetupInterrupted}, nothing written.
 * `null` = no questions (no terminal, or the secrets file is refused: the Secrets step says why).
 */
export async function askVoice(ctx: Ctx): Promise<VoiceAnswers | null> {
  const askSecret = ctx.view.askSecret;
  if (ctx.ask === null || askSecret === null) return null;
  let present: Readonly<Record<string, string>>;
  try {
    present = readPrivateEnv(ctx.io.env).values;
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    line(ctx, failure.message);
    ctx.view.note(`${SONIOX.feature}: off (the secrets file is refused, see Secrets)`);
    return null;
  }
  const soniox = hasValue(present[SONIOX.name]) ? KEPT : await askKey(ctx, askSecret, SONIOX);
  if (soniox.kind === 'off') return { soniox, openai: null };
  const openai = hasValue(present[OPENAI.name]) ? KEPT : await askKey(ctx, askSecret, OPENAI);
  return { soniox, openai };
}

async function askKey(
  ctx: Ctx, askSecret: (prompt: string) => Promise<string | null>, spec: VoiceKeySpec,
): Promise<VoiceKey> {
  if (!await confirm(ctx, spec.question, spec.explanation)) return { kind: 'off', why: null };
  if (spec.sentence !== null) ctx.view.questionNote(spec.sentence);
  let raw: string | null;
  try {
    raw = await askSecret(spec.prompt);
  } catch (failure) {
    if (failure instanceof SecretInputInterrupted) throw new SetupInterrupted(`Ctrl-C at the ${spec.label} key prompt`);
    if (failure instanceof SecretInputTooLong) return { kind: 'off', why: tooLong() };
    return { kind: 'off', why: `key not read (${errnoCode(failure)})` };
  }
  // Ctrl-D, Enter alone: no key, so the feature stays off.
  if (raw === null) return { kind: 'off', why: SKIPPED };
  const checked = checkKey(raw);
  if ('key' in checked) return { kind: 'typed', value: checked.key };
  switch (checked.fault) {
    case 'empty':
      return { kind: 'off', why: SKIPPED };
    case 'too-long':
      return { kind: 'off', why: tooLong() };
    case 'not-one-token':
      return { kind: 'off', why: 'key not saved: it has spaces or control characters' };
  }
}

const tooLong = (): string => `key not saved: longer than ${String(SECRET_MAX_BYTES)} bytes`;

/**
 * Under the Rarog lock `held` of step 2, after the re-check that `config.json` is still missing: the secrets
 * directory (0700, also without iroh) when a key is to be written, the typed keys (a key that appeared in the file
 * meanwhile stays), then the flag rule from the file read under the lock. `writes` records each write as it lands, so
 * the report is right also after a refusal half way.
 */
export function writeVoiceKeys(
  ctx: Ctx, held: Lock, answers: VoiceAnswers, writes: VoiceWrites,
): { readonly flag: boolean } | { readonly problem: string } {
  const env = ctx.io.env;
  try {
    const typed: [VoiceKeySpec, string, 'soniox' | 'openai'][] = [];
    if (answers.soniox.kind === 'typed') typed.push([SONIOX, answers.soniox.value, 'soniox']);
    if (answers.openai?.kind === 'typed') typed.push([OPENAI, answers.openai.value, 'openai']);
    if (typed.length > 0) ensureSecretDir(env);
    for (const [spec, value, which] of typed) {
      if (hasValue(readPrivateEnv(env).values[spec.name])) {
        writes[which] = 'kept';
        continue;
      }
      writeSecretLine(held, env, SECRET_WRITES, { name: spec.name, value, statusCommand: spec.statusCommand });
      writes[which] = 'saved';
    }
    writes.flag = voiceAgentKeysReady(readPrivateEnv(env).values);
    return { flag: writes.flag };
  } catch (failure) {
    if (failure instanceof Refusal) return { problem: failure.message };
    throw failure;
  }
}

/**
 * The outcome lines of step 2, after the lock: `dictation: on (Soniox key saved|kept)` or `off`, and, when the agent
 * question was asked or its key kept, `voice agent: on (OpenAI key saved|kept)` or `off`. A feature the user left off
 * (a plain "n", no key, a key refused) gets `<feature>: off; later: rarog … set-key` on the screen and in the log, and
 * the log names the app page that shows where the key comes from. Without a Soniox key the agent question is not
 * asked, and only the log says how to set the agent up later: the first setup's screen has no line to spare. A key
 * typed and saved goes to the log; on the screen it is the short `dictation: on` only where answered questions leave
 * the screen, because elsewhere the key prompt stands right above. Every other line goes to the screen too.
 * `created` = `config.json` was written in this run (otherwise a typed key was not saved, or was saved without its
 * config).
 */
export function reportVoice(ctx: Ctx, answers: VoiceAnswers, writes: VoiceWrites, created: boolean): void {
  report(ctx, SONIOX, answers.soniox, writes.soniox, true);
  if (answers.openai !== null) report(ctx, OPENAI, answers.openai, writes.openai, writes.flag && created);
  else if (answers.soniox.kind === 'off') {
    line(ctx, `${OPENAI.feature}: not asked, it needs dictation first; later: ${laterCommand(ctx, OPENAI)}`
      + ` (app: ${OPENAI.appPage})`);
  }
}

const laterCommand = (ctx: Ctx, spec: VoiceKeySpec): string => rarogCli(spec.setKeyCommand, ctx.mode);

function report(
  ctx: Ctx, spec: VoiceKeySpec, key: VoiceKey, wrote: 'saved' | 'kept' | 'none', on: boolean,
): void {
  if (key.kind === 'off') {
    const why = key.why === null ? '' : ` (${key.why})`;
    ctx.view.note(`${spec.feature}: off${why}; later: ${laterCommand(ctx, spec)}`);
    line(ctx, `the app's ${spec.appPage} shows where to get the ${spec.label} key`);
    return;
  }
  const done = key.kind === 'kept' || wrote === 'kept' ? 'kept' : wrote === 'saved' ? 'saved' : null;
  if (done === null) {
    ctx.view.note(`${spec.feature}: off (${spec.label} key not saved)`);
    return;
  }
  if (on && done === 'saved') {
    line(ctx, `${spec.feature}: on (${spec.label} key saved)`);
    ctx.view.answerNote(`${spec.feature}: on`);
  } else {
    ctx.view.note(on ? `${spec.feature}: on (${spec.label} key ${done})`
      : `${spec.feature}: off (${spec.label} key ${done}; config.json not created)`);
  }
}
