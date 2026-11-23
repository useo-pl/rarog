import Foundation

// Skrót komendy powłoki do samych narzędzi: wiersz „w tle" mówi `batch-run.sh review`,
// `swift test` albo `grep | head` zamiast dwustu znaków ze ścieżkami, flagami i cytowanym promptem. Pełna komenda
// zostaje pod „Kopiuj komendę". To skrót do CZYTANIA, nie parser powłoki: gdy niczego nie rozpozna, oddaje `nil`,
// a wiersz mówi wtedy sam rodzaj („komenda") albo — gdy nie ma czym innym nazwać zadania — początek komendy
// (`clipped`). Czego nie wolno mu zrobić, to pokazać jako narzędzia czegoś, co komendą nie jest (treść heredoca,
// napis w cudzysłowie, urwane słowo). Czyste funkcje, testy na macOS.
// Właściciel: nagłówek.

public enum CommandTools {
  /// Ile narzędzi mówi skrót; reszta to „+N".
  public static let limit = 3
  /// Serwer tnie komendę do tylu jednostek UTF-16 (`TASK_COMMAND_MAX`, `slice` w JS).
  static let serverCut = 1000
  /// Limit starszego serwera. Apka i serwer wchodzą na produkcję osobno, więc komenda o dokładnie tej
  /// długości też mogła zostać ucięta.
  static let legacyCut = 200
  /// Ile znaków komendy pokazuje wiersz, gdy skrót niczego nie rozpozna.
  public static let clipLength = 60

  /// Początek komendy w jednej linii dla wiersza, którego nie ma czym innym nazwać (zadanie bez opisu, własna
  /// komenda subagenta), gdy skrót niczego nie rozpozna: do 60 znaków i „…". Cała komenda (do 1000 znaków
  /// z serwera) zalewałaby wiersz przypisaniami zmiennych.
  public static func clipped(_ line: String) -> String {
    line.count > clipLength ? line.prefix(clipLength).trimmingCharacters(in: .whitespaces) + "…" : line
  }

  /// `bash /…/batch-run.sh review --uncommitted --dir … -- "…"` → `batch-run.sh review`;
  /// `grep -rn x src | head -40` → `grep | head`; `cd server && pnpm install && pnpm test` →
  /// `pnpm install, pnpm test`. Potok łączy „ | ", kolejne komendy przecinek.
  public static func summary(_ command: String) -> String? {
    guard var segments = segments(command) else { return nil }
    // Ostatnie słowo uciętej komendy bywa urwane: nie jest ani narzędziem, ani podkomendą.
    let units = command.utf16.count
    if units >= serverCut || units == legacyCut, var last = segments.popLast() {
      last.words.removeLast()
      if !last.words.isEmpty { segments.append(last) }
    }
    var tools: [(text: String, piped: Bool)] = []
    var fallback: String?
    for segment in segments {
      switch tool(segment.words) {
      case let .tool(text):
        if tools.last?.text != text { tools.append((text, segment.piped)) }
      case let .quiet(name):
        if fallback == nil { fallback = name }
      case .none:
        break
      }
    }
    guard !tools.isEmpty else { return fallback }
    var out = ""
    for (index, tool) in tools.prefix(limit).enumerated() {
      if index > 0 { out += tool.piped ? " | " : ", " }
      out += tool.text
    }
    return tools.count > limit ? "\(out) +\(tools.count - limit)" : out
  }

  // MARK: Podział na komendy

  struct Segment: Equatable {
    var words: [String]
    /// Komenda stoi za `|` — dalszy człon potoku.
    var piped: Bool
  }

  /// Komendy między `|`, `&&`, `||`, `;`, `&` i końcem linii. Cudzysłowy, `\` i `$(…)` (także w podwójnym
  /// cudzysłowie) trzymają słowo w całości, `\` przed końcem linii skleja linie, komentarz `# …` i treść heredoca
  /// (`<<EOF` … `EOF`) wypadają — to nie komendy. `nil` = składnia, której skrót nie rozbiera (definicja funkcji,
  /// `((…))`): lepiej pokazać całą komendę niż nazwę czegoś, co się nie wykonuje.
  static func segments(_ command: String) -> [Segment]? {
    var out: [Segment] = []
    var words: [String] = []
    var word = ""
    var piped = false
    /// Cudzysłów otwarty na poziomie komendy.
    var quote: Character?
    /// Zagnieżdżenie `$(…)` i cudzysłów otwarty w jego środku (nawias w cudzysłowie niczego nie zamyka).
    var depth = 0
    var inner: Character?
    var escaped = false
    /// Ograniczniki heredoców tej linii; ich treść zaczyna się po końcu linii. `<<-` zdejmuje z linii treści
    /// początkowe tabulatory, zwykłe `<<` porównuje linię dosłownie.
    var heredocs: [(delimiter: String, stripTabs: Bool)] = []

    func endWord() {
      if !word.isEmpty { words.append(word) }
      word = ""
    }
    func endSegment(nextPiped: Bool) {
      endWord()
      if !words.isEmpty { out.append(Segment(words: words, piped: piped)) }
      words = []
      piped = nextPiped
    }

    let characters = Array(command)
    var index = 0
    while index < characters.count {
      let character = characters[index]
      let next = index + 1 < characters.count ? characters[index + 1] : nil
      index += 1
      if escaped {
        // `\` przed końcem linii to kontynuacja: znika razem z nim.
        if !character.isNewline { word.append(character) }
        escaped = false
        continue
      }
      if character == "\\", quote != "'", inner != "'" {
        escaped = true
        continue
      }
      if depth > 0 {
        if let open = inner {
          if character == open { inner = nil }
        } else if character == "\"" || character == "'" {
          inner = character
        } else if character == "(" {
          depth += 1
        } else if character == ")" {
          depth -= 1
        }
        word.append(character)
        continue
      }
      if let open = quote {
        if character == open {
          quote = nil
        } else if open == "\"", character == "$", next == "(" {
          // Podstawienie w podwójnym cudzysłowie ma własne cudzysłowy: nie zamykają zewnętrznego.
          depth = 1
          word.append("$(")
          index += 1
        } else {
          word.append(character)
        }
        continue
      }
      if character.isNewline {
        endSegment(nextPiped: false)
        for heredoc in heredocs {
          // Linie do tej, która jest samym ogranicznikiem (albo do końca, gdy serwer uciął komendę wcześniej).
          while index < characters.count {
            var line = ""
            while index < characters.count, !characters[index].isNewline {
              line.append(characters[index])
              index += 1
            }
            if index < characters.count { index += 1 }
            if heredoc.stripTabs { line = String(line.drop { $0 == "\t" }) }
            if line == heredoc.delimiter { break }
          }
        }
        heredocs = []
        continue
      }
      switch character {
      case "$" where next == "(":
        depth = 1
        word.append("$(")
        index += 1
      case "\"", "'":
        quote = character
        // Słowo zaczęte cudzysłowem niesie znacznik: nazwą programu bywa wtedy tylko ścieżka (`program`).
        if word.isEmpty { word.append("\u{1}") }
      case "`":
        quote = character
        // Podstawienie w odwrotnych apostrofach: słowo z nim nigdy nie jest nazwą — uruchamia się to, co
        // podstawienie wypisze, a nie to, co w nim stoi (osobny znacznik).
        word.append("\u{2}")
      case "#" where word.isEmpty:
        // Komentarz do końca linii; koniec linii zostaje, bo po nim zaczyna się treść heredoca.
        while index < characters.count, !characters[index].isNewline { index += 1 }
      case "(" where word.hasSuffix("="):
        // Tablica `PLIKI=("/tmp/a.py" b)`: elementy to dane przypisania, nie komendy — do nawiasu zamykającego.
        var nested = 1
        var open: Character?
        while index < characters.count, nested > 0 {
          let mark = characters[index]
          index += 1
          if let quoted = open {
            if mark == quoted { open = nil }
          } else if mark == "\"" || mark == "'" {
            open = mark
          } else if mark == "(" {
            nested += 1
          } else if mark == ")" {
            nested -= 1
          }
        }
      case "(" where next == ")" || next == "(":
        // `nazwa() { … }` definiuje funkcję, `((…))` liczy: nic z tego nie jest uruchomionym narzędziem.
        return nil
      case " ", "\t", "(", ")":
        // Nawiasy podpowłoki `(cd x && make)` tylko grupują.
        endWord()
      case ";":
        endSegment(nextPiped: false)
      case "|":
        if next == "|" { index += 1 }
        endSegment(nextPiped: next != "|")
        if next == "&" { index += 1 }
      case "&":
        // `2>&1` i `&>plik` to przekierowania, nie koniec komendy.
        if next == ">" || word.hasSuffix(">") {
          word.append(character)
        } else {
          if next == "&" { index += 1 }
          endSegment(nextPiped: false)
        }
      case "<" where next == "<":
        if index + 1 < characters.count, characters[index + 1] == "<" {
          // `<<<` to napis na wejście w tej samej linii, nie heredoc.
          word.append("<<<")
          index += 2
        } else {
          index += 1
          var stripTabs = false
          if index < characters.count, characters[index] == "-" {
            stripTabs = true
            index += 1
          }
          while index < characters.count, characters[index] == " " || characters[index] == "\t" { index += 1 }
          var closing: Character?
          if index < characters.count, characters[index] == "\"" || characters[index] == "'" {
            closing = characters[index]
            index += 1
          }
          var delimiter = ""
          while index < characters.count {
            let mark = characters[index]
            if let closing {
              index += 1
              if mark == closing { break }
            } else if mark.isWhitespace || ";|&<>()".contains(mark) {
              break
            } else {
              index += 1
            }
            delimiter.append(mark)
          }
          // Pusty ogranicznik w cudzysłowie (`<<''`) jest poprawny: treść kończy pusta linia.
          if !delimiter.isEmpty || closing != nil { heredocs.append((delimiter, stripTabs)) }
          endWord()
        }
      default:
        word.append(character)
      }
    }
    endSegment(nextPiped: false)
    return out
  }

  // MARK: Jedna komenda

  enum Tool: Equatable {
    case tool(String)
    /// Wbudowane drobiazgi powłoki (`cd`, `echo`, `sleep`): w skrócie stoją tylko wtedy, gdy nie ma nic innego.
    case quiet(String)
    case none
  }

  private static let loopHeads: Set<String> = ["for", "case", "select", "function"]
  private static let keywords: Set<String> = [
    "if", "then", "else", "elif", "fi", "while", "until", "do", "done", "esac", "{", "}", "!",
  ]
  /// Warunek `[ a = b ]`, `[[ … ]]`, `test …`: jego operandy to napisy, nie komendy.
  private static let tests: Set<String> = ["[", "[[", "test"]

  /// Owijka: mówi się narzędzie, które uruchamia. `taking` to jej opcje, które zabierają następne słowo
  /// (`xcrun --sdk iphonesimulator swift test`, `sudo --user root pnpm test`) — bez tego wartość opcji udawałaby
  /// program; `plain` to opcje bez wartości. Opcja spoza obu list: nie wiadomo, gdzie zaczyna się komenda, więc
  /// skrót mówi samą owijkę.
  private struct Wrapper {
    var taking: Set<String> = []
    var plain: Set<String> = []
  }

  private static let wrappers: [String: Wrapper] = [
    "sudo": Wrapper(
      taking: [
        "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir",
        "-R", "--chroot", "-T", "--command-timeout", "-U", "--other-user", "-r", "--role", "-t", "--type",
      ],
      plain: [
        "-n", "--non-interactive", "-E", "--preserve-env", "-H", "--set-home", "-i", "--login", "-s", "--shell",
        "-S", "--stdin", "-k", "--reset-timestamp", "-b", "--background", "-A", "--askpass", "-P", "--",
      ]),
    "env": Wrapper(
      taking: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"],
      plain: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug", "-", "--"]),
    "xcrun": Wrapper(
      taking: ["--sdk", "-sdk", "--toolchain", "-toolchain"],
      plain: ["--run", "-r", "--verbose", "-v", "--log", "-l", "--no-cache", "-n"]),
    "nice": Wrapper(taking: ["-n", "--adjustment"]),
    "timeout": Wrapper(
      taking: ["-s", "--signal", "-k", "--kill-after"], plain: ["--preserve-status", "--foreground", "-v", "--verbose"]),
    "caffeinate": Wrapper(taking: ["-t", "-w"], plain: ["-d", "-i", "-m", "-s", "-u"]),
    "npx": Wrapper(
      taking: ["-p", "--package", "-c", "--call"], plain: ["-y", "--yes", "--no", "--no-install", "-q", "--quiet", "--"]),
    "bunx": Wrapper(taking: ["-p", "--package"], plain: ["--bun"]),
    "uvx": Wrapper(
      taking: ["--from", "--with", "-p", "--python"], plain: ["-q", "--quiet", "--isolated", "--no-cache"]),
    "exec": Wrapper(taking: ["-a"], plain: ["-c", "-l"]),
    "nohup": Wrapper(),
    "command": Wrapper(),
    "time": Wrapper(plain: ["-p"]),
  ]
  private static let shells: Set<String> = ["bash", "sh", "zsh", "node", "python", "python3", "ruby", "tsx"]
  private static let quiet: Set<String> = [
    "cd", "pushd", "popd", "export", "set", "unset", "echo", "printf", "true", "false", ":", "sleep", "wait", "exit",
    "return", "local", "source", ".", "read", "shift", "trap",
  ]
  /// Narzędzia, których pierwsze słowo po nazwie mówi, co robią (`git diff`, `pnpm test`, `swift build`).
  private static let multi: Set<String> = [
    "git", "pnpm", "npm", "yarn", "bun", "cargo", "go", "swift", "docker", "kubectl", "gh", "brew", "uv", "pip",
    "herdr", "claude", "codex", "launchctl", "tailscale", "wrangler", "simctl", "xcodebuild", "make",
  ]
  /// Podkomendy, po których stoi właściwe zadanie (`pnpm run check`, `uv run pytest`, `docker compose up`).
  private static let nested: Set<String> = ["run", "exec", "dlx", "x", "compose"]
  /// Flagi narzędzi z `multi`, które zabierają następne słowo (`git -C katalog diff`, `pnpm --filter web test`).
  private static let valueFlags: Set<String> = ["-C", "-c", "--filter", "-F", "--prefix", "--dir", "-w", "--workspace"]
  private static let scriptSuffixes = [".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb"]

  static func tool(_ segment: [String]) -> Tool {
    var words = segment[...]
    var wrapper: String?
    while let first = words.first {
      if loopHeads.contains(first) || tests.contains(first) { return .none }
      if keywords.contains(first) || isAssignment(first) {
        words.removeFirst()
      } else if let options = wrappers[first] {
        wrapper = first
        words.removeFirst()
        // Opcje owijki z wartościami, zmienne `env` i czas `timeout` należą do niej, nie do narzędzia.
        while let word = words.first {
          if word.hasPrefix("-") {
            words.removeFirst()
            if options.taking.contains(word) {
              if !words.isEmpty { words.removeFirst() }
            } else if !options.plain.contains(word), !word.contains("=") {
              return .tool(first)
            }
          } else if isAssignment(word) || (first == "timeout" && word.wholeMatch(of: /[0-9.]+[smhd]?/) != nil) {
            words.removeFirst()
          } else {
            break
          }
        }
      } else {
        break
      }
    }
    // Sama owijka (`sudo -i`, `npx -c "…"`) mówi siebie.
    guard let first = words.first.flatMap(program) else { return wrapper.map { .tool($0) } ?? .none }
    var name = base(first)
    var rest = words.dropFirst()
    if shells.contains(name) {
      // `bash skrypt.sh …` mówi skrypt; `bash -c "…"` i `node -e "…"` — sam interpreter.
      if let script = rest.first.flatMap(script) {
        name = base(script)
        rest = rest.dropFirst()
      } else {
        return .tool(name)
      }
    }
    if quiet.contains(name) { return .quiet(name) }
    if scriptSuffixes.contains(where: name.hasSuffix) {
      // Skrypt: podkomendą jest tylko PIERWSZY argument i tylko gołe słowo (`batch-run.sh review`).
      if let sub = rest.first, isBare(sub) { return .tool("\(name) \(sub)") }
      return .tool(name)
    }
    guard multi.contains(name) else { return .tool(name) }
    var parts = [name]
    var takeNested = true
    while let word = rest.first {
      rest = rest.dropFirst()
      if word.hasPrefix("-") {
        if valueFlags.contains(word) { rest = rest.dropFirst() }
        continue
      }
      guard isBare(word) else { break }
      parts.append(word)
      guard takeNested, nested.contains(word) else { break }
      takeNested = false
    }
    return .tool(parts.joined(separator: " "))
  }

  private static func isAssignment(_ word: String) -> Bool {
    word.wholeMatch(of: /[A-Za-z_][A-Za-z0-9_]*=.*/) != nil
  }

  /// Słowo, które może być nazwą programu, w postaci do rozbioru; `nil` = argument, nie program. Przechodzi
  /// słowo z liter, cyfr i znaków ścieżki, zaczęte od litery albo ścieżki, także ścieżka od zmiennej
  /// (`$W/scripts/check.sh`, `${ROOT}/bin/run`) i ścieżka w cudzysłowie (`"$W/scripts/check.sh"`) — tak piszą
  /// komendy agenci. Odpada napis w cudzysłowie bez ukośnika, sama zmienna (`$CMD`: nie wiadomo, co uruchamia),
  /// przekierowanie, podstawienie `$(…)` i w odwrotnych apostrofach, flaga i wszystko ze znakiem niewidocznym.
  private static func program(_ word: String) -> String? {
    var text = Substring(word)
    let quoted = text.first == "\u{1}"
    if quoted { text = text.dropFirst() }
    let shape = /(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)?[A-Za-z_.\/~][A-Za-z0-9_.\/~+@:-]*/
    guard text.wholeMatch(of: shape) != nil else { return nil }
    // W cudzysłowie programem bywa ścieżka; gołe słowo w cudzysłowie to napis.
    if quoted, !text.contains("/") { return nil }
    return String(text)
  }

  /// Argument interpretera, który jest skryptem: ścieżka albo plik z rozszerzeniem skryptu.
  private static func script(_ word: String) -> String? {
    guard let text = program(word), text.contains("/") || scriptSuffixes.contains(where: text.hasSuffix) else {
      return nil
    }
    return text
  }

  /// Gołe słowo podkomendy: małe litery, cyfry, `:`, `-`, `_` (`review`, `e2e:presence`), do 24 znaków.
  private static func isBare(_ word: String) -> Bool {
    word.count <= 24 && word.wholeMatch(of: /[a-z][a-z0-9:_-]*/) != nil
  }

  /// Nazwa bez katalogu: `/usr/bin/git` → `git`, `./scripts/check.sh` → `check.sh`.
  private static func base(_ word: String) -> String {
    word.split(separator: "/").last.map(String.init) ?? word
  }
}
