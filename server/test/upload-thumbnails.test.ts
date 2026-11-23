/**
 * Miniatury zdjęć z `.rarog-uploads/` PO przeładowaniu apki, na drugim urządzeniu i po restarcie
 * serwera.
 *
 * Trzy ogniwa, każde z własną granicą:
 * - `uploads.read` — JEDYNA droga odczytu tego katalogu: nazwa po wzorcu Raroga, `lstat` na
 *   katalogu i pliku (dowiązanie = brak), `null` zamiast wyjątku;
 * - import z jsonl — wpis-towarzysz `[Image: source: …]` (`isMeta`) daje POPRZEDNIEJ wiadomości
 *   człowieka wizytówkę z `file` i zdejmuje z niej zastępnik `[obraz]`;
 * - echo Raroga — `withUploadFiles` dokleja do wizytówek zdjęć samą NAZWĘ pliku (nigdy ścieżkę).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPLOAD_IMAGE_FILE_PATTERN, messageAttachmentSchema, messageAttachments } from '@rarog/shared';
import { UPLOAD_DIR_NAME, UPLOAD_NAME_PATTERN, createUploads, uploadImageMime } from '../src/herdr/uploads.ts';
import { IMAGE_PLACEHOLDER, parseTranscriptTail } from '../src/transcript-import.ts';
import { wireMessages } from './helpers/bloki-drutu.ts';
import { withUploadFiles } from '../src/sessions/manager.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const NAME_PNG = '1788361542375-67f5f846e6fe49e7.png';
const NAME_JPG = '1788361542375-67f5f846e6fe49e7.jpg';

describe('uploads.read — jedyna droga odczytu .rarog-uploads', () => {
  let base: string;
  let cwd: string;
  const uploads = createUploads({ now: () => Date.UTC(2026, 8, 10, 12, 0, 0) });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-miniatury-'));
    cwd = join(base, 'projekt');
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('oddaje bajty i MIME zdjęcia zapisanego przez write', async () => {
    const [path] = await uploads.write(cwd, [PNG]);
    const name = path?.split('/').pop() ?? '';
    expect(UPLOAD_NAME_PATTERN.test(name)).toBe(true);

    const image = await uploads.read(cwd, name);
    expect(image).not.toBeNull();
    expect(image?.mime).toBe('image/png');
    expect(image?.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('nazwa spoza wzorca Raroga to null — bez dotykania dysku (ścieżka, plik użytkownika, PDF)', async () => {
    await mkdir(join(cwd, UPLOAD_DIR_NAME), { recursive: true });
    await writeFile(join(cwd, UPLOAD_DIR_NAME, 'raport.pdf'), 'x');
    for (const name of ['../package.json', '..', 'raport.pdf', '1-abc.png', `${NAME_PNG}/x`, '']) {
      expect(await uploads.read(cwd, name)).toBeNull();
    }
    // Wzorzec z protokołu i modułu uploadów są JEDNYM wzorcem — inaczej schemat przepuściłby
    // nazwę, której serwer nie odda, albo odwrotnie.
    expect(UPLOAD_NAME_PATTERN).toBe(UPLOAD_IMAGE_FILE_PATTERN);
  });

  it('brak pliku (po sweepie 48 h) i brak katalogu to null, nie wyjątek', async () => {
    expect(await uploads.read(cwd, NAME_PNG)).toBeNull();
    await mkdir(join(cwd, UPLOAD_DIR_NAME), { recursive: true });
    expect(await uploads.read(cwd, NAME_JPG)).toBeNull();
  });

  it('dowiązanie w miejscu katalogu ALBO pliku to null — Rarog nie idzie za dowiązaniem', async () => {
    const victimDir = join(base, 'cudzy');
    await mkdir(victimDir, { recursive: true });
    await writeFile(join(victimDir, NAME_PNG), 'sekret');
    await symlink(victimDir, join(cwd, UPLOAD_DIR_NAME));
    expect(await uploads.read(cwd, NAME_PNG)).toBeNull();

    await rm(join(cwd, UPLOAD_DIR_NAME));
    await mkdir(join(cwd, UPLOAD_DIR_NAME), { recursive: true });
    await symlink(join(victimDir, NAME_PNG), join(cwd, UPLOAD_DIR_NAME, NAME_PNG));
    expect(await uploads.read(cwd, NAME_PNG)).toBeNull();
  });

  it('MIME idzie z rozszerzenia, a Rarog zapisuje wyłącznie png i jpg', () => {
    expect(uploadImageMime(NAME_PNG)).toBe('image/png');
    expect(uploadImageMime(NAME_JPG)).toBe('image/jpeg');
    expect(uploadImageMime('zdjecie.gif')).toBeNull();
  });
});

describe('import z jsonl — wpis-towarzysz [Image: source: …] daje wiadomości człowieka miniaturę', () => {
  const CWD = '/Users/demo/Projects/willow';
  const line = (value: unknown): string => JSON.stringify(value);
  const user = (content: unknown, extra: Record<string, unknown> = {}): string => line({
    type: 'user', message: { role: 'user', content }, isSidechain: false,
    timestamp: '2026-09-10T10:00:00.000Z', ...extra,
  });
  const companion = (...paths: string[]): string => user(
    paths.map((path) => ({ type: 'text', text: `[Image: source: ${path}]` })),
    { isMeta: true, turnCompanion: true },
  );
  const humanWithImage = (text: string): string => user([
    { type: 'text', text: `[Image #1]${text}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]);
  // Widok drutu: bloki po serializacji sesji.
  const parse = (lines: string[]) => (
    wireMessages(parseTranscriptTail(lines.join('\n'), { dropFirstLine: false }))
  );

  it('zdjęcie z Raroga: wizytówka z `file` (sama nazwa) i bez zastępnika [obraz]', () => {
    const result = parse([
      humanWithImage('tak ma byc?'),
      companion(`${CWD}/${UPLOAD_DIR_NAME}/${NAME_JPG}`),
    ]);
    expect(result.messages).toHaveLength(1);
    const [message] = result.messages;
    expect(message?.blocks).toEqual([{ type: 'text', text: 'tak ma byc?' }]);
    expect(message?.attachments).toEqual([
      { kind: 'image', name: '', bytes: 0, mime: 'image/jpeg', file: NAME_JPG },
    ]);
    // Wizytówka przechodzi schemat protokołu — to ona jedzie na telefon.
    expect(messageAttachmentSchema.safeParse(message?.attachments?.[0]).success).toBe(true);
    expect(JSON.stringify(message)).not.toContain(CWD);
  });

  it('zdjęcie spoza .rarog-uploads (wklejone w terminalu) zostaje [obraz] bez wizytówki', () => {
    const result = parse([humanWithImage('a to?'), companion('/Users/demo/Desktop/zrzut.png')]);
    expect(result.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'a to?' }, { type: 'text', text: IMAGE_PLACEHOLDER.text, ref: IMAGE_PLACEHOLDER.ref },
    ]);
    expect(result.messages[0]?.attachments).toBeUndefined();
  });

  it('kilka zdjęć: kolejność towarzyszy = kolejność wizytówek; zastępniki ponad liczbę zostają', () => {
    const result = parse([
      user([
        { type: 'text', text: '[Image #1][Image #2][Image #3]trzy' },
        { type: 'image', source: {} }, { type: 'image', source: {} }, { type: 'image', source: {} },
      ]),
      companion(
        `${CWD}/${UPLOAD_DIR_NAME}/${NAME_PNG}`,
        '/Users/demo/Desktop/obce.png',
        `${CWD}/${UPLOAD_DIR_NAME}/${NAME_JPG}`,
      ),
    ]);
    const [message] = result.messages;
    expect(message?.attachments?.map((a) => a.file)).toEqual([NAME_PNG, NAME_JPG]);
    expect(message?.blocks.filter((b) => b.type === 'text' && b.text === IMAGE_PLACEHOLDER.text))
      .toHaveLength(1);
  });

  it('towarzysz bez wiadomości człowieka przed sobą jest pomijany, jak każdy wpis meta', () => {
    const result = parse([
      companion(`${CWD}/${UPLOAD_DIR_NAME}/${NAME_PNG}`),
      line({
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        isSidechain: false, timestamp: '2026-09-10T10:00:05.000Z',
      }),
      companion(`${CWD}/${UPLOAD_DIR_NAME}/${NAME_PNG}`),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.messages[0]?.attachments).toBeUndefined();
  });

  it('inne wpisy meta nadal nie wchodzą do transkryptu', () => {
    const result = parse([user([{ type: 'text', text: 'podsumowanie CLI' }], { isMeta: true })]);
    expect(result.messages).toEqual([]);
  });
});

describe('echo Raroga — withUploadFiles dokleja nazwę pliku do wizytówki zdjęcia', () => {
  it('zdjęcia dostają `file` po kolejności ścieżek, pliki zostają bez', () => {
    const files = [{ name: 'raport.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }];
    const attachments = withUploadFiles(
      messageAttachments([PNG, PNG], files),
      [`/tmp/projekt/${UPLOAD_DIR_NAME}/${NAME_PNG}`, `/tmp/projekt/${UPLOAD_DIR_NAME}/${NAME_JPG}`],
    );
    expect(attachments.map((a) => a.file)).toEqual([NAME_PNG, NAME_JPG, undefined]);
    expect(attachments[2]?.name).toBe('raport.pdf');
    expect(JSON.stringify(attachments)).not.toContain('/tmp/projekt');
  });

  it('bez ścieżek (zapis się nie odbył) wizytówki zostają nietknięte', () => {
    const before = messageAttachments([PNG]);
    expect(withUploadFiles(before, [])).toEqual(before);
  });
});
