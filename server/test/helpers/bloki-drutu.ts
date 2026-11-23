/**
 * Widok drutu bloków wewnętrznych dla testów: import pliku rozmowy i zdarzenia drivera niosą bloki
 * z tekstem o znanym pochodzeniu (`say`, `foreign`), a na drut wychodzą bloki `Block` z `protocol.ts`.
 * Testy kształtu transkryptu porównują to, co zobaczy apka, więc przepuszczają wynik przez TĘ SAMĄ serializację,
 * której używa `Session.appendMessage` (`wireBlocks`). Pochodzenie tekstu sprawdzają osobne testy, nie ten widok.
 */
import type { Block } from '@rarog/shared';
import type { InternalBlock } from '../../src/drivers/types.ts';
import { wireBlocks } from '../../src/sessions/session.ts';

/** Wiadomość z blokami z drutu zamiast wewnętrznych. */
export type WireMessage<T extends { blocks: readonly InternalBlock[] }> = Omit<T, 'blocks'> & { blocks: Block[] };

/** Jedna wiadomość w widoku drutu. */
export function wireMessage<T extends { blocks: readonly InternalBlock[] }>(message: T): WireMessage<T> {
  return { ...message, blocks: wireBlocks(message.blocks) };
}

/** Wynik z listą `messages` (import ogona, zdarzenie `history`) w widoku drutu. */
export function wireMessages<T extends { messages: readonly { blocks: readonly InternalBlock[] }[] }>(
  value: T,
): Omit<T, 'messages'> & { messages: WireMessage<T['messages'][number]>[] } {
  return { ...value, messages: value.messages.map((message) => wireMessage(message)) };
}

/** Wpis z `parseImportLine` (wiadomość albo `null`) w widoku drutu. */
export function wireEntry<T extends { message: { blocks: readonly InternalBlock[] } | null }>(
  entry: T | null,
): (Omit<T, 'message'> & { message: WireMessage<NonNullable<T['message']>> | null }) | null {
  if (entry === null) return null;
  return { ...entry, message: entry.message === null ? null : wireMessage(entry.message) };
}
