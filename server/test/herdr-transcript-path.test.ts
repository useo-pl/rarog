/**
 * Lokalizacja pliku transkryptu po UUID (`herdr/transcript-path.ts`).
 *
 * Testy pracują na PRAWDZIWYM katalogu tymczasowym, bo sednem modułu jest zachowanie systemu
 * plików: plik pod innym slugiem, katalog bez uprawnień, wpis, który jest katalogiem zamiast
 * pliku. Atrapa `fs` udowodniłaby tylko, że kod woła to, co kod woła.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { locateTranscript, transcriptHasConversation } from '../src/herdr/transcript-path.ts';

const CWD = '/Users/u/Projects/atlas';
const OTHER_CWD = '/Users/u/Projects/birch';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-locate-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Kładzie plik transkryptu w slugu podanego katalogu. */
async function place(cwd: string, session = SESSION): Promise<string> {
  const dir = join(root, projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  await writeFile(path, '{}\n');
  return path;
}

describe('locateTranscript', () => {
  it('trafia pierwszym strzałem w slug katalogu roboczego', async () => {
    const path = await place(CWD);
    expect(await locateTranscript(root, CWD, SESSION)).toBe(path);
  });

  /**
   * TEST OBOWIĄZKOWY.
   *
   * `claude --resume <uuid>` uruchomiony w innym katalogu dopisuje do pliku w slugu
   * ORYGINALNYM — tak samo rozwidlenie sesji. Bez globu Rarog szukałby pliku tam, gdzie on
   * nigdy nie powstanie, i po 15 s zgłaszał GŁOŚNY alarm „transkrypt nie powstaje" na sesji,
   * która jest zdrowa i pisze normalnie.
   */
  it('znajduje plik pod INNYM slugiem niż `cwd` (wznowienie międzykatalogowe)', async () => {
    const path = await place(OTHER_CWD);
    await mkdir(join(root, projectSlug(CWD)), { recursive: true });
    expect(await locateTranscript(root, CWD, SESSION)).toBe(path);
  });

  it('brak pliku gdziekolwiek → `null`', async () => {
    await place(OTHER_CWD, '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55');
    expect(await locateTranscript(root, CWD, SESSION)).toBeNull();
  });

  it('nieistniejący korzeń magazynu → `null`, nigdy wyjątek', async () => {
    expect(await locateTranscript(join(root, 'nie-ma'), CWD, SESSION)).toBeNull();
  });

  /**
   * Granica traversalu. `agentSessionId` bywa wejściem z requestu (`resumeFrom`), więc wzorzec
   * identyfikatora jest tu bramką, a nie kosmetyką — bez niej `../../…` czytałoby dowolny plik
   * konta użytkownika.
   */
  it('identyfikator spoza wzorca nie dotyka dysku', async () => {
    expect(await locateTranscript(root, CWD, '../../../etc/passwd')).toBeNull();
    expect(await locateTranscript(root, CWD, 'a/b')).toBeNull();
    expect(await locateTranscript(root, CWD, '')).toBeNull();
  });

  it('katalog o nazwie pliku transkryptu nie jest transkryptem', async () => {
    await mkdir(join(root, projectSlug(CWD), `${SESSION}.jsonl`), { recursive: true });
    expect(await locateTranscript(root, CWD, SESSION)).toBeNull();
  });

  it('wynik globu jest POWTARZALNY, gdy plik leży w kilku katalogach', async () => {
    await place('/Users/u/Projects/zeta');
    await place('/Users/u/Projects/birch');
    const first = await locateTranscript(root, CWD, SESSION);
    expect(first).toBe(await locateTranscript(root, CWD, SESSION));
    // Kolejność `readdir` zależy od systemu plików, więc sortujemy — inaczej ten sam plik
    // znajdowałby się raz tu, raz tam, a follower przepinałby się między nimi.
    expect(first).toBe(join(root, projectSlug('/Users/u/Projects/birch'), `${SESSION}.jsonl`));
  });
});

// ---------------------------------------------------------------------------
// Rozmowa czy sama hydraulika CLI
// ---------------------------------------------------------------------------

/**
 * Prefiks pliku w chwili `/clear` przepisany z żywej sesji (wersja CLI niezapisana):
 * tytuł panelu, tryb, snapshot plików, echo komendy w roli `user` i wpis meta. Ostatnie cztery linie
 * `commands/measured/rename-clear-2.1.302.jsonl` (CLI 2.1.302) mają ten sam układ bez trybu i snapshotu:
 * tytuł, wpis meta, echo `/clear` w roli `user` i pusty wynik komendy. Ani jednej wypowiedzi — a plik
 * już jest, więc test „istnieje" brał to za `/resume`.
 */
const AFTER_CLEAR_LINES = [
  { type: 'custom-title', customTitle: 'fixes', sessionId: SESSION },
  { type: 'mode', mode: 'normal', sessionId: SESSION },
  { type: 'file-history-snapshot', messageId: 'a8746086', snapshot: { trackedFileBackups: {} } },
  {
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>Caveat…</local-command-caveat>' },
    isMeta: true,
    timestamp: '2026-08-25T13:36:22.622Z',
  },
  {
    type: 'user',
    message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-args></command-args>' },
    timestamp: '2026-08-25T13:36:22.491Z',
  },
  { type: 'system', subtype: 'local_command_output', content: '', timestamp: '2026-08-25T13:36:22.622Z' },
];

const lines = (entries: readonly unknown[]): string =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

/** Kładzie plik o podanej treści w slugu `CWD` i zwraca jego ścieżkę. */
async function write(content: string, session = SESSION): Promise<string> {
  const dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  await writeFile(path, content);
  return path;
}

describe('transcriptHasConversation', () => {
  it('świeży plik po `/clear` to NIE rozmowa, choć plik istnieje', async () => {
    expect(await transcriptHasConversation(await write(lines(AFTER_CLEAR_LINES)))).toBe(false);
  });

  it('plik z wypowiedzią człowieka to rozmowa', async () => {
    const content = lines([...AFTER_CLEAR_LINES, {
      type: 'user',
      message: { role: 'user', content: 'popraw layout' },
      timestamp: '2026-08-25T13:37:12.368Z',
    }]);
    expect(await transcriptHasConversation(await write(content))).toBe(true);
  });

  it('sama odpowiedź agenta też jest rozmową (wznowienie po restarcie CLI)', async () => {
    const content = lines([{
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'gotowe' }] },
      timestamp: '2026-08-25T13:37:12.368Z',
    }]);
    expect(await transcriptHasConversation(await write(content))).toBe(true);
  });

  /**
   * Prompt wchłonięty w trwającą turę stoi w pliku wyłącznie jako załącznik kolejki.
   * Wypowiedzią człowieka jest tylko ten o pochodzeniu `human`; meldunek i wiadomość od subagenta
   * jadą tym samym nośnikiem i rozmową nie są.
   */
  it('załącznik kolejki: prompt człowieka to rozmowa, meldunek i wiadomość od subagenta nie', async () => {
    const carried = (attachment: Record<string, unknown>): string => lines([...AFTER_CLEAR_LINES, {
      type: 'attachment', isSidechain: false, timestamp: '2026-10-10T07:50:29.308Z',
      attachment: { type: 'queued_command', prompt: 'a jeszcze to', commandMode: 'prompt', ...attachment },
    }]);
    expect(await transcriptHasConversation(await write(carried({ origin: { kind: 'human' } })))).toBe(true);
    expect(await transcriptHasConversation(await write(carried({ origin: { kind: 'peer' }, isMeta: true })))).toBe(false);
    expect(await transcriptHasConversation(await write(carried({
      commandMode: 'task-notification', origin: { kind: 'task-notification' },
    })))).toBe(false);
  });

  it('pusty plik i brak pliku → `false`, nigdy wyjątek', async () => {
    expect(await transcriptHasConversation(await write(''))).toBe(false);
    expect(await transcriptHasConversation(join(root, 'nie-ma.jsonl'))).toBe(false);
  });

  /**
   * Ucięta ostatnia linia prefiksu nie może udawać wypowiedzi — parser dostaje tylko linie
   * domknięte znakiem nowej linii.
   */
  it('niedomknięta ostatnia linia nie liczy się jako rozmowa', async () => {
    const content = `${lines(AFTER_CLEAR_LINES)}{"type":"user","message":{"role":"user","con`;
    expect(await transcriptHasConversation(await write(content))).toBe(false);
  });

  /**
   * Plik większy od sondy jest z definicji starą sesją: pół megabajta hydrauliki bez ani jednej
   * wypowiedzi nie powstaje w chwili `/clear`.
   */
  it('plik dłuższy od sondy liczy się jako rozmowa', async () => {
    const filler = `${JSON.stringify({ type: 'mode', mode: 'normal', pad: 'x'.repeat(4000) })}\n`;
    expect(await transcriptHasConversation(await write(filler.repeat(200)))).toBe(true);
  });
});
