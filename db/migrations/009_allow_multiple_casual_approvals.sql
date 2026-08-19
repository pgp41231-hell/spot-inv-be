-- Approvers may approve another casual request while a student still has an
-- active issue. The one-at-a-time rule is enforced when custody is handed over
-- at the kiosk, not while committee members are clearing the approval queue.
DROP INDEX IF EXISTS one_active_casual_issue_per_student;

CREATE UNIQUE INDEX one_active_casual_issue_per_student
  ON equipment_requests(requester_id)
  WHERE request_type='CASUAL' AND status IN ('ISSUED','RETURN_PENDING');
