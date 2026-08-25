# Auth, Google, and AWS SES Setup

This app now has two account login paths on `/auth`:

1. Google login through Supabase OAuth.
2. Email OTP login through Supabase Auth OTP, delivered by AWS SES.

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
```

Add local development URLs only when testing locally:

```text
http://127.0.0.1:8091/**
http://localhost:8091/**
```

## AWS SES Secrets

Set these Supabase Edge Function secrets:

```bash
supabase secrets set AWS_REGION=ap-south-1 --project-ref bugwubrwvlqayxwcazfd
supabase secrets set AWS_ACCESS_KEY_ID=... --project-ref bugwubrwvlqayxwcazfd
supabase secrets set AWS_SECRET_ACCESS_KEY=... --project-ref bugwubrwvlqayxwcazfd
supabase secrets set AWS_SES_FROM_EMAIL='Cirkle <verify@cirkle.world>' --project-ref bugwubrwvlqayxwcazfd
supabase secrets set VERIFICATION_CODE_PEPPER=... --project-ref bugwubrwvlqayxwcazfd
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase for hosted Edge Functions.

The AWS IAM user should have permission for:

```text
ses:SendEmail
```

The sender/domain in `AWS_SES_FROM_EMAIL` must be verified in AWS SES. If the SES account is still in sandbox mode, recipient addresses must also be verified.

## Deploy

After Supabase CLI is authenticated to the project:

```bash
supabase db push --project-ref bugwubrwvlqayxwcazfd
supabase functions deploy request-login-otp verify-login-otp send-verification-email verify-iit-email --project-ref bugwubrwvlqayxwcazfd --use-api
```

`request-login-otp` and `verify-login-otp` are configured with `verify_jwt = false` because users are not authenticated yet.

`send-verification-email` and `verify-iit-email` remain `verify_jwt = true` because IIT verification happens after account login.
