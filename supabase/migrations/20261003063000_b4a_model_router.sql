-- B4a: model-router support. Two service_role-only RPCs and one table:
--
-- 1. public.router_requests: one row per (user_id, Idempotency-Key) the router
--    has ever accepted, with the sha256 of the raw request body. Written by
--    private.router_claim_request BEFORE anything else happens to the request
--    (model / plan checks, reservation), so a repeated key is ALWAYS a 409:
--    same body -> idempotency_replay, different body -> idempotency_conflict,
--    whatever the first attempt ended with (403, 402, 503, success...).
--    No user access at all (RLS on, no policy, no client grants).
-- 2. private.router_claim_request(user, key, body_sha256): claims the key.
-- 3. private.router_reserve(user, request_id, amount, max_active, ttl):
--    reserve_credits plus a cap on concurrent active reservations per user
--    (P0429 -> 429 too_many_requests). Same lock order as every credit RPC:
--    the wallet row first (FOR UPDATE), so the count and the reservation are
--    serialized per user.
-- 4. private.router_store_cost(user, key, credits, model, provider, tokens):
--    when the router computed a cost but private.settle_usage kept failing
--    (2 retries), it stores that cost on the router_requests row.
-- 5. private.release_expired_reservations (B1) is replaced: an expired active
--    reservation whose router_requests row carries a stored cost is SETTLED
--    by that cost (capped at the reservation, 'settle' ledger row, 'billed'
--    usage row) instead of refunded; with no stored cost it is refunded
--    exactly as before. Signature, lock order and return value unchanged.
-- Settlement / release reuse private.settle_usage (B1): settling with 0
-- credits gives the whole reservation back.

create table public.router_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  -- Cost the router computed but could not settle (see router_store_cost);
  -- the expiry sweep charges it. NULL = nothing stored (sweep refunds).
  settle_credits bigint check (settle_credits >= 0),
  settle_model text,
  settle_provider text,
  settle_input_tokens integer check (settle_input_tokens >= 0),
  settle_output_tokens integer check (settle_output_tokens >= 0),
  settle_stored_at timestamptz,
  primary key (user_id, idempotency_key),
  check (settle_credits is null or (settle_model is not null and settle_provider is not null))
);

alter table public.router_requests enable row level security;
-- RLS on, no policy: only service_role (BYPASSRLS) reads or writes it.
revoke all on table public.router_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.router_requests to service_role;

create function private.router_claim_request(
  p_user_id uuid,
  p_idempotency_key text,
  p_body_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
begin
  if p_user_id is null or p_idempotency_key is null or p_body_sha256 is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,200}$'
     or p_body_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid router request arguments' using errcode = '22023';
  end if;

  -- A concurrent claim of the same key waits here for the first one to
  -- commit and then sees its row.
  insert into public.router_requests (user_id, idempotency_key, body_sha256)
  values (p_user_id, p_idempotency_key, p_body_sha256)
  on conflict (user_id, idempotency_key) do nothing;
  if found then
    return jsonb_build_object('code', 'claimed');
  end if;

  select rr.body_sha256 into v_existing
    from public.router_requests rr
   where rr.user_id = p_user_id and rr.idempotency_key = p_idempotency_key;
  return jsonb_build_object(
    'code', case when v_existing = p_body_sha256 then 'idempotency_replay'
                 else 'idempotency_conflict' end);
end;
$$;

create function private.router_reserve(
  p_user_id uuid,
  p_request_id text,
  p_amount bigint,
  p_max_active integer default 4,
  p_ttl interval default interval '15 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active integer;
begin
  if p_user_id is null or p_request_id is null or p_max_active is null or p_max_active < 1 then
    raise exception 'invalid router reservation arguments' using errcode = '22023';
  end if;

  perform 1 from public.credit_wallets w where w.user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0404';
  end if;
  perform private.release_expired_reservations(p_user_id);

  select count(*) into v_active
    from public.credit_reservations r
   where r.user_id = p_user_id and r.status = 'active';
  if v_active >= p_max_active then
    raise exception 'too many active reservations'
      using errcode = 'P0429',
            detail = format('active %s, limit %s', v_active, p_max_active);
  end if;

  return private.reserve_credits(p_user_id, p_request_id, p_amount, p_ttl);
end;
$$;

create function private.router_store_cost(
  p_user_id uuid,
  p_idempotency_key text,
  p_credits bigint,
  p_model text,
  p_provider text,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_idempotency_key is null or p_credits is null or p_credits < 0
     or p_model is null or p_provider is null then
    raise exception 'invalid router cost arguments' using errcode = '22023';
  end if;
  update public.router_requests rr
     set settle_credits = p_credits,
         settle_model = p_model,
         settle_provider = p_provider,
         settle_input_tokens = greatest(coalesce(p_input_tokens, 0), 0),
         settle_output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
         settle_stored_at = now()
   where rr.user_id = p_user_id and rr.idempotency_key = p_idempotency_key;
  return found;
end;
$$;

-- B1's sweep, plus: a stored router cost settles the reservation instead of
-- refunding it. Everything else (lock order wallet -> reservations, refunds,
-- 'expire:<request_id>' ledger keys, return count) is unchanged.
create or replace function private.release_expired_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[];
  v_user uuid;
  v_res record;
  v_cost bigint;
  v_count integer := 0;
begin
  if p_user_id is not null then
    v_users := array[p_user_id];
  else
    select coalesce(array_agg(distinct r.user_id order by r.user_id), array[]::uuid[])
      into v_users
      from public.credit_reservations r
     where r.status = 'active' and r.expires_at <= now();
  end if;

  foreach v_user in array v_users loop
    perform 1 from public.credit_wallets w where w.user_id = v_user for update;
    if not found then
      continue;
    end if;
    for v_res in
      select r.id, r.request_id, r.amount, rr.settle_credits, rr.settle_model,
             rr.settle_provider, rr.settle_input_tokens, rr.settle_output_tokens
        from public.credit_reservations r
        left join public.router_requests rr
          on rr.user_id = r.user_id and rr.idempotency_key = r.request_id
       where r.user_id = v_user
         and r.status = 'active'
         and r.expires_at <= now()
       order by r.created_at, r.id
         for update of r
    loop
      if v_res.settle_credits is not null then
        v_cost := least(v_res.settle_credits, v_res.amount);
        update public.credit_reservations r
           set status = 'settled', settled_amount = v_cost, settled_at = now()
         where r.id = v_res.id;
        update public.credit_wallets w
           set balance = w.balance + (v_res.amount - v_cost),
               reserved = w.reserved - v_res.amount,
               updated_at = now()
         where w.user_id = v_user;
        insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
        values (v_user, v_res.amount - v_cost, 'settle', 'settle:' || v_res.request_id, v_res.request_id)
        on conflict (user_id, idempotency_key) do nothing;
        insert into public.usage_events
          (user_id, request_id, model, provider, input_tokens, output_tokens, credits, status)
        values (v_user, v_res.request_id, v_res.settle_model, v_res.settle_provider,
                coalesce(v_res.settle_input_tokens, 0), coalesce(v_res.settle_output_tokens, 0),
                v_cost, 'billed')
        on conflict (user_id, request_id) do nothing;
      else
        update public.credit_reservations r
           set status = 'expired', settled_at = now()
         where r.id = v_res.id;
        update public.credit_wallets w
           set balance = w.balance + v_res.amount,
               reserved = w.reserved - v_res.amount,
               updated_at = now()
         where w.user_id = v_user;
        insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
        values (v_user, v_res.amount, 'refund', 'expire:' || v_res.request_id, v_res.request_id)
        on conflict (user_id, idempotency_key) do nothing;
      end if;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.router_claim_request(uuid, text, text) from public, anon, authenticated;
revoke all on function private.router_reserve(uuid, text, bigint, integer, interval) from public, anon, authenticated;
grant execute on function private.router_claim_request(uuid, text, text) to service_role;
grant execute on function private.router_reserve(uuid, text, bigint, integer, interval) to service_role;
revoke all on function private.router_store_cost(uuid, text, bigint, text, text, integer, integer) from public, anon, authenticated;
grant execute on function private.router_store_cost(uuid, text, bigint, text, text, integer, integer) to service_role;
-- create or replace keeps the B1 grants of release_expired_reservations; restated.
revoke all on function private.release_expired_reservations(uuid) from public, anon, authenticated;
grant execute on function private.release_expired_reservations(uuid) to service_role;
