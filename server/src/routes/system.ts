/**
 * System routes: `/health` (no device key; the fields only for a loopback caller), `/api/version`, `/api/mac`,
 * `/api/client-log`, the global SSE stream `/api/stream`, the temporary dictation key `/api/voice/token`, the
 * short-lived OpenAI key of the voice agent `/api/companion/token`, its temporary Soniox speech key
 * `/api/companion/speech-token` and its session catalog `/api/companion/sessions`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { PROTOCOL_VERSION, clientLogBodySchema } from '@rarog/shared';
import {
  COMPANION_DISABLED_ERROR, COMPANION_SESSIONS_DISABLED_ERROR, companionSpeechTokenBodySchema, companionTokenBodySchema,
} from '@rarog/shared/rest';
import type { VersionResponse } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { redact } from '../auth/index.ts';
import { appendClientLog, clientTag } from '../client-log.ts';
import { companionCatalog } from '../companion/catalog.ts';
import { conversationToken } from '../companion/conversation.ts';
import { HEALTH_ALIVE, fullHealthAllowed, healthPayload, readHookHealth } from '../health.ts';
import {
  clientLabel, methodNotAllowed, readValidatedBody, recheckDevice, sendError, sendJson,
} from '../router.ts';
import { SERVER_CAPABILITIES } from '../version.ts';
import type { RouteContext, RouteRequest } from './context.ts';

/**
 * Ciało `POST /api/voice/token`: puste i takie ma zostać.
 *
 * Schemat istnieje po to, żeby ciało z polami („model", „język") było twardym 400, a nie
 * cicho ignorowanym życzeniem klienta — parametry strumienia ustala serwer.
 */
const voiceTokenBodySchema = z.strictObject({});

export async function routeSystem(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, pathname, principal, owner } = rq;
  const {
    deps, config, hub, serverStartId, startedAtMs, apns, system, voice, companionToken, companionAvailable,
    companionSessionsAvailable, companionSpeechToken, healthProbes, log, secrets,
  } = ctx;

  if (pathname === '/health') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    // The fields only for a loopback caller; anyone else gets `{"ok":true}` and runs no probe.
    sendJson(res, 200, fullHealthAllowed(req)
      ? await healthPayload(config.version, startedAtMs, healthProbes)
      : HEALTH_ALIVE);
    return true;
  }

  if (pathname === '/api/version') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const hookHealth = readHookHealth(healthProbes);
    sendJson(res, 200, {
      version: config.version,
      protocolVersion: PROTOCOL_VERSION,
      serverStartId,
      /*
       * Jedyny styk, po którym klient wie, czy pokazać mikrofon (nigdy martwy przycisk).
       * Świadomie tutaj, a nie w `herdrStatus`: dyktowanie nie ma nic wspólnego z herdr,
       * a `/api/version` klient i tak odpytuje przy starcie (sonda poświadczenia).
       */
      voiceEnabled: voice.available,
      /*
       * Ten sam precedens co `voiceEnabled` i ten sam powód: klient ma wiedzieć, czy pokazać
       * wiersz „Terminal", zanim ktokolwiek w niego stuknie. Wyłączony `RAROG_TERM`
       * (albo nieudane złożenie modułu) = wiersza nie ma, zamiast wiersza oddającego 404.
       */
      termEnabled: deps.term !== undefined,
      /*
       * Ten sam styk i ten sam powód co wyżej: nagłówek AGENCI ma powiedzieć, w którym
       * tailnecie stoi serwer, a `/api/version` klient i tak odpytuje
       * na starcie. `null` = nie wiemy albo Tailscale nie działa — klient wtedy milczy, zamiast
       * pokazywać nieaktualną nazwę. Endpoint jest ZA AUTH (nie ma go w `PUBLIC_PATHS`),
       * więc nazwa tailnetu nie wycieka nikomu bez klucza urządzenia.
       */
      tailnet: deps.tailnet === undefined ? null : await deps.tailnet(),
      /*
       * Wiek ostatniego odpalenia hooka treści w sekundach; `null` = nie odpalił ani razu.
       *
       * Świadomie TUTAJ, a nie na `/health`: `/health` jest publiczny
       * (`PUBLIC_PATHS`), a znacznik `hook-seen.json` pisze się przy KAŻDYM dialogu w każdej
       * sesji Claude pod korzeniami Raroga — także w tych prowadzonych przy biurku, których
       * Rarog nigdy nie pokazuje. Odpytywana w pętli, z rozdzielczością 1 s, składa się
       * w profil aktywności człowieka; `/health` ma nieść WYŁĄCZNIE stan konfiguracji
       * i żywotność (`hook` = `ok`/`brak`/`mismatch`/`stale` zostaje tam).
       */
      hookSeenAgo: hookHealth.seenAgo,
      /*
       * Ten sam wiek per plik wejściowy kopii hooka (okres przejściowy zmiany nazwy): który plik Claude Code
       * jeszcze woła. Ten sam powód co wyżej, więc też wyłącznie tutaj; bez znaczników per plik klucza nie ma.
       */
      ...(hookHealth.seenAgoByFile === undefined ? {} : { hookSeenAgoByFile: hookHealth.seenAgoByFile }),
      /*
       * Ten sam precedens co `voiceEnabled`/`termEnabled`: klient ma wiedzieć, czy
       * pokazać wejście do notatek projektu, ZANIM ktokolwiek w nie stuknie (w dawnej PWA
       * pigułka ✎). `RAROG_NOTES=0` = wejścia nie ma, zamiast wejścia otwierającego 404.
       */
      notesEnabled: config.notesEnabled,
      /*
       * Voice agent (`docs/companion.md`), the same precedent: the app shows its button only when the routes
       * answer. `false` with `RAROG_COMPANION=0`, without an OpenAI key, without the Soniox voice (no Soniox key or a
       * key outside the EU region), in demo mode and when the module is missing.
       */
      companionEnabled: companionAvailable,
      /*
       * The voice agent speaks with the Soniox voice. It has no other voice, so the field equals `companionEnabled`;
       * it stays in the contract for apps that read it.
       */
      companionSpeech: companionAvailable,
      // The mode across sessions (`docs/companion.md`, "Turns route"): present only when it works, never `false`.
      ...(companionSessionsAvailable ? { companionSessions: true as const } : {}),
      /*
       * Kanał APNs apki natywnej — ten sam precedens co flagi wyżej: apka ma wiedzieć,
       * czy proponować „Włącz powiadomienia", zanim ktoś stuknie.
       */
      apnsEnabled: apns !== undefined,
      /*
       * Możliwości po nazwie (`version.ts`) — apka sprawdza, czy serwer umie to, czego ona
       * potrzebuje, zamiast porównywać numery wersji. Dziś pusta lista (kopia stałej `readonly`).
       */
      capabilities: [...SERVER_CAPABILITIES],
      /*
       * System maszyny serwera (`serverSystem` w `version.ts`): apka bierze z niego słowo maszyny, „Mac” albo
       * „VPS”. Pole jest zawsze; klient czyta brak (serwer sprzed pola) jako „nie wiem”.
       */
      system,
      /*
       * Serwer iroh: EndpointId i relay, te same co `k=`/`r=` linku parowania. Serwer bez
       * nasłuchu iroh pisze `null` (klucz stoi, jak `tailnet`).
       */
      iroh: deps.iroh ?? null,
    } satisfies VersionResponse);
    return true;
  }

  /*
   * POST /api/voice/token — klucz TYMCZASOWY Soniox.
   *
   * Endpoint nie przyjmuje żadnych parametrów i nigdy ich nie przyjmie: wszystko, co
   * konfiguruje strumień (region, model, format, limity), jest decyzją serwera. Ciało
   * czytamy wyłącznie po to, żeby domknąć żądanie i utrzymać limit 64 kB.
   */
  if (pathname === '/api/voice/token') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, voiceTokenBodySchema);
    if (body === null) return true;
    const result = await voice.mint();
    if (!result.ok) {
      sendError(res, result.status, result.error, result.sentence);
      return true;
    }
    // `sendJson` ustawia `Cache-Control: no-store` na KAŻDEJ odpowiedzi API — dla tej
    // jednej to nie jest higiena, tylko wymóg: w ciele jedzie klucz.
    sendJson(res, 200, result.token);
    return true;
  }

  /*
   * POST /api/companion/token → {value, expiresAt, model} (`docs/companion.md`, "Short-lived OpenAI key"): a
   * short-lived OpenAI Realtime key for the voice agent. Demo mode has no route (404 as unknown). The body is empty;
   * any field is a 400 before the network. Without the Soniox voice there is no voice agent, so no OpenAI key either
   * (503 `companion-disabled`, before the network). A closed request cancels the request to OpenAI. After the key
   * arrives the device is checked again: a device revoked meanwhile gets 401 and the key is dropped (it expires on its
   * own).
   */
  if (pathname === '/api/companion/token') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    if (config.demo) {
      sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
      return true;
    }
    const body = await readValidatedBody(req, res, config, companionTokenBodySchema);
    if (body === null) return true;
    // The minter's own refusals (flag off, no OpenAI key) keep their sentences; the missing voice gets its own.
    if (companionToken.available && !companionAvailable) {
      const noKey = (config.sonioxApiKey?.trim() ?? '') === '';
      sendError(res, 503, COMPANION_DISABLED_ERROR,
        say(noKey ? 'rest.companion-speech-key-missing' : 'rest.companion-speech-disabled'));
      return true;
    }
    const closed = new AbortController();
    res.once('close', () => { if (!res.writableFinished) closed.abort(); });
    if (req.socket.destroyed) closed.abort();
    const result = await companionToken.mint(closed.signal);
    if (result.kind === 'cancelled' || closed.signal.aborted) {
      res.destroy();
      return true;
    }
    if (result.kind === 'refused') {
      sendError(res, result.status, result.error, result.sentence);
      return true;
    }
    if (!recheckDevice(req, res, 'while minting a voice agent key for')) return true;
    // `sendJson` sets `Cache-Control: no-store` on every API response; here the body carries a key.
    sendJson(res, 200, result.token);
    return true;
  }

  /*
   * POST /api/companion/speech-token → {apiKey, expiresAt, webSocketUri, model, voice, sampleRate}
   * (`docs/companion.md`, "Temporary Soniox speech key"): a temporary Soniox text-to-speech key for the voice agent's
   * voice, one per conversation. Demo mode has no route (404
   * as unknown). The body is empty; any field is a 400 before the network. After the key arrives the device is checked
   * again: a device revoked meanwhile gets 401 and the key is dropped (it expires on its own).
   */
  if (pathname === '/api/companion/speech-token') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    if (config.demo) {
      sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
      return true;
    }
    const body = await readValidatedBody(req, res, config, companionSpeechTokenBodySchema);
    if (body === null) return true;
    const result = await companionSpeechToken.mint();
    if (!result.ok) {
      sendError(res, result.status, result.error, result.sentence);
      return true;
    }
    if (!recheckDevice(req, res, 'while minting a voice agent speech key for')) return true;
    // `sendJson` sets `Cache-Control: no-store` on every API response; here the body carries a key.
    sendJson(res, 200, result.token);
    return true;
  }

  /*
   * GET /api/companion/sessions → {sessions: [{id, asksOwner?, conversation, stateSince}]} (`docs/companion.md`,
   * "Session catalog"): the voice agent's session catalog, built from the server's memory. Demo mode has no route (404
   * as unknown). The gate, in order, as for the turns route: the voice agent (503 `companion-disabled`), the mode
   * across sessions (503 `companion-sessions-disabled`). The catalog and the answer follow the gate with no `await`.
   */
  if (pathname === '/api/companion/sessions') {
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
    sendJson(res, 200, companionCatalog(ctx.manager, deps.conversationToken ?? conversationToken));
    return true;
  }

  /*
   * Obciążenie Maca — CPU (średnia z minuty), RAM (presja) i dysk (zajęte) w procentach, krok 5;
   * brak pola = brak odczytu, pusty obiekt = żadnego. Ten sam kształt co `mac` w stanie Live Activity
   * (`liveActivityMacSchema`) i te same liczby, bo czyta je ten sam próbnik. Apka pyta co 30 s
   * wyłącznie na wierzchu; odpowiedź z pamięci, bez I/O w żądaniu.
   */
  if (pathname === '/api/mac') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    sendJson(res, 200, deps.mac?.() ?? {});
    return true;
  }

  if (pathname === '/api/client-log') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, clientLogBodySchema);
    if (body === null) return true;
    try {
      const written = await appendClientLog(config, body.events, {
        client: clientTag(req.headers['user-agent'], clientLabel(req, principal)),
      });
      sendJson(res, 202, { ok: true, written });
    } catch (err) {
      log.error(`client-log: ${redact(err, secrets)}`);
      sendError(res, 500, 'internal', say('rest.client-log-failed'));
    }
    return true;
  }

  if (pathname === '/api/stream') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    // `Accept-Encoding` decyduje o kompresji strumienia (`RAROG_SSE_GZIP`).
    hub.openGlobal(res, owner, req.headers['accept-encoding']);
    return true;
  }

  return false;
}
