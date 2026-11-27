/**
 * Czytnik pliku rozmowy subagenta (`herdr/background/agent-file.ts`) i to, co z jego faktów składa
 * `merge.ts`: wybudzenie agenta w postoju i jego własne komendy w tle.
 *
 * Testy pracują na PRAWDZIWYCH plikach w katalogu tymczasowym, w układzie magazynu CLI:
 * `<root>/<slug>/<sesja>.jsonl` i obok `<sesja>/subagents/agent-<id>.jsonl`. Kształty wpisów są
 * przepisane z `fixtures/herdr/tasks/measured/postoj.jsonl` (CLI 2.1.296).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentOwnTask, BackgroundTask, WorkflowRun } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import {
  AGENT_FILE_COST_LOG, MONITOR_MAX_MS, createAgentFileReader, mayCarryOwnCommand,
} from '../src/herdr/background/agent-file.ts';
import type {
  AgentFileFacts, AgentFileReader, AgentFileReaderOptions, OpenFile,
} from '../src/herdr/background/agent-file.ts';
import {
  DORMANT_AFTER_MS, OWN_TASKS_MAX, createTasksState, forgetSession, noteTasks,
} from '../src/herdr/background/merge.ts';
import type { TasksDeps, TasksState } from '../src/herdr/background/merge.ts';
import type { WorkflowRunReader } from '../src/herdr/background/workflow-run.ts';
import { TASK_COMMAND_MAX, createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import { createSatelliteDir } from '../src/herdr/background/satellite.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '0b9f1a52-6c1e-4b0e-9d59-3a7c2f4e8d11';
const AGENT = 'a52b91f105b002e8d';
/** Czas meldunku o postoju z incydentu; reszta czasów liczy się od niego. */
const STANDBY = '2026-10-09T21:51:18.194Z';
const after = (ms: number, iso = STANDBY): string => new Date(Date.parse(iso) + ms).toISOString();

let root = '';
let logs: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-agentfile-'));
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sessionDir = (session = SESSION): string => join(root, projectSlug(CWD), session);
const agentPath = (id = AGENT, session = SESSION): string => join(sessionDir(session), 'subagents', `agent-${id}.jsonl`);

/** Transkrypt sesji i jej katalog obok — bez pliku subagenta. */
async function seedSession(session = SESSION): Promise<void> {
  await mkdir(join(sessionDir(session), 'subagents'), { recursive: true });
  await writeFile(join(root, projectSlug(CWD), `${session}.jsonl`), '{}\n');
}

/** Wpis pliku subagenta: wypowiedź asystenta z czasem (kształt CLI 2.1.296, pola poza treścią). */
const said = (at: string, text = 'ok'): string => `${JSON.stringify({
  type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: at,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})}\n`;

/** Wybudzenie: wpis `user` z meldunkiem o końcu własnej komendy (`origin.kind: task-notification`). */
const wokenBy = (commandId: string, at: string): string => `${JSON.stringify({
  type: 'user', isSidechain: true, agentId: AGENT, timestamp: at, origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n'
      + `<task-id>${commandId}</task-id>\n<status>completed</status>\n`
      + '<summary>Background command "pomiar-sleep" completed (exit code 0)</summary>\n</task-notification>',
  },
})}\n`;

/**
 * Start własnej komendy w tle: wywołanie `Bash` (tu stoi TREŚĆ komendy) i 1 ms później jego wynik
 * z `backgroundTaskId`, sparowany po `tool_use_id` — dwie linie, jak w `postoj.jsonl`.
 */
const startedCommand = (commandId: string, command: string, at: string): string => `${JSON.stringify({
  type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: after(-1, at),
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_use', id: `toolu_${commandId}`, name: 'Bash',
      input: { run_in_background: true, command, description: 'pomiar-sleep' },
    }],
  },
})}\n${JSON.stringify({
  type: 'user', isSidechain: true, agentId: AGENT, timestamp: at,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${commandId}` }] },
  toolUseResult: { backgroundTaskId: commandId },
})}\n`;

/** Wynik `TaskStop` w pliku subagenta: trzecia droga końca własnej komendy (5 z 32 w incydencie). */
const stoppedCommand = (commandId: string, at: string): string => `${JSON.stringify({
  type: 'user', isSidechain: true, agentId: AGENT, timestamp: at,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_stop_${commandId}` }] },
  toolUseResult: { message: `Successfully stopped task: ${commandId} (sleep 40)`, task_id: commandId, task_type: 'local_bash' },
})}\n`;

/** Wywołanie narzędzia w pliku subagenta (kształt z pliku żywej sesji, CLI 2.1.296). */
const called = (name: string, input: Record<string, unknown>, at: string): string => `${JSON.stringify({
  type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: at,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${name}_${at}`, name, input }] },
})}\n`;

/**
 * Fakty pliku, w którym nie ma otwartej własnej komendy: czas ostatniego wpisu i dowód, że plik jest
 * znany do ostatniej linii (`settled`). `unsettled` to te same fakty bez dowodu: plik zerowany,
 * niedoczytany albo z końcem, którego czytnik nie zna.
 */
const seen = (lastEntryAt: string): AgentFileFacts => ({ lastEntryAt, commands: [], settled: {} });
const unsettled = (lastEntryAt: string): AgentFileFacts => ({ lastEntryAt, commands: [] });

function reader(opts: Partial<AgentFileReaderOptions> = {}): AgentFileReader {
  return createAgentFileReader({
    cwd: CWD, agentSessionId: SESSION, root, logger: (message) => { logs.push(message); }, ...opts,
  });
}

/**
 * Prawdziwy plik z zaczepami: `beforeRead` PRZED każdym odczytem zakresu (numer odczytu od 1,
 * wspólny dla wszystkich otwarć, oraz pozycja i długość) i `beforeStat` przed pytaniem o rozmiar.
 * Zaczep może rzucić albo zrobić coś „w trakcie”.
 */
function hookedOpen(hooks: {
  beforeRead?: (read: number, position: number, length: number) => void;
  beforeStat?: () => void;
}): OpenFile {
  let reads = 0;
  return async (path) => {
    const handle = await open(path, 'r');
    return {
      stat: () => {
        hooks.beforeStat?.();
        return handle.stat();
      },
      read: (buffer, offset, length, position) => {
        reads += 1;
        hooks.beforeRead?.(reads, position, length);
        return handle.read(buffer, offset, length, position);
      },
      close: () => handle.close(),
    };
  };
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

// ---------------------------------------------------------------------------
// Adres katalogu sesji
// ---------------------------------------------------------------------------

describe('createSatelliteDir: odczyt adresu rozpoczęty przed zmianą sesji', () => {
  /**
   * Wyścig: `resolve()` rozpoczęte PRZED `repoint()` może skończyć się po nim i zapisać katalog
   * poprzedniej sesji silnika. Każdy następny odczyt (przebiegów workflow i plików subagentów)
   * czytałby wtedy cudzy katalog aż do kolejnego `/clear`.
   */
  it('`repoint()` w trakcie `resolve()`: stary adres nie wraca i nie zostaje w pamięci', async () => {
    await seedSession(SESSION);
    await seedSession(SESSION_B);
    const satellite = createSatelliteDir({ root, cwd: CWD, agentSessionId: SESSION });

    const early = satellite.resolve();
    satellite.repoint(SESSION_B);
    expect(await early, 'wynik sprzed zmiany sesji opisuje poprzednią').toBeNull();
    expect(await satellite.resolve()).toBe(sessionDir(SESSION_B));
  });

  it('`relocated()` w trakcie `resolve()`: adres sprzed przeniesienia nie zostaje w pamięci', async () => {
    await seedSession(SESSION);
    const satellite = createSatelliteDir({ root, cwd: CWD, agentSessionId: SESSION });

    const early = satellite.resolve();
    satellite.relocated();
    expect(await early).toBeNull();
    expect(await satellite.resolve()).toBe(sessionDir(SESSION));
  });
});

// ---------------------------------------------------------------------------
// Czytnik: czas ostatniego wpisu
// ---------------------------------------------------------------------------

describe('createAgentFileReader: czas ostatniego wpisu', () => {
  it('bez katalogu sesji, bez pliku i dla id spoza wzorca odpowiada `null`', async () => {
    const files = reader();
    expect(await files.read(AGENT), 'brak transkryptu i katalogu').toBeNull();

    await seedSession();
    expect(await files.read(AGENT), 'katalog jest, pliku agenta nie ma').toBeNull();

    // Id z ukośnikiem czytałoby plik spoza katalogu sesji: odpada przed złożeniem ścieżki.
    await writeFile(join(sessionDir(), 'agent-x.jsonl'), said(STANDBY));
    expect(await files.read('../agent-x')).toBeNull();
    expect(await files.read('')).toBeNull();
  });

  it('oddaje czas ostatniego wpisu i doczytuje SAM przyrost', async () => {
    await seedSession();
    const head = said(after(-2000)) + said(after(-1000));
    await writeFile(agentPath(), head);
    /** Zakresy pliku, o które czytnik poprosił: [pozycja, długość]. */
    const ranges: [number, number][] = [];
    const files = reader({ open: hookedOpen({ beforeRead: (_n, position, length) => { ranges.push([position, length]); } }) });
    expect(await files.read(AGENT)).toEqual(seen(after(-1000)));
    expect(ranges).toEqual([[0, Buffer.byteLength(head)]]);

    // Nic nie doszło: ten sam fakt i ani jednego odczytu treści.
    expect(await files.read(AGENT)).toEqual(seen(after(-1000)));
    expect(ranges).toHaveLength(1);

    const more = said(after(18));
    await appendFile(agentPath(), more);
    expect(await files.read(AGENT)).toEqual(seen(after(18)));
    expect(ranges.slice(1), 'drugi odczyt zaczyna tam, gdzie skończył pierwszy').toEqual(
      [[Buffer.byteLength(head), Buffer.byteLength(more)]],
    );
  });

  it('duży plik idzie porcjami, żadna nie przekracza sufitu porcji', async () => {
    await seedSession();
    const content = Array.from({ length: 12 }, (_unused, n) => said(after(n))).join('');
    await writeFile(agentPath(), content);
    const ranges: [number, number][] = [];
    const files = reader({
      chunkBytes: 256,
      open: hookedOpen({ beforeRead: (_n, position, length) => { ranges.push([position, length]); } }),
    });
    expect(await files.read(AGENT)).toEqual(seen(after(11)));

    const size = Buffer.byteLength(content);
    expect(ranges.length).toBe(Math.ceil(size / 256));
    expect(ranges.every(([, length]) => length <= 256)).toBe(true);
    // Porcje stykają się bez dziur i bez zakładek, od zera do końca pliku.
    expect(ranges.map(([position]) => position)).toEqual(ranges.map((_range, n) => n * 256));
    expect(ranges.reduce((sum, [, length]) => sum + length, 0)).toBe(size);
  });

  it('plik bez wpisu z czasem daje fakty bez czasu', async () => {
    await seedSession();
    await writeFile(agentPath(), '{"type":"summary","summary":"bez czasu"}\nnie json\n');
    expect(await reader().read(AGENT)).toEqual({ commands: [] });
  });

  /** Napis, który nie jest datą, „późniejszy” od każdej daty byłby tylko w porównaniu napisów. */
  it('`timestamp`, który nie jest datą, nie zostaje czasem ostatniego wpisu', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000)) + said('zzzz') + said(''));
    const files = reader();
    // Ostatnia linia nie dała czasu, więc końca pliku nie znamy: bez dowodu `settled`.
    expect(await files.read(AGENT)).toEqual(unsettled(after(-1000)));

    await appendFile(agentPath(), said(after(18)));
    expect(await files.read(AGENT)).toEqual(seen(after(18)));
  });

  it('linia w trakcie zapisu czeka w buforze na resztę', async () => {
    await seedSession();
    const line = said(after(18), 'wybudzenie');
    await writeFile(agentPath(), said(after(-1000)) + line.slice(0, 40));
    const files = reader();
    expect(await files.read(AGENT), 'niedokończona linia: końca pliku nie znamy').toEqual(unsettled(after(-1000)));

    await appendFile(agentPath(), line.slice(40));
    expect(await files.read(AGENT)).toEqual(seen(after(18)));
  });

  /**
   * Porcja kończy się tam, gdzie kończy się bufor, nie tam, gdzie kończy się linia albo znak.
   * Przy porcji 7 B każda linia jest cięta kilkanaście razy, także w środku „ż” (2 bajty)
   * i „🚀” (4 bajty).
   */
  it('porcja ucięta w środku linii i w środku znaku UTF-8 nie gubi wpisu', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000), 'zażółć gęślą jaźń 🚀') + said(after(18), 'żółw 🚀🚀'));
    expect(await reader({ chunkBytes: 7 }).read(AGENT)).toEqual(seen(after(18)));
  });

  /** Załącznik niesie czas PIERWSZEJ kopii meldunku, czyli wcześniejszy niż chwila zapisu. */
  it('załącznik na końcu pliku nie cofa czasu i nie zasłania wpisu przed nim', async () => {
    await seedSession();
    const attachment = `${JSON.stringify({
      type: 'attachment', isSidechain: true, timestamp: after(-5000),
      attachment: { type: 'queued_command', prompt: 'x' },
    })}\n`;
    await writeFile(agentPath(), said(after(-9000)) + said(after(18)) + attachment);
    // Załącznik nie ma własnego czasu, więc ostatniej linii pliku nie umiemy umieścić w czasie.
    expect(await reader().read(AGENT)).toEqual(unsettled(after(18)));
  });

  it('skrócenie pliku: czytanie rusza od nowego końca, a czas ostatniego wpisu się nie cofa', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-3000)) + said(after(-2000)) + said(after(18)));
    const files = reader();
    expect(await files.read(AGENT)).toEqual(seen(after(18)));

    await truncate(agentPath(), said(after(-3000)).length);
    expect(await files.read(AGENT)).toEqual(unsettled(after(18)));

    // Po skróceniu pliku nie znamy już w całości, i to na stałe.
    await appendFile(agentPath(), said(after(60_000)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(60_000)));
  });

  it('podmiana pliku na inny (nowy i-węzeł) nie jest czytana od starego miejsca', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-2000)) + said(after(18)));
    const files = reader();
    expect(await files.read(AGENT)).toEqual(seen(after(18)));

    // Dłuższy plik pod tą samą nazwą: stary offset wypada w środku jego pierwszej linii, a za nim
    // stoi cały wpis. Bez rozpoznania podmiany czytnik wziąłby ten wpis za przyrost starego pliku.
    const other = `${agentPath()}.nowy`;
    await writeFile(other, said(after(-9000), 'x'.repeat(400)) + said(after(50_000)));
    await rename(other, agentPath());
    expect(await files.read(AGENT), 'zawartość podmienionego pliku jest pomijana').toEqual(unsettled(after(18)));

    await appendFile(agentPath(), said(after(90_000)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(90_000)));
  });

  it('przeskok: przyrost ponad sufit czyta sam ogon, bez uciętej pierwszej linii', async () => {
    await seedSession();
    const head = Array.from({ length: 40 }, (_unused, n) => said(after(-100_000 + n))).join('');
    const tail = said(after(18), 'ogon');
    await writeFile(agentPath(), head + tail);
    // Sufit mniejszy niż plik i taki, żeby ogon zaczynał się w środku linii.
    const files = reader({ chunkBytes: 64, maxReadBytes: tail.length + 37 });
    expect(await files.read(AGENT)).toEqual(unsettled(after(18)));

    // Pominięty kawałek mógł nieść start komendy: pliku po przeskoku nie znamy w całości już nigdy.
    await appendFile(agentPath(), said(after(500)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(500)));
    expect(await files.read(AGENT), 'kolejny odczyt bez przyrostu niczego nie przywraca').toEqual(unsettled(after(500)));
  });

  it('linia dłuższa niż bufor jest pomijana, a wpisy po niej się liczą', async () => {
    await seedSession();
    const huge = said(after(-500), 'x'.repeat(2_000));
    await writeFile(agentPath(), said(after(-1000)) + huge + said(after(18)));
    const files = reader({ chunkBytes: 128, lineMaxBytes: 512 });
    // Pominięta linia to dziura w historii pliku: czas idzie dalej, ale dowodu `settled` już nie ma.
    expect(await files.read(AGENT)).toEqual(unsettled(after(18)));

    // Sama za długa linia na końcu: jej czasu nie znamy, poprzedni zostaje.
    await appendFile(agentPath(), said(after(900), 'y'.repeat(2_000)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(18)));
    // Zwykły wpis po niej dziury nie zasypuje.
    await appendFile(agentPath(), said(after(1_200)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(1_200)));
  });

  /**
   * Sufit dotyczy LINII, nie tylko bufora: linia, która przekracza go
   * dopiero w porcji ze swoim znakiem nowej linii, i linia mieszcząca się w jednej porcji też odpadają.
   */
  it('linia ponad sufit odpada także wtedy, gdy domyka się w tej samej porcji', async () => {
    await seedSession();
    // Ostatnia linia pliku ma dokładnie 600 B (bez `\n`). Czytnik bierze czas z OSTATNIEGO wpisu,
    // więc to od niej zależy wynik: pominięta zostawia czas wpisu przed nią.
    const overhead = Buffer.byteLength(said(after(900), '')) - 1;
    const long = said(after(900), 'x'.repeat(600 - overhead));
    expect(Buffer.byteLength(long) - 1).toBe(600);
    const short = said(after(18));
    await writeFile(agentPath(), short + long);

    // Porcja równa pierwszej linii + 500 B: bufor po niej trzyma 500 B (mieści się w suficie 512),
    // a sufit pęka dopiero w następnej porcji, tej z `\n`.
    const carried = reader({ chunkBytes: Buffer.byteLength(short) + 500, lineMaxBytes: 512 });
    expect(await carried.read(AGENT)).toEqual(unsettled(after(18)));
    // Porcja 4 kB: cała linia razem z `\n` w jednej porcji, bufor pusty.
    expect(await reader({ chunkBytes: 4096, lineMaxBytes: 512 }).read(AGENT)).toEqual(unsettled(after(18)));
    // Linia na styk sufitu przechodzi w obu układach.
    expect(await reader({ chunkBytes: 4096, lineMaxBytes: 600 }).read(AGENT)).toEqual(seen(after(900)));
    expect(await reader({ chunkBytes: Buffer.byteLength(short) + 500, lineMaxBytes: 600 }).read(AGENT))
      .toEqual(seen(after(900)));
  });

  it('błąd odczytu w połowie: następny odczyt rusza od tego samego miejsca, z buforem linii', async () => {
    await seedSession();
    const first = said(after(-1000));
    await writeFile(agentPath(), first + said(after(18)));
    let failing = true;
    const positions: number[] = [];
    // Porcja 100 B: drugi odczyt domyka pierwszą linię i zostawia w buforze początek drugiej.
    expect(Buffer.byteLength(first)).toBeGreaterThan(100);
    expect(Buffer.byteLength(first)).toBeLessThan(200);
    const files = reader({
      chunkBytes: 100,
      open: hookedOpen({
        beforeRead: (read, position) => {
          if (failing && read === 3) throw new Error('EIO');
          positions.push(position);
        },
      }),
    });

    expect(await files.read(AGENT), 'wiemy to, co doszło przed błędem').toEqual(unsettled(after(-1000)));
    expect(positions).toEqual([0, 100]);
    failing = false;
    expect(await files.read(AGENT), 'druga linia sklejona z buforem sprzed błędu').toEqual(seen(after(18)));
    expect(positions.slice(2, 3), 'od bajtu, na którym stanął udany odczyt').toEqual([200]);
  });

  it('`repoint()` w trakcie czytania pliku: wynik przepada, a pamięć nowej sesji jest czysta', async () => {
    await seedSession(SESSION);
    await seedSession(SESSION_B);
    await writeFile(agentPath(AGENT, SESSION), said(after(-1000)) + said(after(18)));
    await writeFile(agentPath(AGENT, SESSION_B), said(after(-7000)));
    let repointed = false;
    const files: AgentFileReader = reader({
      chunkBytes: 100,
      open: hookedOpen({
        beforeRead: (read) => {
          if (read !== 2 || repointed) return;
          repointed = true;
          files.repoint(SESSION_B);
        },
      }),
    });

    expect(await files.read(AGENT)).toBeNull();
    // Gdyby stan starej sesji przeżył, nowy plik (inny i-węzeł) wyglądałby na podmieniony i byłby pominięty.
    expect(await files.read(AGENT)).toEqual(seen(after(-7000)));
  });

  /**
   * Najwęższe okno: plik starej sesji jest już otwarty, ale czytnik nie założył mu jeszcze stanu.
   * Stan założony PO `repoint()` trafiłby do pamięci nowej sesji pod tym samym id agenta.
   */
  it('`repoint()` między otwarciem pliku a pierwszym odczytem nie zostawia stanu starej sesji', async () => {
    await seedSession(SESSION);
    await seedSession(SESSION_B);
    await writeFile(agentPath(AGENT, SESSION), said(after(-1000)) + said(after(18)));
    await writeFile(agentPath(AGENT, SESSION_B), said(after(-7000)));
    let repointed = false;
    const files: AgentFileReader = reader({
      open: hookedOpen({
        beforeStat: () => {
          if (repointed) return;
          repointed = true;
          files.repoint(SESSION_B);
        },
      }),
    });

    expect(await files.read(AGENT)).toBeNull();
    expect(await files.read(AGENT)).toEqual(seen(after(-7000)));
  });

  it('`close()` w trakcie czytania pliku: wynik przepada', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000)) + said(after(18)));
    const files: AgentFileReader = reader({
      chunkBytes: 100,
      open: hookedOpen({ beforeRead: (read) => { if (read === 2) files.close(); } }),
    });
    expect(await files.read(AGENT)).toBeNull();
  });

  it('pierwsze podpięcie do pliku ponad próg zostawia JEDNĄ linię logu z rozmiarem i czasem', async () => {
    await seedSession();
    const content = Array.from({ length: 30 }, (_unused, n) => said(after(n), 'x'.repeat(100))).join('');
    await writeFile(agentPath(), content);
    await writeFile(agentPath('amaly'), said(after(1)));
    let clock = 1_000;
    const files = reader({ costLogBytes: 1_000, now: () => { clock += 7; return clock; } });

    await files.read(AGENT);
    await files.read('amaly');
    await appendFile(agentPath(), content);
    await files.read(AGENT);

    const lines = logs.filter((line) => line.includes(AGENT_FILE_COST_LOG));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`agent-${AGENT}.jsonl`);
    expect(lines[0]).toContain(`${String(Buffer.byteLength(content))} B`);
    expect(lines[0]).toMatch(/in \d+ ms$/);
  });

  it('`repoint()` w trakcie odczytu: wynik przepada, a nowa sesja czyta własny plik od zera', async () => {
    await seedSession(SESSION);
    await seedSession(SESSION_B);
    await writeFile(agentPath(AGENT, SESSION), said(after(18)));
    await writeFile(agentPath(AGENT, SESSION_B), said(after(-7000)));
    const files = reader();

    const early = files.read(AGENT);
    files.repoint(SESSION_B);
    expect(await early).toBeNull();
    expect(await files.read(AGENT)).toEqual(seen(after(-7000)));
  });

  it('`relocated()`: plik przeniesiony razem z katalogiem czyta się dalej od tego samego miejsca', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000)));
    const files = reader();
    expect(await files.read(AGENT)).toEqual(seen(after(-1000)));

    // `EnterWorktree`: transkrypt i katalog obok jadą `rename(2)`-em do innego slugu.
    const moved = join(root, projectSlug('/Users/u/Projects/atlas/.claude/worktrees/x'));
    await mkdir(moved, { recursive: true });
    await rename(join(root, projectSlug(CWD), `${SESSION}.jsonl`), join(moved, `${SESSION}.jsonl`));
    await rename(sessionDir(), join(moved, SESSION));
    expect(await files.read(AGENT), 'stary adres: pliku już nie ma').toBeNull();

    files.relocated();
    await appendFile(join(moved, SESSION, 'subagents', `agent-${AGENT}.jsonl`), said(after(18)));
    expect(await files.read(AGENT)).toEqual(seen(after(18)));
  });

  it('po `close()` niczego nie czyta', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const files = reader();
    files.close();
    expect(await files.read(AGENT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Czytnik: własne komendy subagenta
// ---------------------------------------------------------------------------

describe('createAgentFileReader: własne komendy subagenta', () => {
  it('komenda dostaje treść z wywołania i czas z wyniku startu', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-9000)) + startedCommand('b00000001', 'sleep 40', after(-5000)));
    expect(await reader().read(AGENT)).toEqual({
      lastEntryAt: after(-5000),
      commands: [{ id: 'b00000001', command: 'sleep 40', startedAt: after(-5000) }],
      settled: {},
    });
  });

  it('treść komendy jest przycięta tak samo jak `command` zadania', async () => {
    await seedSession();
    const long = `until grep -qE "TEST|ios-only" ${'x'.repeat(TASK_COMMAND_MAX + 400)}; do sleep 5; done`;
    await writeFile(agentPath(), startedCommand('bjvzo6rnl', long, after(-5000)));
    const facts = await reader().read(AGENT);
    expect(facts?.commands[0]?.command).toBe(long.slice(0, TASK_COMMAND_MAX));
    expect(facts?.commands[0]?.command).toHaveLength(TASK_COMMAND_MAX);
  });

  it('koniec z pliku subagenta zamyka komendę: meldunek o wybudzeniu i wynik `TaskStop`', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000))
      + startedCommand('b00000002', 'sleep 60', after(-4000)) + startedCommand('b00000003', 'sleep 80', after(-3000)));
    const files = reader();
    expect((await files.read(AGENT))?.commands.map((command) => command.id))
      .toEqual(['b00000001', 'b00000002', 'b00000003']);

    await appendFile(agentPath(), wokenBy('b00000001', after(18)));
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['b00000002', 'b00000003']);

    await appendFile(agentPath(), stoppedCommand('b00000003', after(500)));
    expect(await files.read(AGENT)).toEqual({
      lastEntryAt: after(500),
      commands: [{ id: 'b00000002', command: 'sleep 60', startedAt: after(-4000) }],
      settled: {},
    });
  });

  /**
   * Koniec, który stoi tylko w kolejce pliku GŁÓWNEGO, czytnik dostaje przy odczycie (`ended`)
   * i zamyka nim komendę u siebie na stałe. Bez tego taka komenda stałaby w jego liście do końca
   * życia agenta, a lista i każda jej kopia rosłyby bez końca.
   */
  it('koniec znany z pliku głównego (`ended`) zamyka komendę w czytniku na stałe', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000))
      + startedCommand('b00000002', 'sleep 60', after(-4000)));
    const files = reader();
    const ids = async (ended?: ReadonlySet<string>): Promise<string[] | undefined> =>
      (await files.read(AGENT, ended))?.commands.map((command) => command.id);

    expect(await ids(new Set(['b00000001', 'bcudza']))).toEqual(['b00000002']);
    // Na stałe: następny odczyt, już bez tego id, jej nie przywraca.
    expect(await ids()).toEqual(['b00000002']);
    expect(await ids(new Set())).toEqual(['b00000002']);

    // Koniec podany razem z odczytem, który dopiero przynosi start: komenda nie pojawia się wcale.
    await appendFile(agentPath(), startedCommand('b00000003', 'sleep 1', after(-3000)));
    expect(await ids(new Set(['b00000003']))).toEqual(['b00000002']);
    expect(await ids()).toEqual(['b00000002']);
  });

  it('długo żyjący agent: komendy zamykane tylko przez `ended` nie zbierają się w liście czytnika', async () => {
    await seedSession();
    const total = 300;
    const id = (n: number): string => `b${String(n).padStart(8, '0')}`;
    await writeFile(agentPath(), Array.from({ length: total }, (_unused, n) =>
      startedCommand(id(n), `sleep ${String(n)}`, after(-900_000 + n * 1000))).join(''));
    const files = reader();

    const ended = new Set(Array.from({ length: total - 2 }, (_unused, n) => id(n)));
    expect((await files.read(AGENT, ended))?.commands.map((command) => command.id)).toEqual([id(298), id(299)]);
    // Czytnik nie trzyma zamkniętych: bez zbioru oddaje te same dwie, nie trzysta.
    expect((await files.read(AGENT))?.commands).toHaveLength(2);
  });

  /**
   * TEST OBOWIĄZKOWY. Przy porcji 7 B wywołanie i wynik są cięte w dziesiątkach miejsc, także
   * w środku „ż” (2 bajty) i „🚀” (4 bajty). Dekodowanie porcji zamiast całej linii wstawiłoby
   * w treść komendy znaki zastępcze.
   */
  it('porcja ucięta w środku linii i w środku znaku UTF-8 nie psuje treści komendy', async () => {
    await seedSession();
    const command = 'echo "zażółć gęślą jaźń 🚀" && sleep 40';
    const content = said(after(-9000), 'żółw 🚀') + startedCommand('b00000001', command, after(-5000));
    await writeFile(agentPath(), content);
    const ranges: number[] = [];
    const files = reader({
      chunkBytes: 7, open: hookedOpen({ beforeRead: (_n, _position, length) => { ranges.push(length); } }),
    });
    expect(await files.read(AGENT)).toEqual({
      lastEntryAt: after(-5000), commands: [{ id: 'b00000001', command, startedAt: after(-5000) }], settled: {},
    });
    expect(ranges.length).toBe(Math.ceil(Buffer.byteLength(content) / 7));
  });

  it('wywołanie i wynik w dwóch osobnych odczytach też się parują', async () => {
    await seedSession();
    const [call = '', result = ''] = startedCommand('b00000001', 'sleep 40', after(-5000)).split('\n');
    await writeFile(agentPath(), `${call}\n`);
    const files = reader();
    expect((await files.read(AGENT))?.commands).toEqual([]);

    await appendFile(agentPath(), `${result}\n`);
    expect((await files.read(AGENT))?.commands).toEqual([
      { id: 'b00000001', command: 'sleep 40', startedAt: after(-5000) },
    ]);
  });

  it('zagnieżdżony subagent i zwykła komenda na pierwszym planie własną komendą w tle nie są', async () => {
    await seedSession();
    const foreground = `${JSON.stringify({
      type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: after(-8001),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }] },
    })}\n${JSON.stringify({
      type: 'user', isSidechain: true, agentId: AGENT, timestamp: after(-8000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg' }] },
      toolUseResult: { stdout: 'a\nb', stderr: '', interrupted: false },
    })}\n`;
    const nested = `${JSON.stringify({
      type: 'user', isSidechain: true, agentId: AGENT, timestamp: after(-7000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_nested' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a7725f999e73158bc', description: 'zagnieżdżony' },
    })}\n`;
    await writeFile(agentPath(), foreground + nested + startedCommand('b00000001', 'sleep 40', after(-5000)));
    expect((await reader().read(AGENT))?.commands.map((command) => command.id)).toEqual(['b00000001']);
  });

  /**
   * Przeskok, skrócenie i podmiana ZERUJĄ reduktor agenta: pominięty kawałek mógł nieść koniec
   * komendy, więc komendy sprzed niego mają los nieznany i nie są pokazywane.
   */
  it('przeskok: komendy sprzed ogona znikają, komenda z ogona zostaje', async () => {
    await seedSession();
    const head = startedCommand('bstara', 'sleep 1000', after(-90_000))
      + Array.from({ length: 30 }, (_unused, n) => said(after(-80_000 + n))).join('');
    const tail = startedCommand('bnowa', 'sleep 40', after(-5000));
    await writeFile(agentPath(), head + tail);

    // Bez sufitu obie komendy są otwarte.
    expect((await reader().read(AGENT))?.commands.map((command) => command.id)).toEqual(['bstara', 'bnowa']);
    // Sufit mieści ogon z zapasem, który wypada w środku wcześniejszej linii.
    const files = reader({ chunkBytes: 64, maxReadBytes: Buffer.byteLength(tail) + 50 });
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bnowa']);
  });

  it('przeskok w trakcie życia czytnika zeruje listę komend, które znał', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('bstara', 'sleep 1000', after(-90_000)));
    const files = reader({ chunkBytes: 64, maxReadBytes: 2_000 });
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bstara']);

    const flood = Array.from({ length: 40 }, (_unused, n) => said(after(-80_000 + n), 'x'.repeat(60))).join('');
    expect(Buffer.byteLength(flood)).toBeGreaterThan(2_000);
    await appendFile(agentPath(), flood + startedCommand('bnowa', 'sleep 40', after(-5000)));
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bnowa']);
  });

  it('skrócenie pliku zeruje listę komend i nie czyta od zera tego, co zostało', async () => {
    await seedSession();
    const first = startedCommand('bstara', 'sleep 1000', after(-90_000));
    await writeFile(agentPath(), first + startedCommand('bdruga', 'sleep 2000', after(-80_000)));
    const files = reader();
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bstara', 'bdruga']);

    await truncate(agentPath(), Buffer.byteLength(first));
    expect((await files.read(AGENT))?.commands, 'start, który został w pliku, nie wraca').toEqual([]);

    await appendFile(agentPath(), startedCommand('bnowa', 'sleep 40', after(-5000)));
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bnowa']);
  });

  it('podmiana pliku zeruje listę komend', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('bstara', 'sleep 1000', after(-90_000)));
    const files = reader();
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bstara']);

    const other = `${agentPath()}.nowy`;
    await writeFile(other, said(after(-70_000), 'x'.repeat(900)) + startedCommand('bobca', 'sleep 5', after(-60_000)));
    await rename(other, agentPath());
    expect((await files.read(AGENT))?.commands).toEqual([]);

    await appendFile(agentPath(), startedCommand('bnowa', 'sleep 40', after(-5000)));
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['bnowa']);
  });
});

/**
 * Żeby uznać agenta w postoju za uśpionego, `merge.ts` musi wiedzieć, do kiedy agent
 * może mieć żywe własne zadanie INNE niż komenda. Kształt wywołania `Monitor` z pliku subagenta
 * żywej sesji (CLI 2.1.296): `{description, timeout_ms: 1800000, command}`.
 */
describe('createAgentFileReader: termin innych własnych zadań (`settled.otherWorkUntil`)', () => {
  const T0 = after(-600_000);

  it('plik bez monitora i zagnieżdżonych zadań: dowód bez terminu', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000)) + said(after(-1000)));
    expect((await reader().read(AGENT))?.settled).toEqual({});
  });

  it('`Monitor` trzyma do swojego terminu: czas wywołania + `timeout_ms`', async () => {
    await seedSession();
    await writeFile(agentPath(), called('Monitor', { description: 'log', timeout_ms: 120_000, command: 'tail -f x' }, T0)
      + said(after(-1000)));
    expect((await reader().read(AGENT))?.settled).toEqual({ otherWorkUntil: Date.parse(T0) + 120_000 });
  });

  it('`Monitor` bez czytelnego terminu albo ponad sufit narzędzia liczy się sufitem (30 minut)', async () => {
    for (const input of [{ description: 'log' }, { timeout_ms: 'długo' }, { timeout_ms: 0 }, { timeout_ms: 9e9 }]) {
      await seedSession();
      await writeFile(agentPath(), called('Monitor', input, T0) + said(after(-1000)));
      expect((await reader().read(AGENT))?.settled, JSON.stringify(input))
        .toEqual({ otherWorkUntil: Date.parse(T0) + MONITOR_MAX_MS });
    }
  });

  it('kilka monitorów: liczy się najpóźniejszy termin, także z późniejszego odczytu', async () => {
    await seedSession();
    await writeFile(agentPath(), called('Monitor', { timeout_ms: 600_000 }, T0) + said(after(-400_000)));
    const files = reader();
    expect((await files.read(AGENT))?.settled).toEqual({ otherWorkUntil: Date.parse(T0) + 600_000 });

    await appendFile(agentPath(), called('Monitor', { timeout_ms: 60_000 }, after(-300_000)) + said(after(-200_000)));
    expect((await files.read(AGENT))?.settled, 'krótszy monitor nie skraca terminu').toEqual({ otherWorkUntil: Date.parse(T0) + 600_000 });

    await appendFile(agentPath(), called('Monitor', { timeout_ms: 1_800_000 }, after(-100_000)) + said(after(-50_000)));
    expect((await files.read(AGENT))?.settled).toEqual({ otherWorkUntil: Date.parse(after(-100_000)) + 1_800_000 });
  });

  it.each(['Agent', 'Task', 'Workflow'])('wywołanie `%s` trzyma bez końca: losu takiego zadania plik nie mówi', async (name) => {
    await seedSession();
    await writeFile(agentPath(), called(name, { description: 'zagnieżdżone' }, T0) + said(after(-1000)));
    expect((await reader().read(AGENT))?.settled).toEqual({ otherWorkUntil: Infinity });
  });

  it('`Bash` i narzędzia bez zadań w tle terminu nie dają', async () => {
    await seedSession();
    await writeFile(agentPath(), called('Bash', { command: 'ls' }, T0) + called('Read', { file_path: '/x' }, after(-9000))
      + said(after(-1000)));
    expect((await reader().read(AGENT))?.settled).toEqual({});
  });

  /**
   * Pominięta linia mogła nieść start zadania. Późniejsza zwykła linia
   * nie ma prawa przywrócić dowodu, bo agent zniknąłby z listy przy żywym monitorze albo komendzie.
   */
  it('linia startu pominięta jako za długa: późniejszy wpis nie przywraca dowodu', async () => {
    await seedSession();
    const monitor = called('Monitor', { description: 'x'.repeat(2_000), timeout_ms: 1_800_000 }, T0);
    await writeFile(agentPath(), said(after(-700_000)) + monitor + said(after(-1000)));
    const files = reader({ chunkBytes: 128, lineMaxBytes: 512 });
    expect(await files.read(AGENT)).toEqual(unsettled(after(-1000)));
    await appendFile(agentPath(), called('SubagentHandback', { message: 'raport' }, after(-500)));
    expect((await files.read(AGENT))?.settled, 'kolejne zwykłe linie też nie').toBeUndefined();
  });

  it('linia, która mogła nieść start, a nie daje się sparsować, odbiera dowód na stałe', async () => {
    await seedSession();
    await writeFile(agentPath(), `${said(after(-9000))}{"type":"assistant","message":{"content":[{"type":"tool_use" ZEPSUTE\n${
      said(after(-1000))}`);
    const files = reader();
    expect(await files.read(AGENT)).toEqual(unsettled(after(-1000)));
    await appendFile(agentPath(), said(after(-500)));
    expect(await files.read(AGENT)).toEqual(unsettled(after(-500)));
  });

  it('odczyt, który nie doszedł do końca pliku (`bytesRead: 0`), nie daje dowodu', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-2000)) + said(after(-1000)));
    let short = true;
    const files = reader({
      chunkBytes: 64,
      open: async (path) => {
        const handle = await open(path, 'r');
        let reads = 0;
        return {
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) => {
            reads += 1;
            return short && reads > 1 ? Promise.resolve({ bytesRead: 0 }) : handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    });
    expect((await files.read(AGENT))?.settled, 'odczyt urwany przed końcem').toBeUndefined();
    short = false;
    expect(await files.read(AGENT)).toEqual(seen(after(-1000)));
  });
});

describe('mayCarryOwnCommand: prefiltr przed parsowaniem', () => {
  const carries = (line: string): boolean => mayCarryOwnCommand(Buffer.from(line, 'utf8'));

  it('przepuszcza wywołanie narzędzia, start, meldunek, `TaskStop` i `TaskOutput`', () => {
    const [call = '', result = ''] = startedCommand('b00000001', 'sleep 40', STANDBY).split('\n');
    expect(carries(call)).toBe(true);
    expect(carries(result)).toBe(true);
    expect(carries(wokenBy('b00000001', STANDBY))).toBe(true);
    expect(carries(stoppedCommand('b00000001', STANDBY))).toBe(true);
    expect(carries(JSON.stringify({ toolUseResult: { retrieval_status: 'success', task: { task_id: 'b1', status: 'completed' } } })))
      .toBe(true);
  });

  it('odrzuca to, czego w pliku subagenta jest najwięcej: tekst i wynik zwykłego narzędzia', () => {
    expect(carries(said(STANDBY, 'długi wywód'))).toBe(false);
    // Wynik zwykłej komendy ma `tool_use_id`, ale nie blok wywołania.
    expect(carries(JSON.stringify({
      type: 'user', isSidechain: true, agentId: AGENT, timestamp: STANDBY,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'a\nb' }] },
      toolUseResult: { stdout: 'a\nb', stderr: '', interrupted: false },
    }))).toBe(false);
    // Cytat wywołania w TREŚCI wyniku ma cudzysłowy poprzedzone ukośnikiem, więc igłą nie jest.
    expect(carries(JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{"type":"tool_use"}' }] },
    }))).toBe(false);
  });

  /**
   * Prefiltr nie ma prawa zgubić linii, na którą reduktor by zareagował. Dowód na zmierzonych
   * plikach subagentów (CLI 2.1.296): lista komend z linii po prefiltrze jest po każdej linii
   * taka sama jak z wszystkich linii.
   */
  it('na zmierzonych plikach subagentów daje tę samą listę komend co parsowanie wszystkiego', () => {
    const dir = join(import.meta.dirname, 'fixtures/herdr/tasks/measured');
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(3);
    let lines = 0;
    let skipped = 0;
    let opened = 0;
    for (const name of files) {
      const all = createBackgroundTasksTracker({ sidechain: true });
      const filtered = createBackgroundTasksTracker({ sidechain: true });
      const commands = (tracker: typeof all): string =>
        JSON.stringify(tracker.tasks.filter((task) => task.kind === 'command'));
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.includes('"_plik":"subagent:')) continue;
        lines += 1;
        all.note(JSON.parse(line));
        if (carries(line)) filtered.note(JSON.parse(line));
        else skipped += 1;
        expect(commands(filtered), `${name}: linia ${String(lines)}`).toBe(commands(all));
        opened = Math.max(opened, all.tasks.length);
      }
    }
    expect(lines, 'fixture’y mają linie plików subagentów').toBeGreaterThan(10);
    expect(skipped, 'prefiltr cokolwiek odrzuca').toBeGreaterThan(0);
    expect(opened, 'w fixture’ach jest choć jedna własna komenda').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// merge.ts: wybudzenie agenta w postoju
// ---------------------------------------------------------------------------

/** Agent tak, jak oddaje go reduktor pliku głównego. */
const agentTask = (waitingSince?: string): BackgroundTask => ({
  id: AGENT, kind: 'agent', description: 'Shared views of panel sections', startedAt: after(-680_000),
  ...(waitingSince === undefined ? {} : { waitingSince }),
});

interface Harness {
  state: TasksState;
  deps: TasksDeps;
  /** Każda lista wysłana w górę. */
  lists: BackgroundTask[][];
  /** Stan agenta w ostatniej wysłanej liście. */
  shown: () => string;
  /** Odpala zegar (jeden tick) i czeka na koniec odczytu. */
  tick: () => Promise<void>;
  /** Czeka, aż odczyt w locie się skończy. */
  settled: () => Promise<void>;
  timers: () => number;
  /** Zegar drivera (ms epoki); testy uśpienia przesuwają go same. */
  clock: { now: number };
}

function harness(agentReader: AgentFileReader | null, runReader: WorkflowRunReader | null = null): Harness {
  const state = createTasksState();
  const lists: BackgroundTask[][] = [];
  const pending: (() => void)[] = [];
  const clock = { now: 0 };
  const deps: TasksDeps = {
    reader: runReader,
    agentReader,
    scheduler: {
      setTimeout: (fn) => { pending.push(fn); return pending.length; },
      clearTimeout: () => undefined,
      now: () => clock.now,
    },
    pollMs: 5_000,
    disposed: () => false,
    emit: (tasks) => { lists.push([...tasks]); },
  };
  const settled = (): Promise<void> => waitFor(() => !state.polling, 'koniec odczytu');
  return {
    state, deps, lists, settled, clock,
    shown: () => {
      const task = lists.at(-1)?.find((item) => item.id === AGENT);
      if (task === undefined) return 'brak';
      return task.waitingSince === undefined ? 'pracuje' : `czeka od ${task.waitingSince}`;
    },
    tick: async () => {
      for (const fn of pending.splice(0)) fn();
      await settled();
    },
    timers: () => pending.length,
  };
}

describe('merge.ts: agent w postoju wraca do „pracuje” po wpisie w swoim pliku', () => {
  /**
   * TEST OBOWIĄZKOWY. Najkrótszy zmierzony odstęp między meldunkiem o postoju a pierwszym wpisem
   * po nim to 18 ms; potem agent potrafi milczeć godzinę (długa komenda na pierwszym planie).
   * Próg na `mtime` z marginesem przeoczyłby takie wybudzenie na zawsze; czas wpisu nie.
   */
  it('wybudzenie 18 ms po postoju z długą ciszą potem: agent jedzie w górę bez `waitingSince`', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000)));
    const h = harness(reader());

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    await appendFile(agentPath(), wokenBy('bjvzo6rnl', after(18)));
    await h.tick();
    expect(h.shown()).toBe('pracuje');
    expect(h.lists.at(-1)?.[0]).toEqual(agentTask());

    // Cisza: kolejne ticki czytają plik, ale niczego nie wysyłają.
    const sent = h.lists.length;
    await h.tick();
    await h.tick();
    expect(h.lists).toHaveLength(sent);
    expect(h.timers(), 'zegar chodzi, dopóki agent jest otwarty').toBe(1);
  });

  /**
   * Granica reguły: wpis musi być PÓŹNIEJSZY niż postój. Liczą się chwile, nie napisy: czas bez
   * milisekund jest jako napis „większy” od tego samego czasu z milisekundami.
   */
  it('wpis równy postojowi, wcześniejszy albo o nieczytelnym czasie nie zdejmuje `waitingSince`', async () => {
    const facts: { value: AgentFileFacts } = { value: { commands: [] } };
    const h = harness({
      read: async () => facts.value, repoint: () => undefined, relocated: () => undefined, close: () => undefined,
    });
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();

    for (const lastEntryAt of [STANDBY, after(-1), STANDBY.replace('.194Z', 'Z'), 'zzzz']) {
      facts.value = { lastEntryAt, commands: [] };
      await h.tick();
      expect(h.shown(), lastEntryAt).toBe(`czeka od ${STANDBY}`);
    }
    // Ta sama chwila co 18 ms po postoju, zapisana w innej strefie.
    facts.value = { lastEntryAt: after(18).replace('T21:51:18.212Z', 'T23:51:18.212+02:00'), commands: [] };
    await h.tick();
    expect(h.shown()).toBe('pracuje');
  });

  it('obiekt z followera nie zmienia się w miejscu: w górę jedzie kopia bez pola', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const h = harness(reader());
    const raw = agentTask(STANDBY);

    noteTasks(h.state, h.deps, { tasks: [raw] });
    await h.settled();
    expect(h.shown()).toBe('pracuje');
    expect(raw).toEqual(agentTask(STANDBY));
    expect(h.lists.at(-1)?.[0]).not.toBe(raw);
  });

  /** Follower wysyła listę przy każdej swojej zmianie; agent stoi na niej dalej z `waitingSince`. */
  it('re-emisja followera (ta sama para agent i postój) nie cofa „pracuje”', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    expect(h.shown()).toBe('pracuje');

    const woken = h.lists.length - 1;
    const command: BackgroundTask = { id: 'b1', kind: 'command', startedAt: after(5000) };
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY), command] });
    expect(h.shown(), 'od razu, bez czekania na odczyt').toBe('pracuje');
    await h.settled();
    expect(h.lists.at(-1)).toEqual([agentTask(), command]);
    // Od wybudzenia żadna lista nie pokazała agenta jako czekającego.
    expect(h.lists.slice(woken).map((list) => list.find((task) => task.id === AGENT)?.waitingSince))
      .toEqual([undefined, undefined]);
  });

  it('nowy postój gasi wybudzenie, a wpis po nim znów je zapala', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    expect(h.shown()).toBe('pracuje');

    const second = after(37_000);
    await appendFile(agentPath(), said(after(36_000)));
    noteTasks(h.state, h.deps, { tasks: [agentTask(second)] });
    expect(h.shown(), 'od razu po liście followera').toBe(`czeka od ${second}`);
    await h.settled();
    expect(h.shown(), 'wpis sprzed drugiego postoju go nie zdejmuje').toBe(`czeka od ${second}`);

    await appendFile(agentPath(), wokenBy('b00000002', after(18, second)));
    await h.tick();
    expect(h.shown()).toBe('pracuje');
  });

  it('wznowienie i koniec z followera wygrywają: agent bez `waitingSince` i agent spoza listy', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-1000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    noteTasks(h.state, h.deps, { tasks: [agentTask()] });
    expect(h.shown()).toBe('pracuje');
    await h.settled();

    noteTasks(h.state, h.deps, { tasks: [] });
    expect(h.shown()).toBe('brak');
    await h.settled();
    expect(h.state.agents.size, 'fakty zamkniętego agenta nie zostają w stanie').toBe(0);
    await h.tick();
    expect(h.timers(), 'bez otwartego agenta zegar staje').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// merge.ts: własne komendy subagenta na drucie (`ownTasks`)
// ---------------------------------------------------------------------------

describe('merge.ts: własne komendy subagenta jadą w `ownTasks`', () => {
  /** Początek okna pliku głównego: wcześniejszy niż wszystkie starty komend w tych testach. */
  const SINCE = after(-600_000);
  /** Własne komendy agenta w ostatniej wysłanej liście. */
  const own = (h: Harness): AgentOwnTask[] | undefined => h.lists.at(-1)?.find((task) => task.id === AGENT)?.ownTasks;
  const ids = (h: Harness): string[] => (own(h) ?? []).map((task) => task.id);

  /**
   * TEST OBOWIĄZKOWY (kryterium 6 planu). Agent w postoju pokazuje, NA CO czeka: komendę i od kiedy.
   * W incydencie były to trzy powłoki, których w Rarogu nie było widać wcale.
   */
  it('agent w postoju dostaje listę swoich otwartych komend: id, treść i czas startu', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('bjvzo6rnl', 'until grep -qE "TEST" log; do sleep 5; done', after(-300_000))
      + startedCommand('b00000002', 'until [ -f single2-summary.txt ]; do sleep 5; done', after(-200_000)));
    const h = harness(reader());

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();
    expect(h.lists.at(-1)).toEqual([{
      ...agentTask(STANDBY), ownCommandWait: 'short',
      ownTasks: [
        { id: 'bjvzo6rnl', command: 'until grep -qE "TEST" log; do sleep 5; done', startedAt: after(-300_000) },
        { id: 'b00000002', command: 'until [ -f single2-summary.txt ]; do sleep 5; done', startedAt: after(-200_000) },
      ],
    }]);

    // Ten sam stan przy kolejnych tickach nie daje kolejnych list.
    const sent = h.lists.length;
    await h.tick();
    await h.tick();
    expect(h.lists).toHaveLength(sent);
  });

  it('listę widać także pod agentem, który pracuje, i znika razem z ostatnią komendą', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask()], since: SINCE });
    await h.settled();
    expect(h.shown()).toBe('pracuje');
    expect(ids(h)).toEqual(['b00000001']);

    await appendFile(agentPath(), stoppedCommand('b00000001', after(18)));
    await h.tick();
    expect(h.lists.at(-1)).toEqual([agentTask()]);
    expect(h.lists.at(-1)?.[0]).not.toHaveProperty('ownTasks');
  });

  /**
   * Trzy źródła końca. W incydencie koniec 24 z 32 komend agenta stał w kolejce pliku głównego,
   * a 11 z nich WYŁĄCZNIE tam: plik subagenta takiej komendy nie zamknie nigdy.
   */
  it('koniec tylko w kolejce pliku głównego (`ended` z followera) zdejmuje komendę', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000))
      + startedCommand('b00000002', 'sleep 60', after(-4000)));
    const files = reader();
    const h = harness(files);
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();
    expect(ids(h)).toEqual(['b00000001', 'b00000002']);

    // Lista zadań followera ta sama, zmienił się tylko przyrost końców.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['b00000001'], since: SINCE });
    expect(ids(h), 'od razu, bez czekania na odczyt pliku').toEqual(['b00000002']);
    await h.settled();
    expect(ids(h)).toEqual(['b00000002']);
    // Odczyt po tym zdarzeniu podał koniec czytnikowi: komenda nie stoi już w jego liście.
    expect((await files.read(AGENT))?.commands.map((command) => command.id)).toEqual(['b00000002']);

    // Kolejne zdarzenie followera nie niesie już tamtego id, a komenda nie wraca.
    noteTasks(h.state, h.deps, { tasks: [agentTask(after(60_000))], since: SINCE });
    await h.settled();
    expect(ids(h)).toEqual(['b00000002']);
  });

  /**
   * Follower czyta plik główny od razu, a plik subagenta idzie w ticku 5 s, więc koniec krótkiej
   * komendy potrafi przyjść PRZED odczytaniem jej startu. Czeka w zbiorze na swoją komendę.
   */
  it('koniec, który przyszedł przed odczytaniem startu, zamyka komendę w chwili jej pojawienia się', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(-9000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask()], ended: ['bkrotka'], since: SINCE });
    await h.settled();

    await appendFile(agentPath(), startedCommand('bkrotka', 'sleep 1', after(-5000))
      + startedCommand('bdluga', 'sleep 400', after(-4000)));
    await h.tick();
    expect(ids(h)).toEqual(['bdluga']);
    expect(
      h.lists.some((list) => (list[0]?.ownTasks ?? []).some((task) => task.id === 'bkrotka')),
      'krótka komenda nie mignęła w żadnej liście',
    ).toBe(false);
  });

  it('koniec z pliku subagenta i koniec z pliku głównego naraz: komenda znika raz i nie wraca', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();
    expect(ids(h)).toEqual(['b00000001']);

    await appendFile(agentPath(), wokenBy('b00000001', after(18)));
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['b00000001'], since: SINCE });
    await h.settled();
    await h.tick();
    expect(h.lists.at(-1)).toEqual([agentTask()]);
  });

  it(`sufit: ponad ${String(OWN_TASKS_MAX)} komend jedzie ${String(OWN_TASKS_MAX)} najnowszych, w kolejności startu`, async () => {
    await seedSession();
    const total = OWN_TASKS_MAX + 5;
    const id = (n: number): string => `b${String(n).padStart(8, '0')}`;
    await writeFile(agentPath(), Array.from({ length: total }, (_unused, n) =>
      startedCommand(id(n), `sleep ${String(n)}`, after(-100_000 + n * 1000))).join(''));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();

    expect(ids(h)).toEqual(Array.from({ length: OWN_TASKS_MAX }, (_unused, n) => id(n + 5)));
    // Koniec jednej z pokazanych zwalnia miejsce dla starszej, która się nie mieściła.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: [id(total - 1)], since: SINCE });
    expect(ids(h)).toHaveLength(OWN_TASKS_MAX);
    expect(ids(h)[0]).toBe(id(4));
    expect(ids(h)).not.toContain(id(total - 1));
  });

  /**
   * LOS NIEZNANY. Plik główny znamy od `since` (okno ogona po restarcie Raroga, przeskok, `/clear`).
   * Koniec komendy wystartowanej wcześniej mógł stać w jego kolejce, zanim zaczęliśmy patrzeć,
   * więc taka komenda bez znanego końca nie jest pokazywana: lepiej nie pokazać żywej, niż trzymać
   * na ekranie martwą bez końca.
   */
  it('los nieznany: komenda wystartowana przed początkiem okna pliku głównego nie jest pokazywana', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('bprzed', 'sleep 1000', after(-90_000))
      + startedCommand('bnastyk', 'sleep 50', after(-60_000)) + startedCommand('bpo', 'sleep 40', after(-5000)));
    const h = harness(reader());

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: after(-60_000) });
    await h.settled();
    expect(ids(h), 'start równo z początkiem okna jest już widziany').toEqual(['bnastyk', 'bpo']);

    // Przeskok albo skrócenie pliku głównego: follower zaczyna okno od nowa, później.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: after(-10_000) });
    expect(ids(h)).toEqual(['bpo']);
    await h.settled();

    // Okno w ogóle nieznane (reduktor nie widział jeszcze wpisu z czasem): nie pokazujemy nic.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    expect(own(h)).toBeUndefined();
    await h.settled();
    expect(own(h)).toBeUndefined();

    // Okno starsze niż wszystkie starty: wracają wszystkie trzy (plik subagenta czytamy od zera).
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: after(-600_000) });
    expect(ids(h)).toEqual(['bprzed', 'bnastyk', 'bpo']);
  });

  it('los nieznany: komenda bez czasu startu i okno o nieczytelnym czasie', async () => {
    const facts: { value: AgentFileFacts } = {
      value: { commands: [{ id: 'bbezczasu', command: 'sleep 1' }, { id: 'bzczasem', startedAt: after(-5000) }] },
    };
    const h = harness({
      read: async () => facts.value, repoint: () => undefined, relocated: () => undefined, close: () => undefined,
    });
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();
    expect(own(h)).toEqual([{ id: 'bzczasem', startedAt: after(-5000) }]);

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: 'zzzz' });
    expect(own(h)).toBeUndefined();
  });

  it('`/clear` zapomina końce i początek okna poprzedniej sesji', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['b00000001'], since: SINCE });
    await h.settled();
    expect(own(h)).toBeUndefined();

    forgetSession(h.state);
    expect(h.state.ended.size).toBe(0);
    expect(h.state.since).toBeUndefined();
  });

  it('lista, która już wyszła, nie zmienia się, gdy agent dostaje kolejną komendę', async () => {
    await seedSession();
    await writeFile(agentPath(), startedCommand('b00000001', 'sleep 40', after(-5000)));
    const h = harness(reader());
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: SINCE });
    await h.settled();
    const first = h.lists.at(-1)?.[0];
    const snapshot = JSON.stringify(first);

    await appendFile(agentPath(), startedCommand('b00000002', 'sleep 60', after(18)));
    await h.tick();
    expect(ids(h)).toEqual(['b00000001', 'b00000002']);
    expect(h.lists.at(-1)?.[0]).not.toBe(first);
    expect(JSON.stringify(first)).toBe(snapshot);
  });
});

/**
 * Czytnik, którego odczyty kończą się dopiero po `release()` — okno na zdarzenie „w trakcie”.
 * Plik jest czytany od razu (wynik opisuje chwilę sprzed zdarzenia), wstrzymane jest samo oddanie.
 */
function gated(real: AgentFileReader): {
  reader: AgentFileReader;
  /** Fakty pierwszego odczytu, już przeczytane z pliku i jeszcze nieoddane. */
  held: Promise<AgentFileFacts | null>;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let hold: (facts: AgentFileFacts | null) => void = () => undefined;
  const held = new Promise<AgentFileFacts | null>((resolve) => { hold = resolve; });
  return {
    reader: {
      read: async (agentId): Promise<AgentFileFacts | null> => {
        const facts = await real.read(agentId);
        hold(facts);
        await gate;
        return facts;
      },
      repoint: (id) => { real.repoint(id); },
      relocated: () => { real.relocated(); },
      close: () => { real.close(); },
    },
    held,
    release: () => { release(); },
  };
}

describe('merge.ts: wynik odczytu, który się spóźnił', () => {
  /**
   * `/clear` wchodzi w środek odczytu. Fasada zapomina sesję od razu, ale lista followera gaśnie
   * dopiero jego następnym zdarzeniem, więc przez chwilę agent poprzedniej sesji dalej stoi na
   * liście. Fakty z jego pliku nie mogą w tym oknie wejść do stanu: agent „ruszyłby” w sesji,
   * w której go nie ma.
   */
  it('`/clear` w trakcie odczytu: fakty poprzedniej sesji nie wchodzą do stanu nowej', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const gate = gated(reader());
    const h = harness(gate.reader);

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    expect(await gate.held, 'odczyt przyniósł wybudzenie').toEqual(seen(after(18)));
    forgetSession(h.state);
    gate.release();
    await h.settled();

    expect(h.state.agents.size).toBe(0);
    expect(h.shown(), 'jedyna lista w górę to ta sprzed odczytu').toBe(`czeka od ${STANDBY}`);
    expect(h.lists).toHaveLength(1);

    noteTasks(h.state, h.deps, { tasks: [] });
    expect(h.shown()).toBe('brak');
  });

  /**
   * Odczyt zaczął się przy pierwszym postoju i zobaczył wybudzenie, ale zanim wrócił, follower
   * przyniósł DRUGI postój. Wpis, który zdjął pierwszy, jest starszy niż drugi: agent czeka.
   */
  it('nowy postój w trakcie odczytu: wynik odczytu go nie zdejmuje', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)) + said(after(30_000)));
    const gate = gated(reader());
    const h = harness(gate.reader);
    const second = after(31_000);

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    expect(await gate.held, 'odczyt widział wpis po PIERWSZYM postoju').toEqual(seen(after(30_000)));
    noteTasks(h.state, h.deps, { tasks: [agentTask(second)] });
    gate.release();
    await h.settled();

    expect(h.shown()).toBe(`czeka od ${second}`);
    expect(h.lists.map((list) => list[0]?.waitingSince)).toEqual([STANDBY, second]);
  });

  it('agent zamknięty w trakcie odczytu: fakty o nim nie zostają w stanie', async () => {
    await seedSession();
    await writeFile(agentPath(), said(after(18)));
    const gate = gated(reader());
    const h = harness(gate.reader);

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    expect(await gate.held).toEqual(seen(after(18)));
    noteTasks(h.state, h.deps, { tasks: [] });
    gate.release();
    await h.settled();

    expect(h.state.agents.size).toBe(0);
    expect(h.shown()).toBe('brak');
  });
});

describe('merge.ts: bez czytnika plików subagentów', () => {
  it('agent stoi na „czeka” do wznowienia albo końca i zegar dla niego nie chodzi', async () => {
    const h = harness(null);
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
    expect(h.timers()).toBe(0);
  });

  /**
   * Zegar jest wspólny dla rozkładów workflow i plików subagentów. Wyłączony odczyt plików nie ma
   * prawa ani zatrzymać rozkładów, ani trzymać zegara dla samego agenta.
   */
  it('zegar chodzi dalej dla przebiegu workflow, a sam agent go nie podtrzymuje', async () => {
    let run: WorkflowRun = { phases: ['Faza A'], agents: [{ id: 'a1', done: false }] };
    let reads = 0;
    const h = harness(null, {
      read: async () => { reads += 1; return run; },
      repoint: () => undefined, relocated: () => undefined, close: () => undefined,
    });
    const workflow: BackgroundTask = {
      id: 'wl4g4ha1y', kind: 'workflow', runId: 'wf_d6b24986-923', startedAt: after(-60_000),
    };

    noteTasks(h.state, h.deps, { tasks: [workflow, agentTask(STANDBY)] });
    await h.settled();
    expect(h.lists.at(-1)).toEqual([{ ...workflow, run }, agentTask(STANDBY)]);
    expect(h.timers()).toBe(1);

    // Tick odświeża rozkład przebiegu; agent dalej czeka.
    run = { phases: ['Faza A'], agents: [{ id: 'a1', done: true }] };
    await h.tick();
    expect(h.lists.at(-1)).toEqual([{ ...workflow, run }, agentTask(STANDBY)]);
    expect(reads).toBe(2);
    expect(h.timers()).toBe(1);

    // Przebieg zamknięty, agent został: nie ma czego czytać, zegar staje.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    await h.tick();
    expect(h.timers()).toBe(0);
    expect(reads).toBe(2);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
  });
});

// ---------------------------------------------------------------------------
// merge.ts: subagent, który już nie wróci
// ---------------------------------------------------------------------------

/**
 * CLI melduje postój, gdy agent staje przy żywym własnym zadaniu w tle. Gdy to zadanie skończy się
 * bez wybudzenia agenta, CLI nie pisze o nim nic więcej. Zmierzone na pliku żywej sesji
 * (CLI 2.1.296): subagent oddał raport przy żywym monitorze, monitor wygasł, agenta nikt nie
 * wybudził, a lista trzymała go na „czeka" do restartu procesu CLI. W plikach sesji projektu tak
 * skończyło 13 z 248 agentów.
 */
describe('merge.ts: subagent w postoju, który nie ma już na co czekać, usypia i wypada z listy', () => {
  const NOW = Date.parse(STANDBY) + 10_000;
  const TICK = 5_000;

  /** Czytnik-atrapa: oddaje to, co stoi w `facts.value`; `null` = nieudany odczyt. */
  function fake(initial: AgentFileFacts | null): {
    reader: AgentFileReader; facts: { value: AgentFileFacts | null }; reads: () => number;
  } {
    const facts = { value: initial };
    let reads = 0;
    return {
      facts,
      reads: () => reads,
      reader: {
        read: async () => { reads += 1; return facts.value; },
        repoint: () => undefined, relocated: () => undefined, close: () => undefined,
      },
    };
  }

  /** Uprząż z agentem w postoju i zegarem ustawionym chwilę po postoju. */
  async function standing(initial: AgentFileFacts | null, since?: string): Promise<{ h: Harness } & ReturnType<typeof fake>> {
    const source = fake(initial);
    const h = harness(source.reader);
    h.clock.now = NOW;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ...(since === undefined ? {} : { since }) });
    await h.settled();
    return { h, ...source };
  }

  /** Przesuwa zegar o `ms` i odpala tick; oddaje to, co widać po nim. */
  async function pass(h: Harness, ms: number): Promise<string> {
    h.clock.now += ms;
    await h.tick();
    return h.shown();
  }

  /** Ticki co 5 s przez `ms`; oddaje KAŻDY stan agenta po drodze. */
  async function during(h: Harness, ms: number): Promise<string[]> {
    const seenStates: string[] = [];
    for (let left = ms; left > 0; left -= TICK) seenStates.push(await pass(h, TICK));
    return seenStates;
  }

  /**
   * TEST OBOWIĄZKOWY: przebieg z żywej sesji. Agent stoi, plik znany do końca, komend otwartych
   * nie ma: po minucie ciszy znika z listy, a zegar dalej czyta jego plik.
   */
  it('minuta ciszy: agent znika z listy, a jego plik jest dalej czytany co tick', async () => {
    const { h, reads } = await standing(seen(after(-1000)));
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    const states = await during(h, DORMANT_AFTER_MS - TICK);
    expect(new Set(states), 'przed upływem minuty agent stoi na liście').toEqual(new Set([`czeka od ${STANDBY}`]));

    expect(await pass(h, TICK)).toBe('brak');
    expect(h.lists.at(-1)).toEqual([]);

    // Uśpienie niczego nie kasuje: follower trzyma wpis, zegar chodzi, plik jest czytany.
    const before = reads();
    await pass(h, TICK);
    await pass(h, TICK);
    expect(reads()).toBe(before + 2);
    expect(h.timers()).toBe(1);
    expect(h.state.raw).toEqual([agentTask(STANDBY)]);
  });

  /**
   * Wyścig, przed którym chroni minuta. Koniec ostatniej komendy przychodzi kolejką pliku głównego
   * (follower widzi go od razu i od razu czyta plik agenta), a wpisu wybudzenia w pliku agenta
   * jeszcze nie ma; następna szansa to tick. Zmierzone: wpis pojawia się 8–111 ms po
   * końcu komendy (53 przypadki).
   */
  it('koniec komendy, a wybudzenie dopiero w następnym ticku: agent ani razu nie znika', async () => {
    const command: AgentOwnTask = { id: 'b00000001', command: 'sleep 40', startedAt: after(-5000) };
    const { h, facts } = await standing({ lastEntryAt: after(-1000), commands: [command], settled: {} }, after(-900_000));
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown(), 'otwarta komenda trzyma agenta na liście bez końca').toBe(`czeka od ${STANDBY}`);

    // Koniec z pliku głównego: czytnik zamyka komendę u siebie, ale wpisu wybudzenia jeszcze nie widzi.
    facts.value = seen(after(-1000));
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['b00000001'], since: after(-900_000) });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    facts.value = seen(after(120_000));
    expect(await pass(h, TICK)).toBe('pracuje');
    expect(h.lists.every((list) => list.some((task) => task.id === AGENT)), 'agent stał w każdej wysłanej liście').toBe(true);
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown(), 'agent, który ruszył, nie usypia').toBe('pracuje');
  });

  it('uśpiony agent wraca jako „pracuje", gdy w jego pliku pojawi się późniejszy wpis', async () => {
    const { h, facts } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS);
    expect(h.shown()).toBe('brak');

    facts.value = seen(after(600_000));
    expect(await pass(h, TICK)).toBe('pracuje');
  });

  it('nowy postój uśpionego agenta: wraca jako „czeka" i minuta liczy się od nowa', async () => {
    const { h } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS);
    expect(h.shown()).toBe('brak');

    const again = after(900_000);
    noteTasks(h.state, h.deps, { tasks: [agentTask(again)] });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${again}`);
    expect(new Set(await during(h, DORMANT_AFTER_MS - TICK))).toEqual(new Set([`czeka od ${again}`]));
    expect(await pass(h, TICK)).toBe('brak');
  });

  /**
   * Lista followera przychodzi także W TRAKCIE odczytu pliku. Sama
   * mijająca minuta nie może uśpić agenta na podstawie faktów sprzed tego odczytu: pusta lista
   * zdjęłaby blokadę restartu, zanim odczyt przyniesie wybudzenie.
   */
  it('minuta mija w trakcie odczytu, a follower powtarza listę: agent nie znika przed wynikiem odczytu', async () => {
    let release: ((facts: AgentFileFacts | null) => void) | null = null;
    let held = false;
    let current: AgentFileFacts | null = seen(after(-1000));
    const h = harness({
      read: () => (held
        ? new Promise<AgentFileFacts | null>((resolve) => { release = resolve; })
        : Promise.resolve(current)),
      repoint: () => undefined, relocated: () => undefined, close: () => undefined,
    });
    h.clock.now = NOW;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    await during(h, DORMANT_AFTER_MS - TICK);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    // Tick po minucie rusza odczyt, który wisi; w tym czasie follower powtarza listę.
    held = true;
    h.clock.now += TICK;
    const ticking = h.tick();
    await waitFor(() => release !== null, 'odczyt w locie');
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['bcudza'] });
    expect(h.shown(), 'minuta minęła, ale odczyt jeszcze trwa').toBe(`czeka od ${STANDBY}`);

    // Odczyt przynosi wybudzenie: agent od razu „pracuje", pustej listy nie było ani razu.
    current = seen(after(120_000));
    held = false;
    (release as unknown as (facts: AgentFileFacts | null) => void)(current);
    await ticking;
    expect(h.shown()).toBe('pracuje');
    expect(h.lists.every((list) => list.some((task) => task.id === AGENT))).toBe(true);
  });

  it('uśpiony agent zostaje uśpiony przy powtórzonej liście followera', async () => {
    const { h } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS);
    expect(h.shown()).toBe('brak');
    const sent = h.lists.length;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['bcudza'] });
    await h.settled();
    expect(h.shown()).toBe('brak');
    expect(h.lists, 'ta sama pusta lista nie jedzie drugi raz').toHaveLength(sent);
  });

  it('powtórzona ta sama lista followera nie zeruje minuty', async () => {
    const { h } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS - TICK);
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['bcudza'] });
    await h.settled();
    expect(await pass(h, TICK)).toBe('brak');
  });

  /**
   * Brak dowodu końca to nie koniec. Komenda o losie nieznanym (start sprzed `since`) nie jest
   * pokazywana w `ownTasks`, ale agenta trzyma: jej koniec mógł stać w pliku głównym, zanim
   * zaczęliśmy patrzeć, albo nie.
   */
  it('otwarta komenda trzyma agenta, także ta o losie nieznanym', async () => {
    const old: AgentOwnTask = { id: 'bstara', command: 'pnpm dev', startedAt: after(-999_000) };
    const { h } = await standing({ lastEntryAt: after(-1000), commands: [old], settled: {} }, after(-5000));
    expect(h.lists.at(-1)?.[0], 'komenda sprzed okna nie jest pokazywana').not.toHaveProperty('ownTasks');
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
  });

  it('bez dowodu, że plik jest znany do ostatniej linii, agent nie usypia', async () => {
    const { h, facts } = await standing(unsettled(after(-1000)));
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    // Dowód przyszedł dopiero teraz: minuta liczy się od tej chwili.
    facts.value = seen(after(-1000));
    expect(new Set(await during(h, DORMANT_AFTER_MS))).toEqual(new Set([`czeka od ${STANDBY}`]));
    expect(await pass(h, TICK)).toBe('brak');
  });

  /**
   * Nieudany odczyt zostawia w stanie fakty z poprzedniego (wybudzenie, które widzieliśmy, było),
   * ale ciszy już nie dowodzi: plik mógł się w tym czasie zmienić.
   */
  it('nieudany odczyt przerywa ciszę, a po powrocie odczytu minuta liczy się od nowa', async () => {
    const { h, facts } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS - 2 * TICK);

    facts.value = null;
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown(), 'seria nieudanych odczytów nie usypia').toBe(`czeka od ${STANDBY}`);

    facts.value = seen(after(-1000));
    expect(new Set(await during(h, DORMANT_AFTER_MS))).toEqual(new Set([`czeka od ${STANDBY}`]));
    expect(await pass(h, TICK)).toBe('brak');
  });

  it('nieudany odczyt uśpionego agenta przywraca go na listę', async () => {
    const { h, facts } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS);
    expect(h.shown()).toBe('brak');
    facts.value = null;
    expect(await pass(h, TICK)).toBe(`czeka od ${STANDBY}`);
  });

  /**
   * Uśpienie zdejmuje blokadę restartu sesji, więc agent, który może jeszcze czekać na monitor,
   * zostaje na liście do końca jego terminu. Duch z żywej sesji miał
   * monitor na 30 minut i znika minutę po jego terminie.
   */
  it('żywy monitor trzyma agenta do swojego terminu; minuta liczy się dopiero po nim', async () => {
    const until = NOW + 13 * 60_000;
    const { h } = await standing({ lastEntryAt: after(-1000), commands: [], settled: { otherWorkUntil: until } });
    const states = await during(h, 13 * 60_000 - TICK);
    expect(new Set(states), 'przed terminem monitora').toEqual(new Set([`czeka od ${STANDBY}`]));

    expect(new Set(await during(h, DORMANT_AFTER_MS)), 'minuta po terminie').toEqual(new Set([`czeka od ${STANDBY}`]));
    expect(await pass(h, TICK)).toBe('brak');
  });

  it('agent, który wołał `Agent` albo `Workflow`, nie usypia nigdy', async () => {
    const { h } = await standing({ lastEntryAt: after(-1000), commands: [], settled: { otherWorkUntil: Infinity } });
    await during(h, 10 * DORMANT_AFTER_MS);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
  });

  it('agent, który pracuje, nie usypia; liczy się wyłącznie postój z followera', async () => {
    const source = fake(seen(after(-1000)));
    const h = harness(source.reader);
    h.clock.now = NOW;
    noteTasks(h.state, h.deps, { tasks: [agentTask()] });
    await h.settled();
    await during(h, 3 * DORMANT_AFTER_MS);
    expect(h.shown()).toBe('pracuje');
  });

  it('dwóch agentów ma osobne minuty', async () => {
    const OTHER = 'a0000000000000002';
    const other = (waitingSince: string): BackgroundTask => ({ id: OTHER, kind: 'agent', description: 'drugi', waitingSince });
    const source = fake(seen(after(-1000)));
    const h = harness(source.reader);
    h.clock.now = NOW;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    await during(h, DORMANT_AFTER_MS - 2 * TICK);

    // Drugi agent staje 50 s po pierwszym.
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY), other(after(50_000))] });
    await h.settled();
    await during(h, 2 * TICK);
    expect(h.lists.at(-1)?.map((task) => task.id), 'pierwszy uśpiony, drugi jeszcze stoi').toEqual([OTHER]);
    await during(h, DORMANT_AFTER_MS);
    expect(h.lists.at(-1)).toEqual([]);
  });

  it('`forgetSession` i zejście agenta z listy czyszczą pamięć ciszy', async () => {
    const { h } = await standing(seen(after(-1000)));
    await during(h, DORMANT_AFTER_MS);
    expect(h.state.dormant.size).toBe(1);

    forgetSession(h.state);
    expect([h.state.quiet.size, h.state.dormant.size, h.state.unread.size]).toEqual([0, 0, 0]);

    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    await during(h, DORMANT_AFTER_MS);
    expect(h.state.quiet.size).toBe(1);
    noteTasks(h.state, h.deps, { tasks: [] });
    await h.settled();
    expect([h.state.quiet.size, h.state.dormant.size]).toEqual([0, 0]);
  });

  it('bez czytnika plików subagentów (`RAROG_AGENT_FILES=0`) reguły nie ma: agent stoi jak dotąd', async () => {
    const h = harness(null);
    h.clock.now = NOW;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)] });
    await h.settled();
    h.clock.now += 10 * DORMANT_AFTER_MS;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], ended: ['bcudza'] });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
  });

  /** Prawdziwy plik i prawdziwy czytnik: przebieg ducha od początku do końca. */
  it('na prawdziwym pliku: komendy skończone, monitor po terminie → agent usypia; nowy wpis go budzi', async () => {
    await seedSession();
    const monitorAt = after(-16 * 60_000);
    await writeFile(agentPath(), startedCommand('b00000001', 'pnpm test', after(-20 * 60_000))
      + called('Monitor', { description: 'log bramki', timeout_ms: 1_800_000, command: 'tail -f x' }, monitorAt)
      + wokenBy('b00000001', after(-120_000))
      + called('SubagentHandback', { message: 'raport' }, after(-1000)));
    const h = harness(reader());
    h.clock.now = Date.parse(STANDBY) + 1000;
    noteTasks(h.state, h.deps, { tasks: [agentTask(STANDBY)], since: after(-30 * 60_000) });
    await h.settled();
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);

    // Monitor żyje jeszcze 14 minut: agent stoi.
    await during(h, 13 * 60_000);
    expect(h.shown()).toBe(`czeka od ${STANDBY}`);
    // Termin monitora minął, potem minuta ciszy.
    await during(h, 3 * 60_000);
    expect(h.shown()).toBe('brak');

    await appendFile(agentPath(), said(after(20 * 60_000), 'wróciłem'));
    expect(await pass(h, TICK)).toBe('pracuje');
  });
});
