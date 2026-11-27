/*
 * Słownik powiadomień — JEDNO źródło słów dla banera push (serwer). Apka ma własne
 * słowa dymka w RarogUI.
 *
 * Powód osobnego modułu: to samo zdarzenie widać na dwa sposoby — jako push, gdy Raroga nie ma
 * na ekranie, i jako dymek, gdy jest. Przy dwóch słownikach push mówiłby „Czeka na zgodę", a dymek
 * „czeka na decyzję": dwa słowniki na jedno znaczenie rozjeżdżają się przy pierwszej poprawce.
 * Tu stoją rodzaje zdarzeń i kody ich tytułów — nic więcej; słowa żyją w rejestrze zdań (`sentences/push.ts`).
 */
import type { SentenceCode } from './sentences/index.ts';

/**
 * Rodzaj zdarzenia, o którym warto powiadomić — to, co człowiek czyta w tytule / na dymku. `stalled`: a subagent has
 * waited over an hour on its own background command; no scheduler class, its own collapse key (`buildStalledContent`
 * on the server).
 */
export type NotifyKind = 'permission' | 'question' | 'blocked' | 'done' | 'error' | 'limit' | 'stalled';

/**
 * Kod tytułu banera push per rodzaj: zdanie `push.title.<rodzaj>` z argumentem `project`. Szablon zaczyna się
 * od emoji rodzaju, bo ikona na banerze jest jedna dla wszystkich powiadomień, a tytuł iOS ucina od końca.
 */
export const NOTIFY_KIND_TITLE = {
  permission: 'push.title.permission',
  question: 'push.title.question',
  blocked: 'push.title.blocked',
  done: 'push.title.done',
  error: 'push.title.error',
  limit: 'push.title.limit',
  stalled: 'push.title.stalled',
} as const satisfies Readonly<Record<NotifyKind, SentenceCode>>;
