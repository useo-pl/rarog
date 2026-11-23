/**
 * Kontrakt REST — ciała i odpowiedzi tras HTTP, których nie niesie SSE.
 *
 * The shapes stand here as zod schemas, so the native app does not guess them from server code.
 * The golden responses in `shared/fixtures/rest/` are produced by server code
 * (`server/test/rest-fixtures-producenci.test.ts`); the mirror for a client in another language is
 * `shared/test/rest-fixtures.test.ts` and the Swift test `RestFixturesTests` in `RarogContract`.
 *
 * A separate module (`@rarog/shared/rest`), not `protocol.ts`; it also holds the
 * `POST …/messages` body.
 *
 * Schemas describe the SERVER STATE: every field the router sends and nothing more. The client
 * must tolerate unknown keys (`z.object` strips them) and missing optional fields.
 *
 * The native app route contract lives here too: APNs and Live Activity route bodies, token status,
 * `GET /api/version` flags, the Live Activity content state (it travels in the APNs payload, not
 * over REST, but it is the same two-client contract) and a re-export of the terminal REST schemas
 * that stand in `protocol.ts`.
 */
import { z } from 'zod';
import { IROH_ENDPOINT_ID_RE, PAIRING_CODE_RE, irohRelayUrl } from './pairing-link.ts';
import { sentenceRefSchema } from './sentences/index.ts';
import {
  MAX_ANSWER_TEXT_CHARS,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_TEXT_CHARS,
  PUSH_LABEL_MAX_CHARS,
  TERM_ID_RE,
  fileAttachmentSchema,
  imageDataUrlSchema,
  sessionSummarySchema,
  termListResponseSchema,
  transcriptMessageSchema,
} from './protocol.ts';

/*
 * REST terminala dla apki natywnej: schematy istnieją w `protocol.ts`, tu tylko re-eksport — jedno miejsce
 * kontraktu REST dla klienta w innym języku, zero kopii.
 */
export {
  termHistoryResponseSchema,
  termListResponseSchema,
  termOpenBodySchema,
  termOpenResponseSchema,
} from './protocol.ts';
export type { TermHistoryResponse, TermOpenResponse } from './protocol.ts';
export type TermListResponse = z.infer<typeof termListResponseSchema>;

// ---------------------------------------------------------------------------
// Ciała żądań
// ---------------------------------------------------------------------------

/**
 * Wiadomość do sesji (`POST /api/sessions/:id/messages`). `images` to data URL-e PO downscale po
 * stronie klienta — serwer ich nie przetwarza, tylko waliduje limity (max 5 × 1,5 MB, png/jpeg).
 *
 * `files` to DOWOLNE inne załączniki (PDF, log, kod): max 4 × 27 MB data URL-a. Serwer zapisuje
 * je pod ich nazwą w `<cwd>/.rarog-uploads/` i dokleja ŚCIEŻKI do promptu — agent otwiera je
 * `Read`-em. Oba pola są opcjonalne i niezależne: wiadomość może mieć same zdjęcia, same pliki,
 * jedno i drugie albo nic.
 */
export const messageBodySchema = z.object({
  text: z.string().max(MAX_MESSAGE_TEXT_CHARS, 'Wiadomość jest za długa.'),
  images: z.array(imageDataUrlSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
  files: z.array(fileAttachmentSchema).max(MAX_FILES_PER_MESSAGE).optional(),
  /**
   * Idempotencja wysyłki: UUID nadany przez klienta RAZ na wiadomość, ten sam przy
   * każdym „Ponów". Serwer przyjmuje go najwyżej raz w oknie 24 h — powtórka oddaje 202
   * `replayed: true` bez drugiej wysyłki, ten sam id z inną treścią to 409
   * `client-id-conflict`. Brak pola = wysyłka bez idempotencji. Pełna semantyka i granice
   * gwarancji: `docs/implementation-spec.md`, „Idempotent send".
   */
  clientMessageId: z.uuid().optional(),
  /**
   * Klient umie czekać na echo odroczone: prompt wysłany w trakcie pracy agenta staje
   * w transkrypcie dopiero, gdy CLI go weźmie, a 202 niesie wtedy `queued: true`. Ma sens tylko
   * z `clientMessageId`. Brak pola = echo od razu; starszy serwer pole odcina.
   */
  queueAware: z.literal(true).optional(),
  /**
   * Who sends: `voice-agent` = the voice agent across sessions, after the owner's word. The audit entry `prompt` of the
   * send records it (`sender`). Another value is a 400. Absent = a message as today. Only together with
   * `expectedConversation`: one without the other is a 400.
   */
  source: z.literal('voice-agent').optional(),
  /**
   * The token of the engine conversation the sender read (`conversation` of `GET /api/companion/sessions` and of the
   * turns route). Another conversation than the one the session writes and its pane runs at the moment of sending is a
   * 409 (`session.conversation-changed`) and nothing reaches the pane. Only together with `source`.
   *
   * With `RAROG_COMPANION_SESSIONS` off (or the voice agent off), a body that carries both fields is a 503 like the other
   * routes of the mode across sessions (`docs/companion.md`, "Sending from the conversation").
   */
  expectedConversation: z.string().min(1).max(64).optional(),
}).refine((body) => (body.source === undefined) === (body.expectedConversation === undefined), {
  message: 'source and expectedConversation come both or neither',
});
export type MessageBody = z.infer<typeof messageBodySchema>;
/** The sender of a message (`MessageBody.source`). */
export type MessageSource = NonNullable<MessageBody['source']>;

/**
 * `POST /api/sessions/:id/seen`. Without fields (`{}`, as the app sends it) a human viewed the result. `by:
 * "voice-agent"` with `stateSince` and `conversation` is the voice agent across sessions picking up the result it
 * read: `stateSince` and `conversation` (the token of `GET /api/companion/sessions` and of the turns route) come from
 * that read. The server accepts it only for a result standing in `waiting-input` with no decision card over it, whose
 * `stateSince` is the session's current one, in the engine conversation the session writes and its pane runs;
 * otherwise a 409 (`session.seen-result-changed`) and nothing changes. All three or none: a part is a 400, as is
 * another value of `by`.
 *
 * With `RAROG_COMPANION_SESSIONS` off (or the voice agent off), a body with the three fields is a 503 like the other
 * routes of the mode across sessions (`docs/companion.md`, "Picking up a result").
 */
export const seenBodySchema = z.object({
  by: z.literal('voice-agent').optional(),
  stateSince: z.string().min(1).max(64).optional(),
  conversation: z.string().min(1).max(64).optional(),
}).refine((body) => {
  const given = [body.by, body.stateSince, body.conversation].filter((field) => field !== undefined).length;
  return given === 0 || given === 3;
}, {
  message: 'by, stateSince and conversation come all three or none',
});
export type SeenBody = z.infer<typeof seenBodySchema>;
/** Who picked up a result when it was not a human (`SeenBody.by`, `SessionSummary.seenBy`). */
export type SeenBy = NonNullable<SeenBody['by']>;

/**
 * Sufit JEDNEJ notatki do odpowiedzi, w jednostkach UTF-16 (`string.length`): sufit Raroga,
 * niezmierzony w CLI. MUSI zgadzać się z `ANSWER_NOTE_MAX_CHARS` w `scripts/hooks/rarog-pending.mjs` i z polem
 * notatki w apce (`maxNoteUnits`).
 */
export const MAX_ANSWER_NOTE_CHARS = 8_192;

/**
 * Sufit SUMY odpowiedzi (wartości po sklejeniu przecinkiem) i notatek jednego żądania, w jednostkach
 * UTF-16: sufit Raroga, niezmierzony w CLI. Pilnowany w managerze i w hooku.
 */
export const MAX_ANSWERS_TOTAL_CHARS = 32_768;

/**
 * Odpowiedź na kartę pytania (`POST /api/sessions/:id/answers/:qId`): per pytanie tablica wartości
 * (jednokrotny wybór = jedna).
 *
 * `notes` — RÓWNOLEGŁE do `answers`: notatka człowieka do wybranej opcji pytania
 * o tym samym indeksie albo `null`. Wolno ją wyłącznie tam, gdzie karta niesie `notes: true`
 * (kanał hooka, jednokrotny wybór z podglądem, CLI ≥ 2.1.288) i przy JEDNEJ opcji z listy —
 * resztę reguł egzekwuje manager (400). Brak pola = odpowiedź bez notatek.
 */
export const answersBodySchema = z.object({
  answers: z.array(z.array(z.string().max(MAX_ANSWER_TEXT_CHARS, 'Odpowiedź jest za długa.'))),
  notes: z.array(
    z.string().max(MAX_ANSWER_NOTE_CHARS, 'Notatka jest za długa.').nullable(),
  ).optional(),
});
export type AnswersBody = z.infer<typeof answersBodySchema>;

/**
 * Kod błędu 409 przy `clientMessageId`, który przyszedł już z INNĄ treścią. Osobny od
 * `bad-state`, bo znaczy co innego: nie „sesja zajęta, spróbuj później", tylko „ten identyfikator
 * jest zużyty" — ponowienie z tym samym id nigdy nie przejdzie, klient potrzebuje nowego.
 */
export const CLIENT_ID_CONFLICT_ERROR = 'client-id-conflict';

/**
 * Kod błędu 400 bramki startu z ultracode: zainstalowany Claude Code jest za stary albo serwer nie zna jego
 * wersji, albo żądanie podaje poziom inny niż `xhigh`. Osobny od `bad-request`, bo odmowa nie mówi nic o katalogu:
 * klient pokazuje zdanie `message` przy ustawieniach startu, a nie przy polu ścieżki.
 */
export const ULTRACODE_REFUSED_ERROR = 'ultracode-refused';

/**
 * Refusals of `POST /api/fs/mkdir` beside the codes of the listing (`path-not-allowed`, `not-found`). 409: this server
 * creates no directories (the demo, or `RAROG_HERDR_LAUNCH` or `RAROG_HERDR_SEND` off).
 */
export const MKDIR_DISABLED_ERROR = 'mkdir-disabled';
/** 429: another directory is being created; nothing was created. */
export const MKDIR_BUSY_ERROR = 'mkdir-busy';
/** 400: the name breaks the name rule or names a folder the listing hides; nothing was created. */
export const DIR_NAME_INVALID_ERROR = 'dir-name-invalid';
/** 409: something already exists under that name (a directory, a file or a symlink); nothing was overwritten. */
export const DIR_EXISTS_ERROR = 'dir-exists';

// ---------------------------------------------------------------------------
// Odpowiedzi
// ---------------------------------------------------------------------------

/**
 * Ciało każdego błędu API (4xx/5xx): `error` to kod (`bad-request`, `bad-state`,
 * `client-id-conflict`, `usage-unavailable`…), `message` — gotowe zdanie do pokazania wprost (po angielsku dla zdań
 * z rejestru), `messageRef` — jego kod i argumenty, gdy serwer powiedział je przez `say()`: apka tłumaczy kod,
 * a nieznany pokazuje `message`. Zdanie jeszcze bez kodu przychodzi samym `message`.
 *
 * Wyjątki niosą pola PONAD tę parę i schemat je odcina: odmowa decyzji 422 dokłada `reason`
 * (`decisionRefusedBodySchema` w `protocol.ts`), konflikt notatek 409 — `current`. Lista kodów
 * NIE jest zamknięta: rośnie razem z serwerem, a klient decyduje po statusie HTTP i paru znanych
 * kodach, nieznany kod pokazuje zdaniem `message`.
 */
export const errorBodySchema = z.object({
  error: z.string().min(1),
  message: z.string(),
  messageRef: sentenceRefSchema.optional(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Potwierdzenie bez treści: `close`, `seen` (200) i `focus` (202). */
export const okAckSchema = z.object({ ok: z.literal(true) });
export type OkAck = z.infer<typeof okAckSchema>;

/**
 * 202 na `POST /api/sessions/:id/messages`. Bez `clientMessageId` w ciele: samo `{ok: true}`.
 * Z nim: identyfikator wraca, a powtórka już przyjętej wiadomości dokłada `replayed: true`
 * (nic nie poszło drugi raz i echa tej odpowiedzi nie będzie).
 */
export const messageAcceptedSchema = z.object({
  ok: z.literal(true),
  clientMessageId: z.string().optional(),
  replayed: z.literal(true).optional(),
  /**
   * Echo odroczone: wiadomość czeka u serwera, aż CLI weźmie prompt — echo przyjdzie
   * dopiero wtedy, więc klient trzyma swój wpis bez progu „Nie potwierdzono” po 15 s. Także przy
   * `replayed`, gdy pierwsze przyjęcie wciąż czeka.
   */
  queued: z.literal(true).optional(),
});
export type MessageAccepted = z.infer<typeof messageAcceptedSchema>;

/**
 * Serwer iroh: EndpointId i relay w postaci kanonicznej — te same wartości co pola `k=` i `r=` linku
 * parowania (`pairing-link.ts`). Niesie go `iroh` w `PairResponse.server` i w `GET /api/version`; serwer bez
 * nasłuchu iroh pisze `null` (nie pomija klucza), a klient czyta brak pola (serwer sprzed pola) jak `null`.
 */
export const serverIrohSchema = z.object({
  endpointId: z.string().regex(IROH_ENDPOINT_ID_RE),
  relay: z.string().refine((relay) => irohRelayUrl(relay) === relay, 'relay: postać kanoniczna `irohRelayUrl`'),
});
export type ServerIroh = z.infer<typeof serverIrohSchema>;

/**
 * System maszyny serwera (`serverSystem` w `server/src/version.ts`): `macos` = `darwin`, `linux` = `linux`,
 * `other` = każdy inny `process.platform`.
 */
export const SERVER_SYSTEMS = ['macos', 'linux', 'other'] as const;
export type ServerSystem = typeof SERVER_SYSTEMS[number];

/**
 * `GET /api/version` — sonda poświadczenia przy starcie i flagi możliwości serwera (klient wie,
 * czego nie pokazywać, zanim ktoś stuknie). `tailnet`, `hookSeenAgo` i `iroh` są zawsze
 * obecne, `null` = „nie wiem" albo „nie ma" (serwer pisze `null`, nie pomija klucza).
 */
export const versionResponseSchema = z.object({
  version: z.string(),
  protocolVersion: z.number().int(),
  serverStartId: z.string(),
  voiceEnabled: z.boolean(),
  termEnabled: z.boolean(),
  /** Nazwa tailnetu serwera. */
  tailnet: z.string().nullable(),
  /** Sekundy od ostatniego odpalenia hooka treści — diagnostyka operatora (`curl`). */
  hookSeenAgo: z.number().nullable(),
  /**
   * Ten sam wiek per plik wejściowy kopii hooka (`{"<plik>.mjs": sekundy}`). Pole opcjonalne: serwer pomija je,
   * gdy hook nie zostawił znacznika per plik; klient go nie potrzebuje.
   */
  hookSeenAgoByFile: z.record(z.string(), z.number()).optional(),
  notesEnabled: z.boolean(),
  /**
   * The voice agent works (`docs/companion.md`): `RAROG_COMPANION=1`, an OpenAI key and a Soniox key from the
   * EU region on the server, outside demo mode. The server always writes it; the app reads a missing field (an older
   * server) as `false`.
   */
  companionEnabled: z.boolean(),
  /**
   * The voice agent speaks with the Soniox voice (`POST /api/companion/speech-token` answers). The voice agent has no
   * other voice, so the server writes it equal to `companionEnabled`; the app reads a missing field (an older server)
   * as `false`.
   */
  companionSpeech: z.boolean(),
  /**
   * The voice agent's mode across sessions works (`docs/companion.md`, "Turns route"): `companionEnabled` and
   * `RAROG_COMPANION_SESSIONS=1`. Present only as `true`; a missing field means off.
   */
  companionSessions: z.literal(true).optional(),
  /**
   * Kanał APNs apki natywnej istnieje. `false` = apka nie proponuje włączenia
   * powiadomień i nie pyta o status tokenu.
   */
  apnsEnabled: z.boolean(),
  /**
   * Możliwości serwera po nazwie (`SERVER_CAPABILITIES` w `server/src/version.ts`).
   * Pole addytywne: serwer pisze je zawsze, klient czyta brak (serwer sprzed pola) jako pustą listę,
   * a nieznaną nazwę pomija.
   */
  capabilities: z.array(z.string()),
  /**
   * System maszyny serwera ({@link SERVER_SYSTEMS}): z niego apka bierze słowo maszyny („Mac” na macOS, „VPS”
   * na Linuksie). Pole addytywne: serwer pisze je zawsze, klient czyta brak (serwer sprzed pola) jako „nie wiem”.
   */
  system: z.enum(SERVER_SYSTEMS),
  /** Serwer iroh ({@link serverIrohSchema}); `null` = serwer bez nasłuchu iroh. */
  iroh: serverIrohSchema.nullable(),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

/** Okno limitu planu: procent zużycia (wartość ze źródła) i koniec okna, gdy źródło go podało. */
export const usageWindowSchema = z.object({
  percent: z.number(),
  resetsAt: z.string().optional(),
});

/**
 * `GET /api/usage` (200) — limity planu Claude z Maca. 503 `usage-unavailable` niesie
 * {@link errorBodySchema}. Jedynym źródłem serwera jest pasek statusu Claude Code: odpowiedź
 * ma `source: 'cli'` i `fetchedAt` = chwila zrzutu, a `stale: true` WYŁĄCZNIE wtedy, gdy zrzut jest
 * starszy niż 15 min. Tryb demo podaje stałe liczby bez `source`. Kształt producenta: `PlanUsage`
 * w `server/src/usage.ts`.
 *
 * Ten sam schemat niesie `GET /api/usage/details`: odczyt limitów, który Claude Code
 * zapisuje sam w `~/.claude.json` — 5 h, tydzień i `weeklyModel` z WŁASNĄ chwilą odczytu w `fetchedAt`,
 * bez `source`; `{}` = odczytu nie ma.
 */
export const planUsageSchema = z.object({
  fiveHour: usageWindowSchema.optional(),
  weekly: usageWindowSchema.optional(),
  /**
   * Tygodniowy limit per model. `GET /api/usage` go nie wysyła (pasek statusu go nie niesie);
   * niesie go `GET /api/usage/details` i stałe liczby trybu demo.
   */
  weeklyModel: usageWindowSchema.extend({ model: z.string().optional() }).optional(),
  /** E-mail konta, którego dotyczą liczby (`~/.claude.json` na Macu). */
  account: z.string().optional(),
  stale: z.boolean().optional(),
  fetchedAt: z.string().optional(),
  source: z.literal('cli').optional(),
});
export type PlanUsageResponse = z.infer<typeof planUsageSchema>;

/** `POST /api/sessions/:id/resume` (200): nowy panel, ta sama karta. */
export const resumeResponseSchema = z.object({
  sessionId: z.string(),
  session: sessionSummarySchema,
});
export type ResumeResponse = z.infer<typeof resumeResponseSchema>;

/**
 * Ciało `POST /api/sessions/:id/restart`. Puste (albo bez ciała) = restart na nowszym Claude Code.
 * `resend` = „Uruchom ponownie i wyślij” pod notką blokady: oba pola z `SessionSummary.promptBlocked`,
 * `seq` i `id` (sam `seq` po restarcie sesji wskazałby nową notkę o tym samym numerze). Serwer uruchamia
 * sesję ponownie także bez aktualizacji i wysyła zablokowany prompt do nowego procesu RAZ. Tekstu w ciele
 * nie ma — bierze go serwer ze swojego pierścienia wysyłek, a nieznane klucze odcina schemat.
 */
export const restartBodySchema = z.object({
  resend: z.object({ seq: z.number().int(), id: z.string() }).optional(),
}).optional();
export type RestartBody = z.infer<typeof restartBodySchema>;

/** `POST /api/sessions/:id/restart` (202): `/exit` poszedł, dalszy przebieg jedzie po SSE. */
export const restartResponseSchema = z.object({ sessionId: z.string() });
export type RestartResponse = z.infer<typeof restartResponseSchema>;

/**
 * Body of `POST /api/sessions/:id/queue/take-back`: a UUID the app assigns once per take-back and sends unchanged with
 * every retry; a retry gets the result of the first take-back (`docs/implementation-spec.md`, "Queue take-back").
 */
export const queueTakeBackBodySchema = z.object({ operationId: z.uuid() });
export type QueueTakeBackBody = z.infer<typeof queueTakeBackBodySchema>;

/**
 * 200 of `POST /api/sessions/:id/queue/take-back`: the prompts that left the queues, in queue order (the CLI queue
 * first, then the server's own), one per item. `clientMessageId` marks a message from the app whose echo the server
 * held; a prompt typed at the Mac and a message pasted onto a draft at the desk come without it. An empty list: nothing
 * was queued. `incomplete: true`: part of the CLI queue stayed with Claude Code.
 */
export const queueTakeBackResponseSchema = z.object({
  items: z.array(z.object({ text: z.string(), clientMessageId: z.string().optional() })),
  incomplete: z.literal(true).optional(),
});
export type QueueTakeBackResponse = z.infer<typeof queueTakeBackResponseSchema>;

// ---------------------------------------------------------------------------
// APNs i Live Activity apki natywnej
// ---------------------------------------------------------------------------

/*
 * Trasy: `POST /api/push/apns` (rejestracja tokenu urządzenia), `POST /api/push/apns/unregister`,
 * `POST /api/push/apns/status`, `POST /api/push/live-activity` (token aktywności),
 * `POST /api/push/live-activity/end`. Wszystkie za kluczem urządzenia i bramką Origin. Bez kanału APNs
 * (brak kompletu `RAROG_APNS_*` albo `RAROG_PUSH=0`) `status` mówi `enabled: false`, reszta to
 * 204 no-op po walidacji ciała — nigdy 404.
 *
 * Token urządzenia to ADRES, pod który da się wysłać push — nie trafia do logu ani do query
 * (dlatego status idzie POST-em: logi Caddy notują ścieżkę z zapytaniem).
 */

/**
 * Token APNs (urządzenia i aktywności) jako hex — tak apka zapisuje `Data` z systemu. Dziś
 * 32 bajty (64 znaki); Apple nie obiecuje długości, więc zakres jest szeroki, a wielkość liter
 * dowolna.
 */
export const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;
const apnsTokenSchema = z.string().regex(APNS_TOKEN_RE);

/**
 * `aps-environment` z profilu podpisu apki: `development` = sandbox APNs (build kablem i link),
 * `production` = TestFlight/App Store. Serwer wybiera po nim host APNs.
 */
export const APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = typeof APNS_ENVIRONMENTS[number];

/**
 * Bundle id apki w kształcie, jaki przyjmuje `apns-topic`: segmenty `A-Za-z0-9-` rozdzielone
 * kropkami, co najmniej dwa. Ta sama reguła waliduje `RAROG_APNS_TOPIC` (`server/src/config.ts`)
 * i pole `topic` rejestracji apki — jedna definicja, bo oba końce muszą się zgodzić co do wartości.
 */
export const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Id aktywności z ActivityKit (`Activity.id`, dziś UUID) — sufit z zapasem. */
export const LIVE_ACTIVITY_ID_MAX_CHARS = 128;
const liveActivityIdSchema = z.string().min(1).max(LIVE_ACTIVITY_ID_MAX_CHARS);

/**
 * `POST /api/push/apns` → 204. Upsert tokenu urządzenia przy każdym starcie apki i powrocie
 * z tła. `alerts` = stan zgody systemowej na powiadomienia: `false` zostawia wpis dla Live
 * Activity, ale banerów do niego nie ma. `label` to nazwa urządzenia (`iPad·Rarog`) — nigdy do logu.
 * `test: true` = po zapisie push próbny do tego tokenu (dławik per token; 429 nie cofa zapisu).
 *
 * `topic` = bundle id apki, która rejestruje token (temat APNs, pod którym token przyjmuje pushe).
 * Musi równać się tematowi serwera (`RAROG_APNS_TOPIC`), inaczej 400 {@link APNS_TOPIC_MISMATCH_ERROR}
 * i nic się nie zapisuje; brak pola daje to samo 400 (w schemacie pole zostaje opcjonalne, rozstrzyga trasa).
 * Rejestracja wymaga klucza urządzenia (bez niego bramka routera odpowiada 401).
 *
 * `pushFormats` = formaty ładunku banera, które apka umie czytać (`3` = treść szyfrowana, którą
 * odszyfruje jej NSE). Serwer zapisuje deklarację w wpisie TEJ rejestracji, jak `topic`: brak pola albo brak 3 = wpis
 * bez banerów (serwer wysyła wyłącznie format 3).
 *
 * `locKeys: true` = apka ma w katalogu klucze lokalizacji pushy (`push.placeholder.*`, `push.chime.*`): serwer zapisuje
 * deklarację w wpisie TEJ rejestracji i wysyła mu tekst zastępczy banera i dzwonek kafla jako klucze zamiast
 * polskich literałów. Brak pola albo `false` = wpis bez deklaracji (literały); wartość inna niż boolean to 400.
 */
export const apnsRegisterBodySchema = z.object({
  token: apnsTokenSchema,
  environment: z.enum(APNS_ENVIRONMENTS),
  label: z.string().max(PUSH_LABEL_MAX_CHARS),
  alerts: z.boolean(),
  test: z.boolean().optional(),
  topic: z.string().regex(BUNDLE_ID_RE).optional(),
  pushFormats: z.array(z.number().int()).max(8).optional(),
  locKeys: z.boolean().optional(),
});
export type ApnsRegisterBody = z.infer<typeof apnsRegisterBodySchema>;

/**
 * Kod błędu 400 na `POST /api/push/apns`, gdy apka deklaruje `topic` inny niż temat serwera
 * (`RAROG_APNS_TOPIC`). Token takiej apki przyjmuje pushe tylko pod jej tematem, a serwer wysyła pod
 * swoim — wpis od razu skończyłby się `DeviceTokenNotForTopic`. Bez kanału APNs trasa zostaje 204.
 */
export const APNS_TOPIC_MISMATCH_ERROR = 'topic-mismatch';

/** `POST /api/push/apns/unregister` → 204, idempotentnie (także nieznany token). */
export const apnsUnregisterBodySchema = z.object({ token: apnsTokenSchema });

/** `POST /api/push/apns/status` — ciało niesie token, żeby nie stał w query. */
export const apnsStatusBodySchema = z.object({ token: apnsTokenSchema });

/**
 * Przyczyny degradacji tokenu, które serwer umie nazwać (przekaźnik push):
 * - `pass-missing` — wpis nie ma czym wysłać: brak ważnej przepustki przekaźnika i brak klucza APNs na Macu
 *   (zamówienie przepustki padło albo czeka na ponowienie; wpis apki sprzed pola `topic` przepustki nie dostaje);
 * - `env-mismatch` — przekaźnik odmówił przepustki, bo Apple nie zna tokenu w zgłoszonym środowisku
 *   (`BadDeviceToken` dla tokenu, który nigdy nie dostał 200): build apki ma inne `aps-environment`, niż zgłosił.
 */
export const APNS_DEGRADED_REASONS = ['pass-missing', 'env-mismatch'] as const;
export type ApnsDegradedReason = typeof APNS_DEGRADED_REASONS[number];

/**
 * Odpowiedź `POST /api/push/apns/status` (200). `enabled` = kanał APNs istnieje; `registered`
 * = serwer zna ten token; `alerts` = zapisany stan zgody tego wpisu (`false`, gdy nieznany);
 * `degradedSince` = od kiedy dostawy do TEGO tokenu nie dochodzą (ISO), `null` = zdrowy. Pole
 * jest wartością, nie brakiem: „zdrowy" to jawne `null`, a nie ramka bez treści.
 *
 * `degradedReason` (addytywne) — przyczyna degradacji, gdy serwer ją zna ({@link APNS_DEGRADED_REASONS});
 * brak pola = przyczyna ogólna albo zdrowy token. Stoi zawsze RAZEM z `degradedSince`, więc apka sprzed pola
 * pokazuje przy niej zwykły baner degradacji. Klient czyta nieznaną wartość jak brak pola.
 */
export const apnsStatusResponseSchema = z.object({
  enabled: z.boolean(),
  registered: z.boolean(),
  alerts: z.boolean(),
  degradedSince: z.string().nullable(),
  degradedReason: z.enum(APNS_DEGRADED_REASONS).optional(),
});
export type ApnsStatusResponse = z.infer<typeof apnsStatusResponseSchema>;

/**
 * `POST /api/push/live-activity` → 204. Token aktualizacji aktywności (`pushTokenUpdates`)
 * przypięty do urządzenia. Nowy `activityId` zastępuje poprzednią aktywność, ten sam id
 * z nowym tokenem to rotacja tokenu. Nieznane urządzenie przy kanale APNs → 409
 * {@link APNS_DEVICE_UNKNOWN_ERROR}.
 */
export const liveActivityRegisterBodySchema = z.object({
  deviceToken: apnsTokenSchema,
  activityId: liveActivityIdSchema,
  updateToken: apnsTokenSchema,
});

/**
 * Kod błędu 409 na `POST /api/push/live-activity`, gdy serwer z kanałem APNs nie zna tokenu
 * URZĄDZENIA z ciała. Środowisko APNs aktywności bierze się z wpisu urządzenia, więc apka
 * rejestruje najpierw urządzenie (`POST /api/push/apns`), potem ponawia token aktywności — inaczej
 * aktywność żyłaby bez ani jednej aktualizacji z serwera. Bez kanału APNs trasa zostaje 204.
 */
export const APNS_DEVICE_UNKNOWN_ERROR = 'apns-device-unknown';

/**
 * `POST /api/push/live-activity/end` → 204. `activityId` jest WYMAGANY: spóźnione „zakończ"
 * starej aktywności nie może zamknąć nowej, więc serwer ignoruje id, które nie pasuje.
 */
export const liveActivityEndBodySchema = z.object({
  deviceToken: apnsTokenSchema,
  activityId: liveActivityIdSchema,
});

/**
 * Sekundy epoki Unix, liczba całkowita. Żadnych dat ISO ani `Date` po stronie Swift: ActivityKit
 * dekoduje stan domyślnym `JSONDecoder`, który czyta `Date` jako sekundy od 2001 roku.
 */
const epochSecondsSchema = z.number().int().nonnegative();

/**
 * Sufit łańcucha w stanie kafla (projekt, nazwa przebiegu, tytuł fazy). Z nim limit 4 KB ładunku
 * Live Activity jest własnością kontraktu, a nie deklaracją: dwa przebiegi po trzy łańcuchy po
 * 60 znaków (do 240 B w UTF-8) i 12 segmentów mieszczą się z dużym zapasem.
 */
export const LIVE_ACTIVITY_TEXT_MAX = 60;
/** Najwięcej przebiegów workflow na kaflu; reszta to sama liczba (`moreWorkflows`). */
export const LIVE_ACTIVITY_WORKFLOWS_MAX = 2;
/** Najwięcej segmentów paska jednego przebiegu — więcej faz = jeden segment całości. */
export const LIVE_ACTIVITY_SEGMENTS_MAX = 12;

/** Procent kafla: całość 0–100 (limity planu, obciążenie Maca, wypełnienie segmentu). */
const percentSchema = z.number().int().min(0).max(100);

/**
 * Sesja wiodąca — WYŁĄCZNIE cel tapnięcia w aktywność (v2: kafel jej nie nazywa). Reguła: najdłużej
 * czekająca, a bez czekających najdłużej pracująca. `termId` = wpis Codexa w terminalu Raroga:
 * tap prowadzi wtedy do terminala, jak baner APNs (`rarog.termId`).
 */
export const liveActivityTopSchema = z.object({
  sessionId: z.string().min(1),
  termId: z.string().regex(TERM_ID_RE).optional(),
});

/** Bieżąca faza przebiegu z PLANEM faz: „faza `index`/`count` `title`" (numer od 1). */
export const liveActivityPhaseSchema = z.object({
  index: z.number().int().min(1),
  count: z.number().int().min(1).max(LIVE_ACTIVITY_SEGMENTS_MAX),
  /** Pusty, gdy faza nie ma tytułu — wtedy copy kończy się na numerze. */
  title: z.string().max(LIVE_ACTIVITY_TEXT_MAX),
}).refine((phase) => phase.index <= phase.count, { message: 'numer fazy większy niż liczba faz' });

/**
 * Stan fazy planu na pasku kafla: `pending` = żaden agent fazy nie ruszył,
 * `running` = ktoś w niej jeszcze pracuje, `done` = wszyscy, którzy ruszyli, skończyli (porażka liczy się
 * jak skończenie). Regułę liczy serwer (`server/src/notify/live-activity-state.ts`).
 */
export const liveActivityPhaseStateSchema = z.enum(['pending', 'running', 'done']);

/**
 * Jeden przebieg workflow na kaflu (do {@link LIVE_ACTIVITY_WORKFLOWS_MAX}). `sessionId` = sesja, która go
 * puściła; `name` = nazwa skryptu (`workflowName`), nigdy opis; `agents`/`done` = agenci przebiegu, którzy
 * ruszyli i skończyli. `segments` = wypełnienie każdej fazy w procentach, w kolejności skryptu — przy planie
 * tyle, ile faz; bez planu (albo przy więcej niż {@link LIVE_ACTIVITY_SEGMENTS_MAX} fazach) jeden segment
 * całości i bez `phase`. `states` = stan każdej fazy, ta sama długość i kolejność co `segments`; stoi
 * WYŁĄCZNIE przy `phase`, bo jeden pełny segment „w pracy” czytałby się jak 100 %.
 */
export const liveActivityWorkflowSchema = z.object({
  sessionId: z.string().min(1),
  project: z.string().min(1).max(LIVE_ACTIVITY_TEXT_MAX),
  name: z.string().min(1).max(LIVE_ACTIVITY_TEXT_MAX),
  agents: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  phase: liveActivityPhaseSchema.optional(),
  segments: z.array(percentSchema).min(1).max(LIVE_ACTIVITY_SEGMENTS_MAX),
  states: z.array(liveActivityPhaseStateSchema).optional(),
})
  .refine((workflow) => workflow.done <= workflow.agents, { message: 'skończonych więcej niż agentów' })
  .refine(
    (workflow) => workflow.phase === undefined || workflow.segments.length === workflow.phase.count,
    { message: 'segment na każdą fazę planu' },
  )
  .refine(
    (workflow) => workflow.states === undefined
      || (workflow.phase !== undefined && workflow.states.length === workflow.segments.length),
    { message: 'stan faz tylko przy planie faz, po jednym na segment' },
  );

/** Limity planu Claude w procentach (okno 5 h i tydzień); brak pola = brak żywego okna. */
export const liveActivityLimitsSchema = z.object({
  fiveHour: percentSchema.optional(),
  weekly: percentSchema.optional(),
});

/**
 * Obciążenie Maca w procentach ZAJĘTYCH, zaokrąglone do 5 (`server/src/mac-stats.ts`): CPU = średnia
 * z minuty, RAM = presja pamięci, dysk = zajęte jak `df`. Brak pola = brak odczytu. Ten sam kształt
 * jest odpowiedzią `GET /api/mac` (200) — stopka listy apki natywnej i kafel czytają jeden próbnik.
 */
export const liveActivityMacSchema = z.object({
  cpu: percentSchema.optional(),
  ram: percentSchema.optional(),
  disk: percentSchema.optional(),
});

/**
 * Stan treści JEDNEJ zbiorczej Live Activity urządzenia (`aps.content-state` w ładunku APNs
 * i `ContentState` po stronie ActivityKit). Wisi na ekranie blokady do 8 h, więc kształt NIE MA
 * pól na treść: ani tekstu pytania (`waitingFor.text`), ani `activity.summary`, ani `lastSummary`,
 * ani komendy, opisu przebiegu, narzędzia zgody czy etykiety sesji — prywatność wymusza schemat,
 * nie dobra wola producenta (pokazuje, ile czeka, bez informacji na co).
 *
 * `waiting` = sesje stojące na decyzji (zgoda, pytanie), `working` = sesje w pracy, `finished` = sesje
 * po turze z nieodebranym wynikiem. `top` brak = „nic nie czeka i nic nie
 * pracuje" (tap otwiera listę). `workflows` brak = żaden przebieg z rozkładem. `updatedEpoch` = chwila
 * wyliczenia stanu; producent nie porównuje go przy wykrywaniu zmiany treści (ani `mac`, który jedzie
 * wyłącznie z inną zmianą albo z heartbeatem).
 */
export const liveActivityContentStateSchema = z.object({
  waiting: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
  finished: z.number().int().nonnegative(),
  top: liveActivityTopSchema.optional(),
  workflows: z.array(liveActivityWorkflowSchema).min(1).max(LIVE_ACTIVITY_WORKFLOWS_MAX).optional(),
  moreWorkflows: z.number().int().min(1).optional(),
  limits: liveActivityLimitsSchema.optional(),
  mac: liveActivityMacSchema.optional(),
  updatedEpoch: epochSecondsSchema,
});
export type LiveActivityContentState = z.infer<typeof liveActivityContentStateSchema>;

// ---------------------------------------------------------------------------
// Tożsamość urządzeń i parowanie kodem
// ---------------------------------------------------------------------------

/*
 * Trasy: `POST /api/pair` (publiczna — kod JEST poświadczeniem), `POST /api/pairings`, `GET /api/devices`,
 * `GET /api/devices/me` i `POST /api/devices/forget` (tylko klient z kluczem urządzenia).
 * `DELETE /api/pairings` (device key, no body) cancels the device's own unused code: 204 without a body, so it has no
 * schema here and no golden file, as `forget`.
 * Klucz urządzenia jedzie nagłówkiem `Authorization: Rarog-Device <deviceId>.<secret>` w REST, SSE
 * i upgrade'zie WebSocket terminala; bramka `Origin` dla mutacji zostaje bez zmian. Trasy `/api/admin/*`
 * istnieją WYŁĄCZNIE na gnieździe Unix `<dataDir>/run/admin.sock` i nie należą do tego kontraktu (CLI
 * `rarog`, nie apka). Protokół: `docs/implementation-spec.md`, „Device keys and pairing”.
 */

/*
 * Wersja parowania (`PAIR_PROTOCOL_VERSION`), schemat linku (`PAIRING_LINK_SCHEME`) i kształt kodu
 * (`PAIRING_CODE_RE`) stoją w `pairing-link.ts` razem z regułami linku; ten moduł je re-eksportuje (import
 * `@rarog/shared/rest` zostaje jedynym wejściem kontraktu REST).
 */
export {
  IROH_ENDPOINT_ID_RE, PAIR_PROTOCOL_VERSION, PAIRING_CODE_RE, PAIRING_LINK_SCHEME,
} from './pairing-link.ts';

/** Identyfikator urządzenia: 16 losowych bajtów jako hex małymi literami. Jawny (lista urządzeń, CLI). */
export const DEVICE_ID_RE = /^[0-9a-f]{32}$/;

/** Kod 404 na `POST /api/pair`: kod zły, zużyty albo przeterminowany — bez rozróżnienia. */
export const PAIR_UNKNOWN_ERROR = 'pair-unknown';
/** Kod 400 na `POST /api/pair` z `v`, którego serwer nie zna: „zaktualizuj apkę albo serwer”. */
export const PAIR_VERSION_ERROR = 'pair-version';
/** Kod 401: nagłówek `Rarog-Device` z kluczem, którego serwer nie zna (także zły sekret i obcy schemat). */
export const DEVICE_UNKNOWN_ERROR = 'device-unknown';
/** Kod 401: urządzenie odpięte albo wygasłe — ciało niesie {@link deviceRevokedBodySchema}. */
export const DEVICE_REVOKED_ERROR = 'device-revoked';
/**
 * Kod 403: trasa tylko dla klienta z kluczem urządzenia. Za bramką routera klient jest zawsze urządzeniem, więc
 * ta odpowiedź zostaje wyłącznie zabezpieczeniem typu w routerze; kod stoi w kontrakcie, bo zna go apka.
 */
export const DEVICE_REQUIRED_ERROR = 'device-required';
/**
 * Kod 403 w trybie recenzji demo (`RAROG_DEMO_REVIEW_CODE`): trasa, której recenzent nie dostaje (np. kod parowania
 * dla kolejnego urządzenia). Zdanie `demo.review-refused`.
 */
export const DEMO_REVIEW_ERROR = 'demo-review';
/**
 * Kod 429 na `POST /api/pair` w trybie recenzji demo: kod recenzenta przy pełnym sufcie aktywnych urządzeń. Bez
 * `Retry-After`, bo miejsce zwalnia odpięcie, nie czas. Zdanie `demo.review-device-limit`.
 */
export const DEMO_REVIEW_FULL_ERROR = 'demo-review-full';

/**
 * Kto odpiął urządzenie: `admin` (CLI na Macu: `rarog devices revoke`, także rotacja `RAROG_AUTH_EPOCH`),
 * `forget` („Zapomnij serwer” w apce), `expired` (30 dni bez użycia albo nowy rekord bez ani jednego
 * żądania przez 10 min) albo identyfikator urządzenia, które odpięło inne (zarezerwowane — dziś żadna
 * trasa tego nie robi).
 */
export const deviceRevokedBySchema = z.union([
  z.enum(['admin', 'forget', 'expired']),
  z.string().regex(DEVICE_ID_RE),
]);
export type DeviceRevokedBy = z.infer<typeof deviceRevokedBySchema>;

/**
 * Ciało `POST /api/pair`. `code` to kod z linku albo z QR (kształtu nie sprawdza schemat: kod w złym
 * kształcie to „zły kod”, czyli 404, nie 400). `label` = nazwa urządzenia (`iPhone·Rarog`), serwer ją
 * sanityzuje. `build` = numer builda apki (diagnostyka listy urządzeń). `pushFormats` = formaty ładunku
 * push, które apka umie czytać — serwer pole przyjmuje i NIE używa: deklaracja formatu idzie rejestracją tokenu
 * (`apnsRegisterBodySchema.pushFormats`), bo tylko ona trafia do wpisu, do którego się wysyła.
 */
export const pairBodySchema = z.object({
  v: z.number().int(),
  code: z.string().max(128),
  label: z.string().max(PUSH_LABEL_MAX_CHARS),
  build: z.string().max(32).optional(),
  pushFormats: z.array(z.number().int()).max(8).optional(),
});
export type PairBody = z.infer<typeof pairBodySchema>;

/**
 * Serwer, z którym urządzenie się sparowało: trwały `serverId`, nazwa hosta, wersja, możliwości i serwer iroh
 * ({@link serverIrohSchema}; `null` = serwer bez nasłuchu iroh).
 */
export const pairServerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  iroh: serverIrohSchema.nullable(),
});

/**
 * `POST /api/pair` (200) — wysyłana RAZ, po trwałym zapisie rekordu. `secret` i `pushKey` nie wrócą już
 * żadną trasą: na dysku serwera leży skrót sekretu, a klucz push (32 B base64url) służy do szyfrowania
 * treści banerów. `kid` = pierwsze 8 znaków hex `sha256(pushKey)` liczonego z SUROWYCH bajtów klucza.
 */
export const pairResponseSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_RE),
  secret: z.string().regex(PAIRING_CODE_RE),
  pushKey: z.string().regex(PAIRING_CODE_RE),
  kid: z.string().regex(/^[0-9a-f]{8}$/),
  server: pairServerSchema,
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

/**
 * `POST /api/pairings` (200) — kod dla NOWEGO urządzenia, wydany na już sparowanym. Ważny do `expiresAt`
 * (ISO, zegar serwera), jednorazowy; nowy kod tego samego urządzenia unieważnia poprzedni. Ciało żądania
 * jest puste.
 */
export const pairingIssuedSchema = z.object({
  code: z.string().regex(PAIRING_CODE_RE),
  expiresAt: z.string(),
});
export type PairingIssued = z.infer<typeof pairingIssuedSchema>;

/**
 * Urządzenie na liście: etykieta, data parowania, twórca kodu (`admin` = kod z CLI na Macu, inaczej
 * `deviceId` urządzenia, które go wydało), ostatnie użycie (`null` = sparowane, jeszcze bez żadnego
 * żądania), build z parowania i `current` = to jest urządzenie, które pyta. Bez skrótu sekretu i klucza push.
 */
export const deviceInfoSchema = z.object({
  id: z.string().regex(DEVICE_ID_RE),
  label: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  creator: z.union([z.literal('admin'), z.string().regex(DEVICE_ID_RE)]),
  build: z.string().nullable(),
  current: z.boolean(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** `GET /api/devices` (200) — aktywne urządzenia serwera (nieodpięte i niewygasłe), od najstarszego. */
export const deviceListSchema = z.object({ devices: z.array(deviceInfoSchema) });
export type DeviceList = z.infer<typeof deviceListSchema>;

/** `GET /api/devices/me` (200) — rekord pytającego urządzenia i trwały `serverId` serwera. */
export const deviceMeSchema = z.object({ device: deviceInfoSchema, serverId: z.string().min(1) });
export type DeviceMe = z.infer<typeof deviceMeSchema>;

/**
 * 401 `device-revoked` — urządzenie odpięto (`revokedAt` ISO, `revokedBy` — {@link deviceRevokedBySchema}).
 * Apka po nim kasuje klucz i pokazuje trwały ekran „To urządzenie odpięto”; po samym 401 bez tego
 * kodu klucza nie kasuje.
 */
export const deviceRevokedBodySchema = z.object({
  error: z.literal(DEVICE_REVOKED_ERROR),
  message: z.string(),
  messageRef: sentenceRefSchema.optional(),
  revokedAt: z.string(),
  revokedBy: deviceRevokedBySchema,
});
export type DeviceRevokedBody = z.infer<typeof deviceRevokedBodySchema>;

// ---------------------------------------------------------------------------
// Voice agent: a question about one Claude Code session
// ---------------------------------------------------------------------------

/**
 * Longest question in UTF-16 code units (`string.length`). The server's input to the model (`MAX_QUESTION_CHARS` in
 * `server/src/companion/prompt.ts`) takes this value.
 */
export const COMPANION_QUESTION_MAX_CHARS = 2000;

/**
 * `POST /api/sessions/:id/companion/ask`. The question is about the engine conversation the session writes when the
 * server takes the request; the app never names it (the wire does not carry a session's engine conversation). A new
 * engine conversation while the question waits (`/clear`, `/resume`) kills the call and closes the response without
 * a body. `clientRequestId` is a UUID per question, for the server log only. A question of only whitespace is refused
 * like an empty one.
 */
export const companionAskBodySchema = z.object({
  question: z.string().max(COMPANION_QUESTION_MAX_CHARS).refine((question) => question.trim() !== ''),
  clientRequestId: z.uuid(),
});
export type CompanionAskBody = z.infer<typeof companionAskBodySchema>;

/**
 * 200 of `POST /api/sessions/:id/companion/ask`: the answer to read aloud (1–3 sentences), whether the session holds
 * it, and a prompt proposal for the agent when it does not (absent when there is none). Common secret shapes in
 * `answer` and `prompt` are masked (`docs/companion.md`, "Secret mask").
 */
export const companionAskSchema = z.object({
  answer: z.string(),
  found: z.boolean(),
  prompt: z.string().min(1).optional(),
});
export type CompanionAsk = z.infer<typeof companionAskSchema>;

/**
 * 503: `RAROG_COMPANION` is off on this server, or it has no OpenAI key, or (the short-lived key route) no Soniox voice
 * (`companionEnabled: false`).
 */
export const COMPANION_DISABLED_ERROR = 'companion-disabled';
/** 429: a question about this session is in flight, or two are in flight on the server. */
export const COMPANION_BUSY_ERROR = 'companion-busy';
/** 429: the Claude subscription limit is exhausted. */
export const COMPANION_LIMIT_ERROR = 'companion-limit';
/** 503: Claude Code did not answer: no program, no login, a failed run or output over a ceiling. */
export const COMPANION_CLI_ERROR = 'companion-cli';
/** 504: no answer within the time limit. */
export const COMPANION_TIMEOUT_ERROR = 'companion-timeout';

// ---------------------------------------------------------------------------
// Voice agent across sessions: the last turns of one session
// ---------------------------------------------------------------------------

/** Most turns `GET /api/sessions/:id/companion/turns` returns. */
export const COMPANION_TURNS_MAX = 3;

/** The `count` query parameter of `GET /api/sessions/:id/companion/turns`: a whole number 1–3 in decimal digits. */
export const companionTurnsCountSchema = z.string().regex(/^[1-9]$/u).transform(Number)
  .pipe(z.number().int().min(1).max(COMPANION_TURNS_MAX));

/**
 * 200 of `GET /api/sessions/:id/companion/turns?count=1..3`: the messages of the last turns of the engine
 * conversation the session writes now, in the shape of the session stream (`TranscriptMessage`; `seq` numbers the
 * messages of this response from 1 and is not the stream's `seq`). A turn starts at a human message that the app
 * shows as a turn. `conversation` is an opaque token of that conversation: the same while the server runs, another
 * for another conversation and after a server restart; it is not the engine's id. `stateSince` is the session's
 * `stateSince` at the read. `complete: false` = the read window starts inside the oldest returned turn, so its prompt
 * and its first messages are missing.
 */
export const companionTurnsSchema = z.object({
  messages: z.array(transcriptMessageSchema),
  conversation: z.string().min(1),
  stateSince: z.string(),
  complete: z.boolean(),
});
export type CompanionTurns = z.infer<typeof companionTurnsSchema>;

/** 503: the voice agent works, but the mode across sessions is off (`RAROG_COMPANION_SESSIONS`). */
export const COMPANION_SESSIONS_DISABLED_ERROR = 'companion-sessions-disabled';

/**
 * 200 of `GET /api/companion/sessions`: the voice agent's session catalog, one row per session the voice agent may see
 * (a Claude Code session in scope). `id` is the session's id in the session list; `conversation` the same token as in
 * `companionTurnsSchema`, so a row and a turns read of one session compare; `stateSince` as the session list carries
 * it. `asksOwner` is present, only as `true`, while the session waits for input and its last message is an agent
 * message with a top-level paragraph that opens with a bold `Do Ciebie:` or `To you:` (`docs/companion.md`,
 * "Session catalog"). A session without a row is not the voice agent's to see.
 */
export const companionSessionsSchema = z.object({
  sessions: z.array(z.object({
    id: z.string().min(1),
    asksOwner: z.literal(true).optional(),
    conversation: z.string().min(1),
    stateSince: z.string(),
  })),
});
export type CompanionSessions = z.infer<typeof companionSessionsSchema>;

/**
 * `POST /api/companion/token`: an empty body. Any field is a 400: the server picks the model and the lifetime, the
 * app does not ask for them.
 */
export const companionTokenBodySchema = z.strictObject({});
export type CompanionTokenBody = z.infer<typeof companionTokenBodySchema>;

/**
 * 200 of `POST /api/companion/token`: a short-lived OpenAI Realtime key (`value`, valid 60 s from the moment OpenAI
 * made it; while valid it opens new Realtime sessions, and an open session outlives it), its expiry as ISO 8601 and
 * the Realtime model the server set for it (`RAROG_COMPANION_MODEL`). The server's own OpenAI key never leaves the
 * server (`docs/companion.md`, "Short-lived OpenAI key").
 */
export const companionTokenSchema = z.object({
  value: z.string().min(1),
  expiresAt: z.string(),
  model: z.string().min(1),
});
export type CompanionToken = z.infer<typeof companionTokenSchema>;

/** 429: a short-lived key was made a moment ago (one per 3 s, 60 per hour, for all devices together). */
export const COMPANION_THROTTLED_ERROR = 'companion-throttled';
/** 503: OpenAI refused the server's key (401, 403): a configuration of the server, not an OpenAI outage. */
export const COMPANION_OPENAI_KEY_ERROR = 'companion-openai-key';
/** 429: OpenAI answered 429 (the account's rate limit or budget). */
export const COMPANION_OPENAI_LIMIT_ERROR = 'companion-openai-limit';
/** 502: OpenAI did not give a key (5xx, timeout, redirect, a refused model, a reply outside its contract). */
export const COMPANION_OPENAI_ERROR = 'companion-openai';

/**
 * `POST /api/companion/speech-token`: an empty body. Any field is a 400: the server picks the voice, the model and
 * the lifetimes, the app does not ask for them.
 */
export const companionSpeechTokenBodySchema = z.strictObject({});
export type CompanionSpeechTokenBody = z.infer<typeof companionSpeechTokenBodySchema>;

/**
 * 200 of `POST /api/companion/speech-token`: a temporary Soniox text-to-speech key for the voice agent's voice
 * (`apiKey`; while valid it opens new speech streams, each stream lives at most 180 s), its expiry as ISO 8601, the EU
 * WebSocket address, the model, the voice and the sample rate of the audio. The server's own Soniox key never leaves
 * the server (`docs/companion.md`, "Temporary Soniox speech key").
 */
export const companionSpeechTokenSchema = z.object({
  apiKey: z.string().min(1),
  expiresAt: z.string(),
  webSocketUri: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().min(1),
  sampleRate: z.number().int().positive(),
});
export type CompanionSpeechToken = z.infer<typeof companionSpeechTokenSchema>;

/**
 * 503: no Soniox voice for the voice agent: `RAROG_COMPANION` is off or the server has no OpenAI key, the server has no
 * Soniox key or one from outside the EU region, or Soniox refused the key (401, 403).
 */
export const COMPANION_SPEECH_UNCONFIGURED_ERROR = 'companion-speech-unconfigured';
/** 429: a speech key was made a moment ago (one per 3 s, 60 per hour, for all devices together; dictation apart). */
export const COMPANION_SPEECH_THROTTLED_ERROR = 'companion-speech-throttled';
/** 502: Soniox did not give a key (5xx, timeout, no connection, a reply without a key). */
export const COMPANION_SPEECH_UPSTREAM_ERROR = 'companion-speech-upstream';
