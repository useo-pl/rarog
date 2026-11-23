/**
 * Strefa pytania dialogu `Write` (CLI 2.1.322): linie między dolną kreską ramki treści
 * a pierwszą opcją. CLI rysuje tam wyłącznie pytanie „Do you want to create <nazwa>?” albo „Do you want to overwrite
 * <nazwa>?” (`measured/zgoda-write-*-2.1.322.txt`). Odczyt nazywa dialog `Write` WYŁĄCZNIE wtedy, gdy nagłówek dialogu
 * jest nad krawędzią ekranu (`toolNaming` w `screen/block.ts`): przy widocznym nagłówku nazwę daje jego tytuł,
 * a nagłówek spoza mapy tytułów to zmiana wyglądu CLI i ma skończyć się odmową. Nazwa z pytania jest tylko do
 * wyświetlenia: licznik kolejki stoi w linii nagłówka nad krawędzią, więc ekran nie odróżnia dwóch `Write` z kolejki,
 * a tożsamość `file-question` nie daje przycisków ani cyfry na żadnej ścieżce.
 *
 * Pytanie stoi pod dolną kreską ramki, więc pisze je CLI, nie agent: treść pliku `Write` ma numery linii, więc ani
 * kreski `╌╌╌`, ani linii pytania pod nią podrobić nie może. Linia `⏺ Write(…)` nazwy nie daje: stoi nad górną kreską
 * dialogu, więc przy nagłówku nad krawędzią jej nie widać, a linia tego kształtu na ekranie to treść ramki.
 *
 * Strefa przechodzi wyłącznie wtedy, gdy jej niepuste linie (puste na brzegach się nie liczą) stoją jedna pod drugą
 * i sklejone spacją są dokładnie tym pytaniem, jak w strefie `Edit` (`screen/edit-zone.ts`). Zdanie licznika
 * auto-odmowy (`withoutAutoDeny`, CLI 2.1.316) to linia interfejsu CLI, więc zostaje z niego pusta linia. Każda inna
 * linia daje `null`: nazwy wtedy nie ma, a formularza zgody z ekranu i tak nie ma przy żadnej ramce uciętej u góry
 * ani bez widocznej góry bloku (`parseOptions`).
 */
import { withoutAutoDeny } from './auto-deny.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Pytanie dialogu `Write`; grupa 1 to nazwa pliku. */
const WRITE_QUESTION = SCREEN_SIGNATURES.writeZoneQuestion.pattern;

/**
 * Nazwa pliku z pytania dialogu `Write`, gdy strefa (linie ekranu od linii pod dolną kreską ramki do linii nad
 * pierwszą opcją) to samo to pytanie, także zawinięte; `null` przy każdej innej strefie.
 */
export function writeZoneFile(zone: readonly string[]): string | null {
  // Licznik auto-odmowy (tyka co sekundę) to linia interfejsu CLI, nie dopisek: zostaje z niego pusta linia.
  const lines = withoutAutoDeny(zone).map((line) => line.trim());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  const question = lines.slice(start, end);
  if (question.length === 0 || question.includes('')) return null;
  return WRITE_QUESTION.exec(question.join(' '))?.[1] ?? null;
}
