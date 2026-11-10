CREATE TABLE IF NOT EXISTS paid_sessions (
  session_id   TEXT PRIMARY KEY,
  service      TEXT NOT NULL,
  session_json TEXT NOT NULL,
  event_id     TEXT,
  received     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_sessions_received ON paid_sessions(received);
