/**
 * Protocol contract, slash commands area: `GET /api/sessions/:id/commands`.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Slash-komendy sesji — `GET /api/sessions/:id/commands`
// ---------------------------------------------------------------------------

/** Jak kończy się komenda: wynik w linii i powrót do pola (`local`) albo tura modelu (`prompt`). */
export const COMMAND_CHOICE_KINDS = ['local', 'prompt'] as const;
export type CommandChoiceKind = (typeof COMMAND_CHOICE_KINDS)[number];

/** Skąd komenda: wbudowana w CLI (komenda albo skill), skill lub komenda z dysku, plugin. */
export const COMMAND_CHOICE_SOURCES = ['builtin', 'skill', 'plugin'] as const;
export type CommandChoiceSource = (typeof COMMAND_CHOICE_SOURCES)[number];

/** Sufit `description` i `argumentHint` w znakach UTF-16; dłuższy tekst serwer ucina z `…`. */
export const COMMAND_TEXT_MAX = 200;

/**
 * Jedna komenda, którą Rarog przepuści w tej sesji. `name` bez ukośnika, wielkość liter ze źródła (rejestr,
 * nazwa na dysku: `compact`, `pr-review-toolkit:review-pr`). Opis i podpowiedź argumentu z frontmattera skilla
 * albo komendy (`description`, `argument-hint`); wbudowane ich nie mają (rejestr Raroga ich nie zna). Aliasów nie
 * ma, bo nie przechodzą, a ścieżek plików nie ma, bo apka ich nie potrzebuje.
 */
export interface CommandChoice {
  name: string;
  kind: CommandChoiceKind;
  source: CommandChoiceSource;
  description?: string;
  argumentHint?: string;
}

export const commandChoiceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(COMMAND_CHOICE_KINDS),
  source: z.enum(COMMAND_CHOICE_SOURCES),
  description: z.string().min(1).max(COMMAND_TEXT_MAX).optional(),
  argumentHint: z.string().min(1).max(COMMAND_TEXT_MAX).optional(),
});

/**
 * Odpowiedź `GET /api/sessions/:id/commands` — TA SAMA migawka katalogu sesji, którą strażnik
 * wysyłki sprawdza tekst. `revision` zmienia się razem z treścią listy; ta sama `revision` =
 * ta sama lista. Kolejność: po nazwie małymi literami.
 */
export interface CommandList {
  revision: string;
  commands: CommandChoice[];
}

export const commandListSchema = z.object({
  revision: z.string().min(1),
  commands: z.array(commandChoiceSchema),
});

type _CommandChoiceSchemaMatchesType = z.infer<typeof commandChoiceSchema> extends CommandChoice ? true : never;
type _CommandChoiceTypeMatchesSchema = CommandChoice extends z.infer<typeof commandChoiceSchema> ? true : never;
type _CommandListSchemaMatchesType = z.infer<typeof commandListSchema> extends CommandList ? true : never;
type _CommandListTypeMatchesSchema = CommandList extends z.infer<typeof commandListSchema> ? true : never;

const _commandChoiceSchemaMatchesType: _CommandChoiceSchemaMatchesType = true;
const _commandChoiceTypeMatchesSchema: _CommandChoiceTypeMatchesSchema = true;
const _commandListSchemaMatchesType: _CommandListSchemaMatchesType = true;
const _commandListTypeMatchesSchema: _CommandListTypeMatchesSchema = true;

void _commandChoiceSchemaMatchesType;
void _commandChoiceTypeMatchesSchema;
void _commandListSchemaMatchesType;
void _commandListTypeMatchesSchema;
