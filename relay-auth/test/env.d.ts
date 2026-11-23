// Typy funkcji Vite używanych w testach (bez @types/node i bez vite/client): surowy tekst pliku (`?raw`)
// i `import.meta.glob` do odczytu fixture'ów z `shared/fixtures/` i źródeł z `src/`.
declare module '*?raw' {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, T>;
}

// Kontekst żądania w atrapie rejestru (`LocalRegistry.within`): `AsyncLocalStorage` z Node, typy bez @types/node.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
