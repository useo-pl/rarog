/**
 * Tożsamość sesji herdr między restartami Raroga.
 *
 * 1. `randomUUID()` przy każdym starcie robił z 17 zakładek na telefonie 17 stron 404 —
 *    codziennie, bo Rarog restartuje się przy każdym deployu. `sessionIdFor(key)` jest czystą
 *    funkcją klucza agenta, więc deep-link `/sessions/<uuid>` przeżywa restart, `Last-Event-ID`
 *    ma do czego się odnieść, a karta nie zmienia tożsamości pod palcem.
 * 2. Alias `engineSessionId → sessionId`: po wznowieniu panel jest NOWY, więc `key`
 *    jest inny i `sessionIdFor(key)` daje inne id. Uuid SILNIKA jest jedyną rzeczą, która
 *    przeżywa zmianę panelu — i to on jest kluczem aliasu. Zero treści, dwa uuidy na wpis.
 * 3. `seen` — „ten wynik obejrzałem z telefonu". herdr gasi znacznik `done` wyłącznie
 *    fokusem panelu w terminalu, więc bez tej sekcji karta obejrzana na telefonie wracała do
 *    sekcji uwagi po każdym resyncu i po każdym restarcie Raroga. Wpis to dwa identyfikatory
 *    i numer stanu; nowszy `done` ma numer wyższy i przebija go sam z siebie.
 *
 * Sekcja `hidden` (stara lista ukrytych) jest przy odczycie ignorowana, a pierwszy zapis ją
 * gubi. Nazwa pliku (`herdr-hidden.json`), typu (`HiddenStore`) i pola (`supervisor.hidden`)
 * ZOSTAJE: zmiana nazwy magazynu kosztowałaby migrację aliasów i `seen` — jedynych sekcji,
 * które dziś niesie — za samą kosmetykę.
 *
 * Format pliku rośnie WYŁĄCZNIE o nowe klucze najwyższego poziomu albo o OPCJONALNE pola wpisu,
 * a każda sekcja jest czytana niezależnie: plik zapisany przez starszą wersję Raroga wczytuje się
 * bez straty (brakująca sekcja = pusta, brakujące pole = wartość domyślna), a zapisany przez
 * nowszą — bez wywrotki (nieznane pole wpisu starsza wersja pomija). Jedyne takie pole dziś to
 * `unseen` wpisu `seen`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeenBy } from '@rarog/shared/rest';

/**
 * Przestrzeń nazw UUIDv5 Raroga — WYGENEROWANA RAZ I ZAMROŻONA.
 *
 * Zmiana tej stałej unieważnia wszystkie zapisane deep-linki (klucz zostaje ten sam, ale
 * `sessionId` się zmienia). Nie ma powodu, dla którego wolno by ją było ruszyć — jeśli kiedyś
 * taki powód powstanie, to jest zmiana wymagająca migracji, a nie poprawka jednej linii.
 */
export const HERDR_SESSION_NAMESPACE = '5d1a1f74-9c1e-4a3f-9d3b-6a0f2b8c47e1';

/** Nazwa pliku magazynu tożsamości (aliasy + `seen`) w `config.dataDir` — patrz nagłówek. */
export const HERDR_HIDDEN_FILENAME = 'herdr-hidden.json';

const FILE_MODE = 0o600;

/** UUID tekstowy → 16 bajtów. */
function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Niepoprawny UUID przestrzeni nazw: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/** 16 bajtów → UUID tekstowy. */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

/**
 * UUID wersji 5 (RFC 4122, sekcja 4.3): sha1(przestrzeń nazw ‖ nazwa) z ustawionymi bitami wersji
 * i wariantu.
 *
 * Piszemy to ręcznie zamiast dokładać zależność `uuid`: algorytm ma 6 linii, jest zamrożony
 * od 2005 roku, a `node:crypto` daje sha1 z pudełka. Test pilnuje zgodności z wektorem
 * referencyjnym RFC.
 */
export function uuidV5(name: string, namespace: string = HERDR_SESSION_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Bajt 6: górne 4 bity = wersja (5). Bajt 8: górne 2 bity = wariant RFC 4122 (10xx).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** Deterministyczny `sessionId` Raroga dla agenta herdr o danym kluczu. */
export function sessionIdFor(key: string): string {
  return uuidV5(key);
}

/**
 * Ile aliasów `engineSessionId → sessionId` trzymamy (LRU).
 *
 * To NIE jest powrót rejestru sesji: wpis ma dwa uuidy i zero treści — ani etykiety, ani
 * katalogu, ani jednej wiadomości. 200 wpisów to kilkanaście kilobajtów i zapas na miesiące
 * wznowień, a najstarszy alias, który wypadnie, kosztuje dokładnie tyle, że karta wznowionej
 * sesji dostanie nowy adres.
 */
export const HERDR_ALIAS_LIMIT = 200;

/**
 * Znacznik „ten wynik już widziałem" — Z TELEFONU.
 *
 * herdr gasi `done` wyłącznie fokusem panelu w terminalu, więc karta obejrzana na telefonie
 * wisiała w sekcji uwagi do końca dnia. Rarog dokłada więc WŁASNY znacznik, i to jest cała
 * jego treść: numer stanu (`state_change_seq`), przy którym wynik został obejrzany. Nowszy
 * `done` ma numer WYŻSZY, więc przebija znacznik sam z siebie — bez kasowania, bez TTL i bez
 * jednej linii wysłanej do cudzego panelu.
 */
export interface SeenEntry {
  key: string;
  agentSessionId: string;
  stateChangeSeq: number;
  /**
   * Ręczne „nieprzeczytane" z listy: człowiek cofnął odbiór wyniku przy tym numerze stanu.
   * Wpis jest jeden na panel, więc ostatnia decyzja — „obejrzane" albo „nieprzeczytane" — wygrywa.
   * Starsza wersja Raroga pole pomija i czyta wpis jako „obejrzane": rollback gubi tylko ręczne
   * „nieprzeczytane".
   */
  unseen?: true;
  /**
   * Who received the result when it was not a human: `voice-agent` after the voice agent's pick-up. Only on a receipt
   * entry; a human receipt at the same number rewrites the entry without it. An older Rarog skips the field and reads
   * the entry as a receipt, so a rollback loses only who received.
   */
  by?: SeenBy;
}

/** Magazyn tożsamości — niesie aliasy i `seen` (nazwa po starej liście ukrytych). */
export interface HiddenStore {
  /**
   * Numer stanu, przy którym wynik tego panelu został obejrzany z telefonu.
   *
   * `undefined` = nigdy. Wpis jest honorowany wyłącznie przy ZGODNYM `agentSessionId`:
   * po restarcie serwera herdr adresy paneli startują od nowa, a „widziane" odziedziczone
   * po cudzym panelu chowałoby świeży wynik.
   */
  seenSeq(key: string, agentSessionId: string): number | undefined;
  /** `by` = who received when it was not a human (absent = a human); see {@link SeenEntry.by}. */
  markSeen(key: string, agentSessionId: string, stateChangeSeq: number, by?: SeenBy): Promise<void>;
  /** {@link SeenEntry.by} of the receipt entry at this address; `undefined` for a human, an "unread" entry or none. */
  seenBy(key: string, agentSessionId: string): SeenBy | undefined;
  /**
   * Numer stanu, przy którym człowiek oznaczył wynik jako NIEPRZECZYTANY. Te same zasady
   * adresu co {@link HiddenStore.seenSeq}; wpis „obejrzane" i „nieprzeczytane" wykluczają się.
   */
  unseenSeq(key: string, agentSessionId: string): number | undefined;
  markUnseen(key: string, agentSessionId: string, stateChangeSeq: number): Promise<void>;
  /**
   * `sessionId` Raroga zapamiętany dla tej sesji SILNIKA.
   *
   * `sessionIdFor(key)` liczy id z adresu panelu, a wznowienie dostaje NOWY panel — bez tego
   * aliasu obietnica „ta sama karta po wznowieniu" żyłaby wyłącznie w RAM i umierała przy
   * pierwszym deployu, czyli dokładnie w scenariuszu, dla którego ten plik powstał.
   */
  aliasFor(engineSessionId: string): string | undefined;
  rememberAlias(engineSessionId: string, sessionId: string): Promise<void>;
  /** Domknięcie zapisów w toku (testy, `dispose()`). */
  flush(): Promise<void>;
  /*
   * ŻADNA z powyższych obietnic nigdy nie zostaje odrzucona — patrz `persist()`. Produkcja
   * woła `markSeen`/`rememberAlias` przez `void` (index.ts), więc odrzucenie nie miałoby
   * odbiorcy i ubiłoby proces.
   */
}

export interface HiddenStoreOptions {
  dataDir: string;
  /** Jedna linia przy nieudanym zapisie magazynu; brak = cisza. */
  logger?: (message: string) => void;
}

/** Ścieżka pliku magazynu tożsamości (aliasy + `seen`). */
export function hiddenStorePath(dataDir: string): string {
  return path.join(dataDir, HERDR_HIDDEN_FILENAME);
}

/**
 * Ile znaczników „widziane" trzymamy (LRU).
 *
 * Wpis ma dwa identyfikatory i jedną liczbę — kilkadziesiąt bajtów. 200 to zapas na wszystkie
 * panele, jakie mieszczą się na Macu, razy kilka dni; najstarszy, który wypadnie, kosztuje
 * dokładnie tyle, że karta wraca do sekcji uwagi.
 */
export const HERDR_SEEN_LIMIT = 200;

interface StoreState {
  aliases: Map<string, string>;
  seen: Map<string, SeenEntry>;
}

/**
 * Wczytanie stanu: cokolwiek nie tak z plikiem → pusty stan, NIGDY wyjątek.
 *
 * Sekcja `hidden` (i cały plik w starym formacie — goła tablica kluczy) jest ignorowana.
 */
function loadState(file: string): StoreState {
  const empty: StoreState = { aliases: new Map(), seen: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Brak pliku (pierwszy start) albo uszkodzony JSON. Pusty stan jest bezpieczny:
    // najgorsze, co się stanie, to nowy adres wznowionej karty i powrót „widzianych".
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;

  const body = parsed as { aliases?: unknown; seen?: unknown };
  const aliases = new Map<string, string>();
  if (typeof body.aliases === 'object' && body.aliases !== null) {
    for (const [engine, sessionId] of Object.entries(body.aliases as Record<string, unknown>)) {
      if (typeof sessionId === 'string' && sessionId !== '') aliases.set(engine, sessionId);
    }
  }
  const seen = new Map<string, SeenEntry>();
  if (Array.isArray(body.seen)) {
    for (const raw of body.seen) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as {
        key?: unknown; agentSessionId?: unknown; stateChangeSeq?: unknown; unseen?: unknown; by?: unknown;
      };
      if (typeof entry.key !== 'string' || entry.key === '') continue;
      if (typeof entry.agentSessionId !== 'string' || entry.agentSessionId === '') continue;
      // Numer stanu MUSI być skończoną liczbą: `NaN` w porównaniu jest zawsze fałszem, więc
      // wpis-śmieć znaczyłby „widziane" albo „niewidziane" zależnie od strony nierówności.
      if (typeof entry.stateChangeSeq !== 'number' || !Number.isFinite(entry.stateChangeSeq)) {
        continue;
      }
      seen.set(entry.key, {
        key: entry.key,
        agentSessionId: entry.agentSessionId,
        stateChangeSeq: entry.stateChangeSeq,
        ...(entry.unseen === true ? { unseen: true as const } : {}),
        // An unknown receiver (a newer Rarog) reads as a human receipt: the receipt itself stays.
        ...(entry.unseen !== true && entry.by === 'voice-agent' ? { by: 'voice-agent' as const } : {}),
      });
    }
  }
  return { aliases, seen };
}

/**
 * Aliasy sesji i znaczniki `seen`, trzymane w RAM i utrwalane ATOMOWO (tmp + rename).
 *
 * Zapis „w miejscu" potrafi zostawić plik uciętym w połowie, gdy proces zginie w trakcie —
 * a wtedy przy starcie odzyskujemy pusty stan (nowe adresy wznowionych kart, powrót
 * „widzianych" do sekcji uwagi). `rename` w obrębie jednego systemu plików jest atomowe.
 */
export function createHiddenStore(opts: HiddenStoreOptions): HiddenStore {
  const file = hiddenStorePath(opts.dataDir);
  const { aliases, seen } = loadState(file);
  let chain: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const payload = `${JSON.stringify({
      aliases: Object.fromEntries(aliases),
      // Kolejność wstawiania (czyli LRU) zachowujemy CELOWO: to ona decyduje, który znacznik
      // wypadnie po przekroczeniu limitu, więc sortowanie po kluczu zgubiłoby tę informację
      // przy pierwszym restarcie.
      seen: [...seen.values()],
    })}\n`;
    chain = chain.then(async () => {
      const tmp = `${file}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE });
      await rename(tmp, file);
    }).catch((err: unknown) => {
      /*
       * Łańcuch NIE MOŻE zostać odrzucony, i to z dwóch niezależnych powodów.
       *
       * 1. `chain` jest stanem obiektu żyjącego przez całe życie procesu: odrzucona obietnica
       *    pomija KAŻDY następny krok, więc jedno ENOSPC zamrażałoby aliasy i znaczniki
       *    „widziane" do końca dnia — czyli dokładnie te dwie regresje, dla których ten plik
       *    powstał. Połknięcie błędu daje samoleczenie: następny `persist()` próbuje od nowa.
       * 2. Produkcja woła `markSeen`/`rememberAlias` przez `void` (index.ts), a w procesie nie
       *    ma handlera `unhandledRejection` — odrzucenie ubijałoby serwer razem ze strumieniami
       *    SSE i podpięciami paneli.
       *
       * Magazyn jest WYGODĄ (deep-link po restarcie, „widziane"), nie autoryzacją — ta sama
       * reguła, co przy dzienniku audytu: nieudany zapis kosztuje powrót do stanu z RAM,
       * a nie utratę serwera.
       */
      opts.logger?.(
        `herdr-hidden: write failed (${err instanceof Error ? err.message : String(err)})`
        + ' — aliases and "seen" markers stay in RAM',
      );
    });
    return chain;
  };

  const writeSeen = (entry: SeenEntry): Promise<void> => {
    // `delete` przed `set` przesuwa wpis na koniec kolejności wstawiania (LRU) — tak samo
    // jak przy aliasach.
    seen.delete(entry.key);
    seen.set(entry.key, entry);
    while (seen.size > HERDR_SEEN_LIMIT) {
      const oldest = seen.keys().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
    return persist();
  };

  return {
    seenSeq(key: string, agentSessionId: string): number | undefined {
      const entry = seen.get(key);
      if (entry === undefined || entry.agentSessionId !== agentSessionId) return undefined;
      return entry.unseen === true ? undefined : entry.stateChangeSeq;
    },
    markSeen(key: string, agentSessionId: string, stateChangeSeq: number, by?: SeenBy): Promise<void> {
      const current = seen.get(key);
      if (
        current?.agentSessionId === agentSessionId
        && current.unseen !== true
        && current.stateChangeSeq >= stateChangeSeq
      ) {
        // Znacznik już obejmuje ten stan — zapis niczego by nie zmienił, a przy 17 panelach
        // odświeżanych co 30 s byłby stałym ruchem na dysku.
        if (current.by === by) return chain;
        // Another receiver of the same result (a human after the voice agent): the number stays, `by` follows.
        return writeSeen({
          key, agentSessionId, stateChangeSeq: current.stateChangeSeq, ...(by === undefined ? {} : { by }),
        });
      }
      // Wpis „nieprzeczytane" ustępuje odbiorowi przy KAŻDYM numerze, także niższym: licznik
      // herdr cofa się po restarcie jego serwera, a świadomy odbiór jest nowszą decyzją.
      return writeSeen({ key, agentSessionId, stateChangeSeq, ...(by === undefined ? {} : { by }) });
    },
    seenBy(key: string, agentSessionId: string): SeenBy | undefined {
      const entry = seen.get(key);
      if (entry === undefined || entry.agentSessionId !== agentSessionId || entry.unseen === true) return undefined;
      return entry.by;
    },
    unseenSeq(key: string, agentSessionId: string): number | undefined {
      const entry = seen.get(key);
      if (entry === undefined || entry.agentSessionId !== agentSessionId) return undefined;
      return entry.unseen === true ? entry.stateChangeSeq : undefined;
    },
    markUnseen(key: string, agentSessionId: string, stateChangeSeq: number): Promise<void> {
      const current = seen.get(key);
      if (
        current?.agentSessionId === agentSessionId
        && current.unseen === true
        && current.stateChangeSeq === stateChangeSeq
      ) {
        return chain;
      }
      // Bez bramki „tylko wyższy numer", z tego samego powodu co przy odbiorze nad „nieprzeczytane".
      return writeSeen({ key, agentSessionId, stateChangeSeq, unseen: true });
    },
    aliasFor: (engineSessionId) => aliases.get(engineSessionId),
    rememberAlias(engineSessionId: string, sessionId: string): Promise<void> {
      if (aliases.get(engineSessionId) === sessionId) return chain;
      // `delete` przed `set` przesuwa wpis na koniec kolejności wstawiania — `Map` zachowuje
      // ją wiernie, więc LRU nie potrzebuje osobnej struktury.
      aliases.delete(engineSessionId);
      aliases.set(engineSessionId, sessionId);
      while (aliases.size > HERDR_ALIAS_LIMIT) {
        const oldest = aliases.keys().next();
        if (oldest.done === true) break;
        aliases.delete(oldest.value);
      }
      return persist();
    },
    flush: () => chain,
  };
}
