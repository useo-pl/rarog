/**
 * Instalacja czasu w liniach stdout i stderr procesu serwera (opis: `log-timestamps.ts`). Import z efektem
 * ubocznym: ładuje go wyłącznie `index.ts`, jako pierwszy import, więc owinięcie stoi przed kodem innych
 * modułów.
 */
import { timestampWrites } from './log-timestamps.ts';

timestampWrites(process.stdout);
timestampWrites(process.stderr);
