/**
 * Stałe transportu iroh wspólne dla serwera i apki. Serwer przyjmuje połączenia QUIC z tym ALPN i każdy
 * strumień dwukierunkowy traktuje jak jedno połączenie HTTP/1.1 (`server/src/iroh/`).
 *
 * Bez zależności: moduł czytają kod serwera i testy.
 */

/** ALPN protokołu: HTTP/1.1 w strumieniu dwukierunkowym QUIC. Inny ALPN serwer odrzuca. */
export const IROH_ALPN = 'rarog-http/1';

/**
 * `Origin`, który apka wysyła w mutacjach po iroh. Domena `.invalid` (RFC 2606) nie rozwiązuje się nigdzie, więc
 * nie udaje żadnej strony WWW i nie zderza się z adresem z listy `Origin` serwera.
 */
export const IROH_ORIGIN = 'https://iroh.rarog.invalid';
