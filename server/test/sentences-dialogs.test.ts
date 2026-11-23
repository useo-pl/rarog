/**
 * Zdania dialogów, wysyłki odpowiedzi, drivera herdr i notek transkryptu: każde zdanie części powstaje
 * u źródła przez `say()`, a tekst, który wychodzi do apki, to angielski szablon rejestru z argumentami. Jeden
 * przypadek na kod. Zdania drivera jadą przez prawdziwy driver na atrapie klienta herdr, notki transkryptu przez
 * prawdziwego followera na pliku tymczasowym. Drogi kart (cyfra, notatka, formularz) w driverze sprawdza
 * `herdr-driver.test.ts` na `ref.code`.
 */
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENTENCES, isServerSentence } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode } from '@rarog/shared/sentences';
import {
  FORM_SUBMIT_GONE_MESSAGE, MULTI_SELECT_MESSAGE, NOTE_NOT_ALLOWED_MESSAGE, NOTE_NO_CHANNEL_MESSAGE,
  NOTE_WRITE_FAILED_MESSAGE, NO_ANSWER_ON_SCREEN_MESSAGE, NO_DIGIT_MESSAGE, PAUSE_ESCAPE_MESSAGE,
  SCREEN_CHANGED_MESSAGE, STALE_DECISION_MESSAGE, TERMINAL_DIALOG_MESSAGE, TERMINAL_ONLY_MESSAGE,
  formSubmitAbortMessage, hookAnswerPartialMessage, noteNotDeliveredMessage,
} from '../src/herdr/dialogs/copy.ts';
import { HerdrKeyNotAllowedError, assertAllowedKeys } from '../src/herdr/dialogs/send/keys.ts';
import { assertFormSubmitKeys } from '../src/herdr/dialogs/send/form-submit.ts';
import { NO_TRANSCRIPT_MESSAGE } from '../src/drivers/herdr/transcript.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import type { InternalBlock } from '../src/drivers/types.ts';
import { HerdrOutOfScopeError } from '../src/herdr/types.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { registryCatalog } from '../src/herdr/commands/catalog.ts';
import { projectSlug } from '../src/cli-store.ts';

vi.setConfig({ testTimeout: 20_000 });

const en = (code: SentenceCode): string => {
  const def = SENTENCES[code].en;
  if (typeof def !== 'string') throw new Error(`${code}: szablon z liczbą mnogą`);
  return def;
};

/** Zdanie z kodem: marka `say()`, kod, argumenty na drucie i angielski tekst. */
function expectSentence(value: AnyText | undefined, code: SentenceCode, args: string[] = [], text?: string): void {
  expect(isServerSentence(value), `${code}: źródło ma być zdaniem z say()`).toBe(true);
  if (value === undefined || !isServerSentence(value)) return;
  expect(value.ref.code).toBe(code);
  expect(value.ref.args ?? []).toEqual(args);
  expect(value.text).toBe(text ?? en(code));
}

describe('zdania: copy.ts dialogów (stałe)', () => {
  const cases: readonly [AnyText, SentenceCode][] = [
    [NO_DIGIT_MESSAGE, 'dialogs.no-digit'],
    [MULTI_SELECT_MESSAGE, 'dialogs.multi-select'],
    [NO_ANSWER_ON_SCREEN_MESSAGE, 'dialogs.no-answer-on-screen'],
    [TERMINAL_ONLY_MESSAGE, 'dialogs.terminal-only'],
    [TERMINAL_DIALOG_MESSAGE, 'dialogs.terminal-dialog'],
    [PAUSE_ESCAPE_MESSAGE, 'dialogs.pause-escape'],
    [STALE_DECISION_MESSAGE, 'dialogs.stale-decision'],
    [SCREEN_CHANGED_MESSAGE, 'dialogs.screen-changed'],
    [NOTE_NO_CHANNEL_MESSAGE, 'dialogs.note-no-channel'],
    [NOTE_NOT_ALLOWED_MESSAGE, 'dialogs.note-not-allowed'],
    [NOTE_WRITE_FAILED_MESSAGE, 'dialogs.note-write-failed'],
    [FORM_SUBMIT_GONE_MESSAGE, 'dialogs.form-submit-gone'],
  ];
  for (const [value, code] of cases) {
    it(`${code}: angielski szablon bez argumentów`, () => { expectSentence(value, code); });
  }
});

describe('zdania: copy.ts dialogów (z argumentami)', () => {
  it('dialogs.note-not-delivered: notatki złączone \\n, polski argument zostaje dosłownie', () => {
    const notes = ['pierwsza', '/tmp/zażółć'];
    expectSentence(noteNotDeliveredMessage(notes), 'dialogs.note-not-delivered', ['pierwsza\n/tmp/zażółć'],
      en('dialogs.note-not-delivered').replace('{notes}', 'pierwsza\n/tmp/zażółć'));
  });

  it('dialogs.hook-answer-partial: pytanie złożone z białych znaków i skrócone do 80 znaków', () => {
    expectSentence(hookAnswerPartialMessage('Który  plik\nzmienić?'), 'dialogs.hook-answer-partial',
      ['Który plik zmienić?'], en('dialogs.hook-answer-partial').replace('{question}', 'Który plik zmienić?'));
    const long = 'x'.repeat(100);
    const short = `${'x'.repeat(79)}…`;
    expectSentence(hookAnswerPartialMessage(long), 'dialogs.hook-answer-partial', [short],
      en('dialogs.hook-answer-partial').replace('{question}', short));
  });

  const abort = (sub: SentenceCode): string => en('dialogs.form-submit-abort').replace('{reason}', en(sub));
  const reasons = [
    ['notes-editing', 'dialogs.submit-abort.notes-editing'],
    ['question-changed', 'dialogs.submit-abort.question-changed'],
    ['not-a-form', 'dialogs.submit-abort.not-a-form'],
    ['no-single-highlight', 'dialogs.submit-abort.option-unconfirmed'],
    ['wrong-option', 'dialogs.submit-abort.option-unconfirmed'],
  ] as const;
  for (const [reason, sub] of reasons) {
    it(`dialogs.form-submit-abort: powód ${reason} → podkod ${sub}`, () => {
      expectSentence(formSubmitAbortMessage(reason), 'dialogs.form-submit-abort', [sub], abort(sub));
    });
  }
});

describe('zdania: klawisze wysyłki', () => {
  const sentenceOf = (fn: () => void): AnyText | undefined => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(HerdrKeyNotAllowedError);
      return (err as HerdrKeyNotAllowedError).sentence;
    }
    throw new Error('powinno rzucić');
  };

  it('dialogs.keys-empty: pusta lista klawiszy', () => {
    expectSentence(sentenceOf(() => { assertAllowedKeys([]); }), 'dialogs.keys-empty');
  });

  it('dialogs.key-not-allowed: klawisz spoza listy i lista dozwolonych jako tekst', () => {
    const value = sentenceOf(() => { assertAllowedKeys(['zażółć']); });
    expect(isServerSentence(value) ? value.ref.args?.[0] : undefined).toBe('zażółć');
    const allowed = isServerSentence(value) ? value.ref.args?.[1] ?? '' : '';
    expect(allowed).toContain('escape');
    expectSentence(value, 'dialogs.key-not-allowed', ['zażółć', allowed],
      en('dialogs.key-not-allowed').replace('{key}', 'zażółć').replace('{allowed}', allowed));
  });

  it('dialogs.form-submit-keys: zatwierdzenie formularza to wyłącznie enter', () => {
    expectSentence(sentenceOf(() => { assertFormSubmitKeys(['enter', 'enter']); }), 'dialogs.form-submit-keys');
  });
});

// ---------------------------------------------------------------------------
// Transkrypt: prawdziwy follower na pliku tymczasowym
// ---------------------------------------------------------------------------

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

let base = '';
const closers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-sentences-dialogs-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await rm(base, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const userLine = (text: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION, ...extra,
})}\n`;

/** Bloki `text` wiadomości systemowych (zdarzenia followera i drivera mają ten sam kształt). */
const systemBlocks = (events: readonly (FollowEvent | DriverEvent)[]): AnyText[] => events.flatMap((e) =>
  e.type === 'message' && e.role === 'system'
    ? e.blocks.flatMap((b: InternalBlock) => (b.type === 'text' ? [b.text] : []))
    : []);
const codes = (events: readonly (FollowEvent | DriverEvent)[]): string[] =>
  systemBlocks(events).map((t) => (isServerSentence(t) ? t.ref.code : `tekst: ${t.text}`));

describe('zdania: notki transkryptu (follower)', () => {
  const startFollower = async (content: string, maxReadBytes?: number): Promise<{
    file: string; events: FollowEvent[];
  }> => {
    const root = join(base, 'store');
    const dir = join(root, projectSlug(CWD));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${SESSION}.jsonl`);
    await writeFile(file, content);
    const follower: JsonlFollower = createJsonlFollower({
      cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING,
      ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    });
    closers.push(() => { follower.close(); });
    const events: FollowEvent[] = [];
    void (async () => { for await (const event of follower.events) events.push(event); })();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    return { file, events };
  };

  it('transcript.file-truncated: skrócenie pliku', async () => {
    const { file, events } = await startFollower(userLine('stare') + userLine('jeszcze starsze'));
    await writeFile(file, userLine('a'));
    await waitFor(() => systemBlocks(events).length > 0, 'notka o skróceniu');
    expect(codes(events)).toEqual(['transcript.file-truncated']);
    expectSentence(systemBlocks(events)[0], 'transcript.file-truncated');
  });

  it('transcript.gap: przyrost większy niż limit odczytu', async () => {
    const max = 2_000;
    const { file, events } = await startFollower(userLine('start'), max);
    await appendFile(file, userLine('x'.repeat(max * 2), { isMeta: true }) + userLine('dalej'));
    await waitFor(() => systemBlocks(events).length > 0, 'luka');
    expect(codes(events)).toContain('transcript.gap');
    expectSentence(systemBlocks(events).find((t) => isServerSentence(t) && t.ref.code === 'transcript.gap'),
      'transcript.gap');
  });

  it('transcript.no-transcript: zdanie drivera o braku pliku', () => {
    expectSentence(NO_TRANSCRIPT_MESSAGE, 'transcript.no-transcript');
  });
});

// ---------------------------------------------------------------------------
// Driver: atrapa klienta herdr
// ---------------------------------------------------------------------------

const PANE = 'w9-3';

class StubClient implements HerdrClient {
  promptError: unknown = null;
  escapeError: unknown = null;
  sendFormSubmit = (): Promise<void> => Promise.resolve();
  sendModeCycle = (): Promise<void> => Promise.resolve();
  pasteText = (): Promise<void> => Promise.resolve();
  sendPromptSubmit = (): Promise<void> => Promise.resolve();
  sendTrustStep = (): Promise<void> => Promise.resolve();
  sendDialogKey = (): Promise<void> => Promise.resolve();
  sendTakeBackKey = (): Promise<void> => Promise.resolve();
  getAgent = (): Promise<HerdrAgentInfo> => Promise.reject(new Error('agent.get poza testem'));
  listAgents(): Promise<never> { return Promise.reject(new Error('agent.list poza testem')); }
  readPaneHistory(): Promise<HerdrPaneHistory> { return Promise.resolve({ text: '', truncated: false }); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
  prompt(): Promise<void> {
    const error = this.promptError;
    this.promptError = null;
    return error === null ? Promise.resolve() : Promise.reject(error as Error);
  }
  sendKeys = (_paneId: string, keys: readonly string[]): Promise<void> =>
    (keys[0] === 'escape' && this.escapeError !== null ? Promise.reject(this.escapeError as Error) : Promise.resolve());
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
}

const stubPulse = (): SessionPulse => ({
  start: () => {}, stop: () => {}, repoint: () => {}, relocated: () => {}, close: () => {},
});

async function makeDriver(opts: { agent?: Partial<HerdrAgent>; deps?: Partial<HerdrDriverDeps> } = {}): Promise<{
  driver: SessionDriver; client: StubClient; events: DriverEvent[];
}> {
  const root = join(base, 'store');
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, projectSlug(cwd)), { recursive: true });
  await writeFile(join(root, projectSlug(cwd), `${SESSION}.jsonl`), '');
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true, ...opts.agent,
  };
  const handle: HerdrAgentHandle = { agent, subscribe: () => () => {} };
  const client = new StubClient();
  const deps: HerdrDriverDeps = {
    pulse: (_o: { onPulse: (sample: PulseSample) => void }) => stubPulse(),
    client,
    audit: { log: () => {} },
    yoloRoots: [],
    now: () => Date.UTC(2026, 7, 22, 12, 0, 0),
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    ...opts.deps,
  };
  const driver = createHerdrDriver(handle, deps);
  closers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) events.push(event); })();
  return { driver, client, events };
}

describe('zdania: driver herdr', () => {
  it('commands.send-refused z podkodem commands.command-mismatch: rozjazd klasyfikacji z managerem', async () => {
    const fx = await makeDriver({ deps: { guard: assertSendable } });
    fx.driver.send('/compact', undefined, undefined, { command: { catalog: registryCatalog(), slash: null } });
    await waitFor(() => systemBlocks(fx.events).length > 0, 'odmowa');
    // Powód jest własny, więc jedzie kodem: apka tłumaczy całe zdanie, łącznie z powodem.
    expectSentence(systemBlocks(fx.events)[0], 'commands.send-refused', ['commands.command-mismatch'],
      en('commands.send-refused').replace('{reason}', en('commands.command-mismatch')));
  });

  it('commands.send-failed: powód obcy (błąd zapisu załącznika) jedzie dosłownie', async () => {
    const fx = await makeDriver({
      deps: { uploads: { write: () => Promise.reject(new Error('EACCES /tmp/zażółć')), writeFiles: () => Promise.resolve([]) } as unknown as HerdrDriverDeps['uploads'] },
    });
    fx.driver.send('przejrzyj', ['data:image/png;base64,AAAA']);
    await waitFor(() => systemBlocks(fx.events).length > 0, 'odmowa');
    expectSentence(systemBlocks(fx.events)[0], 'commands.send-failed', ['EACCES /tmp/zażółć'],
      en('commands.send-failed').replace('{reason}', 'EACCES /tmp/zażółć'));
  });

  it('commands.panel-send-failed: nieznany błąd gniazda przy prompcie', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new Error('gniazdo padło');
    fx.driver.send('zwykła wiadomość');
    await waitFor(() => systemBlocks(fx.events).length > 0, 'błąd wysyłki');
    expectSentence(systemBlocks(fx.events)[0], 'commands.panel-send-failed', ['gniazdo padło'],
      en('commands.panel-send-failed').replace('{reason}', 'gniazdo padło'));
  });

  it('commands.interrupt-failed.mac: nieznany błąd przy Esc na Macu, kropka z wyjątku ucięta', async () => {
    const fx = await makeDriver({ deps: { system: 'macos' } });
    fx.client.escapeError = new Error('gniazdo padło.');
    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await waitFor(() => systemBlocks(fx.events).length > 0, 'błąd przerwania');
    expectSentence(systemBlocks(fx.events)[0], 'commands.interrupt-failed.mac', ['gniazdo padło'],
      en('commands.interrupt-failed.mac').replace('{reason}', 'gniazdo padło'));
  });

  it('commands.interrupt-failed.vps: ten sam błąd na serwerze Linux', async () => {
    const fx = await makeDriver({ deps: { system: 'linux' } });
    fx.client.escapeError = new Error('gniazdo padło');
    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await waitFor(() => systemBlocks(fx.events).length > 0, 'błąd przerwania');
    expectSentence(systemBlocks(fx.events)[0], 'commands.interrupt-failed.vps', ['gniazdo padło'],
      en('commands.interrupt-failed.vps').replace('{reason}', 'gniazdo padło'));
  });

  it('panel poza RAROG_HERDR_ROOTS: wyjątek niesie zdanie session.out-of-scope', async () => {
    const fx = await makeDriver({ agent: { inScope: false } });
    let thrown: unknown;
    try {
      fx.driver.send('nie wolno');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HerdrOutOfScopeError);
    expectSentence((thrown as HerdrOutOfScopeError).sentence, 'session.out-of-scope');
  });
});
