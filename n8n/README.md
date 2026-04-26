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

## CellarTracker export runner

This repo now includes a basic Playwright runner for CellarTracker export under:

```text
scripts/playwright/
```

### Required env vars

Add these to the Pi `.env` file:

```env
CT_USER=your-cellartracker-login
CT_PASSWORD=your-cellartracker-password
PLAYWRIGHT_API_TOKEN=your-random-shared-secret
PLAYWRIGHT_RUNNER_PORT=3002
```

Security note:
- These credentials stay in `.env` only.
- Do not paste them into workflow JSON or commit them anywhere.

### Start the runner on the Pi

Preferred: run it through `docker compose` from the repo root so `n8n` can reach it at the Docker service hostname `playwright-runner`.

```bash
cd /home/drosner/dave-brain
docker compose build playwright-runner
docker compose up -d playwright-runner
```

If you want to run it directly during development instead:

```bash
cd /home/drosner/dave-brain/scripts/playwright
npm install
npx playwright install chromium
npm run start
```

### Test the runner directly

```bash
curl -sS http://127.0.0.1:3002/health
curl -sS -X POST http://127.0.0.1:3002/api/cellartracker/export \
  -H "x-api-key: $PLAYWRIGHT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"table":"Bottles","bottleState":"1","format":"csv","includeContent":true}'
```

Successful exports write CSV files into:

```text
/home/drosner/dave-brain/scripts/logs/cellartracker-exports/
```

Importable n8n workflow:

```text
n8n/CellarTracker Export Test.json
```

The nightly inventory workflow in this repo is also wired to call:

```text
http://playwright-runner:3002/api/cellartracker/export
```

That means the `n8n` and `playwright-runner` services need to be on the same Docker network when you run the Pi setup.
