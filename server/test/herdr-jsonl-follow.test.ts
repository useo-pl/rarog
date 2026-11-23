/**
 * Follower transkryptu panelu herdr (`herdr/jsonl-follow.ts`).
 *
 * Testy pracują na PRAWDZIWYM pliku w katalogu tymczasowym — sednem modułu jest wyścig między
 * odczytem historii a dopisywaniem do pliku, a tego atrapa `fs` nie odtworzy. Czasy są
 * wstrzykiwane (`timing`), więc scenariusz „plik pojawia się z opóźnieniem" trwa milisekundy,
 * a nie minutę; zegar okna dedup jest osobny (`now`), bo echo trzeba umieć postarzać o godziny
 * — jego TTL jest bezpiecznikiem liczonym w godzinach, a nie progiem liczonym w sekundach.
 *
 * `watch: false` w większości testów jest celowe: sprawdzamy siatkę bezpieczeństwa (`stat` co
 * tick), czyli tę ścieżkę, która musi działać na systemach plików gubiących zdarzenia `fs.watch`.
 * Jeden test jawnie włącza `fs.watch`, żeby ścieżka szybka też była pokryta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InternalBlock } from '../src/drivers/types.ts';
import { projectSlug } from '../src/cli-store.ts';
import {
  ECHO_TTL_MS, ECHO_WINDOW, FOLLOW_MAX_READ_BYTES, GAP_MESSAGE, REPOINT_MESSAGE,
  RESUME_REPOINT_MESSAGE, TASKS_SCAN_LOG, TASKS_SCAN_LOG_BYTES, TASKS_SCAN_SKIPPED_LOG, TITLE_SCAN_MAX_BYTES,
  TRUNCATED_MESSAGE, UNKNOWN_AGENT_NOTE_LOG, createJsonlFollower, transcriptPathFor,
} from '../src/herdr/jsonl-follow.ts';
import { MAIN_SCAN_MAX_BYTES } from '../src/herdr/background/main-scan.ts';
import type { FollowEvent, JsonlFollower, TasksScanOptions } from '../src/herdr/jsonl-follow.ts';
import { ATTACHMENTS_ONLY_PROMPT, UPLOAD_DIR_NAME, appendAttachmentPaths } from '../src/herdr/uploads.ts';

/*
 * Domyślny limit testu w vitest to 5 s — mniej niż sufit `waitFor` niżej, więc bez tej linii
 * przeciążony przebieg padałby na „Test timed out in 5000ms" ZAMIAST na nazwanym `timeout: <co>`.
 * Podniesienie limitu nie wydłuża przebiegu zielonego: to sufit, nie opóźnienie.
 */
vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';

/** Czasy testowe: wszystko rzędu kilkunastu ms, żeby zestaw był szybki i nieflaky. */
const TIMING = {
  batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16,
};

let root = '';
let dir = '';
let now = 1_000_000;
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  now = 1_000_000;
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Narzędzia
// ---------------------------------------------------------------------------

const filePath = (session = SESSION): string => join(dir, `${session}.jsonl`);

/**
 * Utworzenie transkryptu ATOMOWO (zapis obok + `rename`), a nie `writeFile` na docelowej ścieżce.
 *
 * Powód jest wyścigiem, który wywracał trzy testy średnio raz na pięć pełnych przebiegów
 * `pnpm test` — i nie był to timeout, tylko HANG do końca budżetu. `writeFile` tworzy plik
 * i dopiero potem wpisuje treść. Gdy `#prime` followera trafi swoim `stat` w tę szczelinę,
 * czyta plik PUSTY: historia jest wtedy pusta, więc zdarzenie `history` NIE LECI (leci tylko
 * dla niepustego okna), a `#primed` i tak staje się `true`. Treść dopisana ułamek milisekundy
 * później dojeżdża już ścieżką tailu, czyli jako `message` — poprawnie z punktu widzenia
 * produkcji (nic nie ginie), ale test czekający na `history` czekał w nieskończoność.
 *
 * `rename` w tym samym katalogu jest atomowy: follower widzi albo BRAK pliku, albo plik
 * z komplet­ną treścią. Nazwa tymczasowa jest bez `.jsonl`, żeby glob `locateTranscript`
 * nie zobaczył jej po drodze.
 */
const createTranscript = async (path: string, content: string): Promise<void> => {
  const tmp = `${path}.partial`;
  await writeFile(tmp, content);
  await rename(tmp, path);
};

const userLine = (text: unknown, extra: Record<string, unknown> = {}): string => `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: text },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z',
  sessionId: SESSION,
  ...extra,
})}\n`;

const assistantLine = (
  content: unknown, extra: Record<string, unknown> = {},
): string => `${JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-fable-5', content },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:05.000Z',
  sessionId: SESSION,
  ...extra,
})}\n`;

const start = (opts: Partial<Parameters<typeof createJsonlFollower>[0]> = {}): {
  follower: JsonlFollower; events: FollowEvent[];
} => {
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING,
    now: () => now, ...opts,
  });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  return { follower, events };
};

/*
 * Czekamy na ZDARZENIE, którego dotyczy asercja, nigdy na „cokolwiek przyszło".
 *
 * `waitFor(() => events.length > 0, 'historia')` stało w 45 miejscach i było wyścigiem, nie
 * skrótem: pierwsze zdarzenie followera NIE MUSI być `history` (potrafi je wyprzedzić `pending`
 * albo `meta` z tej samej partii), więc pod obciążeniem pełnej suite predykat spełniał się
 * o jedną partię za wcześnie i `history(events)` rzucało „brak zdarzenia history" po 87 ms.
 * Wyglądało to na timeout, a było zwykłym sprawdzeniem złej rzeczy.
 */

/**
 * Sufit na ZEGARZE ŚCIENNYM, a `TIMING` w tym pliku schodzi do jednostek milisekund
 * (`statTickMs: 8`) — to dwie różne skale i tylko ta pierwsza łapie obciążenie maszyny.
 *
 * UWAGA na diagnozę: podniesienie tego sufitu z 3 s samo NIE naprawiło flake'a i nie było jego
 * przyczyną. Zmierzone przy 45 s: test dalej wisiał do końca budżetu, więc nie chodziło
 * o głodzenie procesora, tylko o dwa prawdziwe wyścigi (patrz komentarze przy
 * `createTranscript` i przy predykatach `waitFor`). Sufit jest tylko po to, żeby przebieg pod
 * obciążeniem miał zapas — w przebiegu zielonym nie kosztuje NIC, bo pętla kończy się
 * w chwili spełnienia predykatu.
 */
const WAIT_BUDGET_MS = 10_000;

const waitFor = async (predicate: () => boolean, label = 'warunek'): Promise<void> => {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

/** Krótka cisza — dowód, że czegoś NIE ma (kilka ticków `stat` + okno batchowania). */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

/**
 * Pierwsza pełna wypłata followera po otwarciu pliku: historia, potem partia stanu z pierwszą listą artefaktów.
 * Partia przychodzi po oknie batchowania albo po przeglądzie części pliku sprzed okna, więc test, który
 * liczy zdarzenia od samej historii, bierze ją czasem za odczyt przyrostowy.
 */
const primed = async (events: readonly FollowEvent[]): Promise<void> => {
  await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
  await waitFor(() => events.some((e) => e.type === 'artifacts'), 'pierwsza lista artefaktów');
};

const texts = (events: readonly FollowEvent[]): string[] => events
  .filter((e): e is Extract<FollowEvent, { type: 'message' }> => e.type === 'message')
  .flatMap((e) => e.blocks.map(blockText));

const blockText = (block: InternalBlock): string => {
  if (block.type === 'text') return block.text.text;
  if (block.type === 'tool-call') return `tool:${block.toolName}`;
  return 'image';
};

const history = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'history' }> => {
  const found = events.find((e): e is Extract<FollowEvent, { type: 'history' }> => e.type === 'history');
  if (found === undefined) throw new Error('brak zdarzenia history');
  return found;
};

const usages = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'usage' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'usage' }> => e.type === 'usage');

const metas = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'meta' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'meta' }> => e.type === 'meta');

const pendings = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'pending' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'pending' }> => e.type === 'pending');

const errors = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'error' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'error' }> => e.type === 'error');

const taskEvents = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'tasks' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'tasks' }> => e.type === 'tasks');

/*
 * Pierwsza wypłata listy zadań po podpięciu idzie zawsze, także pusta (wymiana drivera zachowuje listę
 * poprzedniego followera). Testy zmian listy na pliku bez zadań czekają na nią (`firstTasks`) i dopiero potem
 * dopisują linie, a liczą kolejne zdarzenia (`taskChanges`). Bez czekania wypłata potrafi wpaść do jednej partii
 * z pierwszą zmianą albo wyjść osobno, zależnie od tego, czy dopisek zdąży przed oknem partii.
 */
const firstTasks = (events: readonly FollowEvent[]): Promise<void> =>
  waitFor(() => taskEvents(events).length > 0, 'pierwsza lista zadań po podpięciu');

const taskChanges = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'tasks' }>[] =>
  taskEvents(events).slice(1);

/** Start komendy w tle: wywołanie `Bash` i jego wynik z `backgroundTaskId` (kształt zmierzony). */
const backgroundStart = (id: string, useId = 'toolu_bg'): string => assistantLine([
  { type: 'tool_use', id: useId, name: 'Bash', input: { command: 'pnpm test', description: 'Testy', run_in_background: true } },
]) + userLine([{ type: 'tool_result', tool_use_id: useId, content: '' }], {
  toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id },
});

/** Powiadomienie o końcu w wariancie `queue-operation` — jednym z czterech zmierzonych. */
const backgroundDone = (id: string): string => `${JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  sessionId: SESSION,
  content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n`
    + '<summary>Background command "Testy" completed (exit code 0)</summary>\n</task-notification>',
})}\n`;

/** Start subagenta w tle: wywołanie `Agent` i jego wynik z `agentId` (kształt CLI 2.1.296). */
const agentStart = (id: string, useId = 'toolu_agent'): string => assistantLine([
  { type: 'tool_use', id: useId, name: 'Agent', input: { description: 'Przegląd', subagent_type: 'general-purpose' } },
]) + userLine([{ type: 'tool_result', tool_use_id: useId, content: '' }], {
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: 'Przegląd' },
});

/** Dopisek o POSTOJU subagenta, znak w znak z `fixtures/herdr/tasks/measured/postoj.jsonl`. */
const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its '
  + 'own when that work completes or reports, and the same task-id notifies again if it does; the result '
  + 'below may be interim.';

/** Meldunek o zatrzymaniu subagenta; `n` rozróżnia meldunki tego samego agenta (wynik i `<usage>`). */
const agentStopped = (id: string, note: string, n: number): string => [
  '<task-notification>', `<task-id>${id}</task-id>`, '<status>completed</status>',
  '<summary>Agent "Przegląd" finished</summary>', `<note>${note}</note>`,
  `<result>wynik meldunku ${String(n)}</result>`,
  `<usage><subagent_tokens>${String(1000 + n)}</subagent_tokens><tool_uses>${String(n)}</tool_uses></usage>`,
  '</task-notification>',
].join('\n');

/** Pierwsza kopia meldunku: wpis kolejki `enqueue` z własnym czasem. */
const queued = (text: string, at: string): string => `${JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: SESSION, content: text,
})}\n`;

/**
 * Wpis asystenta z pełnym `usage` — kształt przepisany z `transcript-usage.jsonl`.
 *
 * Model jest parametrem, bo NIE jest neutralny: `claude-fable-5` potwierdza
 * followerowi okno 1M (`KNOWN_CONTEXT_LIMITS`), a testy „okno nieznane" potrzebują modelu
 * spoza tabeli (`claude-opus-5` — rozwiązane id aliasów nigdy w niej nie siedzi).
 */
const usageLine = (
  sum: number,
  extra: Record<string, unknown> = {},
  model = 'claude-fable-5',
): string => `${JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:05.000Z',
  sessionId: SESSION,
  message: {
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `tura ${String(sum)}` }],
    usage: {
      input_tokens: sum, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
  },
  ...extra,
})}\n`;

/** Granica kompakcji — jedyny dowód na realny rozmiar okna tej sesji. */
const boundaryLine = (preTokens: number, trigger = 'auto'): string => `${JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  isSidechain: false,
  sessionId: SESSION,
  compactMetadata: { trigger, preTokens, postTokens: 14_002 },
})}\n`;

const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:06.000Z',
  sessionId: SESSION,
  message: {
    role: 'assistant', model: 'claude-fable-5',
    content: [{ type: 'tool_use', id, name, input }],
  },
})}\n`;

const toolResultLine = (id: string): string => `${JSON.stringify({
  type: 'user',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:07.000Z',
  sessionId: SESSION,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})}\n`;

// ---------------------------------------------------------------------------
// Ścieżka pliku
// ---------------------------------------------------------------------------

describe('transcriptPathFor', () => {
  it('składa ścieżkę z korzenia, slugu cwd i identyfikatora sesji', () => {
    expect(transcriptPathFor('/root', CWD, SESSION))
      .toBe(join('/root', projectSlug(CWD), `${SESSION}.jsonl`));
  });

  it('odrzuca identyfikator, który mógłby wyjść poza magazyn', () => {
    expect(transcriptPathFor('/root', CWD, '../../../etc/passwd')).toBeNull();
    expect(transcriptPathFor('/root', CWD, 'a/b')).toBeNull();
    expect(transcriptPathFor('/root', CWD, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Historia + tail
// ---------------------------------------------------------------------------

describe('historia i tail', () => {
  it('oddaje historię, a potem nowe wpisy — bez duplikatu na styku', async () => {
    const reply = assistantLine([{ type: 'text', text: 'odpowiedź' }]);
    await writeFile(filePath(), userLine('pierwsze') + reply);
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    expect(history(events).messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    await appendFile(filePath(), userLine('drugie'));
    await waitFor(() => texts(events).includes('drugie'), 'nowy wpis');
    await quiet();

    // Klucz testu: „pierwsze" jest WYŁĄCZNIE w historii, „drugie" WYŁĄCZNIE w tailu.
    expect(texts(events)).toEqual(['drugie']);
    expect(texts(events).filter((t) => t === 'drugie')).toHaveLength(1);
  });

  it('nie gubi wpisu, którego zapis zastał w połowie linii', async () => {
    const line = userLine('dokończone');
    await writeFile(filePath(), userLine('gotowe') + line.slice(0, 20));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await quiet();

    // Ucięta linia nie jest jeszcze wiadomością…
    expect(texts(events)).toEqual([]);
    expect(history(events).messages).toHaveLength(1);

    await appendFile(filePath(), line.slice(20));
    await waitFor(() => texts(events).includes('dokończone'), 'domknięta linia');
    expect(texts(events)).toEqual(['dokończone']);
  });

  it('czeka na plik, którego jeszcze nie ma, i nigdy nie zgłasza błędu', async () => {
    const { events } = start();
    // Jedyne zdarzenia przed plikiem to puste listy zadań i artefaktów (pierwsza wypłata idzie także
    // bez pliku); obie z tej samej partii.
    await waitFor(() => events.some((e) => e.type === 'artifacts'), 'pierwsza lista artefaktów');
    await quiet();
    expect(events).toEqual([{ type: 'tasks', tasks: [] }, { type: 'artifacts', artifacts: [] }]);

    await createTranscript(filePath(), userLine('pierwszy prompt w tym panelu'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia po pojawieniu się pliku');
    expect(history(events).messages).toHaveLength(1);
  });

  it('skrócenie pliku daje wiadomość systemową zamiast powtórki od zera', async () => {
    const reply = assistantLine([{ type: 'text', text: 'stara odpowiedź' }]);
    await writeFile(filePath(), userLine('stare') + reply);
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await writeFile(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await quiet();

    // Zero replayu: po skróceniu leci sam komunikat, a nie cała reszta pliku jeszcze raz.
    expect(texts(events)).toEqual([TRUNCATED_MESSAGE.text]);
  });

  it('utrzymuje okno historii na `HERDR_HISTORY_MESSAGES`', async () => {
    let content = '';
    for (let i = 0; i < 300; i += 1) content += userLine(`prompt ${String(i)}`);
    await writeFile(filePath(), content);

    const { events } = start({ historyMessages: 60 });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    const messages = history(events).messages;
    expect(messages).toHaveLength(60);
    // Zostają NAJŚWIEŻSZE — telefon ma pokazać koniec rozmowy, nie jej początek.
    expect(blockText(messages[59]?.blocks[0] as InternalBlock)).toBe('prompt 299');
  });

  it('przy ogonie większym niż sufit bajtów odrzuca uciętą pierwszą linię', async () => {
    let content = '';
    for (let i = 0; i < 40; i += 1) content += userLine(`prompt ${String(i)}`);
    await writeFile(filePath(), content);

    // Sufit równy porcji = okno nie rośnie ani razu; ogon zaczyna się w środku wpisu.
    const { events } = start({ historyBytes: 900, historyMaxBytes: 900 });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    const messages = history(events).messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(40);
    // Każda wiadomość jest kompletna — żadna nie pochodzi z połówki linii.
    for (const message of messages) {
      expect(blockText(message.blocks[0] as InternalBlock)).toMatch(/^prompt \d+$/);
    }
  });

  /*
   * Bajty jsonl to w większości `tool_result`, którego import wyrzuca — więc okno
   * mierzone w bajtach dowozi kilkanaście wiadomości przy zadeklarowanym suficie 200
   * (pomiar na 60 największych transkryptach: mediana 12, sufitu nie dotknął żaden plik).
   * Okno musi rosnąć, aż uzbiera WIADOMOŚCI — i zatrzymać się dopiero na twardym suficie.
   */
  describe('okno historii mierzone wiadomościami', () => {
    /** Wpis z grubym `tool_result` — dokładnie ten kształt, który zjadał okno bajtowe. */
    const toolResultLine = (bytes: number): string => userLine([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(bytes) },
    ]);

    it('dociąga porcjami, dopóki nie uzbiera zadeklarowanej liczby wiadomości', async () => {
      let content = '';
      // 30 tur, każda okupiona 4 kB wyniku narzędzia: przy porcji 2 kB pierwszy obrót
      // przynosi najwyżej jedną wiadomość, a deklaracja obiecuje 20.
      for (let i = 0; i < 30; i += 1) {
        content += userLine(`prompt ${String(i)}`);
        content += toolResultLine(4_000);
      }
      await writeFile(filePath(), content);

      const { events } = start({ historyBytes: 2_048, historyMessages: 20 });
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

      const messages = history(events).messages;
      expect(messages).toHaveLength(20);
      // Zostają NAJŚWIEŻSZE — telefon ma pokazać koniec rozmowy, nie jej początek.
      expect(blockText(messages[19]?.blocks[0] as InternalBlock)).toBe('prompt 29');
    });

    it('twardy sufit bajtów przerywa pogoń — Rarog nie wciąga całego transkryptu', async () => {
      let content = '';
      for (let i = 0; i < 30; i += 1) {
        content += userLine(`prompt ${String(i)}`);
        content += toolResultLine(4_000);
      }
      await writeFile(filePath(), content);

      // Sufit 12 kB mieści ~3 tury; deklaracja 20 wiadomości pozostaje niespełniona i DOBRZE.
      const { events } = start({
        historyBytes: 2_048, historyMaxBytes: 12_288, historyMessages: 20,
      });
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

      const messages = history(events).messages;
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBeLessThan(20);
      expect(blockText(messages[messages.length - 1]?.blocks[0] as InternalBlock)).toBe('prompt 29');
    });

    it('plik krótszy od porcji kosztuje dokładnie jeden obrót', async () => {
      await writeFile(filePath(), userLine('jedyny prompt'));

      const { events } = start({ historyBytes: 2_048, historyMessages: 200 });
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

      // Pętla kończy się na `start === 0`, a nie na suficie wiadomości, którego nie ma skąd wziąć.
      expect(history(events).messages).toHaveLength(1);
    });

    it('po historii tail leci dalej od miejsca, w którym skończyło się OSTATNIE okno', async () => {
      let content = '';
      for (let i = 0; i < 30; i += 1) {
        content += userLine(`prompt ${String(i)}`);
        content += toolResultLine(4_000);
      }
      await writeFile(filePath(), content);

      const { events } = start({ historyBytes: 2_048, historyMessages: 20 });
      await primed(events);
      const before = events.length;

      await appendFile(filePath(), userLine('po historii'));
      await waitFor(() => events.length > before, 'tail po historii');
      // Ani duplikatu okna, ani luki: na drut idzie dokładnie dopisana linia.
      expect(texts(events.slice(before))).toEqual(['po historii']);
    });
  });

  it('emituje jedną porcją wpisy dopisane w jednym oknie batchowania', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    let burst = '';
    for (let i = 0; i < 10; i += 1) burst += userLine(`seria ${String(i)}`);
    await appendFile(filePath(), burst);

    await waitFor(() => events.length > before, 'pierwsza emisja');
    // Cała dziesiątka trafia do kolejki w JEDNEJ emisji — nie po ramce na wpis.
    expect(events.length - before).toBe(10);
  });

  it('zdarzenie `fs.watch` skraca opóźnienie do poniżej ticku `stat`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ watch: true, timing: { ...TIMING, statTickMs: 5_000 } });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), userLine('z watcha'));
    await waitFor(() => texts(events).includes('z watcha'), 'wpis z fs.watch');
  });
});

// ---------------------------------------------------------------------------
// Kształty wpisów
// ---------------------------------------------------------------------------

describe('kształty wpisów', () => {
  /*
   * Aktywność PO wiadomości, nie przed. Wpis z `tool_use` ląduje w jsonl
   * w chwili domknięcia odpowiedzi API, a cisza narzędzia zaczyna się DOPIERO POTEM —
   * klient kasuje aktywność przy każdej wiadomości, więc wskaźnik wysłany przed własną
   * wiadomością gasł w tej samej partii i pracująca sesja nie pokazywała nic.
   */
  it('blok `tool_use` daje wskaźnik aktywności PO wiadomości', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), assistantLine([
      { type: 'text', text: 'czytam plik' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/Users/u/Projects/atlas/src/a.ts' } },
    ]));

    await waitFor(() => events.length > before + 1, 'message + activity');
    const emitted = events.slice(before);
    expect(emitted[0]?.type).toBe('message');
    // Opis = skrót inputu: wiersz aktywności mówi „czyta plik: …/a.ts".
    expect(emitted[1]).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Read',
      summary: '/Users/u/Projects/atlas/src/a.ts',
    });
  });

  /*
   * Narzędzia delegujące (S-live). Po `Task`/`Agent`/`Workflow` główny plik milknie na minuty,
   * więc wiersz „Agent" zostaje na ekranie sam — i musi powiedzieć, o jaką pracę chodzi.
   * `summarizeToolInput` tego nie zrobi: szuka `command`/`file_path`/…, a input delegacji ma
   * `description` albo `script` (zmierzone na realnych wpisach).
   */
  it('`Agent` niesie opis zadania w aktywności', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), assistantLine([
      {
        type: 'tool_use',
        name: 'Agent',
        input: { description: 'Audyt UI panelu', subagent_type: 'general-purpose' },
      },
    ]));

    await waitFor(() => events.length > before + 1, 'message + activity');
    expect(events[before + 1]).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Agent', summary: 'Audyt UI panelu',
      delegation: 'agents',
    });
  });

  it('`Workflow` niesie nazwę przebiegu z nagłówka skryptu', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), assistantLine([
      {
        type: 'tool_use',
        name: 'Workflow',
        input: { script: "export const meta = {\n  name: 'rarog-fala-1',\n  phases: []\n};\n" },
      },
    ]));

    await waitFor(() => events.length > before + 1, 'message + activity');
    expect(events[before + 1]).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Workflow', summary: 'rarog-fala-1',
      delegation: 'workflow',
    });
  });

  it('zwykłe narzędzie niesie skrót inputu — wiersz mówi, JAKĄ komendę uruchamia', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), assistantLine([
      { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
    ]));

    await waitFor(() => events.length > before + 1, 'message + activity');
    expect(events[before + 1]).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Bash', summary: 'pnpm test',
    });
  });

  /*
   * Jedna partia = JEDEN wskaźnik aktywności (ta sama zasada co `#drainState`).
   *
   * Aktywność jest ulotna: klient nadpisuje ją przy każdej kolejnej i kasuje przy każdej
   * wiadomości. Wskaźniki sprzed ostatniego zdarzenia partii nie mają więc jak się pokazać —
   * a każdy z nich kosztuje ramkę SSE na telefon.
   */
  it('kilka bloków `tool_use` w jednej odpowiedzi daje JEDEN wskaźnik aktywności', async () => {
    await createTranscript(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), assistantLine([
      { type: 'tool_use', name: 'Read', input: { file_path: '/Users/u/Projects/atlas/a.ts' } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
    ]));

    await waitFor(() => events.slice(before).some((e) => e.type === 'activity'), 'aktywność');
    await quiet();
    expect(events.slice(before).filter((e) => e.type === 'activity')).toEqual([
      { type: 'activity', kind: 'tool', toolName: 'Bash', summary: 'pnpm test' },
    ]);
  });

  it('wskaźnik, po którym w tej samej partii leci wiadomość, NIE wychodzi', async () => {
    await createTranscript(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    // Dwie linie JEDNYM zapisem: obie wchodzą do tego samego bufora, więc partia jest pewna.
    await appendFile(filePath(), assistantLine([
      { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
    ]) + userLine('a teraz co innego'));

    await waitFor(
      () => texts(events.slice(before)).includes('a teraz co innego'), 'druga wiadomość',
    );
    await quiet();
    expect(events.slice(before).some((e) => e.type === 'activity')).toBe(false);
  });

  it('obrazek z magazynu CLI staje się `[image]` — base64 nie opuszcza Maca', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), userLine([
      { type: 'text', text: 'zobacz' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]));
    await waitFor(() => texts(events).includes('[image]'), 'placeholder obrazka');
    expect(texts(events).some((t) => t.includes('AAAA'))).toBe(false);
  });

  it('ignoruje wpisy, które nie są rozmową (system, meta, sidechain)', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), [
      `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`,
      userLine('meta', { isMeta: true }),
      userLine('podagent', { isSidechain: true }),
      '{ to nie jest json\n',
      userLine('prawdziwy prompt'),
    ].join(''));

    await waitFor(() => texts(events).includes('prawdziwy prompt'), 'prompt z terminala');
    await quiet();
    expect(texts(events)).toEqual(['prawdziwy prompt']);
  });

  it('nie tworzy pliku ani zdarzeń dla identyfikatora spoza wzorca', async () => {
    const { events } = start({ agentSessionId: '../../../etc/passwd' });
    // Poza pustymi listami zadań i artefaktów: pliku nie będzie, więc listy są puste na pewno.
    await waitFor(() => events.some((e) => e.type === 'artifacts'), 'pierwsza lista artefaktów');
    await quiet();
    expect(events).toEqual([{ type: 'tasks', tasks: [] }, { type: 'artifacts', artifacts: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Echo własnych promptów
// ---------------------------------------------------------------------------

/*
 * Wiadomość od subagenta i zaplanowane wybudzenie stoją w pliku jako wpis `user`
 * z `isMeta: true`. W transkrypcie ich nie ma i ma nie być, ale wywołują turę, więc follower
 * mówi o nich jednym zdarzeniem bez treści. Manager liczy z niego przyczynę tury.
 */
/**
 * Prompt, który przychodzi W TRAKCIE tury, Claude Code wchłania w tę turę i zapisuje wyłącznie jako
 * załącznik kolejki (`queue-operation` enqueue, remove z powodem „absorbed_mid_turn", potem
 * `attachment` typu `queued_command`), bez wpisu `user`. Zmierzone na CLI 2.1.267–2.1.296
 * (112 promptów w 32 plikach sesji). Bez tego wpisu echo wysyłki z Raroga zostaje sierotą,
 * a prompt z terminala nie dociera do Raroga wcale.
 */
describe('prompt wchłonięty w trwającą turę (załącznik kolejki)', () => {
  const AT = '2026-10-10T07:50:29.308Z';
  /** Trzy wpisy, którymi CLI 2.1.296 zapisuje wchłonięty prompt; treść niesie tylko ostatni. */
  const absorbed = (prompt: unknown, text: string): string => [
    { type: 'queue-operation', operation: 'enqueue', timestamp: AT, sessionId: SESSION, content: text },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: AT, sessionId: SESSION, content: text },
    {
      type: 'attachment', isSidechain: false, timestamp: AT, sessionId: SESSION,
      attachment: {
        type: 'queued_command', prompt, source_uuid: '4736773d-7cd6-4c16-afeb-64ec815377dc', commandMode: 'prompt',
        origin: { kind: 'human' }, timestamp: AT, humanTurn: 3,
      },
    },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join('');
  const inputs = (events: readonly FollowEvent[]): FollowEvent[] => events.filter((e) => e.type === 'turn-input');

  it('z Raroga: echo zużyte, w górę idzie `turn-input`, nie druga wiadomość', async () => {
    await writeFile(filePath(), userLine('start') + assistantLine([{ type: 'text', text: 'pracuję' }]));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('a jeszcze to');
    now += 9_500;
    await appendFile(filePath(), absorbed('a jeszcze to', 'a jeszcze to'));
    await waitFor(() => inputs(events).length === 1, 'wejście tury');
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);

    // Sieroty echa nie ma: ten sam tekst wpisany później w terminalu dociera do Raroga.
    await appendFile(filePath(), userLine('a jeszcze to'));
    await waitFor(() => texts(events.slice(before)).includes('a jeszcze to'), 'identyczny prompt z terminala');
  });

  it('z terminala: prompt wchłonięty w turę dociera do Raroga jako wiadomość', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), absorbed('poprawka z terminala', 'poprawka z terminala'));
    await waitFor(() => texts(events.slice(before)).includes('poprawka z terminala'), 'prompt z terminala');
    await quiet();
    expect(texts(events.slice(before))).toEqual(['poprawka z terminala']);
    expect(inputs(events.slice(before))).toEqual([]);
  });

  it('ze zdjęciem z Raroga: echo trafia mimo `[Image #N]` i bloku obrazu', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('BTW. Pytanie z boku /Users/u/Projects/atlas/.rarog-uploads/1-ab-zrzut.png');
    await appendFile(filePath(), absorbed([
      { type: 'text', text: '[Image #4]BTW. Pytanie z boku' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
    ], '[Image #4]BTW. Pytanie z boku'));
    await waitFor(() => inputs(events).length === 1, 'wejście tury');
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);
  });

  it('samo zdjęcie z Raroga wchłonięte w turę: echo trafia po stałym tekście', async () => {
    // Wpis `queued_command` ze zdjęciem NIE ma towarzysza z nazwą pliku (8 z 8 takich wpisów w transkryptach
    // Raroga, CLI 2.1.277–2.1.296), więc bez tekstu echa nie byłoby czym dopasować.
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho(appendAttachmentPaths('', ['/Users/u/Projects/atlas/.rarog-uploads/1-0123456789abcdef.png']));
    const prompt = `[Image #4]${ATTACHMENTS_ONLY_PROMPT}`;
    await appendFile(filePath(), absorbed([
      { type: 'text', text: prompt },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
    ], prompt));
    await waitFor(() => inputs(events).length === 1, 'wejście tury');
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);
  });

  it('historia przy podpięciu niesie wchłonięty prompt w miejscu wpisu', async () => {
    await writeFile(filePath(), userLine('zrób to') + assistantLine([{ type: 'text', text: 'Zaczynam.' }])
      + absorbed('a jeszcze to', 'a jeszcze to') + assistantLine([{ type: 'text', text: 'Dobrze, to też.' }]));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(history(events).messages.map((message) => message.blocks.map(blockText).join(' ')))
      .toEqual(['zrób to', 'Zaczynam.', 'a jeszcze to', 'Dobrze, to też.']);
  });

  /**
   * Echo zarejestrowane, zanim follower przeczyta historię (wysyłka tuż po podpięciu): filtr
   * historii zużywa je tak samo jak odczyt na żywo, tylko bez `turn-input`.
   */
  it('echo wchłoniętego promptu gaśnie także w pierwszym odczycie historii', async () => {
    await writeFile(filePath(), userLine('zrób to') + absorbed('z Raroga tuż po podpięciu', 'z Raroga tuż po podpięciu'));
    const { follower, events } = start();
    follower.dropEcho('z Raroga tuż po podpięciu');
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(history(events).messages.map((message) => message.blocks.map(blockText).join(' '))).toEqual(['zrób to']);
    expect(inputs(events)).toEqual([]);

    // Echo zużyte: ten sam tekst wpisany potem w terminalu przechodzi.
    await appendFile(filePath(), userLine('z Raroga tuż po podpięciu'));
    await waitFor(() => texts(events).includes('z Raroga tuż po podpięciu'), 'identyczny prompt z terminala');
  });

  it('meldunek i wiadomość od subagenta tym samym nośnikiem dalej nie są wiadomością', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;
    const carried = (attachment: Record<string, unknown>): string => `${JSON.stringify({
      type: 'attachment', isSidechain: false, timestamp: AT, sessionId: SESSION,
      attachment: { type: 'queued_command', prompt: 'nie człowiek', commandMode: 'prompt', ...attachment },
    })}\n`;

    await appendFile(filePath(), carried({ origin: { kind: 'peer', from: 'a1', senderTaskId: 'a1' }, isMeta: true })
      + carried({ commandMode: 'task-notification', origin: { kind: 'task-notification' } }));
    await quiet();
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);
  });
});

describe('ukryte wejście tury (`turn-input`)', () => {
  const PEER = { kind: 'peer', from: 'a7c3bc19e5d808853', senderTaskId: 'a7c3bc19e5d808853', handback: true };
  const hidden = (extra: Record<string, unknown>): string => userLine(
    'Another Claude session sent a message:\n<agent-message>raport</agent-message>',
    { isMeta: true, promptSource: 'system', ...extra },
  );
  const inputs = (events: readonly FollowEvent[]): FollowEvent[] => events.filter((e) => e.type === 'turn-input');

  it('wiadomość subagenta dopisana na żywo → jedno `turn-input`, żadnej wiadomości', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await waitFor(() => events.some((e) => e.type === 'artifacts'), 'pierwsza lista artefaktów');
    const before = events.length;

    await appendFile(filePath(), hidden({ origin: PEER, turnOrigin: 'peer' }));
    await waitFor(() => inputs(events).length === 1, 'wejście tury');
    await quiet();

    expect(events.slice(before)).toEqual([{ type: 'turn-input' }]);
  });

  it('zaplanowane wybudzenie też; towarzysz zdjęcia i wpis subagenta nie', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), [
      hidden({ turnOrigin: 'scheduled' }),
      userLine('[Image: source: /Users/u/Projects/atlas/.rarog-uploads/a.png]', { isMeta: true }),
      hidden({ origin: PEER, turnOrigin: 'peer', isSidechain: true }),
      userLine('koniec partii'),
    ].join(''));
    await waitFor(() => texts(events).includes('koniec partii'), 'koniec partii');

    expect(inputs(events)).toHaveLength(1);
  });

  it('kolejność pliku zostaje: notka o postoju, wiadomość subagenta, prompt człowieka', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { events } = start();
    await primed(events);
    const before = events.length;
    const standby = agentStopped('a52b91f105b002e8d',
      'This agent stopped with background work of its own still running. It may resume on its own.', 1);

    await appendFile(filePath(), [
      userLine(standby, { origin: { kind: 'task-notification' } }),
      hidden({ origin: PEER, turnOrigin: 'peer' }),
      userLine('z terminala'),
    ].join(''));
    await waitFor(() => texts(events).includes('z terminala'), 'prompt z terminala');

    const order = events.slice(before)
      .filter((e) => e.type === 'message' || e.type === 'turn-input')
      .map((e) => (e.type === 'message' ? `message:${e.notice?.outcome ?? 'prompt'}` : e.type));
    expect(order).toEqual(['message:waiting', 'turn-input', 'message:prompt']);
  });

  /*
   * Prompt wysłany z Raroga stoi w transkrypcie od wysyłki, więc jego echo z pliku follower gasi.
   * Fakt zostaje: CLI właśnie wzięło ten prompt do tury. Prompt wysłany w trakcie tury CLI
   * kolejkuje i zapisuje dopiero w następnej (kolejka zmierzona na 2.1.299), a manager ma go policzyć tam,
   * gdzie się wykonał.
   */
  it('echo własnego promptu Raroga: wiadomości nie ma, wejście jest — w kolejności pliku', async () => {
    await writeFile(filePath(), userLine('zrób coś'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('z Raroga');
    await appendFile(filePath(), userLine('z Raroga') + userLine('z terminala'));
    await waitFor(() => texts(events).includes('z terminala'), 'prompt z terminala');

    const live = events.slice(before).filter((e) => e.type === 'message' || e.type === 'turn-input');
    expect(live.map((e) => e.type)).toEqual(['turn-input', 'message']);
    expect(texts(events)).not.toContain('z Raroga');
  });

  /*
   * Follower wypuszcza z partii tylko tę aktywność, która partię ZAMYKA (wcześniejsze i tak
   * skasowałaby następna wiadomość). `turn-input` partii nie zamyka: klient go nie widzi, więc
   * wskaźnik narzędzia ma zostać. Widoczna wiadomość po nim dalej go zabiera.
   */
  it('`turn-input` w tej samej partii co `tool_use` nie zabiera wskaźnika narzędzia', async () => {
    const bash = assistantLine([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }]);
    const kinds = (list: readonly FollowEvent[]): string[] => list
      .filter((e) => e.type === 'message' || e.type === 'activity' || e.type === 'turn-input')
      .map((e) => (e.type === 'activity' ? `activity:${e.toolName ?? ''}` : e.type));

    await writeFile(filePath(), userLine('zrób coś'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    let before = events.length;

    // Raport subagenta zaraz po wywołaniu narzędzia.
    await appendFile(filePath(), bash + hidden({ origin: PEER, turnOrigin: 'peer' }));
    await waitFor(() => inputs(events).length === 1, 'wejście po narzędziu');
    await quiet();
    expect(kinds(events.slice(before))).toEqual(['message', 'activity:Bash', 'turn-input']);

    // Zgaszone echo promptu z Raroga zaraz po wywołaniu narzędzia.
    before = events.length;
    follower.dropEcho('z Raroga');
    await appendFile(filePath(), bash + userLine('z Raroga'));
    await waitFor(() => inputs(events).length === 2, 'echo po narzędziu');
    await quiet();
    expect(kinds(events.slice(before))).toEqual(['message', 'activity:Bash', 'turn-input']);

    // Widoczna wiadomość na końcu partii dalej zastępuje wskaźnik.
    before = events.length;
    await appendFile(filePath(), bash + hidden({ origin: PEER, turnOrigin: 'peer' }) + userLine('z terminala'));
    await waitFor(() => texts(events).includes('z terminala'), 'wiadomość po narzędziu');
    await quiet();
    expect(kinds(events.slice(before))).toEqual(['message', 'turn-input', 'message']);
  });

  /*
   * Utrata ciągłości pliku: pominięty albo ucięty kawałek mógł nieść
   * prompt bieżącej tury, a notka o postoju z tego, co zostało, wyglądałaby na jej jedyną
   * przyczynę. Follower mówi o tym PRZED tym, co przeczyta potem.
   */
  it('skrócenie pliku: `lost` przed wiadomością o skróceniu', async () => {
    await writeFile(filePath(), userLine('pierwsza') + userLine('druga') + userLine('trzecia'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await createTranscript(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');

    const after = events.slice(before).filter((e) => e.type === 'message' || e.type === 'turn-input');
    expect(after[0]).toEqual({ type: 'turn-input', lost: true });
    expect(after[1]).toMatchObject({ type: 'message', role: 'system' });
  });

  it('przeskok przyrostu ponad sufit: `lost` przed wiadomością o luce i przed zachowanym ogonem', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ maxReadBytes: 2_000 });
    await primed(events);
    const before = events.length;
    const standby = agentStopped('a52b91f105b002e8d',
      'This agent stopped with background work of its own still running. It may resume on its own.', 1);

    // Prompt człowieka ginie w pominiętym kawałku, notka o postoju zostaje w ogonie.
    await appendFile(filePath(), [
      userLine('zadanie człowieka'),
      userLine('x'.repeat(4_000), { isMeta: true }),
      userLine(standby, { origin: { kind: 'task-notification' } }),
    ].join(''));
    await waitFor(() => events.some((e) => e.type === 'message' && e.notice !== undefined), 'notka z ogona');

    const after = events.slice(before)
      .filter((e) => e.type === 'message' || e.type === 'turn-input')
      .map((e) => (e.type === 'turn-input' ? `turn-input:${e.lost === true ? 'lost' : 'input'}`
        : `message:${e.role}:${e.notice?.outcome ?? '-'}`));
    expect(after).toEqual(['turn-input:lost', 'message:system:-', 'message:user:waiting']);
    expect(texts(events)).not.toContain('zadanie człowieka');
  });

  it('wpisy z historii przy podpięciu nie dają zdarzenia: to tury sprzed Raroga', async () => {
    await writeFile(filePath(), userLine('zrób coś') + hidden({ origin: PEER, turnOrigin: 'peer' }));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await quiet();

    expect(inputs(events)).toEqual([]);
    expect(history(events).messages).toHaveLength(1);
  });
});

describe('dropEcho', () => {
  it('wycina echo wysłanego promptu', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('z Raroga');
    now += 2_000;
    await appendFile(filePath(), userLine('z Raroga'));
    await quiet();
    expect(texts(events)).toEqual([]);
  });

  /*
   * Regresja: prompt w transkrypcie dwa razy.
   *
   * Prompt wysłany w chwili, gdy agent pracuje, trafia do KOLEJKI Claude Code i do jsonl wchodzi
   * dopiero przy dequeue. W transkrypcie sesji `visuals`: `queue-operation`/`enqueue` z treścią
   * o 13:05:00, ten sam tekst jako wpis `user` o 13:06:56. Przy TTL 10 s wpis echa dawno
   * by wygasł i dymek pojawiłby się drugi raz — przy KAŻDYM promptcie wysłanym w trakcie dłuższej
   * tury, nie tylko przy `/compact`.
   *
   * Liczba jest tu literałem świadomie: to zmierzony czas z życia, a nie pochodna stałej.
   * Skrócenie TTL poniżej niego ma ten test wywalić.
   */
  it('gasi echo promptu, który przeleżał w kolejce Claude Code', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('z Raroga, prosto do kolejki');
    now += 115_000;
    await appendFile(filePath(), userLine('z Raroga, prosto do kolejki'));
    await quiet();
    expect(texts(events)).toEqual([]);
  });

  it('echo gaśnie po OKNIE, nie po zegarze: dziewiąta wysyłka wypycha pierwszą', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    // Zegar stoi — jedyne, co usuwa najstarszy wpis, to przepełnienie okna.
    follower.dropEcho('najstarszy');
    for (let i = 0; i < ECHO_WINDOW; i += 1) follower.dropEcho(`wypełniacz ${String(i)}`);

    await appendFile(filePath(), userLine('najstarszy'));
    await waitFor(() => texts(events).includes('najstarszy'), 'prompt wypchnięty z okna');
  });

  it('TTL zostaje bezpiecznikiem na sierotę po wysyłce, która nie dojechała do jsonl', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('sierota');
    now += ECHO_TTL_MS + 1;
    await appendFile(filePath(), userLine('sierota'));
    await waitFor(() => texts(events).includes('sierota'), 'prompt po TTL');
  });

  /*
   * Duplikat z żywej sesji (wersja CLI niezapisana): prompt z załącznikiem wraca z jsonl
   * PRZEBRANY — CLI dokleja `[Image #N]` do tekstu (ten kształt zmierzony na CLI 2.1.302, test niżej),
   * a import zamienia blok obrazka na `[image]`.
   * Dosłowne porównanie nie ma prawa trafić i echo weszłoby obok wpisu optymistycznego.
   */
  it('echo promptu ze zdjęciem trafia mimo znaczników [Image #N] i [image]', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    // Strona zapisu niesie DOKLEJONĄ ścieżkę uploadu (tak wysyła driver) — CLI ją zjada.
    follower.dropEcho(
      '- popraw layout\n- i jeszcze font /Users/u/Projects/atlas/.rarog-uploads/1-ab-zrzut.png',
    );
    await appendFile(filePath(), userLine([
      { type: 'text', text: '[Image #27]- popraw layout\n- i jeszcze font' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
    ]));
    await quiet();
    expect(texts(events)).toEqual([]);
  });

  /*
   * Duplikat zmierzony na żywo (CLI 2.1.304): raport z tabelą TSV wraca z jsonl
   * w obwódce wklejki, z KAŻDYM tabulatorem zamienionym na cztery spacje (puste pole `\t\t` = osiem) i bez
   * pustej linii po pierwszym zdaniu. Pojedynczy tabulator w środku linii zostałby w kluczu echa jako `\t`,
   * cztery spacje z pliku jako ` ` — klucze rozjechałyby się i prompt stałby w transkrypcie dwa razy.
   */
  it('echo tekstu z tabelą TSV trafia, choć CLI 2.1.304 zamienia tabulatory na spacje', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    const jpg = '/Users/u/Projects/atlas/.rarog-uploads/1792498614146-21a5cfb9e96d4a91.jpg';
    const sent = [
      'Takie powiadomienie po 10 min przyszło. Logi poniżej',
      '',
      '# Fjord · pomiar Notatek · build 222',
      'stop\trec\tzrodlo\tfaza_stop',
      '2026-10-20T12:01:18.212Z\tE2D9\tintent.stop\t\t68.0',
      '2026-10-20T12:03:45.440Z\t60FE\tintent.stop\tbackground\t\t145.1',
    ].join('\n');
    const fromCli = [
      'Takie powiadomienie po 10 min przyszło. Logi poniżej',
      '# Fjord · pomiar Notatek · build 222',
      'stop    rec    zrodlo    faza_stop',
      '2026-10-20T12:01:18.212Z    E2D9    intent.stop        68.0',
      '2026-10-20T12:03:45.440Z    60FE    intent.stop    background        145.1',
    ].join('\n');
    follower.dropEcho(appendAttachmentPaths(sent, [jpg]));
    await appendFile(filePath(), userLine([
      { type: 'text', text: `[Image #11]\n\n<pasted_content id="7c4b">\n${fromCli}\n</pasted_content id="7c4b">\n` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aaaa' } },
    ]) + userLine([{ type: 'text', text: `[Image: source: ${jpg}]` }], { isMeta: true }));
    await quiet();
    expect(texts(events)).toEqual([]);
  });

  /*
   * Sam załącznik bez tekstu: Rarog wysyła `(załącznik) <ścieżki>`, a echo trafia po tym
   * tekście. Kształty wpisów zmierzone na CLI 2.1.302: zdjęcie wraca jako `[Image #N]<tekst>`
   * z blokiem obrazu i towarzyszem `isMeta` `[Image: source: <ścieżka>]` w tej samej milisekundzie (import
   * przypina go w historii i zdejmuje `[image]`), plik nieobrazkowy jako goły string ze ścieżką.
   */
  // Nazwy jak z `writeUploads` (`UPLOAD_IMAGE_FILE_PATTERN`): tylko takie import przypina z towarzysza.
  const UPLOADS = '/Users/u/Projects/atlas/.rarog-uploads';
  const PNG_A = `${UPLOADS}/1790000000-0123456789abcdef.png`;
  const PNG_B = `${UPLOADS}/1790000001-0123456789abcde0.png`;
  const TXT = `${UPLOADS}/1790000002-0123456789abcde2-notatka.txt`;
  const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } };
  /** Wiadomość ze zdjęciami i jej towarzysz, jednym zapisem — tak, jak zapisuje je CLI 2.1.302. */
  const photoLines = (text: string, paths: readonly string[]): string => userLine(
    [{ type: 'text', text }, ...paths.map(() => IMAGE)],
  ) + userLine(paths.map((path) => ({ type: 'text', text: `[Image: source: ${path}]` })), { isMeta: true });

  it('echo samego zdjęcia, dwóch zdjęć i samego pliku trafia na żywo', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho(appendAttachmentPaths('', [PNG_A]));
    await appendFile(filePath(), photoLines(`[Image #2]${ATTACHMENTS_ONLY_PROMPT}`, [PNG_A]));
    follower.dropEcho(appendAttachmentPaths('', [PNG_A, PNG_B]));
    await appendFile(filePath(), photoLines(`[Image #3] [Image #4]${ATTACHMENTS_ONLY_PROMPT}`, [PNG_A, PNG_B]));
    follower.dropEcho(appendAttachmentPaths('', [TXT]));
    await appendFile(filePath(), userLine(appendAttachmentPaths('', [TXT])));
    await quiet();
    expect(texts(events)).toEqual([]);
  });

  it('echo samego zdjęcia gaśnie też w pierwszym odczycie historii (import przypina towarzysza)', async () => {
    await writeFile(filePath(), userLine('start') + photoLines(`[Image #1]${ATTACHMENTS_ONLY_PROMPT}`, [PNG_A]));
    const { follower, events } = start();
    follower.dropEcho(appendAttachmentPaths('', [PNG_A]));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(history(events).messages.map((message) => message.blocks.map(blockText).join(' '))).toEqual(['start']);
  });

  it('echo samego zdjęcia z Raroga nie gasi zdjęcia wklejonego przy biurku', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    // Wysyłka z Raroga nie doszła, więc jej wpis echa czeka do końca TTL.
    follower.dropEcho(appendAttachmentPaths('', [PNG_A]));
    await appendFile(filePath(), photoLines('[Image #5]', ['/Users/u/Desktop/zrzut.png']));
    await waitFor(() => texts(events).includes('[image]'), 'zdjęcie z terminala');
  });

  it('prompt wpisany w terminalu przechodzi zawsze', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('z Raroga');
    await appendFile(filePath(), userLine('z terminala'));
    await waitFor(() => texts(events).includes('z terminala'), 'prompt z terminala');
  });

  it('okno zużywa wpis: drugie echo tego samego tekstu już przechodzi', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('dwa razy');
    await appendFile(filePath(), userLine('dwa razy') + userLine('dwa razy'));
    await waitFor(() => texts(events).includes('dwa razy'), 'drugie wystąpienie');
    await quiet();
    expect(texts(events)).toEqual(['dwa razy']);
  });
});

// ---------------------------------------------------------------------------
// `/clear`
// ---------------------------------------------------------------------------

describe('repoint', () => {
  it('wstawia wiadomość systemową i przepina się na nowy plik', async () => {
    await writeFile(filePath(), userLine('stara sesja'));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.repoint(SESSION_B);
    await waitFor(() => events.slice(before).some((e) => e.type === 'history'), 'komunikat + nowa historia');

    const after = events.slice(before);
    // Pierwsze jest przyznanie się do utraty ciągłości: nowa rozmowa w tym samym panelu,
    // więc rachunek wejść tury przestaje być pełny, zanim przyjdzie cokolwiek z nowego pliku.
    expect(after[0]).toEqual({ type: 'turn-input', lost: true });
    // Nowy uuid MA już plik — to `/resume`, nie `/clear`: komunikat obiecuje historię,
    // która przychodzi zaraz po nim, zamiast kłamać, że rozmowa „została w terminalu".
    expect(after[1]).toEqual({
      type: 'message', role: 'system',
      blocks: [{ type: 'text', text: RESUME_REPOINT_MESSAGE }],
    });
    const newHistory = after.find((e) => e.type === 'history');
    expect(newHistory?.type).toBe('history');
    expect(after.indexOf(newHistory as FollowEvent)).toBeGreaterThan(1);
  });

  it('tailuje nowy plik, a starego już nie czyta', async () => {
    await writeFile(filePath(), userLine('stara sesja'));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.repoint(SESSION_B);
    // Historii NOWEGO pliku szukamy wyłącznie wśród zdarzeń po `repoint()` — inaczej warunek
    // spełnia historia starej sesji, test dopisuje do pliku przed jego zassaniem i dopisek
    // wraca jako `history` zamiast jako wiadomość (test migotałby).
    const gotHistory = (): boolean =>
      events.slice(before).some((e) => e.type === 'history' && e.messages.length > 0);
    await waitFor(gotHistory, 'nowa historia');

    await appendFile(filePath(), userLine('dopisek do starego pliku'));
    await appendFile(filePath(SESSION_B), userLine('dopisek do nowego pliku'));
    await waitFor(() => texts(events).includes('dopisek do nowego pliku'), 'nowy tail');
    await quiet();
    expect(texts(events)).not.toContain('dopisek do starego pliku');
  });

  /**
   * `/clear` wysłany z Raroga nie może dostać komunikatu od `/resume`. CLI zakłada plik nowej
   * sesji NATYCHMIAST (tytuł panelu, tryb, echo komendy) i dopiero potem idzie `session-changed`,
   * więc sam test „plik istnieje" widziałby wznowienie tam, gdzie go nie ma.
   */
  it('nowy plik z samą hydrauliką CLI to `/clear`, nie `/resume`', async () => {
    await writeFile(filePath(), userLine('stara sesja'));
    await writeFile(filePath(SESSION_B), [
      JSON.stringify({ type: 'custom-title', customTitle: 'fixes', sessionId: SESSION_B }),
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION_B }),
      userLine('<local-command-caveat>Caveat…</local-command-caveat>', { isMeta: true }).trim(),
      userLine('<command-name>/clear</command-name>').trim(),
    ].join('\n') + '\n');
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.repoint(SESSION_B);
    await waitFor(() => events.length > before + 1, 'komunikat');
    expect(events[before]).toEqual({ type: 'turn-input', lost: true });
    expect(events[before + 1]).toEqual({
      type: 'message', role: 'system',
      blocks: [{ type: 'text', text: REPOINT_MESSAGE }],
    });
  });

  /*
   * Wpisy komendy lokalnej są notkami `system` z treścią, ale nie wypowiedzią: rozpoznanie
   * `/clear` patrzy na `conversational`. Nowy plik z parą `/clear` z pomiaru (CLI 2.1.302, pusty wynik),
   * z wynikiem innej komendy i z `/new` wpisanym w terminalu dalej nie jest wznowieniem.
   */
  it('nowy plik z komendą, jej wynikiem i `/new` z terminala to dalej `/clear`, a notki idą historią', async () => {
    const clearPair = readFileSync(
      join(import.meta.dirname, 'fixtures/herdr/commands/measured/rename-clear-2.1.302.jsonl'), 'utf8',
    ).split('\n').filter((raw) => raw.trim() !== '').slice(16, 19);
    await writeFile(filePath(), userLine('stara sesja'));
    await writeFile(filePath(SESSION_B), [
      ...clearPair,
      userLine('<command-name>/new</command-name>').trim(),
      userLine('<local-command-stdout>Wyczyszczono rozmowę</local-command-stdout>').trim(),
    ].join('\n') + '\n');
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.repoint(SESSION_B);
    await waitFor(() => events.slice(before).some((e) => e.type === 'history'), 'komunikat + historia');
    expect(events[before + 1]).toEqual({
      type: 'message', role: 'system',
      blocks: [{ type: 'text', text: REPOINT_MESSAGE }],
    });
    const fresh = events.slice(before).find((e): e is Extract<FollowEvent, { type: 'history' }> => e.type === 'history');
    expect(fresh?.messages.map((m) => [m.role, m.blocks.map(blockText).join(' ')])).toEqual([
      ['system', '/clear'], ['system', '/new'], ['system', 'Wyczyszczono rozmowę'],
    ]);
  });

  it('komunikat leci nawet wtedy, gdy nowy plik jeszcze nie powstał', async () => {
    await writeFile(filePath(), userLine('stara sesja'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.repoint(SESSION_B);
    await waitFor(() => texts(events).includes(REPOINT_MESSAGE.text), 'komunikat /clear');

    await createTranscript(filePath(SESSION_B), userLine('pierwszy prompt po /clear'));
    await waitFor(
      () => events.some((e) => e.type === 'history' && e.messages.length === 1),
      'historia nowego pliku',
    );
  });
});

// ---------------------------------------------------------------------------
// Komendy CLI w transkrypcie
// ---------------------------------------------------------------------------

describe('komendy CLI', () => {
  const MEASURED = join(import.meta.dirname, 'fixtures/herdr/commands/measured');
  /** Linie wycinka pomiaru (numeracja jak w edytorze), każda zakończona `\n`. */
  const measured = (name: string, from: number, to = from): string => readFileSync(join(MEASURED, name), 'utf8')
    .split('\n').filter((raw) => raw.trim() !== '').slice(from - 1, to).map((raw) => `${raw}\n`).join('');
  const CONTEXT = (): string => measured('nieznane-sciezki-plan-context-2.1.302.jsonl', 15, 16);
  const PLAN = (): string => measured('nieznane-sciezki-plan-context-2.1.302.jsonl', 12, 14);
  const inputs = (events: readonly FollowEvent[]): FollowEvent[] => events.filter((e) => e.type === 'turn-input');
  const messages = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'message' }>[] =>
    events.filter((e): e is Extract<FollowEvent, { type: 'message' }> => e.type === 'message');
  /** Wywołanie komendy typu prompt jak w `commands/measured/skill-doctor-2.1.294.jsonl`, z argumentami w tagu. */
  const skillCall = (name: string, args: string): string => userLine(
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
    { origin: { kind: 'human' }, turnOrigin: 'human' },
  );

  it('komenda typu prompt z Raroga: echo gaśnie, jedzie `turn-input`, wiadomości nie ma', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('/codex test');
    await appendFile(filePath(), skillCall('codex', 'test'));
    await waitFor(() => inputs(events.slice(before)).length === 1, 'wejście tury');
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);

    // Ta sama komenda wpisana potem w terminalu jest wiadomością człowieka (echo zużyte).
    await appendFile(filePath(), skillCall('codex', 'test'));
    await waitFor(() => texts(events.slice(before)).includes('/codex test'), 'komenda z terminala');
    expect(messages(events.slice(before)).map((m) => m.role)).toEqual(['user']);
  });

  /*
   * Strażnik przepuszcza komendę oddzieloną od argumentów nową linią albo tabulatorem,
   * a CLI trzyma argumenty osobno, więc import składa „/nazwa args” ze spacją. Echo ma się zgodzić i tak.
   */
  it('echo komendy z argumentem po nowej linii albo tabulatorze gaśnie na żywo i w historii', async () => {
    const { follower, events } = start();
    follower.dropEcho('/doctor\nsprawdz instalacje');
    await createTranscript(filePath(), skillCall('doctor', 'sprawdz instalacje'));
    // Historia z samym zgaszonym echem jest pusta, więc zdarzenia `history` nie ma; lista zadań wychodzi po niej.
    await firstTasks(events);
    await quiet();
    expect(events.filter((e) => e.type === 'history' || e.type === 'message')).toEqual([]);
    const before = events.length;

    follower.dropEcho('/Doctor\tdrugi raz\nz nowa linia');
    await appendFile(filePath(), skillCall('doctor', 'drugi raz\nz nowa linia'));
    await waitFor(() => inputs(events.slice(before)).length === 1, 'wejście tury');
    await quiet();
    expect(texts(events.slice(before))).toEqual([]);
  });

  it('komenda lokalna z terminala: dwie notki `system`, wynik z nazwą komendy, bez `turn-input`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    await appendFile(filePath(), CONTEXT());
    await waitFor(() => messages(events.slice(before)).length === 2, 'notki komendy');
    await quiet();
    const [call, output] = messages(events.slice(before));
    expect(call).toEqual({ type: 'message', role: 'system', blocks: [{ type: 'text', text: { text: '/context' } }] });
    expect(output?.role).toBe('system');
    expect(output?.commandOutput).toBe('context');
    expect(inputs(events.slice(before))).toEqual([]);
  });

  it('komenda lokalna z Raroga: wywołanie gaśnie echem (także `/CLEAR` wobec `/clear`), wynik zostaje', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('/CONTEXT');
    await appendFile(filePath(), CONTEXT());
    await waitFor(() => messages(events.slice(before)).length === 1, 'wynik komendy');
    await quiet();
    const only = messages(events.slice(before));
    expect(only.map((m) => [m.role, m.commandOutput])).toEqual([['system', 'context']]);
    expect(inputs(events.slice(before))).toEqual([]);
  });

  it('partie odczytu dzielą parę wywołanie/wynik: wynik wpisem `user` i tak dostaje nazwę komendy', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    const [caveat = '', call = '', output = ''] = PLAN().split('\n').filter((raw) => raw !== '').map((raw) => `${raw}\n`);
    await appendFile(filePath(), caveat + call);
    await waitFor(() => texts(events.slice(before)).includes('/plan'), 'wywołanie');
    // Wynik w dwóch kawałkach: pierwsza połowa linii bez `\n` czeka w buforze followera.
    const half = Math.floor(output.length / 2);
    await appendFile(filePath(), output.slice(0, half));
    await quiet();
    expect(texts(events.slice(before))).toEqual(['/plan']);
    await appendFile(filePath(), output.slice(half));
    await waitFor(() => texts(events.slice(before)).includes('Enabled plan mode'), 'wynik');
    expect(messages(events.slice(before)).map((m) => [m.role, m.commandOutput ?? null])).toEqual([
      ['system', null], ['system', 'plan'],
    ]);
  });

  it('wiadomość między wywołaniem a wynikiem zrywa parę: wynik `/compact` nie dostaje nazwy poprzedniej komendy', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    const before = events.length;

    // `/plan` (wywołanie i wynik), potem `/compact` z terminala: zwykły wpis `user`, wywołanie ukryte
    // regułą `fileEcho` i wynik wpisem `user` bez nazwy.
    await appendFile(filePath(), PLAN() + userLine('/compact')
      + userLine('<command-name>/compact</command-name>')
      + userLine('<local-command-stdout>Compacted</local-command-stdout>'));
    await waitFor(() => texts(events.slice(before)).includes('Compacted'), 'wynik /compact');
    expect(messages(events.slice(before)).map((m) => [m.role, m.blocks.map(blockText).join(' '), m.commandOutput ?? null]))
      .toEqual([
        ['system', '/plan', null], ['system', 'Enabled plan mode', 'plan'], ['user', '/compact', null],
        ['system', 'Compacted', null],
      ]);
  });

  it('historia: komenda wysłana z Raroga przed powstaniem pliku nie wraca drugą kopią, wynik niesie nazwę', async () => {
    const { follower, events } = start();
    follower.dropEcho('/context');
    await createTranscript(filePath(), CONTEXT());
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(history(events).messages.map((m) => [m.role, m.commandOutput ?? null, m.blocks.map(blockText).join(' ').split('\n')[0]]))
      .toEqual([['system', 'context', 'Context Usage']]);
    expect(inputs(events)).toEqual([]);
  });

  it('historia z komendą wpisaną w terminalu: notki bez pola `command` importu', async () => {
    await writeFile(filePath(), userLine('start') + PLAN());
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    const got = history(events).messages;
    expect(got.map((m) => [m.role, m.blocks.map(blockText).join(' ')])).toEqual([
      ['user', 'start'], ['system', '/plan'], ['system', 'Enabled plan mode'],
    ]);
    for (const m of got) expect(m).not.toHaveProperty('command');
  });
});

// ---------------------------------------------------------------------------
// Stan spoza treści: zużycie, meta, czekające narzędzie, brak pliku
// ---------------------------------------------------------------------------

describe('zużycie okna', () => {
  it('rosnące sumy w JEDNEJ partii dają JEDNO zdarzenie — z ostatnią wartością', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(1_000) + usageLine(2_000) + usageLine(3_000));
    await waitFor(() => usages(events).length > 0, 'zużycie');
    await quiet();

    expect(usages(events)).toHaveLength(1);
    // Rozwiązany `claude-fable-5` z tych samych wpisów potwierdza od razu okno 1M.
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 3_000, limit: 1_000_000, source: 'model',
    });
  });

  /**
   * TEST OBOWIĄZKOWY (apka nie może pokazać 94 %, gdy CLI pokazuje 34 %).
   *
   * `preTokens` automatycznej granicy to PRÓG kompakcji, a próg jest ustawieniem
   * (`autoCompactWindow`, `/autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), nie rozmiarem okna.
   * Granica przy 400k w sesji bez znanego okna mówi tylko „400k się zmieściło": stan zostaje
   * `unknown` z dolną granicą, a nie `known` z limitem 400k (340k z 400k to 85 % zamiast 34 %).
   */
  it('auto-kompakcja w historii daje DOLNĄ GRANICĘ, a nie limit okna', async () => {
    await writeFile(
      filePath(),
      userLine('start') + boundaryLine(400_000) + usageLine(340_000, {}, 'claude-opus-5'),
    );
    const { events } = start();
    await waitFor(() => usages(events).length > 0, 'zużycie z historii');
    await quiet();
    expect(usages(events).map((e) => e.context.kind)).not.toContain('known');
    expect(usages(events).at(-1)?.context)
      .toEqual({ kind: 'unknown', tokens: 340_000, atLeast: 400_000 });
  });

  it('auto-kompakcja w historii nie obniża limitu z tabeli modelu', async () => {
    await writeFile(filePath(), userLine('start') + boundaryLine(400_000) + usageLine(340_000));
    const { events } = start();
    await waitFor(() => usages(events).length > 0, 'zużycie z historii');
    await quiet();
    expect(usages(events).at(-1)?.context).toEqual({
      kind: 'known', tokens: 340_000, limit: 1_000_000, source: 'model',
    });
  });

  it('auto-kompakcja na żywo zostawia limit z tabeli modelu', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(400_000));
    await waitFor(() => usages(events).length === 1, 'zużycie z tabeli');
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 400_000, limit: 1_000_000, source: 'model',
    });

    await appendFile(filePath(), boundaryLine(400_000) + usageLine(12_000));
    await waitFor(() => usages(events).length === 2, 'zużycie po kompakcji');
    await quiet();
    expect(usages(events)[1]?.context).toEqual({
      kind: 'known', tokens: 12_000, limit: 1_000_000, source: 'model',
    });
  });

  it('auto-kompakcja na żywo nie potwierdza limitu modelowi spoza tabeli', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(400_000, {}, 'claude-opus-5'));
    await waitFor(() => usages(events).length === 1, 'zużycie bez limitu');
    expect(usages(events)[0]?.context.kind).toBe('unknown');

    await appendFile(filePath(), boundaryLine(400_000) + usageLine(12_000, {}, 'claude-opus-5'));
    await waitFor(() => usages(events).length === 2, 'zużycie po kompakcji');
    await quiet();
    expect(usages(events)[1]?.context)
      .toEqual({ kind: 'unknown', tokens: 12_000, atLeast: 400_000 });
  });

  it('kompakcja ręczna niczego nie potwierdza', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(
      filePath(),
      boundaryLine(120_000, 'manual') + usageLine(9_000, {}, 'claude-opus-5'),
    );
    await waitFor(() => usages(events).length > 0, 'zużycie');
    await quiet();
    // `kind` zostaje `unknown` — LIMITU ręczna kompakcja nie potwierdza. `atLeast` to co innego:
    // nie „okno ma 120k", tylko „120k już się w nim zmieściło" (patrz `compactPreTokensFrom`).
    expect(usages(events).at(-1)?.context)
      .toEqual({ kind: 'unknown', tokens: 9_000, atLeast: 120_000 });
  });

  /**
   * TEST OBOWIĄZKOWY (licznik po `/compact` nie może stać na wartości sprzed cięcia).
   *
   * Po `/compact` następny wpis `assistant` powstaje dopiero przy KOLEJNYM prompcie, więc bez
   * czytania `postTokens` widget wisiałby na sumie sprzed cięcia — pokazując pełne okno w chwili,
   * w której okno właśnie zostało opróżnione. Tu po granicy nie ma ani jednej wypowiedzi
   * silnika i licznik i tak musi spaść.
   */
  it('ręczny `/compact` zbija licznik OD RAZU, bez czekania na odpowiedź silnika', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(690_000));
    await waitFor(() => usages(events).length === 1, 'zużycie przed kompakcją');
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 690_000, limit: 1_000_000, source: 'model',
    });

    await appendFile(filePath(), boundaryLine(690_000, 'manual'));
    await waitFor(() => usages(events).length === 2, 'zużycie po kompakcji');
    await quiet();
    // Limit z modelu zostaje (ręczna kompakcja go nie rusza), zmienia się SAMA liczba tokenów.
    expect(usages(events)[1]?.context).toEqual({
      kind: 'known', tokens: 14_002, limit: 1_000_000, source: 'model',
    });
  });

  /**
   * TEST OBOWIĄZKOWY (panel Opusa po `/compact` z nieznanym limitem okna).
   *
   * Model spoza `KNOWN_CONTEXT_LIMITS` i wyłącznie ręczne kompakcje = limit zostaje NIEZNANY
   * na zawsze. Ale `preTokens` własnej granicy dowodzi, że okno tej sesji uniosło 690k — i ta
   * liczba musi dojechać do klienta RAZEM ze stanem po cięciu, bo to ona decyduje, od czego
   * PWA liczy procent.
   */
  it('ręczna kompakcja podnosi dolną granicę okna, choć limitu nie potwierdza', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(690_000, {}, 'claude-opus-5'));
    await waitFor(() => usages(events).length === 1, 'zużycie przed kompakcją');
    expect(usages(events)[0]?.context)
      .toEqual({ kind: 'unknown', tokens: 690_000, atLeast: 690_000 });

    await appendFile(filePath(), boundaryLine(690_000, 'manual'));
    await waitFor(() => usages(events).length === 2, 'zużycie po kompakcji');
    await quiet();
    // Tokeny spadają, wiedza o pojemności zostaje — i `kind` nadal uczciwie mówi „nie wiem".
    expect(usages(events).at(-1)?.context)
      .toEqual({ kind: 'unknown', tokens: 14_002, atLeast: 690_000 });
  });

  it('model podany przez Raroga daje limit od pierwszej sumy', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ knownContextLimit: 200_000 });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    // Model spoza tabeli — limit ma pochodzić WYŁĄCZNIE z flagi, którą podał Rarog.
    await appendFile(filePath(), usageLine(5_000, {}, 'claude-opus-5'));
    await waitFor(() => usages(events).length > 0, 'zużycie');
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 5_000, limit: 200_000, source: 'model',
    });
  });
});

describe('meta (model, effort, tryb)', () => {
  it('leci raz przy zmianie i milknie, gdy wartości się powtarzają', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(100, { effort: 'high' }));
    await waitFor(() => metas(events).length > 0, 'meta');
    await quiet();
    expect(metas(events)).toHaveLength(1);
    expect(metas(events)[0]).toEqual({ type: 'meta', model: 'claude-fable-5', effort: 'high' });

    // Ta sama tura z tym samym modelem i effortem — pigułka modelu nie ma migotać.
    await appendFile(filePath(), usageLine(200, { effort: 'high' }));
    await waitFor(() => usages(events).length === 2, 'druga tura');
    await quiet();
    expect(metas(events)).toHaveLength(1);
  });

  it('a mode change from jsonl goes as its own event and carries only the mode', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(100, { effort: 'low' }));
    await waitFor(() => metas(events).length === 1, 'meta modelu');

    await appendFile(
      filePath(),
      `${JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' })}\n`,
    );
    await waitFor(() => metas(events).length === 2, 'meta trybu');
    // Only the fresh field: an old model and effort would overwrite a live change already on the card.
    expect(metas(events)[1]).toEqual({
      type: 'meta', mode: 'bypass',
    });
  });
});

describe('ultracode bieżącego procesu CLI', () => {
  const ULTRACODE = join(import.meta.dirname, 'fixtures', 'herdr', 'ultracode');
  /** Wycinek z pomiaru 2.1.318: start z flagą, `ultra_effort_enter` w linii 22 (00:00:29.103). */
  const startFlaga = (): string => readFileSync(join(ULTRACODE, 'start-flaga.jsonl'), 'utf8');
  const PROCESS_START = Date.parse('2026-01-01T00:00:00.000Z');
  const withUltracode = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'meta' }>[] =>
    metas(events).filter((meta) => 'ultracode' in meta);

  it('załącznik z historii liczy się po starcie procesu z rejestru: meta niesie `ultracode: true`', async () => {
    await writeFile(filePath(), startFlaga());
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    // Rarog po restarcie adoptuje panel: ten sam proces CLI, fakt startu przychodzi z rejestru po odczycie pliku.
    expect(withUltracode(events)).toEqual([]);
    follower.noteProcessStart(PROCESS_START);
    await waitFor(() => withUltracode(events).length === 1, 'meta z ultracode');
    expect(withUltracode(events)[0]).toMatchObject({ type: 'meta', ultracode: true });
  });

  it('znacznik sprzed startu procesu (historia poprzedniego procesu przy `--resume`) niczego nie daje', async () => {
    await writeFile(filePath(), startFlaga());
    const { follower, events } = start();
    follower.noteProcessStart(Date.parse('2026-01-01T00:01:00.000Z'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await quiet();
    expect(metas(events).length).toBeGreaterThan(0);
    expect(withUltracode(events)).toEqual([]);
  });

  it('nowy proces CLI tej rozmowy (`/exit`, `claude --resume` przy biurku): meta niesie `ultracode: null`', async () => {
    await writeFile(filePath(), startFlaga());
    const { follower, events } = start();
    follower.noteProcessStart(PROCESS_START);
    await waitFor(() => withUltracode(events).length === 1, 'meta z ultracode');
    // Rejestr podał późniejszy start: ten sam plik pisze nowy proces, a załącznik mówi o poprzednim.
    follower.noteProcessStart(Date.parse('2026-01-01T00:01:00.000Z'));
    await waitFor(() => withUltracode(events).length === 2, 'meta po restarcie procesu');
    expect(withUltracode(events)[1]).toEqual({ type: 'meta', ultracode: null });
  });

  it('żądanie bez znacznika w pierwszej turze: odpowiedź modelu daje `ultracode: false`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.noteUltracodeRequest(Date.parse('2026-08-22T10:00:01.000Z'));
    await appendFile(filePath(), userLine('zrób plan', {
      timestamp: '2026-08-22T10:00:02.000Z', origin: { kind: 'human' },
    }));
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'ok' }]));
    await waitFor(() => withUltracode(events).length === 1, 'meta z ultracode');
    expect(withUltracode(events)[0]).toMatchObject({ model: 'claude-fable-5', ultracode: false });
  });

  it('żądanie bez reguły pierwszej tury (wznowienie z flagą): ta sama odpowiedź nie daje `false`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.noteUltracodeRequest(Date.parse('2026-08-22T10:00:01.000Z'), false);
    await appendFile(filePath(), userLine('zrób plan', {
      timestamp: '2026-08-22T10:00:02.000Z', origin: { kind: 'human' },
    }));
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'ok' }]));
    await waitFor(() => metas(events).some((meta) => meta.model === 'claude-fable-5'), 'meta odpowiedzi');
    expect(withUltracode(events)).toEqual([]);
  });

  it('nowa rozmowa w panelu (`/clear`): pole znika, póki jej plik nic nie powie', async () => {
    await writeFile(filePath(), startFlaga());
    await writeFile(filePath(SESSION_B), userLine('nowa sesja') + assistantLine([{ type: 'text', text: 'ok' }]));
    const { follower, events } = start();
    follower.noteProcessStart(PROCESS_START);
    await waitFor(() => withUltracode(events).length === 1, 'ultracode starej rozmowy');
    const before = events.length;
    follower.repoint(SESSION_B);
    await waitFor(() => metas(events.slice(before)).length > 0, 'meta nowej rozmowy');
    expect(metas(events.slice(before)).every((meta) => !('ultracode' in meta))).toBe(true);
  });

  describe('nowy proces spoza Raroga: drugi start w tym samym followerze', () => {
    /** Wycinek z pomiaru 2.1.318: `--resume … --effort ultracode`, pierwsza tura (00:02:11.522) bez znacznika. */
    const wznowienie = (): string => readFileSync(join(ULTRACODE, 'wznowienie-z-flaga.jsonl'), 'utf8');
    const RESUME_REQUEST = Date.parse('2026-01-01T00:02:08.000Z');
    const RESUME_START = Date.parse('2026-01-01T00:02:09.000Z');

    it('wznowienie z flagą bez znacznika, potem `/exit` i `claude --resume` przy biurku: meta z `null`', async () => {
      await writeFile(filePath(), wznowienie());
      const { follower, events } = start();
      // Rarog wznowił rozmowę z flagą: karta ma żądane `true`, reguły pierwszej tury nie ma.
      follower.noteUltracodeRequest(RESUME_REQUEST, false);
      follower.noteProcessStart(RESUME_START);
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
      await quiet();
      expect(withUltracode(events)).toEqual([]);

      follower.noteProcessStart(Date.parse('2026-01-01T00:05:00.000Z'));
      await waitFor(() => withUltracode(events).length === 1, 'meta po nowym procesie');
      expect(withUltracode(events)[0]).toEqual({ type: 'meta', ultracode: null });
    });

    it('komenda włączenia młodsza od startu poprzedniego procesu zostaje żądaniem', async () => {
      await writeFile(filePath(), wznowienie());
      const { follower, events } = start();
      follower.noteUltracodeRequest(RESUME_REQUEST, false);
      follower.noteProcessStart(RESUME_START);
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
      // `/effort ultracode` z apki o 00:03:00; rejestr podaje start nowego procesu (00:02:30) dopiero po komendzie.
      follower.noteUltracodeRequest(Date.parse('2026-01-01T00:03:00.000Z'));
      follower.noteProcessStart(Date.parse('2026-01-01T00:02:30.000Z'));
      await quiet();
      expect(withUltracode(events)).toEqual([]);
      // Żądanie zostało: odpowiedź na pierwszy prompt po komendzie bez załącznika daje `false`.
      await appendFile(filePath(), userLine('zrób plan', {
        timestamp: '2026-01-01T00:03:01.000Z', origin: { kind: 'human' },
      }) + assistantLine([{ type: 'text', text: 'ok' }], { timestamp: '2026-01-01T00:03:02.000Z' }));
      await waitFor(() => withUltracode(events).length === 1, 'meta z ultracode');
      expect(withUltracode(events)[0]).toMatchObject({ ultracode: false });
    });
  });

  /*
   * Luka w odczycie (przeskok ponad sufit, skrócenie pliku): pominięty kawałek mógł nieść wynik `Ultracode off`
   * i `ultra_effort_exit`, a kolejne tury znacznika nie powtarzają. Wycinek `komendy-w-bezczynnosci.jsonl`, linie
   * 3–14: wynik `off` (00:00:34.696) i tura z `ultra_effort_exit` (00:00:38.533).
   */
  describe('luka w odczycie unieważnia znany stan', () => {
    const MAX = 8_000;
    const offLines = (): string => readFileSync(join(ULTRACODE, 'komendy-w-bezczynnosci.jsonl'), 'utf8')
      .split('\n').slice(2, 14).map((line) => `${line}\n`).join('');
    const padding = (): string => userLine('x'.repeat(MAX * 2), { isMeta: true });
    const turn = (): string => userLine('dalej', { timestamp: '2026-01-01T00:01:00.000Z', origin: { kind: 'human' } })
      + assistantLine([{ type: 'text', text: 'ok' }], { timestamp: '2026-01-01T00:01:05.000Z' });
    /** Start z flagą przeczytany, start procesu znany: karta ma `ultracode: true` z dowodu. */
    const withEvidence = async (): Promise<{ follower: JsonlFollower; events: FollowEvent[] }> => {
      await writeFile(filePath(), startFlaga());
      const started = start({ maxReadBytes: MAX });
      started.follower.noteProcessStart(PROCESS_START);
      await waitFor(() => withUltracode(started.events).at(-1)?.ultracode === true, 'meta z ultracode');
      return started;
    };

    it('przeskok przez wyłączenie, potem tury bez znaczników: meta niesie `ultracode: null`', async () => {
      const { events } = await withEvidence();
      await appendFile(filePath(), offLines() + padding() + turn());
      await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
      await waitFor(() => withUltracode(events).at(-1)?.ultracode === null, 'meta po luce');
      expect(withUltracode(events).at(-1)).toMatchObject({ model: 'claude-fable-5', ultracode: null });
    });

    it('ogon po przeskoku niesie znacznik: jedna wypłata z jego wartością, bez `null` po drodze', async () => {
      const { events } = await withEvidence();
      const before = events.length;
      await appendFile(filePath(), padding() + offLines());
      await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
      await waitFor(() => withUltracode(events).at(-1)?.ultracode === false, 'meta ze znacznika ogona');
      await quiet();
      expect(withUltracode(events.slice(before)).map((meta) => meta.ultracode)).toEqual([false]);
    });

    it('luka bez stanu i bez żądania: zdarzenia `meta` nie ma', async () => {
      await writeFile(filePath(), userLine('start'));
      const { events } = start({ maxReadBytes: MAX });
      await primed(events);
      const before = events.length;
      await appendFile(filePath(), offLines() + padding() + userLine('dalej', { origin: { kind: 'human' } }));
      await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
      await quiet();
      expect(metas(events.slice(before))).toEqual([]);
    });

    it('skrócenie pliku: meta niesie `ultracode: null`', async () => {
      const { events } = await withEvidence();
      await createTranscript(filePath(), userLine('a'));
      await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
      await waitFor(() => withUltracode(events).at(-1)?.ultracode === null, 'meta po skróceniu');
    });
  });
});

describe('czekające narzędzie', () => {
  it('pojawia się i znika — DOKŁADNIE dwa zdarzenia', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), toolUseLine('t-1', 'Bash', { command: 'pnpm test' }));
    await waitFor(() => pendings(events).length === 1, 'pending');
    expect(pendings(events)[0]?.pending).toMatchObject({
      id: 't-1', toolName: 'Bash', input: { command: 'pnpm test' },
    });

    await appendFile(filePath(), toolResultLine('t-1'));
    await waitFor(() => pendings(events).length === 2, 'koniec czekania');
    await quiet();
    expect(pendings(events)[1]?.pending).toBeNull();
    expect(pendings(events)).toHaveLength(2);
  });

  it('historia z niedomkniętym `tool_use` oddaje pending od razu przy podpięciu', async () => {
    await writeFile(
      filePath(),
      userLine('zrób to') + toolUseLine('t-7', 'Edit', { file_path: '/Users/u/Projects/atlas/a.ts' }),
    );
    const { events } = start();
    await waitFor(() => pendings(events).length > 0, 'pending z historii');
    expect(pendings(events)[0]?.pending?.id).toBe('t-7');
    // Kolejność: najpierw historia, dopiero potem stan pliku PO tej historii.
    expect(events.findIndex((e) => e.type === 'history'))
      .toBeLessThan(events.findIndex((e) => e.type === 'pending'));
  });

  /**
   * Skrócony plik to inna zawartość, a `tool_use` sprzed cięcia nigdy
   * nie dostanie `tool_result` — bez resetu trackera karta zgody stałaby jako widmo do `/clear`.
   */
  it('skrócenie pliku w środku otwartego `tool_use` gasi czekające narzędzie', async () => {
    await writeFile(filePath(), userLine('start') + toolUseLine('t-1', 'Bash', { command: 'ls' }));
    const { events } = start();
    await waitFor(() => pendings(events).length === 1, 'pending z historii');
    expect(pendings(events)[0]?.pending?.id).toBe('t-1');

    await writeFile(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => pendings(events).length === 2, 'wygaszenie po skróceniu');
    await quiet();
    expect(pendings(events)[1]?.pending).toBeNull();
    expect(pendings(events)).toHaveLength(2);
  });

  it('`/clear` kasuje czekające narzędzie poprzedniej sesji', async () => {
    await writeFile(filePath(), toolUseLine('t-1', 'Bash', {}));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja'));
    const { follower, events } = start();
    await waitFor(() => pendings(events).length === 1, 'pending');

    follower.repoint(SESSION_B);
    await waitFor(() => pendings(events).length === 2, 'wygaszenie pendingu');
    expect(pendings(events)[1]?.pending).toBeNull();
  });

  /**
   * `pending: null` emitowane przez `repoint()` NATYCHMIAST, zanim odczyt historii nowego pliku
   * przywróci prawdę, kazałoby driverowi oceniać panel „na ślepo" i degradować stojącą kartę
   * zgody do fallbacku bez przycisków. `null` po repoint jest więc odroczony: prawdę emituje historia, karencja zostaje
   * wyłącznie na `/clear` bez nowego pliku.
   */
  it('repoint nie mruga `null`, gdy nowy plik ma czekające narzędzie', async () => {
    await writeFile(filePath(), toolUseLine('t-1', 'Bash', {}));
    await writeFile(
      filePath(SESSION_B), userLine('start') + toolUseLine('t-2', 'Bash', { command: 'ls' }),
    );
    const { follower, events } = start();
    await waitFor(() => pendings(events).length === 1, 'pending starej sesji');

    follower.repoint(SESSION_B);
    await waitFor(() => pendings(events).length === 2, 'pending nowej sesji');
    await quiet();
    expect(pendings(events)[1]?.pending?.id).toBe('t-2');
    expect(pendings(events).some((p) => p.pending === null)).toBe(false);
  });

  it('repoint bez nowego pliku gasi czekające narzędzie dopiero po karencji', async () => {
    await writeFile(filePath(), toolUseLine('t-1', 'Bash', {}));
    const { follower, events } = start({
      timing: { ...TIMING, pendingRepointGraceMs: 120 },
    });
    await waitFor(() => pendings(events).length === 1, 'pending');

    follower.repoint(SESSION_B);
    await quiet();
    // Okno karencji: `null` jeszcze NIE wyszedł — driver trzyma dotychczasową kartę.
    expect(pendings(events)).toHaveLength(1);
    await waitFor(() => pendings(events).length === 2, 'wygaszenie po karencji');
    expect(pendings(events)[1]?.pending).toBeNull();
  });
});

describe('okno kontekstu ze status line', () => {
  /** Zrzut payloadu, jaki `~/.claude/statusline.sh` zostawia dla sesji silnika. */
  const dumpStatusline = async (size: number, session = SESSION): Promise<void> => {
    const dir = join(root, 'statusline');
    await mkdir(dir, { recursive: true });
    // Atomowo z tego samego powodu co `createTranscript`: drugi test dokłada zrzut POD ŻYWYM
    // followerem, a plik widziany w połowie zapisu to niepoprawny JSON, czyli limit „nieznany".
    await createTranscript(join(dir, `${session}.json`), JSON.stringify({
      session_id: session,
      model: { id: 'claude-opus-5' },
      context_window: { context_window_size: size, used_percentage: 5 },
    }));
  };

  /**
   * TEST OBOWIĄZKOWY — limit okna ze zrzutu silnika.
   *
   * `claude-opus-5` nie jest w `KNOWN_CONTEXT_LIMITS` i nigdy nie będzie (wariantu 1M nie da się
   * poznać po identyfikatorze), więc bez zrzutu ta sesja zostaje `unknown` i PWA liczy procent od
   * ZAŁOŻONYCH 200k. Zrzut zamienia założenie w odpowiedź silnika: 100k z miliona to 10%,
   * a nie 50%.
   */
  it('rozmiar okna ze zrzutu POTWIERDZA limit, którego jsonl nie zna', async () => {
    await dumpStatusline(1_000_000);
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ statuslineRoot: join(root, 'statusline') });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(100_000, {}, 'claude-opus-5'));
    await waitFor(
      () => usages(events).some((e) => e.context.kind === 'known'),
      'limit ze status line',
    );
    expect(usages(events).at(-1)?.context).toEqual({
      kind: 'known', tokens: 100_000, limit: 1_000_000, source: 'statusline',
    });
  });

  /**
   * TEST OBOWIĄZKOWY (limit okna w apce nie może skakać po ~2 s).
   *
   * Zrzut leżący na dysku w chwili podpięcia czytamy razem z historią, a nie dopiero z pierwszego
   * ticku `stat`: inaczej pierwszy stan, który jedzie do apki, ma limit z innego źródła, a po
   * chwili skacze. Długi tik wyklucza, że zdąży on przed pierwszą wypłatą.
   */
  it('zrzut obecny przy podpięciu daje limit już w PIERWSZYM stanie okna', async () => {
    await dumpStatusline(1_000_000);
    await writeFile(
      filePath(),
      userLine('start') + boundaryLine(400_000) + usageLine(340_000, {}, 'claude-opus-5'),
    );
    const { events } = start({
      statuslineRoot: join(root, 'statusline'), timing: { ...TIMING, statTickMs: 5_000 },
    });
    await waitFor(() => usages(events).length > 0, 'zużycie z historii');
    await quiet();
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 340_000, limit: 1_000_000, source: 'statusline',
    });
    expect(usages(events)).toHaveLength(1);
  });

  /**
   * Odpowiedź silnika bije dolną granicę z auto-kompakcji, i to także w dół. Sesja przełączona
   * `/model` na wariant 200k naprawdę ma mniejsze okno niż przed chwilą — a granica kompakcji
   * opisuje tylko to, co się kiedyś zmieściło.
   */
  it('zrzut bije dolną granicę z kompakcji, także gdy jest MNIEJSZY', async () => {
    await writeFile(filePath(), userLine('start') + boundaryLine(900_000, 'auto'));
    const { events } = start({ statuslineRoot: join(root, 'statusline') });
    await waitFor(() => usages(events).length > 0, 'stan z kompakcji');
    expect(usages(events)[0]?.context)
      .toEqual({ kind: 'unknown', tokens: 14_002, atLeast: 900_000 });

    await dumpStatusline(200_000);
    await appendFile(filePath(), usageLine(50_000, {}, 'claude-opus-5'));
    await waitFor(
      () => usages(events).some((e) => e.context.kind === 'known' && e.context.limit === 200_000),
      'limit ze status line',
    );
    expect(usages(events).at(-1)?.context).toEqual({
      kind: 'known', tokens: 50_000, limit: 200_000, source: 'statusline',
    });
  });

  /**
   * TEST OBOWIĄZKOWY. Brak zrzutu jest normalnym stanem (panel spoza tej maszyny, sesja bez
   * renderu stopki) i NIE MOŻE niczego psuć — Rarog zostaje przy dotychczasowym szacunku.
   */
  it('brak zrzutu zostawia stan nietknięty', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ statuslineRoot: join(root, 'nie-ma-takiego') });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), usageLine(100_000, {}, 'claude-opus-5'));
    await waitFor(() => usages(events).length > 0, 'zużycie');
    await quiet();
    expect(usages(events).at(-1)?.context).toEqual({
      kind: 'unknown', tokens: 100_000, atLeast: 100_000,
    });
  });
});

describe('zadania w tle', () => {
  /**
   * TEST OBOWIĄZKOWY. Zadanie odpalone PRZED podpięciem Raroga (a więc przed każdym restartem
   * serwera) musi wstać z okna ogona — inaczej plakietka pojawiałaby się dopiero przy następnym
   * zadaniu, czyli nigdy w sesji, która właśnie coś mieli.
   */
  it('start z ogona pliku wstaje przy podpięciu, jednym zdarzeniem', async () => {
    await writeFile(filePath(), userLine('start') + backgroundStart('b28xs0cd6'));
    const { events } = start();
    await waitFor(() => taskEvents(events).length > 0, 'zadania');
    await quiet();

    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.tasks).toEqual([{
      id: 'b28xs0cd6',
      kind: 'command',
      description: 'Testy',
      command: 'pnpm test',
      startedAt: '2026-08-22T10:00:00.000Z',
    }]);
  });

  /*
   * Wymiana drivera (powrót gniazda herdr) zachowuje sesję razem z listą poprzedniego followera. Nowy follower
   * ze startowym pustym podpisem nie wysłałby pustej listy nigdy: karta zostałaby z zadaniami
   * poprzedniej rozmowy albo zadaniem, które skończyło się tuż przed wymianą.
   */
  it('pierwsza wypłata po podpięciu idzie zawsze, także pusta: raz, potem tylko zmiany', async () => {
    await writeFile(filePath(), userLine('start') + backgroundStart('b1') + backgroundDone('b1'));
    const { events } = start();
    await firstTasks(events);
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'mielę' }]));
    await quiet();
    expect(taskEvents(events)).toEqual([{ type: 'tasks', tasks: [], since: '2026-08-22T10:00:00.000Z' }]);
  });

  it('bez pliku rozmowy: pusta pierwsza wypłata po pudle globu, plik bez zadań nic nie dokłada', async () => {
    const { events } = start();
    await firstTasks(events);
    // Kolejne pudła globu (tick co kilka ms) nie wypłacają nic.
    await quiet();
    expect(taskEvents(events)).toEqual([{ type: 'tasks', tasks: [] }]);
    await createTranscript(filePath(), userLine('pierwszy prompt'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia nowego pliku');
    await quiet();
    expect(taskEvents(events)).toHaveLength(1);
    // Zadanie w pliku, który powstał, jedzie jak każda zmiana.
    await appendFile(filePath(), backgroundStart('b1'));
    await waitFor(() => taskEvents(events).length === 2, 'start zadania');
    expect(taskEvents(events)[1]?.tasks.map((task) => task.id)).toEqual(['b1']);
  });

  it('skrócenie pliku przed pierwszą wypłatą jej nie kasuje', async () => {
    await writeFile(filePath(), userLine('start'));
    // Długie okno partii: skrócenie wpada, zanim pierwsza wypłata zdąży wyjść.
    const { events } = start({ timing: { ...TIMING, batchMs: 150 } });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await createTranscript(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await quiet();
    expect(taskEvents(events)).toEqual([{ type: 'tasks', tasks: [] }]);
  });

  /** `repoint` między uzbrojeniem a zrzutem pierwszej wypłaty. */
  it('`repoint` przed pierwszą wypłatą: wychodzi jedna lista, z zadaniami nowej rozmowy', async () => {
    await writeFile(filePath(), userLine('start'));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja', { timestamp: '2026-08-22T11:00:00.000Z' })
      + backgroundStart('bnowa'));
    // Długie okno partii: `repoint` i otwarcie nowego pliku wpadają, zanim pierwsza wypłata zdąży wyjść.
    const { follower, events } = start({ timing: { ...TIMING, batchMs: 150 } });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.repoint(SESSION_B);
    await firstTasks(events);
    await quiet();
    expect(taskEvents(events).map((event) => [event.tasks.map((task) => task.id), event.since]))
      .toEqual([[['bnowa'], '2026-08-22T11:00:00.000Z']]);
  });

  it('na żywo: zdarzenie leci przy KAŻDEJ zmianie listy i milczy, gdy nic się nie zmienia', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);

    await appendFile(filePath(), backgroundStart('b1'));
    await waitFor(() => taskChanges(events).length === 1, 'start');

    // Zwykła wypowiedź listy nie rusza — i nie ma prawa wywołać zdarzenia.
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'mielę' }]));
    await quiet();
    expect(taskChanges(events)).toHaveLength(1);

    await appendFile(filePath(), backgroundDone('b1'));
    await waitFor(() => taskChanges(events).length === 2, 'koniec');
    expect(taskChanges(events)[1]?.tasks).toEqual([]);
  });

  /**
   * TEST OBOWIĄZKOWY — i to on ujawnił WYŚCIG, który siedział w followerze od początku.
   *
   * Po `/clear` zadania poprzedniej sesji silnika nie mają jak się domknąć (ich powiadomienia
   * pojadą do STAREGO pliku), więc plakietka musi zgasnąć razem z rozmową, tak jak karta zgody.
   * Zanim `repoint()` zaczął podbijać numer pokolenia, ten test padał w ~60% przebiegów: między
   * resetem stanu a otwarciem nowego pliku (`await` w `#repoint`) `#path` wskazywał jeszcze
   * stary plik przy `#offset` już wyzerowanym, a tik `stat` wpadający w tę szczelinę wczytywał
   * całą poprzednią rozmowę OD ZERA — jako wiadomości „na żywo" w nowej sesji.
   */
  it('`/clear` gasi plakietkę poprzedniej sesji silnika', async () => {
    await writeFile(filePath(), backgroundStart('b1'));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja'));
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'start');

    follower.repoint(SESSION_B);
    await waitFor(() => taskEvents(events).length === 2, 'wygaszenie');
    expect(taskEvents(events)[1]?.tasks).toEqual([]);
  });

  /**
   * Druga twarz „karty-widma", tym razem dla plakietki. Skrócenie pliku przestawia `#offset`
   * na nowy rozmiar, czyli świadomie POMIJA wszystko poniżej — a `<\task-notification>`
   * i `TaskOutput` otwartego zadania leżą właśnie tam i nigdy nie zostaną odczytane. Wpis bez
   * domknięcia jest cichy i trwały: `doneOrSilence()` zwraca `null` dopóki `backgroundTasks > 0`,
   * więc taka sesja do końca życia nie dostaje ani jednego pusha „gotowe".
   */
  it('skrócenie pliku w środku otwartego zadania gasi plakietkę', async () => {
    await writeFile(filePath(), userLine('start') + backgroundStart('b1'));
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'start zadania');
    expect(taskEvents(events)[0]?.tasks).toHaveLength(1);

    await writeFile(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => taskEvents(events).length === 2, 'wygaszenie po skróceniu');
    await quiet();
    expect(taskEvents(events)[1]?.tasks).toEqual([]);
    expect(taskEvents(events)).toHaveLength(2);
  });

  /**
   * TEST OBOWIĄZKOWY. Postój i wznowienie subagenta nie zmieniają listy
   * identyfikatorów — zmienia się samo `waitingSince`. Podpis z samych id (stan do tej daty)
   * nie wypuściłby żadnego z tych przejść i apka nie dowiedziałaby się, że agent stanął.
   */
  it('zmiana samego `waitingSince` jedzie na drut: postój, kolejny postój, wznowienie', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);

    await appendFile(filePath(), agentStart('a52b91f105b002e8d'));
    await waitFor(() => taskChanges(events).length === 1, 'start agenta');
    const working = taskChanges(events)[0]?.tasks[0];
    expect(working).not.toHaveProperty('waitingSince');

    const first = agentStopped('a52b91f105b002e8d', STANDBY_NOTE, 1);
    await appendFile(filePath(), queued(first, '2026-08-22T10:11:00.000Z'));
    await waitFor(() => taskChanges(events).length === 2, 'postój');
    expect(taskChanges(events)[1]?.tasks.map((task) => [task.id, task.waitingSince]))
      .toEqual([['a52b91f105b002e8d', '2026-08-22T10:11:00.000Z']]);

    // Kopia tego samego meldunku (wpis `user`, kilkanaście ms później) niczego nie wysyła.
    await appendFile(filePath(), userLine(first, {
      origin: { kind: 'task-notification' }, timestamp: '2026-08-22T10:11:00.014Z',
    }));
    await quiet();
    expect(taskChanges(events)).toHaveLength(2);

    // Agent sam ruszył i stanął znowu: ten sam zestaw id, nowy czas.
    await appendFile(filePath(), queued(agentStopped('a52b91f105b002e8d', STANDBY_NOTE, 2), '2026-08-22T10:12:30.000Z'));
    await waitFor(() => taskChanges(events).length === 3, 'kolejny postój');
    expect(taskChanges(events)[2]?.tasks[0]?.waitingSince).toBe('2026-08-22T10:12:30.000Z');

    await appendFile(filePath(), userLine([{ type: 'tool_result', tool_use_id: 'toolu_send', content: '' }], {
      toolUseResult: { message: 'Resuming agent a52b91f', pin: false, resumedAgentId: 'a52b91f105b002e8d', success: true },
    }));
    await waitFor(() => taskChanges(events).length === 4, 'wznowienie');
    expect(taskChanges(events)[3]?.tasks).toEqual([working]);

    // Zdarzenie opisuje chwilę, w której powstało: obiekt wysłany przy starcie nie dostał postoju.
    expect(taskChanges(events)[0]?.tasks[0]).toBe(working);
    expect(working).not.toHaveProperty('waitingSince');
    expect(taskChanges(events)[1]?.tasks[0]?.waitingSince).toBe('2026-08-22T10:11:00.000Z');
  });

  /**
   * TEST OBOWIĄZKOWY. Koniec WŁASNEJ komendy subagenta stoi
   * w kolejce pliku głównego, ale jej start stoi w pliku subagenta, więc lista zadań followera
   * się przy nim nie zmienia. Bez osobnego zdarzenia nikt poza reduktorem
   * o takim zamknięciu by nie wiedział, więc jedzie w `tasks` jako `ended`: przyrost, nie całość.
   */
  it('koniec bez startu jedzie w `tasks` jako `ended`, choć lista się nie zmieniła', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);

    await appendFile(filePath(), agentStart('a52b91f105b002e8d'));
    await waitFor(() => taskChanges(events).length === 1, 'start agenta');
    expect(taskChanges(events)[0]).not.toHaveProperty('ended');

    await appendFile(filePath(), backgroundDone('bwlasna1'));
    await waitFor(() => taskChanges(events).length === 2, 'koniec bez startu');
    expect(taskChanges(events)[1]?.ended).toEqual(['bwlasna1']);
    expect(taskChanges(events)[1]?.tasks).toEqual(taskChanges(events)[0]?.tasks);

    // Kopia tego samego meldunku (wpis `remove` kolejki ma tę samą treść) niczego nie wysyła.
    await appendFile(filePath(), backgroundDone('bwlasna1'));
    await quiet();
    expect(taskChanges(events)).toHaveLength(2);

    // Dwa końce i zmiana listy w jednej partii: jedno zdarzenie, a w nim wyłącznie NOWE id.
    await appendFile(filePath(), backgroundDone('bwlasna2') + backgroundDone('bwlasna3') + backgroundStart('b1'));
    await waitFor(() => taskChanges(events).length === 3, 'partia');
    expect(taskChanges(events)[2]?.ended).toEqual(['bwlasna2', 'bwlasna3']);
    expect(taskChanges(events)[2]?.tasks.map((task) => task.id)).toEqual(['a52b91f105b002e8d', 'b1']);

    // Zwykła zmiana listy po tym wszystkim nie niesie starych końców.
    await appendFile(filePath(), backgroundDone('b1'));
    await waitFor(() => taskChanges(events).length === 4, 'koniec zadania ze startem');
    expect(taskChanges(events)[3]).not.toHaveProperty('ended');
  });

  it('koniec bez startu z ogona pliku wychodzi przy podpięciu, także przy pustej liście', async () => {
    await writeFile(filePath(), userLine('start') + backgroundDone('bwlasna1'));
    const { events } = start();
    await waitFor(() => taskEvents(events).length > 0, 'końce z ogona');
    await quiet();
    expect(taskEvents(events)).toEqual([
      { type: 'tasks', tasks: [], ended: ['bwlasna1'], since: '2026-08-22T10:00:00.000Z' },
    ]);
  });

  /**
   * `since`: od kiedy reduktor widzi plik główny. Odbiorca (własne komendy subagentów) nie pokazuje
   * komendy wystartowanej wcześniej, bo jej koniec mógł stać w pliku, zanim follower zaczął patrzeć.
   * Jedzie w każdym zdarzeniu `tasks`, a po zerowaniu reduktora liczy się od pierwszego nowego wpisu.
   */
  it('`tasks` niesie `since`: czas pierwszego wpisu okna, po skróceniu pliku liczony od nowa', async () => {
    await writeFile(
      filePath(),
      userLine('start', { timestamp: '2026-08-22T09:00:00.000Z' }) + agentStart('a52b91f105b002e8d'),
    );
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'start agenta z ogona');
    expect(taskEvents(events)[0]?.since).toBe('2026-08-22T09:00:00.000Z');

    // Późniejszy wpis początku okna nie przesuwa.
    await appendFile(filePath(), backgroundStart('b1'));
    await waitFor(() => taskEvents(events).length === 2, 'start komendy');
    expect(taskEvents(events)[1]?.since).toBe('2026-08-22T09:00:00.000Z');

    // Podmiana atomowa, nie `writeFile`: ten obcina plik do zera i dopiero potem pisze, a tik
    // `stat`, który trafi w tę szczelinę, czyta nową treść od zera i lista wychodzi już z `since`.
    await createTranscript(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => taskEvents(events).length === 3, 'lista zgaszona po skróceniu');
    // Nowy reduktor nie widział jeszcze żadnego wpisu.
    expect(taskEvents(events)[2]).toEqual({ type: 'tasks', tasks: [] });

    await appendFile(filePath(), agentStart('a7725f999e73158bc'));
    await waitFor(() => taskEvents(events).length === 4, 'start po skróceniu');
    expect(taskEvents(events)[3]?.since).toBe('2026-08-22T10:00:05.000Z');
  });

  /**
   * Okno potrafi otworzyć załącznik z meldunkiem o postoju: lista wychodzi wtedy BEZ `since`,
   * a odbiorca bez początku okna nie pokazuje żadnej własnej komendy agenta. Pierwszy zwykły wpis
   * ustala czas, ale listy nie zmienia, więc `since` musi dojechać własnym zdarzeniem.
   * Przy pustej liście takiego zdarzenia nie ma: nie byłoby komu go czytać.
   */
  it('okno otwarte załącznikiem: `since` dochodzi osobnym zdarzeniem, gdy lista już wyszła', async () => {
    const attachment = `${JSON.stringify({
      type: 'attachment', isSidechain: false, timestamp: '2026-08-22T09:59:00.000Z', sessionId: SESSION,
      attachment: {
        type: 'queued_command', commandMode: 'task-notification',
        prompt: agentStopped('a52b91f105b002e8d', STANDBY_NOTE, 1),
      },
    })}\n`;
    await writeFile(filePath(), attachment);
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'agent z załącznika');
    expect(taskEvents(events)[0]?.tasks.map((task) => task.waitingSince)).toEqual(['2026-08-22T09:59:00.000Z']);
    expect(taskEvents(events)[0]).not.toHaveProperty('since');

    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'mielę' }]));
    await waitFor(() => taskEvents(events).length === 2, 'początek okna');
    expect(taskEvents(events)[1]?.since).toBe('2026-08-22T10:00:05.000Z');
    expect(taskEvents(events)[1]?.tasks).toEqual(taskEvents(events)[0]?.tasks);

    // Początek okna ustala się raz: kolejne wpisy już niczego nie wysyłają.
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'dalej' }], { timestamp: '2026-08-22T10:00:09.000Z' }));
    await quiet();
    expect(taskEvents(events)).toHaveLength(2);
  });

  /** Załącznik niesie czas PIERWSZEJ kopii meldunku, czyli chwilę sprzed okna: początkiem okna nie jest. */
  it('`since` nie bierze czasu z załącznika na początku okna', async () => {
    const attachment = `${JSON.stringify({
      type: 'attachment', isSidechain: false, timestamp: '2026-08-22T08:59:00.000Z', sessionId: SESSION,
      attachment: { type: 'queued_command', prompt: 'x', commandMode: 'task-notification' },
    })}\n`;
    await writeFile(filePath(), attachment + agentStart('a52b91f105b002e8d'));
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'start agenta z ogona');
    expect(taskEvents(events)[0]?.since).toBe('2026-08-22T10:00:05.000Z');
  });

  it('po zerowaniu reduktora (skrócenie pliku) przyrost końców liczy się od nowa', async () => {
    await writeFile(filePath(), userLine('start') + backgroundDone('bprzed1') + backgroundDone('bprzed2'));
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'końce z ogona');
    expect(taskEvents(events)[0]?.ended).toEqual(['bprzed1', 'bprzed2']);

    await createTranscript(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await appendFile(filePath(), backgroundDone('bpo'));
    await waitFor(() => taskEvents(events).length === 2, 'koniec po skróceniu');
    await quiet();
    expect(taskEvents(events).slice(1)).toEqual([{ type: 'tasks', tasks: [], ended: ['bpo'] }]);
  });

  it('po `/clear` przyrost końców liczy się od nowa, dla pliku nowej sesji silnika', async () => {
    await writeFile(filePath(), userLine('start') + backgroundDone('bprzed1') + backgroundDone('bprzed2'));
    await writeFile(filePath(SESSION_B), userLine('nowa sesja') + backgroundDone('bnowa'));
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'końce pierwszej sesji');
    expect(taskEvents(events)[0]?.ended).toEqual(['bprzed1', 'bprzed2']);

    follower.repoint(SESSION_B);
    await waitFor(() => taskEvents(events).length === 2, 'koniec z nowej sesji');
    await quiet();
    expect(taskEvents(events).slice(1)).toEqual([
      { type: 'tasks', tasks: [], ended: ['bnowa'], since: '2026-08-22T10:00:00.000Z' },
    ]);
  });

  /**
   * Kryterium 7 planu subagenta w tle: nowe brzmienie dopisku w CLI nie psuje niczego ponad
   * stan sprzed rozróżnienia (postój znów zamyka wpis) i zostawia JEDNĄ linię w `server.log`.
   * Raz na proces, nie na followera: zmiana zdania w CLI dotyczy każdej sesji naraz.
   */
  it('nieznany dopisek meldunku agenta: jedna linia logu na proces, dopisek komendy bez linii', async () => {
    const logs: string[] = [];
    const unknownLines = (): string[] => logs.filter((line) => line.includes(UNKNOWN_AGENT_NOTE_LOG));
    const logger = (line: string): void => { logs.push(line); };

    // Dopisek KOMENDY po limicie czasu to trzecie znane brzmienie i nie mówi nic o agencie.
    await writeFile(filePath(), userLine('start') + backgroundStart('bdluga') + queued([
      '<task-notification>', '<task-id>bdluga</task-id>', '<status>killed</status>',
      '<summary>Background command "Testy" was stopped after reaching its background time limit</summary>',
      '<note>If the work in progress still needs it, start it again with `run_in_background` and a longer '
        + '`timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report '
        + 'that it was stopped.</note>',
      '</task-notification>',
    ].join('\n'), '2026-08-22T10:10:00.000Z'));
    const { events } = start({ logger });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await quiet();
    expect(taskEvents(events).at(-1)?.tasks ?? []).toEqual([]);
    expect(unknownLines()).toEqual([]);

    // Pierwsza sesja: agent z dopiskiem, którego reduktor nie zna. Wpis znika jak przy końcu.
    await appendFile(filePath(), agentStart('a1aaaaaaaaaaaaaaa'));
    await waitFor(() => taskEvents(events).at(-1)?.tasks.length === 1, 'start agenta');
    const strange = agentStopped('a1aaaaaaaaaaaaaaa', 'This agent paused while a child task is pending.', 1);
    await appendFile(filePath(), queued(strange, '2026-08-22T10:11:00.000Z') + queued(
      agentStopped('a1aaaaaaaaaaaaaaa', 'This agent paused while a child task is pending.', 2), '2026-08-22T10:12:00.000Z',
    ));
    await waitFor(() => taskEvents(events).at(-1)?.tasks.length === 0, 'agent zamknięty');
    await waitFor(() => unknownLines().length > 0, 'linia logu');
    expect(unknownLines()).toHaveLength(1);
    expect(unknownLines()[0]).toContain(SESSION);

    // Druga sesja, drugi follower, ten sam proces: linia już wyszła.
    await writeFile(filePath(SESSION_B), userLine('start') + agentStart('a2bbbbbbbbbbbbbbb')
      + queued(agentStopped('a2bbbbbbbbbbbbbbb', 'This agent paused while a child task is pending.', 3), '2026-08-22T10:13:00.000Z'));
    const other = start({ agentSessionId: SESSION_B, logger });
    await waitFor(() => other.events.some((e) => e.type === 'history'), 'historia drugiej sesji');
    await quiet();
    expect(unknownLines()).toHaveLength(1);
  });
});

/*
 * Start procesu CLI jako fakt dla zadań w tle.
 *
 * Subagent żyje w procesie CLI, a CLI po `/exit` i `claude --resume` nie zapisuje o nim nic (pomiar
 * `measured/resume-cli.jsonl`, CLI 2.1.296). Follower dostaje chwilę startu jedynego procesu rozmowy
 * (`noteProcessStart`, z rejestru procesów CLI przez manager i driver) i podaje ją reduktorowi,
 * który zamyka agentów o starszym dowodzie życia. Reguła i jej warianty: `herdr-jsonl-tasks.test.ts`.
 */
describe('start procesu CLI zamyka subagentów sprzed restartu', () => {
  const AGENT = 'a52b91f105b002e8d';
  const STANDBY_AT = '2026-08-22T10:11:00.000Z';
  const AFTER_STANDBY = Date.parse('2026-08-22T10:30:00.000Z');
  /** Agent wystartowany (10:00:00) i w postoju od 10:11:00. */
  const standing = (): string => userLine('start') + agentStart(AGENT)
    + queued(agentStopped(AGENT, STANDBY_NOTE, 1), STANDBY_AT);
  const lastTasks = (events: readonly FollowEvent[]): readonly { id: string }[] | undefined =>
    taskEvents(events).at(-1)?.tasks;

  /**
   * ODTWORZENIE NA DANYCH ZMIERZONYCH (CLI 2.1.296): plik główny z `measured/resume-cli.jsonl`,
   * czyli sesja, z której użytkownik wyszedł przy subagencie w postoju i wrócił przez `--resume`.
   */
  it('pomiar `resume-cli`: po sygnale późniejszym niż ostatni postój lista jest pusta', async () => {
    const main = (await readFile(
      join(import.meta.dirname, 'fixtures/herdr/tasks/measured/resume-cli.jsonl'), 'utf8',
    )).split('\n').filter((line) => line.includes('"_plik":"glowny"'));
    await writeFile(filePath(), `${main.join('\n')}\n`);
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'agent w postoju z pliku');
    expect(taskEvents(events)[0]?.tasks.map((task) => [task.id, task.waitingSince]))
      .toEqual([['a1000000000000000', '2026-01-01T00:00:07.000Z']]);

    // Nowy proces wystartował między meldunkiem `killed` (00:00:10) a promptem po wznowieniu.
    follower.noteProcessStart(Date.parse('2026-01-01T00:00:10.500Z'));
    await waitFor(() => taskEvents(events).length === 2, 'lista po sygnale');
    expect(taskEvents(events)[1]?.tasks).toEqual([]);
  });

  it('starszy start procesu niczego nie zamyka i niczego nie wysyła', async () => {
    await writeFile(filePath(), standing());
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'agent w postoju');
    follower.noteProcessStart(Date.parse('2026-08-22T09:00:00.000Z'));
    await quiet();
    expect(taskEvents(events)).toHaveLength(1);
  });

  it('powtórka tej samej chwili (manager podaje ją co odczyt rejestru) nie robi nic', async () => {
    await writeFile(filePath(), standing());
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'agent w postoju');
    follower.noteProcessStart(AFTER_STANDBY);
    await waitFor(() => taskEvents(events).length === 2, 'agent zamknięty');

    // Agent wznowiony w nowym procesie wraca; powtórzony sygnał nie ma prawa go zamknąć.
    await appendFile(filePath(), userLine([{ type: 'tool_result', tool_use_id: 'toolu_send', content: '' }], {
      timestamp: '2026-08-22T10:40:00.000Z',
      toolUseResult: { message: 'Resuming agent a52b91f', pin: false, resumedAgentId: AGENT, success: true },
    }));
    await waitFor(() => taskEvents(events).length === 3, 'agent wznowiony');
    for (let i = 0; i < 3; i += 1) follower.noteProcessStart(AFTER_STANDBY);
    await quiet();
    expect(taskEvents(events)).toHaveLength(3);
    expect(lastTasks(events)?.map((task) => task.id)).toEqual([AGENT]);
  });

  /**
   * Rarog wstaje przy już zrestartowanym CLI: rejestr bywa odczytany, zanim follower przeczyta
   * historię. Agent sprzed restartu nie ma prawa mignąć na liście.
   */
  it('sygnał przed historią: agent sprzed restartu nie pojawia się wcale', async () => {
    const { follower, events } = start();
    follower.noteProcessStart(AFTER_STANDBY);
    // Pliku jeszcze nie ma: pierwsza wypłata (pusta) idzie po pudle globu.
    await firstTasks(events);
    await createTranscript(filePath(), standing() + backgroundStart('b1'));
    await waitFor(() => taskEvents(events).length > 1, 'zadania z pliku');
    await quiet();
    expect(taskEvents(events).map((event) => event.tasks.map((task) => task.id))).toEqual([[], ['b1']]);
  });

  it('reduktor założony po skróceniu pliku zna start procesu', async () => {
    await writeFile(filePath(), standing());
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'agent w postoju');
    follower.noteProcessStart(AFTER_STANDBY);
    await waitFor(() => lastTasks(events)?.length === 0, 'agent zamknięty');
    const before = taskEvents(events).length;

    await writeFile(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    // Ten sam meldunek o postoju sprzed restartu, czytany przez NOWY reduktor.
    await appendFile(filePath(), queued(agentStopped(AGENT, STANDBY_NOTE, 1), STANDBY_AT) + backgroundStart('b1'));
    await waitFor(() => taskEvents(events).length > before, 'zadania po skróceniu');
    await quiet();
    expect(taskEvents(events).slice(before).map((event) => event.tasks.map((task) => task.id))).toEqual([['b1']]);
  });

  it('reduktor założony po przeskoku przyrostu zna start procesu', async () => {
    const MAX = 2_000;
    await writeFile(filePath(), standing());
    const { follower, events } = start({ maxReadBytes: MAX });
    await waitFor(() => taskEvents(events).length === 1, 'agent w postoju');
    follower.noteProcessStart(AFTER_STANDBY);
    await waitFor(() => lastTasks(events)?.length === 0, 'agent zamknięty');
    const before = taskEvents(events).length;

    // Przyrost ponad sufit: reduktor rusza od zera, a w zachowanym ogonie stoi kopia starego postoju.
    const big = `${JSON.stringify({
      type: 'user', isSidechain: false, timestamp: '2026-08-22T10:45:00.000Z', sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: 'A'.repeat(MAX * 3) }] },
    })}\n`;
    await appendFile(filePath(), big + queued(agentStopped(AGENT, STANDBY_NOTE, 1), STANDBY_AT) + backgroundStart('b1'));
    await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
    await waitFor(() => taskEvents(events).length > before, 'zadania po luce');
    await quiet();
    expect(taskEvents(events).slice(before).map((event) => event.tasks.map((task) => task.id))).toEqual([['b1']]);
  });

  it('`repoint` zapomina start procesu: w nowej rozmowie reguły nie ma, dopóki nie przyjdzie na nowo', async () => {
    await writeFile(filePath(), userLine('start'));
    await writeFile(filePath(SESSION_B), standing());
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);
    follower.noteProcessStart(AFTER_STANDBY);

    follower.repoint(SESSION_B);
    await waitFor(() => taskChanges(events).length === 1, 'agent z nowej rozmowy');
    expect(lastTasks(events)?.map((task) => task.id)).toEqual([AGENT]);

    // Ta sama chwila co przed `repoint`, ale dla nowej rozmowy to nowy fakt.
    follower.noteProcessStart(AFTER_STANDBY);
    await waitFor(() => taskChanges(events).length === 2, 'agent zamknięty w nowej rozmowie');
    expect(lastTasks(events)).toEqual([]);
  });
});

/*
 * Monitor agenta głównego: start w kształcie CLI 2.1.319 (`{persistent, taskId, timeoutMs}`), termin
 * liczony zegarem czytnika i koniec przez nowy proces CLI. Reguły reduktora i ich warianty:
 * `herdr-jsonl-tasks.test.ts`; tu stoi to, co dokłada follower: przegląd sprzed okna i zegar bez nowych linii.
 */
describe('monitor agenta głównego na liście zadań', () => {
  const MON = 'bm0n1t0r1';
  const START_AT = '2026-08-22T10:00:10.000Z';
  const monitorStart = (opts: { persistent?: boolean; timeoutMs?: number } = {}): string => assistantLine([
    { type: 'tool_use', id: 'toolu_mon', name: 'Monitor', input: { description: 'log serwera', timeout_ms: 60_000, command: 'tail -f log' } },
  ], { timestamp: START_AT }) + userLine([{ type: 'tool_result', tool_use_id: 'toolu_mon', content: '' }], {
    timestamp: START_AT,
    toolUseResult: { persistent: opts.persistent ?? false, taskId: MON, timeoutMs: opts.timeoutMs ?? 60_000 },
  });
  const lastIds = (events: readonly FollowEvent[]): string[] | undefined =>
    taskEvents(events).at(-1)?.tasks.map((task) => task.id);

  it('start sprzed okna ogona jest po podpięciu na liście jako monitor', async () => {
    now = Date.parse(START_AT) + 1_000;
    const padding = Array.from({ length: 60 }, (_, n) =>
      assistantLine([{ type: 'text', text: `wypowiedź ${String(n)} ${'x'.repeat(40)}` }])).join('');
    await createTranscript(filePath(), userLine('start') + monitorStart() + padding);
    const { events } = start({ historyBytes: 2_048, historyMaxBytes: 2_048, historyMessages: 5 });
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    await quiet();
    expect(taskEvents(events).map((event) => event.tasks)).toEqual([[{
      id: MON, kind: 'monitor', description: 'log serwera', command: 'tail -f log', startedAt: START_AT,
    }]]);
    expect(history(events).messages.every((message) => message.role === 'assistant')).toBe(true);
  });

  it('wygaśnięcie przy nierosnącym pliku: zegar czytnika zamyka monitor po `timeoutMs`', async () => {
    now = Date.parse(START_AT) + 1_000;
    await writeFile(filePath(), userLine('start') + monitorStart({ timeoutMs: 60_000 }));
    const { events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'monitor na liście');
    expect(lastIds(events)).toEqual([MON]);
    const size = (await readFile(filePath(), 'utf8')).length;

    now = Date.parse(START_AT) + 59_999;
    await quiet();
    expect(taskEvents(events)).toHaveLength(1);
    now = Date.parse(START_AT) + 60_000;
    await waitFor(() => taskEvents(events).length === 2, 'monitor po terminie');
    expect(lastIds(events)).toEqual([]);
    // Plik nie urósł: zamknięcie przyszło z zegara, nie z nowej linii.
    expect((await readFile(filePath(), 'utf8')).length).toBe(size);
  });

  it('nowy proces CLI zamyka monitor trwały, starszy od siebie', async () => {
    now = Date.parse(START_AT) + 1_000;
    await writeFile(filePath(), userLine('start') + monitorStart({ persistent: true }));
    const { follower, events } = start();
    await waitFor(() => taskEvents(events).length === 1, 'monitor na liście');
    now = Date.parse(START_AT) + 24 * 60 * 60_000;
    await quiet();
    expect(lastIds(events)).toEqual([MON]);

    follower.noteProcessStart(Date.parse(START_AT) + 5_000);
    await waitFor(() => taskEvents(events).length === 2, 'monitor po starcie procesu');
    expect(lastIds(events)).toEqual([]);
  });
});

/*
 * Pełny przegląd pliku głównego przy podpięciu.
 *
 * Okno ogona (do 8 MiB) wystarcza na historię rozmowy, ale lista zadań z samego okna gubi to, co
 * zaczęło się wcześniej: po każdym restarcie Raroga subagent sprzed okna był niewidoczny do swojego
 * następnego postoju, a własne komendy subagentów sprzed okna miały „los nieznany”. Przy podpięciu
 * reduktor zadań dostaje więc linie o zadaniach z CAŁEGO pliku: najpierw część sprzed okna
 * (`background/main-scan.ts`), potem okno. Sam przegląd i jego zgodność z „każdą linią” pilnuje
 * `herdr-main-scan.test.ts`; tu stoi to, co robi z nim follower.
 */
describe('pełny przegląd pliku przy podpięciu', () => {
  const AGENT = 'a52b91f105b002e8d';
  const FIRST_AT = '2026-08-22T09:00:00.000Z';
  /** Okno ogona na 2 kB i pięć wiadomości: wszystko, co stoi przed wypełniaczem, jest PRZED oknem. */
  const SMALL_WINDOW = { historyBytes: 2_048, historyMaxBytes: 2_048, historyMessages: 5 };
  /** Wypełniacz: sześćdziesiąt zwykłych wypowiedzi, około 12 kB. Żadna nie mówi o zadaniach. */
  const padding = (): string => Array.from({ length: 60 }, (_, n) =>
    assistantLine([{ type: 'text', text: `wypowiedź ${String(n)} ${'x'.repeat(40)}` }])).join('');
  const resumed = (id: string, at: string): string => userLine(
    [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '' }],
    { timestamp: at, toolUseResult: { message: 'Resuming agent', pin: false, resumedAgentId: id, success: true } },
  );
  /** Przegląd wyłączony sufitem zero: zachowanie sprzed przeglądu, do porównania. */
  const WINDOW_ONLY = { ...SMALL_WINDOW, tasksScan: { maxBytes: 0 } };
  const scanLines = (logs: readonly string[]): string[] => logs.filter((line) => line.includes(TASKS_SCAN_LOG));
  const skippedLines = (logs: readonly string[]): string[] =>
    logs.filter((line) => line.includes(TASKS_SCAN_SKIPPED_LOG));

  /**
   * TEST OBOWIĄZKOWY. Agent wystartował, stanął i został wznowiony, a potem rozmowa urosła o więcej
   * niż okno ogona. Po restarcie Raroga taki agent pracuje, a Rarog go nie widział.
   */
  it('agent wystartowany i wznowiony przed oknem jest po podpięciu na liście z opisem', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + queued(agentStopped(AGENT, STANDBY_NOTE, 1), '2026-08-22T10:11:00.000Z')
      + resumed(AGENT, '2026-08-22T10:20:00.000Z') + padding());
    const { events } = start(SMALL_WINDOW);
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    await quiet();

    expect(taskEvents(events)).toEqual([{
      type: 'tasks',
      tasks: [{
        id: AGENT, kind: 'agent', description: 'Przegląd', agentType: 'general-purpose',
        startedAt: '2026-08-22T10:00:00.000Z',
      }],
      // `since` po pełnym przeglądzie to czas pierwszego wpisu PLIKU, nie okna.
      since: FIRST_AT,
    }]);
    // Okno naprawdę nie obejmuje startu: historia ma same wypowiedzi z wypełniacza.
    expect(history(events).messages.every((message) => message.role === 'assistant')).toBe(true);
    expect(history(events).messages.length).toBeLessThan(60);
  });

  it('historia wychodzi przed listą zadań: przegląd nie wstrzymuje transkryptu', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT) + padding());
    const { events } = start(SMALL_WINDOW);
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    const order = events.map((event) => event.type);
    expect(order.indexOf('history')).toBeGreaterThan(-1);
    expect(order.indexOf('history')).toBeLessThan(order.indexOf('tasks'));
  });

  /**
   * Koniec własnej komendy subagenta stoi w kolejce pliku głównego. Sprzed okna nie było go widać,
   * więc odbiorca (własne komendy w `merge.ts`) nie mógł pokazać żadnej starszej komendy: jej
   * koniec mógł go ominąć. Po przeglądzie zna wszystkie końce i początek całego pliku.
   */
  it('koniec komendy subagenta sprzed okna jedzie w `ended`, a `since` to początek pliku', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + backgroundDone('bwlasna1') + padding() + backgroundDone('bwlasna2'));
    const { events } = start(SMALL_WINDOW);
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    await quiet();
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.ended).toEqual(['bwlasna1', 'bwlasna2']);
    expect(taskEvents(events)[0]?.since).toBe(FIRST_AT);
    expect(taskEvents(events)[0]?.tasks.map((task) => task.id)).toEqual([AGENT]);
  });

  it('start sprzed okna i koniec w oknie: zadanie zamknięte, a koniec nie jest „bez startu”', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + backgroundStart('b1')
      + backgroundStart('b2', 'toolu_bg2') + padding() + backgroundDone('b1'));
    const { events } = start(SMALL_WINDOW);
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    await quiet();
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.tasks.map((task) => task.id)).toEqual(['b2']);
    expect(taskEvents(events)[0]).not.toHaveProperty('ended');
  });

  /**
   * Koniec sprzed okna zamyka, także wobec tego, co stoi w oknie. Kopia meldunku spóźnia się
   * nawet o minutę: gdy okno zaczynało się między pierwszą kopią a powtórzeniem, reduktor brał
   * powtórzenie za nowy meldunek i otwierał agenta, który dawno skończył.
   */
  it('koniec sprzed okna zamyka: spóźniona kopia starego postoju w oknie nie otwiera agenta', async () => {
    const standby = agentStopped(AGENT, STANDBY_NOTE, 1);
    const copy = `${JSON.stringify({
      type: 'attachment', isSidechain: false, timestamp: '2026-08-22T10:11:00.000Z', sessionId: SESSION,
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: standby },
    })}\n`;
    const content = userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + queued(standby, '2026-08-22T10:11:00.000Z')
      + queued(agentStopped(AGENT, 'A task-notification fires each time this agent stops with no live '
        + 'background children of its own.', 2), '2026-08-22T10:30:00.000Z')
      + padding() + copy;
    await createTranscript(filePath(), content);
    const { events } = start(SMALL_WINDOW);
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);
    await quiet();
    // Jedyna lista to pierwsza wypłata po podpięciu: pusta.
    expect(taskEvents(events)).toEqual([{ type: 'tasks', tasks: [], since: FIRST_AT }]);

    // Bez przeglądu (sufit zero) ta sama kopia otwiera agenta-widmo: stan sprzed tej zmiany.
    await createTranscript(filePath(SESSION_B), content);
    const windowOnly = start({ ...WINDOW_ONLY, agentSessionId: SESSION_B, logger: () => undefined });
    await waitFor(() => taskEvents(windowOnly.events).length > 0, 'agent-widmo z samego okna');
    expect(taskEvents(windowOnly.events)[0]?.tasks.map((task) => task.waitingSince))
      .toEqual(['2026-08-22T10:11:00.000Z']);
  });

  /**
   * TEST OBOWIĄZKOWY: sufit rozmiaru. Powyżej niego przegląd się nie odbywa, lista powstaje
   * z samego okna jak przed przeglądem, a w logu zostaje jedna linia.
   */
  it('plik ponad sufit: przeglądu nie ma, zachowanie jak przed nim i jedna linia w logu', async () => {
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + padding() + backgroundStart('b1'));
    const { events } = start({ ...WINDOW_ONLY, logger: (line) => logs.push(line) });
    await waitFor(() => taskEvents(events).length > 0, 'zadania z okna');
    await quiet();
    // Agent sprzed okna jest niewidoczny, a `since` to pierwszy wpis OKNA.
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.tasks.map((task) => task.id)).toEqual(['b1']);
    expect(taskEvents(events)[0]?.since).toBe('2026-08-22T10:00:05.000Z');
    expect(skippedLines(logs)).toHaveLength(1);
    expect(skippedLines(logs)[0]).toContain(SESSION);
    expect(skippedLines(logs)[0]).toContain('B before the window, more than the scan cap');
    expect(scanLines(logs)).toEqual([]);
  });

  it('linia logu z czasem przeglądu: tylko dla pliku powyżej progu', async () => {
    const content = userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT) + padding();
    await createTranscript(filePath(), content);
    const quietLogs: string[] = [];
    const small = start({ ...SMALL_WINDOW, logger: (line) => quietLogs.push(line) });
    await waitFor(() => taskEvents(small.events).length > 0, 'zadania po przeglądzie');
    // Domyślny próg to 8 MiB: plik testowy ma kilkanaście kB.
    expect(TASKS_SCAN_LOG_BYTES).toBe(8 * 1024 * 1024);
    expect(scanLines(quietLogs)).toEqual([]);

    await createTranscript(filePath(SESSION_B), content);
    const logs: string[] = [];
    const big = start({
      ...SMALL_WINDOW, agentSessionId: SESSION_B, tasksScan: { logBytes: 1_000, chunkBytes: 512 },
      logger: (line) => logs.push(line),
    });
    await waitFor(() => taskEvents(big.events).length > 0, 'zadania po przeglądzie');
    expect(scanLines(logs)).toHaveLength(1);
    expect(scanLines(logs)[0])
      .toMatch(/background task scan before the tail window: \d+ B in \d+ ms, parsed \d+ of \d+ lines/);
    expect(scanLines(logs)[0]).toContain(SESSION_B);
  });

  it('plik mieszczący się w oknie nie ma przeglądu wcale', async () => {
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT));
    const { events } = start({ tasksScan: { logBytes: 0 }, logger: (line) => logs.push(line) });
    await waitFor(() => taskEvents(events).length > 0, 'zadania z okna');
    expect(taskEvents(events)[0]?.since).toBe(FIRST_AT);
    expect(scanLines(logs)).toEqual([]);
  });

  /**
   * TEST OBOWIĄZKOWY. Przegląd jest TYLKO przy otwarciu pliku. Przeskok przyrostu i skrócenie
   * pliku zerują stan jak dotąd: lista odbudowuje się z tego, co follower przeczyta dalej,
   * a agent sprzed luki wraca dopiero swoim następnym wpisem.
   */
  it('przeskok przyrostu zeruje listę BEZ ponownego przeglądu', async () => {
    const MAX = 2_000;
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT) + padding());
    const { events } = start({
      ...SMALL_WINDOW, maxReadBytes: MAX, tasksScan: { logBytes: 0 }, logger: (line) => logs.push(line),
    });
    await waitFor(() => taskEvents(events).length === 1, 'agent z przeglądu');
    expect(taskEvents(events)[0]?.tasks.map((task) => task.id)).toEqual([AGENT]);
    expect(scanLines(logs)).toHaveLength(1);

    const big = `${JSON.stringify({
      type: 'user', isSidechain: false, timestamp: '2026-08-22T11:00:00.000Z', sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: 'A'.repeat(MAX * 3) }] },
    })}\n`;
    await appendFile(filePath(), big + backgroundStart('b1'));
    await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
    await waitFor(() => taskEvents(events).at(-1)?.tasks.some((task) => task.id === 'b1') === true, 'lista po luce');
    await quiet();
    // Po luce stoi samo zadanie z ogona; agent sprzed luki zniknął, a `since` liczy się od ogona.
    expect(taskEvents(events).at(-1)?.tasks.map((task) => task.id)).toEqual(['b1']);
    expect(taskEvents(events).at(-1)?.since).toBe('2026-08-22T10:00:05.000Z');
    expect(scanLines(logs)).toHaveLength(1);
  });

  it('skrócenie pliku zeruje listę BEZ ponownego przeglądu', async () => {
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT) + padding());
    const { events } = start({ ...SMALL_WINDOW, tasksScan: { logBytes: 0 }, logger: (line) => logs.push(line) });
    await waitFor(() => taskEvents(events).length === 1, 'agent z przeglądu');

    // Krótszy plik, podmieniony atomowo: start agenta stoi w nim PRZED miejscem, od którego
    // follower czyta dalej, więc bez ponownego przeglądu nikt go już nie zobaczy.
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => taskEvents(events).length === 2, 'lista zgaszona');
    await appendFile(filePath(), backgroundStart('b1'));
    await waitFor(() => taskEvents(events).length === 3, 'zadanie po skróceniu');
    await quiet();
    expect(taskEvents(events)[1]?.tasks).toEqual([]);
    expect(taskEvents(events)[2]?.tasks.map((task) => task.id)).toEqual(['b1']);
    expect(scanLines(logs)).toHaveLength(1);
  });

  it('`repoint` otwiera nowy plik, więc robi przegląd jego części sprzed okna', async () => {
    await createTranscript(filePath(), userLine('start'));
    await createTranscript(filePath(SESSION_B), userLine('start', { timestamp: FIRST_AT, sessionId: SESSION_B })
      + agentStart(AGENT) + padding());
    const { follower, events } = start(SMALL_WINDOW);
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await firstTasks(events);
    follower.repoint(SESSION_B);
    await waitFor(() => taskEvents(events).length > 1, 'zadania nowej rozmowy');
    expect(taskEvents(events).at(-1)?.tasks.map((task) => task.id)).toEqual([AGENT]);
    expect(taskEvents(events).at(-1)?.since).toBe(FIRST_AT);
  });

  /**
   * Przegląd trwa, a `/clear` potrafi wejść w jego środek. Wynik przeglądu starego pliku nie ma
   * prawa trafić do nowej rozmowy ani na listę.
   */
  it('`repoint` w trakcie przeglądu: lista starego pliku nie wychodzi', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT) + padding());
    await createTranscript(filePath(SESSION_B), userLine('nowa', { sessionId: SESSION_B }) + backgroundStart('bnowa'));
    // Porcja 16 bajtów: przegląd kilkunastu kB to setki odczytów; długi batch trzyma listę w buforze.
    const { follower, events } = start({
      ...SMALL_WINDOW, tasksScan: { chunkBytes: 16 }, timing: { ...TIMING, batchMs: 150 },
    });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia starego pliku');
    follower.repoint(SESSION_B);
    await waitFor(() => taskEvents(events).some((event) => event.tasks.some((task) => task.id === 'bnowa')), 'nowa rozmowa');
    await quiet();
    expect(taskEvents(events).flatMap((event) => event.tasks.map((task) => task.id))).not.toContain(AGENT);
  });

  /**
   * Start procesu CLI (reguła restartu) działa także na część sprzed okna: Rarog wstający przy
   * zrestartowanym CLI nie pokazuje agenta, którego przegląd dopiero co odnalazł.
   */
  it('start procesu znany przed przeglądem zamyka agenta sprzed okna i sprzed restartu', async () => {
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + queued(agentStopped(AGENT, STANDBY_NOTE, 1), '2026-08-22T10:11:00.000Z')
      + backgroundStart('b1', 'toolu_bg1') + padding());
    const { follower, events } = start(SMALL_WINDOW);
    follower.noteProcessStart(Date.parse('2026-08-22T10:30:00.000Z'));
    await waitFor(() => taskEvents(events).length > 0, 'zadania po przeglądzie');
    await quiet();
    expect(taskEvents(events).map((event) => event.tasks.map((task) => task.id))).toEqual([['b1']]);
  });

  /**
   * Przegląd wstrzymany na pierwszym odczycie, do `release()`. Test wchodzi dzięki temu w ŚRODEK
   * przeglądu deterministycznie, a `opened` liczy, ile przeglądów naprawdę ruszyło.
   */
  const pausedScan = (): { open: NonNullable<TasksScanOptions['open']>; release: () => void; opened: () => number } => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let opened = 0;
    return {
      open: async (path) => {
        opened += 1;
        const handle = await open(path, 'r');
        return {
          read: async (buffer, offset, length, position) => {
            await gate;
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
      release,
      opened: () => opened,
    };
  };
  const histories = (events: readonly FollowEvent[]): number => events.filter((e) => e.type === 'history').length;

  /**
   * TEST OBOWIĄZKOWY. Follower czekający na plik, którego nie ma, ma
   * zaplanowane ponowienie. `repoint` na inną rozmowę go nie kasował, a przegląd wydłuża czas,
   * w którym nowy plik jest w trakcie otwierania: spóźnione ponowienie otwierało go DRUGI raz.
   * Skutek: historia dwa razy, a drugi przegląd podmieniał reduktor, który zdążył już przyjąć
   * wpisy z odczytu przyrostowego, więc zadanie z tych wpisów znikało bez drogi powrotu.
   */
  it('spóźnione ponowienie po `repoint` nie otwiera nowego pliku drugi raz w trakcie przeglądu', async () => {
    const scan = pausedScan();
    await createTranscript(filePath(SESSION_B), userLine('start', { timestamp: FIRST_AT, sessionId: SESSION_B })
      + agentStart(AGENT) + padding());
    // Pliku pierwszej rozmowy nie ma: follower ponawia co 40 ms.
    const { follower, events } = start({
      ...SMALL_WINDOW, tasksScan: { open: scan.open },
      timing: { ...TIMING, missingFastMs: 40, missingSlowMs: 40 },
    });
    // Pudło globu: pierwsza wypłata (pusta) wychodzi po oknie partii, ponowienie czeka jeszcze 40 ms.
    await firstTasks(events);

    follower.repoint(SESSION_B);
    await waitFor(() => histories(events) === 1, 'historia nowej rozmowy');
    await waitFor(() => scan.opened() === 1, 'przegląd ruszył');
    // Przegląd stoi; w tym czasie wypada ponowienie zaplanowane jeszcze dla starej rozmowy.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(histories(events)).toBe(1);
    expect(scan.opened()).toBe(1);

    scan.release();
    await waitFor(() => taskEvents(events).length === 2, 'lista po przeglądzie');
    expect(taskEvents(events)[0]).toEqual({ type: 'tasks', tasks: [] });
    expect(taskEvents(events)[1]?.tasks.map((task) => task.id)).toEqual([AGENT]);

    // Odczyt przyrostowy działa i nikt nie podmienia reduktora pod nim.
    await appendFile(filePath(SESSION_B), backgroundStart('bnew'));
    await waitFor(() => taskEvents(events).at(-1)?.tasks.some((task) => task.id === 'bnew') === true, 'nowe zadanie');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(taskEvents(events).at(-1)?.tasks.map((task) => task.id)).toEqual([AGENT, 'bnew']);
    expect(histories(events)).toBe(1);
    expect(scan.opened()).toBe(1);
  });

  it('start procesu podany W TRAKCIE przeglądu obowiązuje reduktor, który z przeglądu wychodzi', async () => {
    const scan = pausedScan();
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + queued(agentStopped(AGENT, STANDBY_NOTE, 1), '2026-08-22T10:11:00.000Z')
      + backgroundStart('b1', 'toolu_bg1') + padding());
    const { follower, events } = start({ ...SMALL_WINDOW, tasksScan: { open: scan.open } });
    await waitFor(() => scan.opened() === 1, 'przegląd ruszył');

    // Rejestr procesów odczytany, gdy przegląd stoi: fakt trafia do starego, pustego reduktora.
    follower.noteProcessStart(Date.parse('2026-08-22T10:30:00.000Z'));
    scan.release();
    await waitFor(() => taskEvents(events).length > 0, 'lista po przeglądzie');
    await quiet();
    expect(taskEvents(events).map((event) => event.tasks.map((task) => task.id))).toEqual([['b1']]);
  });

  it('wyjątek odczytu w przeglądzie nie zabija followera: lista z okna i linia w logu', async () => {
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('start', { timestamp: FIRST_AT }) + agentStart(AGENT)
      + padding() + backgroundStart('b1'));
    // Plik istnieje dla followera, ale przegląd dostaje ścieżkę, której nie umie otworzyć.
    const { events } = start({
      ...SMALL_WINDOW, logger: (line) => logs.push(line),
      tasksScan: { open: () => Promise.reject(new Error('EMFILE')) },
    });
    await waitFor(() => taskEvents(events).length > 0, 'zadania z okna');
    expect(taskEvents(events)[0]?.tasks.map((task) => task.id)).toEqual(['b1']);
    expect(skippedLines(logs)).toHaveLength(1);
    expect(skippedLines(logs)[0]).toContain('EMFILE');
    // Follower żyje: dopisany wpis dociera zwykłą drogą.
    await appendFile(filePath(), backgroundDone('b1'));
    await waitFor(() => taskEvents(events).at(-1)?.tasks.length === 0, 'koniec zadania');
  });
});

/*
 * Przeskok przyrostu większego niż sufit odczytu (`maxReadBytes`).
 *
 * Wynik `Read` z obrazkiem (1,35 MB) wpada do pliku jednym zapisem, follower przeskakuje do
 * ostatniego 1 MB i wyrzuca uciętą linię: bez resetu `tool_result` przepada, `Read` „czeka" do
 * końca tury, a każdy kolejny dialog tej tury kończy się `mismatch`. Przeskok to utrata ciągłości: stan
 * liczony parami (czekające narzędzie, zadania w tle, okno echa) wraca do zera.
 */
describe('luka w odczycie (przeskok przyrostu ponad sufit)', () => {
  const MAX = 2_000;
  const bigResultLine = (id: string, bytes: number): string => `${JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-08-22T10:00:07.000Z',
    sessionId: SESSION,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: id,
        content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes) } }],
      }],
    },
  })}\n`;

  it('wynik większy niż sufit gasi martwe narzędzie i oddaje następne', async () => {
    const logs: string[] = [];
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ maxReadBytes: MAX, logger: (line) => logs.push(line) });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), toolUseLine('t-read', 'Read', { file_path: '/a.png' }));
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-read', 'czeka Read');

    await appendFile(
      filePath(),
      bigResultLine('t-read', MAX * 3) + toolUseLine('t-bash', 'Bash', { command: 'ls' }),
    );
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-bash', 'czeka Bash');
    expect(texts(events)).toContain(GAP_MESSAGE.text);
    expect(logs.some((line) => line.includes('skipped'))).toBe(true);
  });

  it('przeskok bez żadnej kompletnej linii w ogonie i tak gasi narzędzie i zadania', async () => {
    await writeFile(filePath(), userLine('start') + backgroundStart('b1'));
    const { events } = start({ maxReadBytes: MAX });
    await waitFor(() => taskEvents(events).length === 1, 'start zadania');

    await appendFile(filePath(), toolUseLine('t-read', 'Read', { file_path: '/a.png' }));
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-read', 'czeka Read');

    // Sam wielki wynik: ogon po przeskoku to koniec JEDNEJ linii, czyli zero wpisów do sparsowania.
    await appendFile(filePath(), bigResultLine('t-read', MAX * 3));
    await waitFor(() => pendings(events).at(-1)?.pending === null, 'pending wygaszony');
    await waitFor(() => taskEvents(events).at(-1)?.tasks.length === 0, 'plakietka wygaszona');
    expect(texts(events)).toContain(GAP_MESSAGE.text);
  });

  it('echo zarejestrowane przed luką nie ukrywa późniejszej wiadomości z terminala', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start({ maxReadBytes: MAX });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('zrób zrzut');
    // Echo własnego promptu ląduje w PRZESKOCZONEJ części pliku — follower go nie zobaczy.
    await appendFile(
      filePath(),
      userLine('zrób zrzut') + toolUseLine('t-read', 'Read', { file_path: '/a.png' })
        + bigResultLine('t-read', MAX * 3),
    );
    await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
    await appendFile(filePath(), userLine('zrób zrzut'));
    await waitFor(() => texts(events).includes('zrób zrzut'), 'wiadomość z terminala');
  });

  it('po przeskoku przyrost końców bez startu liczy się od nowa', async () => {
    await writeFile(filePath(), userLine('start') + backgroundDone('bprzed1') + backgroundDone('bprzed2'));
    const { events } = start({ maxReadBytes: MAX });
    await waitFor(() => taskEvents(events).length === 1, 'końce z ogona');
    expect(taskEvents(events)[0]?.ended).toEqual(['bprzed1', 'bprzed2']);

    // Wielki wynik idzie w lukę, a koniec własnej komendy subagenta stoi już w zachowanym ogonie.
    await appendFile(filePath(), bigResultLine('t-read', MAX * 3) + backgroundDone('bpo'));
    await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
    await waitFor(() => taskEvents(events).length === 2, 'koniec po przeskoku');
    await quiet();
    expect(taskEvents(events).slice(1)).toEqual([{ type: 'tasks', tasks: [], ended: ['bpo'] }]);
  });

  it('przyrost mieszczący się w suficie czyta się bez przeskoku', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ maxReadBytes: MAX });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), toolUseLine('t-read', 'Read', { file_path: '/a.png' }));
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-read', 'czeka Read');
    await appendFile(filePath(), bigResultLine('t-read', MAX / 2));
    await waitFor(() => pendings(events).at(-1)?.pending === null, 'wynik sparowany');
    expect(texts(events)).not.toContain(GAP_MESSAGE.text);
  });

  it('przyrost DOKŁADNIE równy sufitowi to jeszcze nie luka', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ maxReadBytes: MAX });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), toolUseLine('t-read', 'Read', { file_path: '/a.png' }));
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-read', 'czeka Read');
    // Długość linii liczona w BAJTACH (z narzutem JSON i `\n`), dopasowana do sufitu co do bajtu.
    const overhead = Buffer.byteLength(bigResultLine('t-read', 0));
    const exact = bigResultLine('t-read', MAX - overhead);
    expect(Buffer.byteLength(exact)).toBe(MAX);
    await appendFile(filePath(), exact);
    await waitFor(() => pendings(events).at(-1)?.pending === null, 'wynik sparowany');
    expect(texts(events)).not.toContain(GAP_MESSAGE.text);
  });

  it('domyślny sufit mieści zrzut ekranu z incydentu (1,35 MB) bez przeskoku', async () => {
    expect(FOLLOW_MAX_READ_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    await appendFile(filePath(), toolUseLine('t-read', 'Read', { file_path: '/a.png' }));
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-read', 'czeka Read');
    await appendFile(
      filePath(),
      bigResultLine('t-read', 1_346_397) + toolUseLine('t-bash', 'Bash', { command: 'ls' }),
    );
    await waitFor(() => pendings(events).at(-1)?.pending?.id === 't-bash', 'czeka Bash');
    expect(texts(events)).not.toContain(GAP_MESSAGE.text);
  });
});

describe('brak pliku transkryptu', () => {
  /**
   * TEST OBOWIĄZKOWY.
   *
   * Plik sesji wznowionej międzykatalogowo zostaje w slugu ORYGINALNYM. Gdyby follower szukał
   * go wyłącznie po `cwd`, zdrowa sesja dostałaby po 15 s alarm „transkrypt nie powstaje".
   */
  it('plik pod innym slugiem jest znajdowany globem i NIE ma alarmu', async () => {
    const otherDir = join(root, projectSlug('/Users/u/Projects/birch'));
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, `${SESSION}.jsonl`), userLine('rozmowa spod innego slugu'));

    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia spod innego slugu');
    now += 60_000;
    await quiet();

    expect(history(events).messages).toHaveLength(1);
    expect(errors(events)).toEqual([]);
  });

  it('plik, który nie powstaje NIGDZIE, daje alarm — dokładnie raz', async () => {
    const { follower, events } = start();
    await quiet();
    expect(errors(events)).toEqual([]);

    // Strażnik uzbraja się dopiero wtedy, gdy jest POWÓD oczekiwać pliku: wysłana
    // wiadomość albo rozpoczęta tura. Bez tego kroku alarmu nie ma i nie ma go mieć.
    follower.expectTranscript();
    // Zegar okna karencji jest wstrzykiwany: test nie czeka 15 s realnego czasu.
    now += 20_000;
    await waitFor(() => errors(events).length > 0, 'alarm o braku transkryptu');
    now += 20_000;
    await quiet();

    expect(errors(events)).toEqual([{ type: 'error', reason: 'no-transcript' }]);
  });

  /**
   * Regresja: pusta sesja bez alarmu.
   *
   * Pusta sesja stoi na powłoce i nie ma pliku transkryptu, bo nikt jeszcze nic nie napisał.
   * Alarm „transkrypt tej sesji nie powstaje" byłby w tej sytuacji FAŁSZYWY — a alarm o braku
   * czegoś, czego nikt nie zamówił, uczy ignorować wszystkie alarmy.
   */
  it('PUSTA sesja bez ani jednej tury NIE alarmuje — nawet po minucie', async () => {
    const { events } = start();
    now += 60_000;
    await quiet();
    await quiet();
    expect(errors(events)).toEqual([]);
  });

  it('`/clear` ROZBRAJA strażnika — nowy plik też czeka na pierwszy prompt', async () => {
    const { follower, events } = start();
    follower.expectTranscript();
    now += 20_000;
    await waitFor(() => errors(events).length === 1, 'alarm dla pierwszej sesji');

    follower.repoint(SESSION_B);
    now += 60_000;
    await quiet();
    await quiet();
    // Drugiego alarmu NIE MA: po `/clear` panel znowu czeka na pierwsze zdanie człowieka.
    expect(errors(events)).toHaveLength(1);
  });

  it('`hasTranscript` mówi, czy plik jest ZNALEZIONY (ścieżka ekranowa)', async () => {
    const { follower, events } = start();
    // Do końca globu po uuid odpowiedź brzmi „nie wiem" — nie „nie ma".
    expect(follower.hasTranscript()).toBe('unknown');
    await quiet();
    expect(follower.hasTranscript()).toBe('no');

    await createTranscript(filePath(), userLine('pierwszy prompt'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(follower.hasTranscript()).toBe('yes');
  });

  it('`hasTranscript` po `repoint()` wraca do „nie wiem", a identyfikator spoza wzorca to „nie"', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(follower.hasTranscript()).toBe('yes');

    // Stary plik przestaje być odpowiedzią NATYCHMIAST: nowy uuid to nowe pytanie.
    follower.repoint(SESSION_B);
    expect(follower.hasTranscript()).toBe('unknown');
    await waitFor(() => texts(events).includes(REPOINT_MESSAGE.text), 'komunikat repoint');
    await quiet();
    expect(follower.hasTranscript()).toBe('no');

    // Identyfikator spoza wzorca = pliku nie ma i nie będzie; driver nie ma na co czekać.
    follower.repoint('nie-uuid');
    await waitFor(() => texts(events).filter((t) => t === REPOINT_MESSAGE.text).length === 2, 'drugi repoint');
    expect(follower.hasTranscript()).toBe('no');
  });

  /**
   * `#prime` jest wołane przez `void`, więc wyjątek w środku `await` bez obsługi byłby cichą
   * śmiercią followera — bez historii, bez taila i bez alarmu `no-transcript`.
   * Odczyt z założenia nie rzuca, dlatego test podstawia własny (`io`).
   */
  it('wyjątek w `#prime` NIE zabija followera — następny tick czyta plik', async () => {
    await writeFile(filePath(), userLine('start'));
    const logs: string[] = [];
    let throws = 1;
    const { events } = start({
      logger: (message) => { logs.push(message); },
      io: {
        sizeOf: async (path) => {
          if (throws > 0) {
            throws -= 1;
            throw new Error('EIO: symulowana awaria odczytu');
          }
          return (await stat(path)).size;
        },
      },
    });

    await waitFor(() => events.some((e) => e.type === 'history'), 'historia po ponowieniu');
    expect(history(events).messages).toHaveLength(1);
    // Jedna linia w dzienniku, z treścią wyjątku — nie stos i nie cisza.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('symulowana awaria odczytu');

    // Tail żyje: dopisana linia dojeżdża normalną ścieżką.
    await appendFile(filePath(), userLine('po awarii'));
    await waitFor(() => texts(events).includes('po awarii'), 'tail po ponowieniu');
  });

  it('wyjątek w `#prime` nie rozbraja alarmu `no-transcript`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start({
      logger: () => undefined,
      io: { sizeOf: () => Promise.reject(new Error('EIO: trwała awaria odczytu')) },
    });
    follower.expectTranscript();
    now += 20_000;
    // Po karencji alarm leci mimo pliku na dysku: dla użytkownika treści i tak nie ma.
    await waitFor(() => errors(events).length === 1, 'alarm mimo wyjątku');
    await quiet();
    expect(errors(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'history')).toBe(false);
  });

  it('plik, który powstaje PO alarmie, dowozi historię', async () => {
    const { follower, events } = start();
    follower.expectTranscript();
    now += 20_000;
    await waitFor(() => errors(events).length === 1, 'alarm');

    await createTranscript(filePath(), userLine('spóźniony pierwszy prompt'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia po alarmie');
    expect(history(events).messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Relokacja pliku
// ---------------------------------------------------------------------------

/**
 * `EnterWorktree` przenosi transkrypt `rename(2)`-em do slugu worktree: ten sam inode, ta sama
 * treść, inny katalog projektu. Zmierzone:
 * bez relokacji follower kończył `#drainOnce` po `ENOENT` i milczał do końca życia panelu.
 */
describe('relokacja pliku transkryptu', () => {
  const WORKTREE = '/Users/u/Projects/atlas/.claude/worktrees/dialogi';

  /** `EnterWorktree`: ten sam plik ląduje w slugu worktree, stary adres znika. */
  const moveToWorktree = async (): Promise<string> => {
    const dst = join(root, projectSlug(WORKTREE));
    await mkdir(dst, { recursive: true });
    const path = join(dst, `${SESSION}.jsonl`);
    await rename(filePath(), path);
    return path;
  };

  const relocations = (
    events: readonly FollowEvent[],
  ): Extract<FollowEvent, { type: 'relocated' }>[] => events.filter(
    (e): e is Extract<FollowEvent, { type: 'relocated' }> => e.type === 'relocated',
  );

  it('plik przeniesiony do innego slugu jest czytany DALEJ, od tego samego offsetu', async () => {
    await createTranscript(filePath(), userLine('przed przeprowadzką'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'tail przed' }]));
    await waitFor(() => texts(events).includes('tail przed'), 'tail przed przeprowadzką');

    const moved = await moveToWorktree();
    await appendFile(moved, assistantLine([{ type: 'text', text: 'tail po' }]));

    await waitFor(() => texts(events).includes('tail po'), 'tail po przeprowadzce');
    await quiet();
    // Treść jedzie DALEJ, a nie od nowa: żadnej drugiej historii i żadnego duplikatu linii.
    expect(events.filter((e) => e.type === 'history')).toHaveLength(1);
    expect(texts(events).filter((t) => t === 'tail przed')).toHaveLength(1);
    expect(texts(events).filter((t) => t === 'tail po')).toHaveLength(1);
    // Nowy adres jedzie do satelitów RAZ, razem z katalogiem obok transkryptu.
    expect(relocations(events)).toEqual([{
      type: 'relocated',
      path: moved,
      dir: moved.slice(0, moved.length - '.jsonl'.length),
    }]);
    expect(follower.hasTranscript()).toBe('yes');
    // Przeniesienie NIE jest `/clear` ani skróceniem — użytkownik nie ma o czym wiedzieć.
    expect(texts(events)).not.toContain(REPOINT_MESSAGE.text);
    expect(texts(events)).not.toContain(TRUNCATED_MESSAGE.text);
  });

  it('plik skasowany: jedna linia w dzienniku, `hasTranscript()` mówi prawdę, bez pętli', async () => {
    const logs: string[] = [];
    await createTranscript(filePath(), userLine('krótkie życie'));
    const { follower, events } = start({ logger: (message) => logs.push(message) });
    await primed(events);
    expect(follower.hasTranscript()).toBe('yes');

    await rm(filePath());

    await waitFor(() => logs.length > 0, 'linia o zniknięciu pliku');
    // Kilkanaście ticków `stat` PO wyczerpaniu prób: ani drugiej linii, ani zdarzenia.
    const after = events.length;
    await quiet();
    await quiet();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(SESSION);
    expect(events.length).toBe(after);
    // Glob przebiegł i nic nie znalazł — to jest odpowiedź „nie ma", nie „tak" o starym adresie.
    expect(follower.hasTranscript()).toBe('no');
  });

  it('plik pod nowym adresem KRÓTSZY niż offset idzie ścieżką skrócenia', async () => {
    await createTranscript(filePath(), userLine('długa rozmowa') + userLine('druga linia'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    const dst = join(root, projectSlug(WORKTREE));
    await mkdir(dst, { recursive: true });
    await rm(filePath());
    await writeFile(join(dst, `${SESSION}.jsonl`), '');

    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'komunikat o skróceniu');
  });
});

// ---------------------------------------------------------------------------
// Realny fixture
// ---------------------------------------------------------------------------

describe('fixture z realnego magazynu', () => {
  it('przechodzi przez `transcript-sample.jsonl` bez wywrotki i oddaje rozmowę', async () => {
    const fixture = await readFile(
      join(import.meta.dirname, 'fixtures', 'herdr', 'transcript-sample.jsonl'), 'utf8',
    );
    await writeFile(filePath(), fixture);

    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia z fixture');

    const messages = history(events).messages;
    // 7 wiadomości — liczba udokumentowana w `fixtures/herdr/README.md`; gdyby parser zaczął
    // przepuszczać wpisy `system`/`attachment` albo znacznik przerwania, ta liczba urośnie i test o tym powie.
    expect(messages).toHaveLength(7);
    for (const message of messages) {
      expect(['user', 'assistant']).toContain(message.role);
      expect(message.blocks.length).toBeGreaterThan(0);
    }
    // Obrazek z realnego wpisu nie przenosi base64 do transkryptu Raroga.
    const all = messages.flatMap((m) => m.blocks.map(blockText)).join('\n');
    expect(all).not.toContain('iVBORw0KGgo');
  });

  it('cały fixture zużycia: limit z modelu, granica go nie obniża, tokeny po kompakcji', async () => {
    const fixture = await readFile(
      join(import.meta.dirname, 'fixtures', 'herdr', 'transcript-usage.jsonl'), 'utf8',
    );
    await writeFile(filePath(), fixture);

    const { events } = start();
    await waitFor(() => usages(events).length > 0, 'zużycie z fixture');
    await quiet();

    // Cała historia to JEDNA porcja → jedna migawka zużycia, a nie dziewięć kolejnych sum.
    // `claude-fable-5` jest w `KNOWN_CONTEXT_LIMITS`; auto-granica przy 462 682 to próg kompakcji.
    expect(usages(events)).toHaveLength(1);
    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 14_002, limit: 1_000_000, source: 'model',
    });
  });

  it('close() domyka strumień i nie zostawia timerów', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    let ended = false;
    void (async () => {
      for await (const _ of follower.events) void _;
      ended = true;
    })();
    follower.close();
    await waitFor(() => ended, 'koniec strumienia');

    await appendFile(filePath(), userLine('po zamknięciu'));
    await quiet();
    expect(texts(events)).toEqual([]);
  });
});

/**
 * Echo odroczone: wpis okna echa z TOKENEM. Wpis promptu z pliku nie znika jak zwykłe echo,
 * tylko idzie dalej z polem `echoToken` w kolejności pliku — manager podstawia w to miejsce
 * wiadomość, którą trzyma od wysyłki.
 */
describe('echo odroczone', () => {
  const AT = '2026-10-14T08:00:00.000Z';
  const LATER = '2026-10-14T08:00:05.000Z';
  const REGISTERED = Date.parse(AT);
  /** Wchłonięty prompt tak, jak zapisuje go CLI 2.1.296: `remove` + załącznik kolejki. */
  const absorbed = (text: string, at = LATER): string => [
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at, sessionId: SESSION, content: text },
    {
      type: 'attachment', isSidechain: false, timestamp: at, sessionId: SESSION,
      attachment: {
        type: 'queued_command', prompt: text, source_uuid: '4736773d-7cd6-4c16-afeb-64ec815377dc',
        commandMode: 'prompt', origin: { kind: 'human' }, timestamp: at, humanTurn: 3,
      },
    },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join('');
  type Message = Extract<FollowEvent, { type: 'message' }>;
  const messages = (events: readonly FollowEvent[]): Message[] =>
    events.filter((e): e is Message => e.type === 'message');
  const flat = (message: { blocks: InternalBlock[] }): string => message.blocks.map(blockText).join(' ');
  const dropped = (events: readonly FollowEvent[]): string[] => events
    .filter((e): e is Extract<FollowEvent, { type: 'echo-dropped' }> => e.type === 'echo-dropped')
    .map((e) => e.token);

  it('wpis `user` z tokenem idzie dalej z `echoToken` w kolejności pliku, bez `turn-input`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    now = REGISTERED;
    follower.dropEcho('a jeszcze to', 'tok-1');
    await appendFile(filePath(), assistantLine([{ type: 'text', text: 'pracuję' }], { timestamp: AT })
      + userLine('a jeszcze to', { timestamp: LATER })
      + assistantLine([{ type: 'text', text: 'odpowiedź' }], { timestamp: LATER }));
    await waitFor(() => messages(events.slice(before)).length === 3, 'trzy wiadomości');
    const live = messages(events.slice(before));
    expect(live.map(flat)).toEqual(['pracuję', 'a jeszcze to', 'odpowiedź']);
    expect(live.map((m) => m.echoToken)).toEqual([undefined, 'tok-1', undefined]);
    expect(events.slice(before).filter((e) => e.type === 'turn-input')).toEqual([]);
  });

  it('prompt wchłonięty w turę (załącznik kolejki) też niesie token', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    now = REGISTERED;
    follower.dropEcho('w trakcie', 'tok-2');
    await appendFile(filePath(), absorbed('w trakcie'));
    await waitFor(() => messages(events.slice(before)).length === 1, 'wchłonięty prompt');
    expect(messages(events.slice(before))[0]?.echoToken).toBe('tok-2');
  });

  it('starszy wpis o tym samym tekście (sprzed rejestracji) nie zjada tokenu', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    // Rejestracja 10 s po tym, jak terminal zapisał „ok", którego follower jeszcze nie przeczytał.
    now = REGISTERED + 10_000;
    follower.dropEcho('ok', 'tok-3');
    await appendFile(filePath(), userLine('ok', { timestamp: AT })
      + userLine('ok', { timestamp: '2026-10-14T08:00:11.000Z' }));
    await waitFor(() => messages(events.slice(before)).length === 2, 'oba wpisy');
    expect(messages(events.slice(before)).map((m) => m.echoToken)).toEqual([undefined, 'tok-3']);
  });

  it('historia przy podpięciu: wpis z tokenem zostaje NA SWOJEJ POZYCJI z `echoToken`', async () => {
    await writeFile(filePath(), userLine('zrób to', { timestamp: AT })
      + assistantLine([{ type: 'text', text: 'Zaczynam.' }], { timestamp: AT })
      + absorbed('z Raroga')
      + assistantLine([{ type: 'text', text: 'Dobrze, to też.' }], { timestamp: LATER }));
    now = REGISTERED;
    const { follower, events } = start();
    follower.dropEcho('z Raroga', 'tok-4');
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    const items = history(events).messages;
    expect(items.map(flat)).toEqual(['zrób to', 'Zaczynam.', 'z Raroga', 'Dobrze, to też.']);
    expect(items.map((m) => m.echoToken)).toEqual([undefined, undefined, 'tok-4', undefined]);
  });

  it('`forgetEcho`: wycofany wpis nie zjada identycznego promptu wpisanego potem', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    now = REGISTERED;
    follower.dropEcho('kontynuuj', 'tok-5');
    follower.forgetEcho('tok-5');
    await appendFile(filePath(), userLine('kontynuuj', { timestamp: LATER }));
    await waitFor(() => messages(events.slice(before)).length === 1, 'prompt z terminala');
    expect(messages(events.slice(before))[0]?.echoToken).toBeUndefined();
  });

  it('okno przycinane osobno: zwykłe echo nie wypycha wpisu z tokenem; dziewiąty z tokenem → `echo-dropped`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    follower.dropEcho('z tokenem', 'tok-6');
    for (let i = 0; i <= ECHO_WINDOW; i += 1) follower.dropEcho(`bez ${String(i)}`);
    // Najstarszy BEZ tokenu wypadł z okna zwykłego echa, wpis z tokenem został.
    await appendFile(filePath(), userLine('bez 0'));
    await waitFor(() => texts(events.slice(before)).includes('bez 0'), 'wypchnięty wpis bez tokenu');
    expect(dropped(events)).toEqual([]);

    for (let i = 0; i < ECHO_WINDOW; i += 1) follower.dropEcho(`t ${String(i)}`, `tok-t${String(i)}`);
    await waitFor(() => dropped(events).length > 0, '`echo-dropped`');
    expect(dropped(events)).toEqual(['tok-6']);
  });

  /** Regresja: pełne okno wpisów z tokenem zjadało świeże zwykłe echo. */
  it('osiem wstrzymanych nie wypycha świeżego zwykłego echa: dziewiąty prompt nie wraca z pliku drugi raz', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await primed(events);
    const before = events.length;

    now = REGISTERED;
    for (let i = 0; i < ECHO_WINDOW; i += 1) follower.dropEcho(`czeka ${String(i)}`, `tok-w${String(i)}`);
    follower.dropEcho('dziewiąty');
    let file = '';
    for (let i = 0; i < ECHO_WINDOW; i += 1) file += userLine(`czeka ${String(i)}`, { timestamp: LATER });
    await appendFile(filePath(), file + userLine('dziewiąty', { timestamp: LATER }));
    await waitFor(() => messages(events.slice(before)).length === ECHO_WINDOW, 'wstrzymane z tokenem');
    await quiet();
    const live = messages(events.slice(before));
    expect(live.every((m) => m.echoToken !== undefined)).toBe(true);
    expect(live.map(flat)).not.toContain('dziewiąty');
    expect(dropped(events)).toEqual([]);
  });

  it('wiek ponad TTL: wpis z tokenem wypada z `echo-dropped` przy następnej rejestracji', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');

    follower.dropEcho('stary', 'tok-7');
    now += ECHO_TTL_MS + 1;
    follower.dropEcho('nowy');
    await waitFor(() => dropped(events).length > 0, '`echo-dropped`');
    expect(dropped(events)).toEqual(['tok-7']);
  });
});

/*
 * Prompt zablokowany przez hook `UserPromptSubmit`
 * (`docs/dialogs.md`, „Prompt blocked by a hook”). CLI nie pisze wpisu `user`, tylko wpis `system` z
 * `promptSubmitEnding`; follower przechwytuje go PRZED `#commandLine`, w ogonie i w historii, i gasi nim echo wysyłki z
 * Raroga.
 */
describe('prompt zablokowany przez hook', () => {
  const MEASURED = join(import.meta.dirname, 'fixtures/herdr/commands/measured');
  type Json = Record<string, unknown>;
  /*
   * Nagrania mają w ścieżkach inną nazwę katalogu załączników; serwer zna tylko `UPLOAD_DIR_NAME`,
   * więc odczyt nagrania podmienia katalog w ścieżkach. Kształt ścieżki i reszta nagrania bez zmian.
   */
  const measured = (name: string): Json[] => readFileSync(join(MEASURED, name), 'utf8')
    .replace(/\/\.[a-z]+-uploads\//g, `/${UPLOAD_DIR_NAME}/`)
    .split('\n').filter((raw) => raw.trim() !== '').map((raw) => JSON.parse(raw) as Json);

  const blockedLine = (prompt: string, timestamp = '2026-10-19T18:00:00.500Z', reason = 'hook mówi nie'): string => `${JSON.stringify({
    type: 'system', subtype: 'informational', level: 'warning', isMeta: false, preventContinuation: true,
    content: `UserPromptSubmit operation blocked by hook:\n[/h.sh]: ${reason}\n\nOriginal prompt: ${prompt}`,
    promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason }, promptKept: false },
    timestamp, sessionId: SESSION,
  })}\n`;

  const blockedEvents = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'prompt-blocked' }>[] =>
    events.filter((e): e is Extract<FollowEvent, { type: 'prompt-blocked' }> => e.type === 'prompt-blocked');

  it('ogon: blokada promptu z Raroga → zdarzenie z trafionym echem, bez dymka `user` i bez `turn-input`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.dropEcho('zrób to z Raroga');
    await appendFile(filePath(), blockedLine('zrób to z Raroga'));
    await waitFor(() => blockedEvents(events).length === 1, 'blokada');
    expect(blockedEvents(events)[0]).toEqual({
      type: 'prompt-blocked', reason: 'hook mówi nie', promptKept: false, prompt: 'zrób to z Raroga', echoed: true,
      key: 'zrób to z Raroga',
    });
    await quiet();
    expect(texts(events)).toEqual([]);
    expect(events.some((e) => e.type === 'turn-input')).toBe(false);

    // Trafienie zużyło wpis okna: ten sam tekst wysłany potem w terminalu przechodzi jako wiadomość.
    await appendFile(filePath(), userLine('zrób to z Raroga'));
    await waitFor(() => texts(events).includes('zrób to z Raroga'), 'identyczny prompt z terminala');
  });

  it('ogon: prompt z terminala (bez echa) → zdarzenie z cytatem, `echoed: false`, bez dymka', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await appendFile(filePath(), blockedLine('wpisane przy Macu'));
    await waitFor(() => blockedEvents(events).length === 1, 'blokada');
    expect(blockedEvents(events)[0]).toMatchObject({ echoed: false, prompt: 'wpisane przy Macu', key: 'wpisane przy Macu' });
    expect(texts(events)).toEqual([]);
  });

  it('przechwycenie PRZED `#commandLine`: wpis blokady w ogonie nie staje się zwykłą notką `system`', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    await appendFile(filePath(), blockedLine('x'));
    await waitFor(() => blockedEvents(events).length === 1, 'blokada');
    expect(events.filter((e) => e.type === 'message')).toEqual([]);
  });

  it('historia: pierwszy prompt świeżej sesji (plik zakłada wpis blokady) → zdarzenie z trafionym echem', async () => {
    const { follower, events } = start();
    follower.dropEcho('pierwszy prompt');
    await createTranscript(filePath(), blockedLine('pierwszy prompt'));
    await waitFor(() => blockedEvents(events).length === 1, 'blokada z historii');
    expect(blockedEvents(events)[0]).toMatchObject({ echoed: true, key: 'pierwszy prompt' });
    // Historia bez wpisu blokady była pusta — nie wyszła wcale.
    expect(events.some((e) => e.type === 'history')).toBe(false);
  });

  it('historia: blokada z echem rozcina historię — przed nią historia, po niej reszta', async () => {
    const { follower, events } = start();
    follower.dropEcho('drugi');
    await createTranscript(filePath(), userLine('pierwszy') + blockedLine('drugi') + assistantLine([{ type: 'text', text: 'po' }]));
    await waitFor(() => events.filter((e) => e.type === 'history').length === 2, 'dwie porcje historii');
    expect(events.filter((e) => e.type === 'history' || e.type === 'prompt-blocked').map((e) => e.type))
      .toEqual(['history', 'prompt-blocked', 'history']);
  });

  it('historia bez echa (prompt spoza Raroga albo sprzed restartu) → notka z cytatem na swojej pozycji', async () => {
    await createTranscript(filePath(), userLine('pierwszy') + blockedLine('z terminala') + userLine('dalej'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    const messages = history(events).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'user']);
    expect(messages[1]?.promptBlocked).toEqual({ reason: 'hook mówi nie', prompt: 'z terminala' });
    expect(messages[1]?.blocks.map(blockText)).toEqual([
      "⚠ A hook blocked the prompt. It wasn't sent.\nhook mówi nie\nPrompt: z terminala",
    ]);
    expect(blockedEvents(events)).toEqual([]);
  });

  it('historia: duży cytat w polu `promptBlocked` przycięty (sufit wiadomości), cytat do echa pełny', async () => {
    const huge = 'słowo '.repeat(40_000).trim();
    await createTranscript(filePath(), blockedLine(huge));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    const field = history(events).messages[0]?.promptBlocked;
    expect(Buffer.byteLength(field?.prompt ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('stara identyczna blokada w historii nie zjada echa nowej wysyłki (czas każdego wpisu okna)', async () => {
    now = Date.parse('2026-10-19T18:00:00.000Z');
    const { follower, events } = start();
    follower.dropEcho('ten sam tekst');
    await createTranscript(filePath(), blockedLine('ten sam tekst', '2026-10-19T17:00:00.000Z'));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(history(events).messages[0]?.promptBlocked).toEqual({ reason: 'hook mówi nie', prompt: 'ten sam tekst' });

    // Nowa blokada (wpis ~350 ms po wysyłce) trafia w echo, którego stara blokada nie zjadła.
    await appendFile(filePath(), blockedLine('ten sam tekst', '2026-10-19T18:00:00.350Z'));
    await waitFor(() => blockedEvents(events).length === 1, 'nowa blokada');
    expect(blockedEvents(events)[0]?.echoed).toBe(true);
  });

  it('cytat po `humanTextOf` trafia w echo wysłanego tekstu we wszystkich sześciu wariantach', async () => {
    const entries = measured('prompt-block-quote-fidelity-2.1.303.jsonl');
    const sent = entries.filter((entry) => entry['_pomiar'] === 'wyslany').map((entry) => String(entry['tekst']));
    expect(sent).toHaveLength(6);
    const blocks = entries.filter((entry) => entry['promptSubmitEnding'] !== undefined);
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    for (const text of sent) follower.dropEcho(text);
    await appendFile(filePath(), blocks.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    await waitFor(() => blockedEvents(events).length === 6, 'sześć blokad');
    expect(blockedEvents(events).map((e) => e.echoed)).toEqual([true, true, true, true, true, true]);
    expect(texts(events)).toEqual([]);
  });

  it('dosłowny znacznik wklejki wpisany przez człowieka nie trafia w echo (ta sama asymetria co wpis `user`)', async () => {
    const literal = 'zobacz <pasted_content id="ab12">to</pasted_content id="ab12"> dalej';
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.dropEcho(literal);
    await appendFile(filePath(), blockedLine(literal));
    await waitFor(() => blockedEvents(events).length === 1, 'blokada');
    expect(blockedEvents(events)[0]?.echoed).toBe(false);
  });

  it('wyłącznik (`promptBlock: false`): wpis blokady pomijany, echo zostaje', async () => {
    await writeFile(filePath(), userLine('start'));
    const { follower, events } = start({ promptBlock: false });
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    follower.dropEcho('zablokowany');
    await appendFile(filePath(), blockedLine('zablokowany') + assistantLine([{ type: 'text', text: 'znacznik' }]));
    await waitFor(() => texts(events).includes('znacznik'), 'wpis za blokadą');
    expect(blockedEvents(events)).toEqual([]);
    expect(texts(events)).toEqual(['znacznik']);
    // Echo nie zostało zużyte: identyczny wpis `user` dalej gaśnie.
    await appendFile(filePath(), userLine('zablokowany') + assistantLine([{ type: 'text', text: 'znacznik 2' }]));
    await waitFor(() => texts(events).includes('znacznik 2'), 'drugi znacznik');
    expect(texts(events)).not.toContain('zablokowany');
  });
});

describe('`openToolUses`: „nie wiem” przed odczytem, lista po nim (dowód trybu cienia)', () => {
  // Pusta lista zabiera hookowi dowód „dialog stoi” i zwalnia go jako sierotę — więc pustą wolno oddać dopiero
  // po odczycie pliku. Przed nim (brak pliku, glob w toku) odpowiedź to `null`.
  it('bez pliku `null`; po historii z otwartym `tool_use` lista; po `tool_result` pusta', async () => {
    const { follower, events } = start();
    expect(follower.openToolUses?.()).toBeNull();
    await waitFor(() => events.some((e) => e.type === 'artifacts'), 'pierwsza wypłata bez pliku');
    expect(follower.openToolUses?.()).toBeNull();

    await createTranscript(filePath(), userLine('zbuduj') + assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
    ]));
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(follower.openToolUses?.()?.map((tool) => [tool.id, tool.toolName])).toEqual([['toolu_1', 'Bash']]);

    await appendFile(filePath(), userLine([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]));
    await waitFor(() => follower.openToolUses?.()?.length === 0, 'domknięte wywołanie');
  });
});

describe('`transcriptOffset`: pozycja dla przeglądu dowodów kanału zgód', () => {
  // Przegląd szuka od tej pozycji wstecz początku tury, więc nie może ona stać ZA początkiem niedokończonej linii.
  it('bez pliku `null`; po pełnych liniach koniec pliku; przy niedokończonej linii jej początek (także po UTF-8)', async () => {
    const { follower, events } = start();
    expect(follower.transcriptOffset?.()).toBeNull();

    const head = userLine('zbuduj') + assistantLine([{ type: 'text', text: 'robię' }]);
    await createTranscript(filePath(), head);
    await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
    expect(follower.transcriptOffset?.()).toEqual({ file: filePath(), lineStart: Buffer.byteLength(head) });

    // Niedokończona linia rozcięta w środku znaku UTF-8 (`ż` to dwa bajty).
    const tail = Buffer.from(userLine('żółw'));
    // Pierwszy bajt znaku dekoduje się jako U+FFFD (3 bajty): pozycja wychodzi 2 bajty PRZED początkiem linii.
    await appendFile(filePath(), tail.subarray(0, tail.indexOf(Buffer.from('ż')) + 1));
    await waitFor(() => follower.transcriptOffset?.()?.lineStart === Buffer.byteLength(head) - 2, 'odczyt ogona');

    await appendFile(filePath(), tail.subarray(tail.indexOf(Buffer.from('ż')) + 1));
    await waitFor(() => follower.transcriptOffset?.()?.lineStart === Buffer.byteLength(head) + tail.length, 'pełna linia');
  });
});

// ---------------------------------------------------------------------------
// Nazwa rozmowy z `custom-title`
// ---------------------------------------------------------------------------

describe('nazwa rozmowy z `custom-title`', () => {
  const RENAME_FIXTURE = join(import.meta.dirname, 'fixtures/herdr/commands/measured/rename-custom-title-2.1.319.jsonl');
  const titleLine = (customTitle: string, sessionId = SESSION): string =>
    `${JSON.stringify({ type: 'custom-title', customTitle, sessionId })}\n`;
  const agentNameLine = (agentName: string, sessionId = SESSION): string =>
    `${JSON.stringify({ type: 'agent-name', agentName, sessionId })}\n`;
  const titles = (events: readonly FollowEvent[]): string[] => events
    .filter((e): e is Extract<FollowEvent, { type: 'custom-title' }> => e.type === 'custom-title')
    .map((e) => e.title);

  it('wpis `custom-title` dopisany na żywo daje nazwę w tym samym odczycie, bez tury', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start();
    await primed(events);
    expect(titles(events)).toEqual([]);

    // Sam `/rename`: wpis nazwy bez wypowiedzi asystenta i bez nowego promptu (pomiar na CLI 2.1.319).
    await appendFile(filePath(), titleLine('demo-eksport'));
    await waitFor(() => titles(events).length > 0, 'nazwa rozmowy');
    await quiet();

    expect(titles(events)).toEqual(['demo-eksport']);
  });

  it('przy podpięciu wygrywa ostatni wpis z okna ogona', async () => {
    await writeFile(filePath(), readFileSync(RENAME_FIXTURE, 'utf8'));
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa rozmowy z okna');
    await quiet();

    expect(titles(events)).toEqual(['demo-eksport-csv']);
  });

  it('wpis sprzed okna ogona znajduje przegląd pliku z igłą, także w nowym followerze (restart)', async () => {
    let content = titleLine('stara-nazwa') + titleLine('nazwa-sprzed-okna');
    for (let i = 0; i < 40; i += 1) content += userLine(`prompt ${String(i)}`);
    await writeFile(filePath(), content);
    const window = { historyBytes: 900, historyMaxBytes: 900 };

    const first = start(window);
    await primed(first.events);
    // Okno ogona nie sięga początku pliku: bez przeglądu nazwy by nie było.
    expect(history(first.events).messages.length).toBeLessThan(40);
    await waitFor(() => titles(first.events).length > 0, 'nazwa sprzed okna');
    await quiet();
    expect(titles(first.events)).toEqual(['nazwa-sprzed-okna']);

    // Restart serwera = nowy follower na tym samym pliku: ta sama nazwa od nowa.
    first.follower.close();
    const second = start(window);
    await primed(second.events);
    await waitFor(() => titles(second.events).length > 0, 'nazwa po restarcie');
    expect(titles(second.events)).toEqual(['nazwa-sprzed-okna']);
  });

  it('sufit przeglądu nazwy: 1 GiB, ten sam co przeglądu zadań i artefaktów', () => {
    expect(TITLE_SCAN_MAX_BYTES).toBe(1024 * 1024 * 1024);
    expect(TITLE_SCAN_MAX_BYTES).toBe(MAIN_SCAN_MAX_BYTES);
  });

  it('plik ponad sufit przeglądu nazwy (sufit wstrzyknięty): nazwy sprzed okna nie ma, jedna linia w logu', async () => {
    let content = titleLine('nazwa-sprzed-okna');
    for (let i = 0; i < 40; i += 1) content += userLine(`prompt ${String(i)}`);
    await writeFile(filePath(), content);
    const size = Buffer.byteLength(content);
    const window = { historyBytes: 900, historyMaxBytes: 900 };

    const logs: string[] = [];
    const over = start({ ...window, tasksScan: { titleMaxBytes: size - 1 }, logger: (line) => logs.push(line) });
    await primed(over.events);
    await quiet();
    expect(titles(over.events)).toEqual([]);
    const capped = logs.filter((line) => line.includes('to scan for the session name, more than the scan cap'));
    expect(capped).toEqual([`rarog: transcript ${SESSION}: ${String(size)} B to scan for the session name, `
      + 'more than the scan cap']);
    over.follower.close();

    // Równo z sufitem to jeszcze nie „za dużo”.
    const exact = start({ ...window, tasksScan: { titleMaxBytes: size } });
    await primed(exact.events);
    await waitFor(() => titles(exact.events).length > 0, 'nazwa przy pliku równym sufitowi');
    expect(titles(exact.events)).toEqual(['nazwa-sprzed-okna']);
  });

  it('wpis z okna wygrywa z wpisem sprzed okna', async () => {
    let content = titleLine('nazwa-sprzed-okna');
    for (let i = 0; i < 40; i += 1) content += userLine(`prompt ${String(i)}`);
    content += titleLine('nazwa-z-okna');
    await writeFile(filePath(), content);

    const { events } = start({ historyBytes: 900, historyMaxBytes: 900 });
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa z okna');
    await quiet();

    expect(titles(events)).toEqual(['nazwa-z-okna']);
  });

  it('ta sama nazwa drugi raz nie daje drugiego zdarzenia', async () => {
    await writeFile(filePath(), userLine('start') + titleLine('demo-eksport'));
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa rozmowy');

    // CLI powtarza wpis nazwy przy kolejnych turach: bez zmiany wartości nic nie jedzie.
    await appendFile(filePath(), userLine('dalej') + titleLine('demo-eksport'));
    await waitFor(() => texts(events).includes('dalej'), 'dopisek');
    await quiet();

    expect(titles(events)).toEqual(['demo-eksport']);
  });

  it('`/clear` — nowy plik z własnym wpisem `custom-title` daje nazwę od nowa', async () => {
    await writeFile(filePath(), userLine('stara sesja') + titleLine('demo-eksport'));
    // Pomiar 2.1.302: CLI wpisuje nazwę do pliku nowej sesji od razu po `/clear`.
    await writeFile(filePath(SESSION_B), titleLine('demo-eksport', SESSION_B));
    const { follower, events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa starej rozmowy');
    const before = events.length;

    follower.repoint(SESSION_B);
    await waitFor(() => titles(events.slice(before)).length > 0, 'nazwa nowej rozmowy');

    expect(titles(events.slice(before))).toEqual(['demo-eksport']);
  });

  it('`/resume` rozmowy bez `custom-title` — pamięć nazwy per sesja silnika, bez zdarzenia', async () => {
    await writeFile(filePath(), userLine('stara sesja') + titleLine('demo-eksport'));
    await writeFile(filePath(SESSION_B), userLine('wznowiona rozmowa'));
    const { follower, events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa starej rozmowy');
    const before = events.length;

    follower.repoint(SESSION_B);
    await waitFor(() => events.slice(before).some((e) => e.type === 'history'), 'historia wznowionej');
    await quiet();
    expect(titles(events.slice(before))).toEqual([]);

    // Pamięć wyzerowana: ta sama nazwa w nowej rozmowie jest dla niej nowa.
    await appendFile(filePath(SESSION_B), titleLine('demo-eksport', SESSION_B));
    await waitFor(() => titles(events.slice(before)).length > 0, 'nazwa wznowionej');
    expect(titles(events.slice(before))).toEqual(['demo-eksport']);
  });

  it('plik skrócony — ponowny skan nowej treści daje jej nazwę', async () => {
    await writeFile(filePath(), userLine('stara treść '.repeat(20)) + titleLine('stara-nazwa'));
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'stara nazwa');

    await writeFile(filePath(), titleLine('nowa-nazwa'));
    await waitFor(() => titles(events).length > 1, 'nazwa po skróceniu');
    await quiet();

    expect(titles(events)).toEqual(['stara-nazwa', 'nowa-nazwa']);
  });

  it('plik skrócony bez `custom-title` w nowej treści — nazwa bez zmian, bez zdarzenia', async () => {
    await writeFile(filePath(), userLine('stara treść '.repeat(20)) + titleLine('stara-nazwa'));
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'stara nazwa');

    await writeFile(filePath(), userLine('a'));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await quiet();

    expect(titles(events)).toEqual(['stara-nazwa']);
  });

  it('przeskok przyrostu — nazwa z pominiętego kawałka wraca przeglądem', async () => {
    await writeFile(filePath(), userLine('start'));
    const { events } = start({ maxReadBytes: 2_000 });
    await primed(events);

    await appendFile(filePath(), titleLine('nazwa-w-luce') + userLine('x'.repeat(4_000)) + userLine('ogon'));
    await waitFor(() => titles(events).length > 0, 'nazwa z luki');
    await quiet();

    expect(titles(events)).toEqual(['nazwa-w-luce']);
  });

  /*
   * Skrócenie pliku nie zmienia pokolenia ani licznika wpisów nazwy, więc przegląd sprzed
   * skrócenia, który skończył się później niż przegląd nowej treści, przywracał nazwę z treści, której już nie ma.
   * Wstrzymany jest tylko PIERWSZY przegląd nazwy (sprzed okna, przy podpięciu); przegląd po skróceniu przechodzi.
   * Odczyt idzie przed bramką, więc wstrzymany przegląd trzyma starą treść.
   */
  it('spóźniony skan sprzed skrócenia nie przywraca starej nazwy', async () => {
    let content = titleLine('stara-nazwa');
    for (let i = 0; i < 40; i += 1) content += userLine(`prompt ${String(i)}`);
    await writeFile(filePath(), content);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let opened = 0;
    let held = false;
    const titleOpen: NonNullable<TasksScanOptions['titleOpen']> = async (path) => {
      opened += 1;
      const paused = opened === 1;
      const handle = await open(path, 'r');
      return {
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, length, position);
          if (paused) {
            held = true;
            await gate;
          }
          return result;
        },
        close: () => handle.close(),
      };
    };
    const { events } = start({ historyBytes: 900, historyMaxBytes: 900, tasksScan: { titleOpen } });
    await primed(events);
    await waitFor(() => held, 'przegląd nazwy sprzed okna wstrzymany');

    await writeFile(filePath(), titleLine('nowa-nazwa'));
    await waitFor(() => titles(events).includes('nowa-nazwa'), 'nazwa po skróceniu');
    release();
    await quiet();

    expect(titles(events)).toEqual(['nowa-nazwa']);
  });

  /** Podmiana pliku: nowy inode pod tą samą ścieżką (zapis obok i `rename`), jak przy zapisie atomowym. */
  const replaceTranscript = async (content: string): Promise<void> => {
    const before = await stat(filePath());
    await createTranscript(filePath(), content);
    expect((await stat(filePath())).ino).not.toBe(before.ino);
  };

  it('podmiana pliku tej samej długości z innym custom-title', async () => {
    const oldContent = userLine('treść '.repeat(20)) + titleLine('stara-nazwa');
    await writeFile(filePath(), oldContent);
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'stara nazwa');

    // Ta sama liczba bajtów: `nowa-nazwa` jest o bajt krótsza, więc treść dostaje bajt więcej.
    const newContent = userLine(`${'treść '.repeat(20)}x`) + titleLine('nowa-nazwa');
    expect(Buffer.byteLength(newContent)).toBe(Buffer.byteLength(oldContent));
    await replaceTranscript(newContent);
    await waitFor(() => titles(events).length > 1, 'nazwa po podmianie');
    await quiet();

    expect(titles(events)).toEqual(['stara-nazwa', 'nowa-nazwa']);
  });

  it('podmiana pliku większej długości z innym custom-title', async () => {
    const oldContent = userLine('treść '.repeat(20)) + titleLine('stara-nazwa');
    await writeFile(filePath(), oldContent);
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'stara nazwa');

    // Wpis nazwy stoi w części nowego pliku przed starym końcem: odczyt przyrostowy od starego offsetu go nie widzi.
    const newContent = titleLine('nowa-nazwa') + userLine('nowa treść '.repeat(20)) + userLine('ogon');
    expect(Buffer.byteLength(newContent)).toBeGreaterThan(Buffer.byteLength(oldContent));
    await replaceTranscript(newContent);
    await waitFor(() => titles(events).length > 1, 'nazwa po podmianie');
    await quiet();

    expect(titles(events)).toEqual(['stara-nazwa', 'nowa-nazwa']);
  });

  it('podmiana między odczytem rozmiaru a tożsamości, wpis nazwy przecina stary koniec pliku', async () => {
    const oldContent = userLine('treść '.repeat(20)) + titleLine('stara-nazwa');
    const oldSize = Buffer.byteLength(oldContent);
    // Wpis `nowa-nazwa` zaczyna się 10 bajtów przed starym końcem i kończy za nim.
    let pad = '';
    while (Buffer.byteLength(userLine(pad)) < oldSize - 10) pad += 'x';
    const newContent = userLine(pad) + titleLine('nowa-nazwa') + userLine('ogon');
    const titleStart = Buffer.byteLength(userLine(pad));
    expect(titleStart).toBeLessThan(oldSize);
    expect(titleStart + Buffer.byteLength(titleLine('nowa-nazwa'))).toBeGreaterThan(oldSize);

    await writeFile(filePath(), oldContent);
    let swap = false;
    const { events } = start({
      io: {
        sizeOf: async (path) => {
          const size = (await stat(path)).size;
          if (swap) {
            swap = false;
            await replaceTranscript(newContent);
          }
          return size;
        },
      },
    });
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'stara nazwa');

    swap = true;
    await waitFor(() => titles(events).length > 1, 'nazwa po podmianie między dwoma `stat`');
    await quiet();

    expect(titles(events)).toEqual(['stara-nazwa', 'nowa-nazwa']);
  });

  it('`agent-name` nie zmienia nazwy rozmowy', async () => {
    await writeFile(filePath(), userLine('start') + titleLine('demo-eksport'));
    const { events } = start();
    await primed(events);
    await waitFor(() => titles(events).length > 0, 'nazwa rozmowy');

    await appendFile(filePath(), agentNameLine('inna-nazwa-agenta') + userLine('dalej'));
    await waitFor(() => texts(events).includes('dalej'), 'dopisek');
    await quiet();

    expect(titles(events)).toEqual(['demo-eksport']);
  });

  it('fixture `/rename` ma kształt wpisów z pliku CLI i wartości syntetyczne', () => {
    const entries = readFileSync(RENAME_FIXTURE, 'utf8').split('\n').filter((raw) => raw !== '')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    const named = entries.filter((e) => e['type'] === 'custom-title' || e['type'] === 'agent-name');
    // Kształt z plików rozmów CLI 2.1.311–2.1.319: dokładnie trzy klucze, wszystkie napisy.
    for (const entry of named) {
      const key = entry['type'] === 'custom-title' ? 'customTitle' : 'agentName';
      expect(Object.keys(entry)).toEqual(['type', key, 'sessionId']);
      expect(typeof entry[key]).toBe('string');
    }
    expect(named.map((e) => e['type'])).toEqual(['custom-title', 'agent-name', 'custom-title', 'agent-name']);
    // Wartości syntetyczne: identyfikatory z puli zastępczej, katalog i nazwy wymyślone.
    for (const entry of entries) {
      for (const field of ['sessionId', 'uuid', 'parentUuid', 'promptId']) {
        const value = entry[field];
        if (typeof value === 'string') expect(value).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
      }
      if (entry['cwd'] !== undefined) expect(entry['cwd']).toBe('/Users/u/Projects/demo');
    }
  });
});
