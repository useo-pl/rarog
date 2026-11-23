/**
 * Wejście `--import` testu rzeczywistego procesu trybu recenzji (`server/test/demo-review-proces.test.ts`):
 * szpieg procesów potomnych i odczytów pod `HOME`. Ładuje się po `--import tsx`, przed `server/src/index.ts`.
 *
 * - `node:child_process`: każde wywołanie `exec`, `execFile`, `spawn`, `fork` i wersji `Sync` trafia do dziennika
 *   i NIE uruchamia niczego. Wersje asynchroniczne odpowiadają jak brak pliku (`ENOENT`): `exec`/`execFile` błędem
 *   w wywołaniu zwrotnym, `spawn`/`fork` zdarzeniem `error` atrapy procesu; `spawnSync` zwraca `error`, reszta `Sync`
 *   rzuca. Test nie zależy więc od tego, co jest zainstalowane na maszynie, i nie dotyka żadnego programu hosta.
 * - `node:fs` i `node:fs/promises`: funkcje z rodzin `readFile*`, `stat*`, `lstat*`, `exists*`, `open*` (także
 *   `opendir*`), `realpath*` (z `.native`), `readdir*`, `access*`, `readlink*`, `watch*` i `createReadStream`
 *   ze ścieżką pod `HOME` procesu (napis, `Buffer` albo `URL`; deskryptor liczbą się nie liczy) trafiają do dziennika
 *   i działają dalej normalnie (HOME to katalog tymczasowy testu ze znacznikami). Wywołanie zagnieżdżone w innym
 *   podmienionym (np. `openSync` w `readFileSync`) nie dubluje wpisu.
 * - `syncBuiltinESMExports()` przepisuje podmiany do importów nazwanych ESM (`import { execFile } from
 *   'node:child_process'` w plikach `.ts` serwera); bez tego import nazwany trzymałby oryginał. That the replacement
 *   works shows the test's spy self-check (a child process called through a named ESM import).
 *
 * Dziennik: JSONL pod ścieżką `SZPIEG_HOSTA_DZIENNIK` (poza `HOME`), wpis `{ rodzaj: 'proces', fn, plik, argumenty }`
 * albo `{ rodzaj: 'odczyt', fn, sciezka }`, dopisywany synchronicznie oryginałem `appendFileSync`, więc przetrwa
 * także upadek procesu. Zmienna jest testowa, poza rejestrem zmiennych serwera; serwer jej nie czyta.
 */
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DZIENNIK = process.env.SZPIEG_HOSTA_DZIENNIK;
if (DZIENNIK === undefined || DZIENNIK === '') throw new Error('SZPIEG_HOSTA_DZIENNIK: brak ścieżki dziennika szpiega');
const HOME = process.env.HOME;
if (HOME === undefined || HOME === '') throw new Error('szpieg hosta: brak HOME');

// Oryginały PRZED podmianą: dziennik i rozwiązywanie HOME nie mogą przejść przez szpiega.
const appendOriginal = fs.appendFileSync;
const realpathOriginal = fs.realpathSync;
const KORZENIE = [...new Set([path.resolve(HOME), realpathOriginal(HOME)])];

let glebokosc = 0;

function zapisz(wpis) {
  appendOriginal(DZIENNIK, `${JSON.stringify(wpis)}\n`);
}

function sciezkaOf(arg) {
  if (typeof arg === 'string') return path.resolve(arg);
  if (Buffer.isBuffer(arg)) return path.resolve(arg.toString('utf8'));
  if (arg instanceof URL && arg.protocol === 'file:') return fileURLToPath(arg);
  return null;
}

function podHome(sciezka) {
  return KORZENIE.some((root) => sciezka === root || sciezka.startsWith(`${root}${path.sep}`));
}

/** Opakowanie funkcji czytającej: wpis przy ścieżce pod HOME, potem oryginał bez zmian. */
function odczyt(nazwa, oryginal) {
  const wrapper = function szpiegOdczytu(...args) {
    if (glebokosc === 0) {
      const sciezka = sciezkaOf(args[0]);
      if (sciezka !== null && podHome(sciezka)) zapisz({ rodzaj: 'odczyt', fn: nazwa, sciezka });
    }
    glebokosc += 1;
    try {
      return Reflect.apply(oryginal, this, args);
    } finally {
      glebokosc -= 1;
    }
  };
  for (const key of Reflect.ownKeys(oryginal)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const opis = Object.getOwnPropertyDescriptor(oryginal, key);
    if (opis !== undefined) Object.defineProperty(wrapper, key, opis);
  }
  if (typeof oryginal.native === 'function') wrapper.native = odczyt(`${nazwa}.native`, oryginal.native);
  return wrapper;
}

const RODZINY = [
  'readFile', 'stat', 'lstat', 'exists', 'open', 'realpath', 'readdir', 'access', 'readlink', 'watch',
  'createReadStream',
];

function podmienOdczyty(obiekt, przedrostek) {
  for (const key of Object.keys(obiekt)) {
    const value = obiekt[key];
    if (typeof value !== 'function' || !RODZINY.some((rodzina) => key.startsWith(rodzina))) continue;
    obiekt[key] = odczyt(`${przedrostek}${key}`, value);
  }
}

function blad(plik) {
  return Object.assign(new Error(`spawn ${String(plik)} ENOENT (szpieg hosta: proces zablokowany)`), {
    code: 'ENOENT', errno: -2, syscall: `spawn ${String(plik)}`, path: String(plik),
  });
}

function zapiszProces(fn, args) {
  const argumenty = Array.isArray(args[1]) ? args[1].map(String) : [];
  zapisz({ rodzaj: 'proces', fn, plik: String(args[0]), argumenty });
}

/** Atrapa `ChildProcess` dla `spawn`/`fork`: `error` z `ENOENT` w następnym obrocie, jak brak programu. */
function atrapaProcesu(plik) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => false;
  process.nextTick(() => {
    child.emit('error', blad(plik));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', -2, null);
  });
  return child;
}

for (const fn of ['exec', 'execFile']) {
  childProcess[fn] = function szpiegProcesu(...args) {
    zapiszProces(fn, args);
    const callback = args.findLast((arg) => typeof arg === 'function');
    if (callback !== undefined) process.nextTick(() => { callback(blad(args[0]), '', ''); });
    const child = new EventEmitter();
    child.kill = () => false;
    return child;
  };
}
for (const fn of ['spawn', 'fork']) {
  childProcess[fn] = function szpiegProcesu(...args) {
    zapiszProces(fn, args);
    return atrapaProcesu(args[0]);
  };
}
childProcess.spawnSync = function szpiegProcesu(...args) {
  zapiszProces('spawnSync', args);
  return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: null, error: blad(args[0]) };
};
for (const fn of ['execSync', 'execFileSync']) {
  childProcess[fn] = function szpiegProcesu(...args) {
    zapiszProces(fn, args);
    throw blad(args[0]);
  };
}

podmienOdczyty(fs, '');
podmienOdczyty(fs.promises, 'promises.');
syncBuiltinESMExports();
