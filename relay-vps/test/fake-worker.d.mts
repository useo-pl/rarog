/** Typy atrapy Workera `fake-worker.mjs` dla testów `relay-vps/test/`. */

export type FakeMode = 'shadow' | 'enforce' | 'hang' | 'slow-headers' | 'slow-body' | 'partial' | 'partial-close'
  | 'bad-body' | 'big-body' | 'deny-bad' | '500' | '401';

export const MODES: readonly FakeMode[];

export interface FakeWorker {
  readonly state: {
    mode: FakeMode;
    readonly allow: Set<string>;
    readonly deny: Set<string>;
    requests: number;
    /** Nagłówki ostatniego żądania (małe litery). */
    last: Record<string, string> | null;
  };
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function startFakeWorker(opts?: { bearer?: string; mode?: FakeMode; port?: number; gapMs?: number }): Promise<FakeWorker>;
