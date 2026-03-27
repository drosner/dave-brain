# Dave's Open Brain — Project Briefing

## What this is
Personal AI memory and project management system built on top of OB1 (Open Brain by Nate Jones).
This repo contains Dave's private extensions — schema migrations, ingestion scripts, and Claude Code skills.
OB1 MCP server is deployed separately to Supabase and treated as a read-only dependency.

## Who Dave is
Dave Rosner. Partner at Deloitte. IFR-rated pilot (Garmin GNS 650, ForeFlight). Serious woodworker/maker.
Wine collector (320 bottles, 5-tier system). Angel Flight East volunteer pilot.
Active projects: Ski House (Killington VT), Garbage Pi V2, Wine collection, AI Scaffolding, Aviation/Flying.

## Stack
- Supabase (Postgres + pgvector + Edge Functions) — hosted, not local
- Deno (ingestion scripts in /scripts)
- OpenRouter (embeddings: text-embedding-3-small, metadata: gpt-4o-mini)
- OB1 MCP server (deployed to Supabase, do not modify source)
- n8n (planned, self-hosted on VPS for Gmail watch and automation)

## Existing Supabase tables
- thoughts — core OB1 table (id, content, embedding, metadata jsonb, created_at, updated_at)
- orders — purchase tracking (id, item_description, vendor, order_number, status, tracking_*, project text, category, thought_id, metadata jsonb)
- projects — bare bones (id, name, status, budget, notes, metadata jsonb) — needs extension
- Views: open_orders, recent_deliveries, project_spend

## Repo structure
- /supabase/migrations/ — numbered SQL files, one per schema change, run in order
- /supabase/views/ — view definitions source-controlled here
- /scripts/ — Deno ingestion scripts (pull-gmail.ts, capture-orders.ts)
- /claude-skills/ — Claude Code skill .md files

## Rules
- NEVER commit .env, token.json, credentials.json, sync-log.json
- ALL schema changes go in /supabase/migrations/ as a numbered SQL file BEFORE running
- Scripts use --dry-run flag for safe testing before live runs
- Secrets live in Windows User environment variables, not in any file

## Current priorities
1. Extend projects table (add category, description, target_date, started_at, location)
2. Add people table (vendors, contractors, contacts)
3. Add todos table (standalone, optional project_id FK)
4. Add milestones table (standalone, optional project_id FK)
5. Add project_id UUID FK to orders (alongside existing project text field)
6. Fix [object Object] people serialization bug in pull-gmail.ts
