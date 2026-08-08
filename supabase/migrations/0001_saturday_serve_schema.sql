-- Saturday Serve registration system
create extension if not exists pgcrypto;

create schema if not exists private;

-- Admin credentials live outside the API-exposed schema
create table private.admin_config (
  id int primary key default 1 check (id = 1),
  passcode text not null,
  export_token text not null
);

create table public.app_config (
  id int primary key default 1 check (id = 1),
  title text not null,
  description text not null,
  reg_prefix text not null default 'SEP',
  next_reg_no int not null default 1
);

create table public.event_dates (
  id text primary key,
  label text not null,
  position int not null default 0
);

-- p1/p2/confirmed on registrations are intentionally not FKs:
-- removing an option keeps it readable in registration history.
create table public.event_options (
  id text primary key,
  date_id text not null references public.event_dates(id) on delete cascade,
  name text not null,
  capacity int not null default 10 check (capacity >= 0),
  position int not null default 0
);

create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  reg_id text not null unique,
  name text not null,
  email text not null,
  mobile text not null,
  nric text not null,
  date_id text not null references public.event_dates(id) on delete cascade,
  p1 text not null,
  p2 text,
  confirmed text,
  status text not null default 'active' check (status in ('active','cancelled')),
  dup_flag text,
  wl_rank jsonb not null default '{}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index registrations_date_idx on public.registrations (date_id);
create index registrations_confirmed_idx on public.registrations (confirmed) where status = 'active';

-- No direct API access to any table: RLS on, no policies. Everything goes
-- through the SECURITY DEFINER functions below.
alter table public.app_config enable row level security;
alter table public.event_dates enable row level security;
alter table public.event_options enable row level security;
alter table public.registrations enable row level security;
revoke all on public.app_config, public.event_dates, public.event_options, public.registrations from anon, authenticated;

-- Waitlist position of a registration for an option (explicit rank first, then submission time)
create or replace function public._wl_pos(p_opt text, p_reg uuid) returns int
language sql security definer set search_path = public, pg_temp as $$
  select pos::int from (
    select id, row_number() over (
      order by coalesce((wl_rank->>p_opt)::int, 1000000), created_at, id
    ) as pos
    from registrations
    where status = 'active' and (p1 = p_opt or p2 = p_opt) and confirmed is distinct from p_opt
  ) t where t.id = p_reg;
$$;

create or replace function public._remaining(p_opt text) returns int
language sql security definer set search_path = public, pg_temp as $$
  select greatest(0, o.capacity - (
    select count(*)::int from registrations r where r.status = 'active' and r.confirmed = o.id
  )) from event_options o where o.id = p_opt;
$$;

-- Public: availability + form content, no PII
create or replace function public.get_public_state() returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'title', (select title from app_config where id = 1),
    'description', (select description from app_config where id = 1),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', o.id, 'name', o.name, 'capacity', o.capacity,
            'confirmed', (select count(*)::int from registrations r where r.status = 'active' and r.confirmed = o.id),
            'waitlist', (select count(*)::int from registrations r where r.status = 'active' and (r.p1 = o.id or r.p2 = o.id) and r.confirmed is distinct from o.id)
          ) order by o.position, o.id)
          from event_options o where o.date_id = d.id
        ), '[]'::jsonb)
      ) order by d.position, d.id)
      from event_dates d
    ), '[]'::jsonb)
  );
$$;

-- Public: submit a registration. Entries: [{date_id, p1, p2}].
-- Serialized with an advisory lock; capacity re-checked at commit time.
create or replace function public.submit_registration(
  p_name text, p_email text, p_mobile text, p_nric text, p_entries jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e jsonb;
  v_name text := trim(p_name);
  v_email text := trim(p_email);
  v_mobile text := trim(p_mobile);
  v_nric text := upper(trim(p_nric));
  v_date record;
  v_dup text;
  v_rem1 int; v_rem2 int;
  v_confirmed text;
  v_n int;
  v_reg_id text;
  v_id uuid;
  v_ts numeric := floor(extract(epoch from now()) * 1000);
  v_regs jsonb := '[]'::jsonb;
  v_o1 record; v_o2 record;
begin
  perform pg_advisory_xact_lock(874512);

  if v_name = '' then return jsonb_build_object('ok', false, 'error', 'Enter your full name.'); end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid email address.');
  end if;
  if v_mobile !~ '^[0-9 +\-]{8,15}$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid mobile number.');
  end if;
  if v_nric !~ '^[A-Z0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'NRIC field must be exactly 4 characters (e.g. 123A).');
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Select preferences for at least one Saturday.');
  end if;

  -- Pass 1: validate every entry before inserting anything
  for e in select * from jsonb_array_elements(p_entries) loop
    select * into v_date from event_dates where id = e->>'date_id';
    if not found then return jsonb_build_object('ok', false, 'error', 'Unknown date.'); end if;

    select * into v_o1 from event_options where id = e->>'p1' and date_id = v_date.id;
    if not found then return jsonb_build_object('ok', false, 'error', v_date.label || ': invalid first preference.'); end if;
    if e->>'p2' is not null then
      select * into v_o2 from event_options where id = e->>'p2' and date_id = v_date.id;
      if not found then return jsonb_build_object('ok', false, 'error', v_date.label || ': invalid second preference.'); end if;
      if v_o2.id = v_o1.id then return jsonb_build_object('ok', false, 'error', v_date.label || ': first and second preference must differ.'); end if;
    end if;

    if exists (
      select 1 from registrations r
      where r.status = 'active' and r.date_id = v_date.id
        and lower(trim(r.email)) = lower(v_email)
    ) then
      return jsonb_build_object('ok', false, 'error', v_date.label || ': this email address already has a registration for this date.');
    end if;

    v_rem1 := _remaining(e->>'p1');
    v_rem2 := case when e->>'p2' is not null then _remaining(e->>'p2') else 0 end;
    if v_rem1 <= 0 and v_rem2 <= 0 then
      return jsonb_build_object('ok', false, 'error',
        v_date.label || ': availability changed while you were reviewing — both of your selected options are now full. Please go back and select at least one option that still has availability.');
    end if;
  end loop;

  -- Pass 2: allocate and insert
  for e in select * from jsonb_array_elements(p_entries) loop
    select * into v_date from event_dates where id = e->>'date_id';
    select * into v_o1 from event_options where id = e->>'p1';
    v_o2 := null;
    if e->>'p2' is not null then select * into v_o2 from event_options where id = e->>'p2'; end if;

    v_dup := null;
    if exists (
      select 1 from registrations r
      where r.status = 'active' and r.date_id = v_date.id
        and (
          (regexp_replace(coalesce(r.mobile,''), '[^0-9]', '', 'g') = regexp_replace(v_mobile, '[^0-9]', '', 'g'))::int
          + (lower(trim(r.nric)) = lower(v_nric))::int
          + (lower(trim(r.name)) = lower(v_name))::int
        ) >= 2
    ) then
      v_dup := 'Matches existing registration on multiple identifiers';
    end if;

    if _remaining(v_o1.id) > 0 then v_confirmed := v_o1.id;
    else v_confirmed := v_o2.id;
    end if;

    update app_config set next_reg_no = next_reg_no + 1 where id = 1
      returning next_reg_no - 1, reg_prefix into v_n, v_reg_id;
    v_reg_id := v_reg_id || '-' || lpad(v_n::text, 6, '0');

    insert into registrations (reg_id, name, email, mobile, nric, date_id, p1, p2, confirmed, dup_flag, history)
    values (
      v_reg_id, v_name, v_email, v_mobile, v_nric, v_date.id, v_o1.id,
      case when v_o2 is null then null else v_o2.id end,
      v_confirmed, v_dup,
      jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Registered. Confirmed ' || (select name from event_options where id = v_confirmed)
        || case when v_confirmed = v_o1.id then ' (1st preference)' else ' (2nd preference — 1st was full)' end || '.'))
    ) returning id into v_id;

    v_regs := v_regs || jsonb_build_object(
      'reg_id', v_reg_id,
      'date_id', v_date.id,
      'date_label', v_date.label,
      'p1', v_o1.id, 'p1_name', v_o1.name,
      'p2', case when v_o2 is null then null else v_o2.id end,
      'p2_name', case when v_o2 is null then null else v_o2.name end,
      'confirmed', v_confirmed,
      'confirmed_name', (select name from event_options where id = v_confirmed),
      'wl_pos', jsonb_strip_nulls(jsonb_build_object(
        'p1', case when v_confirmed <> v_o1.id then _wl_pos(v_o1.id, v_id) else null end,
        'p2', case when v_o2 is not null and v_confirmed <> v_o2.id then _wl_pos(v_o2.id, v_id) else null end
      ))
    );
  end loop;

  return jsonb_build_object('ok', true, 'regs', v_regs);
end;
$$;

-- Admin login check
create or replace function public.admin_check(p_code text) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select exists (select 1 from private.admin_config where passcode = p_code);
$$;

-- Admin: full state including PII (passcode-gated)
create or replace function public.admin_get_state(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from private.admin_config where passcode = p_code) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return jsonb_build_object(
    'ok', true,
    'config', (select jsonb_build_object('title', title, 'description', description) from app_config where id = 1),
    'export_token', (select export_token from private.admin_config where id = 1),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'capacity', o.capacity) order by o.position, o.id)
          from event_options o where o.date_id = d.id
        ), '[]'::jsonb)
      ) order by d.position, d.id)
      from event_dates d
    ), '[]'::jsonb),
    'registrations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'reg_id', r.reg_id, 'name', r.name, 'email', r.email,
        'mobile', r.mobile, 'nric', r.nric, 'date_id', r.date_id,
        'p1', r.p1, 'p2', r.p2, 'confirmed', r.confirmed, 'status', r.status,
        'dup_flag', r.dup_flag, 'wl_rank', r.wl_rank, 'history', r.history,
        'ts', floor(extract(epoch from r.created_at) * 1000)
      ) order by r.created_at desc)
      from registrations r
    ), '[]'::jsonb)
  );
end;
$$;

-- Admin: all mutations, dispatched by action name (passcode-gated)
create or replace function public.admin_action(p_code text, p_action text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reg registrations%rowtype;
  v_target text;
  v_from text;
  v_ts numeric := floor(extract(epoch from now()) * 1000);
  v_id text;
  v_letter text;
  v_ord jsonb;
  i int;
begin
  if not exists (select 1 from private.admin_config where passcode = p_code) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  perform pg_advisory_xact_lock(874512);

  if p_action = 'move' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found or v_reg.confirmed is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    v_target := case when v_reg.confirmed = v_reg.p1 then v_reg.p2 else v_reg.p1 end;
    if v_target is null or _remaining(v_target) <= 0 then return jsonb_build_object('ok', false, 'error', 'target_full'); end if;
    v_from := (select name from event_options where id = v_reg.confirmed);
    update registrations set confirmed = v_target,
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin moved allocation: ' || coalesce(v_from, '(unallocated)') || ' → ' || (select name from event_options where id = v_target) || '. Preferences unchanged.'))
    where id = v_reg.id;

  elsif p_action = 'release' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found or v_reg.confirmed is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    v_from := (select name from event_options where id = v_reg.confirmed);
    update registrations set confirmed = null,
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin released confirmed slot in ' || coalesce(v_from, '?') || '. Now waitlisted on both preferences.'))
    where id = v_reg.id;

  elsif p_action = 'cancel' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    update registrations set status = 'cancelled', confirmed = null,
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text', 'Registration cancelled by admin.'))
    where id = v_reg.id;

  elsif p_action = 'promote' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found or v_reg.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    v_target := p->>'opt';
    if v_target is distinct from v_reg.p1 and v_target is distinct from v_reg.p2 then
      return jsonb_build_object('ok', false, 'error', 'not_a_preference');
    end if;
    if _remaining(v_target) <= 0 then return jsonb_build_object('ok', false, 'error', 'target_full'); end if;
    v_from := case when v_reg.confirmed is null then '(waitlist only)' else (select name from event_options where id = v_reg.confirmed) end;
    update registrations set confirmed = v_target,
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin promoted from waitlist into ' || (select name from event_options where id = v_target) || ' (was ' || v_from || '). Preferences unchanged.'))
    where id = v_reg.id;

  elsif p_action = 'reorder_wl' then
    v_target := p->>'opt';
    v_ord := p->'order';
    if v_ord is null or jsonb_typeof(v_ord) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_order'); end if;
    for i in 0 .. jsonb_array_length(v_ord) - 1 loop
      update registrations
        set wl_rank = jsonb_set(coalesce(wl_rank, '{}'::jsonb), array[v_target], to_jsonb(i))
        where id = (v_ord->>i)::uuid;
    end loop;
    if p->>'moved' is not null then
      update registrations set history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin reordered waitlist position for ' || coalesce((select name from event_options where id = v_target), v_target) || '.'))
      where id = (p->>'moved')::uuid;
    end if;

  elsif p_action = 'set_config' then
    update app_config set
      title = coalesce(p->>'title', title),
      description = coalesce(p->>'description', description)
    where id = 1;

  elsif p_action = 'set_date_label' then
    update event_dates set label = p->>'label' where id = p->>'date';

  elsif p_action = 'remove_date' then
    delete from registrations where date_id = p->>'date';
    delete from event_dates where id = p->>'date';

  elsif p_action = 'add_date' then
    v_id := 'd' || substr(md5(random()::text), 1, 8);
    insert into event_dates (id, label, position)
      values (v_id, 'New Saturday (edit me)', coalesce((select max(position) from event_dates), 0) + 1);
    insert into event_options (id, date_id, name, capacity, position)
      values (v_id || '_' || substr(md5(random()::text), 1, 6), v_id, 'Option A', 10, 1);

  elsif p_action = 'add_option' then
    select count(*)::int into i from event_options where date_id = p->>'date';
    v_letter := chr(65 + i);
    insert into event_options (id, date_id, name, capacity, position)
      values ((p->>'date') || '_' || substr(md5(random()::text), 1, 6), p->>'date', 'Option ' || v_letter, 10, i + 1);

  elsif p_action = 'set_option' then
    update event_options set
      name = coalesce(p->>'name', name),
      capacity = coalesce((p->>'capacity')::int, capacity)
    where id = p->>'opt';

  elsif p_action = 'remove_option' then
    update registrations set confirmed = null where confirmed = p->>'opt';
    delete from event_options where id = p->>'opt';

  elsif p_action = 'set_passcode' then
    if length(coalesce(p->>'passcode', '')) < 8 then
      return jsonb_build_object('ok', false, 'error', 'Passcode must be at least 8 characters.');
    end if;
    update private.admin_config set passcode = p->>'passcode' where id = 1;

  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- CSV export, gated by a separate export token (safe to embed in a Google Sheet)
create or replace function public.export_csv(p_token text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_csv text;
  q text := '"';
begin
  if not exists (select 1 from private.admin_config where export_token = p_token) then
    return null;
  end if;
  select
    'Reg ID,Name,Email,Mobile,NRIC Last 4,Date,1st Preference,2nd Preference,Confirmed Option,Status,Waitlisted For,Duplicate Flag,Registered At (SGT)'
    || coalesce(E'\n' || string_agg(line, E'\n' order by ord), '')
  into v_csv
  from (
    select r.created_at as ord,
      concat_ws(',',
        q || replace(r.reg_id, q, q||q) || q,
        q || replace(r.name, q, q||q) || q,
        q || replace(r.email, q, q||q) || q,
        q || replace(r.mobile, q, q||q) || q,
        q || replace(r.nric, q, q||q) || q,
        q || replace(coalesce(d.label, r.date_id), q, q||q) || q,
        q || replace(coalesce(o1.name, r.p1), q, q||q) || q,
        q || replace(coalesce(o2.name, r.p2, '—'), q, q||q) || q,
        q || replace(coalesce(oc.name, '—'), q, q||q) || q,
        q || r.status || q,
        q || replace(coalesce((
          select string_agg(x.part, ' · ')
          from (
            select coalesce(o1.name, r.p1) || ' (#' || _wl_pos(r.p1, r.id) || ')' as part
            where r.status = 'active' and r.confirmed is distinct from r.p1
            union all
            select coalesce(o2.name, r.p2) || ' (#' || _wl_pos(r.p2, r.id) || ')'
            where r.status = 'active' and r.p2 is not null and r.confirmed is distinct from r.p2
          ) x
        ), ''), q, q||q) || q,
        q || replace(coalesce(r.dup_flag, ''), q, q||q) || q,
        q || to_char(r.created_at at time zone 'Asia/Singapore', 'YYYY-MM-DD HH24:MI') || q
      ) as line
    from registrations r
    left join event_dates d on d.id = r.date_id
    left join event_options o1 on o1.id = r.p1
    left join event_options o2 on o2.id = r.p2
    left join event_options oc on oc.id = r.confirmed
  ) rows;
  return v_csv;
end;
$$;

-- Lock down helpers not meant for direct anonymous use
revoke execute on function public._wl_pos(text, uuid) from anon, authenticated;
revoke execute on function public._remaining(text) from anon, authenticated;
