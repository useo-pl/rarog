/**
 * Protocol contract, directory browser area: `GET /api/fs?path=…` and `POST /api/fs/mkdir`.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Przeglądarka katalogów — `GET /api/fs?path=…`
// ---------------------------------------------------------------------------

/** Sufit listingu jednego katalogu; powyżej `truncated: true` (UI każe zawęzić filtrem). */
export const MAX_DIR_ENTRIES = 300;

export interface DirEntry {
  name: string;
  /** Ścieżka absolutna (serwer) — dokładnie to, co idzie potem w `cwd`. */
  path: string;
  /** Katalog ma `.git` (repo) — UI pokazuje znacznik. */
  git: boolean;
  /** W `~/.claude/projects/<slug>` leżą transkrypty CLI dla tego katalogu. */
  history: boolean;
}

/**
 * Listing katalogu. `path: null` = poziom korzeni (`RAROG_PROJECT_ROOTS`): `entries` to
 * korzenie, `parent` nie istnieje. Dla katalogu będącego korzeniem `parent` jest `null`
 * (cofnięcie wraca na poziom korzeni), dla głębszych — ścieżka katalogu nadrzędnego.
 *
 * `git` and `history` describe the listed directory itself, with the meaning of the same fields of
 * {@link DirEntry}. The server sends both with every listing of a directory and neither on the roots level; a
 * listing without them (an older server) leaves them unknown, and the app treats the directory as unknown.
 */
export interface DirListing {
  path: string | null;
  parent: string | null;
  git?: boolean;
  history?: boolean;
  /**
   * Whether this server creates directories (`POST /api/fs/mkdir`): sent with every listing of a directory, never on
   * the roots level. A hint for the button only; the route checks everything again. A missing field (an older
   * server) means no.
   */
  canCreate?: boolean;
  entries: DirEntry[];
  truncated: boolean;
}

export const dirEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  git: z.boolean(),
  history: z.boolean(),
});

export const dirListingSchema = z.object({
  path: z.string().nullable(),
  parent: z.string().nullable(),
  git: z.boolean().optional(),
  history: z.boolean().optional(),
  canCreate: z.boolean().optional(),
  entries: z.array(dirEntrySchema).max(MAX_DIR_ENTRIES),
  truncated: z.boolean(),
});

/**
 * `POST /api/fs/mkdir`: the listed directory `parent` (a `path` of a listing) and the name of the new directory in it.
 * The schema checks the shape only, with ceilings well above any real path and name, so that an empty, long or
 * malformed name gets the name refusal of the server (`dir-name-invalid`) and not `bad-request`. The answer 200 is the
 * new row as a {@link DirEntry}.
 */
export const makeDirBodySchema = z.strictObject({
  parent: z.string().max(4_096),
  name: z.string().max(1_024),
});
export type MakeDirBody = z.infer<typeof makeDirBodySchema>;

type _DirEntrySchemaMatchesType = z.infer<typeof dirEntrySchema> extends DirEntry ? true : never;
type _DirEntryTypeMatchesSchema = DirEntry extends z.infer<typeof dirEntrySchema> ? true : never;
type _DirListingSchemaMatchesType = z.infer<typeof dirListingSchema> extends DirListing ? true : never;
type _DirListingTypeMatchesSchema = DirListing extends z.infer<typeof dirListingSchema> ? true : never;

const _dirEntrySchemaMatchesType: _DirEntrySchemaMatchesType = true;
const _dirEntryTypeMatchesSchema: _DirEntryTypeMatchesSchema = true;
const _dirListingSchemaMatchesType: _DirListingSchemaMatchesType = true;
const _dirListingTypeMatchesSchema: _DirListingTypeMatchesSchema = true;

void _dirEntrySchemaMatchesType;
void _dirEntryTypeMatchesSchema;
void _dirListingSchemaMatchesType;
void _dirListingTypeMatchesSchema;
