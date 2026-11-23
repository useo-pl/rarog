/**
 * Cykl kanału zgód (warstwa 1): maszyna stanów jednego klucza hooka, rekord `consent-records/`, plik odpowiedzi
 * `consent/` i karta kanału (`cards.ts`). Opis stanów: `contract.ts` ({@link CONSENT_CYCLE_STATES}); opis cyklu:
 * `docs/dialogs.md`, „Channel cycle”.
 *
 * Serializacja: każde wejście dla klucza (decyzja z urządzenia, zwolnienie, zdjęcie karty, wyłącznik, sygnały, przegląd
 * plików, dowód z transkryptu, odzyskiwanie) idzie przez jedną kolejkę per klucz (łańcuch obietnic). Pierwsza decyzja
 * `allow`/`deny`, która zapisze `deciding`, wygrywa; druga dostaje `decided` z bieżącym stanem. Zwolnienie,
 * wyłącznik i odzyskiwanie to przejścia sterujące, oceniane według bieżącego stanu.
 *
 * Protokół zapisu decyzji: (1) rekord `deciding` z `fsync` — porażka (pełny dysk) = `write-failed`, bez pliku;
 * (2) podpisany plik `consent/<sesja>/<klucz>.json` z `fsync` — porażka = rekord z powrotem `pending`,
 * `write-failed`; (3) rekord `sent`. Odzyskiwanie po starcie ({@link ConsentCycle.recover}), w tej kolejności:
 * `.claimed` z decyzją i `at` rekordu = odebrana (`claimed`, przy `release` = `released`); `.rejected` bez `.json` =
 * `revoked` (`signature`); `.json` = `sent` (po {@link CONSENT_CLAIM_TIMEOUT_MS} od zapisu odwołany); nic przy
 * `deciding` i `pending` = `revoked` (`restart`). Gwarancja dotyczy awarii procesu, nie utraty zasilania (bez `fsync`
 * katalogu). Odwołanie, którego `rename` padło z innego powodu niż brak pliku, zostawia `sent` (plik może leżeć).
 * With the restart grace ({@link ConsentCycleOptions.restartGraceMs}, `resume.ts`) a `pending` record, a `sent` one
 * inside the claim deadline and a `claimed` `allow` without a receipt whose hook `ps` finds alive wait instead for the
 * hook's second registration; a refused one, or none within G, gives the outcome above (`revoked`, `restart`), and
 * a resumed `sent` counts its claim deadline from that registration, kept in the record (`claimFrom`) for the recovery
 * after another restart.
 *
 * „Zatwierdzono” (`applied`) i „rozstrzygnięto przy biurku” (`settled-at-desk`) daje wyłącznie wynik wywołania
 * związanego z kluczem w transkrypcie (`bind.ts`, `proof.ts`), w trakcie tury, gdy wywołanie klucza na pewno się
 * skończyło, inaczej po jej końcu; `applied` also needs the registration the answer file is signed under equal
 * to what the record took from its first dump, and for an `allow` the hook's receipt (`consentAnswerProven`).
 * The receipt comes from the hook's `POST /claim` ({@link ConsentCycle.confirmReceipt}, check in `receipt.ts`).
 * Rozliczenie tur leży w `turns.ts`. Fakty tury czyta `herdr/consent-evidence.ts` i podaje je
 * {@link ConsentCycle.applyTurn}; checkpoint przeglądu zapisuje {@link ConsentCycle.setCheckpoint}. Moduł nie czyta
 * transkryptu ani panelu (`layer1-granica.test.ts`).
 *
 * Utrata dowodu „dialog stoi” idzie w jedną stronę. Dwa fakty w pamięci procesu, bez zapisu na dysk: klucz, który
 * transkrypt raz minął ({@link ConsentCycle.notePassed}), i powrót gniazda herdr per sesja: okres od `re-attached`
 * ({@link ConsentCycle.markReattached}) do pierwszej obserwacji ze znanym transkryptem
 * ({@link ConsentCycle.noteTranscript}), potem granica z chwili tej obserwacji. A hook can outlive a server restart
 * (restart grace), and the new process has neither fact for it, so a `pending` record that waits for its hook counts
 * the restart as a herdr socket return with the boundary after its hook start (`resume.ts`): no allow button in this
 * process, whatever a later transcript or proof says, because nobody can show its transcript history continuous from
 * the hook start; deny and release stay. A record nobody resumes is revoked, as before the grace.
 * Karta `pending` (albo klucz bez rekordu) z takim faktem nie ma przycisku zgody w żadnym późniejszym widoku, cokolwiek
 * wie czytnik transkryptu; obserwacja sesji podaje fakty do dowodu ({@link ConsentCycle.proofLost}, `observe.ts`).
 * Fakt działa też po odwołaniu karty: hook odwołanej karty może czekać dalej (odwołanie `pending` nie pisze pliku
 * decyzji; zwolnienie hooka niżej dochodzi do niego dopiero przy następnym odpytaniu albo wcale), a jego zrzut nie wraca
 * do reguły bliźniaków (`transkrypt-nadmiar` w `shadow/evidence.ts`). Rekord, który czyta surowy sygnał zrzutu
 * ({@link RAW_SIGNAL_STATES}), idzie za nim także z faktem utraty.
 *
 * Zwolnienie hooka (`releaseHook`): karta skończona bez odebranej odpowiedzi, której hook może czekać dalej
 * (dialog zniknął, koniec tury, klawisz przy biurku, nieudany zapis zwolnienia z urządzenia), dostaje podpisany plik
 * `release`; rekord i karta bez zmian. Rekord subagenta z żywą rejestracją przy sygnale `gone` i końcu biegu bez
 * wyniku zostaje w `pending` i wraca do biurka niżej.
 *
 * Pula sesji ({@link ConsentCycle.notePool}): każdy zrzut per wywołanie i znacznik prośby (`markers/<sesja>/`) widziany
 * w tym procesie, jeden kandydat na klucz, bez względu na `ps`, przycięcie, wątek i stan karty, w pamięci procesu
 * (restart odtwarza z dysku tylko znaczniki). Zniknięcie zrzutu, odwołanie karty, fakty utraty i zamknięcie w
 * transkrypcie z puli nie wyjmują. Wyjście, na stałe: kandydat wątku głównego — świeży rejestr bez `waiting` odczytany
 * co najmniej `REGISTRY_SLACK_MS` po zapisie prośby; kandydat subagenta ze znacznikiem — taki rejestr co najmniej
 * `REGISTRY_SLACK_MS` po obserwacji, w której `ps` potwierdził śmierć jego hooka ({@link ConsentCycle.noteHookDead});
 * kandydat subagenta bez znacznika (hook bez znaczników) zostaje, bo rejestr przy subagencie w tle mówi `busy`. Blokada
 * startu: sesja nie ma dowodu, dopóki nie przyjdzie świeży rejestr bez `waiting` odczytany co najmniej
 * `REGISTRY_SLACK_MS` po utworzeniu cyklu. Znaczniki sprząta wyłącznie cykl: znacznik kandydata po jego wyjściu i
 * terminie odczytów (niżej), a znaczniki sesji razem z pulą na końcu sesji ({@link ConsentCycle.endPool}). Nieudane
 * usunięcie zostawia plik; po restarcie znacznik wraca do puli i wychodzi zwykłą regułą. Pamięć puli: kandydat trzyma
 * tylko pola, które czyta dopasowanie do wierzchu (`topFieldsOf` w `top.ts`), klucz, chwilę zapisu i wątek. Kandydat po
 * wyjściu, gdy minął termin każdego odczytu, który mógł go użyć (wyjście starsze niż `CONSENT_PROOF_TTL_MS`), zostaje
 * jako klucz z chwilą wyjścia, bez zrzutu, i nie wraca z dysku jako nowy. Sufit {@link CONSENT_POOL_MAX} liczy
 * kandydatów bez wyjścia; ponad nim treść puli zostaje zwolniona, a sesja nie ma dowodu do restartu procesu. Dowód z
 * wierzchu ekranu (`observed` w {@link ConsentCycle.observe}) obowiązuje przed terminem i tylko przy kluczu jako
 * zwycięzcy bieżącej puli dla ekranu dowodu ({@link ConsentCycle.topWinner}): sprawdza to krok kolejki obserwacji,
 * widok karty (publikacja i odczyt `card`/`cards`), `decide(allow)` przed zapisem `deciding` i drugi raz po nim, przed
 * podpisem. Po terminie albo po dopisaniu kandydata, który też pasuje, widok karty nie ma przycisku zgody, a
 * `decide(allow)` dostaje `card-changed`; przegląd plików ({@link ConsentCycle.tick}) publikuje taki widok urządzeniom
 * bez czekania na obserwację. Werdykt ze starszego odczytu ekranu nie nadpisuje werdyktu z nowszego.
 *
 * Dowód ukryty (5.3 i 5.6; sygnał `hidden` w {@link ConsentCycle.observe}): prośba subagenta, której dialog
 * stoi w tle, ma dowód z faktów obserwacji bez ekranu ({@link ConsentObserved.hidden}), z terminem od chwili
 * najstarszego odczytu tych faktów. Cykl trzyma go osobno od dowodu z wierzchu, każdy ze swoją chwilą odczytu: werdykt
 * klucza ma najwyżej jeden z nich, a chwila odczytu, której nie przebija starszy werdykt, to chwila odczytu ekranu
 * (dowód z wierzchu i obserwacja bez dowodu) albo chwila odczytu faktów (dowód ukryty). Dowód ukryty obowiązuje tylko
 * przed terminem, tylko dla rekordu z `agentId` i tylko przy trybie `all`; sprawdza to krok kolejki obserwacji,
 * widok karty i `decide(allow)` przed zapisem `deciding` i drugi raz przed podpisem, tak jak dowód z wierzchu. Sygnał
 * `hidden` nie zmienia stanu rekordu (dla przejść to niewiadoma), a zgoda podpisana z nim niesie w rekordzie
 * `proofKind: 'hidden'` (z dowodem z wierzchu `top`). Regułę, która daje sygnał `hidden`, ma obserwacja (`observe.ts`).
 *
 * Dowód z kanału (sygnał `channel` w {@link ConsentCycle.observe}): prośba wątku głównego spoza MCP
 * przy regule `channel` (`RAROG_CONSENT_PROOF` i bramka wersji CLI w `observe.ts`) ma dowód z dowodu własnego
 * i świeżego `waiting: permission`, bez puli i bez wierzchu, z terminem od chwili odczytu rejestru CLI
 * ({@link ConsentObserved.channel}: odczyt + `REGISTRY_MAX_AGE_MS`). Sprawdza go krok kolejki obserwacji, widok karty
 * i `decide(allow)` przed zapisem `deciding` i drugi raz przed podpisem, jak dowód z wierzchu; zgoda niesie
 * `proofKind: 'channel'`. Werdykt bez wpisu dowodu (obserwacja bez `observed`) przycisku nie daje (W-d), a każde
 * przejście `moveTo` sprawdza tabelę {@link CONSENT_TRANSITIONS} (`assertConsentTransition`). Each such check also
 * asks the session's rules now ({@link ConsentCycleOptions.proofRules}): after a kind's change to `screen` neither
 * a channel proof nor a hidden proof taken under `channel` holds, also from an observation that started before.
 *
 * "Always" ({@link ConsentCycleOptions.always}, check in `card.ts`, closed list in `always.ts`): `decide`
 * with `allow-always` passes the same gates as `allow`, then needs the view's `always` before `deciding` and again
 * before signing (else `no-always`). The file is `allow` with reason `allow-always` and `permissionsSha256` of the
 * registration's suggestions; the record carries those updates literally (`permissions`).
 *
 * Tryb `all` ({@link ConsentCycleOptions.mode}): karta prośby subagenta idzie z zakresem
 * `all` (bez `terminal-only`, bez dowodu, więc bez przycisku zgody), pole audytu `buttonless` liczy też ją, a rekord
 * subagenta wraca do biurka: `pending` z żywym sekretem bez dowodu przez
 * {@link CONSENT_SUBAGENT_GRACE_MS} od przyjęcia rejestracji albo od utraty ostatniego dowodu dostaje podpisane
 * `release` z `releaseCause: desk-fallback`. Czas nie biegnie, póki świeży rejestr sesji
 * (z {@link ConsentCycle.notePool}) mówi `waiting: permission`, także przed pierwszym sprawdzeniem rekordu; odczyt
 * starszy niż `REGISTRY_MAX_AGE_MS` wstrzymuje go tylko na swoją świeżość, a odczyt starszy niż najnowszy przyjęty nie
 * zmienia nic. Sprawdzenie idzie w kroku kolejki klucza: w obserwacji i w takcie. Porażka zapisu `release` z `pending`
 * (powrót do biurka, zwolnienie z urządzenia albo `rarog dialogs release`) zostawia `pending` z licznikiem
 * `releaseFailed`; powrót do biurka próbuje znowu przy następnym sprawdzeniu. `deciding`, `sent` i dalsze bez zmian,
 * rekord wątku głównego nigdy, a sygnał `gone` przy żywej rejestracji subagenta rekordu nie odwołuje (hook nie czyta
 * `.revoked`).
 *
 * Linia logu dowodu (diagnostyka): karta wątku głównego w `pending` bez przycisku zgody z powodem `no-proof`
 * dostaje w logu człony dowodu, które odpadły (wierzch, rejestr, dowód własny, fakt utraty), raz na zestaw, a po
 * odzyskaniu dowodu jedną linię „ok” (`noteProof`); karta z regułą `channel` bez członu wierzchu. Decyzji to nie
 * zmienia. Karta subagenta (dowód z wierzchu z pliku subagenta albo dowód ukryty przy trybie `all`) tej linii nie
 * loguje. Linia z nieznanym elementem wierzchu
 * (`top=bash-zone(…)`, `top=edit-zone`, `top=bottom`; `unknownTopOf` w `proof.ts`) zapisuje raz na kartę ekran odczytu
 * dowodu do `<dataDir>/refusals/` (`dumpUnknownTop`): linię spoza listy może napisać agent, więc jej treść idzie tylko
 * do zrzutu, nigdy do logu. Zrzut idzie wyłącznie za linią, więc karta subagenta go nie dostaje. Zapis jest
 * best-effort i karty nie zmienia.
 *
 * Pamięć karty końcowej: publikacja stanu końcowego (`applied`, `settled-at-desk`, `revoked`, `released`) idzie
 * do `onCard` pełnym widokiem, a zaraz po niej zrzut, werdykt, odczyt ekranu dowodu i chwile klucza wychodzą z pamięci,
 * a magazyn trzyma widok bez prezentacji (powód braku zgody i chwila pojawienia się zostają). Stan końcowy nie ma
 * przycisków, a następne przejście z niego (`revoked` → `settled-at-desk`) zmienia tylko stan i przyczynę. Rekord
 * (metadane bez `tool_input`) zostaje w pamięci do restartu: wiązanie, spóźniony dowód, `late` i audyt. Koniec sesji
 * ({@link ConsentCycle.endPool}) zdejmuje karty końcowe sesji z magazynu; karta niekońcowa zostaje bez zmian.
 */
import { existsSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFileSync } from '../../../safe-read.ts';
import { consentSubagentsOpen } from '../hook/contract.ts';
import type { HookCallDump } from '../hook/contract.ts';
import type { RefusalDumper } from '../refusals.ts';
import { writeAtomic } from '../shadow/atomic.ts';
import { REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS, registryNegates } from '../shadow/evidence.ts';
import type { RegistryEvidence } from '../shadow/evidence.ts';
import { isMarkerName, listDir, markerFilePath, markersDirOf } from '../shadow/files.ts';
import type { MarkerScan, ReadMarker } from '../shadow/files.ts';
import { describeHookProcess, describePsFinding } from '../shadow/liveness.ts';
import type { HookProcess, ProcessLiveness, PsFinding } from '../shadow/liveness.ts';
import type { ConsentTurnFacts } from './bind.ts';
import { consentPermissionsSha256 } from './always.ts';
import { consentCardVerdict, consentDumpCardSha256 } from './card.ts';
import type { ConsentCardVerdict, ConsentStanding } from './card.ts';
import { createConsentCards, wireStateOf } from './cards.ts';
import type { ConsentCardView, ConsentCards } from './cards.ts';
import { createConsentDesk } from './desk.ts';
import { consentDeskReasonOf, createConsentDeskReleases } from './desk-reason.ts';
import type { ConsentDeskReason, ConsentDeskRelease } from './desk-reason.ts';
import {
  CONSENT_CLAIMED_STANDING_MS, CONSENT_CLAIMED_SUFFIX, CONSENT_CLAIM_TIMEOUT_MS, CONSENT_FINAL_STATES,
  CONSENT_POOL_MAX, CONSENT_PROOF_TTL_MS, CONSENT_RECORD_VERSION, CONSENT_REJECTED_SUFFIX, CONSENT_REVOKED_SUFFIX,
  CONSENT_SUBAGENT_GRACE_MS, CONSENT_TRANSITIONS,
} from './contract.ts';
import type {
  ConsentCause, ConsentCheckpoint, ConsentCycleState, ConsentDecision, ConsentProofRule, ConsentReasonId,
  ConsentRevokeCause,
} from './contract.ts';
import {
  claimedDialogSignal, consentKeyRule, consentTopMissText, consentTopVerdict, unknownTopOf,
} from './proof.ts';
import type {
  ConsentAfterClaim, ConsentDialogSignal, ConsentPool, ConsentPoolDump, ConsentProofFinding, ConsentTopCheck,
} from './proof.ts';
import { consentReceiptConfirmable } from './receipt.ts';
import { consentFilesDir, consentSignedOf, readConsentRecords, writeConsentRecord } from './records.ts';
import type { ConsentCycleRecord, ConsentProofKind, ConsentRecord, ConsentRecordTimes } from './records.ts';
import type { ConsentEffectiveMode } from './mode.ts';
import type { ConsentRegistry } from './registry.ts';
import { consentClaimKept, createConsentResume } from './resume.ts';
import { signConsentFile } from './sign.ts';
import { topFieldsOf } from './top.ts';
import type { ConsentScreenRead, MatchTop, TopScreen } from './top.ts';
import { createConsentTurns } from './turns.ts';
import type { ConsentEvidenceTarget } from './turns.ts';
import type { ConsentProofRules } from './version-gate.ts';

export type { ConsentEvidenceTarget };

/** Operacje na dysku cyklu; testy podmieniają je, żeby sprawdzić pełny dysk i awarię między krokami protokołu. */
export interface ConsentCycleIo {
  writeRecord(dataDir: string, record: ConsentRecord, options: { fsync: boolean }): void;
  /** Zapis pliku odpowiedzi `<dir>/<name>` atomowo. */
  writeFile(dir: string, name: string, body: string, options: { fsync: boolean }): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  list(dir: string): string[];
  /** Treść małego pliku zwykłego albo `null` (brak, nie plik zwykły, za duży). */
  read(path: string): string | null;
  /** Usunięcie pliku (znacznik prośby). */
  remove(path: string): void;
  /** Usunięcie pustego katalogu (katalog znaczników sesji na końcu sesji). */
  removeDir(path: string): void;
}

/** Sufit odczytu przejętego pliku odpowiedzi (podpisany plik ma kilkaset bajtów). */
const CLAIMED_READ_MAX_BYTES = 64 * 1024;

const defaultIo: ConsentCycleIo = {
  writeRecord: (dataDir, record, options) => { writeConsentRecord(dataDir, record, options); },
  writeFile: (dir, name, body, options) => { writeAtomic(dir, name, body, options); },
  rename: renameSync,
  exists: existsSync,
  list: listDir,
  read: (path) => {
    try {
      const read = readRegularFileSync(path, { maxBytes: CLAIMED_READ_MAX_BYTES, followSymlink: false });
      return read === null || read.truncated ? null : read.bytes.toString('utf8');
    } catch {
      return null;
    }
  },
  remove: unlinkSync,
  removeDir: rmdirSync,
};

export interface ConsentCycleOptions {
  readonly dataDir: string;
  readonly bootId: string;
  /**
   * Rejestr sekretów: podpis, a po potwierdzonej śmierci hooka zapomnienie wpisu (`forget`); the expectations of
   * recovered records ({@link ConsentCycleOptions.restartGraceMs}) when it has them.
   */
  readonly registry: Pick<ConsentRegistry, 'entry' | 'secretOf' | 'entries' | 'forget'>
    & Partial<Pick<ConsentRegistry, 'expectResume' | 'cancelResume'>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Karta dodana albo zmieniona (bez zdarzenia, gdy zapis nic nie zmienił). */
  readonly onCard?: (view: ConsentCardView) => void;
  /**
   * Zapisywacz zrzutów odmów (`refusals.ts`, wyłącznik `RAROG_REFUSAL_DUMPS` w nim): ekran dowodu karty, której linia
   * logu dowodu mówi o nieznanym elemencie wierzchu ({@link ConsentCycle.observe}, „Linia logu dowodu”), raz na kartę.
   * Brak = bez zrzutów.
   */
  readonly dumpUnknownTop?: RefusalDumper;
  readonly io?: Partial<ConsentCycleIo>;
  /**
   * Tryb efektywny kanału (`layer1/mode.ts`), czytany przy każdej ocenie karty i każdym sprawdzeniu powrotu do biurka.
   * Wyłącznie `all` otwiera kanał subagentom (`consentSubagentsOpen` z `hook/contract.ts`): zakres karty `all`,
   * `buttonless` dla subagenta i powrót do biurka. Brak pola, wyjątek źródła i każdy inny tryb = zachowanie `main`.
   */
  readonly mode?: () => ConsentEffectiveMode;
  /** The "always" option of the cards (`RAROG_CONSENT_ALWAYS`, `always.ts`); no field = off. */
  readonly always?: boolean;
  /**
   * The session's proof rules now (the version gate's `current`), asked at every check of a proof taken under
   * `channel`: after a kind's change to `screen` such a proof gives no button and no signature. No field = proofs
   * hold as observed; an exception = `screen`.
   */
  readonly proofRules?: (sessionId: string) => ConsentProofRules;
  /**
   * Restart grace G in ms (`resume.ts`): in {@link ConsentCycle.recover} a record whose hook `ps` finds alive
   * waits this long for the hook's second registration. No field or 0 = recovery as before the grace.
   */
  readonly restartGraceMs?: number;
  /** `ps` for the hooks of recovered records (`psLiveness`); no field = no hook counts as alive. */
  readonly liveness?: ProcessLiveness;
}

/** Odmowy decyzji i zwolnienia; kod HTTP wybiera wołający. */
export type ConsentRefusal =
  /** Brak rekordu klucza. */
  | 'not-found'
  /** Decyzja już zapadła (first-wins) albo stan jej nie dopuszcza. */
  | 'decided'
  /** Zgoda bez przycisku zgody w chwili decyzji. */
  | 'card-changed'
  /** `allow-always` on a card without the "always" option (`always.ts`). */
  | 'no-always'
  /** Serwer nie może podpisać (brak żywej, niezablokowanej rejestracji). */
  | 'not-signable'
  /** Rekord albo plik odpowiedzi nie dał się zapisać (pełny dysk). */
  | 'write-failed'
  /** Odpowiedź odebrana: odwołać jej się nie da, skutek rozliczy transkrypt. */
  | 'too-late'
  /** Karta skończona albo hook nie żyje. */
  | 'gone';

export type ConsentOutcome =
  | { readonly ok: true; readonly state: ConsentCycleState }
  | { readonly ok: false; readonly error: ConsentRefusal; readonly state: ConsentCycleState | null };

export interface ConsentRecoverSummary {
  readonly records: number;
  readonly changed: number;
}

/**
 * Odczyt ekranu, z którego obserwacja wzięła sygnał (`observe.ts`): chwila, termin i wejście dowodu „dialog stoi”.
 * Jeden obiekt na obserwację: cykl pamięta przy nim zwycięzcę wierzchu dla wersji puli.
 */
export interface ConsentObserved {
  /** Chwila rozpoczęcia odczytu ekranu albo, bez odczytu, chwila obserwacji (ms epoki). */
  readonly at: number;
  /**
   * Termin dowodu: rozpoczęcie odczytu + `CONSENT_PROOF_TTL_MS`; `null` = obserwacja bez dowodu (bez ekranu albo
   * z niekompletnym odczytem zrzutów).
   */
  readonly until: number | null;
  /** Odczyt ekranu dowodu; `null` = obserwacja bez dowodu. */
  readonly screen: ConsentScreenRead | null;
  /** Dopasowanie zrzutu do wierzchu (`matchTop` z `top.ts` albo szew obserwacji). */
  readonly matchTop: MatchTop;
  /**
   * Odczyt faktów dowodu ukrytego tej obserwacji (5.6): wejście sygnału `hidden`. Brak albo `null` =
   * obserwacja bez dowodu ukrytego (kanał zamknięty dla subagentów, niekompletny odczyt zrzutów albo znaczników).
   */
  readonly hidden?: ConsentHiddenRead | null;
  /**
   * Odczyt rejestru CLI tej obserwacji przy regule `channel`: wejście sygnału `channel`, z terminem od chwili
   * odczytu rejestru. Brak albo `null` = obserwacja bez dowodu z kanału (reguła `screen`, rejestr nieznany).
   */
  readonly channel?: ConsentChannelRead | null;
  /**
   * Linia logu dowodu: dlaczego obserwacja jest bez ekranu dowodu (`no-screen` bez odczytu ekranu, `scan-incomplete`
   * przy niekompletnym odczycie zrzutów albo znaczników); brak pola = `no-screen`.
   */
  readonly unread?: 'no-screen' | 'scan-incomplete';
  /** Linia logu dowodu: wierzch ekranu (`topScreen` z `top.ts`); brak przy szwie dopasowania. */
  readonly screenTop?: (screenText: string) => TopScreen;
}

/** Odczyt faktów dowodu ukrytego jednej obserwacji (`observe.ts`): chwila i termin. */
export interface ConsentHiddenRead {
  /** Chwila rozpoczęcia najstarszego odczytu faktów, z których reguła wzięła sygnał (ms epoki). */
  readonly at: number;
  /** Termin dowodu: `at` + `CONSENT_PROOF_TTL_MS`. */
  readonly until: number;
  /**
   * The rule each request's proof was taken under, per dump key (`consentHiddenKeyRule` of the observation's
   * subagents' rule: an MCP tool takes `screen` also under `channel`). A proof taken under `channel` holds only while
   * the session's subagents' rule stays `channel` (`proofRules`); a key without an entry holds as observed.
   */
  readonly keyRules?: ReadonlyMap<string, ConsentProofRule>;
}

/**
 * Odczyt rejestru CLI, z którego obserwacja wzięła dowód z kanału (`observe.ts`, reguła `channel`): chwila i termin.
 */
export interface ConsentChannelRead {
  /** Chwila odczytu rejestru CLI (ms epoki). */
  readonly at: number;
  /** Termin dowodu: `at` + `REGISTRY_MAX_AGE_MS` (rejestr świeży). */
  readonly until: number;
}

/**
 * Sygnał obserwacji jednego klucza: sygnał dowodu z wierzchu ({@link ConsentDialogSignal}), `hidden`: dialog prośby
 * subagenta stoi ukryty według faktów odczytu {@link ConsentObserved.hidden} (5.3), albo `channel`: dialog
 * prośby wątku głównego stoi według reguły `channel` (dowód własny i świeży `waiting: permission` z odczytu
 * {@link ConsentObserved.channel}, bez wierzchu ekranu).
 */
export type ConsentObservedSignal = ConsentDialogSignal | 'hidden' | 'channel';

/** Przejście cyklu spoza {@link CONSENT_TRANSITIONS} (W-d): błąd programu, nie stan karty. */
export function assertConsentTransition(from: ConsentCycleState, to: ConsentCycleState): void {
  if (!(CONSENT_TRANSITIONS[from] as readonly ConsentCycleState[]).includes(to)) {
    throw new Error(`consent: transition ${from} → ${to} is not in the cycle table`);
  }
}

/** Przyczyna odwołania kart całej sesji ({@link ConsentCycle.revokeSession}). */
export type ConsentSessionRevokeCause = Extract<ConsentRevokeCause, 'hook-dead' | 'dialog-gone'>;

/** Why a `dead` signal came ({@link ConsentCycle.observe}): the `ps` finding of the hook, or the call dump is gone. */
export type ConsentDeadWhy = { readonly ps: PsFinding } | { readonly cause: 'call dump gone' };

export interface ConsentCycle {
  /**
   * Zrzut klucza i sygnał o dialogu (T-01, T-04, T-08, T-09): bez rekordu zakłada `pending` z kartą, przy rekordzie
   * odświeża kartę i ocenia sygnał według stanu. Bez zrzutu sam sygnał (hook wyszedł i zrzut zniknął). Sygnał
   * `dead` (potwierdzona śmierć procesu hooka) zapomina wpis rejestru klucza, także bez rekordu. Przy `claimed`
   * sygnał `dead` sam niczego nie zmienia: stan wybiera reguła `claimedDialogSignal` (`proof.ts`) z faktów sesji
   * `afterClaim` (rejestr CLI, inny żywy zrzut wątku głównego, wierzch ekranu); bez faktów karta zostaje `claimed`.
   *
   * `observed` = odczyt ekranu obserwacji (`observe.ts` podaje go zawsze): `standing` (także z reguły karty `claimed`)
   * liczy się tylko przed terminem `until`, tylko przy kluczu jako zwycięzcy bieżącej puli dla ekranu dowodu
   * ({@link topWinner}, w kroku kolejki klucza) i tylko z odczytu nie starszego niż ten, z którego wziął się bieżący
   * werdykt klucza; odczyt starszy nie zmienia werdyktu karty `pending`. Bez `observed` (testy maszyny stanów,
   * zamiatanie rejestru sygnałem `dead`) werdykt `standing` nie daje przycisku zgody (W-d: dowód bez wpisu nie
   * obowiązuje), a przejścia stanu biorą go bez sprawdzenia puli.
   *
   * `hidden` (dowód ukryty, 5.3) liczy się tylko z odczytem {@link ConsentObserved.hidden} przed jego
   * terminem, dla prośby subagenta i przy trybie `all`, z odczytu faktów nie starszego niż ten, z którego wziął się
   * bieżący werdykt; inaczej, i zawsze dla przejść stanu, to niewiadoma.
   *
   * `channel` (reguła `channel`) liczy się jak `standing`, bez puli i wierzchu: tylko z odczytem
   * {@link ConsentObserved.channel} przed jego terminem (odczyt rejestru + `REGISTRY_MAX_AGE_MS`), dla prośby wątku
   * głównego spoza MCP, z odczytu rejestru nie starszego niż ten, z którego wziął się bieżący werdykt (kolejność według
   * chwili odczytu rejestru, nie ekranu ani obserwacji) i późniejszego niż ostatni status sesji bez `waiting:
   * permission` ({@link noteRegistryNotWaiting}). Dla przejść stanu (karta `claimed`) przy innym żywym zrzucie w sesji
   * (`afterClaim.otherLive`) to niewiadoma: rejestr może mówić o dialogu tamtej prośby.
   *
   * `finding` = człony dowodu poza wierzchem z obserwacji (`consentDialogFindings` w `proof.ts`): wyłącznie do linii
   * logu `consent: proof of key <key> missing: …` przy karcie `pending` bez dowodu; decyzji nie zmienia.
   *
   * `deadWhy` = why the signal is `dead`, only for the log line of the forgotten registration; changes no decision.
   */
  observe(
    sessionId: string, key: string, signal: ConsentObservedSignal, dump?: HookCallDump, afterClaim?: ConsentAfterClaim,
    observed?: ConsentObserved, finding?: ConsentProofFinding, deadWhy?: ConsentDeadWhy,
  ): Promise<ConsentCardView | null>;
  /**
   * Status rejestru CLI sesji bez `waiting: permission` przyjęty przez driver, z chwilą odczytu `at` (port drivera
   * `consentRegistryNotWaiting`). Dowód z kanału sesji z odczytu rejestru nie późniejszego niż `at` przestaje
   * obowiązywać od razu, także gdy obserwacja z takim odczytem jeszcze trwa: jej sygnał `channel` nie zmienia werdyktu.
   * Chwila nie maleje (starszy status nic nie zmienia). Wynik po publikacji kart `pending`, którym to zabrało dowód.
   */
  noteRegistryNotWaiting(sessionId: string, at: number): Promise<void>;
  /**
   * Koniec sesji silnika (wyzwalacz managera): karty `pending` = `revoked` z przyczyną, `sent` = plik odpowiedzi
   * odwołany jak przy {@link off} (hook szybszy od odwołania = `claimed`); `claimed`, `running` i stany końcowe bez
   * zmian. Żadnego nowego pliku odpowiedzi. `hook-dead` zapomina wpisy rejestru sesji. Wynik = klucze kart, których
   * stan się zmienił, w kolejności pojawienia się kart.
   */
  revokeSession(sessionId: string, cause: ConsentSessionRevokeCause): Promise<readonly string[]>;
  /** Decyzja z urządzenia (T-02): protokół zapisu, first-wins. */
  decide(sessionId: string, key: string, decision: 'allow' | 'allow-always' | 'deny'): Promise<ConsentOutcome>;
  /** Zwolnienie do terminala (T-10), przejście sterujące według bieżącego stanu. */
  release(sessionId: string, key: string): Promise<ConsentOutcome>;
  /**
   * The hook's receipt of the record's `allow` (`POST /claim`, W-a): only the live `allow` with this `decisionAt`
   * (`consentReceiptConfirmable`) gets the `receipt` field, written with `fsync` before the answer; a `sent` record
   * moves to `claimed`. `true` = the hook may give `allow` (also a repeat for the same `decisionAt`); `false` = another
   * state, decision or `at`, or a failed write. In the key's queue, so a revoke, release or file review comes either
   * before it (and the receipt is refused) or after it (and sees `claimed`).
   */
  confirmReceipt(sessionId: string, key: string, at: number, inputSha256: string): Promise<boolean>;
  /**
   * Karta zdjęta z urządzeń na końcu sesji (manager): rekord niekońcowy dostaje pole `retired` (raz, z chwilą), a stan
   * zostaje. Od tej chwili zmiany karty nie idą do `onCard`, także po restarcie (`recover`); magazyn kart i rekord
   * idą dalej za dowodem. Bez pliku odpowiedzi. `true` = rekord niesie pole; `false` = brak rekordu albo stan
   * końcowy. Błąd zapisu zostaje w logu, pole w pamięci.
   */
  retire(sessionId: string, key: string): Promise<boolean>;
  /** Wyłącznik kanału: `pending` → `revoked` (`off`), `sent` → plik odwołany; odebrane bez zmian. */
  off(): Promise<void>;
  /**
   * Przegląd plików odpowiedzi (T-03, T-08): przejęcie, odłożenie, termin przejęcia. Ten sam takt publikuje karty
   * `pending`, których widok zmienił się bez obserwacji (termin dowodu, pula sesji, rejestracja), także gdy obserwacja
   * sesji pada.
   */
  tick(): Promise<void>;
  /** Odzyskiwanie po starcie z rekordów i plików (T-11). Woła się raz, przed pierwszym `observe`. */
  recover(): Promise<ConsentRecoverSummary>;
  /** Checkpoint przeglądu transkryptu dla rekordu (pierwszy tik); istniejący zostaje. */
  setCheckpoint(sessionId: string, key: string, checkpoint: ConsentCheckpoint): Promise<void>;
  /** Tury, dla których przegląd transkryptu ma jeszcze czego szukać. */
  evidenceTargets(): ConsentEvidenceTarget[];
  /**
   * Fakty tury z transkryptu (T-05, T-06, T-07). `forcedEnd` zamyka turę bez wpisu w transkrypcie (bezczynność
   * sesji, `/exit`) — wtedy rozliczane są wyłącznie odpowiedzi odebrane; karty `pending` i `sent` zostają. Fakty
   * z `agent` to tura subagenta: rozlicza rekordy z tym `agentId` (tylko przy trybie `all`), każdy klucz po końcu
   * biegu agenta nie starszym niż start jego hooka, a `forcedEnd` jej nie dotyczy. Klucz, którego wywołanie na pewno
   * się skończyło, rozlicza się już w trakcie tury (`bindDuringTurn` w `bind.ts`).
   */
  applyTurn(sessionId: string, promptId: string, facts: ConsentTurnFacts, forcedEnd?: boolean): Promise<void>;
  /**
   * Klucze zrzutów sesji, które transkrypt minął (`transcriptPassed` w `proof.ts`, liczone w `observe.ts` przed
   * odczytem `ps`). Fakt zapisuje się tylko dla klucza bez rekordu albo z rekordem `pending` i zostaje do końca procesu.
   */
  notePassed(sessionId: string, keys: readonly string[]): void;
  /**
   * Powrót gniazda herdr na panelu sesji (port managera, w tym samym kroku synchronicznym co odpięcie starego drivera):
   * otwiera okres, w którym zrzut sesji z rekordem `pending` albo bez rekordu traci dowód, także gdy hook wystartował
   * po wywołaniu, a rekord powstanie później. Okres kończy {@link noteTranscript}. Granica = chwila wywołania, ustawiona
   * od razu (nie maleje).
   * Wynik po publikacji kart `pending` sesji bez przycisku zgody.
   */
  markReattached(sessionId: string): Promise<void>;
  /**
   * Obserwacja sesji ze znanym transkryptem (`observe.ts`, na początku kroku, przed odczytem `ps`). Pierwsza po
   * {@link markReattached} należy do nowego drivera: stary jest już odpięty i nie zaczyna obserwacji. Kończy okres,
   * a granica = `at` (nie maleje). Bez otwartego okresu nic nie zmienia.
   */
  noteTranscript(sessionId: string, at: number): void;
  /**
   * Pula sesji (obserwacja, `observe.ts`, w synchronicznym początku kroku): zrzuty `dumps` (wszystkie przeczytane, także
   * formularza pytania i subagenta), potem znaczniki prośby `markers.markers` (`scanMarkers` w `shadow/files.ts`: tylko
   * nazwy, których pula nie znała) dochodzą jako kandydaci pod kluczem albo nazwą znacznika, chyba że klucz jest już
   * w puli (także po wyjściu, bez zrzutu): jeden kandydat na klucz, z polami pierwszego odczytu. Kandydat, którego nazwa
   * jest w `markers.names`, ma znacznik na dysku. Kandydat po wyjściu starszym niż `CONSENT_PROOF_TTL_MS` przed `at`
   * zostaje kluczem z chwilą wyjścia, a jego znacznik znika z dysku.
   * Świeży rejestr bez `waiting` odczytany w chwili `at` zdejmuje blokadę startu (odczyt co najmniej `REGISTRY_SLACK_MS`
   * po utworzeniu cyklu) i wyjmuje z puli kandydatów wątku głównego zapisanych co najmniej `REGISTRY_SLACK_MS` przed
   * odczytem (`registryNegates` z `shadow/evidence.ts`) oraz kandydatów subagenta, których śmierć hooka
   * ({@link noteHookDead}) zapisano co najmniej `REGISTRY_SLACK_MS` przed odczytem. Kandydat ponad
   * {@link CONSENT_POOL_MAX} kandydatów bez wyjścia nie wchodzi: treść puli zostaje zwolniona, a sesja traci dowód do
   * restartu procesu albo końca sesji ({@link endPool}).
   */
  notePool(
    sessionId: string, dumps: readonly HookCallDump[], registry: RegistryEvidence, at: number,
    markers?: Pick<MarkerScan, 'markers' | 'names'>,
  ): void;
  /**
   * Czy pula sesji zna nazwę: kandydat albo wyjście pod tym kluczem, albo pula po przekroczeniu sufitu (wtedy każda).
   * Odczyt znaczników (`observe.ts`) nie parsuje znanych nazw.
   */
  poolKnows(sessionId: string, name: string): boolean;
  /**
   * Hooki do sprawdzenia w `ps`: kandydaci subagenta ze znacznikiem prośby, bez wyjścia i bez zapisanej śmierci hooka,
   * najdawniej sprawdzany najpierw ({@link noteHookChecks}; kandydat jeszcze niesprawdzany liczy się jak sprawdzony
   * w chwili dopisania do puli), przy równym sprawdzeniu w kolejności pierwszego odczytu. Obserwacja pyta początek
   * listy, a sprawdzone klucze idą na jej koniec, więc obserwacje idą po liście w koło: każdy hook dostaje sprawdzenie
   * w skończonej liczbie obserwacji (nowy kandydat staje za czekającymi), cokolwiek `ps` mówi o innych. Kandydat
   * wątku głównego i kandydat bez znacznika tu nie trafiają.
   */
  hookWatch(sessionId: string): readonly ConsentHookWatch[];
  /**
   * Sprawdzenie hooków kandydatów subagenta w `ps` (`observe.ts`: po odczycie `ps` w obserwacji z kompletnym odczytem
   * zrzutów i znaczników, przy każdej odpowiedzi o pid, także jej braku): te klucze idą na koniec listy
   * {@link hookWatch}, między sobą w kolejności pierwszego odczytu. Klucz spoza puli bez zmian.
   */
  noteHookChecks(sessionId: string, keys: readonly string[]): void;
  /**
   * Śmierć hooków kandydatów subagenta ze znacznikiem (`observe.ts`: `ps` odpowiedział `false` dla pidu i startu
   * w obserwacji z kompletnym odczytem zrzutów i znaczników) w chwili `at`, raz: od niej liczy się wyjście z puli
   * ({@link notePool}). Inny klucz i kandydat z zapisaną już śmiercią bez zmian.
   */
  noteHookDead(sessionId: string, keys: readonly string[], at: number): void;
  /**
   * Koniec sesji silnika (port managera, panel `gone` albo wyjście procesu, gdy żaden inny żywy panel nie prowadzi tej
   * rozmowy): pula sesji i karty końcowe sesji znikają z pamięci (rekordy zostają), a znaczniki prośby sesji z dysku,
   * potem pusty katalog sesji. Nieudane usunięcie zostawia plik (sprzątanie startu, retencja 7 dni) i idzie do logu.
   * Następna obserwacja tej sesji zaczyna pustą pulę. Karty niekońcowe zostają.
   */
  endPool(sessionId: string): void;
  /**
   * Pula sesji (kopia): kandydaci ze zrzutem w kolejności pierwszego odczytu, kandydaci po wyjściu bez zrzutu, blokada
   * startu i sufit.
   */
  pool(sessionId: string): ConsentPool;
  /**
   * Zrzut na wierzchu ekranu obserwacji z bieżącej puli sesji (`consentTopWinner` w `proof.ts`): klucz albo `null`
   * (obserwacja bez dowodu, termin `observed.until` minął, pula bez jedynego `match`). Wynik liczy się w chwili
   * wywołania: kandydat dopisany przez inną obserwację zmienia go od razu.
   */
  topWinner(sessionId: string, observed: ConsentObserved): string | null;
  /**
   * Czy zrzut stracił dowód na stałe: klucz minięty ({@link notePassed}), okres powrotu gniazda otwarty
   * ({@link markReattached}) albo hook nie późniejszy niż granica. Rekord w stanie {@link RAW_SIGNAL_STATES} = `false`
   * (zrzut idzie za surowym sygnałem); bez rekordu, przy `pending`, `unknown` i w stanie końcowym fakt działa, więc
   * odwołana karta, której hook czeka dalej, zostaje poza regułami bliźniaków i kolejki.
   */
  proofLost(sessionId: string, dump: Pick<HookCallDump, 'key' | 'startedAt'>): boolean;
  /** Rekord klucza (kopia) albo `null`. */
  record(sessionId: string, key: string): ConsentCycleRecord | null;
  /**
   * What the desk release of the key kept (reason, hook list `why`, request `cwd`), while its record carries
   * `releaseCause: desk-fallback` and the engine session lasts ({@link endPool}); `null` otherwise and after a restart.
   */
  deskRelease(sessionId: string, key: string): ConsentDeskRelease | null;
  /**
   * Czy w sesji jest rekord z `agentId` w `pending` (prośba subagenta czeka): driver obserwuje wtedy sesję przy trybie
   * `all` co najwyżej co sekundę ze świeżym odczytem rejestru (5.6).
   */
  subagentPending(sessionId: string): boolean;
  /**
   * Karta klucza albo `null`; widok liczony przy odczycie (termin dowodu, bieżąca pula sesji, rejestracja). Karta
   * końcowa po publikacji ma `presentation: null`, a po {@link endPool} jej nie ma.
   */
  card(sessionId: string, key: string): ConsentCardView | null;
  /** Karty w kolejności pojawienia się; widok każdej liczony przy odczycie jak w {@link card}. */
  cards(sessionId?: string): ConsentCardView[];
  /** Zdejmuje kartę z magazynu (rekord zostaje); `true` = była. */
  dropCard(sessionId: string, key: string): boolean;
  /**
   * Diagnostyka dla testów, produkcja tego nie woła: klucze sesji z wpisem w każdej mapie pamięci cyklu. Mapy treści
   * (zrzut, werdykt, odczyt dowodu: ekranu albo faktów dowodu ukrytego, chwila odczytu, chwila pojawienia się) nie mają
   * kluczy kart końcowych po publikacji.
   */
  diagnosticMemory(sessionId: string): ConsentCycleMemory;
}

/** Klucze sesji z wpisem w mapach pamięci cyklu ({@link ConsentCycle.diagnosticMemory}). */
export interface ConsentCycleMemory {
  readonly dumps: readonly string[];
  readonly verdicts: readonly string[];
  /** Odczyty dowodu bieżącego werdyktu: ekranu (dowód z wierzchu) i faktów dowodu ukrytego. */
  readonly proofs: readonly string[];
  readonly seenAt: readonly string[];
  readonly createdAt: readonly string[];
  /** Magazyn kart (`cards.ts`). */
  readonly cards: readonly string[];
  /** Rekordy (metadane bez `tool_input`): zostają także dla kart końcowych. */
  readonly records: readonly string[];
  /** Powody braku dowodu z obserwacji i ostatnia linia logu dowodu: tylko karty `pending`. */
  readonly proofMisses: readonly string[];
  readonly proofNotes: readonly string[];
}

const FINAL = CONSENT_FINAL_STATES as readonly ConsentCycleState[];

function isFinal(state: ConsentCycleState): boolean {
  return FINAL.includes(state);
}

/**
 * Stany rekordu, przy których zrzut idzie za surowym sygnałem także z faktem utraty dowodu: decyzja z urządzenia
 * zapadła, a odpowiedź czeka na odbiór albo jest odebrana. `sent` rozlicza śmierć hooka, `claimed` zniknięcie i stanie
 * dialogu (30 s = `unknown: no-effect`); `deciding` (stan wewnętrzny zapisu decyzji) poprzedza `sent`, a `running`
 * czeka na skutek w transkrypcie. W każdym innym stanie (bez rekordu, `pending`, `unknown`, stany końcowe) zrzut
 * z faktem utraty nie ma dowodu i nie liczy się w regułach bliźniaków i kolejki. Rekord `unknown`
 * i rekord w stanie końcowym biorą z sygnałów zrzutu tylko `dead` (zapomnienie rejestracji), więc werdykt bez dowodu
 * niczego w nich nie zmienia.
 */
const RAW_SIGNAL_STATES: readonly ConsentCycleState[] = ['deciding', 'sent', 'claimed', 'running'];

/** Hook kandydata subagenta ze znacznikiem prośby do sprawdzenia w `ps` ({@link ConsentCycle.hookWatch}). */
export interface ConsentHookWatch {
  readonly key: string;
  readonly pid: number;
  readonly startedAt: number;
}

/** Kandydat puli w pamięci: pola dopasowania, proces hooka i stan wyjścia. */
interface PoolCandidate {
  readonly dump: ConsentPoolDump;
  exitAt: number | null;
  /** Proces hooka prośby z pierwszego odczytu klucza (wyjście kandydata subagenta po śmierci hooka). */
  readonly pid: number;
  readonly startedAt: number;
  /** Znacznik prośby pod tym kluczem leżał na dysku w którejś obserwacji: cykl kasuje go po wyjściu kandydata. */
  marked: boolean;
  /** Chwila potwierdzonej śmierci hooka kandydata subagenta ze znacznikiem ({@link ConsentCycle.noteHookDead}). */
  deadAt: number | null;
  /**
   * Numer ostatniego sprawdzenia hooka w `ps` ({@link PoolState.checks}); przy dopisaniu do puli bieżący numer, więc
   * nowy kandydat czeka za sprawdzonymi wcześniej ({@link ConsentCycle.hookWatch}).
   */
  checkedAt: number;
}

/** Pula sesji w pamięci ({@link ConsentCycle.notePool}). */
interface PoolState {
  /** Kandydaci ze zrzutem w kolejności pierwszego odczytu: bez wyjścia albo po wyjściu w terminie odczytu. */
  readonly candidates: Map<string, PoolCandidate>;
  /** Kandydaci po wyjściu bez zrzutu: klucz → chwila wyjścia (ms epoki). */
  readonly exited: Map<string, number>;
  /** Najpóźniejsze wyjście w {@link exited}; `null` = brak. */
  exitedAt: number | null;
  /** Kandydaci bez wyjścia: tylko ich liczy sufit {@link CONSENT_POOL_MAX}. */
  live: number;
  unlockedAt: number | null;
  overflow: boolean;
  /**
   * Rośnie przy każdej zmianie puli, z licznika całego cyklu (pula po końcu sesji zaczyna od nowej wartości): zwycięzca
   * wierzchu policzony przy starszej wersji jest nieaktualny.
   */
  version: number;
  /** Liczba sprawdzeń hooków kandydatów subagenta w `ps` ({@link ConsentCycle.noteHookChecks}). */
  checks: number;
}

/** Zrzut do pamięci puli: klucz, chwila zapisu, wątek i pola dopasowania do wierzchu (`topFieldsOf`). */
function poolDumpOf(dump: HookCallDump): ConsentPoolDump {
  return {
    key: dump.key, at: dump.at, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }), ...topFieldsOf(dump),
  };
}

/** Znacznik prośby do pamięci puli: nazwa znacznika jako klucz, chwila zapisu, wątek i pola dopasowania. */
function poolDumpOfMarker(marker: ReadMarker): ConsentPoolDump {
  return {
    key: marker.name, at: marker.at, ...(marker.agentId === undefined ? {} : { agentId: marker.agentId }),
    ...topFieldsOf(marker),
  };
}

/** Ostatnia linia logu dowodu klucza to „ok” (dowód odzyskany po linii „missing”). */
const PROOF_OK = 'ok';

/** Pusty zbiór nazw znaczników: obserwacja bez odczytu znaczników. */
const NO_NAMES: ReadonlySet<string> = new Set();

function slotOf(sessionId: string, key: string): string {
  return `${sessionId}\n${key}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

/** Stan karty po odczycie dowodu „dialog stoi”: martwy hook i niewiadoma bez przycisku zgody. */
function standingOf(signal: ConsentDialogSignal): ConsentStanding {
  if (signal === 'standing') return 'standing';
  return signal === 'dead' ? 'dead' : 'unknown';
}

export function createConsentCycle(options: ConsentCycleOptions): ConsentCycle {
  const { dataDir, bootId, registry } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const io: ConsentCycleIo = { ...defaultIo, ...options.io };
  const records = new Map<string, ConsentCycleRecord>();
  const verdicts = new Map<string, ConsentCardVerdict>();
  /** Ostatni zrzut klucza: karta `pending` przelicza werdykt przy każdym sygnale. */
  const dumps = new Map<string, HookCallDump>();
  const createdAt = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  /** Sloty kluczy, które transkrypt minął, póki rekord był `pending` albo go nie było ({@link ConsentCycle.notePassed}). */
  const passedSlots = new Set<string>();
  /**
   * Granica powrotu gniazda herdr per sesja silnika (ms epoki): chwila ostatniego `re-attached`, potem chwila obserwacji,
   * która zamknęła jego okres.
   */
  const reattachAt = new Map<string, number>();
  /** Sesje silnika z otwartym okresem powrotu gniazda: od `re-attached` do pierwszej obserwacji ze znanym transkryptem. */
  const reattachOpen = new Set<string>();
  const store: ConsentCards = createConsentCards();
  /** Chwila utworzenia cyklu: blokada startu trwa do rejestru bez `waiting` co najmniej `REGISTRY_SLACK_MS` później. */
  const startedAt = now();
  /** Pule sesji silnika ({@link ConsentCycle.notePool}). */
  const pools = new Map<string, PoolState>();
  /** Licznik wersji pul całego cyklu: każda zmiana dowolnej puli dostaje nową wartość ({@link PoolState.version}). */
  let poolVersions = 0;
  /**
   * Chwila odczytu, z którego wziął się bieżący werdykt klucza: ekranu (`ConsentObserved.at`) albo, przy dowodzie
   * ukrytym, faktów ({@link ConsentHiddenRead.at}).
   */
  const seenAt = new Map<string, number>();
  /**
   * Odczyt ekranu, z którego wziął się bieżący werdykt karty `pending` (termin i wejście dowodu z wierzchu); brak wpisu
   * tu, w {@link hiddenProofs} i w {@link channelProofs} = dowód nie obowiązuje (W-d; obserwacja bez `observed`). Karta
   * po wyjściu z `pending` wpisu nie trzyma.
   */
  const proofs = new Map<string, ConsentObserved>();
  /**
   * Odczyt faktów dowodu ukrytego, z którego wziął się bieżący werdykt karty `pending` (sygnał `hidden`, 5.6).
   * Klucz ma wpis najwyżej w jednej z map dowodu. Karta po wyjściu z `pending` wpisu nie trzyma.
   */
  const hiddenProofs = new Map<string, ConsentHiddenRead>();
  /**
   * Odczyt rejestru CLI, z którego wziął się bieżący werdykt karty `pending` z dowodem z kanału (sygnał `channel`).
   * Klucz ma wpis najwyżej w jednej z map dowodu. Karta po wyjściu z `pending` wpisu nie trzyma.
   */
  const channelProofs = new Map<string, ConsentChannelRead>();
  /**
   * Chwila odczytu najnowszego statusu rejestru CLI sesji bez `waiting: permission` przyjętego przez driver
   * ({@link noteRegistryNotWaiting}); dowód z kanału z odczytu nie późniejszego nie obowiązuje. Wpis per sesja zostaje
   * do końca procesu (liczba, nie treść).
   */
  const registryNotWaitingAt = new Map<string, number>();
  /** Sprawdzenie wierzchu per odczyt ekranu obserwacji przy wersji puli sesji ({@link topWinner}). */
  const winners = new WeakMap<ConsentObserved, { readonly version: number; readonly check: ConsentTopCheck }>();
  /**
   * Człony dowodu, które odpadły w obserwacji bieżącego werdyktu karty `pending` bez dowodu (wierzch z kroku kolejki,
   * rejestr i dowód własny z obserwacji), jako części linii logu ({@link noteProof}).
   */
  const misses = new Map<string, readonly string[]>();
  /** Ostatnia linia logu dowodu karty `pending`: zestaw powodów braku albo {@link PROOF_OK}. */
  const proofNotes = new Map<string, string>();
  /** Karty, których ekran z nieznanym elementem wierzchu poszedł już do zrzutu ({@link dumpUnknownTop}). */
  const topDumped = new Set<string>();
  /** Reason code (and the hook list's `why`) of the last observation of a subagent `pending` key without proof. */
  const deskReasons = new Map<string, { readonly reason: ConsentDeskReason; readonly hooks: string | null }>();
  const deskReleases = createConsentDeskReleases();
  /** Desk fallback with its clocks and holds (`desk.ts`). */
  const desk = createConsentDesk<ConsentOutcome>({
    records, registry, dumps, deskReasons, deskReleases, slotOf, now, log, subagentsOpen, viewOf, writeDecision, commit,
    publish,
  });
  const { noteHeld, releasePending, deskFallback, mcpToDesk } = desk;
  /**
   * Sloty, których zwolnienia hooka ({@link releaseHook}) nie dało się zapisać: następna obserwacja z żywym zrzutem
   * klucza próbuje jeszcze raz. W pamięci procesu: po restarcie hook starego procesu widzi nowy `bootId` i wychodzi sam.
   */
  const releaseDue = new Set<string>();
  /** Records recovered after a restart that wait for their hook's second registration (`resume.ts`). */
  const resume = createConsentResume({
    graceMs: options.restartGraceMs ?? 0, registry, now, log,
    ...(options.liveness === undefined ? {} : { liveness: options.liveness }),
    read: (record, suffix) => { const path = pathOf(record, suffix); return path === null ? null : io.read(path); },
    // The claim deadline start of a resumed `sent` goes to its record at once, for the recovery after another restart.
    onResumed: (sessionId, key, decisionAt, at) => {
      enqueue(slotOf(sessionId, key), () => {
        const kept = consentClaimKept(records.get(slotOf(sessionId, key)), decisionAt, at);
        if (kept !== null) commit(kept, false, true);
      }).catch((err: unknown) => { log(`consent: claim start of ${key} not kept: ${errText(err)}`); });
    },
  });

  /** Kanał otwarty dla subagentów (tryb efektywny `all`); wyjątek źródła trybu = zamknięty. */
  function subagentsOpen(): boolean {
    try {
      return consentSubagentsOpen(options.mode?.());
    } catch {
      return false;
    }
  }

  function enqueue<T>(slot: string, task: () => T | Promise<T>): Promise<T> {
    const previous = queues.get(slot) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    queues.set(slot, settled);
    void settled.then(() => {
      if (queues.get(slot) === settled) queues.delete(slot);
    });
    return run;
  }

  /**
   * Sloty z rekordem albo z zadaniem w kolejce (pierwsza obserwacja klucza tworzy rekord dopiero w swoim zadaniu).
   * Odwołanie zakolejkowane za taką obserwacją widzi jej rekord, więc karta nie zostaje `pending` po końcu sesji.
   */
  function slotsOf(sessionId?: string): string[] {
    const prefix = sessionId === undefined ? '' : slotOf(sessionId, '');
    const slots = new Set<string>();
    for (const [slot, record] of records) if (sessionId === undefined || record.sessionId === sessionId) slots.add(slot);
    for (const slot of queues.keys()) if (slot.startsWith(prefix)) slots.add(slot);
    return [...slots];
  }

  function filesDir(sessionId: string): string | null {
    return consentFilesDir(dataDir, sessionId);
  }

  function pathOf(record: ConsentRecord, suffix: string): string | null {
    const dir = filesDir(record.sessionId);
    return dir === null ? null : join(dir, `${record.key}${suffix}`);
  }

  function hasRejected(record: ConsentRecord): boolean {
    const dir = filesDir(record.sessionId);
    if (dir === null) return false;
    try {
      return io.list(dir).some((name) => name.startsWith(`${record.key}.`) && name.endsWith(CONSENT_REJECTED_SUFFIX));
    } catch {
      return false;
    }
  }

  function exists(path: string | null): boolean {
    if (path === null) return false;
    try {
      return io.exists(path);
    } catch {
      return false;
    }
  }

  /**
   * Hook przejął odpowiedź BIEŻĄCEJ decyzji rekordu: `.claimed` niesie tę samą decyzję i ten sam `at` co rekord.
   * `.claimed` wcześniejszej odpowiedzi pod tym kluczem nie jest odbiorem nowej.
   */
  function claimedMatches(record: ConsentRecord): boolean {
    const path = pathOf(record, CONSENT_CLAIMED_SUFFIX);
    if (path === null || record.decision === null) return false;
    let text: string | null;
    try {
      text = io.read(path);
    } catch {
      return false;
    }
    if (text === null) return false;
    try {
      const file = JSON.parse(text) as unknown;
      if (file === null || typeof file !== 'object') return false;
      const { decision, at } = file as { decision?: unknown; at?: unknown };
      return decision === record.decision && at === record.decisionAt;
    } catch {
      return false;
    }
  }

  /**
   * Fakt utraty dowodu klucza: minięty w transkrypcie, okres powrotu gniazda otwarty albo hook rozpoczęty nie później
   * niż granica powrotu gniazda.
   */
  function factLost(sessionId: string, key: string, startedAt: number): boolean {
    return lostWhy(sessionId, key, startedAt) !== null;
  }

  /**
   * Który fakt utraty dowodu ma klucz ({@link factLost}): `transcript-passed` (transkrypt minął klucz), `reattach`
   * (okres powrotu gniazda otwarty), `before-reattach` (hook nie późniejszy niż granica); `null` = żaden.
   */
  function lostWhy(
    sessionId: string, key: string, startedAt: number,
  ): 'transcript-passed' | 'reattach' | 'before-reattach' | null {
    if (passedSlots.has(slotOf(sessionId, key))) return 'transcript-passed';
    if (reattachOpen.has(sessionId)) return 'reattach';
    const boundary = reattachAt.get(sessionId);
    return boundary !== undefined && startedAt <= boundary ? 'before-reattach' : null;
  }

  /**
   * The proof-loss fact of a card ({@link lostWhy}) with the hook start of its registration, as `canAllow` takes it:
   * the record's `hookStartedAt` comes from the first dump, which is not authenticated, the registration on
   * `consent.sock` is. Without a registration entry only the facts that need no start count, and `unregistered`
   * stands for the rest: the card has no allow button (fail-closed).
   */
  function cardLostWhy(record: ConsentRecord): ReturnType<typeof lostWhy> | 'unregistered' {
    const entry = registry.entry(record.sessionId, record.key);
    if (entry !== null) return lostWhy(record.sessionId, record.key, entry.startedAt);
    return lostWhy(record.sessionId, record.key, Number.POSITIVE_INFINITY) ?? 'unregistered';
  }

  /** Zrzut na wierzchu ekranu obserwacji z bieżącej puli sesji ({@link ConsentCycle.topWinner}). */
  function topWinner(sessionId: string, observed: ConsentObserved): string | null {
    return topCheck(sessionId, observed).winner;
  }

  /** {@link topWinner} z powodem braku zwycięzcy (linia logu dowodu); zwycięzca i pamięć wersji puli te same. */
  function topCheck(sessionId: string, observed: ConsentObserved): ConsentTopCheck {
    const none = (miss: NonNullable<ConsentTopCheck['miss']>): ConsentTopCheck =>
      ({ winner: null, miss, unknownKey: null });
    if (observed.screen === null || observed.until === null) return none(observed.unread ?? 'no-screen');
    if (now() >= observed.until) return none('expired');
    const pool = pools.get(sessionId);
    if (pool === undefined) return none('no-pool');
    const known = winners.get(observed);
    if (known !== undefined && known.version === pool.version) return known.check;
    const check = consentTopVerdict({
      candidates: pool.candidates.values(), unlockedAt: pool.unlockedAt, overflow: pool.overflow, exitedAt: pool.exitedAt,
    }, observed.screen, observed.matchTop);
    winners.set(observed, { version: pool.version, check });
    return check;
  }

  /** Człon wierzchu linii logu dowodu klucza dla odczytu ekranu `observed`; `null` = klucz jest zwycięzcą. */
  function topMiss(sessionId: string, key: string, observed: ConsentObserved): string | null {
    const check = topCheck(sessionId, observed);
    if (check.winner === key) return null;
    const screen: TopScreen | null = observed.screen === null || observed.screenTop === undefined
      ? null
      : observed.screenTop(observed.screen.text);
    return consentTopMissText(check, key, screen);
  }

  /**
   * Człony, które odpadły w obserwacji werdyktu karty `pending` (część linii logu dowodu): wierzch z kroku kolejki
   * klucza, potem rejestr i dowód własny z obserwacji (`finding`). Wierzch obserwacji inny niż klucz, a w kroku kolejki
   * klucz zwycięzcą = `top=changed` (pula zmieniła się między nimi). Bez `finding` i bez innego członu = sam sygnał.
   */
  function missesOf(
    sessionId: string, key: string, signal: ConsentDialogSignal, observed: ConsentObserved | undefined,
    finding: ConsentProofFinding | undefined,
  ): readonly string[] {
    if (signal === 'standing') return [];
    if (finding?.rule === 'channel') return channelMisses(sessionId, observed, finding);
    const parts: string[] = [];
    const top = observed === undefined ? null : topMiss(sessionId, key, observed);
    if (top !== null) parts.push(`top=${top}`);
    else if (finding !== undefined && !finding.top) parts.push('top=changed');
    if (finding === undefined) {
      if (parts.length === 0) parts.push(`signal=${signal}`);
      return parts;
    }
    if (finding.registry !== null) parts.push(`registry=${finding.registry}`);
    if (finding.own !== null) parts.push(`own=${finding.own}`);
    return parts;
  }

  /**
   * Człony linii logu dowodu karty z regułą `channel`: bez członu wierzchu. Rejestr z obserwacji, a gdy ten był
   * świeży: `registry=newer-not-waiting` przy odczycie nie późniejszym niż status sesji bez `waiting: permission`
   * ({@link noteRegistryNotWaiting}), `registry=stale`, gdy termin odczytu minął przed krokiem kolejki klucza; potem
   * dowód własny. Bez członu (np. sam fakt utraty) linia ma tylko `lost=` albo `unexplained` ({@link proofMissOf}).
   */
  function channelMisses(
    sessionId: string, observed: ConsentObserved | undefined, finding: ConsentProofFinding,
  ): readonly string[] {
    const parts: string[] = [];
    const read = observed?.channel ?? null;
    if (finding.registry !== null) parts.push(`registry=${finding.registry}`);
    else if (read !== null && superseded(sessionId, read)) parts.push('registry=newer-not-waiting');
    else if (finding.own === null && (read === null || now() >= read.until)) parts.push('registry=stale');
    if (finding.own !== null) parts.push(`own=${finding.own}`);
    return parts;
  }

  /**
   * Dowód „dialog stoi” bieżącego werdyktu klucza obowiązuje teraz, według rodzaju: dowód ukryty
   * ({@link hiddenHolds}), dowód z kanału ({@link channelHolds}), a dowód z wierzchu przed terminem odczytu ekranu,
   * z którego się wziął, i przy kluczu jako zwycięzcy bieżącej puli dla tego odczytu. Werdykt bez odczytu (obserwacja
   * bez `observed`) nie ma dowodu (W-d).
   */
  function proofHolds(record: ConsentRecord): boolean {
    const slot = slotOf(record.sessionId, record.key);
    const hidden = hiddenProofs.get(slot);
    if (hidden !== undefined) return hiddenHolds(record.sessionId, record.key, record.agentId, hidden);
    const channel = channelProofs.get(slot);
    if (channel !== undefined) return channelHolds(record.sessionId, record, channel);
    const proof = proofs.get(slot);
    return proof !== undefined && topWinner(record.sessionId, proof) === record.key;
  }

  /**
   * Dowód z kanału z odczytu rejestru `read` obowiązuje teraz: prośba wątku głównego spoza MCP
   * ({@link consentKeyRule}) przy bieżącej regule wątku głównego sesji `channel` ({@link rulesNow}), przed terminem
   * odczytu rejestru i z odczytu późniejszego niż ostatni status sesji bez `waiting: permission` ({@link superseded}).
   */
  function channelHolds(
    sessionId: string, request: Pick<ConsentRecord, 'toolName' | 'agentId'>, read: ConsentChannelRead,
  ): boolean {
    return consentKeyRule(rulesNow(sessionId).main, request) === 'channel' && now() < read.until
      && !superseded(sessionId, read);
  }

  /** {@link ConsentCycleOptions.proofRules}; without the source both kinds `channel`, an exception = `screen`. */
  function rulesNow(sessionId: string): ConsentProofRules {
    try {
      return options.proofRules?.(sessionId) ?? { main: 'channel', subagents: 'channel' };
    } catch {
      return { main: 'screen', subagents: 'screen' };
    }
  }

  /**
   * Odczyt rejestru `read` nie jest późniejszy niż ostatni status sesji bez `waiting: permission`
   * ({@link registryNotWaitingAt}): ta sama chwila też, bo kolejności dwóch odczytów z jednej milisekundy nie znamy.
   */
  function superseded(sessionId: string, read: ConsentChannelRead): boolean {
    return read.at <= (registryNotWaitingAt.get(sessionId) ?? Number.NEGATIVE_INFINITY);
  }

  /**
   * Dowód ukryty z odczytu `read` obowiązuje teraz: prośba subagenta, przed terminem odczytu faktów i przy kanale
   * otwartym dla subagentów (tryb `all`, sprawdzany przy każdym widoku karty i podpisie); a proof of key `key`
   * taken under `channel` ({@link ConsentHiddenRead.keyRules}) only while the session's subagents' rule is still
   * `channel` ({@link rulesNow}). A key's `screen` proof (an MCP tool, every hidden-proof check) holds under either
   * rule.
   */
  function hiddenHolds(sessionId: string, key: string, agentId: string | null, read: ConsentHiddenRead): boolean {
    return agentId !== null && now() < read.until && subagentsOpen()
      && (read.keyRules?.get(key) !== 'channel' || rulesNow(sessionId).subagents === 'channel');
  }

  /** Rodzaj dowodu bieżącego werdyktu klucza (pole `proofKind` zgody). */
  function proofKindOf(record: ConsentRecord): ConsentProofKind {
    const slot = slotOf(record.sessionId, record.key);
    return hiddenProofs.has(slot) ? 'hidden' : channelProofs.has(slot) ? 'channel' : 'top';
  }

  /**
   * Widok karty z rekordu i ostatniego werdyktu. Fakt utraty zapisany po werdykcie (granica postawiona w trakcie
   * obserwacji, decyzja w kolejce klucza za faktem), termin dowodu, który minął (`ConsentObserved.until` albo termin
   * odczytu faktów dowodu ukrytego), kandydat puli dopisany po werdykcie, z którym klucz nie jest już jedynym `match`,
   * i tryb inny niż `all` przy dowodzie ukrytym zabierają przycisk zgody od razu.
   */
  function viewOf(record: ConsentRecord): ConsentCardView {
    const slot = slotOf(record.sessionId, record.key);
    const stored = verdicts.get(slot) ?? null;
    // Karta końcowa po publikacji nie ma werdyktu: powód i chwila pojawienia się zostają w widoku z magazynu.
    const kept = stored === null && isFinal(record.state) ? store.get(record.sessionId, record.key) : null;
    const secret = registry.secretOf(record.sessionId, record.key) !== null;
    const pending = record.state === 'pending';
    const lost = pending && stored?.canAllow === true && (!proofHolds(record) || cardLostWhy(record) !== null);
    // A record that waited for its hook after a restart never gets the allow button back (`resume.ts`).
    const held = pending && stored !== null && resume.holds(record);
    const verdict: ConsentCardVerdict | null = held ? { ...stored, canAllow: false, unavailable: 'server-restart' }
      : lost && stored !== null ? { ...stored, canAllow: false, unavailable: 'no-proof' } : stored;
    const canSign = verdict?.canSign === true && secret;
    return {
      permId: record.key,
      sessionId: record.sessionId,
      promptId: record.promptId,
      toolName: record.toolName,
      agentId: record.agentId,
      presentation: verdict?.presentation ?? null,
      state: wireStateOf(record.state),
      canAllow: pending && verdict?.canAllow === true && secret,
      canDeny: pending && canSign,
      canRelease: pending || record.state === 'sent',
      unavailable: verdict !== null ? verdict.unavailable : kept !== null ? kept.unavailable : 'server-restart',
      cause: record.cause,
      late: record.late,
      createdAt: createdAt.get(slot) ?? kept?.createdAt ?? record.times.pending,
      ...deskDecisionOf(record),
      ...(verdict?.permissionSuggestions === undefined ? {} : { permissionSuggestions: verdict.permissionSuggestions }),
      ...(verdict?.always === undefined ? {} : { always: verdict.always }),
    };
  }

  function deskDecisionOf(record: ConsentRecord): Pick<ConsentCardView, 'deskDecision'> {
    const desk = (record as ConsentCycleRecord).deskDecision;
    return record.state === 'settled-at-desk' && desk !== undefined ? { deskDecision: desk } : {};
  }

  /**
   * Widok karty do magazynu i do `onCard`. Rekord z polem `retired` (karta zdjęta na końcu sesji) idzie tylko do
   * magazynu: urządzenia kartę już zdjęły i nie dostają jej z powrotem. Stan końcowy po publikacji zwalnia treść
   * karty ({@link dropContent}).
   */
  function publish(record: ConsentRecord): void {
    const view = viewOf(record);
    markButtonless(record, view);
    noteProof(record, view);
    const changed = store.set(view) !== 'same';
    if (changed && !isRetired(record)) options.onCard?.(view);
    if (isFinal(record.state)) dropContent(record, view);
  }

  /**
   * Karta końcowa po publikacji (urządzenia dostały stan końcowy pełnym widokiem): zrzut, werdykt, odczyt ekranu
   * dowodu i chwile klucza wychodzą z pamięci, a magazyn trzyma widok bez prezentacji, bez zdarzenia. Rekord zostaje.
   * Obserwacja, która później przyniesie zrzut tego klucza (hook odwołanej karty czeka dalej), kończy się publikacją,
   * więc i jej wpisy wychodzą tu.
   */
  function dropContent(record: ConsentRecord, view: ConsentCardView): void {
    const slot = slotOf(record.sessionId, record.key);
    dumps.delete(slot);
    verdicts.delete(slot);
    proofs.delete(slot);
    hiddenProofs.delete(slot);
    channelProofs.delete(slot);
    misses.delete(slot);
    deskReasons.delete(slot);
    proofNotes.delete(slot);
    topDumped.delete(slot);
    seenAt.delete(slot);
    createdAt.delete(slot);
    if (view.presentation !== null) store.set({ ...view, presentation: null });
  }

  /**
   * Linia logu dowodu karty wątku głównego w `pending` (diagnostyka): widok bez przycisku zgody z powodem
   * `no-proof` loguje `consent: proof of key <key> missing: <człony>` przy pierwszej publikacji bez dowodu i przy
   * każdej zmianie zestawu członów ({@link proofMissOf}), a widok z przyciskiem po takiej linii raz
   * `consent: proof of key <key> ok`. Ten sam zestaw drugi raz linii nie daje, więc takt obserwacji i przegląd plików
   * nie powtarzają jej. Karta poza `pending` zapomina ostatnią linię. Linia niesie klucz i nazwy członów z powodami
   * (wartości wyliczeniowe i liczby), nigdy treści ekranu, komendy ani ścieżki.
   */
  function noteProof(record: ConsentRecord, view: ConsentCardView): void {
    const slot = slotOf(record.sessionId, record.key);
    if (record.state !== 'pending' || record.agentId !== null) {
      proofNotes.delete(slot);
      return;
    }
    const noted = proofNotes.get(slot);
    if (view.unavailable !== 'no-proof') {
      if (view.canAllow && noted !== undefined && noted !== PROOF_OK) {
        proofNotes.set(slot, PROOF_OK);
        log(`consent: proof of key ${record.key} ok`);
      }
      return;
    }
    const why = proofMissOf(record);
    if (why === noted) return;
    proofNotes.set(slot, why);
    log(`consent: proof of key ${record.key} missing: ${why}`);
    dumpUnknownTop(record, why);
  }

  /**
   * Zrzut ekranu dowodu do `refusals/`, gdy człony linii logu dowodu mówią o nieznanym elemencie wierzchu
   * (`unknownTopOf`), raz na kartę. Człon wierzchu w obu drogach {@link proofMissOf} pochodzi z odczytu ekranu
   * w `proofs` (obserwacja zapisuje go razem z członami), więc zrzut niesie ekran, z którego wziął się człon. Błąd
   * zapisywacza nie wychodzi poza diagnostykę.
   */
  function dumpUnknownTop(record: ConsentRecord, why: string): void {
    const write = options.dumpUnknownTop;
    const slot = slotOf(record.sessionId, record.key);
    const kind = unknownTopOf(why);
    if (write === undefined || kind === null || topDumped.has(slot)) return;
    const proof = proofs.get(slot);
    if (proof?.screen === undefined || proof.screen === null) return;
    topDumped.add(slot);
    const dump = dumps.get(slot);
    try {
      write({
        reason: `top-${kind}`,
        toolName: record.toolName,
        key: record.key,
        proof: why,
        screen: proof.screen.text,
        hook: dump === undefined ? null : { toolName: dump.toolName, at: dump.at },
        jsonl: null,
        shape: { promptId: record.promptId },
        at: proof.at,
      });
    } catch {
      // Diagnostyka nie zmienia karty ani cyklu.
    }
  }

  /**
   * Człony dowodu, które odpadły dla karty `pending` bez dowodu, w kolejności `top=`, `registry=`, `own=`, `lost=`.
   * Werdykt bez dowodu: człony z jego obserwacji ({@link missesOf}). Werdykt z dowodem, który widok zabrał później:
   * reguła wątku głównego sesji zmieniona na `screen`, nowszy status rejestru bez `waiting: permission` albo termin
   * odczytu rejestru (dowód z kanału, `rule=screen`, `registry=newer-not-waiting`, `registry=stale`) albo wierzch
   * odczytu ekranu tego werdyktu teraz (termin, pula); werdykt bez wpisu dowodu (W-d) = `proof=unread`. Fakt utraty
   * ({@link cardLostWhy}) zawsze teraz.
   */
  function proofMissOf(record: ConsentRecord): string {
    const slot = slotOf(record.sessionId, record.key);
    const parts: string[] = [];
    if (verdicts.get(slot)?.canAllow === true) {
      const channel = channelProofs.get(slot);
      const proof = proofs.get(slot);
      if (channel !== undefined) {
        if (rulesNow(record.sessionId).main !== 'channel') parts.push('rule=screen');
        else if (superseded(record.sessionId, channel)) parts.push('registry=newer-not-waiting');
        else if (now() >= channel.until) parts.push('registry=stale');
      } else if (proof === undefined) {
        if (!hiddenProofs.has(slot)) parts.push('proof=unread');
      } else {
        const top = topMiss(record.sessionId, record.key, proof);
        if (top !== null) parts.push(`top=${top}`);
      }
    } else {
      parts.push(...(misses.get(slot) ?? []));
    }
    const lost = cardLostWhy(record);
    if (lost !== null && lost !== 'unregistered') parts.push(`lost=${lost}`);
    if (dumps.get(slot)?.mcpEmptySuggestions === true) parts.push('mcp=empty-suggestions');
    return parts.length === 0 ? 'unexplained' : parts.join(' ');
  }

  function isRetired(record: ConsentRecord): boolean {
    const current: ConsentCycleRecord = records.get(slotOf(record.sessionId, record.key)) ?? record;
    return current.retired !== undefined || (record as ConsentCycleRecord).retired !== undefined;
  }

  /**
   * Pole audytu `buttonless`: raz, przy pierwszej publikacji karty wątku głównego (przy `all` także subagenta)
   * w `pending` bez `canAllow`, gdy rejestracja jest przyjęta, a hook żywy (powód inny niż `hook-dead`). Zapis poza
   * protokołem: błąd zostaje w logu.
   */
  function markButtonless(record: ConsentRecord, view: ConsentCardView): void {
    const slot = slotOf(record.sessionId, record.key);
    const current: ConsentCycleRecord = records.get(slot) ?? record;
    if (current.buttonless !== undefined || record.state !== 'pending' || view.canAllow) return;
    if ((record.agentId !== null && !subagentsOpen()) || registry.entry(record.sessionId, record.key) === null) return;
    const reason = view.unavailable ?? 'no-channel';
    if (reason === 'hook-dead' || reason === 'terminal-only' || reason === 'server-restart') return;
    const marked: ConsentCycleRecord = { ...current, buttonless: { reason, at: now() } };
    records.set(slot, marked);
    save(marked, false);
  }

  /** Zapis rekordu: przy protokole błąd leci wyżej, poza nim zostaje w logu, a pamięć idzie dalej. */
  function save(record: ConsentRecord, protocol: boolean): void {
    try {
      io.writeRecord(dataDir, record, { fsync: protocol });
    } catch (err) {
      if (protocol) throw err;
      log(`consent: record ${record.key} (${record.state}) not written: ${errText(err)}`);
    }
  }

  /**
   * Writes the record and publishes its view. `quiet` writes without publishing: only for a transition that the same
   * synchronous task follows with a published one (a `revoked` step the turn settlement settles at once).
   */
  function commit(next: ConsentCycleRecord, protocol = false, quiet = false): ConsentCycleRecord {
    // Pola `buttonless` i `retired` ustawia się raz: przejście zbudowane ze starszej kopii rekordu ich nie gubi. Tak
    // samo licznik `releaseFailed` (nie maleje) i `releaseCause` tej samej decyzji `release` (ten sam `decisionAt`).
    const prior: ConsentCycleRecord | undefined = records.get(slotOf(next.sessionId, next.key));
    const buttonless = next.buttonless ?? prior?.buttonless;
    const retired = next.retired ?? prior?.retired;
    const releaseFailed = Math.max(next.releaseFailed ?? 0, prior?.releaseFailed ?? 0);
    const releaseCause = next.releaseCause ?? (next.decision === 'release' && prior?.decision === 'release'
      && prior.decisionAt === next.decisionAt ? prior.releaseCause : undefined);
    // Rodzaj dowodu należy do decyzji `allow` (ten sam `decisionAt`); rekord innej decyzji go nie niesie.
    const proofKind = next.decision !== 'allow' ? undefined : next.proofKind ?? (prior?.decision === 'allow'
      && prior.decisionAt === next.decisionAt ? prior.proofKind : undefined);
    const { proofKind: _given, ...rest } = next;
    // The receipt is set once as well (`confirmReceipt`).
    const receipt = next.receipt ?? prior?.receipt;
    const record: ConsentCycleRecord = {
      ...rest, ...(buttonless === undefined ? {} : { buttonless }), ...(retired === undefined ? {} : { retired }),
      ...(releaseCause === undefined ? {} : { releaseCause }), ...(releaseFailed === 0 ? {} : { releaseFailed }),
      ...(proofKind === undefined ? {} : { proofKind }), ...(receipt === undefined ? {} : { receipt }),
    };
    save(record, protocol);
    records.set(slotOf(record.sessionId, record.key), record);
    resume.moved(record);
    // Odczyt dowodu (ekranu albo faktów dowodu ukrytego), powody jego braku i zegar powrotu do biurka liczą się tylko
    // dla karty `pending`.
    if (record.state !== 'pending') {
      proofs.delete(slotOf(record.sessionId, record.key));
      hiddenProofs.delete(slotOf(record.sessionId, record.key));
      channelProofs.delete(slotOf(record.sessionId, record.key));
      misses.delete(slotOf(record.sessionId, record.key));
      deskReasons.delete(slotOf(record.sessionId, record.key));
      desk.forgetClock(slotOf(record.sessionId, record.key));
    }
    if (!quiet) publish(record);
    return records.get(slotOf(record.sessionId, record.key)) ?? record;
  }

  function times(record: ConsentRecord, patch: Partial<ConsentRecordTimes>): ConsentRecordTimes {
    return { ...record.times, ...patch };
  }

  function moveTo(
    record: ConsentRecord, state: ConsentCycleState, cause: ConsentCause | null = record.cause,
    extra: Partial<ConsentCycleRecord> = {}, quiet = false,
  ): ConsentRecord {
    assertConsentTransition(record.state, state);
    const at = now();
    const stamp: Partial<ConsentRecordTimes> = state === 'claimed' ? { claimed: at }
      : state === 'running' ? { running: at }
        : state === 'unknown' || isFinal(state) ? { settled: at } : {};
    const base: ConsentCycleRecord = { ...record, ...extra };
    return commit({ ...base, state, cause, bootId, times: times(base, stamp) }, false, quiet);
  }

  function revoke(record: ConsentRecord, cause: ConsentRevokeCause, quiet = false): ConsentRecord {
    return moveTo(record, 'revoked', cause, {}, quiet);
  }

  /**
   * Odwołanie pliku `.json` (`rename` na `.revoked`). `revoked` = plik odwołany; `claimed` = hook go przejął;
   * `rejected` = hook go odłożył; `gone` = pliku nie ma i nie wiadomo czemu; `failed` = `rename` padło z innego
   * powodu niż brak pliku, więc podpisana odpowiedź może dalej leżeć i hook może ją przejąć.
   */
  function revokeFile(record: ConsentRecord): 'revoked' | 'claimed' | 'rejected' | 'gone' | 'failed' {
    const json = pathOf(record, '.json');
    const target = pathOf(record, CONSENT_REVOKED_SUFFIX);
    if (json === null || target === null) return 'gone';
    try {
      io.rename(json, target);
      return 'revoked';
    } catch (err) {
      if (claimedMatches(record)) return 'claimed';
      if (!isMissing(err)) {
        log(`consent: revoking ${record.key} failed: ${errText(err)}`);
        return 'failed';
      }
      return hasRejected(record) ? 'rejected' : 'gone';
    }
  }

  /** Stan po przejęciu pliku przez hook: `release` kończy cykl, `allow`/`deny` czekają na skutek. */
  function claimed(record: ConsentRecord): ConsentRecord {
    return record.decision === 'release' ? moveTo(record, 'released', null) : moveTo(record, 'claimed', null);
  }

  /**
   * Wynik odwołania `sent` jako przejście; `revoked` z podaną przyczyną. Odwołanie niepotwierdzone (`failed`)
   * zostawia `sent`: przegląd plików spróbuje jeszcze raz, a przejęcie rozliczy jak każde inne. `quiet`: the
   * `revoked` record is not published, because the caller settles it in the same task ({@link commit}).
   */
  function afterRevokeFile(record: ConsentRecord, cause: ConsentRevokeCause, quiet = false): ConsentRecord {
    const outcome = revokeFile(record);
    if (outcome === 'claimed') return claimed(record);
    if (outcome === 'rejected') return revoke(record, 'signature', quiet);
    if (outcome === 'failed') {
      publish(record);
      return record;
    }
    return revoke(record, cause, quiet);
  }

  /**
   * Protokół zapisu decyzji (kroki 1–3). Rzuca `write-failed` jako wynik, nie wyjątek. `extra` = pola rekordu
   * `deciding` (przyczyna `release` od serwera), niesione dalej przez `sent`; porażka wraca do `pending` bez nich.
   * Zgoda niesie w rekordzie `deciding` rodzaj dowodu, który ją dopuścił (`proofKind`); drugie sprawdzenie dowodu przed
   * podpisem dotyczy tego samego rodzaju. Every decision carries the registration its file is signed under (`signed`:
   * the card digest and the call identity), the identity of the answered call for the outcome (`consentAnswerProven`).
   */
  function writeDecision(
    record: ConsentRecord, decision: ConsentDecision, reasonId: ConsentReasonId,
    extra: Pick<ConsentCycleRecord, 'releaseCause'> = {},
  ): ConsentOutcome {
    const secret = registry.secretOf(record.sessionId, record.key);
    const entry = registry.entry(record.sessionId, record.key);
    const dir = filesDir(record.sessionId);
    if (secret === null || entry === null || entry.blocked || dir === null) {
      return { ok: false, error: 'not-signable', state: record.state };
    }
    const at = now();
    // `allow-always` signs the digest of the registration's updates and keeps every update in the record.
    const updates = reasonId === 'allow-always' ? entry.permissionSuggestions : undefined;
    if (reasonId === 'allow-always' && updates === undefined) {
      return { ok: false, error: 'no-always', state: record.state };
    }
    const permissions = updates === undefined ? undefined : { sha256: consentPermissionsSha256(updates), updates };
    const { proofKind: _earlier, permissions: _written, signed: _signed, ...base } = record as ConsentCycleRecord;
    const deciding: ConsentCycleRecord = {
      ...base, ...extra, state: 'deciding', decision, reasonId, decisionAt: at, cause: null, bootId,
      times: times(record, { deciding: at }),
      ...(decision === 'allow' ? { proofKind: proofKindOf(record) } : {}),
      signed: consentSignedOf(entry, at),
      ...(permissions === undefined ? {} : { permissions }),
    };
    try {
      save(deciding, true);
    } catch (err) {
      log(`consent: record ${record.key} (deciding) not written, decision refused: ${errText(err)}`);
      return { ok: false, error: 'write-failed', state: record.state };
    }
    records.set(slotOf(record.sessionId, record.key), deciding);
    // Zgoda: dowód drugi raz (termin i zwycięzca puli albo termin dowodu ukrytego i tryb), po zapisie `deciding` (zapis
    // z `fsync` trwa), przed podpisem.
    const again = decision === 'allow' ? viewOf(record) : null;
    if (again !== null && (!again.canAllow || permissions !== undefined && again.always === undefined)) {
      log(`consent: proof of key ${record.key} lost while writing the decision, allow refused`);
      commit({ ...record, bootId });
      return { ok: false, error: 'card-changed', state: record.state };
    }
    const file = signConsentFile(secret, {
      key: record.key, sessionId: record.sessionId, decision, reasonId, inputSha256: entry.inputSha256,
      cardSha256: entry.cardSha256, at, ...(permissions === undefined ? {} : { permissionsSha256: permissions.sha256 }),
    });
    try {
      io.writeFile(dir, `${record.key}.json`, `${JSON.stringify(file)}\n`, { fsync: true });
    } catch (err) {
      log(`consent: answer file ${record.key} not written: ${errText(err)}`);
      commit({ ...record, bootId });
      return { ok: false, error: 'write-failed', state: record.state };
    }
    const sent = commit({ ...deciding, state: 'sent', times: times(deciding, { sent: now() }) }, false);
    return { ok: true, state: sent.state };
  }

  /**
   * Zwolnienie hooka karty, która skończyła się bez odebranej odpowiedzi, a której hook może dalej czekać:
   * podpisany plik `release` pod kluczem, ten sam co przy zwolnieniu z urządzenia, więc hook wychodzi bez wyniku
   * (`release` nigdy nie wykonuje narzędzia; dialog, jeśli stoi, zostaje przy biurku). Rekord, karta i decyzja
   * w rekordzie bez zmian. Bez żywej, niezablokowanej rejestracji nic (hook bez przyjętej rejestracji nie czeka na
   * plik). Zapis, który padł, idzie do logu raz, a próbę powtarza następna obserwacja z żywym zrzutem klucza
   * ({@link releaseDue}).
   *
   * Woła ją każde przejście, po którym hook może czekać dalej bez pliku: sygnał `gone` przy `pending`, koniec tury bez
   * wywołania przy `pending` i przy `sent` po potwierdzonym odwołaniu pliku, klawisz przy biurku przed sygnałem
   * (`pending` → `settled-at-desk`) i zwolnienie z urządzenia, którego plik nie powstał (`revoked: write-failed`).
   * Rekord subagenta z żywą rejestracją przy `gone` i po końcu biegu bez wyniku zostaje w `pending`: jego
   * `release` pisze powrót do biurka (`deskFallback`, `desk.ts`), a jego porażka idzie do pola `releaseFailed`, nie do
   * {@link releaseDue}.
   * Hooka nie zwalniają: śmierć hooka, restart (stary hook widzi nowy `bootId` w `alive.json`), wyłącznik (`alive.json`
   * z trybem niższym niż `main`), koniec sesji silnika (`revokeSession`: CLI kończy swoje hooki, `hook-dead` zapomina
   * rejestrację), termin przejęcia (hook nie przejął podpisanego pliku przez 60 s) i plik odłożony jako nieważny
   * (drugi plik z tym samym podpisem odpadłby tak samo).
   */
  function releaseHook(record: ConsentRecord): ConsentRecord {
    const slot = slotOf(record.sessionId, record.key);
    const secret = registry.secretOf(record.sessionId, record.key);
    const entry = registry.entry(record.sessionId, record.key);
    const dir = filesDir(record.sessionId);
    if (secret === null || entry === null || dir === null) {
      releaseDue.delete(slot);
      return record;
    }
    const file = signConsentFile(secret, {
      key: record.key, sessionId: record.sessionId, decision: 'release', reasonId: 'release',
      inputSha256: entry.inputSha256, cardSha256: entry.cardSha256, at: now(),
    });
    const why = record.cause ?? record.state;
    try {
      io.writeFile(dir, `${record.key}.json`, `${JSON.stringify(file)}\n`, { fsync: true });
    } catch (err) {
      if (!releaseDue.has(slot)) {
        log(`consent: release file ${record.key} (${why}) not written, retried at the next observation: ${errText(err)}`);
      }
      releaseDue.add(slot);
      return record;
    }
    releaseDue.delete(slot);
    log(`consent: hook of key ${record.key} released (${why})`);
    return record;
  }

  function newRecord(dump: HookCallDump): ConsentCycleRecord {
    const entry = registry.entry(dump.sessionId, dump.key);
    const dumpCardSha256 = consentDumpCardSha256(dump);
    return {
      v: CONSENT_RECORD_VERSION, key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
      toolName: dump.toolName, inputSha256: dump.inputSha256, cardSha256: entry?.cardSha256 ?? null,
      agentId: dump.agentId ?? null, pid: dump.pid, hookStartedAt: dump.startedAt, bootId, state: 'pending',
      decision: null, reasonId: null, decisionAt: null, correlation: 'open', toolUseId: null, cause: null,
      late: false, checkpoint: null, times: { pending: now() },
      ...(dumpCardSha256 === null ? {} : { dumpCardSha256 }),
    };
  }

  function evaluate(dump: HookCallDump, signal: ConsentDialogSignal): ConsentCardVerdict {
    return consentCardVerdict({
      dump,
      registration: registry.entry(dump.sessionId, dump.key),
      signable: registry.secretOf(dump.sessionId, dump.key) !== null,
      scope: subagentsOpen() ? 'all' : 'main',
      standing: standingOf(signal),
      always: options.always === true,
    });
  }

  /**
   * Przejście według sygnału. `fresh` = `standing` liczy się (odczyt ekranu nie starszy niż werdykt klucza i przed
   * terminem); bez tego `standing`, także z reguły karty `claimed`, jest niewiadomą.
   */
  function onSignal(
    record: ConsentRecord, signal: ConsentDialogSignal, afterClaim: ConsentAfterClaim | undefined, fresh: boolean,
  ): ConsentRecord {
    switch (record.state) {
      case 'pending':
        if (signal === 'dead') return revoke(record, 'hook-dead');
        // Hook subagenta z żywą rejestracją czeka na podpisany plik, `.revoked` go nie kończy; rekord zostaje
        // w `pending`, a `release` przychodzi z powrotu do biurka.
        if (signal === 'gone' && record.agentId !== null && registry.entry(record.sessionId, record.key) !== null) {
          return record;
        }
        // CLI rozstrzygnął prośbę sam (klawisz przy biurku, odmowa trybu auto), a jej hook czeka dalej.
        if (signal === 'gone') return releaseHook(revoke(record, 'dialog-gone'));
        return record;
      case 'sent':
        return signal === 'dead' ? afterRevokeFile(record, 'hook-dead') : record;
      case 'claimed': {
        const since = record.times.claimed ?? now();
        // Hook nie żyje albo wyszedł: o dialogu mówi rejestr CLI odczytany po odbiorze, nie sama śmierć hooka.
        const dialog = signal === 'dead' ? claimedDialogSignal(afterClaim, since, now()) : signal;
        if (dialog === 'gone') return moveTo(record, 'running');
        if (dialog === 'standing' && fresh && now() - since >= CONSENT_CLAIMED_STANDING_MS) {
          return moveTo(record, 'unknown', 'no-effect');
        }
        return record;
      }
      default:
        return record;
    }
  }

  /**
   * Zapomnienie wpisu rejestru klucza po potwierdzonej śmierci procesu hooka: sekret podpisywał odpowiedź tylko dla
   * niego, a wpis zajmuje miejsce w limicie sesji do końca swojego terminu. Wpisu żywego hooka nic tu nie usuwa.
   * The log line says why; the hook process of a reason without `ps` comes from the caller (registry entry or the
   * key's dump), not from a registry read, which drops expired entries.
   */
  function forgetDead(
    sessionId: string, key: string, why: ConsentDeadWhy | 'session ended' | undefined, proc: HookProcess | undefined,
  ): void {
    if (!registry.forget(sessionId, key)) return;
    const hook = proc === undefined ? 'pid unknown' : describeHookProcess(proc);
    const reason = why === undefined ? `${hook}: no reason given`
      : typeof why === 'string' ? `${hook}: ${why}, no ps check`
        : 'ps' in why ? describePsFinding(why.ps) : `${hook}: ${why.cause}, no ps check`;
    log(`consent: registration of key ${key} forgotten (hook dead): ${reason}`);
  }

  async function observe(
    sessionId: string, key: string, signal: ConsentObservedSignal, dump?: HookCallDump, afterClaim?: ConsentAfterClaim,
    observed?: ConsentObserved, finding?: ConsentProofFinding, deadWhy?: ConsentDeadWhy,
  ): Promise<ConsentCardView | null> {
    const slot = slotOf(sessionId, key);
    return enqueue(slot, () => {
      if (dump !== undefined && (dump.sessionId !== sessionId || dump.key !== key)) return null;
      // The hook process for the forgotten line, read before the transition can drop the key's dump.
      const hookProc = dump ?? dumps.get(slot);
      const hiddenRead = signal === 'hidden' ? observed?.hidden ?? null : null;
      const channelRead = signal === 'channel' ? observed?.channel ?? null : null;
      // Chwila odczytu, z którego wziąłby się werdykt: fakty dowodu ukrytego przy sygnale `hidden`, rejestr CLI przy
      // sygnale `channel` (dowód z kanału: kolejność i termin od odczytu rejestru), inaczej ekran (albo, bez odczytu
      // ekranu, chwila obserwacji).
      const readAt = hiddenRead !== null ? hiddenRead.at : channelRead !== null ? channelRead.at : observed?.at;
      /*
       * Termin i zwycięzca bieżącej puli (dowód z wierzchu), termin, wątek i tryb (dowód ukryty) albo termin, wątek
       * i narzędzie (dowód z kanału) sprawdzane w kroku kolejki klucza, po każdym `await` obserwacji: kandydat dopisany
       * w tym czasie przez inną obserwację (drugi panel) zabiera dowód z wierzchu. Odczyt starszy niż werdykt nic nie
       * daje; odczyt rejestru sygnału `channel` nie późniejszy niż status sesji bez `waiting: permission` też nie.
       */
      const stale = readAt !== undefined && (readAt < (seenAt.get(slot) ?? Number.NEGATIVE_INFINITY)
        || (channelRead !== null && superseded(sessionId, channelRead)));
      const request = records.get(slot) ?? (dump === undefined ? undefined
        : { toolName: dump.toolName, agentId: dump.agentId ?? null });
      const agentId = request?.agentId ?? null;
      const channel = !stale && channelRead !== null && request !== undefined
        && channelHolds(sessionId, request, channelRead);
      // Karta z regułą `channel` (także `claimed` z faktów po odbiorze) nie pyta o wierzch.
      const fresh = !stale && (signal === 'channel' ? channel
        : afterClaim?.channel === true || observed === undefined || topWinner(sessionId, observed) === key);
      const hidden = !stale && hiddenRead !== null && hiddenHolds(sessionId, key, agentId, hiddenRead);
      // Werdykt karty: dowód ukryty i dowód z kanału stoją jak dowód z wierzchu. Przejścia stanu biorą `hidden` jako
      // niewiadomą, a `channel` przy innym żywym zrzucie sesji też (rejestr może mówić o dialogu tamtej prośby).
      const effective: ConsentDialogSignal = signal === 'hidden' ? (hidden ? 'standing' : 'unknown')
        : signal === 'channel' ? (channel ? 'standing' : 'unknown')
          : signal === 'standing' && !fresh ? 'unknown' : signal;
      const transition: ConsentDialogSignal = signal === 'hidden' ? 'unknown'
        : signal === 'channel' && afterClaim?.otherLive === true ? 'unknown' : effective;
      const mark = (pending: boolean): void => {
        if (stale || observed === undefined || readAt === undefined) return;
        seenAt.set(slot, readAt);
        proofs.delete(slot);
        hiddenProofs.delete(slot);
        channelProofs.delete(slot);
        if (!pending) return;
        if (hidden && hiddenRead !== null) hiddenProofs.set(slot, hiddenRead);
        else if (channel && channelRead !== null) channelProofs.set(slot, channelRead);
        else proofs.set(slot, observed);
      };
      const noteDesk = (): void => {
        if (agentId === null) return;
        const top = observed === undefined ? null : topCheck(sessionId, observed);
        const hooks = finding?.subagent?.hooks ?? null;
        deskReasons.set(slot, { reason: consentDeskReasonOf(key, finding, dump !== undefined, top), hooks });
      };
      let record = records.get(slot);
      if (record === undefined) {
        if (signal === 'dead') forgetDead(sessionId, key, deadWhy, hookProc);
        if (dump === undefined || signal === 'dead' || signal === 'gone') return null;
        dumps.set(slot, dump);
        verdicts.set(slot, evaluate(dump, effective));
        misses.set(slot, missesOf(sessionId, key, effective, observed, finding));
        noteDesk();
        mark(true);
        createdAt.set(slot, now());
        // MCP with user interaction goes back at once: its pending card is written without publishing (`mcpToDesk`).
        const mcp = dump.mcpEmptySuggestions === true;
        record = mcp ? mcpToDesk(commit(newRecord(dump), false, true)) : deskFallback(commit(newRecord(dump)));
        return viewOf(record);
      }
      if (dump !== undefined) dumps.set(slot, dump);
      // Zwolnienie, którego zapis padł: martwy hook kończy próby, żywy zrzut klucza daje następną.
      if (releaseDue.has(slot)) {
        if (signal === 'dead') releaseDue.delete(slot);
        else if (dump !== undefined) releaseHook(record);
      }
      const known = dumps.get(slot);
      if (known !== undefined && record.state === 'pending' && !stale) {
        verdicts.set(slot, evaluate(known, effective));
        misses.set(slot, missesOf(sessionId, key, effective, observed, finding));
        noteDesk();
      }
      mark(record.state === 'pending');
      record = onSignal(record, transition, afterClaim, fresh);
      publish(record);
      record = known?.mcpEmptySuggestions === true ? mcpToDesk(record) : deskFallback(record);
      // Po przejściu i publikacji: odwołanie pliku i widok karty liczą się jeszcze z wpisem rejestru.
      if (signal === 'dead') forgetDead(sessionId, key, deadWhy, hookProc);
      return viewOf(record);
    });
  }

  async function noteRegistryNotWaiting(sessionId: string, at: number): Promise<void> {
    if (at <= (registryNotWaitingAt.get(sessionId) ?? Number.NEGATIVE_INFINITY)) return;
    // Synchronicznie, przed pierwszym `await`: krok kolejki obserwacji w toku widzi już nowszy status.
    registryNotWaitingAt.set(sessionId, at);
    const hit = slotsOf(sessionId).filter((slot) => {
      const read = channelProofs.get(slot);
      return read !== undefined && read.at <= at;
    });
    await Promise.all(hit.map((slot) => enqueue(slot, () => {
      const record = records.get(slot);
      if (record?.state === 'pending') publish(record);
    })));
  }

  async function revokeSession(sessionId: string, cause: ConsentSessionRevokeCause): Promise<readonly string[]> {
    const changed = new Set<string>();
    await Promise.all(slotsOf(sessionId).map((slot) => enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined) return;
      let after: ConsentRecord = record;
      if (record.state === 'pending') after = revoke(record, cause);
      else if (record.state === 'sent') after = afterRevokeFile(record, cause);
      if (after.state !== record.state) changed.add(slot);
    })));
    if (cause === 'hook-dead') {
      for (const entry of registry.entries()) {
        if (entry.sessionId === sessionId) forgetDead(sessionId, entry.key, 'session ended', entry);
      }
    }
    // Kolejność kart w magazynie (pojawienie się), nie kolejność zakończenia zadań w kolejkach. Karta końcowa zdjęta
    // z magazynu w trakcie (`endPool`) idzie na koniec: wynik nie gubi klucza.
    const listed = store.list(sessionId).map((card) => slotOf(card.sessionId, card.permId))
      .filter((slot) => changed.has(slot));
    return [...listed, ...[...changed].filter((slot) => !listed.includes(slot))]
      .map((slot) => records.get(slot)?.key ?? '')
      .filter((key) => key !== '');
  }

  async function decide(
    sessionId: string, key: string, decision: 'allow' | 'allow-always' | 'deny',
  ): Promise<ConsentOutcome> {
    const slot = slotOf(sessionId, key);
    return enqueue(slot, (): ConsentOutcome => {
      const record = records.get(slot);
      if (record === undefined) return { ok: false, error: 'not-found', state: null };
      if (record.state !== 'pending') return { ok: false, error: 'decided', state: record.state };
      const view = viewOf(record);
      if (decision !== 'deny' && !view.canAllow) return { ok: false, error: 'card-changed', state: record.state };
      if (decision === 'allow-always' && view.always === undefined) {
        return { ok: false, error: 'no-always', state: record.state };
      }
      if (decision === 'deny' && !view.canDeny) return { ok: false, error: 'not-signable', state: record.state };
      if (decision === 'deny') return writeDecision(record, 'deny', 'phone-deny');
      return writeDecision(record, 'allow', decision);
    });
  }

  async function release(sessionId: string, key: string): Promise<ConsentOutcome> {
    const slot = slotOf(sessionId, key);
    return enqueue(slot, (): ConsentOutcome => {
      const record = records.get(slot);
      if (record === undefined) return { ok: false, error: 'not-found', state: null };
      switch (record.state) {
        case 'pending': {
          if (registry.secretOf(sessionId, key) === null) return { ok: true, state: moveTo(record, 'released', null).state };
          return releasePending(record);
        }
        case 'sent': {
          if (record.decision === 'release') return { ok: true, state: record.state };
          const outcome = revokeFile(record);
          if (outcome === 'claimed') return { ok: false, error: 'too-late', state: claimed(record).state };
          if (outcome === 'rejected') return { ok: false, error: 'gone', state: revoke(record, 'signature').state };
          // Poprzednia odpowiedź może dalej leżeć: bez potwierdzonego odwołania nie piszemy następnej.
          if (outcome === 'failed') return { ok: false, error: 'write-failed', state: record.state };
          const written = writeDecision(record, 'release', 'release');
          if (written.ok) return written;
          // Poprzedni plik jest odwołany, a `release` nie powstał: druga próba od razu, potem z następną obserwacją;
          // do tej pory hook czeka, a dialog zostaje w terminalu.
          const revoked = releaseHook(revoke(records.get(slot) ?? record, 'write-failed'));
          return { ok: false, error: written.error, state: revoked.state };
        }
        // `unknown`: hook mógł już wykonać decyzję (T-10), więc nowego pliku nie piszemy; rozstrzyga dowód.
        case 'claimed':
        case 'running':
        case 'unknown':
          return { ok: false, error: 'too-late', state: record.state };
        default:
          return { ok: false, error: 'gone', state: record.state };
      }
    });
  }

  async function confirmReceipt(sessionId: string, key: string, at: number, inputSha256: string): Promise<boolean> {
    const slot = slotOf(sessionId, key);
    return enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined || !consentReceiptConfirmable(record, at)) return false;
      if (record.receipt?.decisionAt === at) return true;
      const receipt = { decisionAt: at, inputSha256, at: now() };
      if (record.state === 'sent') assertConsentTransition('sent', 'claimed');
      const next: ConsentCycleRecord = record.state === 'sent'
        ? { ...record, state: 'claimed', cause: null, bootId, receipt, times: times(record, { claimed: receipt.at }) }
        : { ...record, bootId, receipt };
      try {
        commit(next, true);
      } catch (err) {
        log(`consent: receipt of ${key} not written: ${errText(err)}`);
        return false;
      }
      return true;
    });
  }

  async function retire(sessionId: string, key: string): Promise<boolean> {
    const slot = slotOf(sessionId, key);
    return enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined || isFinal(record.state)) return false;
      if (record.retired !== undefined) return true;
      const marked: ConsentCycleRecord = { ...record, retired: { at: now() } };
      records.set(slot, marked);
      save(marked, false);
      return true;
    });
  }

  async function off(): Promise<void> {
    await Promise.all(slotsOf().map((slot) => enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined) return;
      if (record.state === 'pending') revoke(record, 'off');
      else if (record.state === 'sent') afterRevokeFile(record, 'off');
    })));
  }

  /** Przegląd jednego rekordu `sent` albo `claimed` wobec plików `consent/`. */
  function reviewFiles(record: ConsentRecord): ConsentRecord {
    if (record.state === 'sent') {
      if (claimedMatches(record)) return claimed(record);
      if (!exists(pathOf(record, '.json')) && hasRejected(record)) return revoke(record, 'signature');
      const sentAt = resume.claimFrom(record) ?? record.times.sent ?? record.times.deciding ?? record.times.pending;
      if (now() - sentAt >= CONSENT_CLAIM_TIMEOUT_MS) return afterRevokeFile(record, 'claim-timeout');
      return record;
    }
    if (record.state === 'claimed' && !claimedMatches(record)
      && !exists(pathOf(record, '.json')) && hasRejected(record)) {
      return revoke(record, 'signature');
    }
    return record;
  }

  async function tick(): Promise<void> {
    const slots = [...records.entries()]
      .filter(([, record]) => record.state === 'pending' || record.state === 'sent' || record.state === 'claimed')
      .map(([slot]) => slot);
    await Promise.all(slots.map((slot) => enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined) return;
      // A record that waited for its hook after a restart in vain goes as recovery took it before the grace.
      if (resume.settle(record) !== null) {
        if (record.state === 'pending') revoke(record, 'restart');
        else if (record.state === 'sent') afterRevokeFile(record, 'restart');
        if (record.state !== 'claimed') return;
      }
      // Karta `pending`: widok liczony teraz (termin dowodu, pula, rejestracja) idzie do urządzeń, gdy się zmienił.
      if (record.state === 'pending') {
        publish(record);
        deskFallback(records.get(slot) ?? record);
      } else {
        reviewFiles(record);
      }
    })));
  }

  /** Odzyskanie jednego rekordu sprzed restartu; `true` = stan się zmienił. */
  function recoverOne(record: ConsentRecord): boolean {
    const slot = slotOf(record.sessionId, record.key);
    records.set(slot, record);
    if (isFinal(record.state)) return false;
    if (record.state === 'deciding' || record.state === 'sent') {
      if (claimedMatches(record)) {
        const taken = claimed(record);
        resume.wait(taken);
        return taken !== record;
      }
      if (!exists(pathOf(record, '.json'))) {
        revoke(record, hasRejected(record) ? 'signature' : 'restart');
        return true;
      }
      const sent = record.state === 'sent' ? record : moveTo(record, 'sent', null, {
        times: times(record, { sent: record.times.deciding ?? now() }),
      });
      const sentAt = resume.claimFrom(sent) ?? sent.times.sent ?? now();
      if (now() - sentAt >= CONSENT_CLAIM_TIMEOUT_MS) {
        afterRevokeFile(sent, 'restart');
      } else {
        publish(sent);
        resume.wait(sent);
      }
      return true;
    }
    // A `pending` record whose hook is alive waits for the hook's second registration (`resume.ts`).
    if (record.state === 'pending') {
      if (resume.wait(record)) publish(record);
      else revoke(record, 'restart');
      return records.get(slot)?.state !== 'pending';
    }
    // `claimed`, `running`, `unknown`: skutek rozliczy przegląd transkryptu od checkpointu.
    publish(record);
    resume.wait(record);
    return false;
  }

  async function recover(): Promise<ConsentRecoverSummary> {
    const found = readConsentRecords(dataDir);
    await resume.probe(found);
    let changed = 0;
    await Promise.all(found.map((record) => enqueue(slotOf(record.sessionId, record.key), () => {
      if (recoverOne(record)) changed += 1;
    })));
    return { records: found.length, changed };
  }

  async function setCheckpoint(sessionId: string, key: string, checkpoint: ConsentCheckpoint): Promise<void> {
    const slot = slotOf(sessionId, key);
    await enqueue(slot, () => {
      const record = records.get(slot);
      if (record === undefined || record.checkpoint !== null || checkpoint.sessionId !== sessionId) return;
      commit({ ...record, checkpoint });
    });
  }

  function notePassed(sessionId: string, keys: readonly string[]): void {
    for (const key of keys) {
      const slot = slotOf(sessionId, key);
      const record = records.get(slot);
      if (record === undefined || record.state === 'pending') passedSlots.add(slot);
    }
  }

  async function markReattached(sessionId: string): Promise<void> {
    reattachAt.set(sessionId, Math.max(reattachAt.get(sessionId) ?? Number.NEGATIVE_INFINITY, now()));
    reattachOpen.add(sessionId);
    // Karty `pending` sesji tracą przycisk od razu, bez czekania na obserwację nowego drivera.
    await Promise.all(slotsOf(sessionId).map((slot) => enqueue(slot, () => {
      const record = records.get(slot);
      if (record !== undefined && record.state === 'pending') publish(record);
    })));
  }

  function noteTranscript(sessionId: string, at: number): void {
    if (!reattachOpen.delete(sessionId)) return;
    // Każdy znany dotąd zrzut ma start nie późniejszy niż `at`, więc żaden widok karty się nie zmienia.
    reattachAt.set(sessionId, Math.max(reattachAt.get(sessionId) ?? Number.NEGATIVE_INFINITY, at));
  }

  /** Nowa wersja puli z licznika cyklu ({@link PoolState.version}). */
  function bump(state: PoolState): void {
    poolVersions += 1;
    state.version = poolVersions;
  }

  /** Usuwa znacznik prośby kandydata; brak pliku to nie błąd, inny błąd zostawia plik i idzie do logu. */
  function removeMarker(sessionId: string, name: string): void {
    const path = markerFilePath(dataDir, sessionId, name);
    if (path === null) return;
    try {
      io.remove(path);
    } catch (err) {
      if (!isMissing(err)) log(`consent: session ${sessionId} marker ${name} not removed: ${errText(err)}`);
    }
  }

  function notePool(
    sessionId: string, seen: readonly HookCallDump[], evidence: RegistryEvidence, at: number,
    markers?: Pick<MarkerScan, 'markers' | 'names'>,
  ): void {
    noteHeld(sessionId, evidence, at);
    let found = pools.get(sessionId);
    if (found === undefined) {
      poolVersions += 1;
      found = {
        candidates: new Map(), exited: new Map(), exitedAt: null, live: 0, unlockedAt: null, overflow: false,
        version: poolVersions, checks: 0,
      };
      pools.set(sessionId, found);
    }
    const state = found;
    // Po przekroczeniu sufitu treść puli jest zwolniona, a sesja zostaje bez dowodu do restartu procesu.
    if (state.overflow) return;
    const names = markers?.names ?? NO_NAMES;
    /** Nowy kandydat pod kluczem; `false` = sufit przekroczony (pula zwolniona). */
    const admit = (key: string, make: () => Pick<PoolCandidate, 'dump' | 'pid' | 'startedAt'>): boolean => {
      if (state.candidates.has(key) || state.exited.has(key)) return true;
      // Ponad sufit nikogo się nie wyrzuca (wyrzucony kandydat mógłby stać na wierzchu ekranu): sesja traci dowód,
      // a pamięć puli wraca do systemu. Wyjścia z tej obserwacji liczą się po dopisaniu jej kandydatów.
      if (state.live >= CONSENT_POOL_MAX) {
        log(`consent: session ${sessionId} pool over ${String(CONSENT_POOL_MAX)} candidates, no proof until restart`);
        state.overflow = true;
        state.candidates.clear();
        state.exited.clear();
        state.exitedAt = null;
        state.live = 0;
        bump(state);
        return false;
      }
      state.candidates.set(key, {
        ...make(), exitAt: null, marked: names.has(key), deadAt: null, checkedAt: state.checks,
      });
      state.live += 1;
      bump(state);
      return true;
    };
    for (const dump of seen) {
      if (dump.sessionId !== sessionId) continue;
      if (!admit(dump.key, () => ({ dump: poolDumpOf(dump), pid: dump.pid, startedAt: dump.startedAt }))) return;
    }
    // Znacznik po zrzucie: kandydat z obu źródeł ma pola zrzutu przeczytanego w tej samej obserwacji.
    for (const marker of markers?.markers ?? []) {
      if (marker.sessionId !== sessionId) continue;
      const make = (): Pick<PoolCandidate, 'dump' | 'pid' | 'startedAt'> =>
        ({ dump: poolDumpOfMarker(marker), pid: marker.pid, startedAt: marker.startedAt });
      if (!admit(marker.name, make)) return;
    }
    // Znacznik kandydata ze zrzutu przeczytanego wcześniej: od teraz cykl skasuje go po wyjściu kandydata.
    for (const name of names) {
      const candidate = state.candidates.get(name);
      if (candidate !== undefined) candidate.marked = true;
    }
    // Termin każdego odczytu, który mógł użyć kandydata po wyjściu (odczyt rozpoczęty nie po wyjściu), minął.
    for (const [key, candidate] of state.candidates) {
      if (candidate.exitAt === null || at - candidate.exitAt <= CONSENT_PROOF_TTL_MS) continue;
      state.candidates.delete(key);
      state.exited.set(key, candidate.exitAt);
      state.exitedAt = Math.max(state.exitedAt ?? candidate.exitAt, candidate.exitAt);
      bump(state);
      if (candidate.marked) removeMarker(sessionId, key);
    }
    if (evidence.kind !== 'active' || at - evidence.at > REGISTRY_MAX_AGE_MS) return;
    if (state.unlockedAt === null && evidence.at >= startedAt + REGISTRY_SLACK_MS) {
      state.unlockedAt = evidence.at;
      bump(state);
      log(`consent: session ${sessionId} start lock released`);
    }
    for (const candidate of state.candidates.values()) {
      if (candidate.exitAt !== null) continue;
      // Wątek główny: rejestr po zapisie prośby. Subagent: rejestr po potwierdzonej śmierci hooka, bez niej nigdy
      // (dialog subagenta w tle staje dopiero po wyjściu hooka).
      const since = candidate.dump.agentId === undefined ? candidate.dump.at : candidate.deadAt;
      if (since === null || !registryNegates(evidence, at, { at: since })) continue;
      candidate.exitAt = evidence.at;
      state.live -= 1;
      bump(state);
    }
  }

  function poolKnows(sessionId: string, name: string): boolean {
    const found = pools.get(sessionId);
    if (found === undefined) return false;
    return found.overflow || found.candidates.has(name) || found.exited.has(name);
  }

  function hookWatch(sessionId: string): ConsentHookWatch[] {
    const found = pools.get(sessionId);
    if (found === undefined || found.overflow) return [];
    const out: { readonly watch: ConsentHookWatch; readonly checkedAt: number }[] = [];
    for (const [key, candidate] of found.candidates) {
      if (!watched(candidate)) continue;
      out.push({ watch: { key, pid: candidate.pid, startedAt: candidate.startedAt }, checkedAt: candidate.checkedAt });
    }
    // Sortowanie stabilne: przy równym numerze sprawdzenia zostaje kolejność pierwszego odczytu (kolejność mapy).
    return out.sort((a, b) => a.checkedAt - b.checkedAt).map((one) => one.watch);
  }

  function noteHookChecks(sessionId: string, keys: readonly string[]): void {
    const found = pools.get(sessionId);
    if (found === undefined || found.overflow || keys.length === 0) return;
    found.checks += 1;
    for (const key of keys) {
      const candidate = found.candidates.get(key);
      if (candidate !== undefined) candidate.checkedAt = found.checks;
    }
  }

  /** Kandydat subagenta ze znacznikiem, bez wyjścia i bez zapisanej śmierci hooka. */
  function watched(candidate: PoolCandidate): boolean {
    return candidate.marked && candidate.dump.agentId !== undefined && candidate.exitAt === null
      && candidate.deadAt === null;
  }

  function noteHookDead(sessionId: string, keys: readonly string[], at: number): void {
    const found = pools.get(sessionId);
    if (found === undefined || found.overflow) return;
    for (const key of keys) {
      const candidate = found.candidates.get(key);
      if (candidate !== undefined && watched(candidate)) candidate.deadAt = at;
    }
  }

  function endPool(sessionId: string): void {
    pools.delete(sessionId);
    deskReleases.endSession(slotOf(sessionId, ''));
    desk.endSession(sessionId);
    // Karty końcowe sesji schodzą z magazynu (treść zeszła już przy publikacji); rekordy zostają dla spóźnionego
    // dowodu i audytu, a karty niekońcowe bez zmian (także `pending` i `sent` z `release` subagenta, którego hook
    // czeka na plik).
    for (const card of store.list(sessionId)) {
      const record = records.get(slotOf(card.sessionId, card.permId));
      if (record !== undefined && isFinal(record.state)) store.delete(card.sessionId, card.permId);
    }
    const dir = markersDirOf(dataDir, sessionId);
    if (dir === null) return;
    let files: string[];
    try {
      files = io.list(dir);
    } catch (err) {
      log(`consent: session ${sessionId} markers not listed: ${errText(err)}`);
      return;
    }
    for (const file of files) {
      const name = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
      if (!isMarkerName(name)) continue;
      try {
        io.remove(join(dir, file));
      } catch (err) {
        if (!isMissing(err)) log(`consent: session ${sessionId} marker ${name} not removed: ${errText(err)}`);
      }
    }
    try {
      io.removeDir(dir);
    } catch {
      // Katalog niepusty (plik tymczasowy hooka, znacznik, którego nie dało się usunąć) albo brak: zostaje sprzątaniu
      // startu.
    }
  }

  function pool(sessionId: string): ConsentPool {
    const found = pools.get(sessionId);
    if (found === undefined) return { candidates: [], exited: [], exitedAt: null, unlockedAt: null, overflow: false };
    return {
      candidates: [...found.candidates.values()].map((candidate) => ({ dump: candidate.dump, exitAt: candidate.exitAt })),
      exited: [...found.exited].map(([key, exitAt]) => ({ key, exitAt })),
      exitedAt: found.exitedAt,
      unlockedAt: found.unlockedAt,
      overflow: found.overflow,
    };
  }

  /** Widok karty z magazynu przeliczony przy odczycie: magazyn trzyma widok z ostatniej publikacji. */
  function readView(card: ConsentCardView): ConsentCardView {
    const record = records.get(slotOf(card.sessionId, card.permId));
    return record === undefined ? card : viewOf(record);
  }

  function proofLost(sessionId: string, dump: Pick<HookCallDump, 'key' | 'startedAt'>): boolean {
    const record = records.get(slotOf(sessionId, dump.key));
    if (record !== undefined && RAW_SIGNAL_STATES.includes(record.state)) return false;
    return factLost(sessionId, dump.key, dump.startedAt);
  }

  const turns = createConsentTurns({
    records, bootId, registry, slotOf, enqueue, subagentsOpen, commit, moveTo, claimed, claimedMatches, releaseHook,
    revoke, afterRevokeFile,
  });

  return {
    observe,
    noteRegistryNotWaiting,
    revokeSession,
    decide,
    release,
    confirmReceipt,
    retire,
    off,
    tick,
    recover,
    setCheckpoint,
    evidenceTargets: turns.evidenceTargets,
    applyTurn: turns.applyTurn,
    notePassed,
    markReattached,
    noteTranscript,
    notePool,
    poolKnows,
    hookWatch,
    noteHookChecks,
    noteHookDead,
    endPool,
    pool,
    topWinner,
    proofLost,
    record: (sessionId, key) => {
      const record = records.get(slotOf(sessionId, key));
      return record === undefined ? null : { ...record };
    },
    deskRelease: (sessionId, key) => {
      const slot = slotOf(sessionId, key);
      return records.get(slot)?.releaseCause === 'desk-fallback' ? deskReleases.of(slot) : null;
    },
    subagentPending: (sessionId) => {
      for (const record of records.values()) {
        if (record.sessionId === sessionId && record.state === 'pending' && record.agentId !== null) return true;
      }
      return false;
    },
    card: (sessionId, key) => {
      const card = store.get(sessionId, key);
      return card === null ? null : readView(card);
    },
    cards: (sessionId) => store.list(sessionId).map(readView),
    dropCard: (sessionId, key) => store.delete(sessionId, key),
    diagnosticMemory: (sessionId) => {
      const prefix = slotOf(sessionId, '');
      const keysOf = (slots: Iterable<string>): string[] =>
        [...slots].filter((slot) => slot.startsWith(prefix)).map((slot) => slot.slice(prefix.length));
      return {
        dumps: keysOf(dumps.keys()),
        verdicts: keysOf(verdicts.keys()),
        proofs: [...keysOf(proofs.keys()), ...keysOf(hiddenProofs.keys()), ...keysOf(channelProofs.keys())],
        seenAt: keysOf(seenAt.keys()),
        createdAt: keysOf(createdAt.keys()),
        cards: store.list(sessionId).map((card) => card.permId),
        records: keysOf(records.keys()),
        proofMisses: keysOf(misses.keys()),
        proofNotes: keysOf(proofNotes.keys()),
      };
    },
  };
}
