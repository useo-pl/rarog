/**
 * Notki harnessu w transkrypcie: pole `TranscriptMessage.notice` z serwera.
 *
 * Reguły, których pilnuje ten plik:
 * - klasyfikacja po POCHODZENIU wpisu jsonl (`origin.kind === 'task-notification'`), nie po
 *   tekście — prompt człowieka ze znacznikiem w treści notką nie jest;
 * - ścieżka na żywo (follower, linia po linii) i historia (`parseTranscriptTail`) dają ten sam
 *   wynik, a `role` i `blocks` zostają zwykłe (stara PWA rozpoznaje notkę po swojemu);
 * - szczegóły z treści; brak `outcome` NIE znaczy sukcesu;
 * - reguła roli efektywnej po stronie serwera: notka nie uczestniczy w echu wysyłki i nie
 *   dostaje zdjęć Raroga z wpisu-towarzysza.
 * - postój subagenta: `completed` z dopiskiem o własnej pracy agenta w tle to
 *   wynik `waiting`, nie `done` — i wyłącznie dla notki rodzaju `agent`. Notka i lista zadań
 *   pytają o postój ten sam parser, więc treść jednego meldunku czytają tak samo.
 * Degradacje (`notice.kind` → `unknown`, `notice.outcome` → brak), `null` i zły typ sprawdzają
 * `shared/test/decode.test.ts` i złote ramki `message.*notice*`.
 */
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrStatus, TranscriptNotice } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps } from '../src/sessions/manager.ts';
import { parseImportLine as parseLine, parseTranscriptTail as parseTail } from '../src/transcript-import.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { wireEntry, wireMessages } from './helpers/bloki-drutu.ts';

/** Import w widoku drutu: bloki po serializacji sesji, czyli tak, jak zobaczy je apka. */
const parseImportLine = (...args: Parameters<typeof parseLine>) => wireEntry(parseLine(...args));
const parseTranscriptTail = (...args: Parameters<typeof parseTail>) => wireMessages(parseTail(...args));
import { NOTICE_NAME_MAX, isTaskNotificationOrigin, noticeFromText } from '../src/herdr/background/notice.ts';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';

vi.setConfig({ testTimeout: 20_000 });

/** Treść notki w kształcie CLI 2.1.x. */
function notification(status: string | null, summary: string): string {
  return [
    '<task-notification>', '<task-id>bash_1</task-id>',
    ...(status === null ? [] : [`<status>${status}</status>`]),
    `<summary>${summary}</summary>`, '</task-notification>',
    'Read the output file to retrieve the result.',
  ].join('\n');
}

const ORIGIN = { kind: 'task-notification', producer: 'session-task' };
const FAILED = notification('failed', 'Background command "pnpm test" failed with exit code 2');

function line(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user', timestamp: '2026-10-04T10:00:00.000Z', message: { role: 'user', content }, ...extra,
  });
}

// ---------------------------------------------------------------------------
// Klasyfikacja
// ---------------------------------------------------------------------------

describe('fakty z treści notki (te same reguły co PWA)', () => {
  it.each([
    ['Background command "pnpm test" completed (exit code 0)', 'command'],
    ['Agent "Przegląd" completed', 'agent'],
    ['Background agent "sierota" was stopped', 'agent'],
    ['Dynamic workflow "kontrakt" completed', 'workflow'],
    ['Background workflow "kontrakt" failed', 'workflow'],
    ['Monitor event: "tick"', 'monitor-event'],
    ['Monitor "Log serwera" stopped', 'monitor-end'],
    ['No completion record was found for background workflow "x"', 'orphan'],
    ['3 background shell command task(s) were running', 'orphan'],
    ['Coś zupełnie nowego', 'unknown'],
  ] as const)('%s → %s', (summary, kind) => {
    expect(noticeFromText(notification('completed', summary)).kind).toBe(kind);
  });

  it('wynik wyłącznie ze statusu; sierota i brak statusu = brak wyniku (nie sukces)', () => {
    const outcome = (status: string | null, summary = 'Background command "x" ended'): unknown =>
      noticeFromText(notification(status, summary)).outcome;
    expect(outcome('completed')).toBe('done');
    expect(outcome('failed')).toBe('failed');
    expect(outcome('killed', 'Background command "x" was stopped')).toBe('halted');
    expect(outcome('stopped')).toBe('halted');
    expect(outcome('running')).toBeUndefined();
    expect(outcome(null, 'Monitor event: "tick"')).toBeUndefined();
    expect(outcome('stopped', 'No completion record was found for background workflow "x"')).toBeUndefined();
  });

  it('nazwa z cudzysłowu (także po podwójnym kodowaniu) z sufitem; kod wyjścia tylko z pliku', () => {
    expect(noticeFromText(FAILED)).toStrictEqual({
      kind: 'command', outcome: 'failed', name: 'pnpm test', exitCode: 2,
    });
    expect(noticeFromText(notification('completed', 'Agent \\"Przegląd\\" completed')).name)
      .toBe('Przegląd');
    const long = 'x'.repeat(NOTICE_NAME_MAX + 5);
    const clipped = noticeFromText(notification('completed', `Agent "${long}" completed`)).name ?? '';
    expect([...clipped]).toHaveLength(NOTICE_NAME_MAX);
    expect(clipped.endsWith('…')).toBe(true);
    // Emoji na granicy sufitu: cięcie po punktach kodowych, bez samotnej połówki pary zastępczej.
    const emoji = `${'a'.repeat(NOTICE_NAME_MAX - 2)}🚀🚀`;
    const cut = noticeFromText(notification('completed', `Agent "${emoji}x" completed`)).name ?? '';
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
    expect([...cut]).toHaveLength(NOTICE_NAME_MAX);
    expect(JSON.parse(JSON.stringify({ cut })).cut).toBe(cut);
    // Kod wyjścia z meldunku, nie z nazwy zadania; bez kodu w meldunku pola nie ma.
    const quotedCode = 'Background command "check exit code 2" completed (exit code 0)';
    expect(noticeFromText(notification('completed', quotedCode)).exitCode).toBe(0);
    expect(noticeFromText(notification('completed', 'Background command "exit code 7" completed')).exitCode)
      .toBeUndefined();
    // Bez streszczenia: forma ogólna, nigdy wyjątek ani pusty obiekt bez rodzaju.
    expect(noticeFromText('<task-notification></task-notification>')).toStrictEqual({ kind: 'unknown' });
  });

  it('pochodzenie: wyłącznie `origin.kind === "task-notification"`', () => {
    expect(isTaskNotificationOrigin(ORIGIN)).toBe(true);
    expect(isTaskNotificationOrigin({ kind: 'task-notification' })).toBe(true);
    for (const other of [undefined, null, 'task-notification', { kind: 'human' }, { kind: 'peer' }, []]) {
      expect(isTaskNotificationOrigin(other)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Postój subagenta
// ---------------------------------------------------------------------------

/** Dopisek o POSTOJU, znak w znak z `fixtures/herdr/tasks/measured/postoj.jsonl` (CLI 2.1.296). */
const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its '
  + 'own when that work completes or reports, and the same task-id notifies again if it does; the result '
  + 'below may be interim.';
/** Dopisek o KOŃCU, z tych samych fixture'ów. */
const ENDED_NOTE = 'A task-notification fires each time this agent stops with no live background children of '
  + 'its own. The user can send it another message and resume it, so the same task-id may notify more than once.';

/** Meldunek z dopiskiem `<note>` w kształcie CLI 2.1.296: dopisek stoi przed wynikiem. */
function noted(status: string, summary: string, note?: string, id = 'a52b91f105b002e8d'): string {
  return [
    '<task-notification>', `<task-id>${id}</task-id>`, `<status>${status}</status>`,
    `<summary>${summary}</summary>`, ...(note === undefined ? [] : [`<note>${note}</note>`]),
    '<result>raport agenta</result>', '<usage><subagent_tokens>1</subagent_tokens></usage>',
    '</task-notification>',
  ].join('\n');
}

describe('notka o postoju subagenta', () => {
  const AGENT_DONE = 'Agent "Przegląd" finished';

  /**
   * TEST OBOWIĄZKOWY: postój nie może dać notki „Subagent skończył" o agencie, który pracuje
   * dalej. Postój i koniec mają ten sam status; różni je dopisek.
   */
  it('postój → `waiting`, koniec → `done`; nazwa zostaje, kodu wyjścia nie ma', () => {
    expect(noticeFromText(noted('completed', AGENT_DONE, STANDBY_NOTE)))
      .toStrictEqual({ kind: 'agent', outcome: 'waiting', name: 'Przegląd' });
    expect(noticeFromText(noted('completed', AGENT_DONE, ENDED_NOTE)))
      .toStrictEqual({ kind: 'agent', outcome: 'done', name: 'Przegląd' });
    // Starsze CLI: meldunek agenta bez dopisku to zwykły koniec.
    expect(noticeFromText(noted('completed', AGENT_DONE)).outcome).toBe('done');
  });

  it('`waiting` dostaje WYŁĄCZNIE notka rodzaju `agent`', () => {
    // Streszczenie, którego rodzaju nie znamy: dopisek o postoju nie robi z niego postoju subagenta.
    expect(noticeFromText(noted('completed', 'Coś zupełnie nowego "Przegląd" finished', STANDBY_NOTE)))
      .toStrictEqual({ kind: 'unknown', outcome: 'done', name: 'Przegląd' });
    expect(noticeFromText(noted('completed', 'Background command "pnpm test" completed (exit code 0)', STANDBY_NOTE)))
      .toStrictEqual({ kind: 'command', outcome: 'done', name: 'pnpm test', exitCode: 0 });
    expect(noticeFromText(noted('completed', 'Dynamic workflow "kontrakt" completed', STANDBY_NOTE)).outcome).toBe('done');
    // Sierota dalej nie ma wyniku wcale.
    expect(noticeFromText(noted('stopped', 'No completion record was found for background agent "x"', STANDBY_NOTE)))
      .not.toHaveProperty('outcome');
  });

  it('postój wymaga statusu `completed`; każdy inny status mówi swoje mimo dopisku', () => {
    expect(noticeFromText(noted('failed', 'Agent "Przegląd" failed', STANDBY_NOTE)).outcome).toBe('failed');
    expect(noticeFromText(noted('killed', 'Agent "Przegląd" was stopped by Claude', STANDBY_NOTE)).outcome).toBe('halted');
    expect(noticeFromText(noted('stopped', AGENT_DONE, STANDBY_NOTE)).outcome).toBe('halted');
    expect(noticeFromText(noted('running', AGENT_DONE, STANDBY_NOTE))).not.toHaveProperty('outcome');
  });

  it('dopisek o innym brzmieniu, obie frazy naraz i `<note>` w samym wyniku to `done`', () => {
    expect(noticeFromText(noted('completed', AGENT_DONE, 'This agent paused while a child task is pending.')).outcome)
      .toBe('done');
    expect(noticeFromText(noted('completed', AGENT_DONE, `${STANDBY_NOTE} ${ENDED_NOTE}`)).outcome).toBe('done');
    const quoted = noted('completed', AGENT_DONE).replace('raport agenta', `cytat: <note>${STANDBY_NOTE}</note>`);
    expect(noticeFromText(quoted).outcome).toBe('done');
  });

  it('znacznik w nazwie agenta nie zasłania dopisku o postoju ani go nie podmienia', () => {
    expect(noticeFromText(noted('completed', 'Agent "Analiza <result> parsera" finished', STANDBY_NOTE)))
      .toStrictEqual({ kind: 'agent', outcome: 'waiting', name: 'Analiza <result> parsera' });
    // Nazwa z własnym `</summary>` i cudzym dopiskiem: rozstrzyga dopisek CLI, tu o końcu.
    const fake = `Agent "X </summary> <note>${STANDBY_NOTE}</note>" finished`;
    expect(noticeFromText(noted('completed', fake, ENDED_NOTE)).outcome).toBe('done');
  });

  /**
   * Fraza sieroty po powłokach W NAZWIE agenta nie robi z niego sieroty: jako `orphan` notka
   * traciła wynik `waiting`, choć lista pokazywała tego agenta w postoju.
   * Prawdziwy zbiorczy meldunek o sierotach nazwy w cudzysłowie nie ma i zostaje sierotą.
   */
  it('fraza sieroty w nazwie agenta nie zabiera mu rodzaju ani wyniku', () => {
    const summary = 'Agent "Analiza background shell command task(s)" finished';
    expect(noticeFromText(noted('completed', summary, STANDBY_NOTE))).toStrictEqual({
      kind: 'agent', outcome: 'waiting', name: 'Analiza background shell command task(s)',
    });
    // Także gdy nazwa ma własne cudzysłowy, gołe albo po podwójnym kodowaniu JSON.
    for (const inner of ['Agent "Analiza "background shell command task(s)"" finished',
      'Agent "Analiza \\"background shell command task(s)\\"" finished']) {
      const notice = noticeFromText(noted('completed', inner, STANDBY_NOTE));
      expect([notice.kind, notice.outcome], inner).toEqual(['agent', 'waiting']);
    }
    // Komenda z tą frazą w nazwie zostaje komendą; zbiorczy meldunek o sierotach zostaje sierotą.
    expect(noticeFromText(noted('completed', 'Background command "kill background shell command task(s)" completed')).kind)
      .toBe('command');
    expect(noticeFromText(noted('stopped', '3 background shell command task(s) were running')).kind).toBe('orphan');
  });

  it('import na żywo i historia dają ten sam wynik `waiting`', () => {
    const text = noted('completed', AGENT_DONE, STANDBY_NOTE);
    const expected: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'Przegląd' };
    expect(parseImportLine(line(text, { origin: ORIGIN }))?.message?.notice).toStrictEqual(expected);
    const { messages } = parseTranscriptTail(line(text, { origin: ORIGIN }), { dropFirstLine: false });
    expect(messages[0]?.notice).toStrictEqual(expected);
    // Prompt człowieka, który cytuje meldunek o postoju, notką nie jest (bramką jest `origin`).
    expect(parseImportLine(line(text))?.message?.notice).toBeUndefined();
  });

  /**
   * Lista zadań i notka czytają ten sam meldunek dwoma modułami. Rozpoznanie postoju z TREŚCI
   * meldunku stoi w jednym miejscu (`notification.ts`) właśnie po to, żeby nie dało się ich
   * rozjechać: agent, którego lista pokazuje jako czekającego, nie ma prawa dostać notki
   * „skończył" — i odwrotnie. Dla meldunku z czasem wpisu, o zadaniu, które jest agentem.
   */
  it('notka mówi `waiting` dokładnie wtedy, gdy reduktor zostawia agenta w postoju', () => {
    const notes = [undefined, STANDBY_NOTE, ENDED_NOTE, 'Nowe zdanie CLI.', `${STANDBY_NOTE} ${ENDED_NOTE}`];
    const summaries = [AGENT_DONE, 'Background agent "Przegląd" finished', 'agent "Przegląd" finished', 'Agents "x" done'];
    let waiting = 0;
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      for (const note of notes) {
        for (const summary of summaries) {
          const text = noted(status, summary, note);
          const tracker = createBackgroundTasksTracker();
          tracker.note({
            type: 'user', timestamp: '2026-10-09T21:39:58.108Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '' }] },
            toolUseResult: { agentId: 'a52b91f105b002e8d', status: 'async_launched', description: 'Przegląd' },
          });
          tracker.note({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-09T21:51:18.194Z', content: text });
          const onList = tracker.tasks[0]?.waitingSince !== undefined;
          const notice = noticeFromText(text);
          expect(notice.outcome === 'waiting', `${status} | ${summary} | ${note ?? 'bez dopisku'}`).toBe(onList);
          if (onList) waiting += 1;
        }
      }
    }
    // Trzy brzmienia streszczenia agenta × jeden status × jeden dopisek; „Agents" agentem nie jest.
    expect(waiting).toBe(3);
  });

  /**
   * Granica tej zgodności, zapisana wprost: reduktor ma dwa warunki, których notka nie zna, bo
   * dotyczą LISTY, nie treści meldunku. Oba kończą się zniknięciem wpisu i żaden nie
   * występuje w plikach CLI: wpis kolejki zawsze ma `timestamp`, a id zadania nie zmienia rodzaju.
   */
  it('notka `waiting` przy wpisie, którego reduktor nie umie zostawić w postoju: bez czasu i pod id komendy', () => {
    const text = noted('completed', AGENT_DONE, STANDBY_NOTE, 'bkomenda');
    expect(noticeFromText(text).outcome).toBe('waiting');

    const timeless = createBackgroundTasksTracker();
    timeless.note({ type: 'queue-operation', operation: 'enqueue', content: text });
    expect(timeless.tasks).toEqual([]);

    const command = createBackgroundTasksTracker();
    command.note({
      type: 'user', timestamp: '2026-10-09T21:39:58.108Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '' }] },
      toolUseResult: { backgroundTaskId: 'bkomenda' },
    });
    command.note({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-09T21:51:18.194Z', content: text });
    expect(command.tasks).toEqual([]);
  });
});

describe('import wpisu jsonl', () => {
  it('wpis z `origin` notki → `notice`; rola i bloki bez zmian (surowy tekst)', () => {
    const parsed = parseImportLine(line(FAILED, { origin: ORIGIN }));
    expect(parsed?.message).toStrictEqual({
      role: 'user', at: '2026-10-04T10:00:00.000Z', blocks: [{ type: 'text', text: FAILED }],
      notice: { kind: 'command', outcome: 'failed', name: 'pnpm test', exitCode: 2 },
    });
  });

  it('prompt człowieka ZE ZNACZNIKIEM w treści nie jest notką (brak albo inne `origin`)', () => {
    for (const extra of [{}, { origin: { kind: 'human' } }, { origin: null }]) {
      const parsed = parseImportLine(line(FAILED, extra));
      expect(parsed?.message?.notice).toBeUndefined();
      expect(parsed?.message?.blocks).toStrictEqual([{ type: 'text', text: FAILED }]);
    }
  });

  it('treść jako bloki `text` też jest klasyfikowana', () => {
    const parsed = parseImportLine(line([{ type: 'text', text: FAILED }], { origin: ORIGIN }));
    expect(parsed?.message?.notice?.kind).toBe('command');
  });

  it('notka nie dostaje zdjęć Raroga z wpisu-towarzysza (to nie wypowiedź człowieka)', () => {
    const companion = JSON.stringify({
      type: 'user', isMeta: true, timestamp: '2026-10-04T10:00:01.000Z',
      message: { role: 'user', content: [
        { type: 'text', text: '[Image: source: /x/.rarog-uploads/1790000000-0123456789abcdef.png]' },
      ] },
    });
    const { messages } = parseTranscriptTail(
      [line(FAILED, { origin: ORIGIN }), companion].join('\n'), { dropFirstLine: false },
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty('attachments');
  });
});

// ---------------------------------------------------------------------------
// Follower: na żywo i historia
// ---------------------------------------------------------------------------

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-s8-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

function start(): { follower: JsonlFollower; events: FollowEvent[] } {
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => 1_000_000,
  });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  return { follower, events };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

/** Zapis atomowy (jak w `herdr-jsonl-follow.test.ts`): follower nie trafi w pusty plik. */
async function createTranscript(content: string): Promise<string> {
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(`${path}.partial`, content);
  await rename(`${path}.partial`, path);
  return path;
}

type MessageEvent = Extract<FollowEvent, { type: 'message' }>;
type HistoryEvent = Extract<FollowEvent, { type: 'history' }>;

describe('follower — ten sam wynik na żywo i z historii', () => {
  it('notka z historii i ta sama linia dopisana na żywo dają identyczne `notice` i bloki', async () => {
    const notice = line(FAILED, { origin: ORIGIN });
    const path = await createTranscript(`${notice}\n`);
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    const fromHistory = (events.find((e) => e.type === 'history') as HistoryEvent).messages[0];

    await appendFile(path, `${notice}\n`);
    await waitFor(() => events.some((e) => e.type === 'message'), 'linia na żywo');
    const live = events.find((e) => e.type === 'message') as MessageEvent;

    const expected: TranscriptNotice = { kind: 'command', outcome: 'failed', name: 'pnpm test', exitCode: 2 };
    expect(fromHistory?.notice).toStrictEqual(expected);
    expect(live.notice).toStrictEqual(expected);
    expect(live.role).toBe('user');
    expect(live.blocks).toStrictEqual(fromHistory?.blocks);
  });

  it('notka nie zjada wpisu echa i nie jest nim gaszona — na żywo i z historii', async () => {
    const path = await createTranscript(`${line(FAILED, { origin: ORIGIN })}\n`);
    const { follower, events } = start();
    // Echo o tej SAMEJ treści co notka: gdyby notka brała udział w echu, zniknęłaby z historii.
    follower.dropEcho(FAILED);
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect((events.find((e) => e.type === 'history') as HistoryEvent).messages).toHaveLength(1);

    await appendFile(path, `${line(FAILED, { origin: ORIGIN })}\n${line(FAILED)}\n`);
    await waitFor(() => events.filter((e) => e.type === 'message').length >= 1, 'linie na żywo');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const live = events.filter((e): e is MessageEvent => e.type === 'message');
    // Notka przeszła, a prompt człowieka o tej treści zgasł na niezużytym wpisie echa.
    expect(live.map((e) => e.notice?.kind ?? 'prompt')).toStrictEqual(['command']);
  });
});

// ---------------------------------------------------------------------------
// Manager: pole dojeżdża do transkryptu
// ---------------------------------------------------------------------------

class FixtureDriver extends AtrapaDrivera {
  push(...events: DriverEvent[]): void { for (const event of events) this.queue.push(event); }
}

class FixtureSupervisor extends AtrapaNadzorcy<FixtureDriver> {
  override status(): HerdrStatus { return { available: true, agentCount: 1, readOnly: false, canLaunch: false }; }
  protected nowyDriver(key: string): FixtureDriver { return new FixtureDriver(key); }
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('manager przenosi `notice` do transkryptu', () => {
  it('wariant `message` i porcja `history` niosą pole; zwykła wiadomość go nie ma', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-s8-mgr-'));
    const supervisor = new FixtureSupervisor();
    const deps: HerdrManagerDeps = {
      sessionIdFor: (key) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
      aliasFor: () => undefined, rememberAlias: () => undefined,
      assertSendable: (text) => ({ text, slash: null }), takeSendSlot: () => true,
      writeUploads: () => Promise.resolve([]), writeUploadFiles: () => Promise.resolve([]),
      sweepUploads: () => Promise.resolve(),
    };
    const manager = await createManager({
      demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, gitStatus: null,
      gitWatcher: null, liveSessionsReader: () => Promise.resolve(null),
    });
    try {
      await manager.ready;
      const agent: HerdrAgent = {
        key: 'w1:p1', paneId: 'w1:p1', tabId: 'w1:t1', agentSessionId: SESSION, engine: 'claude',
        termId: null, cwd: CWD, status: 'working', title: 'atlas', stateChangeSeq: 1, mode: 'auto',
        modeReadAt: 0, inScope: true, launchedByRarog: true, interactiveReady: true,
      };
      supervisor.lifecycle.push({ type: 'appeared', agent });
      await flush();
      const driver = supervisor.drivers.get('w1:p1');
      if (driver === undefined) throw new Error('driver nie został podpięty');
      // Do drivera idzie wynik importu z blokami wewnętrznymi, jak z prawdziwego followera.
      const imported = parseTail(
        [line('Zrób przegląd.'), line(FAILED, { origin: ORIGIN })].join('\n'), { dropFirstLine: false },
      );
      driver.push({ type: 'history', messages: imported.messages });
      const live = parseLine(line(notification('completed', 'Agent "Przegląd" completed'), {
        origin: ORIGIN,
      }))?.message;
      if (live?.notice === undefined) throw new Error('import nie rozpoznał notki');
      driver.push({ type: 'message', role: 'user', blocks: live.blocks, notice: live.notice });
      await flush();

      const messages = manager.transcript('herdr-w1-p1').messages;
      expect(messages.map((m) => [m.role, m.notice?.kind ?? null])).toStrictEqual([
        ['user', null], ['user', 'command'], ['user', 'agent'],
      ]);
      expect(messages[0]).not.toHaveProperty('notice');
      expect(messages[2]?.notice).toStrictEqual({ kind: 'agent', outcome: 'done', name: 'Przegląd' });
    } finally {
      await manager.dispose();
      supervisor.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
