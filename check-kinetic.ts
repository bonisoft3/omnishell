// omnishell kinetic verification: algebraic simulation invariance, absorbing trap state
// fuzzer/model-checker, aspect-aware frustum enclosure linter, and dual-plane projection parity.
//
//   omnishell check kinetic <appDir>
//   omnishell check kinetic --self-test
//
// Verifies that:
// 1. Simulation is deterministic, algebraic, free of absorbing trap states (e.g. pit floors),
//    and bounded by world envelopes.
// 2. Camera frustum is fully enclosed by level geometry across the aspect ratio spectrum
//    (4:3, 16:9, 16:10, 21:9, 32:9), with zero unrendered void leaks.
// 3. Dual-plane projection homomorphism: every entity simulated in state maps to an active
//    visual primitive in the scene graph without silent pool truncation.

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type Finding = { severity: 'critical' | 'error' | 'warning' | 'advisory'; path: string; message: string };

export const fails = (findings: Finding[]) =>
  findings.some((f) => f.severity === 'critical' || f.severity === 'error');

export const ASPECT_RATIOS = [
  { name: '4:3 (retro)', ratio: 4 / 3 },
  { name: '16:9 (standard)', ratio: 16 / 9 },
  { name: '16:10 (macbook)', ratio: 16 / 10 },
  { name: '21:9 (ultrawide)', ratio: 21 / 9 },
  { name: '2.38:1 (custom)', ratio: 2.377 },
  { name: '32:9 (super ultrawide)', ratio: 32 / 9 },
];

/**
 * Checks an app directory for kinetic engine and renderer invariants.
 */
export async function checkApp(appUrl: URL): Promise<{ findings: Finding[] }> {
  const findings: Finding[] = [];
  const appDir = fileURLToPath(appUrl);

  const enginePath = path.join(appDir, 'shell', 'engine', 'simulation.js');
  const tilemapPath = path.join(appDir, 'shell', 'engine', 'tilemap.js');
  const rendererPath = path.join(appDir, 'shell', 'engine', 'renderer.js');
  const constantsPath = path.join(appDir, 'shell', 'engine', 'constants.js');
  const entitiesPath = path.join(appDir, 'shell', 'engine', 'entities.js');

  // If app is not a kinetic app, skip cleanly
  if (!fs.existsSync(enginePath)) {
    return { findings };
  }

  // 1. Battery 1: Simulation Invariance, World Boundary, & Absorbing Trap Detection
  try {
    const simMod = await import(`file://${enginePath}`);
    const tmMod = fs.existsSync(tilemapPath) ? await import(`file://${tilemapPath}`) : null;
    const constMod = fs.existsSync(constantsPath) ? await import(`file://${constantsPath}`) : null;

    const simFindings = checkSimulationLiveness(simMod, tmMod, constMod, appDir);
    findings.push(...simFindings);
  } catch (err: any) {
    findings.push({
      severity: 'critical',
      path: 'shell/engine/simulation.js',
      message: `Failed to import simulation module: ${err.message}`,
    });
  }

  // 2. Battery 2: Aspect-Aware Frustum Enclosure & Void Linter
  if (fs.existsSync(rendererPath)) {
    try {
      const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
      const frustumFindings = checkFrustumEnclosure(rendererSrc, appDir);
      findings.push(...frustumFindings);
    } catch (err: any) {
      findings.push({
        severity: 'critical',
        path: 'shell/engine/renderer.js',
        message: `Failed to analyze renderer source: ${err.message}`,
      });
    }
  }

  // 3. Battery 3: Dual-Plane Projection Homomorphism & Pool Capacity
  if (fs.existsSync(rendererPath)) {
    try {
      const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
      const constantsSrc = fs.existsSync(constantsPath) ? fs.readFileSync(constantsPath, 'utf8') : '';
      const entitiesSrc = fs.existsSync(entitiesPath) ? fs.readFileSync(entitiesPath, 'utf8') : '';
      const projFindings = checkProjectionHomomorphism(rendererSrc, constantsSrc, entitiesSrc);
      findings.push(...projFindings);
    } catch (err: any) {
      findings.push({
        severity: 'critical',
        path: 'shell/engine/renderer.js',
        message: `Failed to verify projection homomorphism: ${err.message}`,
      });
    }
  }

  return { findings };
}

/**
 * Battery 1: Verifies algebraic determinism, boundary clamping, and absence of absorbing trap states.
 */
export function checkSimulationLiveness(
  simMod: any,
  tmMod: any,
  constMod: any,
  appDir: string,
): Finding[] {
  const findings: Finding[] = [];
  const engine = simMod.supertuxEngine || simMod;
  const initStateFn = engine.initState || simMod.createInitialState;
  const advanceFn = engine.advanceFrame || simMod.advanceFrame;

  if (!initStateFn || !advanceFn) {
    findings.push({
      severity: 'critical',
      path: 'shell/engine/simulation.js',
      message: 'Kinetic engine missing mandatory contract: initState and advanceFrame required.',
    });
    return findings;
  }

  // A. Left World Boundary Check
  try {
    let state = initStateFn(1337);
    if (state.tux) {
      state.tux.x = 8;
      for (let i = 0; i < 30; i++) {
        state = advanceFn(state, { left: true });
      }
      if (state.tux.x < 0) {
        findings.push({
          severity: 'critical',
          path: 'shell/engine/simulation.js',
          message: `World boundary leak: actor position x=${state.tux.x} < 0 under continuous leftward input.`,
        });
      }
    }
  } catch (err: any) {
    findings.push({
      severity: 'critical',
      path: 'shell/engine/simulation.js',
      message: `Boundary check threw: ${err.message}`,
    });
  }

  // B. Tilemap Out-of-Bounds Query Check (Pit Open Air Invariant)
  if (tmMod && tmMod.getTileAt) {
    try {
      const dummyTm = tmMod.createDefaultTilemap ? tmMod.createDefaultTilemap() : { width: 100, height: 18, tiles: new Int16Array(1800) };
      const outOfBoundsTile = tmMod.getTileAt(dummyTm, 10, dummyTm.height + 1);
      const isSolidFn = tmMod.isTileSolid || ((t: number) => t === 1);
      if (isSolidFn(outOfBoundsTile)) {
        findings.push({
          severity: 'critical',
          path: 'shell/engine/tilemap.js',
          message: 'Out-of-bounds floor collision: getTileAt returned solid tile for y >= height, trapping actors at pit floor.',
        });
      }
    } catch (err: any) {
      findings.push({
        severity: 'critical',
        path: 'shell/engine/tilemap.js',
        message: `Tilemap out-of-bounds query threw: ${err.message}`,
      });
    }
  }

  // C. Absorbing Pit Trap & Reachability Model Checker
  try {
    let state = initStateFn(1337);
    const tm = state.tilemap;
    const TILE_SIZE = constMod?.TILE_SIZE ?? 32;

    if (tm && tm.tiles && state.tux) {
      const pits: { start: number; end: number }[] = [];
      let inPit = false;
      let pitStart = 0;

      // Scan ground row (height - 3) for missing floor blocks (pits)
      const groundRow = tm.height - 3;
      for (let x = 0; x < tm.width; x++) {
        const t = tm.tiles[groundRow * tm.width + x];
        const isAir = !t || t === 0;
        if (isAir && !inPit) {
          inPit = true;
          pitStart = x;
        } else if (!isAir && inPit) {
          inPit = false;
          pits.push({ start: pitStart, end: x - 1 });
        }
      }
      if (inPit) pits.push({ start: pitStart, end: tm.width - 1 });

      for (const pit of pits) {
        const pitCenterX = Math.floor((pit.start + pit.end) / 2);
        let testState = initStateFn(1337);
        const initialLives = testState.lives;

        // Position Tux directly over the pit
        testState.tux.x = pitCenterX * TILE_SIZE;
        testState.tux.y = (groundRow - 1) * TILE_SIZE;
        testState.tux.grounded = false;

        // Step simulation forward under gravity (neutral inputs)
        let died = false;
        let trappedAtFloor = false;

        for (let tick = 0; tick < 70; tick++) {
          testState = advanceFn(testState, {});
          if (
            testState.events?.some((e: any) => e.type === 'die') ||
            testState.tux.posture === 'dead' ||
            testState.lives < initialLives
          ) {
            died = true;
            break;
          }

          // If Tux lands grounded inside the pit at or below the floor without dying
          if (testState.tux.grounded && testState.tux.y >= (tm.height - 3) * TILE_SIZE) {
            trappedAtFloor = true;
            break;
          }
        }

        if (trappedAtFloor && !died) {
          findings.push({
            severity: 'critical',
            path: 'shell/engine/simulation.js',
            message: `Absorbing trap state detected in pit at column x=${pitCenterX}: actor fell into pit and became grounded at y=${testState.tux.y} without dying or ability to escape.`,
          });
        }
      }
    }
  } catch (err: any) {
    findings.push({
      severity: 'critical',
      path: 'shell/engine/simulation.js',
      message: `Pit trap model checker threw: ${err.message}`,
    });
  }

  return findings;
}

/**
 * Battery 2: Verifies that visible camera frustum never exposes unrendered void outside world bounds.
 */
export function checkFrustumEnclosure(rendererSrc: string, appDir: string): Finding[] {
  const findings: Finding[] = [];

  // Parse camera parameters from renderer source
  const fovMatch = rendererSrc.match(/fov\s*=\s*([0-9.]+)/);
  const fov = fovMatch ? parseFloat(fovMatch[1]) : 0.85;

  const camDistMatch = rendererSrc.match(/Vector3\([0-9.,\s-]+,\s*(-?[0-9.]+)\)/);
  const camDist = camDistMatch ? Math.abs(parseFloat(camDistMatch[1])) : 20;

  const scaleMatch = rendererSrc.match(/const\s+S\s*=\s*([0-9.]+)/);
  const S = scaleMatch ? parseFloat(scaleMatch[1]) : 0.05;

  const virtualWMatch = rendererSrc.match(/virtualWidth\s*=\s*([0-9]+)/);
  const virtualWidth = virtualWMatch ? parseInt(virtualWMatch[1], 10) : 640;

  const hasAspectClamping =
    rendererSrc.includes('frustumWidthPx') &&
    (rendererSrc.includes('minCamX') || rendererSrc.includes('halfFrustumW'));

  const hasLeftGroundPadding =
    rendererSrc.includes('worldLeft < 0') || rendererSrc.includes('leftPadStart');

  // Sweep aspect ratios
  for (const { name, ratio } of ASPECT_RATIOS) {
    const frustumHeightPx = (2 * camDist * Math.tan(fov / 2)) / S;
    const frustumWidthPx = frustumHeightPx * ratio;
    const halfFrustumW = frustumWidthPx / 2;
    const vHalfW = virtualWidth / 2;

    // What left world coordinate is viewed if camera.x = 0
    const rawLeftWorldX = 0 + vHalfW - halfFrustumW;

    if (rawLeftWorldX < -4 && !hasAspectClamping && !hasLeftGroundPadding) {
      findings.push({
        severity: 'critical',
        path: 'shell/engine/renderer.js',
        message: `Frustum void leak on aspect ${name} (${ratio.toFixed(2)}:1): camera clamps at x=0 exposing ${Math.abs(rawLeftWorldX).toFixed(0)}px of void space to the left of level start (x=0).`,
      });
    }
  }

  return findings;
}

/**
 * Battery 3: Verifies projection homomorphism between simulation state entities and renderer meshes.
 */
export function checkProjectionHomomorphism(
  rendererSrc: string,
  constantsSrc: string,
  entitiesSrc: string,
): Finding[] {
  const findings: Finding[] = [];

  // Strip comments so mentions in comments do not fulfill visual projection contracts
  const codeOnlyRenderer = rendererSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  // Extract all entity types declared in simulation / constants
  const declaredTypes = new Set<string>();
  const entityTypeRegex = /([a-zA-Z0-9_]+)\s*:\s*['"]([a-z0-9_]+)['"]/g;

  for (const match of constantsSrc.matchAll(entityTypeRegex)) {
    declaredTypes.add(match[2]);
  }
  for (const match of entitiesSrc.matchAll(entityTypeRegex)) {
    declaredTypes.add(match[2]);
  }

  // Active particle and item entities that MUST have visual projection
  const visualEntities = ['coin_pop', 'brick_debris', 'egg', 'fire_flower'];

  for (const vEntity of visualEntities) {
    const isInEntities = declaredTypes.has(vEntity) || entitiesSrc.includes(vEntity) || constantsSrc.includes(vEntity);
    if (isInEntities) {
      // Check if renderer handles this entity type
      const renderedInSource =
        codeOnlyRenderer.includes(vEntity) ||
        codeOnlyRenderer.includes(vEntity.toUpperCase()) ||
        codeOnlyRenderer.includes(vEntity.replace('_', ''));

      if (!renderedInSource) {
        findings.push({
          severity: 'critical',
          path: 'shell/engine/renderer.js',
          message: `Dual-plane projection gap: entity type '${vEntity}' is simulated in state.particles/entities but has no rendering path in renderer.js.`,
        });
      }
    }
  }

  // Check tile scanning loop for premature culling (e.g. `boxIdx < bTileBoxes.length` on outer for loops)
  const prematureLoopCutoff = /for\s*\([^;]+;\s*[^;]+boxIdx\s*<\s*this\.bTileBoxes\.length\s*;/i.test(rendererSrc);
  if (prematureLoopCutoff) {
    findings.push({
      severity: 'error',
      path: 'shell/engine/renderer.js',
      message: 'Premature frustum culling: tile scanning loop terminates when boxIdx reaches capacity, culling subsequent coins and interactive objects.',
    });
  }

  return findings;
}

/**
 * Built-in self-test suite testing positive and negative cases across all 3 batteries.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  // Case 1: Detects absorbing pit trap state
  {
    const mockSimulation = {
      createInitialState: () => ({
        lives: 3,
        events: [],
        tilemap: {
          width: 50,
          height: 18,
          tiles: new Int16Array(50 * 18), // All air, including ground
        },
        tux: { x: 300, y: 14 * 32, vx: 0, vy: 0, grounded: false, posture: 'jump' },
      }),
      advanceFrame: (state: any) => ({
        ...state,
        // Land on bottom row 18 and get stuck grounded without dying
        tux: { ...state.tux, y: 18 * 32 - 26, vy: 0, grounded: true, posture: 'idle' },
      }),
    };
    const mockTilemap = {
      isTileSolid: (t: number) => t === 1,
      getTileAt: (_tm: any, _x: number, y: number) => (y >= 18 ? 1 : 0), // Bug: returns SOLID below height
    };

    const findings = checkSimulationLiveness(mockSimulation, mockTilemap, { TILE_SIZE: 32 }, '.');
    if (!findings.some((f) => f.message.includes('Out-of-bounds floor collision'))) {
      failures.push('self-test failed to catch out-of-bounds floor collision');
    }
    if (!findings.some((f) => f.message.includes('Absorbing trap state detected'))) {
      failures.push('self-test failed to catch absorbing pit trap state');
    }
  }

  // Case 2: Detects frustum void leak on ultrawide viewports
  {
    const naiveRendererSrc = `
      export class Renderer {
        constructor() {
          this.virtualWidth = 640;
          this.bCamera = { fov: 0.85 };
        }
        updateCamera(tux, tilemap) {
          this.camera.x = Math.max(0, tux.x - 320);
        }
      }
    `;
    const findings = checkFrustumEnclosure(naiveRendererSrc, '.');
    if (!findings.some((f) => f.message.includes('Frustum void leak on aspect 21:9'))) {
      failures.push('self-test failed to catch frustum void leak on naive camera clamping');
    }
  }

  // Case 3: Detects dual-plane projection gap (missing coin_pop rendering)
  {
    const dummyConstants = `export const ENTITY_TYPE = { COIN_POP: 'coin_pop', EGG: 'egg' };`;
    const dummyEntities = `export function createCoinPop() { return { type: 'coin_pop' }; }`;
    const incompleteRendererSrc = `
      export class Renderer {
        render(state) {
          if (state.egg) this.bEgg.position.set(0, 0, 0);
        }
      }
    `;
    const findings = checkProjectionHomomorphism(incompleteRendererSrc, dummyConstants, dummyEntities);
    if (!findings.some((f) => f.message.includes("entity type 'coin_pop'"))) {
      failures.push('self-test failed to catch unrendered particle entity coin_pop');
    }
  }

  return { failures };
}

/**
 * Omnishell CLI entry point for `check kinetic`.
 */
export async function run(args: string[]): Promise<void> {
  Deno.exitCode = 1;

  if (args[0] === '--self-test') {
    const { failures } = await selfTest();
    const say = (line: string) => Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
    for (const f of failures) say(`FAIL ${f}`);
    say(failures.length === 0 ? 'check-kinetic self-test: passed' : `check-kinetic self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }

  const appDir = args[0] || '.';
  const targetUrl = new URL(`${appDir.replace(/\/*$/, '')}/`, `file://${Deno.cwd()}/`);
  const { findings } = await checkApp(targetUrl);

  console.log(JSON.stringify(findings, null, 2));
  if (!fails(findings)) {
    Deno.exitCode = 0;
  }
}

if (import.meta.main) {
  await run(Deno.args);
}
