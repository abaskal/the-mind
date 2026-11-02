/**
 * HTTP layer of the `rooms` Edge Function (MIND-03), runtime-agnostic (standard Request/Response).
 *
 *   POST  Authorization: Bearer <user access token>   Content-Type: application/json
 *         { "action": "create" | "join" | "leave" | "setVariant", ...input }
 *   200   { ...data }
 *   4xx   { "error": { "code", "message", ...extra } }   (codes: see ERROR_STATUS in rooms-rules.mjs)
 *   500   { "error": { "code": "INTERNAL", "message" } }
 *   OPTIONS → 204 with CORS headers. CORS allows any origin: auth is a bearer token, there are no cookies.
 */
import { ERROR_STATUS } from './rooms-rules.mjs';

export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
});

const MAX_BODY_BYTES = 4096;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
  });
}

const errorResponse = (status, code, message) => json(status, { error: { code, message } });

/**
 * createRoomsHandler({ service, authenticate, log? }) → (request) => Promise<Response>
 *   authenticate(request) → user id (uuid) or null. It must verify the token (e.g. supabase.auth.getUser).
 */
export function createRoomsHandler({ service, authenticate, log = console }) {
  return async function handleRoomsRequest(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'POST') return errorResponse(405, 'INVALID_INPUT', 'Use POST');
    try {
      const userId = await authenticate(request);
      if (!userId) return errorResponse(401, 'UNAUTHORIZED', 'Sign in first');

      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return errorResponse(413, 'INVALID_INPUT', 'Request body is too large');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse(400, 'INVALID_INPUT', 'Request body must be JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
        return errorResponse(400, 'INVALID_INPUT', 'Request body must be an object with an "action"');
      }

      const { action, ...input } = body;
      const result = await service.run(userId, action, input);
      if (result.ok) return json(200, result.data);
      return json(ERROR_STATUS[result.error.code] || 400, { error: result.error });
    } catch (err) {
      log.error('rooms: unexpected error', err);
      return errorResponse(500, 'INTERNAL', 'Something went wrong, please try again');
    }
  };
}
