-- Removing a volunteer option used to orphan people.
--
-- registrations.p1/p2/confirmed are plain text with no foreign key, so the old
-- remove_option deleted the row, nulled `confirmed`, and left p1/p2 pointing at
-- an id that no longer existed. Those people showed as NOT PLACED with a raw id
-- like "d1_f3a2b9" where their choice should be — and if the dead option was
-- their 1st choice they read as WAITING FOR 1ST forever, for something that can
-- never be filled.
--
-- Two changes fix it:
--   1. Options are retired, not deleted. Every past reference still resolves to
--      a name — in history, in cancelled registrations, in the CSV.
--   2. Nobody can be left pointing at a retired option. Removing one requires a
--      destination for every active person attached to it, applied in the same
--      transaction as the retirement.

alter table public.event_options
  add column if not exists removed_at timestamptz;

comment on column public.event_options.removed_at is
  'Set when an admin retires this option. It disappears from the form and the '
  'dashboard but the row stays so historical references still resolve to a name.';

-- A retired option has no places, ever — belt and braces against a stale form
-- or a stale admin tab trying to put someone into one.
create or replace function public._remaining(p_opt text)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select case when o.removed_at is not null then 0 else greatest(0, o.capacity - (
    select count(*)::int from registrations r where r.status = 'active' and r.confirmed = o.id
  )) end from event_options o where o.id = p_opt;
$function$;

-- ---------------------------------------------------------------------------
-- The reassignment itself.
--
-- `p_moves` is [{reg, to}] — one entry per active registration touching the
-- option, where `to` is the option they serve in afterwards (null = leave them
-- unplaced). The rule is simply: `to` is where they are now, and any preference
-- that pointed at the retired option is rewritten to `to`. A 2nd preference that
-- collapses onto the 1st is dropped.
--
-- Rewriting the preference (not just the placement) is the important part. Leave
-- p1 pointing at a retired option and the person sits in "waiting for their 1st
-- choice" permanently, in a queue that can never move.
-- ---------------------------------------------------------------------------
create or replace function public._retire_option(p_opt text, p_moves jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_opt event_options%rowtype;
  v_ts numeric := floor(extract(epoch from now()) * 1000);
  v_missing int;
  v_bad text;
  v_full text;
begin
  select * into v_opt from event_options where id = p_opt and removed_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  create temp table _mv on commit drop as
  select (m->>'reg')::uuid as reg, nullif(m->>'to', '') as dest
  from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) m;

  -- Everyone attached to this option must have been given a destination.
  select count(*) into v_missing
  from registrations r
  where r.status = 'active'
    and (r.confirmed = p_opt or r.p1 = p_opt or r.p2 = p_opt)
    and r.id not in (select reg from _mv);
  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'error',
      'Someone attached to this option has no destination — reload the admin page and try again.');
  end if;

  -- Destinations must be a live option on the same Saturday, and never the one
  -- being retired.
  select string_agg(distinct r.name, ', ') into v_bad
  from _mv join registrations r on r.id = _mv.reg
  where _mv.dest is not null and not exists (
    select 1 from event_options o
    where o.id = _mv.dest and o.date_id = r.date_id and o.removed_at is null and o.id <> p_opt
  );
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'Invalid destination for: ' || v_bad);
  end if;

  -- p1 is required, so "leave unplaced" needs a surviving 2nd choice to fall back on.
  select string_agg(r.name, ', ') into v_bad
  from _mv join registrations r on r.id = _mv.reg
  where _mv.dest is null and r.p1 = p_opt and r.p2 is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error',
      'This was the only option chosen by: ' || v_bad || '. Pick where they should serve instead.');
  end if;

  -- Net capacity change per destination, counting the places these same moves
  -- free up along the way.
  select string_agg(o.name || ' (needs ' || dl.d || ', has ' || _remaining(dl.opt) || ')', ', ')
    into v_full
  from (
    select opt, sum(d)::int as d from (
      select _mv.dest as opt, 1 as d from _mv join registrations r on r.id = _mv.reg
        where _mv.dest is not null and r.confirmed is distinct from _mv.dest
      union all
      select r.confirmed as opt, -1 from _mv join registrations r on r.id = _mv.reg
        where r.confirmed is not null and r.confirmed is distinct from _mv.dest
    ) x group by opt
  ) dl
  join event_options o on o.id = dl.opt
  where dl.d > 0 and _remaining(dl.opt) < dl.d;
  if v_full is not null then
    return jsonb_build_object('ok', false, 'error', 'Not enough places in ' || v_full || '.');
  end if;

  with calc as (
    select r.id,
      _mv.dest as new_conf,
      case when r.p1 = p_opt then coalesce(_mv.dest, r.p2) else r.p1 end as new_p1,
      case when r.p2 = p_opt then _mv.dest else r.p2 end as raw_p2
    from _mv join registrations r on r.id = _mv.reg
  )
  update registrations r set
    confirmed = c.new_conf,
    p1 = c.new_p1,
    -- a 2nd choice that has collapsed onto the 1st is no longer a choice
    p2 = case when c.raw_p2 is not distinct from c.new_p1 then null else c.raw_p2 end,
    -- this move was forced by the retirement, not a balancing decision, so it
    -- must not suppress the "can go into their 1st choice" banner later
    placed_by_admin = false,
    wl_rank = coalesce(r.wl_rank, '{}'::jsonb) - p_opt,
    history = r.history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
      '"' || v_opt.name || '" was removed. ' || case
        when c.new_conf is null then 'Left unplaced for this Saturday — needs a call.'
        when c.new_conf = r.confirmed then 'They stay in ' || (select name from event_options where id = c.new_conf) || '.'
        else 'Admin moved them to ' || (select name from event_options where id = c.new_conf) || '.'
      end))
  from calc c where r.id = c.id;

  update event_options set removed_at = now() where id = p_opt;
  return jsonb_build_object('ok', true, 'moved', (select count(*)::int from _mv));
end;
$function$;

revoke execute on function public._retire_option(text, jsonb) from public, anon, authenticated;
revoke execute on function public._remaining(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Callers: retired options must vanish from the form and become unbookable,
-- while still resolving to a name wherever they are referenced.
-- ---------------------------------------------------------------------------

create or replace function public.get_public_state()
returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'title', (select title from app_config where id = 1),
    'description', (select description from app_config where id = 1),
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'label', f.label, 'type', f.type,
        'options', f.options, 'required', f.required, 'placeholder', f.placeholder
      ) order by f.position, f.id)
      from custom_fields f
    ), '[]'::jsonb),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label, 'subtitle', d.subtitle,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', o.id, 'name', o.name, 'capacity', o.capacity,
            'confirmed', (select count(*)::int from registrations r where r.status = 'active' and r.confirmed = o.id),
            'waitlist', (select count(*)::int from registrations r where r.status = 'active' and r.p1 = o.id and r.confirmed is distinct from o.id)
          ) order by o.position, o.id)
          from event_options o where o.date_id = d.id and o.removed_at is null
        ), '[]'::jsonb)
      ) order by d.position, d.id)
      from event_dates d
    ), '[]'::jsonb)
  );
$function$;

-- Retired options stay in the admin payload, flagged, so old registrations and
-- history entries can still show a name instead of a raw id. The dashboard and
-- the settings editor filter them out; name lookup does not.
create or replace function public.admin_get_state(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not exists (select 1 from private.admin_config where passcode = p_code) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return jsonb_build_object(
    'ok', true,
    'config', (select jsonb_build_object('title', title, 'description', description) from app_config where id = 1),
    'export_token', (select export_token from private.admin_config where id = 1),
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'label', f.label, 'type', f.type,
        'options', f.options, 'required', f.required, 'placeholder', f.placeholder
      ) order by f.position, f.id)
      from custom_fields f
    ), '[]'::jsonb),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label, 'subtitle', d.subtitle,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', o.id, 'name', o.name, 'capacity', o.capacity,
            'removed', (o.removed_at is not null)
          ) order by o.position, o.id)
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
        'dup_flag', r.dup_flag, 'wl_rank', r.wl_rank, 'history', r.history, 'extra', r.extra,
        'placed_by_admin', r.placed_by_admin,
        'ts', floor(extract(epoch from r.created_at) * 1000)
      ) order by r.created_at desc)
      from registrations r
    ), '[]'::jsonb)
  );
end;
$function$;

-- A form left open in a tab must not be able to book a retired option: the two
-- lookups in pass 1 now refuse to resolve one. (Only those two lines changed.)
create or replace function public.submit_registration(p_name text, p_email text, p_mobile text, p_nric text, p_entries jsonb, p_extra jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  v_f record;
  v_val text;
  v_extra jsonb := '{}'::jsonb;
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

  -- Custom fields: required-check, dropdown values must be one of the offered options.
  for v_f in select * from custom_fields order by position, id loop
    v_val := trim(coalesce(p_extra->>v_f.id, ''));
    if v_f.required and v_val = '' then
      return jsonb_build_object('ok', false, 'error', v_f.label || ' is required.');
    end if;
    if v_f.type = 'select' and v_val <> '' and not (v_f.options ? v_val) then
      return jsonb_build_object('ok', false, 'error', v_f.label || ': choose one of the listed options.');
    end if;
    if v_val <> '' then
      v_extra := v_extra || jsonb_build_object(v_f.id, left(v_val, 200));
    end if;
  end loop;

  -- Pass 1: validate every entry before inserting anything
  for e in select * from jsonb_array_elements(p_entries) loop
    select * into v_date from event_dates where id = e->>'date_id';
    if not found then return jsonb_build_object('ok', false, 'error', 'Unknown date.'); end if;

    select * into v_o1 from event_options where id = e->>'p1' and date_id = v_date.id and removed_at is null;
    if not found then return jsonb_build_object('ok', false, 'error', v_date.label || ': that option is no longer available — please refresh the page.'); end if;
    if e->>'p2' is not null then
      select * into v_o2 from event_options where id = e->>'p2' and date_id = v_date.id and removed_at is null;
      if not found then return jsonb_build_object('ok', false, 'error', v_date.label || ': that option is no longer available — please refresh the page.'); end if;
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

    insert into registrations (reg_id, name, email, mobile, nric, date_id, p1, p2, confirmed, dup_flag, extra, history)
    values (
      v_reg_id, v_name, v_email, v_mobile, v_nric, v_date.id, v_o1.id,
      case when v_o2 is null then null else v_o2.id end,
      v_confirmed, v_dup, v_extra,
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
$function$;

-- admin_action: 'remove_option' now delegates to _retire_option and carries a
-- destination for every affected person. 'add_option' skips retired options when
-- picking the next letter. Everything else is unchanged from 0003.
create or replace function public.admin_action(p_code text, p_action text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_reg registrations%rowtype;
  v_target text;
  v_from text;
  v_ts numeric := floor(extract(epoch from now()) * 1000);
  v_id text;
  v_letter text;
  v_ord jsonb;
  i int;
  v_n int;
  v_opts jsonb;
  v_type text;
  v_pos int;
  v_swap record;
  v_fld custom_fields%rowtype;
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
      -- moving them off their 1st choice is a deliberate admin call; moving them
      -- back onto it clears the flag again
      placed_by_admin = (v_target is distinct from v_reg.p1),
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin moved allocation: ' || coalesce(v_from, '(unallocated)') || ' → ' || (select name from event_options where id = v_target) || '. Preferences unchanged.'))
    where id = v_reg.id;

  elsif p_action = 'release' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found or v_reg.confirmed is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    v_from := (select name from event_options where id = v_reg.confirmed);
    update registrations set confirmed = null, placed_by_admin = false,
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin released slot in ' || coalesce(v_from, '?') || '. Not placed for this Saturday.'))
    where id = v_reg.id;

  elsif p_action = 'cancel' then
    select * into v_reg from registrations where id = (p->>'reg')::uuid;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    update registrations set status = 'cancelled', confirmed = null, placed_by_admin = false,
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
    v_from := case when v_reg.confirmed is null then '(not placed)' else (select name from event_options where id = v_reg.confirmed) end;
    update registrations set confirmed = v_target,
      placed_by_admin = (v_target is distinct from v_reg.p1),
      history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
        'Admin placed into ' || (select name from event_options where id = v_target) || ' (was ' || v_from || '). Preferences unchanged.'))
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
        'Admin reordered the queue for ' || coalesce((select name from event_options where id = v_target), v_target) || '.'))
      where id = (p->>'moved')::uuid;
    end if;

  elsif p_action = 'set_config' then
    update app_config set
      title = coalesce(p->>'title', title),
      description = coalesce(p->>'description', description)
    where id = 1;

  elsif p_action = 'set_date_label' then
    update event_dates set label = p->>'label' where id = p->>'date';

  elsif p_action = 'set_date_subtitle' then
    update event_dates set subtitle = p->>'subtitle' where id = p->>'date';

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
    select count(*)::int into i from event_options where date_id = p->>'date' and removed_at is null;
    v_letter := chr(65 + i);
    insert into event_options (id, date_id, name, capacity, position)
      values ((p->>'date') || '_' || substr(md5(random()::text), 1, 6), p->>'date', 'Option ' || v_letter, 10, i + 1);

  elsif p_action = 'set_option' then
    update event_options set
      name = coalesce(p->>'name', name),
      capacity = coalesce((p->>'capacity')::int, capacity)
    where id = p->>'opt';

  elsif p_action = 'remove_option' then
    -- Retire it and rehome everyone attached, in this one transaction. See
    -- _retire_option for the rules; the admin supplies p->'moves'.
    return _retire_option(p->>'opt', p->'moves');

  elsif p_action = 'reassign' then
    -- Batch move between options that all still exist — used when a capacity is
    -- lowered below the number of people already confirmed.
    return _reassign(p->'moves', p->>'reason');

  -- ---- Custom registration fields ----
  elsif p_action = 'add_field' then
    v_type := coalesce(p->>'type', 'text');
    if v_type not in ('text', 'select') then return jsonb_build_object('ok', false, 'error', 'bad_type'); end if;
    v_id := 'f_' || substr(md5(random()::text), 1, 10);
    insert into custom_fields (id, label, type, options, required, placeholder, position)
      values (v_id,
        coalesce(nullif(trim(p->>'label'), ''), 'New question (edit me)'),
        v_type,
        case when v_type = 'select' then '["Option 1","Option 2"]'::jsonb else '[]'::jsonb end,
        coalesce((p->>'required')::boolean, true),
        '',
        coalesce((select max(position) from custom_fields), 0) + 1);

  elsif p_action = 'set_field' then
    select * into v_fld from custom_fields where id = p->>'field';
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    v_type := coalesce(p->>'type', v_fld.type);
    if v_type not in ('text', 'select') then return jsonb_build_object('ok', false, 'error', 'bad_type'); end if;
    -- options arrive as a newline-separated string from the admin UI
    if p ? 'options_text' then
      select coalesce(jsonb_agg(t), '[]'::jsonb) into v_opts
      from (select trim(x) as t from unnest(string_to_array(p->>'options_text', E'\n')) x where trim(x) <> '') s;
    else
      v_opts := v_fld.options;
    end if;
    if v_type = 'select' and jsonb_array_length(v_opts) = 0 then
      return jsonb_build_object('ok', false, 'error', 'A dropdown needs at least one choice.');
    end if;
    update custom_fields set
      label = coalesce(nullif(trim(p->>'label'), ''), label),
      type = v_type,
      options = case when v_type = 'select' then v_opts else '[]'::jsonb end,
      required = coalesce((p->>'required')::boolean, required),
      placeholder = coalesce(p->>'placeholder', placeholder)
    where id = v_fld.id;

  elsif p_action = 'remove_field' then
    -- Existing answers are kept on the registrations for the record; the
    -- question just stops being asked and stops appearing in the CSV.
    delete from custom_fields where id = p->>'field';

  elsif p_action = 'move_field' then
    select * into v_fld from custom_fields where id = p->>'field';
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if (p->>'dir') = 'up' then
      select * into v_swap from custom_fields
        where (position, id) < (v_fld.position, v_fld.id) order by position desc, id desc limit 1;
    else
      select * into v_swap from custom_fields
        where (position, id) > (v_fld.position, v_fld.id) order by position, id limit 1;
    end if;
    if not found then return jsonb_build_object('ok', true); end if;
    v_pos := v_fld.position;
    update custom_fields set position = v_swap.position where id = v_fld.id;
    update custom_fields set position = v_pos where id = v_swap.id;
    -- equal positions would leave the order ambiguous, so nudge them apart
    if v_swap.position = v_pos then
      update custom_fields set position = v_pos + 1 where id = v_swap.id;
    end if;

  elsif p_action = 'set_passcode' then
    if length(coalesce(p->>'passcode', '')) < 8 then
      return jsonb_build_object('ok', false, 'error', 'Passcode must be at least 8 characters.');
    end if;
    update private.admin_config set passcode = p->>'passcode' where id = 1;

  elsif p_action = 'clear_registrations' then
    select count(*)::int into v_n from registrations;
    delete from registrations;
    update app_config set next_reg_no = 1 where id = 1;
    return jsonb_build_object('ok', true, 'deleted', v_n);

  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;
