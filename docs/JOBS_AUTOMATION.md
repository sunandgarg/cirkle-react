# Jobs publishing and AI-assisted scanning

Members can read published, unexpired jobs and verified members can apply.
Administrators can manage drafts and sources through the Node API.

The supported AI providers are OpenAI and Google Gemini. Configure their keys
only in the API environment; the Admin UI reads server status and offers only
providers that are actually configured.

The scanner validates administrator access, HTTPS source URLs, response sizes,
structured model output, and job fields. It does not claim live web discovery
when no reviewed discovery integration exists; that request returns an explicit
error instead of inventing vacancies. Imported jobs default to drafts.

Required runtime values:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

Use a scheduler outside the API process for recurring scans, monitor scan-run
records, and keep automatic publishing disabled until source quality has been
reviewed. See [DEPLOYMENT.md](./DEPLOYMENT.md).
