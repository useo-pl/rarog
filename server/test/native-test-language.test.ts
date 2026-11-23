/**
 * Strażnik języka testów apki natywnej (`docs/localization.md`, „Tests”). Asercje XCUITest i testów UIKit stoją na
 * polskich zdaniach, a symulator startuje w `en_US`; apka bez przypięcia mówiłaby po angielsku, gdy tylko katalog
 * ma angielskie tłumaczenie. Przypięcie ma cztery miejsca i każde pilnujemy tutaj, bo żadne z nich nie przewraca się
 * samo, gdy zniknie (test na polskim zdaniu przechodzi, dopóki katalog nie ma angielskiego):
 * 1. jedno miejsce tworzenia `XCUIApplication` apki (`DemoServer.makeApp(language:)`), domyślnie z `-AppleLanguages
 *    (pl) -AppleLocale pl_PL`; inny język test wybiera jawnie parametrem (`.en`: zestaw dymny `EnglishSmokeUITests`),
 *    język i region idą w parze; testy dokładają argumenty `+=`, nie podstawiają listy i nie podają `-AppleLanguages`
 *    same;
 * 2. schemat `Rarog`: `RAROG_COPY_LANGUAGE=pl` w akcji testów (proces testów UIKit, `CopyLanguage`);
 * 3. `scripts/ios-check.sh` i `scripts/check.sh` — sprawdzają je testy skryptów (`scripts-ios-check-demo.test.ts`,
 *    `scripts-check.test.ts`);
 * 4. przepis „Selected tests next to other sessions” w `native/Rarog/docs/tests.md`, z którego agenci kopiują komendy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_TESTS = path.join(REPO, 'native/Rarog/RarogUITests');
const FACTORY = 'DemoServer.swift';

/** Kod bez komentarzy liniowych (`//`, `///`) — o `XCUIApplication()` wolno pisać w komentarzu. */
function code(text: string): string {
  return text.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

describe('język testów apki natywnej przypięty na polski', () => {
  const sources = readdirSync(UI_TESTS).filter((file) => file.endsWith('.swift'))
    .map((file) => ({ file, text: code(readFileSync(path.join(UI_TESTS, file), 'utf8')) }));

  it('XCUIApplication apki powstaje wyłącznie w DemoServer.makeApp, z językiem i regionem', () => {
    expect(sources.length).toBeGreaterThan(30);
    const outside = sources.filter(({ file, text }) => file !== FACTORY && text.includes('XCUIApplication()'))
      .map(({ file }) => file);
    expect(outside, 'twórz apkę przez DemoServer.makeApp()').toEqual([]);
    const factory = sources.find(({ file }) => file === FACTORY)?.text ?? '';
    expect(factory.split('XCUIApplication()').length - 1).toBe(1);
    expect(factory).toMatch(
      /func makeApp\(language: AppLanguage = \.pl\) -> XCUIApplication \{\n\s*let app = XCUIApplication\(\)\n\s*app\.launchArguments \+= language\.arguments\n/);
    // `launch(port:…)` też domyślnie po polsku i z tym samym językiem dla `makeApp`.
    expect(factory).toMatch(/static func launch\([^)]*language: AppLanguage = \.pl\s*\) -> XCUIApplication \{\n\s*let app = makeApp\(language: language\)\n/);
  });

  it('każdy język apki pod testem: lista języków i region tego samego języka; polski jest wśród nich', () => {
    const factory = sources.find(({ file }) => file === FACTORY)?.text ?? '';
    const cases = [...factory.matchAll(/case \.(\w+): \[(.*)\]/g)].map(([, name, list]) => ({ name, list }));
    expect(cases.map(({ name }) => name)).toContain('pl');
    expect(cases.find(({ name }) => name === 'pl')?.list).toBe('"-AppleLanguages", "(pl)", "-AppleLocale", "pl_PL"');
    for (const { name, list } of cases) {
      expect(list, name).toMatch(new RegExp(`^"-AppleLanguages", "\\(${name}\\)", "-AppleLocale", "${name}_[A-Z]{2}"$`));
    }
  });

  it('język i region podaje wyłącznie DemoServer: test wybiera język parametrem, nie własnym argumentem', () => {
    const own = sources.filter(({ file, text }) => file !== FACTORY && /-Apple(Languages|Locale)/.test(text))
      .map(({ file }) => file);
    expect(own, 'język testu: DemoServer.makeApp(language:) albo launch(…, language:)').toEqual([]);
  });

  it('żaden test nie podstawia listy argumentów startu (zgubiłby język)', () => {
    const assigned = sources.filter(({ text }) => /\blaunchArguments\s*=(?!=)/.test(text)).map(({ file }) => file);
    expect(assigned).toEqual([]);
  });

  it('schemat Rarog daje procesowi testów RAROG_COPY_LANGUAGE=pl', () => {
    const scheme = readFileSync(path.join(REPO, 'native/Rarog/Rarog.xcodeproj/xcshareddata/xcschemes/Rarog.xcscheme'), 'utf8');
    const testAction = /<TestAction[\s\S]*?<\/TestAction>/.exec(scheme)?.[0] ?? '';
    // Z `shouldUseLaunchSchemeArgsEnv = "YES"` akcja testów brałaby środowisko akcji uruchomienia, a własne pomijała.
    expect(testAction).toContain('shouldUseLaunchSchemeArgsEnv = "NO"');
    expect(testAction).toMatch(/key = "RAROG_COPY_LANGUAGE"\s+value = "pl"\s+isEnabled = "YES"/);
  });

  it('przepis „Wybrane testy” w README niesie język testów', () => {
    const readme = readFileSync(path.join(REPO, 'native/Rarog/docs/tests.md'), 'utf8');
    const recipe = /\*\*Selected tests next to other sessions\.\*\*[\s\S]*?(?=\n\*\*Queue\.\*\*)/.exec(readme)?.[0] ?? '';
    expect(recipe).toContain('RAROG_COPY_LANGUAGE=pl');
    expect(recipe).toContain('-testLanguage pl -testRegion PL');
    expect(recipe).toContain('TEST_RUNNER_RAROG_COPY_LANGUAGE=pl');
  });
});
