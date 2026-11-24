/**
 * Złote ramki SSE, strona PRODUCENTÓW: kod serwera → pliki `shared/fixtures/sse/`.
 *
 * Ramki buduje KOD, nie ręka: manager (seedy demo z mock-driverem albo atrapa nadzorcy herdr
 * z driverem sterowanym z testu), import transkryptu z syntetycznego jsonl, puls katalogu sesji
 * i `SseHub`. Każda ramka wychodzi przez `formatSseEvent` (atrapa odpowiedzi HTTP zbiera to,
 * co hub zapisałby do gniazda) i wraca `JSON.parse` z pola `data:` — dokładnie to, co dostaje
 * klient. Nadajnik ramek nie waliduje, więc ten test jest jedynym miejscem, w którym
 * wyjście producenta przechodzi przez ścisły kontrakt (`parseServerEvent`).
 *
 * Druga strona (pliki → dekoder) mieszka w `shared/test/sse-fixtures.test.ts` i nie importuje
 * niczego z serwera — to lustro dla każdego innego klienta.
 *
 * Determinizm: zegar wstrzyknięty (fake timery w demo, `now` managera w scenariuszu herdr),
 * identyfikatory stałe (klucze paneli, uuid sesji silnika, `serverStartId`, `promptBlockId`), treść syntetyczna
 * (`/Users/demo/…`). Domyślnie test PORÓWNUJE ramki z plikami; `RAROG_FIXTURES_WRITE=1`
 * nadpisuje pliki `ok` i przelicza pochodne (`base` + `patch` z manifestu).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { foreign, say } from '@rarog/shared/sentences';
import { PROTOCOL_VERSION, parseServerEvent } from '@rarog/shared';
import type {
  ActivityPhase, BackgroundTask, HerdrStatus, PullRequestState, Question, SessionArtifact,
  SessionPullRequest, SessionScheduledTask,
} from '@rarog/shared';
import { SseHub, type SseResponse } from '../src/sse.ts';
import { CARD_HIDDEN_RANGES, inRanges } from '../src/hidden-chars.ts';
import { consentResolvedEvent } from '../src/herdr/dialogs/layer1/frames.ts';
import { HERDR_PANE_CAP_MESSAGE, createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import type { PrStatusPort } from '../src/sessions/pr-status-link.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createPulseEcho, pulseActivity } from '../src/drivers/herdr/transcript.ts';
import { degradedCard, screenQuestionCard } from '../src/herdr/dialogs/cards/build.ts';
import { clipForDisplay } from '../src/drivers/tool-text.ts';
import { optionEscalates } from '../src/herdr/dialogs/policy/escalation.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { reviewPairsFrom } from '../src/herdr/dialogs/screen/review.ts';
import { parseImportLine, parseTranscriptTail } from '../src/transcript-import.ts';
import { echoKey } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { consentBash, consentView, produceConsent, screenConsentEvents } from './sse-fixtures-producenci-zgody.ts';
import { produceInbox } from './sse-fixtures-producenci-inbox.ts';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/sse',
);
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';

// ---------------------------------------------------------------------------
// Manifest i pliki
// ---------------------------------------------------------------------------

interface PatchOp {
  path: string;
  value?: unknown;
  remove?: boolean;
}

interface ManifestEntry {
  expect: 'ok' | 'degraded' | 'ignored';
  base?: string;
  patch?: PatchOp[];
}

function readManifest(): Record<string, ManifestEntry> {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as
    Record<string, ManifestEntry>;
}

const BACKSLASH = String.fromCharCode(0x5c);
/** U+2028 — w JSON-ie legalny, w pliku niewidoczny; w ramce ma przejść tam i z powrotem. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/**
 * JSON pliku złotej ramki: wcięcie 2, znak nowej linii na końcu, a separatory U+2028/U+2029
 * jako escape. `JSON.stringify` zostawia je dosłownie (są legalne w JSON), ale w pliku byłyby
 * niewidoczne — `shared/test/sources.test.ts` odrzuca je razem z bajtami sterującymi. Tak samo
 * każdy inny znak ukryty na karcie (`CARD_HIDDEN_RANGES`, w nim separatory): ramka karty
 * `hidden-chars` niesie go w `displayText`, a surowy znak kierunku pisma przestawiałby tekst pliku
 * w przeglądzie różnicy.
 */
function serialize(value: unknown): string {
  // Kody zamiast literałów: escape w źródle bywa rozwijany do surowego znaku przez narzędzia,
  // które ten plik zapisują — a wtedy test wnosiłby dokładnie usterkę, której pilnuje.
  // A hidden character above U+FFFF (a tag) goes out as its two UTF-16 units: JSON `\u` takes four hex digits.
  const text = [...JSON.stringify(value, null, 2)].map((one) => {
    const code = one.codePointAt(0) ?? 0;
    return inRanges(code, CARD_HIDDEN_RANGES)
      ? Array.from({ length: one.length }, (_unit, index) => one.charCodeAt(index))
        .map((unit) => `${BACKSLASH}u${unit.toString(16).padStart(4, '0')}`).join('')
      : one;
  }).join('');
  return `${text}\n`;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as unknown;
}

/** JSON Pointer (RFC 6901) → klucze. */
function pointer(raw: string): string[] {
  if (!raw.startsWith('/')) throw new Error(`ścieżka spoza RFC 6901: ${raw}`);
  return raw.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Nakłada operacje manifestu (`value` = ustaw, `remove` = usuń) na kopię dokumentu. Ta sama
 * semantyka co w `shared/test/sse-fixtures.test.ts` — tamten test nie może importować z serwera,
 * a ten nie powinien z testów innego pakietu, więc kilkanaście linii jest tu dwa razy.
 */
function applyOps(doc: unknown, ops: readonly PatchOp[]): unknown {
  const out = structuredClone(doc);
  for (const op of ops) {
    const keys = pointer(op.path);
    const last = keys.pop();
    if (last === undefined) throw new Error('operacja na korzeniu dokumentu');
    let parent: unknown = out;
    for (const key of keys) {
      parent = (parent as Record<string, unknown>)[key];
      if (typeof parent !== 'object' || parent === null) {
        throw new Error(`ścieżka ${op.path}: brak rodzica ${key}`);
      }
    }
    const target = parent as Record<string, unknown>;
    if (op.remove === true) {
      if (Array.isArray(target)) target.splice(Number(last), 1);
      else delete target[last];
    } else {
      target[last] = structuredClone(op.value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zbieranie ramek z huba
// ---------------------------------------------------------------------------

/** Atrapa odpowiedzi HTTP: zbiera dokładnie to, co hub zapisałby do gniazda. */
class FrameSink implements SseResponse {
  readonly chunks: string[] = [];

  writeHead(): unknown {
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): unknown {
    return this;
  }

  on(): unknown {
    return this;
  }

  /**
   * Ramki danych po `JSON.parse(data)`, w kolejności zapisu (bez `retry:` i heartbeatów).
   *
   * Linie tnie WYŁĄCZNIE `\n`, jak parser SSE. Regex z `.` i `$/m` uciąłby ramkę na surowym
   * U+2028 (JavaScript liczy go jako koniec linii) — dokładnie ten błąd łapie `message.unicode`.
   */
  frames(): Record<string, unknown>[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .map((raw) => raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data): data is string => data !== undefined)
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  /** OSTATNIA ramka typu spełniająca warunek — albo twardy błąd (scenariusz się rozjechał). */
  last(type: string, match: (frame: Record<string, unknown>) => boolean = () => true):
    Record<string, unknown> {
    const found = this.frames().filter((frame) => frame.type === type && match(frame)).at(-1);
    if (found === undefined) throw new Error(`brak ramki ${type} w strumieniu`);
    return found;
  }

  /** PIERWSZA ramka typu spełniająca warunek. */
  first(type: string, match: (frame: Record<string, unknown>) => boolean = () => true):
    Record<string, unknown> {
    const found = this.frames().find((frame) => frame.type === type && match(frame));
    if (found === undefined) throw new Error(`brak ramki ${type} w strumieniu`);
    return found;
  }
}

const sessionOf = (frame: Record<string, unknown>): Record<string, unknown> =>
  frame.session as Record<string, unknown>;

/** Oddaje sterowanie pętli zdarzeń, żeby pompy managera przetrawiły kolejki driverów. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// ---------------------------------------------------------------------------
// Treść syntetyczna
// ---------------------------------------------------------------------------

const ROOT = '/Users/demo/Projects';

/** 1×1 px png — liczy się wyłącznie poprawny kształt data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
/** Nagłówek PDF — liczy się kształt data URL-a, nie treść. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

/** Nazwa zdjęcia nadana przez uploady (`UPLOAD_IMAGE_FILE_PATTERN`) — klucz miniatury. */
const UPLOAD_IMAGE = '1790000000-0123456789abcdef.png';

const UUID_ATLAS = '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31';
const UUID_BIRCH = '9a2c51e7-3f08-4d6b-a1c4-7e5b20d8f613';
const UUID_CEDAR = 'c3e8a147-60d2-4f9b-b5a3-18f7e9d4c205';
const UUID_DUNES = '5d1f9b3a-7e24-4c8a-9f60-b2a4c7e1d398';
const UUID_EMBER = 'e7a40c92-1b5f-4d37-8c26-9f0d3b6a5e14';
const UUID_OMEGA = '2f6b8d04-a9c3-4e71-b5d2-0c8e4a7f9b16';
const UUID_NOWY = '8c0e2a6f-4d9b-4f13-a7e5-6b1c3d9f2a40';
const UUID_ZETA = '1a9e7c35-b0d4-4e62-9f18-c5a3e7b2d906';
const UUID_FJORD = 'f4c2b9e8-06a1-4d5c-83b7-e9d1a4f6c052';
const UUID_GROVE = '6e3d1b72-c8f0-4a95-a2d4-b17e09c5f863';
const UUID_LAMBDA = 'b8a5f2d1-3c79-4e06-9d4b-52f1e8c0a7d3';
const UUID_MU = '0d4e7a19-b2c6-4f85-9e13-6a8c2f5b1d74';
const UUID_NU = 'a6f31c08-5d2e-4b97-8c41-e09b7d3f2a65';
const UUID_XI = '3b7d9e15-c4a2-4f60-8e1b-d5a9c2f7e083';
const UUID_OMICRON = '7c1e4f92-3a6d-4b08-9e25-d4b7a0c3f816';
const UUID_SIGMA = '5e8a2c47-91d3-4f6b-a0e2-c7b4d9f1e358';
/** Identyfikator blokady promptu (`SessionSummary.promptBlocked.id`) — produkcja losuje `randomUUID()`. */
const PROMPT_BLOCK_ID = '7c1e5a93-2b4f-4d86-9e0a-3f6b8d2c4e17';
/** `clientMessageId` wysyłki z telefonu — echo niesie go w `message.max.json`. */
const CLIENT_MESSAGE_ID = '7e1c4a92-5b3d-4f08-a6e2-9c0d1b8f4a57';

/**
 * Formularz `AskUserQuestion` odczytany Z EKRANU (karta cyfrowa): opcje autora i chrome CLI pod
 * nimi. Flagę eskalacji stawia parser tą samą funkcją (`optionEscalates`), a rolę opcji wyznacza
 * `screenQuestionCard` — to są dwa kroki prawdziwego kodu drivera nad etykietami z ekranu.
 */
const KEYS_FORM_LABELS: { label: string; description?: string }[] = [
  { label: 'Tylko ten raz', description: 'Zgoda na jedno uruchomienie testów.' },
  { label: "Yes, and don't ask again for pnpm test commands" },
  { label: 'Type something.' },
  { label: 'Chat about this' },
];

/**
 * Treść notki o zadaniu w tle w kształcie CLI 2.1.x (znaczniki jak w realnych transkryptach).
 * `note` to dopisek `<note>`, który CLI dokłada do meldunku o subagencie.
 */
function taskNotification(taskId: string, status: string, summary: string, note?: string): string {
  return [
    '<task-notification>', `<task-id>${taskId}</task-id>`, `<status>${status}</status>`,
    `<summary>${summary}</summary>`, ...(note === undefined ? [] : [`<note>${note}</note>`]),
    '</task-notification>',
    'Read the output file to retrieve the result.',
  ].join('\n');
}

/**
 * Notka na żywo — linia jsonl, którą follower przepuszcza przez `parseImportLine`: komenda
 * w tle zakończona niepowodzeniem z kodem 1, czyli każde pole `notice` w jednej ramce `message`
 * (i w `transcript-snapshot.keys.json`, bo leci do sesji `grove` przed jej migawką).
 */
const LIVE_NOTICE_LINE = JSON.stringify({
  type: 'user', timestamp: '2026-10-03T07:45:00.000Z',
  origin: { kind: 'task-notification', producer: 'session-task' },
  message: { role: 'user', content: taskNotification(
    'bash_3f1a', 'failed', 'Background command "pnpm test shared/test" failed with exit code 1',
  ) },
});

/**
 * Meldunek o POSTOJU subagenta: status `completed` z dopiskiem, że agent stanął, a jego własna
 * praca w tle jeszcze leci (brzmienie dopisku z pomiaru CLI 2.1.296,
 * `server/test/fixtures/herdr/tasks/measured/postoj.jsonl`). Dotyczy zadania `agent_9b2c` z {@link TASKS}.
 */
const WAITING_NOTICE_LINE = JSON.stringify({
  type: 'user', timestamp: '2026-10-03T07:50:00.000Z',
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: taskNotification(
    'agent_9b2c', 'completed', 'Agent "Szuka producentów ramek" finished',
    'This agent stopped with background work of its own still running. It may resume on its own when '
    + 'that work completes or reports, and the same task-id notifies again if it does; the result below '
    + 'may be interim.',
  ) },
});

/**
 * Jedna linia jsonl w kształcie magazynu CLI (2.1.x). Import czyta wyłącznie pola, które tu są:
 * `type`, `timestamp`, `isMeta`, `origin`, `effort`, `message.{role, model, content}`.
 */
function jsonl(entries: readonly Record<string, unknown>[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

/**
 * Sesja `birch`: prompt ze zdjęciem z Raroga (wpis-towarzysz `[Image: source: …]`), potem tura
 * asystenta z każdym rodzajem narzędzia, który klient rysuje inaczej: powłoka, edycja z diffem,
 * delegacja (`Agent`, `Workflow`, `Task`) i narzędzie z inputem `null`.
 */
const BIRCH_JSONL = jsonl([
  {
    type: 'user', timestamp: '2026-10-03T07:30:00.000Z',
    message: { role: 'user', content: [
      { type: 'text', text: 'Przejrzyj kontrakt SSE i dopisz złote ramki do testów.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ] },
  },
  {
    type: 'user', isMeta: true, timestamp: '2026-10-03T07:30:00.000Z',
    message: { role: 'user', content: [
      { type: 'text', text: `[Image: source: ${ROOT}/birch/.rarog-uploads/${UPLOAD_IMAGE}]` },
    ] },
  },
  {
    type: 'assistant', timestamp: '2026-10-03T07:30:20.000Z', effort: 'high',
    message: { role: 'assistant', model: 'claude-fable-5-1', content: [
      { type: 'text', text: 'Zaczynam od testów dekodera, potem producenci ramek.' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {
        command: 'pnpm test shared/test/decode.test.ts', description: 'Testy dekodera',
      } },
    ] },
  },
  {
    type: 'user', timestamp: '2026-10-03T07:30:40.000Z',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: '12 passed' },
    ] },
  },
  {
    type: 'assistant', timestamp: '2026-10-03T07:31:00.000Z', effort: 'high',
    message: { role: 'assistant', model: 'claude-fable-5-1', content: [
      { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: {
        file_path: `${ROOT}/birch/src/decode.ts`,
        old_string: '  return null;',
        new_string: '  return { event, degradations };',
      } },
      { type: 'tool_use', id: 'toolu_03', name: 'Agent', input: {
        description: 'Przegląd fixtures', subagent_type: 'Explore',
        prompt: 'Sprawdź, czy każdy typ ramki ma wariant max.',
      } },
      { type: 'tool_use', id: 'toolu_04', name: 'Workflow', input: {
        name: 'kontrakt-semantyczny', description: 'Trzy fazy: przegląd, implementacja, weryfikacja',
      } },
      { type: 'tool_use', id: 'toolu_05', name: 'Task', input: {
        description: 'Starszy podagent', prompt: 'Policz pola schematu.',
      } },
      { type: 'tool_use', id: 'toolu_06', name: 'ExitPlanMode', input: null },
    ] },
  },
]);

/** Sesja `atlas`: krótka historia przebiegu workflow. */
const ATLAS_JSONL = jsonl([
  {
    type: 'user', timestamp: '2026-10-03T07:20:00.000Z',
    message: { role: 'user', content: 'Uruchom workflow kontraktu semantycznego.' },
  },
  {
    type: 'assistant', timestamp: '2026-10-03T07:20:30.000Z', effort: 'xhigh',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'text', text: 'Startuję przebieg w trzech fazach.' },
      { type: 'tool_use', id: 'toolu_11', name: 'Workflow', input: {
        name: 'kontrakt-semantyczny', description: 'Przegląd, implementacja, weryfikacja',
      } },
    ] },
  },
]);

function history(text: string): Extract<DriverEvent, { type: 'history' }> {
  const imported = parseTranscriptTail(text, { dropFirstLine: false });
  return { type: 'history', messages: imported.messages };
}

/**
 * Pytania z kanału hooka: jedno pojedynczego wyboru, drugie wielokrotnego. Opcje z PAYLOADU
 * autora — chrome CLI („Type something.", „Chat about this") w payloadzie nie występuje.
 */
const HOOK_QUESTIONS: Question[] = [
  {
    question: 'Gdzie trzymamy złote ramki SSE?',
    header: 'Fixtures',
    multiSelect: false,
    options: [
      { label: 'shared/fixtures/sse', description: 'Wspólne dla serwera i każdego klienta.' },
      { label: 'server/test/fixtures', description: 'Obok testów serwera.' },
    ],
  },
  {
    question: 'Które klienty mają przejść manifest?',
    header: 'Klienci',
    multiSelect: true,
    options: [
      { label: 'PWA', description: 'Dzisiejszy klient.' },
      { label: 'Swift', description: 'Przyszły klient natywny.' },
    ],
  },
];

/**
 * Pytanie z PODGLĄDEM opcji. Druga opcja przekracza sufit podglądu jednej opcji,
 * więc w ramce kończy się znacznikiem `✂ …` — oryginał zostaje w driverze.
 */
const PREVIEW_QUESTIONS: Question[] = [{
  question: 'Jaki układ listy sesji?',
  header: 'Układ',
  multiSelect: false,
  options: [
    {
      label: 'Dwie kolumny (Rekomendacja)',
      description: 'Lista obok podglądu.',
      preview: '┌────────┬─────────┐\n│ lista  │ podgląd │\n└────────┴─────────┘',
    },
    {
      label: 'Jedna kolumna',
      preview: Array.from(
        { length: 110 }, (_, i) => `${String(i + 1).padStart(3, '0')} │ ${'─'.repeat(32)}`,
      ).join('\n'),
    },
    { label: 'Bez listy' },
  ],
}];

/** Ekran przeglądu formularza dwóch pytań — pytanie i odpowiedź zawinięte przez wąski panel. */
const REVIEW_SCREEN = [
  '─'.repeat(60),
  '←  ☒ Odstęp  ☒ Dodatki  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● Na którą wartość ujednolicić odstęp pod',
  '   nagłówkiem sekcji?',
  '   → 52 px — wartość `wide`',
  '     (Rekomendacja)',
  ' ● Które dodatki włączyć?',
  '   → Posypka',
  '   → Polewa',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');

/** Plan przebiegu workflow z cache'u rozkładu — fakty, które puls dokleja do wiersza. */
const PHASES: ActivityPhase[] = [
  { title: 'Przegląd', agents: 2, done: 2 },
  { title: 'Implementacja', agents: 1, done: 0 },
  { title: 'Weryfikacja', agents: 0, done: 0 },
];

const TASKS: BackgroundTask[] = [
  {
    id: 'wf_7c1e2a',
    kind: 'workflow',
    description: 'kontrakt-semantyczny',
    startedAt: '2026-10-03T07:21:00.000Z',
    runId: 'wf_7c1e2a',
    run: {
      phases: PHASES.map((phase) => phase.title),
      agents: [
        { id: 'agent-1', phase: 'Przegląd', label: 'protokół', done: true,
          startedAt: '2026-10-03T07:21:05.000Z' },
        { id: 'agent-2', phase: 'Przegląd', label: 'dekoder', done: true,
          startedAt: '2026-10-03T07:21:06.000Z' },
        { id: 'agent-3', phase: 'Implementacja', done: false },
      ],
    },
  },
  {
    id: 'bash_3f1a', kind: 'command', command: 'pnpm vitest --watch shared/test',
    description: 'Testy w trybie obserwacji',
  },
  {
    id: 'agent_9b2c', kind: 'agent', agentType: 'Explore', model: 'claude-opus-5-5',
    description: 'Szuka producentów ramek', summary: 'Znalazł 9 producentów.',
    startedAt: '2026-10-03T07:22:00.000Z',
    // Postój: agent stanął i czeka na własne komendy w tle. Dwa kształty pozycji: z treścią
    // i startem oraz sam identyfikator. Reduktor wypełnia dziś samo `waitingSince`, `ownTasks`
    // jeszcze nie — lista jedzie tu prosto do managera, jak każde zdarzenie drivera w tym scenariuszu.
    waitingSince: '2026-10-03T07:50:00.000Z',
    ownTasks: [
      {
        id: 'bash_7d4e', command: `until grep -q "passed" ${ROOT}/atlas/testy.log; do sleep 5; done`,
        startedAt: '2026-10-03T07:35:00.000Z',
      },
      { id: 'bash_8a15' },
    ],
  },
  { id: 'monitor_1d', kind: 'monitor', description: 'Log serwera' },
];

/** Adres artefaktu usuniętego w scenariuszu `atlas` — ten sam w liście i w meldunku o końcu obserwacji. */
const GONE_ARTIFACT_URL = 'https://claude.ai/artifact/Szk1cMan1festu7Kp4QxRw';

/**
 * Artefakty sesji `atlas`: zwykły i usunięty (`gone`). Lista idzie do managera zdarzeniem drivera
 * `artifacts`, jak zadania w tle; drogę z pliku rozmowy sprawdza `herdr-artifacts-integracja.test.ts`.
 */
const ARTIFACTS: SessionArtifact[] = [
  {
    url: 'https://claude.ai/artifact/RaportKontraktuSSE8mZq', title: 'Raport kontraktu SSE',
    publishedAt: '2026-10-03T07:40:00.000Z',
  },
  { url: GONE_ARTIFACT_URL, title: 'Szkic manifestu', publishedAt: '2026-10-03T07:25:00.000Z', gone: true },
];

/**
 * Pull requesty sesji `atlas`: z tytułem i bez (`gh pr create --fill`). Lista idzie do managera zdarzeniem
 * drivera `pull-requests`, jak artefakty; drogę z plików rozmowy sprawdza `herdr-pull-requests.test.ts`.
 * Each GitHub state appears once (`open`, `closed`, `merged`, `draft`) and one PR has no state (not read yet).
 * The driver list carries no state, like a real one: the states come from the fixed map
 * {@link PULL_REQUEST_STATES} through the manager's PR status port, laid over the list when the summary is built.
 */
const PULL_REQUESTS: SessionPullRequest[] = [
  {
    url: 'https://github.com/rarog-example/rarog/pull/130', repo: 'rarog-example/rarog', number: 130,
    createdAt: '2026-10-03T07:50:00.000Z', title: 'Stan PR-ów w inspektorze',
  },
  {
    url: 'https://github.com/rarog-example/rarog/pull/129', repo: 'rarog-example/rarog', number: 129,
    createdAt: '2026-10-03T07:48:00.000Z',
  },
  {
    url: 'https://github.com/rarog-example/rarog/pull/128', repo: 'rarog-example/rarog', number: 128,
    createdAt: '2026-10-03T07:45:00.000Z', title: 'Złote ramki z PR-ami sesji',
  },
  {
    url: 'https://github.com/rarog-example/rarog/pull/127', repo: 'rarog-example/rarog', number: 127,
    createdAt: '2026-10-03T07:30:00.000Z',
  },
  {
    url: 'https://github.com/rarog-example/rarog/pull/126', repo: 'rarog-example/rarog', number: 126,
    createdAt: '2026-10-03T07:20:00.000Z', title: 'Szkic opisu stanów PR',
  },
];

/**
 * Scheduled tasks of session `atlas`: a recurring one that already ran (`lastFiredAt`, `expiresAt`, no `nextFireAt`) and
 * a one-shot with every other field. The list goes to the manager as a driver event `scheduled-tasks`; the path from
 * the conversation file is checked by `scheduled-tasks-integration.test.ts`.
 */
const SCHEDULED_TASKS: SessionScheduledTask[] = [
  {
    id: '9bc70ce1', cron: '*/30 * * * *', recurring: true, prompt: 'Check the nightly build and report failures',
    createdAt: '2026-10-03T07:35:00.000Z', lastFiredAt: '2026-10-03T08:00:04.000Z',
    expiresAt: '2026-10-10T07:35:00.000Z',
  },
  {
    id: 'bac11b20', cron: '13 22 3 10 *', recurring: false, prompt: 'Remind me to review the SSE contract report',
    createdAt: '2026-10-03T07:20:00.000Z', nextFireAt: '2026-10-03T20:13:00.000Z',
  },
];

/** GitHub states of {@link PULL_REQUESTS}: a fixed map, the way the demo and review mode get theirs. */
const PULL_REQUEST_STATES: ReadonlyMap<string, PullRequestState> = new Map<string, PullRequestState>([
  ['https://github.com/rarog-example/rarog/pull/130', 'open'],
  ['https://github.com/rarog-example/rarog/pull/129', 'closed'],
  ['https://github.com/rarog-example/rarog/pull/128', 'merged'],
  ['https://github.com/rarog-example/rarog/pull/126', 'draft'],
]);

/** The manager's PR status port over the fixed map: the states are known from the start, no tracker, no reads. */
const FIXED_PR_STATUS: PrStatusPort = {
  stateOf: (url) => PULL_REQUEST_STATES.get(url),
  setSessionUrls: () => undefined,
  dropSession: () => undefined,
  listen: () => undefined,
};

/**
 * Meldunek CLI o końcu obserwacji usuniętego artefaktu (brzmienie z pomiaru,
 * `server/test/fixtures/herdr/artifacts/measured/meldunki.jsonl`). Import daje z niego notkę `artifact-watch`.
 */
const ARTIFACT_WATCH_LINE = JSON.stringify({
  type: 'user', timestamp: '2026-10-03T07:52:00.000Z',
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: [
    '<task-notification>', '<task-type>artifact-watch-lifecycle</task-type>',
    '<summary>Stopped watching Artifact: "Szkic manifestu" (artifact not found)</summary>',
    `<event>Watch on ${GONE_ARTIFACT_URL} ended — no such artifact for this account (it was deleted, or it has `
      + 'not been shared with the user). This session no longer keeps track of new versions of it.</event>',
    '</task-notification>',
  ].join('\n') },
});

/**
 * Wpis promptu zablokowanego przez hook `UserPromptSubmit` w kształcie z pomiaru (CLI 2.1.303,
 * `server/test/fixtures/herdr/commands/measured/prompt-block-*.jsonl`). Import daje z niego fakty notki. Powód
 * i cytat po angielsku: notka to zdanie z kodem, a strażnik złotych ramek nie przyjmuje polskich liter w tekście
 * obok `ref` (argument `text` jedzie w nim dosłownie).
 */
const promptBlockLine = (prompt: string): string => JSON.stringify({
  type: 'system', subtype: 'informational', level: 'warning', isMeta: false, preventContinuation: true,
  content: 'UserPromptSubmit operation blocked by hook:\n[/Users/demo/.claude/hooks/prompt-policy.sh]: '
    + 'Prompts on this branch need a ticket number.\nAdd one and send the prompt again.'
    + `\n\nOriginal prompt: ${prompt}`,
  promptSubmitEnding: {
    ending: {
      kind: 'blocked_by_hook',
      reason: 'Prompts on this branch need a ticket number.\nAdd one and send the prompt again.',
    },
    promptKept: false,
  },
  timestamp: '2026-10-03T07:53:00.000Z',
});

/** Fakty notki z importu wpisu blokady — jak notki harnessu wyżej, wynik daje kod, nie ręka. */
function promptBlockOf(prompt: string): { reason: string; promptKept: boolean; prompt: string } {
  const blocked = parseImportLine(promptBlockLine(prompt))?.message?.promptBlocked;
  if (blocked?.prompt === undefined) throw new Error('import nie rozpoznał wpisu blokady');
  return { reason: blocked.reason, promptKept: blocked.promptKept, prompt: blocked.prompt };
}

// ---------------------------------------------------------------------------
// Atrapa nadzorcy herdr (granica: zdarzenia panelu i drivera, nie gniazdo)
// ---------------------------------------------------------------------------

/** Driver sterowany z testu — wejście managera to `DriverEvent`, tak jak z prawdziwego drivera. */
class FixtureDriver extends AtrapaDrivera {
  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }
}

class FixtureSupervisor extends AtrapaNadzorcy<FixtureDriver> {
  readonly agents = new Map<string, HerdrAgent>();
  /** Pierwsze zdarzenia drivera po podpięciu — prawdziwy driver zawsze coś melduje (slot). */
  readonly onAttach = new Map<string, DriverEvent[]>();

  override status(): HerdrStatus {
    // Sufit paneli osiągnięty: tylko wtedy nadzorca niesie zdanie w `detail` i jego kod w `detailRef` (patrz protokół).
    return {
      available: true, agentCount: this.agents.size, readOnly: false, canLaunch: false,
      version: '0.9.3', protocol: 22, detail: HERDR_PANE_CAP_MESSAGE.text, detailRef: HERDR_PANE_CAP_MESSAGE.ref,
    };
  }

  protected nowyDriver(key: string): FixtureDriver {
    return new FixtureDriver(key);
  }

  override attach(key: string): FixtureDriver {
    const driver = super.attach(key);
    driver.push(...(this.onAttach.get(key) ?? []));
    return driver;
  }

  override rarogPaneCount(): number {
    return [...this.agents.values()].filter((agent) => agent.launchedByRarog).length;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.agents.get(key);
  }

  appear(agent: HerdrAgent, onAttach: DriverEvent[]): void {
    this.agents.set(agent.key, agent);
    this.onAttach.set(agent.key, onAttach);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function agent(key: string, name: string, uuid: string, overrides: Partial<HerdrAgent> = {}):
  HerdrAgent {
  return {
    key,
    paneId: key,
    tabId: `${key.split(':')[0] ?? 'w1'}:t1`,
    agentSessionId: uuid,
    engine: 'claude',
    termId: null,
    cwd: `${ROOT}/${name}`,
    status: 'working',
    title: name,
    stateChangeSeq: 1,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    launchedByRarog: true,
    interactiveReady: true,
    ...overrides,
  };
}

/** Id karty z klucza panelu — ta sama reguła co w atrapach managera (`herdr-<klucz>`). */
const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

function fixtureDeps(): HerdrManagerDeps {
  return {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: (cwd, images) => Promise.resolve(
      images.map(() => `${cwd}/.rarog-uploads/${UPLOAD_IMAGE}`),
    ),
    writeUploadFiles: (cwd, files) => Promise.resolve(
      files.map((file) => `${cwd}/.rarog-uploads/1790000001-a1b2c3d4e5f60718-${file.name}`),
    ),
    sweepUploads: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// Scenariusze
// ---------------------------------------------------------------------------

type Produced = Map<string, unknown>;

/**
 * Herdr: dziesięć paneli, każdy pokazuje inny rodzaj karty — przebieg workflow, pełny transkrypt
 * ze zgodą, dialog zaufania z ekranu, pytanie z kanału hooka, zgoda bez cyfr, cyfrowa karta
 * pytania z ekranu, zgoda na plan, Codex, zwykła tura z narzędziem i karta bezczynna — plus
 * jedenasty, który pojawia się po pełnej ramce listy.
 */
async function produceHerdr(out: Produced, dataDir: string): Promise<void> {
  let clock = Date.parse('2026-10-03T08:00:00.000Z');
  const tick = (ms = 1_000): void => { clock += ms; };
  const supervisor = new FixtureSupervisor();
  const manager: Manager = await createManager({
    demo: false,
    dataDir,
    herdrSupervisor: supervisor,
    herdrDeps: fixtureDeps(),
    herdrRoots: [ROOT],
    now: () => clock,
    promptBlockId: () => PROMPT_BLOCK_ID,
    gitStatus: null,
    gitWatcher: null,
    termEnabled: true,
    liveSessionsReader: () => Promise.resolve(null),
    prStatus: FIXED_PR_STATUS,
    // Proces `atlas` chodzi na starszym Claude Code niż zainstalowany. `mu` (pytanie
    // z podglądem) na wydaniu, którego walidator przyjmuje notatki (≥ 2.1.288).
    cliVersionReader: () => Promise.resolve({
      installed: '2.1.283',
      registry: new Map([
        [UUID_ATLAS, [{ pid: 4242, version: '2.1.281', status: 'busy' }]],
        [UUID_MU, [{ pid: 4343, version: '2.1.293', status: 'waiting' }]],
      ]),
    }),
  });
  const notes = new Set([`${ROOT}/atlas`, `${ROOT}/nowy`]);
  const hub = new SseHub({
    manager,
    serverStartId: '0f7c2a9e-5b1d-4c3a-9e2f-6a8b1c4d7e90',
    protocolVersion: PROTOCOL_VERSION,
    // Próg builda apki natywnej — `hello.max.json` ma nieść pole (strażnik pokrycia pól).
    minClientBuild: 12,
    // Default heartbeat, so `hello.max.json` carries `heartbeatMs`; no-op timers keep pings out of the frames.
    setInterval: () => 1, clearInterval: () => {},
    notesFor: (cwds) => cwds.filter((cwd) => notes.has(cwd)),
  });
  try {
    await manager.ready;
    hub.start();
    await flush();
    const live = new FrameSink();
    hub.openGlobal(live);

    // --- atlas: przebieg workflow w toku -------------------------------------------------
    const atlas = idOf('w1:p1');
    const atlasStream = new FrameSink();
    supervisor.appear(
      agent('w1:p1', 'atlas', UUID_ATLAS, { title: 'przegląd kontraktu SSE', stateChangeSeq: 12 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 12 }],
    );
    await flush();
    hub.openSession(atlas, atlasStream, null);
    tick();
    supervisor.driver('w1:p1').push(
      { type: 'init', engineSessionId: UUID_ATLAS, model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true },
      history(ATLAS_JSONL),
      { type: 'result', subtype: 'success', summary: 'Plan przebiegu gotowy, trzy fazy.' },
      { type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 13 },
    );
    await flush();
    tick(42_000);
    // Wiersz z PULSU katalogu sesji: subagenci przebiegu i plan faz.
    const pulse = pulseActivity(createPulseEcho(), {
      agents: 3, workflowName: 'kontrakt-semantyczny', agentsDone: 2, runId: 'wf_7c1e2a',
      other: 1, at: clock - 42_000,
    }, { now: clock, silentFor: 42_000 }, PHASES);
    if (pulse === null) throw new Error('puls nie dał wiersza aktywności');
    supervisor.driver('w1:p1').push(pulse);
    await flush();
    tick();
    // Metadane karty PO wierszu aktywności: każda z nich rozgłasza kartę, która go niesie.
    supervisor.driver('w1:p1').push(
      {
        type: 'git-status', branch: 'feat/kontrakt-semantyczny', dirtyCount: 3,
        files: ['shared/src/decode.ts', 'docs/img/karta-unsupported.png', 'docs/spec.md'],
        ahead: 2, behind: 0,
        fileKinds: { added: 1, modified: 2, deleted: 0 },
        lastCommit: {
          hash: 'dd51c2c1', subject: 'feat(web): karta unsupported', at: '2026-10-03T07:10:00.000Z',
        },
        // Szczegóły per plik: liczniki linii, plik binarny (bez liczników) i nowy plik bez nich.
        fileDetails: [
          { path: 'shared/src/decode.ts', kind: 'modified', linesAdded: 42, linesDeleted: 7 },
          { path: 'docs/img/karta-unsupported.png', kind: 'modified', binary: true },
          { path: 'docs/spec.md', kind: 'added' },
        ],
      },
      {
        type: 'usage',
        context: { kind: 'known', tokens: 412_000, limit: 1_000_000, source: 'statusline' },
      },
      { type: 'background-tasks', tasks: TASKS },
      { type: 'artifacts', artifacts: ARTIFACTS },
      { type: 'pull-requests', pullRequests: PULL_REQUESTS },
      { type: 'scheduled-tasks', scheduledTasks: SCHEDULED_TASKS },
    );
    await flush();

    // --- birch: pełny transkrypt i zgoda z „nie pytaj ponownie" ---------------------------
    const birch = idOf('w1:p2');
    const birchStream = new FrameSink();
    supervisor.appear(
      agent('w1:p2', 'birch', UUID_BIRCH, { status: 'idle', title: 'złote ramki', mode: 'plan' }),
      [{ type: 'agent-state', state: 'idle', seen: true, mode: 'plan', stateChangeSeq: 1 }],
    );
    await flush();
    hub.openSession(birch, birchStream, null);
    tick();
    supervisor.driver('w1:p2').push(
      { type: 'init', engineSessionId: UUID_BIRCH, model: 'claude-fable-5-1', effort: 'high' },
      history(BIRCH_JSONL),
    );
    await flush();
    tick();
    await manager.sendMessage(
      birch, 'Porównaj zrzut z raportem i popraw manifest.', [PNG],
      [{ name: 'raport-kontraktu.pdf', dataUrl: PDF }], CLIENT_MESSAGE_ID,
    );
    await flush();
    tick();
    supervisor.driver('w1:p2').push(
      { type: 'message', role: 'assistant', blocks: [
        { type: 'text', text: foreign('Zrzut zgadza się z raportem — dokładam podgląd:') },
        { type: 'image', dataUrl: PNG, alt: 'Podgląd karty nieobsługiwanej sesji' },
      ] },
      { type: 'message', role: 'assistant', blocks: [{
        type: 'text',
        text: foreign(`Zażółć gęślą jaźń — złote ramki gotowe 🚀${LINE_SEPARATOR}druga linia po U+2028.`),
      }] },
    );
    await flush();
    tick();
    supervisor.driver('w1:p2').push({
      type: 'permission-request', reqId: 'toolu_21', toolName: 'Bash',
      input: { command: 'pnpm test shared/test/sse-fixtures.test.ts' },
      displayText: 'pnpm test shared/test/sse-fixtures.test.ts',
      alwaysLabel: `Yes, and don't ask again for pnpm test commands in ${ROOT}/birch`,
    });
    await flush();

    // --- cedar: dialog zaufania rozpoznany z ekranu -------------------------------------
    supervisor.appear(
      agent('w1:p3', 'cedar', UUID_CEDAR, { status: 'blocked', title: 'nowy projekt', mode: 'manual' }),
      [{ type: 'agent-state', state: 'blocked', mode: 'manual', stateChangeSeq: 2 }],
    );
    await flush();
    tick();
    supervisor.driver('w1:p3').push({
      type: 'screen-dialog', knownDialog: 'trust',
      screen: [
        'Do you trust the files in this folder?', `${ROOT}/cedar`, '❯ 1. Yes, proceed', '  2. No, exit',
      ].join('\n'),
    });
    await flush();

    // --- dunes: pytanie z kanału hooka, okno kontekstu niepotwierdzone -------------------
    const dunes = idOf('w2:p4');
    const dunesStream = new FrameSink();
    supervisor.appear(
      agent('w2:p4', 'dunes', UUID_DUNES, { title: 'manifest', mode: 'plan', launchedByRarog: false }),
      [{ type: 'agent-state', state: 'working', mode: 'plan', stateChangeSeq: 4 }],
    );
    await flush();
    hub.openSession(dunes, dunesStream, null);
    tick();
    supervisor.driver('w2:p4').push(
      { type: 'init', engineSessionId: UUID_DUNES, model: 'claude-sonnet-5', effort: 'medium' },
      { type: 'usage', context: { kind: 'unknown', tokens: 184_220, atLeast: 612_000 } },
      { type: 'question-request', reqId: 'toolu_31', channel: 'hook', questions: HOOK_QUESTIONS },
    );
    await flush();

    // --- ember: zgoda, której Rarog nie umie zatwierdzić (brak cyfr z ekranu) ----------
    const ember = idOf('w2:p5');
    const emberStream = new FrameSink();
    supervisor.appear(
      agent('w2:p5', 'ember', UUID_EMBER, { title: 'sprzątanie', stateChangeSeq: 3 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 3 }],
    );
    await flush();
    hub.openSession(ember, emberStream, null);
    tick();
    // Rejestr sesji CLI mówi przy tym `permission prompt` — klasa jedzie na kartę.
    supervisor.driver('w2:p5').push({
      type: 'permission-request', reqId: 'toolu_41', toolName: 'Bash', input: null,
      displayText: 'rm -rf ./build', reason: 'mismatch', cliDialog: 'permission',
      screen: 'Bash command\n  rm -rf ./build\nDo you want to proceed?',
    });
    await flush();

    // --- grove: karta CYFROWA z ekranu — role chrome CLI i opcja tylko przy biurku ----
    const grove = idOf('w5:p10');
    const groveStream = new FrameSink();
    supervisor.appear(
      agent('w5:p10', 'grove', UUID_GROVE, { title: 'zgody testów', stateChangeSeq: 6 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 6 }],
    );
    await flush();
    hub.openSession(grove, groveStream, null);
    tick();
    const keysCard = screenQuestionCard({
      kind: 'question', header: 'Testy', question: 'Jak traktować zgody na testy w tym projekcie?',
      options: KEYS_FORM_LABELS.map((option, index) => ({
        digit: String(index + 1),
        ...option,
        ...(optionEscalates(option.label) ? { terminalOnly: true } : {}),
      })),
      dialogIdentity: { kind: 'question', identity: { kind: 'form' } },
    }, 6);
    supervisor.driver('w5:p10').push(keysCard.event);
    await flush();
    // Notka harnessu na żywo: linia jsonl → import (jak w followerze) → driver → `message`.
    // Bez `tick()`: zegar reszty scenariusza (i daty pozostałych ramek) zostaje nietknięty.
    const notice = parseImportLine(LIVE_NOTICE_LINE)?.message;
    if (notice?.notice === undefined) throw new Error('import nie rozpoznał notki harnessu');
    supervisor.driver('w5:p10').push({
      type: 'message', role: notice.role, blocks: notice.blocks, notice: notice.notice,
    });
    await flush();

    // --- lambda: zgoda na wyjście z trybu planu (`subject: 'plan'`) ----------------------
    const lambda = idOf('w5:p11');
    const lambdaStream = new FrameSink();
    supervisor.appear(
      agent('w5:p11', 'lambda', UUID_LAMBDA, { title: 'plan kontraktu', mode: 'plan', stateChangeSeq: 2 }),
      [{ type: 'agent-state', state: 'working', mode: 'plan', stateChangeSeq: 2 }],
    );
    await flush();
    hub.openSession(lambda, lambdaStream, null);
    tick();
    supervisor.driver('w5:p11').push({
      type: 'permission-request', reqId: 'toolu_51', toolName: 'ExitPlanMode',
      input: { plan: '# Plan\n\n1. Pola semantyczne w kontrakcie.\n2. Klient czyta pola.' },
      displayText: '# Plan\n\n1. Pola semantyczne w kontrakcie.\n2. Klient czyta pola.',
    });
    await flush();

    // --- omega: Codex (sam stan), stan panelu nieznany, kontakt z herdr zerwany ---------
    supervisor.appear(
      agent('w3:p6', 'omega', UUID_OMEGA, {
        engine: 'codex', termId: 'a1b2c3d4e5f60718', inScope: false, status: 'unknown',
        title: 'codex', launchedByRarog: false,
      }),
      [{ type: 'detached', reason: 'gniazdo herdr zamknięte' }],
    );
    await flush();

    // --- zeta: zwykła tura, wiersz z PLIKU (follower jsonl): narzędzie i skrót inputu ---
    const zeta = idOf('w4:p8');
    const zetaStream = new FrameSink();
    supervisor.appear(
      agent('w4:p8', 'zeta', UUID_ZETA, { title: 'testy kontraktu', stateChangeSeq: 5 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 5 }],
    );
    await flush();
    hub.openSession(zeta, zetaStream, null);
    tick();
    supervisor.driver('w4:p8').push(
      { type: 'init', engineSessionId: UUID_ZETA, model: 'claude-opus-5-5', effort: 'high' },
      {
        type: 'activity', kind: 'tool', toolName: 'Bash', summary: 'pnpm test shared/test',
        description: 'Run the shared contract tests',
      },
      // Auto-tytuł panelu (`/rename`) rozgłasza kartę — razem z bieżącym wierszem aktywności.
      { type: 'title', title: 'testy dekodera' },
    );
    await flush();

    // --- fjord: karta bezczynna, wynik odebrany (`seen` niesie tylko `waiting-input`) -
    const fjord = idOf('w4:p9');
    supervisor.appear(
      agent('w4:p9', 'fjord', UUID_FJORD, { status: 'idle', title: 'notatki', stateChangeSeq: 9 }),
      [{ type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 9 }],
    );
    await flush();

    // --- punkt kontrolny: karty, transkrypty i lista ------------------------------------
    out.set('session-changed.max.json', live.last('session-changed', (f) => sessionOf(f).id === atlas));
    out.set('session-changed.question.json',
      live.last('session-changed', (f) => sessionOf(f).id === dunes));
    out.set('session-changed.trust-dialog.json',
      live.last('session-changed', (f) => sessionOf(f).id === idOf('w1:p3')));
    out.set('session-changed.no-digits.json',
      live.last('session-changed', (f) => sessionOf(f).id === ember));
    out.set('session-changed.codex.json',
      live.last('session-changed', (f) => sessionOf(f).id === idOf('w3:p6')));
    out.set('session-changed.tool.json', live.last('session-changed', (f) => sessionOf(f).id === zeta));
    out.set('session-changed.idle.json', live.last('session-changed', (f) => sessionOf(f).id === fjord));

    // Echo wysyłki z telefonu: zdjęcie i plik jako wizytówki (ostatnia wiadomość człowieka).
    out.set('message.max.json', birchStream.last('message', (f) => (
      (f.message as { role: string }).role === 'user' && 'attachments' in (f.message as object)
    )));
    out.set('message.tool-calls.json', birchStream.first('message', (f) => (
      (f.message as { blocks: { type: string }[] }).blocks.some((b) => b.type === 'tool-call')
    )));
    out.set('message.image.json', birchStream.first('message', (f) => (
      (f.message as { blocks: { type: string }[] }).blocks.some((b) => b.type === 'image')
    )));
    out.set('message.unicode.json', birchStream.last('message', (f) => (
      JSON.stringify(f.message).includes('Zażółć')
    )));
    out.set('message.notice.json', groveStream.last('message', (f) => 'notice' in (f.message as object)));
    out.set('permission-pending.max.json', birchStream.last('permission-pending'));
    out.set('permission-pending.no-digits.json', emberStream.last('permission-pending'));
    out.set('question-pending.max.json', dunesStream.last('question-pending'));
    out.set('question-pending.keys.json', groveStream.last('question-pending'));
    out.set('permission-pending.plan.json', lambdaStream.last('permission-pending'));
    out.set('activity.max.json', atlasStream.last('activity', (f) => f.workflow !== undefined));
    out.set('activity.tool.json', zetaStream.last('activity', (f) => f.summary !== undefined));
    out.set('usage.max.json', atlasStream.last('usage'));
    out.set('git-status.max.json', atlasStream.last('git-status'));

    const birchSnapshot = new FrameSink();
    hub.openSession(birch, birchSnapshot, null);
    out.set('transcript-snapshot.max.json', birchSnapshot.last('transcript-snapshot'));
    const atlasSnapshot = new FrameSink();
    hub.openSession(atlas, atlasSnapshot, null);
    out.set('transcript-snapshot.running.json', atlasSnapshot.last('transcript-snapshot'));
    const dunesSnapshot = new FrameSink();
    hub.openSession(dunes, dunesSnapshot, null);
    out.set('transcript-snapshot.question.json', dunesSnapshot.last('transcript-snapshot'));
    const groveSnapshot = new FrameSink();
    hub.openSession(grove, groveSnapshot, null);
    out.set('transcript-snapshot.keys.json', groveSnapshot.last('transcript-snapshot'));
    const zetaSnapshot = new FrameSink();
    hub.openSession(zeta, zetaSnapshot, null);
    out.set('transcript-snapshot.tool.json', zetaSnapshot.last('transcript-snapshot'));

    const global = new FrameSink();
    hub.openGlobal(global);
    out.set('hello.max.json', global.first('hello'));
    out.set('sessions-snapshot.max.json', global.first('sessions-snapshot'));

    // --- cedar po zaufaniu: okno komendy CLI, którego Rarog nie rozpoznał -------
    // Klasa z rejestru sesji CLI jedzie na kartę bez decyzji. PO pełnej ramce listy i bez
    // `tick()`: lista zostaje przy dialogu zaufania, a zegar reszty scenariusza — nietknięty.
    supervisor.driver('w1:p3').push(
      { type: 'permission-cleared', reason: 'zaufanie potwierdzone w terminalu' },
      {
        type: 'screen-dialog', reason: 'no-jsonl', cliDialog: 'dialog',
        screen: [
          'Select login method:', '❯ 1. Claude account with subscription', '  2. Anthropic Console account',
        ].join('\n'),
      },
    );
    await flush();
    out.set('session-changed.cli-dialog.json',
      live.last('session-changed', (f) => sessionOf(f).id === idOf('w1:p3')));

    // --- atlas po pełnej ramce: subagent `agent_9b2c` staje i czeka na własną komendę ------
    // Notka z wynikiem `waiting` (postój to nie koniec). Linia jsonl idzie przez import jak
    // notka `grove` i to import daje wynik, nie ten test: `notice.ts` czyta meldunek `completed`
    // z dopiskiem o postoju jako `waiting`, nie `done`. Bez `tick()`, jak przy notce `grove`.
    const waiting = parseImportLine(WAITING_NOTICE_LINE)?.message;
    if (waiting?.notice === undefined) throw new Error('import nie rozpoznał meldunku o postoju');
    supervisor.driver('w1:p1').push({
      type: 'message', role: waiting.role, blocks: waiting.blocks, notice: waiting.notice,
    });
    await flush();
    out.set('message.notice-waiting.json',
      atlasStream.last('message', (f) => 'notice' in (f.message as object)));
    const atlasWaiting = new FrameSink();
    hub.openSession(atlas, atlasWaiting, null);
    out.set('transcript-snapshot.notice-waiting.json', atlasWaiting.last('transcript-snapshot'));

    // --- atlas: koniec obserwacji usuniętego artefaktu — notka `artifact-watch` -------
    // Linia jsonl idzie przez import jak notka `grove`; bez `tick()`.
    const watch = parseImportLine(ARTIFACT_WATCH_LINE)?.message;
    if (watch?.notice?.kind !== 'artifact-watch') throw new Error('import nie rozpoznał meldunku o artefakcie');
    supervisor.driver('w1:p1').push({
      type: 'message', role: watch.role, blocks: watch.blocks, notice: watch.notice,
    });
    await flush();
    out.set('message.notice-artifact-watch.json', atlasStream.last('message', (f) => (
      (f.message as { notice?: { kind: string } }).notice?.kind === 'artifact-watch'
    )));

    // --- atlas: prompt zablokowany przez hook `UserPromptSubmit` ---
    // Notkę składa manager ze zdarzenia drivera: wysyłka z Raroga (dymek już stoi, notka bez cytatu)
    // i prompt wpisany w terminalu (notka z cytatem). Zdarzenia wprost, jak notki wyżej; bez `tick()`.
    const fromRarog = promptBlockOf('Dopisz testy do fixture');
    supervisor.driver('w1:p1').push({
      type: 'prompt-blocked', ...fromRarog, echoed: true, decided: false, key: fromRarog.prompt,
    });
    await flush();
    out.set('message.prompt-blocked.json', atlasStream.last('message', (f) => (
      'promptBlocked' in (f.message as object)
    )));
    const fromTerminal = promptBlockOf('Typed at the Mac\non two lines');
    supervisor.driver('w1:p1').push({
      type: 'prompt-blocked', ...fromTerminal, echoed: false, decided: false, key: fromTerminal.prompt,
    });
    await flush();
    out.set('message.prompt-blocked-terminal.json', atlasStream.last('message', (f) => (
      (f.message as { promptBlocked?: { prompt?: string } }).promptBlocked?.prompt !== undefined
    )));
    const atlasBlocked = new FrameSink();
    hub.openSession(atlas, atlasBlocked, null);
    out.set('transcript-snapshot.prompt-blocked.json', atlasBlocked.last('transcript-snapshot'));

    // --- fjord: prompt z telefonu zablokowany przez hook → przycisk na karcie -----------
    // Karta bezczynna dostaje wysyłkę z Raroga, a driver rozstrzyga ją blokadą: `SessionSummary.promptBlocked`
    // niesie `seq` notki i `id` blokady (stały z `promptBlockId`). Po wszystkich ramkach `fjord` (punkt kontrolny
    // wyżej); bez `tick()`.
    const fjordPrompt = 'Uruchom testy kontraktu';
    await manager.sendMessage(fjord, fjordPrompt);
    await flush();
    supervisor.driver('w4:p9').push({
      type: 'prompt-blocked', ...promptBlockOf(fjordPrompt), echoed: true, decided: true, key: echoKey(fjordPrompt),
    });
    await flush();
    out.set('session-changed.prompt-blocked.json', live.last('session-changed', (f) => (
      sessionOf(f).id === fjord && 'promptBlocked' in sessionOf(f)
    )));
    const blockedList = new FrameSink();
    hub.openGlobal(blockedList);
    out.set('sessions-snapshot.prompt-blocked.json', blockedList.first('sessions-snapshot'));

    // --- decyzje z telefonu ---------------------------------------------------------------
    tick();
    await manager.resolvePermission(birch, 'toolu_21', 'allow-always', 'iPad');
    out.set('permission-resolved.max.json', birchStream.last('permission-resolved'));
    tick();
    await manager.answerQuestion(dunes, 'toolu_31', [['shared/fixtures/sse'], ['PWA', 'Swift']]);
    out.set('question-resolved.max.json', dunesStream.last('question-resolved'));

    // --- nowy katalog po pełnej ramce: bit notatki, stan bez szczegółu, pusty transkrypt -
    tick();
    const nowy = idOf('w3:p7');
    supervisor.appear(
      agent('w3:p7', 'nowy', UUID_NOWY, { status: 'idle', title: 'nowy' }),
      [{ type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 }],
    );
    await flush();
    out.set('notes.max.json', global.last('notes'));
    out.set('state.min.json', global.last('state', (f) => f.sessionId === nowy));
    const nowySnapshot = new FrameSink();
    hub.openSession(nowy, nowySnapshot, null);
    out.set('transcript-snapshot.min.json', nowySnapshot.last('transcript-snapshot'));

    // --- mu: pytanie z PODGLĄDEM opcji — driver oddaje oryginał, manager tnie kopię -
    // Po pełnej ramce listy: wcześniejsze ramki (lista, notatki) zostają nietknięte.
    tick();
    const mu = idOf('w6:p12');
    const muStream = new FrameSink();
    supervisor.appear(
      agent('w6:p12', 'mu', UUID_MU, { title: 'układ listy', stateChangeSeq: 2 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 2 }],
    );
    await flush();
    hub.openSession(mu, muStream, null);
    supervisor.driver('w6:p12').push(
      { type: 'init', engineSessionId: UUID_MU, model: 'claude-opus-5-5', effort: 'high' },
      { type: 'question-request', reqId: 'hook:1790000123:5f1c0a2b9d3e', channel: 'hook',
        questions: PREVIEW_QUESTIONS },
    );
    await flush();
    out.set('question-pending.preview.json', muStream.last('question-pending'));
    const muSnapshot = new FrameSink();
    hub.openSession(mu, muSnapshot, null);
    out.set('transcript-snapshot.preview.json', muSnapshot.last('transcript-snapshot'));

    // --- nu: ekran PRZEGLĄDU formularza — pary liczone z surowych linii ekranu ----
    const nu = idOf('w6:p13');
    const nuStream = new FrameSink();
    supervisor.appear(
      agent('w6:p13', 'nu', UUID_NU, { title: 'przegląd odpowiedzi', stateChangeSeq: 4 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 4 }],
    );
    await flush();
    hub.openSession(nu, nuStream, null);
    const reviewDialog = parseOptions(REVIEW_SCREEN);
    if (reviewDialog?.kind !== 'confirm' || reviewDialog.question === null) {
      throw new Error('parser nie rozpoznał ekranu przeglądu');
    }
    const reviewCard = screenQuestionCard({
      kind: 'confirm', ...reviewDialog.question, options: reviewDialog.options,
      dialogIdentity: { kind: 'confirm', identity: reviewDialog.identity },
    }, 4, reviewPairsFrom(REVIEW_SCREEN));
    supervisor.driver('w6:p13').push(reviewCard.event);
    await flush();
    out.set('question-pending.review.json', nuStream.last('question-pending'));
    const nuSnapshot = new FrameSink();
    hub.openSession(nu, nuSnapshot, null);
    out.set('transcript-snapshot.review.json', nuSnapshot.last('transcript-snapshot'));

    // --- xi: zdania z kodem na drucie — etykieta numerowana, blok `[image]`, ucięcia, karty z kodem --
    const xi = idOf('w7:p14');
    const xiStream = new FrameSink();
    supervisor.appear(
      agent('w7:p14', 'xi', UUID_XI, { title: 'session 2', stateChangeSeq: 3 }),
      [{ type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 3 }],
    );
    await flush();
    hub.openSession(xi, xiStream, null);
    tick();
    const longDetail = clipForDisplay(`pnpm test ${'shared/test/decode.test.ts '.repeat(6)}`, 80);
    supervisor.driver('w7:p14').push({ type: 'message', role: 'assistant', blocks: [
      { type: 'text', text: say('transcript.image-placeholder') },
      {
        type: 'tool-call', toolName: 'Bash', summary: 'pnpm test shared/test', detail: longDetail.text,
        inputKind: 'shell', ...(longDetail.truncation === undefined ? {} : { truncation: longDetail.truncation }),
      },
    ] });
    await flush();
    tick();
    supervisor.driver('w7:p14').push({
      type: 'permission-request', reqId: 'toolu_61', toolName: 'Bash',
      input: { command: longDetail.text }, displayText: longDetail.text,
      ...(longDetail.truncation === undefined ? {} : { truncation: longDetail.truncation }),
    });
    supervisor.driver('w7:p14').push({ ...degradedCard('toolu_62', null, 'mismatch').event } as DriverEvent);
    await flush();
    tick();
    const fallbackCard = screenQuestionCard({
      kind: 'question', header: 'Wybór', question: '',
      options: [{ label: 'A', digit: '1' }, { label: 'B', digit: '2' }],
      dialogIdentity: { kind: 'question', identity: { kind: 'form' } },
    }, 3);
    supervisor.driver('w7:p14').push(fallbackCard.event);
    await flush();
    out.set('session-changed.label-ref.json', live.last('session-changed', (f) => sessionOf(f).id === xi));
    out.set('message.refs.json', xiStream.last('message'));
    out.set('permission-pending.truncation.json', xiStream.first('permission-pending'));
    out.set('permission-pending.degraded.json', xiStream.last('permission-pending'));
    out.set('question-pending.fallback.json', xiStream.last('question-pending'));
    const xiSnapshot = new FrameSink();
    hub.openSession(xi, xiSnapshot, null);
    out.set('transcript-snapshot.refs.json', xiSnapshot.last('transcript-snapshot'));
    const xiList = new FrameSink();
    hub.openGlobal(xiList);
    out.set('sessions-snapshot.label-ref.json', xiList.first('sessions-snapshot'));
    // Karta z pliku rozmowy z komendą ze znakiem kierunku pisma U+202E: treść na karcie, bez przycisku zgody. Po
    // zrzutach sesji `xi`, żeby nie zmieniać ich ramek.
    const hiddenCommand = `echo ${String.fromCodePoint(0x202e)}gnp.exe`;
    supervisor.driver('w7:p14').push({
      type: 'permission-request', reqId: 'toolu_63', toolName: 'Bash',
      input: { command: hiddenCommand }, displayText: hiddenCommand,
    });
    await flush();
    out.set('permission-pending.hidden.json', xiStream.last(
      'permission-pending', (f) => (f.request as Record<string, unknown>).permId === 'toolu_63',
    ));
    // Cards without `channel` through the consent gate: the reason why the approve button is missing.
    const screenNames = ['screen-settings-changed', 'screen-no-channel', 'screen-truncated'];
    for (const [index, [reqId, event]] of [...screenConsentEvents('/Users/demo/Projects/xi')].entries()) {
      supervisor.driver('w7:p14').push(event);
      await flush();
      out.set(`permission-pending.${screenNames[index] ?? reqId}.json`, xiStream.last(
        'permission-pending', (f) => (f.request as Record<string, unknown>).permId === reqId,
      ));
    }

    // --- gniazdo herdr ------------------------------------------------------------------
    supervisor.lifecycle.push({ type: 'unavailable', reason: say('herdr.response-timeout', { method: 'agent.list' }) });
    await flush();
    out.set('herdr-status.max.json', global.last('herdr-status'));
    // Powrót gniazda przy osiągniętym suficie paneli: baner niesie zdanie nadzorcy z kodem.
    supervisor.lifecycle.push({ type: 'available' });
    await flush();
    out.set('herdr-status.pane-cap.json', global.last('herdr-status'));
  } finally {
    hub.closeAll();
    await manager.dispose();
    supervisor.dispose();
  }
}

/** Demo: siedem seedów i mock-driver — tura po zgodzie, pytanie i limit planu. */
async function produceDemo(out: Produced, dataDir: string): Promise<void> {
  vi.useFakeTimers({ now: Date.parse('2026-10-03T09:00:00.000Z') });
  const manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
  const hub = new SseHub({
    manager,
    serverStartId: '6a1d9f3c-2e7b-4b85-9c04-d3f8a2e1b507',
    protocolVersion: PROTOCOL_VERSION,
    heartbeatMs: 0,
    notesFor: (cwds) => cwds.filter((cwd) => cwd.endsWith('/willow')),
  });
  try {
    await manager.ready;
    hub.start();
    const global = new FrameSink();
    hub.openGlobal(global);
    out.set('sessions-snapshot.demo.json', global.first('sessions-snapshot'));
    const willow = new FrameSink();
    hub.openSession('demo-willow', willow, null);
    out.set('transcript-snapshot.demo.json', willow.first('transcript-snapshot'));

    await vi.advanceTimersByTimeAsync(0);
    await manager.resolvePermission('demo-willow', 'demo-perm-willow', 'allow', 'iPhone');
    await vi.advanceTimersByTimeAsync(10_000);
    out.set('activity.min.json', willow.first('activity', (f) => f.kind === 'thinking'));
    out.set('delta.max.json', willow.first('delta'));
    out.set('message.min.json', willow.first('message', (f) => (
      (f.message as { role: string }).role === 'assistant'
    )));

    await manager.sendMessage('demo-willow', 'Mam pytanie o format zapisu rejestru.');
    await vi.advanceTimersByTimeAsync(1_000);
    const question = willow.last('question-pending');
    out.set('question-pending.min.json', question);
    const qId = (question.request as { qId: string }).qId;
    await manager.answerQuestion('demo-willow', qId, [['JSON + rename'], ['Jednostkowe']]);
    await vi.advanceTimersByTimeAsync(10_000);

    await manager.sendMessage('demo-willow', 'Sprawdź limit planu przed kolejną turą.');
    await vi.advanceTimersByTimeAsync(1_000);
    out.set('state.max.json', global.last('state', (f) => f.state === 'limit-reached'));
  } finally {
    hub.closeAll();
    await manager.dispose();
    vi.useRealTimers();
  }
}

/** Rarog bez herdr: pusta lista i nic więcej — najmniejsza ramka listy. */
async function produceBare(out: Produced, dataDir: string): Promise<void> {
  const manager = await createManager({ demo: false, dataDir, gitStatus: null, gitWatcher: null });
  const hub = new SseHub({
    manager, serverStartId: '3e9b0c71-8d42-4a6f-b1e5-c07a9d2f4b38',
    protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
  });
  try {
    await manager.ready;
    hub.start();
    const global = new FrameSink();
    hub.openGlobal(global);
    // Serwer bez `RAROG_MIN_CLIENT_BUILD`: `hello` BEZ progu — to jest `ok`, nie `null`.
    out.set('hello.min.json', global.first('hello'));
    out.set('sessions-snapshot.min.json', global.first('sessions-snapshot'));
  } finally {
    hub.closeAll();
    await manager.dispose();
  }
}

/**
 * A result marked unread by hand (one idle pane adopted as received, then `markUnseen`) and a result the voice agent
 * picked up (a pane on `done`, then the pick-up). Its own manager, so the herdr scenario's frames stay as they are.
 */
async function produceSeenMarks(out: Produced, dataDir: string): Promise<void> {
  const clock = Date.parse('2026-10-03T10:00:00.000Z');
  const supervisor = new FixtureSupervisor();
  const manager: Manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: fixtureDeps(), herdrRoots: [ROOT],
    now: () => clock, gitStatus: null, gitWatcher: null, liveSessionsReader: () => Promise.resolve(null),
  });
  const hub = new SseHub({
    manager, serverStartId: '5b2e8d14-7f39-4c6a-a0d3-91e6c4b7f258', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
  });
  try {
    await manager.ready;
    hub.start();
    const live = new FrameSink();
    hub.openGlobal(live);
    const omicron = idOf('w8:p15');
    supervisor.appear(
      agent('w8:p15', 'omicron', UUID_OMICRON, { status: 'idle', title: 'review notes', stateChangeSeq: 6 }),
      [{ type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 6 }],
    );
    await flush();
    manager.markUnseen(omicron);
    await flush();
    out.set('session-changed.marked-unseen.json', live.last('session-changed', (f) => (
      sessionOf(f).id === omicron && 'markedUnseen' in sessionOf(f)
    )));
    const list = new FrameSink();
    hub.openGlobal(list);
    out.set('sessions-snapshot.marked-unseen.json', list.first('sessions-snapshot'));
    const sigma = idOf('w8:p16');
    supervisor.appear(
      agent('w8:p16', 'sigma', UUID_SIGMA, { status: 'done', title: 'release notes', stateChangeSeq: 9 }),
      [{ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 9 }],
    );
    await flush();
    manager.markSeen(sigma, {
      by: 'voice-agent', readMark: manager.companionTarget(sigma)?.readMark ?? '',
      conversation: (agentSessionId) => agentSessionId === UUID_SIGMA,
    });
    await flush();
    out.set('session-changed.seen-by-voice-agent.json', live.last('session-changed', (f) => 'seenBy' in sessionOf(f)));
    const picked = new FrameSink();
    hub.openGlobal(picked);
    out.set('sessions-snapshot.seen-by-voice-agent.json', picked.first('sessions-snapshot'));
  } finally {
    hub.closeAll();
    await manager.dispose();
    supervisor.dispose();
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const manifest = readManifest();
/** Pliki `ok` bez `base` — to te, które musi wyprodukować kod. */
const producedNames = Object.entries(manifest)
  .filter(([, entry]) => entry.expect === 'ok' && entry.base === undefined)
  .map(([name]) => name)
  .sort();

describe('złote ramki SSE: producenci → pliki', () => {
  const produced: Produced = new Map();
  const dirs: string[] = [];

  beforeAll(async () => {
    for (const run of [produceHerdr, produceDemo, produceBare, produceSeenMarks, produceInbox]) {
      const dir = await mkdtemp(path.join(tmpdir(), 'rarog-fixtures-'));
      dirs.push(dir);
      await run(produced, dir);
    }
    produceConsent(produced);
    if (!WRITE) return;
    for (const [name, frame] of produced) {
      writeFileSync(path.join(FIXTURES_DIR, name), serialize(frame));
    }
    // Pochodne liczone od ŚWIEŻYCH plików bazowych — inaczej strażnik dryfu w `shared` padnie.
    for (const [name, entry] of Object.entries(manifest)) {
      if (entry.base === undefined) continue;
      writeFileSync(
        path.join(FIXTURES_DIR, name), serialize(applyOps(readFixture(entry.base), entry.patch ?? [])),
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('kod produkuje dokładnie te ramki, które manifest zna jako `ok` bez `base`', () => {
    expect([...produced.keys()].sort()).toEqual(producedNames);
  });

  it('każda wyprodukowana ramka przechodzi ŚCISŁY kontrakt bez strat (nadajnik nie waliduje)', () => {
    for (const [name, frame] of produced) {
      expect(parseServerEvent(frame), `${name}: ramka poza kontraktem`).toEqual(frame);
    }
  });

  it('karta kanału: ta sama komenda `Bash` z wyłączonym sandboksem dostaje uwagę, bez niego nie', () => {
    const request = (name: string): Record<string, unknown> =>
      (produced.get(name) as { request: Record<string, unknown> }).request;
    expect(request('permission-pending.hook.json').displayText)
      .toBe(request('permission-pending.hook-sandbox.json').displayText);
    expect(request('permission-pending.hook.json').notes).toBeUndefined();
    expect(request('permission-pending.hook-sandbox.json').notes).toEqual(['sandbox-disabled']);
  });

  it('karta kanału w stanie niekońcowym nie daje `permission-resolved`', () => {
    expect(consentResolvedEvent(consentView('k', 'Bash', consentBash(false), { state: 'unknown' }), null, 'iPad'))
      .toBeNull();
  });

  it.each(producedNames)('%s = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)', (name) => {
    expect(produced.get(name), `${name}: kod przestał produkować tę ramkę`).toBeDefined();
    expect(produced.get(name)).toEqual(readFixture(name));
  });
});
