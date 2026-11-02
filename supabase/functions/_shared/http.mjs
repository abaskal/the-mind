/**
 * HTTP helpers shared by the Edge Functions (standard Request/Response, runtime-agnostic).
 * CORS allows any origin: auth is a bearer token, there are no cookies.
 */
export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
});

export const MAX_BODY_BYTES = 4096;

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS, headers),
  });
}

export const errorResponse = (status, code, message, headers) => jsonResponse(status, { error: { code, message } }, headers);

export const preflightResponse = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** → { body } with the parsed JSON object, or { response } with the 4xx to send back. */
export async function readJsonObject(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { response: errorResponse(413, 'INVALID_INPUT', 'Request body is too large') };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: errorResponse(400, 'INVALID_INPUT', 'Request body must be JSON') };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { response: errorResponse(400, 'INVALID_INPUT', 'Request body must be a JSON object') };
  }
  return { body };
}
