# AI YouTube Radar

A single static page tracking the AI YouTube channels worth following: their latest video, its topic, when it dropped, and how often they actually publish.

## How it works

- `fetch.ts` picks the channel list out of the local ClaudeClaw YouTube index (channels with 2+ AI videos watched), then reads each channel's public YouTube RSS upload feed. No API key, no scraping.
- It writes `data.json` with the latest video, the gap before it, the median gap over the last 15 uploads, and a cadence label.
- `index.html` is a static page that reads `data.json`. No build step, no framework, no dependencies at runtime.

## Refresh the data

```bash
npx tsx fetch.ts     # rewrites data.json
git commit -am "refresh" && git push   # Vercel redeploys on push
```

Requires the ClaudeClaw SQLite index at `/Users/jack/ClaudeClaw/store/claudeclaw.db` for the channel list. The upload data itself comes from YouTube.

## Deploy

Static site, no build command, no output directory. Import the repo at vercel.com/new and accept the defaults.

## Ko-fi

The donate link is in the footer of `index.html`, marked with a `KO-FI LINK` comment. Replace `YOURNAME` with the Ko-fi handle.

## Local preview

```bash
python3 -m http.server 4321
# open http://127.0.0.1:4321
```
