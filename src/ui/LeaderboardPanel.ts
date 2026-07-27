import { el } from './dom';
import boardHero from '../assets/leaderboard-hero.webp';
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
 * board still tells a new player the game is competitive and that their run
 * will count for something. It refreshes on demand instead of polling, because
 * nobody sits on the menu watching for a rank to change.
 *
 * The visual weight is all on **wave reached**, because that is the number
 * players actually compare. Kills and time are supporting detail, set smaller
 * and dimmer so a glance down the board reads as a single column of waves.
 */

/** How many rows fit before the list starts scrolling. */
const VISIBLE_ROWS = 8;

/** Medals for the top three, in place of a plain rank number. */
const MEDALS = ['🥇', '🥈', '🥉'];

export class LeaderboardPanel {
  readonly root: HTMLElement;

  private readonly list: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly note: HTMLElement;
  private readonly countLabel: HTMLElement;

  private lastFetch = 0;
  private inFlight: Promise<void> | null = null;

  /** Highlights the row belonging to the run that just finished. */
  private highlightId: string | null = null;

  constructor(private readonly options: { compact?: boolean } = {}) {
    this.list = el('ol', { className: 'sh-board__list' });
    this.subtitle = el('p', { className: 'sh-board__subtitle', text: 'Loading standings…' });
    this.note = el('p', { className: 'sh-board__note' });
    this.countLabel = el('span', { className: 'sh-board__count' });

    this.root = el('section', {
      className: `sh-board${options.compact ? ' sh-board--compact' : ''}`,
      attrs: { 'aria-label': 'Monthly leaderboard' },
      children: [
        // --- Hero banner -----------------------------------------------------
        el('header', {
          className: 'sh-board__hero',
          children: [
            el('div', {
              className: 'sh-board__hero-art',
              style: { backgroundImage: `url(${boardHero})` },
              attrs: { 'aria-hidden': 'true' },
            }),
            el('div', { className: 'sh-board__hero-fade', attrs: { 'aria-hidden': 'true' } }),
            el('div', {
              className: 'sh-board__hero-text',
              children: [
                el('span', { className: 'sh-board__eyebrow', text: 'Hall of Survivors' }),
                el('h2', { className: 'sh-board__title', text: 'Who Lasted Longest' }),
                this.subtitle,
              ],
            }),
          ],
        }),

        el('div', {
          className: 'sh-board__columns',
          attrs: { 'aria-hidden': 'true' },
          children: [
            el('span', { className: 'sh-board__col sh-board__col--rank', text: '' }),
            el('span', { className: 'sh-board__col sh-board__col--name', text: 'Survivor' }),
            el('span', { className: 'sh-board__col sh-board__col--wave', text: 'Wave' }),
            el('span', { className: 'sh-board__col sh-board__col--kills', text: 'Kills' }),
            el('span', { className: 'sh-board__col sh-board__col--time', text: 'Time' }),
          ],
        }),

        this.list,

        el('footer', {
          className: 'sh-board__footer',
          children: [this.countLabel, this.note],
        }),
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
      ? `${board.month} · everyone resets on the 1st`
      : `${board.month} · this device only`;

    this.note.textContent = board.global
      ? ''
      : 'Offline — showing your own runs until the board is reachable.';
    this.note.classList.toggle('is-visible', !board.global);

    this.list.replaceChildren();

    if (board.entries.length === 0) {
      this.countLabel.textContent = '';
      this.list.appendChild(
        el('li', {
          className: 'sh-board__empty',
          children: [
            el('span', { className: 'sh-board__empty-mark', text: '🏆' }),
            el('strong', { text: 'The board is wide open.' }),
            el('span', {
              text: 'Nobody has posted a run this month. Survive one wave and the top spot is yours.',
            }),
          ],
        }),
      );
      return;
    }

    const rows = this.options.compact ? board.entries.slice(0, 5) : board.entries;
    rows.forEach((entry, index) => this.list.appendChild(this.buildRow(entry, index + 1)));

    this.list.classList.toggle('is-scrollable', rows.length > VISIBLE_ROWS);

    const best = board.entries[0];
    this.countLabel.textContent = this.options.compact
      ? ''
      : `${board.entries.length} survivor${board.entries.length === 1 ? '' : 's'} · wave ${best.wave} to beat`;
  }

  private buildRow(entry: LeaderboardEntry, rank: number): HTMLElement {
    const isMine = this.highlightId !== null && entry.id === this.highlightId;
    const podium = rank <= 3;

    const rankNode = podium
      ? el('span', {
          className: 'sh-board__col sh-board__col--rank sh-board__medal',
          text: MEDALS[rank - 1],
          attrs: { title: `Rank ${rank}` },
        })
      : el('span', { className: 'sh-board__col sh-board__col--rank', text: String(rank) });

    return el('li', {
      className: [
        'sh-board__row',
        isMine ? 'is-mine' : '',
        podium ? `is-podium is-rank-${rank}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      // Drives the staggered entrance without a script per row.
      style: { animationDelay: `${Math.min(rank - 1, 9) * 45}ms` },
      children: [
        rankNode,
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
            isMine ? el('span', { className: 'sh-board__you', text: 'you' }) : null,
          ],
        }),
        el('span', {
          className: 'sh-board__col sh-board__col--wave',
          children: [el('span', { className: 'sh-board__wave-num', text: String(entry.wave) })],
        }),
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
    this.countLabel.textContent = '';
    this.list.replaceChildren(
      el('li', {
        className: 'sh-board__empty',
        children: [
          el('span', { className: 'sh-board__empty-mark', text: '📡' }),
          el('strong', { text: 'Could not reach the board.' }),
          el('span', { text: 'Your runs are still being saved locally.' }),
        ],
      }),
    );
  }
}
