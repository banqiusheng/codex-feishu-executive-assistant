ALTER TABLE control_events
  ADD COLUMN external_effects_pending INTEGER NOT NULL DEFAULT 0
  CHECK (external_effects_pending IN (0, 1));

CREATE UNIQUE INDEX one_replacement_per_interrupted_task
  ON tasks(resumed_from_task_id)
  WHERE task_kind = 'RESUME';
