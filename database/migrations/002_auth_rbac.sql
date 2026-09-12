CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
 password_hash text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (
 code text PRIMARY KEY,
 category text NOT NULL,
 CHECK ((category = 'PRIVILEGED' AND code IN ('OWNER','MANAGER')) OR
        (category = 'OPERATIONAL' AND code IN ('CASHIER','KITCHEN','DISPATCH')))
);
CREATE TABLE permissions (code text PRIMARY KEY);
CREATE TABLE user_roles (
 user_id uuid NOT NULL REFERENCES users(id),
 role_code text NOT NULL REFERENCES roles(code),
 PRIMARY KEY (user_id, role_code)
);
CREATE INDEX user_roles_role_idx ON user_roles(role_code, user_id);
CREATE TABLE role_permissions (
 role_code text NOT NULL REFERENCES roles(code),
 permission_code text NOT NULL REFERENCES permissions(code),
 PRIMARY KEY (role_code, permission_code)
);
CREATE INDEX role_permissions_permission_idx ON role_permissions(permission_code);
INSERT INTO roles VALUES ('OWNER','PRIVILEGED'), ('MANAGER','PRIVILEGED'),
 ('CASHIER','OPERATIONAL'), ('KITCHEN','OPERATIONAL'), ('DISPATCH','OPERATIONAL');
INSERT INTO permissions VALUES ('orders.create'), ('orders.read'), ('payments.collect'),
 ('kitchen.read'), ('kitchen.update'), ('dispatch.read'), ('dispatch.complete'),
 ('users.manage'), ('menu.manage'), ('reports.read'), ('payments.refund'),
 ('orders.cancel'), ('orders.prioritize'), ('credit.adjust');
INSERT INTO role_permissions
 SELECT 'OWNER', code FROM permissions;
INSERT INTO role_permissions
 SELECT 'MANAGER', code FROM permissions WHERE code <> 'users.manage';
INSERT INTO role_permissions VALUES
 ('CASHIER','orders.create'), ('CASHIER','orders.read'), ('CASHIER','payments.collect'),
 ('KITCHEN','kitchen.read'), ('KITCHEN','kitchen.update'),
 ('DISPATCH','dispatch.read'), ('DISPATCH','dispatch.complete');

-- Updating the parent row serializes membership writes, including direct SQL.
-- The actual UPDATE also prevents snapshot-isolation write skew.
CREATE FUNCTION lock_role_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
   RAISE EXCEPTION 'ROLE_ASSIGNMENT_IMMUTABLE' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'DELETE' THEN
   UPDATE users SET version = version + 1 WHERE id = OLD.user_id;
   RETURN OLD;
 END IF;
 UPDATE users SET version = version + 1 WHERE id = NEW.user_id;
 RETURN NEW;
END $$;
CREATE TRIGGER serialize_role_assignments BEFORE INSERT OR UPDATE OR DELETE ON user_roles
 FOR EACH ROW EXECUTE FUNCTION lock_role_assignment();
CREATE FUNCTION validate_user_roles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; total integer; privileged integer;
BEGIN
 IF TG_TABLE_NAME = 'users' THEN target := NEW.id;
 ELSIF TG_OP = 'DELETE' THEN target := OLD.user_id;
 ELSE target := NEW.user_id;
 END IF;
 SELECT count(*), count(*) FILTER (WHERE r.category = 'PRIVILEGED')
 INTO total, privileged FROM user_roles ur JOIN roles r ON r.code = ur.role_code
 WHERE ur.user_id = target;
 IF total = 0 OR (privileged > 0 AND total <> 1) THEN
   RAISE EXCEPTION 'INVALID_ROLE_COMBINATION' USING ERRCODE = '23514', CONSTRAINT = 'valid_user_role_set';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER user_requires_roles AFTER INSERT ON users
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_user_roles();
CREATE CONSTRAINT TRIGGER valid_user_role_set AFTER INSERT OR DELETE ON user_roles
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_user_roles();

CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE login_attempts (
 key text PRIMARY KEY,
 attempts integer NOT NULL CHECK (attempts > 0),
 window_start timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_window_idx ON login_attempts(window_start);
CREATE TABLE user_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid REFERENCES users(id),
 target_id uuid NOT NULL REFERENCES users(id),
 action text NOT NULL CHECK (action IN ('BOOTSTRAP','CREATED','ACCESS_CHANGED')),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 old_value jsonb,
 new_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_audit_target_idx ON user_audit(target_id, created_at);
CREATE FUNCTION protect_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER user_audit_immutable BEFORE UPDATE OR DELETE ON user_audit
 FOR EACH ROW EXECUTE FUNCTION protect_user_audit();
