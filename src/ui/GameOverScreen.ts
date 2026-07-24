import { button, clearChildren, el } from './dom';
import type { RunStats } from '../systems/EconomySystem';
import { formatTime } from '../utilities/MathUtils';

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

  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly recordBadge: HTMLElement;
  private readonly statsGrid: HTMLElement;
  private countUpHandle: number | null = null;

  constructor(callbacks: GameOverCallbacks) {
    this.title = el('h2', { className: 'sh-gameover__title', text: 'Sun Down' });
    this.subtitle = el('p', { className: 'sh-gameover__subtitle', text: '' });
    this.recordBadge = el('span', { className: 'sh-gameover__record', text: '' });
    this.statsGrid = el('div', { className: 'sh-stats' });

    const modal = el('div', {
      className: 'sh-panel sh-modal sh-gameover',
      children: [
        el('div', {
          className: 'sh-modal__header',
          style: { flexDirection: 'column', alignItems: 'stretch' },
          children: [this.title, this.subtitle, this.recordBadge],
        }),
        el('div', { className: 'sh-modal__body', children: [this.statsGrid] }),
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
}
