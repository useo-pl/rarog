/**
 * Protocol contract, terminal area: `/api/term` routes and WebSocket frames.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';
import { sentenceRefSchema } from '../sentences/index.ts';

// ---------------------------------------------------------------------------
// Terminal PTY (faza B planu terminala) — kontrakt `/api/term` i ramek WebSocket
// ---------------------------------------------------------------------------

/*
 * To jest JEDYNE miejsce, w którym kształt ramek terminala jest zapisany — serwer koduje
 * przeciw tym schematom, apka odwzorowuje je w `TerminalFrames.swift`. Terminal stoi POZA
 * herdr: nie ma tu ani allow-listy klawiszy, ani deny-listy tekstu, bo to pełna powłoka
 * użytkownika, a nie kanał do panelu `claude`. Granice tej władzy opisuje `docs/security-model.md`
 * (sekcja „Emergency console").
 */

/**
 * Długość identyfikatora terminala: `sha256(<materiał>)` skrócony do 16 znaków hex.
 *
 * Materiałem jest `realpath(cwd)` dla slotu 1, `realpath(cwd) + NUL + N` dla slotu N ≥ 2
 * i `realpath(cwd) + NUL + <rola>` dla paneli popupowych (`lazygit`, `popup`) — człon należy do WEJŚCIA
 * hasha, nigdy do jego wyniku, więc każdy terminal ma id w tym samym kształcie (`TERM_ID_RE`)
 * i wchodzi w tę samą trasę oraz w ten sam token panelu herdr. Rozdzielaczem jest bajt NUL,
 * bo nie może wystąpić w ścieżce POSIX (powód w całości przy `termIdFor` w `lifecycle.ts`).
 */
export const TERM_ID_LENGTH = 16;

/**
 * Ile terminali (SLOTÓW) wolno mieć JEDNEMU projektowi.
 *
 * Terminal to para `(cwd, slot)`, slot liczony od 1. Sufit jest PER PROJEKT i liczy WPISY
 * rejestru, a nie żywe strumienie — świadomie inaczej niż `RAROG_TERM_MAX`, który liczy żywe
 * PTY w całym Rarogu. Dwie różne miary, bo odpowiadają na dwa różne pytania: „ile tabów
 * w tym projekcie" i „ile procesów naraz ciągnie serwer". Globalny sufit musi być WYŻSZY (`RAROG_TERM_MAX`
 * powyżej domyślnych 4, np. 12), inaczej jeden projekt z kompletem tabów blokowałby terminale wszystkim
 * pozostałym — a dokładają się do niego jeszcze panele popupowe (`lazygit`, `popup`), które slotu nie
 * zajmują, ale żywym strumieniem są.
 */
export const TERM_SLOTS_MAX = 4;

/**
 * Sufit długości `proc` (nazwy procesu na pigułce taba) w znakach.
 *
 * Etykieta ma być JEDNYM SŁOWEM na pigułce szerokości kciuka (`nvim`, `devspace`, `zsh`),
 * a nie ścieżką binarki — dlatego serwer obcina ją u siebie, zamiast liczyć na to, że CSS
 * schowa resztę.
 */
export const TERM_PROC_MAX_LENGTH = 12;

/**
 * Dozwolony kształt `:id` w `GET /api/term/:id` i `DELETE /api/term/:id`.
 *
 * Wzorzec jest wąski celowo: id trafia do stempla panelu herdr (token `rarog-term`) i do
 * argumentów procesu kontrolera. Znak spoza `[0-9a-f]` nie ma tam czego szukać, a jedyną
 * drogą powstania id jest `POST /api/term` (klient nigdy nie podaje `cwd` przy upgrade).
 */
export const TERM_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Sufit JEDNEJ ramki wejścia (`{"t":"in"}` i kawałka wklejki `{"t":"pa"}`) w bajtach UTF-8.
 *
 * Wklejkę dzieli KLIENT; ramka ponad limit to błąd protokołu i zamknięcie WS, nigdy ciche
 * przycięcie — przycięte wejście do powłoki jest gorsze niż jego brak. Serwer WS ma dodatkowo
 * `maxPayload` dwa razy wyższy, żeby limit egzekwował kod, a nie biblioteka.
 */
export const TERM_MAX_INPUT_BYTES = 8 * 1024;

/**
 * Sufit CAŁEJ wklejki (ramki `pa`) w bajtach UTF-8 treści, sumowany po kawałkach.
 *
 * herdr 0.9.3 gubi PO CICHU wejście ponad 1 MiB (`MAX_INPUT_PAYLOAD`), więc Rarog trzyma się
 * połowy. Klient sprawdza sufit PRZED wysyłką i mówi zdaniem; serwer odrzuca nadmiar w całości
 * z wpisem w logu (bez treści), ale BEZ ramki `err` — ta zatrzymuje automat reconnectu klienta.
 * Każdy kawałek `d` podlega dodatkowo {@link TERM_MAX_INPUT_BYTES}, jak ramka `in`.
 */
export const TERM_MAX_PASTE_BYTES = 512 * 1024;

/**
 * ROLA terminala: co siedzi w panelu herdr po drugiej stronie strumienia.
 *
 * `'shell'` to dotychczasowy terminal projektu — para `(cwd, slot)`, pigułka w pasku, pełna
 * powłoka. `'lazygit'` to OSOBNY panel, w którym Rarog wpisuje `exec lazygit` i który front
 * otwiera w popupie (Cmd+G). `'popup'` to TA SAMA konstrukcja bez
 * żadnej komendy startowej: goła powłoka w popupie pod Cmd+F. Rola jest w kontrakcie, a nie
 * tylko po stronie klienta, bo rozstrzyga TRZY rzeczy, o których wie wyłącznie serwer:
 * tożsamość (`termIdFor` z rolą, osobna przestrzeń od slotów), etykietę taba w herdr
 * (`rarog-lazygit` / `rarog-popup`) i koniec życia wpisu (padł strumień → wpis znika
 * z rejestru, zamiast czekać w `failed`).
 *
 * Panel roli popupowej NIE zajmuje slotu projektu (`slot: 0` w odpowiedzi i na liście) —
 * pigułek w pasku dalej jest najwyżej {@link TERM_SLOTS_MAX} — ale liczy się do sufitu żywych
 * strumieni `RAROG_TERM_MAX` w całym Rarogu. `lazygit` i `popup` tego samego katalogu to DWA
 * różne panele (różny materiał id), więc mogą stać obok siebie.
 */
export const TERM_ROLES = ['shell', 'lazygit', 'popup'] as const;
export type TermRole = typeof TERM_ROLES[number];
export const termRoleSchema = z.enum(TERM_ROLES);

/**
 * Czy rola stoi POZA slotami projektu, czyli mieszka w popupie (`lazygit`, `popup`).
 *
 * Jedno pytanie w jednym miejscu, bo od tej samej odpowiedzi zależy pięć różnych decyzji
 * (materiał `termIdFor`, `slot: 0`, zakaz `slot` w ciele POST, odnajdywanie wpisu po katalogu,
 * kasowanie wpisu zamiast `failed`). Rozsypane `role === 'lazygit'` po dodaniu drugiej takiej
 * roli znaczyłyby „lazygit", a nie „poza slotami" — i każde z nich trzeba by znaleźć osobno.
 */
export function isPopupRole(role: TermRole): boolean {
  return role === 'lazygit' || role === 'popup';
}

/**
 * Ciało `POST /api/term`. Idempotentne: ta sama trójka `(realpath(cwd), slot, role)` → to samo
 * `id`.
 *
 * `slot` jest OPCJONALNY i jego brak znaczy `1` — pełna zgodność wsteczna: klient sprzed tej
 * zmiany wysyła samo `{cwd}` i dostaje dokładnie ten terminal, który miał dotąd (id slotu 1 to
 * niezmienione `sha256(realpath(cwd))`). `'next'` znaczy „załóż KOLEJNY": numeru nie wybiera
 * klient, tylko serwer — najniższy wolny, bo tylko on wie, co już stoi w rejestrze.
 *
 * `role` jest opcjonalna i jej brak znaczy `'shell'` (ta sama zgodność wstecz). Przy roli
 * popupowej ({@link isPopupRole}: `lazygit`, `popup`) pole `slot` jest ZABRONIONE, a nie
 * ignorowane: taki panel slotu nie ma, więc ciało z numerem opisywałoby stan, którego serwer
 * nie umie spełnić — a cicho zignorowany numer kazałby klientowi wierzyć, że dostał tab,
 * o który prosił.
 */
export const termOpenBodySchema = z.object({
  cwd: z.string().min(1),
  slot: z.union([
    z.literal('next'),
    z.number().int().min(1).max(TERM_SLOTS_MAX),
  ]).optional(),
  role: termRoleSchema.optional(),
}).refine((body) => !isPopupRole(body.role ?? 'shell') || body.slot === undefined, {
  message: 'Panel w popupie nie ma slotu — nie podawaj `slot` przy roli `lazygit` ani `popup`.',
  path: ['slot'],
});

/**
 * Odpowiedź `POST /api/term` — id, numer slotu, który padł, ORAZ rola.
 *
 * `slot` jest w odpowiedzi, bo przy `slot: 'next'` klient go NIE ZNA: numer wybiera serwer
 * i bez tego pola front musiałby go zgadywać z listy (wyścig z własnym pollingiem). `cwd`
 * dalej nie wraca — to jedyna rzecz, którą klient wysłał sam.
 *
 * `slot: 0` należy WYŁĄCZNIE do paneli popupowych (`lazygit`, `popup`) i znaczy „poza slotami
 * projektu": zakres zaczyna się więc od 0, a nie od 1. Rola wraca w odpowiedzi razem z nim,
 * żeby klient nie musiał
 * wnioskować roli z samego zera.
 */
export const termOpenResponseSchema = z.object({
  id: z.string().regex(TERM_ID_RE),
  slot: z.number().int().min(0).max(TERM_SLOTS_MAX),
  role: termRoleSchema,
});
export type TermOpenResponse = z.infer<typeof termOpenResponseSchema>;

/**
 * Odpowiedź `GET /api/term` — lista terminali dla sidebaru. Tu `cwd` JEST w odpowiedzi
 * (inaczej niż w POST): po restarcie Raroga rejestr odbudowuje adopcja z paneli herdr, więc to
 * serwer, nie klient, wie, do którego projektu należy powłoka. `live` = strumień chodzi teraz;
 * `false` to powłoka czekająca na wejście.
 *
 * `proc` to nazwa procesu na pierwszym planie powłoki (`nvim`, `codex`, `zsh`) — etykieta
 * pigułki taba. **Pusty string znaczy „jeszcze nie wiem", a nie „powłoka bez procesu"**:
 * `GET /api/term` jest SYNCHRONICZNY i oddaje ostatnio znaną wartość z cache'u backendu,
 * a odczyt z herdr rusza w tle dopiero po odpowiedzi. Pierwsza lista po starcie serwera niesie
 * więc `proc: ''` i pigułka pokazuje samo `>_`. Świadomie nie czekamy na herdr w torze GET:
 * p90 odczytu ekranu to ~110 ms RAZY liczba paneli.
 *
 * `role` mówi, czym jest wpis: `'shell'` to tab projektu ze slotem 1…
 * {@link TERM_SLOTS_MAX}, `'lazygit'` i `'popup'` to panele poza slotami, zawsze z `slot: 0`.
 * Bez tego pola front musiałby zgadywać rolę z zera, a pasek pigułek rysowałby wiersz, którego nie umie
 * otworzyć w swoim widoku.
 */
export const termListResponseSchema = z.object({
  terminals: z.array(z.object({
    id: z.string().regex(TERM_ID_RE),
    cwd: z.string().min(1),
    live: z.boolean(),
    slot: z.number().int().min(0).max(TERM_SLOTS_MAX),
    proc: z.string().max(TERM_PROC_MAX_LENGTH),
    role: termRoleSchema,
  })),
});

/**
 * `GET /api/term/:id/history?lines=N` — historia panelu jako ZWYKŁY TEKST.
 *
 * Trasa istnieje z jednego powodu: na telefonie xterm.js nie ma zaznaczania dotykiem
 * (xtermjs/xterm.js#3727), więc dłuższego fragmentu NIE DA SIĘ skopiować z ekranu terminala.
 * Scrollback nie żyje przy tym w xtermie, tylko w PANELU herdr — jedyną drogą do
 * „zaznacz i skopiuj" jest wyjęcie historii tekstem (`pane.read`) i pokazanie jej w zwykłym
 * `<pre>`, gdzie natywna selekcja iOS (uchwyty, lupka) działa za darmo.
 *
 * `truncated` przychodzi wprost z herdr i znaczy „scrollback był dłuższy niż `lines`" —
 * stopka nakładki mówi to zdaniem, zamiast udawać, że widać całość.
 */
export const TERM_HISTORY_DEFAULT_LINES = 1000;

/**
 * Sufit `lines`. Nie jest ostrożnością, tylko ceną transportu: historia jedzie JEDNYM ciałem
 * JSON i ląduje w jednym węźle tekstowym DOM-u, a 5000 wierszy to już ~0,5 MB na telefonie.
 * Wartość ponad sufit jest ŚCINANA (jak `limit` w `/api/resumable/recent`), a nie odrzucana:
 * „za dużo linii" nie jest błędem człowieka, tylko końcem tego, co Rarog umie pokazać.
 */
export const TERM_HISTORY_MAX_LINES = 5000;

/** Odpowiedź `GET /api/term/:id/history`. Treść NIE jest nigdzie logowana ani zapisywana. */
export const termHistoryResponseSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
});
export type TermHistoryResponse = z.infer<typeof termHistoryResponseSchema>;

/**
 * Ramki KLIENT → SERWER: wyłącznie tekstowy JSON.
 *
 * Ramka binarna od klienta jest błędem protokołu (zamknięcie WS), a nie „wejściem w bajtach":
 * jedna reprezentacja wejścia znaczy jedno miejsce do sprawdzenia limitu. W drugą stronę jest
 * odwrotnie — binarne = surowe bajty PTY, tekstowe = zdarzenie (`exit`, `err`).
 */
export const termClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), d: z.string() }),
  z.object({
    t: z.literal('rs'),
    c: z.number().int().min(1).max(1000),
    r: z.number().int().min(1).max(1000),
  }),
  /*
   * Przewinięcie o `d` wierszy (dodatnie = W DÓŁ). Historia powłoki żyje po stronie panelu
   * herdr, a nie w buforze xterma (scrollback klienta = 0), więc palec musi mieć czym poprosić
   * o przewinięcie.
   *
   * Limit jest W ZODZIE, jak przy `rs`: ramka spoza zakresu nie parsuje się i `ws.ts` zamyka
   * gniazdo kodem 1002 istniejącą ścieżką, zamiast przepuszczać do backendu liczbę, którą
   * musiałby przycinać ktoś inny. 200 wierszy to kilka ekranów jednym gestem.
   */
  /*
   * `c`/`r` — komórka POD PALCEM (1-based, jak w `rs`), opcjonalna. Herdr kieruje kółko do
   * panelu aplikacji leżącego pod tą komórką (`terminal.scroll` przyjmuje `column`/`row`) —
   * bez niej lazygit dostaje kółko „znikąd" i diff nie przewija się wcale (zmierzone na żywym
   * panelu: bez współrzędnych ekran stoi, z `column` nad diffem przewija się diff, nad listą — lista).
   * Opcjonalna, bo starszy klient jej nie śle, a ramka bez współrzędnych dalej przewija zwykłą powłokę.
   */
  z.object({
    t: z.literal('sc'),
    d: z.number().int().min(-200).max(200),
    c: z.number().int().min(1).max(1000).optional(),
    r: z.number().int().min(1).max(1000).optional(),
  }),
  /*
   * Kawałek WKLEJKI: `e` = ostatni kawałek. Serwer skleja kawałki jednego gniazda, czyści
   * z treści `ESC[200~`/`ESC[201~`, owija całość i oddaje herdr JEDNO `terminal.input` — herdr
   * koduje je od nowa według trybu programu w panelu (z 2004 owinięte, bez — sam tekst).
   * Zerwane gniazdo albo `in` w środku wklejki wyrzuca bufor, nigdy nie wpisuje połowy.
   */
  z.object({ t: z.literal('pa'), d: z.string(), e: z.boolean() }),
]);
export type TermClientFrame = z.infer<typeof termClientFrameSchema>;

/** Ramki SERWER → KLIENT w postaci tekstowej (binarne niosą surowe bajty PTY). */
export const termServerFrameSchema = z.discriminatedUnion('t', [
  /*
   * PIERWSZA ramka tekstowa na gnieździe, które PRZESZŁO `attach`. Przy odmowie
   * (`failed`/`limit`) nie leci w ogóle, więc nigdy nie poprzedza `err`.
   *
   * `backend` is FIXED (the shell lives in a herdr panel) and today's client does NOT read it — a
   * literal, not a union, because the server has nothing to choose and the schema describes what
   * really goes over the wire. The frame stays for OLDER clients: for them a missing `hello` means
   * "tmux", i.e. xterm scrollback and a finger gesture set up for a backend that no longer exists.
   * A client that does not understand it ignores it like any unknown frame type.
   */
  z.object({ t: z.literal('hello'), backend: z.literal('herdr') }),
  z.object({ t: z.literal('exit') }),
  // `msgRef` — kod zdania `msg`, gdy serwer powiedział je przez `say()`.
  z.object({ t: z.literal('err'), msg: z.string(), msgRef: sentenceRefSchema.optional() }),
]);
export type TermServerFrame = z.infer<typeof termServerFrameSchema>;
