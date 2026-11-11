CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS cafe_tables (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  zone text NOT NULL CHECK (zone IN ('Window', 'Indoor', 'Patio')),
  floor smallint NOT NULL CHECK (floor BETWEEN 1 AND 3),
  capacity smallint NOT NULL CHECK (capacity BETWEEN 1 AND 12),
  is_active boolean NOT NULL DEFAULT true,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  price numeric(10, 2) NOT NULL CHECK (price >= 0),
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  email text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK (role IN ('owner', 'staff')),
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_admin_expiry_idx ON sessions (admin_user_id, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE CHECK (reference ~ '^CC-[0-9A-HJKMNP-TV-Z]{26}$'),
  legacy_reference text,
  visit_date date NOT NULL,
  time_slot text NOT NULL CHECK (length(time_slot) BETWEEN 5 AND 8),
  start_time time without time zone NOT NULL,
  timezone_name text NOT NULL,
  duration_minutes smallint NOT NULL DEFAULT 90 CHECK (duration_minutes BETWEEN 15 AND 360),
  during tsrange GENERATED ALWAYS AS (
    tsrange(
      visit_date + start_time,
      visit_date + start_time + make_interval(mins => duration_minutes),
      '[)'
    )
  ) STORED,
  party_size smallint NOT NULL CHECK (party_size BETWEEN 1 AND 8),
  table_id text NOT NULL REFERENCES cafe_tables(id) ON DELETE RESTRICT,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 100),
  customer_phone text CHECK (customer_phone IS NULL OR length(customer_phone) BETWEEN 7 AND 32),
  customer_email text CHECK (customer_email IS NULL OR length(customer_email) BETWEEN 3 AND 254),
  special_requests text NOT NULL DEFAULT '' CHECK (length(special_requests) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  CHECK (customer_phone IS NOT NULL OR customer_email IS NOT NULL),
  CONSTRAINT reservations_no_table_overlap EXCLUDE USING gist (
    table_id WITH =,
    during WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);
CREATE INDEX IF NOT EXISTS reservations_date_status_idx ON reservations (visit_date, status);
CREATE INDEX IF NOT EXISTS reservations_table_date_idx ON reservations (table_id, visit_date, start_time);
CREATE INDEX IF NOT EXISTS reservations_email_visit_idx ON reservations (customer_email, visit_date, start_time)
  WHERE customer_email IS NOT NULL AND status <> 'cancelled';
CREATE INDEX IF NOT EXISTS reservations_phone_visit_idx ON reservations (customer_phone, visit_date, start_time)
  WHERE customer_phone IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS reservation_items (
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  menu_item_id text NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (reservation_id, menu_item_id)
);

CREATE TABLE IF NOT EXISTS reservation_events (
  id bigserial PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  actor_admin_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  previous_status text CHECK (previous_status IS NULL OR previous_status IN ('pending', 'confirmed', 'cancelled')),
  new_status text NOT NULL CHECK (new_status IN ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id bigserial PRIMARY KEY,
  ip_hash char(64) NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  identity_hash char(64) NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_created_idx ON login_attempts (created_at);
CREATE INDEX IF NOT EXISTS login_attempts_identity_idx ON login_attempts (identity_hash, created_at);

CREATE TABLE IF NOT EXISTS security_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  ip_hash char(64) CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{64}$'),
  subject_hash char(64) CHECK (subject_hash IS NULL OR subject_hash ~ '^[a-f0-9]{64}$'),
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key char(64) PRIMARY KEY CHECK (bucket_key ~ '^[a-f0-9]{64}$'),
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  hit_count integer NOT NULL CHECK (hit_count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_expiry_idx ON rate_limit_buckets (expires_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key varchar(200) PRIMARY KEY,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS data_imports (
  source text PRIMARY KEY,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  reservation_count integer NOT NULL CHECK (reservation_count >= 0),
  admin_count integer NOT NULL CHECK (admin_count >= 0),
  table_count integer NOT NULL CHECK (table_count >= 0),
  imported_at timestamptz NOT NULL DEFAULT now()
);
