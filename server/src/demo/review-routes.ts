/**
 * Klasy tras w trybie recenzji demo: co recenzent z kluczem urządzenia dostaje,
 * a czego nie. Bramka w `handle` routera (`server/src/router.ts`) pyta {@link classifyReviewRoute} po bramce
 * poświadczeń i przed routingiem, wyłącznie przy `config.demoReview !== null`. Poza trybem recenzji tabela nie
 * działa.
 *
 * Klasy:
 * - `allow`: żądanie idzie do routera jak w zwykłym demo; metodę i ciało sprawdza dalej router (405, 400 jak dziś);
 * - `retired`: `/api/login`, router odpowiada stałym 410 `login-retired` jak na każdym serwerze;
 * - `refuse`: 403 `demo-review` ze zdaniem `demo.review-refused`; trasa istnieje, ale recenzent jej nie dostaje;
 * - `absent`: 404 `not-found` jak nieznana ścieżka. To klasa KAŻDEJ ścieżki spoza tabeli (domyślna odmowa), więc
 *   trasa dopisana do routera bez wpisu tutaj w trybie recenzji nie istnieje.
 *
 * Wzorzec bez `:id` i `*` porównuje się z całą ścieżką dokładnie, tak jak `pathname === …` w routerze. `:id` to
 * jeden dowolny segment, `*` na końcu to co najmniej jeden segment pod prefiksem. Wzorzec z `:id` łapie też dłuższe
 * ścieżki: podakcje sesji (`diff/files`, `diff/file`, `uploads/:file`, `permissions/:id`, `answers/:id`) dziedziczą
 * klasę akcji, bo jednostką podścieżki sesji jest `segments[3]`. Ścieżka to `pathname` routera (bez końcowych
 * ukośników), a segmenty liczy się tak samo jak w routerze (puste odpadają), więc tabela i router widzą tę samą
 * ścieżkę.
 *
 * Wpis z `outside` obsługuje inny plik niż router; inwentarz tras (`server/test/demo-review-routes.test.ts`) nie
 * szuka go w `router.ts`. Inwentarz jest pomocniczy: dowodem izolacji są testy zachowania, nie skan źródła.
 */

/** Klasa trasy w trybie recenzji; znaczenia w nagłówku modułu. */
export type ReviewRouteClass = 'allow' | 'retired' | 'refuse' | 'absent';

export interface ReviewRoute {
  /** Wzorzec ścieżki: literał, `:id` za jeden segment, `*` na końcu za resztę ścieżki. */
  readonly route: string;
  readonly class: ReviewRouteClass;
  /** Plik, który obsługuje trasę poza routerem (router jej nie zna). */
  readonly outside?: string;
}

/** Akcje `/api/sessions/:id/<akcja>` (`segments[3]` w routerze): wszystkie dozwolone, podakcje dziedziczą klasę. */
const SESSION_ACTIONS = [
  'answers', 'close', 'commands', 'diff', 'focus', 'interrupt', 'messages', 'mode', 'model', 'permission',
  'permissions', 'queue', 'restart', 'resume', 'seen', 'stream', 'unseen', 'uploads',
] as const;

export const REVIEW_ROUTES: readonly ReviewRoute[] = [
  { route: '/health', class: 'allow' },
  { route: '/api/version', class: 'allow' },
  { route: '/api/pair', class: 'allow' },
  { route: '/api/login', class: 'retired' },
  // Kod dla kolejnego urządzenia: liczba urządzeń recenzji zależy wyłącznie od kodu recenzenta i jego sufitu.
  { route: '/api/pairings', class: 'refuse' },
  { route: '/api/devices', class: 'allow' },
  { route: '/api/devices/me', class: 'allow' },
  { route: '/api/devices/forget', class: 'allow' },
  { route: '/api/stream', class: 'allow' },
  { route: '/api/notes', class: 'allow' },
  { route: '/api/client-log', class: 'allow' },
  { route: '/api/presence', class: 'allow' },
  { route: '/api/projects', class: 'allow' },
  { route: '/api/projects/recent', class: 'allow' },
  { route: '/api/resumable', class: 'allow' },
  { route: '/api/resumable/recent', class: 'allow' },
  { route: '/api/usage', class: 'allow' },
  { route: '/api/usage/details', class: 'allow' },
  { route: '/api/mac', class: 'allow' },
  { route: '/api/models', class: 'allow' },
  { route: '/api/fs', class: 'allow' },
  { route: '/api/voice/token', class: 'allow' },
  { route: '/api/push/apns', class: 'allow' },
  { route: '/api/push/apns/unregister', class: 'allow' },
  { route: '/api/push/apns/status', class: 'allow' },
  { route: '/api/push/live-activity', class: 'allow' },
  { route: '/api/push/live-activity/end', class: 'allow' },
  { route: '/api/sessions', class: 'allow' },
  ...SESSION_ACTIONS.map((action): ReviewRoute => ({ route: `/api/sessions/:id/${action}`, class: 'allow' })),
  // Kod parowania dla testów UI, który odpina wszystkie urządzenia: w trybie recenzji router go nie wydaje.
  { route: '/api/demo/pairing', class: 'absent' },
  // Agent głosowy: demo nie ma pliku rozmowy ani procesu `claude -p`, więc trasy nie ma także dla recenzenta.
  { route: '/api/sessions/:id/companion', class: 'absent' },
  { route: '/api/companion/token', class: 'absent' },
  { route: '/api/companion/speech-token', class: 'absent' },
  { route: '/api/companion/sessions', class: 'absent' },
  { route: '/api/demo/control', class: 'absent', outside: 'server/src/demo/control.ts' },
  { route: '/api/term', class: 'absent' },
  { route: '/api/term/:id', class: 'absent' },
  { route: '/api/term/:id/history', class: 'absent' },
  // Creating a directory writes to the disk through a child process, which no demo starts.
  { route: '/api/fs/mkdir', class: 'absent' },
  { route: '/api/admin/*', class: 'absent', outside: 'server/src/auth/admin.ts' },
];

const isPattern = (route: string): boolean => route.includes('/:') || route.endsWith('/*');

const segmentsOf = (pathname: string): string[] => pathname.split('/').filter((s) => s !== '');

const EXACT: ReadonlyMap<string, ReviewRouteClass> = new Map(
  REVIEW_ROUTES.filter((entry) => !isPattern(entry.route)).map((entry) => [entry.route, entry.class]),
);

/** Wzorce z `:id` albo `*`, najdłuższe najpierw: dokładniejszy wzorzec wygrywa z krótszym prefiksem. */
const PATTERNS: readonly { readonly parts: readonly string[]; readonly class: ReviewRouteClass }[] = REVIEW_ROUTES
  .filter((entry) => isPattern(entry.route))
  .map((entry) => ({ parts: segmentsOf(entry.route), class: entry.class }))
  .sort((a, b) => b.parts.length - a.parts.length);

/** Klasa ścieżki `pathname` routera w trybie recenzji; ścieżka spoza tabeli to `absent`. */
export function classifyReviewRoute(pathname: string): ReviewRouteClass {
  const exact = EXACT.get(pathname);
  if (exact !== undefined) return exact;
  const segments = segmentsOf(pathname);
  for (const pattern of PATTERNS) {
    if (segments.length < pattern.parts.length) continue;
    if (pattern.parts.every((part, i) => part === ':id' || part === '*' || part === segments[i])) return pattern.class;
  }
  return 'absent';
}
