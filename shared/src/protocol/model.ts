/**
 * Protocol contract, model area: effort levels, model list (`GET /api/models`), model labels and aliases,
 * model, effort and permission mode changes of a live session.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';
import { type SentenceRef, type ServerSentence, say, sentenceRefSchema } from '../sentences/index.ts';

// ---------------------------------------------------------------------------
// Model i effort
// ---------------------------------------------------------------------------

/** Poziomy effortu SDK (`Options.effort`). Kolejność = kolejność w UI. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const effortLevelSchema = z.enum(EFFORT_LEVELS);

/**
 * Identyfikator modelu, jaki wolno wysłać do serwera. Wzorzec odsiewa śmieci (spacje, flagi),
 * ale NIE jest allow-listą — tą jest lista modeli znana serwerowi (`GET /api/models`):
 * serwer odrzuca 400 `model-unknown` wszystko spoza niej.
 *
 * Sufiks wariantu okna `[1m]` przechodzi (wybór Opusa ustawia okno 1M). Zmierzone, nie założone:
 * `claude --model 'opus[1m]'` rozwiązuje się do `claude-opus-5[1m]` z `contextWindow: 1000000`,
 * a `herdr agent start … -- --model opus[1m]` stawia panel ze stopką „Opus 5:1M" — nawiasy przeżywają wpisanie do powłoki panelu.
 * Dozwolony jest WYŁĄCZNIE ten jeden sufiks: to jedyny wariant, jaki CLI zna, a wzorzec stoi
 * przed argv powłoki (`ARG_VALUE_PATTERN`, `herdr/argv.ts`).
 */
export const MODEL_ID_PATTERN = /^[a-z][a-z0-9.-]{1,63}(?:\[1m\])?$/;
export const modelIdSchema = z.string().regex(MODEL_ID_PATTERN, 'Nieprawidłowy identyfikator modelu.');

/** Jedna pozycja listy modeli do wyboru. */
export interface ModelChoice {
  /**
   * Wartość wysyłana w `model` (alias CLI albo pełny identyfikator).
   *
   * PUSTY string ma znaczenie i jest domyślną pozycją listy: „model domyślny konta", czyli
   * ZERO flagi `--model` w argv. Klient takiej wartości nie wysyła (pole `model` po prostu
   * nie wchodzi do ciała) — to jest etykieta wyboru, a nie identyfikator modelu.
   */
  value: string;
  /** Krótka nazwa do UI („Fable 5"). */
  label: string;
  /** Kod zdania `label`: tylko pozycja „model domyślny konta”. */
  labelRef?: SentenceRef;
  description?: string;
  /** Kod zdania `description`. */
  descriptionRef?: SentenceRef;
  /** Poziomy effortu, które model wspiera; pusta lista = effort nie ma znaczenia. */
  effortLevels: EffortLevel[];
  /**
   * Serwer umie włączyć ultracode przy tym modelu: start flagą i zmiana w żywej sesji. Brak pola = brak
   * przełącznika w apce, także u serwera, który pola nie zna.
   */
  ultracode?: true;
}

export const modelChoiceSchema = z.object({
  // Pusty string przechodzi WYŁĄCZNIE tutaj (lista wyboru), nigdy w ciele żądania:
  // `createSessionBodySchema.model` zostaje przy `modelIdSchema`.
  value: z.union([z.literal(''), modelIdSchema]),
  label: z.string().min(1),
  labelRef: sentenceRefSchema.optional(),
  description: z.string().optional(),
  descriptionRef: sentenceRefSchema.optional(),
  effortLevels: z.array(effortLevelSchema),
  ultracode: z.literal(true).optional(),
});

/**
 * Odpowiedź `GET /api/models` — lista WBUDOWANA.
 *
 * Pola `source` już nie ma: po wycięciu SDK Rarog nie ma czego zapytać o modele konta
 * (`Query.supportedModels()` odeszło razem z driverem), więc jedynym źródłem jest ta lista.
 */
export interface ModelList {
  models: ModelChoice[];
}

export const modelListSchema = z.object({
  models: z.array(modelChoiceSchema),
});

const ALL_EFFORTS: EffortLevel[] = [...EFFORT_LEVELS];

/**
 * Pierwsza i DOMYŚLNA pozycja listy modeli: „nie podawaj `--model`".
 *
 * Powód jest zmierzony, a nie estetyczny: ustawienie konta użytkownika bywa wariantem w nawiasie
 * kwadratowym (`claude-fable-5[1m]`), a wybrany z listy model bez tego wariantu dałby okno
 * 200k zamiast 1M, po cichu i bez śladu w UI. Brak flagi jest jedyną wartością, która na pewno
 * nie kłamie — także dziś, gdy lista ma `opus[1m]`: ustawienie konta może być dowolne.
 */
const DEFAULT_MODEL_LABEL = say('model.default-label');
const DEFAULT_MODEL_DESCRIPTION = say('model.default-description');
export const DEFAULT_MODEL_CHOICE: ModelChoice = {
  value: '',
  // Zdania rejestru (`model.default-*`): tekst i obok kod dla apki.
  label: DEFAULT_MODEL_LABEL.text,
  labelRef: DEFAULT_MODEL_LABEL.ref,
  description: DEFAULT_MODEL_DESCRIPTION.text,
  descriptionRef: DEFAULT_MODEL_DESCRIPTION.ref,
  effortLevels: [],
};

/**
 * Lista wbudowana — używana, dopóki serwer nie spyta żywego silnika. SAME ALIASY: `fable`,
 * `opus`, `sonnet`, `haiku` — każdy rozwiązuje CLI do najnowszej wersji rodziny
 * (`claude --help`: „Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')").
 *
 * One Fable and one Opus, always the newest: an alias needs no Rarog change for a new version,
 * and `modelAlias` keeps the model sheet from showing "Opus 5" (the resolved id of the current
 * session) next to "Opus" (the alias) as two pills.
 *
 * Lista jest allow-listą flagi `--model` (`isKnownModel`, `sessions/manager.ts`), więc pełny
 * identyfikator wysłać się NIE DA — a odczytać wolno: sesja założona poza Rarogiem na
 * `claude-fable-5` czyta się dalej, razem ze swoim oknem (`KNOWN_CONTEXT_LIMITS`).
 */
export const FALLBACK_MODEL_CHOICES: readonly ModelChoice[] = [
  // `ultracode` jawnie przy pozycjach z menu effortu: przełącznik wymusza xhigh, którego pozycje bez menu
  // (Haiku, model domyślny konta) w formularzu nie mają.
  { value: 'fable', label: 'Fable', effortLevels: ALL_EFFORTS, ultracode: true },
  // `opus[1m]`, not `opus`: picking Opus sets the 1M variant. The bare `opus` window is 1M too
  // (Claude Code 2.1.280, `KNOWN_CONTEXT_LIMITS`; docs `model-config.md`, "Extended context": Opus 4.7
  // and newer without the suffix), so the suffix is only the owner's choice. The label stays "Opus" —
  // the variant is not a separate choice but the only Opus Rarog offers.
  { value: 'opus[1m]', label: 'Opus', effortLevels: ALL_EFFORTS, ultracode: true },
  { value: 'sonnet', label: 'Sonnet', effortLevels: ALL_EFFORTS, ultracode: true },
  { value: 'haiku', label: 'Haiku', effortLevels: [] },
];

/**
 * Krótka nazwa modelu do pigułki w composerze. Najpierw lista (`label`), potem heurystyka na
 * identyfikatorze: `claude-fable-5-1` → „Fable 5.1", `claude-opus-4-6` → „Opus 4.6",
 * `claude-haiku-4-5-20251001` → „Haiku 4.5". Nieznany kształt wraca bez zmian.
 *
 * Wariant okna w nawiasie kwadratowym (`claude-opus-5[1m]` → „Opus 5 (1M)") jest częścią
 * identyfikatora, a nie ozdobnikiem: konto miewa ten sam model w dwóch wariantach kontekstu
 * i to jedyne miejsce, po którym da się je rozróżnić. Zjadanie go dawałoby dwa różne modele
 * pod jedną nazwą — dokładnie ta pomyłka, przez którą okno fable liczyło się pięciokrotnie
 * za małe (`KNOWN_CONTEXT_LIMITS`).
 */
export function formatModelLabel(model: string, choices: readonly ModelChoice[] = []): string {
  const known = choices.find((choice) => choice.value === model);
  if (known !== undefined) return known.label;
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[([a-z0-9]+)\])?$/.exec(model);
  if (match === null) return model;
  const family = match[1] ?? '';
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = match[3] === undefined ? match[2] : `${match[2]}.${match[3]}`;
  const variant = match[4];
  const window = variant === undefined ? '' : ` (${variant.toUpperCase()})`;
  return `${name} ${version}${window}`;
}

/**
 * The list alias that a RESOLVED model id falls under — or the id unchanged when the list has no
 * such alias.
 *
 * `claude-fable-5-1` → `fable`, `claude-opus-5[1m]` → `opus[1m]`. The window variant is PART of
 * the match: family + the same suffix (`opus[1m]`) first, the bare family (`opus`) only after
 * that and only when the id has no suffix either. `claude-opus-5` does NOT fold into
 * `opus[1m]`: it is treated as a different window (200k), so the sheet shows "Opus 5" next to
 * "Opus" and offers the switch to `opus[1m]`. The docs (`model-config.md`, "Extended context")
 * give Opus 4.7 and newer a 1M window without the suffix; until that is confirmed, no folding.
 * The engine reports the full id in jsonl while Rarog sends aliases, so without this mapping the
 * sheet would show "Opus 5" and "Opus" as two models even when both mean the same. Accepted cost:
 * a session on an OLDER family version (`claude-opus-4-8[1m]`) also falls under `opus[1m]` —
 * the alias means "this family", not "this version", and the CLI would get the same after a tap
 * on the pill.
 */
export function modelAlias(model: string, choices: readonly ModelChoice[]): string {
  if (choices.some((choice) => choice.value === model)) return model;
  const match = /^claude-([a-z]+)-\d[^[]*(\[[a-z0-9]+\])?$/.exec(model);
  if (match === null) return model;
  const alias = `${match[1] ?? ''}${match[2] ?? ''}`;
  return choices.some((choice) => choice.value === alias) ? alias : model;
}

/**
 * Ciało `POST /api/sessions/:id/model` — zmiana modelu, effortu i/lub ultracode ŻYWEJ sesji.
 * Co najmniej jedno pole. `effort: null` = wróć do domyślnego silnika. `ultracode`: `true` włącza,
 * `false` wyłącza; obecność pola, nie jego wartość, liczy się do „co najmniej jednego”.
 */
export const sessionModelBodySchema = z.object({
  model: modelIdSchema.optional(),
  effort: effortLevelSchema.nullable().optional(),
  ultracode: z.boolean().optional(),
}).refine((body) => body.model !== undefined || body.effort !== undefined || body.ultracode !== undefined, {
  message: 'Podaj model, effort albo ultracode.',
});
export type SessionModelBody = z.infer<typeof sessionModelBodySchema>;

/**
 * OSTRZEŻENIE o skutku GLOBALNYM zmiany modelu — jedno zdanie prawdy.
 *
 * Nie jest to drobiazg prawny: `/model` w Claude Code ZAPISUJE wybór do
 * `~/.claude/settings.json`, więc zmiana zrobiona z telefonu dla jednej sesji przestawia
 * domyślny model KAŻDEJ następnej sesji na tym koncie — także tej zakładanej jutro
 * w terminalu. Rarog tej wartości nie przywraca (byłby to wyścig z 17 sesjami piszącymi
 * do tego samego pliku), więc jedyne, co może zrobić uczciwie, to powiedzieć
 * o skutku PRZED, a nie po.
 *
 * Stała mieszka w kontrakcie, bo mówią nią DWA miejsca: arkusz w kliencie (przed wysłaniem)
 * i odpowiedź `202` serwera (po wysłaniu, jako `warning`). Rozjazd tych dwóch zdań byłby
 * dokładnie tą sytuacją, w której użytkownik przestaje wierzyć ostrzeżeniom.
 */
export const MODEL_CHANGE_WARNING: ServerSentence =
  // Bez backticków: zdanie idzie do UI jako zwykły tekst, więc markdown byłby tu widoczny jako znaki.
  // Polecenie w cudzysłowie definicyjnym. Brzmienie: rejestr `model.change-warning`.
  say('model.change-warning');

/**
 * Zdanie o koszcie ultracode — odpowiednik {@link MODEL_CHANGE_WARNING} dla paczki z samym `ultracode`.
 * Wynik `/effort ultracode` mówi „this session only”, więc zdanie mówi o koszcie tury, a nie o skutku
 * globalnym. Mówią nim arkusz w kliencie i `warning` odpowiedzi serwera.
 */
export const ULTRACODE_CHANGE_NOTE: ServerSentence = say('model.ultracode-note');

/**
 * Odpowiedź `POST /api/sessions/:id/model` — **202**, bo dialog potwierdzenia w panelu
 * obsługuje się PO odpowiedzi HTTP.
 *
 * Blokowanie POST-a do czasu, aż panel przemaluje dialog i przyjmie cyfrę, kosztowałoby
 * te same 2 s, które przy zgaszonym ekranie iOS gubią odpowiedź (ten sam powód, co przy
 * `POST /api/sessions`). Skutek przychodzi tam, gdzie użytkownik i tak patrzy: wiadomością
 * systemową w transkrypcie i pigułką modelu po następnej turze.
 */
export const sessionModelResponseSchema = z.object({
  ok: z.literal(true),
  /**
   * Zdanie zależne od paczki — pole, a nie założenie po stronie klienta: {@link MODEL_CHANGE_WARNING} dla paczki
   * z modelem albo effortem, {@link ULTRACODE_CHANGE_NOTE} dla paczki z samym `ultracode`.
   */
  warning: z.string().min(1),
  /** Kod zdania `warning`. */
  warningRef: sentenceRefSchema.optional(),
});
export type SessionModelResponse = z.infer<typeof sessionModelResponseSchema>;

/**
 * Tryby, do których wolno przełączyć panel z Raroga: pigułka „auto" → `plan`,
 * pigułka „plan" → `auto`. `bypass` jako cel nie istnieje — Rarog nie zdejmuje pytań o zgodę.
 */
export const MODE_CYCLE_TARGETS = ['plan', 'auto'] as const;
export type ModeCycleTarget = (typeof MODE_CYCLE_TARGETS)[number];

/** Ciało `POST /api/sessions/:id/mode` — zmiana trybu uprawnień ŻYWEJ sesji. */
export const sessionModeBodySchema = z.object({
  mode: z.enum(MODE_CYCLE_TARGETS),
});
export type SessionModeBody = z.infer<typeof sessionModeBodySchema>;

/**
 * Odpowiedź `POST /api/sessions/:id/mode` — **202**, bo pętla `shift+tab` → odczyt stopki
 * trwa sekundy i biegnie PO odpowiedzi HTTP. Skutek wraca kanałem, który telefon i tak ma
 * otwarty: chip trybu przez `session-changed` i zdanie w transkrypcie.
 */
export const sessionModeResponseSchema = z.object({ ok: z.literal(true) });
export type SessionModeResponse = z.infer<typeof sessionModeResponseSchema>;

type _ModelChoiceSchemaMatchesType = z.infer<typeof modelChoiceSchema> extends ModelChoice ? true : never;
type _ModelChoiceTypeMatchesSchema = ModelChoice extends z.infer<typeof modelChoiceSchema> ? true : never;
type _ModelListSchemaMatchesType = z.infer<typeof modelListSchema> extends ModelList ? true : never;
type _ModelListTypeMatchesSchema = ModelList extends z.infer<typeof modelListSchema> ? true : never;

const _modelChoiceSchemaMatchesType: _ModelChoiceSchemaMatchesType = true;
const _modelChoiceTypeMatchesSchema: _ModelChoiceTypeMatchesSchema = true;
const _modelListSchemaMatchesType: _ModelListSchemaMatchesType = true;
const _modelListTypeMatchesSchema: _ModelListTypeMatchesSchema = true;

void _modelChoiceSchemaMatchesType;
void _modelChoiceTypeMatchesSchema;
void _modelListSchemaMatchesType;
void _modelListTypeMatchesSchema;
