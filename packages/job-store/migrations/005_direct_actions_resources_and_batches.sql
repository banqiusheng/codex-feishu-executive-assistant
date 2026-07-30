-- SQLite cannot alter a CHECK constraint in place.  Rebuild the action table
-- and each dependent action ledger while retaining every v4 row and foreign
-- key edge inside the migrator's enclosing transaction.
DROP TRIGGER actions_frozen_payload;
DROP TRIGGER actions_legal_state_transition;
DROP INDEX actions_state_updated_idx;
DROP INDEX one_president_pending_action_per_task;
DROP TRIGGER action_transitions_append_only_update;
DROP TRIGGER action_transitions_append_only_delete;
DROP TRIGGER approvals_append_only_update;
DROP TRIGGER approvals_append_only_delete;
DROP TRIGGER action_attempts_append_only_update;
DROP TRIGGER action_attempts_append_only_delete;
DROP TRIGGER reconciliations_append_only_update;
DROP TRIGGER reconciliations_append_only_delete;

ALTER TABLE actions RENAME TO actions_v4;
ALTER TABLE approvals RENAME TO approvals_v4;
ALTER TABLE action_transitions RENAME TO action_transitions_v4;
ALTER TABLE action_attempts RENAME TO action_attempts_v4;
ALTER TABLE reconciliations RENAME TO reconciliations_v4;

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  control_event_id TEXT REFERENCES control_events(id),
  version INTEGER NOT NULL,
  capability TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('bot','user')),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('president','president_instruction','system_policy')),
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
  CHECK (
    (capability='system_reply' AND approval_mode='system_policy' AND identity='bot') OR
    (capability<>'system_reply' AND approval_mode='president') OR
    (capability<>'system_reply' AND approval_mode='president_instruction' AND task_id IS NOT NULL AND control_event_id IS NULL)
  ),
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

INSERT INTO actions SELECT * FROM actions_v4;
INSERT INTO approvals SELECT * FROM approvals_v4;
INSERT INTO action_transitions SELECT * FROM action_transitions_v4;
INSERT INTO action_attempts SELECT * FROM action_attempts_v4;
INSERT INTO reconciliations SELECT * FROM reconciliations_v4;

DROP TABLE approvals_v4;
DROP TABLE action_transitions_v4;
DROP TABLE action_attempts_v4;
DROP TABLE reconciliations_v4;
DROP TABLE actions_v4;

CREATE INDEX actions_state_updated_idx ON actions(state, updated_at);
CREATE UNIQUE INDEX one_president_pending_action_per_task
  ON actions(task_id)
  WHERE task_id IS NOT NULL AND approval_mode='president' AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING');

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

CREATE TABLE instruction_authorizations (
  action_id TEXT NOT NULL,
  action_version INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  inbound_event_id TEXT NOT NULL REFERENCES inbound_events(id),
  capability TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  item_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (action_id, action_version),
  UNIQUE (task_id, capability, item_key),
  FOREIGN KEY (action_id, action_version) REFERENCES actions(id, version)
);

CREATE TRIGGER instruction_authorizations_exact_action_insert
BEFORE INSERT ON instruction_authorizations
WHEN NOT EXISTS (
  SELECT 1
    FROM actions
    JOIN tasks ON tasks.id=actions.task_id
   WHERE actions.id=NEW.action_id
     AND actions.version=NEW.action_version
     AND actions.approval_mode='president_instruction'
     AND actions.task_id=NEW.task_id
     AND tasks.inbound_event_id=NEW.inbound_event_id
     AND actions.capability=NEW.capability
     AND actions.payload_hash=NEW.payload_hash
)
BEGIN
  SELECT RAISE(ABORT, 'action_instruction_authorization_mismatch');
END;

CREATE TRIGGER instruction_authorizations_append_only_update
BEFORE UPDATE ON instruction_authorizations BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER instruction_authorizations_append_only_delete
BEFORE DELETE ON instruction_authorizations BEGIN SELECT RAISE(ABORT, 'append only'); END;

CREATE TABLE clarification_options (
  group_id TEXT NOT NULL,
  group_label TEXT NOT NULL,
  option_ordinal INTEGER NOT NULL CHECK (option_ordinal >= 1),
  option_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  principal_hash TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  value_json TEXT NOT NULL,
  display_label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, option_ordinal),
  UNIQUE (group_id, option_ref)
);

CREATE TRIGGER clarification_options_append_only_update
BEFORE UPDATE ON clarification_options BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER clarification_options_append_only_delete
BEFORE DELETE ON clarification_options BEGIN SELECT RAISE(ABORT, 'append only'); END;

CREATE TABLE clarification_selections (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  option_ordinal INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action_id TEXT REFERENCES actions(id),
  selected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, group_id),
  FOREIGN KEY (group_id, option_ordinal)
    REFERENCES clarification_options(group_id, option_ordinal)
);

CREATE TRIGGER clarification_selections_append_only_update
BEFORE UPDATE ON clarification_selections BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER clarification_selections_append_only_delete
BEFORE DELETE ON clarification_selections BEGIN SELECT RAISE(ABORT, 'append only'); END;

CREATE TABLE task_resources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  resource_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_message_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, resource_ref),
  UNIQUE (task_id, relative_path)
);

CREATE TRIGGER task_resources_append_only_update
BEFORE UPDATE ON task_resources BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER task_resources_append_only_delete
BEFORE DELETE ON task_resources BEGIN SELECT RAISE(ABORT, 'append only'); END;

CREATE TABLE notification_batches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  batch_key_hash TEXT NOT NULL UNIQUE,
  recipient_count INTEGER NOT NULL CHECK (recipient_count >= 1),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','DISPATCHING','SUCCEEDED','FAILED','UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER notification_batches_immutable_fields
BEFORE UPDATE ON notification_batches
WHEN NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.batch_key_hash IS NOT OLD.batch_key_hash
  OR NEW.recipient_count IS NOT OLD.recipient_count
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable notification batch fields');
END;

CREATE TRIGGER notification_batches_legal_state_transition
BEFORE UPDATE OF state ON notification_batches
WHEN NOT (
  (OLD.state='PREPARED' AND NEW.state IN ('DISPATCHING','FAILED')) OR
  (OLD.state='DISPATCHING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal notification batch state transition');
END;

CREATE TABLE notification_parts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES notification_batches(id),
  recipient_ordinal INTEGER NOT NULL CHECK (recipient_ordinal >= 1),
  action_id TEXT NOT NULL REFERENCES actions(id),
  part_ordinal INTEGER NOT NULL CHECK (part_ordinal >= 1),
  part_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','CLAIMED','DISPATCHING','SUCCEEDED','FAILED','UNKNOWN')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_id TEXT,
  request_digest TEXT,
  remote_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (action_id, part_ordinal),
  UNIQUE (batch_id, recipient_ordinal, part_ordinal)
);

CREATE TRIGGER notification_parts_recipient_action_insert
BEFORE INSERT ON notification_parts
WHEN EXISTS (
  SELECT 1 FROM notification_parts
   WHERE batch_id=NEW.batch_id
     AND recipient_ordinal=NEW.recipient_ordinal
     AND action_id<>NEW.action_id
)
BEGIN
  SELECT RAISE(ABORT, 'notification_recipient_action_mismatch');
END;

CREATE TRIGGER notification_parts_action_recipient_insert
BEFORE INSERT ON notification_parts
WHEN EXISTS (
  SELECT 1 FROM notification_parts
   WHERE action_id=NEW.action_id
     AND (
       batch_id<>NEW.batch_id OR
       recipient_ordinal<>NEW.recipient_ordinal
     )
)
BEGIN
  SELECT RAISE(ABORT, 'notification_action_recipient_mismatch');
END;

CREATE TRIGGER notification_parts_recipient_ordinal_insert
BEFORE INSERT ON notification_parts
WHEN NOT EXISTS (
  SELECT 1 FROM notification_batches
   WHERE id=NEW.batch_id
     AND NEW.recipient_ordinal BETWEEN 1 AND recipient_count
)
BEGIN
  SELECT RAISE(ABORT, 'notification_recipient_ordinal_out_of_range');
END;

CREATE TRIGGER notification_parts_action_task_insert
BEFORE INSERT ON notification_parts
WHEN NOT EXISTS (
  SELECT 1
    FROM notification_batches
    JOIN actions ON actions.task_id=notification_batches.task_id
   WHERE notification_batches.id=NEW.batch_id
     AND actions.id=NEW.action_id
)
BEGIN
  SELECT RAISE(ABORT, 'notification_action_task_mismatch');
END;

CREATE TRIGGER notification_parts_immutable_fields
BEFORE UPDATE ON notification_parts
WHEN NEW.id IS NOT OLD.id
  OR NEW.batch_id IS NOT OLD.batch_id
  OR NEW.recipient_ordinal IS NOT OLD.recipient_ordinal
  OR NEW.action_id IS NOT OLD.action_id
  OR NEW.part_ordinal IS NOT OLD.part_ordinal
  OR NEW.part_kind IS NOT OLD.part_kind
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable notification part fields');
END;

CREATE TRIGGER notification_parts_legal_state_transition
BEFORE UPDATE OF state ON notification_parts
WHEN NOT (
  (OLD.state='PENDING' AND NEW.state IN ('CLAIMED','FAILED')) OR
  (OLD.state='CLAIMED' AND NEW.state IN ('DISPATCHING','UNKNOWN')) OR
  (OLD.state='DISPATCHING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal notification part state transition');
END;

PRAGMA foreign_key_check;
PRAGMA integrity_check;
