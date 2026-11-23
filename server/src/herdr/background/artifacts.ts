/**
 * Artefakty sesji — rozpoznanie w pliku rozmowy i lista. CZYSTE: bez I/O, zegara i logów.
 *
 * Sesja Claude Code publikuje strony narzędziem `Artifact`. Wynik publikacji stoi w pliku rozmowy jak
 * start zadania w tle: obiekt `toolUseResult` na najwyższym poziomie wpisu `user`, obok bloku
 * `tool_result`. Usunięcie artefaktu na claude.ai CLI melduje notką harnessu o końcu obserwacji. Z tych
 * dwóch faktów moduł składa listę „co ta rozmowa opublikowała". Opis całości: `docs/artifacts.md`.
 *
 * Dlaczego tutaj, w katalogu zadań w tle: meldunek o usunięciu jedzie tym samym nośnikiem i tym samym
 * znacznikiem co meldunek zadania, więc ma ten sam parser (`notification.ts`) i ten sam rejestr słów
 * CLI (`cli-shapes.ts`). Osobny katalog z drugim rejestrem przewracałby strażnika literałów.
 *
 * Rozpoznanie, każdy warunek z powodu (pomiar na całym magazynie CLI tego konta, CLI
 * 2.1.273–2.1.301: 189 publikacji z wejścia `tool_use`, 181 bez wgrania zasobu i bez błędu):
 *
 * - **publikacja** — wpis `user` spoza subagenta, `toolUseResult` jest obiektem, jego `url` to DOKŁADNIE
 *   adres artefaktu (`isArtifactUrl`), do tego `created_from_type === true` albo `updated` typu boolean,
 *   co najmniej jeden blok `tool_result` i żaden z `is_error`, wpis z czasem. Po kształcie, nie po nazwie
 *   narzędzia: wywołanie stoi w innym wpisie, często przed oknem ogona. Kształt odsiewa `read`, `list`,
 *   `quickstart` i wgranie zasobu (inne pola wyniku), błąd (wynik jest napisem) i `WebFetch` adresu
 *   artefaktu (ma `url`, nie ma `updated`). Rozpoznanie dało te same 181 `tool_use_id` co wejście;
 * - **usunięcie** — WYŁĄCZNIE notka harnessu: wpis `user` z `origin.kind: task-notification` albo załącznik
 *   kolejki (`queued_command`) z tym samym pochodzeniem w samym załączniku, spoza subagenta, z meldunkiem
 *   rodzaju `artifact-watch-lifecycle`, wariantem `(artifact not found)` na końcu streszczenia (nie w tytule)
 *   i adresem w zdarzeniu (ostatnim, zaczynającym linię — nie w tytule). Nie
 *   `queue-operation`: ten nośnik niesie też prompty człowieka i raporty agentów, które potrafią cytować
 *   meldunek. Nie treść wyniku narzędzia ani prompt bez pochodzenia: cytat nie jest meldunkiem.
 *   Usunięcie w trakcie tury przychodzi samym załącznikiem (zmierzone na wariancie „account changed”,
 *   CLI 2.1.291: `attachment.origin.kind` i `commandMode` równe `task-notification`).
 *
 * Lista: adres → tytuł, chwila ostatniej publikacji i znacznik usunięcia. Publikacja ustawia tytuł
 * i czas, zdejmuje usunięcie; usunięcie dotyczy tylko adresu, który ta rozmowa opublikowała. Najnowsza
 * publikacja pierwsza, najwyżej {@link ARTIFACTS_MAX}. Z wyniku wychodzą tylko adres (sprawdzony),
 * tytuł (bez znaków sterujących, przycięty) i czas — nigdy ścieżka scratchpada, `capabilities`,
 * `instructions` ani lista plików.
 */
import type { SessionArtifact } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { clipUnits, stripControlChars } from '../../text.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { CLI_SHAPES } from './cli-shapes.ts';
import { isTaskNotificationOrigin } from './notice.ts';
import { isArtifactUrl, isTaskNotification, parseTaskNotification } from './notification.ts';

const PUBLISH = CLI_SHAPES.artifactPublish.literals;
const WATCH = CLI_SHAPES.artifactWatch.literals;
const CARRIERS = CLI_SHAPES.notificationCarriers.literals;
const QUEUED = CLI_SHAPES.queuedPrompt.literals;
const TOOL_RESULT = CLI_SHAPES.toolResult.literals.field;

/**
 * Ile artefaktów najwyżej stoi na liście. Lista jedzie w każdej ramce snapshotu jak zadania w tle;
 * zmierzone maksimum to 4 artefakty w jednej sesji (30 dni).
 */
export const ARTIFACTS_MAX = 20;

/** Ile jednostek UTF-16 tytułu jedzie na telefon — tyle co streszczenie zadania (`TASK_SUMMARY_MAX`). */
export const ARTIFACT_TITLE_MAX = 120;

/** Jeden fakt z jednego wpisu pliku rozmowy. */
export type ArtifactFact =
  | { readonly kind: 'published'; readonly url: string; readonly title: string; readonly at: string }
  | { readonly kind: 'gone'; readonly url: string };

/** Obiekt, ale nie tablica — `toolUseResult` błędu jest napisem, a tablica obiektem wyniku nie jest. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Bloki treści wpisu; nie-tablica = brak bloków (ta sama reguła co w `reducer.ts`). */
function blocksOf(entry: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = asRecord(entry['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Record<string, unknown>[] => {
    const block = plainRecord(item);
    return block === null ? [] : [block];
  });
}

/** Tytuł do listy: bez znaków sterujących, bez białych brzegów, przycięty; pusty → identyfikator z adresu. */
function cleanTitle(raw: string, url: string): string {
  const title = clipUnits(stripControlChars(raw).trim(), ARTIFACT_TITLE_MAX);
  return title === '' ? url.slice(url.lastIndexOf('/') + 1) : title;
}

/** Wynik publikacji we wpisie `user`; `null` = to nie jest publikacja. */
function publishedOf(entry: Record<string, unknown>): ArtifactFact | null {
  const results = blocksOf(entry).filter((block) => block['type'] === 'tool_result');
  if (results.length === 0 || results.some((block) => block['is_error'] === true)) return null;
  const result = plainRecord(entry[TOOL_RESULT]);
  if (result === null) return null;
  const url = asText(result[PUBLISH.url]);
  if (!isArtifactUrl(url)) return null;
  if (result[PUBLISH.createdFromType] !== true && typeof result[PUBLISH.updated] !== 'boolean') return null;
  // Czas jest częścią wiersza listy („2 h temu · 14:05”); CLI pisze go w każdym wpisie.
  const at = asText(entry['timestamp']);
  if (Number.isNaN(Date.parse(at))) return null;
  return { kind: 'published', url, title: cleanTitle(asText(result[PUBLISH.title]), url), at };
}

/**
 * Tekst notki harnessu z wpisu; `''` = wpis nią nie jest. Pochodzenie stoi na wpisie `user`, a w załączniku
 * kolejki w samym załączniku. `queue-operation` notką nie jest nigdy (patrz nagłówek).
 * The pull request list reads the end of a background command through the same gate (`pull-requests.ts`).
 */
export function harnessNoticeText(entry: Record<string, unknown>): string {
  const type = entry['type'];
  if (type === 'user') {
    if (!isTaskNotificationOrigin(entry['origin'])) return '';
    return asText(asRecord(entry['message'])?.['content']);
  }
  if (type === CARRIERS.attachmentType) {
    const attachment = plainRecord(entry[CARRIERS.attachmentField]);
    if (attachment === null || attachment['type'] !== CARRIERS.queuedCommand) return '';
    if (!isTaskNotificationOrigin(attachment[QUEUED.origin])) return '';
    return asText(attachment[CARRIERS.queuedText]);
  }
  return '';
}

/** Meldunek o usunięciu artefaktu; `null` = to nie on. */
function goneOf(entry: Record<string, unknown>): ArtifactFact | null {
  const text = harnessNoticeText(entry);
  if (!isTaskNotification(text)) return null;
  const notification = parseTaskNotification(text);
  if (notification.taskType !== WATCH.lifecycle) return null;
  // Wariant stoi na KOŃCU streszczenia, za tytułem w cudzysłowie. Tytuł to tekst modelu i może sam nieść tę
  // frazę (`"Plan (artifact not found)" (public, …)`) — szukanie w całym streszczeniu wygaszało żywy artefakt.
  if (!notification.summary.endsWith(WATCH.notFound) || notification.watchedUrl === '') return null;
  return { kind: 'gone', url: notification.watchedUrl };
}

/**
 * Jeden SPARSOWANY wpis pliku rozmowy (wynik `parseJsonlEntry`) → fakt o artefakcie albo `null`.
 * Wpis subagenta (`isSidechain`) odpada: lista dotyczy rozmowy głównej, a subagent pisze do własnego pliku.
 */
export function artifactFact(value: unknown): ArtifactFact | null {
  const entry = plainRecord(value);
  if (entry === null || entry['isSidechain'] === true) return null;
  if (entry['type'] === 'user') return publishedOf(entry) ?? goneOf(entry);
  return goneOf(entry);
}

export interface ArtifactsTracker {
  /** Skarmia JEDEN sparsowany wpis; oddaje fakt, który z niego wyszedł (`null` = żaden). */
  note(entry: unknown): ArtifactFact | null;
  /** Fakt zebrany wcześniej (powtórka faktów przeczytanych w trakcie przeglądu pliku). */
  apply(fact: ArtifactFact): void;
  /**
   * Lista: najnowsza publikacja pierwsza, najwyżej {@link ARTIFACTS_MAX}. Za każdym odczytem NOWA tablica
   * z NOWYMI obiektami: lista jedzie dalej przez referencję, a zmiana w miejscu zmieniałaby wysłaną ramkę.
   */
  readonly artifacts: readonly SessionArtifact[];
}

/** Wpis listy w środku trackera: `seq` rozstrzyga remis czasów (późniejsza publikacja w pliku wygrywa). */
interface Known {
  title: string;
  at: string;
  gone: boolean;
  seq: number;
}

/** Kolejność listy: czas ostatniej publikacji malejąco, przy remisie późniejsza w pliku pierwsza. */
function newestFirst(a: Known, b: Known): number {
  return Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq;
}

/**
 * Tworzy tracker listy artefaktów jednego pliku rozmowy.
 *
 * Mapa adresów ma ten sam sufit co lista: po przekroczeniu wypada artefakt z najstarszą publikacją. Wynik
 * jest taki sam jak przy mapie bez sufitu — wypadnięty adres i tak stoi poza listą, a wraca na nią tylko
 * nową publikacją, która ustawia od nowa tytuł, czas i zdejmuje usunięcie.
 */
export function createArtifactsTracker(): ArtifactsTracker {
  const known = new Map<string, Known>();
  let seq = 0;

  const apply = (fact: ArtifactFact): void => {
    const current = known.get(fact.url);
    if (fact.kind === 'gone') {
      if (current !== undefined) current.gone = true;
      return;
    }
    seq += 1;
    // Czas nie cofa się: ostatnia publikacja w pliku ma najpóźniejszy czas, a gdyby nie miała, wiersz
    // nie skacze w dół listy.
    const at = current === undefined || Date.parse(fact.at) > Date.parse(current.at) ? fact.at : current.at;
    known.set(fact.url, { title: fact.title, at, gone: false, seq });
    if (known.size <= ARTIFACTS_MAX) return;
    const [oldest] = [...known.entries()].sort(([, a], [, b]) => newestFirst(b, a));
    if (oldest !== undefined) known.delete(oldest[0]);
  };

  return {
    note(entry: unknown): ArtifactFact | null {
      const fact = artifactFact(entry);
      if (fact !== null) apply(fact);
      return fact;
    },
    apply,
    get artifacts(): readonly SessionArtifact[] {
      return [...known.entries()]
        .sort(([, a], [, b]) => newestFirst(a, b))
        .slice(0, ARTIFACTS_MAX)
        .map(([url, item]): SessionArtifact => (item.gone
          ? { url, title: item.title, publishedAt: item.at, gone: true }
          : { url, title: item.title, publishedAt: item.at }));
    },
  };
}

/**
 * Podpis listy — po nim follower poznaje ZMIANĘ. Obejmuje wszystko, co lista niesie, więc zmiana tytułu,
 * czasu i usunięcia też jest zmianą. Pusta lista ma podpis `[]`.
 */
export function artifactsSignature(artifacts: readonly SessionArtifact[]): string {
  return JSON.stringify(artifacts.map((item) => [item.url, item.title, item.publishedAt, item.gone === true]));
}

/**
 * Lista artefaktów z linii pliku (kolejność zapisu) — ta sama maszyna co w followerze, dla pomiaru i testów.
 */
export function sessionArtifacts(lines: readonly string[]): readonly SessionArtifact[] {
  const tracker = createArtifactsTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return tracker.artifacts;
}
