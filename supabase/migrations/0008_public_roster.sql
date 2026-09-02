-- "What am I doing on the 19th again?"
--
-- People sign up once, in August, and then forget. The confirmation screen is
-- shown exactly once and the email lands in a promotions tab, so by the time the
-- Saturday comes round the honest answer for most volunteers is "I don't know".
-- Until now the only way to find out was to ask an admin to open the dashboard.
--
-- get_roster() is the answer to that question and to nothing else. It is the
-- first public reader that returns anything personal, so the boundary is drawn
-- tightly and on purpose:
--
--   returns   a name, a Saturday, and the activity that person is placed in
--   omits     email, mobile, NRIC, Lifenet, preferences, waitlist position,
--             admin history — everything the CSV and the dashboard carry
--
-- A name next to an activity is what a volunteer needs to recognise themselves,
-- and it is roughly what a printed sign-up sheet on a church noticeboard would
-- show. Contact details are not on a noticeboard, and they are not here. Anyone
-- who can reach the site can read this, so nothing may be added to it that we
-- would not put on that noticeboard.

create or replace function public.get_roster()
returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label)
                       order by d.position, d.id)
      from event_dates d
    ), '[]'::jsonb),
    -- One row per active registration: the frontend groups them by person.
    -- 'opt' is null when an admin has released the slot and not re-placed it;
    -- 'gone' marks a retired option, so the page can say "being reassigned"
    -- instead of naming an activity that is no longer running.
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', r.name,
        'date', r.date_id,
        'opt',  o.name,
        'gone', (o.removed_at is not null)
      ) order by r.name, d.position, d.id)
      from registrations r
      join event_dates d on d.id = r.date_id
      left join event_options o on o.id = r.confirmed
      where r.status = 'active'
    ), '[]'::jsonb)
  );
$function$;

comment on function public.get_roster() is
  'Public, unauthenticated: every active volunteer''s name, Saturday and placed '
  'activity, so people can look up what they signed up for. Deliberately carries '
  'no contact details, no preferences and no admin history — see 0008.';
