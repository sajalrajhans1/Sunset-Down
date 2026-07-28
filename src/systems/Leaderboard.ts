import { Storage } from '../utilities/Storage';

/**
 * Client half of the global leaderboard.
 *
 * Every call degrades rather than fails. If the backend is absent, offline or
 * simply slow, the panel falls back to a board held in local storage — so the
 * feature is always *there*, and a deployment with no database configured is a
 * quieter leaderboard rather than a broken menu.
 */

export interface LeaderboardEntry {
  id: string;
  name: string;
  /** ISO-3166 alpha-2, or '??' when the request had no geo header. */
  country: string;
  wave: number;
  kills: number;
  time: number;
  at: number;
  /** True for rows that only exist on this device. */
  local?: boolean;
}

export interface Board {
  month: string;
  entries: LeaderboardEntry[];
  /** False when no backend is configured — the board is this device only. */
  global: boolean;
}

const NAME_KEY = 'sh-player-name';
const PLAYER_ID_KEY = 'sh-player-id';
const LOCAL_BOARD_KEY = 'sh-local-board';
const MAX_LOCAL = 25;

/** Longest a request may take before we give up and show what we have. */
const TIMEOUT_MS = 6000;

export const MAX_NAME_LENGTH = 16;

export class Leaderboard {
  /** Token issued by the server when the current run began. */
  private runToken: string | null = null;

  /**
   * Whether a global board exists, once we have heard from the server.
   * Null until the first call — the UI treats that as "assume it does".
   */
  backendAvailable: boolean | null = null;

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * A stable, anonymous id for this browser.
   *
   * This is what identifies a player on the board, *not* their name. Names are
   * free text, so two strangers both calling themselves "Sam" are two players
   * and must each keep their own row — deduplicating on the name would let one
   * of them silently delete the other's run.
   *
   * It is random, carries nothing about the person, and is never shown or
   * returned by the API. Clearing site data simply makes a new player.
   */
  get playerId(): string {
    let id = Storage.get<string>(PLAYER_ID_KEY, '');
    if (!/^[a-f0-9]{32}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '');
      Storage.set(PLAYER_ID_KEY, id);
    }
    return id;
  }

  /** The name this player last submitted under, if any. */
  get savedName(): string {
    return Storage.get<string>(NAME_KEY, '');
  }

  set savedName(value: string) {
    Storage.set(NAME_KEY, sanitiseName(value));
  }

  // -------------------------------------------------------------------------
  // Username ownership
  // -------------------------------------------------------------------------

  /**
   * Asks whether a name is free.
   *
   * `available` is true when nobody holds it *or* when the holder is this
   * browser, so the caller can treat "your own name" and "an unused name" the
   * same way. A network failure reports available: refusing to let someone
   * submit because a check timed out would be worse than letting the server
   * make the final call on submit.
   */
  async checkName(name: string): Promise<{ available: boolean; mine: boolean }> {
    const cleaned = sanitiseName(name).trim();
    if (!cleaned) return { available: false, mine: false };

    const query = `?name=${encodeURIComponent(cleaned)}&client=${this.playerId}`;
    const result = await this.request<{ available: boolean; mine: boolean }>(
      `/api/username${query}`,
    );
    if (!result) return { available: true, mine: false };
    return { available: !!result.available, mine: !!result.mine };
  }

  /** Fetches this player's recovery code for the name they own. */
  async recoveryCode(name: string): Promise<string | null> {
    const cleaned = sanitiseName(name).trim();
    if (!cleaned) return null;
    const result = await this.request<{ code?: string }>('/api/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'code', name: cleaned, client: this.playerId }),
    });
    return result?.code ?? null;
  }

  /**
   * Moves a name this player owns onto this browser, using its code.
   * This is the escape hatch for a new device or cleared site data.
   */
  async recoverUsername(
    name: string,
    code: string,
  ): Promise<{ ok: boolean; name?: string; reason?: string }> {
    const cleaned = sanitiseName(name).trim();
    if (!cleaned) return { ok: false, reason: 'name required' };

    const result = await this.request<{ recovered?: boolean; name?: string; error?: string }>(
      '/api/username',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover', name: cleaned, code, client: this.playerId }),
      },
    );

    if (!result) return { ok: false, reason: 'offline' };
    if (result.error) return { ok: false, reason: result.error };
    if (result.recovered) {
      this.savedName = result.name ?? cleaned;
      return { ok: true, name: this.savedName };
    }
    return { ok: false, reason: 'failed' };
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /**
   * Opens a run with the server.
   *
   * Fire-and-forget on purpose: pressing Play must never wait on the network.
   * If this fails the run simply cannot be submitted globally, which the
   * submit path handles.
   */
  beginRun(): void {
    this.runToken = null;
    void this.request<{ configured: boolean; token?: string }>('/api/run', { method: 'POST' })
      .then((result) => {
        if (!result) return;
        this.backendAvailable = result.configured;
        this.runToken = result.token ?? null;
      })
      .catch(() => {
        this.backendAvailable = false;
      });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Fetches the current month's board, falling back to the local one. */
  async fetchBoard(): Promise<Board> {
    const result = await this.request<{
      configured: boolean;
      month: string;
      entries: LeaderboardEntry[];
    }>('/api/scores');

    if (result?.configured && Array.isArray(result.entries)) {
      this.backendAvailable = true;
      return { month: result.month, entries: result.entries, global: true };
    }

    this.backendAvailable = false;
    return { month: currentMonthLabel(), entries: this.localEntries(), global: false };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Submits a finished run.
   *
   * Always records locally first, so the player sees their result even when the
   * network is against them, then tries the server on top.
   */
  async submit(run: {
    name: string;
    wave: number;
    kills: number;
    timeSurvived: number;
  }): Promise<{ recorded: boolean; rank: number | null; global: boolean; reason?: string }> {
    const name = sanitiseName(run.name);
    if (!name) return { recorded: false, rank: null, global: false, reason: 'name required' };

    this.savedName = name;
    this.recordLocally({ ...run, name });

    if (!this.runToken) {
      return { recorded: true, rank: null, global: false, reason: 'no run token' };
    }

    const result = await this.request<{
      recorded: boolean;
      rank: number | null;
      error?: string;
      reason?: string;
    }>('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.runToken, client: this.playerId, ...run, name }),
    });

    // A token is good for exactly one score either way.
    this.runToken = null;

    if (!result) return { recorded: true, rank: null, global: false, reason: 'offline' };
    if (result.error) return { recorded: true, rank: null, global: false, reason: result.error };

    return {
      recorded: result.recorded,
      rank: result.rank ?? null,
      global: true,
      reason: result.reason,
    };
  }

  // -------------------------------------------------------------------------
  // Local mirror
  // -------------------------------------------------------------------------

  private localEntries(): LeaderboardEntry[] {
    const stored = Storage.get<LeaderboardEntry[]>(LOCAL_BOARD_KEY, []);
    if (!Array.isArray(stored)) return [];
    // Local rows follow the same monthly life as the server's.
    const month = currentMonthKey();
    return stored
      .filter((entry) => monthKeyOf(entry.at) === month)
      .sort((a, b) => b.wave - a.wave || b.kills - a.kills)
      .slice(0, MAX_LOCAL);
  }

  private recordLocally(run: { name: string; wave: number; kills: number; timeSurvived: number }): void {
    const entries = Storage.get<LeaderboardEntry[]>(LOCAL_BOARD_KEY, []);
    const list = Array.isArray(entries) ? entries : [];
    list.push({
      id: `local-${Date.now().toString(36)}`,
      name: run.name,
      country: '??',
      wave: run.wave,
      kills: run.kills,
      time: Math.round(run.timeSurvived),
      at: Date.now(),
      local: true,
    });
    const month = currentMonthKey();
    const trimmed = list
      .filter((entry) => monthKeyOf(entry.at) === month)
      .sort((a, b) => b.wave - a.wave || b.kills - a.kills)
      .slice(0, MAX_LOCAL);
    Storage.set(LOCAL_BOARD_KEY, trimmed);
  }

  // -------------------------------------------------------------------------

  /** Fetch with a timeout, returning null instead of throwing. */
  private async request<T>(url: string, init?: RequestInit): Promise<T | null> {
    // A leaderboard is never worth hanging the UI for.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok && response.status !== 400 && response.status !== 409) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Client-side name cleaning.
 *
 * The server sanitises independently and authoritatively — this exists so the
 * player sees what will actually be stored while they are typing it.
 */
export function sanitiseName(input: string): string {
  return input
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, MAX_NAME_LENGTH);
}

/**
 * Turns a country code into its flag emoji.
 *
 * Regional indicator symbols sit at a fixed offset from ASCII letters, so the
 * flag for a code is just its two letters shifted into that block.
 */
export function flagOf(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return '🏳️';
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + country.charCodeAt(0) - 65,
    A + country.charCodeAt(1) - 65,
  );
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthKeyOf(timestamp: number): string {
  return currentMonthKey(new Date(timestamp));
}

function currentMonthLabel(now = new Date()): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

export const leaderboard = new Leaderboard();
