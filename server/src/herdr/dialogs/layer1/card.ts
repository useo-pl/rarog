/**
 * Karta kanału zgód ze zrzutu hooka (warstwa 1): pełna prezentacja wejścia narzędzia i werdykt, czy pod kartą
 * wolno zgodzić się z telefonu (`unavailable`), odmówić albo zwolnić prośbę do terminala.
 *
 * Prezentacja pokazuje WSZYSTKIE pola wejścia, w całości, i nic nie przycina:
 *
 * - `Bash` z napisem `command`: komenda jako blok powłoki (`inputKind: 'shell'`, `displayText` to dosłownie
 *   komenda), pozostałe pola w stałej kolejności (`description`, `timeout`, `run_in_background`,
 *   `dangerouslyDisableSandbox`, potem reszta po nazwie); `dangerouslyDisableSandbox: true` dokłada uwagę
 *   `sandbox-disabled`, którą karta wyróżnia zdaniem;
 * - inne znane narzędzia: całe wejście jako JSON z polami w stałej kolejności narzędzia, reszta po nazwie;
 * - nieznane narzędzia: całe wejście jako JSON w kolejności pól wejścia.
 *
 * Prezentacja dłuższa niż {@link CONSENT_DISPLAY_MAX} bajtów UTF-8 (tekst, nazwy i wartości pól) to `truncated`,
 * tak jak zrzut przycięty przez hook: telefon zgadza się na to, co widzi, więc widzi wszystko albo nie ma
 * przycisku zgody. Such a verdict carries `presentation: null`: the text does not leave the server. Karta nie bierze
 * `toolInputText` ani `clipForDisplay` z `drivers/tool-text.ts`: tamte pokazują samą komendę `Bash` i przycinają.
 *
 * Werdykt (kolejność ma znaczenie, pierwszy powód wygrywa): prośba subagenta przy zakresie `main`
 * (`terminal-only`), brak rejestracji (`no-channel`), klucz zablokowany (`key-blocked`), rejestracja innego wywołania
 * niż zrzut (`card-mismatch`), zrzut przycięty (`truncated`), puste wejście (`no-content`; narzędzie MCP z `{}` to
 * wywołanie bez argumentów, pełna treść), prezentacja ponad sufit (`truncated`), znak ukryty w prezentacji albo
 * w katalogu roboczym (`hidden-chars`: tekst, nazwy i wartości pól, `cwd`, `CARD_HIDDEN_RANGES`
 * z `server/src/hidden-chars.ts`), `cardSha256` ze zrzutu różny od rejestracji (`card-mismatch`), martwy hook
 * (`hook-dead`), brak dowodu „dialog stoi” (`no-proof`). An MCP dump with the empty suggestion marker
 * (`mcpEmptySuggestions`, `hook/suggestions.ts`) also has `no-proof`: a plain `allow` from the hook does not close the
 * dialog of an MCP tool with `requiresUserInteraction`, and the empty list was measured only with such tools.
 * Przy zakresie `all` prośba subagenta przechodzi te same powody bez `terminal-only`, a przycisk zgody dostaje
 * z dowodem z wierzchu albo z dowodem ukrytym (5.4; dowód liczy `proof.ts`); reguła `channel` bez
 * wierzchu dotyczy tylko wątku głównego spoza MCP. Odmowę i zwolnienie serwer podpisuje wartościami
 * z rejestracji, więc wolno je przy każdej karcie z żywą, niezablokowaną rejestracją (prośba subagenta tylko przy
 * zakresie `all`); zgodę tylko bez powodu. Prośbę subagenta bez dowodu zwalnia rekord cyklu (`cycle.ts`).
 *
 * The verdict carries the dump's checked `permission_suggestions` as data: apart from the MCP marker above they change
 * no reason and no `canAllow`. The "always" option (`always`) comes from the registration's suggestions on the
 * closed list (`always.ts`), only with the option on (`RAROG_CONSENT_ALWAYS`), a hook that knows the "always" file
 * (`alwaysVersion`), the dump's suggestions equal to the registration's and a presentation shown in full; the phone
 * gets the button only together with `canAllow`.
 *
 * Czysta funkcja nad jawnymi wejściami: bez dysku, zegara i transkryptu (`layer1-granica.test.ts`).
 */
import { hasCardHiddenChar } from '../../../hidden-chars.ts';
import { isTruncatedHookInput } from '../hook/dump.ts';
import type { HookCallDump } from '../hook/contract.ts';
import type { HookSuggestions } from '../hook/suggestions.ts';
import { CONSENT_COMPARABLE_TOOL_PREFIX, CONSENT_DISPLAY_MAX } from './contract.ts';
import type { ConsentUnavailable } from './contract.ts';
import { CONSENT_ALWAYS_VERSION, consentAlwaysEntries, sameConsentSuggestions } from './always.ts';
import type { ConsentAlwaysEntry } from './always.ts';
import type { ConsentRegistryEntry } from './registry.ts';
import { consentCardSha256 } from './sign.ts';

/** Rodzaj prezentacji: komenda powłoki albo JSON (te same wartości co `ToolInputKind` kontraktu). */
export type ConsentInputKind = 'shell' | 'json';

/** Uwagi prezentacji, które karta wyróżnia zdaniem. */
export type ConsentPresentationNote = 'sandbox-disabled';

/** Pole wejścia poza blokiem komendy: nazwa i pełna wartość (napis dosłownie, inne typy jako JSON). */
export interface ConsentPresentationField {
  readonly name: string;
  readonly value: string;
}

export interface ConsentPresentation {
  readonly inputKind: ConsentInputKind;
  /** `shell`: dosłownie komenda; `json`: całe wejście. */
  readonly displayText: string;
  /** Pozostałe pola przy `shell`, w stałej kolejności; przy `json` puste (wszystko jest w `displayText`). */
  readonly fields: readonly ConsentPresentationField[];
  readonly notes: readonly ConsentPresentationNote[];
  /** Bajty UTF-8 tekstu, nazw i wartości pól. */
  readonly bytes: number;
}

/** Pola `Bash` poza komendą, w kolejności karty. */
const BASH_FIELD_ORDER = ['description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'] as const;

/** Stała kolejność pól znanych narzędzi (reszta pól po nazwie, za nimi). */
const KNOWN_FIELD_ORDER: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
  Read: ['file_path', 'offset', 'limit', 'pages'],
  NotebookEdit: ['notebook_path', 'cell_id', 'cell_type', 'edit_mode', 'new_source'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
  ExitPlanMode: ['plan', 'planFilePath'],
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Wartość pola do pokazania: napis dosłownie, reszta jako JSON (`undefined` jak `null`). */
function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) ?? 'null';
}

/** Klucze w kolejności `order`, potem pozostałe po nazwie. */
function orderedKeys(record: Record<string, unknown>, order: readonly string[]): string[] {
  const keys = Object.keys(record);
  const first = order.filter((key) => Object.hasOwn(record, key));
  const rest = keys.filter((key) => !order.includes(key)).sort();
  return [...first, ...rest];
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Pełna prezentacja wejścia narzędzia albo `null`, gdy wejście nie jest obiektem (cykl, `BigInt` i inne wartości
 * spoza JSON też dają `null`: karty nie da się pokazać w całości).
 */
export function presentConsentInput(toolName: string, toolInput: unknown): ConsentPresentation | null {
  const record = asObject(toolInput);
  if (record === null) return null;
  try {
    const command = record['command'];
    if (toolName === 'Bash' && typeof command === 'string') {
      const fields = orderedKeys(record, BASH_FIELD_ORDER)
        .filter((name) => name !== 'command')
        .map((name) => ({ name, value: fieldText(record[name]) }));
      const notes: ConsentPresentationNote[] = record['dangerouslyDisableSandbox'] === true ? ['sandbox-disabled'] : [];
      const bytes = bytesOf(command) + fields.reduce((sum, f) => sum + bytesOf(f.name) + bytesOf(f.value), 0);
      return { inputKind: 'shell', displayText: command, fields, notes, bytes };
    }
    const order = KNOWN_FIELD_ORDER[toolName];
    const keys = order === undefined ? Object.keys(record) : orderedKeys(record, order);
    // `Object.fromEntries` tworzy pola własne: przypisanie `ordered[key]` uruchomiłoby setter `__proto__` i własne
    // pole `__proto__` z wejścia JSON zniknęłoby z prezentacji, zostając w skrócie karty.
    const ordered = Object.fromEntries(keys.map((key) => [key, record[key]]));
    const displayText = JSON.stringify(ordered, null, 2);
    return { inputKind: 'json', displayText, fields: [], notes: [], bytes: bytesOf(displayText) };
  } catch {
    return null;
  }
}

/**
 * Prezentacja bez treści: brak prezentacji albo pusty obiekt JSON. Narzędzie MCP z `{}` to wywołanie bez argumentów
 * (wejście hooka = wpis `tool_use`, pomiar na CLI 2.1.322): karta pokazuje nazwę narzędzia i `{}` w całości.
 * `Bash` bez komendy i plan z `{}` (plan w pliku planu) nie mają czego pokazać.
 */
function emptyPresentation(toolName: string, presentation: ConsentPresentation | null): boolean {
  if (presentation === null) return true;
  return presentation.inputKind === 'json' && presentation.displayText === '{}'
    && !toolName.startsWith(CONSENT_COMPARABLE_TOOL_PREFIX);
}

/** Czy prezentacja ma znak ukryty na karcie: w tekście, nazwie albo wartości pola. */
function hiddenInPresentation(presentation: ConsentPresentation | null): boolean {
  if (presentation === null) return false;
  return hasCardHiddenChar(presentation.displayText)
    || presentation.fields.some((field) => hasCardHiddenChar(field.name) || hasCardHiddenChar(field.value));
}

/** Stan dowodu „dialog stoi” dla klucza (`proof.ts`): `dead` = proces hooka nie żyje. */
export type ConsentStanding = 'standing' | 'unknown' | 'dead';

export interface ConsentCardInput {
  readonly dump: HookCallDump;
  /** Wpis rejestru klucza (także zablokowany) albo `null`. */
  readonly registration: ConsentRegistryEntry | null;
  /** Czy rejestr ma sekret do podpisu (żywy, niezablokowany wpis tej sesji). */
  readonly signable: boolean;
  /**
   * Zakres kanału: przy `main` prośba subagenta idzie do terminala (`terminal-only`), przy `all` dostaje kartę jak
   * prośba wątku głównego: przycisk zgody z dowodem, bez dowodu `no-proof`, z którego wraca do biurka.
   */
  readonly scope: 'main' | 'all';
  readonly standing: ConsentStanding;
  /** The "always" option is on (`RAROG_CONSENT_ALWAYS`); no field = off. */
  readonly always?: boolean;
}

export interface ConsentCardVerdict {
  readonly presentation: ConsentPresentation | null;
  /** Pierwszy powód braku przycisku zgody albo `null` (zgoda dozwolona). */
  readonly unavailable: ConsentUnavailable | null;
  readonly canAllow: boolean;
  /**
   * Odmowa i zwolnienie: serwer może podpisać plik (żywa, niezablokowana rejestracja; prośba subagenta tylko przy
   * zakresie `all`).
   */
  readonly canSign: boolean;
  /** `cardSha256` policzony serwerem z pełnego zrzutu albo `null` (zrzut przycięty albo nie do policzenia). */
  readonly cardSha256: string | null;
  /** The dump's checked `permission_suggestions`; no field without them. Data only. */
  readonly permissionSuggestions?: HookSuggestions;
  /** The "always" option: the updates the hook would write; no field = no option (module header). */
  readonly always?: readonly ConsentAlwaysEntry[];
}

/** The "always" option of the card (module header) or `null`. */
function alwaysOf(input: ConsentCardInput, shown: boolean): readonly ConsentAlwaysEntry[] | null {
  const { dump, registration } = input;
  if (input.always !== true || !shown || registration === null || registration.alwaysVersion !== CONSENT_ALWAYS_VERSION
    || !sameConsentSuggestions(dump.permissionSuggestions, registration.permissionSuggestions)) return null;
  return consentAlwaysEntries(dump.toolName, registration.permissionSuggestions);
}

/** Czy rejestracja opisuje to samo wywołanie co zrzut (sesja, prompt, wejście, proces hooka). */
function sameCall(dump: HookCallDump, entry: ConsentRegistryEntry): boolean {
  return entry.sessionId === dump.sessionId && entry.promptId === dump.promptId
    && entry.inputSha256 === dump.inputSha256 && entry.pid === dump.pid && entry.startedAt === dump.startedAt
    && (entry.agentId ?? null) === (dump.agentId ?? null);
}

/**
 * The `cardSha256` of the dump, computed by the server the way the hook computes it for its registration (tool name,
 * whole input, session, `cwd`, agent, permission mode); `null` = a dump the hook truncated, or not computable.
 */
export function consentDumpCardSha256(dump: HookCallDump): string | null {
  if (isTruncatedHookInput(dump.toolInput)) return null;
  try {
    return consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
    });
  } catch {
    return null;
  }
}

/** Werdykt karty kanału dla jednego zrzutu. */
export function consentCardVerdict(input: ConsentCardInput): ConsentCardVerdict {
  const { dump, registration } = input;
  const truncated = isTruncatedHookInput(dump.toolInput);
  const presentation = truncated ? null : presentConsentInput(dump.toolName, dump.toolInput);
  const cardSha256 = consentDumpCardSha256(dump);
  const subagent = dump.agentId !== undefined;
  const subagentOpen = input.scope === 'all';
  const canSign = (!subagent || subagentOpen) && input.signable && registration !== null && !registration.blocked
    && input.standing !== 'dead';
  const empty = emptyPresentation(dump.toolName, presentation);
  const overDisplay = presentation !== null && presentation.bytes > CONSENT_DISPLAY_MAX;

  const reasons: [boolean, ConsentUnavailable][] = [
    [subagent && !subagentOpen, 'terminal-only'],
    [registration === null || !input.signable && !registration.blocked, 'no-channel'],
    [registration?.blocked === true, 'key-blocked'],
    [registration !== null && !sameCall(dump, registration), 'card-mismatch'],
    [truncated, 'truncated'],
    [empty, 'no-content'],
    [overDisplay, 'truncated'],
    [hiddenInPresentation(presentation) || hasCardHiddenChar(dump.cwd), 'hidden-chars'],
    [cardSha256 === null || registration === null || cardSha256 !== registration.cardSha256, 'card-mismatch'],
    [input.standing === 'dead', 'hook-dead'],
    [input.standing !== 'standing' || dump.mcpEmptySuggestions === true, 'no-proof'],
  ];
  const unavailable = reasons.find(([hit]) => hit)?.[1] ?? null;
  const always = alwaysOf(input, presentation !== null && !overDisplay);
  // A presentation over the display ceiling does not leave the server: the card says "not shown", as for a dump the
  // hook truncated, and carries no text the phone could not approve anyway.
  return {
    presentation: overDisplay ? null : presentation, unavailable, canAllow: unavailable === null, canSign, cardSha256,
    ...(dump.permissionSuggestions === undefined ? {} : { permissionSuggestions: dump.permissionSuggestions }),
    ...(always === null ? {} : { always }),
  };
}
