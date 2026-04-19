# Wine Scanner

Small browser-based iPhone scanner app for the wine brain.

## Files

- `server.js`: Express server and scan API
- `index.html`: mobile web UI
- `package.json`: app dependencies and scripts
- `.env.example`: required environment variables
- `wine-scanner.service`: systemd unit template for the Pi

## Environment

For now this app should read from the shared Pi env file at `~/n8n/.env`.

Required variables:

```env
OPENROUTER_API_KEY=...
WINE_MCP_URL=https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp
```

This version assumes the current scanner design does not use a separate MCP bearer key.

## Local run

```bash
npm install
npm start
```

## Pi deploy

Deploy this directory into the Pi repo at `/home/drosner/dave-brain/wine-scanner`.

Example:

```bash
scp -r wine-scanner drosner@192.168.0.215:/home/drosner/dave-brain/
```

Then on the Pi:

```bash
cd ~/dave-brain/wine-scanner
npm install
source ~/.nvm/nvm.sh
export $(cat ~/n8n/.env | grep -v ^# | xargs)
node server.js
```

Phone URL:

```text
http://raspberrypi.local:3333
```

## systemd

Use the included `wine-scanner.service` as the template for `/etc/systemd/system/wine-scanner.service`.
