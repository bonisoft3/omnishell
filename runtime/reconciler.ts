// Headless DivKit reconciler: binds NativeScreenIr + DivKitCard against live relational rows,
// stamps keyed `<template data-item>` repeaters and empty states, resolves `[data-image-src]`
// (`/img/*` and inline `data:image/svg+xml;utf8,...`), evaluates ownership/favorite probes,
// and drives `div-state` sheets and row statechart variables.

import {
  applyDivContainerStyle,
  applyDivTextStyle,
  BLANK_SVG_DATA_URI,
  buildDivKitPalette,
  buildResponsiveShellWrapper,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME,
  directionOfLocale,
  resolveNativeImageUrl,
  type DivKitCard,
  type DivKitVariable,
  type NativeActionSpec,
  type NativeAppProjection,
  type NativeNavEntry,
  type NativeNode,
  type NativeScreenIr,
  type ThemePalettes,
  type ThemeTokens,
} from "../project-native.ts";

export type RowRecord = Record<string, unknown>;
export type TableMap = Record<string, RowRecord[]>;

export interface ReconcileContext {
  origin?: string;
  params?: Record<string, string>;
  tables?: TableMap;
  variables?: Record<string, string | number | boolean>;
  theme?: ThemeTokens;
  palettes?: ThemePalettes;
  themeMode?: "light" | "dark" | "auto";
  systemColorScheme?: "light" | "dark";
  locale?: string;
  viewportWidthDp?: number;
  navEntries?: NativeNavEntry[];
}

export function parsePrintReturnUrl(rawUrl: string): { orderId: string; outcome?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const orderId = parsed.searchParams.get("order")?.trim() || "";
  if (!orderId) return null;
  const outcome = parsed.searchParams.get("checkout") || undefined;

  if (parsed.protocol === "snapcards:") {
    const routePart = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    if (routePart === "print/return" || routePart === "print") {
      return { orderId, ...(outcome ? { outcome } : {}) };
    }
    return null;
  }

  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    const tail = segments[segments.length - 1];
    if (tail === "print") {
      return { orderId, ...(outcome ? { outcome } : {}) };
    }
  }
  return null;
}

const PLACEHOLDER_GLOBAL_RE = /\{([a-zA-Z0-9_.\[\]]+)\}/g;

function sanitizeVarName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sheetStateVarForId(sheetId: string): string {
  if (sheetId === "login-modal-overlay" || sheetId.startsWith("login-modal")) {
    return "modal_login_state";
  }
  return `sheet_${sanitizeVarName(sheetId)}_state`;
}

function lookupPath(expr: string, scope: RowRecord, params: Record<string, string>): unknown {
  if (expr.startsWith("param.")) {
    const key = expr.slice("param.".length);
    return params[key] ?? "";
  }
  if (expr in scope) return scope[expr];
  const parts = expr.split(".");
  let cur: unknown = scope;
  for (const seg of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as RowRecord)[seg];
  }
  return cur;
}

export function interpolateTemplate(
  raw: string,
  scope: RowRecord,
  params: Record<string, string>,
): string {
  const normalized = raw.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  return normalized.replace(PLACEHOLDER_GLOBAL_RE, (full, expr: string) => {
    if (expr.startsWith("msg.") || expr.startsWith("msg[")) return full;
    const val = lookupPath(expr, scope, params);
    return val === undefined || val === null ? "" : String(val);
  });
}

function matchesClause(row: RowRecord, col: string, opExpr: string): boolean {
  const rowVal = row[col];
  if (opExpr === "is.null") {
    return rowVal === null || rowVal === undefined;
  }
  if (opExpr === "not.is.null") {
    return rowVal !== null && rowVal !== undefined;
  }
  const dotIdx = opExpr.indexOf(".");
  if (dotIdx === -1) return true;
  const op = opExpr.slice(0, dotIdx);
  const target = decodeURIComponent(opExpr.slice(dotIdx + 1));

  if (op === "eq") {
    return String(rowVal ?? "") === target;
  }
  if (op === "neq") {
    return String(rowVal ?? "") !== target;
  }
  if (op === "gt") {
    return Number(rowVal) > Number(target);
  }
  if (op === "lt") {
    return Number(rowVal) < Number(target);
  }
  if (op === "in") {
    const inner = target.replace(/^\(/, "").replace(/\)$/, "");
    const allowed = inner.split(",").map((s) => s.trim());
    return allowed.includes(String(rowVal ?? ""));
  }
  if (op === "ilike" || op === "like") {
    const caseInsensitive = op === "ilike";
    const hay = caseInsensitive ? String(rowVal ?? "").toLowerCase() : String(rowVal ?? "");
    const needleRaw = caseInsensitive ? target.toLowerCase() : target;
    const escaped = needleRaw
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[*%]/g, ".*");
    return new RegExp(`^${escaped}$`).test(hay);
  }
  return true;
}

export function queryTableRows(
  tables: TableMap,
  tableName: string,
  filterTemplate: string | undefined,
  orderSpec: string | undefined,
  scope: RowRecord,
  params: Record<string, string>,
): RowRecord[] {
  const source = tables[tableName] ?? [];
  let limit: number | undefined;
  const clauses: Array<{ col: string; opExpr: string }> = [];

  if (filterTemplate) {
    const resolvedFilter = interpolateTemplate(filterTemplate, scope, params);
    for (const part of resolvedFilter.split("&")) {
      if (!part) continue;
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const key = part.slice(0, eqIdx);
      const val = part.slice(eqIdx + 1);
      if (key === "limit") {
        const parsed = Number(val);
        if (Number.isFinite(parsed) && parsed >= 0) limit = parsed;
      } else if (key !== "order" && key !== "select") {
        clauses.push({ col: key, opExpr: val });
      }
    }
  }

  let rows = source.filter((row) => clauses.every((c) => matchesClause(row, c.col, c.opExpr)));

  if (orderSpec) {
    const specs = orderSpec.split(",").map((part) => {
      const [col, dir] = part.trim().split(".");
      return { col, desc: dir === "desc" };
    });
    rows = [...rows].sort((a, b) => {
      for (const { col, desc } of specs) {
        const av = a[col];
        const bv = b[col];
        if (av === bv) continue;
        if (typeof av === "number" && typeof bv === "number") {
          return desc ? bv - av : av - bv;
        }
        const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (limit !== undefined) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

function resolveEmptyRow(
  emptyRow: Record<string, unknown>,
  scope: RowRecord,
  params: Record<string, string>,
): RowRecord {
  const out: RowRecord = {};
  for (const [k, v] of Object.entries(emptyRow)) {
    out[k] = typeof v === "string" ? interpolateTemplate(v, scope, params) : v;
  }
  return out;
}

function isOwnedByMe(tables: TableMap, ownerId: unknown): boolean {
  if (!ownerId || typeof ownerId !== "string") return false;
  const meRows = tables.me ?? [];
  return meRows.some((r) => String(r.id) === ownerId);
}

function isDeckFavorited(tables: TableMap, deckId: unknown): boolean {
  if (!deckId || typeof deckId !== "string") return false;
  const favRows = tables.favorite ?? [];
  return favRows.some(
    (r) =>
      String(r.deck_id ?? r.article_id ?? "") === deckId &&
      (r.deleted_at === null || r.deleted_at === undefined || r.deleted_at === ""),
  );
}

/**
 * Reconcile one projected screen against live relational tables, route params, and state variables,
 * returning a concrete DivKitCard with stamped repeaters, resolved image URLs, and bound variables.
 */
export function reconcileScreenToDivKit(
  screenIr: NativeScreenIr,
  ctx: ReconcileContext = {},
): DivKitCard {
  const origin = ctx.origin || "https://snapcards.fun";
  const params = ctx.params ?? {};
  const tables = ctx.tables ?? {};
  const baseLightTheme = ctx.theme ?? DEFAULT_THEME;
  const palettes: ThemePalettes = ctx.palettes ?? {
    light: baseLightTheme,
    dark: DEFAULT_DARK_THEME,
  };
  const explicitVars = ctx.variables ?? {};

  const deviceRow = queryTableRows(tables, "device", "id=eq.device", undefined, {}, params)[0];
  const rawThemeVar = explicitVars.theme ?? explicitVars.theme_mode ?? ctx.themeMode ?? deviceRow?.theme ?? "auto";
  const effectiveThemeMode: "light" | "dark" | "auto" =
    rawThemeVar === "dark" ? "dark" : rawThemeVar === "light" ? "light" : "auto";
  const resolvedScheme: "light" | "dark" =
    effectiveThemeMode === "dark"
      ? "dark"
      : effectiveThemeMode === "light"
        ? "light"
        : ctx.systemColorScheme === "dark"
          ? "dark"
          : "light";
  const theme: ThemeTokens = resolvedScheme === "dark" ? palettes.dark : palettes.light;

  const locale = ctx.locale || params.locale || "pt";
  const direction = directionOfLocale(locale);
  const isTablet = typeof ctx.viewportWidthDp === "number" && ctx.viewportWidthDp >= 768;

  const variables: DivKitVariable[] = [];
  const varIndex = new Map<string, number>();

  const setVar = (
    name: string,
    type: DivKitVariable["type"],
    defaultValue: string | number | boolean,
  ): string => {
    const clean = sanitizeVarName(name);
    if (varIndex.has(clean)) {
      return clean;
    }
    const initial = Object.prototype.hasOwnProperty.call(explicitVars, clean)
      ? explicitVars[clean]
      : defaultValue;
    varIndex.set(clean, variables.length);
    variables.push({ name: clean, type, value: initial });
    return clean;
  };

  for (const layer of screenIr.hudLayers) {
    setVar(`hud_${layer.layer}`, "string", "");
  }
  for (const inp of screenIr.inputs) {
    setVar(`input_${inp.field}`, "string", "");
  }
  if (params.shelf !== undefined) {
    setVar("author_filter", "string", params.shelf);
  }

  // Seed top-level screen session / generation state variables from tables when present
  const sessionRow = queryTableRows(tables, "play_session", "id=eq.session", undefined, {}, params)[0];
  if (sessionRow) {
    if (typeof sessionRow.status === "string") setVar("status", "string", sessionRow.status);
    if (typeof sessionRow.flipped === "string") setVar("flipped", "string", sessionRow.flipped);
    if (sessionRow.status === "login") setVar("modal_login_state", "string", "open");
  }
  const genFormRow = queryTableRows(tables, "generation_form", "id=eq.draft", undefined, {}, params)[0];
  if (genFormRow && typeof genFormRow.status === "string") {
    setVar("generation_status", "string", genFormRow.status);
  }

  const printConfigRow = queryTableRows(tables, "print_config", "id=eq.config", undefined, {}, params)[0];
  const deliveryDraftRow = queryTableRows(tables, "delivery_draft", "id=eq.draft", undefined, {}, params)[0];
  const activePrintOrderId =
    params.order ||
    (typeof explicitVars.active_order_id === "string" ? explicitVars.active_order_id : "") ||
    (typeof deliveryDraftRow?.order_id === "string" ? deliveryDraftRow.order_id : "") ||
    (typeof tables.print_order?.[0]?.id === "string" ? tables.print_order[0].id : "");
  const activePrintOrderRow = activePrintOrderId
    ? queryTableRows(tables, "print_order", `id=eq.${activePrintOrderId}`, undefined, {}, params)[0]
    : undefined;

  const activeDeckId =
    params.deck ||
    (screenIr.name === "print" && typeof printConfigRow?.set_id === "string" && printConfigRow.set_id
      ? printConfigRow.set_id
      : typeof sessionRow?.set_id === "string"
        ? sessionRow.set_id
        : "");
  if (screenIr.name === "print") {
    setVar("active_deck_id", "string", activeDeckId);
    setVar("active_order_id", "string", activePrintOrderId);
    if (params.order) {
      setVar("sheet_print_checkout_panel_state", "string", "open");
    }
    if (activePrintOrderRow?.status) {
      setVar("print_order_status", "string", String(activePrintOrderRow.status));
    }
  }
  if (activeDeckId) {
    const deckRow = queryTableRows(tables, "card_set", `id=eq.${activeDeckId}`, undefined, {}, params)[0]
      ?? queryTableRows(tables, "localized_deck", `id=eq.${activeDeckId}`, undefined, {}, params)[0];
    if (deckRow) {
      setVar("is_owned_deck", "boolean", isOwnedByMe(tables, deckRow.owner));
    }
    const deckCards = queryTableRows(tables, "flashcard", `set_id=eq.${activeDeckId}`, undefined, {}, params);
    setVar("deck_card_count", "integer", deckCards.length);
    if (screenIr.name === "deck") {
      setVar("deck_is_empty", "boolean", deckCards.length === 0);
    }
  }

  const allDecks = [...(tables.card_set ?? []), ...(tables.localized_deck ?? [])];
  if (allDecks.some((d) => d.cover_emoji === "🎨" && isOwnedByMe(tables, d.owner))) {
    setVar("has_owned_generation", "boolean", true);
  }

  function findByClass(root: NativeNode, className: string): NativeNode | null {
    if (root.classes.includes(className)) return root;
    for (const c of root.children) {
      const hit = findByClass(c, className);
      if (hit) return hit;
    }
    return null;
  }

  function buildActions(
    node: NativeNode,
    scope: RowRecord,
    idSuffix: string,
  ): Array<Record<string, unknown>> | undefined {
    const out: Array<Record<string, unknown>> = [];
    const specs: NativeActionSpec[] = [
      ...(node.extraActions ?? []),
      ...(node.action ? [node.action] : []),
    ];
    for (const spec of specs) {
      const resolvedUrl = interpolateTemplate(spec.url, scope, params);
      const logId = idSuffix ? `${spec.id}__${idSuffix}` : spec.id;
      out.push({ log_id: logId, url: resolvedUrl });
      if (spec.popoverTarget) {
        const stateVar = setVar(sheetStateVarForId(spec.popoverTarget), "string", "closed");
        const nextVal = spec.popoverOp === "hide" ? "closed" : "open";
        out.push({
          log_id: `${logId}_sheet_${nextVal}`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=${nextVal}`,
        });
      }
      if (spec.command === "open-login") {
        const stateVar = setVar("modal_login_state", "string", "closed");
        out.push({
          log_id: `${logId}_open_login`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=open`,
        });
      } else if (
        spec.command === "close-login" ||
        spec.command === "auth-guest" ||
        spec.command === "auth-passkey" ||
        spec.command === "auth-google" ||
        spec.command === "auth-apple" ||
        spec.command === "auth-signout" ||
        spec.command === "auth-delete"
      ) {
        const stateVar = setVar("modal_login_state", "string", "closed");
        out.push({
          log_id: `${logId}_close_login`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=closed`,
        });
      }
    }
    if (node.id === "card-flip-visual" || node.id === "card-flip-prompt") {
      const flippedVar = setVar("flipped", "string", String(scope.flipped ?? "no"));
      out.push({
        log_id: `${node.id}_flip_yes`,
        url: `div-action://set_variable?name=${encodeURIComponent(flippedVar)}&value=yes`,
      });
    } else if (node.id === "card-flip-back" || node.id === "card-flip-back-prompt") {
      const flippedVar = setVar("flipped", "string", String(scope.flipped ?? "no"));
      out.push({
        log_id: `${node.id}_flip_no`,
        url: `div-action://set_variable?name=${encodeURIComponent(flippedVar)}&value=no`,
      });
    }
    return out.length > 0 ? out : undefined;
  }

  function resolveVisibility(
    node: NativeNode,
    scope: RowRecord,
    insideRowRepeater: boolean,
  ): string | undefined {
    if (node.hidden) {
      if (node.classes.includes("store-error") || node.role === "alert") {
        const errVar = setVar("store_error", "string", "");
        return `@{${errVar} != '' ? 'visible' : 'gone'}`;
      }
      if (node.realm?.unit === "print-payment") {
        const payOpenVar = setVar("checkout_payment_open", "boolean", Boolean(activePrintOrderRow?.checkout_url));
        return `@{${payOpenVar} ? 'visible' : 'gone'}`;
      }
      return "gone";
    }

    const cls = new Set(node.classes);

    // Per-row concrete visibility evaluation inside stamped repeater items
    if (insideRowRepeater) {
      const rowOwned = isOwnedByMe(tables, scope.owner);
      const rowFav = isDeckFavorited(tables, scope.id);
      if (cls.has("card-set-item") && params.shelf === "mine" && !rowOwned) {
        return "gone";
      }
      if (cls.has("btn-delete-deck")) {
        return rowOwned ? "visible" : "gone";
      }
      if (cls.has("when-unset")) {
        return rowFav ? "gone" : "visible";
      }
      if (cls.has("when-set")) {
        return rowFav ? "visible" : "gone";
      }
      if (cls.has("card-delete-idle")) {
        const st = String(scope.state ?? "idle");
        return st === "armed" || st === "confirmed" ? "gone" : "visible";
      }
      if (cls.has("card-delete-armed")) {
        const st = String(scope.state ?? "idle");
        return st === "armed" || st === "confirmed" ? "visible" : "gone";
      }
    }

    if (cls.has("fullscreen-topbar")) {
      const v = setVar("status", "string", String(scope.status ?? "playing"));
      return `@{${v} == 'fullscreen' ? 'visible' : 'gone'}`;
    }
    if (
      (cls.has("play-header") || cls.has("explore-contact-sidebar")) &&
      (screenIr.name === "explore" || screenIr.name === "card")
    ) {
      const v = setVar("status", "string", String(scope.status ?? "playing"));
      return `@{${v} == 'fullscreen' ? 'gone' : 'visible'}`;
    }
    if (cls.has("flashcard-stack-wrap") || cls.has("play-controls")) {
      const v = setVar("status", "string", String(scope.status ?? "playing"));
      return `@{${v} == 'completed' ? 'gone' : 'visible'}`;
    }
    if (cls.has("play-completed-card")) {
      const v = setVar("status", "string", String(scope.status ?? "playing"));
      return `@{${v} == 'completed' ? 'visible' : 'gone'}`;
    }
    if (cls.has("generated-deck-banner")) {
      const st = setVar("generation_status", "string", String(scope.status ?? "idle"));
      const own = setVar("has_owned_generation", "boolean", false);
      return `@{${st} == 'done' || ${st} == 'generating' || ${st} == 'partial' || ${own} ? 'visible' : 'gone'}`;
    }
    if (cls.has("my-cards-cta-card")) {
      const af = setVar("author_filter", "string", params.shelf ?? "");
      return `@{${af} == 'mine' ? 'visible' : 'gone'}`;
    }
    if (cls.has("featured-hero")) {
      const af = setVar("author_filter", "string", params.shelf ?? "");
      return `@{${af} == 'mine' || ${af} == 'gallery' ? 'gone' : 'visible'}`;
    }
    if (cls.has("btn-edit-card") || cls.has("btn-delete-deck")) {
      const own = setVar("is_owned_deck", "boolean", false);
      return `@{${own} ? 'visible' : 'gone'}`;
    }
    if (cls.has("card-delete")) {
      const own = setVar("is_owned_deck", "boolean", false);
      const cnt = setVar("deck_card_count", "integer", 0);
      return `@{${own} && ${cnt} > 1 ? 'visible' : 'gone'}`;
    }
    if (cls.has("when-unset")) {
      const fav = setVar("is_favorited", "boolean", false);
      return `@{${fav} ? 'gone' : 'visible'}`;
    }
    if (cls.has("when-set")) {
      const fav = setVar("is_favorited", "boolean", false);
      return `@{${fav} ? 'visible' : 'gone'}`;
    }
    if (cls.has("deck-loading")) {
      const empty = setVar("deck_is_empty", "boolean", false);
      return `@{${empty} ? 'gone' : 'visible'}`;
    }
    if (cls.has("deck-empty-back")) {
      const empty = setVar("deck_is_empty", "boolean", false);
      return `@{${empty} ? 'visible' : 'gone'}`;
    }
    if (cls.has("translation-error")) {
      const tf = setVar("translation_failed_topic", "string", String(scope.translation_failed_topic ?? ""));
      return `@{${tf} != '' ? 'visible' : 'gone'}`;
    }

    if (typeof ctx.viewportWidthDp === "number" && ctx.viewportWidthDp < 768) {
      if (
        cls.has("top-bar-breadcrumb") ||
        cls.has("search-kbd") ||
        cls.has("btn-top-new") ||
        cls.has("btn-top-print") ||
        cls.has("btn-top-login") ||
        cls.has("filter-badges") ||
        cls.has("hero-meta")
      ) {
        return "gone";
      }
    }

    return undefined;
  }

  function reconcileNode(
    node: NativeNode,
    parentScope: RowRecord,
    idSuffix: string,
    insideRowRepeater: boolean,
    inHorizontalParent = false,
  ): Record<string, unknown> | null {
    if (node.visibility === "keys-only" || node.isProbe) return null;

    let scope = parentScope;
    let repeaterRows: RowRecord[] | undefined;

    if (node.live) {
      const matched = queryTableRows(
        tables,
        node.live.table,
        node.live.filter,
        node.live.order,
        parentScope,
        params,
      );
      if (node.live.isRepeater) {
        repeaterRows =
          matched.length === 0 && node.live.emptyRow
            ? [resolveEmptyRow(node.live.emptyRow, parentScope, params)]
            : matched;
      } else {
        const single = matched[0]
          ?? (node.live.emptyRow ? resolveEmptyRow(node.live.emptyRow, parentScope, params) : undefined);
        if (single) {
          scope = { ...parentScope, ...single, [node.live.table]: single };
        }
      }
    }

    const visibility = resolveVisibility(node, scope, insideRowRepeater);
    if (visibility === "gone" && node.hidden) return null;
    if (visibility === "gone" && insideRowRepeater) return null;
    if (visibility === "gone" && typeof ctx.viewportWidthDp === "number" && ctx.viewportWidthDp < 768) return null;

    const concreteId = idSuffix ? `${node.id}__${idSuffix}` : node.id;

    if (node.flipCard) {
      const initialFlipped = String(scope.flipped ?? "no");
      const flippedVar = setVar(node.flipCard.flippedVar, "string", initialFlipped);
      const frontNode = findByClass(node, "card-front") ?? node.children[0];
      const backNode = findByClass(node, "card-back") ?? node.children[1];
      const frontDiv = frontNode ? reconcileNode(frontNode, scope, idSuffix, insideRowRepeater, false) : null;
      const backDiv = backNode ? reconcileNode(backNode, scope, idSuffix, insideRowRepeater, false) : null;
      const items = [frontDiv, backDiv].filter((x): x is Record<string, unknown> => x !== null);
      const customId = node.children[0]?.id && node.children[0].classes.includes("card-inner")
        ? (idSuffix ? `${node.children[0].id}__${idSuffix}` : node.children[0].id)
        : concreteId;
      return {
        type: "custom",
        id: customId,
        custom_type: "flip-card",
        width: { type: "match_parent" },
        height: { type: "fixed", value: 380 },
        items,
        custom_props: {
          flipped: `@{${flippedVar}}`,
          flipped_variable: flippedVar,
          perspective_px: 1200,
          duration_ms: 600,
          direction,
        },
        ...(visibility ? { visibility } : {}),
      };
    }

    if (node.realm) {
      const realmScope: RowRecord = {
        ...printConfigRow,
        ...deliveryDraftRow,
        ...scope,
        set_id: scope.set_id ?? printConfigRow?.set_id ?? activeDeckId,
        order_id: scope.order_id ?? activePrintOrderId,
      };
      const resolvedProps: Record<string, string> = {};
      for (const [pk, pv] of Object.entries(node.realm.props)) {
        resolvedProps[pk] = interpolateTemplate(pv, realmScope, params);
      }
      if (node.realm.unit === "print-payment" && activePrintOrderRow) {
        if (!resolvedProps.order) resolvedProps.order = String(activePrintOrderRow.id ?? activePrintOrderId);
        if (!resolvedProps.url && typeof activePrintOrderRow.checkout_url === "string") {
          resolvedProps.url = activePrintOrderRow.checkout_url;
        }
      }
      const deckIdVal = String(realmScope.set_id ?? activeDeckId ?? "");
      const orderIdVal = String(realmScope.order_id ?? activePrintOrderId ?? "");
      return {
        type: "custom",
        id: concreteId,
        custom_type: node.realm.customType,
        width: { type: "match_parent" },
        height:
          node.realm.customType === "print-realm"
            ? { type: "fixed", value: 360 }
            : resolvedProps.mode === "locate"
              ? { type: "fixed", value: 44 }
              : { type: "fixed", value: 260 },
        custom_props: {
          unit: node.realm.unit,
          isolation: node.realm.isolation,
          grants: node.realm.grants,
          ...(node.realm.src ? { src: node.realm.src } : {}),
          ...(node.realm.subdomain ? { subdomain: node.realm.subdomain } : {}),
          deck_id: deckIdVal,
          order_id: orderIdVal,
          ...(activePrintOrderRow?.status ? { order_status: String(activePrintOrderRow.status) } : {}),
          ...(typeof activePrintOrderRow?.checkout_url === "string"
            ? { checkout_url: activePrintOrderRow.checkout_url }
            : {}),
          locale,
          direction,
          theme: resolvedScheme,
          origin,
          props: resolvedProps,
          events: node.realm.events,
          print_action_url: `omnishell://print?job=Snapcards&unit=${encodeURIComponent(node.realm.unit)}&deck=${encodeURIComponent(deckIdVal)}`,
          checkout_action_url:
            typeof activePrintOrderRow?.checkout_url === "string" && activePrintOrderRow.checkout_url.length > 0
              ? `omnishell://checkout?order=${encodeURIComponent(orderIdVal)}&checkout_url=${encodeURIComponent(activePrintOrderRow.checkout_url)}&return_url=${encodeURIComponent(`snapcards://print/return?order=${orderIdVal}`)}`
              : `omnishell://checkout?order=${encodeURIComponent(orderIdVal)}&deck=${encodeURIComponent(deckIdVal)}&return_url=${encodeURIComponent("snapcards://print/return")}`,
        },
        ...(visibility ? { visibility } : {}),
      };
    }

    if (node.image) {
      const resolvedRaw = interpolateTemplate(node.image.src, scope, params);
      const imageUrl = resolveNativeImageUrl(resolvedRaw || BLANK_SVG_DATA_URI, origin);
      const resolvedAlt = node.image.alt ? interpolateTemplate(node.image.alt, scope, params) : undefined;
      const defaultImgHeight = node.classes.includes("card-illustration-img")
        ? 230
        : node.classes.includes("card-rail-thumb") || node.classes.includes("deck-picker-cover")
          ? 110
          : 180;
      return {
        type: "image",
        id: concreteId,
        image_url: imageUrl,
        scale: node.image.scale,
        preload_required: !node.image.isResponsiveBinding,
        width: node.image.width
          ? { type: "fixed", value: node.image.width }
          : inHorizontalParent
            ? { type: "fixed", value: 140 }
            : { type: "match_parent" },
        height: node.image.height
          ? { type: "fixed", value: node.image.height }
          : { type: "fixed", value: defaultImgHeight },
        border: { corner_radius: 12 },
        ...(resolvedAlt ? { accessibility: { description: resolvedAlt } } : {}),
        ...(visibility ? { visibility } : {}),
      };
    }

    if (node.input) {
      const initialVal = node.input.valueBinding
        ? interpolateTemplate(node.input.valueBinding, scope, params)
        : "";
      const varName = setVar(`input_${node.input.field}`, "string", initialVal);
      const keyboardType =
        node.input.kind === "multiline"
          ? "multi_line_text"
          : node.input.kind === "number" || node.input.kind === "range"
            ? "number"
            : "single_line_text";
      return {
        type: "input",
        id: concreteId,
        hint_text: node.input.placeholder || node.input.field,
        text_variable: varName,
        keyboard_type: keyboardType,
        font_size: node.typography === "display" ? 20 : 15,
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: theme.primary,
        ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
        ...(visibility ? { visibility } : {}),
      };
    }

    const childDivs: Record<string, unknown>[] = [];
    if (node.live?.isRepeater && repeaterRows !== undefined) {
      const countVarName = `live_${concreteId}_count`;
      setVar(countVarName, "integer", repeaterRows.length);
      if (repeaterRows.length === 0) {
        if (node.live.empty && node.live.empty.length > 0) {
          childDivs.push({
            type: "text",
            id: `${concreteId}_empty`,
            text: node.live.empty,
            font_size: 14,
            font_weight: "regular",
            font_family: "sans-serif",
            text_color: theme.secondary,
            ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
          });
        }
      } else {
        const templates = node.live.itemTemplates ?? [];
        const childInHoriz = node.orientation === "horizontal";
        repeaterRows.forEach((row, idx) => {
          const rowKey = sanitizeVarName(String(row.id ?? row.deck_id ?? idx));
          const nextSuffix = idSuffix ? `${idSuffix}_${rowKey}` : rowKey;
          const rowScope = { ...scope, _index: idx, _count: repeaterRows!.length, ...row };
          for (const tpl of templates) {
            const stamped = reconcileNode(tpl, rowScope, nextSuffix, true, childInHoriz);
            if (stamped) childDivs.push(stamped);
          }
        });
      }
    } else {
      const childInHoriz = node.orientation === "horizontal";
      for (const child of node.children) {
        const lowered = reconcileNode(child, scope, idSuffix, insideRowRepeater, childInHoriz);
        if (lowered) childDivs.push(lowered);
      }
    }

    const actions = buildActions(node, scope, idSuffix);

    if (node.sheet) {
      const stateVar = setVar(node.sheet.stateVar, "string", "closed");
      const openDiv: Record<string, unknown> = {
        type: "container",
        id: concreteId,
        orientation: node.orientation,
        items: childDivs,
        ...(actions ? { actions } : {}),
      };
      applyDivContainerStyle(openDiv, node, theme, false);
      return {
        type: "state",
        id: `state_${node.sheet.sheetId}`,
        div_id: `state_${node.sheet.sheetId}`,
        default_state_id: "closed",
        state_id_variable: stateVar,
        states: [
          { state_id: "closed" },
          { state_id: "open", div: openDiv },
        ],
      };
    }

    if (childDivs.length === 0) {
      const rawText = node.textBinding ?? node.text ?? node.action?.label ?? "";
      const displayText = rawText ? interpolateTemplate(rawText, scope, params) : "";
      if (!displayText && !actions && !node.touchZone && !node.live?.isRepeater) return null;
      if (!displayText && !actions && node.live?.isRepeater) {
        const emptyContainer: Record<string, unknown> = {
          type: "container",
          id: concreteId,
          orientation: node.orientation,
          items: [],
          ...(visibility ? { visibility } : {}),
        };
        return applyDivContainerStyle(emptyContainer, node, theme, inHorizontalParent);
      }
      const textDiv: Record<string, unknown> = {
        type: "text",
        id: concreteId,
        text: displayText,
        font_size: node.typography === "display" ? 22 : node.typography === "meta" ? 12 : 15,
        font_weight:
          node.typography === "display" || node.tag === "b" || node.tag === "strong" || node.tag === "button"
            ? "bold"
            : "regular",
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: node.tag === "button" || node.tag === "a" ? theme.accent : theme.primary,
        ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
        ...(actions ? { actions } : {}),
        ...(visibility ? { visibility } : {}),
      };
      return applyDivTextStyle(textDiv, node, theme, inHorizontalParent);
    }

    const isDeckGrid = isTablet && (node.classes.includes("deck-grid") || node.classes.includes("cards-grid"));
    if (isDeckGrid) {
      return {
        type: "grid",
        id: concreteId,
        column_count: 2,
        items: childDivs,
        ...(direction === "rtl" ? { content_alignment_horizontal: "right" } : {}),
        ...(actions ? { actions } : {}),
        ...(visibility ? { visibility } : {}),
      };
    }

    const orderedChildren =
      direction === "rtl" && node.orientation === "horizontal" ? [...childDivs].reverse() : childDivs;

    const containerDiv: Record<string, unknown> = {
      type: "container",
      id: concreteId,
      orientation: node.orientation,
      items: orderedChildren,
      ...(direction === "rtl" ? { content_alignment_horizontal: "right" } : {}),
      ...(actions ? { actions } : {}),
      ...(visibility ? { visibility } : {}),
    };
    return applyDivContainerStyle(containerDiv, node, theme, inHorizontalParent);
  }

  setVar("theme_mode", "string", effectiveThemeMode);
  setVar("resolved_theme", "string", resolvedScheme);
  setVar("layout_direction", "string", direction);

  let rootDiv = reconcileNode(screenIr.root, {}, "", false) || {
    type: "container",
    id: `${screenIr.name}_root`,
    orientation: "vertical",
    items: [],
  };

  if (typeof ctx.viewportWidthDp === "number") {
    setVar("form_factor", "string", ctx.viewportWidthDp >= 768 ? "tablet" : "phone");
    rootDiv = buildResponsiveShellWrapper(screenIr.name, rootDiv, {
      viewportWidthDp: ctx.viewportWidthDp,
      direction,
      theme,
      navEntries: ctx.navEntries,
    });
  }

  return {
    card: {
      log_id: `omnishell_${screenIr.name}`,
      variables,
      palette: buildDivKitPalette(palettes),
      states: [
        {
          state_id: 0,
          div: rootDiv,
        },
      ],
    },
  };
}

export class HeadlessDivKitSession {
  private projection: NativeAppProjection;
  private origin: string;
  private currentScreen: string;
  private params: Record<string, string>;
  private tables: TableMap;
  private variables: Record<string, string | number | boolean> = {};
  private locale: string;
  private viewportWidthDp?: number;
  private themeMode?: "light" | "dark" | "auto";
  private systemColorScheme: "light" | "dark";

  constructor(
    projection: NativeAppProjection,
    options: {
      origin?: string;
      initialScreen?: string;
      params?: Record<string, string>;
      tables?: TableMap;
      locale?: string;
      viewportWidthDp?: number;
      themeMode?: "light" | "dark" | "auto";
      systemColorScheme?: "light" | "dark";
    } = {},
  ) {
    this.projection = projection;
    this.origin = options.origin || "https://snapcards.fun";
    this.currentScreen = options.initialScreen || Object.keys(projection.screens)[0] || "cards";
    this.params = { ...(options.params ?? {}) };
    this.tables = { ...(options.tables ?? {}) };
    this.locale = options.locale || projection.defaultLocale || "pt";
    this.viewportWidthDp = options.viewportWidthDp;
    this.themeMode = options.themeMode;
    this.systemColorScheme = options.systemColorScheme || "light";
  }

  get screen(): string {
    return this.currentScreen;
  }

  setViewportWidthDp(widthDp: number | undefined): void {
    this.viewportWidthDp = widthDp;
  }

  setLocale(nextLocale: string): void {
    this.locale = nextLocale;
  }

  setThemeMode(mode: "light" | "dark" | "auto"): void {
    this.themeMode = mode;
    this.variables.theme = mode;
    this.upsertRow("device", { id: "device", theme: mode });
  }

  setSystemColorScheme(scheme: "light" | "dark"): void {
    this.systemColorScheme = scheme;
  }

  setTables(nextTables: TableMap): void {
    this.tables = { ...nextTables };
  }

  upsertRow(table: string, row: RowRecord, keyField = "id"): void {
    const list = [...(this.tables[table] ?? [])];
    const idx = list.findIndex((r) => String(r[keyField]) === String(row[keyField]));
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push({ ...row });
    this.tables[table] = list;
  }

  render(): DivKitCard {
    const entry = this.projection.screens[this.currentScreen];
    if (!entry) {
      throw new Error(`Unknown screen '${this.currentScreen}' in app '${this.projection.app}'`);
    }
    return reconcileScreenToDivKit(entry.ir, {
      origin: this.origin,
      params: this.params,
      tables: this.tables,
      variables: this.variables,
      theme: this.projection.theme,
      palettes: this.projection.palettes,
      themeMode: this.themeMode,
      systemColorScheme: this.systemColorScheme,
      locale: this.locale,
      viewportWidthDp: this.viewportWidthDp,
      navEntries: this.projection.navEntries,
    });
  }

  async recheckPrintOrder(
    orderId: string,
    options: { fetcher?: typeof fetch; bearerToken?: string } = {},
  ): Promise<RowRecord> {
    const doFetch = options.fetcher ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Prefer: "return=representation",
      ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
    };
    const cleanOrigin = this.origin.replace(/\/+$/, "");
    const getRes = await doFetch(`${cleanOrigin}/crud/print_order?id=eq.${encodeURIComponent(orderId)}`, {
      headers,
    });
    if (!getRes.ok) {
      throw new Error(`print_order lookup failed (${getRes.status})`);
    }
    const rows = (await getRes.json()) as RowRecord[];
    let row = rows[0];
    if (!row) throw new Error("order_not_found");

    if (row.status === "awaiting_payment") {
      const nextChecks = Number(row.checks ?? 0) + 1;
      const patchRes = await doFetch(
        `${cleanOrigin}/crud/print_order?id=eq.${encodeURIComponent(orderId)}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status: "checking", checks: nextChecks }),
        },
      );
      if (!patchRes.ok) {
        throw new Error(`print_order recheck PATCH failed (${patchRes.status})`);
      }
      const patched = (await patchRes.json()) as RowRecord[];
      if (patched[0]) row = patched[0];
    }

    this.upsertRow("print_order", row);
    this.variables.active_order_id = orderId;
    this.variables.print_order_status = String(row.status ?? "");
    return row;
  }

  async handleDeepLink(
    deepLinkUrl: string,
    options: { fetcher?: typeof fetch; bearerToken?: string } = {},
  ): Promise<{ screen: string; orderId?: string; recheckedRow?: RowRecord; card: DivKitCard }> {
    const printReturn = parsePrintReturnUrl(deepLinkUrl);
    if (!printReturn) {
      throw new Error(`Unsupported deep link URL: ${deepLinkUrl}`);
    }
    this.currentScreen = "print";
    this.params = {
      ...this.params,
      order: printReturn.orderId,
      ...(printReturn.outcome ? { checkout: printReturn.outcome } : {}),
    };
    this.variables.sheet_print_checkout_panel_state = "open";
    this.variables.checkout_payment_open = false;
    const recheckedRow = await this.recheckPrintOrder(printReturn.orderId, options);
    return {
      screen: this.currentScreen,
      orderId: printReturn.orderId,
      recheckedRow,
      card: this.render(),
    };
  }

  dispatchAction(actionUri: string): DivKitCard {
    if (actionUri.startsWith("div-action://set_variable?")) {
      const qs = new URLSearchParams(actionUri.slice("div-action://set_variable?".length));
      const name = qs.get("name");
      const val = qs.get("value");
      if (name && val !== null) {
        this.variables[name] = val;
      }
      return this.render();
    }

    if (actionUri.startsWith("omnishell://print?") || actionUri.startsWith("omnishell://checkout?")) {
      return this.render();
    }

    if (!actionUri.startsWith("pronto://event/")) {
      throw new Error(`Unsupported action URI: ${actionUri}`);
    }

    const raw = actionUri.slice("pronto://event/".length);
    const qIdx = raw.indexOf("?");
    const action = qIdx === -1 ? raw : raw.slice(0, qIdx);
    const qs = new URLSearchParams(qIdx === -1 ? "" : raw.slice(qIdx + 1));

    if (action === "NAVIGATE") {
      const nextScreen = qs.get("screen");
      const nextLocale = qs.get("locale");
      if (nextLocale) this.locale = nextLocale;
      if (nextScreen) {
        this.currentScreen = nextScreen;
        const nextParams: Record<string, string> = {};
        qs.forEach((v, k) => {
          if (k !== "screen") nextParams[k] = v;
        });
        this.params = nextParams;
      }
    } else if (action === "POPOVER") {
      const target = qs.get("target") || "";
      const op = qs.get("op") || "toggle";
      const varName = sheetStateVarForId(target);
      const prev = this.variables[varName] ?? "closed";
      this.variables[varName] =
        op === "hide" ? "closed" : op === "show" ? "open" : prev === "open" ? "closed" : "open";
    } else if (action === "CHART_CLICK") {
      const id = qs.get("id") || "";
      const entry = this.projection.screens[this.currentScreen];
      const chartTarget = entry?.ir.chartTargets?.[id];
      if (id === "card-flip-visual" || id === "card-flip-prompt") {
        this.variables.flipped = "yes";
      } else if (id === "card-flip-back" || id === "card-flip-back-prompt") {
        this.variables.flipped = "no";
      } else if (id === "theme-light" || id === "theme-dark" || id === "theme-auto") {
        const nextTheme = id === "theme-dark" ? "dark" : id === "theme-light" ? "light" : "auto";
        this.setThemeMode(nextTheme);
      } else if (chartTarget?.nextState !== undefined) {
        this.variables[sanitizeVarName(chartTarget.field)] = chartTarget.nextState;
      }
    } else if (action === "COMMAND") {
      const cmd = qs.get("command");
      if (cmd === "open-login") {
        this.variables.status = "login";
        this.variables.modal_login_state = "open";
      } else if (
        cmd === "close-login" ||
        cmd === "auth-guest" ||
        cmd === "auth-passkey" ||
        cmd === "auth-google" ||
        cmd === "auth-apple" ||
        cmd === "auth-signout" ||
        cmd === "auth-delete"
      ) {
        this.variables.status = "playing";
        this.variables.modal_login_state = "closed";
        if (cmd === "auth-delete") {
          this.tables.me = [];
          this.tables.favorite = [];
        }
      } else if (cmd === "fullscreen") {
        this.variables.status = "fullscreen";
      } else if (cmd === "exit-fullscreen") {
        this.variables.status = "playing";
      }
    } else if (action === "AUTH") {
      const method = qs.get("method");
      this.variables.status = "playing";
      this.variables.modal_login_state = "closed";
      if (method === "delete-account" || method === "signout") {
        this.tables.me = [];
        if (method === "delete-account") {
          this.tables.favorite = [];
        }
      }
    } else if (action === "INPUT") {
      const field = qs.get("field");
      const val = qs.get("value") ?? "";
      if (field) this.variables[`input_${sanitizeVarName(field)}`] = val;
    }

    return this.render();
  }
}

export function emitNativeHostRuntimeJs(): string {
  return `// App-agnostic Omnishell SDUI Host Runtime for JavaScriptCore / QuickJS.
// Loads bundled Resources/screens/<screen>.divkit.json, evaluates Jessie handlers
// and Statechart machines from SQLite CacheStorage, and reconciles data-live repeaters.
(function() {
  "use strict";

  const BLANK_SVG_DATA_URI = ${JSON.stringify(BLANK_SVG_DATA_URI)};
  const RTL_LANGS = new Set(["he", "iw", "ar", "fa", "ur", "yi"]);

  function directionOfLocale(locale) {
    if (!locale) return "ltr";
    const prefix = String(locale).trim().toLowerCase().split(/[-_]/)[0];
    return RTL_LANGS.has(prefix) ? "rtl" : "ltr";
  }

  function sanitizeVarName(raw) {
    return String(raw || "").replace(/[^a-zA-Z0-9_]/g, "_");
  }

  function sheetStateVarForId(sheetId) {
    if (sheetId === "login-modal-overlay" || String(sheetId).startsWith("login-modal")) {
      return "modal_login_state";
    }
    return "sheet_" + sanitizeVarName(sheetId) + "_state";
  }

  function harden(val, seen) {
    if (val === null || (typeof val !== "object" && typeof val !== "function")) return val;
    const visited = seen || new Set();
    if (visited.has(val)) return val;
    visited.add(val);
    for (const k of Object.getOwnPropertyNames(val)) {
      const desc = Object.getOwnPropertyDescriptor(val, k);
      if (desc && "value" in desc) harden(desc.value, visited);
    }
    return Object.freeze(val);
  }

  function Statechart(chart, implementations) {
    const fail = (msg) => { throw new Error("statechart: " + msg); };
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    if (!chart || typeof chart !== "object" || !chart.states || !own(chart.states, chart.initial)) {
      fail("invalid chart");
    }
    if (typeof implementations?.guard !== "function" || typeof implementations?.reduce !== "function") {
      fail("guard and reduce callbacks are required");
    }
    const knownEvents = new Set();
    for (const st of Object.values(chart.states)) {
      if (st && st.on) {
        for (const ev of Object.keys(st.on)) knownEvents.add(ev);
      }
    }
    return function stepStatechart(row, event) {
      if (!row || !own(chart.states, row.phase) || !event || !knownEvents.has(event.kind)) {
        fail("invalid state or event");
      }
      const stateDecl = chart.states[row.phase];
      const arrow = stateDecl && stateDecl.on && own(stateDecl.on, event.kind) ? stateDecl.on[event.kind] : null;
      if (!arrow) return row;
      if (arrow.guard !== undefined) {
        const ok = implementations.guard(row, arrow.guard, event, false);
        if (typeof ok !== "boolean") fail("guard must return a boolean");
        if (!ok) return row;
      }
      let cur = implementations.reduce(
        row,
        Object.freeze({ target: arrow.target, guard: arrow.guard, reduce: arrow.reduce }),
        event,
        false
      );
      let automatic = 0;
      while (true) {
        const curDecl = chart.states[cur.phase];
        const alwaysList = (curDecl && curDecl.always) || [];
        let matched = null;
        for (const cand of alwaysList) {
          if (cand.guard !== undefined) {
            const ok = implementations.guard(cur, cand.guard, event, true);
            if (typeof ok !== "boolean") fail("guard must return a boolean");
            if (!ok) continue;
          }
          matched = cand;
          break;
        }
        if (!matched) break;
        if (automatic++ >= 100) fail("automatic transitions did not settle");
        cur = implementations.reduce(
          cur,
          Object.freeze({ target: matched.target, guard: matched.guard, reduce: matched.reduce }),
          event,
          true
        );
      }
      return cur;
    };
  }

  function resolveNativeImageUrl(rawSrc, origin) {
    const trimmed = String(rawSrc || "").trim();
    if (!trimmed) return BLANK_SVG_DATA_URI;
    if (trimmed.startsWith("data:image/svg+xml")) {
      const utf8Prefix = "data:image/svg+xml;utf8,";
      if (trimmed.startsWith(utf8Prefix)) {
        const payload = trimmed.slice(utf8Prefix.length);
        if (payload.includes("<") || payload.includes("#") || payload.includes('"')) {
          return utf8Prefix + payload
            .replace(/%/g, "%25")
            .replace(/#/g, "%23")
            .replace(/</g, "%3C")
            .replace(/>/g, "%3E")
            .replace(/"/g, "%22");
        }
      }
      return trimmed;
    }
    if (trimmed.startsWith("data:") || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
      return trimmed;
    }
    const cleanOrigin = String(origin || "https://snapcards.fun").replace(/\\/+$/, "");
    return trimmed.startsWith("/") ? (cleanOrigin + trimmed) : (cleanOrigin + "/" + trimmed);
  }

  const sql = typeof __omnishellStorage !== "undefined" && __omnishellStorage ? __omnishellStorage.sql : null;
  const origin = typeof __omnishellOrigin === "string" && __omnishellOrigin ? __omnishellOrigin : "https://snapcards.fun";

  sql.exec("CREATE TABLE IF NOT EXISTS mecha_shape_row (shape_id TEXT NOT NULL, subject TEXT NOT NULL, row_key TEXT NOT NULL, row_json TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE (shape_id, subject, row_key));");

  let importMap = {};
  (function loadImportMap() {
    const entryRows = sql.query("SELECT body FROM omnishell_http_cache WHERE cache_name = 'pronto-entries-v1' AND pathname = '/' LIMIT 1;");
    if (entryRows && entryRows.length > 0 && entryRows[0].body) {
      const m = /<script\\b[^>]*\\bid=["']pronto-assets["'][^>]*>([\\s\\S]*?)<\\/script>/i.exec(entryRows[0].body);
      if (m && m[1]) {
        const parsed = JSON.parse(m[1]);
        if (parsed && parsed.imports) importMap = parsed.imports;
      }
    }
  })();

  function readCachedAsset(logicalPath) {
    const norm = logicalPath.startsWith("/") ? logicalPath : ("/" + logicalPath);
    const mapped = importMap[norm] || norm;
    let rows = sql.query("SELECT body FROM omnishell_http_cache WHERE pathname = ? LIMIT 1;", [mapped]);
    if ((!rows || rows.length === 0) && mapped !== norm) {
      rows = sql.query("SELECT body FROM omnishell_http_cache WHERE pathname = ? LIMIT 1;", [norm]);
    }
    if (!rows || rows.length === 0) {
      const suffix = "%" + norm.split("/").pop();
      rows = sql.query("SELECT body FROM omnishell_http_cache WHERE pathname LIKE ? LIMIT 1;", [suffix]);
    }
    return rows && rows.length > 0 ? String(rows[0].body) : null;
  }

  const shellRaw = readCachedAsset("/shell/shell.json");
  if (!shellRaw) throw new Error("Missing /shell/shell.json in omnishell_http_cache");
  const shell = JSON.parse(shellRaw);

  const entityPks = {};
  const serverEntities = new Set(Object.keys(shell.access || {}));
  if (shell.schema && typeof shell.schema === "object") {
    for (const [tName, tSpec] of Object.entries(shell.schema)) {
      const fields = (tSpec && tSpec.fields) || [];
      const pkField = fields.find((f) => f.pk) || fields[0];
      entityPks[tName] = (pkField && pkField.name) || "id";
      if (tSpec && (tSpec.durability === "live" || tSpec.durability === "offline" || tSpec.durability === "server")) {
        serverEntities.add(tName);
      }
    }
  }
  entityPks.deck_stats = entityPks.deck_stats || "deck_id";

  function readTable(tableName) {
    const rows = sql.query("SELECT row_json FROM mecha_shape_row WHERE shape_id = ? ORDER BY seq ASC;", [tableName]);
    const isServer = serverEntities.has(tableName);
    const out = [];
    for (const r of rows || []) {
      if (r && r.row_json) {
        const parsed = JSON.parse(r.row_json);
        if (isServer && parsed && typeof parsed === "object" && (parsed.txid === undefined || parsed.txid === null || parsed.txid === "")) {
          parsed.txid = "1";
        }
        out.push(parsed);
      }
    }
    return out;
  }

  function writeRow(tableName, rowKey, rowObj, subject) {
    sql.exec(
      "INSERT INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES (?, ?, ?, ?) ON CONFLICT(shape_id, subject, row_key) DO UPDATE SET row_json = excluded.row_json;",
      [tableName, subject || "", String(rowKey), JSON.stringify(rowObj)]
    );
  }

  function deleteRow(tableName, rowKey) {
    sql.exec("DELETE FROM mecha_shape_row WHERE shape_id = ? AND row_key = ?;", [tableName, String(rowKey)]);
  }

  function randomHex(len) {
    let s = "";
    for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function randomUuid() {
    return randomHex(8) + "-" + randomHex(4) + "-4" + randomHex(3) + "-" +
      (["8", "9", "a", "b"][Math.floor(Math.random() * 4)]) + randomHex(3) + "-" + randomHex(12);
  }

  // Seed declared local rows (e.g. play_session, print_config, device) on first boot if absent.
  if (shell.seed && typeof shell.seed === "object") {
    for (const [tableName, seedRows] of Object.entries(shell.seed)) {
      if (!Array.isArray(seedRows)) continue;
      const existing = readTable(tableName);
      if (existing.length === 0) {
        const pk = entityPks[tableName] || "id";
        for (const r of seedRows) {
          const rk = r[pk] || "default";
          writeRow(tableName, rk, r, "");
        }
      }
    }
  }
  const bootDevice = readTable("device")[0];
  if (!bootDevice || !/^[0-9a-f]{16}$/.test(String(bootDevice.key || ""))) {
    writeRow("device", "device", Object.assign({ id: "device", theme: "auto", locale: "" }, bootDevice || {}, { key: randomHex(16) }), "");
  }

  const handlerCache = new Map();
  function getHandler(handlerName) {
    if (handlerCache.has(handlerName)) return handlerCache.get(handlerName);
    const raw = readCachedAsset("/shell/handlers/" + handlerName + ".js");
    if (!raw) throw new Error("Missing handler in cache: " + handlerName);
    const stripped = raw.replace(/^\\s*(?:\\/\\/[^\\n]*\\n\\s*)*/, "");
    let body;
    if (stripped.startsWith("(")) {
      body = "return " + stripped;
    } else {
      const idx = raw.lastIndexOf("\\n({");
      if (idx === -1) throw new Error("Unsupported handler format: " + handlerName);
      body = raw.slice(0, idx + 1) + "return " + raw.slice(idx + 1);
    }
    const fn = new Function("Statechart", "harden", body)(Statechart, harden);
    handlerCache.set(handlerName, fn);
    return fn;
  }

  const messagesCache = new Map();
  function loadMessages(loc) {
    const clean = String(loc || shell.i18n?.default || "pt").toLowerCase().split(/[-_]/)[0];
    if (messagesCache.has(clean)) return messagesCache.get(clean);
    const raw = readCachedAsset("/messages/" + clean + ".json") || readCachedAsset("/messages/" + (shell.i18n?.default || "pt") + ".json");
    const parsed = raw ? JSON.parse(raw) : {};
    messagesCache.set(clean, parsed);
    return parsed;
  }

  const bundledScreenCache = new Map();
  function loadBundledScreen(screenName) {
    if (bundledScreenCache.has(screenName)) return bundledScreenCache.get(screenName);
    if (typeof __readBundledScreenDivKit !== "function") {
      throw new Error("__readBundledScreenDivKit native binding is not registered");
    }
    const raw = __readBundledScreenDivKit(screenName);
    if (!raw) throw new Error("Missing bundled screen DivKit JSON for: " + screenName);
    const parsed = JSON.parse(raw);
    bundledScreenCache.set(screenName, parsed);
    return parsed;
  }

  const PLACEHOLDER_RE = /\\{([a-zA-Z0-9_.\\[\\]]+)\\}/g;
  function lookupPath(expr, scope, params, messages) {
    if (expr.startsWith("msg.")) {
      const key = expr.slice(4);
      return messages && ownProp(messages, key) ? messages[key] : key;
    }
    if (expr.startsWith("param.")) {
      const key = expr.slice(6);
      return params && ownProp(params, key) ? params[key] : "";
    }
    if (expr === "now") return new Date().toISOString();
    if (scope && ownProp(scope, expr)) return scope[expr];
    const parts = expr.split(".");
    let cur = scope;
    for (const seg of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function ownProp(obj, key) {
    return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function interpolate(raw, scope, params, messages) {
    if (typeof raw !== "string") return "";
    const norm = raw.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
    return norm.replace(PLACEHOLDER_RE, (_, expr) => {
      const val = lookupPath(expr, scope, params, messages);
      return val === undefined || val === null ? "" : String(val);
    });
  }

  function matchesClause(row, col, opExpr) {
    const rowVal = row[col];
    if (opExpr === "is.null") return rowVal === null || rowVal === undefined || rowVal === "";
    if (opExpr === "not.is.null") return rowVal !== null && rowVal !== undefined && rowVal !== "";
    const dotIdx = opExpr.indexOf(".");
    if (dotIdx === -1) return true;
    const op = opExpr.slice(0, dotIdx);
    const target = decodeURIComponent(opExpr.slice(dotIdx + 1));
    if (op === "eq") return String(rowVal ?? "") === target;
    if (op === "neq") return String(rowVal ?? "") !== target;
    if (op === "gt") return Number(rowVal) > Number(target);
    if (op === "lt") return Number(rowVal) < Number(target);
    if (op === "in") {
      const allowed = target.replace(/^\\(/, "").replace(/\\)$/, "").split(",").map((s) => s.trim());
      return allowed.includes(String(rowVal ?? ""));
    }
    if (op === "ilike" || op === "like") {
      const ci = op === "ilike";
      const hay = ci ? String(rowVal ?? "").toLowerCase() : String(rowVal ?? "");
      const needle = (ci ? target.toLowerCase() : target)
        .replace(/[.+?^$\${}()|[\\]\\\\]/g, "\\\\$&")
        .replace(/[*%]/g, ".*");
      return new RegExp("^" + needle + "$").test(hay);
    }
    return true;
  }

  function queryRows(tables, tableName, filterTpl, orderSpec, scope, params, messages) {
    const source = tables[tableName] || (tables[tableName] = readTable(tableName));
    let limit;
    const clauses = [];
    if (filterTpl) {
      const resolved = interpolate(filterTpl.replace(/&amp;/g, "&"), scope, params, messages);
      for (const part of resolved.split("&")) {
        if (!part) continue;
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) continue;
        const key = part.slice(0, eqIdx);
        const val = part.slice(eqIdx + 1);
        if (key === "limit") {
          const n = Number(val);
          if (Number.isFinite(n) && n >= 0) limit = n;
        } else if (key === "order") {
          orderSpec = orderSpec || val;
        } else if (key !== "select") {
          clauses.push({ col: key, opExpr: val });
        }
      }
    }
    let out = source.filter((r) => clauses.every((c) => matchesClause(r, c.col, c.opExpr)));
    if (orderSpec) {
      const specs = orderSpec.split(",").map((p) => {
        const [col, dir] = p.trim().split(".");
        return { col, desc: dir === "desc" };
      });
      out = out.slice().sort((a, b) => {
        for (const s of specs) {
          const av = a[s.col];
          const bv = b[s.col];
          if (av === bv) continue;
          if (typeof av === "number" && typeof bv === "number") return s.desc ? bv - av : av - bv;
          const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
          if (cmp !== 0) return s.desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  function loadAllTables() {
    const names = sql.query("SELECT DISTINCT shape_id FROM mecha_shape_row;");
    const map = {};
    for (const r of names || []) {
      if (r && r.shape_id) map[r.shape_id] = readTable(r.shape_id);
    }
    return map;
  }

  const pendingServerOps = [];
  let flushServerOpsFn = null;

  function applyUpdates(updates, defaultEntity) {
    if (!Array.isArray(updates) || updates.length === 0) return false;
    let changed = false;
    for (const upd of updates) {
      if (!upd) continue;
      const entity = upd.entity || defaultEntity || "play_session";
      const pk = entityPks[entity] || "id";
      const rowId = upd.id ?? (upd.row && upd.row[pk]) ?? "session";
      const isServer = serverEntities.has(entity);
      if (upd.op === "delete") {
        deleteRow(entity, rowId);
        changed = true;
        if (isServer) pendingServerOps.push({ op: "delete", entity, pk, rowId });
      } else if (upd.op === "patch") {
        const existing = readTable(entity).find((r) => String(r[pk]) === String(rowId));
        if (upd.ifTxid && existing && String(existing.txid || "") !== String(upd.ifTxid)) {
          continue;
        }
        const base = existing || upd.absent || { [pk]: rowId };
        const merged = Object.assign({}, base, upd.row || {}, { [pk]: rowId });
        if (isServer && !merged.txid) merged.txid = "1";
        writeRow(entity, rowId, merged, "");
        changed = true;
        if (isServer) {
          pendingServerOps.push({
            op: "patch",
            entity,
            pk,
            rowId,
            ifTxid: upd.ifTxid ? String(upd.ifTxid) : undefined,
            changes: Object.assign({}, upd.row || {}),
            fullRow: merged
          });
        }
      } else if (upd.op === "put" || upd.op === "upsert" || upd.row) {
        const existing = readTable(entity).find((r) => String(r[pk]) === String(rowId));
        const nextRow = upd.op === "put" && !existing && upd.absent
          ? Object.assign({}, upd.absent, upd.row || {}, { [pk]: rowId })
          : Object.assign({}, existing || {}, upd.row || {}, { [pk]: rowId });
        if (isServer && !nextRow.txid) nextRow.txid = "1";
        writeRow(entity, rowId, nextRow, "");
        changed = true;
        if (isServer) {
          pendingServerOps.push({
            op: "upsert",
            entity,
            pk,
            rowId,
            fullRow: nextRow
          });
        }
      }
    }
    if (pendingServerOps.length > 0 && typeof flushServerOpsFn === "function") {
      flushServerOpsFn();
    }
    return changed;
  }

  const initialRoute = (shell.routes && shell.routes[0] && shell.routes[0].screen) || "cards";
  let state = {
    screen: initialRoute,
    params: {},
    locale: (shell.i18n && shell.i18n.default) || "pt",
    viewportWidthDp: 390,
    systemColorScheme: "light",
    categoryFilter: "all",
    variables: {}
  };

  function buildHandlerContext(tables, foldSpec, parentRow) {
    const rows = {};
    const hasExplicitReads = Boolean(foldSpec && Array.isArray(foldSpec.reads) && foldSpec.reads.length > 0);
    const readList = hasExplicitReads
      ? foldSpec.reads
      : Array.from(new Set([...Object.keys(shell.schema || {}), ...Object.keys(tables)]));
    for (const rName of readList) {
      rows[rName] = tables[rName] || (tables[rName] = readTable(rName));
    }
    const devRow = (tables.device && tables.device[0]) || readTable("device")[0] || { id: "device", key: "" };
    const foldScope = Object.assign({ device: devRow }, parentRow || {});
    const msgs = loadMessages(state.locale);
    if (foldSpec && foldSpec.namedReads) {
      for (const [alias, specStr] of Object.entries(foldSpec.namedReads)) {
        const qIdx = specStr.indexOf("?");
        const tName = qIdx === -1 ? specStr : specStr.slice(0, qIdx);
        const fStr = qIdx === -1 ? undefined : specStr.slice(qIdx + 1);
        rows[alias] = queryRows(tables, tName, fStr, undefined, foldScope, state.params, msgs);
      }
    }
    const items = foldSpec && foldSpec.table
      ? queryRows(tables, foldSpec.table, foldSpec.filter, undefined, foldScope, state.params, msgs)
      : (tables.play_session || readTable("play_session"));
    return {
      locale: state.locale,
      ui: { locale: state.locale },
      ssr: false,
      params: Object.assign({}, state.params),
      rows,
      reads: rows,
      items
    };
  }

  function runContinuationChain(fn, foldSpec, parentRow, firstThen, defaultEntity) {
    let nextThen = firstThen;
    let mutated = false;
    let navigated = false;
    for (let step = 0; step < 8 && nextThen && nextThen.type; step++) {
      if (nextThen.type === "intent:navigate" && nextThen.with && nextThen.with.route) {
        state.screen = nextThen.with.route;
        state.params = Object.assign({}, nextThen.with.params || {});
        state.variables.flipped = "no";
        navigated = true;
        break;
      }
      const ev = { type: nextThen.type };
      if (nextThen.from) ev.from = nextThen.from;
      if (nextThen.with !== undefined) ev.with = nextThen.with;
      if (nextThen.seed === true) ev.seed = Math.floor(Math.random() * 0x100000000);
      if (nextThen.uuid === true) ev.uuid = randomUuid();
      const tables = loadAllTables();
      for (const rName of (foldSpec && foldSpec.reads) || []) {
        if (!tables[rName]) tables[rName] = [];
      }
      const ctx = buildHandlerContext(tables, foldSpec, parentRow);
      const followRes = fn({ context: ctx, event: ev });
      if (followRes && Array.isArray(followRes.updates) && followRes.updates.length > 0) {
        if (applyUpdates(followRes.updates, defaultEntity)) mutated = true;
      }
      nextThen = followRes && followRes.then ? followRes.then : null;
    }
    return { mutated, navigated };
  }

  function runScreenFolds() {
    for (let pass = 0; pass < 6; pass++) {
      const tpl = loadBundledScreen(state.screen);
      const meta = (tpl.card && tpl.card.omnishell_meta) || {};
      const folds = meta.folds || [];
      let navigated = false;
      let anyMutated = false;
      for (const fold of folds) {
        if (!fold.handler) continue;
        const fn = getHandler(fold.handler);
        const tables = loadAllTables();
        for (const rName of fold.reads || []) {
          if (!tables[rName]) tables[rName] = [];
        }
        let parentRows = [null];
        if (fold.parentTable) {
          const devRow = (tables.device && tables.device[0]) || readTable("device")[0] || { id: "device", key: "" };
          const msgs = loadMessages(state.locale);
          const matchedParents = queryRows(tables, fold.parentTable, fold.parentFilter, undefined, { device: devRow }, state.params, msgs);
          if (matchedParents.length === 0) {
            if (fold.parentEmptyRow) {
              const resolvedParent = {};
              for (const [ek, ev] of Object.entries(fold.parentEmptyRow)) {
                resolvedParent[ek] = typeof ev === "string" ? interpolate(ev, { device: devRow }, state.params, msgs) : ev;
              }
              parentRows = [resolvedParent];
            } else {
              continue;
            }
          } else {
            parentRows = matchedParents;
          }
        }
        for (const parentRow of parentRows) {
          const freshTables = parentRow ? loadAllTables() : tables;
          for (const rName of fold.reads || []) {
            if (!freshTables[rName]) freshTables[rName] = [];
          }
          const ctx = buildHandlerContext(freshTables, fold, parentRow);
          if (fold.table === "play_session" && (!ctx.items || ctx.items.length === 0)) {
            ctx.items = [{ id: "session", set_id: state.params.deck || "", card_index: 0, flipped: "no", mastered: 0, total: 5, status: "playing", finished: "", front: "", back: "", hint: "", emoji: "" }];
          }
          const res = fn({ context: ctx, event: { type: "mutation", from: fold.id || "", visit: pass === 0 } });
          if (res && Array.isArray(res.updates) && res.updates.length > 0) {
            if (applyUpdates(res.updates, fold.table)) anyMutated = true;
          }
          if (res && res.then) {
            const chainOut = runContinuationChain(fn, fold, parentRow, res.then, fold.table);
            if (chainOut.mutated) anyMutated = true;
            if (chainOut.navigated) {
              navigated = true;
              break;
            }
          }
        }
        if (navigated) break;
      }
      if (!navigated && !anyMutated) break;
    }
  }

  function isOwnedByMe(tables, ownerId) {
    if (!ownerId || typeof ownerId !== "string") return false;
    return (tables.me || []).some((r) => String(r.id) === ownerId);
  }

  function isDeckFavorited(tables, deckId) {
    if (!deckId || typeof deckId !== "string") return false;
    return (tables.favorite || []).some(
      (r) => String(r.deck_id || r.article_id || "") === deckId && !r.deleted_at
    );
  }

  function matchesCategoryFilter(row, catFilter) {
    if (!catFilter || catFilter === "all") return true;
    const cat = String(row.category || "").toLowerCase();
    const emoji = String(row.cover_emoji || "");
    if (catFilter === "Animals") return cat.includes("anim") || cat.includes("fauna") || emoji === "🦫" || emoji === "🦜" || emoji === "🐾";
    if (catFilter === "Fruits") return cat.includes("frut") || cat.includes("fruit") || cat.includes("aliment") || emoji === "🍍" || emoji === "🥭";
    if (catFilter === "Words") return cat.includes("palavr") || cat.includes("word") || cat.includes("cotid") || cat.includes("alfabet");
    return true;
  }

  function unwrapInnerScreenRoot(div) {
    if (!div || typeof div !== "object") return div;
    if (div.id === "omnishell_phone_shell" || div.id === "omnishell_tablet_shell") {
      const panes = div.items || [];
      for (const pane of panes) {
        if (pane && (pane.id === "omnishell_phone_scroll" || pane.id === "omnishell_tablet_main") && Array.isArray(pane.items) && pane.items[0]) {
          return pane.items[0];
        }
      }
    }
    return div;
  }

  function buildResponsiveShell(screenName, innerRoot, meta, theme, direction, messages) {
    const rawEntries = (meta && Array.isArray(meta.nav_entries) && meta.nav_entries.length > 0)
      ? meta.nav_entries
      : [
          { screen: "cards", label: "Cards", key: "nav_cards", icon: "🏠" },
          { screen: "generate", label: "Create", key: "nav_generate", icon: "✨" },
          { screen: "print", label: "Print", key: "nav_print", icon: "🖨️" }
        ];
    const entries = rawEntries.map((e) => Object.assign({}, e, {
      label: (e.key && messages && messages[e.key]) ? messages[e.key] : e.label
    }));
    const isStudy = screenName === "card" || screenName === "explore" || screenName === "deck";

    function makeNavBtn(entry, idx, isActive, isPhoneBar) {
      const qs = ["screen=" + encodeURIComponent(entry.screen)];
      for (const [k, v] of Object.entries(entry.params || {})) {
        qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      }
      return Object.assign(
        {
          type: "text",
          id: "nav_item_" + entry.screen + "_" + idx,
          text: entry.icon ? (entry.icon + " " + entry.label) : entry.label,
          font_size: 13,
          font_weight: isActive ? "bold" : "medium",
          font_family: "sans-serif",
          text_color: isActive ? "#181D25" : theme.secondary,
          text_alignment_horizontal: direction === "rtl" && !isPhoneBar ? "right" : "center",
          text_alignment_vertical: "center",
          border: { corner_radius: 10 },
          actions: [{ log_id: "nav_" + entry.screen + "_" + idx, url: "pronto://event/NAVIGATE?" + qs.join("&") }]
        },
        isPhoneBar
          ? { width: { type: "match_parent", weight: 1 }, height: { type: "fixed", value: 44 } }
          : { paddings: { left: 8, right: 8, top: 10, bottom: 10 } },
        isActive ? { background: [{ type: "solid", color: "#F59E0B" }] } : {}
      );
    }

    if (state.viewportWidthDp >= 768) {
      const railItems = entries.map((e, i) =>
        makeNavBtn(e, i, (e.screen === screenName || (isStudy && e.screen === "cards")) && !(e.params && e.params.shelf), false)
      );
      railItems.push({
        type: "text",
        id: "omnishell_rail_account",
        text: "👤",
        font_size: 15,
        font_weight: "bold",
        font_family: "sans-serif",
        text_color: theme.primary,
        text_alignment_horizontal: "center",
        paddings: { left: 8, right: 8, top: 10, bottom: 10 },
        actions: [
          { log_id: "rail_open_account", url: "pronto://event/COMMAND?handler=play_select&command=open-login&id=btn-top-login" },
          { log_id: "rail_open_account_var", url: "div-action://set_variable?name=modal_login_state&value=open" }
        ]
      });
      const navRail = {
        type: "container",
        id: "omnishell_tablet_nav_rail",
        orientation: "vertical",
        width: { type: "fixed", value: 88 },
        height: { type: "match_parent" },
        paddings: { left: 6, right: 6, top: 12, bottom: 12 },
        item_spacing: 6,
        background: [{ type: "solid", color: theme.neutral }],
        items: railItems
      };
      const mainPane = {
        type: "gallery",
        id: "omnishell_tablet_main",
        orientation: "vertical",
        width: { type: "match_parent" },
        height: { type: "match_parent" },
        paddings: { left: 20, right: 20, top: 16, bottom: 28 },
        items: [innerRoot]
      };
      return {
        type: "container",
        id: "omnishell_tablet_shell",
        orientation: "horizontal",
        width: { type: "match_parent" },
        height: { type: "match_parent" },
        background: [{ type: "solid", color: theme.neutral }],
        items: direction === "rtl" ? [mainPane, navRail] : [navRail, mainPane]
      };
    }

    const primaryScreens = new Set(["cards", "generate", "print"]);
    const phoneEntries = entries.filter((e) => primaryScreens.has(e.screen) && (!e.params || Object.keys(e.params).length === 0));
    const barItems = phoneEntries.map((e, i) =>
      makeNavBtn(e, i, e.screen === screenName || (isStudy && e.screen === "cards"), true)
    );
    barItems.push({
      type: "text",
      id: "omnishell_avatar_sheet_trigger",
      text: "👤",
      font_size: 16,
      font_weight: "bold",
      font_family: "sans-serif",
      text_color: theme.primary,
      text_alignment_horizontal: "center",
      text_alignment_vertical: "center",
      width: { type: "fixed", value: 46 },
      height: { type: "fixed", value: 44 },
      background: [{ type: "solid", color: theme.surfaceMuted }],
      border: { corner_radius: 12, stroke: { color: theme.border, width: 1 } },
      actions: [
        { log_id: "phone_open_avatar_sheet", url: "pronto://event/COMMAND?handler=play_select&command=open-login&id=btn-top-login" },
        { log_id: "phone_open_avatar_var", url: "div-action://set_variable?name=modal_login_state&value=open" }
      ]
    });
    const topBar = {
      type: "container",
      id: "omnishell_phone_nav_bar",
      orientation: "horizontal",
      width: { type: "match_parent" },
      height: { type: "fixed", value: 64 },
      paddings: { left: 10, right: 10, top: 8, bottom: 8 },
      item_spacing: 6,
      content_alignment_vertical: "center",
      background: [{ type: "solid", color: theme.surface }],
      border: { stroke: { color: theme.border, width: 1 } },
      items: direction === "rtl" ? barItems.slice().reverse() : barItems
    };
    const bodyScroll = {
      type: "gallery",
      id: "omnishell_phone_scroll",
      orientation: "vertical",
      width: { type: "match_parent" },
      height: { type: "match_parent" },
      paddings: { left: 14, right: 14, top: 12, bottom: 32 },
      item_spacing: 12,
      items: [innerRoot]
    };
    return {
      type: "container",
      id: "omnishell_phone_shell",
      orientation: "vertical",
      width: { type: "match_parent" },
      height: { type: "match_parent" },
      background: [{ type: "solid", color: theme.neutral }],
      items: [topBar, bodyScroll]
    };
  }

  function renderActiveScreen() {
    const rawDoc = loadBundledScreen(state.screen);
    const cardTemplate = JSON.parse(JSON.stringify(rawDoc.card));
    const meta = cardTemplate.omnishell_meta || {};
    const tables = loadAllTables();
    const messages = loadMessages(state.locale);
    const direction = directionOfLocale(state.locale);

    const deviceRow = (tables.device || [])[0] || { id: "device", theme: "auto" };
    const rawTheme = state.variables.theme || state.variables.theme_mode || deviceRow.theme || "auto";
    const themeMode = rawTheme === "dark" ? "dark" : rawTheme === "light" ? "light" : "auto";
    const resolvedScheme = themeMode === "dark" ? "dark" : themeMode === "light" ? "light" : (state.systemColorScheme === "dark" ? "dark" : "light");
    const palettes = meta.palettes || {};
    const lightTheme = palettes.light || { primary: "#181D25", secondary: "#475569", accent: "#0F766E", danger: "#B91C1C", neutral: "#F3EFEA", surface: "#FFFFFF", border: "#E2E8F0", surfaceMuted: "#F8FAFC" };
    const darkTheme = palettes.dark || { primary: "#F8FAFC", secondary: "#94A3B8", accent: "#14B8A6", danger: "#EF4444", neutral: "#090E17", surface: "#111827", border: "#1F2937", surfaceMuted: "#1A2234" };
    const theme = resolvedScheme === "dark" ? darkTheme : lightTheme;
    const colorSwap = {};
    if (resolvedScheme === "dark") {
      for (const k of Object.keys(lightTheme)) {
        if (typeof lightTheme[k] === "string" && lightTheme[k].startsWith("#") && typeof darkTheme[k] === "string") {
          colorSwap[lightTheme[k].toUpperCase()] = darkTheme[k];
        }
      }
    }

    const varsMap = new Map();
    for (const v of cardTemplate.variables || []) {
      varsMap.set(v.name, { name: v.name, type: v.type, value: ownProp(state.variables, v.name) ? state.variables[v.name] : v.value });
    }
    function setCardVar(name, type, val) {
      const clean = sanitizeVarName(name);
      if (!varsMap.has(clean)) {
        varsMap.set(clean, { name: clean, type, value: val });
      } else {
        varsMap.get(clean).value = val;
      }
      return clean;
    }

    const sessionRow = (tables.play_session || []).find((r) => r.id === "session") || (tables.play_session || [])[0];
    if (sessionRow) {
      if (typeof sessionRow.status === "string" && !ownProp(state.variables, "status")) {
        setCardVar("status", "string", sessionRow.status);
      }
      if (typeof sessionRow.flipped === "string") {
        setCardVar("flipped", "string", ownProp(state.variables, "flipped") ? state.variables.flipped : sessionRow.flipped);
      }
      setCardVar("translation_failed_topic", "string", String(sessionRow.translation_failed_topic || ""));
    }
    setCardVar("author_filter", "string", String(state.params.shelf || ""));
    setCardVar("theme_mode", "string", themeMode);
    setCardVar("resolved_theme", "string", resolvedScheme);
    setCardVar("layout_direction", "string", direction);
    setCardVar("form_factor", "string", state.viewportWidthDp >= 768 ? "tablet" : "phone");

    const printCfg = (tables.print_config || [])[0];
    const activeDeckId = state.params.deck || (state.screen === "print" && printCfg && printCfg.set_id ? printCfg.set_id : (sessionRow && sessionRow.set_id ? sessionRow.set_id : ""));
    if (state.screen === "print") {
      setCardVar("active_deck_id", "string", String(activeDeckId || ""));
    }
    if (activeDeckId) {
      const deckRow = (tables.card_set || []).find((d) => d.id === activeDeckId) || (tables.localized_deck || []).find((d) => d.id === activeDeckId);
      setCardVar("is_owned_deck", "boolean", Boolean(deckRow && isOwnedByMe(tables, deckRow.owner)));
      const deckCards = (tables.flashcard || []).filter((c) => c.set_id === activeDeckId);
      setCardVar("deck_card_count", "integer", deckCards.length);
      if (state.screen === "deck") setCardVar("deck_is_empty", "boolean", deckCards.length === 0);
    }

    function swapColorsInNode(divObj) {
      if (resolvedScheme !== "dark" || !divObj) return;
      if (typeof divObj.text_color === "string") {
        const mapped = colorSwap[divObj.text_color.toUpperCase()];
        if (mapped) divObj.text_color = mapped;
      }
      if (Array.isArray(divObj.background)) {
        for (const bg of divObj.background) {
          if (bg && typeof bg.color === "string") {
            const mapped = colorSwap[bg.color.toUpperCase()];
            if (mapped) bg.color = mapped;
          }
        }
      }
      if (divObj.border && divObj.border.stroke && typeof divObj.border.stroke.color === "string") {
        const mapped = colorSwap[divObj.border.stroke.color.toUpperCase()];
        if (mapped) divObj.border.stroke.color = mapped;
      }
    }

    function expandDiv(node, parentScope, suffix, insideRepeater) {
      if (!node || typeof node !== "object") return null;
      const ext = node.extension_props || {};
      const cls = new Set(Array.isArray(ext.classes) ? ext.classes : []);

      if (state.viewportWidthDp < 768) {
        if (
          cls.has("top-bar-breadcrumb") ||
          cls.has("search-kbd") ||
          cls.has("btn-top-new") ||
          cls.has("btn-top-print") ||
          cls.has("btn-top-login") ||
          cls.has("filter-badges") ||
          cls.has("hero-meta")
        ) {
          return null;
        }
      }

      if (cls.has("translation-error") && !(sessionRow && String(sessionRow.translation_failed_topic || "").endsWith("|" + state.locale))) {
        return null;
      }

      if (insideRepeater) {
        if (cls.has("translation-pending") && !(String(parentScope.topic || "").includes("[TRANSLATE:") && String(parentScope.locale || "") === state.locale)) {
          return null;
        }
        const rowOwned = isOwnedByMe(tables, parentScope.owner);
        const rowFav = isDeckFavorited(tables, parentScope.id);
        if (cls.has("card-set-item") && state.params.shelf === "mine" && !rowOwned) return null;
        if (cls.has("btn-delete-deck") && !rowOwned) return null;
        if (cls.has("when-unset") && rowFav) return null;
        if (cls.has("when-set") && !rowFav) return null;
      }

      let scope = parentScope;
      let repeaterRows = null;
      if (ext.data_live) {
        let matched = queryRows(tables, ext.data_live, ext.data_filter, ext.data_order, parentScope, state.params, messages);
        if (ext.data_live === "localized_deck" && state.screen === "cards" && state.categoryFilter !== "all") {
          matched = matched.filter((r) => matchesCategoryFilter(r, state.categoryFilter));
        }
        if (ext.repeater) {
          if (matched.length === 0 && ext.data_empty_row) {
            const resolvedEmpty = {};
            for (const [ek, ev] of Object.entries(ext.data_empty_row)) {
              resolvedEmpty[ek] = typeof ev === "string" ? interpolate(ev, parentScope, state.params, messages) : ev;
            }
            repeaterRows = [resolvedEmpty];
          } else {
            repeaterRows = matched;
          }
        } else {
          let single = matched[0];
          if (!single && ext.data_empty_row) {
            single = {};
            for (const [ek, ev] of Object.entries(ext.data_empty_row)) {
              single[ek] = typeof ev === "string" ? interpolate(ev, parentScope, state.params, messages) : ev;
            }
          }
          if (single) {
            scope = Object.assign({}, parentScope, single, { [ext.data_live]: single });
          }
        }
      }

      const out = Object.assign({}, node);
      delete out.extension_props;
      if (suffix && typeof out.id === "string") {
        out.id = out.id + "__" + suffix;
      }
      if (suffix && typeof out.div_id === "string") {
        out.div_id = out.div_id + "__" + suffix;
      }

      if (insideRepeater && out.visibility && String(out.visibility).startsWith("@{is_favorited")) {
        delete out.visibility;
      }
      if (insideRepeater && out.visibility && String(out.visibility).startsWith("@{is_owned_deck")) {
        delete out.visibility;
      }

      if (out.type === "image") {
        const rawImgSrc = ext.data_image_src || ext.image_src;
        if (rawImgSrc) {
          const resolvedSrc = interpolate(rawImgSrc, scope, state.params, messages);
          out.image_url = resolveNativeImageUrl(resolvedSrc || BLANK_SVG_DATA_URI, origin);
        }
        return out;
      }

      if (out.type === "input") {
        if (ext.raw_text) {
          out.hint_text = interpolate(ext.raw_text, scope, state.params, messages);
        }
        swapColorsInNode(out);
        return out;
      }

      if (out.type === "text") {
        if (ext.raw_text) {
          out.text = interpolate(ext.raw_text, scope, state.params, messages);
        } else if (typeof out.text === "string" && out.text.includes("{")) {
          out.text = interpolate(out.text, scope, state.params, messages);
        }
        if (cls.has("filter-pill-label")) {
          const pillActive =
            (node.id === "lbl-cat-all" && state.categoryFilter === "all") ||
            (node.id === "lbl-cat-animals" && state.categoryFilter === "Animals") ||
            (node.id === "lbl-cat-fruits" && state.categoryFilter === "Fruits") ||
            (node.id === "lbl-cat-words" && state.categoryFilter === "Words");
          if (pillActive) {
            out.background = [{ type: "solid", color: theme.accent }];
            out.text_color = "#FFFFFF";
          }
        }
        if (cls.has("mobile-shelf-tab")) {
          const curShelf = state.params.shelf || "";
          const tabActive =
            (node.id === "cards_a_84" && curShelf === "") ||
            (String(out.actions?.[0]?.url || "").includes("shelf=mine") && curShelf === "mine") ||
            (String(out.actions?.[0]?.url || "").includes("shelf=gallery") && curShelf === "gallery") ||
            (!String(out.actions?.[0]?.url || "").includes("shelf=") && curShelf === "");
          if (tabActive) {
            out.background = [{ type: "solid", color: theme.accent }];
            out.text_color = "#FFFFFF";
          }
        }
        if (cls.has("lang-link") && node.id === "lang-" + state.locale) {
          out.background = [{ type: "solid", color: theme.accent }];
          out.text_color = "#FFFFFF";
        }
      }

      if (Array.isArray(out.actions)) {
        out.actions = out.actions.map((act) => {
          const nextAct = Object.assign({}, act);
          if (suffix && typeof nextAct.log_id === "string") nextAct.log_id = nextAct.log_id + "__" + suffix;
          if (typeof nextAct.url === "string" && (nextAct.url.includes("{") || nextAct.url.includes("%7B") || nextAct.url.includes("%7b"))) {
            nextAct.url = interpolate(nextAct.url, scope, state.params, messages);
          }
          return nextAct;
        });
      }

      if (out.type === "state" && Array.isArray(out.states)) {
        out.states = out.states.map((st) => {
          if (!st || !st.div) return st;
          const expandedDiv = expandDiv(st.div, scope, suffix, insideRepeater);
          return expandedDiv ? { state_id: st.state_id, div: expandedDiv } : { state_id: st.state_id };
        });
        return out;
      }

      if (out.type === "custom") {
        if (out.custom_props && typeof out.custom_props === "object") {
          const nextProps = Object.assign({}, out.custom_props);
          if (out.custom_type === "flip-card") {
            nextProps.direction = direction;
          }
          out.custom_props = nextProps;
        }
        if (Array.isArray(out.items)) {
          out.items = out.items.map((c) => expandDiv(c, scope, suffix, insideRepeater)).filter(Boolean);
        }
        return out;
      }

      if (ext.repeater && repeaterRows !== null) {
        const countVar = "live_" + out.id + "_count";
        setCardVar(countVar, "integer", repeaterRows.length);
        const stamped = [];
        if (repeaterRows.length === 0) {
          if (ext.data_empty) {
            stamped.push({
              type: "text",
              id: out.id + "_empty",
              text: interpolate(String(ext.data_empty), scope, state.params, messages),
              font_size: 14,
              font_weight: "regular",
              font_family: "sans-serif",
              text_color: theme.secondary
            });
          }
        } else {
          const templates = Array.isArray(ext.item_templates) ? ext.item_templates : [];
          repeaterRows.forEach((row, idx) => {
            const rk = sanitizeVarName(String(row.id ?? row.deck_id ?? idx));
            const nextSuf = suffix ? (suffix + "_" + rk) : rk;
            const rowScope = Object.assign({}, scope, { _index: idx, _count: repeaterRows.length }, row);
            for (const tpl of templates) {
              const itemDiv = expandDiv(tpl, rowScope, nextSuf, true);
              if (itemDiv) stamped.push(itemDiv);
            }
          });
        }
        out.items = stamped;
        if (state.viewportWidthDp >= 768 && (cls.has("deck-grid") || cls.has("cards-grid"))) {
          out.type = "grid";
          out.column_count = 2;
          delete out.orientation;
          delete out.layout_mode;
        }
      } else if (Array.isArray(out.items)) {
        const expandedChildren = out.items.map((c) => expandDiv(c, scope, suffix, insideRepeater)).filter(Boolean);
        out.items = direction === "rtl" && out.orientation === "horizontal" ? expandedChildren.reverse() : expandedChildren;
      }

      swapColorsInNode(out);
      return out;
    }

    const rawRoot = unwrapInnerScreenRoot(cardTemplate.states[0].div);
    const expandedInner = expandDiv(rawRoot, {}, "", false) || {
      type: "container",
      id: state.screen + "_root",
      orientation: "vertical",
      items: []
    };
    const wrappedRoot = buildResponsiveShell(state.screen, expandedInner, meta, theme, direction, messages);

    return {
      card: {
        log_id: "omnishell_" + state.screen,
        variables: Array.from(varsMap.values()),
        states: [{ state_id: 0, div: wrappedRoot }]
      }
    };
  }

  function emitFullRender() {
    const card = renderActiveScreen();
    if (typeof emitUiAst === "function") {
      emitUiAst(JSON.stringify(card));
    }
  }

  function setVarInPlace(name, val) {
    const clean = sanitizeVarName(name);
    state.variables[clean] = val;
    if (typeof __emitDivVariableUpdate === "function") {
      __emitDivVariableUpdate(clean, val);
    } else {
      emitFullRender();
    }
  }

  function parseQuery(qsStr) {
    const out = {};
    if (!qsStr) return out;
    for (const part of qsStr.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq === -1) {
        out[decodeURIComponent(part)] = "";
      } else {
        const k = decodeURIComponent(part.slice(0, eq));
        const v = decodeURIComponent(part.slice(eq + 1).replace(/\\+/g, " "));
        out[k] = v;
      }
    }
    return out;
  }

  function dispatchHandlerEvent(handlerName, eventObj) {
    if (!handlerName) return false;
    const fn = getHandler(handlerName);
    const tables = loadAllTables();
    const clickFold = { reads: [], namedReads: {} };
    if (shell.access && shell.access.generation_draft) {
      clickFold.namedReads.draft_cheap = "generation_draft?id=eq.{device.key}:draft-cheap";
      clickFold.namedReads.draft_heavy = "generation_draft?id=eq.{device.key}:draft-heavy";
    }
    if (state.params.deck) {
      clickFold.namedReads.route_deck = "card_set?id=eq.{param.deck}";
      clickFold.namedReads.route_cards = "flashcard?set_id=eq.{param.deck}&order=id.asc";
    }
    const ctx = buildHandlerContext(tables, clickFold);
    if (handlerName.startsWith("play_")) {
      ctx.items = (tables.play_session || []).filter((r) => r.id === "session");
      if (ctx.items.length === 0) {
        ctx.items = [{ id: "session", set_id: state.params.deck || "", card_index: 0, flipped: "no", mastered: 0, total: 5, status: "playing", finished: "", front: "", back: "", hint: "", emoji: "" }];
      }
    } else if (handlerName === "print_select") {
      ctx.items = tables.print_config || [];
    } else if (handlerName === "create_set" || handlerName === "count-step") {
      ctx.items = tables.generation_form || [{ id: "draft", card_count: 5 }];
    }
    const res = fn({ context: ctx, event: eventObj });
    if (typeof res === "number") {
      applyUpdates([{ op: "patch", entity: "generation_form", id: "draft", row: { card_count: res } }], "generation_form");
      return true;
    }
    const defaultTarget = handlerName.startsWith("play_") ? "play_session" : "generation_form";
    let mutated = false;
    if (res && Array.isArray(res.updates) && res.updates.length > 0) {
      mutated = applyUpdates(res.updates, defaultTarget);
    }
    if (res && res.then) {
      const chainOut = runContinuationChain(fn, clickFold, null, res.then, defaultTarget);
      if (chainOut.mutated || chainOut.navigated) mutated = true;
    }
    return mutated;
  }

  function handleAction(actionUri) {
    if (!actionUri || typeof actionUri !== "string") return;

    if (actionUri.startsWith("ORDER_RECHECK:")) {
      const orderId = actionUri.slice("ORDER_RECHECK:".length).trim();
      state.screen = "print";
      state.params = Object.assign({}, state.params, { order: orderId });
      state.variables.active_order_id = orderId;
      state.variables.sheet_print_checkout_panel_state = "open";
      runScreenFolds();
      emitFullRender();
      return;
    }

    if (actionUri.startsWith("div-action://set_variable?")) {
      const q = parseQuery(actionUri.slice("div-action://set_variable?".length));
      if (q.name && q.value !== undefined) {
        state.variables[q.name] = q.value;
        if (q.name === "flipped") {
          applyUpdates([{ op: "patch", entity: "play_session", id: "session", row: { flipped: q.value } }], "play_session");
        }
        setVarInPlace(q.name, q.value);
      }
      return;
    }

    if (!actionUri.startsWith("pronto://event/")) return;

    const rest = actionUri.slice("pronto://event/".length);
    const qIdx = rest.indexOf("?");
    const action = qIdx === -1 ? rest : rest.slice(0, qIdx);
    const q = parseQuery(qIdx === -1 ? "" : rest.slice(qIdx + 1));

    if (action === "DISPLAY") {
      const nextW = q.viewport ? Number(q.viewport) : state.viewportWidthDp;
      const nextScheme = q.scheme === "dark" ? "dark" : "light";
      if (nextW !== state.viewportWidthDp || nextScheme !== state.systemColorScheme) {
        state.viewportWidthDp = nextW;
        state.systemColorScheme = nextScheme;
        emitFullRender();
      }
      return;
    }

    if (action === "DEEPLINK") {
      const rawPath = (q.path || "/").replace(/\\/+$/, "") || "/";
      const extraQs = parseQuery(q.query || "");
      const pathSegs = rawPath.split("/").filter(Boolean);
      let matchedRoute = null;
      let matchedParams = {};
      for (const route of (shell.routes || [])) {
        const rSegs = String(route.path || "/").split("/").filter(Boolean);
        const minLen = rSegs.filter((s) => !s.endsWith("?")).length;
        if (pathSegs.length < minLen || pathSegs.length > rSegs.length) continue;
        let ok = true;
        const cand = {};
        for (let i = 0; i < rSegs.length; i++) {
          const rs = rSegs[i];
          const ps = pathSegs[i];
          if (rs.startsWith(":")) {
            const paramName = rs.replace(/^:/, "").replace(/\\?$/, "");
            if (ps !== undefined) cand[paramName] = decodeURIComponent(ps);
          } else if (rs !== ps) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matchedRoute = route;
          matchedParams = cand;
          break;
        }
      }
      if (matchedRoute) {
        if (extraQs.locale) state.locale = extraQs.locale;
        state.screen = matchedRoute.screen;
        const mergedParams = Object.assign({}, matchedParams);
        for (const [k, v] of Object.entries(extraQs)) {
          if (k !== "locale" && v !== "") mergedParams[k] = v;
        }
        state.params = mergedParams;
        state.variables.flipped = "no";
        state.variables.modal_login_state = "closed";
        if (state.params.deck) {
          dispatchHandlerEvent("play_select", {
            type: "click",
            from: "deeplink",
            id: state.params.deck,
            target: { dataset: { id: state.params.deck }, closest: () => ({ dataset: { id: state.params.deck } }) }
          });
        }
        runScreenFolds();
        emitFullRender();
      }
      return;
    }

    if (action === "NAVIGATE") {
      if (q.locale) state.locale = q.locale;
      if (q.screen) {
        state.screen = q.screen;
        const nextParams = {};
        for (const [k, v] of Object.entries(q)) {
          if (k !== "screen" && k !== "locale" && v !== "") nextParams[k] = v;
        }
        state.params = nextParams;
        state.variables.flipped = "no";
        state.variables.modal_login_state = "closed";
      }
      runScreenFolds();
      emitFullRender();
      return;
    }

    if (action === "POPOVER") {
      const varName = sheetStateVarForId(q.target || "");
      const prev = state.variables[varName] || "closed";
      const nextVal = q.op === "hide" ? "closed" : q.op === "show" ? "open" : (prev === "open" ? "closed" : "open");
      setVarInPlace(varName, nextVal);
      return;
    }

    if (action === "CHART_CLICK") {
      const id = q.id || "";
      if (id === "card-flip-visual" || id === "card-flip-prompt") {
        applyUpdates([{ op: "patch", entity: "play_session", id: "session", row: { flipped: "yes" } }], "play_session");
        setVarInPlace("flipped", "yes");
        return;
      }
      if (id === "card-flip-back" || id === "card-flip-back-prompt") {
        applyUpdates([{ op: "patch", entity: "play_session", id: "session", row: { flipped: "no" } }], "play_session");
        setVarInPlace("flipped", "no");
        return;
      }
      if (id === "theme-light" || id === "theme-dark" || id === "theme-auto") {
        const nextTheme = id === "theme-dark" ? "dark" : id === "theme-light" ? "light" : "auto";
        state.variables.theme = nextTheme;
        applyUpdates([{ op: "patch", entity: "device", id: "device", row: { theme: nextTheme } }], "device");
        emitFullRender();
        return;
      }
      if (id.startsWith("lbl-cat-")) {
        state.categoryFilter =
          id === "lbl-cat-animals" ? "Animals" :
          id === "lbl-cat-fruits" ? "Fruits" :
          id === "lbl-cat-words" ? "Words" : "all";
        applyUpdates([{ op: "patch", entity: "play_session", id: "session", row: { library_query: "" } }], "play_session");
        state.variables.input_library_search = "";
        emitFullRender();
        return;
      }
      const tpl = loadBundledScreen(state.screen);
      const chartTargets = (tpl.card && tpl.card.omnishell_meta && tpl.card.omnishell_meta.chart_targets) || {};
      const ct = chartTargets[id];
      if (ct && ct.nextState !== undefined) {
        setVarInPlace(ct.field, ct.nextState);
      }
      return;
    }

    if (action === "INPUT") {
      const field = q.field || "";
      const val = q.value ?? "";
      const varKey = "input_" + sanitizeVarName(field);
      if (state.variables[varKey] === val) return;
      state.variables[varKey] = val;
      if (field === "library-search") {
        applyUpdates([{ op: "patch", entity: "play_session", id: "session", row: { library_query: val } }], "play_session");
        emitFullRender();
      } else if (state.screen === "generate" && field) {
        applyUpdates([{ op: "patch", entity: "generation_form", id: "draft", row: { [field]: val } }], "generation_form");
      }
      return;
    }

    if (action === "FAVORITE" || action === "UNFAVORITE") {
      const deckId = q.deck_id || "";
      if (deckId) {
        const isFav = action === "FAVORITE";
        writeRow("favorite", deckId, { user_id: "local-user", deck_id: deckId, deleted_at: isFav ? null : new Date().toISOString() }, "");
        const stats = readTable("deck_stats").find((s) => s.deck_id === deckId) || { deck_id: deckId, favorite_count: 0, cover: "" };
        const nextCnt = Math.max(0, Number(stats.favorite_count || 0) + (isFav ? 1 : -1));
        writeRow("deck_stats", deckId, Object.assign({}, stats, { favorite_count: nextCnt }), "");
        emitFullRender();
      }
      return;
    }

    if (action === "CLICK" || action === "COMMAND") {
      const dataset = {};
      for (const [k, v] of Object.entries(q)) {
        if (k.startsWith("data_")) {
          const rawAttr = k.slice(5);
          const camel = rawAttr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          dataset[camel] = v;
          dataset[rawAttr] = v;
        }
      }
      const ev = {
        type: "click",
        from: q.id || "",
        id: dataset.id || undefined,
        command: q.command || undefined,
        target: { dataset, closest: () => ({ dataset }) }
      };
      if (q.command === "open-login") {
        state.variables.status = "login";
        state.variables.modal_login_state = "open";
        setVarInPlace("status", "login");
        setVarInPlace("modal_login_state", "open");
        return;
      }
      if (q.command === "close-login") {
        state.variables.status = "playing";
        state.variables.modal_login_state = "closed";
        setVarInPlace("status", "playing");
        setVarInPlace("modal_login_state", "closed");
        return;
      }
      if (q.command === "fullscreen") {
        setVarInPlace("status", "fullscreen");
        return;
      }
      if (q.command === "exit-fullscreen") {
        setVarInPlace("status", "playing");
        return;
      }
      if (q.handler) {
        if (q.handler === "play_next" || q.handler === "play_prev" || q.handler === "play_restart") {
          state.variables.flipped = "no";
        }
        dispatchHandlerEvent(q.handler, ev);
        runScreenFolds();
        emitFullRender();
      }
      return;
    }

    if (action === "AUTH") {
      state.variables.status = "playing";
      state.variables.modal_login_state = "closed";
      const method = q.method || "";
      if (typeof AuthBridge !== "undefined") {
        if (method === "oidc:apple" && AuthBridge.appleSignIn) {
          AuthBridge.appleSignIn({}).then(() => emitFullRender());
        } else if (method.startsWith("oidc:") && AuthBridge.oidcStart) {
          AuthBridge.oidcStart(method.slice(5), {}).then(() => emitFullRender());
        } else if (method === "delete-account" && AuthBridge.deleteAccount) {
          AuthBridge.deleteAccount({}).then(() => emitFullRender());
        } else if (method === "signout" && AuthBridge.clearSession) {
          AuthBridge.clearSession();
        }
      }
      emitFullRender();
    }
  }

  function stripClientMeta(rowObj) {
    const clean = {};
    for (const [k, v] of Object.entries(rowObj || {})) {
      if (!k.startsWith("$") && k !== "txid" && k !== "scope_id") clean[k] = v;
    }
    return clean;
  }

  let authTokenPromise = null;
  async function getAuthToken() {
    if (typeof AuthBridge !== "undefined" && AuthBridge && typeof AuthBridge.loadSession === "function") {
      const held = AuthBridge.loadSession();
      if (held && held.token) {
        const heldUid = (held.user && held.user.id) || held.userId || "";
        if (heldUid && readTable("me").length === 0) {
          writeRow("me", heldUid, { id: heldUid, txid: "1" }, heldUid);
        }
        return held.token;
      }
    }
    if (authTokenPromise) return authTokenPromise;
    authTokenPromise = (async () => {
      try {
        const res = await fetch(origin + "/auth/guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (!res.ok) return null;
        const sess = await res.json();
        if (sess && sess.token) {
          const uid = (sess.user && sess.user.id) || sess.userId || "";
          const handle = (sess.user && sess.user.handle) || sess.handle || null;
          const isGuest = sess.user ? Boolean(sess.user.guest) : (sess.isGuest !== false);
          if (typeof AuthBridge !== "undefined" && AuthBridge && typeof AuthBridge.saveSession === "function" && uid) {
            AuthBridge.saveSession({
              token: sess.token,
              refreshToken: sess.refreshToken || null,
              userId: uid,
              handle,
              isGuest,
              expiresAtEpochS: sess.expiresAtEpochS || null
            });
          }
          if (uid) {
            writeRow("me", uid, { id: uid, txid: "1" }, uid);
          }
          return sess.token;
        }
      } catch (_) {
        // Offline or fixture network; local SQLite continues serving pre-seeded rows.
      } finally {
        authTokenPromise = null;
      }
      return null;
    })();
    return authTokenPromise;
  }

  async function authedCrudFetch(pathAndQuery, init) {
    const tok = await getAuthToken();
    const hdrs = Object.assign({ "Content-Type": "application/json" }, (init && init.headers) || {});
    if (tok) hdrs.Authorization = "Bearer " + tok;
    return fetch(origin + "/crud/" + pathAndQuery, Object.assign({}, init || {}, { headers: hdrs }));
  }

  let draftPollActive = false;
  function startDraftPollIfNeeded() {
    if (draftPollActive || typeof fetch !== "function" || typeof setTimeout !== "function") return;
    const dev = readTable("device")[0];
    const devKey = dev && dev.key ? String(dev.key) : "";
    if (!devKey) return;
    const drafts = readTable("generation_draft");
    const active = drafts.some((d) =>
      d &&
      (d.id === devKey + ":draft-cheap" || d.id === devKey + ":draft-heavy") &&
      (d.status === "drafting" || d.status === "illustrating")
    );
    const form = readTable("generation_form")[0];
    const activeSetId = form && form.set_id && (form.status === "drafting" || form.status === "illustrating")
      ? String(form.set_id)
      : "";
    if (!active && !activeSetId) return;

    draftPollActive = true;
    let attempts = 0;
    const stepPoll = async () => {
      attempts++;
      try {
        const idsFilter = "id=in.(" + encodeURIComponent(devKey + ":draft-cheap") + "," + encodeURIComponent(devKey + ":draft-heavy") + ")";
        const res = await authedCrudFetch("generation_draft?" + idsFilter);
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows)) {
            for (const r of rows) {
              if (r && r.id) writeRow("generation_draft", r.id, r, "");
            }
          }
        }
        if (activeSetId) {
          const [cardsRes, levelsRes] = await Promise.all([
            authedCrudFetch("flashcard?set_id=eq." + encodeURIComponent(activeSetId)),
            authedCrudFetch("deck_level?set_id=eq." + encodeURIComponent(activeSetId))
          ]);
          if (cardsRes.ok) {
            const cRows = await cardsRes.json();
            if (Array.isArray(cRows)) {
              for (const c of cRows) if (c && c.id) writeRow("flashcard", c.id, c, "");
            }
          }
          if (levelsRes.ok) {
            const lRows = await levelsRes.json();
            if (Array.isArray(lRows)) {
              for (const l of lRows) if (l && l.id) writeRow("deck_level", l.id, l, "");
            }
          }
        }
        runScreenFolds();
        emitFullRender();
      } catch (_) {
        // Ignore transient network hiccup during polling.
      }
      const latestDrafts = readTable("generation_draft");
      const stillRunning = latestDrafts.some((d) =>
        d &&
        (d.id === devKey + ":draft-cheap" || d.id === devKey + ":draft-heavy") &&
        (d.status === "drafting" || d.status === "illustrating")
      );
      const latestForm = readTable("generation_form")[0];
      const stillGen = Boolean(latestForm && latestForm.set_id && (latestForm.status === "drafting" || latestForm.status === "illustrating"));
      if ((stillRunning || stillGen) && attempts < 45) {
        setTimeout(stepPoll, 1000);
      } else {
        draftPollActive = false;
      }
    };
    setTimeout(stepPoll, 900);
  }

  let serverFlushChain = Promise.resolve();
  flushServerOpsFn = function() {
    if (typeof fetch !== "function" || pendingServerOps.length === 0) return;
    const batch = pendingServerOps.splice(0);
    serverFlushChain = serverFlushChain.then(async () => {
      let wroteAny = false;
      for (const item of batch) {
        try {
          if (item.op === "delete") {
            await authedCrudFetch(item.entity + "?" + item.pk + "=eq." + encodeURIComponent(item.rowId), {
              method: "DELETE",
              headers: { Prefer: "return=representation" }
            });
          } else if (item.op === "patch") {
            if (item.ifTxid === "1") {
              const upRes = await authedCrudFetch(item.entity + "?on_conflict=" + encodeURIComponent(item.pk), {
                method: "POST",
                headers: { Prefer: "return=representation,resolution=merge-duplicates" },
                body: JSON.stringify(stripClientMeta(item.fullRow))
              });
              if (upRes.ok) {
                const upRows = await upRes.json();
                if (Array.isArray(upRows) && upRows[0]) {
                  writeRow(item.entity, item.rowId, upRows[0], "");
                  wroteAny = true;
                }
              }
            } else {
              let qs = item.pk + "=eq." + encodeURIComponent(item.rowId);
              if (item.ifTxid) qs += "&txid=eq." + encodeURIComponent(item.ifTxid);
              const res = await authedCrudFetch(item.entity + "?" + qs, {
                method: "PATCH",
                headers: { Prefer: "return=representation" },
                body: JSON.stringify(stripClientMeta(item.changes))
              });
              if (res.ok) {
                const rows = await res.json();
                if (Array.isArray(rows) && rows.length > 0) {
                  writeRow(item.entity, item.rowId, rows[0], "");
                  wroteAny = true;
                } else if (item.ifTxid) {
                  const curRes = await authedCrudFetch(item.entity + "?" + item.pk + "=eq." + encodeURIComponent(item.rowId));
                  if (curRes.ok) {
                    const curRows = await curRes.json();
                    if (Array.isArray(curRows) && curRows[0]) {
                      writeRow(item.entity, item.rowId, curRows[0], "");
                      wroteAny = true;
                    }
                  }
                }
              }
            }
          } else if (item.op === "upsert") {
            const res = await authedCrudFetch(item.entity + "?on_conflict=" + encodeURIComponent(item.pk), {
              method: "POST",
              headers: { Prefer: "return=representation,resolution=merge-duplicates" },
              body: JSON.stringify(stripClientMeta(item.fullRow))
            });
            if (res.ok) {
              const rows = await res.json();
              if (Array.isArray(rows) && rows[0]) {
                writeRow(item.entity, item.rowId, rows[0], "");
                wroteAny = true;
              }
            }
          }
        } catch (_) {
          // Offline or unreachable test host; keep optimistic SQLite state.
        }
      }
      if (wroteAny) {
        runScreenFolds();
        emitFullRender();
      }
      startDraftPollIfNeeded();
    });
  };

  async function bootstrapLiveServerSync() {
    if (typeof fetch !== "function") return;
    try {
      const tok = await getAuthToken();
      if (!tok) return;
      const publicSyncTables = [];
      for (const [tName, aSpec] of Object.entries(shell.access || {})) {
        if (aSpec && aSpec.scope === "public" && tName !== "generation_draft" && tName !== "card_art" && tName !== "deck_progress" && tName !== "deck_level") {
          publicSyncTables.push(tName);
        }
      }
      await Promise.all(publicSyncTables.map(async (tName) => {
        const res = await authedCrudFetch(tName);
        if (!res.ok) return;
        const rows = await res.json();
        if (!Array.isArray(rows)) return;
        const pk = entityPks[tName] || "id";
        for (const r of rows) {
          if (r && r[pk] !== undefined) writeRow(tName, r[pk], r, "");
        }
      }));
      await serverFlushChain;
      if (shell.access && shell.access.generation_draft) {
        const dev = readTable("device")[0];
        const devKey = dev && dev.key ? String(dev.key) : "";
        if (/^[0-9a-f]{16}$/.test(devKey)) {
          const slotIds = [devKey + ":draft-cheap", devKey + ":draft-heavy"];
          const slotRes = await authedCrudFetch("generation_draft?id=in.(" + slotIds.map(encodeURIComponent).join(",") + ")");
          const foundIds = new Set();
          if (slotRes.ok) {
            const slotRows = await slotRes.json();
            if (Array.isArray(slotRows)) {
              for (const sr of slotRows) {
                if (sr && sr.id) {
                  foundIds.add(sr.id);
                  writeRow("generation_draft", sr.id, sr, "");
                }
              }
            }
          }
          for (const sid of slotIds) {
            if (!foundIds.has(sid)) {
              const createRes = await authedCrudFetch("generation_draft?on_conflict=id", {
                method: "POST",
                headers: { Prefer: "return=representation,resolution=merge-duplicates" },
                body: JSON.stringify({
                  id: sid,
                  topic: "",
                  category: "",
                  locale: "",
                  region: "",
                  card_count: 0,
                  status: "idle",
                  set_id: "",
                  details: ""
                })
              });
              if (createRes.ok) {
                const created = await createRes.json();
                if (Array.isArray(created) && created[0]) {
                  writeRow("generation_draft", sid, created[0], "");
                }
              }
            }
          }
        }
      }
      runScreenFolds();
      emitFullRender();
      startDraftPollIfNeeded();
    } catch (_) {
      // Offline cold boot continues seamlessly from SQLite snapshot.
    }
  }

  runScreenFolds();
  emitFullRender();
  void bootstrapLiveServerSync();

  if (typeof onAction === "function") {
    onAction(handleAction);
  }
})();
`;
}
