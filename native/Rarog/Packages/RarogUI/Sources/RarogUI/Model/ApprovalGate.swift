/// Którędy wolno dać zgodę: WYŁĄCZNIE gestem. Klawisz nigdy — ani skrót, ani Spacja
/// czy Enter na przycisku z fokusem klawiatury (Full Keyboard Access), ani VO+Spacja. Odmowa nie ma
/// tego ograniczenia: kierunek „Odrzuć" jest bezpieczny, a Esc z fokusem w karcie znaczy właśnie to.
public enum ApprovalInput: Sendable, Equatable {
  /// Dotyk palcem albo klik wskaźnikiem (gładzik, mysz) — `onTapGesture`.
  case touchOrPointer
  /// Domyślna akcja dostępności. Tę samą drogę biorą dwukrotne stuknięcie VoiceOver (gest), VO+Spacja
  /// z klawiatury sprzętowej przy VoiceOverze i Spacja w Full Keyboard Access (klawisze) — system nie
  /// mówi, skąd przyszła.
  case accessibilityActivation
}

public enum ApprovalGate {
  /// `voiceOverRunning` = `UIAccessibility.isVoiceOverRunning`, `hardwareKeyboard` = podłączona
  /// klawiatura sprzętowa (`GCKeyboard.coalesced`), obie w chwili aktywacji.
  ///
  /// Akcja dostępności zatwierdza WYŁĄCZNIE pod VoiceOverem i bez klawiatury sprzętowej: wtedy jedyną
  /// drogą do niej jest gest (dwukrotne stuknięcie). Z klawiaturą VO+Spacja i stuknięcie dają tę samą
  /// akcję i nie da się ich wiarygodnie odróżnić, więc akcja nie zatwierdza (fail-closed). Bez
  /// VoiceOvera to Full Keyboard Access albo inne wejście klawiszowe — też nie. Koszt świadomy:
  /// VoiceOver z podłączoną klawiaturą, Sterowanie głosem i Switch Control zatwierdzają dotykiem bez
  /// czytnika albo w terminalu.
  public static func accepts(_ input: ApprovalInput, voiceOverRunning: Bool, hardwareKeyboard: Bool) -> Bool {
    switch input {
    case .touchOrPointer: true
    case .accessibilityActivation: voiceOverRunning && !hardwareKeyboard
    }
  }

  /// Zdanie dla czytnika, gdy akcja dostępności NIE zatwierdziła; `nil` = cisza (bez VoiceOvera nie ma
  /// komu mówić, a Spacja w Full Keyboard Access po prostu nic nie robi — jak na PWA).
  public static func refusalSpoken(_ input: ApprovalInput, voiceOverRunning: Bool, hardwareKeyboard: Bool) -> String? {
    guard input == .accessibilityActivation, voiceOverRunning, hardwareKeyboard else { return nil }
    return UICopy.approvalKeyboardSpoken
  }
}
