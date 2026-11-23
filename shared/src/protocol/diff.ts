/**
 * Protocol contract, diff area: session diff, change list and the patch of one file.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Git: diff sesji
// ---------------------------------------------------------------------------

/**
 * Limit ciała patcha w `GET /api/sessions/:id/diff`.
 *
 * 512 kB to granica, po której overlay z patchem przestaje być czytelny na telefonie,
 * a nie granica wydajności serwera — dalej odcinamy i ustawiamy `truncated`.
 */
export const MAX_DIFF_PATCH_BYTES = 512 * 1024;

/**
 * Status pliku w diffie. Świadomie tylko trzy litery: rename/copy z gita mapujemy
 * na `M`/`A`, bo overlay pokazuje jeden patch, a nie graf zmian nazw.
 */
export type DiffFileStatus = 'A' | 'M' | 'D';

export const diffFileStatusSchema = z.enum(['A', 'M', 'D']);

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  linesAdded: number;
  linesDeleted: number;
}

export const diffFileSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  linesAdded: z.number(),
  linesDeleted: z.number(),
});

/** Odpowiedź `GET /api/sessions/:id/diff` — `git diff HEAD` + `--numstat`. */
export interface SessionDiff {
  files: DiffFile[];
  patch: string;
  /** `true`, gdy patch przekroczył `MAX_DIFF_PATCH_BYTES` i został ucięty. */
  truncated: boolean;
}

export const sessionDiffSchema = z.object({
  files: z.array(diffFileSchema),
  patch: z.string(),
  truncated: z.boolean(),
});

type _DiffFileSchemaMatchesType = z.infer<typeof diffFileSchema> extends DiffFile ? true : never;
type _DiffFileTypeMatchesSchema = DiffFile extends z.infer<typeof diffFileSchema> ? true : never;
type _DiffSchemaMatchesType = z.infer<typeof sessionDiffSchema> extends SessionDiff ? true : never;
type _DiffTypeMatchesSchema = SessionDiff extends z.infer<typeof sessionDiffSchema> ? true : never;
const _diffFileSchemaMatchesType: _DiffFileSchemaMatchesType = true;
const _diffFileTypeMatchesSchema: _DiffFileTypeMatchesSchema = true;
const _diffSchemaMatchesType: _DiffSchemaMatchesType = true;
const _diffTypeMatchesSchema: _DiffTypeMatchesSchema = true;
void _diffFileSchemaMatchesType;
void _diffFileTypeMatchesSchema;
void _diffSchemaMatchesType;
void _diffTypeMatchesSchema;

// ---------------------------------------------------------------------------
// Git: diff sesji per plik — lista zmian i patch jednego pliku
// ---------------------------------------------------------------------------

/**
 * Pozycja listy zmian (`GET /api/sessions/:id/diff/files`).
 *
 * Liczniki są OPCJONALNE i brak znaczy „nie wiem", nie zero: mają je tylko pliki śledzone i tylko
 * wtedy, gdy `git diff --numstat` zmieścił się w swoim budżecie czasu — lista na niego nie czeka.
 * `binary: true` = git nie liczy linii tego pliku, więc liczników nie ma. Plik nieśledzony nie ma
 * żadnego z tych pól (klient liczy bilans z patcha, gdy go pobierze).
 */
export interface DiffListEntry {
  /** Ścieżka względem katalogu sesji, dokładnie taka, jaką wypisał git (`-z`, bez cytowania). */
  path: string;
  status: DiffFileStatus;
  linesAdded?: number;
  linesDeleted?: number;
  binary?: true;
}

export const diffListEntrySchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  linesAdded: z.number().int().nonnegative().optional(),
  linesDeleted: z.number().int().nonnegative().optional(),
  binary: z.literal(true).optional(),
});

/**
 * Odpowiedź `GET /api/sessions/:id/diff/files` — pliki śledzone w kolejności gita, potem
 * nieśledzone. `truncated: true` = lista ucięta na suficie serwera (`MAX_DIFF_LIST_FILES`);
 * plik spoza uciętej listy dalej da się pobrać po ścieżce.
 */
export interface DiffFileList {
  files: DiffListEntry[];
  truncated: boolean;
}

export const diffFileListSchema = z.object({
  files: z.array(diffListEntrySchema),
  truncated: z.boolean(),
});

/**
 * Odpowiedź `GET /api/sessions/:id/diff/file?path=…` — patch JEDNEGO pliku. Bywa w nim więcej
 * niż jeden blok `diff --git` (zmiana typu pliku), a `path` to ścieżka z żądania, nie wynik
 * rozbioru patcha. `truncated: true` = patch tego pliku ucięty na granicy linii
 * (`MAX_DIFF_FILE_PATCH_BYTES`) albo git doszedł do sufitu odczytu.
 */
export interface DiffFilePatch {
  path: string;
  patch: string;
  truncated: boolean;
}

export const diffFilePatchSchema = z.object({
  path: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
});

/*
 * Kody błędów tras diffa per plik (pole `error` ciała 4xx/5xx). Klient rozróżnia po nich
 * przypadki, których sam status nie rozdziela: oba 404 („lista się zmieniła" kontra „nie ma
 * sesji") i 404 `not-found` routera, czyli serwer sprzed tych tras. Wpis Codexa i sesja poza
 * zasięgiem dostają 400 `bad-request` ze zdaniem managera.
 */
/** 400: `path` nie przeszedł walidacji wstępnej (pusty, bezwzględny, z `..`, zakończony `/`…). */
export const DIFF_BAD_PATH_ERROR = 'bad-path';
/** 404: pliku nie ma na liście zmian, którą git wypisał w tym żądaniu — klient odświeża listę. */
export const DIFF_FILE_NOT_FOUND_ERROR = 'diff-file-not-found';
/** 404: nie ma takiej sesji. Osobny od `not-found` routera („nie ma takiego endpointu"). */
export const DIFF_SESSION_NOT_FOUND_ERROR = 'session-not-found';
/** 503: git nie zdążył albo nie wystartował — klient pokazuje „Spróbuj ponownie". */
export const DIFF_GIT_FAILED_ERROR = 'git-failed';

type _DiffListEntrySchemaMatchesType =
  z.infer<typeof diffListEntrySchema> extends DiffListEntry ? true : never;
type _DiffListEntryTypeMatchesSchema =
  DiffListEntry extends z.infer<typeof diffListEntrySchema> ? true : never;
type _DiffFileListSchemaMatchesType =
  z.infer<typeof diffFileListSchema> extends DiffFileList ? true : never;
type _DiffFileListTypeMatchesSchema =
  DiffFileList extends z.infer<typeof diffFileListSchema> ? true : never;
type _DiffFilePatchSchemaMatchesType =
  z.infer<typeof diffFilePatchSchema> extends DiffFilePatch ? true : never;
type _DiffFilePatchTypeMatchesSchema =
  DiffFilePatch extends z.infer<typeof diffFilePatchSchema> ? true : never;
const _diffListEntrySchemaMatchesType: _DiffListEntrySchemaMatchesType = true;
const _diffListEntryTypeMatchesSchema: _DiffListEntryTypeMatchesSchema = true;
const _diffFileListSchemaMatchesType: _DiffFileListSchemaMatchesType = true;
const _diffFileListTypeMatchesSchema: _DiffFileListTypeMatchesSchema = true;
const _diffFilePatchSchemaMatchesType: _DiffFilePatchSchemaMatchesType = true;
const _diffFilePatchTypeMatchesSchema: _DiffFilePatchTypeMatchesSchema = true;
void _diffListEntrySchemaMatchesType;
void _diffListEntryTypeMatchesSchema;
void _diffFileListSchemaMatchesType;
void _diffFileListTypeMatchesSchema;
void _diffFilePatchSchemaMatchesType;
void _diffFilePatchTypeMatchesSchema;
