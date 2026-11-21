-- The Wire: live commentary timeline (see the table comment in schema.sql).
--
-- Additive and idempotent: no existing table or row is touched.
-- Applied with: npx wrangler d1 execute squad-goals --remote --file=migrations/011-live-wire.sql
CREATE TABLE IF NOT EXISTS live_wire_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL UNIQUE,
  match_id INTEGER NOT NULL,
  competition TEXT NOT NULL,
  match_day TEXT NOT NULL,
  kind TEXT NOT NULL,
  facts TEXT NOT NULL,
  ai_line TEXT,
  ai_state TEXT,
  ai_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_wire_items_day ON live_wire_items(match_day, updated_at);
CREATE INDEX IF NOT EXISTS live_wire_items_match ON live_wire_items(match_id);
CREATE INDEX IF NOT EXISTS live_wire_items_ai ON live_wire_items(ai_state, created_at);
