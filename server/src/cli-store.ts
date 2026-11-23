/**
 * Adresowanie magazynu CLI: gdzie leży katalog transkryptów i jak nazywa się katalog projektu.
 *
 * Moduł jest CELOWO malutki i celowo bez logiki czytania. Treść transkryptów Rarog bierze
 * z oficjalnego API (`session-list.ts` → `listSessions()`), ale kilka miejsc potrzebuje samej
 * ŚCIEŻKI, bo pracują na pliku, a nie na liście: `jsonl-follow.ts` śledzi plik żywej sesji,
 * `transcript-import.ts` czyta jego ogon, `transcript-path.ts` szuka pliku po UUID,
 * `session-pulse.ts` pilnuje mtime, a `fs-browse.ts` odpowiada na pytanie „czy ten katalog ma
 * historię". Żadna z tych rzeczy nie ma odpowiednika w API — ono listuje sesje, nie oddaje
 * ścieżek.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Domyślny korzeń magazynu CLI. */
export function defaultStoreRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Ścieżka projektu → nazwa katalogu w magazynie CLI.
 *
 * Reguła z docs `sessions.md`, „Where transcripts are stored”: katalog projektu to ścieżka katalogu
 * roboczego z każdym znakiem niealfanumerycznym zamienionym na `-`. Funkcja zostawia tylko
 * `[A-Za-z0-9-]`, więc spacje i znaki diakrytyczne też dają `-`.
 *
 * Odwzorowanie jest STRATNE i musi takie zostać — to format cudzego magazynu, nie nasz wybór.
 * `/Users/u/Projects/stare` i `/Users/u/Projects-stare` dają ten sam katalog, więc sam slug
 * NIE jest dowodem przynależności pliku do projektu.
 *
 * Znana granica: dla katalogu, którego nazwa po zamianie przekracza 200 znaków, CLI ucina ją
 * do 200 i dokleja hash pełnej ścieżki (docs `sessions.md`, „Where transcripts are stored”).
 * Tego przypadku ta funkcja NIE odwzorowuje — i nie musi, bo jej czytelnicy
 * albo mają cofkę (`transcript-path.ts` przeszukuje korzeń po pudle), albo pytanie zadają miękko
 * (`fs-browse.ts`: „historia" to podpowiedź, nie kontrakt). Listy sesji ta granica nie dotyczy
 * w ogóle — listę oddaje API (`session-list.ts`), nie ta funkcja.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}
