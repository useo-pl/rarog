import Foundation
@testable import RarogUI
import Testing

@Suite("skrót komendy do narzędzi (wiersze „w tle”)")
struct CommandToolsTests {
  private func short(_ command: String) -> String? { CommandTools.summary(command) }

  @Test("nazwa programu bez ścieżki, flag i argumentów; skrypt i narzędzie z podkomendą zostawiają pierwsze słowo")
  func singleCommand() {
    let codex = #"bash /Users/x/fleet-ops/scripts/batch-run.sh review --uncommitted --dir /Users/x/rarog -- "Zmiana dodaje narzędzie; patrz | tu && tam""#
    #expect(short(codex) == "batch-run.sh review", "znaki specjalne w cudzysłowie nie dzielą komendy")
    #expect(short("grep -rn inspector native/Rarog") == "grep", "argument to nie podkomenda")
    #expect(short("/usr/bin/git -C /Users/x/rarog diff --stat") == "git diff")
    #expect(short("git -c core.quotepath=false status --porcelain=v2") == "git status")
    #expect(short("pnpm -C /Users/x/rarog run check") == "pnpm run check")
    #expect(short("pnpm test -- --run src/notes.test.ts") == "pnpm test")
    #expect(short("pnpm --filter web exec tsc --noEmit") == "pnpm exec tsc")
    #expect(short("docker compose up -d") == "docker compose up")
    #expect(short("./scripts/ios-check.sh") == "ios-check.sh")
    #expect(short("bash scripts/measure-dialogs.sh --workspace wQ --only typ") == "measure-dialogs.sh")
    #expect(short("curl -s localhost:8930/health") == "curl")
    #expect(short("make") == "make" && short("make -j8 check") == "make check")
  }

  @Test("zmienne, owijki i interpretery nie są narzędziem; `bash -c` i `node -e` mówią sam interpreter")
  func wrappersAndInterpreters() {
    #expect(short("DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swift test --package-path native/Rarog") == "swift test")
    #expect(short("RAROG_IOS_QUICK=1 RAROG_IOS_UI_TESTS=Klasa bash scripts/ios-check.sh > gate.log 2>&1") == "ios-check.sh")
    #expect(short("env -i HOME=/tmp PATH=/usr/bin node server.mjs --port 8930") == "server.mjs")
    #expect(short("timeout 30 npx vitest run") == "vitest")
    #expect(short(#"bash -c "cd x && make""#) == "bash")
    #expect(short(#"node -e "console.log(1)""#) == "node")
    #expect(short("python3 tools/report.py --since 7d") == "report.py")
  }

  @Test("potok łączy „ | ”, kolejne komendy przecinek; drobiazgi powłoki milczą, chyba że nie ma nic innego")
  func pipelinesAndSequences() {
    #expect(short(#"grep -rn "a|b" native/Rarog | sort -u | head -40"#) == "grep | sort | head")
    #expect(short("cd server && pnpm install && pnpm test -- --run src/notes") == "pnpm install, pnpm test")
    #expect(short("cd native &&\n  bash check.sh") == "check.sh", "nowa linia też dzieli komendy")
    #expect(short("pnpm test || pnpm test; echo done") == "pnpm test", "powtórzone narzędzie raz")
    #expect(short("(cd server && pnpm build) && ./deploy.sh production") == "pnpm build, deploy.sh production")
    #expect(short("until grep -q '^exit=' gate.log; do sleep 5; done; tail -12 gate.log") == "grep, tail")
    #expect(short("for f in a b c; do wc -l \"$f\"; done") == "wc", "nagłówek pętli nie jest narzędziem")
    #expect(short("if [ -f x ]; then cat x; fi") == "cat")
    #expect(short("sleep 600") == "sleep" && short("cd /tmp && echo ok") == "cd", "sam drobiazg mówi siebie")
    #expect(short("git add -A && git commit -m \"x\" && git push && gh pr create && pnpm test") == "git add, git commit, git push +2")
    #expect(short("a | b | c | d") == "a | b | c +1")
  }

  @Test("heredoc to dane; komenda ucięta przez serwer nie zgaduje narzędzia z urwanego słowa; pustka daje nil")
  func heredocTruncationAndEmpty() {
    #expect(short("cat > plik.txt <<'EOF'\nrm -rf / && git push\npnpm test\nEOF\nwc -l plik.txt") == "cat, wc")
    #expect(short("python3 - <<PY\nimport os\nprint(os.getcwd())\nPY") == "python3")
    #expect(short("cat <<< \"tekst\" | tr a b") == "cat | tr", "`<<<` to napis, nie heredoc")
    // Starszy serwer ciął w 200. jednostce: z `pnpm test` zostaje „pnp" — urwane słowo nie jest narzędziem.
    let whole = "grep -rn x " + String(repeating: "a", count: 182) + " && pnpm test"
    let cut = String(whole.prefix(CommandTools.legacyCut))
    #expect(cut.hasSuffix("&& pnp") && short(cut) == "grep")
    #expect(short("grep -rn x aaa && pnpm test") == "grep, pnpm test", "krótsza komenda jest cała")
    #expect(short("") == nil && short("   \n ") == nil && short("\"tylko napis\"") == nil)
    #expect(short("FOO=bar") == nil && short("> plik.txt") == nil)
  }

  /// Pięć wejść, przy których skrót pokazywał coś, co komendą nie jest.
  @Test("kontynuacja linii, opcje owijek z wartością, nawias w cudzysłowie w `$(…)`, urwana podkomenda, dwa heredoki")
  func misleadingInputs() {
    #expect(short("cd server && \\\n  pnpm test") == "pnpm test", "`\\` przed końcem linii skleja linie")
    #expect(short("xcrun --sdk iphonesimulator swift test") == "swift test")
    #expect(short("sudo -u root pnpm test") == "pnpm test")
    #expect(short("npx --package typescript tsc --noEmit") == "tsc")
    #expect(short("sudo -i") == "sudo" && short(#"npx -c "eslint .""#) == "npx", "sama owijka mówi siebie")
    #expect(short("grep $(printf 'a) | rm -rf /') file | head") == "grep | head", "tekst z printf to nie komenda")
    #expect(short(#"echo "$(date +%s | tr -d x)" && make check"#) == "make check")
    // Ucięcie: urwana podkomenda nie wchodzi, a limit liczy się w jednostkach UTF-16, jak `slice` serwera.
    let padded = "grep -rn x " + String(repeating: "a", count: 178) + " && pnpm test"
    let cut = String(decoding: Array(padded.utf16.prefix(CommandTools.legacyCut)), as: UTF16.self)
    #expect(cut.hasSuffix("pnpm te") && short(cut) == "grep, pnpm")
    let emoji = "grep -rn x " + String(repeating: "🙂", count: 91) + " && pnpm test"
    let emojiCut = String(decoding: Array(emoji.utf16.prefix(CommandTools.legacyCut)), as: UTF16.self)
    #expect(emojiCut.count < CommandTools.legacyCut && emojiCut.hasSuffix("&& pnp") && short(emojiCut) == "grep")
    #expect(short("cat <<A <<B\none\nA\nrm -rf /\nB\nwc -l file") == "cat, wc")
    #expect(short("cat <<'KONIEC 1'\nrm x\nKONIEC 1\nls") == "cat, ls", "ogranicznik w cudzysłowie")
    #expect(short("grep \"<<EOF\" plik\nwc -l plik") == "grep, wc", "`<<EOF` w cudzysłowie to napis")
  }

  /// Dane, które po przepisaniu rozbioru dalej udawały narzędzia.
  @Test("podstawienie w cudzysłowie, komentarz, pozorny koniec heredoca, opcje owijek, warunek, definicja funkcji")
  func dataIsNotTools() {
    #expect(short(#"echo "$(printf "%s" "x; git push")""#) == "echo", "cudzysłowy podstawienia nie zamykają zewnętrznego")
    #expect(short(#"git commit -m "$(cat <<'EOF'\#nopis z "cudzysłowem"; rm x\#nEOF\#n)""#) == "git commit")
    #expect(short("pnpm test # explanation; git push") == "pnpm test", "komentarz do końca linii")
    #expect(short("pnpm test # uwaga\ngit status") == "pnpm test, git status", "po komentarzu następna linia")
    #expect(short("curl http://host/a#kotwica | jq .") == "curl | jq", "`#` w środku słowa to nie komentarz")
    #expect(short("cat <<EOF\n EOF\nrm -rf /\nEOF\nwc -l x") == "cat, wc", "linia ze spacją nie zamyka `<<`")
    #expect(short("cat <<-EOF\n\tala\n\tEOF\nwc -l x") == "cat, wc", "`<<-` zdejmuje początkowe tabulatory")
    #expect(short("cat <<''\nrm -rf /\n\nwc -l x") == "cat, wc", "pusty ogranicznik w cudzysłowie kończy pusta linia")
    #expect(short("sudo --user root pnpm test") == "pnpm test")
    #expect(short("sudo --nieznana-opcja root pnpm test") == "sudo", "nieznana opcja: nie wiadomo, gdzie komenda")
    #expect(short("env --ignore-environment FOO=1 node server.mjs") == "server.mjs")
    #expect(short("command -v git") == "command" && short("exec node server.mjs") == "server.mjs")
    #expect(short("if [ ready = ready ]; then pnpm test; fi") == "pnpm test", "operand warunku to napis")
    #expect(short("[[ ready == ready ]] && make check") == "make check")
    #expect(short("test -f plik && cat plik") == "cat")
    #expect(short("helper() { printf ok; rm x; }; pnpm test") == nil, "definicja funkcji: bez zgadywania")
    #expect(short("(( i++ )); pnpm test") == nil)
    #expect(short("echo $((1 << 2)) && make") == "make", "arytmetyka w podstawieniu to nie heredoc")
  }

  @Test("dowolne wejście nie wywraca skrótu: niedomknięty cudzysłów, same operatory, długi tekst spoza ASCII")
  func robustness() {
    #expect(short("grep \"nie domknięty && rm -rf /") == "grep")
    #expect(short("&& || ; | &") == nil && short("$(") == nil && short("<<") == nil && short("\\") == nil)
    #expect(short("cat <<EOF\nbez końca\nrm x") == "cat", "heredoc bez ogranicznika: reszta to dane")
    #expect(short(String(repeating: "zażółć gęślą jaźń 🙂 ", count: 400)) == nil, "tekst, nie komenda")
    #expect(short("naprawdę-dziwne✓narzędzie --flaga") == nil, "nazwa spoza ASCII: wiersz powie sam rodzaj")
  }

  /// Regresja: komenda agenta zaczęta od przypisań zmiennych, ucięta przez serwer przed
  /// właściwym narzędziem, wracała w wierszu w całości.
  @Test("ścieżka od zmiennej i w cudzysłowie jest skryptem; ucięta na samych przypisaniach nie ma narzędzia")
  func variableRootedPaths() {
    let whole = #"W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy-ui-okno; O=/tmp/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/rarog-merge.vBLgSz; LOG="$O/fix-okno-3.log"; RAROG_IOS_QUICK=1 RAROG_IOS_UI_TESTS=AccessibilityUITests bash "$W/scripts/ios-check.sh" > "$LOG" 2>&1; tail -5 "$LOG""#
    #expect(short(whole) == "ios-check.sh, tail")
    let cut = String(whole.prefix(CommandTools.legacyCut))
    #expect(cut.hasSuffix("RAROG_IOS_QUICK=1 RAROG_IOS_UI_TES") && short(cut) == nil, "same przypisania: nic do powiedzenia")
    #expect(short("bash $W/scripts/ios-check.sh") == "ios-check.sh")
    #expect(short("${ROOT}/scripts/batch-run.sh review --uncommitted") == "batch-run.sh review")
    #expect(short(#""$HOME/bin/herdr" agent list"#) == "herdr agent")
    #expect(short(#"python3 "$DIR/tools/report.py" --since 7d"#) == "report.py")
    #expect(short(#"bash "/Users/x/my scripts/run.sh""#) == "bash", "ścieżka ze spacją: sam interpreter")
    // Sama zmienna nie mówi, co uruchamia; napis w cudzysłowie bez ukośnika to argument.
    #expect(short("$CMD --flag") == nil && short(#""$CMD" --flag"#) == nil)
    #expect(short(#"bash "skrypt.sh""#) == "bash" && short(#"echo "/etc/hosts""#) == "echo")
    #expect(short("grep $W/x plik") == "grep", "ścieżka od zmiennej jako argument zostaje argumentem")
    #expect(short("bash $(which run.sh)") == "bash" && short("$(pwd)/run.sh") == nil, "podstawienie to nie nazwa")
  }

  /// Po rozluźnieniu reguły nazwy: dwa wejścia, w których ścieżka jest danymi.
  @Test("elementy tablicy to dane przypisania; podstawienie w odwrotnych apostrofach nie jest nazwą")
  func arraysAndBackticks() {
    #expect(short(#"FILES=("/tmp/report.py"); pnpm test"#) == "pnpm test")
    #expect(short("FILES=(/tmp/report.py tools/x.sh) && pnpm test") == "pnpm test", "także bez cudzysłowów")
    #expect(short(#"A=("a) b" 'c (d' $(ls)) B=() pnpm test"#) == "pnpm test", "nawias w cudzysłowie nie zamyka tablicy")
    #expect(short("local files=(src/a.ts src/b.ts); wc -l \"${files[@]}\"") == "wc")
    #expect(short("FILES=(/tmp/report.py") == nil, "tablica bez końca: reszta to dane")
    #expect(short("bash `./select-script.sh` review") == "bash", "uruchamia się wynik podstawienia, nie ono")
    #expect(short("`./select-tool.sh` --flag") == nil && short("./run-`date +%F`.sh") == nil)
    #expect(short(#"bash "`./select-script.sh`""#) == "bash")
  }

  /// Limit serwera to 1000 jednostek; komenda o długości 200 też może być ucięta,
  /// bo apka i serwer ze starszym limitem wchodzą na produkcję osobno.
  @Test("ucięcie: 1000 jednostek albo dokładnie 200 gubi ostatnie słowo; długość pomiędzy to komenda cała")
  func serverCuts() {
    #expect(CommandTools.serverCut == 1000 && CommandTools.legacyCut == 200)
    let long = "grep -rn x " + String(repeating: "a", count: 982) + " && pnpm test"
    let cut = String(decoding: Array(long.utf16.prefix(CommandTools.serverCut)), as: UTF16.self)
    #expect(cut.hasSuffix("&& pnp") && short(cut) == "grep", "ucięte przez nowy serwer")
    let middle = "grep -rn x " + String(repeating: "a", count: 400) + " && pnpm test"
    #expect(middle.utf16.count > CommandTools.legacyCut && short(middle) == "grep, pnpm test", "cała: nic nie ginie")
    // Komenda, która ma akurat 200 jednostek, traci ostatnie słowo także wtedy, gdy jest cała — cena zgodności
    // ze starym serwerem; z dwóch słów narzędzia zostaje pierwsze.
    let exact = "grep -rn x " + String(repeating: "a", count: 176) + " && pnpm test"
    #expect(exact.utf16.count == CommandTools.legacyCut && short(exact) == "grep, pnpm")
  }

  @Test("zapas bez narzędzi: początek komendy do 60 znaków z wielokropkiem, krótka w całości")
  func clippedFallback() {
    #expect(CommandTools.clipped("helper() { rm x; }") == "helper() { rm x; }")
    let long = "W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy-ui-okno; O=/tmp/folders/xx"
    #expect(CommandTools.clipped(long) == "W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy…")
    #expect(CommandTools.clipped(long).count == CommandTools.clipLength + 1)
    #expect(CommandTools.clipped(String(repeating: "a", count: 59) + " bcd") == String(repeating: "a", count: 59) + "…",
            "spacja przed wielokropkiem schodzi")
    // Cięcie idzie po znakach, nie po jednostkach kodu: rodzina z ZWJ i litera ze znakiem łączonym zostają całe.
    let family = String(repeating: "a", count: 59) + "👨‍👩‍👧 reszta"
    #expect(CommandTools.clipped(family) == String(repeating: "a", count: 59) + "👨‍👩‍👧…")
    let combining = String(repeating: "a", count: 59) + "e\u{301} reszta"
    #expect(CommandTools.clipped(combining) == String(repeating: "a", count: 59) + "e\u{301}…")
  }
}
