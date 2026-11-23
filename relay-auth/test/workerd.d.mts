/** Typy uchwytu rejestru w lokalnym `workerd` (`workerd.mjs`) dla `workerd.test.ts`. */

export interface FakeApple {
  /** Bity DeviceCheck per token urządzenia. */
  readonly bits: Map<string, { bit0: boolean; bit1: boolean }>;
  readonly calls: { readonly host: string; readonly path: string; readonly authorization: string }[];
  handle(request: Request): Promise<Response>;
}

/** `month`: `YYYY-MM` ostatniej zmiany bitów, który atrapa podaje w odpowiedzi `query_two_bits`. */
export function createFakeApple(month: string): FakeApple;

export interface LocalRegistry {
  readonly url: URL;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export function startRegistry(options: { vars: Record<string, string>; apple: FakeApple }): Promise<LocalRegistry>;

export interface Adapter {
  readonly port: number;
  /** Linie logu adaptera (stdout). */
  readonly lines: string[];
  stop(): Promise<void>;
}

/** Prawdziwy adapter haka (`relay-vps/access-adapter.mjs`) przed `workerUrl`; `negTtlMs` 0 = bez cache'u odmów. */
export function startAdapter(workerUrl: string, options?: { deadlineMs?: number; negTtlMs?: number }): Promise<Adapter>;
