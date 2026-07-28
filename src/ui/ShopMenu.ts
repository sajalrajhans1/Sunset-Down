import { button, clearChildren, el, formatCoins } from './dom';
import type { UpgradeId } from '../game/Config';
import type { PlayerStats } from '../game/PlayerStats';
import type { EconomySystem } from '../systems/EconomySystem';
import type { WeaponManager } from '../weapons/WeaponManager';
import { WEAPONS, type WeaponId } from '../weapons/WeaponDefs';
import { audio } from '../audio/AudioManager';
import { WEAPON_ART } from './WeaponArt';

export interface ShopCallbacks {
  onBuyUpgrade: (id: UpgradeId) => boolean;
  onBuyWeapon: (id: WeaponId) => boolean;
  onBuyAmmo: () => boolean;
  onClose: () => void;
  onStartWave: () => void;
}

/** A left-rail entry. Weapon categories hold one weapon each, as in Valorant. */
interface Category {
  id: string;
  label: string;
  group: 'armory' | 'loadout';
  weapons?: WeaponId[];
  upgrades?: UpgradeId[];
}

const CATEGORIES: Category[] = [
  { id: 'sidearms', label: 'Sidearms', group: 'armory', weapons: ['pistol'] },
  { id: 'smgs', label: 'SMGs', group: 'armory', weapons: ['smg'] },
  { id: 'shotguns', label: 'Shotguns', group: 'armory', weapons: ['shotgun'] },
  { id: 'rifles', label: 'Rifles', group: 'armory', weapons: ['rifle'] },
  { id: 'snipers', label: 'Sniper Rifles', group: 'armory', weapons: ['sniper'] },
  { id: 'combat', label: 'Combat', group: 'loadout', upgrades: ['damage', 'firerate', 'crit'] },
  { id: 'survival', label: 'Survival', group: 'loadout', upgrades: ['health', 'armor', 'speed'] },
  { id: 'utility', label: 'Utility', group: 'loadout', upgrades: ['reload', 'magazine'] },
];

/**
 * The buy menu, built on Valorant's interface language: a fixed category rail
 * down the left, a large credit counter in the header, and a grid of flat,
 * sharp-cornered cards with the name top-left and the price top-right.
 *
 * The visual grammar is borrowed; the palette stays with this game's sunset
 * gold so the screen doesn't feel bolted on from another product.
 */
export class ShopMenu {
  readonly root: HTMLElement;

  private readonly creditValue: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly categoryTitle: HTMLElement;
  private readonly categorySub: HTMLElement;
  private readonly startWaveButton: HTMLButtonElement;
  private readonly railButtons = new Map<string, HTMLButtonElement>();
  private activeCategory = 'combat';

  constructor(
    private readonly stats: PlayerStats,
    private readonly economy: EconomySystem,
    private readonly weapons: WeaponManager,
    private readonly callbacks: ShopCallbacks,
  ) {
    this.creditValue = el('span', { className: 'sh-wallet__value', text: '0' });
    this.grid = el('div', { className: 'sh-buy__grid' });
    this.rail = el('nav', { className: 'sh-buy__rail', attrs: { 'aria-label': 'Categories' } });
    this.categoryTitle = el('h3', { className: 'sh-buy__heading', text: 'Combat' });
    this.categorySub = el('p', { className: 'sh-buy__subheading', text: '' });

    this.buildRail();

    this.startWaveButton = button({
      label: 'Start next wave',
      variant: 'primary',
      icon: '⚔',
      onClick: () => this.callbacks.onStartWave(),
    });

    const modal = el('div', {
      className: 'sh-buy',
      children: [
        // --- Header -------------------------------------------------------
        el('header', {
          className: 'sh-buy__header',
          children: [
            el('div', {
              children: [
                el('div', { className: 'sh-buy__eyebrow', text: 'Fairground Supply' }),
                el('div', { className: 'sh-buy__title', text: 'Buy Menu' }),
              ],
            }),
            el('div', {
              className: 'sh-wallet',
              children: [
                el('span', { className: 'sh-wallet__label', text: 'Creds' }),
                this.creditValue,
              ],
            }),
          ],
        }),

        // --- Rail + grid --------------------------------------------------
        el('div', {
          className: 'sh-buy__body',
          children: [
            this.rail,
            el('section', {
              className: 'sh-buy__main',
              children: [
                el('div', {
                  className: 'sh-buy__mainhead',
                  children: [this.categoryTitle, this.categorySub],
                }),
                this.grid,
              ],
            }),
          ],
        }),

        // --- Footer -------------------------------------------------------
        el('footer', {
          className: 'sh-buy__footer',
          children: [
            button({
              label: 'Refill all ammo',
              variant: 'ghost',
              icon: '📦',
              onClick: () => {
                if (this.callbacks.onBuyAmmo()) this.refresh();
              },
            }),
            el('div', { style: { flex: '1' } }),
            this.startWaveButton,
            button({ label: 'Close', variant: 'ghost', hint: 'B', onClick: () => this.callbacks.onClose() }),
          ],
        }),
      ],
    });

    this.root = el('div', {
      className: 'sh-overlay sh-overlay--buy sh-screen--hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Buy menu' },
      children: [modal],
    });

    this.root.addEventListener('pointerdown', (event) => {
      if (event.target === this.root) this.callbacks.onClose();
    });
  }

  // -------------------------------------------------------------------------
  // Rail
  // -------------------------------------------------------------------------

  private buildRail(): void {
    for (const group of ['armory', 'loadout'] as const) {
      this.rail.appendChild(
        el('div', {
          className: 'sh-buy__railgroup',
          text: group === 'armory' ? 'Armory' : 'Loadout',
        }),
      );

      for (const category of CATEGORIES.filter((c) => c.group === group)) {
        const node = el('button', {
          className: 'sh-buy__railitem',
          attrs: { type: 'button' },
          children: [
            el('span', { className: 'sh-buy__railtext', text: category.label }),
            el('span', { className: 'sh-buy__railmark' }),
          ],
          on: {
            pointerenter: () => audio.sfx.uiHover(),
            click: () => {
              audio.sfx.uiClick();
              this.setCategory(category.id);
            },
          },
        });
        this.railButtons.set(category.id, node);
        this.rail.appendChild(node);
      }
    }
  }

  private setCategory(id: string): void {
    this.activeCategory = id;
    for (const [key, node] of this.railButtons) {
      const active = key === id;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-current', String(active));
    }
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Grid
  // -------------------------------------------------------------------------

  refresh(): void {
    this.creditValue.textContent = formatCoins(this.economy.coins);

    const category = CATEGORIES.find((c) => c.id === this.activeCategory) ?? CATEGORIES[0];
    this.categoryTitle.textContent = category.label;
    this.categorySub.textContent =
      category.group === 'armory'
        ? 'Purchases are permanent for the rest of the run.'
        : 'Upgrades apply to every weapon you carry.';

    for (const [key, node] of this.railButtons) {
      node.classList.toggle('is-active', key === category.id);
    }

    clearChildren(this.grid);

    if (category.weapons) {
      for (const id of category.weapons) this.grid.appendChild(this.weaponCard(id));
    }
    if (category.upgrades) {
      for (const id of category.upgrades) this.grid.appendChild(this.upgradeCard(id));
    }
  }

  private weaponCard(id: WeaponId): HTMLElement {
    const def = WEAPONS[id];
    const owned = this.weapons.has(id);
    const affordable = this.economy.canAfford(def.price);
    const dps = Math.round((def.damage * def.pellets) / def.fireInterval);

    const card = el('button', {
      className: `sh-buycard sh-buycard--weapon${owned ? ' is-owned' : ''}${!owned && !affordable ? ' is-locked' : ''}`,
      attrs: { type: 'button' },
      children: [
        el('div', {
          className: 'sh-buycard__top',
          children: [
            el('span', { className: 'sh-buycard__name', text: def.name }),
            el('span', {
              className: 'sh-buycard__price',
              text: owned ? 'Owned' : def.price === 0 ? 'Free' : formatCoins(def.price),
            }),
          ],
        }),
        el('div', {
          className: 'sh-buycard__art sh-buycard__art--weapon',
          children: [
            el('img', {
              className: 'sh-buycard__image',
              attrs: {
                src: WEAPON_ART[id],
                alt: def.name,
                // Eager: the whole set is ~100 kB and lazy-loading inside a
                // hidden modal makes the art pop in after the panel opens.
                loading: 'eager',
                decoding: 'async',
              },
            }),
          ],
        }),
        el('div', {
          className: 'sh-buycard__stats',
          children: [
            statChip('DMG', String(Math.round(def.damage * def.pellets))),
            statChip('DPS', String(dps)),
            statChip('MAG', String(def.magazineSize)),
            statChip(
              'MODE',
              def.fireMode === 'auto'
                ? 'Auto'
                : def.fireMode === 'semi'
                  ? 'Semi'
                  : def.fireMode === 'pump'
                    ? 'Pump'
                    : 'Bolt',
            ),
          ],
        }),
        el('div', { className: 'sh-buycard__tagline', text: def.tagline }),
      ],
      on: {
        pointerenter: () => audio.sfx.uiHover(),
        click: () => {
          if (owned) {
            audio.sfx.uiClick();
            this.weapons.equipWeapon(id);
            return;
          }
          if (this.callbacks.onBuyWeapon(id)) this.refresh();
        },
      },
    });

    return card;
  }

  private upgradeCard(id: UpgradeId): HTMLElement {
    const def = this.stats.defOf(id);
    const level = this.stats.levelOf(id);
    const maxed = this.stats.isMaxed(id);
    const cost = this.stats.nextCost(id);
    const affordable = cost !== null && this.economy.canAfford(cost);

    // One pip per available level — progress readable without parsing numbers.
    const pipRow = el('div', { className: 'sh-buycard__pips' });
    for (let i = 0; i < def.maxLevel; i++) {
      pipRow.appendChild(el('span', { className: `sh-pip${i < level ? ' is-filled' : ''}` }));
    }

    return el('button', {
      className: `sh-buycard${maxed ? ' is-owned' : ''}${!maxed && !affordable ? ' is-locked' : ''}`,
      attrs: { type: 'button' },
      children: [
        el('div', {
          className: 'sh-buycard__top',
          children: [
            el('span', { className: 'sh-buycard__name', text: def.name }),
            el('span', {
              className: 'sh-buycard__price',
              text: maxed ? 'Max' : formatCoins(cost!),
            }),
          ],
        }),
        el('div', {
          className: 'sh-buycard__art',
          children: [el('span', { className: 'sh-buycard__glyph', text: def.icon, attrs: { 'aria-hidden': 'true' } })],
        }),
        el('div', {
          className: 'sh-buycard__stats',
          children: [
            statChip('LVL', `${level}/${def.maxLevel}`),
            statChip('NOW', this.stats.describe(id)),
            statChip('NEXT', this.stats.describeNext(id)),
          ],
        }),
        pipRow,
        el('div', { className: 'sh-buycard__tagline', text: def.description }),
      ],
      on: {
        pointerenter: () => {
          if (!maxed) audio.sfx.uiHover();
        },
        click: () => {
          if (maxed) return;
          if (this.callbacks.onBuyUpgrade(id)) this.refresh();
        },
      },
    });
  }

  // -------------------------------------------------------------------------

  open(canStartWave: boolean): void {
    this.startWaveButton.style.display = canStartWave ? '' : 'none';
    this.setCategory(this.activeCategory);
    this.root.classList.remove('sh-screen--hidden');
    (this.root.querySelector('.sh-buycard') as HTMLElement | null)?.focus();
  }

  close(): void {
    this.root.classList.add('sh-screen--hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('sh-screen--hidden');
  }
}

function statChip(label: string, value: string): HTMLElement {
  return el('div', {
    className: 'sh-chip',
    children: [
      el('span', { className: 'sh-chip__label', text: label }),
      el('span', { className: 'sh-chip__value', text: value }),
    ],
  });
}
