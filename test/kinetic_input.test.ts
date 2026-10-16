import { assertEquals } from "jsr:@std/assert@1";
import { GameInputs } from "../interpreter/vendor/game-inputs.js";
import { createKineticInput, lerp, lerpAngle } from "../interpreter/kinetic.js";

Deno.test("GameInputs: binds actions, tracks state, and latches press counts", () => {
  const inputs = new GameInputs(null as any, { gamepad: false });
  inputs.bind("jump", "Space", "KeyW", "w");
  inputs.bind("move-left", "KeyA", "ArrowLeft", "a");

  assertEquals(inputs.state["jump"], false);
  assertEquals(inputs.state["move-left"], false);

  // Simulate KeyDown with code
  inputs._handleKeyEvent("KeyW", true, { code: "KeyW" });
  assertEquals(inputs.state["jump"], true);
  assertEquals(inputs.pressCount["jump"], 1);

  // KeyUp
  inputs._handleKeyEvent("KeyW", false, { code: "KeyW" });
  assertEquals(inputs.state["jump"], false);
  assertEquals(inputs.releaseCount["jump"], 1);

  // Tick clears counters
  inputs.tick();
  assertEquals(inputs.pressCount["jump"], 0);
  assertEquals(inputs.releaseCount["jump"], 0);

  // Lowercase key matching
  inputs._handleKeyEvent("a", true, { code: "KeyA", key: "a" });
  assertEquals(inputs.state["move-left"], true);
  inputs._handleKeyEvent("a", false, { code: "KeyA", key: "a" });
  assertEquals(inputs.state["move-left"], false);

  inputs.destroy();
});

Deno.test("createKineticInput: poll consumes latched actions across simulation ticks", () => {
  const input = createKineticInput({
    bindings: {
      jump: ["Space", "w", "KeyW"],
      fire: ["ControlLeft", "f"],
    },
    gamepad: false,
  });

  // Tap jump between frames (down then up)
  input.inputs._handleKeyEvent("Space", true, { code: "Space" });
  input.inputs._handleKeyEvent("Space", false, { code: "Space" });

  // Poll should see jump was pressed
  const frame1 = input.poll();
  assertEquals(frame1.jump, true);

  // Next frame without new input should see false
  const frame2 = input.poll();
  assertEquals(frame2.jump, false);

  input.destroy();
});

Deno.test("kinetic: lerp and lerpAngle perform linear and circular temporal interpolation", () => {
  assertEquals(lerp(10, 20, 0), 10);
  assertEquals(lerp(10, 20, 0.5), 15);
  assertEquals(lerp(10, 20, 1), 20);

  // lerpAngle handles wrapping across -PI / +PI boundary
  const angleA = Math.PI - 0.1;
  const angleB = -Math.PI + 0.1;
  const mid = lerpAngle(angleA, angleB, 0.5);
  // Shortest path wraps through PI
  assertEquals(Math.abs(Math.abs(mid) - Math.PI) < 0.001, true);
});
