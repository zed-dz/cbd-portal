-- The 2026/27 Schedule of Rates uses two units and two categories the original
-- rate-card constraints didn't allow, so copying the default card onto a new
-- client failed with client_rate_cards_category_check on the first floatage row:
--   categories  + floatage (mobilisation / demob) , surcharge (regional %)
--   units       + 'each way' (floatage)           , '%'       (surcharge)
--
-- Note the existing list spells the area/volume units 'm2' / 'm3' (ASCII), NOT
-- 'm²' / 'm³' — keep it that way or saves fail the check.

alter table public.client_rate_cards drop constraint if exists client_rate_cards_category_check;
alter table public.client_rate_cards add constraint client_rate_cards_category_check
  check (category is null or category = any (array[
    'labour','plant','materials','attachments','allowances','floatage','surcharge','other'
  ]));

alter table public.client_rate_cards drop constraint if exists client_rate_cards_uom_check;
alter table public.client_rate_cards add constraint client_rate_cards_uom_check
  check (uom = any (array[
    'hour','shift','day','ton','unit','km','m3','m2','lm','each','each way','%'
  ]));

-- Hold the default card to the same rules, so a bad row can't be created there
-- and only blow up later at copy time (which is how this was found).
alter table public.default_rate_card drop constraint if exists default_rate_card_category_check;
alter table public.default_rate_card add constraint default_rate_card_category_check
  check (category is null or category = any (array[
    'labour','plant','materials','attachments','allowances','floatage','surcharge','other'
  ]));

alter table public.default_rate_card drop constraint if exists default_rate_card_uom_check;
alter table public.default_rate_card add constraint default_rate_card_uom_check
  check (uom = any (array[
    'hour','shift','day','ton','unit','km','m3','m2','lm','each','each way','%'
  ]));
