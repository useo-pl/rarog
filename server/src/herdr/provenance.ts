/**
 * POCHODZENIE panelu herdr — czyste funkcje, jedno źródło formatów.
 *
 * Dwa znaki, po których Rarog poznaje „to jest moje", i każdy odpowiada na INNE pytanie:
 *
 * 1. **Nazwa agenta `rarog-<6 hex>`** (`agent.start`, {@link newRarogAgentName}) — WŁASNOŚĆ
 *    panelu Claude: chip „Rarog" i sufit `RAROG_MAX_PANES`. Żyje tyle, co proces
 *    agenta: ręczny `claude` wpisany w tę samą powłokę po `/exit` nazwy nie ma (zmierzone),
 *    więc własności nie dziedziczy. Bywa jej brak także przy agencie Raroga — gdy
 *    wygaśnie rekord startu, herdr wykrywa agenta sam; wtedy własność trzyma
 *    wyłącznie RAM tego procesu (`launchedKeys` w nadzorcy).
 * 2. **Etykieta PANELU** (`pane.rename`) — POCHODZENIE: „ten panel założył Rarog, dla tego
 *    projektu". herdr trzyma ją w snapshotcie sesji, więc jako JEDYNA rzecz Raroga przeżywa
 *    restart serwera herdr (tokeny `pane.report_metadata` giną razem z nim), i jest przypięta do
 *    panelu, nie do adresu. Zmierzone na herdr 0.9.3: etykieta zostaje przy
 *    wykryciu agenta, przy jego wyjściu, przy ręcznym uruchomieniu kolejnego i przy zmianie
 *    silnika; znika wyłącznie po jawnym `pane.rename` z `null`.
 *
 * The provenance suffix is CLOSED (anchored at the end, lowercase hex, single spaces): a human in
 * herdr can label a pane too, and anything outside the patterns means "a foreign pane". In front
 * of the suffix the label carries a description, ` · ` apart: the pane's tab label, cut to 40
 * code points ({@link paneLabelDescription}), so herdr's Go-to window and the pane frame name the
 * pane like its tab. The suffix carries hashes, never a path; the description repeats what the
 * tab label already shows (the card title, a name given by hand, the directory name of a
 * terminal tab), so the label reveals nothing the herdr snapshot did not hold before.
 *
 * Tu mieszka też etykieta TABA: czyszczenie wspólne dla Claude i terminala
 * ({@link sanitizeTabLabel} — to samo co karta, bez znaków sterujących) i format taba terminala
 * ({@link terminalTabLabel}). Etykieta taba jest dla człowieka, nie dowodem — dowodem „tę nadał
 * rarog" jest ślad ({@link labelTrace}) w etykiecie PANELU Claude.
 */
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { TERM_ID_RE } from '@rarog/shared';
import type { TermRole } from '@rarog/shared';
import { normalizeSessionLabel } from '../session-label.ts';

/** Przedrostek nazw Raroga w herdr: nazwa agenta, etykiety paneli i etykieta taba terminala. */
export const HERDR_NAME_PREFIX = 'rarog';

/** Nazwa agenta zakładanego przez Raroga. JEDNO źródło dla generatora i dla czytelnika. */
export const RAROG_AGENT_NAME_RE = new RegExp(`^${HERDR_NAME_PREFIX}-[0-9a-f]{6}$`);

/** `rarog-<6 hex>`: mieści się w `^[a-z][a-z0-9_-]{0,31}$` herdr, kolizja ~1/16M. */
export function newRarogAgentName(): string {
  return `${HERDR_NAME_PREFIX}-${randomBytes(3).toString('hex')}`;
}

const PROJECT_KEY_RE = /^[0-9a-f]{16}$/;
const LABEL_TRACE_RE = /^[0-9a-f]{8}$/;
/*
 * Readers accept an optional leading description: `<description> · rarog-term <id>` and
 * `<description> · rarog-claude <key> <trace>`. The provenance suffix stays exact and anchored
 * at the end. The description is captured and checked in code (at least one non-whitespace
 * character), so a label made of a separator alone stays foreign; one greedy group keeps the
 * match linear on long labels.
 */
const TERM_LABEL_RE = new RegExp(`^(?:(.+) · )?${HERDR_NAME_PREFIX}-term ([0-9a-f]{16})$`);
const CLAUDE_LABEL_RE = new RegExp(
  `^(?:(.+) · )?${HERDR_NAME_PREFIX}-claude ([0-9a-f]{16}) ([0-9a-f]{8})$`,
);

/** A captured description is valid when absent (bare format) or not blank. */
function descriptionOk(description: string | undefined): boolean {
  return description === undefined || /\S/u.test(description);
}

/** Odczytana etykieta pochodzenia; `trace` ma wyłącznie etykieta panelu Claude. */
export type PaneProvenance =
  | { kind: 'term'; value: string }
  | { kind: 'claude'; value: string; trace: string };

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Klucz projektu: pierwsze 16 hex `sha256(realpath(cwd))`.
 *
 * Wejściem MUSI być ścieżka po {@link realProjectPath} — dwie drogi do tego samego katalogu
 * (dowiązanie) mają dać jeden klucz. Materiał jest ten sam co tożsamości slotu 1 terminala
 * (`termIdFor`), więc dla jednego katalogu obie wartości są równe; rozróżnia je prefiks etykiety.
 */
export function projectKey(realCwd: string): string {
  return sha256Hex(realCwd).slice(0, 16);
}

/**
 * `realpath` katalogu projektu; ścieżka, której nie ma (albo nie da się jej rozwiązać), wraca
 * znormalizowana zamiast rzucać. Launcher liczy klucz PO starcie agenta i jego etykieta jest
 * best effort — brak katalogu na dysku nie ma prawa wywrócić startu sesji.
 */
export async function realProjectPath(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/** Tytuł panelu (`pane.report_metadata.title`) — obcinany, bo to tekst spoza tego modułu. */
export const PANE_TITLE_MAX_CHARS = 64;

/** Znaki sterujące U+0000–U+001F, DEL i U+0080–U+009F — herdr ich w etykietach nie odsiewa (zmierzone). */
const CONTROL_CHARS_GLOBAL_RE = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * Etykieta panelu → tytuł nadający się do `pane.report_metadata` i do etykiety taba.
 *
 * Tytuł nie idzie do powłoki (to pole danych, nie argument), ale przychodzi spoza tego modułu,
 * więc zamieniamy znaki sterujące na spacje, sklejamy białe znaki i obcinamy długość — panel
 * z tytułem na pół ekranu jest cudzym problemem. Pusty wynik = `fallback`.
 *
 * Mieszka tu (wcześniej w `launcher.ts`), bo tej samej reguły potrzebuje etykieta taba
 * ({@link sanitizeTabLabel}), a launcher importuje ten moduł — odwrotny import byłby cyklem.
 */
export function sanitizePaneTitle(raw: string, fallback: string): string {
  const cleaned = raw.replace(CONTROL_CHARS_GLOBAL_RE, ' ').replace(/\s+/g, ' ').trim();
  const out = cleaned === '' ? fallback : cleaned;
  return out.length > PANE_TITLE_MAX_CHARS ? out.slice(0, PANE_TITLE_MAX_CHARS) : out;
}

/**
 * Etykieta TABA w herdr: to samo czyszczenie co etykieta KARTY
 * (`normalizeSessionLabel`, `session-label.ts`) i NIC poza nim — bez osobnego limitu długości.
 *
 * Tab z Claude nosi etykietę karty, a manager przepuszcza każdą przez tę samą funkcję, więc tu
 * przechodzi ona BEZ ZMIANY: karta i tab mają ten sam napis, także gdy to nazwa katalogu dłuższa
 * niż 28 znaków (osobne ucięcie taba rozjeżdżałoby je z kartą). Pusty
 * wynik = `fallback` po tym samym czyszczeniu, a gdy i ten pusty — `rarog` (fasada gniazda
 * odrzuca pustą etykietę). Idempotentna: nadzorca czyści po managerze drugi raz bez rozjazdu.
 */
export function sanitizeTabLabel(raw: string, fallback: string): string {
  const cleaned = normalizeSessionLabel(raw);
  if (cleaned !== '') return cleaned;
  const safeFallback = normalizeSessionLabel(fallback);
  return safeFallback === '' ? 'rarog' : safeFallback;
}

/**
 * Etykieta TABA terminala Raroga: `rarog <slot> · <katalog>`, `rarog lazygit · <katalog>`,
 * `rarog popup · <katalog>` — to samo, co pigułki dawnej PWA (slot albo rola), plus katalog, po którym
 * człowiek przy Macu pozna projekt. Nazwy PROCESU świadomie nie ma: zmienia się co chwilę, a każda
 * zmiana byłaby `tab.rename` i zapisem snapshotu herdr.
 *
 * `realCwd` MUSI być po `realpath` (katalog z pliku stanu albo rejestru terminala — tożsamość
 * terminala liczy się z tej samej ścieżki). `slot` dotyczy wyłącznie roli `shell`; `null` = slot
 * nieznany (tożsamość nie pasuje do katalogu) — wtedy sam `rarog`, bez zmyślonego numeru.
 * Deterministyczna, więc etykieta terminala nie potrzebuje śladu w etykiecie panelu.
 */
export function terminalTabLabel(role: TermRole, slot: number | null, realCwd: string): string {
  const prefix = HERDR_NAME_PREFIX;
  const head = role === 'lazygit' ? `${prefix} lazygit`
    : role === 'popup' ? `${prefix} popup`
      : (slot !== null && slot >= 1 ? `${prefix} ${String(slot)}` : prefix);
  const dir = normalizeSessionLabel(path.basename(realCwd));
  return sanitizeTabLabel(dir === '' ? head : `${head} · ${dir}`, head);
}

/**
 * Ślad etykiety TABA: pierwsze 8 hex `sha256(etykieta)`.
 *
 * Mówi „tę etykietę taba nadał Rarog" bez pliku po stronie Raroga — siedzi w etykiecie panelu,
 * więc przeżywa restart Raroga i herdr. Wejściem jest etykieta DOKŁADNIE taka, jaką dostało
 * `tab.create`/`tab.rename` (po `sanitizePaneTitle` przy zakładaniu, po {@link sanitizeTabLabel}
 * przy synchronizacji z kartą — nadzorca, `syncTabLabel`).
 */
export function labelTrace(label: string): string {
  return sha256Hex(label).slice(0, 8);
}

/** Longest description in front of a pane label, in code points (fits herdr's Go-to row). */
export const PANE_LABEL_DESCRIPTION_MAX = 40;

/**
 * Description that leads a pane label: the tab label after the card cleanup
 * (`normalizeSessionLabel`), cut to {@link PANE_LABEL_DESCRIPTION_MAX} code points and trimmed.
 * Empty = no description, the label keeps the bare format. Not `sanitizeTabLabel`: that one
 * never returns an empty string.
 */
export function paneLabelDescription(tabLabel: string): string {
  return Array.from(normalizeSessionLabel(tabLabel))
    .slice(0, PANE_LABEL_DESCRIPTION_MAX).join('').trim();
}

/** `<description> · <origin>`, or the bare origin when the description is empty. */
function describedLabel(origin: string, tabLabel: string): string {
  const description = paneLabelDescription(tabLabel);
  return description === '' ? origin : `${description} · ${origin}`;
}

/**
 * Claude pane label: `<description> · rarog-claude <project key> <tab label trace>`.
 * `tabLabel` is the pane's current tab label; omitted or blank = the bare format.
 */
export function claudePaneLabel(key: string, trace: string, tabLabel = ''): string {
  if (!PROJECT_KEY_RE.test(key)) throw new Error('Klucz projektu spoza wzorca 16 hex.');
  if (!LABEL_TRACE_RE.test(trace)) throw new Error('Ślad etykiety taba spoza wzorca 8 hex.');
  return describedLabel(`rarog-claude ${key} ${trace}`, tabLabel);
}

/**
 * Terminal pane label: `<description> · rarog-term <terminal id>` (id shaped like `TERM_ID_RE`).
 * `tabLabel` is the terminal tab label (`terminalTabLabel`); omitted or blank = the bare format.
 */
export function termPaneLabel(id: string, tabLabel = ''): string {
  if (!TERM_ID_RE.test(id)) throw new Error('Identyfikator terminala spoza wzorca 16 hex.');
  return describedLabel(`rarog-term ${id}`, tabLabel);
}

/**
 * Pane label from `pane.list` → provenance, or `null` for any label outside the patterns.
 * Reads both the bare format and the one with a leading description.
 */
export function parsePaneLabel(label: string | null | undefined): PaneProvenance | null {
  if (typeof label !== 'string') return null;
  const term = TERM_LABEL_RE.exec(label);
  if (term?.[2] !== undefined && descriptionOk(term[1])) return { kind: 'term', value: term[2] };
  const claude = CLAUDE_LABEL_RE.exec(label);
  if (claude?.[2] !== undefined && claude[3] !== undefined && descriptionOk(claude[1])) {
    return { kind: 'claude', value: claude[2], trace: claude[3] };
  }
  return null;
}
