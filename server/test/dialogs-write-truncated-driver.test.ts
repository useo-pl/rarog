/**
 * Dialog `Write` z nagłówkiem nad krawędzią ekranu przez prawdziwy driver (opis:
 * `docs/dialogs.md`, „Known gaps”).
 *
 * Nagłówek nad krawędzią zabiera tytuł, licznik kolejki („1 of 2”) i górę ramki treści: zostaje koniec treści
 * i pytanie „Do you want to create <nazwa>?”. Pytanie daje tożsamość `file-question` i nazwę `Write` tylko do
 * wyświetlenia: ekran nie pokazuje, KTÓRY `Write` z kolejki stoi, a ścieżka jsonl i zrzutu porównuje przy `Write`
 * samą nazwę. Wpis jsonl albo zrzut hooka `Write` pliku A nad dialogiem pliku B dostawał przyciski, a cyfra
 * zatwierdzała B z karty A. Zdanie pliku: taki dialog nie dostaje cyfry w żadnym trybie kanału (`off`, `shadow`
 * z warstwą 2 i bez niej, `main`) i przez żadne wejście decyzji, a karta stoi bez przycisku zgody. To samo dla każdej
 * ramki bez paska `│` uciętej u góry, niezależnie od tożsamości: `Write` z licznikiem auto-odmowy pod ramką i `Edit`
 * widziany od środka diffu.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { editContradictsOperation, fileCallShown } from '../src/herdr/dialogs/screen/edit-frame.ts';
import type { FileCall } from '../src/herdr/dialogs/screen/edit-frame.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { createUploads } from '../src/herdr/uploads.ts';

const SESSION = '5a1e7c2b-3d4f-4a6b-9c8d-0e1f2a3b4c5d';
const PANE = 'w9:p72';
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };
/** Dialog pliku B: `Write` z treścią wyższą niż panel, nagłówek i licznik kolejki nad krawędzią (CLI 2.1.322). */
const CUT_WRITE_B = readFileSync(
  join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'zgoda-write-dluga-tresc-2.1.322.txt'), 'utf8',
);
/** Wywołanie pliku A: inne niż dialog na ekranie, to samo narzędzie. */
const WRITE_A = { file_path: '/Users/u/projekt/inny.txt', content: 'treść pliku A\n' };
const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;

// ---------------------------------------------------------------------------
// Driver: atrapa klienta herdr, prawdziwy follower (jak `layer1-driver.test.ts`)
// ---------------------------------------------------------------------------

interface Call {
  method: 'prompt' | 'send_keys' | 'form_submit' | 'mode_cycle' | 'trust_step' | 'dialog_key' | 'take_back_key' | 'read' | 'focus' | 'history';
  keys?: readonly string[];
}

class FakeClient implements HerdrClient {
  readonly calls: Call[] = [];
  screenText = '';
  sendFormSubmit = (): Promise<void> => {
    this.calls.push({ method: 'form_submit', keys: ['enter'] });
    return Promise.resolve();
  };
  sendModeCycle = (): Promise<void> => {
    this.calls.push({ method: 'mode_cycle', keys: ['shift+tab'] });
    return Promise.resolve();
  };
  sendTrustStep = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'trust_step', keys: [key] });
    return Promise.resolve();
  };
  sendDialogKey = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'dialog_key', keys: [key] });
    return Promise.resolve();
  };
  sendTakeBackKey = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'take_back_key', keys: [key] });
    return Promise.resolve();
  };
  pasteText = (): Promise<void> => Promise.resolve();
  sendPromptSubmit = (): Promise<void> => Promise.resolve();
  listAgents(): Promise<never> {
    return Promise.reject(new Error('driver nie woła agent.list'));
  }
  getAgent: () => Promise<HerdrAgentInfo> = () => Promise.reject(new Error('bez sondy przerwania'));
  readPaneHistory(): Promise<HerdrPaneHistory> {
    this.calls.push({ method: 'history' });
    return Promise.resolve({ text: '', truncated: false });
  }
  readScreen(): Promise<HerdrScreen> {
    this.calls.push({ method: 'read' });
    return Promise.resolve({ text: this.screenText });
  }
  prompt(): Promise<void> {
    this.calls.push({ method: 'prompt' });
    return Promise.resolve();
  }
  sendKeys = (_paneId: string, keys: readonly string[]): Promise<void> => {
    this.calls.push({ method: 'send_keys', keys });
    return Promise.resolve();
  };
  focus(): Promise<void> {
    this.calls.push({ method: 'focus' });
    return Promise.resolve();
  }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.8.2', protocol: 20 });
  }
}

class FakePulse implements SessionPulse {
  start(): void {}
  stop(): void {}
  repoint(): void {}
  relocated(): void {}
  close(): void {}
  constructor(readonly onPulse: (sample: PulseSample) => void) {}
}

interface Fixture {
  driver: SessionDriver;
  client: FakeClient;
  events: DriverEvent[];
  emit: (ev: HerdrPaneEvent) => void;
}

let base = '';
let root = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-write-uciety-'));
  root = join(base, 'store');
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(base, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-11-10T10:00:00.000Z', sessionId: SESSION,
})}\n`;

const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: '2026-11-10T10:00:06.000Z', sessionId: SESSION,
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }] },
})}\n`;

async function makeDriver(opts: { deps: Partial<HerdrDriverDeps>; transcript: string; screen: string }): Promise<Fixture> {
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${SESSION}.jsonl`), opts.transcript);
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
  const listeners = new Set<(ev: HerdrPaneEvent) => void>();
  const handle: HerdrAgentHandle = {
    agent,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = new FakeClient();
  client.screenText = opts.screen;
  const deps: HerdrDriverDeps = {
    pulse: (o) => new FakePulse(o.onPulse),
    client,
    audit: { log: () => {} },
    uploads: createUploads(),
    yoloRoots: [],
    now: () => NOW,
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    agentFiles: (o) => createAgentFileReader({ ...o, root }),
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    system: 'macos',
    ...opts.deps,
  };
  const driver = createHerdrDriver(handle, deps);
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();
  return { driver, client, events, emit: (ev) => { for (const l of listeners) l(ev); } };
}

type CardEvent = Extract<DriverEvent, { type: 'permission-request' | 'question-request' | 'screen-dialog' }>;
const cardsOf = (events: readonly DriverEvent[]): CardEvent[] => events.filter((e): e is CardEvent =>
  e.type === 'permission-request' || e.type === 'question-request' || e.type === 'screen-dialog');

const digitsSent = (fx: Fixture): string[] => fx.client.calls
  .filter((c) => c.method === 'send_keys').flatMap((c) => c.keys ?? []).filter((key) => /^\d$/.test(key));

/** Źródło karty: wpis jsonl innego wywołania, zrzut hooka innego wywołania albo sam ekran. */
type Source = 'jsonl' | 'hook' | 'screen';
const SOURCES: readonly Source[] = ['jsonl', 'hook', 'screen'];
/** Tryb kanału zgód; `shadow` także z warstwą 2 dialogów (`RAROG_DIALOG_LAYER2`). */
const MODES: readonly { mode: ConsentEffectiveMode; layer2: boolean }[] = [
  { mode: 'off', layer2: false }, { mode: 'shadow', layer2: false }, { mode: 'shadow', layer2: true },
  { mode: 'main', layer2: false },
];

/** Wywołanie narzędzia, którego wpis albo zrzut stoi obok uciętego dialogu. */
interface ToolCall {
  readonly tool: string;
  readonly input: unknown;
}

const WRITE_CALL: ToolCall = { tool: 'Write', input: WRITE_A };

/** Zrzut `PermissionRequest` wywołania `call` (świeży, wątek główny). */
const hookOf = (call: ToolCall): PendingHookTool => ({
  toolName: call.tool, toolInput: call.input, at: NOW - 2_000, hookEventName: 'PermissionRequest', promptId: 'p1',
});

/** Driver nad uciętym dialogiem `screen`, panel `blocked`, karta wystawiona. */
async function cutCard(
  screen: string, call: ToolCall, source: Source, mode: ConsentEffectiveMode, layer2: boolean, signal: boolean,
): Promise<Fixture> {
  const fx = await makeDriver({
    transcript: userLine('zapisz') + (source === 'jsonl' ? toolUseLine('toolu_obok', call.tool, call.input) : ''),
    screen,
    deps: {
      consentMode: () => mode,
      dialogLayer2: layer2,
      ...(source === 'hook' ? { readPendingHook: () => hookOf(call), clearPendingHook: () => {} } : {}),
    },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
  if (signal) fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await waitFor(() => cardsOf(fx.events).length > 0, `karta ${source} ${mode}`);
  await quiet();
  return fx;
}

/**
 * Każde wejście decyzji: karta po `reqId` (także „nie pytaj więcej”), dialog adresowany sesją, odpowiedź „Yes” na każdą
 * kartę i odpowiedź pierwszą etykietą karty pytania.
 */
async function decideEverywhere(fx: Fixture): Promise<string[]> {
  const outcomes: string[] = [];
  const reqIds = new Set<string>(['sesja']);
  for (const card of cardsOf(fx.events)) if ('reqId' in card) reqIds.add(card.reqId);
  for (const reqId of reqIds) {
    outcomes.push((await fx.driver.respondPermission(reqId, 'allow')).kind);
    outcomes.push((await fx.driver.respondPermission(reqId, 'allow-always')).kind);
    outcomes.push((await fx.driver.answerQuestion(reqId, [['Yes']])).kind);
  }
  for (const card of cardsOf(fx.events)) {
    if (card.type !== 'question-request') continue;
    outcomes.push((await fx.driver.answerQuestion(card.reqId, [[card.questions[0]?.options[0]?.label ?? '']])).kind);
  }
  await quiet();
  return outcomes;
}

/** Karta bez przycisku zgody, żaden wynik `applied` i żadna cyfra w panelu. */
async function expectNoConsent(fx: Fixture): Promise<void> {
  for (const card of cardsOf(fx.events)) {
    // Przycisk zgody ma karta zgody z treścią (`input`) bez `canAllow: false`; karta ekranu — tylko znany dialog.
    if (card.type === 'permission-request') expect(card.input === null || card.canAllow === false, card.reqId).toBe(true);
    if (card.type === 'screen-dialog') expect(card.knownDialog).toBeUndefined();
    expect(card.type).not.toBe('question-request');
  }
  const outcomes = await decideEverywhere(fx);
  expect(outcomes).not.toContain('applied');
  expect(digitsSent(fx)).toEqual([]);
}

const ROWS = SOURCES.flatMap((source) => MODES.flatMap(({ mode, layer2 }) => [true, false]
  .map((signal) => ({ source, mode, layer2, signal }))));

describe('ucięty dialog `Write`: nazwa tylko do wyświetlenia, bez przycisków i bez cyfry', { timeout: 20_000 }, () => {
  it('ekran: nagłówek nad krawędzią, licznika kolejki nie widać, pytanie daje `Write` pliku B', () => {
    expect(CUT_WRITE_B).not.toMatch(/\d+ of \d+/u);
    expect(parseOptions(CUT_WRITE_B)).toMatchObject({
      kind: 'tool', toolName: 'Write',
      identity: { kind: 'file-question', tool: 'Write', file: 'pomiar-dlugi.txt' },
    });
  });

  it.each(ROWS)('źródło $source, tryb $mode (warstwa 2: $layer2), rejestr $signal: karta bez zgody, 0 cyfr',
    async ({ source, mode, layer2, signal }) => {
      await expectNoConsent(await cutCard(CUT_WRITE_B, WRITE_CALL, source, mode, layer2, signal));
    });
});

/*
 * Ramka bez paska `│` ucięta u góry daje kartę bez przycisku zgody niezależnie od tożsamości dialogu: z licznikiem
 * auto-odmowy pod ramką strefa pytania `Write` miała dopisek, tożsamość spadała do `form`, a karta z samego ekranu
 * (także po zrzucie hooka, któremu ekran przeczył) dostawała formularz zgody i cyfrę. Ten sam kształt ma `Edit`, którego
 * ekran zaczyna się w środku diffu.
 */
const COUNTDOWN = '⚠ Claude Code will automatically block this request in 1:38, to avoid holding up an unattended session';
const CUT_WRITE_COUNTDOWN = CUT_WRITE_B.replace(
  ' Do you want to create pomiar-dlugi.txt?', ` ${COUNTDOWN}\n Do you want to create pomiar-dlugi.txt?`,
);
const EDIT_WHOLE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'zgoda-edit-2.1.322.txt'), 'utf8',
);
/** Dialog `Edit` (CLI 2.1.322) widziany od drugiej linii diffu: nagłówek, tytuł i górna kreska ramki nad krawędzią. */
const CUT_EDIT = ((): string => {
  const lines = EDIT_WHOLE.split('\n');
  const frameTop = lines.findIndex((line) => line.startsWith('╌'));
  return lines.slice(frameTop + 2).join('\n');
})();
const EDIT_CALL: ToolCall = {
  tool: 'Edit', input: { file_path: '/Users/u/projekt/inny.txt', old_string: 'a', new_string: 'b' },
};

describe('ramka ucięta u góry: bez przycisków i bez cyfry niezależnie od tożsamości', { timeout: 20_000 }, () => {
  it('ekrany: licznik pod ramką `Write`, `Edit` od środka diffu', () => {
    expect(CUT_WRITE_COUNTDOWN).toContain(COUNTDOWN);
    expect(CUT_EDIT.split('\n')[0]).toBe(' 1 +nowa wartosc');
    expect(parseOptions(CUT_EDIT)).toMatchObject({ kind: 'tool', toolName: null, identity: { kind: 'form' } });
  });

  it('licznik auto-odmowy w strefie pytania nie zabiera nazwy `Write` do wyświetlenia', () => {
    expect(parseOptions(CUT_WRITE_COUNTDOWN)).toMatchObject({
      kind: 'tool', toolName: 'Write',
      identity: { kind: 'file-question', tool: 'Write', file: 'pomiar-dlugi.txt' },
    });
  });

  it('nieznany dopisek w strefie pytania: brak nazwy, nadal bez formularza zgody z ekranu', () => {
    const unknown = CUT_WRITE_B.replace(
      ' Do you want to create pomiar-dlugi.txt?', ' Nowa linia CLI\n Do you want to create pomiar-dlugi.txt?',
    );
    expect(parseOptions(unknown)).toMatchObject({ toolName: null, identity: { kind: 'form' }, question: null });
  });

  it.each(ROWS)('`Write` z licznikiem — źródło $source, tryb $mode (warstwa 2: $layer2), rejestr $signal: 0 cyfr',
    async ({ source, mode, layer2, signal }) => {
      await expectNoConsent(await cutCard(CUT_WRITE_COUNTDOWN, WRITE_CALL, source, mode, layer2, signal));
    });

  it.each(ROWS)('`Edit` od środka diffu — źródło $source, tryb $mode (warstwa 2: $layer2), rejestr $signal: 0 cyfr',
    async ({ source, mode, layer2, signal }) => {
      await expectNoConsent(await cutCard(CUT_EDIT, EDIT_CALL, source, mode, layer2, signal));
    });
});

/*
 * Góra bloku dialogu zgody nad krawędzią ekranu razem z całą ramką operacji (obie kreski `╌╌╌`) albo bez ramki: ekran
 * zaczyna się od pytania. `headerAboveEdge` nie ma wtedy dolnej kreski ramki nad regionem, a `operationAbove` daje
 * `null`, więc dialog wyglądał jak cały i dostawał formularz zgody z samym pytaniem. Formularz `question` zgody wymaga
 * widocznej góry bloku: górnej kreski i linii tytułu albo nagłówka narzędzia pod nią.
 */
const measured = (name: string): string => readFileSync(
  join(import.meta.dirname, 'fixtures', 'herdr', 'measured', name), 'utf8',
);
const corpusScreen = (name: string): string => readFileSync(
  join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8',
);
/** Ekran od linii pytania `question` w dół: wszystko nad nią, z obiema kreskami ramki i tytułem, nad krawędzią. */
const fromQuestion = (screen: string, question: string): string => {
  const lines = screen.split('\n');
  const at = lines.findIndex((line) => line.trim() === question);
  if (at < 0) throw new Error(`brak pytania „${question}”`);
  return lines.slice(at).join('\n');
};

const FROM_QUESTION: readonly { label: string; whole: string; screen: string; call: ToolCall }[] = [
  {
    label: 'Write',
    // Cały `Write` z tej samej wersji CLI; ekran to dialog pliku B przycięty od pytania (reprodukcja z review).
    whole: 'zgoda-write-2.1.322.txt',
    screen: fromQuestion(CUT_WRITE_B, 'Do you want to create pomiar-dlugi.txt?'),
    call: WRITE_CALL,
  },
  {
    label: 'NotebookEdit',
    whole: 'zgoda-notebookedit-insert-2.1.322.txt',
    screen: fromQuestion(
      measured('zgoda-notebookedit-insert-2.1.322.txt'), 'Do you want to insert this cell into pomiar.ipynb?',
    ),
    call: {
      tool: 'NotebookEdit',
      input: { notebook_path: '/Users/u/projekt/inny.ipynb', new_source: 'print(1)', edit_mode: 'insert' },
    },
  },
  {
    label: 'Read',
    whole: 'zgoda-read-poza-projektem-2.1.322.txt',
    screen: fromQuestion(measured('zgoda-read-poza-projektem-2.1.322.txt'), 'Do you want to proceed?'),
    call: { tool: 'Read', input: { file_path: '/Users/u/inny/plik.txt' } },
  },
  {
    label: 'MCP',
    whole: 'zgoda-mcp-2.1.322.txt',
    screen: fromQuestion(measured('zgoda-mcp-2.1.322.txt'), 'Do you want to proceed?'),
    call: { tool: 'mcp__claude_ai_Claude_Docs__guide', input: { items: ['topic.index'] } },
  },
];

describe('góra bloku nad krawędzią razem z ramką: bez formularza zgody i bez cyfry', { timeout: 20_000 }, () => {
  it.each(FROM_QUESTION)('$label: cały dialog ma formularz, ekran od pytania go nie ma', ({ whole, screen }) => {
    expect(parseOptions(measured(whole))).toMatchObject({ kind: 'tool', question: expect.anything() });
    expect(screen.split('\n')[0]).toMatch(/^ Do you want to /u);
    expect(screen).not.toMatch(/^[─╌]{8,}$/mu);
    expect(parseOptions(screen)).toMatchObject({ kind: 'tool', identity: { kind: 'form' }, question: null });
  });

  it.each([
    ['measured/exitplanmode-2.1.293.txt', 'tool'],
    ['measured/zgoda-siec-2.1.322.txt', 'tool'],
    ['dialog-askuserquestion.txt', 'question'],
  ])('cały dialog bez ramki operacji zostaje z formularzem: %s', (name, kind) => {
    expect(parseOptions(corpusScreen(name))).toMatchObject({ kind, question: expect.anything() });
  });

  it('dialog zaufania (bez opcji z cyframi) zostaje rozpoznany jako `trust`', () => {
    expect(resolveOptions(corpusScreen('dialog-trust-2.1.293.txt'), null))
      .toMatchObject({ status: 'no-jsonl', knownDialog: 'trust' });
  });

  const rows = FROM_QUESTION.flatMap((dialog) => ROWS.map((row) => ({ ...dialog, ...row })));
  it.each(rows)('$label od pytania — źródło $source, tryb $mode (warstwa 2: $layer2), rejestr $signal: 0 cyfr',
    async ({ screen, call, source, mode, layer2, signal }) => {
      await expectNoConsent(await cutCard(screen, call, source, mode, layer2, signal));
    });
});

/*
 * Cały dialog `Write` albo `Edit` pliku B i stęchły wpis jsonl tego samego narzędzia dla pliku A, bez hooka. Nazwa
 * z tytułu się zgadza, więc karta z jsonl (treść pliku A) dostawała przyciski, a cyfra zatwierdzała plik B. Karta
 * z jsonl dostaje przyciski tylko wtedy, gdy ścieżka z nagłówka (względna wobec katalogu sesji) i treść albo diff
 * w ramce zgadzają się z wpisem. Katalog sesji w teście to `<base>/projekt` ({@link makeDriver}).
 */
const sessionPath = (name: string): string => join(base, 'projekt', name);
const FILE_DIALOGS: readonly {
  label: string; screen: string; stale: () => ToolCall; matching: () => ToolCall;
}[] = [
  {
    label: 'Overwrite file',
    screen: measured('zgoda-write-nadpisanie-2.1.322.txt'),
    stale: () => ({ tool: 'Write', input: { file_path: sessionPath('inny.txt'), content: 'inna tresc\n' } }),
    matching: () => ({
      tool: 'Write', input: { file_path: sessionPath('istniejacy.txt'), content: 'linia A\nlinia B\n' },
    }),
  },
  {
    label: 'Create file',
    screen: measured('zgoda-write-2.1.322.txt'),
    stale: () => ({ tool: 'Write', input: { file_path: sessionPath('inny.txt'), content: 'inna tresc\n' } }),
    matching: () => ({
      tool: 'Write', input: { file_path: sessionPath('pomiar-dialogow-nowy.txt'), content: 'pomiar\n' },
    }),
  },
  {
    label: 'Edit file',
    screen: EDIT_WHOLE,
    stale: () => ({
      tool: 'Edit', input: { file_path: sessionPath('inny.txt'), old_string: 'stara', new_string: 'nowa' },
    }),
    matching: () => ({
      tool: 'Edit',
      input: { file_path: sessionPath('pomiar-dialogow.txt'), old_string: 'stara wartosc', new_string: 'nowa wartosc' },
    }),
  },
];

/** Dowód z ekranu dają tylko „Create file” i diff `Edit`; „Overwrite file” nie pokazuje, że diff obejmuje cały plik. */
const PROVABLE: ReadonlySet<string> = new Set(['Create file', 'Edit file']);

describe('karta `Write` i `Edit` z jsonl: przyciski tylko przy pliku i treści z ekranu', { timeout: 20_000 }, () => {
  const stale = FILE_DIALOGS.flatMap((dialog) => MODES.map((row) => ({ ...dialog, ...row })));
  it.each(stale)('$label pliku B, stęchły wpis pliku A — tryb $mode (warstwa 2: $layer2): 0 cyfr',
    async ({ screen, stale: call, mode, layer2 }) => {
      await expectNoConsent(await cutCard(screen, call(), 'jsonl', mode, layer2, true));
    });

  const matching = FILE_DIALOGS.filter(({ label }) => PROVABLE.has(label))
    .flatMap((dialog) => MODES.filter(({ mode }) => mode !== 'main').map((row) => ({ ...dialog, ...row })));
  it.each(matching)('$label, wpis tego pliku i tej treści — tryb $mode (warstwa 2: $layer2): przycisk i cyfra 1',
    async ({ screen, matching: call, mode, layer2 }) => {
      const fx = await cutCard(screen, call(), 'jsonl', mode, layer2, true);
      const card = cardsOf(fx.events).find((e) => e.type === 'permission-request');
      if (card?.type !== 'permission-request') return expect.unreachable('brak karty zgody');
      expect(card.input).not.toBeNull();
      expect(card.canAllow).not.toBe(false);
      expect((await fx.driver.respondPermission(card.reqId, 'allow')).kind).toBe('applied');
      await quiet();
      expect(digitsSent(fx)).toEqual(['1']);
    });
});

/*
 * Treść porównana dosłownie (karta 0d). Porównanie po zdjęciu WSZYSTKICH białych znaków uznawało za równe treści różne
 * spacją wewnątrz wiersza, granicą linii albo wcięciem: ekran „Create file” z `rm -rf / safe` i wpis jsonl
 * `rm -rf /safe` dawały kartę z treścią wpisu i cyfrę `1`, która zatwierdza treść z ekranu. Do tego „Overwrite file”
 * nie pokazuje, że diff obejmuje cały plik: hunk z numerami 50–51 albo od linii 1 z niewidocznym ciągiem dalej ma
 * nową stronę równą stęchłej, krótszej treści. Wszystkie te ekrany mają tytuł i ścieżkę pliku z wpisu.
 */
const CREATE = measured('zgoda-write-2.1.322.txt');
const OVERWRITE = measured('zgoda-write-nadpisanie-2.1.322.txt');
/** Ekran pomiaru z wierszami ramki `from` zastąpionymi `to`; brak wierszy `from` to błąd testu, nie cichy pomiar. */
const replaced = (screen: string, from: string, to: string): string => {
  if (!screen.includes(from)) throw new Error(`ekran bez „${from.trim()}”`);
  return screen.replace(from, to);
};
const createWith = (rows: string): string => replaced(CREATE, '  1 pomiar\n', rows);
const editWith = (rows: string): string => replaced(EDIT_WHOLE, ' 1 +nowa wartosc\n', rows);
const overwriteWith = (rows: string): string => replaced(
  OVERWRITE, '  1 -linia 1\n  2 -linia 2\n  1 +linia A\n  2 +linia B\n', rows,
);
const writeOf = (name: string, content: string): ToolCall => ({
  tool: 'Write', input: { file_path: sessionPath(name), content },
});
const editOf = (newString: string): ToolCall => ({
  tool: 'Edit',
  input: { file_path: sessionPath('pomiar-dialogow.txt'), old_string: 'stara wartosc', new_string: newString },
});
const UNPROVEN: readonly { label: string; screen: string; call: () => ToolCall }[] = [
  {
    label: 'Create: spacja w wierszu (`rm -rf / safe` na ekranie, `rm -rf /safe` we wpisie)',
    screen: createWith('  1 rm -rf / safe\n'), call: () => writeOf('pomiar-dialogow-nowy.txt', 'rm -rf /safe\n'),
  },
  {
    label: 'Create: granica linii (dwie linie na ekranie, jedna we wpisie)',
    screen: createWith('  1 linia A\n  2 linia B\n'), call: () => writeOf('pomiar-dialogow-nowy.txt', 'linia A linia B\n'),
  },
  {
    label: 'Create: wcięcie (wcięta linia na ekranie, bez wcięcia we wpisie)',
    screen: createWith('  1   pomiar\n'), call: () => writeOf('pomiar-dialogow-nowy.txt', 'pomiar\n'),
  },
  { label: 'Edit: spacja w wierszu', screen: editWith(' 1 +nowa war tosc\n'), call: () => editOf('nowa wartosc') },
  { label: 'Edit: granica linii', screen: editWith(' 1 +nowa\n 2 +wartosc\n'), call: () => editOf('nowa wartosc') },
  { label: 'Edit: wcięcie', screen: editWith(' 1 +  nowa wartosc\n'), call: () => editOf('nowa wartosc') },
  {
    label: 'Overwrite: cały diff z pomiaru i wpis tej treści',
    screen: OVERWRITE, call: () => writeOf('istniejacy.txt', 'linia A\nlinia B\n'),
  },
  {
    label: 'Overwrite: jeden hunk 50–51, stęchła treść równa widocznej nowej stronie',
    screen: overwriteWith(' 50 -linia 50\n 51 -linia 51\n 50 +linia A\n 51 +linia B\n'),
    call: () => writeOf('istniejacy.txt', 'linia A\nlinia B\n'),
  },
  {
    label: 'Overwrite: hunk od linii 1, dalszy ciąg pliku niewidoczny',
    screen: overwriteWith('  1 -linia 1\n  1 +linia A\n  2  linia 2\n  3  linia 3\n'),
    call: () => writeOf('istniejacy.txt', 'linia A\nlinia 2\nlinia 3\n'),
  },
];

describe('treść różna dosłownie i „Overwrite file”: karta z jsonl bez przycisku i bez cyfry', { timeout: 20_000 }, () => {
  it.each(UNPROVEN)('$label: ekran ma tożsamość narzędzia i całą ramkę pod nagłówkiem', ({ screen, call }) => {
    expect(parseOptions(screen)).toMatchObject({
      kind: 'tool', toolName: call().tool, operation: { complete: true, headerVisible: true },
    });
  });

  const rows = UNPROVEN.flatMap((dialog) => MODES.map((row) => ({ ...dialog, ...row })));
  it.each(rows)('$label — tryb $mode (warstwa 2: $layer2): 0 cyfr', async ({ screen, call, mode, layer2 }) => {
    await expectNoConsent(await cutCard(screen, call(), 'jsonl', mode, layer2, true));
  });
});

/*
 * Biały znak na końcu linii treści (karta 0d). Ekran rysuje go pustą komórką, a odczyt obcina prawy brzeg wiersza,
 * więc `printf '%s\n' safe \` ze spacją po backslashu i bez niej wyglądają tak samo. To dwa różne skrypty: `\ ` to
 * spacja jako argument i skrypt kończy `exit 7`, a sam `\` skleja linię z następną i skrypt kończy się kodem 0.
 * Treść z takim znakiem nie ma dowodu z ekranu, więc karta z wpisu nie dostaje cyfry `1`; wiersz ramki w teście ma
 * tę spację na końcu.
 */
const SCRIPT_LINE = "printf '%s\\n' safe \\ ";
const LINE_END_SPACE: readonly { label: string; screen: string; call: () => ToolCall }[] = [
  {
    label: 'Create: spacja po końcowym backslashu',
    screen: createWith(`  1 ${SCRIPT_LINE}\n  2 exit 7\n`),
    call: () => writeOf('pomiar-dialogow-nowy.txt', `${SCRIPT_LINE}\nexit 7\n`),
  },
  {
    label: 'Edit: spacja po końcowym backslashu w `new_string`',
    screen: editWith(` 1 +${SCRIPT_LINE}\n 2 +exit 7\n`),
    call: () => editOf(`${SCRIPT_LINE}\nexit 7`),
  },
];

describe('biały znak na końcu linii treści: karta z jsonl bez przycisku i bez cyfry', { timeout: 20_000 }, () => {
  it.each(LINE_END_SPACE)('$label: cała ramka pod nagłówkiem, odczyt bez spacji na końcu wiersza', ({ screen, call }) => {
    const dialog = parseOptions(screen);
    expect(dialog).toMatchObject({
      kind: 'tool', toolName: call().tool, operation: { complete: true, headerVisible: true },
    });
    expect(dialog?.operation?.lines.some((line) => line.endsWith("safe \\"))).toBe(true);
  });

  const rows = LINE_END_SPACE.flatMap((dialog) => MODES.map((row) => ({ ...dialog, ...row })));
  it.each(rows)('$label — tryb $mode (warstwa 2: $layer2): 0 cyfr', async ({ screen, call, mode, layer2 }) => {
    await expectNoConsent(await cutCard(screen, call(), 'jsonl', mode, layer2, true));
  });
});

/*
 * Lines the frame wraps, measured on Claude Code 2.1.330 (`kontrolny/zgoda-{edit,write}-wrap-…`, the exact tool input
 * in `<capture>.input.json`). The call goes to the session directory of this test with the file path the dialog shows
 * relative to it. The jsonl card at `off` gets digit 1 when the frame, joined under the measured geometry, shows the
 * entry's call, and none when the call is one space off at a wrap boundary. In `nbsp` and `tab` the character stands
 * in a context line outside `old_string` and the screen shows a space there: the card carries the call unchanged, so
 * the digit approves exactly its `old_string` and `new_string`.
 */
interface WrapCapture {
  readonly screen: string;
  readonly call: () => ToolCall;
}
const wrapCapture = (
  name: string, change: (input: Record<string, unknown>) => Record<string, unknown> = (input) => input,
): WrapCapture => {
  const file = (ext: string): string => readFileSync(
    join(import.meta.dirname, 'fixtures', 'herdr', 'kontrolny', `${name}${ext}`), 'utf8',
  );
  const measuredCall = JSON.parse(file('.input.json')) as {
    toolName: string; input: Record<string, unknown>; cwd: string;
  };
  const shown = relative(measuredCall.cwd, String(measuredCall.input['file_path']));
  return {
    screen: file('.txt'),
    call: () => ({
      tool: measuredCall.toolName,
      input: change({ ...measuredCall.input, file_path: resolve(base, 'projekt', shown) }),
    }),
  };
};
const CLAUDE_MD = 'zgoda-edit-wrap-claude-md-57-2.1.330';
const WRITE_GEO = 'zgoda-write-wrap-geo-57-2.1.330';
const WRAPPED: readonly { label: string; capture: WrapCapture }[] = [
  { label: '`Edit` of a project instructions file, a context line over five rows', capture: wrapCapture(CLAUDE_MD) },
  { label: '`Write` "Create file", lines over four rows', capture: wrapCapture(WRITE_GEO) },
  { label: '`Edit`, NBSP at W in a context line', capture: wrapCapture('zgoda-edit-wrap-nbsp-57-2.1.330') },
  { label: '`Edit`, a tab in a context line', capture: wrapCapture('zgoda-edit-wrap-tab-57-2.1.330') },
];
const OFF_BY_SPACE: readonly { label: string; name: string; change: (input: Record<string, unknown>) => Record<string, unknown> }[] = [
  {
    label: '`Edit` of a project instructions file, `new_string` with a space at the break', name: CLAUDE_MD,
    change: (input) => ({ ...input, new_string: '- Use one name for one thing across the whole sessi on.' }),
  },
  {
    label: '`Write` "Create file", content with a space at a break', name: WRITE_GEO,
    change: (input) => ({ ...input, content: String(input['content']).replace('dog while th', 'dog while th ') }),
  },
];

describe('lines the frame wraps: the jsonl card at `off` sends the digit for the shown call only', { timeout: 20_000 }, () => {
  it.each(WRAPPED)('$label: the card carries the call unchanged, digit 1', async ({ capture }) => {
    const call = capture.call();
    const fx = await cutCard(capture.screen, call, 'jsonl', 'off', false, true);
    const card = cardsOf(fx.events).find((e) => e.type === 'permission-request');
    if (card?.type !== 'permission-request') return expect.unreachable('no consent card');
    expect(card.input).toEqual(call.input);
    expect(card.canAllow).not.toBe(false);
    expect((await fx.driver.respondPermission(card.reqId, 'allow')).kind).toBe('applied');
    await quiet();
    expect(digitsSent(fx)).toEqual(['1']);
  });

  it.each(OFF_BY_SPACE)('$label: 0 digits', async ({ name, change }) => {
    const capture = wrapCapture(name, change);
    const call = capture.call();
    expect(JSON.stringify(call)).not.toBe(JSON.stringify(wrapCapture(name).call()));
    await expectNoConsent(await cutCard(capture.screen, call, 'jsonl', 'off', false, true));
  });
});

/*
 * A file dialog title over a header whose path continues on a second row, with the key footer marker gone (cut with
 * an ellipsis, as measured at 57 columns). The header does not prove the file, so the dialog is neither a consent
 * nor a confirmation: in no mode and from no source does a card get an approve button or the pane a digit, also when
 * the entry or the dump is the dialog's own call. How the CLI breaks a header path is unmeasured; the screens break it
 * hard at the content width of the 57-column pane.
 */
const LONG_DIR = `atlas-${'d'.repeat(54)}`;
const wrappedHeader = (name: string, file: string, footer: readonly [string, string] | null): WrapCapture => {
  const capture = wrapCapture(name, (input) => ({ ...input, file_path: resolve(base, 'projekt', LONG_DIR, file) }));
  const path = `${LONG_DIR}/${file}`;
  const from = `\n ${file}\n╌`;
  if (!capture.screen.includes(from)) throw new Error(`no header path ${file}`);
  const wrapped = capture.screen.replace(from, `\n ${path.slice(0, 56)}\n ${path.slice(56)}\n╌`);
  if (footer !== null && !wrapped.includes(footer[0])) throw new Error(`no footer "${footer[0]}"`);
  return { ...capture, screen: footer === null ? wrapped : wrapped.replace(footer[0], footer[1]) };
};
const WRAPPED_HEADER: readonly { label: string; capture: WrapCapture }[] = [
  {
    label: '`Edit` with the measured cut footer',
    capture: wrappedHeader('zgoda-edit-wrap-hunks-57-2.1.330', 'notes-hunki-57.md', null),
  },
  {
    label: '`Write` "Create file" with the footer cut',
    capture: wrappedHeader(WRITE_GEO, 'new-geo-57.md', [' Esc to cancel · Tab to amend', ' Esc to cancel · …']),
  },
];
const FOREIGN_CALL: Readonly<Record<string, ToolCall>> = { Edit: EDIT_CALL, Write: WRITE_CALL };

describe('file dialog title over a header path on two rows, footer marker gone: no button, no digit', { timeout: 20_000 }, () => {
  it.each(WRAPPED_HEADER)('$label: the screen is no confirmation and has no form', ({ capture }) => {
    expect(capture.screen).toContain(`\n ${LONG_DIR.slice(0, 56)}\n`);
    expect(parseOptions(capture.screen)).toMatchObject({ kind: 'other', question: null });
  });

  const rows = WRAPPED_HEADER.flatMap((dialog) => (['own', 'foreign'] as const).flatMap((call) => ROWS
    .map((row) => ({ ...dialog, ...row, call }))));
  it.each(rows)('$label — $call call, source $source, mode $mode (layer 2: $layer2), signal $signal: 0 digits',
    async ({ capture, call, source, mode, layer2, signal }) => {
      const own = capture.call();
      const tool = call === 'own' ? own : FOREIGN_CALL[own.tool];
      if (tool === undefined) return expect.unreachable(`no foreign call for ${own.tool}`);
      await expectNoConsent(await cutCard(capture.screen, tool, source, mode, layer2, signal));
    });
});

/** Cross-check ekranu z wywołaniem zapisu pliku w katalogu sesji z fixture'ów (`/Users/u/projekt`, CLI 2.1.322). */
describe('dowód pliku i treści z ekranu (`resolveOptions`, `fileCall`)', () => {
  const PROJECT = '/Users/u/projekt';
  const write = (screen: string, filePath: string, content: string, cwd: string | null = PROJECT): string =>
    resolveOptions(screen, {
      toolName: 'Write', fileCall: { change: 'write', input: { file_path: filePath, content }, cwd },
    }).status;
  const LONG = measured('zgoda-write-dluga-linia-2.1.322.txt');
  const CREATED = `${PROJECT}/pomiar-dialogow-nowy.txt`;

  it('„Create file”: treść dosłownie, linia po linii; jedna nowa linia na końcu pliku i `\\r` przed nową linią (CRLF)'
    + ' nie liczą się', () => {
    expect(write(CREATE, CREATED, 'pomiar\n')).toBe('ok');
    expect(write(CREATE, CREATED, 'pomiar')).toBe('ok');
    expect(write(CREATE, CREATED, 'pomiar\r\n')).toBe('ok');
    expect(write(CREATE, CREATED, 'pomiar\n\n')).toBe('mismatch');
    expect(write(CREATE, CREATED, ' pomiar\n')).toBe('mismatch');
    expect(write(CREATE, CREATED, 'pom iar\n')).toBe('mismatch');
    expect(write(CREATE, CREATED, 'pomiar\tx\n')).toBe('mismatch');
  });

  it('„Create file”: biały znak na końcu linii treści to brak dowodu, bo ekran rysuje go pustą komórką', () => {
    for (const content of ['pomiar \n', 'pomiar  \r\n', 'pomiar\t\n', 'pomiar \n', 'pomiar ', 'pomiar\r', 'pomiar\r\r\n']) {
      expect(write(CREATE, CREATED, content), JSON.stringify(content)).toBe('mismatch');
    }
    const two = createWith('  1 pomiar\n  2 dalej\n');
    expect(write(two, CREATED, 'pomiar \ndalej\n')).toBe('mismatch');
    expect(write(two, CREATED, 'pomiar\t\ndalej\n')).toBe('mismatch');
    expect(write(two, CREATED, 'pomiar\r\ndalej\r\n')).toBe('ok');
  });

  it('wiersz ramki ze spacją na końcu dowodzi tylko treści bez niej: odczyt ekranu obcina prawy brzeg wiersza', () => {
    // Granica dowodu z ekranu: spacji na końcu linii nie odróżnia od pustej komórki ani terminal, ani odczyt.
    const shown = createWith('  1 pomiar \n');
    expect(write(shown, CREATED, 'pomiar\n')).toBe('ok');
    expect(write(shown, CREATED, 'pomiar \n')).toBe('mismatch');
  });

  it('„Create file”: numery od 1 bez luk; pusty wiersz i wiersz w położeniu kontynuacji to brak dowodu', () => {
    expect(write(createWith('  1 pomiar\n  2 dalej\n'), CREATED, 'pomiar\ndalej\n')).toBe('ok');
    expect(write(createWith('  2 pomiar\n'), CREATED, 'pomiar\n')).toBe('mismatch');
    expect(write(createWith('  1 pomiar\n  3 dalej\n'), CREATED, 'pomiar\ndalej\n')).toBe('mismatch');
    expect(write(createWith('  1 pomiar\n\n  2 dalej\n'), CREATED, 'pomiar\ndalej\n')).toBe('mismatch');
    // Kontynuacja linii 1 z treścią w kształcie linii 2: czytana jako linia 2 dałaby dwie linie zamiast jednej.
    expect(write(createWith('  1 pomiar\n     2 dalej\n'), CREATED, 'pomiar\ndalej\n')).toBe('mismatch');
  });

  it('"Create file" with a long wrapped line and no row exactly W wide (CLI 2.1.322): no witness, so no proof', () => {
    const line = Array(59).fill('pomiar').join('-');
    expect(write(LONG, `${PROJECT}/pomiar-linia.txt`, `${line}\n`)).toBe('mismatch');
    // The rows are two columns short of the formula W, so the frame does not prove its width for either call.
    expect(write(LONG, `${PROJECT}/pomiar-linia.txt`, `${line.slice(0, 120)} ${line.slice(120)}\n`)).toBe('mismatch');
  });

  it('„Overwrite file”: diff nie dowodzi całego pliku, więc brak dowodu także przy nowej stronie równej treści', () => {
    expect(write(OVERWRITE, `${PROJECT}/istniejacy.txt`, 'linia A\nlinia B\n')).toBe('mismatch');
    expect(write(OVERWRITE, `${PROJECT}/istniejacy.txt`, 'linia A\n')).toBe('mismatch');
  });

  it('ścieżka względna wobec katalogu sesji: poza projektem z `..` przechodzi, bez katalogu nie', () => {
    const outside = measured('zgoda-write-poza-projektem-2.1.322.txt');
    expect(write(outside, '/Users/u/inny/nowy-poza.txt', 'poza\n')).toBe('ok');
    expect(write(outside, '/Users/u/inny/nowy-poza.txt', 'poza\n', null)).toBe('mismatch');
    expect(write(outside, '/Users/u/projekt/nowy-poza.txt', 'poza\n')).toBe('mismatch');
  });

  it('`Edit`: inny plik w tym samym katalogu to rozjazd, ta edycja tego pliku przechodzi', () => {
    const edit = (filePath: string): string => resolveOptions(EDIT_WHOLE, {
      toolName: 'Edit',
      fileCall: {
        change: 'edit', input: { file_path: filePath, old_string: 'stara wartosc', new_string: 'nowa wartosc' },
        cwd: PROJECT,
      },
    }).status;
    expect(edit(`${PROJECT}/pomiar-dialogow.txt`)).toBe('ok');
    expect(edit(`${PROJECT}/inny.txt`)).toBe('mismatch');
  });
});

/*
 * Koszt porównania liniowy (karta 0d). Wpis jsonl i zrzut hooka to wejście z zewnątrz bez limitu długości, a wyrażenie
 * z wyprzedzeniem albo `\s+$` cofa się przy każdej pozycji długiej serii spacji przed zwykłym znakiem (n = 40000 to
 * sekundy synchronicznie na wątku serwera). Test mierzy czas, bo liczby kroków silnika wyrażeń nie widać z zewnątrz;
 * najkrótszy z trzech przebiegów pod 50 ms oddziela koszt liniowy (ułamek ms) od kwadratowego (sekundy) z zapasem
 * ponad 30× także na obciążonej maszynie, gdzie wydłuża się pojedynczy przebieg.
 */
describe('porównanie z ekranem liniowe: długa seria spacji przed zwykłym znakiem', { timeout: 60_000 }, () => {
  const PROJECT = '/Users/u/projekt';
  const SPACES = `${' '.repeat(40_000)}x`;
  const createOp = parseOptions(CREATE)?.operation ?? null;
  const editOp = parseOptions(EDIT_WHOLE)?.operation ?? null;
  const editIn = (input: Record<string, unknown>): FileCall => ({
    change: 'edit', cwd: PROJECT,
    input: { file_path: `${PROJECT}/pomiar-dialogow.txt`, old_string: 'stara wartosc', new_string: 'nowa wartosc', ...input },
  });
  const fastestMs = (run: () => unknown): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it('ramki z pomiaru czytają się (inaczej test mierzyłby wczesne `false`)', () => {
    expect(createOp).not.toBeNull();
    expect(editOp).not.toBeNull();
    expect(fileCallShown(editIn({}), editOp)).toBe(true);
  });

  it.each([
    ['`content` zapisu', () => fileCallShown({
      change: 'write', cwd: PROJECT, input: { file_path: `${PROJECT}/pomiar-dialogow-nowy.txt`, content: SPACES },
    }, createOp)],
    ['`old_string` edycji', () => fileCallShown(editIn({ old_string: SPACES }), editOp)],
    ['`new_string` edycji', () => fileCallShown(editIn({ new_string: SPACES }), editOp)],
    ['`old_string` z `replace_all`', () => fileCallShown(editIn({ old_string: SPACES, replace_all: true }), editOp)],
    ['`file_path` przy sprawdzeniu sprzeczności', () => editContradictsOperation({ file_path: `/${SPACES}` }, editOp)],
  ])('%s: n = 40000, wynik w < 50 ms', (_label, run) => {
    expect(fastestMs(run)).toBeLessThan(50);
  });
});
