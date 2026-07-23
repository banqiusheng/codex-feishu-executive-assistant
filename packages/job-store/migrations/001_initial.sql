PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE principals (
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  president_open_id TEXT NOT NULL,
  president_chat_id TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  PRIMARY KEY (app_id, tenant_key)
);

CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (app_id, tenant_key, event_id)
);

CREATE TABLE control_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command='CANCEL_ACTIVE_TASK'),
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  target_task_id TEXT REFERENCES tasks(id),
  received_at TEXT NOT NULL,
  UNIQUE (app_id, tenant_key, event_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT NOT NULL REFERENCES inbound_events(id),
  task_kind TEXT NOT NULL DEFAULT 'ROOT' CHECK (task_kind IN ('ROOT','RESUME')),
  resumed_from_task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN ('RECEIVED','CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')),
  recovery_disposition TEXT NOT NULL DEFAULT 'NONE' CHECK (recovery_disposition IN ('NONE','REQUIRES_CONFIRMATION','RESUME_APPROVED','ABANDONED')),
  codex_session_id TEXT,
  workspace_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  control_event_id TEXT REFERENCES control_events(id),
  version INTEGER NOT NULL,
  capability TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('bot','user')),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('president','system_policy')),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING','SUCCEEDED','FAILED','UNKNOWN','RECONCILED')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  remote_id TEXT,
  result_json TEXT,
  reconcile_outcome TEXT CHECK (reconcile_outcome IN ('SUCCEEDED','FAILED','INDETERMINATE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, version),
  CHECK ((task_id IS NOT NULL AND control_event_id IS NULL) OR (task_id IS NULL AND control_event_id IS NOT NULL)),
  CHECK ((capability='system_reply' AND approval_mode='system_policy' AND identity='bot') OR (capability<>'system_reply' AND approval_mode='president')),
  CHECK (control_event_id IS NULL OR capability='system_reply')
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  action_version INTEGER NOT NULL,
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED','EXPIRED','INVALIDATED')),
  decided_at TEXT NOT NULL,
  FOREIGN KEY (action_id, action_version) REFERENCES actions(id, version)
);

CREATE TABLE action_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('STARTED','FINISHED')),
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('DISPATCH','RECONCILE','SYSTEM_REPLY')),
  outcome TEXT CHECK (outcome IN ('SUCCEEDED','FAILED_DEFINITE','UNKNOWN','INDETERMINATE')),
  request_digest TEXT NOT NULL,
  result_digest TEXT,
  remote_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (action_id, attempt_id, phase),
  CHECK (
    (phase='STARTED' AND outcome IS NULL AND result_digest IS NULL AND remote_id IS NULL) OR
    (phase='FINISHED' AND outcome IS NOT NULL)
  )
);

CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','INDETERMINATE')),
  evidence_digest TEXT NOT NULL,
  operator_kind TEXT NOT NULL CHECK (operator_kind IN ('automatic','manual')),
  created_at TEXT NOT NULL
);

CREATE TABLE task_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK (role IN ('input','output','evidence')),
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, relative_path)
);

CREATE TABLE runtime_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_state_created_idx ON tasks(state, created_at);
CREATE INDEX actions_state_updated_idx ON actions(state, updated_at);
CREATE UNIQUE INDEX one_root_task_per_event
  ON tasks(inbound_event_id)
  WHERE task_kind='ROOT';
CREATE UNIQUE INDEX one_president_pending_action_per_task
  ON actions(task_id)
  WHERE task_id IS NOT NULL AND approval_mode='president' AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING');

CREATE TRIGGER tasks_legal_state_transition
BEFORE UPDATE OF state ON tasks
WHEN NOT (
  (OLD.state='RECEIVED' AND NEW.state IN ('CLAIMED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')) OR
  (OLD.state='CLAIMED' AND NEW.state IN ('RUNNING','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')) OR
  (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal task state transition');
END;

CREATE TRIGGER tasks_legal_recovery_transition
BEFORE UPDATE OF recovery_disposition ON tasks
WHEN NOT (
  (OLD.recovery_disposition='NONE' AND NEW.recovery_disposition='REQUIRES_CONFIRMATION') OR
  (OLD.recovery_disposition='REQUIRES_CONFIRMATION' AND NEW.recovery_disposition IN ('RESUME_APPROVED','ABANDONED'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal recovery transition');
END;

CREATE TRIGGER actions_frozen_payload
BEFORE UPDATE ON actions
WHEN NEW.task_id IS NOT OLD.task_id
  OR NEW.control_event_id IS NOT OLD.control_event_id
  OR NEW.version IS NOT OLD.version
  OR NEW.capability IS NOT OLD.capability
  OR NEW.identity IS NOT OLD.identity
  OR NEW.approval_mode IS NOT OLD.approval_mode
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.preview_json IS NOT OLD.preview_json
  OR NEW.actor_open_id_hash IS NOT OLD.actor_open_id_hash
  OR NEW.chat_id_hash IS NOT OLD.chat_id_hash
  OR NEW.nonce_hash IS NOT OLD.nonce_hash
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'immutable action fields');
END;

CREATE TRIGGER actions_legal_state_transition
BEFORE UPDATE OF state ON actions
WHEN NOT (
  (OLD.state='PREPARED' AND NEW.state IN ('APPROVED','FAILED')) OR
  (OLD.state='APPROVED' AND NEW.state IN ('CLAIMED','FAILED')) OR
  (OLD.state='CLAIMED' AND NEW.state IN ('DISPATCHING','FAILED')) OR
  (OLD.state='DISPATCHING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')) OR
  (OLD.state='UNKNOWN' AND NEW.state='RECONCILED')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal action state transition');
END;

CREATE TRIGGER action_transitions_append_only_update
BEFORE UPDATE ON action_transitions BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_transitions_append_only_delete
BEFORE DELETE ON action_transitions BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER approvals_append_only_update
BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER approvals_append_only_delete
BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_attempts_append_only_update
BEFORE UPDATE ON action_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_attempts_append_only_delete
BEFORE DELETE ON action_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER reconciliations_append_only_update
BEFORE UPDATE ON reconciliations BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER reconciliations_append_only_delete
BEFORE DELETE ON reconciliations BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER inbound_events_append_only_update
BEFORE UPDATE ON inbound_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER inbound_events_append_only_delete
BEFORE DELETE ON inbound_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER control_events_append_only_update
BEFORE UPDATE ON control_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER control_events_append_only_delete
BEFORE DELETE ON control_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
