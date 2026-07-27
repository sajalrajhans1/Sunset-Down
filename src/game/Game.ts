import * as THREE from 'three';

import { ECONOMY } from './Config';
import { PlayerStats } from './PlayerStats';
import { settings, detectRecommendedPreset, type QualityProfile, QUALITY_PROFILES } from './Settings';

import { Player } from '../components/Player';
import type { Zombie } from '../components/Zombie';
import { loadZombieModel } from '../components/GlbZombieVisual';
import { loadBossModel } from '../components/GlbBossVisual';
import { MapZones } from '../systems/MapZones';

import { Village } from '../scenes/Village';

import { InputSystem } from '../systems/InputSystem';
import { PostFX } from '../systems/PostFX';
import { ZombieManager } from '../systems/ZombieManager';
import { ParticleSystem } from '../systems/ParticleSystem';
import { DecalSystem } from '../systems/DecalSystem';
import { DamageNumbers } from '../systems/DamageNumbers';
import { CombatSystem } from '../systems/CombatSystem';
import { WaveSystem, type WaveScaling } from '../systems/WaveSystem';
import { EconomySystem } from '../systems/EconomySystem';
import { PerformanceGovernor } from '../systems/PerformanceGovernor';

import { WeaponManager } from '../weapons/WeaponManager';
import { WEAPONS, type WeaponId } from '../weapons/WeaponDefs';

import { UIManager } from '../ui/UIManager';
import type { ThreatCue } from '../ui/HUD';
import { audio } from '../audio/AudioManager';
import { textureLibrary } from '../textures/ProceduralTextures';
import { updateStylizedTime } from '../textures/StylizedMaterial';
import { clamp01, damp } from '../utilities/MathUtils';
import type { UpgradeId } from './Config';

type GameState = 'boot' | 'menu' | 'playing' | 'paused' | 'dying' | 'gameover';

/** How close a zombie must be before it registers as a threat, in metres. */
const THREAT_RADIUS = 9;

/**
 * The game host.
 *
 * Owns the renderer, the scene graph and every system, and is the only place
 * that knows the order things must happen in each frame. Systems themselves
 * stay decoupled — they communicate through this class's callbacks rather than
 * importing each other.
 */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();

  private readonly stats = new PlayerStats();
  private readonly economy = new EconomySystem();
  private readonly input = new InputSystem();
  private readonly waves = new WaveSystem();
  private readonly weapons = new WeaponManager();

  private player!: Player;
  private village!: Village;
  private zombies!: ZombieManager;
  private particles!: ParticleSystem;
  private decals!: DecalSystem;
  private damageNumbers!: DamageNumbers;
  private combat!: CombatSystem;
  private postFx!: PostFX;
  private ui!: UIManager;

  private state: GameState = 'boot';
  private elapsed = 0;
  private runTime = 0;
  private lastFrameTime = 0;
  private rafHandle = 0;

  /** Slows to a crawl for the death sequence and hit-pause. */
  private timeScale = 1;
  private timeScaleTarget = 1;
  private hitPauseTimer = 0;
  private deathTimer = 0;

  // FPS tracking.
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private fpsDisplay = 60;
  private frameMsDisplay = 16.7;

  /** Adaptive quality: keeps the frame rate playable on unknown hardware. */
  private readonly governor = new PerformanceGovernor({
    onRenderScale: (scale) => this.applyRenderScale(scale),
    onCrowdBudget: (fraction) => this.applyCrowdBudget(fraction),
    onPresetChange: (preset) => settings.set('graphics', preset),
  });
  private renderScale = 1;
  /**
   * Fraction of the preset's zombie cap the governor currently allows. Kept so
   * a later preset change re-derives capacity from the same budget rather than
   * silently restoring a full-size horde on a machine that could not hold it.
   */
  private crowdBudget = 1;

  private lastCountdownBeep = -1;
  private mapZones!: MapZones;
  /** Reused each frame so threat detection never allocates. */
  private readonly threatBuffer: ThreatCue[] = [];
  private threatWarnTimer = 0;
  private navRefreshTimer = 0;
  private readonly _tmpVec = new THREE.Vector3();
  private readonly _lookDir = new THREE.Vector3();
  private readonly _damageDir = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA is handled by the post-processing render target.
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Builds the world in stages, yielding to the browser between each so the
   * loading bar actually paints instead of freezing on a single long task.
   */
  async init(uiRoot: HTMLElement): Promise<void> {
    // First run picks a preset that suits the machine.
    if (!localStorage.getItem('sunset-hollow:settings:v1')) {
      settings.set('graphics', detectRecommendedPreset());
    }

    const quality = settings.quality;
    textureLibrary.setAnisotropy(Math.min(quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));

    // Size the renderer *before* anything reads the drawing buffer. PostFX
    // captures that size when it builds its render targets, and an unsized
    // canvas still reports the HTML default of 300x150 — which would lock the
    // entire post-processing chain to that resolution for the whole session.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.buildUi(uiRoot);
    await this.yieldFrame();

    this.ui.setLoadingProgress(0.08, 'Mixing paint');
    this.player = new Player(this.stats, window.innerWidth / window.innerHeight);
    this.player.camera.add(this.weapons.rigRoot);
    this.scene.add(this.player.camera);
    await this.yieldFrame();

    this.ui.setLoadingProgress(0.2, 'Raising the rooftops');
    this.village = new Village(quality);
    this.mapZones = new MapZones({
      spend: (amount) => this.economy.spend(amount),
      canAfford: (amount) => this.economy.canAfford(amount),
      ownsWeapon: (id) => this.weapons.has(id),
      grantWeapon: (id) => {
        this.weapons.grant(id, this.stats.toWeaponModifiers());
        this.weapons.equipWeapon(id);
        return true;
      },
      refillAmmo: () => this.weapons.refillAll(1),
      onZoneOpened: (_id, name) => this.onZoneOpened(name),
    });
    this.village.build(this.scene, quality, this.mapZones);
    this.scene.add(this.village.group);
    await this.yieldFrame();

    this.ui.setLoadingProgress(0.58, 'Waking the neighbours');
    // The skinned zombie has to be decoded before any wave can spawn, so it is
    // awaited here rather than streamed in behind gameplay.
    try {
      await loadZombieModel();
    } catch (error) {
      // A failed model download must not block the game: every class falls
      // back to the original procedural rig automatically.
      console.warn('[Sunset Hollow] Zombie model failed to load, using fallback bodies:', error);
    }
    await this.yieldFrame();

    // The boss is only needed from wave 5, so a slow download here should never
    // hold up the first wave. Started now, awaited by nobody.
    void loadBossModel().catch((error) => {
      console.warn('[Sunset Hollow] Boss model failed to load, using fallback body:', error);
    });

    this.ui.setLoadingProgress(0.7, 'Rousing the dead');
    this.zombies = new ZombieManager(quality.maxZombies);
    this.scene.add(this.zombies.group);
    await this.yieldFrame();

    this.ui.setLoadingProgress(0.78, 'Loading the fireworks');
    this.particles = new ParticleSystem(quality.maxParticles);
    this.decals = new DecalSystem(quality.maxDecals);
    this.damageNumbers = new DamageNumbers(26);
    this.scene.add(this.particles.group, this.decals.group, this.damageNumbers.group);
    await this.yieldFrame();

    this.ui.setLoadingProgress(0.9, 'Focusing the lens');
    this.postFx = new PostFX(this.renderer, this.scene, this.player.camera);
    this.combat = new CombatSystem(
      this.zombies,
      this.village.collision,
      this.particles,
      this.decals,
      this.damageNumbers,
      this.economy,
      this.stats,
    );

    this.wireSystems();
    this.applyQuality();
    this.handleResize();
    await this.yieldFrame();

    // Build the starting weapon now so its geometry and shaders exist before
    // the pre-compile pass below, rather than being created on first Play.
    this.weapons.prewarm(this.stats.toWeaponModifiers());

    this.ui.setLoadingProgress(0.94, 'Compiling shaders');
    await this.precompileShaders();

    this.ui.setLoadingProgress(1, 'Ready');
    this.ui.mainMenu.setRecords(this.economy.records);
    this.ui.finishLoading();
    this.ui.show('menu');
    this.state = 'menu';

    window.addEventListener('resize', () => this.handleResize());
    settings.subscribe((_, key) => this.onSettingsChanged(key));

    this.lastFrameTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /**
   * Yields to the browser between build stages so the loading bar can paint.
   *
   * A double rAF gives a guaranteed paint when the tab is visible, but rAF
   * never fires in a hidden or non-compositing tab — so a timeout races it to
   * make sure loading always completes even if the game is opened in a
   * background tab.
   */
  private yieldFrame(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      window.setTimeout(finish, 80);
    });
  }

  /**
   * Compiles and links every shader program while the loading bar is still up.
   *
   * Without this, the first frame after pressing Play has to compile the whole
   * material set at once — the village, all five zombie classes, the weapon,
   * the particle systems — which reads as a hard stall right when the player
   * expects the game to start.
   *
   * Pooled zombies are hidden, so they're temporarily revealed for the pass:
   * `compileAsync` walks visible objects only.
   */
  private async precompileShaders(): Promise<void> {
    // compileAsync only walks *visible* objects, but the zombie pool and the
    // holstered weapons are hidden by design. Reveal everything, compile, then
    // restore each object's exact previous state.
    const previousVisibility = new Map<THREE.Object3D, boolean>();
    this.scene.traverse((object) => {
      if (!object.visible) {
        previousVisibility.set(object, false);
        object.visible = true;
      }
    });

    try {
      await this.renderer.compileAsync(this.scene, this.player.camera);
    } catch (error) {
      // Losing the pre-compile costs us the optimisation, not the game: the
      // programs are simply built lazily on first use instead.
      console.warn('[Sunset Hollow] Shader pre-compile skipped:', error);
    } finally {
      for (const [object, visible] of previousVisibility) object.visible = visible;
    }
  }

  private buildUi(uiRoot: HTMLElement): void {
    this.ui = new UIManager({
      root: uiRoot,
      stats: this.stats,
      economy: this.economy,
      weapons: this.weapons,
      menu: {
        onPlay: () => this.startRun(),
        onQuit: () => this.quitToDesktop(),
      },
      pause: {
        onResume: () => this.resume(),
        onOpenShop: () => this.openShop(),
        onQuitToMenu: () => this.returnToMenu(),
      },
      shop: {
        onBuyUpgrade: (id) => this.buyUpgrade(id),
        onBuyWeapon: (id) => this.buyWeapon(id),
        onBuyAmmo: () => this.buyAmmo(),
        onClose: () => this.closeShop(),
        onStartWave: () => {
          this.waves.skipPrep();
          this.closeShop();
        },
      },
      gameOver: {
        onPlayAgain: () => this.startRun(),
        onMainMenu: () => this.returnToMenu(),
      },
    });

    this.input.attach(this.canvas);
    this.input.setPauseCallback(() => this.handleEscape());
    this.input.setPointerLockCallback((locked) => {
      // Losing pointer lock mid-fight pauses rather than leaving the player
      // standing helpless with an unresponsive camera.
      if (!locked && this.state === 'playing') this.pause();
    });
  }

  private wireSystems(): void {
    this.zombies.onZombieAttack = (zombie, damage) => this.onZombieAttack(zombie, damage);
    this.zombies.onZombieKilled = (zombie) => this.onZombieKilled(zombie);
    this.zombies.onZombieExploded = (zombie) => this.onZombieExploded(zombie);

    this.waves.onSpawnRequest = (type, scaling) => this.spawnZombie(type, scaling);
    this.waves.onWaveStart = (wave, isBoss) => this.onWaveStart(wave, isBoss);
    this.waves.onWaveCleared = (wave) => this.onWaveCleared(wave);
    this.waves.onPrepStart = (nextWave) => this.onPrepStart(nextWave);

    this.player.onDamage = (event) => {
      this.economy.registerDamageTaken(event.amount);
      this.postFx.pulseDamage(clamp01(0.35 + event.amount / 60));
      if (event.source) {
        this._damageDir.subVectors(event.source, this.player.position).normalize();
        this.ui.hud.showDamageDirection(this._damageDir);
      }
      if (settings.current.damageNumbers) {
        this._tmpVec.copy(this.player.camera.position);
        this._tmpVec.y -= 0.4;
        this.damageNumbers.spawn(this._tmpVec, event.amount, 'player');
      }
    };
    this.player.onDeath = () => this.onPlayerDeath();

    this.economy.onCoinsChanged = () => {
      if (this.ui.shopMenu.isOpen) this.ui.shopMenu.refresh();
    };
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  private startRun(): void {
    // Fire-and-forget: never block starting a run on the audio context. Some
    // autoplay policies leave resume() pending indefinitely, and AudioCore also
    // unlocks itself from its own global gesture listeners.
    void audio.resume();

    this.stats.reset();
    this.economy.reset();
    this.waves.reset();
    this.zombies.clear();
    this.particles.clear();
    this.decals.clear();
    this.damageNumbers.clear();
    this.ui.hud.reset();

    this.weapons.reset(this.stats.toWeaponModifiers());

    // Shut every gate again and rebuild navigation around them, so a second
    // run starts as sealed in as the first.
    this.mapZones.reset();
    this.village.rebuildNavigation();

    // Spawn in the middle of the plaza, facing the fairground.
    this.player.spawn(new THREE.Vector3(0, 0, 6), Math.PI);
    this.village.setProgress(1);
    this.village.navGrid.computeField(this.player.position.x, this.player.position.z);

    this.runTime = 0;
    this.governor.reset();
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.deathTimer = 0;

    this.state = 'playing';
    this.ui.show('playing');
    this.input.setEnabled(true);
    this.input.requestPointerLock();

    audio.music.playGameplay();
    audio.music.setIntensity(0.15);

    this.waves.begin();
    this.ui.hud.showBanner('Sunset Hollow', 'Hold the square', 'normal');
  }

  private returnToMenu(): void {
    this.state = 'menu';
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.zombies.clear();
    this.particles.clear();
    this.damageNumbers.clear();
    this.waves.reset();
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.ui.mainMenu.setRecords(this.economy.records);
    this.ui.show('menu');
    audio.music.playMenu();
  }

  private quitToDesktop(): void {
    // Browsers only allow window.close() on script-opened windows, so fall back
    // to returning to the menu with a clear message.
    this.returnToMenu();
    window.close();
  }

  // -------------------------------------------------------------------------
  // Pause / shop
  // -------------------------------------------------------------------------

  private handleEscape(): void {
    const action = this.ui.handleEscape();
    if (action === 'closed-modal') {
      if (this.ui.shopMenu.isOpen) this.closeShop();
      return;
    }
    if (action === 'none') return;

    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.ui.show('paused');
    this.ui.pauseMenu.open(this.waves.waveNumber, this.economy.stats.kills, this.economy.coins);
    audio.music.setIntensity(0.05);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.show('playing');
    this.input.setEnabled(true);
    this.input.requestPointerLock();
  }

  private openShop(): void {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    this.state = 'paused';
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.ui.show('shop');
    this.ui.shopMenu.open(this.waves.phase === 'prep' || this.waves.phase === 'cleared');
  }

  private closeShop(): void {
    if (!this.ui.shopMenu.isOpen) return;
    this.ui.shopMenu.close();
    this.resumeFromShop();
  }

  private resumeFromShop(): void {
    this.state = 'playing';
    this.ui.show('playing');
    this.input.setEnabled(true);
    this.input.requestPointerLock();
  }

  // -------------------------------------------------------------------------
  // Purchases
  // -------------------------------------------------------------------------

  private buyUpgrade(id: UpgradeId): boolean {
    const cost = this.stats.nextCost(id);
    if (cost === null) return false;
    if (!this.economy.spend(cost)) {
      audio.sfx.denied();
      return false;
    }

    this.stats.applyUpgrade(id);
    this.economy.stats.upgradesPurchased++;
    audio.sfx.purchase();

    // Push new modifiers into every weapon, and top up vitals where relevant.
    this.weapons.setModifiers(this.stats.toWeaponModifiers());
    if (id === 'health') this.player.heal(this.stats.defOf('health').perLevel);
    if (id === 'armor') this.player.restoreArmor();
    return true;
  }

  private buyWeapon(id: WeaponId): boolean {
    const def = WEAPONS[id];
    if (this.weapons.has(id)) return false;
    if (!this.economy.spend(def.price)) {
      audio.sfx.denied();
      return false;
    }
    this.weapons.grant(id, this.stats.toWeaponModifiers());
    this.weapons.equipWeapon(id);
    audio.sfx.purchase();
    return true;
  }

  private buyAmmo(): boolean {
    if (!this.economy.spend(ECONOMY.ammoRefillCost)) {
      audio.sfx.denied();
      return false;
    }
    this.weapons.refillAll(1);
    audio.sfx.purchase();
    return true;
  }

  // -------------------------------------------------------------------------
  // Wave + combat events
  // -------------------------------------------------------------------------

  /**
   * A barricade just came down.
   *
   * Navigation has to be rebuilt before anything else: until it is, the flow
   * field still believes the gateway is a wall, and zombies would path around
   * an opening the player just paid for.
   */
  private onZoneOpened(name: string): void {
    this.village.rebuildNavigation();
    this.ui.hud.showBanner(name, 'The way is open', 'normal');
    this.postFx.flash(0.16, 0xffc861);
    this.player.addShake(0.35);
  }

  /**
   * Tightens or relaxes how many zombies may be active at once.
   *
   * Never goes below a floor that would make a wave feel empty — if the machine
   * still cannot cope at that point, the governor moves on to dropping the
   * graphics preset instead.
   */
  private applyCrowdBudget(fraction: number): void {
    this.crowdBudget = fraction;
    const preset = QUALITY_PROFILES[settings.current.graphics];
    const capacity = Math.max(12, Math.round(preset.maxZombies * fraction));
    this.zombies?.setCapacity(capacity);
  }

  private spawnZombie(type: string, scaling: WaveScaling): boolean {
    if (this.zombies.isFull) return false;

    const point = WaveSystem.chooseSpawnPoint(
      this.village.spawnPoints,
      this.player.position,
      // The plaza is always live; a district only wakes up once bought open.
      (zone) => zone === 'plaza' || this.mapZones.isOpen(zone),
      20,
      80,
    );
    if (!point) return false;

    const zombie = this.zombies.spawn({
      type: type as never,
      position: point,
      healthMultiplier: scaling.health,
      speedMultiplier: scaling.speed,
      damageMultiplier: scaling.damage,
    });
    if (!zombie) return false;

    this.particles.groundDust(point, 6);
    if (zombie.def.isBoss) {
      audio.sfx.bossRoar(point);
      this.postFx.flash(0.32, 0xff6b6b);
      this.player.addShake(0.8);
    }
    return true;
  }

  private onWaveStart(wave: number, isBoss: boolean): void {
    audio.sfx.waveStart(wave);
    this.village.setProgress(wave);
    this.lastCountdownBeep = -1;

    // Three simultaneous channels so the wave start is unmissable: a banner,
    // a screen flash, and a kick of camera shake.
    this.ui.hud.showBanner(
      isBoss ? 'Boss Wave' : `Wave ${wave}`,
      isBoss ? 'Something big is coming' : 'Zombies incoming',
      isBoss ? 'boss' : 'normal',
    );
    this.ui.hud.addKillFeedEntry(isBoss ? 'BOSS WAVE' : `Wave ${wave} —`, '⚠️', 'incoming');
    this.postFx.flash(isBoss ? 0.3 : 0.16, isBoss ? 0xff8080 : 0xffd9a0);
    this.player.addShake(isBoss ? 0.9 : 0.35);
    if (isBoss) audio.sfx.bossRoar();
  }

  private onWaveCleared(wave: number): void {
    const bonus = this.economy.registerWaveClear(wave);
    audio.sfx.waveClear();
    this.ui.hud.showBanner('Wave Cleared', `+${bonus} coins`, 'normal');
    this.ui.hud.addKillFeedEntry('Wave cleared —', '🏁', `+${bonus}`);

    // Partial ammo top-up between waves keeps the pace up without removing the
    // pressure to actually buy ammo.
    this.weapons.refillAll(0.35);
    this.player.restoreArmor();
    audio.music.setIntensity(0.12);
  }

  private onPrepStart(nextWave: number): void {
    if (nextWave > 1) {
      this.ui.hud.addKillFeedEntry('Shop open —', '🛒', 'press B');
    }
  }

  private onZombieAttack(zombie: Zombie, damage: number): void {
    this._tmpVec.copy(zombie.position);
    this._tmpVec.y += zombie.headHeight * 0.6;
    if (this.player.takeDamage(damage, this._tmpVec)) {
      this.player.addShake(zombie.def.hitShake * 0.5);
    }
  }

  private onZombieKilled(zombie: Zombie): void {
    this.waves.notifyKill();

    const result = this.economy.registerKill({
      baseValue: zombie.def.coinValue,
      headshot: false,
      isBoss: zombie.def.isBoss,
    });

    this._tmpVec.set(zombie.position.x, zombie.position.y + zombie.headHeight * 0.8, zombie.position.z);
    this.particles.zombiePoof(this._tmpVec, zombie.bodyColor, zombie.def.scale);
    this.particles.coinSparkle(this._tmpVec);
    audio.sfx.coinPickup(result.pitchStep);

    if (settings.current.damageNumbers) {
      this._tmpVec.y += 0.4;
      this.damageNumbers.spawn(this._tmpVec, result.coins, 'coins');
    }

    this.ui.hud.addKillFeedEntry(
      zombie.def.name,
      zombie.def.isBoss ? '👑' : '💀',
      result.multiplier > 1.01 ? `x${result.multiplier.toFixed(1)}` : null,
    );

    if (zombie.def.isBoss) {
      this.postFx.flash(0.4, 0xffd27a);
      this.player.addShake(1.0);
    }
  }

  private onZombieExploded(zombie: Zombie): void {
    this.combat.detonate(
      zombie,
      this.player.position,
      (amount, from) => {
        this.player.takeDamage(amount, from);
        this.player.addShake(0.9);
      },
      settings.current.damageNumbers,
    );
    this.postFx.flash(0.22, 0xffb066);
    this.player.addShake(0.55);
  }

  private onPlayerDeath(): void {
    this.state = 'dying';
    this.deathTimer = 3.1;
    this.timeScaleTarget = 0.22;
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    audio.music.stop(1.4);
    audio.sfx.gameOver();
    this.postFx.pulseDamage(1);
  }

  private showGameOver(): void {
    this.state = 'gameover';
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.economy.finalise(this.waves.waveNumber, this.runTime);
    this.ui.show('gameover');
    this.ui.gameOver.show({
      stats: this.economy.stats,
      accuracy: this.economy.accuracy,
      waveReached: this.waves.waveNumber,
      isNewRecord: this.economy.isNewRecord,
      bestWave: this.economy.records.bestWave,
    });
    audio.music.playMenu();
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private readonly tick = (now: number): void => {
    this.rafHandle = requestAnimationFrame(this.tick);

    const rawDelta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;

    this.updateFpsCounter(rawDelta, now);

    // Hit pause: a few frames of near-freeze on impactful kills.
    if (this.hitPauseTimer > 0) {
      this.hitPauseTimer -= rawDelta;
      if (this.hitPauseTimer <= 0) this.timeScaleTarget = this.state === 'dying' ? 0.22 : 1;
    }
    this.timeScale = damp(this.timeScale, this.timeScaleTarget, 14, rawDelta);

    const dt = rawDelta * this.timeScale;
    this.elapsed += dt;
    updateStylizedTime(this.elapsed);

    switch (this.state) {
      case 'playing':
        this.updateGameplay(dt, rawDelta);
        break;
      case 'dying':
        this.updateDying(dt, rawDelta);
        break;
      case 'paused':
      case 'gameover':
        // Keep the world alive visually so the scene behind the modal breathes.
        this.updateAmbientOnly(dt);
        break;
      case 'menu':
      case 'boot':
      default:
        break;
    }

    // Only judge performance while actually playing: menus and pause screens
    // legitimately render far cheaper and would skew the measurement.
    if (this.state === 'playing') {
      this.governor.update(rawDelta, rawDelta * 1000);
    }

    this.input.endFrame();
    this.render(rawDelta);
  };

  private updateFpsCounter(rawDelta: number, now: number): void {
    this.fpsAccumulator += rawDelta;
    this.fpsFrames++;
    if (this.fpsAccumulator >= 0.5) {
      this.fpsDisplay = this.fpsFrames / this.fpsAccumulator;
      this.frameMsDisplay = (this.fpsAccumulator * 1000) / this.fpsFrames;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
    void now;
  }

  private updateGameplay(dt: number, rawDelta: number): void {
    this.runTime += dt;

    // --- Weapon switching input -------------------------------------------
    if (this.input.wasPressed('slot1')) this.weapons.equipIndex(0);
    if (this.input.wasPressed('slot2')) this.weapons.equipIndex(1);
    if (this.input.wasPressed('slot3')) this.weapons.equipIndex(2);
    if (this.input.wasPressed('slot4')) this.weapons.equipIndex(3);
    if (this.input.wasPressed('slot5')) this.weapons.equipIndex(4);
    if (this.input.wheelDelta !== 0) this.weapons.cycle(Math.sign(this.input.wheelDelta));
    if (this.input.wasPressed('interact')) this.mapZones.tryInteract();
    if (this.input.wasPressed('reload')) this.weapons.reloadActive();
    if (this.input.wasPressed('inspect')) this.weapons.activeWeapon?.inspect();
    if (this.input.wasPressed('shop')) {
      this.openShop();
      return;
    }

    // --- Player ------------------------------------------------------------
    const lookDeltaX = this.input.lookDeltaX;
    const lookDeltaY = this.input.lookDeltaY;
    this.player.update(dt, this.input, this.village.collision, true);

    // --- Weapons -----------------------------------------------------------
    this.weapons.setAiming(this.input.aimHeld);
    this.player.getLookDirection(this._lookDir);
    this.weapons.update(
      dt,
      { x: lookDeltaX, y: lookDeltaY },
      this.player.moveFactor,
      this.player.sprinting,
      this.player.onGround,
      this.village.collision,
      this.player.camera.position,
      this._lookDir,
    );
    this.player.applyFov(this.weapons.fovDelta, dt);

    this.handleFiring();

    // --- Navigation --------------------------------------------------------
    // The flow field is shared by every zombie, so it only needs refreshing a
    // few times a second rather than per-agent per-frame.
    this.navRefreshTimer -= dt;
    if (this.navRefreshTimer <= 0) {
      this.navRefreshTimer = 0.14;
      this.village.navGrid.computeField(this.player.position.x, this.player.position.z);
    }

    // --- Entities ----------------------------------------------------------
    this.player.getBodyCenter(this._tmpVec);
    this.zombies.update(
      dt,
      this.elapsed,
      this.player.position,
      this._tmpVec,
      !this.player.dead,
      this.village.navGrid,
      this.village.collision,
      this.waves.aggression,
      this.player.camera.position,
    );

    this.waves.update(dt, this.zombies.aliveCount, !this.zombies.isFull);
    this.economy.update(dt);

    // --- Effects -----------------------------------------------------------
    this.particles.update(dt);
    this.decals.update(dt);
    this.damageNumbers.update(dt);
    this.village.update(dt, this.player.camera.position);
    this.mapZones.update(dt, this.player.position, this.player.forwardVector);

    // --- Audio -------------------------------------------------------------
    audio.updateListener(this.player.camera);
    audio.updateFootsteps(
      this.player.distanceThisFrame,
      this.player.onGround,
      this.player.surfaceUnderfoot(),
      this.player.sprinting,
    );
    audio.updateHeartbeat(this.player.healthFraction, this.elapsed);
    this.updateMusicIntensity();

    // --- Post FX -----------------------------------------------------------
    this.postFx.setMotionAmount(this.player.motionBlurAmount(lookDeltaX, lookDeltaY, rawDelta));
    this.postFx.setLowHealth(this.player.distressAmount);

    this.updateHud(dt);
  }

  private updateDying(dt: number, rawDelta: number): void {
    this.deathTimer -= rawDelta;

    this.player.update(dt, this.input, this.village.collision, false);
    this.player.getBodyCenter(this._tmpVec);
    this.zombies.update(
      dt,
      this.elapsed,
      this.player.position,
      this._tmpVec,
      false,
      this.village.navGrid,
      this.village.collision,
      this.waves.aggression,
      this.player.camera.position,
    );

    this.particles.update(dt);
    this.damageNumbers.update(dt);
    this.village.update(dt, this.player.camera.position);
    this.postFx.setLowHealth(1);
    this.postFx.setMotionAmount(0.25);
    audio.updateListener(this.player.camera);

    if (this.deathTimer <= 0) this.showGameOver();
  }

  /** Keeps the world animating gently while a modal is open. */
  private updateAmbientOnly(dt: number): void {
    this.village.update(dt * 0.4, this.player.camera.position);
    this.particles.update(dt * 0.4);
    this.damageNumbers.update(dt * 0.4);
  }

  private handleFiring(): void {
    const weapon = this.weapons.activeWeapon;
    if (!weapon) return;

    const shot = weapon.tryFire(this.input.fireHeld, this.player.moveFactor, this.weapons.aimAmount);
    if (!shot) return;

    // Firing cancels a shell-by-shell reload immediately.
    weapon.cancelReload();

    this.weapons.triggerMuzzleFlash(shot.pellets > 1 ? 1.5 : 1);
    this.player.applyRecoil(
      weapon.def.recoil.vertical * (1 - this.weapons.aimAmount * 0.35),
      (Math.random() - 0.5) * 2 * weapon.def.recoil.horizontal,
    );
    this.player.addShake(weapon.def.recoil.shake * 0.16);

    this.player.getLookDirection(this._lookDir);
    const feedback = this.combat.fire(
      weapon,
      shot,
      this.player.camera.position,
      this._lookDir,
      settings.current.damageNumbers,
    );

    if (feedback.anyHit) {
      this.ui.hud.showHitMarker(feedback.killed ? 'kill' : feedback.critical || feedback.headshot ? 'critical' : 'normal');
    }

    // Hit pause on kills gives the moment weight without stealing control.
    if (feedback.killed) {
      this.hitPauseTimer = 0.045;
      this.timeScaleTarget = 0.22;
    }
  }

  /** Music intensity tracks danger: nearby zombies, boss presence, low health. */
  private updateMusicIntensity(): void {
    const near = this.zombies.countNear(this.player.position, 26);
    const alive = this.zombies.aliveCount;
    const boss = this.zombies.findBoss() !== null;

    let intensity = clamp01(alive / 22) * 0.45 + clamp01(near / 8) * 0.4;
    if (boss) intensity = Math.max(intensity, 0.85);
    if (this.player.healthFraction < 0.35) intensity = Math.max(intensity, 0.7);
    if (this.waves.phase === 'prep' || this.waves.phase === 'cleared') intensity *= 0.3;

    audio.music.setIntensity(intensity);
  }

  private updateHud(dt: number): void {
    const weapon = this.weapons.activeWeapon;
    const boss = this.zombies.findBoss();

    // Standing in front of a gate or a wall-buy outranks everything else: it
    // is the only prompt tied to where the player physically is.
    let prompt: string | null = this.mapZones.promptText;
    if (prompt === null) {
      if (this.waves.phase === 'prep' || this.waves.phase === 'cleared') {
        prompt = 'Press <em>B</em> to open the shop';
      } else if (weapon && weapon.isEmpty && !weapon.isReloading) {
        prompt = weapon.reserveAmmo > 0 ? 'Press <em>R</em> to reload' : 'Out of ammo — switch weapons';
      }
    }

    this.ui.hud.update(
      dt,
      {
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        armor: this.player.armor,
        maxArmor: this.player.maxArmor,
        stamina: this.player.staminaFraction,
        coins: this.economy.coins,
        wave: this.waves.snapshot(this.zombies.aliveCount),
        weapon,
        combo: this.economy.combo,
        comboKills: this.economy.comboKillCount,
        comboFraction: this.economy.comboFraction,
        crosshairSpread: weapon
          ? weapon.currentSpread(this.player.moveFactor, this.weapons.aimAmount)
          : 1,
        aiming: this.weapons.aimAmount > 0.5,
        scoped: this.weapons.isScoped,
        fps: this.fpsDisplay,
        frameMs: this.frameMsDisplay,
        bossName: boss ? boss.def.name : null,
        bossHealthFraction: boss ? boss.healthFraction : 0,
        promptText: prompt,
      },
      this.player.yaw,
      this.player.position,
      this.zombies.activeZombies,
    );

    this.updateThreatCues(dt);

    this.updateWaveCountdownAudio(dt);
  }

  /**
   * Flags zombies closing in from outside the player's view.
   *
   * Anything in front is already on screen, so warning about it is noise --
   * only contacts outside the horizontal field of view get a cue. That makes
   * the indicator mean exactly one thing: "something you cannot see is about
   * to reach you."
   */
  private updateThreatCues(dt: number): void {
    const threats = this.threatBuffer;
    threats.length = 0;

    if (this.state === 'playing' && !this.player.dead) {
      const px = this.player.position.x;
      const pz = this.player.position.z;
      // Bearing the player faces: forward is (-sin(yaw), -cos(yaw)).
      const facing = this.player.yaw + Math.PI;

      // Half the horizontal FOV, widened slightly so a zombie hugging the
      // screen edge still counts as visible and doesn't flicker a warning.
      const aspect = this.player.camera.aspect;
      const safeAspect = Number.isFinite(aspect) && aspect > 0.01 ? aspect : 16 / 9;
      const vertical = THREE.MathUtils.degToRad(this.player.camera.fov);
      const horizontal = 2 * Math.atan(Math.tan(vertical * 0.5) * safeAspect);
      const halfFov = horizontal * 0.5 + 0.12;

      for (const zombie of this.zombies.activeZombies) {
        if (!zombie.isAlive) continue;

        const dx = zombie.position.x - px;
        const dz = zombie.position.z - pz;
        const distance = Math.hypot(dx, dz);
        if (distance > THREAT_RADIUS || distance < 0.01) continue;

        let relative = Math.atan2(dx, dz) - facing;
        relative = ((relative + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        if (Math.abs(relative) < halfFov) continue;

        threats.push({
          x: dx / distance,
          z: dz / distance,
          intensity: clamp01(1 - distance / THREAT_RADIUS),
          imminent: distance <= zombie.def.attackRange + zombie.radius + 0.6,
        });
      }

      // Closest first, so the strongest cues survive the slot limit.
      threats.sort((a, b) => b.intensity - a.intensity);
      if (threats.length > 4) threats.length = 4;
    }

    this.ui.hud.setThreats(threats, this.player.yaw);

    // A low pulse when something first gets within striking distance behind
    // you -- the audio channel of the same warning.
    this.threatWarnTimer -= dt;
    if (this.threatWarnTimer <= 0 && threats.some((threat) => threat.imminent)) {
      this.threatWarnTimer = 1.1;
      audio.sfx.heartbeat();
    }
  }

  /**
   * Beeps down the last five seconds before a wave, then punches the screen
   * when it lands. The countdown is the main "get ready" signal, so it gets
   * both an audible and a visual channel.
   */
  private updateWaveCountdownAudio(dt: number): void {
    void dt;
    const phase = this.waves.phase;
    if (phase !== 'prep' && phase !== 'cleared') {
      this.lastCountdownBeep = -1;
      return;
    }

    const snapshot = this.waves.snapshot(this.zombies.aliveCount);
    const seconds = Math.ceil(snapshot.prepRemaining);
    if (seconds > 5 || seconds <= 0) return;

    if (seconds !== this.lastCountdownBeep) {
      this.lastCountdownBeep = seconds;
      // Rising pitch as it closes in.
      audio.sfx.exploderBeep((5 - seconds) * 1.2);
    }
  }

  private render(dt: number): void {
    // The menu is a DOM screen over a still image — skipping the 3D render
    // there keeps fans quiet and battery use low while idling.
    if (this.state === 'menu' || this.state === 'boot') return;
    this.postFx.render(dt);
  }

  // -------------------------------------------------------------------------
  // Settings + resize
  // -------------------------------------------------------------------------

  private onSettingsChanged(key: string | null): void {
    if (key === null || key === 'graphics' || key === 'shadows' || key === 'bloom') {
      this.applyQuality();
    }
    if (key === null || key === 'motionBlur') {
      this.postFx.setMotionBlurEnabled(settings.current.motionBlur);
    }
    if (key === null || key === 'fov') {
      this.player.setAspect(window.innerWidth / window.innerHeight);
    }
  }

  /** Applies a resolution multiplier chosen by the performance governor. */
  private applyRenderScale(scale: number): void {
    this.renderScale = scale;
    this.applyQuality();
  }

  private applyQuality(): void {
    const quality: QualityProfile = settings.quality;

    const maxRatio =
      Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap) * this.renderScale;
    this.renderer.setPixelRatio(maxRatio);
    this.renderer.shadowMap.enabled = quality.shadowsEnabled;

    textureLibrary.setAnisotropy(
      Math.min(quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()),
    );

    this.village?.applyQuality(quality);
    // Through the budget, not straight from the preset: a governor-driven
    // preset drop re-enters here, and reading maxZombies directly would hand
    // a full-size horde back to the machine that just failed to render one.
    this.applyCrowdBudget(this.crowdBudget);
    this.decals?.setCapacity(quality.maxDecals);

    this.postFx?.applyQuality(quality, this.scene, this.player.camera);
    this.postFx?.setSamples(quality.msaaSamples);
    this.postFx?.setMotionBlurEnabled(settings.current.motionBlur);

    this.particles?.setPixelRatio(maxRatio);
    this.village?.environment.setPixelRatio(maxRatio);

    this.handleResize();
  }

  private handleResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.renderer.setSize(width, height, false);
    this.player?.setAspect(width / height);
    this.postFx?.setSize(width * this.renderer.getPixelRatio(), height * this.renderer.getPixelRatio());
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.input.dispose();
    this.postFx?.dispose();
    this.zombies?.dispose();
    this.particles?.dispose();
    this.decals?.dispose();
    this.damageNumbers?.dispose();
    this.village?.dispose();
    this.weapons.dispose();
    textureLibrary.dispose();
    this.renderer.dispose();
    audio.dispose();
  }
}
