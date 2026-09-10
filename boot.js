import { createShell } from "/omnishell/interpreter/shell.js";

createShell({ config: "./shell.yaml", mount: document.getElementById("app") });
