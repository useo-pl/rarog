/**
 * Puls katalogu sesji (`herdr/session-pulse.ts`).
 *
 * Testy pracują na PRAWDZIWYCH plikach w katalogu tymczasowym, odtwarzając układ zmierzony
 * w `~/.claude/projects`: `subagents/workflows/wf_<id>/agent-<id>.jsonl`,
 * `workflows/scripts/<nazwa>-wf_<id>.js`, `tool-results/`. Atrapa `fs` nie odtworzyłaby tego,
 * o co tu chodzi: świadectwem życia jest `mtime`, a nie zdarzenie watchera.
 *
 * Zegar jest PRAWDZIWY (`mtime` też), więc czasy są skrócone do dziesiątek milisekund, a pliki
 * „stare" postarzamy `utimes`, zamiast czekać dziesięć sekund.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { createSessionPulse, listFiles, mergeScanPaths } from '../src/herdr/session-pulse.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';
const RUN = 'wf_a1b2c3d-e4f';

/** Okno świeżości musi być większe niż throttle, inaczej tick gubiłby własne zmiany. */
const TIMING = { throttleMs: 10, windowMs: 400, verifyMs: 10 };

let root = '';
const pulses: SessionPulse[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-pulse-'));
});

afterEach(async () => {
  for (const pulse of pulses.splice(0)) pulse.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Narzędzia
// ---------------------------------------------------------------------------

/** Katalog satelity sesji: `<slug>/<uuid>/`. */
const sessionDir = (session = SESSION): string => join(root, projectSlug(CWD), session);

/** Zakłada transkrypt sesji — bez niego `locateTranscript` nie ma czego znaleźć. */
async function seedTranscript(session = SESSION): Promise<void> {
  const dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${session}.jsonl`), '{}\n');
}

/** Plik w katalogu satelity (ścieżka względna, katalogi tworzone po drodze). */
async function seedFile(rel: string, session = SESSION): Promise<string> {
  const path = join(sessionDir(session), rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'x\n');
  return path;
}

/** Postarza plik o `ms` — „ten plik nie zmienił się od dawna". */
async function age(path: string, ms: number): Promise<void> {
  const at = new Date(Date.now() - ms);
  await utimes(path, at, at);
}

interface Fixture {
  pulse: SessionPulse;
  samples: PulseSample[];
}

const start = (
  opts: { watch?: boolean; session?: string; maxEntries?: number } = {},
): Fixture => {
  const samples: PulseSample[] = [];
  const pulse = createSessionPulse({
    cwd: CWD,
    agentSessionId: opts.session ?? SESSION,
    root,
    watch: opts.watch ?? false,
    timing: TIMING,
    ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
    onPulse: (sample) => samples.push(sample),
  });
  pulses.push(pulse);
  pulse.start();
  return { pulse, samples };
};

const waitFor = async (predicate: () => boolean, label = 'warunek'): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

/** Kilka pełnych ticków ciszy — tyle, żeby brak zdarzenia znaczył „nie ma", a nie „jeszcze nie". */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

// ---------------------------------------------------------------------------
// Co puls widzi
// ---------------------------------------------------------------------------

describe('puls katalogu sesji', () => {
  it('transkrypty agentów workflow dają liczbę agentów i nazwę przebiegu', async () => {
    await seedTranscript();
    await seedFile(`subagents/workflows/${RUN}/journal.jsonl`);
    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    await seedFile(`subagents/workflows/${RUN}/agent-a2.jsonl`);
    // Nazwa przebiegu jest w NAZWIE pliku skryptu — `workflows/wf_*.json` powstaje dopiero
    // po zakończeniu, a `journal.jsonl` nazwy nie niesie (zmierzone).
    await seedFile(`workflows/scripts/rarog-fala-1-${RUN}.js`);

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agents).toBe(2);
    expect(samples[0]?.workflowName).toBe('rarog-fala-1');
  });

  /*
   * Wgląd w workflow: journal przebiegu ma wpisy `started`/`result` —
   * liczba `result` mówi, ilu agentów SKOŃCZYŁO. Wynik agenta potrafi zawierać dowolny tekst,
   * ale w JSON-owym stringu cudzysłowy są escapowane, więc goły `"type":"result"` jest
   * jednoznaczny.
   */
  it('liczba wpisów `result` w journalu wchodzi jako agentsDone', async () => {
    await seedTranscript();
    const journal = join(sessionDir(SESSION), `subagents/workflows/${RUN}/journal.jsonl`);
    await mkdir(dirname(journal), { recursive: true });
    await writeFile(journal, [
      '{"type":"started","key":"a1","agentId":"a1"}',
      '{"type":"started","key":"a2","agentId":"a2"}',
      '{"type":"result","key":"a1","agentId":"a1","value":"tu może stać \\"type\\":\\"result\\" w treści"}',
      '{"type":"started","key":"a3","agentId":"a3"}',
      '{"type":"result","key":"a2","agentId":"a2","value":"ok"}',
      // Agent, który padł (zmierzone) — też już nie pracuje, więc liczy się jako skończony.
      '{"type":"started","key":"a4","agentId":"a4"}',
      '{"type":"failed","key":"a4","agentId":"a4"}',
      '',
    ].join('\n'));
    await seedFile(`subagents/workflows/${RUN}/agent-a3.jsonl`);

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agents).toBe(1);
    expect(samples[0]?.agentsDone).toBe(3);
    // Sam identyfikator przebiegu — po nim driver dokleja fazy z cache'u rozkładu.
    expect(samples[0]?.runId).toBe(RUN);
  });

  it('journal z samymi `started` daje agentsDone = 0 — zero z pliku jest faktem', async () => {
    await seedTranscript();
    const journal = join(sessionDir(SESSION), `subagents/workflows/${RUN}/journal.jsonl`);
    await mkdir(dirname(journal), { recursive: true });
    await writeFile(journal, '{"type":"started","key":"a1","agentId":"a1"}\n');
    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agents).toBe(1);
    expect(samples[0]?.agentsDone).toBe(0);
    expect(samples[0]?.runId).toBe(RUN);
  });

  it('subagent bez journala nie dostaje agentsDone (nie zmyślamy zera)', async () => {
    await seedTranscript();
    await seedFile('subagents/agent-solo.jsonl');
    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agentsDone).toBeUndefined();
    expect(samples[0]?.runId).toBeUndefined();
  });

  it('`agent-*.meta.json` to nie transkrypt — nie liczy się jako pracujący agent', async () => {
    await seedTranscript();
    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    await seedFile(`subagents/workflows/${RUN}/agent-a1.meta.json`);

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agents).toBe(1);
    expect(samples[0]?.other).toBe(1);
  });

  it('subagent poza workflow nie dostaje nazwy przebiegu (nie zgadujemy)', async () => {
    await seedTranscript();
    await seedFile('subagents/agent-a9.jsonl');

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.agents).toBe(1);
    expect(samples[0]?.workflowName).toBeUndefined();
  });

  it('sam wynik narzędzia to `other`, a nie agent', async () => {
    await seedTranscript();
    await seedFile('tool-results/b53x309hr.txt');

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]).toMatchObject({ agents: 0, other: 1 });
  });

  it('nazwy nie ma, gdy katalog skryptów jej nie potwierdza', async () => {
    await seedTranscript();
    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    await seedFile('workflows/scripts/rarog-inny-wf_zzz.js');

    const { samples } = start();
    await waitFor(() => samples.length > 0, 'puls');
    expect(samples[0]?.workflowName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sufit próbki
// ---------------------------------------------------------------------------

describe('sufit próbki', () => {
  /*
   * Katalog satelity długiej sesji ma setki wyników narzędzi, a sufit `maxEntries` musi wybrać
   * z nich te, które WŁAŚNIE urosły. Stosowany w kolejności `readdir`
   * wyciszałby puls dokładnie w najdłuższych sesjach z subagentami — czyli tam, gdzie wiersz
   * aktywności jest jedyną informacją, że coś się dzieje.
   */
  it('stare śmieci nie wypychają ze próbki świeżych transkryptów subagentów', async () => {
    await seedTranscript();
    for (let i = 0; i < 60; i += 1) {
      const path = await seedFile(`tool-results/stary-${String(i).padStart(3, '0')}.txt`);
      await age(path, 60_000);
    }
    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    await seedFile(`subagents/workflows/${RUN}/agent-a2.jsonl`);

    const { samples } = start({ maxEntries: 20 });
    await waitFor(() => samples.length > 0, 'puls mimo 60 starych plików');
    expect(samples[0]?.agents).toBe(2);
  });

  /*
   * Test na `listFiles` wprost, a nie przez `onPulse`: przez publiczne API wynik zależy od
   * kolejności `readdir` (APFS oddaje wpisy w kolejności hasza nazwy), więc taki test
   * sprawdzałby system plików, nie regułę. Tu reguła jest jedyną zmienną.
   */
  it('listing oddaje NAJŚWIEŻSZE wpisy, niezależnie od kolejności katalogu', async () => {
    await seedTranscript();
    /*
     * Stare i świeże w JEDNYM katalogu, a nazwy świeżych na KOŃCU alfabetu i na końcu
     * kolejności tworzenia: sufit stosowany w kolejności listingu wyrzuca je wtedy przy
     * każdym porządku, jaki system plików może oddać.
     */
    for (let i = 0; i < 6; i += 1) {
      const path = await seedFile(`tool-results/a-stary-${String(i)}.txt`);
      await age(path, 60_000 + i);
    }
    const swieze = ['tool-results/z-nowy-1.txt', 'tool-results/z-nowy-2.txt'];
    for (const rel of swieze) await seedFile(rel);

    const listed = await listFiles(sessionDir(), 2);
    expect(listed.map((path) => path.rel).sort())
      .toEqual(swieze.map((rel) => join(...rel.split('/'))));
  });

  /*
   * Listing statuje każdy oglądany plik, żeby wybrać najświeższe — i ten sam czas oddaje dalej.
   * Bez tego `#classify` statowałby drugi raz dokładnie to samo, czyli do 400
   * `stat` na tick w katalogu, w którym nic się nie zmieniło.
   */
  it('listing oddaje `mtime` razem ze ścieżką, żeby nikt nie statował drugi raz', async () => {
    await seedTranscript();
    const path = await seedFile('tool-results/wynik.txt');
    const mtime = (await stat(path)).mtimeMs;

    const listed = await listFiles(sessionDir(), 10);
    expect(listed).toEqual([{ rel: join('tool-results', 'wynik.txt'), mtime }]);
  });
});

describe('mergeScanPaths', () => {
  /** Listing zawsze niesie `mtime` — tu wartości są sztuczne, liczy się ich obecność. */
  const listing = (...rels: string[]): { rel: string; mtime: number }[] => rels
    .map((rel, i) => ({ rel, mtime: 1_000 - i }));

  /*
   * Reguła, której nie da się sprawdzić przez publiczne API: podpowiedzi watchera przychodzą
   * wyłącznie z `fs.watch({recursive:true})`, a ten w piaskownicy dostaje `EMFILE`.
   */
  it('podpowiedzi watchera przeżywają sufit, listing dobiera resztę', () => {
    const listed = listing('a.txt', 'b.txt', 'c.txt');
    const merged = mergeScanPaths(['subagents/agent-x.jsonl'], listed, 2);
    expect(merged.map((path) => path.rel)).toEqual(['subagents/agent-x.jsonl', 'a.txt']);
    // Podpowiedź przychodzi bez czasu — `#classify` dostatuje właśnie ją, i tylko ją.
    expect(merged[0]?.mtime).toBeUndefined();
    expect(merged[1]?.mtime).toBe(1_000);
  });

  it('bez podpowiedzi zostaje sam listing, przycięty do sufitu', () => {
    expect(mergeScanPaths([], listing('a.txt', 'b.txt', 'c.txt'), 2))
      .toEqual([{ rel: 'a.txt', mtime: 1_000 }, { rel: 'b.txt', mtime: 999 }]);
  });

  it('plik z listingu i z podpowiedzi liczy się raz — i zachowuje `mtime` z listingu', () => {
    expect(mergeScanPaths(['a.txt'], listing('a.txt', 'b.txt'), 5))
      .toEqual([{ rel: 'a.txt', mtime: 1_000 }, { rel: 'b.txt', mtime: 999 }]);
  });
});

// ---------------------------------------------------------------------------
// Uczciwość: cisza znaczy ciszę
// ---------------------------------------------------------------------------

describe('cisza', () => {
  it('stare pliki nie dają pulsu — puls nie udaje życia', async () => {
    await seedTranscript();
    const agent = await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    const result = await seedFile('tool-results/stary.txt');
    await age(agent, 60_000);
    await age(result, 60_000);

    const { samples } = start();
    await quiet();
    expect(samples).toEqual([]);
  });

  it('brak katalogu satelity = brak pulsu (sesja bez subagentów)', async () => {
    await seedTranscript();

    const { samples } = start();
    await quiet();
    expect(samples).toEqual([]);
  });

  it('brak transkryptu = brak pulsu (nie ma czego lokalizować)', async () => {
    const { samples } = start({ session: SESSION_B });
    await quiet();
    expect(samples).toEqual([]);
  });

  it('katalog satelity powstały PO starcie zostaje zauważony', async () => {
    await seedTranscript();
    const { samples } = start();
    await quiet();
    expect(samples).toEqual([]);

    await seedFile(`subagents/workflows/${RUN}/agent-a1.jsonl`);
    await waitFor(() => samples.length > 0, 'puls po powstaniu katalogu');
  });
});

// ---------------------------------------------------------------------------
// Cykl życia
// ---------------------------------------------------------------------------

describe('cykl życia', () => {
  it('stop() gasi obserwację, start() ją wznawia', async () => {
    await seedTranscript();
    await seedFile('subagents/agent-a1.jsonl');
    const { pulse, samples } = start();
    await waitFor(() => samples.length > 0, 'puls');

    pulse.stop();
    const after = samples.length;
    await quiet();
    expect(samples.length).toBe(after);

    pulse.start();
    await waitFor(() => samples.length > after, 'puls po wznowieniu');
  });

  it('close() kończy na dobre — start() po nim nic nie robi', async () => {
    await seedTranscript();
    await seedFile('subagents/agent-a1.jsonl');
    const { pulse, samples } = start();
    await waitFor(() => samples.length > 0, 'puls');

    pulse.close();
    const after = samples.length;
    pulse.start();
    await quiet();
    expect(samples.length).toBe(after);
  });

  /**
   * `EnterWorktree`: ta sama sesja silnika, ale jej pliki jadą `rename(2)`-em do slugu
   * worktree. Adres katalogu jest cache'owany raz (`#resolveDir`), więc bez sygnału `relocated`
   * puls skanuje katalog, którego już nie ma — i milknie po cichu, bo brak katalogu jest tu
   * normalnym stanem pracy.
   */
  it('relocated() zrzuca cache katalogu i puls wraca po przeprowadzce do worktree', async () => {
    const worktree = '/Users/u/Projects/atlas/.claude/worktrees/dialogi';
    await seedTranscript();
    await seedFile('subagents/agent-a1.jsonl');
    const { pulse, samples } = start();
    await waitFor(() => samples.length > 0, 'puls przed przeprowadzką');
    const before = samples.length;

    const dst = join(root, projectSlug(worktree));
    await mkdir(dst, { recursive: true });
    await rename(join(root, projectSlug(CWD), `${SESSION}.jsonl`), join(dst, `${SESSION}.jsonl`));
    await rename(sessionDir(), join(dst, SESSION));

    // Cache pokazuje katalog, którego nie ma: nowy plik w NOWYM miejscu nie daje pulsu.
    const moved = join(dst, SESSION, 'subagents', 'agent-a2.jsonl');
    await mkdir(dirname(moved), { recursive: true });
    await writeFile(moved, 'x\n');
    await quiet();
    expect(samples.length).toBe(before);

    pulse.relocated();
    await waitFor(() => samples.length > before, 'puls po relokacji');
  });

  it('repoint przenosi obserwację do katalogu NOWEJ sesji silnika', async () => {
    await seedTranscript();
    await seedTranscript(SESSION_B);
    await seedFile('subagents/agent-a1.jsonl');
    const { pulse, samples } = start();
    await waitFor(() => samples.length > 0, 'puls sesji A');

    pulse.repoint(SESSION_B);
    const after = samples.length;
    await quiet();
    // Katalog sesji B jeszcze nie istnieje — pliki sesji A nie mają prawa go zastąpić.
    expect(samples.length).toBe(after);

    await seedFile(`subagents/workflows/${RUN}/agent-b1.jsonl`, SESSION_B);
    await waitFor(() => samples.length > after, 'puls sesji B');
  });
});

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

describe('watcher rekurencyjny', () => {
  /*
   * Test jest jeden i celowo słaby w asercji: `fs.watch({recursive:true})` DZIAŁA na macOS
   * (zweryfikowane), ale w piaskownicy Claude Code ten sam kod dostaje `EMFILE` na zdarzeniu
   * `error`. Kontrakt, który musi być prawdziwy w OBU środowiskach, brzmi: puls dochodzi —
   * z watchera albo ze skanu, po cichu.
   */
  it('puls dochodzi także z włączonym watcherem (a po jego awarii ze skanu)', async () => {
    await seedTranscript();
    await seedFile('subagents/agent-a1.jsonl');

    const { samples } = start({ watch: true });
    await waitFor(() => samples.length > 0, 'puls z watcherem');

    const after = samples.length;
    await seedFile(`subagents/workflows/${RUN}/agent-a2.jsonl`);
    await waitFor(() => samples.length > after, 'kolejny puls');
    expect(samples[samples.length - 1]?.agents).toBeGreaterThanOrEqual(1);
  });
});
