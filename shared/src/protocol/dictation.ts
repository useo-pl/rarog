/**
 * Protocol contract, dictation area: the temporary Soniox key (`POST /api/voice/token`).
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dyktowanie — klucz tymczasowy Soniox
// ---------------------------------------------------------------------------

/**
 * Odpowiedź `POST /api/voice/token`.
 *
 * `apiKey` jest kluczem TYMCZASOWYM (60 s na otwarcie strumienia, `single_use`) — klucz stały
 * nie opuszcza Maca. Ten obiekt jest jedyną rzeczą, którą telefon dostaje przed
 * połączeniem z Soniox, więc niesie też adres strumienia i całą konfigurację audio: klient
 * nie ma prawa zgadywać ani hosta (region UE), ani formatu (`pcm_s16le`).
 *
 * **`apiKey` NIGDY nie wchodzi do żadnego logu — ani serwera, ani `client-log`.**
 */
export interface VoiceToken {
  apiKey: string;
  /** ISO 8601 z Soniox; dotyczy OTWARCIA strumienia, nie czasu trwania sesji. */
  expiresAt: string;
  webSocketUri: string;
  model: string;
  /** Sufit długości jednej sesji dyktowania w sekundach (UI ostrzega od 13. minuty). */
  maxSessionSeconds: number;
  config: {
    languageHints: string[];
    audioFormat: string;
    sampleRate: number;
    numChannels: number;
  };
}

export const voiceTokenSchema = z.object({
  apiKey: z.string(),
  expiresAt: z.string(),
  webSocketUri: z.string(),
  model: z.string(),
  maxSessionSeconds: z.number(),
  config: z.object({
    languageHints: z.array(z.string()),
    audioFormat: z.string(),
    sampleRate: z.number(),
    numChannels: z.number(),
  }),
});

type _VoiceTokenSchemaMatchesType = z.infer<typeof voiceTokenSchema> extends VoiceToken ? true
  : never;
type _VoiceTokenTypeMatchesSchema = VoiceToken extends z.infer<typeof voiceTokenSchema> ? true
  : never;
const _voiceTokenSchemaMatchesType: _VoiceTokenSchemaMatchesType = true;
const _voiceTokenTypeMatchesSchema: _VoiceTokenTypeMatchesSchema = true;
void _voiceTokenSchemaMatchesType;
void _voiceTokenTypeMatchesSchema;
