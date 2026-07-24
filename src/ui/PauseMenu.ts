import { button, el } from './dom';
import type { SettingsPanel } from './SettingsPanel';
import pauseBackdrop from '../assets/pause-backdrop.webp';

export interface PauseCallbacks {
  onResume: () => void;
  onOpenShop: () => void;
  onQuitToMenu: () => void;
}

/**
 * Pause overlay.
 *
 * Led by a wide cinematic still of the square at dusk, with the title and run
 * stats sitting over the darkest part of the frame. Deliberately sparse —
 * four actions — so getting back into the fight is never a hunt.
 */
export class PauseMenu {
  readonly root: HTMLElement;

  private readonly waveLabel: HTMLElement;
  private readonly killsLabel: HTMLElement;
  private readonly coinsLabel: HTMLElement;

  constructor(
    private readonly settingsPanel: SettingsPanel,
    callbacks: PauseCallbacks,
  ) {
    this.waveLabel = el('span', { className: 'sh-stat__value', text: '0' });
    this.killsLabel = el('span', { className: 'sh-stat__value', text: '0' });
    this.coinsLabel = el('span', { className: 'sh-stat__value', text: '0' });

    const art = el('div', {
      className: 'sh-pause__art',
      attrs: { 'aria-hidden': 'true' },
      style: { backgroundImage: `url(${pauseBackdrop})` },
      children: [
        el('div', { className: 'sh-pause__scrim' }),
        el('div', {
          className: 'sh-pause__heading',
          children: [
            el('span', { className: 'sh-pause__eyebrow', text: 'Sunset Hollow' }),
            el('h2', { className: 'sh-pause__title', text: 'Paused' }),
          ],
        }),
      ],
    });

    const modal = el('div', {
      className: 'sh-panel sh-modal sh-pause',
      children: [
        art,
        el('div', {
          className: 'sh-modal__body',
          children: [
            el('div', {
              className: 'sh-stats',
              children: [
                el('div', {
                  className: 'sh-stat',
                  children: [this.waveLabel, el('div', { className: 'sh-stat__label', text: 'Wave' })],
                }),
                el('div', {
                  className: 'sh-stat',
                  children: [this.killsLabel, el('div', { className: 'sh-stat__label', text: 'Kills' })],
                }),
                el('div', {
                  className: 'sh-stat',
                  children: [this.coinsLabel, el('div', { className: 'sh-stat__label', text: 'Coins' })],
                }),
              ],
            }),
            el('div', {
              className: 'sh-pause__actions',
              children: [
                button({
                  label: 'Resume',
                  variant: 'primary',
                  icon: '▶',
                  hint: 'Esc',
                  onClick: () => callbacks.onResume(),
                }),
                button({ label: 'Shop', icon: '🛒', hint: 'B', onClick: () => callbacks.onOpenShop() }),
                button({ label: 'Settings', icon: '⚙️', onClick: () => this.settingsPanel.open() }),
                button({
                  label: 'Quit to menu',
                  variant: 'danger',
                  icon: '⏏',
                  onClick: () => callbacks.onQuitToMenu(),
                }),
              ],
            }),
          ],
        }),
      ],
    });

    this.root = el('div', {
      className: 'sh-overlay sh-screen--hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paused' },
      children: [modal],
    });
  }

  open(wave: number, kills: number, coins: number): void {
    this.waveLabel.textContent = String(wave);
    this.killsLabel.textContent = kills.toLocaleString('en-US');
    this.coinsLabel.textContent = coins.toLocaleString('en-US');
    this.root.classList.remove('sh-screen--hidden');
    (this.root.querySelector('button') as HTMLElement | null)?.focus();
  }

  close(): void {
    this.root.classList.add('sh-screen--hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('sh-screen--hidden');
  }
}
