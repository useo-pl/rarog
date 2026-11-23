/**
 * Protocol contract, git area: the last commit, dirty files by kind and the per-file detail of a session's directory.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/**
 * Ostatni commit gałęzi (`git log -1`) — wiersz „ostatni commit" w rozwinięciu gita.
 *
 * `at` to czas COMMITERA w ISO (`%ct`), nie autora: to on mówi, kiedy commit faktycznie
 * wylądował w repozytorium (rebase i cherry-pick przesuwają go, czas autora zostaje stary).
 */
export interface GitCommit {
  /** Skrót SHA (`%h`, zwykle 7–12 znaków). */
  hash: string;
  /** Pierwsza linia wiadomości (`%s`). */
  subject: string;
  at: string;
}

/**
 * Brudne pliki katalogu ROZBITE NA RODZAJE — źródło trójki `+3 ~5 −1` w nagłówku sesji.
 *
 * Liczymy PLIKI, nie linie: z `git status --porcelain=v2` (`?` i `A` to dodane, `D` usunięte,
 * resztę — w tym rename, typechange i konflikt — liczymy jako zmienione). Suma trójki jest
 * zawsze równa `dirtyCount`, bo każdy brudny wpis wpada do dokładnie jednej szufladki.
 */
export interface GitFileKinds {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * Jeden brudny plik z rodzajem zmiany i licznikami linii — wiersz listy „zmiany w katalogu".
 *
 * `kind` to ta sama szufladka, do której plik wpada w trójce {@link GitFileKinds}. Liczniki
 * są PER PLIK i opcjonalne: brak znaczy „nie wiem", a nie zero. `binary: true` = git nie liczy
 * linii tego pliku, więc liczników nie ma. Pełny diff dalej daje wyłącznie
 * `GET /api/sessions/:id/diff`.
 */
export interface GitFileDetail {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  linesAdded?: number;
  linesDeleted?: number;
  binary?: boolean;
}

export const gitCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  at: z.string(),
});

export const gitFileKindsSchema = z.object({
  added: z.number(),
  modified: z.number(),
  deleted: z.number(),
});

export const gitFileDetailSchema = z.object({
  path: z.string(),
  kind: z.enum(['added', 'modified', 'deleted']),
  linesAdded: z.number().int().nonnegative().optional(),
  linesDeleted: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
});
