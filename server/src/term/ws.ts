/**
 * Terminal PTY — transport WebSocket.
 *
 * Autoryzacja jest fail-closed i wykonuje się PRZED `handleUpgrade`: ficzer włączony,
 * ścieżka `/api/term/<16 hex>`, ważne poświadczenie (`authenticate`: klucz urządzenia z nagłówka
 * `Authorization`), `Origin` z allow-listy, id znane rejestrowi (gniazdo bez
 * `POST`, `?direct=1`: wpis, do którego wolno wejść bez `POST` — `TermRegistry.attachableDirect`).
 * Każda odmowa kończy się `socket.destroy()` — bez odpowiedzi HTTP, bo klientowi nieuprawnionemu nie
 * mamy nic do powiedzenia. Nieznany klucz urządzenia liczy się w dławiku jak przy REST.
 *
 * Origin sprawdzamy tu jawnie, choć router robi to tylko na mutacjach: upgrade WS otwiera powłokę, więc
 * dostaje tę samą bramkę co mutacja. Reguła jest ta sama co w routerze (`originAllowed`,
 * `auth/origin.ts`): na gnieździe iroh wyłącznie `IROH_ORIGIN`. Odmowa na gnieździe iroh idzie do budżetu
 * logów nasłuchu zamiast linii `term: upgrade refused`.
 *
 * Gniazdo otwarte kluczem urządzenia jest oznaczone jego `deviceId`: odpięcie urządzenia ZAMYKA jego
 * otwarte terminale ({@link TermUpgradeHandler.closeOwner}) — rejestr pisze do powłoki bez ponownej
 * kontroli poświadczenia, więc samo sprawdzenie przy upgrade'zie nie odcinałoby otwartego terminala.
 * Odcięcie jest SYNCHRONICZNE: gniazdo zostaje oznaczone jako odpięte i odłączone od rejestru, zanim
 * poleci ramka `err` i zamknięcie, a każda ramka, która przyjdzie później (także w trakcie handshake'u
 * zamknięcia), idzie do kosza. Klient ignorujący zamknięcie dostaje `terminate()` po
 * {@link TERM_REVOKE_TERMINATE_MS} zamiast 30 s pingu.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  TERM_ID_RE, TERM_MAX_INPUT_BYTES, TERM_MAX_PASTE_BYTES, termClientFrameSchema,
} from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { authenticate, loginPeer, originAllowed } from '../auth/index.ts';
import { noteIrohRefusal } from '../iroh/socket.ts';
import type { DeviceStore, LoginLimiter } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import type { Logger } from '../router.ts';
import { TERM_PING_MS, TERM_WS_MAX_PAYLOAD_BYTES } from './lifecycle.ts';
import { errFrame } from './backend.ts';
import { PasteAssembler } from './paste.ts';
import type { TermClient, TermDirectVerdict, TermRegistry } from './registry.ts';

/** Kod zamknięcia dla błędu protokołu (ramka binarna od klienta, `in` ponad limit). */
const CLOSE_PROTOCOL_ERROR = 1002;

/** Kod zamknięcia dla terminala w stanie `failed` albo nieznanego id po autoryzacji. */
const CLOSE_POLICY = 1008;

/** Powód odmowy gniazda bez `POST` w `server.log` — stan wpisu, nigdy treść terminala. */
const DIRECT_REFUSAL: Record<Exclude<TermDirectVerdict, 'ok'>, string> = {
  unknown: 'direct: id not in the registry',
  failed: 'direct: entry is failed',
  stale: 'direct: handle needs recomputing',
  lazygit: 'direct: lazygit goes through POST',
};

export interface TermUpgradeOptions {
  readonly config: RarogConfig;
  readonly registry: TermRegistry;
  readonly logger: Logger;
  /** Magazyn kluczy urządzeń; brak = nagłówek `Authorization` zawsze odrzucony. */
  readonly devices?: DeviceStore;
  /** Wspólny dławik nieudanych prób (router i terminal); brak = porażki bez dławika i logu. */
  readonly limiter?: LoginLimiter;
}

export interface TermUpgradeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Zamyka otwarte terminale urządzenia (odpięcie); zwraca liczbę zamkniętych gniazd. */
  closeOwner(owner: string): number;
  /** Zamyka serwer WS i wszystkie gniazda (shutdown — `server.close()` ich nie dotyka). */
  close(): void;
}

/**
 * Ile gniazdo odpiętego urządzenia ma na handshake zamknięcia, zanim serwer je zerwie. Wejście i tak nie
 * przechodzi od chwili odpięcia; termin odcina klienta, który zamknięcie ignoruje i trzymałby gniazdo
 * do pingu (30 s). Dwie sekundy wystarczą, żeby ramka `err` i zamknięcie zeszły przez LTE.
 */
export const TERM_REVOKE_TERMINATE_MS = 2_000;

/** Fraza linii logu o wklejce ponad sufit, odrzuconej w całości (log mówi „ile”, nigdy „co”). */
export const TERM_PASTE_OVER_CAP_LOG = 'paste over the cap';
/** Fraza linii logu o klawiszu w środku wklejki: wklejka idzie do kosza, połowy nie ma. */
export const TERM_PASTE_INTERRUPTED_LOG = 'input in the middle of a paste';

/**
 * Ścieżka upgrade'u; `:id` jest hexem z `TERM_ID_RE`, nigdy ścieżką z klienta.
 *
 * `?fresh=1` = klient zestawia gniazdo dla ŚWIEŻEGO xterma (bez stanu trybów) — rejestr robi
 * wtedy pełny reattach zamiast `refresh-client` (powód przy `TermRegistry.attach`). Brak
 * parametru = xterm z historią (reconnect po zerwaniu gniazda).
 *
 * `?direct=1` = gniazdo próby BEZ poprzedzającego `POST /api/term` (klient zna id). Bramką jest
 * wtedy `TermRegistry.attachableDirect` zamiast samego `has` — powód przy tej metodzie. Każda
 * inna wartość (i brak parametru) = gniazdo zwykłe, dokładnie jak przed znacznikiem, więc
 * starszy klient nie widzi żadnej zmiany.
 */
export function termAttachFromUrl(
  rawUrl: string | undefined,
): {
  id: string; fresh: boolean; direct: boolean; size: { cols: number; rows: number } | null;
} | null {
  // The HTTP parser lets through targets `URL` rejects (`//:/`); this runs before any credential, and a throw here
  // would end the process, so an unparsable target is a path outside `/api/term/:id`.
  let url: URL;
  try {
    url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
  const match = /^\/api\/term\/([^/]+)$/.exec(url.pathname.replace(/\/+$/, ''));
  const id = match?.[1];
  if (id === undefined || !TERM_ID_RE.test(id)) return null;
  // Rozmiar klienta zmierzony przed upgrade'em — powód przy `termWsUrl` (terminal-core).
  // Zakres jak w ramce `rs` (1..1000); śmieć = brak rozmiaru, nigdy błąd upgrade'u.
  const dim = (name: string): number | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : null;
  };
  const cols = dim('c');
  const rows = dim('r');
  return {
    id,
    fresh: url.searchParams.get('fresh') === '1',
    direct: url.searchParams.get('direct') === '1',
    size: cols !== null && rows !== null ? { cols, rows } : null,
  };
}

export function createTermUpgradeHandler(options: TermUpgradeOptions): TermUpgradeHandler {
  const { config, registry, logger: log } = options;
  /**
   * Otwarte gniazda per `deviceId` klucza, którym je otwarto, z funkcją, która
   * odcina TO gniazdo synchronicznie.
   */
  const owned = new Map<string, Map<WebSocket, () => void>>();
  const wss = new WebSocketServer({
    noServer: true,
    // Domyślne 100 MB pozwoliłoby zbuforować ramkę, ZANIM zobaczy ją nasz kod.
    maxPayload: TERM_WS_MAX_PAYLOAD_BYTES,
    // Kompresja psuje rachunek `bufferedAmount`, na którym stoi cały backpressure.
    perMessageDeflate: false,
  });

  const deny = (socket: Duplex, reason: string): void => {
    if (!noteIrohRefusal(socket, 'upgrade-refused', reason)) log.info(`term: upgrade refused (${reason})`);
    socket.destroy();
  };

  const attach = (
    ws: WebSocket, id: string, fresh: boolean, size: { cols: number; rows: number } | null,
    owner: string,
  ): void => {
    let alive = true;
    /** Gniazdo odpiętego urządzenia: od tej chwili ani bajt wejścia, ani wyjścia. */
    let revoked = false;
    const client: TermClient = {
      /*
       * Callback `send` odpala się, gdy ramka faktycznie zeszła do gniazda — czyli
       * w jedynym momencie, w którym pauza PTY mogła stać się niepotrzebna. `ws` nie ma
       * zdarzenia `drain`, więc to jest tutaj jedyne wiarygodne miejsce na ponowne sprawdzenie pauzy.
       */
      sendData: (chunk) => {
        if (revoked) return;
        ws.send(chunk, { binary: true }, () => { registry.reviewBackpressure(id); });
      },
      sendEvent: (frame) => {
        if (revoked) return;
        ws.send(JSON.stringify(frame));
      },
      bufferedAmount: () => ws.bufferedAmount,
      terminate: () => { ws.terminate(); },
    };

    /** Odcięcie gniazda odpiętego urządzenia: znacznik i odłączenie NAJPIERW, potem `err` i zamknięcie. */
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      registry.detach(id, client);
      try {
        ws.send(JSON.stringify(errFrame(say('rest.device-revoked'))));
      } catch {
        // Gniazdo mogło już się zamykać — zamknięcie niżej i tak idzie.
      }
      ws.close(CLOSE_POLICY);
      const kill = setTimeout(() => { ws.terminate(); }, TERM_REVOKE_TERMINATE_MS);
      kill.unref();
      ws.once('close', () => { clearTimeout(kill); });
    };

    const sockets = owned.get(owner) ?? new Map<WebSocket, () => void>();
    sockets.set(ws, revoke);
    owned.set(owner, sockets);
    ws.once('close', () => {
      sockets.delete(ws);
      if (sockets.size === 0 && owned.get(owner) === sockets) owned.delete(owner);
    });
    // Klucz sprawdzony przy upgrade'zie, ale gniazdo podpinamy dopiero teraz: urządzenie odpięte w tej
    // chwili nie dostaje terminala ani na jedną ramkę.
    if (options.devices !== undefined && options.devices.get(owner) === undefined) {
      revoke();
      return;
    }

    const attached = registry.attach(id, client, fresh, size);
    if (attached !== 'ok') {
      /*
       * Odmowa ma DWA powody i dwie różne instrukcje — jedno zdanie na oba wysyłało
       * człowieka w złą stronę („otwórz od nowa" nie pomaga, gdy problemem jest sufit).
       * Ramka `err` w obu przypadkach ZATRZYMUJE reconnect klienta (bez niej klient
       * młóciłby spawn w pętli).
       */
      ws.send(JSON.stringify(errFrame(
        attached === 'limit'
          ? say('term.attach-limit')
          : say('term.attach-failed'),
      )));
      ws.close(CLOSE_POLICY);
      return;
    }

    /*
     * `hello` — PIERWSZA ramka tekstowa na gnieździe, które PRZESZŁO attach, i wysyłana
     * dokładnie tutaj: po odmowie (`failed`/`limit`) jej nie ma, więc nigdy nie poprzedza `err`.
     *
     * The value is CONSTANT (the herdr pane is the only backend), so the client does not need it and does NOT
     * read it. The frame stays for an older cached client, for which a missing `hello` means another backend,
     * with xterm scrollback and the finger gesture set up for it.
     */
    ws.send(JSON.stringify({ t: 'hello', backend: 'herdr' }));

    const ping = setInterval(() => {
      if (!alive) {
        // Brak pongu do NASTĘPNEGO pingu = gniazdo półotwarte (zabita apka, zerwany tunel).
        // Bez tego warunek „ostatni WS zamknięty" nigdy by nie padł i PTY żyłoby wiecznie.
        log.info(`term: socket ${id} missed a pong — terminate`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, TERM_PING_MS);
    ping.unref();

    ws.on('pong', () => { alive = true; });

    /*
     * Bufor wklejki należy do GNIAZDA, nie do terminala: drugie urządzenie ma własny, a zerwane
     * gniazdo zabiera swój ze sobą — nowe gniazdo nie dosyła połowy wklejki sprzed zerwania.
     */
    const paste = new PasteAssembler(TERM_MAX_PASTE_BYTES);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Odpięte urządzenie i gniazdo w trakcie zamykania: żadna ramka nie dochodzi do rejestru.
      if (revoked || ws.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        // Jedna reprezentacja wejścia = jedno miejsce sprawdzania limitu (patrz protokół).
        log.info(`term: socket ${id} sent a non-text frame — closing`);
        ws.close(CLOSE_PROTOCOL_ERROR);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        ws.close(CLOSE_PROTOCOL_ERROR);
        return;
      }
      const frame = termClientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        ws.close(CLOSE_PROTOCOL_ERROR);
        return;
      }
      if (frame.data.t === 'rs') {
        registry.resize(id, frame.data.c, frame.data.r);
        return;
      }
      if (frame.data.t === 'sc') {
        // Limit AMPLITUDY egzekwuje ZOD (`termClientFrameSchema`), więc tu nie ma czego
        // przycinać: ramka spoza zakresu nie doszła do tego miejsca. Limit CZĘSTOTLIWOŚCI
        // stoi po drugiej stronie — backend panelowy skleja ramki z okna 16 ms w jedno
        // `terminal.scroll`, żeby seria ramek nie zamieniła się w serię RPC do demona herdr.
        registry.scroll(
          id,
          frame.data.d,
          frame.data.c !== undefined && frame.data.r !== undefined
            ? { col: frame.data.c, row: frame.data.r }
            : null,
        );
        return;
      }
      if (Buffer.byteLength(frame.data.d, 'utf8') > TERM_MAX_INPUT_BYTES) {
        // Wklejkę dzieli klient. Przycięcie wejścia do powłoki byłoby gorsze niż jego brak.
        log.info(`term: socket ${id} sent input over the limit — closing`);
        ws.close(CLOSE_PROTOCOL_ERROR);
        return;
      }
      if (frame.data.t === 'pa') {
        /*
         * Wklejka: do herdr idzie JEDNO `terminal.input` z całością albo nic. Nadmiar
         * ponad sufit NIE kończy się ramką `err` — ta zatrzymałaby automat reconnectu klienta,
         * a za duża wklejka to nie awaria terminala. Log mówi „ile", nigdy „co".
         */
        const step = paste.push(frame.data.d, frame.data.e);
        if (step.kind === 'ready') registry.write(id, step.input);
        else if (step.kind === 'overflow') {
          log.info(
            `term: socket ${id} — ${TERM_PASTE_OVER_CAP_LOG} (${String(step.bytes)} B > `
            + `${String(TERM_MAX_PASTE_BYTES)} B), refused in full`,
          );
        }
        return;
      }
      // Klawisz w środku wklejki: połowa wklejki w powłoce byłaby gorsza niż żadna.
      if (paste.interrupt()) log.info(`term: socket ${id} — ${TERM_PASTE_INTERRUPTED_LOG}, paste refused`);
      registry.write(id, frame.data.d);
    });

    ws.on('close', () => {
      clearInterval(ping);
      registry.detach(id, client);
    });
    ws.on('error', () => {
      clearInterval(ping);
      registry.detach(id, client);
    });
  };

  return {
    handleUpgrade(req, socket, head) {
      if (!config.termEnabled) return deny(socket, 'feature disabled');
      const target = termAttachFromUrl(req.url);
      if (target === null) return deny(socket, 'path outside /api/term/:id');
      const { id, fresh, direct, size } = target;
      const auth = authenticate(req, options.devices);
      if (!auth.ok) {
        if (auth.refusal.kind === 'device-unknown') {
          const outcome = options.limiter?.fail(loginPeer(req), Date.now(), 'device key');
          if (outcome?.logLine !== undefined) log.info(outcome.logLine);
        }
        return deny(socket, auth.refusal.kind === 'missing' ? 'no device key' : auth.refusal.kind);
      }
      const owner = auth.principal.deviceId;
      if (!originAllowed(req, config)) return deny(socket, 'origin not on the allow-list');
      if (direct) {
        /*
         * Gniazdo bez `POST`: odmowa tam, gdzie wyjście zna tylko `POST` (`failed`, uchwyt do
         * przeliczenia, zastany panel lazygita, brak wpisu). Klient odpowiada na nią `POST`
         * i zwykłym gniazdem — dlatego ta bramka NIE obejmuje gniazd bez znacznika (pętla
         * `POST`, powód przy `attachableDirect`).
         */
        const verdict = registry.attachableDirect(id);
        if (verdict !== 'ok') return deny(socket, DIRECT_REFUSAL[verdict]);
      } else if (!registry.has(id)) {
        return deny(socket, 'id not in the registry');
      }
      wss.handleUpgrade(req, socket, head, (ws) => { attach(ws, id, fresh, size, owner); });
    },
    closeOwner(owner) {
      const sockets = owned.get(owner);
      if (sockets === undefined) return 0;
      owned.delete(owner);
      const revokes = [...sockets.values()];
      for (const revoke of revokes) revoke();
      if (revokes.length > 0) log.info(`term: device revoked — sockets closed: ${String(revokes.length)}`);
      return revokes.length;
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
