/**
 * Przegląd pliku głównego rozmowy sprzed okna ogona (`herdr/background/main-scan.ts`)
 * i wspólne cięcie bajtów na linie (`herdr/background/jsonl-lines.ts`).
 *
 * Sedno: reduktor zadań w tle i lista artefaktów (drugie ujście) mają po przeglądzie i oknie stać
 * DOKŁADNIE tam, gdzie stałyby po przeczytaniu każdej linii pliku. Dwie rzeczy mogą to zepsuć po cichu: prefiltr, który pominie
 * linię zmieniającą listę, i granica przeglądu, która zgubi albo powtórzy linię na styku z oknem.
 * Pierwszej pilnuje test różnicowy (fixture'y z pomiaru i z incydentu, przeplecione szumem),
 * drugiej test, który stawia początek okna na KAŻDYM bajcie pliku.
 *
 * Pliki są prawdziwe, w katalogu tymczasowym (wzór: `herdr-agent-file.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCarry, resetCarry, takeLines } from '../src/herdr/background/jsonl-lines.ts';
import { createArtifactsTracker } from '../src/herdr/background/artifacts.ts';
import type { ArtifactsTracker } from '../src/herdr/background/artifacts.ts';
import {
  MAIN_SCAN_MAX_BYTES, mayCarryArtifact, mayCarryTask, scanMainFileBefore,
} from '../src/herdr/background/main-scan.ts';
import type { MainScanOptions, ScannedFile } from '../src/herdr/background/main-scan.ts';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import type { BackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import { parseJsonlEntry } from '../src/herdr/jsonl-pending.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-main-scan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Narzędzia
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, 'fixtures/herdr');

/** Linie pliku GŁÓWNEGO z fixture'u pomiaru (`_plik: glowny`), bez znaczników skryptu. */
function measuredMain(name: string): string[] {
  return readFileSync(join(FIXTURES, 'tasks/measured', name), 'utf8').split('\n')
    .filter((line) => line.includes('"_plik":"glowny"') && !line.includes('"_pomiar"'));
}

/** Wszystkie linie fixture'u, który sam jest wyciągiem z pliku głównego. */
function fixtureLines(path: string): string[] {
  return readFileSync(join(FIXTURES, path), 'utf8').split('\n').filter((line) => line !== '');
}

const ARTIFACT_URL = 'https://claude.ai/artifact/ArtefaktTestowyH000001';
const ARTIFACT_URL_B = 'https://claude.ai/artifact/ArtefaktTestowyB000002';
const watchNotice = (url: string): string => [
  '<task-notification>', '<task-type>artifact-watch-lifecycle</task-type>',
  '<summary>Stopped watching Artifact: "Raport" (artifact not found)</summary>',
  `<event>Watch on ${url} ended — no such artifact for this account.</event>`, '</task-notification>',
].join('\n');

/**
 * Artefakty w pliku głównym: publikacje, ponowna publikacja, meldunek o usunięciu z kolejki (nie wygasza)
 * i z notki harnessu (wygasza), adres w wyniku `Bash` i w prompcie (fałszywe „tak” prefiltra).
 */
function artifactLines(): string[] {
  const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 16, 9, 0, seconds)).toISOString();
  const result = (id: string, value: unknown, seconds: number): string => JSON.stringify({
    type: 'user', isSidechain: false, timestamp: at(seconds),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: value,
  });
  return [
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: at(1), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'ta1', name: 'Artifact', input: { file_path: '/x/raport.html' } }] } }),
    result('ta1', { url: ARTIFACT_URL, title: 'Raport', updated: false, artifact_id: 'x', path: '/x' }, 2),
    result('ta2', { url: ARTIFACT_URL_B, title: 'Deck', created_from_type: true, instructions: 'x' }, 3),
    result('tb1', { stdout: `opublikowane: ${ARTIFACT_URL_B}`, stderr: '' }, 4),
    JSON.stringify({ type: 'user', isSidechain: false, timestamp: at(5), message: { role: 'user', content: `zobacz ${ARTIFACT_URL}` } }),
    queued(watchNotice(ARTIFACT_URL_B), 6),
    result('ta3', { url: ARTIFACT_URL, title: 'Raport v2', updated: true }, 7),
    JSON.stringify({
      type: 'user', isSidechain: false, timestamp: at(8), origin: { kind: 'task-notification' },
      message: { role: 'user', content: watchNotice(ARTIFACT_URL_B) },
    }),
  ];
}

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 9, 20, 0, seconds)).toISOString();

const user = (text: string, seconds: number): string => JSON.stringify({
  type: 'user', isSidechain: false, timestamp: at(seconds), message: { role: 'user', content: text },
});

const assistantText = (text: string, seconds: number): string => JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: at(seconds),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const toolUse = (id: string, name: string, input: Record<string, unknown>, seconds: number): string => JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: at(seconds),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (
  id: string, result: Record<string, unknown> | undefined, seconds: number,
): string => JSON.stringify({
  type: 'user', isSidechain: false, timestamp: at(seconds),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  ...(result === undefined ? {} : { toolUseResult: result }),
});

const notification = (id: string, status: string, summary: string): string => [
  '<task-notification>', `<task-id>${id}</task-id>`, `<status>${status}</status>`, `<summary>${summary}</summary>`,
  '</task-notification>',
].join('\n');

const queued = (text: string, seconds: number): string => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: at(seconds), content: text,
});

/**
 * Szum: linie, których w prawdziwym pliku jest najwięcej i które listy zadań NIE zmieniają.
 * Część celowo NIESIE słowa prefiltra jako tekst (cytat w wyniku narzędzia, prompt człowieka),
 * żeby fałszywe „tak" też przeszło przez reduktor.
 */
function noise(n: number): string[] {
  return [
    toolUse(`toolu_read_${String(n)}`, 'Read', { file_path: `/Users/u/projekt/plik-${String(n)}.ts` }, 0),
    toolResult(`toolu_read_${String(n)}`, { type: 'text', file: { filePath: '/a.ts', content: 'x'.repeat(300) } }, 0),
    toolUse(`toolu_bash_${String(n)}`, 'Bash', { command: `ls ${String(n)}`, description: 'Lista' }, 0),
    toolResult(`toolu_bash_${String(n)}`, { stdout: 'wynik', stderr: '', interrupted: false }, 0),
    assistantText(`Zwykła wypowiedź ${String(n)}: agentId, backgroundTaskId i "tool_use" jako tekst.`, 0),
    user(`Prompt ${String(n)} z cytatem {"agentId":"a000"} i słowem resumedAgentId.`, 0),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: at(0), durationMs: n }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: `m${String(n)}`, snapshot: { trackedFileBackups: {} } }),
  ];
}

/** Oba ujścia przeglądu: reduktor zadań i lista artefaktów. */
interface Sinks {
  readonly tracker: BackgroundTasksTracker;
  readonly artifacts: ArtifactsTracker;
}

/** Co widać z obu ujść na zewnątrz; po tym porównujemy dwa sposoby karmienia. */
function publicState({ tracker, artifacts }: Sinks): unknown {
  return {
    tasks: tracker.tasks, unstartedEnds: tracker.unstartedEnds, firstEntryAt: tracker.firstEntryAt,
    unknownAgentNotes: tracker.unknownAgentNotes, artifacts: artifacts.artifacts,
  };
}

/** Wzorzec: oba ujścia dostały KAŻDĄ linię. */
function fedAll(lines: readonly string[]): Sinks {
  const sinks = { tracker: createBackgroundTasksTracker(), artifacts: createArtifactsTracker() };
  for (const line of lines) {
    const entry = parseJsonlEntry(line);
    sinks.tracker.note(entry);
    sinks.artifacts.note(entry);
  }
  return sinks;
}

async function writeLines(name: string, lines: readonly string[]): Promise<{ path: string; data: Buffer }> {
  const path = join(dir, name);
  const data = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
  await writeFile(path, data);
  return { path, data };
}

/**
 * To, co robi follower po przeglądzie: okno od bajtu `windowStart` wyrzuca pierwszą (uciętą) linię,
 * a resztę kompletnych linii podaje reduktorowi BEZ filtra.
 */
function feedWindow({ tracker, artifacts }: Sinks, data: Buffer, windowStart: number): void {
  const first = data.indexOf(0x0a, windowStart);
  let from = first === -1 ? data.length : first + 1;
  for (;;) {
    const end = data.indexOf(0x0a, from);
    if (end === -1) break;
    const entry = parseJsonlEntry(data.subarray(from, end).toString('utf8'));
    tracker.note(entry);
    artifacts.note(entry);
    from = end + 1;
  }
}

/**
 * Plik z pamięci dla testów, które robią tysiące przeglądów: te same bajty co na dysku, bez
 * wywołań systemu. Odczyt dysku pokrywają pozostałe testy.
 */
const memoryFile = (data: Buffer) => (): Promise<ScannedFile> => Promise.resolve({
  read: (buffer, offset, length, position) => Promise.resolve({
    bytesRead: data.copy(buffer, offset, position, Math.min(data.length, position + length)),
  }),
  close: () => Promise.resolve(),
});

async function scan(
  path: string, data: Buffer, windowStart: number, opts: Partial<MainScanOptions> = {},
): Promise<Sinks & { result: Awaited<ReturnType<typeof scanMainFileBefore>> }> {
  const tracker = createBackgroundTasksTracker();
  const artifacts = createArtifactsTracker();
  const result = await scanMainFileBefore({ path, windowStart, windowEnd: data.length, tracker, artifacts, ...opts });
  return { tracker, artifacts, result };
}

// ---------------------------------------------------------------------------
// Cięcie bajtów na linie
// ---------------------------------------------------------------------------

describe('takeLines: porcje bajtów → kompletne linie', () => {
  const text = (lines: readonly Buffer[]): string[] => lines.map((line) => line.toString('utf8'));

  it('linia ucięta między porcjami czeka w buforze, także w środku znaku UTF-8', () => {
    const data = Buffer.from('zażółć\ngęślą jaźń\nreszta', 'utf8');
    for (let cut = 1; cut < data.length; cut += 1) {
      const carry = emptyCarry();
      const lines = [
        ...text(takeLines(carry, data.subarray(0, cut), 1024)),
        ...text(takeLines(carry, data.subarray(cut), 1024)),
      ];
      expect(lines, `cięcie na bajcie ${String(cut)}`).toEqual(['zażółć', 'gęślą jaźń']);
      expect(carry.partial.toString('utf8')).toBe('reszta');
    }
  });

  it('linia dłuższa niż sufit jest pomijana w całości, a następna wraca normalnie', () => {
    const carry = emptyCarry();
    const long = 'x'.repeat(40);
    const lines = [
      ...text(takeLines(carry, Buffer.from(`a\n${long.slice(0, 25)}`), 16)),
      ...text(takeLines(carry, Buffer.from(`${long.slice(25)}\nb\n`), 16)),
    ];
    expect(lines).toEqual(['a', 'b']);
    expect(carry).toEqual({ partial: Buffer.alloc(0), dropping: false, dropped: 1 });
  });

  /** Kto chce twierdzić, że zna plik w całości, musi wiedzieć o każdej pominiętej linii. */
  it('`dropped` liczy pominięte kompletne linie i nie maleje po zwykłej linii', () => {
    const carry = emptyCarry();
    expect(text(takeLines(carry, Buffer.from(`a\n${'x'.repeat(40)}\n`), 16))).toEqual(['a']);
    expect(carry.dropped, 'za długa linia').toBe(1);
    expect(text(takeLines(carry, Buffer.from('b\n'), 16))).toEqual(['b']);
    expect(carry.dropped, 'zwykła linia po niej niczego nie cofa').toBe(1);

    // Linia ucięta przeskokiem też jest pominięta, a `resetCarry` zaczyna liczyć od zera.
    resetCarry(carry, true);
    expect(carry.dropped).toBe(0);
    expect(takeLines(carry, Buffer.from('ogon\n'), 16)).toEqual([]);
    expect(carry.dropped).toBe(1);
  });

  it('linia przekraczająca sufit dopiero w porcji ze swoim `\\n` też odpada', () => {
    const carry = emptyCarry();
    expect(takeLines(carry, Buffer.from('1234567890'), 16)).toEqual([]);
    expect(text(takeLines(carry, Buffer.from('1234567\nok\n'), 16))).toEqual(['ok']);
  });

  it('`resetCarry` z pomijaniem: pierwsza linia po przeskoku jest ucięta i odpada', () => {
    const carry = emptyCarry();
    takeLines(carry, Buffer.from('niedokończona'), 1024);
    resetCarry(carry, true);
    expect(text(takeLines(carry, Buffer.from('ogon uciętej linii\ncała\n'), 1024))).toEqual(['cała']);
  });
});

// ---------------------------------------------------------------------------
// Prefiltr
// ---------------------------------------------------------------------------

describe('mayCarryTask: która linia może zmienić listę zadań', () => {
  const pass = (line: string): boolean => mayCarryTask(Buffer.from(line, 'utf8'));

  it('przepuszcza każdą drogę, którą zna reduktor', () => {
    const carrying: [string, string][] = [
      ['wywołanie Bash', toolUse('t1', 'Bash', { command: 'sleep 9', run_in_background: true }, 1)],
      ['wywołanie Agent', toolUse('t2', 'Agent', { description: 'Przegląd' }, 1)],
      ['wywołanie Task', toolUse('t3', 'Task', { description: 'Przegląd' }, 1)],
      ['wywołanie Workflow', toolUse('t4', 'Workflow', { script: 'x' }, 1)],
      ['wywołanie Monitor', toolUse('t5', 'Monitor', { until: 'gotowe' }, 1)],
      ['wywołanie Skill', toolUse('t6', 'Skill', { skill: 'code-review' }, 1)],
      ['start komendy', toolResult('t1', { backgroundTaskId: 'b1' }, 2)],
      ['start subagenta', toolResult('t2', { agentId: 'a52b91f105b002e8d', status: 'async_launched' }, 2)],
      ['start workflow', toolResult('t4', { taskId: 'w1', taskType: 'local_workflow', runId: 'wf_1' }, 2)],
      ['wznowienie', toolResult('t7', { resumedAgentId: 'a52b91f105b002e8d', success: true }, 3)],
      ['TaskStop', toolResult('t8', { message: 'Successfully stopped task: b1', task_id: 'b1' }, 4)],
      ['TaskOutput', toolResult('t9', {
        retrieval_status: 'success', task: { task_id: 'b1', status: 'completed' },
      }, 4)],
      ['meldunek w kolejce', queued(notification('b1', 'completed', 'Background command "x" completed'), 5)],
      ['meldunek we wpisie user', user(notification('b1', 'completed', 'Background command "x" completed'), 5)],
      ['meldunek w załączniku', JSON.stringify({
        type: 'attachment', timestamp: at(5),
        attachment: {
          type: 'queued_command', prompt: notification('b1', 'killed', 'Background command "x" was stopped'),
        },
      })],
    ];
    for (const [what, line] of carrying) expect(pass(line), what).toBe(true);
  });

  it('nie przepuszcza tego, czego w pliku jest najwięcej', () => {
    const plain: [string, string][] = [
      ['wynik zwykłego narzędzia', toolResult('t1', { stdout: 'x'.repeat(500), stderr: '' }, 1)],
      ['wynik narzędzia bez `toolUseResult`', toolResult('t1', undefined, 1)],
      ['wywołanie Read', toolUse('t2', 'Read', { file_path: '/a.ts' }, 1)],
      ['wywołanie Write z treścią pliku', toolUse('t3', 'Write', {
        file_path: '/a.ts', content: 'x'.repeat(500),
      }, 1)],
      ['wypowiedź asystenta', assistantText('Zrobione.', 1)],
      ['prompt człowieka', user('Zrób przegląd.', 1)],
      ['koniec tury', JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(1) })],
    ];
    for (const [what, line] of plain) expect(pass(line), what).toBe(false);
  });

  /** Cytat w treści ma cudzysłów po ukośniku, więc nazwa pola w cudzysłowie go nie łapie. */
  it('słowo prefiltra zacytowane w TREŚCI nie jest polem wpisu', () => {
    expect(pass(assistantText('pole "agentId" i "backgroundTaskId" w wyniku', 1))).toBe(false);
    expect(pass(toolResult('t1', { stdout: '{"resumedAgentId":"a1","taskType":"x"}' }, 1))).toBe(false);
    // Wywołanie `Write`, którego treść cytuje nazwę narzędzia zadań: cudzysłów w treści też jest
    // po ukośniku.
    expect(pass(toolUse('t2', 'Write', { content: 'name: "Bash"' }, 1))).toBe(false);
  });

  it('fałszywe „tak” jest dozwolone: znacznik meldunku w prompcie człowieka przechodzi', () => {
    expect(pass(user('Co znaczy <task-notification> w logu?', 1))).toBe(true);
  });
});

describe('mayCarryArtifact: która linia może zmienić listę artefaktów', () => {
  const pass = (line: string): boolean => mayCarryArtifact(Buffer.from(line, 'utf8'));

  it('przepuszcza każdą linię z adresem artefaktu: wynik publikacji i meldunek o usunięciu', () => {
    for (const line of artifactLines()) {
      if (line.includes('claude.ai/artifact/')) expect(pass(line), line.slice(0, 80)).toBe(true);
    }
    expect(pass(user(watchNotice(ARTIFACT_URL), 1))).toBe(true);
  });

  it('nie przepuszcza linii bez adresu (także wywołania `Artifact` i zwykłych wyników)', () => {
    expect(pass(toolUse('t1', 'Artifact', { file_path: '/a.html' }, 1))).toBe(false);
    expect(pass(toolResult('t1', { stdout: 'x', stderr: '' }, 1))).toBe(false);
    expect(pass(assistantText('artefakt opublikowany', 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Przegląd: wynik taki sam jak przy każdej linii
// ---------------------------------------------------------------------------

describe('scanMainFileBefore: to samo, co dałaby każda linia pliku', () => {
  /** Fixture'y pliku głównego, każdy przepleciony szumem: po każdej linii osiem zwykłych wpisów. */
  const SOURCES: [string, string[]][] = [
    ['incydent 2.1.295', fixtureLines('tasks/incydent-postoj-agenta-2.1.295.jsonl')],
    ['pomiar postoj', measuredMain('postoj.jsonl')],
    ['pomiar wznowienie', measuredMain('wznowienie.jsonl')],
    ['pomiar resume-cli', measuredMain('resume-cli.jsonl')],
    ['pomiar taskoutput-w-postoju', measuredMain('taskoutput-w-postoju.jsonl')],
    ['transcript-sample', fixtureLines('transcript-sample.jsonl')],
    ['transcript-pending', fixtureLines('transcript-pending.jsonl')],
    ['artefakty syntetyczne', artifactLines()],
    ['pomiar artefaktów', [
      ...fixtureLines('artifacts/measured/publikacje.jsonl'), ...fixtureLines('artifacts/measured/meldunki.jsonl'),
    ]],
  ];
  const withNoise = (lines: readonly string[]): string[] =>
    lines.flatMap((line, n) => [...noise(n), line]);

  it('fixture\'y mają co sprawdzać: zadania, końce bez startu i linie odsiane przez prefiltr', () => {
    const all = SOURCES.flatMap(([, lines]) => withNoise(lines));
    const skipped = all.filter((line) => !mayCarryTask(Buffer.from(line, 'utf8')));
    expect(skipped.length).toBeGreaterThan(all.length / 2);
    const incident = fedAll(SOURCES[0]?.[1] ?? []).tracker;
    expect(incident.unstartedEnds.length).toBeGreaterThan(10);
    expect(fedAll(measuredMain('resume-cli.jsonl')).tracker.tasks).toHaveLength(1);
    // Lista artefaktów ma co porównywać: dwa artefakty (jeden wygaszony) i jeden z pomiaru.
    expect(fedAll(artifactLines()).artifacts.artifacts.map((item) => item.gone === true)).toEqual([false, true]);
    expect(fedAll(SOURCES.at(-1)?.[1] ?? []).artifacts.artifacts).toHaveLength(1);
  });

  it.each(SOURCES)('%s: przegląd całego pliku = każda linia', async (name, lines) => {
    const noisy = withNoise(lines);
    const { path, data } = await writeLines(`${name.replaceAll(' ', '-')}.jsonl`, noisy);
    const { result, ...sinks } = await scan(path, data, data.length - 1, { chunkBytes: 4096 });
    expect(result.outcome).toBe('done');
    expect(publicState(sinks)).toEqual(publicState(fedAll(noisy)));
  });

  /**
   * Przegląd z SAMYM ujściem artefaktów (po skróceniu pliku i przeskoku) daje tę samą listę co każda linia,
   * a zadań w tle nie parsuje: liczy tylko linie z adresem.
   */
  it.each(SOURCES)('%s: przegląd z samą listą artefaktów = każda linia', async (name, lines) => {
    const noisy = withNoise(lines);
    const { path, data } = await writeLines(`${name.replaceAll(' ', '-')}-a.jsonl`, noisy);
    const artifacts = createArtifactsTracker();
    const result = await scanMainFileBefore({ path, windowStart: data.length, windowEnd: data.length, artifacts, chunkBytes: 4096 });
    expect(result.outcome).toBe('done');
    expect(artifacts.artifacts).toEqual(fedAll(noisy).artifacts.artifacts);
    expect(result).toMatchObject({ parsed: noisy.filter((line) => line.includes('https://claude.ai/artifact/')).length });
  });

  /**
   * Początek okna na granicy KAŻDEJ linii i w jej środku: przegląd plus okno bez filtra ma dać ten
   * sam stan co wszystkie linie bez filtra. To jest dokładnie droga followera przy podpięciu.
   */
  it.each(SOURCES)('%s: przegląd + okno = każda linia, dla okna zaczętego przy różnych liniach', async (
    name, lines,
  ) => {
    const noisy = withNoise(lines);
    const { path, data } = await writeLines(`${name.replaceAll(' ', '-')}.jsonl`, noisy);
    const expected = publicState(fedAll(noisy));
    // Ostatnia linia szumu i linia fixture'u z każdej grupy: granica przed linią, w jej środku
    // i na jej `\n`. Przy długim fixture bierzemy równo rozłożoną próbkę 150 granic.
    const every: number[] = [];
    let from = 0;
    for (let n = 0; n < noisy.length; n += 1) {
      const length = Buffer.byteLength(noisy[n] ?? '', 'utf8');
      if (n % 9 >= 7) every.push(Math.max(1, from), from + Math.floor(length / 2), from + length);
      from += length + 1;
    }
    const step = Math.max(1, Math.floor(every.length / 150));
    const starts = every.filter((_, n) => n % step === 0);
    expect(starts.length).toBeGreaterThan(5);
    for (const windowStart of starts) {
      const { result, ...sinks } = await scan(path, data, windowStart, { chunkBytes: 1500, open: memoryFile(data) });
      expect(result.outcome, `okno od bajtu ${String(windowStart)}`).toBe('done');
      feedWindow(sinks, data, windowStart);
      expect(publicState(sinks), `okno od bajtu ${String(windowStart)}`).toEqual(expected);
    }
  });

  /**
   * Granica co do bajtu. Mały plik, początek okna na każdym bajcie, porcje po kilka bajtów: żadna
   * linia nie trafia do reduktora dwa razy i żadna nie ginie na styku przeglądu z oknem.
   */
  it('początek okna na KAŻDYM bajcie pliku, przy porcjach 1, 7 i 64 bajty', async () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'bez czasu' }),
      user('zażółć gęślą jaźń', 1),
      toolUse('t1', 'Agent', { description: 'Przegląd ąę', subagent_type: 'general-purpose' }, 2),
      toolResult('t1', { agentId: 'a52b91f105b002e8d', status: 'async_launched' }, 3),
      toolResult('t0', { stdout: 'zwykły wynik', stderr: '' }, 4),
      queued(notification('bwlasna1', 'completed', 'Background command "x" completed (exit code 0)'), 5),
      toolResult('t7', { resumedAgentId: 'a52b91f105b002e8d', success: true }, 6),
      toolResult('t8', { url: ARTIFACT_URL, title: 'Raport ąę', updated: false }, 7),
      JSON.stringify({
        type: 'user', isSidechain: false, timestamp: at(8), origin: { kind: 'task-notification' },
        message: { role: 'user', content: watchNotice(ARTIFACT_URL) },
      }),
      assistantText('koniec', 9),
    ];
    const { path, data } = await writeLines('granica.jsonl', lines);
    const expected = publicState(fedAll(lines));
    for (const chunkBytes of [1, 7, 64]) {
      for (let windowStart = 1; windowStart < data.length; windowStart += 1) {
        const { result, ...sinks } = await scan(path, data, windowStart, { chunkBytes, open: memoryFile(data) });
        expect(result.outcome).toBe('done');
        feedWindow(sinks, data, windowStart);
        expect(publicState(sinks), `porcja ${String(chunkBytes)}, okno od bajtu ${String(windowStart)}`)
          .toEqual(expected);
      }
    }
  });

  it('wynik mówi, ile przeczytał: do końca linii, w której zaczyna się okno, i ani bajtu dalej', async () => {
    const lines = [user('pierwsza', 1), user('druga', 2), user('trzecia', 3)];
    const { path, data } = await writeLines('zakres.jsonl', lines);
    const first = Buffer.byteLength(lines[0] ?? '', 'utf8') + 1;
    const second = first + Buffer.byteLength(lines[1] ?? '', 'utf8') + 1;
    // Okno od środka drugiej linii: przegląd bierze pierwszą i drugą.
    const middle = await scan(path, data, first + 5);
    expect(middle.result).toEqual({ outcome: 'done', bytes: second, lines: 2, parsed: 1 });
    // Okno dokładnie od początku drugiej linii: okno i tak ją wyrzuca, więc przegląd ją bierze.
    const edge = await scan(path, data, first);
    expect(edge.result).toEqual({ outcome: 'done', bytes: second, lines: 2, parsed: 1 });
    // Okno od `\n` pierwszej linii: przegląd kończy na tym `\n`.
    const newline = await scan(path, data, first - 1);
    expect(newline.result).toEqual({ outcome: 'done', bytes: first, lines: 1, parsed: 1 });
    // Okno równe końcowi linii bez dalszych bajtów (przegląd po skróceniu pliku): całe linie i nic więcej.
    const whole = await scanMainFileBefore({
      path, windowStart: second, windowEnd: second, artifacts: createArtifactsTracker(),
    });
    expect(whole).toEqual({ outcome: 'done', bytes: second, lines: 2, parsed: 0 });
  });
});

// ---------------------------------------------------------------------------
// `since`, sufity, awarie
// ---------------------------------------------------------------------------

describe('scanMainFileBefore: początek pliku, sufity i awarie', () => {
  /**
   * `since` po przeglądzie to czas PIERWSZEGO wpisu pliku, nie pierwszej linii, która przeszła
   * prefiltr: do pierwszego wpisu z czasem reduktor dostaje każdą linię.
   */
  it('`firstEntryAt` to czas pierwszego wpisu pliku, choć prefiltr by go odsiał', async () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'bez czasu' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} }),
      user('pierwszy prompt', 10),
      assistantText('odpowiedź', 20),
      toolUse('t1', 'Bash', { command: 'sleep 9', run_in_background: true }, 30),
      toolResult('t1', { backgroundTaskId: 'b1' }, 40),
      assistantText('ogon', 50),
    ];
    const { path, data } = await writeLines('since.jsonl', lines);
    const { tracker, result } = await scan(path, data, data.length - 1);
    expect(tracker.firstEntryAt).toBe(at(10));
    expect(tracker.tasks.map((task) => task.id)).toEqual(['b1']);
    // Trzy linie do pierwszego czasu, potem tylko dwie o zadaniu.
    expect(result).toMatchObject({ outcome: 'done', lines: 7, parsed: 5 });
  });

  it('okno od początku pliku nie zostawia nic do przeglądu', async () => {
    const { path, data } = await writeLines('caly.jsonl', [user('a', 1)]);
    const { tracker, result } = await scan(path, data, 0);
    expect(result).toEqual({ outcome: 'done', bytes: 0, lines: 0, parsed: 0 });
    expect(tracker.firstEntryAt).toBe('');
  });

  it('więcej bajtów przed oknem niż sufit: nic nie czyta i mówi `too-large`', async () => {
    let opened = 0;
    const { path, data } = await writeLines('duzy.jsonl', [user('a', 1), user('b', 2), user('c', 3)]);
    const { tracker, result } = await scan(path, data, data.length - 1, {
      maxBytes: data.length - 2,
      open: async (file) => { opened += 1; return open(file, 'r'); },
    });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(opened).toBe(0);
    expect(tracker.firstEntryAt).toBe('');
    // Równo z sufitem to jeszcze nie „za dużo”.
    const exact = await scan(path, data, data.length - 1, { maxBytes: data.length - 1 });
    expect(exact.result.outcome).toBe('done');
  });

  it('domyślny sufit: 1 GiB, z zapasem nad największym zmierzonym plikiem rozmowy (236 MiB)', () => {
    expect(MAIN_SCAN_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('linia dłuższa niż sufit linii jest pomijana, reszta pliku idzie normalnie', async () => {
    const lines = [
      user('start', 1),
      toolResult('t0', { stdout: 'A'.repeat(5000), backgroundTaskId: 'bzadluga' }, 2),
      toolUse('t1', 'Bash', { command: 'sleep 9', run_in_background: true }, 3),
      toolResult('t1', { backgroundTaskId: 'b1' }, 4),
      assistantText('ogon', 5),
    ];
    const { path, data } = await writeLines('dluga.jsonl', lines);
    const { tracker, result } = await scan(path, data, data.length - 1, { lineMaxBytes: 1000, chunkBytes: 256 });
    expect(result.outcome).toBe('done');
    expect(tracker.tasks.map((task) => task.id)).toEqual(['b1']);
  });

  it('wołający przestał czekać w trakcie: `stale`, bez dalszych odczytów', async () => {
    const { path, data } = await writeLines(
      'stale.jsonl', Array.from({ length: 50 }, (_, n) => user(`linia ${String(n)}`, n)),
    );
    let reads = 0;
    let closed = 0;
    const tapped = async (file: string): Promise<ScannedFile> => {
      const handle = await open(file, 'r');
      return {
        read: (buffer, offset, length, position) => {
          reads += 1;
          return handle.read(buffer, offset, length, position);
        },
        close: async () => { closed += 1; await handle.close(); },
      };
    };
    const { result } = await scan(path, data, data.length - 1, {
      chunkBytes: 64, open: tapped, stale: () => reads >= 3,
    });
    expect(result).toEqual({ outcome: 'stale' });
    expect(reads).toBe(3);
    expect(closed).toBe(1);
  });

  it('pliku nie ma, plik krótszy niż początek okna, błąd odczytu: `failed`, nigdy wyjątek', async () => {
    const missing = await scanMainFileBefore({
      path: join(dir, 'nie-ma.jsonl'), windowStart: 10, windowEnd: 20, tracker: createBackgroundTasksTracker(),
    });
    expect(missing.outcome).toBe('failed');

    const { path, data } = await writeLines('krotki.jsonl', [user('a', 1)]);
    const shorter = await scanMainFileBefore({
      path, windowStart: data.length + 100, windowEnd: data.length + 200, tracker: createBackgroundTasksTracker(),
    });
    expect(shorter).toEqual({ outcome: 'failed', reason: 'plik krótszy niż początek okna' });

    let closed = 0;
    const broken = await scanMainFileBefore({
      path, windowStart: 5, windowEnd: data.length, tracker: createBackgroundTasksTracker(),
      open: () => Promise.resolve({
        read: () => Promise.reject(new Error('EIO')),
        close: () => { closed += 1; return Promise.resolve(); },
      }),
    });
    expect(broken).toEqual({ outcome: 'failed', reason: 'EIO' });
    expect(closed).toBe(1);
  });

  it('plik bez `\\n` za początkiem okna: przegląd bierze kompletne linie i nie czeka na resztę', async () => {
    const complete = [user('a', 1), toolUse('t1', 'Bash', { command: 'x', run_in_background: true }, 2)];
    const path = join(dir, 'bez-konca.jsonl');
    const head = Buffer.from(complete.map((line) => `${line}\n`).join(''), 'utf8');
    const data = Buffer.concat([head, Buffer.from('{"type":"user","niedokończona', 'utf8')]);
    await writeFile(path, data);
    const { tracker, result } = await scan(path, data, head.length + 3);
    expect(result).toMatchObject({ outcome: 'done', lines: 2 });
    expect(tracker.firstEntryAt).toBe(at(1));
  });
});
