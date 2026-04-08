# ScreenTinker

Open-source digital signage management software. Control content on TVs, displays, and kiosks from anywhere.

**Hosted version:** [screentinker.com](https://screentinker.com) — free tier available, no credit card required.

## Features

- **Multi-zone layouts** — split screens into zones with drag-and-drop editor
- **Video walls** — combine multiple displays into one screen with bezel compensation
- **Remote control** — live view, key input, power on/off
- **Scheduling** — visual weekly calendar with recurrence rules
- **Content designer** — clocks, weather, RSS tickers, countdowns, QR codes
- **Kiosk mode** — interactive touchscreen interfaces
- **Proof-of-play** — analytics and CSV export for ad verification
- **Alerts** — email notifications when devices go offline
- **Teams** — multi-user with owner, editor, and viewer roles
- **White-label** — custom branding, colors, logo, domain
- **Built-in billing** — Stripe integration for SaaS subscriptions (optional)
- **Auto-update** — OTA updates pushed to devices automatically

## Supported Platforms

Android TV, Fire TV, Raspberry Pi, Windows, ChromeOS, LG webOS, Samsung Tizen, and any device with a web browser.

## Self-Hosting

### Requirements

- Node.js 20+
- Linux, macOS, or Windows

### Quick Start

```bash
git clone https://github.com/screentinker/screentinker.git
cd screentinker/server
npm install
SELF_HOSTED=true node server.js
```

The server starts on port 3001. Open `http://localhost:3001` in your browser. The first registered user gets full access with all features unlocked.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3001` |
| `SELF_HOSTED` | First user gets all features unlocked | `false` |
| `APP_URL` | Your public URL (used for Stripe callbacks) | _(none)_ |
| `JWT_SECRET` | JWT signing key (auto-generated if not set) | _(auto)_ |
| `SSL_CERT` | Path to SSL certificate | `server/certs/cert.pem` |
| `SSL_KEY` | Path to SSL private key | `server/certs/key.pem` |

### Optional Integrations

All integrations are optional. The app works fully without any of them.

#### Stripe (Billing)

If you want to charge your users, plug in your own Stripe keys. Without them, all features are free for all users.

1. Create a [Stripe account](https://stripe.com)
2. Create products/prices for each plan in the Stripe dashboard
3. Set up a webhook endpoint pointing to `https://yourdomain.com/api/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Update the `plans` table in the SQLite DB with your Stripe price IDs:
   ```sql
   UPDATE plans SET stripe_price_monthly = 'price_xxx', stripe_price_yearly = 'price_yyy' WHERE id = 'starter';
   ```
5. Set the environment variables:

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) |
| `APP_URL` | Your public URL (e.g. `https://signage.yourcompany.com`) |

The default plans are: Free (1 device), Starter ($39/mo, 5 devices), Pro ($99/mo, 15 devices), Business ($199/mo, 50 devices), and Custom (unlimited). Edit the `plans` table to change pricing, limits, or add/remove tiers.

#### Google OAuth

Let users sign in with Google.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Google Identity API
3. Create OAuth 2.0 credentials (web application)
4. Add `https://yourdomain.com` as an authorized origin

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Your Google OAuth client ID |

#### Microsoft OAuth

Let users sign in with Microsoft/Azure AD.

1. Register an app in [Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps)
2. Add a web redirect URI: `https://yourdomain.com`
3. Note the Application (client) ID

| Variable | Description |
|----------|-------------|
| `MICROSOFT_CLIENT_ID` | Your Azure AD application client ID |
| `MICROSOFT_TENANT_ID` | Tenant ID (`common` for multi-tenant) |

#### Email Alerts

Send email notifications when devices go offline.

| Variable | Description |
|----------|-------------|
| `EMAIL_WEBHOOK_URL` | POST endpoint that sends emails. Receives JSON: `{ to, subject, body }` |

You can point this at any email sending service (SendGrid, Mailgun, a simple SMTP relay, etc.) via a small webhook adapter.

### Production Deployment

For production, put the app behind a reverse proxy (nginx, Caddy, etc.) with SSL:

```bash
# Create a dedicated user
sudo useradd -r -s /bin/false screentinker

# Copy the app
sudo cp -r . /opt/screentinker
sudo chown -R screentinker:screentinker /opt/screentinker

# Install dependencies
cd /opt/screentinker/server && npm install --production

# Create a systemd service
sudo cat > /etc/systemd/system/screentinker.service << 'EOF'
[Unit]
Description=ScreenTinker
After=network.target

[Service]
Type=simple
User=screentinker
WorkingDirectory=/opt/screentinker/server
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3001
Environment=NODE_ENV=production
Environment=SELF_HOSTED=true
# Environment=APP_URL=https://signage.yourcompany.com
# Environment=STRIPE_SECRET_KEY=sk_live_...
# Environment=STRIPE_WEBHOOK_SECRET=whsec_...

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now screentinker
```

#### Nginx Example

```nginx
server {
    listen 80;
    server_name signage.yourcompany.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name signage.yourcompany.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

### Backups

The SQLite database is at `server/db/remote_display.db`. Back it up regularly:

```bash
# Safe backup (works even while the server is running)
sqlite3 server/db/remote_display.db ".backup /path/to/backup.db"
```

Uploaded content is in `server/uploads/`. Back that up too.

### Admin Recovery

Locked out? Run this on the server to get a temporary admin token (1 hour):

```bash
node scripts/reset-admin.js
```

### Building the Android APK

The Android player app is in the `android/` directory. To build it:

```bash
cd android

# Set your keystore credentials (or generate a new keystore)
export KEYSTORE_PASSWORD=your_password
export KEY_ALIAS=your_alias
export KEY_PASSWORD=your_password

# Build the APK
./gradlew assembleDebug
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to `server/` as `ScreenTinker.apk` to serve it from `/download/apk`:

```bash
cp android/app/build/outputs/apk/debug/app-debug.apk ScreenTinker.apk
```

To generate a new signing keystore:

```bash
keytool -genkey -v -keystore android/release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias your_alias
```

**Requirements:** Java 17+, Android SDK (API 34).

### Device Setup

1. Register at your ScreenTinker instance
2. Go to **Displays** and click **Add Display**
3. Install the ScreenTinker app on your device:
   - **Android TV / tablets**: Download the APK from your instance (`/download/apk`) or build it from source (see above)
   - **Raspberry Pi**: `curl -sSL https://your-instance/scripts/raspberry-pi-setup.sh | bash`
   - **Windows**: Run the setup script from `scripts/windows-setup.bat`
   - **Any browser**: Open `https://your-instance/player` in kiosk/fullscreen mode
4. Enter the pairing code shown on the device

## Project Structure

```
server/           Node.js/Express backend
  config.js       Configuration and environment variables
  server.js       Main entry point
  db/             SQLite database and schema
  routes/         API route handlers
  middleware/     Auth, rate limiting, file upload
  services/       Background services (heartbeat, scheduler, alerts)
  ws/             WebSocket handlers (device + dashboard)
  player/         Web-based display player
frontend/         Static SPA dashboard
  js/views/       View components
  css/            Stylesheets
  legal/          Terms, privacy, licenses
android/          Android TV/tablet player app
scripts/          Device setup scripts + admin recovery
```

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO, SQLite (better-sqlite3)
- **Frontend:** Vanilla JS SPA (no framework, no build step)
- **Android:** Kotlin, ExoPlayer, Socket.IO client
- **Auth:** JWT with bcrypt, Google/Microsoft OAuth (optional)
- **Payments:** Stripe (optional)

## License

[MIT](LICENSE)
