# Sunset Hollow

A first-person zombie wave-survival game that runs entirely in a browser tab. No install, no backend, no login. You hold a village square at golden hour while increasingly unpleasant things walk out of the treeline.

**[▶ Play it](#)** · Built with Three.js, TypeScript and Vite.

---

## The interesting part

The whole game ships **three images**. That's it — a menu backdrop, a pause screen backdrop, and one tileable square of zombie skin. Everything else you see and hear is generated at runtime:

- Every **texture** — cobblestones, grass, roof shingles, wood grain, plaster, brushed metal on the guns, bullet decals, muzzle smoke — is drawn on a `<canvas>` when the game boots, then uploaded to the GPU. Normal maps are derived from those canvases with a Sobel pass.
- Every **model** — the cottages, carnival tents, the carousel, the ferris wheel, all five weapons, all five zombie classes — is assembled from boxes, spheres and cylinders in code. There isn't a single `.glb` in the repo.
- Every **sound** — gunshots, footsteps, reload clicks, zombie growls, UI blips — is synthesised live from oscillators and noise buffers through the Web Audio API. There are no audio files.
- The **soundtrack** is composed on the fly. Real ii–V–i minor harmony, a melody that builds an 8-note motif per phrase and repeats it, swing on the off-beat 16ths, and an arrangement that adds instruments at intensity thresholds as the fight escalates. The harmonic rhythm literally doubles when things get bad.

Total download: **~434 kB gzipped**, including Three.js.

---

## Controls

| | |
|---|---|
| `W A S D` | Move |
| `Shift` | Sprint |
| `Space` | Jump |
| `Ctrl` / `C` | Crouch |
| `Left Mouse` | Fire |
| `Right Mouse` | Aim down sights |
| `R` | Reload |
| `1`–`5` / scroll | Switch weapon |
| `B` | Buy menu |
| `F` | Inspect weapon |
| `Esc` | Pause |

You start with a pistol and 500 credits. Waves scale in count, health, speed and aggression; a boss shows up every fifth wave. Kill fast and you build a combo multiplier that pays for everything else.

---

## How it's put together

```
src/
├── audio/        Web Audio graph, synthesised SFX, generative music engine
├── components/   Player controller, zombie entity + procedural rig
├── game/         Host loop, balance config, settings store, player stats
├── scenes/       Village layout, prop factory, sky, ambient environment
├── systems/      Collision, navigation, waves, economy, combat, particles, post FX
├── textures/     Canvas texture generators, stylised shader patches
├── ui/           DOM screens — menu, HUD, buy menu, pause, settings, game over
├── utilities/    Math, easing, object pool, storage
└── weapons/      Weapon definitions, procedural models, runtime behaviour
```

~19,600 lines across 52 TypeScript modules. A few decisions worth calling out:

**Navigation is one flow field, not 50 pathfinders.** Running A\* per zombie means 50 independent searches every time you move. Instead there's a single Dijkstra expansion outward from the player across a coarse grid, recomputed about 7× a second. Each zombie's per-frame navigation is then two array reads and a bilinear sample. Cost is flat regardless of how many are chasing you.

**Static geometry is batched by material × map district.** Merging everything into one mesh kills draw calls but also kills frustum culling — you'd render the whole town while staring at a wall. Batching per material *and* per spatial chunk gets both: a handful of draw calls per material, with whole districts culled when you're not looking at them.

**Zombies share one rig.** All five classes are the same 8 meshes; the per-class *proportions* rescale them into completely different silhouettes. A pooled zombie can be recycled as any class without rebuilding a single mesh. Both eyes merge into one geometry, and the entire face — brow, sockets, mouth, teeth — is a second merged geometry, because at 60 zombies every extra mesh is 60 more draw calls (120 with shadows).

**Collision is analytic, not raycast-against-triangles.** Bullets, movement and steering all query a parallel set of oriented boxes and cylinders. A shotgun blast is 9 pellets × a handful of arithmetic ops instead of 9 BVH walks.

**The Pixar look is three shader injections.** Stock PBR reads flat and cold on stylised geometry. Every material gets patched via `onBeforeCompile` with a fresnel rim light in the sunset colour, a wrapped subsurface term for light bleeding through leaves and cloth, and per-vertex wind above a height threshold. Injected before tonemapping so it grades correctly through ACES.

Everything transient — bullets, particles, decals, damage numbers, zombies — is pooled. The GC never runs mid-firefight.

---

## Four bugs that were genuinely worth the debugging

Leaving these in because each one produced a *completely* misleading symptom:

**The sky was missing.** The dome had a radius of 600; the camera's far plane was 400. The entire thing was clipped, and the only surviving sky elements were the sun sprite and god rays — which draw with `depthTest: false`. The result looked like a black hole hanging over the village.

**Everything rendered at 300×150.** `EffectComposer` draws into `writeBuffer`/`readBuffer`, which alias `renderTarget1/2` but are *separate references*. Swapping the render-target fields while disposing the originals left the composer rendering into dead targets, permanently locked to whatever size they were built at — and since the post chain was constructed before the renderer was ever sized, that was the HTML canvas default. Then upscaled to full screen.

**Pixel ratio got squared.** `EffectComposer.setSize()` multiplies by its own internal `_pixelRatio`. Passing it drawing-buffer pixels that were *already* scaled meant allocating targets 2.56× too large at a 1.6 ratio.

**A black box appeared at the muzzle.** Point sprites render as square quads, and the smoke layer used straight-alpha blending — so a texture's black transparent border bleeds in and darkens the whole square. Fixed by making the particle layers premultiplied and rewriting the muzzle flash to be computed analytically in a shader, with no texture at all. The related decal artefact had the same root cause: mipmapping averages black-RGB-zero-alpha pixels into visible edges, so a shrinking bullet hole collapses into a dark square.

---

## Running it

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`. Click the canvas to lock the mouse.

```bash
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve the built bundle
npm run typecheck  # tsc --noEmit
```

Needs **WebGL 2**. It'll tell you politely if that's missing.

## Deploying

It's a static bundle — any host will do. On Vercel, the Vite preset is detected automatically; if you're configuring by hand:

- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

No environment variables, no server-side anything.

---

## Performance

Targets 60 FPS on a modern laptop. Settings → Graphics has four presets that scale pixel ratio, shadow map size, MSAA samples, particle and zombie budgets, grass density and ambient occlusion together. Shadow casting is budgeted to the nearest ~12 zombies; the rest fall back to distance LOD that drops eyes, brows and shadows.

If it's chugging, drop to **Medium** — the biggest single cost is shadows, followed by bloom.

## Accessibility

Reduced-motion mode (calms camera bob, shake and menu animation, and respects the OS preference on first run), high-contrast interface mode, adjustable FOV, sensitivity, screen shake and separate music/SFX volumes. Every control is keyboard-reachable with visible focus rings.

---

## Credits & asset provenance

Design, code and everything procedural: built from scratch for this project.

The three bitmap images — menu backdrop, pause backdrop, zombie skin — were generated with Higgsfield. The zombie skin is a hand-painted-style tileable flesh texture; the two backdrops are the village at golden hour and at dusk.

Fonts are Baloo 2 and Nunito, served from Google Fonts.

Deliberate content constraint: the zombies are menacing but **bloodless**. No gore, no wounds, no organs. They're gaunt and predatory with glowing sunken eyes, which turns out to be more unsettling than red paint anyway.
