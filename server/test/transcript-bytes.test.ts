/**
 * Sufity BAJTOWE transkryptu.
 *
 * Do tej zmiany pamięć sesji była liczona wyłącznie w SZTUKACH (200 wiadomości, 500 eventów
 * ringu), a jedna wiadomość potrafiła nieść megabajty — więc `transcript-snapshot`, ramka
 * lecąca na telefon przy KAŻDYM wejściu w transkrypt, nie miała żadnej granicy wagi.
 * Te testy pilnują drugiego sufitu: wiadomość przycinana z jawnym znacznikiem i tablica
 * `#messages` wypychająca najstarsze wpisy po przekroczeniu budżetu sesji.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '@rarog/shared';
import { MESSAGE_TRIMMED_MARK, Session, clampMessageBlocks } from '../src/sessions/session.ts';
import { MAX_MESSAGE_BYTES, RING_MAX_BYTES, jsonBytes } from '../src/sessions/ring-buffer.ts';
import { foreign } from '@rarog/shared/sentences';

const iso = (offset: number): string => new Date(1_756_000_000_000 + offset).toISOString();

function newSession(): Session {
  return new Session({
    id: 'sess-1',
    cwd: '/Users/x/Projects/rarog',
    title: 'rarog',
    state: 'running',
    stateSince: iso(0),
    createdAt: iso(0),
    lastActivityAt: iso(0),
  });
}

describe('clampMessageBlocks', () => {
  it('wiadomość mieszcząca się w budżecie wraca NIETKNIĘTA (ta sama tablica)', () => {
    const blocks: Block[] = [{ type: 'text', text: 'krótkie zdanie' }];
    expect(clampMessageBlocks(blocks)).toBe(blocks);
  });

  it('nadmiar jest cięty i mówi o tym wprost — cisza byłaby gorsza od cięcia', () => {
    const blocks: Block[] = [{ type: 'text', text: 'a'.repeat(MAX_MESSAGE_BYTES * 2) }];
    const cut = clampMessageBlocks(blocks);
    expect(jsonBytes(cut)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const last = cut.at(-1);
    expect(last?.type).toBe('text');
    expect(last?.type === 'text' && last.text).toBe(MESSAGE_TRIMMED_MARK.text);
  });

  it('początek wiadomości zostaje, ogon odpada — treść jest z przodu, wypis z tyłu', () => {
    const blocks: Block[] = [
      { type: 'text', text: 'to jest odpowiedź agenta' },
      { type: 'text', text: 'b'.repeat(MAX_MESSAGE_BYTES * 2) },
      { type: 'tool-call', toolName: 'Bash', summary: 'echo' },
    ];
    const cut = clampMessageBlocks(blocks);
    expect(cut[0]).toEqual({ type: 'text', text: 'to jest odpowiedź agenta' });
    expect(cut.some((b) => b.type === 'tool-call')).toBe(false);
    expect(jsonBytes(cut)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe('Session — budżet bajtowy transkryptu', () => {
  it('wiadomość dopisana do transkryptu jest już przycięta', () => {
    const session = newSession();
    const { message } = session.appendMessage(
      'assistant', [{ type: 'text', text: foreign('c'.repeat(MAX_MESSAGE_BYTES * 3)) }], iso(1),
    );
    expect(jsonBytes(message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES + 256);
  });

  it('przekroczony budżet sesji wypycha NAJSTARSZE wiadomości', () => {
    const session = newSession();
    const heavy = 'd'.repeat(MAX_MESSAGE_BYTES - 1_000);
    // Tyle ciężkich wiadomości, żeby suma pewnie przebiła sufit sesji.
    const rounds = Math.ceil(RING_MAX_BYTES / MAX_MESSAGE_BYTES) + 3;
    for (let i = 0; i < rounds; i += 1) {
      session.appendMessage('assistant', [{ type: 'text', text: foreign(heavy) }], iso(i + 1));
    }
    expect(session.transcriptBytes).toBeLessThanOrEqual(RING_MAX_BYTES);
    expect(session.recentMessages().length).toBeLessThan(rounds);
    // Ostatnia wiadomość NIGDY nie wypada — pusty transkrypt byłby gorszy niż za ciężki.
    expect(session.recentMessages().length).toBeGreaterThan(0);
  });

  it('wizytówki załączników jadą z wiadomością, a bajtów w niej nie ma', () => {
    const session = newSession();
    const { message } = session.appendMessage(
      'user', [{ type: 'text', text: foreign('zobacz') }], iso(1),
      [{ kind: 'image', name: '', bytes: 1024, mime: 'image/png' }],
    );
    expect(message.attachments).toEqual([
      { kind: 'image', name: '', bytes: 1024, mime: 'image/png' },
    ]);
    expect(JSON.stringify(message)).not.toContain(';base64,');
  });

  it('wiadomość bez załączników NIE dostaje pustego pola (kształt ramki bez zmian)', () => {
    const session = newSession();
    const { message } = session.appendMessage('user', [{ type: 'text', text: foreign('ok') }], iso(1));
    expect('attachments' in message).toBe(false);
  });
});
