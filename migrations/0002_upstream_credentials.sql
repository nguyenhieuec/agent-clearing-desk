-- OpenKrill Connect hands out 1 hour access tokens and rotates the refresh token on each use,
-- so the newest pair must outlive any one Worker isolate.
CREATE TABLE upstream_credentials (
  name TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
