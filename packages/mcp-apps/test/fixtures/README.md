The CDN certificate and key are public, synthetic test fixtures. They are not
credentials and are never installed into a system trust store. The desktop test
uses an owned HTTPS server and browser-process-only hostname mapping for the two
example.test origins, with TLS validation relaxed only in that isolated browser
context. Actual network-server hits prove CSP allow/deny behavior; Playwright
request interception is not treated as proof of an external request.
