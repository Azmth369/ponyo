-- Disposable-database smoke tests for 20261018_dashboard_control_panel.sql.
\set ON_ERROR_STOP on

DO $$
DECLARE result jsonb;
BEGIN
  result := public.grant_dashboard_access('OWNER@example.com', 'Viewer@example.com', ARRAY[]::text[]);
  IF lower(result->>'email') <> 'viewer@example.com' THEN RAISE EXCEPTION 'grant did not normalize email'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dashboard_audit_log WHERE actor_email='owner@example.com' AND action='access.granted_or_updated' AND target_email='viewer@example.com') THEN
    RAISE EXCEPTION 'grant audit row missing';
  END IF;
  result := public.revoke_dashboard_access('owner@example.com', 'VIEWER@example.com');
  IF result->>'is_active' <> 'false' THEN RAISE EXCEPTION 'revoke did not deactivate access'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dashboard_access WHERE email='viewer@example.com' AND NOT is_active AND cardinality(permissions)=0) THEN
    RAISE EXCEPTION 'revoke did not clear permissions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dashboard_audit_log WHERE action='access.revoked' AND target_email='viewer@example.com') THEN
    RAISE EXCEPTION 'revoke audit row missing';
  END IF;
  IF public.revoke_dashboard_access('owner@example.com', 'missing@example.com') IS NOT NULL THEN
    RAISE EXCEPTION 'revoke of missing row should return null';
  END IF;
END $$;

-- A failed audit insert must roll back the permission grant in the same transaction.
CREATE FUNCTION public.test_fail_dashboard_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'access.granted_or_updated' THEN RAISE EXCEPTION 'intentional audit failure'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_fail_dashboard_grant_audit
BEFORE INSERT ON public.dashboard_audit_log
FOR EACH ROW EXECUTE FUNCTION public.test_fail_dashboard_grant_audit();

DO $$
BEGIN
  BEGIN
    PERFORM public.grant_dashboard_access('owner@example.com', 'atomic@example.com', ARRAY['sync.run']::text[]);
    RAISE EXCEPTION 'grant should have failed because audit insert is blocked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'grant should have failed because audit insert is blocked' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.dashboard_access WHERE email='atomic@example.com') THEN
    RAISE EXCEPTION 'permission grant was not rolled back after audit failure';
  END IF;
END $$;

DROP TRIGGER test_fail_dashboard_grant_audit ON public.dashboard_audit_log;
DROP FUNCTION public.test_fail_dashboard_grant_audit();

DO $$
BEGIN
  IF NOT public.claim_dashboard_sync_lock('test-run-a', 60) THEN RAISE EXCEPTION 'first lock claim failed'; END IF;
  IF public.claim_dashboard_sync_lock('test-run-b', 60) THEN RAISE EXCEPTION 'second owner acquired an occupied lock'; END IF;
  IF public.release_dashboard_sync_lock('test-run-b') THEN RAISE EXCEPTION 'non-owner released the lock'; END IF;
  IF NOT public.release_dashboard_sync_lock('test-run-a') THEN RAISE EXCEPTION 'owner could not release lock'; END IF;
  IF NOT public.claim_dashboard_sync_lock('test-run-b', 60) THEN RAISE EXCEPTION 'lock not available after release'; END IF;
  PERFORM public.release_dashboard_sync_lock('test-run-b');
  IF public.claim_dashboard_sync_lock('   ', 60) THEN RAISE EXCEPTION 'blank lock owner was accepted'; END IF;
END $$;

SELECT 'dashboard migration smoke tests passed' AS result;
