@testable import RarogUI
import Testing

/// Kafel „always” w dwóch wierszach: znany początek pogrubiony, pod nim zakres
/// reguły ze ścieżkami pismem stałej szerokości. Etykiety wzięte dosłownie z ekranów w `server/test/fixtures/herdr/`.
/// Właściciel: karty.
@Suite("kafel „always” dwuwierszowo: początek i zakres reguły, fail-safe dla nieznanych etykiet")
struct AlwaysLabelPartsTests {
  private func parts(_ head: String, _ scope: String) -> AlwaysLabelParts.Parts {
    AlwaysLabelParts.Parts(head: head, scope: scope)
  }

  private func text(_ value: String) -> AlwaysLabelParts.Run { AlwaysLabelParts.Run(text: value, isPath: false) }
  private func path(_ value: String) -> AlwaysLabelParts.Run { AlwaysLabelParts.Run(text: value, isPath: true) }

  @Test("czwarty początek „Yes, allow reading”: zakres od „from”, projekt i sesja")
  func readGrant() {
    // dialog-permission-odczyt-z-projektu.txt
    #expect(
      AlwaysLabelParts.split("Yes, allow reading from /Users/u/.local/share/dane from this project")
        == parts("Yes, allow reading", "from ~/.local/share/dane from this project"))
    // dialog-permission-read-2.1.278.txt
    #expect(
      AlwaysLabelParts.split("Yes, allow reading from /etc and /private/etc during this session")
        == parts("Yes, allow reading", "from /etc and /private/etc during this session"))
    // Zgłoszenie z iPhone'a: katalog tymczasowy macOS skrócony do $TMPDIR.
    #expect(
      AlwaysLabelParts.split(
        "Yes, allow reading from /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/rarog-telefon-probe.NnFcpp"
          + " from this project")
        == parts("Yes, allow reading", "from $TMPDIR/rarog-telefon-probe.NnFcpp from this project"))
    // Bez „from” albo bez zakresu — etykieta w całości; „Yes, and allow” nadal swoim wzorcem.
    for label in ["Yes, allow reading", "Yes, allow reading from", "Yes, allow reading files in /etc", "Yes, allow"] {
      #expect(AlwaysLabelParts.split(label) == nil, "\(label)")
    }
    #expect(AlwaysLabelParts.split("Yes, and allow reading from /etc")?.head == "Yes, and allow")
  }

  @Test("$TMPDIR: /private/var/folders/<a>/<b>/T i /var/folders/<a>/<b>/T, cały segment, tylko katalog T")
  func tmpPaths() {
    #expect(AlwaysLabelParts.tmpShortened("from /var/folders/aa/bb/T/x/y from this project")
      == "from $TMPDIR/x/y from this project")
    #expect(AlwaysLabelParts.tmpShortened("/private/var/folders/aa/bb/T") == "$TMPDIR")
    #expect(AlwaysLabelParts.tmpShortened(#"in "/private/var/folders/aa/bb/T/z" and (/var/folders/c/d/T)"#)
      == #"in "$TMPDIR/z" and ($TMPDIR)"#)
    // Sąsiednie katalogi systemu (C — cache, 0 — dane), dłuższa nazwa, środek słowa i brak segmentu — bez zmian.
    for same in [
      "from /var/folders/aa/bb/C/x", "from /private/var/folders/aa/bb/0/x", "from /var/folders/aa/bb/Tx/y",
      "from x/var/folders/aa/bb/T/y", "from /var/folders/aa/T/y", "from /private/var/folders",
    ] {
      #expect(AlwaysLabelParts.tmpShortened(same) == same, "\(same)")
    }
    // Obok skrótu ~ w jednym zakresie.
    #expect(
      AlwaysLabelParts.split("Yes, and always allow access to /var/folders/aa/bb/T/p and /Users/u/q from this project")
        == parts("Yes, and always allow", "access to $TMPDIR/p and ~/q from this project"))
  }

  @Test("odcinki zakresu: ścieżki od /, ~ i $TMPDIR; reszta tekstem; złączone dają zakres znak w znak")
  func scopeRuns() {
    #expect(AlwaysLabelParts.scopeRuns("from $TMPDIR/rarog-telefon-probe.NnFcpp from this project")
      == [text("from "), path("$TMPDIR/rarog-telefon-probe.NnFcpp"), text(" from this project")])
    #expect(AlwaysLabelParts.scopeRuns("for git commands in ~/repo/a/b/c and \"~/d\"")
      == [text("for git commands in "), path("~/repo/a/b/c"), text(" and \""), path("~/d"), text("\"")])
    #expect(AlwaysLabelParts.scopeRuns("/private/tmp/claude access and (/etc) in ~")
      == [path("/private/tmp/claude"), text(" access and ("), path("/etc"), text(") in "), path("~")])
    #expect(AlwaysLabelParts.scopeRuns("from $TMPDIR during this session")
      == [text("from "), path("$TMPDIR"), text(" during this session")])
    // Bez ścieżki: jeden odcinek tekstu; środek słowa, ~ bez ukośnika i $TMPDIRX to nie ścieżki.
    #expect(AlwaysLabelParts.scopeRuns("for: cd *") == [text("for: cd *")])
    #expect(AlwaysLabelParts.scopeRuns("a/b ~x $TMPDIRX x~/y ok") == [text("a/b ~x $TMPDIRX x~/y ok")])
    #expect(AlwaysLabelParts.scopeRuns("").isEmpty)
    for scope in [
      #"/private/tmp/claude access and pnpm build and "echo \"build exit=$?\"" commands"#,
      "for pnpm commands in ~/Projects/atlas", "access to /tmp from this project", " /a  /b ",
    ] {
      #expect(AlwaysLabelParts.scopeRuns(scope).map(\.text).joined() == scope, "\(scope)")
    }
  }

  @Test("trzy pierwsze początki z ekranów CLI (fixtures herdr), ścieżka domowa skrócona do ~")
  func knownHeads() {
    // dialog-permission.txt
    #expect(
      AlwaysLabelParts.split("Yes, and don't ask again for pnpm commands in /Users/u/Projects/atlas")
        == parts("Yes, and don't ask again", "for pnpm commands in ~/Projects/atlas"))
    // dialog-permission-subagent.txt — apostrof typograficzny U+2019
    #expect(AlwaysLabelParts.split("Yes, and don’t ask again for: cd *") == parts("Yes, and don’t ask again", "for: cd *"))
    // dialog-permission-unsandboxed.txt, measured/zgoda-bash-2.1.285.txt
    #expect(
      AlwaysLabelParts.split("Yes, and always allow access to /tmp from this project")
        == parts("Yes, and always allow", "access to /tmp from this project"))
    // dialog-permission-ask-rule-auto.txt (tryb auto): ścieżka spoza katalogu domowego zostaje bez zmian
    let auto = #"Yes, and allow /private/tmp/claude access and pnpm build and "echo \"build exit=$?\"" commands"#
    #expect(
      AlwaysLabelParts.split(auto)
        == parts("Yes, and allow", #"/private/tmp/claude access and pnpm build and "echo \"build exit=$?\"" commands"#))
    // Golden SSE `permission-pending.max.json`
    #expect(
      AlwaysLabelParts.split("Yes, and don't ask again for pnpm test commands in /Users/demo/Projects/birch")
        == parts("Yes, and don't ask again", "for pnpm test commands in ~/Projects/birch"))
  }

  @Test("fail-safe: inny początek, brak zakresu albo kilka wierszy — etykieta w całości")
  func unknownStaysWhole() {
    for label in [
      "Yes, always",
      "Yes, and use auto mode",
      "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "Yes, and don't ask again",
      "Yes, and don't ask again   ",
      "Yes, and always allow\naccess to /tmp",
      "yes, and don't ask again for git",
      "",
    ] {
      #expect(AlwaysLabelParts.split(label) == nil, "\(label)")
    }
  }

  @Test("ścieżki domowe w dowolnym miejscu zakresu; katalog domowy cały, reszta ścieżki bez ucinania")
  func homePaths() {
    #expect(
      AlwaysLabelParts.split("Yes, and don't ask again for git commands in /home/ci/repo/a/b/c and \"/Users/x/d\"")
        == parts("Yes, and don't ask again", "for git commands in ~/repo/a/b/c and \"~/d\""))
    // Bez katalogu pod /Users albo /home nic się nie zmienia; środek słowa nie jest początkiem ścieżki.
    #expect(AlwaysLabelParts.homeShortened("for x/Users/y and /Users") == "for x/Users/y and /Users")
    #expect(AlwaysLabelParts.homeShortened("/Users/u") == "~")
  }
}
