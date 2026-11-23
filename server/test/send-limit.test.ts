/**
 * Kontrakt limitu czasu wysyłki wiadomości z załącznikiem.
 *
 * On an iPad over a slow link (Tailscale relay, ~45 kB/s) a 390 kB photo reaches the pane after 11.7 s,
 * so a client that aborts every POST after the general 10 s reports a failed send, and larger photos are
 * lost halfway through the body. The rule "the client waits longer than the server" applies here too:
 * limit klienta > najgorszy czas serwera przed odpowiedzią (ciało + odczyt trybu + zapas).
 *
 * Klientem jest apka natywna: jej limit to `RarogStore.attachmentSendTimeout`
 * w `RarogCore`. Typecheck serwera nie widzi Swifta, więc test czyta stałą ze źródła.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BODY_TIMEOUT_MS } from '../src/router.ts';
import {
  CONNECT_TIMEOUT_MS as HERDR_CONNECT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS as HERDR_REQUEST_TIMEOUT_MS,
} from '../src/herdr/socket.ts';

/** Zapas klienta ponad serwer: zapis załączników na dysk, tailnet, przekład błędu na odpowiedź. */
const ZAPAS_MS = 5_000;

const SWIFT_SEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../native/Rarog/Packages/RarogCore/Sources/RarogCore/RarogStore+Send.swift',
);

/** `attachmentSendTimeout: Duration = .seconds(N)` ze źródła apki, w milisekundach. */
function appAttachmentTimeoutMs(): number {
  const match = /attachmentSendTimeout: Duration = \.seconds\((\d+)\)/.exec(readFileSync(SWIFT_SEND, 'utf8'));
  expect(match, `brak attachmentSendTimeout w ${SWIFT_SEND}`).not.toBeNull();
  return Number(match?.[1]) * 1000;
}

describe('limit klienta a najgorszy czas serwera dla POST /messages', () => {
  it('apka czeka dłużej niż ciało + odczyt trybu panelu z gniazda herdr', () => {
    // Router czyta ciało do BODY_TIMEOUT_MS; manager przed odpowiedzią czyta stopkę panelu
    // (`#freshMode` — jedno żądanie gniazda: połączenie + odpowiedź) i zapisuje załączniki.
    const najgorszySerwer = BODY_TIMEOUT_MS + HERDR_CONNECT_TIMEOUT_MS + HERDR_REQUEST_TIMEOUT_MS;
    expect(appAttachmentTimeoutMs()).toBeGreaterThanOrEqual(najgorszySerwer + ZAPAS_MS);
  });
});
