// `room-action` Edge Function (MIND-04): gameplay actions, judged by the shared rules engine on the server (I1).
// This entry point only wires the engine, auth and the database; the pipeline lives in ../_shared/ and is tested
// in Node. The engine copy in ../_shared/ is kept identical to engine/mind-engine.js by `npm run sync-engine` (I4).
// All secrets come from the function's environment, which Supabase provides; nothing is hardcoded.
import '../_shared/mind-engine.js';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createRoomActionService } from '../_shared/room-action.mjs';
import { createRpcRoomActionRepo } from '../_shared/room-action-rpc-repo.mjs';
import { createRoomActionHandler } from '../_shared/room-action-http.mjs';

// deno-lint-ignore no-explicit-any
const Mind = (globalThis as any).Mind;
if (!Mind || typeof Mind.MindEngine !== 'function') throw new Error('The rules engine did not load');

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// The service-role client calls the two service-role-only SQL functions (I3) and verifies user tokens.
const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function authenticate(request: Request): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) return null;
  const { data, error } = await supabase.auth.getUser(match[1]);
  return error || !data.user ? null : data.user.id;
}

Deno.serve(createRoomActionHandler({
  service: createRoomActionService({ repo: createRpcRoomActionRepo(supabase), Mind }),
  authenticate,
}));
