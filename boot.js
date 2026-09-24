import { createShell } from "/omnishell/interpreter/shell.js";

const mount = document.getElementById("app");
if (!mount) throw new Error("boot: #app mount missing");

createShell({ config: "./shell.json", mount });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/offline-first-sw.js");
}
