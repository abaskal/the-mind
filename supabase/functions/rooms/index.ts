// `rooms` Edge Function (MIND-03): lobby actions create, join, leave, setVariant.
// This entry point only wires auth and Postgres; the rules live in ../_shared/ and are tested in Node.
// All secrets come from the function's environment, which Supabase provides; nothing is hardcoded.
import postgres from 'npm:postgres@3.4.9';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createRoomsService } from '../_shared/rooms-rules.mjs';
import { createPostgresRoomsRepo } from '../_shared/rooms-postgres-repo.mjs';
import { createRoomsHandler } from '../_shared/rooms-http.mjs';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// Deno's DNS resolver, which npm packages use, rejects '_' in host names. The local Supabase CLI names the
// database container supabase_db_<project>, so such names are resolved through the OS (Deno.connect) instead.
async function connectableDbUrl(raw: string): Promise<string> {
  const url = new URL(raw);
  if (!url.hostname.includes('_')) return raw;
  const conn = await Deno.connect({ hostname: url.hostname, port: Number(url.port || 5432) });
  const ip = (conn.remoteAddr as Deno.NetAddr).hostname;
  conn.close();
  url.hostname = ip.includes(':') ? `[${ip}]` : ip;
  return url.toString();
}

// ROOMS_DB_URL may point at the connection pooler (transaction mode); prepare: false keeps that working.
const sql = postgres(await connectableDbUrl(Deno.env.get('ROOMS_DB_URL') ?? requireEnv('SUPABASE_DB_URL')), {
  prepare: false,
  max: 4,
  idle_timeout: 20,
});

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function authenticate(request: Request): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) return null;
  const { data, error } = await supabase.auth.getUser(match[1]);
  return error || !data.user ? null : data.user.id;
}

Deno.serve(createRoomsHandler({
  service: createRoomsService({ repo: createPostgresRoomsRepo(sql) }),
  authenticate,
}));
