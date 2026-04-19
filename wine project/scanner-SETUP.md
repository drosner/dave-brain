# Wine Scanner — Setup Guide

A mobile web app hosted on the Pi. Open it on any phone on your network
(or via Tailscale) — no app store, no install.

Files:
  server.js    — Express web server
  package.json — dependencies
  index.html   — the full app (served by Express)

---

## STEP 1 — Copy files to Pi

```bash
# Create folder in your dave-brain scripts area or anywhere on the Pi
mkdir -p ~/wine-scanner
scp server.js package.json index.html pi@raspberrypi.local:~/wine-scanner/
```

---

## STEP 2 — Install dependencies

```bash
ssh pi@raspberrypi.local
cd ~/wine-scanner
npm install
```

---

## STEP 3 — Add environment variables

The server reads from environment variables. Add to your Pi's .env or
set them in the start command directly.

Add to ~/n8n/.env (or wherever your Pi env file lives):
```
OPENROUTER_API_KEY=sk-or-your-key
WINE_MCP_URL=https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp
WINE_MCP_KEY=your-mcp-access-key
```

---

## STEP 4 — Run the server

```bash
cd ~/wine-scanner

# One-time run
OPENROUTER_API_KEY=xxx WINE_MCP_URL=xxx WINE_MCP_KEY=xxx node server.js

# Or with .env file (if you have dotenv-cli installed)
dotenv -e ~/.env node server.js

# Or export vars first then run
export $(cat ~/n8n/.env | grep -v ^# | xargs)
node server.js
```

You should see:
  🍷 Wine Scanner running at http://0.0.0.0:3333
  Local:    http://localhost:3333
  Network:  http://<pi-ip>:3333

---

## STEP 5 — Run as a persistent service (so it survives reboots)

Create a systemd service:

```bash
sudo nano /etc/systemd/system/wine-scanner.service
```

Paste this (update paths and env vars):
```ini
[Unit]
Description=Wine Scanner Web App
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/wine-scanner
EnvironmentFile=/home/pi/n8n/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable wine-scanner
sudo systemctl start wine-scanner
sudo systemctl status wine-scanner
```

Now it starts automatically on boot.

---

## STEP 6 — Access the app

On your phone, open:
  http://raspberrypi.local:3333

Or via Tailscale (from anywhere):
  http://<tailscale-pi-ip>:3333

On iPhone: tap the Share button → Add to Home Screen
This gives you a home screen icon that opens the app full-screen,
with the camera working as a proper native-feel experience.

---

## Using the app

### SINGLE mode (default)
1. Point camera at a wine label or barcode
2. Tap the shutter button
3. Result panel slides up with:
   - Wine name and vintage
   - Location in your cellar (e.g. "Left Bottom")
   - Price paid
   - Drinking window
   - CT score
   - SommSelect narrative excerpt (if available)

### SHELF mode
1. Switch to SHELF in the top toggle
2. Frame a group of bottles — a rack, a shelf, or a case
3. Tap shutter
4. Price paid and location appear as floating labels
   superimposed over each identified bottle

### UPLOAD
Tap UPLOAD instead of the shutter to use a photo from your camera roll.
Useful for bottles where live camera doesn't work well.

---

## Troubleshooting

"Camera not available"
→ Browser needs HTTPS or localhost for camera access
→ On iPhone over local network: use http://raspberrypi.local:3333
  (not an IP address — mDNS hostname works for local camera permissions)
→ If still blocked: run the app via Tailscale HTTPS, or add a self-signed
  cert to the server

Server error 500 on scan
→ Check OPENROUTER_API_KEY is valid and has credits
→ Check WINE_MCP_URL and WINE_MCP_KEY match your deployed Edge Function

Bottles not found in SHELF mode
→ Make sure wine_inventory is populated (run the nightly n8n sync first)
→ Try better lighting — foil labels and dark bottles are hard for vision

"NOT IN CURRENT INVENTORY" in single mode
→ Wine was identified but not matched in your inventory
→ Could be a wine you consumed, or one not yet synced from CellarTracker
