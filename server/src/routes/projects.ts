/**
 * Sources of the new-session window: projects (`/api/projects`, `/api/projects/recent`), resumable conversations of
 * a project (`/api/resumable`, `/api/resumable/recent`), models (`/api/models`), directory browsing (`/api/fs`) and
 * creating one directory in a listed directory (`/api/fs/mkdir`, the only write of the group, in `fs-mkdir.ts`).
 * `checkCwd` is the directory gate of every route that takes a project directory from the client.
 */
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_RECENT_PROJECTS, MAX_RECENT_SESSIONS, makeDirBodySchema } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { redact } from '../auth/index.ts';
import { type CwdCheck, type RarogConfig, validateProjectCwd } from '../config.ts';
import { type BrowseResult, browseDirectory, demoListing } from '../fs-browse.ts';
import { makeDirectory, mkdirRefusal } from '../fs-mkdir.ts';
import {
  managerErrorStatus, methodNotAllowed, readValidatedBody, recheckDevice, sendError, sendFailure, sendJson,
} from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import type { RouteContext, RouteRequest } from './context.ts';

/**
 * Sprawdza katalog roboczy podany przez klienta.
 *
 * Dwa źródła prawdy, świadomie rozdzielone:
 * - katalog z listy projektów (dropdown) przechodzi zawsze — także w demo, gdzie ścieżki
 *   seedów (`/Users/demo/Projects/...`) NIE istnieją na dysku,
 * - poza demo dowolna inna ścieżka („inna ścieżka…") musi przejść walidację korzeni:
 *   istniejący katalog wewnątrz `RAROG_PROJECT_ROOTS`, bez segmentów ukrytych.
 *
 * @returns znormalizowany katalog albo zdanie do odesłania w 400.
 */
export function checkCwd(
  cwd: string, config: RarogConfig, manager: ManagerApi,
): CwdCheck {
  /*
   * Ścieżka WZGLĘDNA (w tym pusta) musi odpaść, zanim dotknie `path.resolve` — a odpada tutaj,
   * a nie dopiero w `validateProjectCwd`, bo pierwsze pytanie („czy to jeden z projektów?")
   * zadajemy PRZED walidacją korzeni.
   *
   * `path.resolve('')` to katalog roboczy SERWERA, a poza demo serwer startuje zwykle wewnątrz
   * któregoś projektu — czyli `GET /api/resumable` bez `cwd` oddawałby po cichu listę sesji
   * TEGO projektu, a `POST /api/sessions` z `cwd: ""` zakładałby w nim sesję. To samo dotyczy
   * `.` i `..`. Kontrakt mówi 400, a `validateProjectCwd` jest fail-closed z założenia.
   *
   * Tylda zostaje przepuszczona surowa: rozwija ją `validateProjectCwd` (poza demo), a listy
   * projektów i tak nie trafi, bo tam ścieżki są już bezwzględne.
   */
  const raw = cwd.trim();
  if (raw === '') return { ok: false, sentence: say('rest.cwd-empty') };
  if (!path.isAbsolute(raw) && !raw.startsWith('~')) {
    return { ok: false, sentence: say('rest.cwd-not-absolute') };
  }
  const target = path.resolve(raw);
  if (manager.projects().some((p) => path.resolve(p.path) === target)) {
    return { ok: true, cwd: target };
  }
  if (config.demo) {
    return { ok: false, sentence: say('rest.cwd-not-in-projects') };
  }
  return validateProjectCwd(cwd, config.projectRoots);
}

/** Odsyła wynik `browseDirectory()` / `demoListing()` jako 200 albo 400/404. */
function sendBrowseResult(res: ServerResponse, result: BrowseResult): void {
  if (result.ok) {
    sendJson(res, 200, result.listing);
    return;
  }
  sendError(res, result.status, result.error, result.sentence);
}

export async function routeProjects(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, url, pathname } = rq;
  const { config, manager, log, secrets } = ctx;

  if (pathname === '/api/projects') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    sendJson(res, 200, { projects: manager.projects() });
    return true;
  }

  if (pathname === '/api/models') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    sendJson(res, 200, manager.models());
    return true;
  }

  if (pathname === '/api/fs') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const raw = url.searchParams.get('path');
    /*
     * Demo NIE dotyka dysku: ścieżki seedów (`/Users/demo/Projects/...`) nie istnieją, więc
     * prawdziwy `readdir` oddawałby 404 na każdym kroku, a wpuszczenie tu realnych korzeni
     * pokazywałoby prawdziwe katalogi człowieka w trybie pokazowym.
     */
    sendBrowseResult(res, config.demo
      ? demoListing(raw, manager.projects())
      : await browseDirectory(raw, { roots: config.projectRoots, canCreate: mkdirRefusal(config) === null }));
    return true;
  }

  /*
   * POST /api/fs/mkdir {parent, name} → 200 `DirEntry` of the new directory (`docs/implementation-spec.md`,
   * "Projects, directories and resumable sessions"). The body is read first, so the device check after the body
   * holds here as on every body route; `makeDirectory` then refuses in the demo and with a herdr killswitch off
   * (409 `mkdir-disabled`) before any disk access, and checks the device once more right before its child starts.
   * Its 401 is already sent.
   */
  if (pathname === '/api/fs/mkdir') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, makeDirBodySchema);
    if (body === null) return true;
    const result = await makeDirectory(body, {
      config,
      recheckDevice: () => recheckDevice(req, res, 'before creating a directory for'),
      log: (line) => { log.info(line); },
      secrets,
    });
    if (result.ok) sendJson(res, 200, result.entry);
    else if (result.status !== 401) sendError(res, result.status, result.error, result.sentence);
    return true;
  }

  if (pathname === '/api/projects/recent') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    /*
     * Bez bramki katalogu: odpowiedź to same ŚCIEŻKI z allow-listy (jak `GET /api/projects`),
     * bez jednego zdania rozmowy — filtr siedzi w managerze. `limit` jak w `/resumable/recent`:
     * ścinany do sufitu, śmieci = domyślna.
     */
    const raw = Number(url.searchParams.get('limit') ?? MAX_RECENT_PROJECTS);
    const limit = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), MAX_RECENT_PROJECTS)
      : MAX_RECENT_PROJECTS;
    try {
      sendJson(res, 200, { projects: await manager.recentProjects(limit) });
    } catch (err) {
      const status = managerErrorStatus(err);
      if (status === 500) log.error(`projects/recent: ${redact(err, secrets)}`);
      sendFailure(res, status, err);
    }
    return true;
  }

  if (pathname === '/api/resumable/recent') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    /*
     * Ta sama bramka katalogu co przy `/api/resumable` — obie listy czytają historię
     * KONKRETNEGO projektu i obie zdradzają pierwsze zdania cudzych rozmów. Różnica jest
     * w pytaniu: tamta oddaje całą historię katalogu z oznaczeniem otwartych, ta — kilka
     * ostatnich, które da się wznowić.
     */
    const check = checkCwd(url.searchParams.get('cwd') ?? '', config, manager);
    if (!check.ok) {
      sendError(res, 400, 'cwd-not-allowed', check.sentence);
      return true;
    }
    const raw = Number(url.searchParams.get('limit') ?? MAX_RECENT_SESSIONS);
    const limit = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), MAX_RECENT_SESSIONS)
      : MAX_RECENT_SESSIONS;
    try {
      sendJson(res, 200, { sessions: await manager.recentResumable(check.cwd, limit) });
    } catch (err) {
      const status = managerErrorStatus(err);
      if (status === 500) log.error(`resumable/recent: ${redact(err, secrets)}`);
      sendFailure(res, status, err);
    }
    return true;
  }

  if (pathname === '/api/resumable') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const check = checkCwd(url.searchParams.get('cwd') ?? '', config, manager);
    if (!check.ok) {
      sendError(res, 400, 'cwd-not-allowed', check.sentence);
      return true;
    }
    try {
      sendJson(res, 200, { sessions: await manager.resumable(check.cwd) });
    } catch (err) {
      const status = managerErrorStatus(err);
      if (status === 500) log.error(`resumable: ${redact(err, secrets)}`);
      sendFailure(res, status, err);
    }
    return true;
  }

  return false;
}
