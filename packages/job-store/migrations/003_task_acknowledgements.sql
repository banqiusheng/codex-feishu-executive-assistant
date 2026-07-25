CREATE TABLE task_acknowledgements (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'NOT_ATTEMPTED',
    'SENDING',
    'RETRYABLE_DNS',
    'ACKNOWLEDGED',
    'AMBIGUOUS',
    'FAILED_DEFINITE'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_failure_class TEXT
    CHECK (last_failure_class IS NULL OR last_failure_class IN (
      'DNS_UNAVAILABLE',
      'REMOTE_REJECTED',
      'RESULT_AMBIGUOUS',
      'LOCAL_EVIDENCE_FAILED'
    )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX task_acknowledgements_recovery_order
  ON task_acknowledgements(state, created_at, task_id);

CREATE UNIQUE INDEX one_inflight_task_acknowledgement
  ON task_acknowledgements(state)
  WHERE state = 'SENDING';

CREATE TRIGGER task_acknowledgements_legal_state_transition
BEFORE UPDATE OF state ON task_acknowledgements
WHEN NOT (
  (OLD.state IN ('NOT_ATTEMPTED', 'RETRYABLE_DNS') AND NEW.state = 'SENDING') OR
  (OLD.state = 'SENDING' AND NEW.state IN (
    'RETRYABLE_DNS', 'ACKNOWLEDGED', 'AMBIGUOUS', 'FAILED_DEFINITE'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal task acknowledgement state transition');
END;
