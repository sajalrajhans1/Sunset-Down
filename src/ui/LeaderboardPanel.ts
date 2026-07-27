import { el } from './dom';
import {
  flagOf,
  formatDuration,
  leaderboard,
  type Board,
  type LeaderboardEntry,
} from '../systems/Leaderboard';

/**
 * The standings, shown on the main menu and again after a run.
 *
 * Deliberately always present rather than hidden behind a button: an empty
 * board still tells a new player that the game is competitive and that their
 * run will count for something. It refreshes on demand instead of polling,
 * because nobody sits on the menu watching for a rank to change.
 */

/** How many rows the menu shows before scrolling. */
const VISIBLE_ROWS = 10;

export class LeaderboardPanel {
  readonly root: HTMLElement;

  private readonly list: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly note: HTMLElement;

  private lastFetch = 0;
  private inFlight: Promise<void> | null = null;

  /** Highlights the row belonging to the run that just finished. */
  private highlightId: string | null = null;

  constructor(private readonly options: { compact?: boolean } = {}) {
    this.list = el('ol', { className: 'sh-board__list' });
    this.subtitle = el('p', { className: 'sh-board__subtitle', text: 'Loading standings…' });
    this.note = el('p', { className: 'sh-board__note' });

    this.root = el('section', {
      className: `sh-board${options.compact ? ' sh-board--compact' : ''}`,
      attrs: { 'aria-label': 'Monthly leaderboard' },
      children: [
        el('header', {
          className: 'sh-board__header',
          children: [
            el('h2', { className: 'sh-board__title', text: 'Survivors of the Month' }),
            this.subtitle,
          ],
        }),
        el('div', {
          className: 'sh-board__columns',
          attrs: { 'aria-hidden': 'true' },
          children: [
            el('span', { className: 'sh-board__col sh-board__col--rank', text: '#' }),
            el('span', { className: 'sh-board__col sh-board__col--name', text: 'Survivor' }),
            el('span', { className: 'sh-board__col sh-board__col--wave', text: 'Wave' }),
            el('span', { className: 'sh-board__col sh-board__col--kills', text: 'Kills' }),
            el('span', { className: 'sh-board__col sh-board__col--time', text: 'Time' }),
          ],
        }),
        this.list,
        this.note,
      ],
    });

    this.renderSkeleton();
  }

  /**
   * Pulls fresh standings.
   *
   * Results are held briefly so bouncing between the menu and a run doesn't
   * fire a request every time, but any submitted score forces a refresh.
   */
  refresh(force = false): Promise<void> {
    const age = Date.now() - this.lastFetch;
    if (!force && this.inFlight) return this.inFlight;
    if (!force && age < 30_000) return Promise.resolve();

    this.inFlight = leaderboard
      .fetchBoard()
      .then((board) => this.render(board))
      .catch(() => this.renderError())
      .finally(() => {
        this.lastFetch = Date.now();
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Marks a row so the player can find their own result at a glance. */
  setHighlight(entryId: string | null): void {
    this.highlightId = entryId;
  }

  // -------------------------------------------------------------------------

  private render(board: Board): void {
    this.subtitle.textContent = board.global
      ? `${board.month} · resets on the 1st`
      : `${board.month} · this device only`;

    this.note.textContent = board.global
      ? ''
      : 'No connection to the global board right now — showing your own runs.';
    this.note.classList.toggle('is-visible', !board.global);

    this.list.replaceChildren();

    if (board.entries.length === 0) {
      this.list.appendChild(
        el('li', {
          className: 'sh-board__empty',
          text: 'Nobody has survived a wave yet this month. Be the first.',
        }),
      );
      return;
    }

    const rows = this.options.compact ? board.entries.slice(0, 5) : board.entries;
    rows.forEach((entry, index) => this.list.appendChild(this.buildRow(entry, index + 1)));

    // Room for exactly VISIBLE_ROWS before the list starts scrolling.
    this.list.classList.toggle('is-scrollable', rows.length > VISIBLE_ROWS);
  }

  private buildRow(entry: LeaderboardEntry, rank: number): HTMLElement {
    const isMine = this.highlightId !== null && entry.id === this.highlightId;

    return el('li', {
      className: `sh-board__row${isMine ? ' is-mine' : ''}${rank <= 3 ? ` is-podium is-rank-${rank}` : ''}`,
      children: [
        el('span', { className: 'sh-board__col sh-board__col--rank', text: String(rank) }),
        el('span', {
          className: 'sh-board__col sh-board__col--name',
          children: [
            el('span', {
              className: 'sh-board__flag',
              text: flagOf(entry.country),
              // The flag is decoration; the country code is the real content.
              attrs: { title: entry.country === '??' ? 'Unknown' : entry.country },
            }),
            // textContent, never innerHTML — this string came from a stranger.
            el('span', { className: 'sh-board__name', text: entry.name }),
          ],
        }),
        el('span', { className: 'sh-board__col sh-board__col--wave', text: String(entry.wave) }),
        el('span', {
          className: 'sh-board__col sh-board__col--kills',
          text: entry.kills.toLocaleString(),
        }),
        el('span', {
          className: 'sh-board__col sh-board__col--time',
          text: formatDuration(entry.time),
        }),
      ],
    });
  }

  private renderSkeleton(): void {
    this.list.replaceChildren();
    for (let i = 0; i < 5; i++) {
      this.list.appendChild(el('li', { className: 'sh-board__row sh-board__row--skeleton' }));
    }
  }

  private renderError(): void {
    this.subtitle.textContent = 'Standings unavailable';
    this.list.replaceChildren(
      el('li', { className: 'sh-board__empty', text: 'Could not reach the leaderboard.' }),
    );
  }
}
