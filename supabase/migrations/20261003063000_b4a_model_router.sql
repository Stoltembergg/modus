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
-- Settlement / release reuse private.settle_usage (B1): settling with 0
-- credits gives the whole reservation back.

create table public.router_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
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

revoke all on function private.router_claim_request(uuid, text, text) from public, anon, authenticated;
revoke all on function private.router_reserve(uuid, text, bigint, integer, interval) from public, anon, authenticated;
grant execute on function private.router_claim_request(uuid, text, text) to service_role;
grant execute on function private.router_reserve(uuid, text, bigint, integer, interval) to service_role;
