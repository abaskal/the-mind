/**
 * HTTP layer of the `room-action` Edge Function (MIND-04), runtime-agnostic (standard Request/Response).
 *
 *   POST  Authorization: Bearer <user access token>   Content-Type: application/json
 *         { "roomId", "type": "start" | "handDown" | "play" | … , ...input }
 *   200   { ok: true, version, serverNow, nextDeadlineAt, status, view, events }
 *   4xx   { "error": { "code", "message" }, ...extra }   (INVALID_MOVE adds view, version, serverNow, nextDeadlineAt)
 *   500   { "error": { "code": "INTERNAL", "message" } }
 * Every response carries Server-Timing (load, engine, commit, total in ms) and CORS headers.
 */
import { errorResponse, jsonResponse, preflightResponse, readJsonObject } from './http.mjs';

const TIMING_HEADERS = Object.freeze({
  'Access-Control-Expose-Headers': 'Server-Timing',
  'Timing-Allow-Origin': '*',
});

const defaultTimer = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

export function serverTimingHeader(timing) {
  return Object.entries(timing).map(([name, ms]) => `${name};dur=${Math.max(0, ms).toFixed(1)}`).join(', ');
}

/**
 * createRoomActionHandler({ service, authenticate, log?, timer? }) → (request) => Promise<Response>
 *   authenticate(request) → user id (uuid) or null. It must verify the token (e.g. supabase.auth.getUser).
 */
export function createRoomActionHandler({ service, authenticate, log = console, timer = defaultTimer }) {
  return async function handleRoomActionRequest(request) {
    const started = timer();
    const headers = (timing = {}) => Object.assign(
      { 'Server-Timing': serverTimingHeader(Object.assign({}, timing, { total: timer() - started })) },
      TIMING_HEADERS,
    );
    if (request.method === 'OPTIONS') return preflightResponse();
    if (request.method !== 'POST') return errorResponse(405, 'INVALID_INPUT', 'Use POST', headers());
    try {
      const userId = await authenticate(request);
      if (!userId) return errorResponse(401, 'UNAUTHORIZED', 'Sign in first', headers());

      const { body, response } = await readJsonObject(request);
      if (response) return response;

      const result = await service.run(userId, body);
      return jsonResponse(result.status, result.body, headers(result.timing));
    } catch (err) {
      log.error('room-action: unexpected error', err);
      return errorResponse(500, 'INTERNAL', 'Something went wrong, please try again', headers());
    }
  };
}
