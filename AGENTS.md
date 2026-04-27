# AGENTS.md — dave-brain

## Purpose
Personal automation system. All scripts execute on Raspberry Pi 5 (brain.local / 192.168.0.215).
Orchestrated by n8n (brain.local:5678). Data stored in Supabase via two MCP servers.
End user to be used for execution is drosner

## Language Rules
- Existing scripts: Deno + TypeScript (pull-gmail.ts, capture-orders.ts)
- Playwright scripts (scripts/playwright/): Node.js + TypeScript, tsx runner
- Never use Bun — incompatible with Playwright

## Core Architecture Principle — MCP as Interface Layer
Scripts NEVER write to Supabase directly. All data access goes through MCP tool calls.
- General data (thoughts, todos, orders, projects) → Open Brain MCP
- Wine data (bottles, preferences, reactions) → Wine Brain MCP
- Only the MCP edge functions hold SUPABASE_SERVICE_ROLE_KEY
- Scripts only need OPEN_BRAIN_MCP_KEY and/or WINE_BRAIN_MCP_KEY

## MCP Endpoints
- Open Brain: https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/open-brain-mcp
- Wine Brain: https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp
- Shared MCP client: scripts/utils/mcp-client.ts — always use this, never inline fetch

## Security — Non-Negotiable
- Never commit: .env, credentials.json, token.json, .auth/*, scripts/logs/*
- No API keys or credentials in source code — always process.env
- Scripts use only MCP keys, never SUPABASE_SERVICE_ROLE_KEY

## Code Style Reference
- Read scripts/pull-gmail.ts for all style, error handling, and .env loading conventions
- Read scripts/utils/ before writing any new script — reuse shared utilities
- All scripts output final JSON status to stdout (n8n captures this)
- All scripts append status entry to scripts/logs/automation-status.json

## Supabase Edge Function Deployment
CLI works: `supabase functions deploy <function-name> --project-ref zujvqteqcusephuwuqhe`
CLI is already authenticated and linked. Docker does not need to be running.

## Key Pi Paths
- scripts/ — Deno scripts
- scripts/playwright/ — Node.js Playwright scripts
- scripts/utils/ — shared TypeScript utilities (both Deno and Node compatible)
- scripts/logs/ — log files (gitignored)
- scripts/.auth/ — saved browser sessions (gitignored)
- /home/drosner/dave-brain/.env — all secrets (gitignored)
