// ClaudeMCP Admin UI — vanilla JS + Alpine.js, no build step.
//
// Top-level layout:
//   - ICONS: inline SVG strings (extend as new icons are needed).
//   - PANELS: static metadata table for the sidebar nav.
//   - adminFetch(): wrapper around fetch() that includes the session cookie
//     and bounces back to the login screen on 401.
//   - debounce(): tiny utility used by the archive search panel.
//   - app(): root Alpine component — owns auth state, theme, active panel,
//     and the 5-second /admin/backends poller (shared across all panels via
//     module-level subscribeBackends so each panel can subscribe).
//   - dashboardPanel/backendsPanel/routerPanel/generalPanel/archivePanel():
//     per-panel components. Skeletons here; fleshed out in later tasks.

// ============================================================
// ICONS — inline SVG strings. `currentColor` picks up CSS color.
// ============================================================
const ICONS = {
  logo:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  backends:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="6" rx="2"/><rect x="2" y="15" width="20" height="6" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>`,
  router:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 12h6M9 12L17 8M9 12L17 16"/></svg>`,
  general:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  archive:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M10 12h4"/></svg>`,
  sun:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  moon:      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  logout:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
  refresh:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  trash:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>`,
  plus:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`,
  check:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`,
  close:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  search:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
};

const PANELS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "backends",  label: "Backends",  icon: "backends"  },
  { id: "router",    label: "Router",    icon: "router"    },
  { id: "general",   label: "General",   icon: "general"   },
  { id: "archive",   label: "Archive",   icon: "archive"   },
];

// ============================================================
// ADMIN FETCH WRAPPER
// ============================================================
async function adminFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "include",
    headers: {
      "Accept": "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // Cookie expired or invalid — bounce to login by clearing the shared state.
    window.dispatchEvent(new CustomEvent("claudemcp:logout"));
    throw new Error("session-expired");
  }
  return res;
}

function debounce(fn, delayMs) {
  let h = null;
  return (...args) => {
    if (h !== null) clearTimeout(h);
    h = setTimeout(() => { h = null; fn(...args); }, delayMs);
  };
}

// ============================================================
// SHARED BACKENDS-POLL STATE (single poller for the whole app)
//
// Plan 11 returns:
//   { data: [{ id, models, capabilities, lastProbe: { ok, at, error? } | null, reachable }] }
// We store the raw response on backendsState.data and let panels normalize it.
// ============================================================
const backendsState = {
  data: null,
  lastFetchedAt: null,
  error: null,
};
const backendsListeners = new Set();
function subscribeBackends(listener) {
  backendsListeners.add(listener);
  if (backendsState.data) listener(backendsState);
  return () => backendsListeners.delete(listener);
}
async function refreshBackends() {
  try {
    const res = await adminFetch("/admin/backends");
    if (!res.ok) throw new Error(`/admin/backends ${res.status}`);
    backendsState.data = await res.json();
    backendsState.lastFetchedAt = Date.now();
    backendsState.error = null;
  } catch (e) {
    backendsState.error = e instanceof Error ? e.message : String(e);
  }
  for (const l of backendsListeners) l(backendsState);
}
let backendsPollHandle = null;
function startBackendsPolling() {
  if (backendsPollHandle !== null) return;
  refreshBackends();
  backendsPollHandle = setInterval(refreshBackends, 5000);
}
function stopBackendsPolling() {
  if (backendsPollHandle !== null) {
    clearInterval(backendsPollHandle);
    backendsPollHandle = null;
  }
}

// ============================================================
// ROOT APP COMPONENT
// ============================================================
function app() {
  return {
    // Auth
    isLoggedIn: false,
    apiKeyInput: "",
    loggingIn: false,
    loginError: "",

    // Theme
    theme: document.documentElement.getAttribute("data-theme") || "dark",

    // Navigation
    panels: PANELS,
    activePanel: "dashboard",

    // Top-bar health
    backendHealthPills: [],

    // Make ICONS accessible from templates.
    ICONS,

    async init() {
      // Probe an /admin endpoint to see if we already have a valid session cookie.
      try {
        const res = await fetch("/admin/backends", { credentials: "include" });
        if (res.ok) {
          this.isLoggedIn = true;
          startBackendsPolling();
          this.subscribeHealth();
        }
      } catch (_e) { /* offline — show login */ }

      // Listen for cookie-expiry bounces from any panel's adminFetch.
      window.addEventListener("claudemcp:logout", () => {
        this.isLoggedIn = false;
        stopBackendsPolling();
      });
    },

    async login() {
      this.loggingIn = true;
      this.loginError = "";
      try {
        const res = await fetch("/admin/ui/session", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: this.apiKeyInput }),
        });
        if (res.status === 204) {
          this.apiKeyInput = "";
          this.isLoggedIn = true;
          startBackendsPolling();
          this.subscribeHealth();
        } else if (res.status === 401) {
          this.loginError = "Invalid API key.";
        } else {
          this.loginError = `Login failed: HTTP ${res.status}`;
        }
      } catch (e) {
        this.loginError = `Login failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      try {
        await fetch("/admin/ui/session", { method: "DELETE", credentials: "include" });
      } catch (_e) { /* best effort */ }
      this.isLoggedIn = false;
      stopBackendsPolling();
    },

    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", this.theme);
      try { localStorage.setItem("claudemcp-theme", this.theme); } catch (_e) { /* private mode */ }
    },

    setPanel(id) {
      this.activePanel = id;
    },

    panelTitle() {
      const p = this.panels.find(x => x.id === this.activePanel);
      return p ? p.label : "";
    },

    subscribeHealth() {
      subscribeBackends(state => {
        if (!state.data || !Array.isArray(state.data.data)) {
          this.backendHealthPills = [];
          return;
        }
        // Real /admin/backends shape: { data: [{ id, reachable, lastProbe, models, capabilities }] }
        this.backendHealthPills = state.data.data.map(b => ({
          name: b.id,
          color: colorForBackend(b),
        }));
      });
    },
  };
}

function colorForBackend(backend) {
  if (backend.reachable) return "green";
  if (backend.lastProbe && backend.lastProbe.ok === false) return "red";
  return "yellow";
}

// ============================================================
// PANEL COMPONENT SKELETONS — replaced in later tasks.
// ============================================================
function dashboardPanel() {
  return {
    backends: [],          // raw array from /admin/backends → data: []
    requestCounts: {},     // backendId -> last-hour count (best-effort)
    countsLoadedAt: null,
    unsubscribe: null,
    countInterval: null,

    init() {
      this.unsubscribe = subscribeBackends(state => {
        const arr = state.data && Array.isArray(state.data.data) ? state.data.data : [];
        this.backends = arr;
        this.refreshCounts(false);
      });
      // Refresh counts every 30s in case backends don't change.
      this.countInterval = setInterval(() => this.refreshCounts(true), 30_000);
    },

    destroy() {
      if (this.unsubscribe) this.unsubscribe();
      if (this.countInterval) clearInterval(this.countInterval);
    },

    async refreshCountsRaw() {
      const sinceMs = Date.now() - 60 * 60 * 1000;
      const since = new Date(sinceMs).toISOString();
      const out = { ...this.requestCounts };
      for (const b of this.backends) {
        try {
          // Real /admin/archive shape: { data: [...], has_more: bool }
          // We count by paging through up to 200 (the cap) — this is best-effort
          // and only approximates the true count.
          const res = await adminFetch(`/admin/archive?backend=${encodeURIComponent(b.id)}&since=${encodeURIComponent(since)}&limit=200`);
          if (res.ok) {
            const body = await res.json();
            const n = Array.isArray(body.data) ? body.data.length : 0;
            // If has_more is true, indicate "200+".
            out[b.id] = body.has_more ? `${n}+` : `${n}`;
          }
        } catch (_e) { /* keep previous value */ }
      }
      this.requestCounts = out;
      this.countsLoadedAt = Date.now();
    },

    refreshCounts(force) {
      if (!force && this.countsLoadedAt && Date.now() - this.countsLoadedAt < 25_000) return;
      this.refreshCountsRaw();
    },

    statusColor(backend) { return colorForBackend(backend); },

    formatTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      return d.toLocaleString();
    },

    modelsCount(backend) {
      return Array.isArray(backend.models) ? backend.models.length : 0;
    },

    lastProbeAt(backend) {
      return backend.lastProbe && backend.lastProbe.at ? backend.lastProbe.at : null;
    },
  };
}
function backendsPanel() {
  return {
    loading: true,
    error: null,
    config: null,          // current server config (apiKey redacted)
    draft: null,           // editable copy
    backendsLive: null,    // /admin/backends snapshot { data: [...] }
    unsubscribe: null,
    testing: {},           // map instanceKey -> {status, message}
    showApiKey: {},

    async init() {
      await this.reload();
      this.unsubscribe = subscribeBackends(state => { this.backendsLive = state.data; });
    },
    destroy() { if (this.unsubscribe) this.unsubscribe(); },

    async reload() {
      this.loading = true;
      this.error = null;
      try {
        const res = await adminFetch("/admin/config");
        if (!res.ok) throw new Error(`/admin/config ${res.status}`);
        this.config = await res.json();
        this.draft = JSON.parse(JSON.stringify(this.config));
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    addInstance(backendId) {
      const block = this.draft[backendId];
      if (!Array.isArray(block.instances)) block.instances = [];
      const used = new Set(block.instances.map(x => x.name));
      let i = 1;
      while (used.has(`instance-${i}`)) i++;
      block.instances.push({
        name: `instance-${i}`,
        baseUrl: backendId === "lmstudio" ? "http://localhost:1234" : "http://localhost:11434",
        apiKey: "",
        priority: 100,
        timeoutMs: 60000,
        useNativeApi: backendId === "ollama" ? null : null,
      });
    },

    removeInstance(backendId, idx) {
      this.draft[backendId].instances.splice(idx, 1);
    },

    async testConnection(backendId, instance) {
      const key = `${backendId}/${instance.name}`;
      this.testing[key] = { status: "pending", message: "Testing…" };
      try {
        // Real /admin/backends/test body: { baseUrl, apiKey?, useNativeApi? }
        const body = { baseUrl: instance.baseUrl };
        if (instance.apiKey) body.apiKey = instance.apiKey;
        if (instance.useNativeApi !== null && instance.useNativeApi !== undefined) {
          body.useNativeApi = instance.useNativeApi;
        }
        const res = await adminFetch("/admin/backends/test", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && out.ok) {
          const n = Array.isArray(out.models) ? out.models.length : 0;
          this.testing[key] = { status: "ok", message: `OK — ${n} models in ${out.latencyMs ?? "?"}ms` };
        } else {
          this.testing[key] = { status: "fail", message: out.error || `HTTP ${res.status}` };
        }
      } catch (e) {
        this.testing[key] = { status: "fail", message: e instanceof Error ? e.message : String(e) };
      }
    },

    async reprobe() {
      try {
        await adminFetch("/admin/backends/reprobe", { method: "POST" });
        await refreshBackends();
      } catch (_e) { /* shown via shared error state */ }
    },

    async save() {
      try {
        const patch = computeConfigPatch(this.config, this.draft);
        const res = await adminFetch("/admin/config", { method: "PATCH", body: JSON.stringify(patch) });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          this.error = (body.error && body.error.message) || `Save failed: HTTP ${res.status}`;
          return;
        }
        await this.reload();
        await this.reprobe();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },

    discard() {
      this.draft = JSON.parse(JSON.stringify(this.config));
    },

    /** Models discovered by the live registry, filtered to a backend id. */
    modelsForBackend(backendId) {
      if (!this.backendsLive || !Array.isArray(this.backendsLive.data)) return [];
      const b = this.backendsLive.data.find(x => x.id === backendId);
      return b && Array.isArray(b.models) ? b.models : [];
    },

    isDirty() {
      return JSON.stringify(this.config) !== JSON.stringify(this.draft);
    },
  };
}

/**
 * Compute a deep JSON-merge-patch from base→target. Used for PATCH /admin/config.
 * Arrays are atomic (full replacement, like RFC 7396).
 */
function computeConfigPatch(base, target) {
  if (typeof base !== "object" || base === null || Array.isArray(base) ||
      typeof target !== "object" || target === null || Array.isArray(target)) {
    return target;
  }
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const k of keys) {
    if (!(k in target)) { out[k] = null; continue; }
    if (!(k in base))   { out[k] = target[k]; continue; }
    if (typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k]) &&
        typeof base[k]   === "object" && base[k]   !== null && !Array.isArray(base[k])) {
      const sub = computeConfigPatch(base[k], target[k]);
      if (sub && Object.keys(sub).length > 0) out[k] = sub;
    } else if (JSON.stringify(base[k]) !== JSON.stringify(target[k])) {
      out[k] = target[k];
    }
  }
  return out;
}
function routerPanel()    { return { init() { /* see Task 12 */ } }; }
function generalPanel()   { return { init() { /* see Task 13 */ } }; }
function archivePanel()   { return { init() { /* see Task 14 */ } }; }

// Expose globally so Alpine's x-data attributes can resolve them without imports.
window.app = app;
window.dashboardPanel = dashboardPanel;
window.backendsPanel  = backendsPanel;
window.routerPanel    = routerPanel;
window.generalPanel   = generalPanel;
window.archivePanel   = archivePanel;
window.ICONS = ICONS;
