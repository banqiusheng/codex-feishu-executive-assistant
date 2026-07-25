DROP INDEX one_inflight_task_acknowledgement;

CREATE UNIQUE INDEX one_inflight_task_acknowledgement
  ON task_acknowledgements(state)
  WHERE state = 'SENDING';
