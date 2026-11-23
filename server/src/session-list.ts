/**
 * Lista sesji silnika — czytana OFICJALNYM API Claude Code, nie parsowaniem magazynu.
 *
 * Rarog nie ma tu własnego czytnika plików `~/.claude/projects/**\/*.jsonl`.
 * Dokumentacja CLI mówi o tym formacie wprost (docs `sessions.md`,
 * „Where transcripts are stored”): „the entry format is internal to Claude Code and
 * changes between versions, so scripts that parse these files directly can break on any release. To
 * build on session data, use `/export` or the script interfaces instead". Interfejsem jest
 * `listSessions()` z `@anthropic-ai/claude-agent-sdk`.
 *
 * What the API handles that an own reader would have to (SDK 0.3.247, store of 1169 files / 3.0 GB):
 * - the store rules from the docs (the same section: shortening of directory names over 200 characters,
 *   `CLAUDE_CONFIG_DIR`),
 * - `summary` is the title per the docs (`agent-sdk/typescript.md`, `SDKSessionInfo`): custom title,
 *   last prompt, summary or first prompt, so the row title is not a raw first sentence,
 * - no scan window: a reader of a fixed 512 kB from the start of the file loses both the message count and
 *   the prompt in large transcripts,
 * - `includeProgrammatic: false` filters out sessions of hooks and SDK clients with one field instead of
 *   a hand-made deny list over `promptSource` and `entrypoint` (option from the package types 0.3.247,
 *   `ListSessionsOptions`; the docs do not describe it).
 *
 * **Z tego pakietu wolno importować WYŁĄCZNIE `listSessions`.** `query()` — czyli prowadzenie
 * rozmowy — wymaga poświadczeń i kosztuje tokeny, a Rarog jest klientem herdr, nie drugim
 * silnikiem. Granicy pilnuje test `server/test/sdk-boundary.test.ts`.
 *
 * Pakietu ten moduł nie importuje: funkcję `listSessions` ładuje raz przy starcie serwera `install/sdk.ts`
 * (`loadListSessions`: workspace w klonie repo, `<katalog danych>/sdk/<wersja>/` w paczce npm) i podaje ją
 * {@link engineListerOf}. Błąd ładowania SDK liczy się tam (pole `sdk` w `/health`), a nie jako pusta lista tutaj.
 */
import { MAX_FIRST_PROMPT_LENGTH } from '@rarog/shared';
import type { ResumableSession } from '@rarog/shared';
import type { ListSessionsFn } from './install/sdk.ts';

/** Jeden wpis listy sesji z API — tyle z `SDKSessionInfo`, ile czyta Rarog. */
export interface EngineSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  cwd?: string;
  firstPrompt?: string;
  gitBranch?: string;
}

/** Podmienialne wejście do API — testy i demo nie dotykają dysku ani SDK. */
export type EngineSessionLister = (
  opts: { dir?: string; limit?: number },
) => Promise<EngineSessionInfo[]>;

/**
 * Safety cap of a fetch, not a list length: lists of one directory pass their own smaller `limit`. A fetch with
 * `since` starts at the cap and widens past it, because that list is defined by time, not by count: the owner's
 * store held 1005 human sessions, 527 of them from the last 7 days (measured on SDK 0.3.247: the whole corpus in
 * about 0.6 s, 300 entries in about 0.2 s).
 */
export const ENGINE_SESSION_FETCH_CAP = 300;

/**
 * Obwódka wklejki z CLI ≥ 2.1.277 — API silnika oddaje ją w `firstPrompt` razem z treścią
 * (np. „[Image #1] <pasted_content id="636f"> Jak przewijam…"). Ten sam
 * artefakt zdejmuje z transkryptu `transcript-import.ts`; tu wchodzi innym wejściem.
 */
const PASTED_CONTENT_TAG = /<\/?pasted_content id="[0-9a-z]{1,32}">/g;

/** Przycina tytuł do limitu prezentacji (elipsa mieści się w limicie). */
export function clipPrompt(text: string, limit = MAX_FIRST_PROMPT_LENGTH): string {
  const normalized = text.replace(PASTED_CONTENT_TAG, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

/**
 * Wpis API → wpis kontraktu Raroga. `null`, gdy wpisu nie da się użyć.
 *
 * Odrzucamy wpis **bez `cwd`** — pole jest w API opcjonalne i pusto bywa CZĘSTO (SDK 0.3.247:
 * 18 z 190). Bez katalogu nie ma czego wznawiać ani czym zwalidować
 * allow-listy, więc taki wiersz byłby przyciskiem prowadzącym w 400.
 *
 * `title` niesie `summary`, a `firstPrompt` — pierwszy prompt, gdy API go zna, i przycięte
 * `summary`, gdy nie (kontrakt wymaga tego pola, API nie gwarantuje; brakowało go w 20 z 190).
 * `liveInHerdr` zostaje `false`: magazyn nie wie, co jest otwarte w terminalu — flagę podnosi
 * dopiero manager, który jako jedyny widzi żywe panele.
 */
export function toResumableSession(info: EngineSessionInfo): ResumableSession | null {
  const cwd = info.cwd ?? '';
  if (cwd === '') return null;
  const summary = clipPrompt(info.summary ?? '');
  const prompt = clipPrompt(info.firstPrompt ?? '');
  /*
   * Tytuł bierzemy ze streszczenia, a gdy go nie ma — z pierwszego promptu. Odrzucamy wpis
   * dopiero wtedy, gdy nie ma ANI JEDNEGO: sesja bez tytułu, ale z katalogiem, jest
   * najzupełniej wznawialna, a wiersz ma na taki przypadek własną etykietę
   * („Sesja bez pierwszej wiadomości"). Cichy odsiew ukrywałby ją przed obiema listami.
   */
  const title = summary !== '' ? summary : prompt;
  if (title === '') return null;
  const entry: ResumableSession = {
    engineSessionId: info.sessionId,
    cwd,
    mtime: new Date(info.lastModified).toISOString(),
    firstPrompt: prompt !== '' ? prompt : title,
    liveInHerdr: false,
    title,
  };
  // Gałąź przycinamy tym samym limitem co tytuł: git dopuszcza ~255 bajtów, a to jest wartość
  // spoza Raroga, która ląduje w jednej linii metadanych i w zdaniu dla czytnika ekranu.
  if (info.gitBranch !== undefined && info.gitBranch !== '') {
    entry.gitBranch = clipPrompt(info.gitBranch);
  }
  return entry;
}

/**
 * Session list reader; without `dir` it lists every project.
 *
 * `since` (epoch ms) asks for every session modified at or after that moment, newest first: the fetch cap does not cut
 * that list and `limit` is ignored. The API has no time filter, so the reader widens the fetch until it crosses the
 * boundary (recent projects, where most of the 300 newest sessions can lie outside the allow-list).
 */
export type SessionListReader = (
  opts: { dir?: string; limit?: number; since?: number },
) => Promise<ResumableSession[]>;

export interface SessionListOptions {
  /** Wejście do API: {@link engineListerOf} z funkcją załadowanego SDK; testy podają własne. */
  lister?: EngineSessionLister;
  /** Fetch cap without `since` and the first fetch with it. Defaults to `ENGINE_SESSION_FETCH_CAP`. */
  fetchCap?: number;
}

/**
 * Wejście do API z funkcji `listSessions` załadowanego SDK.
 *
 * `includeProgrammatic: false` jest tu WARUNKIEM UŻYTECZNOŚCI, nie strojeniem. Domyślne `true`
 * wpuszcza sesje hooków i klientów SDK — w SDK 0.3.247 94 ze 190
 * najświeższych wpisów to zapisy jednego hooka z identycznym tytułem. `SDKSessionInfo` nie niesie
 * pola, po którym dałoby się je odsiać samodzielnie (docs `agent-sdk/typescript.md`,
 * `SDKSessionInfo`: ani `entrypoint`, ani `promptSource`), więc bez tej opcji jedyną drogą byłoby
 * parsowanie jsonl. Docs opcji nie opisują; typy pakietu 0.3.247 mówią wprost:
 * „IDE session pickers pass `false` for parity with terminal `/resume`" — Rarog jest dokładnie
 * takim pickerem.
 */
export const engineListerOf = (listSessions: ListSessionsFn): EngineSessionLister => async (opts) => (
  listSessions({
    ...opts,
    includeProgrammatic: false,
    /*
     * `includeWorktrees` domyślnie WPUSZCZA sesje z siostrzanych worktree'ów tego samego repo
     * (docs `agent-sdk/typescript.md`, `listSessions()`, „Parameters”: domyślnie `true`),
     * czyli wpisy o INNYM `cwd` niż ten, o który pytamy. Poprzedni czytnik magazynu odsiewał je
     * po treści pliku (`belongsToCwd`), więc `false` odtwarza dotychczasowy kontrakt:
     * „lista dla katalogu" znaczy ten katalog, a nie okolicę. Bez tego wiersz niósłby pierwsze
     * zdanie rozmowy z katalogu spoza allow-listy, a jego „Wznów" kończyłby się 400.
     */
    includeWorktrees: false,
  })
);

/**
 * Tworzy czytnik listy sesji.
 *
 * Zwracana funkcja jest bezpieczna do wołania z handlera HTTP: nigdy nie rzuca. Awaria API
 * (brak magazynu, brak uprawnień, zmiana kontraktu pakietu) to PUSTA LISTA — magazyn należy
 * do CLI i Rarog nie ma nad nim kontroli, a pusty ekran z wyjaśnieniem jest lepszy niż 500.
 * Bez `lister` (SDK niezaładowany) czytnik zawsze oddaje pustą listę.
 */
export function createSessionListReader(opts: SessionListOptions = {}): SessionListReader {
  const lister = opts.lister;
  const cap = opts.fetchCap ?? ENGINE_SESSION_FETCH_CAP;
  return async ({ dir, limit, since }) => {
    if (lister === undefined) return [];
    const where = dir !== undefined ? { dir } : {};
    let raw: EngineSessionInfo[];
    try {
      raw = since === undefined
        ? await lister({ ...where, limit: Math.min(limit ?? cap, cap) })
        : await fetchSince(lister, where, since, cap);
    } catch {
      return [];
    }
    const out: ResumableSession[] = [];
    for (const info of raw) {
      if (since !== undefined && info.lastModified < since) continue;
      const entry = toResumableSession(info);
      if (entry !== null) out.push(entry);
    }
    return out;
  };
}

/**
 * Newest-first prefix of the corpus that reaches past `since`. The first fetch takes `cap` entries; while the corpus
 * has more and the oldest entry is still at or after `since`, the next fetch takes twice as many. Each fetch reads the
 * prefix from the start, because `offset` costs the API the same scan of the skipped entries (measured on SDK
 * 0.3.247: 300 entries at offset 300 took as long as 600 from the start).
 */
async function fetchSince(
  lister: EngineSessionLister, where: { dir?: string }, since: number, cap: number,
): Promise<EngineSessionInfo[]> {
  for (let wanted = Math.max(cap, 1); ; wanted *= 2) {
    const raw = await lister({ ...where, limit: wanted });
    const oldest = raw.at(-1);
    if (raw.length < wanted || oldest === undefined || oldest.lastModified < since) return raw;
  }
}
