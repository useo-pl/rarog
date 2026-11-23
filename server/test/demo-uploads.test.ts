/**
 * Photo names in demo mode: the echo of a message with a photo carries `attachments[].file`, and the client (PWA
 * and native app) drops the frame when the name does not match `UPLOAD_IMAGE_FILE_PATTERN`. A mock name outside the
 * pattern (such as `demo-0.png`) would drop the `message` frame of every photo sent in the demo and leave the queue
 * entry without an echo.
 *
 * Also the rest of the fake supervisor that depends on the content set: the seed uploads (the bridge photos and the
 * images a set adds for its own messages, `extraUploads`) and the pane cap, which leaves room for a new session above
 * the live seeds of the set.
 */
import { basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_IMAGE_FILE_PATTERN } from '@rarog/shared';
import { createMockHerdr } from '../src/demo/mock-herdr.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import type { DemoContent } from '../src/demo/content/types.ts';
import { demoProjectCwd, demoSeedUploads } from '../src/demo/seeds.ts';

/** 1×1 px png. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

describe('demo: zapis zdjęć w kształcie herdr/uploads.ts', () => {
  it('nazwy pasują do wzorca kontraktu, rozszerzenie z typu obrazka', async () => {
    const mock = createMockHerdr(demoContentPl);
    try {
      const paths = await mock.deps.writeUploads('/Users/demo/Projects/rarog', [
        'data:image/png;base64,AAAA',
        'data:image/jpeg;base64,AAAA',
      ]);
      const names = paths.map((path) => basename(path));
      for (const name of names) expect(name).toMatch(UPLOAD_IMAGE_FILE_PATTERN);
      expect(names.map((name) => name.split('.').pop())).toEqual(['png', 'jpg']);
      expect(paths.every((path) => path.startsWith('/Users/demo/Projects/rarog/.rarog-uploads/'))).toBe(true);
    } finally {
      mock.dispose();
    }
  });
});

describe('demo: seed uploads of a content set', () => {
  it('en and pl keep only the bridge photos', () => {
    for (const content of [demoContentEn, demoContentPl]) {
      expect(demoSeedUploads(content).map((upload) => basename(upload.cwd))).toEqual([
        content.projects.bridge, content.projects.bridge,
      ]);
    }
  });

  it('`extraUploads` of a set go after the bridge photos, in the project of their role, and the mock serves them',
    async () => {
      const file = '1790000000009-73616d706c65696d.png';
      const content: DemoContent = { ...demoContentEn, extraUploads: [{ project: 'panel', file, dataUrl: PNG }] };
      const cwd = demoProjectCwd(content, 'panel');
      const uploads = demoSeedUploads(content);
      expect(uploads.slice(0, 2)).toEqual(demoSeedUploads(demoContentEn));
      expect(uploads.slice(2)).toEqual([{ cwd, file, dataUrl: PNG }]);
      const mock = createMockHerdr(content);
      try {
        expect((await mock.readUpload(cwd, file))?.mime).toBe('image/png');
      } finally {
        mock.dispose();
      }
    });
});

/** The English set with a second copy of each live seed: more live panes than the plain cap leaves free. */
const crowded: DemoContent = {
  ...demoContentEn,
  seeds: (kit) => {
    const seeds = demoContentEn.seeds(kit);
    const copies = seeds.filter((seed) => seed.live !== undefined).map((seed) => ({ ...seed, id: `${seed.id}-2` }));
    return [...seeds, ...copies];
  },
};

describe('pane cap of the demo', () => {
  afterEach(() => { vi.useRealTimers(); });

  // A fresh demo has room for a new session, so the compose button is not dimmed; a set with more live seeds than the
  // plain cap of six leaves, raises the cap. The `en` and `pl` sets keep six.
  it.each([
    ['en', demoContentEn, 6],
    ['pl', demoContentPl, 6],
    ['eight live seeds', crowded, 10],
  ] as const)('%s: a fresh demo can launch a session, the cap is %i', async (_name, content, cap) => {
    const mock = createMockHerdr(content);
    try {
      expect(mock.supervisor.status()).toMatchObject({ canLaunch: true });
      const req = { cwd: demoProjectCwd(content, 'panel') };
      await mock.supervisor.launch(req);
      vi.useFakeTimers({ toFake: ['Date'] });
      while (mock.supervisor.status().agentCount < cap) {
        vi.setSystemTime(Date.now() + 6_000);
        await mock.supervisor.launch(req);
      }
      expect(mock.supervisor.status()).toMatchObject({ agentCount: cap, canLaunch: false });
      vi.setSystemTime(Date.now() + 6_000);
      await expect(mock.supervisor.launch(req)).rejects.toThrow();
    } finally {
      mock.dispose();
    }
  });
});
