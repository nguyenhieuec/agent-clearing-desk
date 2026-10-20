-- A tool added at run time may need a credential header for its upstream (a paid MCP server).
-- Only the sealed value is stored: AES-256-GCM under the UPSTREAM_SECRET_KEY Worker secret.
ALTER TABLE custom_tools ADD COLUMN auth_header_name TEXT;
ALTER TABLE custom_tools ADD COLUMN auth_header_sealed TEXT;
