# Disc Golf Scorecard

Track a round with your friends — one phone each, everybody enters their own
score, live standings update for everyone.

No npm dependencies. Plain Node.js backend, HTML/CSS/JS frontend.

---

## Run it locally

```bash
npm start
```

The server prints the address to open on your phone:

```
  On this computer:  http://localhost:3000
  On your phone:     http://192.168.0.42:3000
```

Phones must be on the same Wi-Fi.

---

## Run it on your own server

The container serves plain HTTP on one port. Your existing nginx handles the
domain and the TLS certificate.

```bash
cp .env.example .env       # optional, to change the port
docker compose up -d
```

By default the port is published on `127.0.0.1` only, so the app is not
reachable from the internet directly — nginx is the only way in. Check it came
up:

```bash
curl -s localhost:3000/api/rounds
```

### nginx site config

Nothing special is required. A plain proxy block works:

```nginx
server {
    listen 443 ssl;
    server_name discgolf.example.com;

    # your existing ssl_certificate / ssl_certificate_key lines

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`.

### Why the live scores survive a default nginx

The live-score channel is a Server-Sent Events stream at
`/api/rounds/<id>/events` that stays open for the whole round. Normally that
needs proxy tuning; here the server already emits the headers that make nginx
do the right thing on its own:

- `X-Accel-Buffering: no` — nginx drops response buffering for that stream, so
  scores are forwarded the moment they are written instead of being held back.
- `Cache-Control: no-transform` — nginx skips gzip for that response, even if
  you have a broad `gzip_types` set globally.
- A `: ping` comment every 25s keeps traffic flowing, so nginx's 60s default
  `proxy_read_timeout` never fires on an idle round.

Verified against nginx with `gzip on; gzip_types *;` and no SSE tuning at all:
a score posted by one phone reached another in **33 ms**, and an idle stream
stayed open past 75s.

You only need to intervene if your existing config overrides those defaults —
specifically a global `proxy_read_timeout` under 25s, or
`proxy_ignore_headers X-Accel-Buffering`. In that case add a dedicated block:

```nginx
    location /api/rounds/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        gzip off;
        proxy_read_timeout 1h;
    }
```

**Use HTTPS if the server is reachable from the internet.** Two features need a
secure context and silently degrade over plain HTTP on a public domain:

| Feature | On HTTPS | On plain HTTP |
|---|---|---|
| "Share link" button | Opens the native share sheet | Falls back to copy |
| "Copy link" button | Copies silently | Shows a prompt to copy manually |
| Add to Home Screen | Works | Not offered |

(`http://localhost` counts as secure, so local development is unaffected.)

---

## Everyday commands

```bash
docker compose logs -f app        # follow the logs
docker compose restart app        # restart
docker compose down               # stop (rounds are kept)
docker compose up -d --build      # update after changing the code
```

## Backup and restore

Rounds live in the `discgolf-data` volume as a single JSON file.

```bash
# backup
docker compose exec app cat /app/data/rounds.json > rounds-backup.json

# restore
docker compose down
docker compose up -d
cat rounds-backup.json | docker compose exec -T app sh -c 'cat > /app/data/rounds.json'
docker compose restart app
```

To keep the data as a normal folder on the host instead of a Docker volume,
replace the volume line in `docker-compose.yml`:

```yaml
    volumes:
      - ./data:/app/data          # instead of discgolf-data:/app/data
```

then `mkdir -p data && sudo chown 1000:1000 data` (the container runs as uid 1000).

---

## Who can reach it

There is **no login**. Anyone who can open the URL can see every round, join an
active one, and delete rounds. That is fine on a home network; think twice
before putting it on a public domain.

To require a password, add HTTP basic auth in nginx:

```bash
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd discgolf
```

then inside the `server { }` block:

```nginx
    auth_basic           "Disc Golf";
    auth_basic_user_file /etc/nginx/.htpasswd;
```

Everyone joining will need the same login.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `3000` | Port published on the host, for nginx to proxy to |
| `BIND` | `127.0.0.1` | Interface to publish on; `0.0.0.0` to also reach it over the LAN |
| `TZ` | `Europe/Stockholm` | Timezone for round timestamps |
| `PORT` | `3000` | Port inside the container |

---

## Project layout

```
server.js                 API, live sync, scoring, JSON persistence
public/index.html         app shell
public/app.js             all frontend logic
public/style.css          styles
public/manifest.webmanifest, icon.svg
Dockerfile
docker-compose.yml        single app service, published on one host port
data/rounds.json          created at runtime
```
