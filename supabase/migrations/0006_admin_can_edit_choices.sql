-- An admin could always change where someone SERVES, but never what they ASKED
-- FOR. That gap bites hardest right after an option is removed: everyone who had
-- it as a 2nd choice is left with no backup at all, and there was no way to give
-- them a new one. It equally covers the everyday cases — someone rings up and
-- changes their mind, or the wrong option was tapped at sign-up.
--
-- Editing choices deliberately does NOT move anyone. Where they serve stays put
-- until an admin moves them, so a correction to the record can never quietly
-- take someone's place away.

create or replace function public._set_prefs(p_reg uuid, p_p1 text, p_p2 text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_reg registrations%rowtype;
  v_ts numeric := floor(extract(epoch from now()) * 1000);
  v_p2 text := nullif(p_p2, '');
  v_old text;
  v_new text;
begin
  select * into v_reg from registrations where id = p_reg;
  if not found or v_reg.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  -- Both must be options that still run on this person's Saturday.
  if not exists (select 1 from event_options
      where id = p_p1 and date_id = v_reg.date_id and removed_at is null) then
    return jsonb_build_object('ok', false, 'error', 'Pick a 1st choice from this Saturday.');
  end if;
  if v_p2 is not null then
    if v_p2 = p_p1 then
      return jsonb_build_object('ok', false, 'error', '1st and 2nd choice must be different.');
    end if;
    if not exists (select 1 from event_options
        where id = v_p2 and date_id = v_reg.date_id and removed_at is null) then
      return jsonb_build_object('ok', false, 'error', 'Pick a 2nd choice from this Saturday.');
    end if;
  end if;

  if p_p1 = v_reg.p1 and v_p2 is not distinct from v_reg.p2 then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  v_old := coalesce((select name from event_options where id = v_reg.p1), '?')
    || ' / ' || coalesce((select name from event_options where id = v_reg.p2), 'none');
  v_new := coalesce((select name from event_options where id = p_p1), '?')
    || ' / ' || coalesce((select name from event_options where id = v_p2), 'none');

  update registrations set
    p1 = p_p1,
    p2 = v_p2,
    -- their old queue position was for a choice they no longer hold
    wl_rank = case when p_p1 = v_reg.p1 then wl_rank
                   else coalesce(wl_rank, '{}'::jsonb) - v_reg.p1 end,
    -- an earlier "we moved them on purpose" no longer describes anything, and
    -- keeping it would hide their new 1st choice from the placing banner
    placed_by_admin = false,
    history = history || jsonb_build_array(jsonb_build_object('ts', v_ts, 'text',
      'Admin changed their choices: ' || v_old || ' → ' || v_new || '. Where they serve is unchanged.'))
  where id = v_reg.id;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke execute on function public._set_prefs(uuid, text, text) from public, anon, authenticated;

-- admin_action gains one branch; everything else is unchanged from 0005.
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

  elsif p_action = 'set_prefs' then
    return _set_prefs((p->>'reg')::uuid, p->>'p1', p->>'p2');

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
    -- Retires it on the spot. Anyone attached is flagged, not moved.
    return _retire_option(p->>'opt');

  elsif p_action = 'rehome' then
    -- The unhurried half, run from the Dashboard whenever the admin is ready.
    return _rehome(p->>'opt', p->'moves');

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
