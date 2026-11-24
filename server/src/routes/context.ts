/**
 * What a route group gets from the router: the server's dependencies (`RouteContext`, one per router) and the
 * parsed request (`RouteRequest`, one per request).
 *
 * A group is called only from `handle` in `router.ts`, after the `Origin` check, the credential and the review-mode
 * class; the body recheck is registered for the request by then. A group never checks any of them again and never
 * reads a body other than through `readJsonBody` or `readValidatedBody` of `router.ts`. The guard
 * `server/test/routes.test.ts` holds that no other module imports a group.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerSystem } from '@rarog/shared/rest';
import type { LoginLimiter, Principal } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import type { FileIndexer } from '../files/file-index.ts';
import type { FileDownloads } from '../files/send-file.ts';
import type { HealthProbes } from '../health.ts';
import type { NotesBackend } from '../notes/store.ts';
import type { Presence } from '../notify/presence.ts';
import type { ApnsFeature, Logger, RouterDeps } from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import type { SseHub } from '../sse.ts';
import type { UsageProvider } from '../usage.ts';
import type { CompanionTokenMinter } from '../companion/openai-token.ts';
import type { CompanionTurnsReader } from '../companion/turns.ts';
import type { SpeechKeyMinter, VoiceMinter } from '../voice/soniox.ts';
import type { TestCooldown } from './push.ts';

/** The router's dependencies after defaults, built once in `createRouter`. */
export interface RouteContext {
  readonly deps: RouterDeps;
  readonly config: RarogConfig;
  readonly manager: ManagerApi;
  readonly hub: SseHub;
  readonly serverStartId: string;
  readonly startedAtMs: number;
  readonly presence: Presence | undefined;
  readonly apns: ApnsFeature | undefined;
  readonly notes: NotesBackend;
  readonly system: ServerSystem;
  readonly voice: VoiceMinter;
  readonly companionToken: CompanionTokenMinter;
  /**
   * The voice agent works: `RAROG_COMPANION`, the module, the OpenAI key and the Soniox voice (`companionEnabled` and
   * `companionSpeech`).
   */
  readonly companionAvailable: boolean;
  /** The mode across sessions works: {@link companionAvailable} and `RAROG_COMPANION_SESSIONS` (`companionSessions`). */
  readonly companionSessionsAvailable: boolean;
  /** Reader of a session's last turns behind `GET /api/sessions/:id/companion/turns`. */
  readonly companionTurns: CompanionTurnsReader;
  /** Temporary Soniox speech keys of the voice agent. */
  readonly companionSpeechToken: SpeechKeyMinter;
  readonly usageProvider: UsageProvider;
  readonly healthProbes: HealthProbes;
  /** Secrets wiped from every logged exception (`logSecrets` in `config.ts`). */
  readonly secrets: readonly string[];
  readonly log: Logger;
  readonly interruptWaitMs: number;
  readonly apnsTestCooldown: TestCooldown;
  readonly loginLimiter: LoginLimiter;
  /** Session file downloads in flight by device, stopped by the unpair effects. */
  readonly fileDownloads: FileDownloads;
  /** Walks of the session file index, one per session directory at a time. */
  readonly fileIndex: FileIndexer;
}

/** One request after the gate: path without the trailing slash, its segments and the caller. */
export interface RouteRequest {
  readonly method: string;
  readonly url: URL;
  readonly pathname: string;
  readonly segments: readonly string[];
  /** The device behind the key; `undefined` only on a public path. */
  readonly principal: Principal | undefined;
  /** `principal.deviceId`, or `undefined` on a public path. */
  readonly owner: string | undefined;
}

/** A route group: answers and returns `true`, or returns `false` for a path it does not serve. */
export type RouteGroup = (
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
) => Promise<boolean>;

export function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
