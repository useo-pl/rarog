/**
 * Wstrzyknięcie zestawu treści demo: manager, atrapa nadzorcy i notatki biorą treść z PODANEGO zestawu,
 * a demo bez zestawu nie startuje (nie ma języka domyślnego). Zestaw testowy to kopia polskiego ze zmienionymi
 * tekstami, więc każdy odbiorca, który sięgnąłby po polski na skróty, pokaże stary tekst.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoContentPl } from '../src/demo/content/pl.ts';
import type { DemoContent } from '../src/demo/content/types.ts';
import { createMockHerdr } from '../src/demo/mock-herdr.ts';
import { DEMO_NOTE_CWD, createDemoNotes } from '../src/demo/notes.ts';
import { demoDiff, demoResumable, demoSeeds } from '../src/demo/seeds.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';

/** Kopia zestawu PL z innym tekstem w każdym polu, które sprawdza test. */
const INNY: DemoContent = {
  ...demoContentPl,
  seeds: (kit) => demoContentPl.seeds(kit).map((seed) => ({ ...seed, label: `inny ${seed.id}` })),
  resumable: demoContentPl.resumable.map((entry) => ({ ...entry, firstPrompt: `inny: ${entry.firstPrompt}` })),
  diffPatch: demoContentPl.diffPatch.replace('saveNote', 'saveOther'),
  lastCommitSubject: 'feat(other): inny temat',
  noteText: 'Inna notatka',
  driver: { ...demoContentPl.driver, turnSummary: 'Inne podsumowanie.' },
};

describe('wstrzyknięcie zestawu treści demo', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'rarog-demo-zestaw-')); });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    await rm(dataDir, { force: true, recursive: true });
  });

  it('demo bez zestawu: `createManager` odmawia zamiast wziąć język domyślny', async () => {
    await expect(createManager({ demo: true, dataDir })).rejects.toThrow(/demoContent/);
  });

  it('manager (także z zastępczą atrapą nadzorcy) bierze seedy, „Wznów istniejącą” i diff z zestawu', async () => {
    const manager = await createManager({ demo: true, demoContent: INNY, dataDir });
    managers.push(manager);
    await manager.ready;
    const labels = manager.list().map((session) => session.label).sort();
    expect(labels).toEqual(demoSeeds(INNY).map((seed) => `inny ${seed.id}`).sort());
    const cwd = '/Users/demo/Projects/willow';
    expect((await manager.resumable(cwd)).map((entry) => entry.firstPrompt))
      .toEqual(demoResumable(INNY, cwd).map((entry) => entry.firstPrompt));
    expect((await manager.diff('demo-willow')).patch).toBe(demoDiff(INNY).patch);
    expect(demoDiff(INNY).patch).not.toBe(demoDiff(demoContentPl).patch);
  });

  it('atrapa nadzorcy: driver seeda kończy turę tekstem zestawu i jego tematem commitu', async () => {
    const mock = createMockHerdr(INNY);
    const driver = mock.supervisor.attach('demo-rarog-stop');
    const events: DriverEvent[] = [];
    const done = (async () => {
      for await (const event of driver.events) {
        events.push(event);
        if (event.type === 'result') return;
      }
    })();
    driver.send('Zrób przegląd.');
    await done;
    driver.dispose();
    mock.dispose();
    expect(events.find((event) => event.type === 'result')).toMatchObject({ summary: 'Inne podsumowanie.' });
    expect(events.find((event) => event.type === 'git-status'))
      .toMatchObject({ lastCommit: { subject: 'feat(other): inny temat' } });
  }, 20_000);

  it('notatki: zasiew i `reset` z zestawu', () => {
    const notes = createDemoNotes(INNY, () => 1_000);
    expect(notes.read(DEMO_NOTE_CWD).text).toBe('Inna notatka');
    notes.writeRemote(DEMO_NOTE_CWD, 'zmiana');
    notes.reset();
    expect(notes.read(DEMO_NOTE_CWD).text).toBe('Inna notatka');
  });
});
