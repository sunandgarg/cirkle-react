# Auth, Google, ZeptoMail, Zavu, and AWS SES Setup

This app now has three account login paths on `/auth`:

1. Google login through Supabase OAuth.
2. Email OTP login through Supabase Auth OTP, delivered by Zoho ZeptoMail with
   Zavu and AWS SES available as fallbacks.
3. Email and password login, including a secure password-recovery link that
   returns to `/reset-password`.

After account login, `/iit-verify` collects basic details including optional phone number, then runs the separate IIT email/document verification gate.

## Supabase Google Provider

Enable Google in Supabase:

- Project: `bugwubrwvlqayxwcazfd`
- Supabase Dashboard -> Auth -> Sign In / Providers -> Google
- Add Google Client ID
- Add Google Client Secret

In Google Cloud Console, add this authorized redirect URI:

```text
https://bugwubrwvlqayxwcazfd.supabase.co/auth/v1/callback
```

In Supabase Auth URL Configuration, allow the production app URL:

```text
https://cirkle.pages.dev
https://cirkle.pages.dev/**
https://cirkle.pages.dev/iit-verify
https://cirkle.pages.dev/reset-password
```

Add the equivalent `https://cirkle.world/**` entry when the custom domain is
active. Password-recovery emails are sent by the `request-password-reset` Edge
Function through the same ZeptoMail-primary delivery chain.
Supabase Auth SMTP settings are only used by any remaining built-in Supabase
email flows.

Add local development URLs only when testing locally:

```text
http://127.0.0.1:8091/**
http://localhost:8091/**
```

## Transactional email providers

Zoho ZeptoMail is the primary transactional provider. Zavu and AWS SES can stay
configured as automatic fallbacks, so email delivery continues if ZeptoMail is
temporarily unavailable.
Set these Supabase Edge Function secrets:

```bash
supabase secrets set ZEPTOMAIL_API_KEY=... \
  EMAIL_PROVIDER_PRIMARY=zeptomail EMAIL_PROVIDER_FALLBACK=zavu,ses \
  --project-ref bugwubrwvlqayxwcazfd
```

The ZeptoMail token is server-only and must never use a `VITE_` prefix. The
sender must use the verified `cirkle.world` email domain and
`verify@cirkle.world` identity. If your ZeptoMail account uses a regional or
account-specific endpoint, also set `ZEPTOMAIL_API_URL`; otherwise the default
`https://api.zeptomail.com/v1.1/email` is used.

If you want to keep Zavu as the first fallback, also keep:

```bash
supabase secrets set ZAVU_API_KEY=... ZAVU_SENDER_ID=... \
  --project-ref bugwubrwvlqayxwcazfd
```

For the SES fallback provider, set:

Set these Supabase Edge Function secrets:

```bash
supabase secrets set AWS_REGION=ap-south-1 --project-ref bugwubrwvlqayxwcazfd
supabase secrets set AWS_ACCESS_KEY_ID=... --project-ref bugwubrwvlqayxwcazfd
supabase secrets set AWS_SECRET_ACCESS_KEY=... --project-ref bugwubrwvlqayxwcazfd
supabase secrets set VERIFICATION_CODE_PEPPER=... --project-ref bugwubrwvlqayxwcazfd
```

All transactional email functions use Cirkle's branded templates and
`verify@cirkle.world` sender identity. A personal Gmail identity is not used.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase for hosted Edge Functions.

The AWS IAM user should have permission for:

```text
ses:SendEmail
```

The `cirkle.world` domain must remain verified in every active provider. If the
SES account is still in sandbox mode, recipient addresses must also be verified;
that limitation applies only when the SES fallback is used.

## Deploy

After Supabase CLI is authenticated to the project:

```bash
supabase db push --project-ref bugwubrwvlqayxwcazfd
supabase functions deploy request-login-otp verify-login-otp request-password-reset send-verification-email verify-iit-email notify-verification-decision --project-ref bugwubrwvlqayxwcazfd --use-api
```

`request-login-otp`, `verify-login-otp`, and `request-password-reset` are
configured with `verify_jwt = false` because users are not authenticated yet.

`send-verification-email` and `verify-iit-email` remain `verify_jwt = true` because IIT verification happens after account login.
