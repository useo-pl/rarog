/**
 * Dyktowanie w trybie demo: klucz-atrapa zamiast mintu u Soniox.
 *
 * Testy UI apki natywnej sprawdzają mikrofon przez prawdziwy styk (`voiceEnabled`, `POST
 * /api/voice/token`); demo nie ma klucza Soniox i nie może po niego sięgać.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { voiceTokenSchema } from '@rarog/shared';
import { DEMO_VOICE_WEBSOCKET_URI, demoVoiceMinter, demoVoiceToken } from '../src/demo/voice.ts';
import { VOICE_AUDIO_FORMAT, VOICE_MAX_SESSION_SECONDS } from '../src/voice/soniox.ts';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

describe('dyktowanie w demo', () => {
  it('klucz przechodzi kontrakt, adres wss:// w domenie .invalid, konfiguracja jak w produkcji', async () => {
    const minter = demoVoiceMinter(() => NOW);
    expect(minter.available).toBe(true);
    const result = await minter.mint();
    if (!result.ok) throw new Error('demo zawsze wydaje klucz');
    expect(voiceTokenSchema.parse(result.token)).toEqual(result.token);
    expect(result.token.webSocketUri).toBe(DEMO_VOICE_WEBSOCKET_URI);
    expect(new URL(result.token.webSocketUri).hostname.endsWith('.invalid')).toBe(true);
    expect(result.token.config.audioFormat).toBe(VOICE_AUDIO_FORMAT);
    expect(result.token.maxSessionSeconds).toBe(VOICE_MAX_SESSION_SECONDS);
    expect(Date.parse(result.token.expiresAt) - NOW).toBe(60_000);
  });

  it('klucz demo ma prefiks snx_temp_: apka wysyła wyłącznie takie klucze, i tylko listą protokołów', () => {
    expect(demoVoiceToken(NOW).apiKey.startsWith('snx_temp_')).toBe(true);
  });

  it('bez dławika: dwa klucze pod rząd', async () => {
    const minter = demoVoiceMinter(() => NOW);
    expect((await minter.mint()).ok).toBe(true);
    expect((await minter.mint()).ok).toBe(true);
  });

  it('serwer podaje atrapę routerowi wyłącznie w trybie demo', () => {
    // Składanie: `index.ts` zakłada atrapę, `bootstrap/http.ts` podaje ją routerowi.
    const index = ['../src/index.ts', '../src/bootstrap/http.ts'].map((file) => readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8',
    )).join('\n');
    expect(index).toMatch(/config\.demo \? \(await import\('\.\/demo\/voice\.ts'\)\)\.demoVoiceMinter\(\)/);
    expect(index).toContain('...(demoVoice === undefined ? {} : { voice: demoVoice })');
  });
});
