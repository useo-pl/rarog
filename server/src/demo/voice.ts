/**
 * Dyktowanie w trybie demo: klucz-atrapa zamiast mintu u Soniox.
 *
 * Testy apki natywnej (`VoiceUITests`) przechodzą przez prawdziwy styk: flaga
 * `voiceEnabled` w `GET /api/version` i `POST /api/voice/token` z bramką `Origin`. Mikrofon
 * i strumień grają tam scenariusz po stronie apki — demo nie ma klucza Soniox i nigdy nie
 * woła ich API (sekret człowieka i limit konta zostają nietknięte, jak przy limitach planu).
 *
 * Adres strumienia leży w domenie `.invalid` (RFC 2606): klient, który spróbowałby się z nim
 * połączyć naprawdę (jak dawna PWA na serwerze demo), dostaje błąd sieci i zdanie „Transkrypcja
 * przerwana", a nie cudzy serwer.
 *
 * Klucz-atrapa ma prefiks `snx_temp_` jak klucze z prawdziwego mintu: apka wysyła klucz wyłącznie listą
 * protokołów WebSocket, a klucza bez tego prefiksu nie wysyła wcale, więc bez niego skryptowe
 * gniazdo testów UI nie dostałoby połączenia.
 */
import type { VoiceToken } from '@rarog/shared';
import type { MintResult, VoiceMinter } from '../voice/soniox.ts';
import {
  SONIOX_RT_MODEL, VOICE_AUDIO_FORMAT, VOICE_LANGUAGE_HINTS, VOICE_MAX_SESSION_SECONDS,
  VOICE_NUM_CHANNELS, VOICE_SAMPLE_RATE, VOICE_TOKEN_EXPIRES_IN_SECONDS,
} from '../voice/soniox.ts';

export const DEMO_VOICE_WEBSOCKET_URI = 'wss://soniox.demo.invalid/transcribe-websocket';

export function demoVoiceToken(now: number): VoiceToken {
  return {
    apiKey: 'snx_temp_demo',
    expiresAt: new Date(now + VOICE_TOKEN_EXPIRES_IN_SECONDS * 1000).toISOString(),
    webSocketUri: DEMO_VOICE_WEBSOCKET_URI,
    model: SONIOX_RT_MODEL,
    maxSessionSeconds: VOICE_MAX_SESSION_SECONDS,
    config: {
      languageHints: [...VOICE_LANGUAGE_HINTS],
      audioFormat: VOICE_AUDIO_FORMAT,
      sampleRate: VOICE_SAMPLE_RATE,
      numChannels: VOICE_NUM_CHANNELS,
    },
  };
}

/** Minter demo: zawsze dostępny, bez dławika (testy UI stukają szybciej niż człowiek). */
export function demoVoiceMinter(now: () => number = Date.now): VoiceMinter {
  return {
    available: true,
    mint: (): Promise<MintResult> => Promise.resolve({ ok: true, token: demoVoiceToken(now()) }),
  };
}
