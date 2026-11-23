/**
 * Strefa pytania dialogu `Edit`: linie między dolną kreską ramki diffu a pierwszą opcją. CLI rysuje tam
 * wyłącznie pytanie „Do you want to make this edit to <nazwa>?” z nazwą bazową pliku z nagłówka dialogu (zmierzone na
 * CLI 2.1.258–2.1.293, `measured/zgoda-edit-*`). Odczyt służy WYŁĄCZNIE dowodowi wierzchu kanału zgód
 * (`layer1/top.ts`): nagłówek „Edit file” i ramkę diffu agent potrafi wpisać w treść innego dialogu, więc o tym, że
 * blok to dialog `Edit` tego pliku, rozstrzyga pytanie narysowane przez CLI pod ramką.
 *
 * Strefa przechodzi wyłącznie wtedy, gdy jej niepuste linie (puste na brzegach się nie liczą) stoją jedna pod drugą
 * i sklejone spacją są dokładnie tym pytaniem z nazwą `fileName`: tak CLI zawija pytanie w wąskim panelu (pomiar
 * pytania `NotebookEdit` na trzy linie w 26 kolumnach, CLI 2.1.311). Każda inna linia (pytanie innego narzędzia, inna
 * nazwa, dopisek, pasek objaśnienia, linia reguły uprawnień, licznik auto-odmowy, druga ramka, pusta linia w środku
 * pytania) daje `false`. Dialogu `Edit` z linią CLI nad pytaniem nie zmierzono, więc taki dialog idzie do biurka.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Pytanie dialogu `Edit`; grupa 1 to nazwa bazowa pliku. */
const EDIT_QUESTION = SCREEN_SIGNATURES.editZoneQuestion.pattern;

/**
 * Czy strefa pytania (linie ekranu od linii pod dolną kreską ramki do linii nad pierwszą opcją) to samo pytanie
 * dialogu `Edit` o plik `fileName`, także zawinięte.
 */
export function editZoneListed(zone: readonly string[], fileName: string): boolean {
  const lines = zone.map((line) => line.trim());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  const question = lines.slice(start, end);
  if (question.length === 0 || question.includes('')) return false;
  return EDIT_QUESTION.exec(question.join(' '))?.[1] === fileName;
}
