import { button, clearChildren, el } from './dom';
import type { RunStats } from '../systems/EconomySystem';
import { formatTime } from '../utilities/MathUtils';
import { LeaderboardPanel } from './LeaderboardPanel';
import { leaderboard, sanitiseName, MAX_NAME_LENGTH } from '../systems/Leaderboard';

export interface GameOverCallbacks {
  onPlayAgain: () => void;
  onMainMenu: () => void;
}

export interface GameOverData {
  stats: RunStats;
  accuracy: number;
  waveReached: number;
  isNewRecord: boolean;
  bestWave: number;
}

/**
 * End-of-run summary.
 *
 * Appears after the death camera has finished falling, so the player gets a
 * beat to register what happened before the numbers arrive. Stat tiles animate
 * in on a stagger and count up, which turns a results table into a small
 * moment of payoff.
 */
export class GameOverScreen {
  readonly root: HTMLElement;

  /** Standings, shown under the stats so a run ends on the competition. */
  readonly board = new LeaderboardPanel({ compact: true });

  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly recordBadge: HTMLElement;
  private readonly statsGrid: HTMLElement;
  private countUpHandle: number | null = null;

  // --- Score submission ---
  private readonly submitRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly submitStatus: HTMLElement;
  private pendingRun: { wave: number; kills: number; timeSurvived: number } | null = null;

  constructor(callbacks: GameOverCallbacks) {
    this.title = el('h2', { className: 'sh-gameover__title', text: 'Sun Down' });
    this.subtitle = el('p', { className: 'sh-gameover__subtitle', text: '' });
    this.recordBadge = el('span', { className: 'sh-gameover__record', text: '' });
    this.statsGrid = el('div', { className: 'sh-stats' });

    this.nameInput = el('input', {
      className: 'sh-submit__input',
      attrs: {
        type: 'text',
        maxlength: String(MAX_NAME_LENGTH),
        placeholder: 'Your name',
        'aria-label': 'Name for the leaderboard',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    }) as HTMLInputElement;

    // Reflect the cleaning rules as the player types, so what they see on the
    // board is exactly what they typed here.
    this.nameInput.addEventListener('input', () => {
      const cleaned = sanitiseName(this.nameInput.value);
      if (cleaned !== this.nameInput.value) this.nameInput.value = cleaned;
      this.submitButton.disabled = cleaned.trim().length === 0;
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.submitScore();
    });

    this.submitButton = button({
      label: 'Submit score',
      variant: 'primary',
      onClick: () => void this.submitScore(),
    }) as HTMLButtonElement;

    this.submitStatus = el('p', { className: 'sh-submit__status' });

    this.submitRow = el('div', {
      className: 'sh-submit',
      children: [
        el('label', {
          className: 'sh-submit__label',
          text: 'Put your name on the board',
          attrs: { for: 'sh-name-input' },
        }),
        el('div', {
          className: 'sh-submit__row',
          children: [this.nameInput, this.submitButton],
        }),
        this.submitStatus,
      ],
    });
    this.nameInput.id = 'sh-name-input';

    const modal = el('div', {
      className: 'sh-panel sh-modal sh-gameover',
      children: [
        el('div', {
          className: 'sh-modal__header',
          style: { flexDirection: 'column', alignItems: 'stretch' },
          children: [this.title, this.subtitle, this.recordBadge],
        }),
        el('div', {
          className: 'sh-modal__body',
          children: [this.statsGrid, this.submitRow, this.board.root],
        }),
        el('div', {
          className: 'sh-modal__footer',
          children: [
            button({ label: 'Main menu', variant: 'ghost', onClick: () => callbacks.onMainMenu() }),
            button({
              label: 'Play again',
              variant: 'primary',
              icon: '↻',
              onClick: () => callbacks.onPlayAgain(),
            }),
          ],
        }),
      ],
    });

    this.root = el('div', {
      className: 'sh-overlay sh-screen--hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Run complete' },
      children: [modal],
    });
  }

  show(data: GameOverData): void {
    const { stats } = data;

    this.prepareSubmission(data);
    this.board.setHighlight(null);
    void this.board.refresh(true);

    this.subtitle.textContent =
      data.waveReached <= 1
        ? 'The fair claimed you early. The bunting is unimpressed.'
        : data.waveReached < 5
          ? 'A respectable stand. The carousel kept turning without you.'
          : data.waveReached < 10
            ? 'You held the square a good long while.'
            : 'Legendary. They will name a hot-dog stand after you.';

    this.recordBadge.textContent = data.isNewRecord ? '★ New personal best ★' : '';
    this.recordBadge.style.display = data.isNewRecord ? '' : 'none';

    clearChildren(this.statsGrid);

    const tiles: { value: number; label: string; format?: (v: number) => string }[] = [
      { value: data.waveReached, label: 'Wave reached' },
      { value: stats.kills, label: 'Zombies stopped' },
      { value: stats.headshots, label: 'Headshots' },
      { value: data.accuracy * 100, label: 'Accuracy', format: (v) => `${v.toFixed(1)}%` },
      { value: stats.coinsEarned, label: 'Coins earned' },
      { value: stats.highestCombo, label: 'Best combo', format: (v) => `x${v.toFixed(1)}` },
      { value: stats.bossesKilled, label: 'Bosses felled' },
      { value: stats.timeSurvived, label: 'Time survived', format: (v) => formatTime(v) },
    ];

    const valueNodes: { node: HTMLElement; target: number; format: (v: number) => string }[] = [];

    tiles.forEach((tile, index) => {
      const valueNode = el('div', { className: 'sh-stat__value', text: '0' });
      const format = tile.format ?? ((v: number) => Math.round(v).toLocaleString('en-US'));
      valueNodes.push({ node: valueNode, target: tile.value, format });

      this.statsGrid.appendChild(
        el('div', {
          className: 'sh-stat',
          // Stagger the entrance so the grid assembles rather than snapping in.
          style: { animationDelay: `${index * 0.06}s` },
          children: [valueNode, el('div', { className: 'sh-stat__label', text: tile.label })],
        }),
      );
    });

    this.root.classList.remove('sh-screen--hidden');
    (this.root.querySelector('.sh-button--primary') as HTMLElement | null)?.focus();
    this.animateCountUp(valueNodes);
  }

  /** Eases every stat from zero to its final value over ~0.9 s. */
  private animateCountUp(
    nodes: { node: HTMLElement; target: number; format: (v: number) => string }[],
  ): void {
    if (this.countUpHandle !== null) cancelAnimationFrame(this.countUpHandle);

    const duration = 900;
    const start = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out cubic.
      const eased = 1 - Math.pow(1 - t, 3);
      for (const entry of nodes) {
        entry.node.textContent = entry.format(entry.target * eased);
      }
      if (t < 1) {
        this.countUpHandle = requestAnimationFrame(step);
      } else {
        this.countUpHandle = null;
      }
    };

    this.countUpHandle = requestAnimationFrame(step);
  }

  hide(): void {
    if (this.countUpHandle !== null) {
      cancelAnimationFrame(this.countUpHandle);
      this.countUpHandle = null;
    }
    this.root.classList.add('sh-screen--hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('sh-screen--hidden');
  }

  // -------------------------------------------------------------------------
  // Leaderboard submission
  // -------------------------------------------------------------------------

  /** Resets the form for a fresh result and pre-fills the last used name. */
  private prepareSubmission(data: GameOverData): void {
    this.pendingRun = {
      wave: data.waveReached,
      kills: data.stats.kills,
      timeSurvived: data.stats.timeSurvived,
    };

    this.nameInput.value = leaderboard.savedName;
    this.nameInput.disabled = false;
    this.submitButton.disabled = this.nameInput.value.trim().length === 0;
    this.submitButton.textContent = 'Submit score';
    this.submitStatus.textContent = '';
    this.submitStatus.className = 'sh-submit__status';

    // Surviving nothing is not a score.
    const eligible = data.waveReached >= 1;
    this.submitRow.style.display = eligible ? '' : 'none';
  }

  private async submitScore(): Promise<void> {
    if (!this.pendingRun) return;

    const name = sanitiseName(this.nameInput.value).trim();
    if (!name) {
      this.setStatus('Enter a name first.', 'error');
      return;
    }

    // Lock the form immediately: a run token is good for exactly one score,
    // and a double-click would spend it on a duplicate request.
    this.submitButton.disabled = true;
    this.nameInput.disabled = true;
    this.submitButton.textContent = 'Submitting…';

    const result = await leaderboard.submit({ name, ...this.pendingRun });

    this.submitButton.textContent = 'Submitted';

    if (result.global && result.recorded) {
      this.setStatus(
        result.rank ? `You are #${result.rank} this month.` : 'Your score is on the board.',
        'success',
      );
    } else if (result.global && result.reason === 'not a personal best') {
      this.setStatus('Your best run this month still stands.', 'info');
    } else if (result.reason === 'run already submitted') {
      this.setStatus('That run has already been submitted.', 'info');
    } else {
      // Saved locally either way, so say what actually happened.
      this.setStatus('Saved on this device — the global board was unreachable.', 'info');
    }

    this.board.setHighlight(null);
    void this.board.refresh(true);
    this.pendingRun = null;
  }

  private setStatus(message: string, kind: 'success' | 'error' | 'info'): void {
    this.submitStatus.textContent = message;
    this.submitStatus.className = `sh-submit__status is-${kind}`;
  }
}
