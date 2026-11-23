/**
 * Kanał ODPOWIEDZI na `AskUserQuestion` — plik, na który czeka śpiący hook.
 *
 * Kierunek jest ODWROTNY niż w `dump.ts`: tam hook pisze, a Rarog czyta; tutaj pisze
 * RAROG, a czyta hook. Katalog jest jeden na sesję silnika (`<dataDir>/answers/<sesja>/`),
 * a nazwą pliku jest KLUCZ POLICZONY PRZEZ HOOK i przyniesiony w zrzucie (`answerKey`) —
 * Rarog go nie zgaduje, bo pod jednym `prompt_id` potrafią stać dwa równoległe pytania
 * i odróżnia je dopiero skrót `tool_input`.
 *
 * Co ten plik ZNACZY i czego NIE ZNACZY. Znaczy dokładnie tyle, co cyfra wpisana w formularz
 * przy biurku: treść odpowiedzi człowieka na pytanie, które sam widzi na karcie. NIE jest zgodą
 * na narzędzie — hook zwraca `allow` WYŁĄCZNIE dla `AskUserQuestion`, które niczego nie
 * wykonuje, a dla każdego innego narzędzia kończy stdoutem pustym.
 *
 * Życie pliku jest KRÓTKIE z rozmysłu. Hook kasuje go po odczycie, Rarog kasuje go, gdy nikt
 * nie zużył go w kilka sekund (biurko było pierwsze albo hooka nie ma), a żniwiarz startu
 * zamiata resztę. Plik, który przeżyłby swoje pytanie, odpowiedziałby na NASTĘPNE — dlatego
 * hook dodatkowo sprawdza `at` i klucz, a nie sam fakt istnienia.
 *
 * Reżim jak przy `pending/`: katalog `0700`, plik `0600`, zapis atomowy (tmp + `rename`), każdy
 * błąd połknięty i zamieniony na `null` — nieudany zapis ma spaść na tor cyfry, a nie wywrócić
 * decyzję użytkownika.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_SESSION_ID_PATTERN } from '../../../transcript-import.ts';
import { HOOK_ANSWERS_DIRNAME } from './contract.ts';

/**
 * Po ilu minutach plik odpowiedzi jest śmieciem.
 *
 * Normalnie żyje ułamek sekundy (hook czyta go w następnym obrocie pollingu). Dłużej leży
 * wyłącznie wtedy, gdy Rarog zniknął między zapisem a sprzątaniem — a wtedy i tak nie ma
 * czego dowodzić: hook odsiewa taki plik po `at` starszym niż jego własny zrzut.
 */
export const HOOK_ANSWER_TTL_MS = 10 * 60 * 1000;

/**
 * Kształt klucza — wejście NIEZAUFANE, bo przychodzi ze zrzutu pisanego przez proces spoza
 * Raroga, a staje się NAZWĄ PLIKU. Realny klucz to `<uuid>-<16 znaków hex>-<16 znaków hex nonce'a>`
 * (nonce: bez niego dwa identyczne pytania jednej tury miałyby klucz co do znaku
 * ten sam) — ale Rarog go NIE LICZY i nie zna jego kształtu, tylko przepuszcza przez ten
 * wzorzec ciąg przyniesiony w zrzucie; wszystko, co nie
 * mieści się w identyfikatorze bez separatorów ścieżki, odrzucamy przed `join` (ta sama granica,
 * co w `pendingPath`).
 */
const ANSWER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/;

/**
 * NOTATKA do odpowiedzi na jedno pytanie — wartość `updatedInput.annotations[pytanie]`.
 * `preview` to ORYGINAŁ podglądu wybranej opcji (CLI oddaje go modelowi).
 */
export interface HookAnswerAnnotation {
  readonly notes: string;
  readonly preview?: string;
}

/** Notatki pliku: DOSŁOWNA treść pytania → notatka. */
export type HookAnswerAnnotations = Readonly<Record<string, HookAnswerAnnotation>>;

/** Kanał odpowiedzi widziany przez driver — trzy czynności, zero wiedzy o `dataDir`. */
export interface HookAnswerChannel {
  /**
   * Zapisuje odpowiedź. Zwraca ŚCIEŻKĘ pliku (do obserwowania i sprzątania) albo `null`, gdy
   * zapis się nie udał lub kanał jest zamknięty — wołający wraca wtedy na tor cyfry (bez
   * notatek) albo odmawia (z notatkami: notatka nie spada do cyfry).
   */
  write(
    engineSessionId: string, key: string, answers: Readonly<Record<string, string>>,
    annotations?: HookAnswerAnnotations | null,
  ): string | null;
  /** Czy plik WCIĄŻ tam leży? `false` = hook go zużył. */
  pending(path: string): boolean;
  /** Kasuje niezużyty plik — żeby nie odpowiedział na NASTĘPNE pytanie. */
  clear(path: string): void;
}

/** Ścieżka pliku odpowiedzi. `null`, gdy sesja albo klucz nie nadają się na nazwę pliku. */
export function hookAnswerPath(
  dataDir: string, engineSessionId: string, key: string,
): string | null {
  if (!ENGINE_SESSION_ID_PATTERN.test(engineSessionId)) return null;
  if (!ANSWER_KEY_PATTERN.test(key)) return null;
  return join(dataDir, HOOK_ANSWERS_DIRNAME, engineSessionId, `${key}.json`);
}

/**
 * Zapis atomowy odpowiedzi: tmp w TYM SAMYM katalogu + `rename`. Tmp ma losowy sufiks i `flag: 'wx'`:
 * dowiązanie pod przewidywalną nazwą `<plik>.<pid>.tmp` przekierowywało zapis, a `rename` stawiało je w miejscu
 * pliku odpowiedzi. Istniejąca nazwa, także dowiązanie, to teraz błąd zapisu (`null`), nie zapis za nią.
 *
 * Hook czyta ten plik w cudzym procesie co 250 ms i nie ma prawa zobaczyć połowy zapisu —
 * pół JSON-a parsuje się na wyjątek, czyli w najlepszym razie kosztowałoby jeden obrót
 * pollingu, ale przy złym cięciu mogłoby dać poprawny JSON z niepełną mapą odpowiedzi.
 *
 * `key` jedzie do środka pliku, a nie tylko do jego nazwy: hook porównuje OBA, więc plik
 * przeniesiony (albo podrzucony) pod cudzą nazwę nie zadziała.
 *
 * `annotations` jadą wyłącznie, gdy są: plik bez notatek nie ma tego pola,
 * więc starsza kopia hooka i CLI sprzed 2.1.288 czytają go bez zmian.
 *
 * @returns ścieżka zapisanego pliku albo `null` przy dowolnym niepowodzeniu
 */
export function writeHookAnswer(
  dataDir: string,
  engineSessionId: string,
  key: string,
  answers: Readonly<Record<string, string>>,
  now: () => number = Date.now,
  annotations: HookAnswerAnnotations | null = null,
): string | null {
  const file = hookAnswerPath(dataDir, engineSessionId, key);
  if (file === null) return null;
  const noted = annotations !== null && Object.keys(annotations).length > 0;
  const body = `${JSON.stringify({
    sessionId: engineSessionId, key, at: now(), answers, ...(noted ? { annotations } : {}),
  })}\n`;
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    mkdirSync(join(dataDir, HOOK_ANSWERS_DIRNAME, engineSessionId), {
      recursive: true, mode: 0o700,
    });
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return file;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort — tmp bez `rename` i tak nie jest przez nikogo czytany.
    }
    return null;
  }
}

/** Czy plik odpowiedzi wciąż leży (czyli hook go NIE zużył)? Błąd odczytu = „nie leży". */
export function hookAnswerPending(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Kasuje plik odpowiedzi. Brak pliku to normalny stan (hook go zużył), nie błąd. */
export function clearHookAnswer(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Brak pliku / brak praw — żniwiarz startu i tak go zamiecie.
  }
}

/**
 * ŻNIWIARZ katalogu odpowiedzi — wzorem `sweepPendingHooks`, z tego samego powodu.
 *
 * Rarog kasuje swój plik na obu ścieżkach (hook go zużył albo Rarog go wycofał), ale nie ma
 * gwarancji, że dożyje tej chwili: SIGTERM w środku czekania zostawia plik z treścią
 * odpowiedzi człowieka na dysku. Start serwera jest jedynym momentem, w którym mamy pewność,
 * że nikt tych plików nie czyta.
 *
 * Wiek liczymy z `mtime`, nie z pola `at`: plik zepsuty albo obcy też ma zniknąć. Puste
 * katalogi sesji zdejmujemy przy okazji — inaczej `answers/` rosłoby o jeden katalog na sesję
 * na zawsze. Każdy błąd połknięty per plik: sprzątanie nie ma prawa wywrócić startu.
 *
 * @returns liczba skasowanych plików (do logu startu)
 */
export function sweepHookAnswers(dataDir: string, now: () => number = Date.now): number {
  const root = join(dataDir, HOOK_ANSWERS_DIRNAME);
  let sessions: string[];
  try {
    sessions = readdirSync(root);
  } catch {
    // Katalogu nie ma — kanał nigdy nie ruszył albo `dataDir` dopiero powstaje.
    return 0;
  }
  const at = now();
  let removed = 0;
  for (const session of sessions) {
    const dir = join(root, session);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const path = join(dir, name);
        if (at - statSync(path).mtimeMs <= HOOK_ANSWER_TTL_MS) continue;
        unlinkSync(path);
        removed += 1;
      } catch {
        // Znikający plik / brak praw — następny start spróbuje jeszcze raz.
      }
    }
    try {
      rmdirSync(dir);
    } catch {
      // Katalog niepusty (żywa sesja) albo brak praw — zostaje do następnego razu.
    }
  }
  return removed;
}

/**
 * Kanał dla drivera, związany z jednym `dataDir`.
 *
 * @param canWrite bramka killswitcha. Kanał OMIJA klienta herdr (pisze plik, nie klawisz), więc
 *        `RAROG_HERDR_SEND=0` musi wyciąć go U ŹRÓDŁA — inaczej „widzę, nie ruszam" przestałoby
 *        obowiązywać akurat dla odpowiedzi na pytania (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 18). Zamknięta bramka = `null`, czyli
 *        driver wraca na tor cyfry i to KLIENT herdr odmawia zapisu ze swoim komunikatem.
 */
export function createHookAnswerChannel(
  dataDir: string, canWrite: () => boolean = (): boolean => true,
): HookAnswerChannel {
  return {
    write: (engineSessionId, key, answers, annotations = null): string | null => (canWrite()
      ? writeHookAnswer(dataDir, engineSessionId, key, answers, Date.now, annotations)
      : null),
    pending: hookAnswerPending,
    clear: clearHookAnswer,
  };
}
