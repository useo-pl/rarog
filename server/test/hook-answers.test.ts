/**
 * Kanał ODPOWIEDZI na `AskUserQuestion` (`server/src/herdr/dialogs/hook/answers.ts`).
 *
 * Sam KSZTAŁT pliku i jego reżim: prawa, atomowość zapisu, granica nazwy (klucz i sesja wchodzą
 * do ścieżki, więc `../` musi odpaść PRZED `join`) i żniwiarz. Czy hook naprawdę ten plik czyta,
 * sprawdza `pending-hook.test.ts` — tam oba procesy spotykają się na jednym katalogu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_ANSWER_TTL_MS, clearHookAnswer, createHookAnswerChannel,
  hookAnswerPath, hookAnswerPending, sweepHookAnswers, writeHookAnswer,
} from '../src/herdr/dialogs/hook/answers.ts';
import { HOOK_ANSWERS_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ffffffffffffffff';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-answers-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('hookAnswerPath', () => {
  it('odrzuca sesję i klucz, które nie nadają się na nazwę pliku', () => {
    // Oba pola są WEJŚCIEM NIEZAUFANYM (klucz przychodzi ze zrzutu pisanego spoza Raroga),
    // a stają się ścieżką — walidacja MUSI stać przed `join`, nie po nim.
    for (const bad of ['../../etc/passwd', 'a/b', '', '.']) {
      expect(hookAnswerPath(dataDir, SESSION, bad), bad).toBeNull();
      expect(hookAnswerPath(dataDir, bad, KEY), bad).toBeNull();
    }
  });

  it('składa ścieżkę `answers/<sesja>/<klucz>.json`', () => {
    expect(hookAnswerPath(dataDir, SESSION, KEY))
      .toBe(join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION, `${KEY}.json`));
  });
});

describe('writeHookAnswer', () => {
  it('pisze plik 0600 w katalogu 0700, z sesją, kluczem, czasem i odpowiedziami', () => {
    const path = writeHookAnswer(
      dataDir, SESSION, KEY, { 'Jaki smak?': 'Czekolada' }, () => 1_700_000_000_000,
    );

    expect(path).toBe(join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION, `${KEY}.json`));
    expect(JSON.parse(readFileSync(path as string, 'utf8'))).toEqual({
      sessionId: SESSION,
      // Klucz jedzie do ŚRODKA, nie tylko do nazwy: hook porównuje oba, więc plik podłożony
      // pod cudzą nazwę nie zadziała.
      key: KEY,
      at: 1_700_000_000_000,
      answers: { 'Jaki smak?': 'Czekolada' },
    });
    // Treść odpowiedzi człowieka to ta sama klasa danych co zrzut w `pending/`.
    expect(statSync(path as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION)).mode & 0o777).toBe(0o700);
  });

  it('zwraca `null` zamiast rzucać, gdy zapis jest niemożliwy', () => {
    // Nieudany zapis ma spaść na tor cyfry, a nie wywrócić decyzję użytkownika.
    expect(writeHookAnswer(dataDir, SESSION, '../x', { a: 'b' })).toBeNull();
    expect(writeHookAnswer('/nie/ma/takiego/katalogu/i/nie/da/sie/go/zrobic\0', SESSION, KEY, { a: 'b' }))
      .toBeNull();
  });

  it('nie zostawia pliku tymczasowego po udanym zapisie', () => {
    writeHookAnswer(dataDir, SESSION, KEY, { a: 'b' });
    const dir = join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION);
    // Nazwa tmp ma losowy sufiks, więc szukamy KAŻDEGO pliku tymczasowego, nie jednej nazwy.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${KEY}.json`]);
  });
});

describe('pending / clear', () => {
  it('`pending` mówi, czy plik wciąż leży, a `clear` znosi go bez wyjątku przy braku', () => {
    const path = writeHookAnswer(dataDir, SESSION, KEY, { a: 'b' }) as string;
    expect(hookAnswerPending(path)).toBe(true);
    clearHookAnswer(path);
    expect(hookAnswerPending(path)).toBe(false);
    // Drugie sprzątanie jest normalnym stanem: hook mógł zużyć plik przed nami.
    expect(() => { clearHookAnswer(path); }).not.toThrow();
  });
});

describe('createHookAnswerChannel', () => {
  it('zamknięta bramka killswitcha nie pisze NICZEGO i oddaje `null`', () => {
    // Kanał omija klienta herdr, więc `RAROG_HERDR_SEND=0` musi wyciąć go tutaj — inaczej
    // „widzę, nie ruszam" przestałoby obowiązywać akurat dla odpowiedzi na pytania.
    const closed = createHookAnswerChannel(dataDir, () => false);
    expect(closed.write(SESSION, KEY, { a: 'b' })).toBeNull();
    expect(existsSync(join(dataDir, HOOK_ANSWERS_DIRNAME))).toBe(false);
  });

  it('otwarta bramka pisze przez ten sam zapisywacz', () => {
    const open = createHookAnswerChannel(dataDir, () => true);
    const path = open.write(SESSION, KEY, { a: 'b' });
    expect(path).not.toBeNull();
    expect(open.pending(path as string)).toBe(true);
    open.clear(path as string);
    expect(open.pending(path as string)).toBe(false);
  });
});

describe('sweepHookAnswers', () => {
  const postarz = (path: string): void => {
    const old = (Date.now() - HOOK_ANSWER_TTL_MS - 60_000) / 1000;
    utimesSync(path, old, old);
  };

  it('brak katalogu to zero, nie wyjątek', () => {
    expect(sweepHookAnswers(dataDir)).toBe(0);
  });

  it('kasuje pliki starsze niż TTL i zdejmuje puste katalogi sesji', () => {
    const path = writeHookAnswer(dataDir, SESSION, KEY, { a: 'b' }) as string;
    postarz(path);

    expect(sweepHookAnswers(dataDir)).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION)))
      .toBe(false);
  });

  it('zostawia plik świeży — czekający hook ma go jeszcze przeczytać', () => {
    const path = writeHookAnswer(dataDir, SESSION, KEY, { a: 'b' }) as string;

    expect(sweepHookAnswers(dataDir)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('zamiata też pliki, których nie umie przeczytać (wiek z `mtime`, nie z treści)', () => {
    const dir = join(dataDir, HOOK_ANSWERS_DIRNAME, SESSION);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'smiec.json');
    writeFileSync(path, 'to nie jest json');
    postarz(path);

    expect(sweepHookAnswers(dataDir)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});
