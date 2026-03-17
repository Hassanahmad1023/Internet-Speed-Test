# NEXUS — Internet Speed Test

A minimal, elegant internet speed test inspired by the VELOX GPS speedometer. No frameworks, no build step, no third-party SDK — just pure `fetch()` against Cloudflare's public endpoints.

**Live demo:** `https://<your-username>.github.io/nexus/`

---

## Features

- **Download & Upload** speed measured progressively across multiple payload sizes
- **Ping latency** and **jitter** via lightweight round-trip requests
- **Live arc gauge** — animates in real-time as measurements arrive
- **VELOX-inspired UI** — Bebas Neue + Space Mono, `#e8ff47` accent, dark grid
- **Dark / Light theme** toggle, persisted in localStorage
- **Zero dependencies** — no npm, no bundler, drop the files and go
- **PWA-ready** — add to home screen on iOS and Android

---

## How it works

All measurements hit Cloudflare's public speed test endpoints:

| Endpoint | Purpose |
|---|---|
| `GET speed.cloudflare.com/__down?bytes=N` | Download — fetches N bytes, measures throughput |
| `POST speed.cloudflare.com/__up` | Upload — sends a payload body, measures throughput |
| `GET speed.cloudflare.com/cdn-cgi/trace` | Server colo & country code |

Download and upload run across progressively larger payloads (100 KB → 100 MB for download, 100 KB → 25 MB for upload). A trimmed mean across all rounds gives the final result, discarding outliers at both ends.

Latency is measured using 8 lightweight GETs with a 0-byte body and a `performance.now()` stopwatch.

---

## File structure

```
nexus/
├── index.html      — markup and CSS
├── speedtest.js    — measurement engine (fetch-based, no SDK)
├── app.js          — arc gauge, smooth animation, UI controller
├── manifest.json   — PWA manifest
├── icons/          — app icons (add your own)
└── README.md
```

---

## Deploy to GitHub Pages

1. Fork or clone this repo
2. Push to `main`
3. Go to **Settings → Pages → Source → Deploy from branch → main / root**
4. Your app is live at `https://<username>.github.io/<repo>/`

No build step needed.

---

## Customisation

All visual design tokens are CSS variables in `index.html`:

```css
:root {
  --bg: #0a0a0a;
  --accent: #e8ff47;   /* yellow — idle / ping */
  --dl: #47ffb2;        /* green — download */
  --ul: #47c8ff;        /* blue  — upload */
}
```

Measurement behaviour (sizes, rounds, timeouts) is configured at the top of `speedtest.js`:

```js
const DL_SIZES = [100000, 1000000, 10000000, 25000000, 100000000];
const UL_SIZES = [100000, 1000000, 10000000, 25000000];
const ROUNDS_PER_SIZE = 2;
const LATENCY_ROUNDS  = 8;
```

---

## Credits

- Measurement endpoints: [Cloudflare speed.cloudflare.com](https://speed.cloudflare.com)
- Font: [Bebas Neue](https://fonts.google.com/specimen/Bebas+Neue) + [Space Mono](https://fonts.google.com/specimen/Space+Mono)
- Inspired by [VELOX GPS Speedometer](https://github.com/Hassanahmad1023/velox-)

---

## License

MIT
