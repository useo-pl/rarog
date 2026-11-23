/**
 * Wejście `--import` (przez `NODE_OPTIONS`) dla testów procesu serwera z iroh (`iroh-proces.test.ts`): hak `resolve`
 * podmienia paczkę biblioteki iroh, zanim `loadIroh()` ją załaduje. Hak synchroniczny (`module.registerHooks`),
 * bo `loadIroh()` ładuje paczkę przez `require()`, a tego asynchroniczne haki `module.register` nie widzą.
 * Tryb z `RAROG_TEST_IROH_SWAP`:
 * - `brak` — paczki „nie ma na dysku” (`ERR_MODULE_NOT_FOUND`, jak po instalacji bez paczki platformy);
 * - `atrapa` — zamiast biblioteki natywnej `iroh-atrapa-biblioteki.mjs` (zamykanie sterowane z testu).
 * Zmienna jest testowa, poza rejestrem zmiennych serwera; produkcja nigdy jej nie czyta.
 */
import { registerHooks } from 'node:module';

const mode = process.env.RAROG_TEST_IROH_SWAP;
if (mode !== 'brak' && mode !== 'atrapa') throw new Error(`RAROG_TEST_IROH_SWAP: brak albo atrapa (jest: ${String(mode)})`);
const PACKAGE = ['@number0', 'iroh'].join('/');
const fake = new URL('./iroh-atrapa-biblioteki.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== PACKAGE) return next(specifier, context);
    if (mode === 'atrapa') return { url: fake, format: 'module', shortCircuit: true };
    const err = new Error(`Cannot find package '${PACKAGE}' (podmiana testu)`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  },
});
