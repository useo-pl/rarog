/**
 * Lista artefaktów sesji w followerze transkryptu: `herdr/jsonl-follow.ts`, zdarzenie `artifacts`.
 *
 * Wypłata to zdarzenie followera `{type: 'artifacts', artifacts}`; drogę dalej (driver → manager → karta)
 * sprawdza `herdr-artifacts-integracja.test.ts`. Testy pilnują reguł z `docs/artifacts.md`:
 *
 * - pierwsza wypłata po podpięciu idzie zawsze, także pusta (nadpisuje listę poprzedniego followera),
 *   także gdy pliku rozmowy nie ma (pudło globu po uuid, identyfikator spoza wzorca);
 * - potem wyłącznie zmiana; `repoint` zaczyna od zera (pusta wychodzi, jeśli poprzednia pusta nie była);
 * - skrócenie pliku i przeskok: lista od zera plus przegląd pliku do miejsca, od którego follower czyta
 *   dalej; wynik zastępuje listę, fakty przeczytane w trakcie przeglądu idą na jego wynik, a do jego końca
 *   lista nie wychodzi;
 * - wynik przeglądu, który skończył się po `repoint`, idzie do kosza; plik znikający w trakcie przeglądu to
 *   `failed` z linią w logu, nie wyjątek.
 *
 * Pliki są prawdziwe, w katalogu tymczasowym, jak w `herdr-jsonl-follow.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import type { SessionArtifact } from '@rarog/shared';
import {
  ARTIFACTS_RESCAN_LOG, ARTIFACTS_RESCAN_SKIPPED_LOG, GAP_MESSAGE, TASKS_SCAN_SKIPPED_LOG, TRUNCATED_MESSAGE,
  createJsonlFollower,
} from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower, TasksScanOptions } from '../src/herdr/jsonl-follow.ts';

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
/** Okno ogona na 2 kB i pięć wiadomości: wszystko, co stoi przed wypełniaczem, jest PRZED oknem. */
const SMALL_WINDOW = { historyBytes: 2_048, historyMaxBytes: 2_048, historyMessages: 5 };

const URL_A = 'https://claude.ai/artifact/ArtefaktTestowyH000001';
const URL_B = 'https://claude.ai/artifact/ArtefaktTestowyB000002';
const URL_C = 'https://claude.ai/artifact/ArtefaktTestowyC000003';

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-artifacts-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const filePath = (session = SESSION): string => join(dir, `${session}.jsonl`);

/** Zapis atomowy (obok + `rename`): follower widzi albo brak pliku, albo całą treść. */
const createTranscript = async (path: string, content: string): Promise<void> => {
  await writeFile(`${path}.partial`, content);
  await rename(`${path}.partial`, path);
};

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 16, 10, minute, 0)).toISOString();

const line = (entry: Record<string, unknown>): string => `${JSON.stringify({ isSidechain: false, sessionId: SESSION, ...entry })}\n`;

const userText = (text: string, minute = 0): string =>
  line({ type: 'user', timestamp: at(minute), message: { role: 'user', content: text } });

/** Wynik publikacji artefaktu (kształt zmierzony): `toolUseResult` obok bloku `tool_result`. */
const published = (url: string, title: string, minute: number, updated = false): string => line({
  type: 'user', timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${String(minute)}`, content: 'ok' }] },
  toolUseResult: { url, title, updated, artifact_id: url.slice(-22), path: '/private/tmp/x/raport.html', version: 1 },
});

/** Notka harnessu o usunięciu artefaktu (osobna tura, wpis `user` z pochodzeniem). */
const gone = (url: string, minute: number): string => line({
  type: 'user', timestamp: at(minute), origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: '<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n'
      + '<summary>Stopped watching Artifact: "x" (artifact not found)</summary>\n'
      + `<event>Watch on ${url} ended — no such artifact for this account.</event>\n</task-notification>`,
  },
});

/** Wypełniacz: sześćdziesiąt zwykłych wypowiedzi, około 12 kB, bez adresów artefaktów. */
const padding = (): string => Array.from({ length: 60 }, (_, n) => line({
  type: 'assistant', timestamp: at(20),
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `wypowiedź ${String(n)} ${'x'.repeat(40)}` }] },
})).join('');

interface Started {
  readonly follower: JsonlFollower;
  readonly events: FollowEvent[];
  /** Kolejne wypłaty listy artefaktów (zdarzenia `artifacts`). */
  readonly payouts: (readonly SessionArtifact[])[];
  readonly logs: string[];
}

const start = (opts: Partial<Parameters<typeof createJsonlFollower>[0]> = {}): Started => {
  const payouts: (readonly SessionArtifact[])[] = [];
  const logs: string[] = [];
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING,
    logger: (message) => logs.push(message), ...opts,
  });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) {
      events.push(event);
      if (event.type === 'artifacts') payouts.push(event.artifacts);
    }
  })();
  return { follower, events, payouts, logs };
};

const waitFor = async (predicate: () => boolean, label = 'warunek'): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

/** Krótka cisza — dowód, że czegoś NIE ma (kilka ticków `stat` + okno batchowania). */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

const urls = (list: readonly SessionArtifact[] | undefined): string[] =>
  (list ?? []).map((item) => (item.gone === true ? `${item.url} (usunięty)` : item.url));

const texts = (events: readonly FollowEvent[]): string[] => events
  .flatMap((event) => (event.type === 'message' ? event.blocks : []))
  .flatMap((block) => (block.type === 'text' ? [block.text.text] : []));

/**
 * Przegląd wstrzymywany na żądanie: otwarcie pliku liczy się zawsze, a odczyt czeka, póki bramka jest
 * zamknięta. `fail` każe otwarciu rzucić, jak przy pliku, który zniknął.
 */
const gatedScan = (): {
  open: NonNullable<TasksScanOptions['open']>; hold: () => void; release: () => void; fail: (why: string) => void;
  opened: () => number;
} => {
  let gate: Promise<void> = Promise.resolve();
  let releaseGate: () => void = () => undefined;
  let failure: string | null = null;
  let opened = 0;
  return {
    open: async (path) => {
      opened += 1;
      if (failure !== null) throw new Error(failure);
      const handle = await open(path, 'r');
      return {
        read: async (buffer, offset, length, position) => {
          await gate;
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
    hold: () => { gate = new Promise((resolve) => { releaseGate = resolve; }); },
    release: () => { releaseGate(); },
    fail: (why) => { failure = why; },
    opened: () => opened,
  };
};

describe('artefakty sesji w followerze: wypłata po podpięciu', () => {
  it('pierwsza wypłata idzie zawsze, także PUSTA; potem cisza bez zmiany', async () => {
    await createTranscript(filePath(), userText('start'));
    const { events, payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    expect(payouts[0]).toEqual([]);
    await appendFile(filePath(), userText('dalej', 1));
    await waitFor(() => texts(events).includes('dalej'), 'wiadomość');
    await quiet();
    expect(payouts).toHaveLength(1);
  });

  /*
   * Follower bez pliku rozmowy (panel czeka na pierwszy prompt) wypłaca pustą listę; bez niej po wymianie
   * drivera odbiorca zostałby z listą poprzedniej rozmowy aż do powstania pliku.
   */
  it('bez pliku rozmowy: pusta pierwsza wypłata po pudle globu, a plik, który powstał, daje listę raz', async () => {
    const { payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata bez pliku');
    expect(payouts[0]).toEqual([]);
    // Kolejne pudła globu (tick co kilka ms) nie wypłacają nic.
    await quiet();
    expect(payouts).toHaveLength(1);
    await createTranscript(filePath(), userText('pierwszy prompt') + published(URL_A, 'Raport', 1));
    await waitFor(() => payouts.length === 2, 'lista z nowego pliku');
    await quiet();
    expect(payouts.map(urls)).toEqual([[], [URL_A]]);
  });

  it('bez pliku rozmowy i bez artefaktów w pliku, który powstał: jedna pusta wypłata, nic więcej', async () => {
    const { events, payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata bez pliku');
    await createTranscript(filePath(), userText('pierwszy prompt'));
    await waitFor(() => events.some((event) => event.type === 'history'), 'historia nowego pliku');
    await quiet();
    expect(payouts).toEqual([[]]);
  });

  it('identyfikator spoza wzorca (pliku nie będzie): pusta pierwsza wypłata od razu', async () => {
    // `ENGINE_SESSION_ID_PATTERN` odrzuca ukośnik i kropkę na początku (granica traversalu).
    const { payouts } = start({ agentSessionId: '../ucieczka' });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    await quiet();
    expect(payouts).toEqual([[]]);
  });

  it('publikacja sprzed okna jest w pierwszej wypłacie (przegląd, drugie ujście), usunięcie w oknie ją wygasza', async () => {
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + published(URL_B, 'Deck', 2)
      + padding() + gone(URL_A, 30));
    const { payouts } = start(SMALL_WINDOW);
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    await quiet();
    expect(payouts).toEqual([[
      { url: URL_B, title: 'Deck', publishedAt: at(2) },
      { url: URL_A, title: 'Raport', publishedAt: at(1), gone: true },
    ]]);
  });

  it('bez przeglądu (sufit zero) lista powstaje z samego okna, a log mówi o zadaniach i artefaktach', async () => {
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + padding() + published(URL_B, 'Deck', 30));
    const { payouts, logs } = start({ ...SMALL_WINDOW, tasksScan: { maxBytes: 0 } });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    expect(urls(payouts[0])).toEqual([URL_B]);
    expect(logs.some((log) => log.includes(TASKS_SCAN_SKIPPED_LOG) && log.includes('artifact'))).toBe(true);
  });

  it('na żywo: publikacja, ponowna publikacja i usunięcie dają wypłaty; ten sam stan nie daje nowej', async () => {
    await createTranscript(filePath(), userText('start'));
    const { payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    await appendFile(filePath(), published(URL_A, 'Raport', 1));
    await waitFor(() => payouts.length === 2, 'publikacja');
    await appendFile(filePath(), published(URL_B, 'Deck', 2));
    await waitFor(() => payouts.length === 3, 'druga publikacja');
    await appendFile(filePath(), gone(URL_A, 3));
    await waitFor(() => payouts.length === 4, 'usunięcie');
    // Drugi meldunek o tym samym usunięciu i adres w zwykłym prompcie listy nie zmieniają.
    await appendFile(filePath(), gone(URL_A, 4) + userText(`zobacz ${URL_C}`, 5));
    await quiet();
    expect(payouts.map(urls)).toEqual([
      [], [URL_A], [URL_B, URL_A], [URL_B, `${URL_A} (usunięty)`],
    ]);
    // Każda wypłata to nowa tablica z nowymi obiektami.
    expect(payouts[3]).not.toBe(payouts[2]);
    expect(payouts[3]?.[0]).not.toBe(payouts[2]?.[0]);
  });
});

describe('artefakty sesji w followerze: `repoint`', () => {
  it('lista idzie za plikiem: po `repoint` wychodzi lista nowej rozmowy, bez artefaktów starej', async () => {
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    await createTranscript(filePath(SESSION_B), userText('nowa') + published(URL_B, 'Deck', 2));
    const { follower, payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    follower.repoint(SESSION_B);
    await waitFor(() => urls(payouts.at(-1)).includes(URL_B), 'lista nowej rozmowy');
    await quiet();
    // Pusta lista z zerowania i lista nowego pliku mogą wyjść jedną wypłatą (ta sama partia), jak zadania.
    expect(payouts.slice(1).flatMap(urls)).not.toContain(URL_A);
    expect(payouts.at(-1)).toEqual([{ url: URL_B, title: 'Deck', publishedAt: at(2) }]);
  });

  it('`/clear` bez nowego pliku: pusta lista wychodzi od razu', async () => {
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    const { follower, payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    follower.repoint(SESSION_B);
    await waitFor(() => payouts.length === 2, 'pusta lista');
    await quiet();
    expect(payouts.map(urls)).toEqual([[URL_A], []]);
  });

  it('po pustej liście `repoint` nie daje drugiej pustej wypłaty; pusta nowa rozmowa też nie', async () => {
    await createTranscript(filePath(), userText('start'));
    await createTranscript(filePath(SESSION_B), userText('nowa'));
    const { follower, events, payouts } = start();
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    const histories = (): number => events.filter((event) => event.type === 'history').length;
    follower.repoint(SESSION_B);
    await waitFor(() => histories() === 2, 'historia nowej rozmowy');
    await quiet();
    expect(payouts).toEqual([[]]);
  });
});

describe('artefakty sesji w followerze: skrócenie pliku i przeskok', () => {
  it('skrócenie pliku: lista od zera i przegląd tego, co zostało; bez pustej wypłaty po drodze', async () => {
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + published(URL_B, 'Deck', 2)
      + padding());
    const { events, payouts } = start(SMALL_WINDOW);
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    expect(urls(payouts[0])).toEqual([URL_B, URL_A]);

    // Krótszy plik, podmieniony atomowo: zostaje tylko pierwsza publikacja, przed miejscem, od którego
    // follower czyta dalej — bez przeglądu nikt by jej już nie zobaczył.
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => payouts.length === 2, 'lista po przeglądzie');
    await appendFile(filePath(), published(URL_C, 'Nowy', 3));
    await waitFor(() => payouts.length === 3, 'publikacja po skróceniu');
    await quiet();
    expect(payouts.map(urls)).toEqual([[URL_B, URL_A], [URL_A], [URL_C, URL_A]]);
  });

  it('przeskok przyrostu: przegląd do miejsca ogona plus publikacja z ogona', async () => {
    const MAX = 2_000;
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    const { events, payouts, logs } = start({ maxReadBytes: MAX, tasksScan: { logBytes: 0 } });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    const big = line({
      type: 'user', timestamp: at(5),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: 'A'.repeat(MAX * 3) }] },
    });
    await appendFile(filePath(), published(URL_B, 'Deck', 2) + big + published(URL_C, 'Nowy', 6));
    await waitFor(() => texts(events).includes(GAP_MESSAGE.text), 'luka');
    await waitFor(() => payouts.length === 2, 'lista po luce');
    await quiet();
    // Publikacja z pominiętego kawałka wraca z przeglądu, ta z ogona z odczytu na żywo.
    expect(payouts.map(urls)).toEqual([[URL_A], [URL_C, URL_B, URL_A]]);
    expect(logs.filter((log) => log.includes(ARTIFACTS_RESCAN_LOG))).toHaveLength(1);
  });

  it('fakt przeczytany w trakcie przeglądu idzie na jego wynik; do końca przeglądu lista nie wychodzi', async () => {
    const scan = gatedScan();
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + published(URL_B, 'Deck', 2));
    const { events, payouts } = start({ tasksScan: { open: scan.open } });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');
    // Plik mieści się w oknie: przeglądu przy podpięciu nie było.
    expect(scan.opened()).toBe(0);

    scan.hold();
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => scan.opened() === 1, 'przegląd ruszył');
    // Publikacja w trakcie przeglądu; wiadomość za nią mówi, że follower ją już przeczytał.
    await appendFile(filePath(), published(URL_C, 'Nowy', 3) + userText('po publikacji', 4));
    await waitFor(() => texts(events).includes('po publikacji'), 'wpis przeczytany');
    await quiet();
    expect(payouts).toHaveLength(1);

    scan.release();
    await waitFor(() => payouts.length === 2, 'lista po przeglądzie');
    await quiet();
    expect(payouts.map(urls)).toEqual([[URL_B, URL_A], [URL_C, URL_A]]);
  });

  it('`repoint` w trakcie przeglądu: jego wynik idzie do kosza, wychodzi lista nowej rozmowy', async () => {
    const scan = gatedScan();
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + published(URL_B, 'Deck', 2));
    await createTranscript(filePath(SESSION_B), userText('nowa') + published(URL_C, 'Nowy', 3));
    const { follower, events, payouts } = start({ tasksScan: { open: scan.open } });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');

    scan.hold();
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => scan.opened() === 1, 'przegląd ruszył');
    follower.repoint(SESSION_B);
    await waitFor(() => urls(payouts.at(-1)).includes(URL_C), 'lista nowej rozmowy');
    scan.release();
    await quiet();
    // Po `repoint` żadna wypłata nie niesie artefaktu starej rozmowy.
    const afterRepoint = payouts.slice(1);
    expect(afterRepoint.flatMap(urls)).not.toContain(URL_A);
    expect(afterRepoint.at(-1)?.map((item) => item.url)).toEqual([URL_C]);
  });

  it('plik znika w trakcie przeglądu: `failed`, linia w logu, lista z samych nowych faktów, follower żyje', async () => {
    const scan = gatedScan();
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1) + published(URL_B, 'Deck', 2));
    const { events, payouts, logs } = start({ tasksScan: { open: scan.open } });
    await waitFor(() => payouts.length === 1, 'pierwsza wypłata');

    scan.fail('ENOENT: no such file or directory');
    await createTranscript(filePath(), userText('start') + published(URL_A, 'Raport', 1));
    await waitFor(() => texts(events).includes(TRUNCATED_MESSAGE.text), 'wiadomość o skróceniu');
    await waitFor(() => payouts.length === 2, 'lista po porażce przeglądu');
    expect(payouts[1]).toEqual([]);
    const skipped = logs.filter((log) => log.includes(ARTIFACTS_RESCAN_SKIPPED_LOG));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('ENOENT');
    expect(skipped[0]).toContain(SESSION);

    await appendFile(filePath(), published(URL_C, 'Nowy', 3));
    await waitFor(() => payouts.length === 3, 'publikacja po porażce');
    expect(urls(payouts[2])).toEqual([URL_C]);
  });
});
