/**
 * Session routes: start a session (`POST /api/sessions`) and the actions under `/api/sessions/:id/` (stream, diff,
 * commands, uploads, messages, queue take-back, interrupt, close, resume, restart, focus, seen, unseen, model, mode,
 * permission, permissions, answers, companion).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_BODY_BYTES, checkMessageImageLimits, closeBodySchema,
  createSessionBodySchema, permissionDecisionBodySchema, sessionModeBodySchema, sessionModelBodySchema,
} from '@rarog/shared';
import type { AttachmentLimitViolation, InterruptDelivery } from '@rarog/shared';
import {
  COMPANION_BUSY_ERROR, COMPANION_CLI_ERROR, COMPANION_DISABLED_ERROR, COMPANION_LIMIT_ERROR,
  COMPANION_SESSIONS_DISABLED_ERROR, COMPANION_TIMEOUT_ERROR, companionTurnsCountSchema,
  answersBodySchema, companionAskBodySchema, messageBodySchema, queueTakeBackBodySchema, restartBodySchema,
  seenBodySchema,
} from '@rarog/shared/rest';
import type { MessageAccepted } from '@rarog/shared/rest';
import { type OwnText, say } from '@rarog/shared/sentences';
import { redact } from '../auth/index.ts';
import type { CompanionRefusal, CompanionTarget } from '../companion/ask.ts';
import { conversationToken } from '../companion/conversation.ts';
import { type TurnsTake, readSettledTurns } from '../companion/turns-settle.ts';
import type { ResolveResult } from '../permissions.ts';
import {
  type ErrorPolicy, type Logger, clientLabel, diffErrorStatus, managerErrorStatus, methodNotAllowed, parseBody,
  readJsonBody, readValidatedBody, recheckDevice, sendError, sendFailure, sendJson,
} from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import { parseLastEventId } from '../sse.ts';
import { type RouteContext, type RouteRequest, decodeSegment } from './context.ts';
import { checkCwd } from './projects.ts';

/**
 * Sprawdza model podany przez klienta wobec allow-listy serwera.
 *
 * Ta sama rola co `checkCwd()` dla katalogu: schemat zod bada tylko KSZTAŁT identyfikatora,
 * a lista dozwolonych wartości mieszka w managerze (`GET /api/models`). Bez tego dowolny string
 * z requestu lądowałby w `options.model` podprocesu silnika.
 */
export function checkModel(model: string | undefined, manager: ManagerApi): boolean {
  if (model === undefined) return true;
  return manager.models().models.some((choice) => choice.value === model);
}

/**
 * Zdanie 413 dla odrzuconej paczki załączników.
 *
 * Cztery powody i cztery zdania, bo każde niesie INNĄ instrukcję: „wyślij mniej zdjęć",
 * „zmniejsz zdjęcie", „wyślij mniej plików", „ten plik jest za duży". Jedno wspólne
 * „za duże ciało" zostawiłoby człowieka z telefonem bez wiedzy, co odpiąć.
 */
function attachmentLimitMessage(violation: AttachmentLimitViolation): OwnText {
  switch (violation) {
    case 'too-many':
      return say('uploads.too-many-images', { max: MAX_IMAGES_PER_MESSAGE });
    case 'too-large':
      return say('uploads.image-too-large');
    case 'files-too-many':
      return say('uploads.too-many-files', { max: MAX_FILES_PER_MESSAGE });
    case 'file-too-large':
      return say('uploads.file-too-large');
  }
}

/**
 * Ile endpoint przerwania czeka na „klawisz doszedł", zanim odpowie `delivered: 'pending'`.
 *
 * Termin jest warunkiem POPRAWNOŚCI, nie wygodą: klient przerywa żądanie po 10 s,
 * zgłasza to jako błąd sieci i PONAWIA — endpoint
 * czekający dłużej sam wyprodukowałby drugi `escape`. Serwer nie utnie tego za nas
 * (`server.requestTimeout = 0` w `index.ts`), a `runManagerAction` robi gołe `await`, więc
 * wyścig musi stać tutaj. 3 s zostawiają zapas na drugą stronę: obietnica drivera rozstrzyga
 * się w jego kolejce, a przed `escape` bywa cała długa wysyłka.
 */
export const INTERRUPT_WAIT_MS = 3_000;

/**
 * Obietnica dostarczenia z terminem → `delivered` z odpowiedzi 202.
 *
 * `false` z drivera NIE znaczy „nie doszło do panelu" w każdym przypadku — przy
 * `herdr-stalled` komenda się wykonała, a driver milczy właśnie dlatego. Rozróżnienie należy
 * do drivera, bo tylko on widzi kod błędu; tutaj `true`/`false` jest już gotowym wynikiem.
 */
async function waitForDelivery(
  delivered: Promise<boolean>, waitMs: number,
): Promise<InterruptDelivery> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<InterruptDelivery>((resolve) => {
    timer = setTimeout(() => { resolve('pending'); }, waitMs);
  });
  try {
    return await Promise.race([
      delivered.then((sent): InterruptDelivery => (sent ? 'yes' : 'no')),
      deadline,
    ]);
  } finally {
    // Timer zdejmujemy ZAWSZE — inaczej każdy szybko rozstrzygnięty Esc trzymałby pętlę
    // zdarzeń przez pełne 3 s.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cztery kody, cztery różne instrukcje dla klienta — i to jest cały powód, dla którego 422
 * istnieje osobno od 409:
 *
 * - **200** `applied` — klawisz poszedł, karta zniknie po evencie `permission-resolved`;
 * - **409** `conflict` — decyzja o tej karcie JUŻ zapadła (klawisz drugiego urządzenia
 *   wyszedł): klient gasi kartę;
 * - **410** `gone` — prośba wygasła / panel jej nie pokazuje: karta gaśnie bez decyzji;
 * - **422** `refused` — decyzja NIE wyszła, dialog stoi dalej w terminalu, pending w
 *   managerze nie został zużyty. Karta ma ZOSTAĆ z powodem przy przycisku; gdyby jechało
 *   to jako 409, klient zdjąłby kartę i pokazała „decyzja zapadła gdzie indziej", czyli
 *   nieprawdę o czymś, co dalej czeka na człowieka. Tą samą drogą (z powodem `in-flight`)
 *   jedzie próba RÓWNOLEGŁA: dopóki pierwsza nie wróci, „już zdecydowano" byłoby zgadywaniem.
 */
const sendDecision = (res: ServerResponse, result: ResolveResult): void => {
  if (result.outcome === 'ok') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (result.outcome === 'conflict') {
    sendError(res, 409, 'conflict', say('rest.decision-conflict'));
    return;
  }
  if (result.outcome === 'consent' && result.consent !== undefined) {
    // Karta kanału zgód: status, kod i zdanie z managera (`too-late`, `card-changed`, `allow-always`…).
    sendError(res, result.consent.status, result.consent.code, say(result.consent.sentence));
    return;
  }
  if (result.outcome === 'refused') {
    // Powód zawsze jest przy `refused` (kontrakt `ResolveResult`); `?? 'send-failed'` jest
    // wyłącznie po to, żeby ciało odpowiedzi dało się złożyć bez rzutowania.
    const reason = result.reason ?? 'send-failed';
    sendError(res, 422, 'refused', say(`dialogs.refuse.${reason}`), { reason });
    return;
  }
  sendError(res, 410, 'gone', say('rest.decision-expired'));
};

/**
 * Uruchamia akcję managera i mapuje wyjątki na 404/409/500.
 *
 * @param policy polityka ciała błędu ({@link errorBodyOf}) — `message` dla akcji, w których zdanie managera JEST
 *               copy dla człowieka („ten panel otworzył ktoś inny"), a ogólne „Żądanie odrzucone." nie mówiłoby nic.
 */
async function runManagerAction(
  res: ServerResponse,
  log: Logger,
  secrets: readonly string[],
  action: () => void | Promise<void>,
  policy: ErrorPolicy = 'generic',
): Promise<true> {
  try {
    await action();
  } catch (err) {
    const status = managerErrorStatus(err);
    if (status === 500) log.error(`manager action failed: ${redact(err, secrets)}`);
    if (!res.headersSent) sendFailure(res, status, err, policy);
  }
  return true;
}

export async function routeSessions(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, url, pathname, segments, principal, owner } = rq;
  const { deps, config, manager, hub, interruptWaitMs, log, secrets } = ctx;

  /*
   * POST /api/sessions — ZAŁOŻENIE PANELU w herdr.
   *
   * Odpowiedź to **202** z `{sessionId, state:'starting'}` natychmiast po `tab.create`,
   * a nie 200 po ~5 s czekania na gotowość agenta. Powód jest mierzalny: blokujący POST
   * ginie przy zgaszeniu ekranu iOS i zostawia telefon ze spinnerem przy ŻYWYM panelu.
   * Reszta startu jedzie po SSE (`starting → running` albo `starting → error` z powodem).
   */
  if (pathname === '/api/sessions' && segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, createSessionBodySchema);
    if (body === null) return true;
    const check = checkCwd(body.cwd, config, manager);
    if (!check.ok) {
      sendError(res, 400, 'cwd-not-allowed', check.sentence);
      return true;
    }
    if (!checkModel(body.model, manager)) {
      sendError(res, 400, 'model-unknown', say('model.unavailable'));
      return true;
    }
    try {
      sendJson(res, 202, await manager.create({ ...body, cwd: check.cwd }));
    } catch (err) {
      /*
       * Komunikat managera jedzie DOSŁOWNIE (400/409/429): „katalog nie był otwierany
       * w Claude Code", „limit paneli Raroga", „za szybko" — to jedyne zdania, które
       * powiedzą użytkownikowi, dlaczego sesja nie powstała.
       *
       * Był tu jeszcze jeden kod — `herdr-untrusted` dla `HerdrUntrustedCwdError`, po którym
       * PWA otwierała arkusz zaufania. Zniknął jako gałąź MARTWA:
       * żadna linia produkcji tym błędem nie rzuca, bo brak zaufania katalogu jedzie polem
       * `trustPrompt` w odpowiedzi 202, a dialog potwierdza się z telefonu. Kod, którego
       * serwer nigdy nie wystawi, nie chroni ŻADNEGO klienta — chroni tylko zielony test.
       */
      const status = managerErrorStatus(err);
      if (status === 500) log.error(`create: ${redact(err, secrets)}`);
      sendFailure(res, status, err, 'message');
    }
    return true;
  }

  // /api/sessions/:id/...
  if (segments[0] === 'api' && segments[1] === 'sessions' && segments.length >= 3) {
    const sessionId = decodeSegment(segments[2] ?? '');
    const action = segments[3];

    if (action === 'stream' && segments.length === 4) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      if (manager.get(sessionId) === undefined) {
        sendError(res, 404, 'not-found', say('rest.session-not-found'));
        return true;
      }
      /*
       * Kursor przyjmujemy z DWÓCH źródeł. `Last-Event-ID` jest kanonem SSE, ale ustawia go
       * wyłącznie wbudowany reconnect przeglądarki — a klient Raroga świadomie zamyka
       * `EventSource` i tworzy nowy (zombie stream po powrocie z tła), więc świeża instancja
       * nagłówka nigdy nie wyśle. `?since=` jest tym samym kursorem podanym jawnie; bez niego
       * każdy powrót z tła kosztowałby pełny `transcript-snapshot`.
       */
      const cursor = parseLastEventId(req.headers['last-event-id'])
        ?? parseLastEventId(url.searchParams.get('since') ?? undefined);
      hub.openSession(sessionId, res, cursor, owner, req.headers['accept-encoding']);
      return true;
    }

    // Diff jest READ-ONLY, więc jest GET-em — i musi być obsłużony PRZED strażnikiem POST-a.
    if (action === 'diff' && segments.length === 4) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return runManagerAction(res, log, secrets, async () => {
        sendJson(res, 200, await manager.diff(sessionId));
      });
    }

    /*
     * Diff per plik: `GET …/diff/files` (lista zmian) i `GET …/diff/file?path=…` (patch
     * jednego pliku). Osobne trasy obok starej, a nie parametr na niej: serwer sprzed tych tras
     * nieznany parametr by zignorował i oddał pełny patch tam, gdzie klient prosił o listę.
     * `path` wchodzi do managera surowy — walidację wstępną i listę dozwoloną trzyma
     * `git-diff.ts`; brak parametru to pusty napis, czyli 400 `bad-path`.
     */
    if (action === 'diff' && segments.length === 5 && (segments[4] === 'files' || segments[4] === 'file')) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      const list = segments[4] === 'files';
      const filePath = url.searchParams.get('path') ?? '';
      try {
        sendJson(res, 200, list
          ? await manager.diffFiles(sessionId)
          : await manager.diffFile(sessionId, filePath));
      } catch (err) {
        const status = diffErrorStatus(err);
        if (status === 500) log.error(`manager action failed: ${redact(err, secrets)}`);
        if (!res.headersSent) sendFailure(res, status, err, 'diff');
      }
      return true;
    }

    /*
     * GET /api/sessions/:id/commands — slash-komendy, które Rarog przepuści w tej sesji: ta sama migawka
     * katalogu co strażnik wysyłki, z jej `revision`. Odczyt, więc GET i trasa
     * PRZED strażnikiem POST-a niżej — serwer bez tej trasy oddaje na nią 405 i apka czyta to jak pustą
     * listę. 404 nieznanej sesji, 400 ze zdaniem managera dla panelu poza zasięgiem (Codex też).
     */
    if (action === 'commands' && segments.length === 4) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return runManagerAction(res, log, secrets, () => {
        sendJson(res, 200, manager.commands(sessionId));
      }, 'message');
    }

    /*
     * GET /api/sessions/:id/companion/turns?count=1..3 → {messages, conversation, stateSince, complete}
     * (`docs/companion.md`, "Turns route"): the last turns of the engine conversation the session writes now, for the
     * voice agent across sessions. Demo mode has no route (404 as unknown). The gate, in order: the voice agent (503
     * `companion-disabled`), the mode across sessions (503 `companion-sessions-disabled`), `count` (400), a Claude Code
     * session in scope (404). The conversation and `stateSince` are taken together before each read and again after
     * it (`companion/turns-settle.ts`): another conversation by then is read again, at most three reads, then the
     * response closes without a body; a session gone or out of scope by then gets the gate's 404. The device is
     * checked again before the answer, so a device unpaired during the read gets 401 and no turns.
     */
    if (action === 'companion' && segments.length === 5 && segments[4] === 'turns') {
      if (config.demo) {
        sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
        return true;
      }
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      if (!config.companionEnabled || deps.companion === undefined) {
        sendError(res, 503, COMPANION_DISABLED_ERROR, say('rest.companion-disabled'));
        return true;
      }
      if (!config.companionSessionsEnabled) {
        sendError(res, 503, COMPANION_SESSIONS_DISABLED_ERROR, say('rest.companion-sessions-disabled'));
        return true;
      }
      const count = companionTurnsCountSchema.safeParse(url.searchParams.get('count') ?? '');
      if (!count.success) {
        sendError(res, 400, 'bad-request', say('rest.companion-turns-count'));
        return true;
      }
      // The refusal is the step that sends it, so a take after the read answers exactly as the gate before it.
      const take = (): TurnsTake<() => void> => {
        let target: CompanionTarget | null;
        try {
          target = manager.companionTarget(sessionId);
        } catch (err) {
          return {
            refused: () => {
              const status = managerErrorStatus(err);
              if (status === 500) log.error(`companion: ${redact(err, secrets)}`);
              sendFailure(res, status, err);
            },
          };
        }
        if (target === null) {
          return { refused: () => { sendError(res, 404, 'not-found', say('rest.companion-claude-only')); } };
        }
        const stateSince = manager.get(sessionId)?.stateSince ?? '';
        return { target: { cwd: target.cwd, agentSessionId: target.agentSessionId, stateSince } };
      };
      await readSettledTurns(ctx.companionTurns, take, count.data, (outcome) => {
        if (!recheckDevice(req, res, 'while reading voice agent turns for')) return;
        if (outcome.kind === 'turns') sendJson(res, 200, outcome.body);
        else if (outcome.kind === 'refused') outcome.refusal();
        else res.destroy();
      });
      return true;
    }

    /*
     * GET /api/sessions/:id/uploads/:file — bajty ZDJĘCIA z `<cwd sesji>/.rarog-uploads/`
     * do miniatury w transkrypcie. Katalog bierze się z SESJI, a nie
     * z żądania; nazwa przechodzi wzorzec Raroga w `uploads.read`, więc ścieżka od klienta
     * nie ma jak wskazać niczego poza własnym zdjęciem. Brak pliku (po sweepie 48 h, zła nazwa,
     * dowiązanie) = 404 i chip w kliencie — nigdy 500, bo miniatura to wygoda, nie stan sesji.
     *
     * `Cache-Control` z `immutable`: nazwa niesie czas i 16 hex losowych, a Rarog nigdy nie
     * nadpisuje pliku (`wx`) — ten sam URL nie ma prawa oddać innych bajtów. `private`, bo za
     * kluczem urządzenia. Dzięki temu powrót do transkryptu nie ściąga zdjęć drugi raz przez Tailscale.
     */
    if (action === 'uploads' && segments.length === 5) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      const session = manager.get(sessionId);
      // Sesja poza zasięgiem i wpis Codexa nie oddają niczego z katalogu panelu: to ta
      // sama granica co transkrypt i diff, a czytnik nie jest o nic pytany.
      const closed = session === undefined || session.outOfScope === true || session.engine === 'codex';
      const image = closed || deps.readUpload === undefined
        ? null
        : await deps.readUpload(session.cwd, decodeSegment(segments[4] ?? ''));
      if (image === null) {
        sendError(res, 404, 'not-found', say('rest.image-not-found'));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': image.mime,
        'Content-Length': String(image.bytes.byteLength),
        'Cache-Control': 'private, max-age=172800, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(image.bytes);
      return true;
    }

    if (method !== 'POST') return methodNotAllowed(res, 'POST');

    if (action === 'messages' && segments.length === 4) {
      // Jedyny endpoint z podniesionym limitem ciała: 5 obrazków × 1,5 MB + 4 pliki × 27 MB
      // + narzut base64/JSON. Reszta API zostaje przy 64 kB — nie chcemy szerokiej furtki
      // na duże żądania.
      const raw = await readJsonBody(req, res, MAX_MESSAGE_BODY_BYTES);
      if (raw === null) return true;
      const violation = checkMessageImageLimits(raw.value);
      if (violation !== null) {
        sendError(res, 413, 'payload-too-large', attachmentLimitMessage(violation));
        return true;
      }
      const body = parseBody(res, messageBodySchema, raw.value);
      if (body === null) return true;
      /*
       * A send from the voice agent across sessions (`docs/companion.md`, "Sending from the conversation"): the schema
       * takes `source` and `expectedConversation` only together (one alone is the 400 above), and with the voice agent
       * or its mode off such a body is refused like the other routes of the mode, so the flag stops every send marked
       * as the agent's. The token check itself runs in the
       * manager after the last `await` of the send, inside the idempotency registry, so a repeat of an accepted
       * `clientMessageId` answers `replayed` without it.
       */
      const fromAgent = body.source !== undefined || body.expectedConversation !== undefined;
      if (fromAgent && (!config.companionEnabled || deps.companion === undefined)) {
        sendError(res, 503, COMPANION_DISABLED_ERROR, say('rest.companion-disabled'));
        return true;
      }
      if (fromAgent && !config.companionSessionsEnabled) {
        sendError(res, 503, COMPANION_SESSIONS_DISABLED_ERROR, say('rest.companion-sessions-disabled'));
        return true;
      }
      const expected = body.expectedConversation;
      const token = deps.conversationToken ?? conversationToken;
      try {
        // `await`, bo sesja przypięta do żywego panelu zapisuje załączniki i sprawdza guard
        // PRZED przejściem stanu — 400/429 ma wrócić jako odpowiedź na tego POST-a.
        const ack = await manager.sendMessage(
          sessionId, body.text, body.images, body.files, body.clientMessageId,
          {
            queueAware: body.queueAware === true, source: body.source,
            conversation: expected === undefined ? undefined : (agentSessionId) => token(agentSessionId) === expected,
          },
        );
        /*
         * Identyfikator wraca w odpowiedzi, a powtórka przyjętej wiadomości dokłada
         * `replayed: true` — klient wie wtedy, że echa tej odpowiedzi NIE będzie (poszło przy
         * pierwszym przyjęciu). Wysyłka bez identyfikatora nie dostaje ani identyfikatora, ani `replayed`.
         * `queued: true`: echo przyjdzie dopiero, gdy CLI weźmie prompt.
         */
        const accepted: MessageAccepted = body.clientMessageId === undefined
          ? { ok: true }
          : {
            ok: true, clientMessageId: body.clientMessageId,
            ...(ack.replayed ? { replayed: true } : {}),
            ...(ack.queued === true ? { queued: true } : {}),
          };
        sendJson(res, 202, accepted);
      } catch (err) {
        const status = managerErrorStatus(err);
        if (status === 500) log.error(`send-message: ${redact(err, secrets)}`);
        sendFailure(res, status, err, 'message');
      }
      return true;
    }

    /*
     * POST /api/sessions/:id/queue/take-back {operationId} → 200 {items, incomplete?}: the queued prompts come back to
     * the app (`docs/dialogs.md`, "Taking the queue back"). No deadline here: the driver step takes up to about 6 s
     * plus its wait behind a paste in the chain, an answer before it would carry nothing, and a client retry with the
     * same `operationId` joins the take-back in flight. 409 and 410 carry the manager's sentence.
     */
    if (action === 'queue' && segments.length === 5 && segments[4] === 'take-back') {
      const body = await readValidatedBody(req, res, config, queueTakeBackBodySchema);
      if (body === null) return true;
      return runManagerAction(res, log, secrets, async () => {
        sendJson(res, 200, await manager.takeBackQueue(sessionId, body.operationId));
      }, 'message');
    }

    if (action === 'interrupt' && segments.length === 4) {
      return runManagerAction(res, log, secrets, async () => {
        /*
         * Obietnica „klawisz doszedł" rozstrzyga się w kolejce drivera, a przed
         * `escape` bywa w niej cała długa wysyłka — dlatego czekamy z TERMINEM
         * (`INTERRUPT_WAIT_MS`) i po nim odpowiadamy uczciwym `pending`, zamiast trzymać
         * żądanie do timeoutu klienta. Powtórnego `escape` z tego czekania nie będzie:
         * idempotencję trzyma manager na własnych oknach, a nie ten endpoint.
         *
         * Odmowy (`outOfScope`, wyłącznik wysyłki) lecą z managera SYNCHRONICZNIE, więc
         * dalej wracają jako 400/409 z `runManagerAction` — mimo `async` tutaj.
         */
        const delivered = await waitForDelivery(manager.interrupt(sessionId), interruptWaitMs);
        /*
         * Odpowiedź niesie ŚWIEŻE `SessionSummary`, żeby widok po Esc nie czekał długo na stan.
         *
         * Przerwanie wychodzi natychmiast i `interrupt` przestawia stan SYNCHRONICZNIE,
         * więc `get` widzi już `waiting-input`. Problemem było to, że otwarty widok
         * dowiadywał się o tym WYŁĄCZNIE pushem SSE — a `EventSource`, który umarł po cichu
         * (QUIC/VPN gubi pakiety bez RST), nie zgłasza błędu i klient czeka na własnego
         * watchdoga (60–75 s). Odpowiedź na POST jedzie ŚWIEŻYM połączeniem, więc naprawia
         * stan także wtedy, gdy strumień milczy. Ring buffer i tak tego nie ratował:
         * `activity` jest ulotna (`seq === null`), więc replay po reconnekcie jej nie powtórzy.
         *
         * `ok: true` zostaje dla zgodności ze starszym klientem, który czyta sam status;
         * `delivered` jest polem ADDYTYWNYM i taki klient je zignoruje.
         */
        sendJson(res, 202, { ok: true, session: manager.get(sessionId), delivered });
      });
    }

    /*
     * POST /api/sessions/:id/close — DWA różne działania w jednym endpoincie.
     *
     * Bez ciała (albo bez `closePanel`) to UKRYCIE karty: panel żyje dalej w terminalu.
     * Z `closePanel: true` to `tab.close` — dozwolone wyłącznie dla panelu ze znacznikiem
     * Raroga, inaczej manager rzuca 409. Ciało jest opcjonalne, żeby stary klient (i każdy
     * `fetch` bez JSON-a) dalej trafiał w bezpieczniejszy z dwóch wariantów.
     */
    if (action === 'close' && segments.length === 4) {
      const raw = await readJsonBody(req, res, config.maxBodyBytes);
      if (raw === null) return true;
      const body = parseBody(res, closeBodySchema, raw.value);
      if (body === null) return true;
      return runManagerAction(res, log, secrets, async () => {
        await manager.close(sessionId, { closePanel: body?.closePanel === true });
        sendJson(res, 200, { ok: true });
      }, 'message');
    }

    if (action === 'resume' && segments.length === 4) {
      return runManagerAction(res, log, secrets, async () => {
        const session = await manager.resume(sessionId);
        sendJson(res, 200, { sessionId: session.id, session });
      });
    }

    /*
     * POST /api/sessions/:id/restart — restart żywej, bezczynnej sesji na nowszym Claude Code
     * Bez ciała albo z `{ resend: { seq, id } }`: „Uruchom ponownie i wyślij” pod notką
     * promptu zablokowanego przez hook. Tekstu ciało nie niesie — prompt do ponownej wysyłki bierze
     * manager ze swojego pierścienia wysyłek. Każda odmowa (400/404/409/429) przychodzi PRZED `/exit`,
     * z polskim zdaniem; 202 znaczy „`/exit` poszedł", a dalszy przebieg jedzie po SSE jako stan karty.
     */
    if (action === 'restart' && segments.length === 4) {
      const raw = await readJsonBody(req, res, config.maxBodyBytes);
      if (raw === null) return true;
      const body = parseBody(res, restartBodySchema, raw.value);
      if (body === null) return true;
      const resend = body?.resend;
      return runManagerAction(res, log, secrets, async () => {
        sendJson(res, 202, await manager.restart(sessionId, resend === undefined ? {} : { resend }));
      }, 'message');
    }

    /*
     * POST /api/sessions/:id/focus — `agent.focus`, czyli „Pokaż w herdr".
     *
     * 202, bo skutek jest NA MACU (panel wychodzi na wierzch w terminalu), a nie w tej
     * odpowiedzi. Jedyna akcja Raroga, która świadomie kasuje znacznik `done` panelu —
     * dlatego ma własny endpoint zamiast być efektem ubocznym czegokolwiek innego.
     */
    if (action === 'focus' && segments.length === 4) {
      return runManagerAction(res, log, secrets, async () => {
        await manager.focus(sessionId);
        sendJson(res, 202, { ok: true });
      }, 'message');
    }

    /*
     * POST /api/sessions/:id/seen — „obejrzałem ten wynik na telefonie".
     *
     * Znacznik jest lokalny, trwały i przebijany przez nowszy wynik panelu. Dokłada
     * się do niego `agent.focus` dla panelu stojącego na `done` — herdr innej dźwigni na
     * „obejrzane" nie ma, a bez niej badge „ukończone, nikt nie zajrzał" kłamałby po każdej sesji
     * obsłużonej z telefonu. Dalej 200 i dalej natychmiastowe: fokus leci w TLE, a jego
     * niepowodzenie nie jest błędem tego wywołania (znacznik lokalny stoi tak czy inaczej).
     *
     * The voice agent's pick-up (`docs/companion.md`, "Picking up a result"): the body `{by, stateSince, conversation}`
     * (all three or none, else the 400 of the schema) meets the gate of the mode's other routes (503), then the
     * catalogue's scope (the 404 of the turns route), and the manager refuses with a 409 anything but the result the
     * agent read (`markSeen` in `seen-marks.ts`: `waiting-input` with no decision card, the same `stateSince`, the
     * conversation of the token), all with no `await` after the body. The token becomes a check of a conversation id
     * as for a send. A body without `by` behaves as before with any flags.
     */
    if (action === 'seen' && segments.length === 4) {
      const body = await readValidatedBody(req, res, config, seenBodySchema);
      if (body === null) return true;
      const token = deps.conversationToken ?? conversationToken;
      const read = body.conversation;
      const pickUp = body.by === undefined || body.stateSince === undefined || read === undefined
        ? undefined
        : {
          by: body.by, stateSince: body.stateSince,
          conversation: (agentSessionId: string | undefined) => token(agentSessionId) === read,
        };
      if (pickUp !== undefined && (!config.companionEnabled || deps.companion === undefined)) {
        sendError(res, 503, COMPANION_DISABLED_ERROR, say('rest.companion-disabled'));
        return true;
      }
      if (pickUp !== undefined && !config.companionSessionsEnabled) {
        sendError(res, 503, COMPANION_SESSIONS_DISABLED_ERROR, say('rest.companion-sessions-disabled'));
        return true;
      }
      return runManagerAction(res, log, secrets, () => {
        if (pickUp !== undefined && manager.companionTarget(sessionId) === null) {
          sendError(res, 404, 'not-found', say('rest.companion-claude-only'));
          return;
        }
        manager.markSeen(sessionId, pickUp);
        sendJson(res, 200, { ok: true });
      }, 'message');
    }

    /*
     * POST /api/sessions/:id/unseen — „oznacz jako nieprzeczytane" z listy, odwrotność `…/seen`.
     *
     * Tylko znacznik lokalny: herdr nie umie postawić `done` z powrotem, więc nic tu nie idzie do
     * panelu i trasa nie podlega `RAROG_HERDR_SEND`. 200 także wtedy, gdy nie było czego cofnąć
     * (tura trwa, wynik już nieodebrany) — stan karty i tak przychodzi ramką `session-changed`.
     */
    if (action === 'unseen' && segments.length === 4) {
      return runManagerAction(res, log, secrets, () => {
        manager.markUnseen(sessionId);
        sendJson(res, 200, { ok: true });
      }, 'message');
    }

    /*
     * POST /api/sessions/:id/model — JEDYNA droga do `/model` i `/effort`.
     *
     * 202, a nie 200: komenda leci do panelu, a dialog potwierdzenia obsługuje się z ekranu
     * już PO odpowiedzi. Ciało niesie ostrzeżenie o skutku globalnym — to samo zdanie, które
     * arkusz w kliencie pokazał przed wysłaniem (`MODEL_CHANGE_WARNING` w kontrakcie).
     */
    if (action === 'model' && segments.length === 4) {
      const body = await readValidatedBody(req, res, config, sessionModelBodySchema);
      if (body === null) return true;
      if (!checkModel(body.model, manager)) {
        sendError(res, 400, 'model-unknown', say('model.unavailable'));
        return true;
      }
      try {
        sendJson(res, 202, await manager.setModel(sessionId, body));
      } catch (err) {
        // Własne mapowanie zamiast `runManagerAction`: komunikat 409/410 jest tu CZĘŚCIĄ
        // kontraktu z UI (arkusz modelu pokazuje go inline pod przyciskiem), więc nie może
        // zostać zastąpiony ogólnym „Sesja jest w stanie, który nie pozwala na tę akcję".
        const status = managerErrorStatus(err);
        if (status === 500) log.error(`set-model: ${redact(err, secrets)}`);
        sendFailure(res, status, err, 'model');
      }
      return true;
    }

    /*
     * POST /api/sessions/:id/mode — JEDYNA droga do `shift+tab`. 202 i mapowanie
     * błędów jak przy `/model`: komunikat 400/409 jest częścią kontraktu z pigułką trybu.
     */
    if (action === 'mode' && segments.length === 4) {
      const body = await readValidatedBody(req, res, config, sessionModeBodySchema);
      if (body === null) return true;
      try {
        sendJson(res, 202, await manager.setMode(sessionId, body));
      } catch (err) {
        const status = managerErrorStatus(err);
        if (status === 500) log.error(`set-mode: ${redact(err, secrets)}`);
        sendFailure(res, status, err, 'model');
      }
      return true;
    }

    /*
     * POST /api/sessions/:id/permission — odrzucenie dialogu stojącego w TERMINALU (3.5).
     *
     * Osobny endpoint od `/permissions/:permId` i to nie jest niekonsekwencja: dialog
     * w panelu herdr nie ma `permId`, bo Rarog nigdy go nie zarejestrował (sesja herdr
     * w `waiting-permission` ma PUSTĄ listę pending — 3.3). Adresem jest więc sama sesja.
     *
     * `deny` → `send_keys ['escape']` i wolno je ZAWSZE, poza pauzą „Session paused” (driver odmawia
     * 422 `terminal-only` po świeżym odczycie ekranu). `allow` przechodzi wyłącznie dla
     * dialogu rozpoznanego z zamkniętej listy sygnatur — rozstrzyga to manager
     * (409 z komunikatem), bo tylko on wie, co driver widzi na ekranie. Cyfry w tym żądaniu
     * NIE MA i mieć nie będzie: składa ją serwer z etykiety opcji.
     *
     * Over a standing layer 2 card `deny` is the card's "Esc to cancel" and goes only through the layer 2 step (422 on
     * any of its refusals), and `allow` never sends a key (`docs/dialog-card.md`, "Answer").
     */
    if (action === 'permission' && segments.length === 4) {
      const body = await readValidatedBody(req, res, config, permissionDecisionBodySchema);
      if (body === null) return true;
      try {
        const result = await manager.resolvePermission(
          sessionId, sessionId, body.decision, clientLabel(req, principal), body.message,
        );
        sendDecision(res, result);
      } catch (err) {
        // 400/409 niosą komunikat managera dosłownie („Zatwierdź w terminalu…",
        // „herdr jest w trybie tylko do odczytu…") — to jedyne wyjaśnienie, jakie
        // użytkownik zobaczy pod przyciskiem „Odrzuć dialog".
        const status = managerErrorStatus(err);
        if (status === 500) log.error(`herdr-deny: ${redact(err, secrets)}`);
        sendFailure(res, status, err, 'message');
      }
      return true;
    }

    if (action === 'permissions' && segments.length === 5) {
      const permId = decodeSegment(segments[4] ?? '');
      const body = await readValidatedBody(req, res, config, permissionDecisionBodySchema);
      if (body === null) return true;
      /*
       * `allow` przechodzi WYŁĄCZNIE dla karty, która ma cyfry z cross-checku jsonl ↔ ekran.
       * Rozstrzyga to manager — on jeden wie, czy driver ma czym zatwierdzić —
       * i odmawia 409 z komunikatem, zamiast oddać 200 na akcję, która nic nie zrobi.
       */
      return runManagerAction(res, log, secrets, async () => {
        const result = await manager.resolvePermission(
          sessionId, permId, body.decision, clientLabel(req, principal), body.message,
        );
        sendDecision(res, result);
      }, 'message');
    }

    if (action === 'answers' && segments.length === 5) {
      const qId = decodeSegment(segments[4] ?? '');
      const body = await readValidatedBody(req, res, config, answersBodySchema);
      if (body === null) return true;
      // Odpowiedź na `AskUserQuestion` jedzie cyfrą wybranej opcji ALBO plikiem hooka.
      // Na kanale cyfry wielokrotny wybór odrzuca manager (409), a wolny tekst — 400: cyfra
      // nie umie nic napisać w TUI. Sufit długości wartości stoi już w schemacie ciała.
      // Notatki sprawdza manager (400), a jadą wyłącznie plikiem hooka.
      return runManagerAction(res, log, secrets, async () => {
        const result = await manager.answerQuestion(sessionId, qId, body.answers, body.notes);
        sendDecision(res, result);
      }, 'message');
    }

    /*
     * POST /api/sessions/:id/companion/ask {question, clientRequestId} → {answer, found, prompt?}
     * (`docs/companion.md`): the voice agent asks the model about what happened in this session. Demo mode has no route
     * (404 as unknown). The gate, in order: the flag and the module (503), the body (400), a Claude Code session in
     * scope (404). The question is about the engine conversation the session writes now, read here and handed to
     * `companion/ask.ts` before its first `await`, so a `/clear` from then on reaches the question. It waits for
     * `claude -p` (up to 60 s); a closed request, a revoked device or a new engine conversation (`/clear`, `/resume`)
     * kills the process, and the response closes without a body.
     */
    if (action === 'companion' && segments.length === 5 && segments[4] === 'ask') {
      if (config.demo) {
        sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
        return true;
      }
      const companion = deps.companion;
      if (!config.companionEnabled || companion === undefined) {
        sendError(res, 503, COMPANION_DISABLED_ERROR, say('rest.companion-disabled'));
        return true;
      }
      const body = await readValidatedBody(req, res, config, companionAskBodySchema);
      if (body === null) return true;
      let target: CompanionTarget | null;
      try {
        target = manager.companionTarget(sessionId);
      } catch (err) {
        const status = managerErrorStatus(err);
        if (status === 500) log.error(`companion: ${redact(err, secrets)}`);
        sendFailure(res, status, err);
        return true;
      }
      if (target === null) {
        sendError(res, 404, 'not-found', say('rest.companion-claude-only'));
        return true;
      }
      // `close` before the end of the response = the client went away; `req` closes already after the body.
      const closed = new AbortController();
      res.once('close', () => { if (!res.writableFinished) closed.abort(); });
      if (req.socket.destroyed) closed.abort();
      const result = await companion.ask({
        sessionId, owner, cwd: target.cwd, agentSessionId: target.agentSessionId, question: body.question,
        signal: closed.signal,
      });
      if (result.kind === 'answer') {
        sendJson(res, 200, result.body);
      } else if (result.kind === 'refused') {
        sendError(res, result.status, result.error, companionSentence(result.error));
      } else {
        res.destroy();
      }
      return true;
    }
  }

  return false;
}

/** Sentence of a voice agent refusal. */
function companionSentence(error: CompanionRefusal): OwnText {
  switch (error) {
    case COMPANION_BUSY_ERROR: return say('rest.companion-busy');
    case COMPANION_LIMIT_ERROR: return say('rest.companion-limit');
    case COMPANION_CLI_ERROR: return say('rest.companion-cli');
    case COMPANION_TIMEOUT_ERROR: return say('rest.companion-timeout');
  }
}
