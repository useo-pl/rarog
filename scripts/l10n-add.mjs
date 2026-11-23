#!/usr/bin/env node
// Adds one text key to the String Catalog of an app copy package, so an agent does not open the catalog
// (`docs/localization.md`, "Adding a text"):
//
//     node scripts/l10n-add.mjs <Package> <key> --en "<English>" --pl "<Polish>" --comment "<translator comment>"
//
// The entry gets `extractionState: manual` and both values in state `translated`; the key goes to its sorted place
// (code-unit order, the order Xcode writes). The file is written in Xcode's layout, and the script first checks
// that the catalog is already in that layout, so the diff is the new entry and nothing else. Before writing, the
// entry passes the value and parameter rules of `scripts/l10n-check.mjs` (`catalogProblems`). Plurals and other
// variations are not supported: add those in Xcode's catalog editor or by hand.
//
// Copy packages are the ones with `Sources/<Package>/Copy/L.swift` next to the catalog (RarogUI, RarogCore,
// RarogActivity). The server sentence catalog of RarogContract is generated from the server registry by
// `scripts/sentences-catalog.mjs` and is refused. Exit codes: 0 added, 1 refused (key exists, a value breaks a
// catalog rule, catalog not in Xcode's layout), 2 bad arguments or package. Node only, no dependencies.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/is-main.mjs';
import { catalogProblems, REQUIRED_LANGUAGES, SERVER_CATALOG_PACKAGE, SOURCE_LANGUAGE } from './l10n-check.mjs';

/** Repository root: the parent of `scripts/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = 'native/Rarog/Packages';
/** Key shape of the copy catalogs: a lowercase area, then dot-separated name parts (`composer.quoted.name`). */
export const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+$/;

const USAGE = [
  'Usage: node scripts/l10n-add.mjs <Package> <key> --en "<English>" --pl "<Polish>" --comment "<translator comment>"',
  '',
].join('\n');

/** Catalog path of a package, relative to the repository root. */
export const catalogPath = (name) => `${PACKAGES}/${name}/Sources/${name}/Copy/Localizable.xcstrings`;

/** Packages under `root` whose catalog is called through their own `L` function. */
export function copyPackages(root) {
  const packages = path.join(root, PACKAGES);
  if (!existsSync(packages)) return [];
  return readdirSync(packages)
    .filter((name) => existsSync(path.join(root, catalogPath(name)))
      && existsSync(path.join(packages, name, 'Sources', name, 'Copy', 'L.swift')))
    .sort();
}

/**
 * JSON in the layout Xcode writes for `.xcstrings`: two-space indent, `"key" : value`, keys in the object's own
 * order, an empty object as `{\n\n}`.
 */
export function xcodeJson(value, indent = 0) {
  const pad = '  '.repeat(indent + 1);
  const close = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => pad + xcodeJson(item, indent + 1)).join(',\n')}\n${close}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `{\n\n${close}}`;
    return `{\n${entries.map(([key, item]) => `${pad}${JSON.stringify(key)} : ${xcodeJson(item, indent + 1)}`)
      .join(',\n')}\n${close}}`;
  }
  return JSON.stringify(value);
}

/** A catalog entry with one plain value per language. */
export function catalogEntry({ en, pl, comment }) {
  const unit = (value) => ({ stringUnit: { state: 'translated', value } });
  return { comment, extractionState: 'manual', localizations: { en: unit(en), pl: unit(pl) } };
}

/**
 * The catalog text with the new key in its sorted place, or the reasons it is refused.
 * @param {string} text the catalog file as it is on disk
 * @param {{ key: string, en: string, pl: string, comment: string, file: string }} entry
 * @returns {{ text: string } | { problems: string[] }}
 */
export function addEntry(text, { key, en, pl, comment, file }) {
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    return { problems: [`${file}: not valid JSON (${error.message})`] };
  }
  if (`${xcodeJson(catalog)}\n` !== text) {
    return {
      problems: [`${file}: not in the layout Xcode writes, so the diff would not be the new entry alone; `
        + 'save the catalog once in Xcode (or fix it by hand) and run again'],
    };
  }
  const strings = catalog.strings ?? {};
  if (Object.hasOwn(strings, key)) {
    return { problems: [`${file}: "${key}" already exists; pick another key or change the entry by hand`] };
  }
  const entry = catalogEntry({ en, pl, comment });
  const problems = catalogProblems({ sourceLanguage: catalog.sourceLanguage, strings: { [key]: entry } },
    { file, required: REQUIRED_LANGUAGES, source: SOURCE_LANGUAGE });
  if (problems.length) return { problems };
  const keys = Object.keys(strings);
  const at = keys.findIndex((other) => other > key);
  const order = at === -1 ? [...keys, key] : [...keys.slice(0, at), key, ...keys.slice(at)];
  catalog.strings = Object.fromEntries(order.map((name) => [name, name === key ? entry : strings[name]]));
  return { text: `${xcodeJson(catalog)}\n` };
}

/**
 * The command. `root` is the repository the package paths are resolved in (tests pass a temporary copy).
 * @param {string[]} argv
 * @param {{ root?: string, stdout?: (text: string) => void, stderr?: (text: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, {
  root = REPO_ROOT,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { en: { type: 'string' }, pl: { type: 'string' }, comment: { type: 'string' }, help: { type: 'boolean' } },
    });
  } catch (error) {
    stderr(`l10n-add: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    stdout(USAGE);
    return 0;
  }
  const [name, key, ...extra] = parsed.positionals;
  const { en, pl, comment } = parsed.values;
  const missing = [['<Package>', name], ['<key>', key], ['--en', en], ['--pl', pl], ['--comment', comment]]
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([label]) => label);
  if (missing.length || extra.length) {
    const reason = missing.length ? `missing or empty: ${missing.join(', ')}` : `unexpected: ${extra.join(' ')}`;
    stderr(`l10n-add: ${reason}\n${USAGE}`);
    return 2;
  }
  if (!KEY_SHAPE.test(key)) {
    stderr(`l10n-add: "${key}" is not a catalog key; keys are area.name (letters and digits, dot-separated), `
      + 'see "Keys" in docs/localization.md\n');
    return 2;
  }
  const packages = copyPackages(root);
  if (!packages.includes(name)) {
    const why = name === SERVER_CATALOG_PACKAGE
      ? `${name} holds the server sentence catalog, which scripts/sentences-catalog.mjs generates from the server `
        + 'registry; add a server sentence there'
      : `${name} is not a copy package`;
    stderr(`l10n-add: ${why}. Copy packages: ${packages.join(', ') || 'none found'}\n`);
    return 2;
  }
  const file = catalogPath(name);
  const result = addEntry(readFileSync(path.join(root, file), 'utf8'), { key, en, pl, comment, file });
  if ('problems' in result) {
    stderr(`l10n-add: refused, nothing written:\n${result.problems.join('\n')}\n`);
    return 1;
  }
  writeFileSync(path.join(root, file), result.text);
  stdout(`l10n-add: added "${key}" to ${file}\n`
    + `Next: call L("${key}"${/%/.test(en.replace(/%%/g, '')) ? ', …' : ''}) in the registry of ${name} `
    + `(${PACKAGES}/${name}/Sources/${name}/Copy/), then run node scripts/l10n-check.mjs\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
