# WarcraftLogs Bot

A Discord bot that tracks raid pulls via WarcraftLogs in real-time.

## Features

- `/start` — Enter a WarcraftLogs URL to begin tracking
- `/stop` — Halt tracking early and see the summary
- `/status` — Check current activity

## Architecture

The bot polls WoWAnalyzer every 30s for new pulls. When a new pull appears, it:
1. Fetches the fight data from Wipefest for detailed mechanics scoring
2. Compares the new pull with the previous pull (duration, result)
3. Posts coaching feedback as an embed
4. Auto-stops after 30 minutes of no new pulls and sends a raid summary

## Setup

```bash
# 1. Copy env
cp .env.example .env

# 2. Fill in your token and client ID

# 3. Install deps
npm install

# 4. Run
node index.js
```

## Permissions

Create a Discord application at discord.com/developers:
- Add the `bot` scope with these permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`
- Add the bot to your raid Discord server
- Set `DISCORD_CLIENT_ID` and `DISCORD_TOKEN` in `.env`

## Data Sources

- [WoWAnalyzer](https://wowanalyzer.com) — fight list
- [Wipefest.gg](https://www.wipefest.gg) — mechanics scoring and coaching data
- [WarcraftLogs](https://warcraftlogs.com) — fight URL for embedding

WarcraftLogs itself is fully JS-rendered and can't be scraped directly — these proxy sites provide static endpoints.

## Limitations

- Works on public WCL reports only
- Wipefest mechanics scoring is percentile-based — 0-100 vs all guilds
