/**
 * Rooms lobby business rules (MIND-03). Runtime-agnostic: no Deno, Node or database APIs, so the same code runs
 * in the `rooms` Edge Function (Postgres repository) and in Node tests (in-memory repository).
 *
 * Repository interface – `repo.transaction(fn)` runs `fn(tx)` atomically and returns its result:
 *   tx.lockUser(userId)                                  serialize all actions of one user
 *   tx.countRateLimitHits(userId, action, windowSeconds) → number of hits inside the window
 *   tx.recordRateLimitHit(userId, action)
 *   tx.findActiveSeat(userId)                            → { roomId, seat, status } in a lobby|playing room, or null
 *   tx.findActiveRoomByCode(code)                        → room in lobby|playing with this code, or null
 *   tx.lockRooms(roomIds)                                → rooms, locked in id order (missing ids are skipped)
 *   tx.getActivePlayer(roomId, userId)                   → player who has not left, or null
 *   tx.listActivePlayers(roomId)                         → players who have not left, earliest joined first
 *   tx.insertRoom({ code, hostId, variant })             → room, or null when an active room already uses the code
 *   tx.insertPlayer({ roomId, userId, seat, nickname })  also re-seats a user whose earlier row here has left_at set
 *   tx.deletePlayer(roomId, userId)
 *   tx.markPlayerLeft(roomId, userId)
 *   tx.updateRoom(room, { hostId?, variant?, status? })  compare-and-swap commit (I6): applies the patch, bumps version
 *                                                        and last_activity_at only while the room still has
 *                                                        room.version, else throws RoomVersionConflictError
 *   tx.appendEvent(roomId, type, payload)                → seq
 * room = { id, code, hostId, variant, status, version } · player = { roomId, userId, seat, nickname, joinedAt }
 *
 * Every action returns { ok: true, data } or { ok: false, error: { code, message, ...extra } }. Rule violations are
 * returned, not thrown, so the transaction still commits the rate-limit hit of a failed join attempt. A version
 * conflict rolls the whole transaction back and the service runs the action again (at most MAX_CONFLICT_RETRIES).
 */

export const VARIANTS = Object.freeze(['classic', 'reverse', 'blind', 'dual']);
export const ACTIVE_STATUSES = Object.freeze(['lobby', 'playing']);
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const MAX_SEATS = 4;
export const NICKNAME_MAX_LENGTH = 16;
export const MAX_CONFLICT_RETRIES = 3;
export const RATE_LIMITS = Object.freeze({
  create: Object.freeze({ max: 10, windowSeconds: 3600 }),
  join: Object.freeze({ max: 20, windowSeconds: 600 }),
});

export const ERROR_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_NICKNAME: 400,
  UNAUTHORIZED: 401,
  NOT_HOST: 403,
  ROOM_NOT_FOUND: 404,
  NICKNAME_TAKEN: 409,
  ROOM_FULL: 409,
  GAME_IN_PROGRESS: 409,
  ALREADY_IN_GAME: 409,
  RATE_LIMITED: 429,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters, line/paragraph separators and bidi embedding/override/isolate characters.
const NICKNAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

const ok = (data) => ({ ok: true, data });
const fail = (code, message, extra) => ({ ok: false, error: Object.assign({ code, message }, extra) });

export const isUuid = (v) => typeof v === 'string' && UUID_PATTERN.test(v);

/** Player ids in events are seat-based (s0–s3); user ids never appear in event payloads. */
export const seatPlayerId = (seat) => `s${seat}`;

/** Thrown by tx.updateRoom when the room's version changed after it was read (compare-and-swap failed). */
export class RoomVersionConflictError extends Error {
  constructor(roomId) {
    super(`Room ${roomId} was changed concurrently`);
    this.name = 'RoomVersionConflictError';
    this.roomId = roomId;
  }
}

const isVersionConflict = (err) => err != null && err.name === 'RoomVersionConflictError';

/** 6 characters from ROOM_CODE_ALPHABET. 256 is a multiple of 32, so `byte & 31` is uniform. */
export function generateRoomCode(fillRandom = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(6);
  fillRandom(bytes);
  let code = '';
  for (const b of bytes) code += ROOM_CODE_ALPHABET[b & 31];
  return code;
}

/** Case-insensitive; spaces and dashes are ignored. Returns null when it cannot be a room code. */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]+/g, '');
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

/** trim + NFC, then 1–16 characters (code points, like Postgres char_length) and no control characters. */
export function normalizeNickname(input) {
  if (input == null) return fail('INVALID_NICKNAME', 'Choose a nickname of 1–16 characters');
  if (typeof input !== 'string') return fail('INVALID_INPUT', 'nickname must be a string');
  const value = input.trim().normalize('NFC');
  const length = [...value].length;
  if (length < 1 || length > NICKNAME_MAX_LENGTH) return fail('INVALID_NICKNAME', 'Choose a nickname of 1–16 characters');
  if (NICKNAME_FORBIDDEN.test(value)) return fail('INVALID_NICKNAME', 'The nickname contains characters that are not allowed');
  return ok(value);
}

/** Key for "same nickname, ignoring case". Folds the Turkish I/ı/İ/i case pairs together as well. */
export function nicknameKey(nickname) {
  return nickname.toLowerCase().replace(/i\u0307/g, 'i').replace(/ı/g, 'i');
}

function rateLimited(action) {
  const { max, windowSeconds } = RATE_LIMITS[action];
  return fail('RATE_LIMITED', `Too many ${action === 'create' ? 'new rooms' : 'join attempts'}: at most ${max} per ${windowSeconds / 60} minutes`);
}

async function overLimit(tx, userId, action) {
  const { max, windowSeconds } = RATE_LIMITS[action];
  return (await tx.countRateLimitHits(userId, action, windowSeconds)) >= max;
}

const roomNotFound = () => fail('ROOM_NOT_FOUND', 'No open room has this code');
const alreadyInGame = (roomId) => fail('ALREADY_IN_GAME', 'You are already playing in another room', { roomId });

// Lobby leave: the player is removed; the earliest-joined remaining player becomes host; the last one out abandons it.
async function leaveLobby(tx, room, userId) {
  await tx.deletePlayer(room.id, userId);
  const rest = await tx.listActivePlayers(room.id);
  if (!rest.length) await tx.updateRoom(room, { status: 'abandoned' });
  else if (room.hostId === userId) await tx.updateRoom(room, { hostId: rest[0].userId });
  else await tx.updateRoom(room, {});
}

async function create(tx, userId, input) {
  const variant = input.variant == null ? 'classic' : input.variant;
  if (!VARIANTS.includes(variant)) return fail('INVALID_INPUT', `variant must be one of ${VARIANTS.join(', ')}`);
  const nickname = normalizeNickname(input.nickname);
  if (!nickname.ok) return nickname;

  await tx.lockUser(userId);
  if (await overLimit(tx, userId, 'create')) return rateLimited('create');

  const current = await tx.findActiveSeat(userId);
  if (current) {
    const [room] = await tx.lockRooms([current.roomId]);
    if (room && room.status === 'playing') return alreadyInGame(room.id);
    if (room && room.status === 'lobby') await leaveLobby(tx, room, userId);
  }

  let room = null;
  for (let attempt = 0; attempt < this.maxCodeAttempts && !room; attempt++) {
    room = await tx.insertRoom({ code: this.randomCode(), hostId: userId, variant });
  }
  if (!room) throw new Error('No free room code found');
  await tx.insertPlayer({ roomId: room.id, userId, seat: 0, nickname: nickname.data });
  await tx.recordRateLimitHit(userId, 'create');
  return ok({ roomId: room.id, code: room.code, seat: 0 });
}

async function join(tx, userId, input) {
  if (typeof input.code !== 'string') return fail('INVALID_INPUT', 'code must be a string');
  if (input.nickname != null && typeof input.nickname !== 'string') return fail('INVALID_INPUT', 'nickname must be a string');

  await tx.lockUser(userId);
  // Every attempt counts, including unknown codes, so codes cannot be guessed quickly.
  if (await overLimit(tx, userId, 'join')) return rateLimited('join');
  await tx.recordRateLimitHit(userId, 'join');

  const code = normalizeRoomCode(input.code);
  const found = code && (await tx.findActiveRoomByCode(code));
  if (!found) return roomNotFound();

  const current = await tx.findActiveSeat(userId);
  const ids = current && current.roomId !== found.id ? [found.id, current.roomId] : [found.id];
  const locked = await tx.lockRooms(ids);
  const target = locked.find((r) => r.id === found.id);
  if (!target || !ACTIVE_STATUSES.includes(target.status) || target.code !== code) return roomNotFound();

  const mine = await tx.getActivePlayer(target.id, userId);
  if (mine) return ok({ roomId: target.id, seat: mine.seat });

  const other = current ? locked.find((r) => r.id === current.roomId) : null;
  if (other && other.status === 'playing') return alreadyInGame(other.id);
  if (target.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'This game has already started');

  const nickname = normalizeNickname(input.nickname);
  if (!nickname.ok) return nickname;
  const players = await tx.listActivePlayers(target.id);
  if (players.length >= MAX_SEATS) return fail('ROOM_FULL', `This room already has ${MAX_SEATS} players`);
  const key = nicknameKey(nickname.data);
  if (players.some((p) => nicknameKey(p.nickname) === key)) return fail('NICKNAME_TAKEN', 'Someone in this room already uses this nickname');

  if (other && other.status === 'lobby') await leaveLobby(tx, other, userId);
  let seat = 0;
  while (players.some((p) => p.seat === seat)) seat++;
  await tx.insertPlayer({ roomId: target.id, userId, seat, nickname: nickname.data });
  await tx.updateRoom(target, {});
  return ok({ roomId: target.id, seat });
}

async function leave(tx, userId, input) {
  if (!isUuid(input.roomId)) return fail('INVALID_INPUT', 'roomId must be a room id');
  await tx.lockUser(userId);
  const [room] = await tx.lockRooms([input.roomId]);
  const me = room ? await tx.getActivePlayer(room.id, userId) : null;
  if (!room || !me) return fail('ROOM_NOT_FOUND', 'You are not in this room');

  if (room.status === 'lobby') {
    await leaveLobby(tx, room, userId);
  } else if (room.status === 'playing') {
    await tx.markPlayerLeft(room.id, userId);
    await tx.updateRoom(room, { status: 'abandoned' });
    await tx.appendEvent(room.id, 'gameAborted', { by: seatPlayerId(me.seat) });
  } else {
    await tx.markPlayerLeft(room.id, userId);
  }
  return ok({ roomId: room.id });
}

async function setVariant(tx, userId, input) {
  if (!isUuid(input.roomId)) return fail('INVALID_INPUT', 'roomId must be a room id');
  if (!VARIANTS.includes(input.variant)) return fail('INVALID_INPUT', `variant must be one of ${VARIANTS.join(', ')}`);
  await tx.lockUser(userId);
  const [room] = await tx.lockRooms([input.roomId]);
  const me = room ? await tx.getActivePlayer(room.id, userId) : null;
  if (!room || !me || !ACTIVE_STATUSES.includes(room.status)) return fail('ROOM_NOT_FOUND', 'You are not in this room');
  if (room.hostId !== userId) return fail('NOT_HOST', 'Only the host can change the mode');
  if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'The mode cannot change after the game has started');
  await tx.updateRoom(room, { variant: input.variant });
  return ok({ roomId: room.id, variant: input.variant });
}

const ACTIONS = { create, join, leave, setVariant };

/**
 * createRoomsService({ repo, randomCode?, maxCodeAttempts?, maxConflictRetries? })
 *   .run(userId, action, input) → { ok, data } | { ok: false, error }
 * Throws only on unexpected failures, including a version conflict that persists after maxConflictRetries retries.
 */
export function createRoomsService({
  repo, randomCode = generateRoomCode, maxCodeAttempts = 20, maxConflictRetries = MAX_CONFLICT_RETRIES,
}) {
  const ctx = { randomCode, maxCodeAttempts };
  return {
    actions: Object.keys(ACTIONS),
    async run(userId, action, input) {
      const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
      if (!fn) return fail('INVALID_INPUT', `action must be one of ${Object.keys(ACTIONS).join(', ')}`);
      if (!isUuid(userId)) return fail('UNAUTHORIZED', 'Sign in first');
      const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      for (let retries = 0; ; retries++) {
        try {
          return await repo.transaction((tx) => fn.call(ctx, tx, userId, body));
        } catch (err) {
          if (!isVersionConflict(err) || retries >= maxConflictRetries) throw err;
        }
      }
    },
  };
}
