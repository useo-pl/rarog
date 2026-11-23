@testable import RarogUI
import UIKit
import XCTest

/// Odbiorca klawiatury strony arkusza (`SheetKeyboardAnchor`): bierze klawiaturę po wejściu do okna, oddaje
/// ją poprzedniemu odbiorcy przy zejściu i nie odbiera jej temu, kto wziął ją w międzyczasie. Bieżącego
/// pierwszego respondenta test podaje sam (proces testów nie ma `UIApplication`).
@MainActor
final class SheetKeyboardAnchorTests: XCTestCase {
  private struct Harness {
    let window: UIWindow
    let field: UITextField
    let other: UITextField
    let anchor: SheetKeyboardAnchor.AnchorView
  }

  private func harness() -> Harness {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
    let root = UIViewController()
    window.rootViewController = root
    window.makeKeyAndVisible()
    let field = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
    let other = UITextField(frame: CGRect(x: 0, y: 60, width: 200, height: 40))
    root.view.addSubview(field)
    root.view.addSubview(other)
    let anchor = SheetKeyboardAnchor.AnchorView()
    anchor.currentResponder = { [weak window] in window.flatMap(Self.firstResponder) }
    addTeardownBlock { @MainActor in window.isHidden = true }
    return Harness(window: window, field: field, other: other, anchor: anchor)
  }

  private static func firstResponder(in view: UIView) -> UIResponder? {
    if view.isFirstResponder { return view }
    for subview in view.subviews {
      if let found = firstResponder(in: subview) { return found }
    }
    return nil
  }

  /// Kolejka główna zdążyła wykonać odłożone bloki kotwicy.
  private func settle() async {
    try? await Task.sleep(for: .milliseconds(80))
  }

  func testTakesKeyboardOnAppearAndReturnsItOnRemoval() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder(), "pole trzyma klawiaturę jak terminal pod arkuszem")
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    XCTAssertTrue(h.anchor.isFirstResponder, "strona bierze klawiaturę po pokazaniu")
    XCTAssertFalse(h.field.isFirstResponder, "poprzedni odbiorca nie dostaje liter")
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "po zejściu strony klawiatura wraca do poprzedniego odbiorcy")
  }

  /// Wyścig: kotwica trzymała klawiaturę, schodzi, a zanim wykona się odłożone
  /// przywrócenie, klawiaturę bierze inne pole — zostaje przy nim.
  func testDoesNotStealKeyboardFromResponderThatTookItMeanwhile() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    XCTAssertTrue(h.anchor.isFirstResponder)
    h.anchor.removeFromSuperview()
    XCTAssertTrue(h.other.becomeFirstResponder(), "inne pole bierze klawiaturę przed odłożonym blokiem")
    await settle()
    XCTAssertTrue(h.other.isFirstResponder, "nowy odbiorca zostaje")
    XCTAssertFalse(h.field.isFirstResponder)
  }

  /// Poprzedni odbiorca, który sam zszedł z ekranu, klawiatury nie dostaje.
  func testDoesNotReturnKeyboardToResponderThatLeftTheWindow() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    h.field.removeFromSuperview()
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertNil(Self.firstResponder(in: h.window), "nikt nie trzyma klawiatury")
  }

  /// Treść okna (tekst historii) bierze klawiaturę OD KOTWICY, a gdy okno schodzi razem z treścią, klawiatura
  /// wraca do tego, kto trzymał ją przed oknem. Komuś spoza okna treść jej nie zabiera.
  func testContentTakesKeyboardFromAnchorAndPreviousGetsItBack() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder(), "terminal pod oknem")
    XCTAssertFalse(
      SheetKeyboardAnchor.handKeyboard(to: h.other, from: h.field), "przed kotwicą treść nie zabiera klawiatury")
    XCTAssertTrue(h.field.isFirstResponder)
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    XCTAssertTrue(h.anchor.isFirstResponder)
    XCTAssertTrue(SheetKeyboardAnchor.handKeyboard(to: h.other, from: h.anchor), "treść bierze klawiaturę od kotwicy")
    XCTAssertTrue(h.other.isFirstResponder)
    // Okno schodzi: treść i kotwica razem.
    h.other.removeFromSuperview()
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "klawiatura wraca do odbiorcy sprzed okna")
  }

  /// Tekst historii sam prosi o klawiaturę po wejściu do okna z treścią: dostaje ją od kotwicy.
  func testHistoryTextTakesKeyboardFromAnchor() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    let text = HistoryTextView(frame: CGRect(x: 0, y: 120, width: 200, height: 80))
    text.isEditable = false
    text.currentResponder = { [weak window = h.window] in window.flatMap(Self.firstResponder) }
    text.text = "historia"
    h.window.rootViewController?.view.addSubview(text)
    await settle()
    XCTAssertTrue(text.isFirstResponder, "tekst trzyma klawiaturę: Cmd+A i Cmd+C działają bez dotykania")
    let empty = HistoryTextView(frame: .zero)
    empty.currentResponder = { [weak window = h.window] in window.flatMap(Self.firstResponder) }
    h.window.rootViewController?.view.addSubview(empty)
    await settle()
    XCTAssertFalse(empty.isFirstResponder, "pusty tekst klawiatury nie bierze")
  }

  /// A page anchor in a sheet's stack: the anchor of the page (`page`) and of the sheet's root (`root`), as SwiftUI
  /// moves them on a push (the page enters, then the root leaves the window) and a pop (the root returns, then the page
  /// leaves).
  private func pageAnchor(_ h: Harness) -> SheetKeyboardAnchor.AnchorView {
    let page = SheetKeyboardAnchor.AnchorView()
    page.currentResponder = { [weak window = h.window] in window.flatMap(Self.firstResponder) }
    return page
  }

  private func push(_ page: UIView, over root: UIView, in h: Harness) async {
    h.window.rootViewController?.view.addSubview(page)
    await settle()
    root.removeFromSuperview()
    await settle()
  }

  /// Push, pop, close: the root anchor must not remember the page anchor as the one to give the keyboard back to,
  /// or the field under the sheet stays without it after the sheet closes.
  func testKeyboardReturnsToFieldAfterPushPopAndClose() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder(), "the field under the sheet")
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    let page = pageAnchor(h)
    await push(page, over: h.anchor, in: h)
    XCTAssertTrue(page.isFirstResponder, "the page takes the keyboard")
    await push(h.anchor, over: page, in: h)
    XCTAssertTrue(h.anchor.isFirstResponder, "back on the root")
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the closed sheet gives the keyboard back to the field")
  }

  /// Push, close on the page (Esc, Cmd+W or a finished forget close the whole sheet from a page): the page anchor
  /// gives the keyboard back to the field the root anchor took it from.
  func testKeyboardReturnsToFieldWhenTheSheetClosesOnAPage() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    let page = pageAnchor(h)
    await push(page, over: h.anchor, in: h)
    XCTAssertTrue(page.isFirstResponder)
    page.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the closed sheet gives the keyboard back to the field")
  }

  /// A page without an anchor that takes the keyboard itself (the shortcut recorder) is pushed and popped: the page
  /// anchor coming back keeps the field under the sheet, not the recorder that leaves, so closing the sheet on that
  /// page still gives the keyboard back to the field.
  func testKeyboardReturnsToFieldAfterARecorderPageWithoutAnchor() async throws {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder(), "the field under the sheet")
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    let recorder = UITextField(frame: CGRect(x: 0, y: 120, width: 200, height: 40))
    h.window.rootViewController?.view.addSubview(recorder)
    XCTAssertTrue(recorder.becomeFirstResponder(), "the recorder takes the keyboard")
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertTrue(recorder.isFirstResponder)
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    recorder.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.anchor.isFirstResponder, "back on the page")
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the closed sheet gives the keyboard back to the field")
  }

  /// Strona bez poprzedniego odbiorcy (nikt nie trzymał klawiatury) też ją bierze — Esc ma dokąd pójść.
  func testTakesKeyboardWhenNobodyHeldIt() async throws {
    let h = harness()
    h.window.rootViewController?.view.addSubview(h.anchor)
    await settle()
    XCTAssertTrue(h.anchor.isFirstResponder)
    h.anchor.removeFromSuperview()
    await settle()
    XCTAssertNil(Self.firstResponder(in: h.window))
  }
}
