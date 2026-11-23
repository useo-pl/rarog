/**
 * Wysyłka w trakcie tury: samo wklejenie i osobny Enter (karta 0a).
 *
 * Tu stoją fasada klienta (`pasteText`, `sendPromptSubmit`), czysta reguła pola (`drivers/herdr/prompt-paste.ts`)
 * i strażnicy granic nowego klawisza. Zachowanie drivera (bramki przed wklejeniem i przed Enterem, kolejka, log) testuje
 * `herdr-driver.test.ts`, blok „wysyłka w trakcie tury”.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHerdrClient } from '../src/herdr/client.ts';
import { ALLOWED_KEYS } from '../src/herdr/dialogs/send/keys.ts';
import { PROMPT_SUBMIT_KEY, assertPromptSubmitKeys } from '../src/herdr/dialogs/send/prompt-submit.ts';
import { gluedFieldVerdict, pastedFieldVerdict, promptFieldOf } from '../src/drivers/herdr/prompt-paste.ts';
import type { PasteMark } from '../src/drivers/herdr/prompt-paste.ts';
import { scan, tsFiles } from './source-scan.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const RULE = '─'.repeat(40);
const field = (text: string): string => `${RULE}\n❯ ${text}\n${RULE}`;

interface Call { method: string; params: Record<string, unknown> }

/** Atrapa transportu gniazda: zapamiętuje żądania i odpowiada sukcesem. */
function fakeRequester(): { calls: Call[]; request: (m: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      return Promise.resolve({ type: 'ok' });
    },
  };
}

describe('fasada klienta: wklejenie i Enter osobno', () => {
  it('`pasteText` to jedno `pane.send_input` z samym adresem i tekstem, bez klawiszy', async () => {
    const fake = fakeRequester();
    await createHerdrClient(fake).pasteText('w9:p72', 'dopisek w trakcie tury');
    expect(fake.calls).toEqual([
      { method: 'pane.send_input', params: { pane_id: 'w9:p72', text: 'dopisek w trakcie tury' } },
    ]);
    expect(Object.keys(fake.calls[0]!.params)).toEqual(['pane_id', 'text']);
  });

  it('`pasteText` bez adresu albo bez tekstu nie dotyka gniazda', async () => {
    const fake = fakeRequester();
    const client = createHerdrClient(fake);
    await expect(client.pasteText('', 'tekst')).rejects.toThrow();
    await expect(client.pasteText('w9:p72', '')).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it('`sendPromptSubmit` to jedno `agent.send_keys` z dokładnie `[enter]`', async () => {
    const fake = fakeRequester();
    await createHerdrClient(fake).sendPromptSubmit('w9:p72');
    expect(fake.calls).toEqual([{ method: 'agent.send_keys', params: { target: 'w9:p72', keys: ['enter'] } }]);
  });

  it.each([[[]], [['enter', 'enter']], [['escape']], [['down']], [['1']], [['ctrl+c']]])(
    'asercja klawisza wysłania: %j → wyjątek', (keys) => {
      expect(() => { assertPromptSubmitKeys(keys); }).toThrow();
    },
  );

  it('asercja przepuszcza wyłącznie `[enter]`, a `ALLOWED_KEYS` dalej nie zna `enter`', async () => {
    expect(() => { assertPromptSubmitKeys([PROMPT_SUBMIT_KEY]); }).not.toThrow();
    expect(ALLOWED_KEYS.has('enter')).toBe(false);
    const fake = fakeRequester();
    await expect(createHerdrClient(fake).sendKeys('w9:p72', ['enter'])).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe('pole promptu po wklejeniu (czysta reguła)', () => {
  it('pole w ramce bez białych znaków; dialog i formularz zakrywają pole (`null`)', () => {
    expect(promptFieldOf(field('dopisek  w trakcie'))).toBe('dopisekwtrakcie');
    expect(promptFieldOf(field(''))).toBe('');
    expect(promptFieldOf(readFileSync(join(FIXTURES, 'dialog-permission.txt'), 'utf8'))).toBeNull();
    const form = readFileSync(join(FIXTURES, 'measured', 'pytanie-preview-2.1.293.txt'), 'utf8');
    expect(promptFieldOf(form)).toBeNull();
  });

  const fresh: PasteMark = { before: null, after: null, lost: false };
  const pasted: PasteMark = { before: '', after: 'dopisek', lost: false };
  /** Tekstu w polu nie widać, a pole przed wklejeniem trzymało szkic. */
  const overDraft: PasteMark = { before: 'szkic', after: null, lost: false };
  /** Tekstu w polu nie widać, pole przed wklejeniem było puste, dowodu utraty nie ma. */
  const unseen: PasteMark = { before: '', after: null, lost: false };
  /** Pierwszy odczyt po wklejeniu (przed progiem 300 ms) pokazał dialog, który już stał: tekst przepadł. */
  const lost: PasteMark = { before: '', after: null, lost: true };
  /** Tekst przepadł w stojącym dialogu, a pole przed wklejeniem trzymało szkic. */
  const lostOverDraft: PasteMark = { before: 'szkic', after: null, lost: true };
  it.each([
    ['pierwsza próba', '', fresh, 'paste'],
    ['tekst wklejony w stojący dialog przepadł (dowód z pierwszego odczytu)', '', lost, 'paste'],
    ['tekst przepadł, szkic sprzed wklejenia dalej stoi', 'szkic', lostOverDraft, 'paste'],
    ['tekst przepadł, a pole trzyma teraz cudzy tekst: to nie wklejony tekst, więc bez Entera', 'zbiurka', lost,
      'changed'],
    ['tekst przepadł, a szkic sprzed wklejenia zniknął: wiadomość nie poszła', '', lostOverDraft, 'changed'],
    ['pole dalej trzyma szkic sprzed wklejenia: Enter wysłałby go z tekstem, więc tekst nie poszedł', 'szkic',
      overDraft, 'paste'],
    ['pole puste jak przed wklejeniem, bez dowodu utraty: tekst mógł pójść Enterem przy Macu', '', unseen, 'unseen'],
    ['tekst doszedł, zanim driver go zobaczył', 'szkicdopisek', overDraft, 'landed'],
    ['tekst doszedł do pustego pola, zanim driver go zobaczył', 'dopisek', unseen, 'landed'],
    ['pole wyczyszczone przy biurku, zanim driver zobaczył tekst', '', overDraft, 'taken'],
    ['tekst przetrwał dialog', 'dopisek', pasted, 'holds'],
    ['pole puste po wklejeniu: Enter albo czyszczenie przy biurku', '', pasted, 'taken'],
    ['pole z cudzym tekstem', 'dopisekzbiurka', pasted, 'changed'],
  ] as const)('%s → %s', (_name, now, mark, verdict) => {
    expect(pastedFieldVerdict(now, mark)).toBe(verdict);
  });

  /*
   * Sklejka po wklejeniu do pustego pola: hook oddał tekst poprzedniej wiadomości z kolejki („pierwszy”), kiedy szła
   * następna („drugi”), albo szkic przy Macu zaczyna się albo kończy tym tekstem. Enter wysłałby oba teksty jako jeden
   * prompt albo cudzy tekst; żaden werdykt nie daje Entera, czyszczenia ani drugiego wklejenia.
   */
  it.each([
    ['oddany tekst przed wklejonym', 'pierwszydrugi', 'drugi', 'pierwszy', 'changed'],
    ['oddany tekst za wklejonym', 'drugipierwszy', 'drugi', 'pierwszy', 'changed'],
    ['oddany tekst zamiast wklejonego: wklejony mógł pójść Enterem przy Macu', 'pierwszy', 'drugi', 'pierwszy',
      'unseen'],
    ['szkic przy Macu zaczyna się poprzednią wiadomością', 'takalechcęzachowaćtenszkic', 'drugi', 'tak', 'changed'],
    ['szkic przy Macu kończy się poprzednią wiadomością', 'zostawtenszkic,tak', 'drugi', 'tak', 'changed'],
    ['sam wklejony tekst, także równy pozostałości', 'tak', 'tak', 'tak', null],
    ['wklejony tekst zaczyna się jak pozostałość, ale jest cały', 'takproszę', 'takproszę', 'tak', null],
    ['znacznik długiej wklejki bez pozostałości', '[Pastedtext#1+12lines]', 'długi', 'pierwszy', null],
    ['znacznik długiej wklejki za pozostałością', 'pierwszy[Pastedtext#1+12lines]', 'długi', 'pierwszy', 'changed'],
    ['bez pozostałości Raroga', 'pierwszydrugi', 'drugi', null, null],
  ] as const)('sklejka: %s → %s', (_name, now, own, leftover, verdict) => {
    expect(gluedFieldVerdict(now, own, leftover)).toBe(verdict);
  });
});

/*
 * Strażnik: `enter` wysyłki promptu ma jedną drogę. Metodę klienta woła wyłącznie wysyłka w trakcie tury w driverze
 * (kolejka wklejeń `drivers/herdr/prompt-queue.ts`, jedna linia), stałą i asercję biorą tylko ona i klient,
 * a `pane.send_input` składa wyłącznie klient (lista metod gniazda stoi w `socket.ts`). Pozostałe ścieżki klawiszy
 * dalej idą przez `ALLOWED_KEYS` bez `enter`.
 */
describe('strażnik ścieżki `enter` wysyłki promptu', () => {
  const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = tsFiles(join(REPO, 'server/src')).map((file) => ({
    file: relative(REPO, file), source: readFileSync(file, 'utf8'),
  }));
  const literalIn = (text: string): string[] => files
    .filter(({ source }) => scan(source).literals.some((literal) => literal.text === text))
    .map(({ file }) => file);
  const codeLines = (source: string): string[] => source.split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
  const usedIn = (pattern: RegExp): string[] => files
    .filter(({ source }) => codeLines(source).some((line) => pattern.test(line)))
    .map(({ file }) => file);
  const driver = files.find(({ file }) => file === 'server/src/drivers/herdr/prompt-queue.ts')?.source ?? '';
  // The answer recheck wraps the client a driver gets: one line per method passes the driver's call on as it came
  // (`herdr-answer-recheck.test.ts`), so it is not a second sender.
  const RECHECK = 'server/src/herdr/answer-recheck.ts';
  const wrapper = files.find(({ file }) => file === RECHECK)?.source ?? '';

  it('`sendPromptSubmit` woła tylko driver, w jednym miejscu; definiuje klient', () => {
    expect(usedIn(/\.sendPromptSubmit\(/).sort()).toEqual(['server/src/drivers/herdr/prompt-queue.ts', RECHECK]);
    expect(codeLines(driver).filter((line) => line.includes('.sendPromptSubmit('))).toHaveLength(1);
    expect(codeLines(wrapper).filter((line) => line.includes('.sendPromptSubmit('))).toHaveLength(1);
    // A definition, not a call through a receiver: the calls are counted above.
    expect(usedIn(/(?<!\.)sendPromptSubmit\(paneId/).sort())
      .toEqual(['server/src/herdr/client.ts', 'server/src/herdr/types.ts']);
  });

  it('`pasteText` woła tylko driver, w jednym miejscu; `pane.send_input` składa tylko klient', () => {
    expect(usedIn(/\.pasteText\(/).sort()).toEqual(['server/src/drivers/herdr/prompt-queue.ts', RECHECK]);
    expect(codeLines(driver).filter((line) => line.includes('.pasteText('))).toHaveLength(1);
    expect(codeLines(wrapper).filter((line) => line.includes('.pasteText('))).toHaveLength(1);
    expect(literalIn('pane.send_input').sort()).toEqual(['server/src/herdr/client.ts', 'server/src/herdr/socket.ts']);
  });

  it('stałą klawisza i asercję biorą tylko driver i klient', () => {
    expect(usedIn(/\bPROMPT_SUBMIT_KEY\b|\bassertPromptSubmitKeys\b/).sort()).toEqual([
      'server/src/drivers/herdr/prompt-queue.ts',
      'server/src/herdr/client.ts',
      'server/src/herdr/dialogs/send/prompt-submit.ts',
    ]);
  });
});
