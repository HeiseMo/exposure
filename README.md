# Exposure

Private, percent-based portfolio activity feed.

The app is a PWA for a small friend group. Users post things like:

> Sold 2% of BLOOM. New exposure: 1.5%.

The VPS stores encrypted event blobs only. Decryption happens in the browser with the shared group passphrase.

## What is private?

- Absolute money amounts are never requested.
- Signals are encrypted client-side with AES-GCM.
- The server stores group IDs, event IDs, timestamps, and encrypted blobs.
- Anyone with the VPS data and no passphrase should not be able to read assets, notes, actions, or percentages.

This is not a perfect anonymity system. Percentages can still reveal conviction and can leak information if someone already knows parts of your portfolio.

## Local development

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000
```

## VPS deployment

1. Copy the folder to your VPS.

```bash
scp -r exposure-pwa-vps user@your-vps:/opt/exposure
```

2. SSH into the VPS.

```bash
ssh user@your-vps
cd /opt/exposure
```

3. Start it.

```bash
docker compose up -d --build
```

4. Put HTTPS in front of it.

Recommended: use Caddy or Nginx Proxy Manager. The included `Caddyfile` is a minimal example.

For a single-container quick test without HTTPS:

```bash
docker compose up -d --build
```

Then visit:

```text
http://YOUR_VPS_IP:3000
```

For iOS/Android PWA installability and microphone permission, use HTTPS.

## Caddy production example

Create a Docker network:

```bash
docker network create web
```

Attach Exposure and Caddy to that network, or adapt your existing reverse proxy.

Example external Caddy compose:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - web

networks:
  web:
    external: true

volumes:
  caddy-data:
  caddy-config:
```

And set your Exposure service to the same `web` network.

## Usage

1. Open the app.
2. Set a group name, for example `hermit-deniz`.
3. Set the same shared passphrase on each phone.
4. Post a signal.
5. Press **Sync**.

## Next improvements

- Invite links that prefill the group name.
- Optional PIN/biometric lock on device.
- Better natural-language parsing.
- Reactions/comments.
- User-level keypairs instead of one shared passphrase.
- Replace JSON file storage with SQLite if the group grows.
