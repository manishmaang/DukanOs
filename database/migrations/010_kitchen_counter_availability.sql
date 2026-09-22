-- Operational Counter flags only; no menu administration or other-channel grants.
INSERT INTO role_permissions(role_code,permission_code)
VALUES ('KITCHEN','menu.availability.manage') ON CONFLICT DO NOTHING;
