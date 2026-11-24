/**
 * Dekoder ramek SSE po stronie KLIENTA — tolerancja nieznanych wartości.
 *
 * Kontrakt w `protocol.ts` jest ŚCISŁY i taki zostaje: serwer, testy producentów i każda poprawna
 * ramka przechodzą przez schemat, który odrzuca wartość spoza listy. Tolerancja jest polityką
 * KLIENTA i mieszka tutaj, we własnej podścieżce (`@rarog/shared/decode`). Powód: ścisły
 * `parseServerEvent` odrzuca CAŁĄ ramkę przy jednej nieznanej wartości enuma — nowy stan JEDNEJ
 * sesji zabierałby klientowi całą listę sesji (`sessions-snapshot`), a nowy typ bloku cały
 * transkrypt.
 *
 * Reguła jest wąska i to jest jej sens:
 * - nieznany ŁAŃCUCH w polu wyliczeniowym degraduje TO POLE do wartości zapasowej
 *   ({@link DEGRADATIONS}), reszta ramki zostaje;
 * - `null`, brak wymaganego pola, zły typ, liczba zamiast łańcucha i uszkodzony ZNANY blok
 *   (`{ type: 'text', text: 9 }`) dalej odrzucają ramkę (`null`), dokładnie jak `parseServerEvent`.
 *   Szeroki `.catch` zamieniłby błąd producenta w „nieobsługiwane" i schował go przed testami;
 * - nieznany `type` RAMKI to dalej `null` (reguła forward-compat z `protocol.ts`).
 *
 * Dlaczego `shared`: to WZORCOWA implementacja polityki degradacji. Test odpala ją bez serwera,
 * a klient ma odwzorować dokładnie ten moduł. Żaden klient
 * TypeScript go nie importuje — zostaje jako wzorzec dla apki natywnej i strażnik manifestu
 * złotych ramek (`shared/test/sse-fixtures.test.ts` sprawdza nim `degrades`, które czyta Swift).
 */
import { z } from 'zod';
import {
  activityEventSchema,
  activitySchema,
  backgroundTaskSchema,
  blockSchema,
  contextLimitStateSchema,
  deltaEventSchema,
  folderAccessEventSchema,
  gitFileDetailSchema,
  gitStatusEventSchema,
  helloEventSchema,
  herdrStatusEventSchema,
  inboxCardKindSchema,
  inboxDialogKindSchema,
  inboxEventSchemas,
  inboxHeadSchemaOf,
  macFolderBlockSchema,
  macFolderStateSchema,
  messageAttachmentSchema,
  messageEventSchema,
  notesEventSchema,
  parseServerEvent,
  permissionPendingEventSchema,
  permissionRequestObjectSchema,
  permissionRequestSchema,
  permissionResolvedEventSchema,
  permissionSettledEventSchema,
  questionOptionSchema,
  questionPendingEventSchema,
  questionRequestSchema,
  questionSchema,
  questionResolvedEventSchema,
  sessionChangedEventSchema,
  sessionPullRequestSchema,
  sessionStateSchema,
  sessionsSnapshotEventSchema,
  sessionSummarySchema,
  stateEventSchema,
  transcriptMessageSchema,
  transcriptNoticeSchema,
  transcriptSnapshotEventSchema,
  usageEventSchema,
  toolCallBlockObjectSchema,
  waitingForSchema,
  withDetailTruncation,
  withDisplayTextTruncation,
} from './protocol.ts';

/**
 * Wartownik „ta wersja klienta tego nie zna". Zarezerwowany w KLIENCIE: serwer go nie nadaje
 * i nie zna (schematy ścisłe), więc w polu stanu nie pomyli się z żadną prawdziwą wartością.
 * Nie `unknown` — to słowo jest już wartością `HerdrMode` („trybu nie odczytano").
 */
export const UNSUPPORTED = 'unsupported' as const;

/** Jedna degradacja: gdzie (JSON Pointer, RFC 6901) i jaki nieznany łańcuch tam przyszedł. */
export interface Degradation {
  path: string;
  value: string;
}

export interface DecodedEvent {
  event: ClientServerEvent;
  /**
   * Pusta WTEDY I TYLKO WTEDY, gdy ramka przeszła ścisły kontrakt (ścieżka szybka). Ramka
   * uratowana tolerancją ma co najmniej jedną pozycję — każde pole, które przeszło gałąź zapasową,
   * także z wartością równą zapasowej.
   */
  degradations: Degradation[];
}

/**
 * Wartości zapasowe — PEŁNA lista pól, które dekoder wolno zdegradować, i nic poza nią.
 *
 * Schematy niżej NIE czytają tej listy w runtime, tylko sprawdzają się z nią w typach
 * (`wartość satisfies Fallback<'pole'>`): inna wartość niż tutaj to błąd `tsc`.
 * Testy (`shared/test/decode.test.ts`) mają po przypadku na każdą pozycję.
 *
 * `undefined` znaczy „pole znika" (przy `context.kind`, `activity.kind` i `waitingFor.kind` —
 * CAŁY obiekt: kształtu nieznanego rodzaju nie znamy, więc nie ma czego pokazać połowicznie).
 * Wartość wybiera zawsze wariant OSTROŻNIEJSZY: karta bez akcji zamiast zgadywania.
 */
export const DEGRADATIONS = {
  /** `SessionSummary.state` i ramka `state` — karta „nieobsługiwana", bez akcji. */
  state: UNSUPPORTED,
  effort: UNSUPPORTED,
  /** Wartość, którą protokół już ma: „trybu nie odczytano". */
  herdrMode: 'unknown',
  /** Bez pola karta zostaje przy wycinku ekranu i „Odrzuć dialog" — wariant bezpieczny. */
  herdrDialog: undefined,
  herdrDialogReason: undefined,
  /** Klasa dialogu z rejestru CLI — bez pola karta mówi to, co bez rejestru. */
  cliDialog: undefined,
  /** Nie `undefined`: brak pola znaczy „Claude", a nieznanego silnika nie wolno czytać jak Claude. */
  engine: UNSUPPORTED,
  'context.kind': undefined,
  'context.source': UNSUPPORTED,
  /** W `SessionSummary` i `transcript-snapshot`; ULOTNA ramka `activity` z nieznanym `kind` → `null`. */
  'activity.kind': undefined,
  'waitingFor.kind': undefined,
  'backgroundTasks.kind': UNSUPPORTED,
  /** Notka systemowa — nie udaje ani człowieka, ani agenta. */
  'message.role': 'system',
  /** Blok zastępczy `{ type: 'unsupported' }`; reszta pól nieznanego bloku jest odcinana. */
  'block.type': UNSUPPORTED,
  'block.detailKind': undefined,
  'attachments.kind': 'file',
  /** Nieznane ryzyko ostrożniej, nigdy łagodniej. */
  risk: 'red',
  /** `QuestionRequest.channel`. */
  channel: undefined,
  /** `permission-resolved.decision` — karta znika jak przy `expired`. */
  'permission-resolved.decision': UNSUPPORTED,
  /*
   * Pola semantyczne. Nieznany przedmiot zgody to zwykła karta zgody, nie plan; nieznana
   * delegacja to wciąż delegacja (forma ogólna, „subagenci"); nieznany rodzaj inputu — szczegół
   * jako zwykły tekst; nieznana rola opcji — opcja pokazana jak odpowiedź (etykietę i tak
   * waliduje serwer przy wysyłce).
   */
  /** `PermissionRequest.subject` (karta zgody i `pendingPermissions`). */
  subject: 'tool',
  /** `PermissionRequest.inputKind` — bez pola komenda na karcie zgody stoi bez koloru. */
  'permission.inputKind': undefined,
  /*
   * Karta kanału zgód: nieznany stan, powód albo uwaga to karta „nieobsługiwana” bez przycisków (apka nie
   * wie, co zatwierdza ani w jakim stanie jest odpowiedź). `permission.state` i `permission.unavailable` obejmują
   * kartę i zdarzenie `permission-settled`.
   */
  'permission.state': UNSUPPORTED,
  'permission.unavailable': UNSUPPORTED,
  'permission.notes': UNSUPPORTED,
  'waitingFor.subject': 'tool',
  /** W podsumowaniu, w `transcript-snapshot` i w ULOTNEJ ramce `activity` (ta zostaje). */
  'activity.delegation': 'agents',
  'block.delegation': 'agents',
  'block.inputKind': undefined,
  /** `QuestionOption.role` (karta pytania i `pendingQuestions`). */
  'option.role': 'answer',
  /*
   * Notka harnessu. Nieznany rodzaj to wciąż notka (forma ogólna „zadanie w tle skończyło
   * się…"), nie wypowiedź człowieka; nieznany wynik znika — brak `outcome` i tak nie znaczy sukcesu.
   */
  'notice.kind': 'unknown',
  'notice.outcome': undefined,
  /*
   * Rodzaj zmiany pliku w ramce `git-status`. Nieznany rodzaj to wciąż zmiana pliku — `modified`,
   * szufladka wszystkiego, czego git nie nazwał dodaniem ani usunięciem (rename, typechange).
   */
  'fileDetails.kind': 'modified',
  /** `SessionPullRequest.state`: an unknown state (`draft`) drops the field, so the row reads as "state unknown". */
  'pullRequests.state': undefined,
  /** `SessionSummary.seenBy`: an unknown picker drops the field, so the received result reads as a human's. */
  seenBy: undefined,
  /**
   * An `inbox-heads` head with an unknown `kind`, `state` or `dialog`: that head drops out of the list and the other
   * heads stay, so a card kind added later does not empty an older app's Inbox. A single `inbox-head` with such a
   * value is one item with nothing left to show and is ignored whole.
   */
  'inbox.head': undefined,
  /**
   * A `folder-access` block with an unknown `state`: that folder drops out of the list and the other blocks stay, so a
   * state added later does not hide the folders an older app can name.
   */
  'folder-access.block': undefined,
} as const;

/** Wartość zapasowa pola `K` — wyłącznie do `satisfies` w schematach (zero kodu w runtime). */
type Fallback<K extends keyof typeof DEGRADATIONS> = (typeof DEGRADATIONS)[K];

/**
 * Znacznik widoku surowego: ta wartość przeszła GAŁĄŹ ZAPASOWĄ. Zgłaszany zawsze, bez porównania
 * z wynikiem — nieznany łańcuch równy wartości zapasowej (`'unsupported'` od serwera, który nie
 * ma prawa go nadać) dalej jest degradacją i ma trafić do raportu.
 */
class Unknown {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

/**
 * A list element the client cannot read. The result drops it from its list; the raw view keeps it in place, wrapped,
 * so {@link collect} reports its markers at the input index and pairs the elements after it with the right result.
 */
class Dropped {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/**
 * Schematy tolerancyjne, zbudowane ze ścisłych przez `.extend` pól wyliczeniowych.
 *
 * Dwa tryby o IDENTYCZNYM zbiorze akceptowanych ramek, różne tylko na wyjściu:
 * - `raw = false` — WYNIK dla klienta: nieznany łańcuch przechodzi w wartość zapasową;
 * - `raw = true` — WIDOK SUROWY: każda wartość przyjęta przez gałąź zapasową staje się
 *   znacznikiem {@link Unknown}, a obiekt o nieznanym wyróżniku kurczy się do samego
 *   (oznaczonego) wyróżnika. Nieznane KLUCZE oba tryby odcinają tak samo (`z.object`).
 * Degradacje to znaczniki widoku surowego z ich ścieżkami ({@link collect}), a nie efekt uboczny
 * w schemacie. Surowe WEJŚCIE się do tego nie nadaje: odcięty nieznany klucz (forward-compat)
 * wygląda tam tak samo jak pole usunięte degradacją, a usunięty `activity` zgłosiłby każdy swój
 * łańcuch, nie tylko `kind`.
 */
function buildSchemas(raw: boolean) {
  const or = <const T>(to: T) => (value: string) => (raw ? new Unknown(value) : to) as T;
  /** Znana wartość ściśle; NIEZNANY ŁAŃCUCH → `to`; `null`, liczba i brak dalej są błędem. */
  const lenient = <S extends z.ZodType, const T>(strict: S, to: T) =>
    z.union([strict, z.string().transform(or(to))]);
  const lenientOpt = <S extends z.ZodType, const T>(field: z.ZodOptional<S>, to: T) =>
    lenient(field.unwrap(), to).optional();
  /*
   * Wyróżnik spoza listy znanych. Bez tej bramki gałąź zapasowa łapałaby też USZKODZONY znany
   * obiekt (`{ type: 'text', text: 9 }` nie pasuje do wariantu, ale pasuje do „jakiś `type`").
   */
  const unknownOf = (known: readonly string[]) => z.string().refine((v) => !known.includes(v));
  /** Obiekt o nieznanym wyróżniku `tag`: w wyniku `to`, w widoku surowym `{ [tag]: znacznik }`. */
  const unknownObject = <const T>(tag: string, known: readonly string[], to: T) =>
    z.object({ [tag]: unknownOf(known).transform(or(to)) })
      .transform((value) => (raw ? value : to) as T);

  const [contextUnknown, contextKnown] = contextLimitStateSchema.options;
  const context = z.union([
    z.discriminatedUnion('kind', [
      contextUnknown,
      contextKnown.extend({
        source: lenient(contextKnown.shape.source, UNSUPPORTED satisfies Fallback<'context.source'>),
      }),
    ]),
    unknownObject(
      'kind',
      contextLimitStateSchema.options.map((o) => o.shape.kind.value),
      undefined satisfies Fallback<'context.kind'>,
    ),
  ]);

  const delegation = lenientOpt(
    activitySchema.shape.delegation, 'agents' satisfies Fallback<'activity.delegation'>,
  );
  const activity = z.union([
    activitySchema.extend({ delegation }),
    unknownObject('kind', activitySchema.shape.kind.options, undefined satisfies Fallback<'activity.kind'>),
  ]);

  const waitingFor = z.union([
    waitingForSchema.extend({
      subject: lenientOpt(waitingForSchema.shape.subject, 'tool' satisfies Fallback<'waitingFor.subject'>),
    }),
    unknownObject('kind', waitingForSchema.shape.kind.options, undefined satisfies Fallback<'waitingFor.kind'>),
  ]);

  const summaryShape = sessionSummarySchema.shape;
  const summary = sessionSummarySchema.extend({
    state: lenient(summaryShape.state, UNSUPPORTED satisfies Fallback<'state'>),
    effort: lenientOpt(summaryShape.effort, UNSUPPORTED satisfies Fallback<'effort'>),
    herdrMode: lenientOpt(summaryShape.herdrMode, 'unknown' satisfies Fallback<'herdrMode'>),
    herdrDialog: lenientOpt(summaryShape.herdrDialog, undefined satisfies Fallback<'herdrDialog'>),
    herdrDialogReason:
      lenientOpt(summaryShape.herdrDialogReason, undefined satisfies Fallback<'herdrDialogReason'>),
    cliDialog: lenientOpt(summaryShape.cliDialog, undefined satisfies Fallback<'cliDialog'>),
    seenBy: lenientOpt(summaryShape.seenBy, undefined satisfies Fallback<'seenBy'>),
    engine: lenientOpt(summaryShape.engine, UNSUPPORTED satisfies Fallback<'engine'>),
    context: context.optional(),
    activity: activity.optional(),
    backgroundTasks: z.array(backgroundTaskSchema.extend({
      kind: lenient(backgroundTaskSchema.shape.kind, UNSUPPORTED satisfies Fallback<'backgroundTasks.kind'>),
    })).optional(),
    waitingFor: waitingFor.optional(),
    pullRequests: z.array(sessionPullRequestSchema.extend({
      state: lenientOpt(sessionPullRequestSchema.shape.state, undefined satisfies Fallback<'pullRequests.state'>),
    })).optional(),
  });

  const [textBlock, , imageBlock] = blockSchema.options;
  // Baza bez reguły `truncation`: `.extend` nie nadpisuje pól obiektu z regułą, więc regułę nakładamy na widok.
  const toolCallBlock = toolCallBlockObjectSchema;
  const block = z.union([
    z.discriminatedUnion('type', [
      textBlock,
      withDetailTruncation(toolCallBlock.extend({
        detailKind:
          lenientOpt(toolCallBlock.shape.detailKind, undefined satisfies Fallback<'block.detailKind'>),
        delegation:
          lenientOpt(toolCallBlock.shape.delegation, 'agents' satisfies Fallback<'block.delegation'>),
        inputKind:
          lenientOpt(toolCallBlock.shape.inputKind, undefined satisfies Fallback<'block.inputKind'>),
      })),
      imageBlock,
    ]),
    z.object({
      type: unknownOf(blockSchema.options.map((o) => o.shape.type.value))
        .transform(or(UNSUPPORTED satisfies Fallback<'block.type'>)),
    }),
  ]);

  const message = transcriptMessageSchema.extend({
    role: lenient(transcriptMessageSchema.shape.role, 'system' satisfies Fallback<'message.role'>),
    blocks: z.array(block),
    attachments: z.array(messageAttachmentSchema.extend({
      kind: lenient(messageAttachmentSchema.shape.kind, 'file' satisfies Fallback<'attachments.kind'>),
    })).optional(),
    notice: transcriptNoticeSchema.extend({
      kind: lenient(transcriptNoticeSchema.shape.kind, 'unknown' satisfies Fallback<'notice.kind'>),
      outcome: lenientOpt(
        transcriptNoticeSchema.shape.outcome, undefined satisfies Fallback<'notice.outcome'>,
      ),
    }).optional(),
  });

  const permission = withDisplayTextTruncation(permissionRequestObjectSchema.extend({
    risk: lenient(permissionRequestSchema.shape.risk, 'red' satisfies Fallback<'risk'>),
    subject: lenientOpt(permissionRequestSchema.shape.subject, 'tool' satisfies Fallback<'subject'>),
    inputKind: lenientOpt(
      permissionRequestSchema.shape.inputKind, undefined satisfies Fallback<'permission.inputKind'>,
    ),
    state: lenientOpt(permissionRequestSchema.shape.state, UNSUPPORTED satisfies Fallback<'permission.state'>),
    unavailable: lenientOpt(
      permissionRequestSchema.shape.unavailable, UNSUPPORTED satisfies Fallback<'permission.unavailable'>,
    ),
    notes: z.array(lenient(
      permissionRequestSchema.shape.notes.unwrap().element, UNSUPPORTED satisfies Fallback<'permission.notes'>,
    )).optional(),
  }));

  const option = questionOptionSchema.extend({
    role: lenientOpt(questionOptionSchema.shape.role, 'answer' satisfies Fallback<'option.role'>),
  });
  const question = questionRequestSchema.extend({
    channel: lenientOpt(questionRequestSchema.shape.channel, undefined satisfies Fallback<'channel'>),
    questions: z.array(questionSchema.extend({ options: z.array(option) })),
  });

  /*
   * `inbox-heads`: a head with an unknown string in `kind`, `state` or `dialog` drops out and the rest of the list
   * stays. Any other broken head (`null`, a missing field, an empty `version`) still rejects the frame, also next to
   * an unknown value.
   */
  const [inboxHeadsEvent, inboxHeadEvent, inboxRemovedEvent] = inboxEventSchemas(sessionStateSchema);
  const inboxHead = inboxHeadSchemaOf(sessionStateSchema);
  const unreadableHead = inboxHead.extend({
    kind: lenient(inboxCardKindSchema, undefined satisfies Fallback<'inbox.head'>),
    state: lenient(sessionStateSchema, undefined satisfies Fallback<'inbox.head'>),
    dialog: lenientOpt(inboxDialogKindSchema.optional(), undefined satisfies Fallback<'inbox.head'>),
  }).transform((head) => new Dropped(head));
  type InboxHead = z.output<typeof inboxHead>;
  const inboxHeads = z.array(z.union([inboxHead, unreadableHead]))
    .transform((heads) => (raw ? heads : heads.filter((head) => !(head instanceof Dropped))) as InboxHead[]);

  /*
   * `folder-access`: a block with an unknown string in `state` drops out and the rest of the list stays. Any other
   * broken block (`null`, a missing field, an empty `path`) still rejects the frame, also next to an unknown state.
   */
  const unreadableBlock = macFolderBlockSchema.extend({
    state: lenient(macFolderStateSchema, undefined satisfies Fallback<'folder-access.block'>),
  }).transform((block) => new Dropped(block));
  type MacFolderBlock = z.output<typeof macFolderBlockSchema>;
  const folderBlocks = z.array(z.union([macFolderBlockSchema, unreadableBlock]))
    .transform((blocks) => (raw ? blocks : blocks.filter((block) => !(block instanceof Dropped))) as MacFolderBlock[]);

  return z.discriminatedUnion('type', [
    helloEventSchema,
    sessionsSnapshotEventSchema.extend({ sessions: z.array(summary) }),
    sessionChangedEventSchema.extend({ session: summary }),
    transcriptSnapshotEventSchema.extend({
      messages: z.array(message),
      pendingPermissions: z.array(permission),
      pendingQuestions: z.array(question),
      activity: activity.optional(),
    }),
    messageEventSchema.extend({ message }),
    deltaEventSchema,
    // `kind` zostaje ŚCISŁY: ramka ulotna nie ma czego pokazać zamiast siebie i odpada w całości.
    // Nieznana `delegation` degraduje jak w podsumowaniu — wiersz zostaje, w formie ogólnej.
    activityEventSchema.extend({ delegation }),
    permissionPendingEventSchema.extend({ request: permission }),
    permissionResolvedEventSchema.extend({
      decision: lenient(
        permissionResolvedEventSchema.shape.decision,
        UNSUPPORTED satisfies Fallback<'permission-resolved.decision'>,
      ),
    }),
    permissionSettledEventSchema.extend({
      state: lenient(permissionSettledEventSchema.shape.state, UNSUPPORTED satisfies Fallback<'permission.state'>),
      unavailable: lenientOpt(
        permissionSettledEventSchema.shape.unavailable, UNSUPPORTED satisfies Fallback<'permission.unavailable'>,
      ),
    }),
    questionPendingEventSchema.extend({ request: question }),
    questionResolvedEventSchema,
    stateEventSchema.extend({
      state: lenient(stateEventSchema.shape.state, UNSUPPORTED satisfies Fallback<'state'>),
    }),
    gitStatusEventSchema.extend({
      fileDetails: z.array(gitFileDetailSchema.extend({
        kind: lenient(gitFileDetailSchema.shape.kind, 'modified' satisfies Fallback<'fileDetails.kind'>),
      })).optional(),
    }),
    usageEventSchema,
    herdrStatusEventSchema,
    notesEventSchema,
    folderAccessEventSchema.extend({ blocked: folderBlocks }),
    inboxHeadsEvent.extend({ heads: inboxHeads }),
    // One head is one item: an unknown value ignores the frame, and the next head or `GET /api/inbox` mends it.
    inboxHeadEvent,
    inboxRemovedEvent,
  ]);
}

type EventSchema = ReturnType<typeof buildSchemas>;
type Frame<T extends ClientServerEvent['type']> = Extract<ClientServerEvent, { type: T }>;

/*
 * Typy KLIENTA — wyjście schematu tolerancyjnego, wyłuskane z unii ramek (builder zwraca w runtime
 * sam schemat ramki: osobne schematy pól kosztowałyby bajty ścieżki startowej tylko dla typów).
 * Ścisły typ jest ich podzbiorem (ścieżka szybka w `decodeServerEvent` oddaje `ServerEvent` jako
 * `ClientServerEvent` i dzięki temu się kompiluje), a wartownik dochodzi tam, gdzie degradacja go
 * wstawia — `tsc` wskaże każdy `switch` i `Record<SessionState, …>` bez niego.
 */
export type ClientServerEvent = z.output<EventSchema>;
export type ClientSessionSummary = Frame<'session-changed'>['session'];
export type ClientSessionState = ClientSessionSummary['state'];
export type ClientTranscriptMessage = Frame<'message'>['message'];
export type ClientBlock = ClientTranscriptMessage['blocks'][number];
export type ClientPermissionRequest = Frame<'permission-pending'>['request'];
export type ClientQuestionRequest = Frame<'question-pending'>['request'];
export type ClientActivity = NonNullable<ClientSessionSummary['activity']>;
export type ClientContextLimitState = NonNullable<ClientSessionSummary['context']>;
export type ClientWaitingFor = NonNullable<ClientSessionSummary['waitingFor']>;
export type ClientBackgroundTask = NonNullable<ClientSessionSummary['backgroundTasks']>[number];

/** Budowane przy PIERWSZEJ ramce spoza ścisłego kontraktu — ścieżka szybka ich nie potrzebuje. */
let views: { out: EventSchema; raw: EventSchema } | undefined;

/**
 * Zbiera degradacje: każdy znacznik {@link Unknown} widoku surowego z jego ścieżką i oryginalną
 * wartością. Przy okazji zdejmuje z wyniku klucze wyzerowane przez degradację — zod zostawia
 * `klucz: undefined`, a „pole znika" ma znaczyć dokładnie to, co w JSON-ie.
 *
 * Ścieżka bez escape'ów RFC 6901 (`~0`, `~1`): klucze widoku to wyłącznie pola schematu
 * i indeksy tablic, więc `~` ani `/` w nich nie występują.
 */
function collect(raw: unknown, out: unknown, path: string, acc: Degradation[]): void {
  if (raw instanceof Unknown) {
    acc.push({ path, value: raw.value });
    return;
  }
  if (raw instanceof Dropped) {
    collect(raw.value, undefined, path, acc);
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  const target = typeof out === 'object' && out !== null ? (out as Record<string, unknown>) : undefined;
  // A dropped element exists only in the raw view, so every later element sits that many places earlier in `out`.
  let dropped = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Dropped) {
      dropped += 1;
      collect(value, undefined, `${path}/${key}`, acc);
      continue;
    }
    const outKey = dropped === 0 ? key : String(Number(key) - dropped);
    const next = target?.[outKey];
    if (next === undefined) delete target?.[outKey];
    collect(value, next, `${path}/${key}`, acc);
  }
}

/**
 * Dekoduje pojedynczą ramkę SSE z tolerancją nieznanych wartości.
 *
 * Ścieżka szybka: ramka zgodna ze ścisłym kontraktem wraca z `parseServerEvent` bez zmian
 * i z `degradations: []` (zero dodatkowego kosztu dla zwykłego strumienia). Dopiero ramkę, którą
 * ścisły schemat odrzucił, czyta schemat tolerancyjny.
 *
 * @param json wartość po `JSON.parse` albo surowy string (wtedy parsowany tutaj)
 * @returns ramka i lista degradacji albo `null`: nieznany `type`, uszkodzony JSON albo kształt,
 *          którego nie ratuje żadna wartość zapasowa.
 */
export function decodeServerEvent(json: unknown): DecodedEvent | null {
  const strict = parseServerEvent(json);
  if (strict !== null) return { event: strict, degradations: [] };
  let value = json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  views ??= { out: buildSchemas(false), raw: buildSchemas(true) };
  const out = views.out.safeParse(value);
  if (!out.success) return null;
  // Ten sam zbiór akceptacji z konstrukcji; porażka tutaj to błąd dekodera — odrzucamy, nie zgadujemy.
  const raw = views.raw.safeParse(value);
  if (!raw.success) return null;
  const degradations: Degradation[] = [];
  collect(raw.data, out.data, '', degradations);
  return { event: out.data, degradations };
}
