COMPLETED MIGRATIONS:
- 001: extended projects table (description, category, location, started_at, target_date, updated_at)
- 002: people table + project_people junction
- 003: todos table (standalone, optional project_id/person_id)
- 004: milestones table (standalone, optional project_id)
- 005: orders project_id FK added
- 006: 12 projects seeded from brain data

CURRENT SCHEMA (accurate):
- thoughts: core OB1 table, unchanged
- orders: full purchase tracking, project text + project_id FK
- projects: 12 active projects seeded (Ski House, Garbage Pi V2, Primary Home, Pool House, Pool House Sofa, RAS Workbench, Boiler Controller, Metal Shop Buildout, AI Scaffolding, Home Assistant, Flying, Wine Collection)
- people: empty, populate going forward
- todos: empty, populate going forward  
- milestones: empty, populate going forward
- Views: open_orders, recent_deliveries, project_spend

DATA STRATEGY:
- Thoughts (brain): project knowledge and context from Codex/ChatGPT migrations is already there and good. New project decisions and research captured going forward.
- Orders/todos/milestones/people: all start fresh from now. No legacy migration needed. Dropbox documents are a future ingestion effort.
- Gmail is source of truth for operational data (orders, shipping, tasks).

BUGS FIXED:
- people serialization bug in pull-gmail.ts fixed (contacts now flat strings)

CURRENT PRIORITIES:
1. Update AGENTS.md (in progress)
2. Fix Angel Flight East and other noise emails being ingested as thoughts in pull-gmail.ts
3. Set up n8n on VPS for always-on Gmail watch
4. Dropbox document ingestion (future)
5. Codex weekly project review skill

Keep the same structure and tone as the existing AGENTS.md. Show me the new version before writing it.