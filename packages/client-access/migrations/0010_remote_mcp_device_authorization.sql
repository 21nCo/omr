ALTER TABLE omr_control.device_authorizations
  DROP CONSTRAINT IF EXISTS device_authorizations_client_kind_check;

ALTER TABLE omr_control.device_authorizations
  ADD CONSTRAINT device_authorizations_client_kind_check
  CHECK (client_kind IN ('cli', 'mcp_remote', 'mcp_stdio'));
