INSERT INTO permissions(code) VALUES ('users.password.reset');
INSERT INTO role_permissions(role_code,permission_code) VALUES
 ('OWNER','users.password.reset'), ('MANAGER','users.password.reset');

ALTER TABLE user_audit DROP CONSTRAINT user_audit_action_check;
ALTER TABLE user_audit ADD CONSTRAINT user_audit_action_check CHECK (
 action IN ('BOOTSTRAP','CREATED','ACCESS_CHANGED','PASSWORD_CHANGED','PASSWORD_RESET','OWNER_RECOVERED')
);
-- Credential audit records may contain only non-secret outcome flags.
ALTER TABLE user_audit ADD CONSTRAINT password_audit_safe_payload CHECK (
 action NOT IN ('PASSWORD_CHANGED','PASSWORD_RESET','OWNER_RECOVERED') OR
 (old_value IS NULL AND new_value = '{"passwordChanged":true,"sessionsRevoked":true}'::jsonb)
);
ALTER TABLE user_audit ADD CONSTRAINT password_audit_actor CHECK (
 (action <> 'PASSWORD_CHANGED' OR (actor_id IS NOT NULL AND actor_id = target_id)) AND
 (action <> 'PASSWORD_RESET' OR (actor_id IS NOT NULL AND actor_id <> target_id)) AND
 (action <> 'OWNER_RECOVERED' OR actor_id IS NULL)
);
