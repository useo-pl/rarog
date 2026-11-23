/**
 * Terminal PTY — DECYZJE cyklu życia jako czyste funkcje.
 *
 * Ten moduł nie dotyka ani dysku, ani procesów, ani gniazd. Wszystko, co tu stoi, da się
 * sprawdzić testem jednostkowym bez herdr — a `registry.ts` i `ws.ts` mają być tylko rękami,
 * które te decyzje wykonują. Powód jest praktyczny: bezpiecznik respawnu i żniwiarz to logika,
 * której NIE da się wyklikać na żywo (trzeba by czekać tydzień albo wywrócić kontroler panelu
 * trzy razy pod rząd).
 */
import { createHash } from 'node:crypto';
import { isPopupRole, TERM_ID_LENGTH, TERM_ROLES, TERM_SLOTS_MAX } from '@rarog/shared';
import type { TermRole } from '@rarog/shared';
import { parsePaneLabel } from '../herdr/provenance.ts';

/**
 * Tożsamość terminala: `sha256(realpath(cwd))` (slot 1) albo `sha256(realpath(cwd) + NUL + N)`
 * (slot N ≥ 2), skrócony do 16 hex.
 *
 * Świadomie NIE slug z `cli-store.ts` — tamten jest STRATNY z własnej deklaracji
 * (`~/Projects/stare` i `~/Projects-stare` dają ten sam slug), a tu kolizja znaczyłaby
 * „powłoka w cudzym katalogu". Wejściem MUSI być ścieżka po `realpath`: dwie różne drogi
 * do tego samego katalogu mają dać jedną sesję (idempotencja `POST /api/term`).
 *
 * **Rozdzielaczem jest bajt NUL (`\u0000`), a NIE `#`.**
 * `#` jest zwykłym, DOZWOLONYM znakiem ścieżki POSIX, więc materiał hasha byłby niejednoznaczny:
 * `termIdFor('/p/foo', 2)` i `termIdFor('/p/foo#2', 1)` dawałyby to samo `18eca2443f94c1b6`.
 * Skutkiem byłaby dokładnie ta kolizja, którą ten docstring odrzuca akapit wyżej:
 * `POST /api/term` na katalog `foo#2` trafiałby w istniejący wpis rejestru `('/p/foo', 2)`
 * i oddawał powłokę w CUDZYM katalogu, a bramka własności (`token rarog-term === id`)
 * przepuszczałaby na ten panel attach, kill i odczyt historii. NUL nie może wystąpić w ścieżce
 * POSIX (kończy string w jądrze), więc rozbicie materiału na `(ścieżka, slot)` jest jednoznaczne.
 *
 * **Slot 1 liczy się DOKŁADNIE tak jak przed wprowadzeniem slotów** (bez sufiksu) i to nie
 * jest kosmetyka: te same wartości siedzą dziś w tokenach `rarog-term` żywych paneli herdr,
 * i w kluczach `term-herdr.json`. Sufiks dla
 * slotu 1 wymusiłby migrację obu naraz — i po restarcie Raroga adopcja nie
 * poznałaby ani jednego istniejącego terminala. Rozdzielacz dotyka wyłącznie slotów ≥ 2.
 *
 * **Role popupowe (`lazygit`, `popup` — {@link isPopupRole}) liczą się z materiału
 * `<ścieżka>NUL<nazwa roli>` i IGNORUJĄ slot.** Powód jest ten sam co przy slocie 1:
 * identyfikatory slotów 1…`TERM_SLOTS_MAX` mają zostać bajt w bajt takie, jakie są (tokeny
 * `rarog-term` żywych paneli, klucze `term-herdr.json`, trasy `#/terminal/<id>` zapisane
 * w dawnej PWA), więc panel popupowy nie może ani wejść w numerowaną przestrzeń slotów, ani jej
 * przesunąć. Kolizja jest przy tym niemożliwa z KSZTAŁTU materiału: po bajcie NUL stoi w nim
 * albo zapis liczby (slot), albo nazwa roli — nigdy jedno i drugie. Dwie role popupowe też się
 * nie zderzą, bo nazwa roli wchodzi do materiału DOSŁOWNIE: `lazygit` i `popup` tego samego
 * katalogu to dwa różne panele, które wolno mieć naraz.
 */
export function termIdFor(realCwd: string, slot = 1, role: TermRole = 'shell'): string {
  const material = isPopupRole(role)
    ? `${realCwd}\u0000${role}`
    : (slot <= 1 ? realCwd : `${realCwd}\u0000${String(slot)}`);
  return createHash('sha256').update(material).digest('hex').slice(0, TERM_ID_LENGTH);
}

/** Tożsamość terminala rozpoznana dla konkretnego katalogu: slot (0 dla ról popupowych) i rola. */
export interface TermIdentity {
  readonly id: string;
  readonly slot: number;
  readonly role: TermRole;
}

/**
 * Czy `id` jest tożsamością terminala TEGO katalogu — a jeśli tak, to którego slotu albo roli.
 *
 * Hash jest jednokierunkowy, więc jedyną drogą jest próba każdego kandydata: sloty
 * 1…`TERM_SLOTS_MAX` (rola `shell`), potem każda rola popupowa (slot 0). To jest zarazem DOWÓD
 * (identyfikator musi być hashem tej właśnie ścieżki) i odczyt numeru taba — jedno pytanie
 * adopcji po restarcie Raroga (`term/index.ts`). `realCwd` MUSI być po `realpath`.
 */
export function matchTermId(id: string, realCwd: string): TermIdentity | null {
  for (let slot = 1; slot <= TERM_SLOTS_MAX; slot += 1) {
    if (id === termIdFor(realCwd, slot)) return { id, slot, role: 'shell' };
  }
  for (const role of TERM_ROLES) {
    if (!isPopupRole(role)) continue;
    if (id === termIdFor(realCwd, 0, role)) return { id, slot: 0, role };
  }
  return null;
}

/**
 * Etykieta PANELU (`rarog-term <id>`) → tożsamość terminala TEGO katalogu albo `null`.
 *
 * `null` dla etykiety spoza wzorca (`parsePaneLabel`), etykiety panelu Claude i identyfikatora,
 * który nie jest hashem tej ścieżki przy żadnym slocie ani roli. Czysta: czyta tylko napis
 * i ścieżkę, niczego nie rozwiązuje na dysku.
 */
export function matchTermLabel(label: string | null | undefined, realCwd: string): TermIdentity | null {
  const provenance = parsePaneLabel(label);
  if (provenance?.kind !== 'term') return null;
  return matchTermId(provenance.value, realCwd);
}

// ---------------------------------------------------------------------------
// Karencja i bezpiecznik respawnu
// ---------------------------------------------------------------------------

/**
 * Ile czekamy po zamknięciu OSTATNIEGO gniazda, zanim zabijemy klienta PTY.
 *
 * Zabijamy wyłącznie KONTROLER panelu — powłoka w herdr żyje dalej, więc karencja nie chroni
 * pracy, tylko oszczędza pełny reattach przy typowym rekonekcie z iOS (zgaszony ekran,
 * przełączona apka).
 *
 * 120 s, nie 10 s: zwolnienie kontrolera
 * to dla herdr powrót panelu do WŁASNEGO rozmiaru, a ponowne wejście — rozmiar klienta; każda
 * taka para to SIGWINCH i przerysowanie promptu przez p10k, czyli „schodki" starych promptów
 * w historii. Przy skakaniu po tabach slotów (codzienny ruch) 10 s zwalniałoby
 * kontroler między każdą parą przełączeń i schodki rosłyby z każdym tapnięciem. 120 s trzyma
 * kontrolery żywe przez całą sesję skakania; kosztem jest panel na Macu stojący w rozmiarze
 * telefonu do 2 min po wyjściu — świadomie tańszy niż zaśmiecona historia każdej powłoki.
 *
 * Sam `terminal.release` herdr zdejmuje blokadę rozmiaru bez przeliczenia, więc panel stałby
 * w rozmiarze telefonu do pierwszego klienta herdr na tym tabie (zmierzone do +11 min). Powrót do
 * WŁASNEGO rozmiaru daje dopiero zwolnienie po karencji
 * z `restoreSize` (`registry.ts`, `herdr-backend.ts`). Przywrócenie czeka na koniec karencji,
 * a nie idzie przy odejściu gniazda — z tego samego powodu co 120 s: para SIGWINCH na każdy
 * przeskok między tabami.
 */
export const TERM_GRACE_MS = 120_000;

/** Okno, w którym liczymy pady PTY dla bezpiecznika respawnu. */
export const TERM_RESPAWN_WINDOW_MS = 30_000;

/** Ile padów w oknie kładzie terminal w stan `failed`. */
export const TERM_RESPAWN_LIMIT = 3;

/**
 * Dopisuje pad do historii i przycina ją do okna.
 *
 * Zwraca NOWĄ tablicę (wejście nietknięte): historia jest własnością wpisu w rejestrze,
 * a decyzja o niej — tego modułu.
 */
export function recordCrash(history: readonly number[], nowMs: number): number[] {
  return [...history, nowMs].filter((at) => nowMs - at < TERM_RESPAWN_WINDOW_MS);
}

/**
 * Czy bezpiecznik zadziałał — trzy pady w oknie 30 s.
 *
 * Bez niego klient z backoffem młóciłby spawn w nieskończoność, gdy backend odmawia TRWALE
 * (brak binarki herdr po aktualizacji, martwe gniazdo herdr, pełny dysk). `failed` kasuje wyłącznie
 * ręczny `POST /api/term` albo restart Raroga — czyli decyzja człowieka, nie pętla klienta.
 */
export function isBreakerTripped(history: readonly number[]): boolean {
  return history.length >= TERM_RESPAWN_LIMIT;
}

// ---------------------------------------------------------------------------
// Keepalive i backpressure
// ---------------------------------------------------------------------------

/**
 * `ws.ping` interval. It keeps the proxy (Caddy) and iOS from closing an idle socket, and a socket with no pong by
 * the next ping is terminated. Its own rhythm, independent of the SSE heartbeat: nothing in the app waits on it.
 *
 * Bez pingu półotwarte gniazdo po zabitym kliencie trzymałoby kontroler bez końca: warunek „ostatni WS
 * zamknięty" nigdy by nie padł, więc karencja nigdy by nie wystartowała.
 */
export const TERM_PING_MS = 25_000;

/** Sufit `bufferedAmount` JEDNEGO gniazda, po którym zrywamy TO gniazdo. */
export const TERM_SOCKET_BUFFER_LIMIT_BYTES = 256 * 1024;

/** Sufit ramki WS po stronie biblioteki — dwa razy limit `in`, żeby limit egzekwował KOD. */
export const TERM_WS_MAX_PAYLOAD_BYTES = 16 * 1024;

/** Gniazdo ponad sufitem bufora: zrywamy je, klient wróci reconnectem i dostanie odmalowanie. */
export function shouldTerminateSocket(bufferedAmount: number): boolean {
  return bufferedAmount > TERM_SOCKET_BUFFER_LIMIT_BYTES;
}

/**
 * Czy wstrzymać CZYTANIE z powłoki — polityka SSE, nie pauza zbiorowa.
 *
 * Pauzujemy wyłącznie, gdy WSZYSTKIE gniazda są nad progiem albo nie ma żadnego. Wolny
 * telefon nie ma prawa zatrzymać szybkiego, a RAM procesu nie ma prawa rosnąć bez granicy,
 * gdy nikt nie słucha.
 */
export function shouldPausePty(bufferedAmounts: readonly number[]): boolean {
  if (bufferedAmounts.length === 0) return true;
  return bufferedAmounts.every((amount) => shouldTerminateSocket(amount));
}

// ---------------------------------------------------------------------------
// Żniwiarz bezczynności
// ---------------------------------------------------------------------------

/** Powłoka oceniana przez żniwiarza — kształt niezależny od backendu. */
export interface TermReapCandidate {
  /**
   * Czy backend przyznaje, że to powłoka Raroga (herdr: token `rarog-term` panelu). Cudzy
   * panel w herdr ma tu `false` i nie jest nigdy zabijany.
   */
  readonly owned: boolean;
  /** Sekundy uniksowe ostatniej aktywności. */
  readonly activityEpochSec: number;
  /** Czy backend widzi podłączonego klienta. */
  readonly attached: boolean;
}

/**
 * Czy powłoka podlega żniwom.
 *
 * Trzy warunki naraz: powłoka Raroga, ZERO podłączonych klientów i cisza dłuższa niż
 * `RAROG_TERM_IDLE_DAYS`. Świadomy kompromis zapisany wprost: sesja z długo działającym,
 * milczącym procesem też podlega żniwom po tygodniu — kto trzyma tygodniowy proces, trzyma
 * go poza Rarogiem albo podnosi limit.
 */
export function shouldReap(
  session: TermReapCandidate, nowMs: number, idleDays: number,
): boolean {
  if (!session.owned) return false;
  if (session.attached) return false;
  const idleMs = nowMs - session.activityEpochSec * 1000;
  return idleMs >= idleDays * 24 * 3600 * 1000;
}
