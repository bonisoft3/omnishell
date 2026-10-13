import "./app-roles.ts";
import { appRenderer } from "../../server/worker-document.ts";
import { routeAt } from "../../interpreter/fragment.js";
import assets from "./.generated/app-assets.json" with { type: "json" };

export const origin = "https://golaberto.bonisoft3.com";
export const cfg = JSON.parse(assets["/shell/shell.json"]);
export function findRoute(url) {
  return routeAt(cfg, url.pathname, url.search, []);
}
export const renderApp = appRenderer(assets, origin);
