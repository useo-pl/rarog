/**
 * SseHub — rejestr otwartych strumieni SSE i broadcast eventów protokołu.
 *
 * Reguły z architektury:
 * - strumień globalny (`scope: 'global'`): `hello` → `sessions-snapshot` → live,
 *   reconnect zawsze dostaje pełny snapshot (stateless resync). Karta z wycinkiem ekranu to
 *   mediana ~450 B na sesję, ~20 kB na snapshot 17 sesji, a pojedyncze `session-changed` ze stojącym dialogiem
 *   2,8 kB. Snapshot jest więc tani na tle strumienia, ale nie darmowy — stąd leniwa
 *   serializacja w `broadcast`,
 * - strumień sesji (`scope: <sessionId>`): domknięte wiadomości mają `id: <seq>`,
 *   text-delty NIE mają `id` (nie przesuwają Last-Event-ID, są ulotne),
 * - `Last-Event-ID` → `ManagerApi.eventsSince`; kursor za stary → `transcript-snapshot` + live,
 *   powtórka z co najmniej {@link REPLAY_SNAPSHOT_MIN_MESSAGES} wiadomościami → też snapshot,
 * - a heartbeat comment every 10 s keeps the proxy (Caddy) and iOS alive; `hello` announces the interval
 *   (`heartbeatMs`) as the basis for the client's silence limit,
 * - strumień otwarty kluczem urządzenia jest oznaczony jego `deviceId`: odpięcie urządzenia
 *   zamyka jego trwające strumienie ({@link SseHub.closeOwner}), bo sprawdzenie poświadczenia przy
 *   otwarciu nie odcina strumienia, który już płynie,
 * - kompresja (`RAROG_SSE_GZIP`): gzip tylko przy włączonej fladze i `Accept-Encoding` z `gzip` o wadze większej
 *   od zera; bufor kompresora opróżniany po każdej ramce i każdym pingu, kompresor zamykany przy rozłączeniu
 *   i odpięciu urządzenia,
 * - Inbox heads go only to a global stream opened with `inbox=1` and only when the server keeps an Inbox: `inbox-heads`
 *   right after `sessions-snapshot`, then the events of {@link SseInbox} as they come; a stream without it gets none.
 */
import type { Block, InboxEventOf, InboxHeadOf, ServerEvent, SessionState, TranscriptMessage } from '@rarog/shared';
import { HELLO_HEARTBEAT_MS, MAX_IMAGE_DATA_URL_BYTES } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { type Gzip, constants as zlibConstants, createGzip } from 'node:zlib';
import type { ManagerApi } from './sessions/manager-api.ts';

/**
 * Default heartbeat interval (SSE comment plus a `ping` event) in ms. Every stream gets it, and `hello` announces it
 * as `heartbeatMs`, so a client can tell a stream that stopped without an error from a quiet one.
 */
export const HEARTBEAT_MS = 10_000;

/** Sugerowany dla klienta odstęp reconnectu w ms (pole `retry:`). */
export const RETRY_MS = 3_000;

/** Zakres strumienia: lista sesji albo transkrypt sesji. */
export type SseScope = 'global' | (string & {});

/**
 * Od ilu ramek `message` w powtórce z ring buffera serwer wysyła zamiast niej `transcript-snapshot`.
 *
 * Powtórka idzie ramka po ramce, a przez Caddy i Tailscale dochodzi na telefon paczkami; apka renderuje
 * po każdej paczce, więc przypięty transkrypt schodziłby na dno w kilku skokach (30 wiadomości
 * co 15 ms = 11 skoków, cała powtórka naraz = 1). Snapshot to JEDNA ramka, czyli jeden
 * render — a tę ścieżkę apka zna z każdego zimnego startu i restartu serwera.
 *
 * Próg 2, a nie 1: jedna wiadomość to i tak jeden render, a krótkie zerwanie z jedną wiadomością albo
 * samymi zmianami stanu nie ma płacić bajtami całego transkryptu (do 500 wiadomości).
 */
export const REPLAY_SNAPSHOT_MIN_MESSAGES = 2;
/**
 * Fraza linii logu powtórki zastąpionej snapshotem: `sse: replay <n> messages → snapshot <kB> kB (session <id>)`,
 * a przy kompresji `… → snapshot <kB> kB, gzip <kB> kB (session <id>)`.
 */
export const REPLAY_SNAPSHOT_LOG = 'sse: replay';

/**
 * Ile bajtów data URL-i obrazków wolno zmieścić w JEDNEJ ramce `transcript-snapshot`.
 *
 * Echo użytkownika NIE MA bloków `image` — zdjęcie z telefonu jedzie
 * jako wizytówka `attachments[]`, a bajty zostają w `.rarog-uploads`. Ten budżet pilnuje więc
 * wyłącznie bloków `image` z INNYCH źródeł (dziś: odbicie obrazków przez mock-drivera w demo)
 * i jest ostatnią linią obrony, gdyby taki blok kiedyś wrócił drogą, o której tu nie wiemy.
 *
 * Budżet = jeden obrazek w pełnym rozmiarze. Świadomie mały: ramka leci przy KAŻDYM wejściu
 * w transkrypt i przy każdym rekonekcie z za starym kursorem, czyli na iOS kilkadziesiąt razy
 * dziennie.
 */
export const SNAPSHOT_IMAGE_BUDGET_BYTES = MAX_IMAGE_DATA_URL_BYTES;

/**
 * Podmienny data URL dla obrazka poza budżetem: przezroczysty PNG 1×1.
 *
 * Kształt bloku ZOSTAJE (`type: 'image'`, ta sama liczba bloków): zamiana obrazka na tekstowe
 * `[obraz]` (jak w imporcie jsonl) zmieniałaby LICZBĘ bloków, a klient recykluje węzły
 * transkryptu po podpisie treści — ta sama wiadomość raz z obrazkiem, raz bez, skakałaby
 * w układzie przy każdym rekonekcie.
 *
 * Musi przejść `IMAGE_DATA_URL_PATTERN` z protokołu: klient wkłada tę wartość prosto
 * w `img[src]`, a wariant spoza wzorca wysypałby walidację u każdego, kto ją robi.
 */
export const SNAPSHOT_IMAGE_PLACEHOLDER
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Tekst alternatywny podmienionego obrazka — jedyne miejsce, gdzie klient dowie się, czemu. */
const SNAPSHOT_IMAGE_PLACEHOLDER_ALT = say('transcript.snapshot-image-alt');

/**
 * Snapshot przycięty do {@link SNAPSHOT_IMAGE_BUDGET_BYTES} — od NAJNOWSZEJ wiadomości wstecz.
 *
 * Kierunek jest całą treścią reguły: budżet wydajemy na to, co człowiek zobaczy po otwarciu
 * transkryptu, czyli na dół listy. Obrazki, na które budżetu zabrakło, zostają blokami
 * `image` z {@link SNAPSHOT_IMAGE_PLACEHOLDER}.
 *
 * Funkcja jest CZYSTA i nie tyka wejścia: `manager.transcript()` oddaje żywe tablice sesji,
 * a przycięcie jest własnością TEJ ramki, nie stanu serwera. Gdy nic nie przekracza budżetu
 * (zdecydowana większość sesji — bez obrazków w ogóle), oddaje tę samą tablicę.
 */
export function budgetSnapshotImages(messages: TranscriptMessage[]): TranscriptMessage[] {
  let budget = SNAPSHOT_IMAGE_BUDGET_BYTES;
  let degraded = false;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i];
    if (message === undefined) continue;
    if (!message.blocks.some((b) => b.type === 'image')) continue;
    let touched = false;
    const blocks: Block[] = message.blocks.map((block) => {
      if (block.type !== 'image') return block;
      // Długość stringa, bo base64 jest ASCII i tak samo mierzy go limit z protokołu.
      if (block.dataUrl.length <= budget) {
        budget -= block.dataUrl.length;
        return block;
      }
      // Budżet się skończył — od tego miejsca w głąb historii nic już nie przejdzie.
      budget = 0;
      touched = true;
      return {
        type: 'image',
        dataUrl: SNAPSHOT_IMAGE_PLACEHOLDER,
        alt: SNAPSHOT_IMAGE_PLACEHOLDER_ALT.text,
        // Obraz zastępczy: apka składa `alt` po swojemu zamiast tekstu serwera.
        placeholder: true,
      };
    });
    if (!touched) continue;
    out[i] = { ...message, blocks };
    degraded = true;
  }
  return degraded ? out : messages;
}

/**
 * Minimalny kontrakt odpowiedzi HTTP używany przez huba — `http.ServerResponse` go spełnia,
 * a testy mogą podstawić atrapę bez otwierania gniazda.
 */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  /**
   * Ile bajtów czeka w buforze gniazda (`http.ServerResponse.writableLength`).
   *
   * Opcjonalne, bo to jedyne pole kontraktu, którego atrapa w teście nie musi mieć — brak
   * traktujemy jak „bufor pusty", czyli tak, jak zachowywał się hub przed backpressure.
   */
  readonly writableLength?: number;
}

/** The Inbox heads the hub sends to streams that ask for them (`InboxHeads` in `server/src/inbox/`). */
export interface SseInbox {
  /** The visible cards' heads, newest first, for the start of a stream. */
  heads(): InboxHeadOf<SessionState>[];
  /** Listener of head changes; returns the function that detaches it. */
  onEvent(listener: (event: InboxEventOf<SessionState>) => void): () => void;
}

interface SseClient {
  readonly id: number;
  readonly scope: SseScope;
  /** A global stream opened with `inbox=1` on a server that keeps an Inbox: it gets the Inbox events. */
  readonly inbox: boolean;
  readonly res: SseResponse;
  /** `deviceId` klucza, którym otwarto strumień; brak = strumień otwarty z pominięciem routera (testy). */
  readonly owner: string | undefined;
  /** Kompresor strumienia; brak = strumień bez kompresji. */
  readonly gzip: Gzip | undefined;
  /** Bajty, które kompresor oddał do gniazda, i stan licznika po ostatnim opróżnieniu bufora. */
  bytesOut: number;
  flushedBytes: number;
}

export interface SseHubOptions {
  readonly manager: ManagerApi;
  readonly serverStartId: string;
  readonly protocolVersion: number;
  /**
   * Próg builda natywnej apki (`RAROG_MIN_CLIENT_BUILD`) — jedzie w `hello` jako
   * `minClientBuild`. NIEOBECNY = brak progu i brak pola w ramce (stary front i tak go odcina).
   */
  readonly minClientBuild?: number;
  /**
   * Które z podanych katalogów mają notatkę. Funkcja, a nie wartość: hub powstaje raz,
   * a notatki zmieniają się w trakcie życia procesu.
   *
   * NIEOBECNA = Rarog o notatkach nie mówi (`RAROG_NOTES=0`), więc pola w ramce nie ma i ikon
   * w sidebarze nie ma — killswitch gasi ficzer w całości, a nie zostawia pustej obietnicy.
   */
  readonly notesFor?: (cwds: readonly string[]) => readonly string[];
  /**
   * Linia do `server.log`. Dziś pisze ją tylko zamiana powtórki na snapshot: liczba wiadomości
   * i waga ramki, bez treści — po to, żeby po tygodniu ocenić koszt bajtów.
   */
  readonly logger?: (line: string) => void;
  /**
   * Stream compression with gzip (`RAROG_SSE_GZIP`). When on, it applies only to a client that sent
   * `Accept-Encoding` naming `gzip` with a weight above zero ({@link acceptsGzip}). Missing = off (test hubs); the
   * server always passes the configured value, which is on by default.
   */
  readonly gzip?: boolean;
  /** Fabryka kompresora; testy podstawiają własną, żeby sprawdzić, że każdy się zamknął. */
  readonly createGzip?: () => Gzip;
  /**
   * Number of open streams after every change (connect, disconnect, close). The PR status reads GitHub only while it
   * is above zero (`bootstrap/pr-status.ts`). Missing = nobody listens.
   */
  readonly onClientCount?: (count: number) => void;
  /** The Inbox heads; missing = the server keeps no Inbox (`RAROG_INBOX=0`), so `inbox=1` gives nothing. */
  readonly inbox?: SseInbox;
  /** Odstęp heartbeatu; w testach zwykle bardzo mały albo heartbeat wyłączony (`0`). */
  readonly heartbeatMs?: number;
  /** Injected timers: tests pass fakes so they do not wait for a real interval. */
  readonly setInterval?: (cb: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/**
 * Serializuje event do ramki SSE. `seq === null` → ramka BEZ `id:` (delty).
 *
 * `id:` niesie `<serverStartId>:<seq>`, a nie samo `seq`. `seq` jest unikalny wyłącznie
 * w obrębie JEDNEGO procesu, a klient trzyma kursor przez restart backendu: instancję
 * strumienia wymienia dopiero zmiana trasy, a `pnpm run restart` trasy nie zmienia. Nowy
 * proces odbudowuje tę samą sesję (id jest deterministyczne) i przy imporcie historii
 * przekracza stary numer w kilka sekund — więc `tooOld` mówiło „kursor ważny" i klient
 * dostawał REPLAY ZAMIAST SNAPSHOTU. Wszystko, co nowy proces zdążył wyemitować poniżej tego
 * numeru — w tym odtworzone `permission-pending` / `question-pending` — przepadało bez śladu.
 * Prefiks czyni obcy kursor rozpoznawalnym, a rozpoznany obcy kursor = pełny snapshot.
 */
export function formatSseEvent(
  event: ServerEvent, seq: number | null, serverStartId?: string,
): string {
  const data = JSON.stringify(event);
  const cursor = serverStartId === undefined ? String(seq) : `${serverStartId}:${String(seq)}`;
  const idLine = seq === null ? '' : `id: ${cursor}\n`;
  return `${idLine}data: ${data}\n\n`;
}

/**
 * Kursor strumienia sesji: numer w ring bufferze + proces, który go nadał.
 *
 * `startId: null` znaczy „kursor bez prefiksu" — np. z ręcznego `?since=`.
 * Taki kursor jest dla huba OBCY: nie ma jak dowieść, że pochodzi z tego procesu.
 */
export interface SseCursor {
  readonly seq: number;
  readonly startId: string | null;
}

/** Parsuje `Last-Event-ID`; wartość pusta/niepoprawna → null (traktujemy jak brak kursora). */
export function parseLastEventId(raw: string | string[] | undefined): SseCursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') return null;
  const text = value.trim();
  const split = text.lastIndexOf(':');
  const startId = split === -1 ? null : text.slice(0, split);
  const seq = Number(split === -1 ? text : text.slice(split + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  if (startId !== null && startId === '') return null;
  return { seq, startId };
}

/**
 * Czy klient przyjmuje gzip: `Accept-Encoding` wymienia `gzip` (bez względu na wielkość liter) z wagą `q` większą od
 * zera albo bez wagi. Samo `*` nie wystarcza: serwer kompresuje tylko na jawną prośbę. Waga, której nie da się
 * odczytać, liczy się jak zero.
 */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  for (const part of header.split(',')) {
    const [coding = '', ...params] = part.split(';').map((item) => item.trim());
    if (coding.toLowerCase() !== 'gzip') continue;
    const weight = params.find((param) => /^q\s*=/i.test(param));
    if (weight === undefined) return true;
    const value = weight.slice(weight.indexOf('=') + 1).trim();
    const q = value === '' ? Number.NaN : Number(value);
    return Number.isFinite(q) && q > 0;
  }
  return false;
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Wyłącza buforowanie w proxy (Caddy/nginx) — bez tego delty przychodzą paczkami.
  'X-Accel-Buffering': 'no',
};

export class SseHub {
  private readonly clients = new Map<number, SseClient>();
  private readonly manager: ManagerApi;
  private readonly serverStartId: string;
  private readonly protocolVersion: number;
  private readonly minClientBuild: number | undefined;
  private readonly notesFor: ((cwds: readonly string[]) => readonly string[]) | undefined;
  private readonly logger: ((line: string) => void) | undefined;
  private readonly onClientCount: ((count: number) => void) | undefined;
  private readonly inbox: SseInbox | undefined;
  private readonly gzipEnabled: boolean;
  private readonly createGzipFn: () => Gzip;
  /**
   * Katalogi, o których notatkach klienci JUŻ usłyszeli (były w ostatniej ramce
   * `sessions-snapshot` albo poszły osobnym eventem `notes`).
   *
   * Po to, żeby odczyt z dysku leciał RAZ na katalog: `session-changed` przychodzi kilkanaście
   * razy na minutę pracującej sesji, a pytanie „czy ten projekt ma notatkę" jest o katalog.
   */
  private readonly notedCwds = new Set<string>();
  private readonly heartbeatMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private heartbeat: unknown = null;
  private nextClientId = 1;
  private started = false;

  constructor(options: SseHubOptions) {
    this.manager = options.manager;
    this.serverStartId = options.serverStartId;
    this.protocolVersion = options.protocolVersion;
    this.minClientBuild = options.minClientBuild;
    this.notesFor = options.notesFor;
    this.logger = options.logger;
    this.onClientCount = options.onClientCount;
    this.inbox = options.inbox;
    this.gzipEnabled = options.gzip ?? false;
    this.createGzipFn = options.createGzip ?? ((): Gzip => createGzip());
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.setIntervalFn = options.setInterval
      ?? ((cb, ms) => {
        const handle = setInterval(cb, ms);
        // Heartbeat nie może trzymać procesu przy życiu przy zamykaniu serwera.
        if (typeof handle.unref === 'function') handle.unref();
        return handle;
      });
    this.clearIntervalFn = options.clearInterval
      ?? ((handle) => { clearInterval(handle as NodeJS.Timeout); });
  }

  /**
   * Whether `hello` carries `heartbeatMs`: only for an integer inside `HELLO_HEARTBEAT_MS`. With the heartbeat off
   * (`0`) the field is absent because the schema rejects `0`; a test interval outside the range is absent because the
   * app would treat it as no field anyway.
   */
  private announcesHeartbeat(): boolean {
    return Number.isInteger(this.heartbeatMs)
      && this.heartbeatMs >= HELLO_HEARTBEAT_MS.min && this.heartbeatMs <= HELLO_HEARTBEAT_MS.max;
  }

  /** Podpina się pod manager.onEvent i uruchamia heartbeat. Idempotentne. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.manager.onEvent((scope, seq, ev) => { this.broadcast(scope, seq, ev); });
    this.manager.onTranscriptReset?.((sessionId) => { this.resetTranscript(sessionId); });
    this.inbox?.onEvent((event) => { this.broadcastInbox(event); });
    if (this.heartbeatMs > 0) {
      this.heartbeat = this.setIntervalFn(() => { this.sendHeartbeat(); }, this.heartbeatMs);
    }
  }

  /** Removes a client from the register; a no-op for one already gone. */
  private dropClient(id: number): void {
    if (this.clients.delete(id)) this.countChanged();
  }

  /** Tells the listener the number of open streams; its failure must not break the stream code. */
  private countChanged(): void {
    try {
      this.onClientCount?.(this.clients.size);
    } catch {
      // The listener is not the hub's business.
    }
  }

  /** Liczba otwartych strumieni (diagnostyka + testy). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Heartbeat: komentarz (trzyma przy życiu proxy) + nazwane zdarzenie `ping` (dla klienta).
   *
   * Sam komentarz NIE wystarcza: przeglądarka nie pokazuje komentarzy
   * SSE JS-owi w ogóle, więc klient nie ma JAK odróżnić zdrowej ciszy od połączenia, które
   * umarło po cichu (QUIC/VPN) — i wisiałby na nieświeżym stanie bez końca. Nazwane zdarzenie
   * omija `onmessage` (zero zmian w parserze protokołu), a watchdog w `EventStream` mierzy po
   * nim świeżość strumienia. Starsze klienty ignorują nieznane nazwane zdarzenia natywnie.
   */
  sendHeartbeat(): void {
    for (const client of this.clients.values()) {
      this.writeRaw(client, ': ping\nevent: ping\ndata: {}\n\n');
    }
  }

  /**
   * Rozsyła event do klientów danego zakresu.
   *
   * Ramkę składamy LENIWIE — dopiero przy pierwszym odbiorcy w zakresie. Manager woła tę metodę
   * DWA razy na każde zdarzenie sesji (`#emitBoth`: raz na zakres sesji, raz na globalny),
   * a telefon trzyma otwarty najwyżej jeden z nich; ta druga ramka była więc serializowana
   * po to, żeby ją wyrzucić. Przy braku klientów w ogóle (nikt nie patrzy, panele pracują)
   * `JSON.stringify` całego `session-changed` znikał bez śladu przy każdej zmianie stanu.
   */
  broadcast(scope: SseScope, seq: number | null, event: ServerEvent): void {
    /*
     * Notatki doklejamy do KAŻDEJ ramki `sessions-snapshot`, nie tylko do startowej
     * z `openGlobal`. Manager emituje własne snapshoty (zamknięcie sesji, `#emitSessionsSnapshot`)
     * i one też muszą nieść pole — klient, dla którego brak pola znaczy „killswitch",
     * gasiłby po nich ikony przy w pełni działającym ficzerze.
     */
    const ready = scope === 'global' && event.type === 'sessions-snapshot'
      ? this.withNotes(event)
      : event;
    let frame: string | null = null;
    for (const client of this.clients.values()) {
      if (client.scope !== scope) continue;
      frame ??= formatSseEvent(ready, seq, this.serverStartId);
      this.writeRaw(client, frame);
    }
    // Dopiero PO wysłaniu ramki: `announceNewCwd` woła `broadcast` jeszcze raz (event `notes`),
    // a bit o katalogu nie ma prawa wyprzedzić sesji, która ten katalog wprowadziła.
    if (frame !== null && ready.type === 'session-changed') this.announceNewCwd(ready.session.cwd);
  }

  /**
   * A new card under an open session id: each open stream of that id gets a `transcript-snapshot` of the new card, which
   * replaces the old card's list in the app. A push the server starts is not an opening of the transcript, so the
   * snapshot is read with `peek` (no git refresh).
   */
  resetTranscript(sessionId: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.scope === sessionId) this.sendTranscriptSnapshot(client, sessionId, undefined, true);
    }
  }

  /**
   * Sends an Inbox event to the global streams opened with `inbox=1`; an older app never asks, so it never gets one.
   * Fleeting like `herdr-status`: no `id:`, nothing to replay, a stream that opens later gets `inbox-heads`.
   */
  broadcastInbox(event: InboxEventOf<SessionState>): void {
    let frame: string | null = null;
    for (const client of this.clients.values()) {
      if (!client.inbox) continue;
      frame ??= formatSseEvent(event, null, this.serverStartId);
      this.writeRaw(client, frame);
    }
  }

  /**
   * Dokłada do ramki `sessions-snapshot` pole `notesCwds` i odnotowuje, o czym klient już wie.
   *
   * OBECNOŚĆ pola jest JEDYNYM sygnałem „Rarog mówi o notatkach": brak = `RAROG_NOTES=0`.
   * Dlatego liczy je hub przy wysyłce, a nie ten, kto ramkę składa — inaczej sygnał zależałby
   * od tego, KTÓRA ścieżka kodu wyemitowała snapshot.
   */
  private withNotes(
    snapshot: Extract<ServerEvent, { type: 'sessions-snapshot' }>,
  ): Extract<ServerEvent, { type: 'sessions-snapshot' }> {
    // Katalogi BEZ POWTÓRZEŃ: projekt z trzema sesjami to trzy razy ten sam `cwd`, a pytanie
    // („czy ten katalog ma notatkę") jest o katalog i kosztuje odczyt z dysku.
    const cwds = [...new Set(snapshot.sessions.map((session) => session.cwd))];
    /*
     * Pełna ramka mówi całą prawdę o katalogach, które niesie — więc zbiór „już wiedzą"
     * ZASTĘPUJEMY, a nie uzupełniamy. Katalog, który z listy zniknął i wróci, ma dostać
     * świeży odczyt: w międzyczasie notatka mogła powstać albo zniknąć.
     */
    this.notedCwds.clear();
    for (const cwd of cwds) this.notedCwds.add(cwd);
    const notes = this.notesFor?.(cwds);
    if (notes === undefined) return snapshot;
    return { ...snapshot, notesCwds: [...notes] };
  }

  /**
   * NOWY katalog w strumieniu → jednorazowy odczyt notatki i event `notes` z bitem `empty`.
   *
   * Sesja założona w projekcie, którego nie było w ostatniej ramce, nie ma skąd wziąć tego bitu:
   * `session-changed` go nie niesie, a najbliższy pełny snapshot bywa dopiero po reconnekcie.
   * Ikona notatki zapalała się więc dopiero po uśpieniu telefonu albo po wejściu w pasek
   * pigułek (sonda `GET /api/notes`). Odczyt leci WYŁĄCZNIE dla katalogu jeszcze nieliczonego
   * i tylko pod killswitchem (`notesFor` nieobecne = `RAROG_NOTES=0`).
   */
  private announceNewCwd(cwd: string): void {
    if (this.notesFor === undefined || cwd === '' || this.notedCwds.has(cwd)) return;
    this.notedCwds.add(cwd);
    this.broadcast('global', null, {
      type: 'notes', cwd, empty: this.notesFor([cwd]).length === 0,
    });
  }

  /**
   * Otwiera strumień globalny: `hello` + `sessions-snapshot`, potem live.
   * `Last-Event-ID` jest tu celowo ignorowany — snapshot listy jest tani i zawsze aktualny.
   * `inbox`: the client asked for the Inbox heads (`inbox=1`); on a server with an Inbox `inbox-heads` follows the
   * list and the stream gets the Inbox events from then on.
   */
  openGlobal(res: SseResponse, owner?: string, acceptEncoding?: string, inbox = false): void {
    const client = this.register('global', res, owner, acceptEncoding, inbox && this.inbox !== undefined);
    this.send(client, {
      type: 'hello',
      protocolVersion: this.protocolVersion,
      serverStartId: this.serverStartId,
      ...(this.minClientBuild === undefined ? {} : { minClientBuild: this.minClientBuild }),
      ...(this.announcesHeartbeat() ? { heartbeatMs: this.heartbeatMs } : {}),
    }, null);
    const snapshot: Extract<ServerEvent, { type: 'sessions-snapshot' }> = {
      type: 'sessions-snapshot', sessions: this.manager.list(),
    };
    /*
     * Stan herdr jedzie w TEJ SAMEJ ramce co lista sesji i nie ma dla niego endpointu REST.
     * Powód jest praktyczny: iOS zrywa SSE przy każdym uśpieniu ekranu, więc klient otwiera
     * ten strumień kilkadziesiąt razy dziennie. Gdyby baner „herdr niedostępny" brał stan
     * z osobnego żądania, po każdym powrocie do apki kłamałby aż do jego odpowiedzi.
     */
    const herdrStatus = this.manager.herdrStatus?.();
    if (herdrStatus !== undefined) snapshot.herdrStatus = herdrStatus;
    /*
     * Notatki projektów: jeden bit na KATALOG, wyliczony z katalogów, które i tak
     * są w tej ramce. Pole leci także PUSTE — „żaden projekt nie ma notatki" jest odpowiedzią,
     * która gasi ikony zapalone przed reconnectem. Brak funkcji (`RAROG_NOTES=0`) to brak pola.
     * Liczy to `withNotes`, ta sama metoda co przy ramkach z managera — patrz `broadcast`.
     */
    this.send(client, this.withNotes(snapshot), null);
    // The Inbox heads after the list (`inbox=1`), so the app knows every session a head names.
    if (client.inbox && this.inbox !== undefined) {
      this.send(client, { type: 'inbox-heads', heads: this.inbox.heads() }, null);
    }
  }

  /**
   * Otwiera strumień transkryptu sesji.
   *
   * - brak kursora → `transcript-snapshot` (klient startuje od zera),
   * - kursor za stary (`tooOld`) → `transcript-snapshot`,
   * - kursor ważny, a w powtórce co najmniej {@link REPLAY_SNAPSHOT_MIN_MESSAGES} wiadomości →
   *   `transcript-snapshot`,
   * - kursor ważny i 0–1 wiadomość → replay eventów z ring buffera z ich `seq`.
   */
  openSession(
    sessionId: string, res: SseResponse, cursor: SseCursor | null, owner?: string, acceptEncoding?: string,
  ): void {
    const client = this.register(sessionId, res, owner, acceptEncoding);
    /*
     * Kursor z INNEGO procesu (albo bez prefiksu) jest tak samo bezużyteczny jak jego brak —
     * `seq` nie jest wtedy porównywalne z niczym, co trzyma ten ring buffer.
     */
    if (cursor === null || cursor.startId !== this.serverStartId) {
      this.sendTranscriptSnapshot(client, sessionId);
      return;
    }
    const replay = this.manager.eventsSince(sessionId, cursor.seq);
    if (replay.tooOld) {
      this.sendTranscriptSnapshot(client, sessionId);
      return;
    }
    /*
     * Kilka zaległych wiadomości jedzie JEDNĄ ramką zamiast powtórki ramka po ramce — patrz
     * {@link REPLAY_SNAPSHOT_MIN_MESSAGES}. Snapshot niesie te same `seq` (wiadomość w ringu i w tablicy
     * transkryptu to ten sam obiekt, `Session.appendMessage`), więc wiersze apki się nie przebudowują.
     * Pominięte ramki stanu dochodzą inaczej: `session-changed`, `state` i treść `usage` (podsumowanie
     * sesji) strumieniem globalnym, `git-status` ponowną emisją przy `transcript()`, karty pełnymi listami
     * pending w snapshocie. Ginie tylko 6-sekundowy ślad karty rozstrzygniętej gdzie indziej
     * i tekst w locie (`delta` niosą wyłącznie sesje demo).
     * Snapshot nie ma `id:`, więc kursor apki przesunie dopiero pierwsza ramka na żywo — jak na ścieżce
     * `tooOld`; kolejne wejście z tym samym kursorem znów dostaje snapshot, bez duplikatów.
     */
    const messages = replay.events.filter((item) => item.event.type === 'message').length;
    if (messages >= REPLAY_SNAPSHOT_MIN_MESSAGES) {
      const logger = this.logger;
      const kB = (bytes: number): string => (bytes / 1024).toFixed(1);
      let raw = 0;
      const line = (packed: number | null): string => {
        const gzip = packed === null ? '' : `, gzip ${kB(packed)} kB`;
        return `${REPLAY_SNAPSHOT_LOG} ${String(messages)} messages → snapshot ${kB(raw)} kB${gzip}`
          + ` (session ${sessionId})`;
      };
      // Z kompresją waga po kompresji jest znana dopiero po opróżnieniu bufora, więc linia idzie wtedy.
      const frame = this.sendTranscriptSnapshot(
        client, sessionId, logger === undefined ? undefined : (packed) => { logger(line(packed)); },
      );
      raw = Buffer.byteLength(frame, 'utf8');
      if (logger !== undefined && client.gzip === undefined) logger(line(null));
      return;
    }
    for (const item of replay.events) {
      this.send(client, item.event, item.seq);
    }
  }

  /**
   * Zamyka trwające strumienie urządzenia (odpięcie) i zwraca ich liczbę. Klient po zamknięciu
   * łączy się od nowa i dostaje 401 `device-revoked` z bramki routera.
   */
  closeOwner(owner: string): number {
    let closed = 0;
    for (const client of [...this.clients.values()]) {
      if (client.owner !== owner) continue;
      this.dropClient(client.id);
      closed += 1;
      this.endClient(client);
    }
    return closed;
  }

  /** Zamyka wszystkie strumienie i zatrzymuje heartbeat (graceful shutdown). */
  closeAll(): void {
    for (const client of this.clients.values()) this.endClient(client);
    this.clients.clear();
    this.countChanged();
    if (this.heartbeat !== null) {
      this.clearIntervalFn(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Wysyła `transcript-snapshot` i oddaje ramkę — waga trafia do linii logu powtórki. `onFlushed` dostaje wagę ramki po
   * kompresji albo `null`, gdy kompresor zamknął się przed opróżnieniem bufora; bez kompresji nie jest wołane.
   */
  private sendTranscriptSnapshot(
    client: SseClient, sessionId: string, onFlushed?: (packed: number | null) => void, peek = false,
  ): string {
    const t = peek ? this.manager.transcript(sessionId, { peek: true }) : this.manager.transcript(sessionId);
    const event: ServerEvent = {
      type: 'transcript-snapshot',
      sessionId,
      // Jedyna ramka protokołu nieograniczona w bajtach — patrz {@link budgetSnapshotImages}.
      messages: budgetSnapshotImages(t.messages),
      pendingPermissions: t.pendingPermissions,
      pendingQuestions: t.pendingQuestions,
    };
    // Aktywność jest ULOTNA (brak w ring bufferze), więc snapshot jest jedynym sposobem, żeby
    // telefon podłączający się w środku tury zobaczył „myśli…" zamiast pustego ekranu.
    if (t.activity !== undefined) event.activity = t.activity;
    const frame = formatSseEvent(event, null, this.serverStartId);
    this.writeChecked(client, frame, onFlushed);
    return frame;
  }

  private register(
    scope: SseScope, res: SseResponse, owner: string | undefined, acceptEncoding: string | undefined, inbox = false,
  ): SseClient {
    const id = this.nextClientId++;
    const gzip = this.gzipEnabled && acceptsGzip(acceptEncoding) ? this.createGzipFn() : undefined;
    const client: SseClient = { id, scope, inbox, res, owner, gzip, bytesOut: 0, flushedBytes: 0 };
    res.writeHead(200, {
      ...SSE_HEADERS,
      // Przy włączonej kompresji odpowiedź zależy od `Accept-Encoding`; pośrednik nie ma jej podać innemu klientowi.
      ...(this.gzipEnabled ? { Vary: 'Accept-Encoding' } : {}),
      ...(gzip === undefined ? {} : { 'Content-Encoding': 'gzip' }),
    });
    if (gzip !== undefined) {
      /*
       * Bajty z kompresora idą prosto do odpowiedzi. Kompresję dostaje tylko odpowiedź z trasy HTTP
       * (`http.ServerResponse`, który przyjmuje bajty); kontrakt {@link SseResponse} zostaje tekstowy dla atrap.
       */
      const sink = res as unknown as { write(chunk: Uint8Array): boolean };
      gzip.on('data', (bytes: Buffer) => {
        client.bytesOut += bytes.length;
        try {
          sink.write(bytes);
        } catch {
          // Zerwane gniazdo: klient znika z rejestru, kompresor się zamyka.
          this.dropClient(id);
          gzip.destroy();
        }
      });
      // Błąd kompresora kończy strumień; klient łączy się od nowa.
      gzip.on('error', () => {
        this.dropClient(id);
        try {
          res.end();
        } catch {
          // Klient mógł już odejść.
        }
      });
    }
    this.writeRaw(client, `retry: ${RETRY_MS}\n\n`);
    this.clients.set(id, client);
    this.countChanged();
    res.on('close', () => {
      this.dropClient(id);
      // Rozłączenie: kompresor nie ma już dokąd pisać, więc zamyka się od razu.
      gzip?.destroy();
    });
    return client;
  }

  /**
   * Kończy odpowiedź klienta. Z kompresją najpierw domyka gzip (stopka strumienia) i kończy odpowiedź dopiero po
   * ostatnich bajtach z kompresora; kompresor zamyka się sam po końcu.
   */
  private endClient(client: SseClient): void {
    const end = (): void => {
      try {
        client.res.end();
      } catch {
        // Klient mógł już odejść — zamykanie jest best-effort.
      }
    };
    const gzip = client.gzip;
    if (gzip === undefined || gzip.destroyed) {
      end();
      return;
    }
    gzip.once('end', end);
    gzip.end();
  }

  private send(client: SseClient, event: ServerEvent, seq: number | null): void {
    this.writeRaw(client, formatSseEvent(event, seq, this.serverStartId));
  }

  private writeRaw(client: SseClient, chunk: string): void {
    this.writeChecked(client, chunk);
  }

  /**
   * Zapis z odpowiedzią, CO się stało — jedyne miejsce, które dotyka gniazda.
   *
   * @returns `true` = przyjęte bez zatoru, `false` = przyjęte, ale bufor gniazda pełny
   *   (`write()` oddało `false`), `null` = gniazdo zerwane i klient wyrejestrowany.
   */
  private writeChecked(
    client: SseClient, chunk: string, onFlushed?: (packed: number | null) => void,
  ): boolean | null {
    try {
      const gzip = client.gzip;
      if (gzip === undefined) return client.res.write(chunk);
      const accepted = gzip.write(chunk);
      /*
       * Opróżnienie bufora po KAŻDYM zapisie (ramka, ping, `retry:`): bez niego gzip trzyma bajty, aż uzbiera blok,
       * a ping czekałby na następną ramkę. `Z_SYNC_FLUSH` zostawia słownik, więc ramka dalej kompresuje się względem
       * poprzednich. Licznik bajtów między opróżnieniami daje wagę tej ramki po kompresji.
       */
      gzip.flush(zlibConstants.Z_SYNC_FLUSH, (...args: unknown[]) => {
        const failed = args[0] !== undefined && args[0] !== null;
        const packed = client.bytesOut - client.flushedBytes;
        client.flushedBytes = client.bytesOut;
        onFlushed?.(failed ? null : packed);
      });
      return accepted;
    } catch {
      // Zerwane gniazdo: usuwamy klienta, żeby broadcast nie próbował go w kółko.
      this.dropClient(client.id);
      return null;
    }
  }
}
