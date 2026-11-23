/**
 * Notatki projektu w trybie pokazowym — magazyn w PAMIĘCI PROCESU.
 *
 * Demo nie dotyka dysku, a jego projekty to fikcyjne ścieżki (`DEMO_PROJECTS_ROOT`), na których `realpath`
 * magazynu plikowego padłby jako 400. Notatki demo istnieją dla testów UI apki natywnej i złotych odpowiedzi
 * REST: te same wyjątki (`NotesFailure`), ten sam warunek wersji i ta sama reguła podbicia `updatedAt` co
 * `notes/store.ts`, tylko bez pliku. Kluczem jest `cwd` po `checkCwd` (`path.resolve`), bo w demo nie ma czego
 * rozwijać.
 *
 * Zasiew to jedna notatka w projekcie roli `import` (`data-loader` po polsku; sesja demo bez tury: testy UI nie
 * czekają na spoczynek strumieniującej sesji). `reset` (kontrola testów, `control.ts`) wraca do zasiewu,
 * a `writeRemote` udaje zapis z innego urządzenia: bez warunku wersji, z nowym `updatedAt`.
 */
import { notesEmpty } from '@rarog/shared';
import type { NotesDoc } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { NotesFailure } from '../notes/store.ts';
import type { NotesBackend } from '../notes/store.ts';
import { demoContentPl } from './content/pl.ts';
import { demoProjectCwd } from './seeds.ts';
import type { DemoContent } from './content/types.ts';

/**
 * Projekt demo z notatką w zasiewie zestawu polskiego. Czyta go kontrola demo (`control.ts`), która działa tylko
 * w testach UI na zestawie polskim; zasiew innego zestawu leży w katalogu jego projektu roli `import`.
 */
export const DEMO_NOTE_CWD = demoProjectCwd(demoContentPl, 'import');

/** Wersja zasiewu: stała, żeby złote odpowiedzi REST nie zależały od zegara. */
export const DEMO_NOTE_UPDATED_AT = Date.parse('2026-10-14T19:40:00.000Z');

export interface DemoNotes extends NotesBackend {
  /** Które z podanych katalogów mają niepustą notatkę (`SseHub.notesFor`). */
  withNotes(cwds: readonly string[]): string[];
  /** Powrót do zasiewu (kontrola testów). */
  reset(): void;
  /** Zapis „z innego urządzenia": bez warunku wersji, nowy `updatedAt`. */
  writeRemote(cwd: string, text: string): NotesDoc;
}

/**
 * @param content zestaw treści demo: tekst notatki z zasiewu (`noteText`: nagłówek, lista, kod w linii i link)
 * @param now zegar wersji zapisu
 */
export function createDemoNotes(content: DemoContent, now: () => number = Date.now): DemoNotes {
  const docs = new Map<string, NotesDoc>();
  const seedCwd = demoProjectCwd(content, 'import');

  function seed(): void {
    docs.clear();
    docs.set(seedCwd, { text: content.noteText, updatedAt: DEMO_NOTE_UPDATED_AT });
  }

  function read(cwd: string): NotesDoc {
    return docs.get(cwd) ?? { text: '', updatedAt: 0 };
  }

  /** Ta sama reguła co `writeNotes`: wersja nigdy nie stoi w miejscu, nawet w tej samej milisekundzie. */
  function put(cwd: string, text: string): NotesDoc {
    const next = { text, updatedAt: Math.max(now(), read(cwd).updatedAt + 1) };
    docs.set(cwd, next);
    return next;
  }

  seed();
  return {
    read,
    write(cwd, text, expectedUpdatedAt) {
      const current = read(cwd);
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new NotesFailure('conflict', say('rest.notes-conflict'), current);
      }
      return put(cwd, text);
    },
    withNotes: (cwds) => [...new Set(cwds)].filter((cwd) => !notesEmpty(read(cwd).text)),
    reset: seed,
    writeRemote: put,
  };
}
