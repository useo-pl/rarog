/**
 * Wysyłka wiadomości w trakcie tury: wklejenie, sprawdzenie, osobny Enter (pomiar 0a).
 *
 * `agent.prompt` herdr wkleja tekst i naciska Enter po stałych 300 ms; blokadę panelu herdr sprawdza raz, na starcie.
 * Dialog zgody albo formularz, który stanie w tym oknie, dostawał Enter: zatwierdzał podświetloną opcję, a tekst
 * wiadomości przepadał (2 z 20 prób na CLI 2.1.322). Driver wkleja więc sam tekst (`pane.send_input`), czeka, aż tekst
 * stoi w polu, sprawdza drugi raz rejestr sesji CLI i prośbę hooka zgody i dopiero wtedy wysyła Enter osobnym
 * klawiszem. Enter tuż po wklejeniu trafia w pole: CLI rysuje dialog, którego żądanie przyszło po przyjęciu wejścia,
 * najwcześniej 441 ms po ostatnim wejściu (pomiar 0a, 47 dialogów), a rejestr pokazuje żądanie p50 6–7 ms po nim.
 *
 * Tu stoją stałe i czysta reguła pola; stan i klawisze trzyma kolejka wklejeń `prompt-queue.ts`.
 */
import { composerRegionText, squashWhitespace } from './commands.ts';

/**
 * Sufit czekania na wklejony tekst w polu promptu. Pomiar 0a: wklejenie → tekst widoczny p50 115 ms, p90 234 ms,
 * max 3820 ms (przestój herdr). Bez tekstu w polu po tym czasie Enter nie idzie, a wiadomość wraca na początek kolejki.
 */
export const PROMPT_FIELD_WAIT_MS = 4_000;

/** Odstęp odczytów pola po wklejeniu (odczyt ekranu herdr p90 ok. 140 ms pod obciążeniem). */
export const PROMPT_FIELD_POLL_MS = 40;

/**
 * Odstęp ponownej próby wiadomości, która czeka, bo stoi dialog (pomiar 0a ponawiał co 300 ms). Próba przy stojącym
 * dialogu kończy się na rejestrze i kanale zgód, bez odczytu ekranu.
 */
export const PROMPT_RETRY_MS = 300;

/**
 * Próg „Enter późno”: od końca wklejenia do Entera minęło więcej, więc odroczenie dialogu przez CLI (najmniej 441 ms
 * po ostatnim wejściu, zmierzone na 2.1.322) przestaje chronić. Wtedy driver sprawdza pole i rejestr jeszcze raz
 * i zapisuje linię logu z czasem.
 */
export const PROMPT_SUBMIT_LATE_MS = 300;

/** Ile razy jedna wiadomość może pójść do pola (tekst wklejony w stojący dialog zgody przepada, pomiar 0a). */
export const PROMPT_PASTE_ATTEMPTS = 3;

/**
 * Sufit czekania następnej wiadomości z kolejki na rozstrzygnięcie poprzedniego Entera. Hook `UserPromptSubmit` biegnie
 * od razu przy Enterze w trakcie tury, a zablokowany prompt CLI oddaje do pola bez wpisu w pliku (`docs/dialogs.md`,
 * „Prompt blocked by a hook”): tekst następnej wiadomości wklejony przed tym oddaniem skleiłby się z nim. Rozstrzyga
 * wpis promptu z pliku rozmowy, pole z oddanym tekstem albo ten sufit.
 *
 * Skąd 1,5 s: wpis blokady hooka pomiarowego stał w pliku 0,35–0,5 s po `agent.prompt`, czyli 50–200 ms po jego
 * Enterze (CLI 2.1.303); hook, który uruchamia `node` albo `git`, potrzebuje kilkuset ms, a odczyt ekranu herdr ma p90
 * ok. 140 ms pod obciążeniem. Sufit mieści taki hook z zapasem na dwa odczyty, a zatrzymuje tylko wiadomość, która
 * idzie zaraz po poprzedniej z kolejki (zwykle kilka wiadomości puszczonych naraz po dialogu). Tekst oddany po suficie
 * łapie sprawdzenie sklejki po wklejeniu ({@link gluedFieldVerdict}). Czasu oddania tekstu do pola w trakcie tury nikt
 * nie zmierzył.
 */
export const PROMPT_SUBMIT_SETTLE_MS = 1_500;

/**
 * Treść pola promptu bez białych znaków albo `null`, gdy pola nie widać (stoi dialog albo formularz, ekran bez ramki
 * pola). Ekran z atrybutami (`visible` + `ansi`): przyciemniona podpowiedź CLI nie jest treścią.
 */
export function promptFieldOf(screen: string): string | null {
  const region = composerRegionText(screen);
  return region === null ? null : squashWhitespace(region);
}

/**
 * Ślad wklejenia jednej wiadomości: pole tuż przed ostatnim wklejeniem i pole, w którym driver zobaczył wklejony tekst
 * (oba bez białych znaków). `before === null` = wiadomość jeszcze nie poszła do pola. `lost` = dowód, że ostatnie
 * wklejenie trafiło w dialog, który już stał, i przepadło: pierwszy udany odczyt po wklejeniu, skończony przed progiem
 * {@link PROMPT_SUBMIT_LATE_MS} liczonym od początku wklejenia, pokazał dialog albo formularz w miejscu pola. CLI rysuje
 * dialog żądany po wejściu najwcześniej 441 ms po nim (pomiar 0a na CLI 2.1.322), więc taki dialog stał przed
 * wklejeniem, a tekstu nikt nie mógł wysłać z pola.
 */
export interface PasteMark {
  readonly before: string | null;
  readonly after: string | null;
  readonly lost: boolean;
}

/**
 * Co zrobić z wiadomością przy widocznym polu `field` (bez białych znaków). Porównanie całego pola, nie początku
 * tekstu: CLI zwija długą wklejkę do znacznika, a znacznik nie zawiera tekstu wiadomości.
 *
 * - `paste` — pierwsza próba albo pole jak przed wklejeniem, gdy wiadomość na pewno nie poszła: wklejenie przepadło
 *   w stojącym dialogu (`lost`; pomiar 0a: 6 z 6, pole po dialogu jak przed wklejeniem) albo pole dalej trzyma niepusty
 *   tekst sprzed wklejenia (Enter wysłałby go razem z wiadomością, więc nie zostałby w polu). To jedyne dowody, które
 *   pozwalają wkleić tę samą wiadomość drugi raz;
 * - `unseen` — pole puste przed wklejeniem i teraz, a driver nie zobaczył tekstu w polu i nie ma dowodu, że przepadł:
 *   tekst mógł pójść Enterem przy Macu przed pierwszym odczytem, więc ani drugiego wklejenia, ani Entera;
 * - `landed` — pole zmieniło się w niepuste po wklejeniu, którego driver nie zdążył zobaczyć (przestój herdr);
 * - `holds` — pole trzyma dokładnie to, co driver zobaczył po wklejeniu (tekst, który stał w polu, przetrwał dialog:
 *   7 z 7) — Enter bez ponownego wklejania;
 * - `taken` — pole puste, choć trzymało wklejony tekst albo szkic sprzed wklejenia: ktoś przy Macu wysłał je albo
 *   wyczyścił, więc ani wklejenia, ani Entera;
 * - `changed` — pole trzyma coś innego niż wklejony tekst (szkic przy Macu) albo zmieniło się po wklejeniu, które
 *   przepadło (`lost`: wklejonego tekstu w polu być nie może, a wiadomość nie poszła): ani wklejenia, ani Entera.
 */
export function pastedFieldVerdict(
  field: string, mark: PasteMark,
): 'paste' | 'unseen' | 'landed' | 'holds' | 'taken' | 'changed' {
  if (mark.before === null) return 'paste';
  if (mark.after === null) {
    if (field === mark.before) return mark.lost || mark.before !== '' ? 'paste' : 'unseen';
    if (mark.lost) return 'changed';
    return field === '' ? 'taken' : 'landed';
  }
  if (field === mark.after) return 'holds';
  return field === '' ? 'taken' : 'changed';
}

/**
 * Pole po wklejeniu do pustego pola, którego driver jeszcze nie uznał za wklejony tekst, trzyma wcześniejszy tekst
 * Raroga `leftover` (hook oddał do pola zablokowany prompt poprzedniej wiadomości z kolejki, kiedy szła następna) i nie
 * jest samym tekstem wiadomości `own`. Wszystko bez białych znaków; `leftover === null` = Rarog nie zostawił w polu nic
 * swojego. Pole, które tylko zaczyna się albo kończy pozostałością, może być też szkicem przy Macu, więc żaden werdykt
 * nie daje Entera, czyszczenia ani drugiego wklejenia.
 *
 * - `unseen` — pole to sama pozostałość: wklejonego tekstu w nim nie ma, mógł pójść Enterem przy Macu;
 * - `changed` — pozostałość razem z czymś jeszcze (wklejony tekst, znacznik `[Pasted text #N +K lines]` długiej wklejki
 *   albo szkic): Enter wysłałby sklejkę albo cudzy tekst, a wiadomość z pola nie wyszła;
 * - `null` — pole nie zaczyna się ani nie kończy pozostałością albo jest samym tekstem wiadomości.
 */
export function gluedFieldVerdict(field: string, own: string, leftover: string | null): 'unseen' | 'changed' | null {
  if (leftover === null || leftover === '' || field === own) return null;
  if (field === leftover) return 'unseen';
  return field.startsWith(leftover) || field.endsWith(leftover) ? 'changed' : null;
}
