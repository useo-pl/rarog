/**
 * Protocol contract, activity area: what the agent does between messages (thinking, tools, delegation).
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/** Delegacja pracy: subagenci (`Agent`, `Task`) albo przebieg workflow (`Workflow`). */
export type Delegation = 'agents' | 'workflow';

/**
 * Co agent robi MIĘDZY wiadomościami (luki L-1…L-7).
 *
 * Silnik potrafi myśleć kilkadziesiąt sekund i mielić narzędzia minutami, nie emitując ani
 * jednego bloku `text` — Rarog rysował wtedy pusty ekran i zaproszenie „Napisz, co ma zrobić".
 * Ten typ jest jedynym kanałem, którym „coś się dzieje" dociera na telefon.
 *
 * - `thinking` — blok myślenia (treści myśli NIE przesyłamy, tylko sam fakt),
 * - `tool` — narzędzie startuje albo wciąż mieli (`toolName`, opcjonalnie `elapsedSeconds`),
 * - `waiting` — silnik czeka na API (`requesting`, retry, kompaktowanie kontekstu),
 * - `idle` — koniec ruchu; wskaźnik ma zgasnąć.
 */
export type ActivityKind = 'thinking' | 'tool' | 'waiting' | 'idle';

/**
 * Narzędzia, których wywołanie znaczy „pracę oddano subagentom".
 *
 * Lista stoi w protokole, a nie po jednej ze stron, bo obie muszą mówić o tym samym: serwer
 * rozpoznaje po niej bloki delegacji w jsonl (`jsonl-follow.ts`), a klient — te same bloki
 * w transkrypcie, gdy chce policzyć agentów bez czekania na event.
 * Rozjazd tych list znaczy wiersz aktywności, który po jednej stronie liczy, a po drugiej nie.
 *
 * `Task` jest w niej z uwagi na starsze transkrypty; w zmierzonej próbce realnych wpisów
 * nie występuje ani razu (84× `Agent`, 40× `Workflow`, 0× `Task`).
 */
export const DELEGATING_TOOLS: readonly string[] = ['Task', 'Agent', 'Workflow'];

export function isDelegatingTool(toolName: string | undefined): boolean {
  return toolName !== undefined && DELEGATING_TOOLS.includes(toolName);
}

export interface Activity {
  kind: ActivityKind;
  toolName?: string;
  summary?: string;
  /**
   * The tool's own words about the call: the `description` field of its input, trimmed and cut like `summary`.
   * Only on `tool` of `Bash` (an MCP tool's `description` is often the data it writes); absent = no description.
   */
  description?: string;
  /**
   * Seconds the activity already lasts: the session pulse's quiet time in an `activity` frame; in a session summary
   * and a transcript snapshot it also counts the whole seconds since the server set the activity. Absent = 0.
   */
  elapsedSeconds?: number;
  /**
   * Ilu subagentów tura trzyma w locie. Liczba, NIE zdanie: 1 = pojedynczy subagent,
   * ≥2 = workflow, a o tym, jak to brzmi po polsku, decyduje wyłącznie klient.
   * Serwer zna tę liczbę z pulsu katalogu sesji — patrz `session-pulse.ts`.
   */
  agents?: number;
  /**
   * Ilu agentów przebiegu już SKOŃCZYŁO (wpisy `result` w journalu workflow). Nieobecne =
   * „nie wiem" (pojedyncze taski bez journala) — nigdy zero-wypełniacz.
   */
  agentsDone?: number;
  /** Nazwa przebiegu workflow, gdy znana; nieobecna = „nie wiem", a nie „brak workflow". */
  workflow?: string;
  /**
   * PLAN przebiegu: fazy ze skryptu (`meta.phases[].title`, kolejność skryptu)
   * z liczbą agentów, którzy w danej fazie ruszyli, i tych, którzy skończyli (tag `[Faza · …]`
   * z pierwszej linii transkryptu agenta). Fakty, nie ułamek — o tym, jak z tego zrobić
   * pasek, decyduje klient (`workflowProgress`). Nieobecne = „nie wiem": skrypt bez `phases`,
   * bez tagów, albo rozkład jeszcze nieodczytany — klient wraca wtedy do liczenia agentów.
   * Faza bez agentów jest legalna (jeszcze nie ruszyła) i niesie zera.
   */
  phases?: ActivityPhase[];
  /** Wiersz delegacji (subagenci albo workflow); nieobecne = to nie delegacja. */
  delegation?: Delegation;
}

export interface ActivityPhase {
  title: string;
  /** Agenci, którzy w tej fazie RUSZYLI (wpis `started`), łącznie ze skończonymi. */
  agents: number;
  /** Agenci, którzy w tej fazie już nie pracują (`result` ALBO `failed` w journalu). */
  done: number;
}

/*
 * Stands BEFORE `activitySchema`, which uses it: a module `const` does not hoist like a function, so the reverse
 * order is a TDZ error at module load, not a type error.
 */
export const activityPhaseSchema = z.object({
  title: z.string(),
  agents: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
});

export const activitySchema = z.object({
  kind: z.enum(['thinking', 'tool', 'waiting', 'idle']),
  toolName: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  elapsedSeconds: z.number().optional(),
  agents: z.number().optional(),
  agentsDone: z.number().optional(),
  workflow: z.string().optional(),
  phases: z.array(activityPhaseSchema).optional(),
  delegation: z.enum(['agents', 'workflow']).optional(),
});
