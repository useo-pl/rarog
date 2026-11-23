/**
 * Notki harnessu i zdjęcia w demo. Apka natywna sprawdza XCUITestem jedno
 * zdanie notki zamiast surowego wpisu i miniatury zdjęć z `GET …/uploads/:file`, więc seed `demo-pipe-link` niesie
 * notki harnessu i zdjęcia, a mock nadzorcy oddaje bajty zdjęć z RAM — także tych wysłanych w trakcie pokazu.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_DATA_URL_PATTERN, UPLOAD_IMAGE_FILE_PATTERN } from '@rarog/shared';
import { DEMO_MAX_UPLOADS, createMockHerdr } from '../src/demo/mock-herdr.ts';
import { demoSeedUploads, demoSeeds } from '../src/demo/seeds.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { noticeFromText } from '../src/herdr/background/notice.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const BRIDGE = '/Users/demo/Projects/pipe-link';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bridgeSeed() {
  const seed = demoSeeds(demoContentPl).find((candidate) => candidate.id === 'demo-pipe-link');
  if (seed === undefined) throw new Error('brak seeda demo-pipe-link');
  return seed;
}

describe('seed demo-pipe-link: notki harnessu i zdjęcia', () => {
  it('notki niosą surowy wpis w blokach i notkę policzoną z niego (stara PWA i nowa apka)', () => {
    const notices = bridgeSeed().messages.filter((message) => message.notice !== undefined);
    expect(notices.map((message) => message.notice)).toEqual([
      { kind: 'command', outcome: 'done', name: 'pnpm test -- bridge', exitCode: 0 },
      { kind: 'agent', outcome: 'halted', name: 'przegląd logu obecności' },
      { kind: 'command', outcome: 'failed', name: 'pnpm run e2e:presence', exitCode: 1 },
    ]);
    for (const message of notices) {
      expect(message.role).toBe('user');
      const [block] = message.blocks;
      expect(block?.type).toBe('text');
      if (block?.type !== 'text') continue;
      expect(block.text.startsWith('<task-notification>')).toBe(true);
      expect(message.notice).toEqual(noticeFromText(block.text));
    }
  });

  it('historia rośnie w czasie, etykieta i pierwszy prompt bez zmian', () => {
    const seed = bridgeSeed();
    const ages = seed.messages.map((message) => message.agoMs);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
    expect(seed.label).toBe('mostek zdarzeń');
    expect(seed.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Dorób mostek zdarzeń i log obecności.' },
    ]);
  });

  it('zdjęcia: nazwy z wzorca kontraktu, obrazek w treści jako poprawny data URL', () => {
    const seed = bridgeSeed();
    const attachments = seed.messages.flatMap((message) => message.attachments ?? []);
    const files = attachments.flatMap((attachment) => (attachment.file === undefined ? [] : [attachment.file]));
    expect(files).toHaveLength(3);
    for (const file of files) expect(file).toMatch(UPLOAD_IMAGE_FILE_PATTERN);
    // Zdjęcie z historii bez nazwy i wagi (jak import jsonl) i plik z wagą.
    expect(attachments.filter((attachment) => attachment.kind === 'image' && attachment.bytes === 0)).toHaveLength(2);
    expect(attachments.find((attachment) => attachment.kind === 'file')).toMatchObject({
      name: 'notatki-obecnosc.pdf', bytes: 182_431,
    });
    const images = seed.messages.flatMap((message) => message.blocks)
      .flatMap((block) => (block.type === 'image' ? [block] : []));
    expect(images).toHaveLength(1);
    expect(images[0]?.dataUrl).toMatch(IMAGE_DATA_URL_PATTERN);
    // Jedno zdjęcie świadomie bez bajtów w RAM (sprzątanie po 48 h → 404).
    const stored = new Set(demoSeedUploads(demoContentPl).map((upload) => upload.file));
    expect(files.filter((file) => !stored.has(file))).toHaveLength(1);
  });
});

describe('mock nadzorcy demo: zdjęcia z RAM pod GET …/uploads/:file', () => {
  it('zdjęcia seedów wracają jako PNG, obca nazwa i obcy katalog dają null', async () => {
    const mock = createMockHerdr(demoContentPl);
    try {
      for (const upload of demoSeedUploads(demoContentPl)) {
        const image = await mock.readUpload(upload.cwd, upload.file);
        expect(image?.mime).toBe('image/png');
        expect(image?.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }
      const [first] = demoSeedUploads(demoContentPl);
      expect(await mock.readUpload('/Users/demo/Projects/willow', first?.file ?? '')).toBeNull();
      expect(await mock.readUpload(BRIDGE, '../sekret.png')).toBeNull();
      expect(await mock.readUpload(BRIDGE, '1790000000000-0000000000000000.png')).toBeNull();
    } finally {
      mock.dispose();
    }
  });

  it('zdjęcie wysłane w pokazie da się odczytać pod nazwą z echa; sufit wypycha najstarsze', async () => {
    const mock = createMockHerdr(demoContentPl);
    try {
      const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`;
      const [path] = await mock.deps.writeUploads('/Users/demo/Projects/rarog', [jpeg]);
      const name = basename(path ?? '');
      expect(await mock.readUpload('/Users/demo/Projects/rarog', name)).toEqual({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), mime: 'image/jpeg',
      });
      const many = Array.from({ length: DEMO_MAX_UPLOADS }, () => jpeg);
      await mock.deps.writeUploads('/Users/demo/Projects/map-view', many);
      const [seedUpload] = demoSeedUploads(demoContentPl);
      expect(await mock.readUpload(seedUpload?.cwd ?? '', seedUpload?.file ?? '')).toBeNull();
    } finally {
      mock.dispose();
    }
  });
});

describe('manager demo: seed z notkami i zdjęciami w transkrypcie', () => {
  let dataDir: string;
  let manager: Manager;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-demo-2h-'));
    manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
    await manager.ready;
  });

  afterEach(async () => {
    await manager.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('wiadomości niosą notice i wizytówki załączników, rola zostaje surowa', () => {
    const messages = manager.transcript('demo-pipe-link').messages;
    const notices = messages.filter((message) => message.notice !== undefined);
    expect(notices).toHaveLength(3);
    expect(notices.every((message) => message.role === 'user')).toBe(true);
    const withPhotos = messages.filter((message) => (message.attachments ?? []).length > 0);
    expect(withPhotos.map((message) => message.attachments?.length)).toEqual([2, 2]);
    expect(manager.list().find((session) => session.id === 'demo-pipe-link')?.label).toBe('mostek zdarzeń');
  });
});
