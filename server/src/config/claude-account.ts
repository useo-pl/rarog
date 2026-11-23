/**
 * Default model and effort of the Claude Code account, read from `~/.claude/settings.json` for display only.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_LEVELS } from '@rarog/shared';
import type { EffortLevel } from '@rarog/shared';

/**
 * Ustawienia konta CLI (`~/.claude/settings.json`) jako surowy obiekt albo `null`.
 *
 * To jest DOKŁADNIE ten plik, który przestawiają `/model` i `/effort` w panelu, więc odczyt
 * nie jest zgadywaniem: panel uruchomiony bez flag wstaje na tym, co tu stoi. Czytamy ŚWIEŻO
 * przy każdym wywołaniu (plik zmienia się w trakcie życia serwera) i wyłącznie do WYŚWIETLENIA
 * — żadna z tych wartości nigdy nie idzie do argv. Brak pliku, zepsuty JSON, coś innego niż
 * obiekt = `null` i cisza; awaria odczytu ma dawać pustą pigułkę, nie wywracać uruchomienie.
 */
function readClaudeSettings(home: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    );
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Domyślny model konta CLI — pole `model` w `~/.claude/settings.json`.
 *
 * Brak pliku, zepsuty JSON albo brak pola = `undefined`, czyli pigułka „model?" do
 * pierwszego `init`.
 */
export function readAccountDefaultModel(home: string = os.homedir()): string | undefined {
  const model = readClaudeSettings(home)?.['model'];
  return typeof model === 'string' && model !== '' ? model : undefined;
}

/** Poziom effortu z obiektu ustawień — pole `effortLevel`, walidowane przeciw kontraktowi. */
function effortField(source: unknown): EffortLevel | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)['effortLevel'];
  return EFFORT_LEVELS.find((level) => level === value);
}

/**
 * Wpisy `modelSettings` widziane przez SKRÓT CLI (`opus`, `sonnet`, `fable`).
 *
 * Klucze w tym pliku są pełnymi identyfikatorami (`claude-opus-5`), a Rarog składa argv ze
 * skrótu — własnego z formularza albo tego z pola `model` w tym samym pliku. Bez przejścia
 * skrót → wpis pytanie trafia w pustkę i seed spada na wartość globalną: przy
 * `modelSettings['claude-opus-5'].effortLevel: xhigh` i globalnym `effortLevel: high` apka pokazałaby opus high,
 * a herdr opus xhigh.
 *
 * WERSJI NIE ZGADUJEMY i to jest sedno tej funkcji. Gdy skrót pasuje do kilku wpisów
 * o RÓŻNYCH poziomach (`claude-opus-4-7: high` obok `claude-opus-5: xhigh`), nie wiadomo,
 * który z nich CLI wybierze — wraca wtedy `undefined`, czyli wartość globalna.
 * Wpisy zgodne są jednoznaczne niezależnie od tego, który wygra, i tylko takie
 * przepuszczamy.
 */
function aliasEffort(perModel: Record<string, unknown>, alias: string): EffortLevel | undefined {
  // Wariant okna (`opus[1m]`) nie jest częścią rodziny: wpis stoi pod `claude-opus-5-5`.
  const prefix = `claude-${alias.replace(/\[1m\]$/, '')}-`;
  const levels = new Set<EffortLevel>();
  for (const [key, value] of Object.entries(perModel)) {
    if (!key.startsWith(prefix)) continue;
    const level = effortField(value);
    if (level !== undefined) levels.add(level);
  }
  const [only] = levels;
  return levels.size === 1 ? only : undefined;
}

/**
 * Domyślny effort konta CLI dla DANEGO modelu — bliźniak `readAccountDefaultModel`.
 *
 * CLI trzyma effort w dwóch miejscach i pierwszeństwo ma to węższe:
 * `modelSettings[<model>].effortLevel` bije globalne `effortLevel`. Panel uruchomiony bez
 * `--effort` wstaje właśnie na tym.
 *
 * Kolejność pytań: wpis DOKŁADNY, potem wpis widziany przez skrót (patrz `aliasEffort`),
 * na końcu globalny `effortLevel`.
 */
export function readAccountDefaultEffort(
  model?: string, home: string = os.homedir(),
): EffortLevel | undefined {
  const settings = readClaudeSettings(home);
  if (settings === null) return undefined;
  if (model !== undefined && model !== '') {
    const perModel = settings['modelSettings'];
    if (typeof perModel === 'object' && perModel !== null) {
      const entries = perModel as Record<string, unknown>;
      const own = effortField(entries[model]);
      if (own !== undefined) return own;
      const byAlias = aliasEffort(entries, model);
      if (byAlias !== undefined) return byAlias;
    }
  }
  return effortField(settings);
}
