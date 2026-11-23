/**
 * Zdanie powodu odmowy ma dwa miejsca w repo i jedno w apce: rejestr zdań (`dialogs.refuse.<powód>`
 * w `shared/src/sentences/dialogs.ts`), `REFUSE_MESSAGES` (`shared/src/protocol.ts`, tekst ciała 422 na decyzję,
 * która nie wyszła do panelu) i katalog zdań serwera w RarogContract (`server.dialogs.refuse.<powód>`), z którego
 * apka składa zdanie karty bez decyzji (`UICopy.refuseMessage` przez fasadę `ServerText.sentence`, zanim ktokolwiek
 * tapnie). Zmiana jednego bez reszty daje dwa różne zdania o tej samej przyczynie: przy neutralnym zdaniu `mismatch`
 * zmieniały się naraz i nic tego nie pilnowało.
 * Porównanie po angielsku: serwer mówi angielskim tekstem rejestru, a angielska kolumna katalogu RarogContract
 * to ten sam szablon (`scripts/sentences-catalog.mjs --write`). Że RarogUI nie trzyma własnej kopii tych zdań, pilnuje
 * `shared/test/sentences-catalog-lustro.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFUSE_MESSAGES, REFUSE_REASONS } from '@rarog/shared';
import { SENTENCES } from '@rarog/shared/sentences';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = path.join(REPO, 'native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/Localizable.xcstrings');

interface Catalog { strings: Record<string, { localizations?: { en?: { stringUnit?: { value?: string } } } }> }

describe('zdanie powodu odmowy: rejestr, serwer i katalog zdań serwera w apce mówią to samo', () => {
  it('REFUSE_MESSAGES to `en` zdania `dialogs.refuse.<powód>` z rejestru, dla każdego powodu', () => {
    expect(Object.keys(REFUSE_MESSAGES).sort()).toEqual([...REFUSE_REASONS].sort());
    for (const reason of REFUSE_REASONS) {
      expect(REFUSE_MESSAGES[reason], reason).toBe(SENTENCES[`dialogs.refuse.${reason}`].en);
    }
  });

  it('każdy powód z REFUSE_REASONS ma w katalogu RarogContract (wariant `en`) to samo zdanie co REFUSE_MESSAGES', () => {
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as Catalog;
    const rows = REFUSE_REASONS.map((reason) => {
      const key = `server.dialogs.refuse.${reason}`;
      return { reason, key, app: catalog.strings[key]?.localizations?.en?.stringUnit?.value ?? null };
    });
    expect(rows).toEqual(rows.map(({ reason, key }) => ({ reason, key, app: REFUSE_MESSAGES[reason] })));
    // Katalog nie ma zdań powodów spoza kontraktu (wariant po usuniętym powodzie).
    const keys = Object.keys(catalog.strings).filter((key) => key.startsWith('server.dialogs.refuse.'));
    expect(keys.sort()).toEqual(rows.map(({ key }) => key).sort());
  });

  it('zdanie `mismatch` nie twierdzi, że narzędzie jest inne (najczęściej to samo, z ramką uciętą u góry)', () => {
    expect(REFUSE_MESSAGES.mismatch).not.toMatch(/different tool/u);
    expect(REFUSE_MESSAGES.mismatch)
      .toBe("Rarog couldn't confirm that the card matches the dialog in the terminal. Check it there.");
  });
});
