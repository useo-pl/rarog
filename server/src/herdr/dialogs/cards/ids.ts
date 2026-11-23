/**
 * Identyfikatory kart (`reqId`) — z TREŚCI dialogu, nigdy z samego numeru blokady.
 *
 * Ten sam dialog daje ten sam identyfikator (mignięcie statusu herdr nad stojącym dialogiem nie
 * podmienia karty), inny dialog — inny (podmiana w miejscu bez zdarzenia statusu daje nową kartę).
 */
import { createHash } from 'node:crypto';
import type { Question } from '@rarog/shared';
import type { KnownDialogId } from '../screen/known.ts';
import type { ScreenOption } from '../screen/options.ts';
import type { HerdrRefuseReason } from '../../audit.ts';

/**
 * Identyfikator karty budowanej Z EKRANU — z TREŚCI dialogu, nigdy z numeru blokady.
 *
 * Treść jest tu jedynym uczciwym kluczem tożsamości i pracuje w OBIE strony:
 * - herdr potrafi mignąć `blocked→working→blocked` nad STOJĄCYM dialogiem, a karta odtworzona
 *   po mignięciu musi mieć ten sam identyfikator, żeby tapnięcie w render sprzed mignięcia
 *   dalej trafiało (inaczej pierwsze tapnięcie przepadłoby bez śladu);
 * - dialog PODMIENIONY w miejscu (druga zakładka formularza, kolejna zgoda pod rząd) nie daje
 *   ani jednego zdarzenia statusu, więc tylko zmiana treści może powiedzieć „to już inna
 *   decyzja" — na tym stoi ponowna ocena stojącego dialogu.
 *
 * Dialog planu dokłada nazwę pliku planu ze stopki (`planFile`): plan A i plan B mają to samo pytanie i te same
 * opcje, a podmieniony w miejscu ma dostać nową kartę. Inne dialogi tego pola nie mają i ich `reqId` się nie zmienia.
 *
 * @param prefix `p` = karta zgody z ekranu, `q` = karta pytania/potwierdzenia
 */
export function screenFormReqId(
  prefix: 'p' | 'q',
  form: { header: string; question: string; options: readonly ScreenOption[]; planFile?: string | undefined },
): string {
  const plan = form.planFile === undefined ? [] : [`plan:${form.planFile}`];
  const content = [form.header, form.question, ...form.options.map((o) => o.label), ...plan].join('\n');
  return `screen:${prefix}:${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
}

/**
 * Identyfikator karty BEZ przycisków (fallback „odpowiedz w terminalu") — też z TREŚCI ekranu.
 *
 * Identyfikator STAŁY na całą blokadę (`screen:<numer blokady>` albo `hook:<id>` zrzutu) kończyłby
 * bramkę „ta sama karta stoi", zanim ktokolwiek spojrzy na nowy ekran: po zakładce `multiSelect` żadne
 * kolejne pytanie formularza nie dostałoby karty, a nad pytaniem jednokrotnym wisiałoby zdanie
 * o wielokrotnym wyborze. Reguła jest ta sama co w {@link screenFormReqId}: ten sam ekran → ten sam
 * identyfikator (hamulec przed migotaniem), inny ekran → inna karta.
 *
 * Do odcisku wchodzi wszystko, co RÓŻNI takie karty między sobą: powód odmowy, rozpoznana
 * sygnatura, treść pytania (dla `multiSelect` parser oddaje `null` — wtedy zostają etykiety)
 * i etykiety opcji.
 *
 * Do tego TYTUŁ dialogu z regionu za kreską (`ScreenDialog.title`). Dialog rodzaju `other` nie ma
 * treści pytania, więc dwa różne dialogi o tych samych etykietach („Switch to Opus 4.8” w dwóch pauzach,
 * „Yes”/„No” w dwóch dialogach CLI) bez tytułu dają ten sam odcisk: karta z wycinkiem zostaje przy
 * pierwszym dialogu, a odsłonięty tytuł nie daje nowej karty. Sam tytuł, nie cała treść: treść pod nim
 * bywa żywa (licznik, lista zadań), a każda nowa karta to wpis `degrade`.
 */
export function screenFallbackReqId(
  base: string,
  parts: {
    knownDialog: KnownDialogId | null;
    reason: HerdrRefuseReason | null;
    question: { header: string; question: string } | null;
    options: readonly ScreenOption[];
    title?: string | null;
  },
): string {
  const content = [
    parts.knownDialog ?? '', parts.reason ?? '',
    parts.question?.header ?? '', parts.question?.question ?? '',
    ...parts.options.map((o) => o.label),
    // Na końcu i tylko gdy jest: odcisk karty bez tytułu nie zależy od tego pola.
    ...(parts.title === undefined || parts.title === null ? [] : [`title:${parts.title}`]),
  ].join('\n');
  return `${base}:f:${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
}

/**
 * Identyfikator karty BEZ przycisków na ścieżce jsonl/hooka — baza z pliku PLUS wniosek.
 *
 * Goła baza (`tool_use.id`, generacja zrzutu) nie zmienia się, dopóki stoi ten sam wpis: bramka „ta sama
 * karta" w driverze kończyłaby każdą ocenę przed odczytem ekranu, a hamulec karty z przyciskami
 * w `decideCard` brałby czytelny już dialog za kartę, która stoi. Przykład: widok fullscreen przewinięty
 * w górę daje `unreadable`, a karta bez przycisków wisiałaby nad dialogiem, który parsuje się bez zarzutu.
 *
 * Do odcisku wchodzi WYŁĄCZNIE nazwa narzędzia z ekranu, którą karta pokazuje. Nie treść ekranu
 * jak w {@link screenFallbackReqId} i nie powód odmowy: przewijanie w terminalu zmienia ekran przy każdym
 * obrocie zegara, a dialog bez podwójnego dowodu (`Edit`, `Write`) przechodzi przy tym między
 * `unreadable` (dialog pod krawędzią) i `mismatch` (ramka ucięta u góry). Każda nowa karta to wpis
 * `degrade`, zrzut odmowy i powiadomienie — w chwili, gdy człowiek przewija terminal i w apkę nie patrzy.
 * Karta bez przycisków niczego nie zatwierdza, więc jej tożsamość mówi tylko,
 * czy na ekranie stoi dialog INNEGO narzędzia. Cena: powód i wycinek ekranu na karcie zostają z chwili
 * jej wystawienia.
 */
export function degradedReqId(base: string, screenToolName: string | null): string {
  return `${base}:d:${createHash('sha256').update(screenToolName ?? '').digest('hex').slice(0, 12)}`;
}

/** Czy `reqId` to karta bez przycisków ({@link degradedReqId}) wywołania o tej bazie. */
export function isDegradedOf(reqId: string, base: string): boolean {
  return reqId.startsWith(`${base}:d:`);
}

/**
 * Identyfikator karty pytania z hooka: id zrzutu PLUS odcisk treści zakładki.
 *
 * Ta sama reguła co w {@link screenFormReqId}, tylko zastosowana do ścieżki hooka.
 * Zrzut niesie CAŁY formularz i przeżywa odpowiedź na pojedyncze pytanie, więc jego `id`
 * nie odróżnia zakładki 1 od zakładki 2. Bez
 * odcisku treści obie karty miałyby ten sam `reqId` i odpowiedź z NIEŚWIEŻEJ karty
 * pierwszego pytania trafiałaby w drugie (etykiety sąsiednich zakładek kolidują).
 *
 * Odcisk liczy się z TREŚCI, KTÓRĄ KARTA NIESIE, a nie z ekranu: karta cyfrowa dostaje jedną
 * zakładkę (`[hookQuestion.card]`), karta kanału hooka — komplet pytań (`hookQuestion.all`).
 * Dzięki temu przełączenie zakładki przy biurku NIE podmienia karty, która i tak pokazuje
 * wszystkie pytania naraz.
 */
export function hookQuestionReqId(pendingId: string, cards: readonly Question[]): string {
  const content = cards
    .map((card) => [card.header, card.question, ...card.options.map((o) => o.label)].join('\n'))
    .join('\n');
  return `${pendingId}:${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
}
