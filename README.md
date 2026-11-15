# ChessGram game server

Node.js HTTP and Socket.IO server for ChessGram.

## Required environment variables

- `PORT` — provided automatically by the hosting platform
- `TELEGRAM_BOT_TOKEN` — Telegram bot token used to verify Mini App initData
- `SESSION_SECRET` — random signing secret, at least 32 characters
- `SUPABASE_URL` — project URL
- `SUPABASE_SECRET_KEY` — server-only Supabase secret key (never expose it to the browser)

The server verifies Telegram Mini App initData, issues short-lived signed sessions, authenticates Socket.IO connections, and stores finished PvP matches and player statistics in Supabase.

## Run

```bash
npm install
npm start
```

Use Node.js 18 or newer. Never commit production secrets.
