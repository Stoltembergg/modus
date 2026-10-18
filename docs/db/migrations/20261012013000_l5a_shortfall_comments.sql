-- L5a: comments only, documenting #199 (Debbie's review); no behaviour change.

comment on column public.credit_lots.shortfall is
  'Credits a reversal of this lot could not take back (delta - take). Two parts: the part still '
  'held by an active reservation at refund time, which moves to credit_wallets.shortfall_owed '
  'and is collected later, and the part already spent, which is never recovered.';

comment on column public.credit_wallets.shortfall_owed is
  'Collectable part only of refund shortfalls: unspent credits of a refunded / charged-back lot '
  'that were held by an active reservation at refund time. Collected (idempotent adjust rows) '
  'from what settle_usage / release_expired_reservations return to the balance, then from Free '
  'top-ups, never more than the top-up. Spent credits are not included (see credit_lots.shortfall).';

comment on function private.process_mp_purchase_payment(jsonb, jsonb, text) is
  'Grants a credit pack payment once (keyed by payment id) and reverses refunds / chargebacks '
  'against that lot only. Immediate deduction takes take = least(delta, remaining, balance) '
  'from the balance. In-flight credits stuck = least(delta - take, remaining - take, reserved) '
  'leave the lot and are added to credit_wallets.shortfall_owed. The reserved term is only a '
  'safety cap: since sum(remaining of credited lots) <= balance + reserved, remaining - take '
  'never exceeds reserved. A full refund / chargeback zeroes the lot.';

comment on function private.collect_shortfall(uuid, text, text, bigint) is
  'Takes least(shortfall_owed, p_available) from the balance with an idempotent adjust ledger '
  'row keyed by p_key. The caller holds the wallet lock and has just added p_available to the '
  'balance, so the balance never goes negative. Returns the amount collected (0 on a repeat).';
