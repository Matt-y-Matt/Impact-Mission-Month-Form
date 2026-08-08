// CSV export endpoint for Saturday Serve.
// Auth: requires ?code=<export_token> which is checked against private.admin_config
// inside the export_csv() SQL function. Designed to be fetched with no headers so
// Google Sheets IMPORTDATA() can pull it directly.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await supabase.rpc("export_csv", { p_token: code });
  if (error) {
    return new Response("Export failed", { status: 500 });
  }
  if (data === null) {
    return new Response("Forbidden: invalid or missing code", { status: 403 });
  }
  return new Response(data, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="saturday-serve-registrations.csv"',
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
