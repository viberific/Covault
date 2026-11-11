-- Migration: a refunded purchase is not part of what a partner spent.
--
-- partner_month_summary is what a phone is given when its partner shares a
-- total, or category totals, instead of their purchases. It added up every
-- amount for the month, including purchases the capture pipeline had marked
-- `refunded` — money that came back. The app counts those as nothing
-- everywhere else (countedAmount in app/lib/transactions/refundMatching.ts),
-- so the household balance on the partner's phone was lower than the one on
-- the phone of the person who made the return, by the size of the refund.
--
-- The only change is `AND t.refunded = false` in both branches. Arguments,
-- return shape, security and grants are as they were.
--
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.partner_month_summary(p_month text)
 RETURNS TABLE(share_level text, budget text, total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_partner uuid; v_level text;
BEGIN
  IF p_month IS NULL OR p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Month must look like 2026-09';
  END IF;
  v_partner := public.linked_partner_id();
  IF v_partner IS NULL THEN RETURN; END IF;
  v_level := public.partner_share_level();
  IF v_level IS NULL OR v_level = 'transactions' THEN RETURN; END IF;
  IF v_level = 'categories' THEN
    RETURN QUERY
      SELECT v_level, t.budget::text, SUM(t.amount)::numeric
        FROM public.transactions t
       WHERE t.user_id = v_partner AND to_char(t.date, 'YYYY-MM') = p_month AND t.is_projected = false AND t.refunded = false
       GROUP BY t.budget;
  ELSE
    RETURN QUERY
      SELECT v_level, NULL::text, COALESCE(SUM(t.amount), 0)::numeric
        FROM public.transactions t
       WHERE t.user_id = v_partner AND to_char(t.date, 'YYYY-MM') = p_month AND t.is_projected = false AND t.refunded = false;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_month_summary(p_month text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_month_summary(p_month text) TO authenticated, service_role;
