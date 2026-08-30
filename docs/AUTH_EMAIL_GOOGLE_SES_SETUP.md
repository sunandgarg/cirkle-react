# Auth, Google, Zavu, and AWS SES Setup

This app now has three account login paths on `/auth`:

1. Google login through Supabase OAuth.
2. Email OTP login through Supabase Auth OTP, delivered by Zavu with AWS SES
   available as a fallback.
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
Function through the same Amazon-SES-primary, Zavu-fallback delivery chain.
Supabase Auth SMTP settings are only used by any remaining built-in Supabase
email flows.

Add local development URLs only when testing locally:

```text
http://127.0.0.1:8091/**
http://localhost:8091/**
```

## Transactional email providers

AWS SES is the primary transactional provider. Zavu remains configured as a
fallback, so the application can switch providers without another code deploy.
Set these Supabase Edge Function secrets:

```bash
supabase secrets set ZAVU_API_KEY=... ZAVU_SENDER_ID=... \
  EMAIL_PROVIDER_PRIMARY=ses EMAIL_PROVIDER_FALLBACK=zavu \
  --project-ref bugwubrwvlqayxwcazfd
```

The Zavu key is server-only and must never use a `VITE_` prefix. The Zavu
sender must use the verified `cirkle.world` email domain and
`verify@cirkle.world` identity.

For the SES primary provider, set:

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

The `cirkle.world` domain must remain verified in both providers. If the SES
account is still in sandbox mode, recipient addresses must also be verified;
that limitation applies only when the fallback is used.

## Deploy

After Supabase CLI is authenticated to the project:

```bash
supabase db push --project-ref bugwubrwvlqayxwcazfd
supabase functions deploy request-login-otp verify-login-otp request-password-reset send-verification-email verify-iit-email notify-verification-decision --project-ref bugwubrwvlqayxwcazfd --use-api
```

`request-login-otp`, `verify-login-otp`, and `request-password-reset` are
configured with `verify_jwt = false` because users are not authenticated yet.

`send-verification-email` and `verify-iit-email` remain `verify_jwt = true` because IIT verification happens after account login.
