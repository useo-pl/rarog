/**
 * Emergency console routes under `/api/term`: list and open a project terminal, read its history as text, close it.
 * The WebSocket upgrade of `GET /api/term/:id` does not pass through here (`term/ws.ts`). Without the terminal
 * feature (`deps.term` missing) every route is 404 `term.disabled`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TERM_HISTORY_DEFAULT_LINES, TERM_HISTORY_MAX_LINES, termOpenBodySchema } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { validateProjectCwd } from '../config.ts';
import { methodNotAllowed, readValidatedBody, sendError, sendJson } from '../router.ts';
import { type RouteContext, type RouteRequest, decodeSegment } from './context.ts';

export async function routeTerminal(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, url, pathname, segments } = rq;
  const { deps, config } = ctx;

  /*
   * POST /api/term {cwd, slot?, role?} → {id, slot, role} — rejestracja terminala PROJEKTU.
   * Role popupowe (`lazygit`, `popup`) to panele poza slotami: `slot`
   * jest wtedy w ciele zabroniony, a w odpowiedzi wraca `0`.
   *
   * Klient NIGDY nie podaje `cwd` przy upgrade WS: ścieżka wchodzi do rejestru wyłącznie
   * tędy i wyłącznie przez `validateProjectCwd` (realpath + `RAROG_PROJECT_ROOTS`) — tą
   * samą bramką, co reszta serwera. Idempotentne: ta sama para `(realpath, slot)` → to samo
   * id, więc klient po restarcie Raroga woła POST i dostaje ten sam terminal.
   */
  if (pathname === '/api/term') {
    /*
     * GET — lista terminali dla sidebaru, żeby żywy terminal był widoczny także po
     * wyjściu z widoku. Źródłem jest rejestr, który po
     * restarcie Raroga odbudowuje adopcja z herdr (`adoptSurvivors`), więc lista nie
     * zależy od pamięci klienta.
     */
    if (method === 'GET') {
      if (deps.term === undefined) {
        sendError(res, 404, 'not-found', say('term.disabled'));
        return true;
      }
      sendJson(res, 200, { terminals: deps.term.list() });
      return true;
    }
    if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
    if (deps.term === undefined) {
      sendError(res, 404, 'not-found', say('term.disabled'));
      return true;
    }
    const body = await readValidatedBody(req, res, config, termOpenBodySchema);
    if (body === null) return true;
    const check = validateProjectCwd(body.cwd, config.projectRoots);
    if (!check.ok) {
      sendError(res, 400, 'cwd-not-allowed', check.sentence);
      return true;
    }
    /*
     * Brak `slot` w ciele = slot 1, czyli DOKŁADNIE dotychczasowe zachowanie: klient sprzed
     * tabów wysyła samo `{cwd}` i wchodzi w ten sam terminal co zawsze (id slotu 1 to
     * niezmieniony `sha256(realpath(cwd))`). Zakres 1…`TERM_SLOTS_MAX` i literał `'next'`
     * egzekwuje schemat, więc rejestr dostaje tu wyłącznie wartości z kontraktu.
     */
    /*
     * Rola: brak = `'shell'`, czyli dotychczasowy terminal projektu. Przy roli
     * popupowej (`'lazygit'`, `'popup'`) numeru slotu w ciele NIE MA (pilnuje tego schemat),
     * a rejestr i tak go ignoruje — taki panel stoi poza slotami i dostaje `slot: 0`.
     */
    const opened = deps.term.open(check.cwd, body.slot ?? 1, body.role ?? 'shell');
    if (!opened.ok) {
      /*
       * 409, a nie 400: „zamknij jeden terminal i spróbuj znowu" to inna instrukcja niż
       * „ta ścieżka nigdy nie przejdzie". Tym samym kodem odpowiadają odmowy backendu
       * panelowego (`herdr-launch-off`, `herdr-send-off`) — stan JEST do naprawienia,
       * tylko nie z telefonu: killswitche siedzą w środowisku serwera. Kod błędu jedzie
       * do klienta dosłownie, żeby klient mógł pokazać właściwe zdanie zamiast „internal".
       */
      // The terminal registry supplies its own sentence; it has no typed sentence code.
      sendError(
        res,
        opened.error === 'spawn' ? 500 : 409,
        opened.error === 'spawn' ? 'internal' : opened.error === 'limit' ? 'term-limit' : opened.error,
        opened.sentence,
      );
      return true;
    }
    // `slot` w odpowiedzi, bo przy `slot: 'next'` klient go NIE ZNA — numer wybrał serwer.
    // `role` z tego samego powodu: przy lazygicie `slot` to `0` i bez roli klient musiałby
    // wnioskować z zera, czym jest wpis, który właśnie dostał.
    sendJson(res, 200, { id: opened.id, slot: opened.slot, role: opened.role });
    return true;
  }

  /*
   * GET /api/term/:id/history?lines=N — historia powłoki jako ZWYKŁY TEKST.
   *
   * Trasa istnieje po to, żeby dało się skopiować z telefonu DŁUŻSZY fragment: xterm.js nie
   * ma zaznaczania dotykiem (xtermjs/xterm.js#3727), a scrollback nie leży w xtermie, tylko
   * w panelu herdr. Klient pokazuje ten tekst z natywną selekcją iOS.
   *
   * `GET`, więc BEZ bramki Origin (jak reszta odczytów; cudza strona nie ma klucza urządzenia, a bez
   * nagłówka `Authorization` jest 401) — ale za auth, bo w ciele jedzie treść powłoki.
   * `RAROG_HERDR_SEND=0` tej trasy NIE gasi: `pane.read` jest metodą czytającą, a „widzę,
   * nie ruszam" to dokładnie ten tryb, w którym czytanie własnej historii jest wartością.
   * Gasi ją wyłącznie `RAROG_TERM=0`, razem z resztą terminala.
   */
  if (
    segments[0] === 'api' && segments[1] === 'term'
    && segments.length === 4 && segments[3] === 'history'
  ) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    if (deps.term === undefined) {
      sendError(res, 404, 'not-found', say('term.disabled'));
      return true;
    }
    /*
     * `lines` ŚCINAMY do sufitu zamiast odrzucać — ta sama reguła co przy `limit`
     * w `/api/resumable/recent`: „za dużo linii" nie jest błędem człowieka, tylko końcem
     * tego, co Rarog umie pokazać. Śmieć (`?lines=abc`) wraca do wartości domyślnej.
     */
    const rawLines = Number(url.searchParams.get('lines') ?? TERM_HISTORY_DEFAULT_LINES);
    const lines = Number.isFinite(rawLines) && rawLines > 0
      ? Math.min(Math.floor(rawLines), TERM_HISTORY_MAX_LINES)
      : TERM_HISTORY_DEFAULT_LINES;
    const history = await deps.term.history(decodeSegment(segments[2] ?? ''), lines);
    if (!history.ok) {
      // 404 = „nie ma takiego terminala" ALBO „panel spod uchwytu nie jest już nasz";
      // z zewnątrz to jedna odpowiedź, żeby nie zdradzać istnienia cudzego panelu.
      sendError(res, history.error === 'not-found' ? 404 : 503, history.error, history.sentence);
      return true;
    }
    // Treść NIE jest logowana ani buforowana (`sendJson` daje `Cache-Control: no-store`).
    sendJson(res, 200, { text: history.text, truncated: history.truncated });
    return true;
  }

  /*
   * DELETE /api/term/:id — jawne „zamknij terminal" (`pane.close` TEGO panelu).
   *
   * Normalna droga końca życia powłoki, symetryczna do otwarcia. Drugim mechanizmem
   * jest żniwiarz bezczynności przy starcie serwera (`RAROG_TERM_IDLE_DAYS`).
   */
  if (segments[0] === 'api' && segments[1] === 'term' && segments.length === 3) {
    if (method !== 'DELETE') return methodNotAllowed(res, 'DELETE');
    if (deps.term === undefined) {
      sendError(res, 404, 'not-found', say('term.disabled'));
      return true;
    }
    if (!deps.term.close(decodeSegment(segments[2] ?? ''))) {
      sendError(res, 404, 'not-found', say('term.not-found'));
      return true;
    }
    sendJson(res, 200, {});
    return true;
  }

  return false;
}
