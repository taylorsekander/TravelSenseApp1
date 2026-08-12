# TravelSense

AI travel advisor. Static front end plus one Cloudflare Worker that calls the
Anthropic and Google APIs with server-side keys.

## Repository layout

Four files. The `public/` folder holds everything served to browsers; the
worker sits at the root so it is never published as a static asset.

```
_worker.js        the API — chat, speech, signup capture
wrangler.json     tells Cloudflare which file is the worker
public/
  index.html      the whole app
  manifest.webmanifest   makes it installable to the home screen
  sw.js                  service worker (offline shell)
  icon-192.png           app icons
  icon-512.png
  icon-192-maskable.png  Android adaptive icons
  icon-512-maskable.png
  apple-touch-icon.png   iOS home screen icon
  health.txt             deploy diagnostic (safe to delete once live)
```

## Installing it as an app

TravelSense is a progressive web app. Once deployed over HTTPS it installs to
the home screen and runs without browser chrome.

- **iPhone / iPad:** open in Safari → Share → Add to Home Screen. Chrome on iOS
  cannot install web apps; it must be Safari.
- **Android:** Chrome shows an install prompt automatically, or use
  menu → Add to Home screen.
- **Desktop:** Chrome and Edge show an install icon in the address bar.

Installed, it opens full screen in portrait with the brand splash colour.

The service worker caches the app shell so it opens without a connection, but
always fetches the current version when online — a stale build would be worse
than a slow load. API calls are never cached.

## Deploying

1. Cloudflare dashboard → Workers & Pages → **Create** → Connect to Git →
   pick this repository.
2. Leave the build command empty. `wrangler.json` supplies the configuration.
3. **Settings → Variables and Secrets → Production:**

   | Variable | Required | Purpose |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | yes | Conversation and recommendation text |
   | `GOOGLE_TTS_API_KEY` | no | Natural voice; falls back to the device voice |
   | `GOOGLE_TTS_VOICE` | no | Defaults to `en-US-Chirp3-HD-Achernar` |
   | `GOOGLE_TTS_STYLE` | no | Spoken style instruction |
   | `GA4_MEASUREMENT_ID` | no | Server-side cost tracking |
   | `GA4_API_SECRET` | no | Server-side cost tracking |

   Add the keys as **Secrets**, not plain text.

4. Redeploy. Cloudflare does not apply new variables to a build that already ran.

If `wrangler.json` reports a name mismatch, change `"name"` to match the
Worker name shown in your dashboard.

## Verifying a deploy

| URL | Expected |
|---|---|
| `/health.txt` | plain text — static files are serving |
| `/api/hello` | JSON listing which keys are detected, never the keys |
| `/api/chat` | **405** — 405 means live, 404 means the worker isn't running |
| `/_worker.js` | **404** — server code must not be public |
| `/` | the landing page |

The last two matter most. If `/_worker.js` returns JavaScript, stop and fix it.

## Logs

Dashboard → your Worker → **Logs**, or `npx wrangler tail`.

- `ts_metrics` — tokens, cost, latency, retries, speech usage
- `ts_signup` — beta signups with email, name and source

Logs are not permanent. Copy signup emails out periodically.

## Analytics

Google Analytics 4 is configured in `index.html` (`window.__TS_GA4_ID`).
Register these as custom definitions in GA4 or they will not appear in reports:

- Metrics: `api_cost`, `match_score`, `destination_count`, `total_tokens`, `latency_ms`
- Dimension: `provider`

Custom definitions do not backfill, so create them before testers arrive.

A founder-only dashboard lives at `/?dashboard=1`. It reads the current browser
only — useful for checking engine behaviour during your own testing, not for
aggregating across users.

## Costs

- Cloudflare free tier: 100,000 worker requests/day. A search is 10–15 requests.
- Google TTS free tier: 1M characters/month, roughly 400 voice searches.
- Anthropic: about $0.25 per completed search at current pricing.
