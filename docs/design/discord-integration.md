# Discord integration: weekly digests and league events

Design doc for [#47](https://github.com/henderjm/world-cup-sweepstake/issues/47). Status: **proposed, not built.**

## The short version

Publishing to Discord is a **fan-out of the league feed we already write**, not a new event system. Every event the issue asks for is already recorded in `fantasy_chat_messages`, already worded by `describeChatEvent`, and already produced by a cron pass. The work is a delivery channel, not a source.

And it should be an **incoming webhook, not a bot**, for reasons that are architectural rather than preferential (below).

## Why not a bot

The issue says "using a bot". A Discord bot receives events over a **persistent WebSocket gateway connection**. Cloudflare Workers are request-scoped and cannot hold one; a Durable Object technically can, but a 24/7 outbound gateway socket per install is a cost and failure mode we would be choosing for no benefit.

Everything requested is **one-way, us to Discord**. That is exactly what an incoming webhook is for: a URL per channel, an HTTP POST, no gateway, no bot token to hold, no OAuth flow, no persistent process. It works from a Worker as-is.

If two-way is ever wanted (`/standings` in Discord), the answer is still not a gateway bot: Discord supports **HTTP interactions**, where Discord POSTs to an endpoint we host and we verify an Ed25519 signature. Worker-native, stateless, and additive to this design. Worth knowing it exists; not worth building now.

**Recommendation: incoming webhooks. Revisit HTTP interactions only if someone actually asks for commands.**

## What we would publish

The issue asks for three. All three already exist as events:

| Requested | Event | Emitted by |
|---|---|---|
| Gameweeks end | `recap` | `runScheduledLeagueRecaps` |
| Waivers close | `waiver_run` | `runLeagueWaiverRun` |
| Transfer offers | — | *does not exist yet; see below* |

"Transfer offers" has no counterpart because **trades are not built**. The nearest existing events are `waiver_claim` and free-agent adds. This integration should not invent a trade concept; when trades ship, they emit a feed event like everything else and this bridge carries them with no change.

Two more are worth including because they are the moments people are not looking at the app:

- `draft_scheduled` / draft reminders, which is where a league loses people
- `draft_recap`, the highest-share-value thing the product produces

Deliberately **not** published: every pick during a live draft. A twelve-manager draft is 180 events in an hour and would get the channel muted, which costs us every other notification.

## Architecture

```
fantasy_chat_messages (already written, append-only)
        │
        ▼
runScheduledDiscordDigest   ← new cron pass, LAST, after api-usage
        │  reads rows since a per-league watermark
        │  words them with describeChatEvent (shared, unchanged)
        ▼
POST https://discord.com/api/webhooks/...   ← per league
```

Three properties fall out of using the feed as the source, and each is a bug we would otherwise have to fix later:

1. **Wording never forks.** `describeChatEvent` already turns stored facts into a sentence at read time. Discord uses the same function, so a copy change lands in both places at once.
2. **Nothing is published twice.** A watermark of the last delivered message id per league, advanced only after a 2xx, makes redelivery idempotent without a distributed transaction. A crashed tick retries; a delivered tick does not repeat.
3. **A dead webhook cannot break a season.** This pass runs last, after every pass that touches scoring, waivers and recaps, for the same reason the API-usage flush does: a failed digest is a missing Discord message, a failed waiver run corrupts a season.

### Schema

```sql
CREATE TABLE IF NOT EXISTS discord_webhooks (
  league_id INTEGER PRIMARY KEY REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,
  last_message_id INTEGER NOT NULL DEFAULT 0, -- watermark into fantasy_chat_messages
  failures INTEGER NOT NULL DEFAULT 0,        -- consecutive; disables at a threshold
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One webhook per league, set by the commissioner. `ON DELETE CASCADE` so deleting a league takes its integration with it.

### Security

**A Discord webhook URL is a bearer credential.** Anyone holding it can post to that channel as us, forever, with no further auth. That drives three rules:

- **Commissioner-only to set, and never readable back.** `GET` returns whether one is configured and the channel name Discord reports, never the URL. A URL that can be read back by any member is a URL that leaks.
- **Validate the host.** Accept only `https://discord.com/api/webhooks/...`. Without that this is an SSRF primitive: a commissioner could point it at an internal address and use our Worker to reach it.
- **404/401 from Discord prunes the row**, exactly as a dead push subscription is pruned today. A deleted channel must not retry forever.

Content is already safe: league and manager names reach Discord through the same `describeChatEvent` payloads the app renders, and team names are stripped of control characters at the point of storage (`src/fantasyTeamName.js`). Discord renders markdown, so text destined for it needs escaping for `*_~\`` at the boundary — not in the shared wording function, which must stay presentation-neutral.

## Weekly digest vs event stream

The issue title says digest, the body lists events. They are different products:

- **Event stream:** each event posted as it happens. Immediate, and noisy.
- **Weekly digest:** one message per gameweek, carrying the recap, the standings and what the waiver run did.

**Recommendation: build the digest first.** It is one message a week, it is the thing that pulls a lapsed manager back, and it is strictly less risky to get wrong. The per-event stream can be a per-league toggle later, reusing the same watermark and the same wording.

## Cost

Nothing measurable. One HTTP POST per league per gameweek, on a cron tick that already runs, against no rate limit we would come close to. No API-Football quota is involved.

## Open questions for @henderjm

1. **Digest, event stream, or both behind a toggle?** Recommendation above is digest first.
2. **Who sets the webhook: commissioner only, or any member?** Recommendation: commissioner, since it posts on behalf of the whole league.
3. **Does this wait for trades?** "Transfer offers" cannot be published until trades exist. The other two events can ship now.
