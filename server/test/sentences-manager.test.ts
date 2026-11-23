/**
 * Zdania managera sesji: odmowy REST managera, restart, dopiski stanu (`stateDetail`), notki systemowe,
 * stan launchera i klienta herdr mówią `say()`. Każdy przypadek sprawdza kod (`ref.code`), argumenty (`ref.args`)
 * i tekst równy angielskiemu szablonowi rejestru z podstawionymi argumentami. Szablon rozwija tu własna funkcja
 * {@link en}, nie `say()`, więc test nie porównuje `say()` samego ze sobą.
 *
 * Dwie części: tabela źródeł (stałe i funkcje zdań, po jednym wierszu na kod) i drogi produkcyjne (manager demo,
 * klient herdr na atrapie gniazda, ciało REST z `errorBodyOf`). Argument `text` nie jest tłumaczony: polska ścieżka
 * albo polski prompt zostają dosłownie.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SENTENCES, foreign, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode } from '@rarog/shared/sentences';
import { errorBodyOf } from '../src/router.ts';
import { BadRequestError, createManager } from '../src/sessions/manager.ts';
import {
  DRIVER_ERROR_DETAIL, DRIVER_GONE_DETAIL, HERDR_ALLOW_MESSAGE, HERDR_CODEX_CLOSE_MESSAGE, HERDR_CODEX_GIT_MESSAGE,
  HERDR_DOUBLE_WRITER_MESSAGE, HERDR_FOCUS_MESSAGE, HERDR_GONE_DETAIL, HERDR_HIDDEN_DETAIL,
  HERDR_LAUNCH_FAILED_DETAIL, HERDR_LAUNCH_OFF_MESSAGE, HERDR_LAUNCHING_DETAIL, HERDR_LOST_PROMPT_MESSAGE,
  HERDR_MODE_BYPASS_MESSAGE, HERDR_MODE_MESSAGE, HERDR_MODE_UNKNOWN_MESSAGE, HERDR_MODEL_MESSAGE,
  HERDR_NOT_OWNED_MESSAGE, HERDR_OUT_OF_SCOPE_DIFF_MESSAGE, HERDR_OUT_OF_SCOPE_MESSAGE, HERDR_READ_ONLY_MESSAGE,
  HERDR_TERMINAL_UNAVAILABLE_MESSAGE, HERDR_THROTTLED_MESSAGE, HERDR_TRUST_PROMPT_MESSAGE, INTERRUPT_DETAIL,
  MODE_BUSY_MESSAGE, MODEL_BUSY_MESSAGE, RESTART_BUSY_MESSAGE, RESTART_CODEX_MESSAGE,
  RESTART_COMPOSER_UNKNOWN_MESSAGE, RESTART_DONE_NOTE, RESTART_EXIT_ASKED_DETAIL, RESTART_EXIT_TIMEOUT_DETAIL,
  RESTART_EXIT_UNCONFIRMED_DETAIL, RESTART_FAILED_DETAIL, RESTART_IN_PROGRESS_MESSAGE, RESTART_MODE_UNKNOWN_MESSAGE,
  RESTART_NO_PANEL_MESSAGE, RESTART_NO_UPDATE_MESSAGE, RESTART_PANEL_CHANGED_MESSAGE, RESTART_RESEND_STALE_MESSAGE,
  RESTART_TASKS_MESSAGE, RESTART_UNSUPPORTED_MESSAGE, RESTART_UNVERIFIED_MESSAGE, RESTART_WAITING_AGENT_MESSAGE,
  RESTART_WRITERS_MESSAGE, RESUME_FOREIGN_CWD_MESSAGE, RESUME_NOT_FOUND_MESSAGE, RESUME_UNREADABLE_MESSAGE,
  RESUME_UNVERIFIABLE_MESSAGE, RESUME_WITHOUT_ULTRACODE_MESSAGE, ULTRACODE_CLI_UNKNOWN_MESSAGE,
  ULTRACODE_EFFORT_MESSAGE, cwdDeniedSentence, heldNotTakenText, heldUnconfirmedText, heldUnseenText,
  herdrDialogStandsMessage, launchThrottledMessage, restartComposerMessage, restartExitingDetail,
  restartLaunchingDetail, ultracodeCliTooOldMessage,
} from '../src/sessions/state-sentences.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { MAX_TURNS_DETAIL } from '../src/sessions/state-machine.ts';
import {
  createHerdrClient, createHerdrLaunchClient, parseAgentList, parsePaneList, parsePaneRows, parseWorkspaceList,
} from '../src/herdr/client.ts';
import { HerdrError } from '../src/herdr/types.ts';
import { ULTRACODE_MIN_CLI } from '../src/herdr/ultracode.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

type Args = Readonly<Record<string, string>>;

/** Angielski szablon rejestru z podstawionymi argumentami; argument `code` pokazuje `en` podkodu. */
function en(code: SentenceCode, args: Args = {}): string {
  const def = SENTENCES[code] as { en: string | { one: string; other: string }; args?: readonly string[] };
  const specs = (def.args ?? []).map((spec) => spec.split(':') as [string, string]);
  const plural = specs.find(([, kind]) => kind === 'plural')?.[0];
  const template = typeof def.en === 'string' ? def.en : (args[plural ?? ''] === '1' ? def.en.one : def.en.other);
  return template.replace(/\{([a-zA-Z0-9]+)\}/gu, (_m, name: string) => {
    const kind = specs.find(([n]) => n === name)?.[1];
    const value = args[name] ?? '';
    return kind === 'code' ? en(value as SentenceCode) : value;
  });
}

/** Zdanie z kodem: marka `say()`, kod, argumenty w kolejności rejestru i angielski tekst z rejestru. */
function expectSentence(value: AnyText | undefined, code: SentenceCode, args: Args = {}): void {
  expect(isServerSentence(value), `${code}: źródło ma być zdaniem z say()`).toBe(true);
  if (value === undefined || !isServerSentence(value)) return;
  const values = Object.values(args);
  expect(value.ref).toEqual(values.length === 0 ? { code } : { code, args: values });
  expect(value.text).toBe(en(code, args));
}

/** Zdanie wyjątku (pole `sentence` klas błędów managera i herdr). */
function sentenceOf(run: () => unknown): AnyText | undefined {
  try {
    run();
  } catch (err) {
    return (err as { sentence?: AnyText }).sentence;
  }
  return undefined;
}

async function rejection(promise: Promise<unknown>): Promise<{ sentence?: AnyText }> {
  try {
    await promise;
  } catch (err) {
    return err as { sentence?: AnyText };
  }
  throw new Error('oczekiwany wyjątek');
}

const MIN = ULTRACODE_MIN_CLI;

/** Źródła zdań: wartość u źródła → kod → argumenty (nazwa → wartość na drucie). */
const SOURCES: ReadonlyArray<readonly [string, () => AnyText | undefined, SentenceCode, Args?]> = [
  ['INTERRUPT_DETAIL', () => INTERRUPT_DETAIL, 'state.interrupted'],
  ['DRIVER_ERROR_DETAIL', () => DRIVER_ERROR_DETAIL, 'state.driver-error'],
  ['DRIVER_GONE_DETAIL', () => DRIVER_GONE_DETAIL, 'state.driver-gone'],
  ['HERDR_LAUNCHING_DETAIL', () => HERDR_LAUNCHING_DETAIL, 'state.herdr-launching'],
  ['HERDR_LAUNCH_FAILED_DETAIL', () => HERDR_LAUNCH_FAILED_DETAIL, 'state.herdr-launch-failed'],
  ['HERDR_GONE_DETAIL', () => HERDR_GONE_DETAIL, 'state.herdr-gone'],
  ['HERDR_HIDDEN_DETAIL', () => HERDR_HIDDEN_DETAIL, 'state.herdr-hidden'],
  ['MAX_TURNS_DETAIL', () => MAX_TURNS_DETAIL, 'state.max-turns'],
  ['RESTART_CODEX_MESSAGE', () => RESTART_CODEX_MESSAGE, 'restart.codex'],
  ['RESTART_IN_PROGRESS_MESSAGE', () => RESTART_IN_PROGRESS_MESSAGE, 'restart.in-progress'],
  ['RESTART_NO_PANEL_MESSAGE', () => RESTART_NO_PANEL_MESSAGE, 'restart.no-panel'],
  ['RESTART_UNSUPPORTED_MESSAGE', () => RESTART_UNSUPPORTED_MESSAGE, 'restart.unsupported'],
  ['RESTART_NO_UPDATE_MESSAGE', () => RESTART_NO_UPDATE_MESSAGE, 'restart.no-update'],
  ['RESTART_BUSY_MESSAGE', () => RESTART_BUSY_MESSAGE, 'restart.busy'],
  ['RESTART_TASKS_MESSAGE', () => RESTART_TASKS_MESSAGE, 'restart.background-task-running'],
  ['RESTART_WAITING_AGENT_MESSAGE', () => RESTART_WAITING_AGENT_MESSAGE, 'restart.waiting-agent'],
  ['restartComposerMessage(macos)', () => restartComposerMessage('macos'), 'restart.unsent-prompt.mac'],
  ['restartComposerMessage(linux)', () => restartComposerMessage('linux'), 'restart.unsent-prompt.vps'],
  ['RESTART_COMPOSER_UNKNOWN_MESSAGE', () => RESTART_COMPOSER_UNKNOWN_MESSAGE, 'restart.composer-unknown'],
  ['RESTART_MODE_UNKNOWN_MESSAGE', () => RESTART_MODE_UNKNOWN_MESSAGE, 'restart.mode-unknown'],
  ['RESTART_PANEL_CHANGED_MESSAGE', () => RESTART_PANEL_CHANGED_MESSAGE, 'restart.panel-changed'],
  ['RESTART_WRITERS_MESSAGE', () => RESTART_WRITERS_MESSAGE, 'restart.multiple-writers'],
  ['RESTART_UNVERIFIED_MESSAGE', () => RESTART_UNVERIFIED_MESSAGE, 'restart.single-writer-unverified'],
  ['RESTART_RESEND_STALE_MESSAGE', () => RESTART_RESEND_STALE_MESSAGE, 'restart.resend-stale'],
  ['restartExitingDetail()', () => restartExitingDetail(), 'restart.exiting'],
  ['restartExitingDetail(v)', () => restartExitingDetail('2.1.280'), 'restart.exiting.version', { version: '2.1.280' }],
  ['restartLaunchingDetail()', () => restartLaunchingDetail(), 'restart.launching'],
  ['restartLaunchingDetail(v)', () => restartLaunchingDetail('2.1.283'), 'restart.launching.version',
    { version: '2.1.283' }],
  ['RESTART_DONE_NOTE', () => RESTART_DONE_NOTE, 'restart.done'],
  ['RESTART_EXIT_ASKED_DETAIL', () => RESTART_EXIT_ASKED_DETAIL, 'restart.exit-asked'],
  ['RESTART_EXIT_TIMEOUT_DETAIL', () => RESTART_EXIT_TIMEOUT_DETAIL, 'restart.exit-timeout'],
  ['RESTART_EXIT_UNCONFIRMED_DETAIL', () => RESTART_EXIT_UNCONFIRMED_DETAIL, 'restart.exit-unconfirmed'],
  ['RESTART_FAILED_DETAIL', () => RESTART_FAILED_DETAIL, 'restart.failed'],
  ['HERDR_MODEL_MESSAGE', () => HERDR_MODEL_MESSAGE, 'model.herdr-set-at-start'],
  ['MODEL_BUSY_MESSAGE', () => MODEL_BUSY_MESSAGE, 'model.busy'],
  ['ULTRACODE_CLI_UNKNOWN_MESSAGE', () => ULTRACODE_CLI_UNKNOWN_MESSAGE, 'model.ultracode-cli-unknown',
    { minVersion: MIN }],
  ['ultracodeCliTooOldMessage', () => ultracodeCliTooOldMessage('2.1.200'), 'model.ultracode-cli-too-old',
    { version: '2.1.200', minVersion: MIN }],
  ['ULTRACODE_EFFORT_MESSAGE', () => ULTRACODE_EFFORT_MESSAGE, 'model.ultracode-effort'],
  ['RESUME_WITHOUT_ULTRACODE_MESSAGE', () => RESUME_WITHOUT_ULTRACODE_MESSAGE, 'model.resume-without-ultracode',
    { minVersion: MIN }],
  ['HERDR_MODE_MESSAGE', () => HERDR_MODE_MESSAGE, 'session.mode-no-channel'],
  ['HERDR_MODE_BYPASS_MESSAGE', () => HERDR_MODE_BYPASS_MESSAGE, 'session.mode-bypass'],
  ['MODE_BUSY_MESSAGE', () => MODE_BUSY_MESSAGE, 'session.mode-busy'],
  ['HERDR_FOCUS_MESSAGE', () => HERDR_FOCUS_MESSAGE, 'session.focus-no-panel'],
  ['HERDR_TRUST_PROMPT_MESSAGE', () => HERDR_TRUST_PROMPT_MESSAGE, 'session.trust-prompt'],
  ['HERDR_DOUBLE_WRITER_MESSAGE', () => HERDR_DOUBLE_WRITER_MESSAGE, 'session.double-writer'],
  ['HERDR_ALLOW_MESSAGE', () => HERDR_ALLOW_MESSAGE, 'session.dialog-unrecognized'],
  ['HERDR_LAUNCH_OFF_MESSAGE', () => HERDR_LAUNCH_OFF_MESSAGE, 'session.launch-off'],
  ['HERDR_LOST_PROMPT_MESSAGE', () => HERDR_LOST_PROMPT_MESSAGE, 'session.prompt-lost'],
  ['launchThrottledMessage(macos)', () => launchThrottledMessage('macos'), 'session.launch-throttled.mac'],
  ['launchThrottledMessage(linux)', () => launchThrottledMessage('linux'), 'session.launch-throttled.vps'],
  ['HERDR_TERMINAL_UNAVAILABLE_MESSAGE', () => HERDR_TERMINAL_UNAVAILABLE_MESSAGE, 'session.herdr-unavailable'],
  ['RESUME_NOT_FOUND_MESSAGE', () => RESUME_NOT_FOUND_MESSAGE, 'session.resume-not-found'],
  ['RESUME_FOREIGN_CWD_MESSAGE', () => RESUME_FOREIGN_CWD_MESSAGE, 'session.resume-foreign-cwd'],
  ['RESUME_UNREADABLE_MESSAGE', () => RESUME_UNREADABLE_MESSAGE, 'session.resume-unreadable'],
  ['RESUME_UNVERIFIABLE_MESSAGE', () => RESUME_UNVERIFIABLE_MESSAGE, 'session.resume-unverifiable'],
  ['HERDR_NOT_OWNED_MESSAGE', () => HERDR_NOT_OWNED_MESSAGE, 'session.close-not-owned'],
  ['HERDR_CODEX_CLOSE_MESSAGE', () => HERDR_CODEX_CLOSE_MESSAGE, 'session.codex-close'],
  ['HERDR_CODEX_GIT_MESSAGE', () => HERDR_CODEX_GIT_MESSAGE, 'session.codex-git'],
  ['HERDR_MODE_UNKNOWN_MESSAGE', () => HERDR_MODE_UNKNOWN_MESSAGE, 'session.mode-footer-unknown'],
  ['dialog-stands: permission', () => herdrDialogStandsMessage('permission'), 'session.dialog-stands',
    { dialog: 'session.cli-dialog.permission' }],
  ['dialog-stands: input', () => herdrDialogStandsMessage('input'), 'session.dialog-stands',
    { dialog: 'session.cli-dialog.input' }],
  ['dialog-stands: sandbox', () => herdrDialogStandsMessage('sandbox'), 'session.dialog-stands',
    { dialog: 'session.cli-dialog.sandbox' }],
  ['dialog-stands: dialog', () => herdrDialogStandsMessage('dialog'), 'session.dialog-stands',
    { dialog: 'session.cli-dialog.open' }],
  ['dialog-stands: other', () => herdrDialogStandsMessage('other'), 'session.dialog-stands',
    { dialog: 'session.cli-dialog.other' }],
  ['HERDR_OUT_OF_SCOPE_MESSAGE', () => HERDR_OUT_OF_SCOPE_MESSAGE, 'session.out-of-scope'],
  ['HERDR_OUT_OF_SCOPE_DIFF_MESSAGE', () => HERDR_OUT_OF_SCOPE_DIFF_MESSAGE, 'session.out-of-scope-diff'],
  ['HERDR_READ_ONLY_MESSAGE', () => HERDR_READ_ONLY_MESSAGE, 'session.herdr-read-only'],
  ['HERDR_THROTTLED_MESSAGE', () => HERDR_THROTTLED_MESSAGE, 'session.send-throttled'],
  ['heldNotTakenText(macos)', () => heldNotTakenText('popraw /tmp/zażółć', 'macos'), 'session.prompt-not-taken.mac',
    { prompt: 'popraw /tmp/zażółć' }],
  ['heldNotTakenText(linux)', () => heldNotTakenText('popraw /tmp/zażółć', 'linux'), 'session.prompt-not-taken.vps',
    { prompt: 'popraw /tmp/zażółć' }],
  ['heldUnconfirmedText(macos)', () => heldUnconfirmedText('długi prompt', 'macos'),
    'session.prompt-unconfirmed.mac', { prompt: 'długi prompt' }],
  ['heldUnconfirmedText(other)', () => heldUnconfirmedText('długi prompt', 'other'),
    'session.prompt-unconfirmed.vps', { prompt: 'długi prompt' }],
  ['heldUnseenText', () => heldUnseenText('zgubiony w dialogu'), 'session.prompt-unseen',
    { prompt: 'zgubiony w dialogu' }],
  ['cwd-denied: powód bez argumentów', () => cwdDeniedSentence('/tmp/zażółć', say('rest.cwd-hidden')),
    'session.cwd-denied', { cwd: '/tmp/zażółć', reason: 'rest.cwd-hidden' }],
  ['cwd-denied: lista korzeni', () => cwdDeniedSentence('/etc', say('rest.cwd-outside-roots.listed', { roots: '/a, /b' })),
    'session.cwd-denied.outside-roots', { cwd: '/etc', roots: '/a, /b' }],
];

describe('zdania u źródeł (stałe i funkcje managera)', () => {
  for (const [label, value, code, args] of SOURCES) {
    it(label, () => { expectSentence(value(), code, args); });
  }

  // Zmiana modelu zachodzi tylko w trybie herdr (manager demo odmawia wcześniej): drogę produkcyjną obu odmów
  // sprawdza `manager-model-focus.test.ts`; tu kod, argument i szablon.
  it('odmowy zmiany modelu: `model.change-empty` i `model.not-in-list`', () => {
    expectSentence(say('model.change-empty'), 'model.change-empty');
    expectSentence(say('model.not-in-list', { model: 'gpt-9' }), 'model.not-in-list', { model: 'gpt-9' });
  });

  it('powód katalogu bez kodu przechodzi sam, bez ścieżki (zapas na zdanie spoza rejestru)', () => {
    const reason = say('rest.cwd-not-found');
    expect(cwdDeniedSentence('/x', foreign('obce') as never)).toEqual(foreign('obce'));
    expectSentence(cwdDeniedSentence('/x', reason), 'session.cwd-denied', { cwd: '/x', reason: 'rest.cwd-not-found' });
  });

  it('cytat promptu w notce: białe znaki zbite, najwyżej 60 znaków i wielokropek; polski tekst bez zmian', () => {
    const note = heldNotTakenText(`zażółć\n\tgęślą ${'jaźń '.repeat(20)}`, 'macos');
    expect(note.ref.code).toBe('session.prompt-not-taken.mac');
    const quoted = note.ref.args?.[0] ?? '';
    expect(quoted.startsWith('zażółć gęślą jaźń')).toBe(true);
    expect(quoted.endsWith('…')).toBe(true);
    expect(Array.from(quoted).length).toBeLessThanOrEqual(61);
  });
});

describe('zdania: klient herdr (odpowiedzi w nieznanym kształcie, puste adresy, etykiety)', () => {
  /** Atrapa gniazda: każda metoda oddaje `result`. */
  const requester = (result: unknown = {}): { request: () => Promise<unknown> } => ({
    request: () => Promise.resolve(result),
  });

  it('listy bez listy: workspace.list, pane.list, agent.list', () => {
    expectSentence(sentenceOf(() => parseWorkspaceList({})), 'herdr.response-no-workspaces');
    expectSentence(sentenceOf(() => parsePaneList({})), 'herdr.response-no-panes');
    expectSentence(sentenceOf(() => parsePaneRows({}, 'w1:p1')), 'herdr.response-no-panes');
    expectSentence(sentenceOf(() => parseAgentList({})), 'herdr.response-no-agents');
  });

  it('pane.list bez wierszy panelu: identyfikator panelu w argumencie `text`', () => {
    expectSentence(sentenceOf(() => parsePaneRows({ panes: [] }, 'w1:p9')), 'herdr.response-no-pane-rows',
      { pane: 'w1:p9' });
  });

  it('odpowiedź w nieznanym kształcie nazywa metodę; odpowiedź startu bez identyfikatorów', async () => {
    const client = createHerdrClient(requester());
    expectSentence((await rejection(client.readScreen('w1:p1', 'visible'))).sentence, 'herdr.response-bad-shape',
      { method: 'agent.read' });
    expectSentence((await rejection(client.ping())).sentence, 'herdr.response-bad-shape', { method: 'ping' });
    const launch = createHerdrLaunchClient(requester());
    expectSentence((await rejection(launch.getTab('w1:t1'))).sentence, 'herdr.response-bad-shape',
      { method: 'tab.get' });
    expectSentence((await rejection(launch.createTab({ cwd: '/tmp' } as never))).sentence,
      'herdr.response-no-ids', { method: 'tab.create' });
  });

  it('odpowiedź startu z obiektami taba i panelu w nieznanym kształcie', async () => {
    const launch = createHerdrLaunchClient(requester({ tab: {}, pane: {} }));
    expectSentence((await rejection(launch.createTab({ cwd: '/tmp' } as never))).sentence,
      'herdr.response-bad-shape', { method: 'tab.create' });
  });

  it('pusty adres panelu i taba nie dotyka gniazda', async () => {
    const launch = createHerdrLaunchClient(requester());
    expectSentence((await rejection(launch.readPaneProcess(''))).sentence, 'herdr.pane-id-missing',
      { method: 'pane.process_info' });
    expectSentence((await rejection(launch.closePane(''))).sentence, 'herdr.pane-id-missing', { method: 'pane.close' });
    expectSentence((await rejection(launch.closeTab(''))).sentence, 'herdr.tab-id-missing', { method: 'tab.close' });
    expectSentence((await rejection(launch.renameTab('', 'x'))).sentence, 'herdr.tab-id-missing',
      { method: 'tab.rename' });
  });

  it('etykieta pusta albo ze znakiem sterującym', async () => {
    const launch = createHerdrLaunchClient(requester());
    expectSentence((await rejection(launch.renamePane('w1:p1', '  '))).sentence, 'herdr.label-empty',
      { method: 'pane.rename' });
    expectSentence((await rejection(launch.renameTab('w1:t1', 'a\u001bb'))).sentence, 'herdr.label-control-char',
      { method: 'tab.rename' });
  });

  it('agent, którego już nie ma: klucz panelu w argumencie', async () => {
    const client = createHerdrClient(requester({ agent: null }));
    const gone = await rejection(client.getAgent('w1:p3'));
    expect(gone).toBeInstanceOf(HerdrError);
    expectSentence(gone.sentence, 'herdr.agent-gone', { key: 'w1:p3' });
  });
});

describe('zdania: drogi produkcyjne managera (demo) i ciało REST', () => {
  const managers: Manager[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function demo(): Promise<Manager> {
    const dataDir = mkdtempSync(join(tmpdir(), 'rarog-zdania-manager-'));
    dirs.push(dataDir);
    const manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir, system: 'linux' });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  it('nieznana sesja → 404 ze zdaniem ogólnym `rest.session-not-found`', async () => {
    const manager = await demo();
    const err = await rejection(manager.focus('nie-ma'));
    expectSentence(err.sentence, 'rest.session-not-found');
  });

  it('katalog spoza allow-listy demo → 400 `session.cwd-outside-allow-list`, polska ścieżka dosłownie', async () => {
    const manager = await demo();
    const err = await rejection(manager.create({ cwd: '/tmp/zażółć', prompt: 'x' }));
    expect(err).toBeInstanceOf(BadRequestError);
    expectSentence(err.sentence, 'session.cwd-outside-allow-list', { cwd: '/tmp/zażółć' });
    expect(errorBodyOf(400, err, 'message')).toEqual({
      error: 'bad-request', message: en('session.cwd-outside-allow-list', { cwd: '/tmp/zażółć' }),
      messageRef: { code: 'session.cwd-outside-allow-list', args: ['/tmp/zażółć'] },
    });
  });

  it('bypassPermissions poza RAROG_YOLO_ROOTS → 400 `session.bypass-outside-yolo-roots`', async () => {
    const manager = await demo();
    const cwd = manager.projects()[0]?.path ?? '';
    const err = await rejection(manager.create({ cwd, prompt: 'x', permissionMode: 'bypassPermissions' }));
    expectSentence(err.sentence, 'session.bypass-outside-yolo-roots');
  });

  it('wysyłka do sesji poza stanem wysyłki → 409 `session.not-accepting-messages` ze stanem z drutu', async () => {
    const manager = await demo();
    const done = manager.list().find((s) => s.state === 'done');
    expect(done).toBeDefined();
    const err = await rejection(Promise.resolve().then(() => manager.sendMessage(done?.id ?? '', 'hej')));
    expectSentence(err.sentence, 'session.not-accepting-messages', { id: done?.id ?? '', state: 'done' });
    expect(errorBodyOf(409, err, 'message').messageRef).toEqual({
      code: 'session.not-accepting-messages', args: [done?.id ?? '', 'done'],
    });
  });

});

// Warianty z argumentami, których droga produkcyjna stoi w innych testach (launcher: `herdr-launcher.test.ts`,
// restart: `session-restart.test.ts`, odpowiedzi na pytanie: `manager.test.ts`): tu kod, kolejność
// argumentów i szablon.
const VARIANTS: ReadonlyArray<readonly [SentenceCode, Args?]> = [
  ['state.herdr-launch-failed.reason', { reason: 'socket closed' }],
  ['state.driver-error.reason', { reason: 'EPIPE' }],
  ['restart.failed.reason', { reason: 'socket closed' }],
  ['restart.failed.panel-gone'],
  ['restart.done.version', { version: '2.1.283' }],
  ['restart.update-not-applied', { version: '2.1.280' }],
  ['restart.update-version-unverified', { version: '2.1.283' }],
  ['session.no-longer-accepting', { id: 'demo-atlas' }],
  ['session.answer-multi-select'],
  ['session.answer-too-long', { max: '4000' }],
  ['session.answer-own-text'],
  ['herdr.agent-name-failed'],
  ['herdr.agent-vanished'],
  ['herdr.agent-vanished.screen', { screen: 'zsh: command not found' }],
  ['herdr.launch-timeout', { seconds: '60' }],
  ['herdr.launch-timeout.screen', { seconds: '60', screen: 'Loading plugins' }],
  ['herdr.session-id-mismatch'],
];

describe('zdania: warianty z argumentami', () => {
  for (const [code, args = {}] of VARIANTS) {
    it(code, () => {
      const values = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, /^\d+$/u.test(v) ? Number(v) : v]));
      expectSentence(say(code, values as never), code, args);
    });
  }
});
