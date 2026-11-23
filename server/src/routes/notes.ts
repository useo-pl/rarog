/**
 * Project notes route `/api/notes` (`GET` reads, `PUT` writes the whole document), behind `RAROG_NOTES`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NOTES_BODY_MAX_BYTES, notesEmpty, notesPutBodySchema } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { redact } from '../auth/index.ts';
import { NotesFailure } from '../notes/store.ts';
import { methodNotAllowed, readValidatedBody, sendError, sendJson } from '../router.ts';
import type { RouteContext, RouteRequest } from './context.ts';
import { checkCwd } from './projects.ts';

/**
 * Notatki projektu — DWIE czynności na JEDNEJ ścieżce.
 *
 * `GET /api/notes?cwd=` oddaje cały dokument, `PUT /api/notes` zapisuje go w całości.
 * Kasowania nie ma osobno: pusty `text` JEST skasowaniem treści. Killswitch sprawdza
 * WOŁAJĄCY, więc tutaj zostaje wyłącznie to, co dotyczy samych notatek.
 *
 * Mapa kodów jest zamknięta i każdy niesie inną instrukcję: 400 „nie ten katalog"
 * (`checkCwd` albo `realpath` na nieistniejącym katalogu), 409 „ktoś je zmienił" z AKTUALNĄ
 * treścią w ciele, 500 „zapis się nie udał" (a nie ciche „ok", bo notatek nikt poza
 * właścicielem nie odtworzy).
 */
async function handleNotes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config, manager, hub, notes, log, secrets } = ctx;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'PUT') {
    methodNotAllowed(res, 'GET, PUT');
    return;
  }

  /*
   * `cwd` jedzie w QUERY przy odczycie, a w CIELE przy zapisie — dokładnie jak w reszcie
   * routera (`GET /api/resumable?cwd=` kontra `POST /api/sessions {cwd}`), żeby nie zakładać
   * drugiej konwencji na jednym zasobie.
   */
  let rawCwd: string;
  let text = '';
  let expectedUpdatedAt = 0;
  if (method === 'PUT') {
    const body = await readValidatedBody(
      req, res, config, notesPutBodySchema, NOTES_BODY_MAX_BYTES,
    );
    if (body === null) return;
    text = body.text;
    expectedUpdatedAt = body.updatedAt;
    rawCwd = body.cwd;
  } else {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    rawCwd = url.searchParams.get('cwd') ?? '';
  }

  const check = checkCwd(rawCwd, config, manager);
  if (!check.ok) {
    sendError(res, 400, 'cwd-not-allowed', check.sentence);
    return;
  }
  const cwd = check.cwd;

  try {
    if (method === 'GET') {
      sendJson(res, 200, notes.read(cwd));
      return;
    }
    const saved = notes.write(cwd, text, expectedUpdatedAt);
    /*
     * Zapis poszedł → wszyscy otwarci klienci mają się dowiedzieć, że ten projekt się zmienił.
     * `empty` to jedyny bit o TREŚCI, jaki ramka niesie: pigułka ✎ podświetla projekt
     * z notatką, a liczy to serwer, bo tylko on wie, co faktycznie leży na dysku po zapisie.
     */
    hub.broadcast('global', null, { type: 'notes', cwd, empty: notesEmpty(saved.text) });
    sendJson(res, 200, { updatedAt: saved.updatedAt });
  } catch (err) {
    if (err instanceof NotesFailure) {
      if (err.code === 'cwd-not-allowed') {
        sendError(res, 400, 'cwd-not-allowed', err.sentence);
        return;
      }
      // 409 z AKTUALNYM dokumentem w ciele: front stawia obie treści obok siebie i pozwala
      // wybrać świadomie, zamiast skasować cudzą wersję albo zjeść tekst spod palca.
      sendError(res, 409, 'conflict', err.sentence, { current: err.current ?? { text: '', updatedAt: 0 } });
      return;
    }
    // Nieudany zapis to 500, nigdy ciche „ok" — patrz nagłówek `notes/store.ts`.
    log.error(`notes: ${redact(err, secrets)}`);
    sendError(res, 500, 'internal', say('rest.notes-save-failed'));
  }
}

export async function routeNotes(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { pathname } = rq;
  const { config } = ctx;

  /*
   * NOTATKI PROJEKTU — JEDNA ścieżka `/api/notes`, jeden dokument na projekt.
   *
   * Obie metody za kluczem urządzenia, obie przez `checkCwd` (ta sama bramka katalogu co
   * `GET /api/resumable`) i obie za killswitchem `RAROG_NOTES`. Notatki NIE należą do sesji,
   * więc nie ma ich pod `/api/sessions/:id` i nie ma ich w ring bufferze: zapis rozsyła
   * ulotny event `notes` (sam `cwd`), a stan startowy klient bierze GET-em.
   *
   * Serwer NIE wystawia notatek sesjom Claude — to jest notes dla człowieka i nie ma żadnej
   * drogi, którą treść stąd wchodziłaby do promptu agenta (`docs/security-model.md`).
   */
  if (pathname === '/api/notes') {
    if (!config.notesEnabled) {
      sendError(res, 404, 'not-found', say('rest.notes-disabled'));
      return true;
    }
    await handleNotes(ctx, req, res);
    return true;
  }

  return false;
}
