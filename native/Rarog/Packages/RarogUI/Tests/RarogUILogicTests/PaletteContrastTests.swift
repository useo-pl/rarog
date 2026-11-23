import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Kontrast tokenów. Właściciel: dostępność.

@Suite("kontrast tokenów")
struct PaletteContrastTests {
  private typealias RGB = TranscriptDim.RGB

  private func contrast(_ ink: PaletteTokens.Pair, on background: PaletteTokens.Pair) -> (dark: Double, light: Double) {
    (
      TranscriptDim.contrast(RGB(hex: ink.dark), RGB(hex: background.dark)),
      TranscriptDim.contrast(RGB(hex: ink.light), RGB(hex: background.light))
    )
  }

  @Test("tekst i wyciszony atrament ≥ 7:1 na tle w obu motywach (przygaszony transkrypt)")
  func mutedSevenToOne() {
    for ink in [PaletteTokens.text, PaletteTokens.muted] {
      let ratio = contrast(ink, on: PaletteTokens.background)
      #expect(ratio.dark >= 7 && ratio.light >= 7, "\(ink): \(ratio)")
    }
    // Jasny wyciszony PWA (#52525B) miał 6,93:1 — token apki jest o krok ciemniejszy.
    #expect(TranscriptDim.contrast(RGB(hex: 0x52525B), RGB(hex: PaletteTokens.background.light)) < 7)
  }

  @Test("tekst drugiego planu (`text2`): ≥ 7:1 na tle i `surface`, jaśniej niż `muted`, ciszej niż `text`")
  func secondaryText() {
    for background in [PaletteTokens.background, PaletteTokens.surface] {
      let second = contrast(PaletteTokens.text2, on: background)
      let full = contrast(PaletteTokens.text, on: background)
      let quiet = contrast(PaletteTokens.muted, on: background)
      #expect(second.dark >= 7 && second.light >= 7, "\(background): \(second)")
      // Nazwa pliku pod wskaźnikiem wraca do `text`, nazwa skończonego zadania ma być czytelniejsza niż w `muted`:
      // obie różnice muszą być widać, więc każda to co najmniej 1,25 raza kontrastu.
      #expect(full.dark >= second.dark * 1.25 && full.light >= second.light * 1.25, "\(background): \(full) i \(second)")
      #expect(second.dark >= quiet.dark * 1.25 && second.light >= quiet.light * 1.25, "\(background): \(second) i \(quiet)")
    }
  }

  @Test("proza agenta (`prose`): ≥ 7:1 także przygaszona, `strong` jaśniejszy w ciemnym motywie")
  func proseAndStrong() {
    let prose = contrast(PaletteTokens.prose, on: PaletteTokens.background)
    let strong = contrast(PaletteTokens.strong, on: PaletteTokens.background)
    #expect(prose.dark >= 7 && prose.light >= 7, "\(prose)")
    // Przygaszenie pod kartą decyzji liczy się od `prose`, najciemniejszego atramentu wierszy tekstu: przy kryciu
    // `soft` proza ma zostać ponad progiem, inaczej przygaszenie robiłoby się słabsze niż dotąd.
    let dimmed = TranscriptDim.dimmedContrast(
      RGB(hex: PaletteTokens.prose.dark), RGB(hex: PaletteTokens.background.dark), alpha: TranscriptDim.soft)
    #expect(dimmed >= TranscriptDim.minContrast, "przygaszona proza: \(dimmed)")
    // Pogrubienie ma się odcinać jasnością (wariant B z makiety,4:1 wobec 19,8:1).
    #expect(strong.dark >= prose.dark * 1.4, "\(strong) i \(prose)")
    // Jasny motyw bez zmian: ciemne pogrubienie na jasnym tle odcina się samą grubością.
    #expect(PaletteTokens.prose.light == PaletteTokens.text.light)
    #expect(PaletteTokens.strong.light == PaletteTokens.text.light)
  }

  @Test("tekst pomocniczy i kolory stanów pisane tekstem spełniają AA (4,5:1) na tle i powierzchni")
  func textAA() {
    let inks = [
      PaletteTokens.muted2, PaletteTokens.wait, PaletteTokens.run, PaletteTokens.err, PaletteTokens.new,
    ]
    for ink in inks {
      for background in [PaletteTokens.background, PaletteTokens.surface, PaletteTokens.surface2] {
        let ratio = contrast(ink, on: background)
        #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink) na \(background): \(ratio)")
      }
    }
  }

  @Test("PR state label: the word ≥ 4.5:1 on each smoked GitHub state fill, in both themes")
  func pullRequestStateLabel() {
    for state in PullRequestState.allCases {
      let ratio = contrast(PullRequestStateTokens.ink, on: PullRequestStateTokens.fill(state))
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(state): \(ratio)")
    }
  }

  /// Wariant B z planszy: napis niesie informację, więc AA; kreska ma się odcinać od tła wyraźnie mocniej
  /// niż włos `border` (≈ 1,2:1), ale pozostaje kreską (pomiar przy 55 %: 3,5:1 ciemny, 2,5:1 jasny).
  @Test("linia „NOWE”: napis w `new` ≥ 4,5:1 na tle transkryptu, kreska w swoim kryciu ≥ 2:1")
  func newMarkerLine() {
    let text = contrast(PaletteTokens.new, on: PaletteTokens.background)
    #expect(text.dark >= 4.5 && text.light >= 4.5, "napis: \(text)")
    let rule = (
      dark: TranscriptDim.dimmedContrast(
        RGB(hex: PaletteTokens.new.dark), RGB(hex: PaletteTokens.background.dark), alpha: PaletteTokens.newMarkerRuleAlpha),
      light: TranscriptDim.dimmedContrast(
        RGB(hex: PaletteTokens.new.light), RGB(hex: PaletteTokens.background.light), alpha: PaletteTokens.newMarkerRuleAlpha)
    )
    #expect(rule.dark >= 2 && rule.light >= 2, "kreska: \(rule)")
  }

  @Test("popover na pełnym `surface`: tekst i `muted` ≥ 7:1, `muted2` i atramenty gita ≥ 4,5:1")
  func popoverSurfaceInks() {
    // Git, „w tle” i model stoją na `surface` (`popoverSurface`), nie na systemowym szkle, którego jasności nie
    // da się policzyć z góry — każdy atrament paneli ma tu stały próg.
    for ink in [PaletteTokens.text, PaletteTokens.muted] {
      let ratio = contrast(ink, on: PaletteTokens.surface)
      #expect(ratio.dark >= 7 && ratio.light >= 7, "\(ink): \(ratio)")
    }
    let inks = [
      PaletteTokens.muted2, PaletteTokens.run, PaletteTokens.wait, PaletteTokens.err, PaletteTokens.new,
      PaletteTokens.ahead, PaletteTokens.behind,
    ]
    for ink in inks {
      let ratio = contrast(ink, on: PaletteTokens.surface)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink): \(ratio)")
    }
  }

  @Test("strzałki ahead/behind i pola do wpisania trzymają AA tam, gdzie stoją")
  func syncArrowsAndInputsAA() {
    for ink in [PaletteTokens.ahead, PaletteTokens.behind] {
      for background in [PaletteTokens.background, PaletteTokens.surface, PaletteTokens.surface2] {
        let ratio = contrast(ink, on: background)
        #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink) na \(background): \(ratio)")
      }
    }
    for field in [PaletteTokens.input, PaletteTokens.composerRest] {
      for ink in [PaletteTokens.text, PaletteTokens.muted] {
        let ratio = contrast(ink, on: field)
        #expect(ratio.dark >= 7 && ratio.light >= 7, "\(ink) na \(field): \(ratio)")
      }
    }
  }

  @Test("nieświeże liczby i etykiety limitów zachowują AA na pełnym tle stopki")
  func staleUsageTextAA() throws {
    let usage = Sample.decode(PlanUsage.self, #"""
      {"stale":true,"fetchedAt":"2026-10-04T10:00:00.000Z",
       "fiveHour":{"percent":27},"weekly":{"percent":63},"weeklyModel":{"percent":91,"model":"Fable"}}
      """#)
    var state = AppState(clientBuild: 1)
    state.apply(.planUsageResult(.loaded(usage), at: Sample.now), now: Sample.now)
    let model = PlanUsageModel.make(state.planUsage, now: Sample.now)
    #expect(model.phase == .stale && model.segments.count == 3)
    // Tekst stopki stoi zawsze w pełnym kryciu: przygasić wolno tylko widma i tory
    // szkieletu przy „niedostępne", a przy nieświeżych liczbach nawet ich nie. Nieświeżość mówią notka w panelu
    // i zdanie czytnika (linia nie ma znaku zegara).
    let alpha = 1.0
    #expect(model.ghostOpacity == 1)
    #expect(model.staleNote != nil)
    // Stopka listy stoi na tle kolumny (`background`, jak `--bg` w PWA); panel limitów nad nią
    // — na `surface`. Obie płaszczyzny muszą trzymać AA. `text2` — procent limitu w spokoju.
    for background in [PaletteTokens.surface, PaletteTokens.background] {
      for ink in [PaletteTokens.muted2, PaletteTokens.muted, PaletteTokens.text2, PaletteTokens.wait, PaletteTokens.err] {
        let dark = TranscriptDim.dimmedContrast(RGB(hex: ink.dark), RGB(hex: background.dark), alpha: alpha)
        let light = TranscriptDim.dimmedContrast(RGB(hex: ink.light), RGB(hex: background.light), alpha: alpha)
        #expect(dark >= 4.5 && light >= 4.5, "nieświeży tekst stopki na \(background): \(dark), \(light)")
      }
    }
  }

  @Test("nazwa tailnetu zachowuje AA na tle kolumny listy (pasek listy stoi na `background`)")
  func listHeaderOnListColumnAA() {
    // Kolumna listy bez systemowego tła stylu `.sidebar` (jak w PWA): odczyt pikseli zrzutów
    // (iOS 27) pod nazwą tailnetu to dokładnie #F2F2F7 i #0A0A0A, czyli `background`. Systemowe tło
    // #E2E6F0 nie występuje; na nim `muted2` ma 4,228:1, stąd mocniejszy `listHeaderInk`.
    let measured = PaletteTokens.Pair(dark: 0x0A0A0A, light: 0xF2F2F7)
    #expect(measured == PaletteTokens.background, "pomiar kolumny = token tła")
    for background in [PaletteTokens.background, PaletteTokens.surface, PaletteTokens.surface2] {
      let ratio = contrast(PaletteTokens.listHeaderInk, on: background)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "nazwa tailnetu na \(background): \(ratio)")
    }
  }

  @Test("kropki i kreski stanów (grafika) ≥ 3:1; świadomy wyjątek: atrament bezczynnych ~2,8:1")
  func graphicsAndIdle() {
    for tone in [StatusTone.working, .waiting, .failed, .unread, .quiet] {
      for background in [PaletteTokens.background, PaletteTokens.surface] {
        let ratio = contrast(PaletteTokens.tone(tone), on: background)
        #expect(ratio.dark >= 3 && ratio.light >= 3, "\(tone): \(ratio)")
      }
    }
    let idle = contrast(PaletteTokens.idleInk, on: PaletteTokens.background)
    #expect(idle.dark < 4.5 && idle.dark > 2.5 && idle.light < 4.5 && idle.light > 2.5, "świadomy wyjątek atramentu bezczynnego wiersza: \(idle)")
  }

  /// Sekcja „w tle”: `done` niesie glify skończonego (✓ ■ ?) i zgaszoną kropkę pracy bez kontaktu ze
  /// źródłem — w panelu na `background`, w popoverze na `surface`. Jako GLIF trzyma 3:1, jako tekst 4,5:1 już nie
  /// (na ciemnym `surface` ~3,7:1), więc napisy obok glifów idą w `muted`.
  @Test("glif `done` (skończone, zgaszona kropka) ≥ 3:1 na tle panelu i popovera; jako tekst za słaby")
  func doneGlyph() {
    for background in [PaletteTokens.background, PaletteTokens.surface] {
      let ratio = contrast(PaletteTokens.done, on: background)
      #expect(ratio.dark >= 3 && ratio.light >= 3, "done na \(background): \(ratio)")
    }
    #expect(contrast(PaletteTokens.done, on: PaletteTokens.surface).dark < 4.5, "napis w `done` nie trzymałby AA")
  }

  /// Przydymiona zieleń: `run` nad `background`, kryjąca — w ciemnym 62 %,
  /// w jasnym 75 %. Element stanu (kropka, dymek, kwadracik, klepsydra
  /// subagenta w postoju) trzyma 3:1 na tle listy i na popoverze; od pracy i od ciszy różni się wartością.
  @Test("ton „czeka na zadanie w tle”: ≥ 3:1 nad `background` i `surface`, inny niż `run` i `done`, cyfra kafelka ≥ 4,5:1")
  func runSmokedContrast() {
    let smoked = PaletteTokens.runSmoked
    #expect(PaletteTokens.tone(.backgroundWait) == smoked)
    for ground in [PaletteTokens.background, PaletteTokens.surface] {
      let ratio = contrast(smoked, on: ground)
      print("runSmoked na #\(String(ground.dark, radix: 16)) / #\(String(ground.light, radix: 16)): \(ratio)")
      #expect(ratio.dark >= 3 && ratio.light >= 3, "na \(ground): \(ratio)")
    }
    for other in [PaletteTokens.run, PaletteTokens.done] {
      #expect(smoked.dark != other.dark && smoked.light != other.light, "\(other)")
    }
    // Cyfra kafelka zakładki na przydymionej zieleni dalej czyta się jak tekst.
    let digit = contrast(PaletteTokens.onRunSmoked, on: smoked)
    #expect(digit.dark >= 4.5 && digit.light >= 4.5, "cyfra na kafelku: \(digit)")
  }

  /// Glif notatki projektu z treścią: bursztyn z rodziny kodu w linii, nie `wait` (ten woła
  /// człowieka). Grafika, więc 3:1 — w drzewie na tle kolumny, w pasku zakładek na tle paska i na płytce bieżącej.
  @Test("`noteInk`: ≥ 3:1 na `background`, `surface2` i płytce zakładki w obu motywach, inny niż `wait`")
  func noteInkContrast() {
    for ground in [PaletteTokens.background, PaletteTokens.surface2, TabTokens.plate] {
      let ratio = contrast(PaletteTokens.noteInk, on: ground)
      #expect(ratio.dark >= 3 && ratio.light >= 3, "noteInk na \(ground): \(ratio)")
    }
    #expect(PaletteTokens.noteInk.dark != PaletteTokens.wait.dark && PaletteTokens.noteInk.light != PaletteTokens.wait.light)
    // Glif bez notatki jest szary (`muted2`): bursztyn musi się od niego odróżniać nie tylko barwą.
    #expect(PaletteTokens.noteInk.dark != PaletteTokens.muted2.dark && PaletteTokens.noteInk.light != PaletteTokens.muted2.light)
  }

  /// Kafelek skrótu na zakładce niesie stan („ladder”). Audyt UI tej cyfry nie
  /// zmierzy sam (glif za drobny, antyaliasing brał za atrament), więc kontrast pilnuje ten test, a audyt ma na cyfrę
  /// jawny wyjątek. Tło paska to `background`; kafelek bieżącej zakładki stoi na płytce, ale jest kryjący (kolor
  /// złożony na tle paska), więc jego tło jest to samo u sióstr i na płytce.
  @Test("kafelek skrótu na zakładce: cyfra ≥ 4,5:1 na kafelku każdego stanu, u siostry i na płytce bieżącej")
  func tabShortcutKeyAA() {
    let tones: [StatusTone] = [.quiet, .working, .unread, .waiting, .failed, .backgroundWait]
    for tone in tones {
      let look = TabTokens.key(tone)
      let ratio = contrast(look.ink, on: look.fill)
      print("kafelek \(tone): tło #\(String(look.fill.dark, radix: 16)) / #\(String(look.fill.light, radix: 16)), "
        + "cyfra \(ratio.dark) / \(ratio.light)")
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(tone): \(ratio)")
    }
  }

  /// Kryjący kafelek ciszy ma kolor #2A2A2A / #DFDFE3; na płytce tego koloru widać by było samą cyfrę.
  /// Płytka w kolorze zaznaczonego wiersza listy jest inna, więc cichy kafelek na bieżącej zakładce ma brzeg.
  /// Boki iPada: lista obok sesji i prawy panel stoją na `sidebar`, o stopień od transkryptu.
  /// Wszystko, co pisze lista i panel, trzyma tam te same progi co na `background`; jasny #E8E8ED z makiety ich nie
  /// trzymał (`muted2` 4,33, `behind` 4,39, `runSmoked` 2,90), stąd #EDEDF2.
  @Test("boki iPada (`sidebar`): stopień od tła, atramenty listy i panelu trzymają progi z tła, wyjątek bezczynnych")
  func sidebarInks() {
    let side = PaletteTokens.sidebar
    let step = contrast(side, on: PaletteTokens.background)
    #expect(step.dark >= 1.04 && step.light >= 1.04 && step.dark < 1.15 && step.light < 1.15, "stopień: \(step)")
    for ink in [PaletteTokens.text, PaletteTokens.text2] {
      let ratio = contrast(ink, on: side)
      #expect(ratio.dark >= 7 && ratio.light >= 7, "\(ink): \(ratio)")
    }
    let inks = [
      PaletteTokens.muted, PaletteTokens.listHeaderInk, PaletteTokens.muted2, PaletteTokens.wait, PaletteTokens.run,
      PaletteTokens.err, PaletteTokens.new, PaletteTokens.ahead, PaletteTokens.behind, PaletteTokens.linkInk,
    ]
    for ink in inks {
      let ratio = contrast(ink, on: side)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink): \(ratio)")
    }
    let graphics = [StatusTone.working, .waiting, .failed, .unread, .quiet].map(PaletteTokens.tone)
      + [PaletteTokens.runSmoked, PaletteTokens.done, PaletteTokens.noteInk]
    for ink in graphics {
      let ratio = contrast(ink, on: side)
      #expect(ratio.dark >= 3 && ratio.light >= 3, "\(ink): \(ratio)")
    }
    let idle = contrast(PaletteTokens.idleInk, on: side)
    #expect(idle.dark < 4.5 && idle.dark > 2.5 && idle.light < 4.5 && idle.light > 2.5, "świadomy wyjątek atramentu bezczynnego wiersza: \(idle)")
    // Plama zaznaczonego wiersza listy dalej odcina się od boku.
    let plate = contrast(PaletteTokens.surface2, on: side)
    #expect(plate.dark >= 1.05 && plate.light >= 1.05, "plama: \(plate)")
  }

  /// The stacked list (iPhone) stands on `background`, and its plate marks the row the human came back from and the
  /// row under the finger. `surface2` on the light background is too close to tell apart, so the plate has its own
  /// pair; the row's inks keep their thresholds on it (the plate lifts idle muting; under the finger it does not).
  @Test("stacked list plate: stands off the column in both themes, the row's inks keep their thresholds on it")
  func stackedListPlate() {
    let ground = contrast(PaletteTokens.stackedPlate, on: PaletteTokens.background)
    #expect(ground.dark >= 1.1 && ground.light >= 1.1, "plate on the column: \(ground)")
    let inks = [
      PaletteTokens.text, PaletteTokens.muted, PaletteTokens.muted2, PaletteTokens.wait, PaletteTokens.run,
      PaletteTokens.err, PaletteTokens.new,
    ]
    for ink in inks {
      let ratio = contrast(ink, on: PaletteTokens.stackedPlate)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink): \(ratio)")
    }
    for tone in [StatusTone.working, .waiting, .failed, .unread, .quiet] {
      let ratio = contrast(PaletteTokens.tone(tone), on: PaletteTokens.stackedPlate)
      #expect(ratio.dark >= 3 && ratio.light >= 3, "\(tone): \(ratio)")
    }
    // Idle ink is a deliberate exception below AA, and the finger's plate does not lift it. The dark plate is the
    // iPad's `surface2`; the light one must not sink the idle ink below where it stands on that plate.
    let idle = contrast(PaletteTokens.idleInk, on: PaletteTokens.stackedPlate)
    let idleBeside = contrast(PaletteTokens.idleInk, on: PaletteTokens.surface2)
    #expect(idle.light >= idleBeside.light, "idle ink in light: \(idle.light) vs \(idleBeside.light)")
  }

  @Test("cichy kafelek odcina się od płytki bieżącej zakładki (≥ 1,15:1)")
  func tabQuietKeyOnPlate() {
    let ratio = contrast(TabTokens.key(.quiet).fill, on: TabTokens.plate)
    #expect(ratio.dark >= 1.15 && ratio.light >= 1.15, "cichy kafelek na płytce: \(ratio)")
  }

  @Test("płytka bieżącej zakładki: odcina się od tła paska, etykieta ≥ 7:1, znak stanu ≥ 3:1")
  func tabPlate() {
    let plate = TabTokens.plate
    // Pasek i lista stoją na tym samym tle. W ciemnym płytka odcina się od tła (~1,16:1); w jasnym ma ~1,04:1, tyle
    // samo co zaznaczony wiersz listy — wtedy „tu jesteś” niesie głównie pogrubiona etykieta w `text`.
    let ground = contrast(plate, on: PaletteTokens.background)
    #expect(ground.dark >= 1.1, "płytka na tle: \(ground)")
    let label = contrast(PaletteTokens.text, on: plate)
    #expect(label.dark >= 7 && label.light >= 7, "etykieta bieżącej (`text`): \(label)")
    // Znak stanu przed etykietą (grafika) stoi przy „Rozróżniaj bez koloru” w pełnym kryciu także na płytce.
    for tone in [StatusTone.working, .waiting, .failed, .unread, .backgroundWait] {
      let ratio = contrast(PaletteTokens.tone(tone), on: plate)
      #expect(ratio.dark >= 3 && ratio.light >= 3, "znak \(tone) na płytce: \(ratio)")
    }
    // Etykieta siostry: `muted2` na tle paska.
    let sibling = contrast(PaletteTokens.muted2, on: PaletteTokens.background)
    #expect(sibling.dark >= 4.5 && sibling.light >= 4.5, "\(sibling)")
  }

  /// Znak siostry stoi w kryciu `TabTokens.markAlpha` nad tłem paska. Przydymiona zieleń w 70 % dawała w jasnym
  /// ~2,15:1, poniżej 3:1 dla elementu stanu, więc jej znak u siostry jest kryjący.
  @Test("znak „czeka na zadanie w tle” u siostry (current: false): ≥ 3:1 nad tłem paska w rzeczywistym kryciu")
  func backgroundWaitSiblingMark() {
    let alpha = TabTokens.markAlpha(.backgroundWait, current: false)
    let mark = TabTokens.composite(PaletteTokens.tone(.backgroundWait), alpha, on: PaletteTokens.background)
    let ratio = contrast(mark, on: PaletteTokens.background)
    #expect(ratio.dark >= 3 && ratio.light >= 3, "znak siostry w kryciu \(alpha): \(ratio)")
    #expect(TabTokens.markAlpha(.backgroundWait, current: true) == .opaque)
  }

  /// Kwadracik nie niesie tekstu, więc progu kontrastu tekstu nie ma; stan mówi zdanie zakładki. Kolorowy (kolor kropki
  /// listy sesji) ma jednak odcinać się od tła paska mocniej niż cichy.
  @Test("kwadracik: cichy słabiej niż kolorowy wobec tła paska, w obu motywach")
  func tabSquareQuietBelowColored() {
    func onBar(_ look: TabTokens.SquareLook) -> (dark: Double, light: Double) {
      contrast(TabTokens.composite(look.color, look.alpha, on: PaletteTokens.background), on: PaletteTokens.background)
    }
    let quiet = onBar(TabTokens.square(.quiet))
    for tone in [StatusTone.working, .unread, .waiting, .failed, .backgroundWait] {
      let colored = onBar(TabTokens.square(tone))
      #expect(quiet.dark < colored.dark && quiet.light < colored.light, "\(tone): cisza \(quiet), kolor \(colored)")
    }
  }

  @Test("kod w linii: ciepły atrament ≥ 4,5:1 na swoim tle w treści agenta i w dymku człowieka, w obu motywach")
  func inlineCodeInkAA() {
    let ink = PaletteTokens.inlineCodeInk
    let alpha = PaletteTokens.inlineCodeFillAlpha
    for base in [PaletteTokens.background, PaletteTokens.userPlate] {
      let darkFill = PaletteTokens.over(0xFFFFFF, alpha: alpha.dark, on: base.dark)
      let lightFill = PaletteTokens.over(0x000000, alpha: alpha.light, on: base.light)
      let dark = TranscriptDim.contrast(RGB(hex: ink.dark), RGB(hex: darkFill))
      let light = TranscriptDim.contrast(RGB(hex: ink.light), RGB(hex: lightFill))
      #expect(dark >= 4.5 && light >= 4.5, "na \(base): \(dark) / \(light)")
    }
    #expect(ink.dark != PaletteTokens.wait.dark && ink.light != PaletteTokens.wait.light, "nie bursztyn stanu „czeka”")
  }

  @Test("link: stonowany niebieski ≥ 4,5:1 na tle transkryptu, dymku człowieka i bloku kodu, w obu motywach")
  func linkInkAA() {
    for background in [PaletteTokens.background, PaletteTokens.userPlate, PaletteTokens.codeBlockFill] {
      let ratio = contrast(PaletteTokens.linkInk, on: background)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "na \(background): \(ratio)")
    }
    #expect(PaletteTokens.linkInk.dark != PaletteTokens.new.dark, "nie niebieski stanu „skończyła”")
  }

  @Test("dymek człowieka: tekst ≥ 7:1, muted ≥ 4,5:1, odcina się od tła i od bloku kodu")
  func userPlateReadsAndStandsOut() {
    let plate = PaletteTokens.userPlate
    #expect(contrast(PaletteTokens.text, on: plate).dark >= 7 && contrast(PaletteTokens.text, on: plate).light >= 7)
    #expect(contrast(PaletteTokens.muted, on: plate).dark >= 4.5 && contrast(PaletteTokens.muted, on: plate).light >= 4.5)
    let ground = contrast(plate, on: PaletteTokens.background)
    #expect(ground.dark >= 1.1 && ground.light >= 1.1, "dymek na tle: \(ground)")
    // Od bloku kodu w odpowiedzi przydymiony dymek odcina się jasnością ledwo (przy
    // 50 % krycia byłoby 1,01:1 w obu motywach). Próg pilnuje, żeby kolejna zmiana nie zeszła do zlania.
    let code = contrast(plate, on: PaletteTokens.codeBlockFill)
    #expect(code.dark >= 1.09 && code.light >= 1.03, "dymek na bloku kodu: \(code)")
  }

  @Test("pasek promptu pod palcem: tło dymku o ton inne, tekst ≥ 7:1, ikona (grafika) ≥ 3:1")
  func userPlatePressed() {
    let pressed = PaletteTokens.userPlatePressed
    #expect(contrast(PaletteTokens.text, on: pressed).dark >= 7 && contrast(PaletteTokens.text, on: pressed).light >= 7)
    // Ikona cytatu to grafika (WCAG 1.4.11: 3:1); pod palcem w ciemnym ma ~4,9:1
    // — mocniejszy krok tła wygrywa z 4,5:1 ikony, bo słabszy (biel 5 %) ledwo widać.
    // W spoczynku ikona trzyma 4,5:1 (`userPlateReadsAndStandsOut`).
    #expect(contrast(PaletteTokens.muted, on: pressed).dark >= 3 && contrast(PaletteTokens.muted, on: pressed).light >= 3)
    // Dotyk widać bez szkła: wciśnięte tło odcina się od dymku (ciemny jaśniej, jasny ciemniej).
    let step = contrast(pressed, on: PaletteTokens.userPlate)
    #expect(step.dark >= 1.1 && step.light >= 1.1, "dotyk: \(step)")
  }

  @Test("arkusz „Prompty w tej sesji”: na pełnym `surface` i bieżący wiersz na dymku — tekst ≥ 7:1, godzina ≥ 4,5:1")
  func promptListSheet() {
    for background in [PaletteTokens.surface, PaletteTokens.userPlate] {
      let text = contrast(PaletteTokens.text, on: background)
      #expect(text.dark >= 7 && text.light >= 7, "tekst: \(text)")
      // Godzina `muted`: `muted2` na tle dymku ma w jasnym ~4,1:1 (na szkle godziny giną).
      let clock = contrast(PaletteTokens.muted, on: background)
      #expect(clock.dark >= 4.5 && clock.light >= 4.5, "godzina: \(clock)")
    }
    #expect(contrast(PaletteTokens.muted2, on: PaletteTokens.userPlate).light < 4.5, "powód, dla którego nie muted2")
  }

  @Test("blok kodu w dymku: odcina się od dymku, w jasnym wyraźniej niż `codeBlockFill`, tekst ≥ 7:1")
  func codeInPlate() {
    let fill = PaletteTokens.codeInPlateFill
    let plate = contrast(fill, on: PaletteTokens.userPlate)
    #expect(plate.dark >= 1.1 && plate.light >= 1.1, "blok na dymku: \(plate)")
    // W jasnym nowe tło odcina się od dymku wyraźniej niż `codeBlockFill` — i jest od niego jaśniejsze (nie dziura).
    let old = contrast(PaletteTokens.codeBlockFill, on: PaletteTokens.userPlate).light
    #expect(plate.light > old + 0.05, "jasny: \(plate.light) wobec dawnych \(old)")
    #expect(contrast(PaletteTokens.text, on: fill).dark >= 7 && contrast(PaletteTokens.text, on: fill).light >= 7)
  }

  @Test("kolory składni ≥ 4,5:1 na tle bloku kodu (także w dymku) i karty narzędzia w obu motywach")
  func syntaxAA() {
    for kind in SyntaxClass.allCases {
      for background in [PaletteTokens.codeBlockFill, PaletteTokens.codeInPlateFill, PaletteTokens.toolCard] {
        let ratio = contrast(PaletteTokens.syntax(kind), on: background)
        #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(kind) na \(background): \(ratio)")
      }
    }
    // Jasne napis, liczba, literał, komentarz i linia `+` są ciemniejsze niż `--hl-*` z PWA, bo na jasnym tle bloku
    // apki (#E6E6EB) wartości PWA (liczone na bieli) nie trzymają progu.
    for pwa: UInt32 in [0x1C773D, 0x986801, 0x0A6F9E, 0x6B6B73] {
      #expect(TranscriptDim.contrast(RGB(hex: pwa), RGB(hex: PaletteTokens.codeBlockFill.light)) < 4.5, "\(pwa)")
    }
  }

  @Test("kolory składni ≥ 4,5:1 na tle bloku komendy karty zgody (`input`) w obu motywach")
  func syntaxOnPermissionCommandAA() {
    for kind in SyntaxClass.allCases {
      let ratio = contrast(PaletteTokens.syntax(kind), on: PaletteTokens.input)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(kind) na input: \(ratio)")
    }
  }

  /// Kontrast atramentu na tle bloku, gdy cały wiersz (blok i tekst) ma krycie `alpha` nad tłem kolumny.
  private func dimmedOnBlock(_ ink: UInt32, block: UInt32, column: UInt32, alpha: Double) -> Double {
    func over(_ hex: UInt32) -> RGB {
      let (top, bottom) = (RGB(hex: hex), RGB(hex: column))
      return RGB(
        red: alpha * top.red + (1 - alpha) * bottom.red, green: alpha * top.green + (1 - alpha) * bottom.green,
        blue: alpha * top.blue + (1 - alpha) * bottom.blue)
    }
    return TranscriptDim.contrast(over(ink), over(block))
  }

  @Test("pod stojącą decyzją kolory składni nie trzymają 7:1 — przygaszony kod wraca do atramentu tekstu")
  func syntaxUnderDim() {
    // Krycie przygaszenia liczone dla atramentu tekstu na tle kolumny, jak `dimAlpha` wiersza wiadomości.
    let (text, column, fill) = (PaletteTokens.text, PaletteTokens.background, PaletteTokens.codeBlockFill)
    let dark = TranscriptDim.alpha(ink: RGB(hex: text.dark), background: RGB(hex: column.dark))
    let light = TranscriptDim.alpha(ink: RGB(hex: text.light), background: RGB(hex: column.light))
    let weakest = SyntaxClass.allCases.map { kind in
      min(
        dimmedOnBlock(PaletteTokens.syntax(kind).dark, block: fill.dark, column: column.dark, alpha: dark),
        dimmedOnBlock(PaletteTokens.syntax(kind).light, block: fill.light, column: column.light, alpha: light))
    }.min() ?? 0
    #expect(weakest < TranscriptDim.minContrast, "gdyby kolory trzymały 7:1, nie trzeba by ich zdejmować")
    // Atrament, do którego wracają, trzyma próg na tle bloku po przygaszeniu.
    #expect(dimmedOnBlock(text.dark, block: fill.dark, column: column.dark, alpha: dark) >= TranscriptDim.minContrast)
    #expect(dimmedOnBlock(text.light, block: fill.light, column: column.light, alpha: light) >= TranscriptDim.minContrast)
  }

  @Test("okno przełącznika sesji: na zaznaczonym wierszu tekst ≥ 7:1, `muted` i słowa stanów ≥ 4,5:1")
  func switcherSelection() {
    let selection = PaletteTokens.switcherSelection
    let text = contrast(PaletteTokens.text, on: selection)
    #expect(text.dark >= 7 && text.light >= 7, "\(text)")
    // Słowo stanu stoi w kolorze stanu, tekst drugorzędny zaznaczonego wiersza w `muted`.
    let inks = [PaletteTokens.muted, PaletteTokens.wait, PaletteTokens.run, PaletteTokens.err, PaletteTokens.new]
    for ink in inks {
      let ratio = contrast(ink, on: selection)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink): \(ratio)")
    }
    // Dlatego nie `muted2` (tekst drugorzędny poza zaznaczeniem) ani `done` (słowo wiersza, który ucichł).
    #expect(contrast(PaletteTokens.muted2, on: selection).dark < 4.5)
    #expect(contrast(PaletteTokens.done, on: selection).dark < 4.5)
    // Zaznaczenie widać na tle okna bez koloru akcentu.
    let step = contrast(selection, on: PaletteTokens.surface)
    #expect(step.dark >= 1.1 && step.light >= 1.1, "\(step)")
  }

  @Test("dictation mic plate: the icon ≥ 4.5:1 on it, the lit icon ≥ 3:1, and both plates show on the card")
  func micPlate() {
    let icon = contrast(PaletteTokens.text, on: PaletteTokens.micPlate)
    #expect(icon.dark >= 4.5 && icon.light >= 4.5, "\(icon)")
    let lit = contrast(PaletteTokens.err, on: PaletteTokens.micPlateLive)
    #expect(lit.dark >= 3 && lit.light >= 3, "\(lit)")
    for plate in [PaletteTokens.micPlate, PaletteTokens.micPlateLive] {
      let step = contrast(plate, on: PaletteTokens.composerRest)
      #expect(step.dark >= 1.2 && step.light >= 1.2, "\(plate): \(step)")
    }
  }

  @Test("switcher window: the row's digit key in `muted` holds 4.5:1 on the selection and on surface")
  func switcherDigitKey() {
    for plate in [PaletteTokens.switcherSelection, PaletteTokens.surface] {
      let ratio = contrast(PaletteTokens.muted, on: plate)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(plate): \(ratio)")
    }
  }

  /// The shortcut sheet: every ink on the ground it stands on — the panel on `surface`, the "You're here"
  /// section and the key caps outside it on `surface2`, the caps inside it on `surface`, the pill on `new`.
  @Test(
    "shortcut sheet: text ≥ 4.5:1 on its ground in both themes",
    arguments: [
      (PaletteTokens.text, PaletteTokens.surface), (PaletteTokens.muted, PaletteTokens.surface),
      (PaletteTokens.muted2, PaletteTokens.surface), (PaletteTokens.text, PaletteTokens.surface2),
      (PaletteTokens.muted2, PaletteTokens.surface2), (PaletteTokens.onState, PaletteTokens.new),
    ])
  func shortcutSheet(ink: PaletteTokens.Pair, ground: PaletteTokens.Pair) {
    let ratio = contrast(ink, on: ground)
    #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink) on \(ground): \(ratio)")
  }

  @Test("okno przełącznika sesji: wiersz pod wskaźnikiem — `muted2` i słowa stanów ≥ 4,5:1, płytka słabsza od zaznaczenia")
  func switcherHover() {
    let selection = PaletteTokens.switcherSelection
    let surface = PaletteTokens.surface
    // Płytka zaznaczenia w połowie krycia nad `surface`, jak zakładka i wiersz agenta pod kursorem.
    let hover = PaletteTokens.Pair(
      dark: PaletteTokens.over(selection.dark, alpha: HoverTokens.agentRowAlpha, on: surface.dark),
      light: PaletteTokens.over(selection.light, alpha: HoverTokens.agentRowAlpha, on: surface.light))
    // Tekst wiersza pod wskaźnikiem się nie zmienia: drugorzędny zostaje w `muted2`.
    let inks = [PaletteTokens.muted2, PaletteTokens.muted, PaletteTokens.wait, PaletteTokens.run, PaletteTokens.err,
                PaletteTokens.new]
    for ink in inks {
      let ratio = contrast(ink, on: hover)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ink): \(ratio)")
    }
    // Płytkę widać, ale zaznaczenie zostaje wyraźniejsze.
    let hoverStep = contrast(hover, on: surface)
    let selectionStep = contrast(selection, on: surface)
    #expect(hoverStep.dark > 1.04 && hoverStep.light > 1.04, "\(hoverStep)")
    #expect(hoverStep.dark < selectionStep.dark && hoverStep.light < selectionStep.light)
  }

  @Test("akcja główna i wiersze wznowienia: napis na atramencie ≥ 7:1; wygaszona i obrysy czytelne na tle formularza")
  func presentationButtons() {
    let label = contrast(PaletteTokens.background, on: PaletteTokens.text)
    #expect(label.dark >= 7 && label.light >= 7, "„Uruchom”, „Zatwierdź”: \(label)")
    // Wygaszona akcja główna to sam obrys z etykietą `muted2`: na `surface` (dymek modelu) i na tle arkusza
    // formularza (`systemGroupedBackground`: jasny #F2F2F7, ciemny w arkuszu #1C1C1E).
    let form = PaletteTokens.Pair(dark: 0x1C1C1E, light: 0xF2F2F7)
    for surface in [PaletteTokens.surface, form] {
      let ratio = contrast(PaletteTokens.muted2, on: surface)
      #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "wygaszona etykieta: \(ratio)")
    }
    // Wiersz formularza systemowego (jasny biały, ciemny #2C2C2E): „Wznów” i „Rozwidl” atramentem tekstu,
    // „Otwórz sesję” ciszej, ale dalej czytelnie.
    let row = PaletteTokens.Pair(dark: 0x2C2C2E, light: 0xFFFFFF)
    let ink = contrast(PaletteTokens.text, on: row)
    #expect(ink.dark >= 7 && ink.light >= 7, "obrys i glif w atramencie tekstu: \(ink)")
    let quiet = contrast(PaletteTokens.muted, on: row)
    #expect(quiet.dark >= 4.5 && quiet.light >= 4.5, "„Otwórz sesję” w `muted`: \(quiet)")
  }

  @Test("„Zatwierdź”: tekst na zieleni ≥ 4,5:1 w obu motywach")
  func onState() {
    let ratio = contrast(PaletteTokens.onState, on: PaletteTokens.run)
    #expect(ratio.dark >= 4.5 && ratio.light >= 4.5, "\(ratio)")
  }

  // MARK: „Zwiększ kontrast”

  /// Kreska `border` złożona na tle: biel w ciemnym, czerń w jasnym, w kryciu tokenu.
  private func line(_ alpha: (dark: Double, light: Double), on ground: PaletteTokens.Pair) -> PaletteTokens.Pair {
    PaletteTokens.Pair(
      dark: PaletteTokens.over(0xFFFFFF, alpha: alpha.dark, on: ground.dark),
      light: PaletteTokens.over(0x000000, alpha: alpha.light, on: ground.light))
  }

  @Test("„Zwiększ kontrast”: kreska, `muted2` i `done` mają do tła ŚCIŚLE wyższy kontrast niż zwykle, w obu motywach")
  func increasedContrastIsStronger() {
    for ground in [PaletteTokens.background, PaletteTokens.surface, PaletteTokens.surface2] {
      for (normal, high) in [
        (PaletteTokens.muted2, PaletteTokens.muted2High), (PaletteTokens.done, PaletteTokens.doneHigh),
      ] {
        let usual = contrast(normal, on: ground)
        let strong = contrast(high, on: ground)
        #expect(strong.dark > usual.dark && strong.light > usual.light, "\(high) na \(ground): \(strong) wobec \(usual)")
      }
      let usual = contrast(line(PaletteTokens.borderAlpha, on: ground), on: ground)
      let strong = contrast(line(PaletteTokens.borderAlphaHigh, on: ground), on: ground)
      #expect(strong.dark > usual.dark && strong.light > usual.light, "kreska na \(ground): \(strong) wobec \(usual)")
    }
    // Hierarchia zostaje: drugi stopień wyciszenia dalej ciszej niż `muted`, a kreska w spoczynku słabiej niż
    // kreska pod wskaźnikiem (`HoverTokens.outlineStroke`).
    let quiet = contrast(PaletteTokens.muted, on: PaletteTokens.background)
    let second = contrast(PaletteTokens.muted2High, on: PaletteTokens.background)
    #expect(second.dark < quiet.dark && second.light < quiet.light, "\(second) wobec `muted` \(quiet)")
    #expect(PaletteTokens.borderAlphaHigh.dark < HoverTokens.outlineStroke)
    #expect(PaletteTokens.borderAlphaHigh.light < HoverTokens.outlineStroke)
  }
}
