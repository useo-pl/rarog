/**
 * Zones of source and data files (`scripts/lib/source-zones.mjs`): comments, test titles, code, Markdown prose and
 * blocks, embedded data. Each case names the mistake it catches: a comment marker inside a string or a regex taken
 * for a comment hides code, and code taken for a comment lets a guard count words it must not see.
 */
import { describe, expect, it } from 'vitest';
import { formatOf, linePieces, sourceZones, swiftRanges } from '../../scripts/lib/source-zones.mjs';
import { scan } from './source-scan.ts';

type Zone = 'comment' | 'title' | 'code' | 'prose' | 'block' | 'data';

/** Text of every piece in `zone`, in order. */
function zoneTexts(file: string, text: string, zone: Zone): string[] {
  const { ranges } = sourceZones(file, text);
  return ranges.filter((range) => range.zone === zone).map((range) => text.slice(range.start, range.end));
}

describe('format by file name', () => {
  it.each([
    ['server/src/a.ts', 'ts'], ['scripts/lib/a.mjs', 'ts'], ['scripts/lib/a.d.mts', 'ts'], ['a.js', 'ts'],
    ['tsconfig.json', 'ts'], ['relay/tsconfig.json', 'ts'], ['tsconfig.base.json', 'ts'],
    ['native/A.swift', 'swift'], ['docs/a.md', 'markdown'], ['README.MD', 'markdown'],
    ['native/Localizable.xcstrings', 'xcstrings'], ['scripts/a.sh', 'script'], ['.github/workflows/check.yml', 'script'],
    ['pnpm-workspace.yaml', 'script'], ['relay/wrangler.toml', 'script'], ['a.py', 'script'], ['.gitignore', 'script'],
    ['native/Rarog.xcodeproj/project.pbxproj', 'script'], ['server/test/fixtures/a.json', 'data'],
    ['server/test/fixtures/a.txt', 'data'], ['LICENSE', 'data'], ['pnpm-lock.yaml', 'data'], ['relay/pnpm-lock.yaml', 'data'],
  ])('%s → %s', (file, format) => {
    expect(formatOf(file)).toBe(format);
  });
});

describe('ranges cover the text', () => {
  it('sorted, non-overlapping, without gaps, for every format', () => {
    const samples: Record<string, string> = {
      'a.ts': "const a = 'x'; // c\nit('t', () => {}); /* b */\n",
      'a.swift': 'let a = "x" // c\n@Test("t") func t() {} /* b */\n',
      'a.md': '# T\n\n```sh\nx\n```\n<!-- c -->\n',
      'a.sh': 'echo x # c\ncat <<EOF\nd\nEOF\n',
      'a.json': '{"a": 1}\n',
    };
    for (const [file, text] of Object.entries(samples)) {
      const { ranges } = sourceZones(file, text);
      let pos = 0;
      for (const range of ranges) {
        expect(range.start, `${file}: gap or overlap at ${String(pos)}`).toBe(pos);
        expect(range.end).toBeGreaterThan(range.start);
        pos = range.end;
      }
      expect(pos, file).toBe(text.length);
    }
  });

  it('pieces per line keep the zone and the line number of multi-line ranges', () => {
    const text = 'a /* one\ntwo */ b\nc';
    const pieces = linePieces(text, sourceZones('a.ts', text).ranges);
    expect(pieces).toEqual([
      { line: 1, zone: 'code', text: 'a ' }, { line: 1, zone: 'comment', text: '/* one' },
      { line: 2, zone: 'comment', text: 'two */' }, { line: 2, zone: 'code', text: ' b' },
      { line: 3, zone: 'code', text: 'c' },
    ]);
  });
});

describe('TypeScript: comments come from the scanner, titles from test calls', () => {
  it('scan() reports comment ranges with their delimiters', () => {
    const source = "const url = 'https://x'; // line\nconst re = /[/*]/; /* block */\n";
    const { comments } = scan(source);
    expect(comments.map((c) => source.slice(c.start, c.end))).toEqual(['// line', '/* block */']);
  });

  it('a label in a comment is comment, the same label in a string literal is code', () => {
    const text = 'const s = "LABEL-7"; // LABEL-7 x\n';
    expect(zoneTexts('a.ts', text, 'comment')).toEqual(['// LABEL-7 x']);
    expect(zoneTexts('a.ts', text, 'code').join('')).toContain('"LABEL-7"');
  });

  it('the first string argument of a test call is a title, with modifiers and tables', () => {
    // The skip samples are split so that the skip inventory of `scripts-check.test.ts` does not count them as skips.
    const text = [
      "it('a (2026-10-14)', () => {});",
      "test." + "skip(\"b\", () => {});",
      "it.each([[1, f(2)], [3, 4]])('row %s', (n) => {});",
      "describe." + "skipIf(x === null)('suite', () => {});",
      'it(`tpl ${name} (${kind})`, () => {});',
      "it.for(['x'])('for %s', () => {});",
    ].join('\n');
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual(['a (2026-10-14)', 'b', 'row %s', 'suite', 'tpl ${name} (${kind})', 'for %s']);
  });

  it('a bracket inside a string of the modifier arguments does not hide the title', () => {
    const text = "it.each([')'])('2026-10-10 LABEL-7', () => {});\n";
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual(['2026-10-10 LABEL-7']);
  });

  it('a template title ends at its own closing backtick, past braces and templates in its interpolation', () => {
    const text = 'it(`outer ${ JSON.stringify({a:1}) + `inner` } 2026-10-10`, () => {});\n';
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual(['outer ${ JSON.stringify({a:1}) + `inner` } 2026-10-10']);
  });

  it('a comment before the call or before the title does not hide the title, even when it ends with a dot', () => {
    const text = [
      '// The sentence ends with a dot.',
      "it('after a line comment', () => {});",
      '/* A block comment. */ test(',
      '  // Why this case exists.',
      "  'after a comment inside the call', () => {});",
    ].join('\n');
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual(['after a line comment', 'after a comment inside the call']);
  });

  it('the first string argument of a title helper (`macOnly`, `checkoutOnly`) in the title position is a title', () => {
    // A trace in a title wrapped by a helper must count like one in a plain title.
    const text = [
      "describe." + "skipIf(!IS_MAC)(macOnly('mac suite', 'launchd'), () => {});",
      "it." + "skipIf(!HAS_CHECKOUT)(checkoutOnly('checkout case'), async () => {});",
      "it('plain', () => { macOnly('not a title', 'x'); });",
    ].join('\n');
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual(['mac suite', 'checkout case', 'plain']);
  });

  it('other calls are not titles: a method named `it`, a second argument, `expect`, a plain function', () => {
    const text = "obj.it('m'); it(name, 'second'); expect('e').toBe('f'); foo('g'); split(it)('h');\n";
    expect(zoneTexts('a.test.ts', text, 'title')).toEqual([]);
  });
});

describe('Swift lexer', () => {
  it('a comment marker inside a raw string is not a comment', () => {
    const text = 'let a = #"// x"#\nlet b = 1 // real\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual(['// real']);
  });

  it('a regex literal with `/*` is not a comment, and the code under it stays code', () => {
    const text = 'let re = /\\/*x/\nreturn !(session.tasks ?? []).isEmpty\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual([]);
    expect(zoneTexts('a.swift', 'word.wholeMatch(of: /[A-Za-z_][A-Za-z0-9_]*=.*/) != nil // c\n', 'comment')).toEqual(['// c']);
  });

  it('an extended regex literal `#/…/#` with `/*` is not a comment', () => {
    const text = 'let re = #/[/*]/#\nreturn !(session.tasks ?? []).isEmpty\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual([]);
  });

  it('an escaped slash inside `#/…/#` does not close it', () => {
    const text = 'let re = #/a\\/#b// LABEL-7/#\nlet x = 1 // after\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual(['// after']);
  });

  it('nested block comments are one range', () => {
    const text = '/* a /* b */ c */ let x = 1\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual(['/* a /* b */ c */']);
    expect(zoneTexts('a.swift', text, 'code')).toEqual([' let x = 1\n']);
  });

  it('interpolation, multi-line strings and raw strings with quotes keep their content as code', () => {
    const text = [
      'let a = "x \\("y // z") w" // one',
      'let b = """',
      '// not a comment',
      '"quoted" and \\(c)',
      '"""',
      'let c = #"a \\#(b) "q" "# // two',
      'let d = "esc \\" // still string" // three',
    ].join('\n');
    expect(zoneTexts('a.swift', text, 'comment')).toEqual(['// one', '// two', '// three']);
  });

  it('a slash after a value is a division, not a regex', () => {
    const text = 'let half = total / 2 // c\nlet r = (a) / (b) /* d */\n';
    expect(zoneTexts('a.swift', text, 'comment')).toEqual(['// c', '/* d */']);
  });

  it('the string of `@Test(…)` and `@Suite(…)` is a title; other strings are not', () => {
    const text = '@Suite("suite LABEL-7")\nstruct S {\n  @Test("a (2026-10-14)", arguments: [1])\n  func t() { #expect(x, "msg") }\n}\n';
    expect(zoneTexts('a.swift', text, 'title')).toEqual(['suite LABEL-7', 'a (2026-10-14)']);
  });

  it('an unterminated block comment or string is a problem, not a silent zone', () => {
    const problems: string[] = [];
    swiftRanges('let a = 1 /* open\nlet b = 2\n', problems);
    expect(problems).toEqual(['unterminated block comment at line 1']);
    expect(sourceZones('a.swift', 'let s = "open\nlet b = 2\n').problems).toEqual(['unterminated string at line 1']);
  });
});

describe('Markdown, string catalogs, scripts', () => {
  it('Markdown: fenced blocks (fences included), HTML comments, prose', () => {
    const text = 'Prose LABEL-7.\n\n```bash\necho 2026-10-10\n```\n<!-- note -->\nMore.\n';
    expect(zoneTexts('a.md', text, 'block')).toEqual(['```bash\necho 2026-10-10\n```']);
    expect(zoneTexts('a.md', text, 'comment')).toEqual(['<!-- note -->']);
    expect(zoneTexts('a.md', text, 'prose').join('')).toBe('Prose LABEL-7.\n\n\n\nMore.\n');
  });

  it('Markdown: a fence inside an HTML comment is comment; a shorter fence inside a longer block does not close it', () => {
    const inComment = '<!-- comment\n```\n-->\nProse\n';
    expect(sourceZones('a.md', inComment).problems).toEqual([]);
    expect(zoneTexts('a.md', inComment, 'comment')).toEqual(['<!-- comment\n```\n-->']);
    expect(zoneTexts('a.md', inComment, 'block')).toEqual([]);
    const nested = '````md\n```\ninner\n```\n````\nAfter\n';
    expect(sourceZones('a.md', nested).problems).toEqual([]);
    expect(zoneTexts('a.md', nested, 'block')).toEqual(['````md\n```\ninner\n```\n````']);
  });

  it('string catalog: the value of each `comment` key; a key count that does not match is a problem', () => {
    const text = JSON.stringify({ strings: { a: { comment: 'Shown on the list (LABEL-7)', localizations: { en: { stringUnit: { value: 'x' } } } } } }, null, 2);
    expect(zoneTexts('a.xcstrings', text, 'comment')).toEqual(['Shown on the list (LABEL-7)']);
    const inline = '{"strings":{"a":{"comment":"x"}}}';
    expect(sourceZones('a.xcstrings', inline).problems).toEqual(['1 comment keys, 0 found on their own lines']);
  });

  it('shell: `#` comments outside quotes, heredoc bodies are data', () => {
    const text = [
      'echo "a # b" # one', "echo 'c # d'", 'n=${#arr[@]}', 'cat <<EOF', '# (LABEL-7) in the heredoc', 'EOF',
      "cat <<-'END'", '\t# also data', '\tEND', 'x=1 # two',
    ].join('\n');
    expect(zoneTexts('a.sh', text, 'comment')).toEqual(['# one', '# two']);
    expect(zoneTexts('a.sh', text, 'data')).toEqual(['# (LABEL-7) in the heredoc\nEOF', '\t# also data\n\tEND']);
  });

  it('shell: `<<WORD` inside quotes is not a heredoc, and a here-string `<<<` is not one either', () => {
    const text = "echo '<<END'\n# LABEL-7 2026-10-10\n: <<END\nEND\ncat <<<word\n# after\n";
    expect(zoneTexts('a.sh', text, 'comment')).toEqual(['# LABEL-7 2026-10-10', '# after']);
    expect(zoneTexts('a.sh', text, 'data')).toEqual(['END']);
  });

  it('YAML: block scalars are data, comments outside them are comments', () => {
    const text = [
      'jobs:', '  check:', '    steps:', '      - run: |', '          # data line', '          echo x', '',
      '      - name: test # comment', '        run: echo y',
    ].join('\n');
    expect(zoneTexts('a.yml', text, 'data')).toEqual(['          # data line\n          echo x\n']);
    expect(zoneTexts('a.yml', text, 'comment')).toEqual(['# comment']);
  });

  it('YAML: a block under `- key: |` ends at a sibling key of the same list item', () => {
    const text = 'steps:\n  - run: |\n      echo ok\n    env:\n      LABEL: LABEL-7\n      WHEN: 2026-10-10\n  - run: echo done\n';
    expect(zoneTexts('a.yml', text, 'data')).toEqual(['      echo ok']);
  });

  it('Xcode project: `/* … */` comments; `#` is not a comment there', () => {
    const text = '// !$*UTF8*$!\n{ A1 /* Foo.swift */ = {isa = PBXBuildFile; name = "#x";}; }\n';
    expect(zoneTexts('a.pbxproj', text, 'comment')).toEqual(['// !$*UTF8*$!', '/* Foo.swift */']);
  });

  it('data files have only code', () => {
    expect(sourceZones('a.json', '{"comment": "x // y"}\n').ranges).toEqual([{ start: 0, end: 22, zone: 'code' }]);
  });

  it('tsconfig: `//` comments are comments, a `//` inside a JSON string is code', () => {
    const text = '{\n  // Separate project: not part of the root build.\n  "extends": "../a//b.json"\n}\n';
    expect(zoneTexts('relay/tsconfig.json', text, 'comment')).toEqual(['// Separate project: not part of the root build.']);
  });
});
