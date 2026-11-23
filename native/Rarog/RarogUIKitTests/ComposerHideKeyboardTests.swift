@testable import RarogUI
import UIKit
import XCTest

/// „Schowaj klawiaturę” w rzędzie kontrolek pola: zwinięcie klawiatury na iPhonie
/// jednym przyciskiem. Przycisk stoi na końcu lewej grupy, za spinaczem, i w spoczynku jest schowany; pokazuje
/// się tylko na iPhonie z fokusem w polu. Właściciel: wysyłka.
@MainActor
final class ComposerHideKeyboardTests: XCTestCase {
  func testShownOnlyOnPhoneWhileEditing() {
    XCTAssertTrue(ComposerView.showsHideKeyboard(idiom: .phone, editing: true), "iPhone z fokusem w polu")
    XCTAssertFalse(ComposerView.showsHideKeyboard(idiom: .phone, editing: false), "iPhone bez fokusu")
    XCTAssertFalse(ComposerView.showsHideKeyboard(idiom: .pad, editing: true), "iPad ma klawisz zwijania")
  }

  func testButtonHiddenAtRestAfterAttachAndAway() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 160))
    let button = try XCTUnwrap(Self.view(id: "composer.hideKeyboard", in: composer) as? UIButton, "przycisk w rzędzie")
    XCTAssertTrue(button.isHidden, "w spoczynku schowany")
    XCTAssertEqual(button.accessibilityLabel, UICopy.hideKeyboard, "etykieta czytnika")

    let bar = try XCTUnwrap(button.superview as? UIStackView, "rząd kontrolek")
    let attach = try XCTUnwrap(Self.view(id: "composer.attach", in: composer), "spinacz")
    let send = try XCTUnwrap(Self.view(id: "composer.send", in: composer), "„Wyślij”")
    let order = bar.arrangedSubviews
    let index = try XCTUnwrap(order.firstIndex(of: button))
    XCTAssertGreaterThan(index, try XCTUnwrap(order.firstIndex(of: attach)), "za spinaczem")
    XCTAssertLessThan(index, try XCTUnwrap(order.firstIndex(of: send)) - 1, "przed odstępem, z dala od „Wyślij”")
  }

  /// Schowany przycisk nie zostawia dziury w rzędzie (0 pt), pokazany ma 32 pt — bez konfliktu ograniczeń, który
  /// zrywał jedno z nich (sztywne 32 pt przeciw szerokości 0 schowanego elementu stosu).
  func testHiddenButtonCollapsesInRow() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 160))
    window.addSubview(composer)
    window.isHidden = false
    defer { window.isHidden = true }
    let button = try XCTUnwrap(Self.view(id: "composer.hideKeyboard", in: composer) as? UIButton)
    composer.layoutIfNeeded()
    XCTAssertEqual(button.frame.width, 0, "schowany: zero szerokości")
    button.isHidden = false
    composer.layoutIfNeeded()
    XCTAssertEqual(button.frame.width, 32, "pokazany: 32 pt")
    button.isHidden = true
    composer.layoutIfNeeded()
    XCTAssertEqual(button.frame.width, 0, "znów schowany: zero szerokości")
  }

  /// Fokus przed pierwszym układem ekranu (klawiatura sprzętowa: pole dostaje go już w `viewDidAppear`): przycisk
  /// staje bez animacji. Blok animacji kończył się układem całego okna, więc pierwszy układ ekranu szedł w animacji
  /// 0,2 s, a transkrypt dochodził do dna jej ścieżką (`TranscriptSettleTests` padał na symulatorze
  /// iPhone'a). Idiom iPhone'a z nadpisania cech: test pilnuje tego także na iPadzie bramki.
  func testFocusBeforeFirstLayoutShowsButtonWithoutAnimation() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
    let screen = LayoutProbe()
    let composer = ComposerView()
    composer.traitOverrides.userInterfaceIdiom = .phone
    composer.translatesAutoresizingMaskIntoConstraints = false
    screen.addSubview(composer)
    NSLayoutConstraint.activate([
      composer.leadingAnchor.constraint(equalTo: screen.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: screen.trailingAnchor),
      composer.bottomAnchor.constraint(equalTo: screen.bottomAnchor),
    ])
    let controller = UIViewController()
    controller.view = screen
    window.rootViewController = controller
    window.isHidden = false
    defer { window.isHidden = true }
    let button = try XCTUnwrap(Self.view(id: "composer.hideKeyboard", in: composer) as? UIButton)
    XCTAssertEqual(screen.layouts, [], "ekran jeszcze przed pierwszym układem")

    XCTAssertTrue(composer.textView.becomeFirstResponder(), "fokus w polu")
    XCTAssertFalse(button.isHidden, "przycisk pokazany razem z fokusem")
    window.layoutIfNeeded()
    XCTAssertFalse(screen.layouts.isEmpty, "ekran ułożony")
    XCTAssertEqual(screen.layouts.filter { $0 != 0 }, [], "pierwszy układ ekranu poza animacją przycisku")
    XCTAssertEqual(button.frame.width, 32, "pokazany: 32 pt")
  }

  /// Widok ekranu, który zapisuje czas animacji obejmującej każdy jego układ (0 = poza animacją).
  private final class LayoutProbe: UIView {
    var layouts: [TimeInterval] = []

    override func layoutSubviews() {
      super.layoutSubviews()
      layouts.append(UIView.inheritedAnimationDuration)
    }
  }

  private static func view(id: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == id { return root }
    for child in root.subviews {
      if let found = view(id: id, in: child) { return found }
    }
    return nil
  }
}
