-- StudyTheGame v2.1 — cache schema
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- No RLS: the server is the only reader/writer and talks to PostgREST with
-- the secret key. Nothing in this schema is ever touched by a browser.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- niches
create table if not exists niches (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,        -- canonical, normalized
  created_at        timestamptz not null default now(),
  last_refreshed_at timestamptz,
  hit_count         integer not null default 0
);

-- ---------------------------------------------------------------- aliases
-- Permanent memo of resolved synonyms: "gym" -> the "workout" niche.
-- A term resolved once never costs a model call again.
create table if not exists aliases (
  alias_slug text primary key,
  niche_id   uuid not null references niches(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- reels
create table if not exists reels (
  id         uuid primary key default gen_random_uuid(),
  niche_id   uuid not null references niches(id) on delete cascade,
  short_code text not null,
  payload    jsonb not null,        -- full normalized Apify item
  score      double precision,
  keep       boolean,
  confidence double precision,
  reason     text,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (niche_id, short_code)
);

-- ---------------------------------------------------------------- breakdowns
-- Keyed by short_code GLOBALLY — deliberately not per niche, and deliberately
-- not a column on reels. The same reel surfaces under several niches (a gym
-- reel appears under both "gym" and "workout") and Opus takes ~13s per
-- analysis. Global keying means each reel is analyzed once ever, and every
-- niche that surfaces it renders instantly.
--
-- It is also immune to the weekly refresh, which cannot disturb a table it
-- does not own.
create table if not exists breakdowns (
  short_code text primary key,
  payload    jsonb not null,        -- { hook_read, mechanism, format, steal_this, image_used }
  model      text,                  -- provenance: which model produced it
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- syntheses
-- The paid artifact: one pattern-read across a whole niche.
create table if not exists syntheses (
  niche_id   uuid primary key references niches(id) on delete cascade,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- indexes
create index if not exists reels_niche_active
  on reels (niche_id) where archived = false;

create index if not exists niches_popular
  on niches (hit_count desc);

-- Feeds the "or explore" chips: most-hit niches that actually have data.
create index if not exists niches_refreshed
  on niches (last_refreshed_at desc nulls last);

-- ---------------------------------------------------------------- rpc
-- Atomic hit counter. Done as a function so concurrent serves of the same
-- niche can't clobber each other with a read-modify-write.
create or replace function increment_hit(n_id uuid)
returns void
language sql
as $$
  update niches set hit_count = hit_count + 1 where id = n_id;
$$;
