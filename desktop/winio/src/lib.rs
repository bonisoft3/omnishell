//! `omnishell-winio`: Elm-like (`init` / `update` / `render`) native desktop widget runtime
//! over AppKit (macOS), WinUI 3 (Windows), GTK 4 (Linux GNOME), and Qt 6 (Linux KDE).
//!
//! Consumes the deterministic `WinioScreenSpec` emitted by `plugins/omnishell/project-native.ts`
//! from `shell/screens/*.{html,css}`:
//!   - Mounts a child `RawWindowHandle` for `data-kinetic="<actor>"` (`KineticSurface`) so
//!     `omnishell-bevy-presenter` renders the 3D scene directly inside the layout rect.
//!   - Evaluates declarative CSS `[data-phase="..."]` state visibility rules on slow HUD cards.
//!   - Exposes all visible slow HUD widgets (`Button`, `Edit`, `Slider`, `Label`, `LiveRegion`)
//!     in the native OS accessibility tree (`NSAccessibility` / UIAutomation / AT-SPI2).

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeBackend {
    /// macOS AppKit (`NSWindow` / `NSView` + `CAMetalLayer` child view)
    AppKit,
    /// Windows WinUI 3 / Win32 (`HWND` + DX12 `IDXGISwapChain3` child visual)
    WinUi3,
    /// Linux GNOME GTK 4 (`GtkWindow` / `GtkWidget` + Vulkan `VkSurfaceKHR` sub-surface)
    Gtk4,
    /// Linux KDE Qt 6 (`QMainWindow` / `QWidget` + Vulkan `QVulkanWindow` child surface)
    Qt6,
}

impl NativeBackend {
    pub fn host_default() -> Self {
        if cfg!(target_os = "macos") {
            NativeBackend::AppKit
        } else if cfg!(target_os = "windows") {
            NativeBackend::WinUi3
        } else {
            NativeBackend::Gtk4
        }
    }

    pub fn accessibility_protocol(&self) -> &'static str {
        match self {
            NativeBackend::AppKit => "NSAccessibility",
            NativeBackend::WinUi3 => "UIAutomation",
            NativeBackend::Gtk4 | NativeBackend::Qt6 => "AT-SPI2",
        }
    }

    pub fn graphics_api(&self) -> &'static str {
        match self {
            NativeBackend::AppKit => "Metal",
            NativeBackend::WinUi3 => "DX12",
            NativeBackend::Gtk4 | NativeBackend::Qt6 => "Vulkan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawWindowHandle {
    pub backend: NativeBackend,
    pub window_ptr: u64,
    pub view_ptr: u64,
    pub width_px: u32,
    pub height_px: u32,
    pub scale_factor_milli: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WidgetKind {
    Window,
    StackPanel,
    Label,
    Button,
    Edit,
    Slider,
    LiveRegion,
    KineticSurface,
    HudLayer,
}

impl WidgetKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "Window" => WidgetKind::Window,
            "StackPanel" => WidgetKind::StackPanel,
            "Label" => WidgetKind::Label,
            "Button" => WidgetKind::Button,
            "Edit" => WidgetKind::Edit,
            "Slider" => WidgetKind::Slider,
            "LiveRegion" => WidgetKind::LiveRegion,
            "KineticSurface" => WidgetKind::KineticSurface,
            "HudLayer" => WidgetKind::HudLayer,
            _ => WidgetKind::StackPanel,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Orientation {
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CssStateRule {
    pub selector: String,
    pub attr: String,
    pub op: String,
    pub value: String,
    pub target_class: String,
    pub visible: bool,
    pub negated: bool,
}

#[derive(Debug, Clone)]
pub struct WinioWidgetSpec {
    pub id: String,
    pub widget: WidgetKind,
    pub orientation: Orientation,
    pub classes: Vec<String>,
    pub role: Option<String>,
    pub accessibility_label: Option<String>,
    pub text: Option<String>,
    pub text_binding: Option<String>,
    pub state_attrs: BTreeMap<String, String>,
    pub live_table: Option<String>,
    pub kinetic_actor: Option<String>,
    pub hud_layer: Option<String>,
    pub input_field: Option<String>,
    pub input_kind: Option<String>,
    pub input_placeholder: Option<String>,
    pub input_min: f32,
    pub input_max: f32,
    pub action_uri: Option<String>,
    pub children: Vec<WinioWidgetSpec>,
}

#[derive(Debug, Clone)]
pub struct WinioScreenSpec {
    pub screen: String,
    pub route: String,
    pub state_rules: Vec<CssStateRule>,
    pub root: WinioWidgetSpec,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccessibilityNode {
    pub id: String,
    pub classes: Vec<String>,
    pub role: String,
    pub label: String,
    pub value: String,
    pub enabled: bool,
    pub focusable: bool,
    pub action_uri: Option<String>,
    pub children: Vec<AccessibilityNode>,
}

impl AccessibilityNode {
    pub fn find_by_id(&self, target_id: &str) -> Option<&AccessibilityNode> {
        if self.id == target_id || self.classes.iter().any(|c| c == target_id) {
            return Some(self);
        }
        for c in &self.children {
            if let Some(found) = c.find_by_id(target_id) {
                return Some(found);
            }
        }
        None
    }

    pub fn collect_interactive(&self, out: &mut Vec<AccessibilityNode>) {
        if self.focusable {
            out.push(self.clone());
        }
        for c in &self.children {
            c.collect_interactive(out);
        }
    }
}

/// Elm-like message dispatched to `WinioComponent::update`.
#[derive(Debug, Clone)]
pub enum DesktopMessage {
    Navigate(String),
    SetStateAttr { key: String, value: String },
    SetInputValue { field: String, value: String },
    SetSliderValue { field: String, value: f32 },
    UpdateScalar { name: String, value: String },
    TriggerButton { id: String },
    Resize { width_px: u32, height_px: u32, scale_factor_milli: u32 },
}

/// Effect emitted by `WinioComponent::update`.
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopEffect {
    DispatchActionUri(String),
    RemountKineticSurface { actor: String, handle: RawWindowHandle },
    SyncAccessibilityTree(AccessibilityNode),
    None,
}

/// Elm-like (`init` / `update` / `render`) `winio` host component for an Omnishell screen.
pub struct WinioDesktopApp {
    pub backend: NativeBackend,
    pub current_screen: String,
    pub screens: BTreeMap<String, WinioScreenSpec>,
    pub state_attrs: BTreeMap<String, String>,
    pub input_values: BTreeMap<String, String>,
    pub slider_values: BTreeMap<String, f32>,
    pub scalars: BTreeMap<String, String>,
    pub kinetic_handle: RawWindowHandle,
    pub dispatched_actions: Vec<String>,
}

impl WinioDesktopApp {
    /// Elm `init`: initialize the desktop widget host for the given OS backend and screen specs.
    pub fn init(backend: NativeBackend, screens: Vec<WinioScreenSpec>, initial_screen: &str) -> Self {
        let mut map = BTreeMap::new();
        for s in screens {
            map.insert(s.screen.clone(), s);
        }
        let mut state_attrs = BTreeMap::new();
        state_attrs.insert("phase".to_string(), "title".to_string());
        state_attrs.insert("lobby".to_string(), "idle".to_string());

        let kinetic_handle = RawWindowHandle {
            backend,
            window_ptr: 0x1000_0001,
            view_ptr: 0x2000_0001,
            width_px: 2560,
            height_px: 1440,
            scale_factor_milli: 2000,
        };

        Self {
            backend,
            current_screen: initial_screen.to_string(),
            screens: map,
            state_attrs,
            input_values: BTreeMap::new(),
            slider_values: BTreeMap::new(),
            scalars: BTreeMap::new(),
            kinetic_handle,
            dispatched_actions: Vec::new(),
        }
    }

    /// Elm `update`: process a `DesktopMessage` and return the resulting `DesktopEffect`.
    pub fn update(&mut self, msg: DesktopMessage) -> DesktopEffect {
        match msg {
            DesktopMessage::Navigate(screen) => {
                if self.screens.contains_key(&screen) {
                    self.current_screen = screen;
                }
                DesktopEffect::SyncAccessibilityTree(self.render_accessibility_tree())
            }
            DesktopMessage::SetStateAttr { key, value } => {
                self.state_attrs.insert(key, value);
                DesktopEffect::SyncAccessibilityTree(self.render_accessibility_tree())
            }
            DesktopMessage::SetInputValue { field, value } => {
                self.input_values.insert(field, value);
                DesktopEffect::None
            }
            DesktopMessage::SetSliderValue { field, value } => {
                self.slider_values.insert(field.clone(), value);
                let uri = format!("pronto://event/INPUT?field={}&value={}", field, value as i32);
                self.dispatched_actions.push(uri.clone());
                DesktopEffect::DispatchActionUri(uri)
            }
            DesktopMessage::UpdateScalar { name, value } => {
                self.scalars.insert(name, value);
                DesktopEffect::None
            }
            DesktopMessage::TriggerButton { id } => {
                if let Some(spec) = self.screens.get(&self.current_screen) {
                    if let Some(widget) = find_widget(&spec.root, &id) {
                        if let Some(base_uri) = &widget.action_uri {
                            let full_uri = self.append_form_inputs(base_uri);
                            self.dispatched_actions.push(full_uri.clone());
                            return DesktopEffect::DispatchActionUri(full_uri);
                        }
                    }
                }
                DesktopEffect::None
            }
            DesktopMessage::Resize {
                width_px,
                height_px,
                scale_factor_milli,
            } => {
                self.kinetic_handle.width_px = width_px;
                self.kinetic_handle.height_px = height_px;
                self.kinetic_handle.scale_factor_milli = scale_factor_milli;
                if let Some((actor, handle)) = self.active_kinetic_surface() {
                    DesktopEffect::RemountKineticSurface { actor, handle }
                } else {
                    DesktopEffect::None
                }
            }
        }
    }

    /// Elm `render`: project the current screen's visible `winio` widgets into the OS accessibility tree.
    pub fn render_accessibility_tree(&self) -> AccessibilityNode {
        let Some(spec) = self.screens.get(&self.current_screen) else {
            return AccessibilityNode {
                id: "empty_window".to_string(),
                classes: Vec::new(),
                role: "window".to_string(),
                label: "Omnishell".to_string(),
                value: String::new(),
                enabled: true,
                focusable: false,
                action_uri: None,
                children: Vec::new(),
            };
        };
        self.lower_accessibility(&spec.root, &spec.state_rules)
            .unwrap_or_else(|| AccessibilityNode {
                id: spec.root.id.clone(),
                classes: spec.root.classes.clone(),
                role: "window".to_string(),
                label: spec.screen.clone(),
                value: String::new(),
                enabled: true,
                focusable: false,
                action_uri: None,
                children: Vec::new(),
            })
    }

    /// Return the mounted `KineticSurface` child view handle if the active screen declares `data-kinetic`.
    pub fn active_kinetic_surface(&self) -> Option<(String, RawWindowHandle)> {
        let spec = self.screens.get(&self.current_screen)?;
        let surface = find_kinetic_surface(&spec.root)?;
        let actor = surface.kinetic_actor.clone()?;
        Some((actor, self.kinetic_handle))
    }

    /// Return all fast HUD layer IDs (`canvas[data-layer]`) declared on the active screen.
    pub fn active_hud_layers(&self) -> Vec<String> {
        let Some(spec) = self.screens.get(&self.current_screen) else {
            return Vec::new();
        };
        let mut layers = Vec::new();
        collect_hud_layers(&spec.root, &mut layers);
        layers
    }

    fn is_widget_visible(&self, widget: &WinioWidgetSpec, rules: &[CssStateRule]) -> bool {
        for rule in rules {
            if rule.target_class.is_empty() {
                continue;
            }
            let targets_widget = widget.id == rule.target_class
                || widget.classes.iter().any(|c| c == &rule.target_class);
            if !targets_widget {
                continue;
            }
            let current_val = self.state_attrs.get(&rule.attr).map(|s| s.as_str()).unwrap_or("");
            let value_matches = match rule.op.as_str() {
                "present" => !current_val.is_empty(),
                "contains" => current_val.split_whitespace().any(|w| w == rule.value),
                _ => rule.value.split('|').any(|v| v == current_val),
            };
            let cond_matches = if rule.negated {
                !value_matches
            } else {
                value_matches
            };
            if cond_matches && !rule.visible {
                return false;
            }
        }
        true
    }

    fn lower_accessibility(&self, widget: &WinioWidgetSpec, rules: &[CssStateRule]) -> Option<AccessibilityNode> {
        if !self.is_widget_visible(widget, rules) {
            return None;
        }
        let mut children = Vec::new();
        for c in &widget.children {
            if let Some(child_node) = self.lower_accessibility(c, rules) {
                children.push(child_node);
            }
        }

        let role = widget.role.clone().unwrap_or_else(|| match widget.widget {
            WidgetKind::Window => "window".to_string(),
            WidgetKind::StackPanel => "group".to_string(),
            WidgetKind::Label => "text".to_string(),
            WidgetKind::Button => "button".to_string(),
            WidgetKind::Edit => "textbox".to_string(),
            WidgetKind::Slider => "slider".to_string(),
            WidgetKind::LiveRegion => "region".to_string(),
            WidgetKind::KineticSurface => "img".to_string(),
            WidgetKind::HudLayer => "status".to_string(),
        });

        let label = widget
            .accessibility_label
            .clone()
            .or_else(|| widget.text.clone())
            .or_else(|| widget.input_placeholder.clone())
            .or_else(|| widget.hud_layer.clone())
            .unwrap_or_else(|| widget.id.clone());

        let value = match widget.widget {
            WidgetKind::Edit => widget
                .input_field
                .as_ref()
                .and_then(|f| self.input_values.get(f))
                .cloned()
                .unwrap_or_default(),
            WidgetKind::Slider => widget
                .input_field
                .as_ref()
                .and_then(|f| self.slider_values.get(f))
                .map(|v| format!("{:.0}", v))
                .unwrap_or_else(|| "80".to_string()),
            WidgetKind::HudLayer => widget
                .hud_layer
                .as_ref()
                .and_then(|l| self.scalars.get(l))
                .cloned()
                .unwrap_or_default(),
            _ => widget.text.clone().unwrap_or_default(),
        };

        let focusable = matches!(
            widget.widget,
            WidgetKind::Button | WidgetKind::Edit | WidgetKind::Slider
        );

        Some(AccessibilityNode {
            id: widget.id.clone(),
            classes: widget.classes.clone(),
            role,
            label,
            value,
            enabled: true,
            focusable,
            action_uri: widget.action_uri.clone(),
            children,
        })
    }

    fn append_form_inputs(&self, base_uri: &str) -> String {
        if self.input_values.is_empty() || !base_uri.starts_with("pronto://event/") {
            return base_uri.to_string();
        }
        let sep = if base_uri.contains('?') { '&' } else { '?' };
        let mut out = base_uri.to_string();
        let mut first = true;
        for (k, v) in &self.input_values {
            out.push(if first { sep } else { '&' });
            first = false;
            out.push_str(&urlencode_form_component(k));
            out.push('=');
            out.push_str(&urlencode_form_component(v));
        }
        out
    }
}

fn urlencode_form_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                let hi = b >> 4;
                let lo = b & 0x0f;
                out.push(if hi < 10 { (b'0' + hi) as char } else { (b'A' + hi - 10) as char });
                out.push(if lo < 10 { (b'0' + lo) as char } else { (b'A' + lo - 10) as char });
            }
        }
    }
    out
}

fn find_widget<'a>(node: &'a WinioWidgetSpec, id: &str) -> Option<&'a WinioWidgetSpec> {
    let norm = id.replace('-', "_");
    let uri_matches = node
        .action_uri
        .as_deref()
        .and_then(|u| u.strip_prefix("pronto://event/"))
        .and_then(|rest| rest.split('?').next())
        .map(|ev| ev.eq_ignore_ascii_case(&norm))
        .unwrap_or(false);
    if node.id == id || node.input_field.as_deref() == Some(id) || uri_matches {
        return Some(node);
    }
    for c in &node.children {
        if let Some(found) = find_widget(c, id) {
            return Some(found);
        }
    }
    None
}

fn find_kinetic_surface(node: &WinioWidgetSpec) -> Option<&WinioWidgetSpec> {
    if node.widget == WidgetKind::KineticSurface {
        return Some(node);
    }
    for c in &node.children {
        if let Some(found) = find_kinetic_surface(c) {
            return Some(found);
        }
    }
    None
}

fn collect_hud_layers(node: &WinioWidgetSpec, out: &mut Vec<String>) {
    if node.widget == WidgetKind::HudLayer {
        if let Some(layer) = &node.hud_layer {
            out.push(layer.clone());
        }
    }
    for c in &node.children {
        collect_hud_layers(c, out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-dependency JSON parser for `WinioScreenSpec` emitted by `project-native.ts`
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum JsonVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsonVal>),
    Obj(BTreeMap<String, JsonVal>),
}

impl JsonVal {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsonVal::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            JsonVal::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsonVal::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[JsonVal]> {
        match self {
            JsonVal::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&BTreeMap<String, JsonVal>> {
        match self {
            JsonVal::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&JsonVal> {
        self.as_obj()?.get(key)
    }
}

pub fn parse_json(input: &str) -> Result<JsonVal, String> {
    let bytes = input.as_bytes();
    let mut pos = 0;
    let val = parse_value(bytes, &mut pos)?;
    Ok(val)
}

fn skip_ws(b: &[u8], pos: &mut usize) {
    while *pos < b.len() && matches!(b[*pos], b' ' | b'\t' | b'\n' | b'\r') {
        *pos += 1;
    }
}

fn parse_value(b: &[u8], pos: &mut usize) -> Result<JsonVal, String> {
    skip_ws(b, pos);
    if *pos >= b.len() {
        return Err("Unexpected EOF in JSON".to_string());
    }
    match b[*pos] {
        b'"' => Ok(JsonVal::Str(parse_string(b, pos)?)),
        b'{' => parse_object(b, pos),
        b'[' => parse_array(b, pos),
        b't' => {
            if b.get(*pos..*pos + 4) == Some(b"true") {
                *pos += 4;
                Ok(JsonVal::Bool(true))
            } else {
                Err("Invalid token 't'".to_string())
            }
        }
        b'f' => {
            if b.get(*pos..*pos + 5) == Some(b"false") {
                *pos += 5;
                Ok(JsonVal::Bool(false))
            } else {
                Err("Invalid token 'f'".to_string())
            }
        }
        b'n' => {
            if b.get(*pos..*pos + 4) == Some(b"null") {
                *pos += 4;
                Ok(JsonVal::Null)
            } else {
                Err("Invalid token 'n'".to_string())
            }
        }
        _ => parse_number(b, pos),
    }
}

fn parse_string(b: &[u8], pos: &mut usize) -> Result<String, String> {
    if b.get(*pos) != Some(&b'"') {
        return Err("Expected '\"'".to_string());
    }
    *pos += 1;
    let mut out = String::new();
    while *pos < b.len() {
        let ch = b[*pos];
        *pos += 1;
        if ch == b'"' {
            return Ok(out);
        }
        if ch == b'\\' {
            if *pos >= b.len() {
                return Err("Unterminated escape".to_string());
            }
            let esc = b[*pos];
            *pos += 1;
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000c}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    if *pos + 4 > b.len() {
                        return Err("Truncated \\u escape".to_string());
                    }
                    let hex = std::str::from_utf8(&b[*pos..*pos + 4]).map_err(|e| e.to_string())?;
                    let code = u32::from_str_radix(hex, 16).map_err(|e| e.to_string())?;
                    *pos += 4;
                    if let Some(c) = char::from_u32(code) {
                        out.push(c);
                    }
                }
                _ => out.push(esc as char),
            }
        } else {
            // Reconstruct UTF-8 char if multi-byte
            if ch < 0x80 {
                out.push(ch as char);
            } else {
                let start = *pos - 1;
                let width = if ch & 0xE0 == 0xC0 {
                    2
                } else if ch & 0xF0 == 0xE0 {
                    3
                } else {
                    4
                };
                *pos = start + width;
                let s = std::str::from_utf8(&b[start..*pos]).map_err(|e| e.to_string())?;
                out.push_str(s);
            }
        }
    }
    Err("Unterminated string".to_string())
}

fn parse_number(b: &[u8], pos: &mut usize) -> Result<JsonVal, String> {
    let start = *pos;
    while *pos < b.len() && matches!(b[*pos], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
        *pos += 1;
    }
    let s = std::str::from_utf8(&b[start..*pos]).map_err(|e| e.to_string())?;
    let n = s.parse::<f64>().map_err(|e| e.to_string())?;
    Ok(JsonVal::Num(n))
}

fn parse_array(b: &[u8], pos: &mut usize) -> Result<JsonVal, String> {
    *pos += 1; // '['
    let mut arr = Vec::new();
    skip_ws(b, pos);
    if b.get(*pos) == Some(&b']') {
        *pos += 1;
        return Ok(JsonVal::Arr(arr));
    }
    loop {
        arr.push(parse_value(b, pos)?);
        skip_ws(b, pos);
        match b.get(*pos) {
            Some(b',') => *pos += 1,
            Some(b']') => {
                *pos += 1;
                return Ok(JsonVal::Arr(arr));
            }
            _ => return Err("Expected ',' or ']' in array".to_string()),
        }
    }
}

fn parse_object(b: &[u8], pos: &mut usize) -> Result<JsonVal, String> {
    *pos += 1; // '{'
    let mut map = BTreeMap::new();
    skip_ws(b, pos);
    if b.get(*pos) == Some(&b'}') {
        *pos += 1;
        return Ok(JsonVal::Obj(map));
    }
    loop {
        skip_ws(b, pos);
        let key = parse_string(b, pos)?;
        skip_ws(b, pos);
        if b.get(*pos) != Some(&b':') {
            return Err("Expected ':' after object key".to_string());
        }
        *pos += 1;
        let val = parse_value(b, pos)?;
        map.insert(key, val);
        skip_ws(b, pos);
        match b.get(*pos) {
            Some(b',') => *pos += 1,
            Some(b'}') => {
                *pos += 1;
                return Ok(JsonVal::Obj(map));
            }
            _ => return Err("Expected ',' or '}' in object".to_string()),
        }
    }
}

pub fn parse_winio_screen_spec(json_str: &str) -> Result<WinioScreenSpec, String> {
    let val = parse_json(json_str)?;
    let screen = val.get("screen").and_then(|v| v.as_str()).unwrap_or("screen").to_string();
    let route = val.get("route").and_then(|v| v.as_str()).unwrap_or("/").to_string();
    let mut state_rules = Vec::new();
    if let Some(arr) = val.get("stateRules").and_then(|v| v.as_arr()) {
        for r in arr {
            let selector = r.get("selector").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let negated = r
                .get("negated")
                .and_then(|v| v.as_bool())
                .unwrap_or_else(|| selector.contains(":not("));
            state_rules.push(CssStateRule {
                selector,
                attr: r.get("attr").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                op: r.get("op").and_then(|v| v.as_str()).unwrap_or("eq").to_string(),
                value: r.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                target_class: r.get("targetClass").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                visible: r.get("visible").and_then(|v| v.as_bool()).unwrap_or(true),
                negated,
            });
        }
    }
    let root_val = val.get("root").ok_or_else(|| "Missing 'root' in WinioScreenSpec".to_string())?;
    let root = decode_widget(root_val)?;
    Ok(WinioScreenSpec {
        screen,
        route,
        state_rules,
        root,
    })
}

fn decode_widget(val: &JsonVal) -> Result<WinioWidgetSpec, String> {
    let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("widget").to_string();
    let widget = WidgetKind::parse(val.get("widget").and_then(|v| v.as_str()).unwrap_or("StackPanel"));
    let orientation = match val.get("orientation").and_then(|v| v.as_str()) {
        Some("Horizontal") => Orientation::Horizontal,
        _ => Orientation::Vertical,
    };
    let classes = val
        .get("classes")
        .and_then(|v| v.as_arr())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut state_attrs = BTreeMap::new();
    if let Some(obj) = val.get("stateAttrs").and_then(|v| v.as_obj()) {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                state_attrs.insert(k.clone(), s.to_string());
            }
        }
    }
    let mut children = Vec::new();
    if let Some(arr) = val.get("children").and_then(|v| v.as_arr()) {
        for c in arr {
            children.push(decode_widget(c)?);
        }
    }
    Ok(WinioWidgetSpec {
        id,
        widget,
        orientation,
        classes,
        role: val.get("role").and_then(|v| v.as_str()).map(|s| s.to_string()),
        accessibility_label: val.get("accessibilityLabel").and_then(|v| v.as_str()).map(|s| s.to_string()),
        text: val.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()),
        text_binding: val.get("textBinding").and_then(|v| v.as_str()).map(|s| s.to_string()),
        state_attrs,
        live_table: val.get("liveTable").and_then(|v| v.as_str()).map(|s| s.to_string()),
        kinetic_actor: val.get("kineticActor").and_then(|v| v.as_str()).map(|s| s.to_string()),
        hud_layer: val.get("hudLayer").and_then(|v| v.as_str()).map(|s| s.to_string()),
        input_field: val.get("inputField").and_then(|v| v.as_str()).map(|s| s.to_string()),
        input_kind: val.get("inputKind").and_then(|v| v.as_str()).map(|s| s.to_string()),
        input_placeholder: val.get("inputPlaceholder").and_then(|v| v.as_str()).map(|s| s.to_string()),
        input_min: val.get("inputMin").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
        input_max: val.get("inputMax").and_then(|v| v.as_f64()).unwrap_or(100.0) as f32,
        action_uri: val.get("actionUri").and_then(|v| v.as_str()).map(|s| s.to_string()),
        children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME_WINIO_JSON: &str = include_str!("../fixtures/home_winio.json");
    const EDITOR_WINIO_JSON: &str = include_str!("../fixtures/editor_winio.json");

    #[test]
    fn slice1_desktop_winio_projection_and_accessibility_tree() {
        let home_spec = parse_winio_screen_spec(HOME_WINIO_JSON).expect("parse home winio");
        let editor_spec = parse_winio_screen_spec(EDITOR_WINIO_JSON).expect("parse editor winio");
        let mut app = WinioDesktopApp::init(
            NativeBackend::host_default(),
            vec![home_spec, editor_spec],
            "home",
        );

        let tree = app.render_accessibility_tree();
        assert_eq!(tree.role, "window");

        app.update(DesktopMessage::Navigate("editor".to_string()));
        app.update(DesktopMessage::SetInputValue {
            field: "title".to_string(),
            value: "Kinetic Native Targets".to_string(),
        });
        let eff = app.update(DesktopMessage::TriggerButton {
            id: "publish-article".to_string(),
        });
        match eff {
            DesktopEffect::DispatchActionUri(uri) => {
                assert!(
                    uri.starts_with("pronto://event/PUBLISH_ARTICLE"),
                    "expected PUBLISH_ARTICLE URI, got {}",
                    uri
                );
                assert!(uri.contains("title=Kinetic+Native+Targets"));
            }
            other => panic!("Expected DispatchActionUri, got {:?}", other),
        }
    }
}
