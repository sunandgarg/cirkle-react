# Authentication, Google, and ZeptoMail setup

This document describes the current Node/MySQL implementation. Historical
Supabase, Brevo, Zavu, and SES providers are not runtime fallbacks: transactional
mail has one explicit provider, Zoho ZeptoMail.

Supported sign-in paths are email/password, email OTP through Zoho ZeptoMail,
and Google OpenID Connect. Password-reset tokens are single-use and are claimed
atomically only when the new password is submitted. Google OAuth state is bound
to a host-only, HttpOnly, SameSite cookie.

Configure the server-only values in `/etc/cirkle/api.env`:

```dotenv
ZEPTOMAIL_TOKEN=
ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email
ZEPTOMAIL_FROM_EMAIL=noreply@cirkle.world
ZEPTOMAIL_FROM_NAME=Cirkle
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://api-react.cirkle.world/api/auth/google/callback
```

`ZEPTOMAIL_TOKEN` is the Agent's Send Mail API key. The service accepts either
the raw key or the value prefixed with ZeptoMail's authorization scheme, but the
key must remain only in the protected API-host environment file. Do not commit
it, add it to a `VITE_` variable, print it, or reuse a key that has been exposed.
The Node service uses ZeptoMail's REST API; the SMTP username, password, and
ports are intentionally not configured.

The India account uses the `api.zeptomail.in` regional endpoint shown above.
Production configuration allows only ZeptoMail's documented HTTPS regional
hosts and the exact `/v1.1/email` path. Verify `cirkle.world` and
`noreply@cirkle.world` in the same Agent, configure its bounce subdomain, and
publish the current SPF, DKIM, and DMARC records before enabling live mail.

Active templates live under `server/src/services/`, provide both responsive
HTML and plain text, escape dynamic content, disable open/click tracking for
account-security messages, and embed the existing `public/cirkle-logo.png`
asset as a CID image. If that file cannot be read in a release, the service logs
a warning and uses the absolute `https://cirkle.world/cirkle-logo.png` asset.

An HTTP 2xx response means ZeptoMail accepted the API request; it does not prove
inbox delivery. The current application does not yet ingest ZeptoMail delivery,
soft-bounce, hard-bounce, or feedback-loop webhooks. Configure and authenticate
those webhooks in ZeptoMail before delivery status is presented in-product.
Until that receiver and persistence model exist, use the Agent's processed-email
logs to verify delivery. The service intentionally does not retry ambiguous
network timeouts because the first request may already have been accepted.

Email challenges are stored before the provider request. When ZeptoMail rejects
or fails the send, the challenge is immediately marked consumed so it cannot be
verified while its issuance still counts toward the destination/IP rate limit.
Ambiguous network timeouts are not retried because the provider may already
have accepted the message; the member can request a fresh challenge within the
normal bounded rate-limit policy.

Register the exact Google callback above in Google Cloud. Before launch, use a
ZeptoMail sandbox Agent, then a rotated production Send Mail key, and verify at
least one real message for every template with remote images disabled as well
as enabled.

Test password login, email OTP, institute OTP, password reset, document approval
and rejection, Google login from both apex and `www`, logout, token refresh in
two tabs, and expired/replayed tokens. See [DEPLOYMENT.md](./DEPLOYMENT.md) for
the complete release gate.
