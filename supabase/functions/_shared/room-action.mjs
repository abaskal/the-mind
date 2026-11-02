/**
 * Gameplay (MIND-04): the core of the `room-action` Edge Function. Runtime-agnostic: no Deno, Node or database
 * APIs. The rules are the shared engine (I4), passed in as `Mind`, and the database sits behind a repository, so
 * the same code runs in the function (Postgres through RPC) and in Node tests (in-memory).
 *
 * Repository interface:
 *   repo.loadRoomForAction(roomId, userId) → null when the room does not exist, else
 *     { room: { id, code, hostId, variant, status, version }, version, seat (null when not seated),
 *       players: [{ userId, seat, nickname }] (seated, joined_at order), engineState (null without a game), nowMs }
 *   repo.commitRoomAction({ roomId, expectedVersion, engineState, hands: [{ userId, hand }], events: [{ type, payload }],
 *       publicState, status, nextDeadlineAt (ms or null), clearGame })
 *     → { conflict: true } when the room is no longer at expectedVersion (nothing changed), else
 *       { conflict: false, version, firstSeq }
 *
 * Pipeline of one request (I1, I6): load (with the database clock, nowMs) → restore the engine → tick(now) → apply
 * the action → no state change: answer without writing; otherwise commit with a compare-and-swap on the version.
 * A conflict starts again from the load, at most maxRetries times.
 *
 * Privacy (I2): engine player ids are seat-based (s0–s3). The full engine state, with every hand and the RNG
 * state, only goes to room_secrets. public_state is viewFor(null), event rows are redactEvent(…, null), each hand
 * goes to its owner's room_hands row, and a response only carries viewFor(caller) and events redacted for them.
 */
import { isUuid, seatPlayerId } from './rooms-rules.mjs';

export const ACTION_TYPES = Object.freeze([
  'start', 'handDown', 'play', 'proposeStar', 'voteStar', 'refocus', 'pause', 'resume', 'nextLevel', 'tick',
  'rematch', 'endGame',
]);
export const MAX_CONFLICT_RETRIES = 3;
export const END_GAME_AFTER_PAUSE_MS = 3 * 60 * 1000;
export const ACTION_RATE_LIMIT = Object.freeze({ max: 15, windowMs: 1000 });

export const ERROR_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_A_MEMBER: 403,
  NOT_HOST: 403,
  INVALID_MOVE: 409,
  CONFLICT_RETRY: 409,
  RATE_LIMITED: 429,
});

// Engine calls for the player actions; each returns true when applied (the engine never throws on bad moves).
const ENGINE_ACTIONS = {
  handDown: (e, me, req, now) => e.placeHand(me, now),
  play: (e, me, req, now) => e.playCard(me, req.pileId, now),
  proposeStar: (e, me, req, now) => e.proposeStar(me, now),
  voteStar: (e, me, req, now) => e.voteStar(me, req.agree, now),
  refocus: (e, me, req, now) => e.callRefocus(me, now),
  pause: (e, me, req, now) => e.pause(me, now),
  resume: (e, me, req, now) => e.resume(me, now),
  nextLevel: (e, me, req, now) => e.nextLevel(now),
  tick: () => true,
};

const ENDED_PHASES = ['victory', 'gameOver'];

const errorBody = (code, message, extra) => Object.assign({ error: { code, message } }, extra);
const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
const handOf = (player) => player.hand.map((c) => ({ v: c.v, pile: c.pile }));

const defaultSeed = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
const defaultTimer = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

/**
 * Sliding-window limit per user and per function instance (approximate across instances, which is accepted).
 *   createActionRateLimiter({ max?, windowMs?, now? }).allow(userId) → false when over the limit
 */
export function createActionRateLimiter({ max = ACTION_RATE_LIMIT.max, windowMs = ACTION_RATE_LIMIT.windowMs, now = () => Date.now(), maxUsers = 10000 } = {}) {
  const hits = new Map();
  return {
    allow(userId) {
      const t = now();
      const recent = (hits.get(userId) || []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(userId, recent);
        return false;
      }
      recent.push(t);
      hits.set(userId, recent);
      if (hits.size > maxUsers) {
        for (const [id, list] of hits) if (!list.length || t - list[list.length - 1] >= windowMs) hits.delete(id);
      }
      return true;
    },
  };
}

function parseRequest(input) {
  const bad = (message) => ({ error: errorBody('INVALID_INPUT', message) });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Request body must be a JSON object');
  if (!isUuid(input.roomId)) return bad('roomId must be a room id');
  if (typeof input.type !== 'string' || !ACTION_TYPES.includes(input.type)) return bad(`type must be one of ${ACTION_TYPES.join(', ')}`);
  if (input.type === 'play' && input.pileId != null && typeof input.pileId !== 'string') return bad('pileId must be a string');
  if (input.type === 'voteStar' && typeof input.agree !== 'boolean') return bad('agree must be true or false');
  return { req: { roomId: input.roomId, type: input.type, pileId: input.pileId == null ? null : input.pileId, agree: input.agree } };
}

/**
 * createRoomActionService({ repo, Mind, randomSeed?, maxRetries?, rateLimiter?, timer? })
 *   .run(userId, body) → { status, body, timing: { load, engine, commit } (ms) }
 * Throws only on unexpected failures (the HTTP layer turns them into 500).
 */
export function createRoomActionService({
  repo, Mind, randomSeed = defaultSeed, maxRetries = MAX_CONFLICT_RETRIES,
  rateLimiter = createActionRateLimiter(), timer = defaultTimer,
}) {
  if (!Mind || typeof Mind.MindEngine !== 'function') throw new Error('createRoomActionService needs the rules engine (Mind)');

  // Collects every engine event as a deep copy, in emit order.
  function record(engine) {
    const events = [];
    engine.on('*', (type, data) => events.push({ type, data: clone(data) || {} }));
    return events;
  }

  function publicStateOf(engine) {
    const state = engine.viewFor(null);
    if (ENDED_PHASES.includes(engine.phase)) {
      state.result = {
        won: engine.phase === 'victory',
        level: engine.level,
        maxLevel: engine.maxLevel,
        stats: Object.assign({}, engine.stats),
        variant: engine.variantId,
      };
    }
    return state;
  }

  function invalidMove(loaded, engine, me, message) {
    return {
      status: 409,
      body: errorBody('INVALID_MOVE', message, {
        view: engine ? engine.viewFor(me) : null,
        version: loaded.version,
        serverNow: Number(loaded.nowMs),
        nextDeadlineAt: engine && loaded.room.status === 'playing' ? engine.nextDeadline() : null,
      }),
    };
  }

  // Builds the commit of a changed engine and the reply that follows it.
  function commitGame({ loaded, engine, events, me, now, handsBefore, clearGame = false, statusOverride = null, extraEvents = [], invalid = null }) {
    const ended = ENDED_PHASES.includes(engine.phase);
    const status = statusOverride || (ended ? 'finished' : 'playing');
    const nextDeadlineAt = status === 'playing' ? engine.nextDeadline() : null;
    const userBySeatId = new Map(loaded.players.map((p) => [seatPlayerId(p.seat), p.userId]));
    const hands = [];
    for (const p of engine.players) {
      const hand = handOf(p);
      const userId = userBySeatId.get(p.id);
      if (userId && (!handsBefore || JSON.stringify(handsBefore.get(p.id)) !== JSON.stringify(hand))) hands.push({ userId, hand });
    }
    const all = events.concat(extraEvents);
    const commit = {
      roomId: loaded.room.id,
      expectedVersion: loaded.version,
      engineState: engine.toJSON(),
      hands,
      events: all.map((e) => ({ type: e.type, payload: Mind.redactEvent(e.type, e.data, null, engine) })),
      publicState: publicStateOf(engine),
      status,
      nextDeadlineAt,
      clearGame,
    };
    const respond = (result) => {
      if (invalid) {
        return errorBody('INVALID_MOVE', invalid, { view: engine.viewFor(me), version: result.version, serverNow: now, nextDeadlineAt });
      }
      return {
        ok: true,
        version: result.version,
        serverNow: now,
        nextDeadlineAt,
        status,
        view: engine.viewFor(me),
        events: all.map((e, i) => ({ seq: result.firstSeq + i, type: e.type, data: Mind.redactEvent(e.type, e.data, me, engine) })),
      };
    };
    return { status: invalid ? 409 : 200, commit, respond };
  }

  // One attempt: decides from a fresh load. → { status, body } (no write) or { status, commit, respond }.
  function decide(loaded, userId, req) {
    const { room } = loaded;
    const me = seatPlayerId(loaded.seat);
    const now = Number(loaded.nowMs);
    const isHost = room.hostId === userId;

    if (req.type === 'start') {
      if (!isHost) return { status: 403, body: errorBody('NOT_HOST', 'Only the host can start the game') };
      if (room.status !== 'lobby') return invalidMove(loaded, null, me, 'The game has already started');
      if (loaded.players.length < 2 || loaded.players.length > 4) return invalidMove(loaded, null, me, 'A game needs 2–4 players');
      const engine = new Mind.MindEngine({
        players: loaded.players.map((p) => ({ id: seatPlayerId(p.seat), name: p.nickname, human: true })),
        variant: room.variant,
        adapt: false,
        seed: randomSeed() >>> 0,
      });
      const events = record(engine);
      engine.start(now);
      return commitGame({ loaded, engine, events, me, now, handsBefore: null, clearGame: true });
    }

    if (req.type === 'rematch') {
      if (!isHost) return { status: 403, body: errorBody('NOT_HOST', 'Only the host can start a rematch') };
      const engine = loaded.engineState ? Mind.MindEngine.fromJSON(loaded.engineState) : null;
      if (room.status !== 'finished') return invalidMove(loaded, engine, me, 'A rematch needs a finished game');
      const event = { type: 'rematch', data: { by: me } };
      return {
        status: 200,
        commit: {
          roomId: room.id,
          expectedVersion: loaded.version,
          engineState: null,
          hands: [],
          events: [{ type: event.type, payload: event.data }],
          publicState: null,
          status: 'lobby',
          nextDeadlineAt: null,
          clearGame: true,
        },
        respond: (result) => ({
          ok: true, version: result.version, serverNow: now, nextDeadlineAt: null, status: 'lobby', view: null,
          events: [{ seq: result.firstSeq, type: event.type, data: event.data }],
        }),
      };
    }

    const engine = loaded.engineState ? Mind.MindEngine.fromJSON(loaded.engineState) : null;
    if (room.status !== 'playing' || !engine) {
      return invalidMove(loaded, engine, me, room.status === 'lobby' ? 'The game has not started yet' : 'This game is over');
    }

    const before = JSON.stringify(engine.toJSON());
    const handsBefore = new Map(engine.players.map((p) => [p.id, handOf(p)]));
    const events = record(engine);
    engine.tick(now);

    if (req.type === 'endGame') {
      if (engine.phase !== 'paused' || now - engine.pausedAt < END_GAME_AFTER_PAUSE_MS) {
        const message = 'A game can only be ended after it has been paused for 3 minutes';
        if (JSON.stringify(engine.toJSON()) === before) return invalidMove(loaded, engine, me, message);
        return commitGame({ loaded, engine, events, me, now, handsBefore, invalid: message });
      }
      return commitGame({
        loaded, engine, events, me, now, handsBefore,
        statusOverride: 'abandoned', extraEvents: [{ type: 'gameAborted', data: { by: me, reason: 'endGame' } }],
      });
    }

    const applied = ENGINE_ACTIONS[req.type](engine, me, req, now) === true;
    const changed = JSON.stringify(engine.toJSON()) !== before;
    const message = applied ? null : `${req.type} is not possible right now`;
    if (!changed) {
      if (!applied) return invalidMove(loaded, engine, me, message);
      return {
        status: 200,
        body: {
          ok: true, version: loaded.version, serverNow: now, nextDeadlineAt: engine.nextDeadline(), status: room.status,
          view: engine.viewFor(me), events: [],
        },
      };
    }
    // A due tick is committed even when the action itself was not possible, so the table moves on.
    return commitGame({ loaded, engine, events, me, now, handsBefore, invalid: message });
  }

  return {
    actionTypes: ACTION_TYPES,
    async run(userId, input) {
      const timing = { load: 0, engine: 0, commit: 0 };
      const done = (status, body) => ({ status, body, timing });
      if (!isUuid(userId)) return done(401, errorBody('UNAUTHORIZED', 'Sign in first'));
      const { req, error } = parseRequest(input);
      if (error) return done(400, error);
      if (!rateLimiter.allow(userId)) return done(429, errorBody('RATE_LIMITED', 'Too many actions: at most 15 per second'));

      for (let retries = 0; ; retries++) {
        let t = timer();
        const loaded = await repo.loadRoomForAction(req.roomId, userId);
        timing.load += timer() - t;
        if (!loaded || loaded.seat == null) return done(403, errorBody('NOT_A_MEMBER', 'You are not seated in this room'));

        t = timer();
        const step = decide(loaded, userId, req);
        timing.engine += timer() - t;
        if (!step.commit) return done(step.status, step.body);

        t = timer();
        const result = await repo.commitRoomAction(step.commit);
        timing.commit += timer() - t;
        if (!result.conflict) return done(step.status, step.respond(result));
        if (retries >= maxRetries) {
          return done(409, errorBody('CONFLICT_RETRY', 'The table changed while your action was applied, please try again'));
        }
      }
    },
  };
}
