/**
 * Blok dialogu: górna kreska i tytuł nad opcjami, rysowane przez CLI. Z bloku i WYŁĄCZNIE z niego pochodzi
 * tożsamość dialogu: nazwa narzędzia z tytułu, nagłówek MCP, linia `Ask rule` pod ramką operacji, a przy nagłówku nad
 * krawędzią ekranu pytanie `Write` pod ramką. Ślad wywołania `⏺ Nazwa(…)` w regionie jest tu sygnałem wyłącznie
 * negatywnym.
 *
 * Strażnik: `server/test/blok-dialogu-guard.test.ts` (wzorce tożsamości tylko w funkcjach liczących blok).
 */
import { FORM_IDENTITY } from './identity.ts';
import type { DialogIdentity } from './identity.ts';
import { KNOWN_DIALOGS } from './known.ts';
import type { KnownDialogId } from './known.ts';
import { BOX_EDGE_PATTERN, unbox } from './options.ts';
import { blockTopOf } from './region.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { writeZoneFile } from './write-zone.ts';

/**
 * Wywołanie narzędzia w renderze Claude Code: `⏺ Bash(pnpm exec …)`.
 *
 * Zestaw bulletów przepisany z manifestu detekcji herdr (`live_turn_working`,
 * `background_mcp_task_working`) plus `⏺` (U+23FA) z realnego ekranu.
 *
 * To WYŁĄCZNIE sygnał negatywny ({@link regionCallTrace}): linia `⏺`
 * w regionie dialogu odbiera mu klasę potwierdzenia ustawień i dialogu planu. Nazwy narzędzia z niej
 * nie bierzemy: linię `⏺` pisze render rozmowy, a jej kształt potrafi powtórzyć agent w opisie,
 * w komendzie albo w etykiecie opcji. Nazwa zgody pochodzi z BLOKU dialogu ({@link dialogBlock}).
 */
const TOOL_CALL_PATTERN = SCREEN_SIGNATURES.toolCall.pattern;

/**
 * Tytuły bloku dialogu zgody → nazwa narzędzia. Lista jest ZAMKNIĘTA.
 *
 * Tytuł pod górną kreską bloku jest PIERWSZYM i zwykle jedynym źródłem nazwy zgody (druga
 * droga: `Ask rule` pod ramką operacji, {@link ASK_RULE_PATTERN}). Wpis dokładamy dopiero po
 * zmierzeniu tytułu na żywym ekranie — mapowanie z domysłu podważałoby sens dosłownej nazwy.
 * Narzędzie bez wpisu (zgoda bez tytułu z mapy) nie ma nazwy z ekranu: karta z wpisem jsonl kończy
 * się `mismatch/tool-name`, czyli zgodą przy biurku (`docs/dialogs.md`, „Known gaps”).
 *
 * - `Bash` („Bash command”) — zmierzone na żywym panelu.
 * - `Edit` („Edit file”) i `Write` („Create file”) — CLI 2.1.258 (`measured/zgoda-edit-*.txt`,
 *   `measured/zgoda-write-*.txt`). Linia wywołania edycji to `⏺ Update(plik)`, nazwa WYŚWIETLANA,
 *   nie nazwa narzędzia z hooka: nazwa z niej (`Update`) dawałaby rozjazd przy każdej zgodzie na `Edit`.
 * - `Read` („Read file”) — CLI 2.1.278 (`dialog-permission-read-2.1.278.txt`).
 * - `WebFetch` („Fetch”), `NotebookEdit` („Edit notebook”) i `Skill` (`Use skill "nazwa"?`, wzorzec
 *   {@link SKILL_DIALOG_TITLE}) — CLI 2.1.311 (`measured/zgoda-webfetch-*.txt`,
 *   `measured/zgoda-notebookedit-*.txt`, `measured/zgoda-skill-*.txt`). Zgoda `WebSearch` ma tytuł „Tool use”
 *   bez nagłówka MCP, więc nazwy z ekranu nie ma; `Glob` i `Grep` w tej wersji CLI nie wystąpiły w sesji.
 * - `Write`, który nadpisuje istniejący plik („Overwrite file”) — CLI 2.1.322
 *   (`measured/zgoda-write-nadpisanie-2.1.322.txt`).
 */
const TOOL_DIALOG_HEADERS: ReadonlyMap<string, string> = new Map([
  [SCREEN_SIGNATURES.toolDialogHeaderBash.pattern, 'Bash'],
  [SCREEN_SIGNATURES.toolDialogHeaderEdit.pattern, 'Edit'],
  [SCREEN_SIGNATURES.toolDialogHeaderWrite.pattern, 'Write'],
  [SCREEN_SIGNATURES.toolDialogHeaderWriteOverwrite.pattern, 'Write'],
  [SCREEN_SIGNATURES.toolDialogHeaderRead.pattern, 'Read'],
  [SCREEN_SIGNATURES.toolDialogHeaderWebFetch.pattern, 'WebFetch'],
  [SCREEN_SIGNATURES.toolDialogHeaderNotebookEdit.pattern, 'NotebookEdit'],
]);

/**
 * Nazwa zgody, którą daje pytanie „Do you want to create/overwrite <nazwa>?” pod ramką treści przy nagłówku nad
 * krawędzią ekranu (`screen/write-zone.ts`): to samo narzędzie co tytuły „Create file” i „Overwrite file” z mapy.
 * Tylko do wyświetlenia: tożsamość `file-question` nie daje przycisków ani cyfry (`resolveOptions`,
 * `sameDialogIdentity`).
 */
const WRITE_QUESTION_TOOL = 'Write';

/** Tytuł zgody na `Skill` z nazwą skilla w cudzysłowie — jedyny wpis mapy, który jest wzorcem, nie tekstem. */
const SKILL_DIALOG_TITLE = SCREEN_SIGNATURES.toolDialogHeaderSkill.pattern;

/** Sufiks tytułu zgody subagenta (` · from the Explore agent`). */
const SUBAGENT_TITLE_SUFFIX = SCREEN_SIGNATURES.subagentTitleSuffix.pattern;

/** Sufiks tytułu zgody o trybie sandboksa (` (unsandboxed)`). */
const SANDBOX_TITLE_SUFFIX = SCREEN_SIGNATURES.sandboxTitleSuffix.pattern;

/**
 * Linia „Ask rule Bash(rm -rf *) overrides auto mode for this command." — druga droga do nazwy
 * narzędzia (identyfikator reguły uprawnień, bez mapowania).
 *
 * Liczy się WYŁĄCZNIE w strefie między dolną kreską ramki operacji a opcjami: tam rysuje ją
 * CLI, także wtedy, gdy tytuł dialogu uciekł nad krawędź panelu
 * (`dialog-bash-subagent-uciety-62x29-2.1.309.txt`). W komendzie w ramce, w opisie nad ramką
 * i w scrollbacku ta sama linia jest tekstem agenta.
 */
const ASK_RULE_PATTERN = SCREEN_SIGNATURES.askRule.pattern;

/**
 * The same rule line as CLI 2.1.328 words it, "Rule Bash(rm -rf *) from command line arguments overrides auto
 * mode.": the same tool name capture, counted in the same place as {@link ASK_RULE_PATTERN}.
 */
const RULE_PATTERN = SCREEN_SIGNATURES.ruleTool.pattern;

/** Tytuł bloku zgody na narzędzie MCP („Tool use”); nagłówek MCP stoi w pierwszej linii pod nim. */
const TOOL_USE_TITLE = SCREEN_SIGNATURES.toolUseTitle.pattern;

/** Tytuł bloku dialogu `ExitPlanMode` („Ready to code?”, „Exit plan mode?”). */
const PLAN_TITLE_PATTERN = SCREEN_SIGNATURES.planTitle.pattern;

/**
 * Nagłówek zgody na narzędzie MCP: `catalog — Get Project Tree Layout Tool: (MCP)`.
 *
 * ZMIERZONE na żywych panelach (CLI 2.1.258, dwa różne serwery — `catalog`
 * i `supabase`): dialog MCP rysuje tytuł bloku „Tool use", a nazwę stawia w pierwszej linii pod
 * nim jako **serwer + LUDZKI TYTUŁ narzędzia**, nie identyfikator. Tytuł nie wraca do
 * identyfikatora żadną regułą, za to identyfikator sprowadza się do tytułu
 * (`catalog_get_project_tree_layout` → „Get Project Tree Layout", `list_extensions` → „List
 * extensions"): cross-check porównuje serwer I tytuł ({@link mcpTitleMatches}).
 *
 * Łącznik claude.ai ma na ekranie nazwę kilku słów (CLI 2.1.322: „Claude Docs — Guide Tool: (MCP)”, identyfikator
 * `mcp__claude_ai_Claude_Docs__guide`), więc serwer może mieć pojedyncze spacje między słowami
 * (`mcpServerMatches` w `screen/resolve.ts`).
 */
const MCP_DIALOG_HEADER_PATTERN = SCREEN_SIGNATURES.mcpDialogHeader.pattern;

/**
 * Dialog sieci sandboksa (zrzut `measured/zgoda-siec-2.1.293.txt`). Nie ma ani hooka
 * `PermissionRequest`, ani własnego wpisu w jsonl — wpis, który wtedy czeka, to komenda Bash,
 * która poprosiła o sieć. Nazwa narzędzia jest więc ze SYGNATURY, jak przy planie: jest nią
 * TYTUŁ bloku dialogu („Network request outside of sandbox” tuż pod górną kreską).
 */
const SANDBOX_NETWORK_PATTERN = SCREEN_SIGNATURES.sandboxNetworkDialog.pattern;

/**
 * Czy region dialogu niesie ŚLAD wywołania narzędzia: linię `⏺ Nazwa(…)`, tytuł zgody z mapy
 * {@link TOOL_DIALOG_HEADERS} albo linię `Ask rule Nazwa(…)`?
 *
 * Sygnał WYŁĄCZNIE negatywny: odbiera regionowi klasę potwierdzenia ustawień
 * ({@link confirmFrom}) i dialogu planu albo sieci, nigdy nie nadaje nazwy: `⏺ Read(` w komendzie,
 * w opisie albo w zawiniętej etykiecie opcji przemianowałby wtedy zgodę `Bash`.
 */
export function regionCallTrace(region: readonly string[]): boolean {
  return region.some((line) => TOOL_CALL_PATTERN.test(line)
    || dialogTitleTool(line) !== null
    || ASK_RULE_PATTERN.test(unbox(line))
    || RULE_PATTERN.test(unbox(line)));
}

/**
 * Nazwa narzędzia z TYTUŁU dialogu zgody („Bash command", „Edit file") — wyłącznie z zamkniętej mapy
 * {@link TOOL_DIALOG_HEADERS} i wzorca {@link SKILL_DIALOG_TITLE}; `null` dla każdej innej linii.
 */
function dialogTitleTool(line: string): string | null {
  // Sufiks zgody SUBAGENTA („· from the Explore agent", CLI 2.1.273) stoi ZA
  // sufiksem trybu sandboksu („(unsandboxed)", zmierzone na CLI 2.1.246), więc zdejmujemy
  // go PIERWSZY: „Bash command (unsandboxed) · from the general-purpose agent"
  // (`dialog-permission-cd-advisory-2.1.265.txt`) w odwrotnej kolejności nie trafiałby w mapę.
  const title = unbox(line).replace(SUBAGENT_TITLE_SUFFIX, '').replace(SANDBOX_TITLE_SUFFIX, '');
  return TOOL_DIALOG_HEADERS.get(title) ?? (SKILL_DIALOG_TITLE.test(title) ? 'Skill' : null);
}

/** Licznik kolejki „k of N” na końcu linii tytułu bloku (`screen/queue.ts`). */
const QUEUE_COUNTER_PATTERN = SCREEN_SIGNATURES.queueCounter.pattern;

/**
 * Nazwa narzędzia z linii tytułu, która kończy się licznikiem kolejki („Bash command · from the
 * general-purpose agent    2 of 2”); `null`, gdy licznika nie ma albo tytuł bez licznika nie trafia w mapę.
 *
 * Licznik psuje dopasowanie {@link dialogTitleTool} (sufiks subagenta stoi wtedy przed nim, nie na końcu
 * linii), więc taki blok ma tożsamość tylko z `Ask rule`. Ten odczyt służy WYŁĄCZNIE dowodowi całej ramki
 * `Bash` (`decide/sources.ts`, `bashFrameProven`, i dowód wierzchu kanału zgód w `layer1/top.ts`); tożsamości
 * dialogu nie zmienia.
 */
export function queuedTitleTool(line: string): string | null {
  const title = unbox(line);
  if (!QUEUE_COUNTER_PATTERN.test(title)) return null;
  return dialogTitleTool(title.replace(QUEUE_COUNTER_PATTERN, ''));
}

/** Tytuł bloku dialogu z zamkniętej listy — co mówi o dialogu (patrz {@link blockTitleOf}). */
type BlockTitle =
  | { readonly kind: 'tool'; readonly tool: string }
  | { readonly kind: 'mcp' }
  | { readonly kind: 'network' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'known'; readonly id: KnownDialogId };

/**
 * Tytuł bloku z jednej linii ekranu; `null` = linia nie jest tytułem z zamkniętej listy. Lista: tytuły
 * zgód z mapy narzędzi (z sufiksami agenta i sandboksa), „Tool use”, tytuł dialogu sieci sandboksa,
 * tytuły dialogu planu i tytuły dialogów z {@link KNOWN_DIALOGS}.
 */
function blockTitleOf(line: string): BlockTitle | null {
  const text = unbox(line);
  const tool = dialogTitleTool(text);
  if (tool !== null) return { kind: 'tool', tool };
  if (text === TOOL_USE_TITLE) return { kind: 'mcp' };
  if (SANDBOX_NETWORK_PATTERN.test(text)) return { kind: 'network' };
  if (PLAN_TITLE_PATTERN.test(text)) return { kind: 'plan' };
  const known = KNOWN_DIALOGS.find((dialog) => dialog.title.test(text));
  return known === undefined ? null : { kind: 'known', id: known.id };
}

/**
 * The file dialog the block title names: `edit` for "Edit file", `write` for "Create file" and "Overwrite file"
 * (subagent suffix allowed); `null` for any other title and for an ambiguous block. Only for the kind of a dialog whose
 * key footer a narrow pane cut or wrapped (`screen/file-dialog.ts`); the name and identity stay with {@link toolNaming}.
 */
export function fileDialogTitle(block: DialogBlock): 'edit' | 'write' | null {
  if (block.ambiguous || block.title?.kind !== 'tool') return null;
  if (block.title.tool === 'Edit') return 'edit';
  return block.title.tool === 'Write' ? 'write' : null;
}

/** Pierwsza niepusta linia pod kreską `rule`, przed `limit`, bez krawędzi ramki `╭──╮`; `-1` = brak. */
export function lineBelow(lines: readonly string[], rule: number, limit: number): number {
  for (let i = rule + 1; i < limit; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line !== '' && !BOX_EDGE_PATTERN.test(line)) return i;
  }
  return -1;
}

/**
 * BLOK dialogu: górna kreska nad pierwszą opcją i tytuł pod nią.
 *
 * Parser zbiera nad pierwszą opcją WSZYSTKIE pary „kreska bloku + pierwsza niepusta linia pod nią
 * z zamkniętej listy tytułów” ({@link blockTitleOf}). Więcej niż jedna para = blok niejednoznaczny
 * (`ambiguous`): kreskę i linię „Read file” potrafi wypisać agent w opisie wywołania, a wtedy prawdziwy
 * tytuł stoi nad podrobionym. Agent może tym najwyżej zabrać przyciski własnej zgodzie, nie podmienić
 * nazwy. Dokładnie jedna para wyznacza tytuł bloku, ale tylko na NAJBLIŻSZEJ kresce bloku nad opcjami:
 * para wyżej (w scrollbacku nad dialogiem bez tytułu z listy) nie nazywa dialogu, który stoi pod nią.
 * Sama linia „Read file” bez kreski nad nią parą nie jest, więc komenda z taką linią przycisków nie traci.
 *
 * Kreska bloku to goła kreska z {@link blockTopOf} (`region.ts`, rodzaj `bare`): kreska ze statusem sesji bloku
 * parsera nie wyznacza. Liczy się w DOWOLNEJ kolumnie. Margines dialogu to kolumna 0 od CLI 2.1.293, ale dialog
 * planu rysuje kreski w kolumnie 2 (`measured/exitplanmode-2.1.293.txt`), a kolumny nie zgadujemy: para wcięta
 * jest najwyżej powodem do `ambiguous`, nigdy tytułem pod cudzą kreską.
 */
export interface DialogBlock {
  /** Indeks najbliższej kreski bloku nad pierwszą opcją; `-1` = nad opcjami nie ma żadnej. */
  readonly top: number;
  /** Tytuł pod kreską {@link top} z zamkniętej listy; `null` = tytułu z listy tam nie ma. */
  readonly title: BlockTitle | null;
  /** Indeks linii tytułu; `-1`, gdy {@link title} jest `null`. */
  readonly titleLine: number;
  /** Nad opcjami stoi więcej niż jedna para „kreska + tytuł” — granicy bloku nie da się wskazać. */
  readonly ambiguous: boolean;
}

/** Filtr góry bloku parsera: wyłącznie goła kreska (patrz {@link dialogBlock}). */
const BARE_TOP = { kinds: ['bare'] } as const;

export function dialogBlock(lines: readonly string[], firstOption: number): DialogBlock {
  const pairs: { readonly rule: number; readonly line: number; readonly title: BlockTitle }[] = [];
  // Kreski od najbliższej opcjom w górę: każda następna to góra bloku nad poprzednią.
  const nearest = blockTopOf(lines, firstOption, BARE_TOP);
  for (let rule = nearest; rule !== null; rule = blockTopOf(lines, rule.line, BARE_TOP)) {
    const line = lineBelow(lines, rule.line, firstOption);
    const title = line === -1 ? null : blockTitleOf(lines[line] ?? '');
    if (title !== null) pairs.push({ rule: rule.line, line, title });
  }
  const top = nearest?.line ?? -1;
  if (pairs.length > 1) return { top, title: null, titleLine: -1, ambiguous: true };
  const pair = pairs[0];
  return pair !== undefined && pair.rule === top
    ? { top, title: pair.title, titleLine: pair.line, ambiguous: false }
    : { top, title: null, titleLine: -1, ambiguous: false };
}

/** Linia z licznikiem kolejki „k of N” na końcu (dowolny tytuł, licznik bez sprawdzenia poprawności). */
function counterTitle(line: string): boolean {
  return QUEUE_COUNTER_PATTERN.test(unbox(line));
}

/** Para „goła kreska bloku + tytuł z listy albo z licznikiem kolejki” (patrz {@link titlePair}). */
export interface TitlePair {
  /** Indeks kreski pary: najbliższej kreski bloku nad pierwszą opcją. */
  readonly rule: number;
  /** Indeks linii tytułu pod nią. */
  readonly titleLine: number;
  /** Tytuł kończy się licznikiem kolejki „k of N” (dowolny tytuł, licznik bez sprawdzenia); `false` = tytuł z listy. */
  readonly counter: boolean;
}

/**
 * Jedyna para bloku nad pierwszą opcją, licząc RAZEM tytuły z zamkniętej listy i tytuły z licznikiem kolejki;
 * `null` przy każdym innym układzie.
 *
 * Pary liczymy jak {@link dialogBlock} (kreski od najbliższej opcjom w górę, pierwsza niepusta linia pod kreską), ale
 * RAZEM z tytułami z licznikiem: parą jest linia z zamkniętej listy tytułów ({@link blockTitleOf}) albo linia
 * zakończona licznikiem „k of N” z dowolnym tytułem i licznikiem bez sprawdzenia poprawności, więc podrobiony
 * „0 of 2” też odbiera jednoznaczność. Wynik jest wyłącznie wtedy, gdy para jest dokładnie jedna i stoi na najbliższej
 * kresce bloku nad opcjami; `counter` mówi, który to rodzaj tytułu. Kreska i „Bash command … 1 of 2” wpisane w treść
 * dialogu `Write` dają drugą parę (tytuł „Create file” wyżej), para z licznikiem nad prawdziwym tytułem z listy też,
 * a para w scrollbacku nad dialogiem bez tytułu z listy nie stoi na najbliższej kresce.
 *
 * Odczyt służy WYŁĄCZNIE dowodowi wierzchu kanału zgód (`layer1/top.ts`, obie drogi wierzchu `Bash`);
 * {@link dialogBlock}, tożsamość dialogu i nazwa narzędzia go nie znają.
 */
export function titlePair(lines: readonly string[], firstOption: number): TitlePair | null {
  const nearest = blockTopOf(lines, firstOption, BARE_TOP);
  let pairs = 0;
  let found: TitlePair | null = null;
  for (let rule = nearest; rule !== null; rule = blockTopOf(lines, rule.line, BARE_TOP)) {
    const line = lineBelow(lines, rule.line, firstOption);
    if (line === -1) continue;
    const text = lines[line] ?? '';
    const listed = blockTitleOf(text) !== null;
    if (!listed && !counterTitle(text)) continue;
    pairs += 1;
    if (rule.line === nearest?.line) found = { rule: rule.line, titleLine: line, counter: !listed };
  }
  return pairs === 1 ? found : null;
}

/** Nazwa, tożsamość i nagłówek MCP zgody na narzędzie — z bloku i ze strefy pod ramką operacji. */
interface ToolNaming {
  readonly toolName: string | null;
  readonly identity: DialogIdentity;
  readonly mcpServer: string | null;
  readonly mcpTool: string | null;
}

const UNNAMED: ToolNaming = { toolName: null, identity: FORM_IDENTITY, mcpServer: null, mcpTool: null };

/**
 * Nazwa zgody na narzędzie (reguła 2), w tej kolejności: nazwa nadana przez Raroga dialogowi planu
 * i sieci sandboksa; nagłówek MCP w pierwszej linii pod tytułem „Tool use”; tytuł bloku z mapy narzędzi;
 * linia `Ask rule` WYŁĄCZNIE w strefie między dolną kreską ramki operacji a opcjami (`zone`); bez tytułu
 * bloku pytanie dialogu `Write` w tej samej strefie, gdy nagłówek dialogu jest nad krawędzią ekranu
 * (`cutZone`, `screen/write-zone.ts`). Nic poza tym: ani `⏺`, ani linie ramki, opcji czy opisu.
 */
export function toolNaming(
  lines: readonly string[], block: DialogBlock, firstOption: number,
  special: string | null, zone: readonly string[] | null, cutZone: readonly string[] | null,
): ToolNaming {
  if (block.ambiguous) return { ...UNNAMED, identity: { kind: 'ambiguous' } };
  if (special !== null) return { ...UNNAMED, toolName: special, identity: { kind: 'title', tool: special } };
  const title = block.title;
  if (title?.kind === 'tool') return { ...UNNAMED, toolName: title.tool, identity: { kind: 'title', tool: title.tool } };
  if (title?.kind === 'mcp') {
    const line = lineBelow(lines, block.titleLine, firstOption);
    const header = line === -1 ? null : MCP_DIALOG_HEADER_PATTERN.exec(unbox(lines[line] ?? ''));
    const server = header?.[1];
    const mcpTitle = header?.[2];
    return server === undefined || mcpTitle === undefined
      ? UNNAMED
      : { ...UNNAMED, mcpServer: server, mcpTool: mcpTitle, identity: { kind: 'mcp', server, title: mcpTitle } };
  }
  for (const line of zone ?? []) {
    const rule = (ASK_RULE_PATTERN.exec(unbox(line)) ?? RULE_PATTERN.exec(unbox(line)))?.[1];
    if (rule !== undefined) return { ...UNNAMED, toolName: rule, identity: { kind: 'ask-rule', tool: rule } };
  }
  const file = title === null && cutZone !== null ? writeZoneFile(cutZone) : null;
  if (file === null) return UNNAMED;
  const tool = WRITE_QUESTION_TOOL;
  return { ...UNNAMED, toolName: tool, identity: { kind: 'file-question', tool, file } };
}
