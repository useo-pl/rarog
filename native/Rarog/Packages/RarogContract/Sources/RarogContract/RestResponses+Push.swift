// Odpowiedź statusu tokenu APNs — lustro `apnsStatusResponseSchema` z
// `shared/src/rest.ts`. Ta sama tolerancja co reszta REST: nieznane klucze odcięte, `null` tylko
// tam, gdzie kontrakt go zna. Złote odpowiedzi: `shared/fixtures/rest/push.apns.status*.json`.

/// Przyczyna degradacji tokenu, którą serwer umie nazwać (przekaźnik push) — `APNS_DEGRADED_REASONS`
/// z `shared/src/rest.ts`.
public enum ApnsDegradedReason: String, ContractEnum {
  /// Serwer nie ma czym wysłać do tego tokenu: brak ważnej przepustki przekaźnika i brak klucza APNs na Macu
  /// (zamówienie przepustki padło albo czeka na ponowienie; serwer ponawia sam).
  case passMissing = "pass-missing"
  /// Przekaźnik odmówił przepustki: Apple nie zna tokenu w zgłoszonym środowisku (build apki ma inne
  /// `aps-environment`, niż zgłasza).
  case envMismatch = "env-mismatch"
}

/// `POST /api/push/apns/status` (200) — stan kanału APNs dla JEDNEGO tokenu urządzenia.
///
/// `enabled` = serwer ma kanał APNs; `registered` = zna ten token; `alerts` = zapisany stan zgody
/// tego wpisu; `degradedSince` = od kiedy dostawy do tego tokenu nie dochodzą (ISO), `nil` =
/// zdrowy. Pole jest wymagane (`null` to wartość „zdrowy"), brak pola odrzuca odpowiedź.
public struct ApnsStatus: Sendable, Equatable, Decodable {
  public var enabled: Bool
  public var registered: Bool
  public var alerts: Bool
  public var degradedSince: String?
  /// Przyczyna degradacji (pole addytywne; serwer wysyła je tylko razem z `degradedSince`). `nil` = przyczyna
  /// ogólna albo zdrowy token: tak samo brak pola (starszy serwer), `null` i wartość, której ta wersja apki
  /// nie zna (nowszy serwer) — zdanie wraca wtedy do ogólnego banera. Zły typ odrzuca odpowiedź jak w każdym
  /// polu REST.
  public var degradedReason: ApnsDegradedReason?

  enum CodingKeys: String, CodingKey { case enabled, registered, alerts, degradedSince, degradedReason }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    enabled = try c.required(.enabled)
    registered = try c.required(.registered)
    alerts = try c.required(.alerts)
    degradedSince = try c.nullable(.degradedSince)
    let reason: String? = try c.optionalOrNull(.degradedReason)
    degradedReason = reason.flatMap(ApnsDegradedReason.wire)
  }
}
