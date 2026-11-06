// Tests for deterministic Omnishell screen markup -> DivKit (Phone) & winio (Desktop) projection.
// Verifies that every screen in apps/realworld and apps/apexrun projects 100% of its inputs,
// actions, live regions, CSS state rules, kinetic 3D surfaces, fast HUD layers, and touch zones
// directly from shell/screens/*.{html,css} with zero opt-outs.

import {
  emitNativeRuntimeBundle,
  projectAppNative,
  selfTest,
} from "../project-native.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
}

Deno.test({
  name: "project-native self-test",
  fn: async () => {
    const { failures } = await selfTest();
    assertEquals(failures, []);
  },
});

Deno.test({
  name: "realworld: all 13 screens project to DivKit and winio with 100% input parity and zero opt-outs",
  fn: async () => {
    const realworldDir = new URL("../../../apps/realworld/", import.meta.url);
    const projection = await projectAppNative(realworldDir);

    const screenNames = Object.keys(projection.screens);
    assertEquals(screenNames.length, 13);

    const editor = projection.screens["editor"];
    assert(editor !== undefined, "editor screen must be projected");
    const editorFields = editor.ir.inputs.map((i) => i.field);
    assertEquals(editorFields, [
      "title",
      "description",
      "body",
      "cover_url",
      "cover_credit",
      "tags",
    ]);

    const editorDivJson = JSON.stringify(editor.divkit);
    const editorWinioJson = JSON.stringify(editor.winio);
    for (const field of editorFields) {
      assert(
        editorDivJson.includes(`"id":"${field}"`),
        `DivKit editor projection missing input '${field}'`,
      );
      assert(
        editorWinioJson.includes(`"inputField":"${field}"`),
        `winio editor projection missing input '${field}'`,
      );
    }

    const settings = projection.screens["settings"];
    assertEquals(
      settings.ir.inputs.map((i) => i.field),
      ["display_name", "bio", "image_url"],
    );

    // Verify all 5 checked-in realworld_bundle.js copies are byte-identical to emitNativeRuntimeBundle(projection)
    const expectedBundle = emitNativeRuntimeBundle(projection);
    const bundlePaths = [
      "../../../apps/realworld/android/bundle/realworld_bundle.js",
      "../../../apps/realworld/android/src/main/resources/bundle/realworld_bundle.js",
      "../../../apps/realworld/android/app/src/main/assets/realworld_bundle.js",
      "../../../apps/realworld/ios/bundle/realworld_bundle.js",
      "../../../apps/realworld/ios/Sources/RealWorld/Resources/bundle/realworld_bundle.js",
    ];
    for (const relPath of bundlePaths) {
      const actual = await Deno.readTextFile(new URL(relPath, import.meta.url));
      assertEquals(actual, expectedBundle);
    }
  },
});

Deno.test({
  name: "apexrun: arena screen projects kinetic:race, 24 HUD layers, 16 touch zones, and keys-only vs touch-only split",
  fn: async () => {
    const apexrunDir = new URL("../../../apps/apexrun/", import.meta.url);
    const projection = await projectAppNative(apexrunDir);

    const arena = projection.screens["arena"];
    assert(arena !== undefined, "arena screen must be projected");
    assertEquals(
      arena.ir.kineticMounts.map((m) => m.actor),
      ["race"],
    );
    assertEquals(arena.ir.hudLayers.length, 24);
    assertEquals(arena.ir.touchZones.length, 16);
    assertEquals(
      arena.ir.inputs.map((i) => i.field),
      ["volume", "join"],
    );

    const divJson = JSON.stringify(arena.divkit);
    assert(divJson.includes('"custom_type":"kinetic:race"'), "DivKit must mount kinetic:race");
    for (const layer of arena.ir.hudLayers) {
      assert(
        divJson.includes(`"custom_type":"kinetic-layer:${layer.layer}"`),
        `DivKit missing HUD layer ${layer.layer}`,
      );
      assert(
        arena.divkit.card.variables.some((v) => v.name === `hud_${layer.layer.replace(/[^a-zA-Z0-9_]/g, "_")}`),
        `DivKit missing variable for HUD layer ${layer.layer}`,
      );
    }
    assert(divJson.includes('"touch_zone":"drive left"'), "DivKit must include touch zones");
    assert(!divJson.includes('"id":"stk-pause-btn"'), "DivKit must omit .keys-only pause button");

    const winioJson = JSON.stringify(arena.winio);
    assert(winioJson.includes('"widget":"KineticSurface"'), "winio must mount KineticSurface");
    assert(winioJson.includes('"widget":"HudLayer"'), "winio must mount HudLayer");
    assert(winioJson.includes('"id":"stk-pause-btn"'), "winio must include .keys-only pause button");
    assert(!winioJson.includes("drive left"), "winio must omit .touch-only zones");
    assert(
      projection.winioRustSource.includes('pub const APP_NAME: &str = "apexrun";'),
      "winioRustSource must declare APP_NAME",
    );
  },
});
