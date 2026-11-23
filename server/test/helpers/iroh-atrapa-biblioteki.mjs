/**
 * Atrapa biblioteki iroh w PROCESIE serwera (`iroh-podmiana.mjs`, tryb `atrapa`): tyle API wiązania, ile woła
 * `adapter.ts` przy `openEndpoint`, przyjmowaniu i zamykaniu. Dwie cechy żywej biblioteki, na których stoi test
 * zamknięcia (`iroh-proces.test.ts`):
 * - `online()` nie kończy się nigdy i trzyma pętlę zdarzeń także po `close()` (fakt 8 w `adapter.ts`), więc proces
 *   kończy dopiero bezpiecznik z `shutdown.ts`;
 * - `close()` trwa `RAROG_TEST_IROH_CLOSE_MS` ms albo nie kończy się wcale (`wisi`).
 * Atrapa niczego nie przyjmuje: `acceptNext()` czeka do zamknięcia i wtedy oddaje `null`.
 */
import { createHash } from 'node:crypto';

const closeSetting = process.env.RAROG_TEST_IROH_CLOSE_MS ?? '0';

class Endpoint {
  static builder() {
    return new Builder();
  }

  constructor(key) {
    this.key = key;
    this.waiting = [];
    this.closing = false;
    // Uchwyt jak u wiązania natywnego przy `online()` bez relaya: trzyma pętlę zdarzeń do końca procesu.
    this.holder = setInterval(() => {}, 60_000);
  }

  id() {
    // Skrót klucza, nie klucz: test sprawdza, że klucz nie trafia do logu, a EndpointId trafia.
    const hex = createHash('sha256').update(Buffer.from(this.key)).digest('hex');
    return { toString: () => hex };
  }

  boundSockets() {
    return ['127.0.0.1:1'];
  }

  acceptNext() {
    if (this.closing) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiting.push(resolve); });
  }

  online() {
    return new Promise(() => {});
  }

  watchHomeRelay() {
    return { stop: () => Promise.resolve() };
  }

  close() {
    this.closing = true;
    for (const resolve of this.waiting.splice(0)) resolve(null);
    if (closeSetting === 'wisi') return new Promise(() => {});
    return new Promise((resolve) => { setTimeout(resolve, Number(closeSetting)); });
  }
}

class Builder {
  secretKey(bytes) {
    this.key = bytes;
  }

  alpns() {}

  relayMode() {}

  bindAddr() {}

  bind() {
    return Promise.resolve(new Endpoint(this.key));
  }
}

const RelayMode = { disabled: () => ({}), customFromUrls: () => ({}) };

function presetMinimal() {}

export default { Endpoint, RelayMode, presetMinimal };
