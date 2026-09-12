-- Foundation only. Domain tables arrive with their owning features.
CREATE TABLE app_metadata (
  key text PRIMARY KEY CHECK (length(key) > 0),
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_metadata (key, value) VALUES ('application', 'DukanOS');
