/**
 * Kontrakt zestawu treści demo: wszystko, co klient widzi w trybie demo, w jednym obiekcie na język.
 *
 * Zestaw wybiera raz `index.ts` przy składaniu serwera (dynamiczny import, tylko w demo) i podaje go managerowi,
 * atrapie nadzorcy (`createMockHerdr`) i notatkom (`createDemoNotes`). Struktura demo (identyfikatory sesji,
 * role projektów, korzeń ścieżek, pliki diffu, nazwy zdjęć, kształty meldunków CLI) zostaje w `demo/seeds.ts`
 * i `drivers/mock-driver.ts`; zestaw składa z niej seedy przez {@link DemoSeedKit}. Treść scenariuszy testów UI
 * (`scenarios.ts`, `control.ts`) jest poza zestawem: działa tylko w testach UI, na zestawie polskim.
 * Zestawy: `pl.ts`, `en.ts`; wybór języka: `index.ts` obok (`demoContent`). Named sets (`RAROG_DEMO_CONTENT`):
 * `named-set.ts`.
 */
import type {
  Block, EffortLevel, MessageAttachment, PullRequestState, Question, SessionArtifact, SessionPullRequest,
} from '@rarog/shared';
import type { ServerSentence } from '@rarog/shared/sentences';
import type { DemoSeed, DemoSeedMessage, DemoSeedPermission } from '../seeds.ts';

/** Język zestawu treści demo. */
export type DemoLang = 'en' | 'pl';

/**
 * Name of a demo content set chosen instead of the language set (`RAROG_DEMO_CONTENT`, English only): the module of
 * the set directory with this name (`named-set.ts`). `parseDemoContent` lets only an existing set through.
 */
export type DemoSet = string;

/** One `gh pr create` call of a demo conversation and the output it printed (input of {@link DemoSeedKit}). */
export interface DemoPullRequestCall {
  /** The `Bash` command, literal. */
  readonly command: string;
  /** The tool output; a line holding exactly the PR URL makes the PR. */
  readonly output: string;
  /** How long before "now" the result arrived. */
  readonly agoMs: number;
}

/** One publication of an artifact in a demo conversation (input of {@link DemoSeedKit}). */
export interface DemoArtifactPublication {
  /** The artifact id (ASCII letters and digits); `seeds.ts` builds the claude.ai address from it. */
  readonly id: string;
  readonly title: string;
  /** How long before "now" it was published. */
  readonly agoMs: number;
}

/**
 * Rola projektu demo: struktura, ta sama w każdym języku. Do roli przypięte są ahead/behind (`DEMO_AHEAD_BEHIND`),
 * notatka z zasiewu (`import`), zdjęcia seedów (`bridge`) i kolejność w pickerze (`DEMO_PROJECT_KEYS`); nazwę
 * projektu, a z nią katalog `/Users/demo/Projects/<nazwa>`, daje zestaw ({@link DemoContent.projects}).
 */
export type DemoProjectKey = 'main' | 'stream' | 'cleanup' | 'import' | 'bridge' | 'panel';

/**
 * Klocki, z których zestaw składa seedy. Kształty, które muszą być takie same w każdym języku (krok narzędzia
 * z polami semantycznymi, meldunek CLI o zadaniu w tle, zdjęcia seedów, chwila resetu limitu), składa
 * `demo/seeds.ts`; zestaw podaje tylko tekst.
 */
export interface DemoSeedKit {
  /** „Teraz” w ms, od którego seedy liczą chwile (reset limitu). */
  readonly now: number;
  /** Katalog projektu demo tej roli (`/Users/demo/Projects/<nazwa z zestawu>`). */
  project(key: DemoProjectKey): string;
  /** Jeden blok tekstu. */
  text(value: string): Block[];
  /** Krok narzędzia: komenda powłoki dosłownie, wejście innych narzędzi jako JSON z wcięciem. */
  toolStep(toolName: string, summary: string, input: Record<string, unknown>): Block[];
  /** Edycja pliku z gotowym mini-diffem. */
  editStep(path: string, detail: string): Block[];
  /** Zapis nowego pliku: szczegół to diff z samych dodanych linii. */
  writeStep(path: string, content: string): Block[];
  /** Zgoda seeda na komendę powłoki. */
  shellPermission(permId: string, command: string, agoMs: number): DemoSeedPermission;
  /** Ahead/behind projektu tej roli z tabeli mock-drivera. */
  sync(key: DemoProjectKey): { ahead?: number; behind?: number };
  /** Dopisek stanu limitu planu: reset za stały czas od {@link now}. */
  limitReset(): `resetAt=${string}`;
  /** Dopisek stanu sesji po restarcie backendu (zdanie rejestru). */
  backendRestarted(): ServerSentence;
  /** Meldunek CLI: komenda w tle skończona. */
  commandCompleted(agoMs: number, command: string): DemoSeedMessage;
  /** Meldunek CLI: komenda w tle padła z kodem wyjścia. */
  commandFailed(agoMs: number, command: string, exitCode: number): DemoSeedMessage;
  /** Meldunek CLI: subagent zatrzymany. */
  agentStopped(agoMs: number, name: string): DemoSeedMessage;
  /** Załączniki pierwszej wiadomości ze zdjęciami: zrzut logu z serwera i plik PDF o tej nazwie. */
  bridgeLogAttachments(pdfName: string): MessageAttachment[];
  /** Załączniki drugiej wiadomości ze zdjęciami: zrzut z telefonu i zdjęcie po sprzątaniu 48 h. */
  bridgePhoneAttachments(): MessageAttachment[];
  /** Obrazek wykresu w treści odpowiedzi agenta. */
  chartImage(alt: string): Block;
  /**
   * The PR list of a conversation built from its `gh pr create` calls by the production reader
   * (`sessionPullRequests`), newest first; for a driver `pull-requests` event of a scene.
   */
  pullRequests(calls: readonly DemoPullRequestCall[]): SessionPullRequest[];
  /**
   * The artifact list of a conversation built from its publications by the production tracker
   * (`createArtifactsTracker`), newest first; for a driver `artifacts` event of a scene.
   */
  artifacts(publications: readonly DemoArtifactPublication[]): SessionArtifact[];
}

/** An image of a set's own seed message, kept in the demo uploads of a project next to the seed photos. */
export interface DemoExtraUpload {
  readonly project: DemoProjectKey;
  /** Name in the shape of `herdr/uploads.ts`, the `file` of the message attachment. */
  readonly file: string;
  /** PNG or JPEG data URL. */
  readonly dataUrl: string;
}

/** Wpis listy „Wznów istniejącą” (bez identyfikatora i ścieżki, które składa `demoResumable`). */
export interface DemoResumableText {
  readonly firstPrompt: string;
  readonly agoMs: number;
  readonly branch: string;
}

/** Wyzwalacze atrapy silnika: wejście zawierające którekolwiek słowo (po `toLowerCase`) daje ten skutek. */
export interface DemoTriggers {
  /** `question-request` z pytaniami {@link DemoDriverContent.questions}. */
  readonly question: readonly string[];
  /** `permission-request` z komendą klasyfikowaną jako red. */
  readonly red: readonly string[];
  /** `limit-reached` z resetem za 2 h. */
  readonly limit: readonly string[];
  /** `exit { ok: false }`. */
  readonly error: readonly string[];
}

/** Treść atrapy silnika (`drivers/mock-driver.ts`). */
export interface DemoDriverContent {
  /** Odpowiedzi tury interaktywnej, cykl po numerze tury. */
  readonly replies: readonly string[];
  /** Fragmenty strumienia scenariusza „streaming”; ostatni domyka akapit, bo cykl się zapętla. */
  readonly streamFragments: readonly string[];
  /** Pytania wyzwalacza `question`, drugie z `multiSelect: true`. */
  readonly questions: readonly Question[];
  readonly triggers: DemoTriggers;
  /** Wstęp odpowiedzi, która odbija obrazki z wiadomości (z odmianą liczby). */
  imagesEcho(count: number): string;
  /** Opis obrazka odbitego z wiadomości (numer od 1). */
  imageAlt(index: number): string;
  /** Odpowiedź po odmowie zgody. */
  readonly deniedReply: string;
  /** Podsumowanie tury po odmowie zgody. */
  readonly deniedSummary: string;
  /** Podsumowanie zwykłej tury. */
  readonly turnSummary: string;
}

/**
 * Stałe trybu recenzji: proces recenzji bierze te wartości zamiast nazwy hosta i pliku ustawień konta
 * (`~/.claude/settings.json`). Składa je `index.ts`.
 */
export interface DemoReviewConstants {
  /** Nazwa serwera w odpowiedzi parowania (`PairResponse.server.name`) zamiast `hostname()`. */
  readonly serverName: string;
  /** Model nowej sesji bez modelu w żądaniu (zamiast `readAccountDefaultModel`). */
  readonly model: string;
  /** Effort nowej sesji bez effortu w żądaniu (zamiast `readAccountDefaultEffort`). */
  readonly effort: EffortLevel;
}

/** Zestaw treści demo jednego języka. */
export interface DemoContent {
  /** Nazwy projektów demo według roli (katalog = `/Users/demo/Projects/<nazwa>`). */
  readonly projects: Readonly<Record<DemoProjectKey, string>>;
  /** 8 sesji startowych (kolejność ma znaczenie: dwie sesje czekają na człowieka). */
  seeds(kit: DemoSeedKit): DemoSeed[];
  /** Wpisy „Wznów istniejącą”, od najnowszego; wpis `-0` w projekcie `main` to rozmowa żywej karty `demo-willow`. */
  readonly resumable: readonly DemoResumableText[];
  /** Patch diffu sesji demo; pliki i liczniki muszą się zgadzać z `DEMO_DIFF_FILES`. */
  readonly diffPatch: string;
  /** Temat ostatniego commitu w ramce `git-status`. */
  readonly lastCommitSubject: string;
  /** Notatka projektu z zasiewu (nagłówek, lista, kod w linii i link). */
  readonly noteText: string;
  readonly driver: DemoDriverContent;
  readonly review: DemoReviewConstants;
  /**
   * Tailnet name in `GET /api/version` of the plain demo, instead of the host's `tailscale status`: a demo shown,
   * recorded or captured must not reveal the host's tailnet. `null` = the demo answers `null`, so the app shows the
   * machine without a tailnet. The review mode answers `null` whatever the set says.
   */
  readonly tailnet: string | null;
  /** Images of the set's own seed messages in the demo uploads, after the seed photos (`demoSeedUploads`). */
  readonly extraUploads?: readonly DemoExtraUpload[];
  /** GitHub states of the set's own PRs, added to the fixed state map of the demo (`demoPullRequestStates`). */
  readonly pullRequestStates?: readonly (readonly [string, PullRequestState])[];
}
