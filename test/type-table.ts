// A real type table, taken from an emitted shell the way the terminal takes
// one at runtime (shell.yaml `types`). For the test that asks whether a
// drawn value is CANONICAL, where a fixture would be a second definition and
// could agree with nothing — a test about ordering takes
// interpreter/fixture-types.js instead, which the image carries.
//
// Host-only: no image here carries an app to read a shell from.
import { parse } from "jsr:@std/yaml@1";
import { carriers, types } from "../interpreter/vendor/mecha-client.js";

const SHELL = new URL("../../../apps/realworld/shell/shell.yaml", import.meta.url);

const parsed = parse(await Deno.readTextFile(SHELL)) as { types?: unknown; carriers?: unknown };
export const typeTable = (parsed.types ?? parsed.carriers) as never;
export const carrierTable = typeTable;
const binder = types ?? carriers;
export const boundTypes = binder(typeTable);
export const boundCarriers = boundTypes;
