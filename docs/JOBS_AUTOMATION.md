# Jobs publishing and career scanning

The Jobs module has two separate surfaces:

- Members can read published, unexpired jobs and verified members can apply.
- Administrators can create drafts, publish, unpublish, close, archive, delete, scan sources, and review scan history.

AI provider keys are server secrets. They must never be added to `VITE_*`, committed to Git, or entered in the browser.

## Deploy

Apply the database migration and deploy the Edge Function from a trusted machine:

```bash
supabase db push
supabase functions deploy scan-jobs
```

Set only the providers you intend to use:

```bash
supabase secrets set GEMINI_API_KEY=...
supabase secrets set OPENAI_API_KEY=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set CUSTOM_AI_API_KEY=... CUSTOM_AI_BASE_URL=https://provider.example/v1
```

The custom provider must expose an OpenAI-compatible `POST /chat/completions` endpoint.

## Admin workflow

1. Open **Admin → Jobs**.
2. Use **Add job** for a manual draft or immediate publish.
3. Use **Scan careers** for up to five public HTTPS company career pages or ATS JSON feeds.
4. Keep **Import as drafts** enabled for new sources. Review extracted jobs and publish only correct listings.
5. Save trusted sources to run them again later. Enable auto-publish only after repeated clean scans.

The scanner rejects private-network URLs, limits redirects, response sizes and run input, requires HTTPS application links, removes common tracking parameters, rejects expired listings, and deduplicates by canonical application URL. Every run records discovered, imported and skipped counts plus failures.

JavaScript-only career sites may return an empty HTML shell. Prefer the company's public ATS job-feed or JSON endpoint when available.

## Scheduled scans

Saved sources are designed for scheduled execution. Use Supabase Cron with Vault/pg_net to invoke `scan-jobs` once per source using this body:

```json
{ "source_id": "saved-source-uuid" }
```

Use the project's service-role JWT from Vault for the scheduled Authorization header. Do not put it in SQL source, frontend code, logs, or this repository. Keep scan frequency reasonable for each company's terms and robots policy.

## Safety defaults

- Imported jobs default to drafts.
- Only admins can mutate jobs or scanner configuration.
- Anonymous and signed-in users can read only published, unexpired jobs.
- Only verified users can apply.
- API keys are read only inside the Edge Function.
- The public feed refreshes after one minute and whenever the browser window regains focus.
