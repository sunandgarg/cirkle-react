# Authentication and email setup

This document describes the current Node/MySQL implementation. Historical
Supabase, Brevo, Zavu, and SES instructions were removed during the migration.

Supported sign-in paths are email/password, email OTP through Zoho ZeptoMail,
and Google OpenID Connect. Password-reset tokens are single-use and are claimed
atomically only when the new password is submitted. Google OAuth state is bound
to a host-only, HttpOnly, SameSite cookie.

Configure the server-only values in `/etc/cirkle/api.env`:

```dotenv
ZEPTOMAIL_TOKEN=
ZEPTOMAIL_FROM_EMAIL=verify@cirkle.world
ZEPTOMAIL_FROM_NAME=Cirkle
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://api.cirkle.world/api/auth/google/callback
```

Register that exact callback in Google Cloud. Verify the sending domain and
sender in ZeptoMail, then publish the provider's current SPF/DKIM records and a
DMARC policy. Never expose these values through a `VITE_` variable.

Before launch, test password login, email OTP, password reset, Google login from
both apex and `www`, logout, token refresh in two tabs, and expired/replayed
tokens. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete release gate.
