/**
 * Dowód „dialog stoi” dla zrzutów per wywołanie jednej sesji — wariant WIDOCZNY (wątek główny, prośba bez
 * `agent_id`). Czysta funkcja nad jawnymi wejściami: bez dysku, bez `ps`, bez stanu globalnego i bez drivera, więc
 * woła ją serwer przed klawiszem zgody i proces pomiarowy z tymi samymi regułami
 * (`docs/dialogs.md`, „Server in shadow mode”).
 *
 * Wejścia:
 *
 * - zrzuty per wywołanie sesji (`pending/<sesja>/<klucz>.json`), już przeczytane i sprawdzone co do kształtu;
 * - życie procesu hooka per klucz (pid i czas startu wobec `ps`): `true`, `false` albo `null` = nie wiem;
 * - sygnał rejestru sesji CLI z chwilą odczytu (`waiting` z klasą, inny status, „nie wiem”);
 * - licznik kolejki z ekranu (`screen/queue.ts`);
 * - otwarte `tool_use` z transkryptu wątku głównego (nazwa i wejście) albo `null` = transkrypt nieznany;
 * - opcja kanału zgód (warstwa 1, {@link Layer1Evidence}): czy transkrypt poszedł dalej niż prośba zrzutu (regułę
 *   stosuje `layer1/proof.ts` nad zapamiętanymi zamknięciami), czy zrzut stracił dowód na stałe (fakty cyklu
 *   `layer1/cycle.ts`) i, przy kanale otwartym dla subagentów, czy fakty pliku subagenta prośby są znane. Tryb cienia
 *   jej nie podaje, więc jego reguły zostają takie jak niżej.
 *
 * Reguły:
 *
 * 1. Dowód daje WYŁĄCZNIE komplet: żywy proces hooka i rejestr `waiting` z klasą `permission`, świeży.
 * 2. Sygnały negatywne zabierają dowód, nigdy go nie dają: rejestr bez `waiting` odczytany później niż zrzut
 *    (z zapasem na opóźnienie zapisu rejestru), zero otwartych `tool_use` tej nazwy w transkrypcie, skrót wejścia
 *    bez otwartego odpowiednika, gdy inny żywy zrzut tej nazwy swój odpowiednik ma, licznik kolejki mniejszy niż
 *    liczba żywych zrzutów, którym nic dowodu nie zabrało. Z opcją warstwy 1 zero otwartych `tool_use` tej nazwy
 *    zabiera dowód dopiero wtedy, gdy transkrypt poszedł dalej niż prośba ({@link Layer1Evidence.passed}); wcześniej
 *    to niewiadoma (reguła 3). Skrót wejścia bez otwartego odpowiednika z opcją warstwy 1 niczego nie zabiera: prośby
 *    tej nazwy rozdziela tam wierzch ekranu i pełna pula sesji (`layer1/proof.ts`). Zrzut, który dowód stracił na stałe
 *    ({@link Layer1Evidence.lost}), nie ma go przy żadnym transkrypcie, także nieznanym (`transkrypt-brak`), i nie
 *    liczy się w regułach bliźniaków i kolejki.
 * 3. Niewiadoma (`null` życia, rejestr nieznany, ekran bez bloku, transkrypt nieznany) niczego nie zabiera,
 *    ale dowodu też nie daje tam, gdzie jest jego warunkiem.
 * 4. Dwa żywe zrzuty o tej samej nazwie i skrócie są NIEJEDNOZNACZNE (kolejno: jeden to sierota po decyzji przy
 *    biurku; równolegle: oba stoją, a ekran nie mówi, który jest na wierzchu) — werdykt mówi to wprost, a nie
 *    „brak dowodu”.
 * 5. Prośba subagenta (`agentId`) i zrzut, którego treść nie daje zapisanego skrótu (przycięty), nie mają dowodu.
 *    Z opcją warstwy 1 przy kanale otwartym dla subagentów ({@link Layer1Evidence.subagentFile}) prośba subagenta
 *    ze znanymi faktami swojego pliku przechodzi reguły 1–4 jak prośba wątku głównego, z trzema różnicami:
 *    transkrypt wątku głównego jej nie dotyczy (dowód zabiera zamknięcie w jej pliku, {@link Layer1Evidence.passed}),
 *    rejestr bez `waiting` zabiera jej dowód, ale sieroty nie robi (5.4), a bliźniaki liczą się w każdym
 *    wątku osobno.
 *
 * Te same reguły wskazują sieroty ({@link orphanHooks}): żywy hook wątku głównego, któremu dowód zabrał sygnał
 * negatywny rejestru albo transkryptu, czeka na dialog, którego już nie ma (decyzja przy biurku). Niewiadoma
 * nigdy nie robi sieroty.
 */
import { CLI_STATUS_WAITING } from '../../../cli-version.ts';
import type { CliDialogClass, CliRegistryEntry, CliWaitingSignal } from '../../../cli-version.ts';
import { callPrint } from '../cross-check.ts';
import { canonicalSha256 } from '../hook/canon.ts';
import type { HookCallDump } from '../hook/contract.ts';
import type { QueueOnScreen } from '../screen/queue.ts';

/**
 * Zapas na opóźnienie rejestru: zrzut młodszy niż `odczyt rejestru − zapas` nie traci dowodu przez status inny
 * niż `waiting` — CLI mogło jeszcze nie przepisać pliku rejestru po pokazaniu dialogu.
 */
export const REGISTRY_SLACK_MS = 2_000;

/** Odczyt rejestru starszy niż to (manager czyta co 1,5 s) jest „nie wiem”, nie dowodem ani zaprzeczeniem. */
export const REGISTRY_MAX_AGE_MS = 5_000;

/** Klasa dialogu rejestru, która jest dialogiem zgody na narzędzie. */
const PERMISSION_CLASS: CliDialogClass = 'permission';

/**
 * Sygnał rejestru sesji CLI z chwilą odczytu `at` (ms epoki). `cliVersion` = wydanie jedynego procesu sesji z tego
 * samego odczytu (sygnał managera, `CliWaitingSignal.version`); brak = wersja nieznana.
 */
export type RegistryEvidence =
  | { readonly kind: 'waiting'; readonly dialog: CliDialogClass; readonly at: number; readonly cliVersion?: string }
  | { readonly kind: 'active'; readonly at: number; readonly cliVersion?: string }
  /** `no-registry`: brak odczytu; `no-entry`: brak wpisu sesji; `writers`: kilku pisarzy; `unread`: nie wiem. */
  | { readonly kind: 'unknown'; readonly why: 'no-registry' | 'no-entry' | 'writers' | 'unread' };

/** Sygnał z wpisów rejestru jednej sesji (proces pomiarowy czyta rejestr sam). */
export function registryEvidenceOf(
  entries: readonly CliRegistryEntry[] | null | undefined, at: number,
): RegistryEvidence {
  if (entries === null) return { kind: 'unknown', why: 'no-registry' };
  if (entries === undefined || entries.length === 0) return { kind: 'unknown', why: 'no-entry' };
  if (entries.length > 1) return { kind: 'unknown', why: 'writers' };
  const [entry] = entries;
  if (entry === undefined) return { kind: 'unknown', why: 'no-entry' };
  if (entry.status !== CLI_STATUS_WAITING) return { kind: 'active', at };
  return { kind: 'waiting', dialog: entry.waitingFor ?? 'other', at };
}

/**
 * Sygnał z odczytu managera (`cliWaitingOf`), który driver dostaje co 1,5 s; `null` = jeszcze żadnego. Wersja procesu
 * przechodzi z sygnału, więc stan i wersja pochodzą z jednego odczytu rejestru.
 */
export function registryEvidenceFromSignal(signal: CliWaitingSignal | null, at: number): RegistryEvidence {
  if (signal === null || signal.kind === 'unknown') return { kind: 'unknown', why: 'unread' };
  const version = signal.version === undefined ? {} : { cliVersion: signal.version };
  if (signal.kind === 'active') return { kind: 'active', at, ...version };
  return { kind: 'waiting', dialog: signal.dialog, at, ...version };
}

/** Otwarty `tool_use` wątku głównego: nazwa i surowe wejście z transkryptu. */
export interface OpenToolUse {
  readonly toolName: string;
  readonly input: unknown;
}

export interface EvidenceInput {
  /** Chwila oceny (ms epoki) — do świeżości odczytu rejestru. */
  readonly now: number;
  readonly dumps: readonly HookCallDump[];
  /** Życie procesu hooka per klucz zrzutu; brak klucza = `null` (nie wiem). */
  readonly alive: ReadonlyMap<string, boolean | null>;
  readonly registry: RegistryEvidence;
  readonly queue: QueueOnScreen;
  /** Otwarte `tool_use` wątku głównego; `null` = transkrypt nieznany. */
  readonly transcript: readonly OpenToolUse[] | null;
  /**
   * Opcja kanału zgód (warstwa 1). Wejście trybu cienia jej nie podaje i zostaje przy regułach „zero otwartych
   * `tool_use` tej nazwy zabiera dowód” i „skrót bez otwartego odpowiednika zabiera dowód, gdy inny żywy zrzut tej
   * nazwy swój odpowiednik ma”.
   */
  readonly layer1?: Layer1Evidence;
}

/** Opcja warstwy 1 wejścia dowodu: fakty kanału zgód, których tryb cienia nie ma. */
export interface Layer1Evidence {
  /**
   * Czy transkrypt poszedł dalej niż prośba zrzutu (`transcriptPassed` w `layer1/proof.ts`). Zmienia regułę
   * `transkrypt-brak`: zero otwartych `tool_use` tej nazwy zabiera dowód tylko zrzutowi, dla którego zwraca `true`.
   */
  readonly passed: (dump: HookCallDump) => boolean;
  /**
   * Czy zrzut stracił dowód na stałe (`proofLost` w `layer1/cycle.ts`). Taki zrzut po rejestrze dostaje
   * `transkrypt-brak` przy każdym transkrypcie, także nieznanym, nie jest kandydatem reguł bliźniaków i kolejki,
   * a po {@link ORPHAN_TRANSCRIPT_MIN_AGE_MS} jest sierotą.
   */
  readonly lost: (dump: HookCallDump) => boolean;
  /**
   * Kanał otwarty dla subagentów (tryb `all`, 5.4): czy fakty pliku subagenta prośby z `agentId` są w tej
   * obserwacji znane do końca (`layer1/observe.ts`). Taka prośba przechodzi reguły dowodu własnego (reguła 5 wyżej),
   * a {@link passed} liczy dla niej zamknięcia z jej pliku. Brak pola (tryb cienia, kanał `main`) albo `false` =
   * prośba subagenta bez dowodu (`subagent`).
   */
  readonly subagentFile?: (dump: HookCallDump) => boolean;
}

/** Dlaczego zrzut nie ma dowodu. Negatywne (zabrały dowód) i braki warunku (nie było czego dać). */
export const NO_PROOF_REASONS = [
  'subagent', 'skrot', 'hook-martwy', 'hook-nieznany', 'rejestr-nie-czeka', 'rejestr-nieznany', 'rejestr-klasa',
  'transkrypt-brak', 'transkrypt-skrot', 'kolejka',
] as const;
export type NoProofReason = (typeof NO_PROOF_REASONS)[number];

export type ProofVerdict =
  | { readonly key: string; readonly kind: 'stoi' }
  | { readonly key: string; readonly kind: 'brak'; readonly why: NoProofReason }
  /** Bliźniak o tej samej nazwie i skrócie — nie wiadomo, który z nich stoi. */
  | { readonly key: string; readonly kind: 'niejednoznaczny' };

function digestOf(input: unknown): string | null {
  try {
    return canonicalSha256(input);
  } catch {
    return null;
  }
}

/**
 * Sygnał negatywny rejestru: świeży odczyt bez `waiting` późniejszy niż zrzut z zapasem. Ten sam warunek wyjmuje
 * zrzut z puli sesji kanału zgód (opcja warstwy 1, `layer1/cycle.ts`).
 */
export function registryNegates(
  registry: RegistryEvidence, now: number, dump: Pick<HookCallDump, 'at'>,
): boolean {
  return registry.kind === 'active' && now - registry.at <= REGISTRY_MAX_AGE_MS
    && dump.at + REGISTRY_SLACK_MS <= registry.at;
}

/** Werdykt per zrzut, w kolejności `dumps`. */
export function standingProofs(input: EvidenceInput): ProofVerdict[] {
  const verdicts = new Map<string, ProofVerdict>();
  const no = (key: string, why: NoProofReason): void => { verdicts.set(key, { key, kind: 'brak', why }); };

  // Reguła 5 i życie procesu: werdykty, które nie zależą od innych zrzutów. Prośba subagenta przechodzi dalej tylko
  // z opcją warstwy 1 i znanymi faktami swojego pliku.
  const live: HookCallDump[] = [];
  for (const dump of input.dumps) {
    if (dump.agentId !== undefined && input.layer1?.subagentFile?.(dump) !== true) no(dump.key, 'subagent');
    else if (digestOf(dump.toolInput) !== dump.inputSha256) no(dump.key, 'skrot');
    else {
      const alive = input.alive.get(dump.key) ?? null;
      if (alive === false) no(dump.key, 'hook-martwy');
      else if (alive === null) no(dump.key, 'hook-nieznany');
      else live.push(dump);
    }
  }

  // Reguła 2, rejestr: status inny niż `waiting` odczytany wyraźnie po zrzucie — dialog tego zrzutu już nie stoi.
  const registry = input.registry;
  const registryFresh = registry.kind !== 'unknown' && input.now - registry.at <= REGISTRY_MAX_AGE_MS;
  const afterRegistry = live.filter((dump) => {
    if (registryNegates(registry, input.now, dump)) {
      no(dump.key, 'rejestr-nie-czeka');
      return false;
    }
    return true;
  });

  // Opcja warstwy 1: zrzut, który dowód stracił na stałe, nie ma go przy żadnym transkrypcie i nie jest kandydatem
  // reguł bliźniaków i kolejki.
  const layer1 = input.layer1;
  const kept = layer1 === undefined ? afterRegistry : afterRegistry.filter((dump) => {
    if (!layer1.lost(dump)) return true;
    no(dump.key, 'transkrypt-brak');
    return false;
  });

  // Opcja warstwy 1, prośba subagenta: transkrypt wątku głównego jej nie dotyczy. Dowód zabiera zamknięcie jej
  // wywołania w jej pliku (`passed`); póki go nie ma, brak prośby w pliku to niewiadoma, jak w wątku głównym.
  let survivors = layer1 === undefined ? kept : kept.filter((dump) => {
    if (dump.agentId === undefined || !layer1.passed(dump)) return true;
    no(dump.key, 'transkrypt-brak');
    return false;
  });

  // Reguła 2, transkrypt: nazwa, a skrót wtedy, gdy rozróżnia (inny żywy zrzut tej nazwy ma odpowiednik).
  if (input.transcript !== null) {
    const open = input.transcript.map((tool) => ({ toolName: tool.toolName, digest: digestOf(tool.input) }));
    const matched = (dump: HookCallDump): boolean =>
      open.some((tool) => tool.toolName === dump.toolName && tool.digest === dump.inputSha256);
    survivors = survivors.filter((dump) => {
      // Prośba subagenta dochodzi tu tylko z opcją warstwy 1 (wyżej); transkrypt wątku głównego jej nie dotyczy.
      if (dump.agentId !== undefined) return true;
      if (!open.some((tool) => tool.toolName === dump.toolName)) {
        // Opcja warstwy 1: brak prośby zabiera dowód dopiero wtedy, gdy transkrypt poszedł dalej niż ona.
        if (layer1 !== undefined && !layer1.passed(dump)) return true;
        no(dump.key, 'transkrypt-brak');
        return false;
      }
      // Opcja warstwy 1: skrót bez otwartego odpowiednika niczego nie zabiera i sieroty nie robi. Prośby tej nazwy
      // rozdziela tam wierzch ekranu i pełna pula sesji (`layer1/proof.ts`), a własne zamknięcie prośby zabiera dowód
      // regułą „transkrypt poszedł dalej” i faktem utraty.
      if (layer1 !== undefined) return true;
      // Tryb cienia (`kept` to `afterRegistry`): skrót rozróżnia, gdy inny żywy zrzut tej nazwy ma odpowiednik.
      const comparable = kept.some((other) => other.toolName === dump.toolName && matched(other));
      if (comparable && !matched(dump)) {
        no(dump.key, 'transkrypt-skrot');
        return false;
      }
      return true;
    });
  }

  // Reguła 4: bliźniaki wśród tych, którym nic nie zabrało dowodu, w każdym wątku osobno (bez opcji warstwy 1 prośba
  // subagenta tu nie dochodzi, więc wątek jest jeden).
  const twinCount = new Map<string, number>();
  const twinKey = (dump: HookCallDump): string => `${dump.agentId ?? ''}\n${dump.toolName}\n${dump.inputSha256}`;
  for (const dump of survivors) twinCount.set(twinKey(dump), (twinCount.get(twinKey(dump)) ?? 0) + 1);

  // Reguła 2, kolejka: stojących na ekranie mniej niż żywych zrzutów — nie wiadomo, które są sierotami.
  const queue = input.queue;
  const standing = queue.kind === 'counter' ? queue.standing : queue.kind === 'single' ? 1 : null;
  const queueShort = standing !== null && standing < survivors.length;

  for (const dump of survivors) {
    if ((twinCount.get(twinKey(dump)) ?? 0) > 1) {
      verdicts.set(dump.key, { key: dump.key, kind: 'niejednoznaczny' });
      continue;
    }
    if (queueShort) {
      no(dump.key, 'kolejka');
      continue;
    }
    // Reguła 1: dowód wyłącznie z rejestru `waiting` z klasą zgody, świeżego.
    if (registry.kind === 'unknown' || !registryFresh) no(dump.key, 'rejestr-nieznany');
    else if (registry.kind === 'active') no(dump.key, 'rejestr-nie-czeka');
    else if (registry.dialog !== PERMISSION_CLASS) no(dump.key, 'rejestr-klasa');
    else verdicts.set(dump.key, { key: dump.key, kind: 'stoi' });
  }

  return input.dumps.map((dump) => verdicts.get(dump.key) ?? { key: dump.key, kind: 'brak', why: 'hook-nieznany' });
}

/** Karta, na którą tapnięto: nazwa narzędzia i odcisk wywołania (`callPrint`), gdy karta go ma. */
export interface ShadowCard {
  readonly toolName: string;
  /** Odcisk z wpisu jsonl albo zrzutu hooka; `null` = karta z samego ekranu, dopasowanie po nazwie. */
  readonly callPrint: string | null;
}

/** Wynik wyboru zrzutu pod plik cienia. */
export type ShadowPick =
  | { readonly kind: 'one'; readonly dump: HookCallDump }
  /** `no-dump`: sesja nie ma zrzutu; `no-match`: żaden nie pasuje do karty; `no-proof`: pasujący bez dowodu. */
  | { readonly kind: 'none'; readonly why: 'no-dump' | 'no-match' | 'no-proof'; readonly detail?: NoProofReason }
  | { readonly kind: 'ambiguous'; readonly keys: readonly string[] };

/**
 * Zrzut pod plik cienia: pasuje do karty (nazwa i odcisk wywołania, gdy karta go ma) i ma dowód „dialog stoi”.
 * Dokładnie jeden kandydat = `one`; dwa z dowodem albo choć jeden niejednoznaczny = `ambiguous`; inaczej `none`
 * z powodem. Pliku nie pisze nic poza `one`.
 */
export function pickShadowTarget(
  dumps: readonly HookCallDump[], verdicts: readonly ProofVerdict[], card: ShadowCard,
): ShadowPick {
  if (dumps.length === 0) return { kind: 'none', why: 'no-dump' };
  const byKey = new Map(verdicts.map((verdict) => [verdict.key, verdict]));
  const matching = dumps.filter((dump) => dump.toolName === card.toolName
    && (card.callPrint === null || callPrintOf(dump) === card.callPrint));
  if (matching.length === 0) return { kind: 'none', why: 'no-match' };
  const standing = matching.filter((dump) => byKey.get(dump.key)?.kind === 'stoi');
  const unclear = matching.filter((dump) => byKey.get(dump.key)?.kind === 'niejednoznaczny');
  if (unclear.length > 0 || standing.length > 1) {
    return { kind: 'ambiguous', keys: [...standing, ...unclear].map((dump) => dump.key) };
  }
  const [only] = standing;
  if (only !== undefined) return { kind: 'one', dump: only };
  const first = byKey.get(matching[0]?.key ?? '');
  return first?.kind === 'brak'
    ? { kind: 'none', why: 'no-proof', detail: first.why }
    : { kind: 'none', why: 'no-proof' };
}

function callPrintOf(dump: HookCallDump): string | null {
  try {
    return callPrint(dump.toolName, dump.toolInput);
  } catch {
    return null;
  }
}

/** Sygnały negatywne, po których czekający hook jest sierotą: dialogu jego prośby już nie ma. */
export const ORPHAN_REASONS = [
  'rejestr-nie-czeka', 'transkrypt-brak', 'transkrypt-skrot', 'transkrypt-nadmiar',
] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];

/**
 * Zrzut młodszy niż to nie staje się sierotą przez transkrypt: czytnik transkryptu mógł jeszcze nie dojść do linii
 * `tool_use` tej prośby. Rejestr ma własny zapas ({@link REGISTRY_SLACK_MS}).
 */
export const ORPHAN_TRANSCRIPT_MIN_AGE_MS = 5_000;

export interface OrphanVerdict {
  readonly key: string;
  readonly why: OrphanReason;
}

/** Wejście oceny sierot: jak dowodu, bez licznika kolejki (licznik nie mówi, który hook jest sierotą). */
export type OrphanInput = Omit<EvidenceInput, 'queue'>;

/**
 * Sieroty wśród zrzutów wątku głównego z ŻYWYM procesem hooka (`alive` = `true`; `false` i `null` nie): zrzut,
 * któremu {@link standingProofs} zabrał dowód sygnałem negatywnym — rejestr bez `waiting` odczytany po zrzucie
 * z zapasem (`rejestr-nie-czeka`), zero otwartych `tool_use` tej nazwy (`transkrypt-brak`), skrót bez otwartego
 * odpowiednika przy porównywalnych skrótach (`transkrypt-skrot`, tylko bez opcji warstwy 1). Bliźniaki (ta sama nazwa
 * i skrót) rozstrzyga liczba: gdy otwartych `tool_use` o tej nazwie i skrócie jest co najmniej jeden, ale mniej niż
 * żywych zrzutów, sierotami są najstarsze ponad tę liczbę (`transkrypt-nadmiar`) — kolejne identyczne wywołanie
 * przychodzi po wyniku poprzedniego. Sygnał transkryptu liczy się dopiero po {@link ORPHAN_TRANSCRIPT_MIN_AGE_MS}
 * od zrzutu.
 * W kolejce rejestr zostaje `waiting`, więc hook pierwszej prośby staje się sierotą dopiero przy wyniku jej
 * narzędzia w transkrypcie. Z opcją warstwy 1 zrzut, który dowód stracił na stałe ({@link Layer1Evidence.lost}), jest
 * sierotą po tym samym czasie przy każdym transkrypcie, także nieznanym. Prośba subagenta z opcją warstwy 1 jest
 * sierotą tylko przez zamknięcie w swoim pliku albo fakt utraty (`transkrypt-brak`): rejestr bez `waiting` zabiera jej
 * dowód z wierzchu, nie robi sieroty (5.4), a liczba otwartych wywołań wątku głównego nie dotyczy jej
 * bliźniaków.
 */
export function orphanHooks(input: OrphanInput): OrphanVerdict[] {
  const verdicts = standingProofs({ ...input, queue: { kind: 'unknown' } });
  const byKey = new Map(input.dumps.map((dump) => [dump.key, dump]));
  const settled = (dump: HookCallDump): boolean => input.now - dump.at >= ORPHAN_TRANSCRIPT_MIN_AGE_MS;
  const out: OrphanVerdict[] = [];
  const twins = new Map<string, HookCallDump[]>();
  for (const verdict of verdicts) {
    const dump = byKey.get(verdict.key);
    if (dump === undefined || input.alive.get(dump.key) !== true) continue;
    if (verdict.kind === 'brak') {
      // `rejestr-nie-czeka` bywa też samym brakiem dowodu (zrzut w zapasie): sierotę robi tylko sygnał negatywny.
      if (verdict.why === 'rejestr-nie-czeka') {
        const subagent = input.layer1 !== undefined && dump.agentId !== undefined;
        if (!subagent && registryNegates(input.registry, input.now, dump)) {
          out.push({ key: dump.key, why: verdict.why });
        }
      }
      else if ((verdict.why === 'transkrypt-brak' || verdict.why === 'transkrypt-skrot') && settled(dump)) {
        out.push({ key: dump.key, why: verdict.why });
      }
    } else if (verdict.kind === 'niejednoznaczny') {
      // Liczba otwartych wywołań niżej pochodzi z transkryptu wątku głównego, więc dotyczy tylko jego bliźniaków.
      if (dump.agentId !== undefined) continue;
      const group = `${dump.toolName}\n${dump.inputSha256}`;
      twins.set(group, [...(twins.get(group) ?? []), dump]);
    }
  }
  if (input.transcript === null) return out;
  const transcript = input.transcript;
  for (const group of twins.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const open = transcript.filter((tool) => tool.toolName === first.toolName
      && digestOf(tool.input) === first.inputSha256).length;
    if (open === 0 || group.length <= open) continue;
    const excess = [...group].sort((a, b) => a.at - b.at).slice(0, group.length - open);
    for (const dump of excess) if (settled(dump)) out.push({ key: dump.key, why: 'transkrypt-nadmiar' });
  }
  return out;
}
