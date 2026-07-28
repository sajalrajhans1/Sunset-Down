/**
 * Shared leaderboard plumbing for the Vercel Edge functions.
 *
 * Storage is Upstash Redis over its REST API rather than a client library, so
 * this runs on the Edge runtime with no dependencies at all — the whole
 * leaderboard is two small functions and a sorted set.
 *
 * If the environment variables are absent the API reports itself as
 * unconfigured rather than erroring. The game then falls back to a local-only
 * board, so a fresh clone with no backend still runs.
 */

/**
 * Redis credentials.
 *
 * Two naming conventions are accepted. Creating the database from the Vercel
 * Marketplace injects `KV_REST_API_*` automatically; creating it directly at
 * upstash.com gives you `UPSTASH_REDIS_REST_*`. Reading both means the
 * integration works with no manual copying either way.
 */
const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

/**
 * Secret used to sign run tokens. Falls back to a build-local value so the
 * flow still works in development; in production an unset secret means tokens
 * are trivially forgeable, so the API refuses to record scores without one.
 */
const RUN_SECRET = process.env.LEADERBOARD_SECRET ?? '';

export const isConfigured = (): boolean =>
  REDIS_URL.length > 0 && REDIS_TOKEN.length > 0 && RUN_SECRET.length > 0;

/**
 * Which pieces of configuration are present, for the health endpoint.
 * Reports only presence — never a value, or any part of one.
 */
export const configState = (): Record<string, boolean> => ({
  redisUrl: REDIS_URL.length > 0,
  redisToken: REDIS_TOKEN.length > 0,
  secret: RUN_SECRET.length > 0,
});

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** Runs a single Redis command through the Upstash REST endpoint. */
export async function redis<T = unknown>(...command: (string | number)[]): Promise<T> {
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command.map(String)),
  });
  if (!response.ok) throw new Error(`Redis ${response.status}`);
  const body = (await response.json()) as { result: T; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result;
}

/**
 * The board key for a given moment.
 *
 * The month is baked into the key, so a "reset" is simply the calendar moving
 * on to a key that does not exist yet. Nothing is ever deleted on a schedule
 * and there is no cron job to fail — last month's board is still sitting there
 * under its own key until its TTL lapses.
 */
export function boardKey(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `lb:${year}-${month}`;
}

/** Human label for the current board, e.g. "July 2026". */
export function boardLabel(now = new Date()): string {
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Where username ownership lives.
 *
 * Deliberately global and without a TTL, unlike the monthly boards. Scores
 * reset on the first of the month; the name a player chose does not, because
 * having it quietly handed to a stranger every month would be worse than the
 * collisions this exists to prevent.
 */
export const USERNAMES_KEY = 'usernames';

export interface UsernameRecord {
  /** Anonymous browser id that currently holds this name. */
  owner: string;
  /** Short code that lets the owner move the name to another device. */
  code: string;
  /** The name as it was typed, so the board can show the original casing. */
  display: string;
  at: number;
}

/**
 * Generates a short, readable recovery code.
 *
 * The alphabet omits I, O, 0 and 1 because these get written down and typed
 * back in by hand, and those four are where that goes wrong.
 */
export function makeRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Seconds until a board should disappear: this month plus a grace period. */
export const BOARD_TTL = 70 * 24 * 60 * 60;

/** Highest number of entries kept per month. */
export const BOARD_SIZE = 100;

// ---------------------------------------------------------------------------
// Run tokens
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(RUN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Issues a token marking the start of a run.
 *
 * The point is not secrecy — it carries nothing worth hiding — but that the
 * server, not the client, decides when the run began. A score claiming forty
 * waves can then be checked against how long the player actually had.
 */
export async function issueToken(): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const issuedAt = Date.now();
  const signature = await sign(`${nonce}.${issuedAt}`);
  return `${nonce}.${issuedAt}.${signature}`;
}

/**
 * Length-independent, content-independent string comparison.
 *
 * Used wherever a caller-supplied value is checked against a secret. A plain
 * `===` returns as soon as two characters differ, so how long it took narrows
 * down how much of the value was right. Over the public internet that signal
 * is buried in jitter and this is close to paranoia - but the token signature
 * already gets this treatment and a recovery code deserves the same, not least
 * because anyone reading this repository can see which one got it and which
 * one did not.
 */
export function safeEqual(a: string, b: string): boolean {
  // Compare a fixed number of characters either way, so length alone leaks
  // nothing beyond the mismatch flag.
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export interface TokenCheck {
  ok: boolean;
  reason?: string;
  nonce?: string;
  ageSeconds?: number;
}

/** Shortest run we will believe, in seconds. */
const MIN_RUN_SECONDS = 20;
/** Longest a token stays usable. Also the replay-guard retention. */
const MAX_RUN_SECONDS = 6 * 60 * 60;

export async function verifyToken(token: unknown): Promise<TokenCheck> {
  if (typeof token !== 'string' || token.length > 200) {
    return { ok: false, reason: 'missing token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  const [nonce, issuedAtRaw, signature] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: 'malformed token' };

  const expected = await sign(`${nonce}.${issuedAt}`);
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'bad signature' };

  const ageSeconds = (Date.now() - issuedAt) / 1000;
  if (ageSeconds < MIN_RUN_SECONDS) return { ok: false, reason: 'run too short' };
  if (ageSeconds > MAX_RUN_SECONDS) return { ok: false, reason: 'token expired' };

  return { ok: true, nonce, ageSeconds };
}

/**
 * Burns a nonce so one token cannot post two scores.
 * Returns false when the token has already been spent.
 */
export async function consumeToken(nonce: string): Promise<boolean> {
  const result = await redis<string | null>('SET', `used:${nonce}`, '1', 'NX', 'EX', MAX_RUN_SECONDS);
  return result === 'OK';
}

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

/**
 * Wave pacing constants.
 *
 * These mirror WAVES in src/game/Config.ts and must be kept in step with it.
 * They are duplicated rather than imported because this file runs in a
 * separate build from the game bundle, and importing across that boundary
 * would drag Three.js into an Edge function.
 */
const WAVE_PACING = {
  baseCount: 6,
  countGrowth: 2.6,
  countExponent: 1.14,
  maxCount: 90,
  baseSpawnInterval: 1.5,
  minSpawnInterval: 0.28,
  spawnIntervalDecay: 0.94,
};

/** Zombies in a given wave, matching WaveSystem's own formula. */
function waveCount(wave: number): number {
  const raw =
    WAVE_PACING.baseCount + WAVE_PACING.countGrowth * Math.pow(wave, WAVE_PACING.countExponent);
  return Math.min(WAVE_PACING.maxCount, Math.round(raw));
}

function spawnInterval(wave: number): number {
  return Math.max(
    WAVE_PACING.minSpawnInterval,
    WAVE_PACING.baseSpawnInterval * Math.pow(WAVE_PACING.spawnIntervalDecay, wave),
  );
}

/**
 * The fastest anyone could conceivably reach a wave, in seconds.
 *
 * A wave cannot end before its zombies have finished spawning, and they trickle
 * out on a fixed interval that no amount of skill shortens. Prep countdowns are
 * excluded on purpose because the player can skip them from the shop, so the
 * spawn schedule is the only part of the clock that is genuinely immovable.
 *
 * The result is then discounted further, because rejecting a legitimate run is
 * a much worse outcome than admitting a doctored one.
 */
export function minimumSecondsForWave(wave: number): number {
  let total = 0;
  for (let w = 1; w < wave; w++) total += waveCount(w) * spawnInterval(w);
  return total * 0.7;
}

/** Total zombies released up to the start of a wave. */
export function zombiesThroughWave(wave: number): number {
  let total = 0;
  for (let w = 1; w < wave; w++) total += waveCount(w);
  return total;
}

export interface ScoreClaim {
  name: string;
  wave: number;
  kills: number;
  timeSurvived: number;
}

export interface Validation {
  ok: boolean;
  reason?: string;
  claim?: ScoreClaim;
}

/** Hard ceiling on a claimed wave. Well past anything reachable by playing. */
const MAX_WAVE = 250;

/**
 * Checks a submission against what the game itself could have produced.
 *
 * None of this makes the score trustworthy — the browser computes it, so a
 * determined person can always lie. What it does is make the lie cost real
 * effort and keep the obvious nonsense (wave 9999, a minute-old run claiming
 * an hour of play) off the board.
 */
export function validateClaim(body: unknown, serverAgeSeconds: number): Validation {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'bad payload' };
  const raw = body as Record<string, unknown>;

  const name = sanitiseName(raw.name);
  if (!name) return { ok: false, reason: 'name required' };

  const wave = Math.floor(Number(raw.wave));
  const kills = Math.floor(Number(raw.kills));
  const timeSurvived = Number(raw.timeSurvived);

  if (!Number.isFinite(wave) || wave < 1 || wave > MAX_WAVE) {
    return { ok: false, reason: 'wave out of range' };
  }
  if (!Number.isFinite(kills) || kills < 0 || kills > 100_000) {
    return { ok: false, reason: 'kills out of range' };
  }
  if (!Number.isFinite(timeSurvived) || timeSurvived < 0 || timeSurvived > MAX_RUN_SECONDS) {
    return { ok: false, reason: 'time out of range' };
  }

  // The clock the server kept must cover the run the client is describing.
  if (serverAgeSeconds + 30 < minimumSecondsForWave(wave)) {
    return { ok: false, reason: 'wave unreachable in the time elapsed' };
  }
  // And the client's own reported duration has to agree with that clock.
  if (timeSurvived > serverAgeSeconds + 60) {
    return { ok: false, reason: 'reported time exceeds session length' };
  }

  // You cannot advance past a wave without clearing it, so reaching wave N
  // implies having killed most of what waves 1..N-1 released.
  const required = Math.floor(zombiesThroughWave(wave) * 0.5);
  if (kills < required) return { ok: false, reason: 'kills too low for that wave' };

  return { ok: true, claim: { name, wave, kills, timeSurvived } };
}

/**
 * Cleans a player-supplied name.
 *
 * Players choose this freely, and it is rendered on a public page, so
 * everything that is not a plain printable character is removed rather than
 * escaped. That leaves nothing for the client to have to be careful with.
 */
export function sanitiseName(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const cleaned = input
    // Strip control characters, zero-width joiners and direction overrides,
    // which are the usual tricks for smuggling layout-breaking names in.
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);

  if (cleaned.length < 1) return null;
  return cleaned;
}

/** Two-letter country from Vercel's geo header, or ?? when unknown. */
export function countryOf(request: Request): string {
  const code = request.headers.get('x-vercel-ip-country') ?? '';
  return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : '??';
}

/** Coarse client identity for rate limiting. Never stored with the entry. */
export function clientKey(request: Request): string {
  // `x-forwarded-for` is a client-supplied list that proxies append to, so its
  // *first* entry is whatever the caller decided to put there. Reading that
  // would let anyone mint a fresh rate-limit bucket per request simply by
  // varying a header, which defeats the limit entirely.
  //
  // Vercel sets these two itself and they cannot be forged from outside, so
  // they are preferred. The fallback takes the *last* forwarded entry - the
  // one appended by the hop closest to us - rather than the first.
  const trusted =
    request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-real-ip');
  if (trusted && trusted.trim()) return trusted.trim();

  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : 'unknown';
}

/**
 * Short, stable hash of a value, used so rate-limit keys never contain a raw
 * IP address. The buckets live for two minutes and exist only to count
 * requests; there is no reason to write someone's address into a database to
 * do that.
 */
async function hashed(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Simple fixed-window rate limit.
 * Returns false when the caller has exceeded `limit` requests this minute.
 */
export async function underRateLimit(request: Request, bucket: string, limit: number): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:${bucket}:${await hashed(clientKey(request))}:${minute}`;
  const count = await redis<number>('INCR', key);
  if (count === 1) await redis('EXPIRE', key, 120);
  return count <= limit;
}

/**
 * Largest request body the score endpoint will read, in bytes.
 * A submission is a couple of hundred bytes; anything approaching this is
 * either broken or trying to make the function do pointless work.
 */
export const MAX_BODY_BYTES = 4096;

/** True when the request declares a body larger than we are willing to parse. */
export function bodyTooLarge(request: Request): boolean {
  const declared = Number(request.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
