-- Internal helpers are only called from other SECURITY DEFINER functions;
-- remove the default PUBLIC execute grant so they are not exposed via the API.
revoke execute on function public._wl_pos(text, uuid) from public, anon, authenticated;
revoke execute on function public._remaining(text) from public, anon, authenticated;
