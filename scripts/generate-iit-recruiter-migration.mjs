import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const rows = JSON.parse(await readFile(join(root, "scripts/data/iit-recruiters.json"), "utf8"));
const catalog = JSON.parse(await readFile(join(root, "public/company-catalog.json"), "utf8"));
const normalize = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ").replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
const quote = (value) => value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const catalogByName = new Map(catalog.map((company) => [normalize(company.name), company]));

const values = rows.map((row) => {
  const name = row["Company / Recruiter Group"];
  const company = catalogByName.get(normalize(name));
  return `(${[
    quote(name), quote(row["Published Name Variants"]), quote(row["Direct Career / Recruitment Page"]),
    quote(row["Link Status"]), Number(row["IIT Count"]) || 0, quote(row["IIT Sources Seen"]),
    quote(row["Fallback Official-Career Search"]), quote(row["IIT Recruiter Evidence URLs"]),
    quote(company?.logo || "/company-logos/company-placeholder.webp"), quote(company?.logoStatus || (company ? "catalog-match" : "placeholder-pending-official-source")),
  ].join(", ")})`;
}).join(",\n");

const sql = `-- Normalized from iit_recruiter_career_pages.xlsx. Missing official career URLs are deliberately retained as unresolved.
create table if not exists public.iit_recruiters (
  id uuid primary key default gen_random_uuid(),
  company text not null unique,
  published_name_variants text,
  career_url text,
  link_status text not null,
  iit_count integer not null default 0,
  iit_sources_seen text,
  fallback_search_url text,
  evidence_urls text,
  logo_url text not null,
  logo_status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint iit_recruiters_career_https check (career_url is null or career_url ~ '^https://'),
  constraint iit_recruiters_logo_webp check (logo_url ~ '\\.webp$')
);

insert into public.iit_recruiters (
  company, published_name_variants, career_url, link_status, iit_count, iit_sources_seen,
  fallback_search_url, evidence_urls, logo_url, logo_status
) values
${values}
on conflict (company) do update set
  published_name_variants = excluded.published_name_variants,
  career_url = excluded.career_url,
  link_status = excluded.link_status,
  iit_count = excluded.iit_count,
  iit_sources_seen = excluded.iit_sources_seen,
  fallback_search_url = excluded.fallback_search_url,
  evidence_urls = excluded.evidence_urls,
  logo_url = excluded.logo_url,
  logo_status = excluded.logo_status,
  updated_at = now();

create index if not exists iit_recruiters_career_idx on public.iit_recruiters (career_url) where career_url is not null;
create index if not exists iit_recruiters_iit_count_idx on public.iit_recruiters (iit_count desc, company);
alter table public.iit_recruiters enable row level security;
drop policy if exists iit_recruiters_public_read on public.iit_recruiters;
create policy iit_recruiters_public_read on public.iit_recruiters for select to anon, authenticated using (true);
grant select on public.iit_recruiters to anon, authenticated;
grant all on public.iit_recruiters to service_role;
`;

await writeFile(join(root, "supabase/migrations/20260903000000_iit_recruiter_catalog.sql"), sql);
console.log(`Generated ${rows.length} recruiter rows.`);
