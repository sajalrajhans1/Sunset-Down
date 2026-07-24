import { el } from './dom';
import { HUD } from './HUD';
import { MainMenu, type MainMenuCallbacks } from './MainMenu';
import { PauseMenu, type PauseCallbacks } from './PauseMenu';
import { ShopMenu, type ShopCallbacks } from './ShopMenu';
import { GameOverScreen, type GameOverCallbacks } from './GameOverScreen';
import type { PlayerStats } from '../game/PlayerStats';
import type { EconomySystem } from '../systems/EconomySystem';
import type { WeaponManager } from '../weapons/WeaponManager';
import { settings } from '../game/Settings';

export type Screen = 'loading' | 'menu' | 'playing' | 'paused' | 'shop' | 'gameover';

/**
 * Owns every DOM screen and the transitions between them.
 *
 * Screen state is a single enum rather than a set of booleans, so it's
 * impossible to end up with, say, the pause menu and the shop both believing
 * they own the pointer.
 */
export class UIManager {
  readonly hud = new HUD();
  readonly mainMenu: MainMenu;
  readonly pauseMenu: PauseMenu;
  readonly shopMenu: ShopMenu;
  readonly gameOver: GameOverScreen;

  private readonly container: HTMLElement;
  private readonly loadingScreen: HTMLElement;
  private readonly loadingFill: HTMLElement;
  private readonly loadingStatus: HTMLElement;

  private screen: Screen = 'loading';

  constructor(options: {
    root: HTMLElement;
    stats: PlayerStats;
    economy: EconomySystem;
    weapons: WeaponManager;
    menu: MainMenuCallbacks;
    pause: PauseCallbacks;
    shop: ShopCallbacks;
    gameOver: GameOverCallbacks;
  }) {
    this.container = options.root;

    this.mainMenu = new MainMenu(options.menu);
    this.pauseMenu = new PauseMenu(this.mainMenu.settingsPanel, options.pause);
    this.shopMenu = new ShopMenu(options.stats, options.economy, options.weapons, options.shop);
    this.gameOver = new GameOverScreen(options.gameOver);

    this.loadingFill = el('div', { className: 'sh-loading__fill' });
    this.loadingStatus = el('div', { className: 'sh-loading__status', text: 'Waking the village' });
    this.loadingScreen = el('div', {
      className: 'sh-loading',
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [
        el('div', { className: 'sh-loading__mark', text: 'Sunset Hollow' }),
        el('div', { className: 'sh-loading__track', children: [this.loadingFill] }),
        this.loadingStatus,
      ],
    });

    this.hud.setVisible(false);
    this.mainMenu.hide();

    this.container.append(
      this.hud.root,
      this.mainMenu.root,
      this.shopMenu.root,
      this.pauseMenu.root,
      this.gameOver.root,
      this.loadingScreen,
    );

    // Apply accessibility preferences to the document root once at startup.
    document.documentElement.dataset.reducedMotion = String(settings.current.reducedMotion);
    document.documentElement.dataset.contrast = settings.current.highContrastUi ? 'high' : 'normal';
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  setLoadingProgress(fraction: number, status?: string): void {
    this.loadingFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    if (status) this.loadingStatus.textContent = status;
  }

  finishLoading(): void {
    this.loadingScreen.classList.add('is-done');
    // Remove from the layer stack once the fade completes.
    window.setTimeout(() => {
      this.loadingScreen.style.display = 'none';
    }, 600);
  }

  // -------------------------------------------------------------------------
  // Screen routing
  // -------------------------------------------------------------------------

  get current(): Screen {
    return this.screen;
  }

  /** True when a modal owns the pointer and gameplay input must be suspended. */
  get isModalOpen(): boolean {
    return (
      this.screen === 'menu' ||
      this.screen === 'paused' ||
      this.screen === 'shop' ||
      this.screen === 'gameover'
    );
  }

  show(screen: Screen): void {
    this.screen = screen;

    this.mainMenu.hide();
    this.pauseMenu.close();
    this.shopMenu.close();
    this.gameOver.hide();
    this.hud.setVisible(false);

    switch (screen) {
      case 'menu':
        this.mainMenu.show();
        break;
      case 'playing':
        this.hud.setVisible(true);
        break;
      case 'paused':
        this.hud.setVisible(true);
        break;
      case 'shop':
        this.hud.setVisible(true);
        break;
      case 'gameover':
        break;
      case 'loading':
      default:
        break;
    }
  }

  /**
   * Routes an Escape press to whichever layer should handle it.
   * Returns the action the game should take.
   */
  handleEscape(): 'closed-modal' | 'toggle-pause' | 'none' {
    if (this.mainMenu.hasOpenModal) {
      this.mainMenu.closeModals();
      return 'closed-modal';
    }
    if (this.screen === 'menu') return 'none';
    if (this.screen === 'gameover') return 'none';
    if (this.shopMenu.isOpen) return 'closed-modal';
    return 'toggle-pause';
  }

  dispose(): void {
    this.container.replaceChildren();
  }
}
