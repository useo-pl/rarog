/**
 * Protocol contract, resume area: resumable CLI sessions and recent projects.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Wznawianie sesji z magazynu CLI
// ---------------------------------------------------------------------------

/** Limit listy `GET /api/resumable` — 20 najnowszych sesji katalogu. */
export const MAX_RESUMABLE_SESSIONS = 20;

/** Ile znaków pierwszego promptu pokazujemy na liście „Wznów istniejącą". */
export const MAX_FIRST_PROMPT_LENGTH = 120;

/**
 * Ile ostatnich sesji projektu pokazuje `GET /api/resumable/recent?cwd=…`.
 *
 * Dziesięć (na życzenie użytkownika). Lista dalej jest
 * SKRÓTEM POWROTU, a nie przeglądem historii: odpowiada na „wróć do tego, co tu robiłem".
 * Pełną historię katalogu (20 wpisów, `MAX_RESUMABLE_SESSIONS`) pokazuje „Wznów istniejącą"
 * w formularzu nowej sesji — tam wybiera się z listy, tu wraca się do ostatniej roboty.
 */
export const MAX_RECENT_SESSIONS = 10;

/**
 * How many recent PROJECTS `GET /api/projects/recent` gives (the recent project chips of the New Session sheet):
 * twelve chips plus the current project, which the app leaves out.
 */
export const MAX_RECENT_PROJECTS = 13;

/**
 * Projekt z historią sesji CLI — katalog i czas OSTATNIEJ sesji w nim (ISO). Lista jest
 * skrótem „wskocz tam, gdzie ostatnio pracowałem", więc niesie tylko to, po czym się skacze
 * i sortuje; ani jednego zdania rozmowy.
 */
export interface RecentProject {
  cwd: string;
  mtime: string;
}

export const recentProjectSchema = z.object({
  cwd: z.string().min(1),
  mtime: z.string(),
});

/** Odpowiedź `GET /api/projects/recent`. */
export const recentProjectsSchema = z.object({
  projects: z.array(recentProjectSchema).max(MAX_RECENT_PROJECTS),
});

/** Jeden wpis magazynu CLI (`~/.claude/projects/<slug>/<engineSessionId>.jsonl`). */
export interface ResumableSession {
  engineSessionId: string;
  cwd: string;
  /** Czas modyfikacji pliku transkryptu (ISO) — po nim sortujemy listę. */
  mtime: string;
  /** Pierwszy prompt użytkownika, przycięty do `MAX_FIRST_PROMPT_LENGTH`. */
  firstPrompt: string;
  /**
   * Gałąź gita z końca sesji, gdy API ją zna.
   *
   * Liczby wiadomości tu nie ma: `listSessions()` jej nie oddaje, a doliczanie jej przez `getSessionMessages()`
   * kosztowałoby jeden odczyt transkryptu na wiersz. Gałąź jest w odpowiedzi za darmo i mówi
   * w tym miejscu więcej — „na czym to było", a nie „jak długo trwało".
   */
  gitBranch?: string;
  /**
   * Ta sesja silnika jest OTWARTA w żywym panelu herdr. **Wymagane** — brak wartości
   * znaczyłby „nie wiem", a nie ma bezpiecznego zachowania dla „nie wiem": wznowienie
   * odpaliłoby drugi proces `claude --resume` na tym samym pliku jsonl, czyli dwóch pisarzy
   * bez możliwości cofnięcia. `true` = wpis na liście nie ma „Wznów" (są „Otwórz sesję"
   * i „Rozwidl"), a `POST /api/sessions` z `resumeFrom` bez `fork` odpowiada 409.
   */
  liveInHerdr: boolean;
  /**
   * Etykieta sesji — NIEZALEŻNIE od źródła.
   *
   * Dwa źródła, w tej kolejności: etykieta ŻYWEGO panelu herdr, gdy `liveInHerdr: true` (zna ją
   * manager, bo trzyma kartę w RAM — a skoro i tak po nią sięga, przepisanie nic nie kosztuje),
   * albo `summary` z `listSessions()`, czyli „nazwa nadana przez człowieka → streszczenie →
   * pierwszy prompt", złożone po stronie API. Front pokazuje ją, ilekroć jest niepusta.
   *
   * Wcześniej pole należało wyłącznie do żywych paneli; poszerzone, bo od przejścia na oficjalne
   * API każdy wpis ma tytuł lepszy niż surowe pierwsze zdanie. Brak pola = zostaje `firstPrompt`.
   * Przycinane tym samym limitem co `firstPrompt` — wiersz listy ma na nie tyle samo miejsca.
   */
  title?: string;
  /**
   * Karta Raroga, w której ta rozmowa ŻYJE — przy `liveInHerdr: true`, bo serwer rozpoznaje
   * żywą rozmowę właśnie po karcie. Cel „przejdź do otwartej rozmowy”: bez pola (starszy serwer)
   * klient zgadywał kartę po katalogu i przy kilku kartach w katalogu zawsze odmawiał.
   */
  sessionId?: string;
}

export const resumableSessionSchema = z.object({
  engineSessionId: z.string(),
  cwd: z.string(),
  mtime: z.string(),
  firstPrompt: z.string().max(MAX_FIRST_PROMPT_LENGTH),
  // Ta sama granica co `firstPrompt`: wartość pochodzi spoza Raroga (git dopuszcza ~255 bajtów),
  // a wiersz listy ma na nią tyle samo miejsca co na tytuł.
  gitBranch: z.string().max(MAX_FIRST_PROMPT_LENGTH).optional(),
  liveInHerdr: z.boolean(),
  // Ta sama granica co `firstPrompt`, bo to jest ta sama rzecz w wierszu listy: etykieta karty
  // płynie z herdr (spoza Raroga), więc jej długość jest wejściem, a nie naszym założeniem.
  title: z.string().max(MAX_FIRST_PROMPT_LENGTH).optional(),
  sessionId: z.string().min(1).optional(),
});

/** Odpowiedź `GET /api/resumable?cwd=…`. */
export const resumableListSchema = z.object({
  sessions: z.array(resumableSessionSchema),
});

type _ResumableSchemaMatchesType =
  z.infer<typeof resumableSessionSchema> extends ResumableSession ? true : never;
type _ResumableTypeMatchesSchema =
  ResumableSession extends z.infer<typeof resumableSessionSchema> ? true : never;
const _resumableSchemaMatchesType: _ResumableSchemaMatchesType = true;
const _resumableTypeMatchesSchema: _ResumableTypeMatchesSchema = true;
void _resumableSchemaMatchesType;
void _resumableTypeMatchesSchema;
