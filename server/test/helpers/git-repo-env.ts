/**
 * Zmienne gita, które wskazują repozytorium (katalog `.git`, drzewo robocze, indeks, obiekty, refy), a nie
 * konfigurują gita. `vitest.config.ts` usuwa je z `process.env` procesu głównego vitest, zanim powstaną procesy
 * robocze, więc każdy plik testów i każdy jego podproces (`git -C <tmp> …`, `bash scripts/…`) dostaje
 * środowisko bez nich. Dowód: `server/test/git-repo-env.test.ts`.
 *
 * Powód: testy puszczone w `git rebase --exec` w linked worktree dostały od gita
 * `GIT_DIR=<repo>/.git/worktrees/<wt>`. Przy ustawionym `GIT_DIR` git ignoruje katalog z `-C`, więc commity, gałąź
 * i tag repo-atrapy z testów trafiły do prawdziwego repo, a `git init --bare` ustawił mu `core.bare = true`. Hook
 * `pre-commit` w linked worktree dostaje `GIT_DIR` i `GIT_INDEX_FILE` (`<gitdir>/index.lock`); zmierzone na
 * git 2.54, gdzie `rebase --exec` w zwykłym checkoucie podaje tylko pusty `GIT_PREFIX`.
 *
 * Źródło listy: `man git`, ENVIRONMENT, „The Git Repository”, i `git rev-parse --local-env-vars`, czyli zmienne,
 * które git sam czyści, gdy przechodzi do innego repozytorium. Dodane spoza tej listy: `GIT_NAMESPACE` (refy
 * w przestrzeni nazw), `GIT_QUARANTINE_PATH` (kwarantanna obiektów w hooku `pre-receive`) i `GIT_REFERENCE_BACKEND`
 * (format i miejsce refów). `GIT_CONFIG` bez przyrostka jest na liście, bo przekierowuje zapis `git config` z
 * `.git/config` repozytorium do innego pliku. Zostają: konfiguracja (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`
 * z parami, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`; środowisko wołającego podaje nimi np. proxy
 * i `safe.directory`), autor i committer, `GIT_CEILING_DIRECTORIES` i przełączniki zachowania
 * (`GIT_NO_REPLACE_OBJECTS`, `GIT_REPLACE_REF_BASE`, `GIT_EDITOR`…). Test porównuje listę z wyjściem
 * `git rev-parse --local-env-vars`, więc nowa zmienna z tego wyjścia trafia albo tutaj, albo na listę zostających
 * w teście.
 */
export const GIT_REPO_ENV_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_REFERENCE_BACKEND',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_CONFIG',
  'GIT_PREFIX',
] as const);

/** Usuwa z `env` (w miejscu) zmienne {@link GIT_REPO_ENV_VARS}. */
export function stripGitRepoEnv(env: NodeJS.ProcessEnv): void {
  for (const name of GIT_REPO_ENV_VARS) delete env[name];
}
