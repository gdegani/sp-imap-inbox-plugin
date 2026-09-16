# Test fixtures

`test-cert.pem` / `test-key.pem` — a self-signed certificate for `localhost`
used by `test/fake-imap-server.cjs`, so the integration tests exercise the real
TLS and STARTTLS paths instead of a plaintext stand-in.

It is a **test fixture, not a secret**: the key is deliberately committed, and
nothing outside these tests trusts it. Tests connect with `allowSelfSigned: true`
— the same switch Proton Bridge and self-hosted Dovecot users need — while one
test connects without it to prove certificate validation is on by default.

Generated with a 100-year lifetime so it never expires out from under CI:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test-key.pem -out test-cert.pem \
  -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
