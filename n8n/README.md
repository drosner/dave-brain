# n8n Playwright Setup

This directory contains the Pi-side `n8n` setup for browser automation.

## What this adds

- The official `n8n` container, unchanged
- A separate `playwright-runner` service with Chromium and `playwright-core`
- A sample SommSelect login test endpoint
- An importable n8n workflow that calls the runner over Docker-internal HTTP

## Required env vars

Add these to `n8n/.env` on the Pi:

```env
SS_EMAIL=your-sommselect-login-email
SS_PASSWORD=your-sommselect-password
PLAYWRIGHT_API_TOKEN=your-random-shared-secret
```

Everything else should stay in the existing `.env`.

## Deploy on the Pi

From the `~/n8n` directory:

```bash
docker compose build
docker compose up -d
curl -sS http://127.0.0.1:3001/health
curl -sS -X POST http://127.0.0.1:3001/api/sommselect/login-test \
  -H "x-api-key: $PLAYWRIGHT_API_TOKEN"
```

## Output artifacts

Successful or failed login attempts write artifacts into:

```text
~/n8n/playwright-output/
```

You should see:

- `sommselect-login-test.png`
- `sommselect-storage-state.json` on successful login
