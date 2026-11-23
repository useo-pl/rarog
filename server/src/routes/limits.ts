/**
 * Claude plan limits: `/api/usage` (5 h and week from the Claude Code status line) and `/api/usage/details`
 * (the per-model read Claude Code saved itself). No token, no network (`usage.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { say } from '@rarog/shared/sentences';
import { methodNotAllowed, sendError, sendJson } from '../router.ts';
import type { RouteContext, RouteRequest } from './context.ts';

export async function routeLimits(
  ctx: RouteContext, _req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, pathname } = rq;
  const { usageProvider, system } = ctx;

  /*
   * Limity planu Claude (5h / tydzień) z paska statusu Claude Code: procenty, daty
   * resetów, chwila zrzutu i e-mail konta z `~/.claude.json` — nic więcej, patrz
   * `usage.ts`. Rarog nie czyta tokenu konta i nie woła API Anthropic. 503 znaczy „nie wiem"
   * (żaden zrzut nie ma żywego okna) i UI ma to pokazać słowem, nie błędem.
   */
  if (pathname === '/api/usage') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    void usageProvider.get().then((usage) => {
      if (usage === null) {
        // Słowo maszyny jak w apce (`ServerMachine`): macOS to Mac, każdy inny system to VPS.
        sendError(res, 503, 'usage-unavailable', system === 'macos'
          ? say('rest.usage-unavailable.mac')
          : say('rest.usage-unavailable.vps'));
        return;
      }
      sendJson(res, 200, usage);
    });
    return true;
  }

  /*
   * Szczegóły limitów dla arkusza „Limity” komendy apki `/usage`: odczyt limitów,
   * który Claude Code zapisał sam w `~/.claude.json` (`cachedUsageUtilization`) — 5 h, tydzień
   * i tydzień per model z WŁASNĄ chwilą odczytu w `fetchedAt`. Ten sam kształt co `GET /api/usage`
   * (`planUsageSchema`), bez `source`. `{}` = odczytu nie ma (brak klucza, inne konto) — 200, nie
   * błąd: arkusz ma wtedy 5 h i tydzień z `GET /api/usage`. Bez tokenu i bez sieci.
   */
  if (pathname === '/api/usage/details') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    void usageProvider.details().then((usage) => { sendJson(res, 200, usage); });
    return true;
  }

  return false;
}
