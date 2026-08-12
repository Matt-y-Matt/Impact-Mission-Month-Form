-- Placement semantics.
--
-- The old model treated every non-confirmed preference as a waitlist entry, so
-- one person choosing two options produced one "confirmed" and one "waitlisted"
-- row. Six volunteers looked like seventeen sign-ups with fifteen people
-- queueing, when in truth only two had missed their first choice.
--
-- The model now is:
--   * a 1st choice you did not get  = a queue position (real, actionable)
--   * a 2nd choice                  = interest, never a queue position
--   * placed_by_admin               = we put them here on purpose
--
-- That last flag exists because moving someone off their first choice for team
-- balancing also frees the slot they left — without the flag the dashboard would
-- immediately suggest undoing our own move, every single refresh.

alter table public.registrations
  add column if not exists placed_by_admin boolean not null default false;

comment on column public.registrations.placed_by_admin is
  'True when an admin deliberately placed this person where they are (team '
  'balancing). Distinguishes it from the system bumping them because their 1st '
  'choice was full. Both leave the person outside their 1st choice; only the '
  'second should be suggested for placing back.';

-- ---------------------------------------------------------------------------
-- A queue for an option = people whose FIRST choice it is and who aren't in it.
-- ---------------------------------------------------------------------------

create or replace function public._wl_pos(p_opt text, p_reg uuid)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select pos::int from (
    select id, row_number() over (
      order by coalesce((wl_rank->>p_opt)::int, 1000000), created_at, id
    ) as pos
    from registrations
    where status = 'active' and p1 = p_opt and confirmed is distinct from p_opt
  ) t where t.id = p_reg;
$function$;

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
          from event_options o where o.date_id = d.id
        ), '[]'::jsonb)
      ) order by d.position, d.id)
      from event_dates d
    ), '[]'::jsonb)
  );
$function$;

-- ---------------------------------------------------------------------------
-- admin_get_state: expose the flag so the dashboard can explain itself.
-- ---------------------------------------------------------------------------

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
        'dup_flag', r.dup_flag, 'wl_rank', r.wl_rank, 'history', r.history, 'extra', r.extra,
        'placed_by_admin', r.placed_by_admin,
        'ts', floor(extract(epoch from r.created_at) * 1000)
      ) order by r.created_at desc)
      from registrations r
    ), '[]'::jsonb)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- admin_action: maintain the flag on every action that moves someone.
--   move / promote → placed_by_admin = (target <> p1); moving them back clears it
--   release / cancel / remove_option → false
-- Only the branches that changed are annotated; the rest is unchanged from 0001.
-- ---------------------------------------------------------------------------

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
    update registrations set confirmed = null, placed_by_admin = false where confirmed = p->>'opt';
    delete from event_options where id = p->>'opt';

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

-- ---------------------------------------------------------------------------
-- export_csv: "Waitlisted For" was true of every second choice and therefore
-- told us nothing. Three plain-English columns replace it.
--   Placement:   Got 1st choice | Waiting for 1st choice | Not placed | Cancelled
--   Waiting For: the option they are still hoping for, blank if none
--   Note:        1st choice was full at sign-up | Moved here by an admin
--                | Slot released by an admin
-- ---------------------------------------------------------------------------

create or replace function public.export_csv(p_token text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_csv text;
  v_extra_head text;
  q text := '"';
begin
  if not exists (select 1 from private.admin_config where export_token = p_token) then
    return null;
  end if;

  select string_agg(q || replace(f.label, q, q||q) || q, ',' order by f.position, f.id)
    into v_extra_head from custom_fields f;

  select
    'Reg ID,Name,Email,Mobile,NRIC Last 4'
    || case when v_extra_head is null then '' else ',' || v_extra_head end
    || ',Date,1st Choice,2nd Choice,Serving In,Placement,Waiting For,Note,Status,Duplicate Flag,Registered At (SGT)'
    || coalesce(E'\n' || string_agg(line, E'\n' order by ord), '')
  into v_csv
  from (
    select r.created_at as ord,
      concat_ws(',',
        q || replace(r.reg_id, q, q||q) || q,
        q || replace(r.name, q, q||q) || q,
        q || replace(r.email, q, q||q) || q,
        q || replace(r.mobile, q, q||q) || q,
        q || replace(r.nric, q, q||q) || q
      )
      || coalesce(',' || (
        select string_agg(q || replace(coalesce(r.extra->>f.id, ''), q, q||q) || q, ',' order by f.position, f.id)
        from custom_fields f
      ), '')
      || ',' || concat_ws(',',
        q || replace(coalesce(d.label, r.date_id), q, q||q) || q,
        q || replace(coalesce(o1.name, r.p1), q, q||q) || q,
        q || replace(coalesce(o2.name, r.p2, '—'), q, q||q) || q,
        q || replace(coalesce(oc.name, '—'), q, q||q) || q,
        q || (case
                when r.status <> 'active' then 'Cancelled'
                when r.confirmed is null then 'Not placed'
                when r.confirmed = r.p1 then 'Got 1st choice'
                else 'Waiting for 1st choice'
              end) || q,
        q || (case
                when r.status = 'active' and r.confirmed is distinct from r.p1
                  then replace(coalesce(o1.name, r.p1), q, q||q)
                else ''
              end) || q,
        q || (case
                when r.status <> 'active' then ''
                when r.confirmed = r.p1 then ''
                when r.placed_by_admin then 'Moved here by an admin'
                when r.confirmed is null then 'Slot released by an admin'
                else '1st choice was full at sign-up'
              end) || q,
        q || r.status || q,
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
$function$;
