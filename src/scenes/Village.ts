import * as THREE from 'three';
import { MeshBatcher, Primitives } from './MeshBatcher';
import { materials, type MaterialKey } from './MaterialLibrary';
import {
  buildBarrel,
  buildBench,
  buildBush,
  buildCarousel,
  buildCottage,
  buildCrateStack,
  buildFence,
  buildFerrisWheel,
  buildHayBale,
  buildLampPost,
  buildMarketStall,
  buildSignpost,
  buildStringLights,
  buildTent,
  buildTree,
  buildWell,
  type BuildContext,
  type LightRequest,
} from './PropFactory';
import { SkySystem } from './SkySystem';
import { Environment } from './Environment';
import { CollisionWorld } from '../systems/CollisionWorld';
import { NavGrid } from '../systems/NavGrid';
import { WORLD } from '../game/Config';
import type { QualityProfile } from '../game/Settings';
import { blobShadowTexture } from '../textures/ProceduralTextures';
import { mulberry32, TAU } from '../utilities/MathUtils';

const PLAZA_RADIUS = 19;

/**
 * The map. Owns geometry, collision, navigation, lighting and atmosphere.
 *
 * Layout is generated from a fixed seed, so the town is identical every session
 * (players can learn it) while still being authored procedurally rather than by
 * hand-placing several hundred objects.
 */
export class Village {
  readonly group = new THREE.Group();
  readonly collision = new CollisionWorld();
  readonly navGrid = new NavGrid();
  readonly sky: SkySystem;
  readonly environment = new Environment();

  /** Perimeter positions where waves stream in from. */
  readonly spawnPoints: THREE.Vector3[] = [];

  private readonly dynamicProps = new THREE.Group();
  private readonly batchedMeshes: THREE.Mesh[] = [];
  private readonly pointLights: THREE.PointLight[] = [];

  private sun!: THREE.DirectionalLight;
  private hemisphere!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private rimLight!: THREE.DirectionalLight;

  private carousel: THREE.Object3D | null = null;
  private ferrisWheel: THREE.Object3D | null = null;
  private elapsed = 0;

  constructor(quality: QualityProfile) {
    this.group.name = 'Village';
    this.sky = new SkySystem(quality);
    this.group.add(this.sky.group);
    this.group.add(this.dynamicProps);
    this.group.add(this.environment.group);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  build(scene: THREE.Scene, quality: QualityProfile): void {
    const rand = mulberry32(20260724);
    const batcher = new MeshBatcher(30);
    const lightRequests: LightRequest[] = [];

    const ctx: BuildContext = {
      batcher,
      collision: this.collision,
      rand,
      dynamic: this.dynamicProps,
      lightRequests,
    };

    this.buildGround();
    this.buildPlazaRing(ctx);
    this.buildResidentialRing(ctx, rand);
    this.buildCarnivalDistrict(ctx, rand);
    this.buildMarketRow(ctx, rand);
    this.buildParkland(ctx, rand);
    this.buildPerimeter(ctx, rand);
    this.buildFestoonLighting(ctx, rand);

    // Bake all static geometry down to a handful of merged draw calls.
    const meshes = batcher.build(true, true);
    for (const mesh of meshes) {
      this.batchedMeshes.push(mesh);
      this.group.add(mesh);
    }

    this.collision.build();
    this.navGrid.bake(this.collision, 0.62);
    this.generateSpawnPoints();

    this.setupLighting(scene, lightRequests, quality);
    this.environment.build(quality, this.collision, PLAZA_RADIUS);
  }

  /** Ground planes: grass field, cobbled plaza, and radiating dirt streets. */
  private buildGround(): void {
    const size = WORLD.halfSize * 2;

    const grass = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), materials.get('ground.grass'));
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    grass.position.y = -0.02;
    grass.name = 'ground.grass';
    this.group.add(grass);

    const plaza = new THREE.Mesh(new THREE.CircleGeometry(PLAZA_RADIUS, 48), materials.get('ground.cobble'));
    plaza.rotation.x = -Math.PI / 2;
    plaza.receiveShadow = true;
    plaza.position.y = 0.01;
    plaza.name = 'ground.plaza';
    this.group.add(plaza);

    // Four dirt streets leading out of the square.
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * TAU + Math.PI / 4;
      const street = new THREE.Mesh(new THREE.PlaneGeometry(9, 60), materials.get('ground.dirt'));
      street.rotation.x = -Math.PI / 2;
      street.rotation.z = -angle;
      street.position.set(Math.cos(angle) * 38, 0.005, Math.sin(angle) * 38);
      street.receiveShadow = true;
      this.group.add(street);
    }
  }

  /** Kerb ring, benches, well and the carousel that anchors the square. */
  private buildPlazaRing(ctx: BuildContext): void {
    // Low stone kerb around the plaza, with gaps for the four streets.
    const segments = 44;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      // Leave openings aligned with the streets.
      const streetAngle = ((a - Math.PI / 4) % (TAU / 4) + TAU) % (TAU / 4);
      if (streetAngle < 0.16 || streetAngle > TAU / 4 - 0.16) continue;

      const x = Math.cos(a) * PLAZA_RADIUS;
      const z = Math.sin(a) * PLAZA_RADIUS;
      ctx.batcher.addTransformed('stone.pale', Primitives.boxBase, { x, y: 0, z }, -a, {
        x: 2.9,
        y: 0.26,
        z: 0.55,
      });
    }

    this.carousel = buildCarousel(ctx, 7.5, 3.0, 4.6);
    buildWell(ctx, -9.5, -6.5);

    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.5;
      buildBench(ctx, Math.cos(a) * (PLAZA_RADIUS - 3.2), Math.sin(a) * (PLAZA_RADIUS - 3.2), -a + Math.PI / 2);
    }

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.4;
      buildLampPost(ctx, Math.cos(a) * (PLAZA_RADIUS - 1.4), Math.sin(a) * (PLAZA_RADIUS - 1.4));
    }

    buildSignpost(ctx, -3, 14, 0.3, 'Sunset Hollow', 0x3f6f8f, 0xfff2dc);
  }

  /** Ring of cottages facing the square, with alleys between clusters. */
  private buildResidentialRing(ctx: BuildContext, rand: () => number): void {
    const plasters: MaterialKey[] = [
      'plaster.cream',
      'plaster.mint',
      'plaster.peach',
      'plaster.sky',
      'plaster.butter',
      'plaster.lilac',
    ];
    const roofs: MaterialKey[] = ['roof.red', 'roof.blue', 'roof.teal', 'roof.plum'];
    const stripes: MaterialKey[] = [
      'stripe.redWhite',
      'stripe.blueWhite',
      'stripe.mintWhite',
      'stripe.goldWhite',
    ];
    const shopNames = ['Bakery', 'Toys', 'Sweets', 'Books', 'Cafe', 'Flowers', 'Cheese', 'Hats'];

    const count = 14;
    let shopIndex = 0;

    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + 0.22;
      // Skip the four street mouths.
      const streetAngle = ((a - Math.PI / 4) % (TAU / 4) + TAU) % (TAU / 4);
      if (streetAngle < 0.3 || streetAngle > TAU / 4 - 0.3) continue;

      const radius = PLAZA_RADIUS + 6.5 + rand() * 3.5;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      // Face the building inward toward the plaza.
      const rotation = -a + Math.PI / 2;

      const isShop = rand() < 0.55;
      buildCottage(ctx, {
        x,
        z,
        rotation,
        width: 5.2 + rand() * 2.6,
        depth: 4.6 + rand() * 1.8,
        storeys: rand() < 0.45 ? 2 : 1,
        plaster: plasters[(rand() * plasters.length) | 0],
        roof: roofs[(rand() * roofs.length) | 0],
        awning: isShop ? stripes[(rand() * stripes.length) | 0] : undefined,
        sign: isShop
          ? { text: shopNames[shopIndex++ % shopNames.length], bg: 0x8f4f4f + ((rand() * 0x203020) | 0), fg: 0xfff2dc }
          : undefined,
        lean: (rand() - 0.5) * 0.035,
      });

      // Clutter tucked against the walls.
      const clutterAngle = a + (rand() - 0.5) * 0.16;
      const clutterRadius = radius - 4.6;
      const cx = Math.cos(clutterAngle) * clutterRadius;
      const cz = Math.sin(clutterAngle) * clutterRadius;
      const roll = rand();
      if (roll < 0.3) buildBarrel(ctx, cx, cz, rand() < 0.25);
      else if (roll < 0.55) buildCrateStack(ctx, cx, cz, 1 + ((rand() * 3) | 0));
      else if (roll < 0.75) buildBush(ctx, cx, cz, 0.9 + rand() * 0.5, 'foliage.green');
    }
  }

  /** Fairground to the north: tents, ferris wheel, hay and ticket stalls. */
  private buildCarnivalDistrict(ctx: BuildContext, rand: () => number): void {
    const stripes: MaterialKey[] = [
      'stripe.redWhite',
      'stripe.blueWhite',
      'stripe.mintWhite',
      'stripe.goldWhite',
    ];

    this.ferrisWheel = buildFerrisWheel(ctx, 2, -47, 11);

    const tents: [number, number, number][] = [
      [-16, -33, 4.4],
      [17, -31, 4.0],
      [-4, -38, 5.0],
      [26, -40, 3.6],
      [-27, -42, 3.9],
    ];
    for (let i = 0; i < tents.length; i++) {
      const [x, z, r] = tents[i];
      buildTent(ctx, x, z, r, stripes[i % stripes.length]);
    }

    for (let i = 0; i < 7; i++) {
      const x = -32 + rand() * 64;
      const z = -26 - rand() * 22;
      if (Math.hypot(x - 2, z + 47) < 15) continue;
      buildHayBale(ctx, x, z, rand() * TAU);
    }

    for (let i = 0; i < 4; i++) {
      const x = -22 + i * 14 + rand() * 3;
      const z = -24 + rand() * 2;
      buildMarketStall(ctx, x, z, Math.PI + (rand() - 0.5) * 0.4, stripes[(rand() * stripes.length) | 0]);
    }

    buildSignpost(ctx, 0, -23, 0, 'Funland', 0xc44f6f, 0xfff2dc);

    for (let i = 0; i < 5; i++) {
      buildLampPost(ctx, -26 + i * 13, -28 + (rand() - 0.5) * 4);
    }
  }

  /** Market street to the east: stalls, produce, carts and awnings. */
  private buildMarketRow(ctx: BuildContext, rand: () => number): void {
    const stripes: MaterialKey[] = ['stripe.redWhite', 'stripe.goldWhite', 'stripe.mintWhite'];
    for (let i = 0; i < 6; i++) {
      const z = -12 + i * 6.5;
      buildMarketStall(ctx, 38 + (rand() - 0.5) * 2, z, -Math.PI / 2 + (rand() - 0.5) * 0.3, stripes[i % stripes.length]);
      if (rand() < 0.6) buildBarrel(ctx, 34 + rand() * 2, z + 2, rand() < 0.3);
      if (rand() < 0.5) buildCrateStack(ctx, 42 + rand() * 2, z - 1.5, 1 + ((rand() * 2) | 0));
    }
    for (let i = 0; i < 3; i++) buildLampPost(ctx, 33, -10 + i * 12);
    buildSignpost(ctx, 30, 0, -Math.PI / 2, 'Market', 0x4f8f6f, 0xfff2dc);
  }

  /** Parkland to the south and west: tree groves, fences and bushes. */
  private buildParkland(ctx: BuildContext, rand: () => number): void {
    const foliage: MaterialKey[] = ['foliage.amber', 'foliage.gold', 'foliage.crimson', 'foliage.green'];

    // Grove clusters, kept clear of the plaza and streets.
    for (let i = 0; i < 46; i++) {
      const angle = rand() * TAU;
      const radius = 26 + rand() * 30;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      // Keep the fairground readable.
      if (z < -22 && Math.abs(x) < 34) continue;
      if (x > 30 && Math.abs(z) < 22) continue;
      if (this.collision.isBlocked(x, z, 3.2, 1)) continue;
      buildTree(ctx, x, z, 0.85 + rand() * 0.75, foliage[(rand() * foliage.length) | 0]);
    }

    for (let i = 0; i < 34; i++) {
      const angle = rand() * TAU;
      const radius = 22 + rand() * 34;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (this.collision.isBlocked(x, z, 1.4, 0.5)) continue;
      buildBush(ctx, x, z, 0.7 + rand() * 0.6, foliage[(rand() * foliage.length) | 0]);
    }

    // A fenced garden south of the square.
    const gx = -6;
    const gz = 36;
    buildFence(ctx, gx - 8, gz - 6, gx + 8, gz - 6);
    buildFence(ctx, gx - 8, gz + 6, gx + 8, gz + 6);
    buildFence(ctx, gx - 8, gz - 6, gx - 8, gz + 6);
    buildFence(ctx, gx + 8, gz - 6, gx + 8, gz + 1.5);
    for (let i = 0; i < 5; i++) {
      buildBush(ctx, gx - 5 + rand() * 10, gz - 4 + rand() * 8, 0.8 + rand() * 0.4, 'flower.pink');
    }
    buildBench(ctx, gx, gz, 0);
  }

  /** Boundary treeline and fences that visually close the playable area. */
  private buildPerimeter(ctx: BuildContext, rand: () => number): void {
    const edge = WORLD.halfSize - 2.5;
    const foliage: MaterialKey[] = ['foliage.amber', 'foliage.gold', 'foliage.crimson'];

    // Dense treeline on all four sides forms a natural wall.
    const step = 4.2;
    for (let t = -edge; t <= edge; t += step) {
      for (const [x, z] of [
        [t, -edge],
        [t, edge],
        [-edge, t],
        [edge, t],
      ] as [number, number][]) {
        const jx = x + (rand() - 0.5) * 2.4;
        const jz = z + (rand() - 0.5) * 2.4;
        buildTree(ctx, jx, jz, 1.1 + rand() * 0.6, foliage[(rand() * foliage.length) | 0]);
      }
    }

    // Solid invisible walls so nothing can squeeze between trunks.
    const wallThickness = 2;
    for (const [x, z, hx, hz] of [
      [0, -WORLD.halfSize, WORLD.halfSize, wallThickness],
      [0, WORLD.halfSize, WORLD.halfSize, wallThickness],
      [-WORLD.halfSize, 0, wallThickness, WORLD.halfSize],
      [WORLD.halfSize, 0, wallThickness, WORLD.halfSize],
    ] as [number, number, number, number][]) {
      this.collision.addBox({ x, z, hx, hz, rotation: 0, baseY: 0, height: 12, impactColor: 0x6b7a4a });
    }
  }

  /** Festoon strings criss-crossing the square — the signature warm glow. */
  private buildFestoonLighting(ctx: BuildContext, rand: () => number): void {
    const anchors: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.4;
      anchors.push(
        new THREE.Vector3(
          Math.cos(a) * (PLAZA_RADIUS - 1.4),
          4.05,
          Math.sin(a) * (PLAZA_RADIUS - 1.4),
        ),
      );
    }

    // Chords across the plaza, skipping adjacent pairs so the strings span it.
    for (let i = 0; i < anchors.length; i++) {
      const target = (i + 3) % anchors.length;
      if (target < i) continue;
      buildStringLights(ctx, anchors[i], anchors[target], 13, 1.6 + rand() * 0.5);
    }

    // A run down the market street.
    buildStringLights(
      ctx,
      new THREE.Vector3(33, 3.9, -10),
      new THREE.Vector3(33, 3.9, 26),
      14,
      1.3,
    );
  }

  // -------------------------------------------------------------------------
  // Lighting
  // -------------------------------------------------------------------------

  private setupLighting(scene: THREE.Scene, requests: LightRequest[], quality: QualityProfile): void {
    // Warm distance haze that matches the sky's horizon band.
    scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);
    // Safety net: if anything ever escapes the sky dome, the gap reads as
    // horizon haze rather than a black hole in the sky.
    scene.background = new THREE.Color(WORLD.skyHorizonColor);

    // Key light: low, warm, strongly directional — classic golden hour.
    //
    // These four intensities are summed on every lit surface and must be
    // budgeted together. Three applies a Lambert BRDF of albedo/PI, so a
    // sunlit albedo-0.8 wall lands at roughly 0.8/PI * (sun + hemi + ambient)
    // — tuned here to ~0.85 linear, comfortably exposed and safely under the
    // 1.15 bloom threshold so only lights and the sun actually glow.
    this.sun = new THREE.DirectionalLight(0xffd2a1, 2.4);
    this.sun.position.set(
      WORLD.sunDirection.x * 60,
      WORLD.sunDirection.y * 60,
      WORLD.sunDirection.z * 60,
    );
    this.sun.castShadow = quality.shadowsEnabled;
    this.sun.shadow.mapSize.setScalar(quality.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 190;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.045;
    // Soft-edged shadows read as "animated film" rather than "hard 3D render".
    this.sun.shadow.radius = 3.5;
    this.setShadowExtent(38);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky/ground bounce. Doing the ambient with a hemisphere rather than a flat
    // ambient light is what gives surfaces their soft GI-like grounding.
    this.hemisphere = new THREE.HemisphereLight(0xbfd0ff, 0xffa96b, 0.8);
    this.hemisphere.position.set(0, 40, 0);
    scene.add(this.hemisphere);

    this.ambient = new THREE.AmbientLight(0xffd9bd, 0.25);
    scene.add(this.ambient);

    // Cool counter-key from the opposite side keeps shadows from going muddy.
    this.rimLight = new THREE.DirectionalLight(0x8fa8ff, 0.45);
    this.rimLight.position.set(-WORLD.sunDirection.x * 40, 22, -WORLD.sunDirection.z * 40);
    scene.add(this.rimLight);

    // Point-light budget: keep the highest-priority requests only, because each
    // one costs a lighting loop iteration in every lit fragment shader.
    const budget = quality.shadowsEnabled ? (quality.ssaoEnabled ? 6 : 4) : 2;
    requests.sort((a, b) => b.priority - a.priority);
    for (let i = 0; i < Math.min(budget, requests.length); i++) {
      const req = requests[i];
      const light = new THREE.PointLight(req.color, req.intensity, req.distance, 1.8);
      light.position.copy(req.position);
      light.castShadow = false;
      this.pointLights.push(light);
      this.group.add(light);
    }
  }

  private setShadowExtent(extent: number): void {
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
  }

  /**
   * Keeps the shadow frustum centred on the player. Without this, a map this
   * size would need either a huge (blurry) shadow map or cascades.
   */
  updateShadowFocus(target: THREE.Vector3): void {
    if (!this.sun.castShadow) return;
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      target.x + WORLD.sunDirection.x * 60,
      WORLD.sunDirection.y * 60,
      target.z + WORLD.sunDirection.z * 60,
    );
  }

  applyQuality(quality: QualityProfile): void {
    this.sun.castShadow = quality.shadowsEnabled;
    this.sun.shadow.mapSize.setScalar(quality.shadowMapSize);
    // Force the shadow map to be rebuilt at the new resolution.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    this.sky.setGodRaysEnabled(quality.godRays);
    this.environment.build(quality, this.collision, PLAZA_RADIUS);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /** Perimeter ring positions, filtered to spots that are actually walkable. */
  private generateSpawnPoints(): void {
    this.spawnPoints.length = 0;
    const rings = [
      { radius: 46, count: 16 },
      { radius: 54, count: 12 },
    ];

    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        const a = (i / ring.count) * TAU + ring.radius * 0.01;
        for (let attempt = 0; attempt < 6; attempt++) {
          const r = ring.radius - attempt * 2.4;
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          if (Math.abs(x) > WORLD.halfSize - 5 || Math.abs(z) > WORLD.halfSize - 5) continue;
          if (this.collision.isBlocked(x, z, 1.0, 0.6)) continue;
          if (this.navGrid.isCellBlocked(x, z)) continue;
          this.spawnPoints.push(new THREE.Vector3(x, 0, z));
          break;
        }
      }
    }

    // Guarantee at least a few spawn points even if the layout changes.
    if (this.spawnPoints.length < 6) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * 40, 0, Math.sin(a) * 40));
      }
    }
  }

  /** Contact-shadow decal used under zombies when real shadows are off. */
  createBlobShadow(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: blobShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.75,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += dt;
    this.sky.update(dt, cameraPosition);
    this.environment.update(dt);
    this.updateShadowFocus(cameraPosition);

    // Carousel: platform rotates, horses bob on their poles.
    if (this.carousel) {
      const spinner = this.carousel.userData.spinner as THREE.Group;
      spinner.rotation.y += dt * 0.22;
      for (const child of spinner.children) {
        if (child.userData.bobPhase === undefined) continue;
        child.position.y =
          (child.userData.baseY as number) +
          Math.sin(this.elapsed * 1.6 + (child.userData.bobPhase as number)) * 0.24;
      }
    }

    // Ferris wheel turns; gondolas counter-rotate so they hang level.
    if (this.ferrisWheel) {
      const wheel = this.ferrisWheel.userData.wheel as THREE.Group;
      wheel.rotation.z += dt * 0.075;
      for (const child of wheel.children) {
        if (child.userData.isGondolaPivot) child.rotation.z = -wheel.rotation.z;
      }
    }

    // Hanging signs sway gently.
    for (const child of this.dynamicProps.children) {
      const swing = child.userData.swing as { phase: number; amplitude: number } | undefined;
      if (!swing) continue;
      child.rotation.z = Math.sin(this.elapsed * 1.1 + swing.phase) * swing.amplitude;
    }

    // Festoon bulbs flicker very slightly, as real filament bulbs do.
    const flicker = 0.94 + Math.sin(this.elapsed * 3.1) * 0.03 + Math.sin(this.elapsed * 7.7) * 0.02;
    for (const light of this.pointLights) light.intensity = (light.userData.baseIntensity ??= light.intensity) * flicker;
  }

  /** Advances the sky toward dusk as the run progresses. */
  setProgress(waveNumber: number): void {
    this.sky.setDusk(Math.min(1, (waveNumber - 1) / 22));
    const dusk = this.sky.dusk;
    this.sun.intensity = 2.4 - dusk * 1.3;
    this.hemisphere.intensity = 0.8 - dusk * 0.3;
    this.ambient.intensity = 0.25 - dusk * 0.08;
    this.rimLight.intensity = 0.45 + dusk * 0.3;
    for (const light of this.pointLights) {
      light.userData.baseIntensity = ((light.userData.originalIntensity ??= light.intensity) as number) * (1 + dusk * 0.8);
    }
  }

  dispose(): void {
    for (const mesh of this.batchedMeshes) mesh.geometry.dispose();
    this.batchedMeshes.length = 0;
    this.dynamicProps.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
    });
    this.dynamicProps.clear();
    this.environment.dispose();
    this.sky.dispose();
    this.collision.clear();
    this.group.clear();
  }
}
