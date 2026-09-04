# Jobs and events AI scanning

The Node API provides two deliberately separate scanner modes. Both require an
authenticated Cirkle `admin` or `owner`; no browser-visible key or legacy
dispatcher secret can authorize a scan.

## Explicit-source extraction

OpenAI and Google Gemini can extract records from public HTTPS pages supplied by
an administrator. The API fetches those pages itself, revalidates every HTTPS
redirect and DNS result, rejects private/non-text/oversized sources, and tells
the model to use only the supplied documents. Before either drafts or
auto-published records can reach the transaction, deterministic validation
requires the result to identify its fetched document, requires every returned
URL to occur in that document, matches each source timestamp to an exact
document excerpt, and requires one contiguous record excerpt tying the core
facts together. Factual text absent from that record evidence is rejected.
Model instructions alone are never treated as evidence. Gemini is intentionally
limited to this mode until its grounded-search response and citations are
integrated and tested to the same standard as OpenAI.

## Grounded OpenAI discovery

`action: "discover"` uses the OpenAI Responses API hosted `web_search` tool. It
forces a tool call, requests `web_search_call.action.sources`, and inspects URL
citation annotations. A discovered record is rejected unless:

- the web-search call completed;
- the provider returned source metadata and a URL citation;
- its official `source_url` exactly matches a cited provider source after safe
  canonicalization;
- its other external URLs were among the pages the provider consulted; and
- every URL passes the API's public-HTTPS and DNS checks.

This follows the official OpenAI documentation for
[web search and citations](https://developers.openai.com/api/docs/guides/tools-web-search)
and the installed SDK's Responses contract. Discovery is enabled only when
`OPENAI_API_KEY` exists and `OPENAI_MODEL` is in the server-reviewed
web-search-capable allowlist. The recommended configured model is
[`gpt-5.4-mini`](https://developers.openai.com/api/docs/models/gpt-5.4-mini);
its official model page lists Responses web search support.
Arbitrary model names sent by a browser are ignored for discovery.

Job discovery searches a fixed career/ATS domain allowlist and runs across these
exact seven experience buckets:

1. Internship
2. 0-1 years
3. 1-2 years
4. 2-3 years
5. 3-5 years
6. 5-7 years
7. 7+ years

Event discovery accepts exactly one of the 23 IITs known to the server and
restricts search to that institute's official domain. Results are drafts and
the Admin UI remains the publishing gate.

## Job freshness policy

Every AI-imported job, including explicit-source scans, must provide an explicit
source `published_at` timestamp. The API accepts only timestamps from the last
24 hours, including the exact 24-hour boundary, and permits at most five minutes
of future clock skew. Missing, inferred, invalid, stale, or further-future times
are rejected; scan time is never substituted for source freshness.

The source publication time is persisted as the imported job's `created_at`;
`discovered_at` records scan time, while `published_at` remains the time Cirkle
published the record (and is null for drafts). This preserves both provenance
and Cirkle publishing semantics without conflating the timestamps.

## Atomicity, deadlines, and audit data

Network and provider work is bounded by the scanner's 50-second total deadline,
including a 30-second provider limit and 12-second per-source limit. All accepted
records, the scan-run record, and its audit log are written in one Prisma
transaction. A validation, provider, deadline, or transaction failure commits no
partial scan.

Completed scans retain the provider, configured model, action, counts, requested
scope, and validated grounded URLs in `job_scan_runs` or `event_scan_runs`.
Provider keys and response bodies are never stored there.

Required API-only values:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

For recurring work, use an external scheduler that signs in through the normal
Node authentication flow and calls the scanner with an administrator JWT.
There is no `RECRUITER_SCAN_SECRET` compatibility path. Keep automatic
publishing disabled until the organization has reviewed its sources and output
quality. See [DEPLOYMENT.md](./DEPLOYMENT.md).
