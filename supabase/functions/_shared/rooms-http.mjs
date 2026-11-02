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
import { CORS_HEADERS, errorResponse, jsonResponse, preflightResponse, readJsonObject } from './http.mjs';

export { CORS_HEADERS };

/**
 * createRoomsHandler({ service, authenticate, log? }) → (request) => Promise<Response>
 *   authenticate(request) → user id (uuid) or null. It must verify the token (e.g. supabase.auth.getUser).
 */
export function createRoomsHandler({ service, authenticate, log = console }) {
  return async function handleRoomsRequest(request) {
    if (request.method === 'OPTIONS') return preflightResponse();
    if (request.method !== 'POST') return errorResponse(405, 'INVALID_INPUT', 'Use POST');
    try {
      const userId = await authenticate(request);
      if (!userId) return errorResponse(401, 'UNAUTHORIZED', 'Sign in first');

      const { body, response } = await readJsonObject(request);
      if (response) return response;
      if (typeof body.action !== 'string') {
        return errorResponse(400, 'INVALID_INPUT', 'Request body must be an object with an "action"');
      }

      const { action, ...input } = body;
      const result = await service.run(userId, action, input);
      if (result.ok) return jsonResponse(200, result.data);
      return jsonResponse(ERROR_STATUS[result.error.code] || 400, { error: result.error });
    } catch (err) {
      log.error('rooms: unexpected error', err);
      return errorResponse(500, 'INTERNAL', 'Something went wrong, please try again');
    }
  };
}
