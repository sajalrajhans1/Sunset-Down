import * as THREE from 'three';
import { el, formatCoins } from './dom';
import { settings } from '../game/Settings';
import { Minimap } from './Minimap';
import type { Zombie } from '../components/Zombie';
import type { WaveSnapshot } from '../systems/WaveSystem';
import type { Weapon } from '../weapons/Weapon';
import { clamp01, formatTime } from '../utilities/MathUtils';

export interface HudFrameData {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  stamina: number;
  coins: number;
  wave: WaveSnapshot;
  weapon: Weapon | null;
  combo: number;
  comboKills: number;
  comboFraction: number;
  crosshairSpread: number;
  aiming: boolean;
  scoped: boolean;
  fps: number;
  frameMs: number;
  bossName: string | null;
  bossHealthFraction: number;
  promptText: string | null;
}

interface KillFeedEntry {
  node: HTMLElement;
  timer: number;
}

interface DamageArrow {
  node: HTMLElement;
  timer: number;
  worldDirection: THREE.Vector2;
}

/** A zombie closing in from outside the player's view. */
export interface ThreatCue {
  /** Normalised world-space direction from the player to the zombie. */
  x: number;
  z: number;
  /** 0..1, rising as it gets closer. */
  intensity: number;
  /** True once it is within swinging distance. */
  imminent: boolean;
}

interface ThreatSlot {
  node: HTMLElement;
  active: boolean;
}

/**
 * The in-game heads-up display.
 *
 * Runs every frame, so it is written to avoid layout thrash: values are cached
 * and only written to the DOM when they actually change, bars animate via
 * `transform: scaleX` (compositor-only), and nothing here ever reads back a
 * computed style.
 */
export class HUD {
  readonly root: HTMLElement;
  readonly minimap = new Minimap();

  // Cached element references.
  private readonly healthFill: HTMLElement;
  private readonly healthGhost: HTMLElement;
  private readonly healthLabel: HTMLElement;
  private readonly armorRow: HTMLElement;
  private readonly armorFill: HTMLElement;
  private readonly armorLabel: HTMLElement;
  private readonly staminaRow: HTMLElement;
  private readonly staminaFill: HTMLElement;
  private readonly vitals: HTMLElement;

  private readonly ammoWeapon: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly reloadFill: HTMLElement;

  private readonly wavePanel: HTMLElement;
  private readonly waveNumber: HTMLElement;
  private readonly waveStatus: HTMLElement;

  private readonly coinsPanel: HTMLElement;
  private readonly coinsValue: HTMLElement;

  private readonly comboPanel: HTMLElement;
  private readonly comboValue: HTMLElement;
  private readonly comboTrackFill: HTMLElement;

  private readonly killFeed: HTMLElement;
  private readonly damageRing: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitMarker: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSubtitle: HTMLElement;
  private readonly bossBar: HTMLElement;
  private readonly bossName: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly countdownValue: HTMLElement;
  private lastCountdownTick = -1;
  private readonly fpsPanel: HTMLElement;
  private readonly fpsValue: HTMLElement;
  private readonly fpsFrame: HTMLElement;

  // Change-detection caches.
  private lastHealth = -1;
  private lastArmor = -1;
  private lastCoins = -1;
  private lastAmmo = -1;
  private lastReserve = -1;
  private lastWeaponName = '';
  private lastWaveNumber = -1;
  private lastStatus = '';
  private lastFpsText = '';
  private ghostHealth = 1;

  private readonly killEntries: KillFeedEntry[] = [];
  private readonly damageArrows: DamageArrow[] = [];
  /** Fixed pool: threat cues update every frame, so nothing is allocated. */
  private readonly threatSlots: ThreatSlot[] = [];
  private static readonly MAX_THREATS = 4;
  private hitMarkerTimer = 0;
  private bannerTimer = 0;

  constructor() {
    // --- Crosshair + hit marker ---
    this.crosshair = el('div', {
      className: 'sh-crosshair',
      attrs: { 'aria-hidden': 'true' },
      children: [
        el('span', { className: 'sh-crosshair__line sh-crosshair__line--top' }),
        el('span', { className: 'sh-crosshair__line sh-crosshair__line--bottom' }),
        el('span', { className: 'sh-crosshair__line sh-crosshair__line--left' }),
        el('span', { className: 'sh-crosshair__line sh-crosshair__line--right' }),
        el('span', { className: 'sh-crosshair__dot' }),
      ],
    });

    this.hitMarker = el('div', {
      className: 'sh-hitmarker',
      attrs: { 'aria-hidden': 'true' },
      children: [el('span'), el('span'), el('span'), el('span')],
    });

    // --- Vitals ---------------------------------------------------------
    // A single bevelled plate holding a heart badge and the three bars, so the
    // corner reads as one designed object rather than three stacked pills.
    this.healthFill = el('span', { className: 'sh-vital__fill' });
    this.healthGhost = el('span', { className: 'sh-vital__ghost' });
    this.healthLabel = el('span', { className: 'sh-vital__readout' });
    this.armorFill = el('span', { className: 'sh-vital__fill' });
    this.armorLabel = el('span', { className: 'sh-vital__readout' });
    this.staminaFill = el('span', { className: 'sh-vital__fill' });

    const healthRow = el('div', {
      className: 'sh-vital sh-vital--health',
      children: [
        el('span', { className: 'sh-vital__track', children: [this.healthGhost, this.healthFill] }),
        // Notches sit above the fill and imply a segmented capacity.
        el('span', { className: 'sh-vital__notches', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'sh-vital__shine', attrs: { 'aria-hidden': 'true' } }),
        this.healthLabel,
      ],
    });

    this.armorRow = el('div', {
      className: 'sh-vital sh-vital--armor',
      children: [
        el('span', { className: 'sh-vital__track', children: [this.armorFill] }),
        el('span', { className: 'sh-vital__notches', attrs: { 'aria-hidden': 'true' } }),
        this.armorLabel,
      ],
    });

    this.staminaRow = el('div', {
      className: 'sh-vital sh-vital--stamina',
      children: [el('span', { className: 'sh-vital__track', children: [this.staminaFill] })],
    });

    this.vitals = el('div', {
      className: 'sh-vitals',
      attrs: { role: 'status', 'aria-live': 'off' },
      children: [
        el('div', {
          className: 'sh-vitals__badge',
          attrs: { 'aria-hidden': 'true' },
          children: [el('span', { className: 'sh-vitals__heart', text: '❤' })],
        }),
        el('div', {
          className: 'sh-vitals__bars',
          children: [healthRow, this.armorRow, this.staminaRow],
        }),
      ],
    });

    // --- Ammo ---
    this.ammoWeapon = el('div', { className: 'sh-ammo__weapon', text: '—' });
    this.ammoMag = el('span', { className: 'sh-ammo__mag', text: '0' });
    this.ammoReserve = el('span', { className: 'sh-ammo__reserve', text: '0' });
    this.reloadFill = el('span');
    this.reloadBar = el('div', { className: 'sh-ammo__reload', children: [this.reloadFill] });

    const ammo = el('div', {
      className: 'sh-ammo',
      children: [
        this.ammoWeapon,
        el('div', {
          className: 'sh-ammo__counts',
          children: [
            this.ammoMag,
            el('span', { className: 'sh-ammo__sep', text: '/' }),
            this.ammoReserve,
          ],
        }),
        this.reloadBar,
      ],
    });

    // --- Wave panel ---
    this.waveNumber = el('div', { className: 'sh-wave__number', text: '0' });
    this.waveStatus = el('div', { className: 'sh-wave__status', text: 'Get ready' });
    this.wavePanel = el('div', {
      className: 'sh-wave',
      children: [
        el('div', { className: 'sh-wave__label', text: 'Wave' }),
        this.waveNumber,
        this.waveStatus,
      ],
    });

    // --- Coins ---
    this.coinsValue = el('span', { text: '0' });
    this.coinsPanel = el('div', {
      className: 'sh-coins',
      children: [el('span', { className: 'sh-coins__icon', text: '🪙' }), this.coinsValue],
    });

    // --- Combo ---
    this.comboValue = el('div', { className: 'sh-combo__value', text: 'x1.0' });
    this.comboTrackFill = el('span');
    this.comboPanel = el('div', {
      className: 'sh-combo',
      children: [
        this.comboValue,
        el('div', { className: 'sh-combo__label', text: 'Combo' }),
        el('div', { className: 'sh-combo__track', children: [this.comboTrackFill] }),
      ],
    });

    // --- Kill feed, damage arrows, boss bar ---
    this.killFeed = el('div', { className: 'sh-killfeed', attrs: { 'aria-hidden': 'true' } });
    this.damageRing = el('div', { className: 'sh-damage-ring', attrs: { 'aria-hidden': 'true' } });

    // Pre-built threat cues, shown and hidden rather than created per frame.
    for (let i = 0; i < HUD.MAX_THREATS; i++) {
      const node = el('div', { className: 'sh-threat' });
      this.damageRing.appendChild(node);
      this.threatSlots.push({ node, active: false });
    }

    this.bossName = el('div', { className: 'sh-bossbar__name', text: 'Boss' });
    this.bossFill = el('div', { className: 'sh-bossbar__fill' });
    this.bossBar = el('div', {
      className: 'sh-bossbar',
      children: [this.bossName, el('div', { className: 'sh-bossbar__track', children: [this.bossFill] })],
    });

    // --- Banner ---
    this.bannerTitle = el('div', { className: 'sh-banner__title', text: '' });
    this.bannerSubtitle = el('div', { className: 'sh-banner__subtitle', text: '' });
    this.banner = el('div', {
      className: 'sh-banner',
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [this.bannerTitle, this.bannerSubtitle],
    });

    // --- Scope, prompt, FPS ---
    this.scope = el('div', {
      className: 'sh-scope',
      attrs: { 'aria-hidden': 'true' },
      children: [el('div', { className: 'sh-scope__reticle' })],
    });

    this.prompt = el('div', { className: 'sh-prompt' });

    // Pre-wave countdown: the clearest possible signal that a wave is about
    // to land, sitting dead centre where the player is already looking.
    this.countdownValue = el('div', { className: 'sh-countdown__value', text: '' });
    this.countdown = el('div', {
      className: 'sh-countdown',
      attrs: { 'aria-hidden': 'true' },
      children: [
        el('div', { className: 'sh-countdown__label', text: 'Next wave in' }),
        this.countdownValue,
      ],
    });

    this.fpsValue = el('b', { text: '60' });
    this.fpsFrame = el('span', { text: '16.7 ms' });
    this.fpsPanel = el('div', {
      className: 'sh-fps',
      attrs: { 'aria-hidden': 'true' },
      children: [
        el('span', { children: [this.fpsValue, document.createTextNode(' FPS')] }),
        this.fpsFrame,
      ],
    });

    this.root = el('div', {
      className: 'sh-hud',
      children: [
        this.scope,
        this.crosshair,
        this.hitMarker,
        this.vitals,
        ammo,
        this.wavePanel,
        this.coinsPanel,
        this.comboPanel,
        this.killFeed,
        this.damageRing,
        this.bossBar,
        this.banner,
        this.countdown,
        this.prompt,
        this.fpsPanel,
        this.minimap.root,
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(
    dt: number,
    data: HudFrameData,
    cameraYaw: number,
    playerPosition?: THREE.Vector3,
    zombies?: readonly Zombie[],
  ): void {
    this.updateCountdown(data);
    if (playerPosition && zombies) {
      this.minimap.update(dt, playerPosition, cameraYaw, zombies);
    }
    this.updateVitals(dt, data);
    this.updateAmmo(data);
    this.updateWave(data);
    this.updateCoins(data);
    this.updateCombo(data);
    this.updateCrosshair(data);
    this.updateBoss(data);
    this.updatePrompt(data);
    this.updateFps(data);
    this.updateTransients(dt, cameraYaw);
  }

  /**
   * Counts the wave in. The last five seconds tick one number at a time with
   * an audible beep, so the transition from "shopping" to "fighting" is
   * impossible to miss.
   */
  private updateCountdown(data: HudFrameData): void {
    const { wave } = data;
    const arming = (wave.phase === 'prep' || wave.phase === 'cleared') && wave.prepRemaining > 0;

    this.countdown.classList.toggle('is-active', arming);
    if (!arming) {
      this.lastCountdownTick = -1;
      return;
    }

    const seconds = Math.ceil(wave.prepRemaining);
    this.countdown.classList.toggle('is-imminent', seconds <= 5);

    if (seconds !== this.lastCountdownTick) {
      this.lastCountdownTick = seconds;
      this.countdownValue.textContent = seconds <= 5 ? String(seconds) : formatTime(wave.prepRemaining);
      // Restart the pop animation on every tick.
      this.countdownValue.classList.remove('is-tick');
      void this.countdownValue.offsetWidth;
      this.countdownValue.classList.add('is-tick');
    }
  }

  private updateVitals(dt: number, data: HudFrameData): void {
    const healthFraction = clamp01(data.health / Math.max(1, data.maxHealth));

    if (Math.abs(healthFraction - this.lastHealth) > 0.0015) {
      this.lastHealth = healthFraction;
      this.healthFill.style.transform = `scaleX(${healthFraction})`;
      // Hue shifts green → gold → red as you bleed out, so peripheral vision
      // reads your state from colour alone without parsing the number.
      const hue = 128 * healthFraction * healthFraction;
      this.healthFill.style.setProperty('--sh-vital-hue', hue.toFixed(0));
      this.healthLabel.textContent = '';
      this.healthLabel.append(
        el('span', { className: 'sh-vital__name', text: 'Health' }),
        el('span', {
          className: 'sh-vital__digits',
          children: [
            el('b', { text: String(Math.ceil(data.health)) }),
            el('i', { text: `/${Math.round(data.maxHealth)}` }),
          ],
        }),
      );
      this.vitals.classList.toggle('sh-vitals--critical', healthFraction <= 0.3);
      this.vitals.classList.toggle('sh-vitals--hurt', healthFraction <= 0.6);
    }

    // The ghost bar chases the real value, revealing how much was just lost.
    if (this.ghostHealth > healthFraction) {
      this.ghostHealth = Math.max(healthFraction, this.ghostHealth - dt * 0.55);
    } else {
      this.ghostHealth = healthFraction;
    }
    this.healthGhost.style.transform = `scaleX(${this.ghostHealth})`;

    const armorFraction = data.maxArmor > 0 ? clamp01(data.armor / data.maxArmor) : 0;
    const showArmor = data.maxArmor > 0;
    this.armorRow.style.display = showArmor ? '' : 'none';
    if (showArmor && Math.abs(armorFraction - this.lastArmor) > 0.0015) {
      this.lastArmor = armorFraction;
      this.armorFill.style.transform = `scaleX(${armorFraction})`;
      this.armorLabel.textContent = '';
      this.armorLabel.append(
        el('span', { className: 'sh-vital__name', text: 'Armor' }),
        el('span', {
          className: 'sh-vital__digits',
          children: [el('b', { text: String(Math.ceil(data.armor)) })],
        }),
      );
    }

    // Stamina only appears when it matters.
    const showStamina = data.stamina < 0.995;
    this.staminaRow.style.opacity = showStamina ? '1' : '0';
    this.staminaFill.style.transform = `scaleX(${clamp01(data.stamina)})`;
  }

  private updateAmmo(data: HudFrameData): void {
    const weapon = data.weapon;
    if (!weapon) return;

    if (weapon.def.name !== this.lastWeaponName) {
      this.lastWeaponName = weapon.def.name;
      this.ammoWeapon.textContent = weapon.def.name;
    }

    if (weapon.ammoInMagazine !== this.lastAmmo) {
      this.lastAmmo = weapon.ammoInMagazine;
      this.ammoMag.textContent = String(weapon.ammoInMagazine);
      const low = weapon.ammoInMagazine <= Math.max(1, Math.ceil(weapon.magazineCapacity * 0.25));
      this.ammoMag.classList.toggle('is-low', low);
    }

    if (weapon.reserveAmmo !== this.lastReserve) {
      this.lastReserve = weapon.reserveAmmo;
      this.ammoReserve.textContent = String(weapon.reserveAmmo);
    }

    const reloading = weapon.isReloading;
    this.reloadBar.classList.toggle('is-active', reloading);
    if (reloading) this.reloadFill.style.transform = `scaleX(${weapon.reloadProgress})`;
  }

  private updateWave(data: HudFrameData): void {
    const { wave } = data;

    if (wave.waveNumber !== this.lastWaveNumber) {
      this.lastWaveNumber = wave.waveNumber;
      this.waveNumber.textContent = String(wave.waveNumber);
    }
    this.wavePanel.classList.toggle('sh-wave--boss', wave.isBossWave);

    const status =
      wave.phase === 'prep' || wave.phase === 'cleared'
        ? `Next wave in ${formatTime(wave.prepRemaining)}`
        : wave.remaining === 1
          ? '1 zombie left'
          : `${wave.remaining} zombies left`;

    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.waveStatus.textContent = status;
    }
  }

  private updateCoins(data: HudFrameData): void {
    if (data.coins === this.lastCoins) return;
    const increased = data.coins > this.lastCoins && this.lastCoins >= 0;
    this.lastCoins = data.coins;
    this.coinsValue.textContent = formatCoins(data.coins);

    if (increased) {
      // Restart the bump animation by forcing a reflow of the class.
      this.coinsPanel.classList.remove('is-bumped');
      void this.coinsPanel.offsetWidth;
      this.coinsPanel.classList.add('is-bumped');
    }
  }

  private updateCombo(data: HudFrameData): void {
    const active = data.combo > 1.001;
    this.comboPanel.classList.toggle('is-active', active);
    if (!active) return;
    this.comboValue.textContent = `x${data.combo.toFixed(1)}`;
    this.comboTrackFill.style.transform = `scaleX(${data.comboFraction})`;
  }

  private updateCrosshair(data: HudFrameData): void {
    // Crosshair gap tracks the weapon's real cone, so it always tells the truth.
    const spread = 3 + data.crosshairSpread * 4.6;
    this.crosshair.style.setProperty('--sh-spread', `${spread.toFixed(1)}px`);
    this.crosshair.classList.toggle('sh-crosshair--hidden', data.scoped);
    this.scope.classList.toggle('is-active', data.scoped);
  }

  private updateBoss(data: HudFrameData): void {
    const active = data.bossName !== null;
    this.bossBar.classList.toggle('is-active', active);
    if (!active) return;
    this.bossName.textContent = data.bossName!;
    this.bossFill.style.transform = `scaleX(${clamp01(data.bossHealthFraction)})`;
  }

  private updatePrompt(data: HudFrameData): void {
    const active = data.promptText !== null;
    this.prompt.classList.toggle('is-active', active);
    if (active && this.prompt.dataset.text !== data.promptText) {
      this.prompt.dataset.text = data.promptText!;
      this.prompt.innerHTML = data.promptText!;
    }
  }

  private updateFps(data: HudFrameData): void {
    const show = settings.current.showFps;
    this.fpsPanel.style.display = show ? '' : 'none';
    if (!show) return;

    const text = String(Math.round(data.fps));
    if (text === this.lastFpsText) return;
    this.lastFpsText = text;
    this.fpsValue.textContent = text;
    this.fpsValue.className = data.fps >= 55 ? '' : data.fps >= 35 ? 'is-warn' : 'is-bad';
    this.fpsFrame.textContent = `${data.frameMs.toFixed(1)} ms`;
  }

  /** Ticks kill-feed entries, damage arrows and the hit marker. */
  private updateTransients(dt: number, cameraYaw: number): void {
    for (let i = this.killEntries.length - 1; i >= 0; i--) {
      const entry = this.killEntries[i];
      entry.timer -= dt;
      if (entry.timer <= 0) {
        entry.node.classList.add('is-leaving');
        // Remove after the exit animation has had time to play.
        if (entry.timer < -0.32) {
          entry.node.remove();
          this.killEntries.splice(i, 1);
        }
      }
    }

    for (let i = this.damageArrows.length - 1; i >= 0; i--) {
      const arrow = this.damageArrows[i];
      arrow.timer -= dt;
      if (arrow.timer <= 0) {
        arrow.node.remove();
        this.damageArrows.splice(i, 1);
        continue;
      }
      // Re-project every frame so the arrow keeps pointing at the attacker as
      // the player spins.
      //
      // The player's forward vector is (-sin(yaw), -cos(yaw)), so the bearing
      // they are facing is yaw + PI, not yaw. And CSS rotate() is clockwise
      // while atan2 bearings increase anticlockwise here, so the difference is
      // taken facing-minus-target rather than the other way round. Getting
      // either wrong points the arrow at the one place the attacker is not.
      const targetBearing = Math.atan2(arrow.worldDirection.x, arrow.worldDirection.y);
      const angle = cameraYaw + Math.PI - targetBearing;
      arrow.node.style.transform = `rotate(${angle}rad)`;
    }

    if (this.hitMarkerTimer > 0) {
      this.hitMarkerTimer -= dt;
      if (this.hitMarkerTimer <= 0) this.hitMarker.classList.remove('is-active');
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('is-active');
    }
  }

  // -------------------------------------------------------------------------
  // Event feedback
  // -------------------------------------------------------------------------

  showHitMarker(kind: 'normal' | 'critical' | 'kill'): void {
    this.hitMarker.className = `sh-hitmarker${kind === 'kill' ? ' sh-hitmarker--kill' : kind === 'critical' ? ' sh-hitmarker--crit' : ''}`;
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void this.hitMarker.offsetWidth;
    this.hitMarker.classList.add('is-active');
    this.hitMarkerTimer = 0.3;
  }

  addKillFeedEntry(text: string, icon: string, highlight: string | null): void {
    const node = el('div', {
      className: 'sh-killfeed__entry',
      children: [
        el('span', { text: icon, attrs: { 'aria-hidden': 'true' } }),
        el('span', {
          children: highlight
            ? [document.createTextNode(text + ' '), el('em', { text: highlight })]
            : [document.createTextNode(text)],
        }),
      ],
    });

    this.killFeed.appendChild(node);
    this.killEntries.push({ node, timer: 3.6 });

    // Cap the feed length so a big combo can't fill the screen.
    while (this.killEntries.length > 5) {
      const oldest = this.killEntries.shift();
      oldest?.node.remove();
    }
  }

  /**
   * Shows where zombies are closing in from, before they land a hit.
   *
   * Uses the same bearing convention as the damage arrows: the player's
   * forward vector is (-sin(yaw), -cos(yaw)), so the bearing they face is
   * yaw + PI, and CSS rotate() runs clockwise while these bearings increase
   * anticlockwise -- hence facing minus target.
   */
  setThreats(threats: readonly ThreatCue[], cameraYaw: number): void {
    for (let i = 0; i < this.threatSlots.length; i++) {
      const slot = this.threatSlots[i];
      const threat = threats[i];

      if (!threat) {
        if (slot.active) {
          slot.active = false;
          slot.node.classList.remove('is-active', 'is-imminent');
        }
        continue;
      }

      const bearing = Math.atan2(threat.x, threat.z);
      const angle = cameraYaw + Math.PI - bearing;
      slot.node.style.transform = `rotate(${angle}rad)`;
      slot.node.style.opacity = (0.2 + threat.intensity * 0.8).toFixed(2);

      if (!slot.active) {
        slot.active = true;
        slot.node.classList.add('is-active');
      }
      slot.node.classList.toggle('is-imminent', threat.imminent);
    }
  }

  /** Directional hit indicator that keeps tracking the attacker's bearing. */
  showDamageDirection(worldDirection: THREE.Vector3): void {
    const bearing = new THREE.Vector2(worldDirection.x, worldDirection.z).normalize();

    // Being clawed repeatedly from one side should make a single indicator
    // insistent, not stack six overlapping copies.
    for (const existing of this.damageArrows) {
      if (existing.worldDirection.dot(bearing) > 0.9) {
        existing.worldDirection.copy(bearing);
        existing.timer = 1.35;
        existing.node.classList.remove('is-pulse');
        void existing.node.offsetWidth;
        existing.node.classList.add('is-pulse');
        return;
      }
    }

    const node = el('div', { className: 'sh-damage-arrow is-pulse' });
    this.damageRing.appendChild(node);
    this.damageArrows.push({ node, timer: 1.35, worldDirection: bearing });

    while (this.damageArrows.length > 5) {
      const oldest = this.damageArrows.shift();
      oldest?.node.remove();
    }
  }

  showBanner(title: string, subtitle: string, variant: 'normal' | 'boss' = 'normal'): void {
    this.bannerTitle.textContent = title;
    this.bannerSubtitle.textContent = subtitle;
    this.banner.className = `sh-banner${variant === 'boss' ? ' sh-banner--boss' : ''}`;
    void this.banner.offsetWidth;
    this.banner.classList.add('is-active');
    this.bannerTimer = 2.6;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('sh-hud--hidden', !visible);
  }

  /** Countdown beep, called by the game on each whole second under five. */
  get countdownSecond(): number {
    return this.lastCountdownTick;
  }

  /** Wipes transient state when a run ends or restarts. */
  reset(): void {
    for (const entry of this.killEntries) entry.node.remove();
    this.killEntries.length = 0;
    for (const arrow of this.damageArrows) arrow.node.remove();
    this.damageArrows.length = 0;
    for (const slot of this.threatSlots) {
      slot.active = false;
      slot.node.classList.remove('is-active', 'is-imminent');
    }
    this.hitMarker.classList.remove('is-active');
    this.banner.classList.remove('is-active');
    this.bossBar.classList.remove('is-active');
    this.lastHealth = -1;
    this.lastArmor = -1;
    this.lastCoins = -1;
    this.lastAmmo = -1;
    this.lastReserve = -1;
    this.lastWaveNumber = -1;
    this.lastStatus = '';
    this.ghostHealth = 1;
  }
}
