import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * OEE Tracker – React frontend
 * - Operator: log production events
 * - Supervisor/Manager: monitor live OEE and view shift report
 * - Realtime: WebSocket updates when available, with graceful fallback
 */

/** @typedef {"operator"|"supervisor"|"manager"} UserRole */
/** @typedef {"running"|"planned_downtime"|"unplanned_downtime"|"changeover"} MachineState */
/** @typedef {"good_count"|"reject_count"|"downtime_start"|"downtime_end"|"note"} EventType */

/**
 * @typedef {Object} OeeSnapshot
 * @property {string} lineId
 * @property {string} lineName
 * @property {string} shiftId
 * @property {number} plannedTimeSec
 * @property {number} runTimeSec
 * @property {number} idealCycleTimeSec
 * @property {number} totalCount
 * @property {number} goodCount
 * @property {number} rejectCount
 * @property {number} availability
 * @property {number} performance
 * @property {number} quality
 * @property {number} oee
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ProductionEvent
 * @property {string} id
 * @property {string} createdAt
 * @property {string} lineId
 * @property {string} shiftId
 * @property {EventType} type
 * @property {number=} quantity
 * @property {string=} reason
 * @property {string=} note
 */

// --- Theme constants (from style guide) ---
const THEME = {
  name: "Ocean Professional",
  primary: "#2563EB",
  secondary: "#F59E0B",
  success: "#F59E0B",
  error: "#EF4444",
  background: "#f9fafb",
  surface: "#ffffff",
  text: "#111827",
};

// --- Environment endpoints ---
function resolveBaseUrls() {
  // Prefer explicit API base, then backend URL, then same-origin fallback
  const apiBase =
    process.env.REACT_APP_API_BASE ||
    process.env.REACT_APP_BACKEND_URL ||
    "";

  const wsUrl =
    process.env.REACT_APP_WS_URL ||
    (apiBase
      ? apiBase.replace(/^http/i, "ws")
      : "");

  return { apiBase, wsUrl };
}

/**
 * Simple JSON fetch wrapper with timeout and helpful error text.
 * If backend is down/unreachable, caller can switch to local fallback.
 */
async function fetchJson(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || text || res.statusText;
      const err = new Error(`Request failed (${res.status}): ${msg}`);
      // @ts-ignore
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Local fallback store (in-memory + localStorage) ---
const LS_KEY = "oee_tracker_local_state_v1";

function loadLocalState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persistLocalState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function pct(x) {
  return `${Math.round(clamp01(x) * 100)}%`;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(Math.round(n));
}

function formatDurationSec(sec) {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function computeOeeFromEvents({
  plannedTimeSec,
  idealCycleTimeSec,
  goodCount,
  rejectCount,
  runTimeSec,
  totalCount,
}) {
  // Availability = run time / planned time
  const availability = plannedTimeSec > 0 ? runTimeSec / plannedTimeSec : 0;
  // Performance = (ideal cycle time * total count) / run time
  const performance =
    runTimeSec > 0 ? (idealCycleTimeSec * totalCount) / runTimeSec : 0;
  // Quality = good / total
  const quality = totalCount > 0 ? goodCount / totalCount : 0;
  const oee = clamp01(availability) * clamp01(performance) * clamp01(quality);
  return {
    availability: clamp01(availability),
    performance: clamp01(performance),
    quality: clamp01(quality),
    oee: clamp01(oee),
  };
}

function makeDefaultLocalState() {
  // Default: 8-hour shift; one line; ideal cycle time 2.0s per unit
  const shiftId = `shift-${new Date().toISOString().slice(0, 10)}-A`;
  return {
    line: { id: "line-1", name: "Line 1" },
    shift: { id: shiftId, name: "Day Shift (A)" },
    metrics: {
      plannedTimeSec: 8 * 3600,
      idealCycleTimeSec: 2.0,
      runTimeSec: 0,
      totalCount: 0,
      goodCount: 0,
      rejectCount: 0,
      updatedAt: nowIso(),
    },
    machine: {
      state: /** @type {MachineState} */ ("running"),
      downtimeReason: "",
      downtimeStartedAt: null,
    },
    events: /** @type {ProductionEvent[]} */ ([]),
    alerts: [],
  };
}

function deriveSnapshotFromLocalState(local) {
  const m = local.metrics;
  const derived = computeOeeFromEvents({
    plannedTimeSec: m.plannedTimeSec,
    idealCycleTimeSec: m.idealCycleTimeSec,
    goodCount: m.goodCount,
    rejectCount: m.rejectCount,
    runTimeSec: m.runTimeSec,
    totalCount: m.totalCount,
  });

  /** @type {OeeSnapshot} */
  const snap = {
    lineId: local.line.id,
    lineName: local.line.name,
    shiftId: local.shift.id,
    plannedTimeSec: m.plannedTimeSec,
    runTimeSec: m.runTimeSec,
    idealCycleTimeSec: m.idealCycleTimeSec,
    totalCount: m.totalCount,
    goodCount: m.goodCount,
    rejectCount: m.rejectCount,
    availability: derived.availability,
    performance: derived.performance,
    quality: derived.quality,
    oee: derived.oee,
    updatedAt: m.updatedAt,
  };
  return snap;
}

function newEventId() {
  return `evt_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function buildAlertsFromSnapshot(snapshot) {
  const alerts = [];
  // Simple, sensible thresholds
  if (snapshot.availability < 0.7) {
    alerts.push({
      id: "availability-low",
      severity: "warning",
      title: "Availability is low",
      message: "Frequent/extended downtime detected. Check downtime reasons and recovery actions.",
    });
  }
  if (snapshot.quality < 0.92) {
    alerts.push({
      id: "quality-low",
      severity: "warning",
      title: "Quality is below target",
      message: "Reject rate is trending high. Review scrap causes and inspection stations.",
    });
  }
  if (snapshot.performance < 0.8) {
    alerts.push({
      id: "performance-low",
      severity: "info",
      title: "Performance opportunity",
      message: "Production rate below ideal. Check cycle time, micro-stops, and changeover losses.",
    });
  }
  if (snapshot.oee < 0.6) {
    alerts.push({
      id: "oee-critical",
      severity: "error",
      title: "OEE needs attention",
      message: "Overall effectiveness is critically low. Prioritize downtime and quality interventions.",
    });
  }
  return alerts;
}

// --- Backend API surface (best-effort; fallback if missing/unavailable) ---
// We do not have an OpenAPI spec in this workspace; implement robust probing.
async function tryBackendHealth(apiBase) {
  if (!apiBase) return { ok: false, reason: "API base not configured" };

  // Try common health endpoints, including container env var if present.
  const candidates = [];
  if (process.env.REACT_APP_HEALTHCHECK_PATH) {
    candidates.push(
      apiBase.replace(/\/$/, "") + process.env.REACT_APP_HEALTHCHECK_PATH
    );
  }
  candidates.push(apiBase.replace(/\/$/, "") + "/health");
  candidates.push(apiBase.replace(/\/$/, "") + "/api/health");
  candidates.push(apiBase.replace(/\/$/, "") + "/");

  for (const url of candidates) {
    try {
      await fetchJson(url, {}, 2500);
      return { ok: true, reason: `Reachable: ${url}` };
    } catch {
      // keep trying
    }
  }
  return { ok: false, reason: "Backend not reachable (health probe failed)" };
}

async function tryFetchDashboard(apiBase) {
  // Try a few likely endpoints.
  const candidates = [
    "/api/oee/summary",
    "/api/oee",
    "/oee/summary",
    "/oee",
  ].map((p) => apiBase.replace(/\/$/, "") + p);

  for (const url of candidates) {
    try {
      const data = await fetchJson(url, {}, 3500);
      return { ok: true, data };
    } catch {
      // try next
    }
  }
  return { ok: false, data: null };
}

async function tryPostEvent(apiBase, event) {
  const candidates = [
    "/api/events",
    "/api/oee/events",
    "/events",
    "/oee/events",
  ].map((p) => apiBase.replace(/\/$/, "") + p);

  for (const url of candidates) {
    try {
      const res = await fetchJson(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        },
        4500
      );
      return { ok: true, data: res };
    } catch {
      // try next
    }
  }
  return { ok: false, data: null };
}

// --- UI components ---
function Badge({ tone, children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function MetricCard({ title, value, subvalue, tone, hint }) {
  return (
    <div className="card metric-card">
      <div className="metric-top">
        <div className="metric-title">{title}</div>
        {tone ? <Badge tone={tone}>{tone.toUpperCase()}</Badge> : null}
      </div>
      <div className="metric-value">{value}</div>
      {subvalue ? <div className="metric-subvalue">{subvalue}</div> : null}
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </div>
  );
}

function ProgressBar({ label, value01, tone }) {
  const pctVal = Math.round(clamp01(value01) * 100);
  return (
    <div className="progress">
      <div className="progress-top">
        <div className="progress-label">{label}</div>
        <div className="progress-value">{pctVal}%</div>
      </div>
      <div className="progress-track" aria-label={`${label} ${pctVal}%`}>
        <div
          className={`progress-fill ${tone ? `progress-${tone}` : ""}`}
          style={{ width: `${pctVal}%` }}
        />
      </div>
    </div>
  );
}

function Table({ columns, rows, emptyText }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="table-empty" colSpan={columns.length}>
                {emptyText || "No data"}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r._key}>
                {columns.map((c) => (
                  <td key={c.key}>{c.render(r)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Toast({ tone, title, message, onClose }) {
  return (
    <div className={`toast toast-${tone}`}>
      <div className="toast-body">
        <div className="toast-title">{title}</div>
        <div className="toast-message">{message}</div>
      </div>
      <button className="icon-btn" onClick={onClose} aria-label="Dismiss alert">
        ✕
      </button>
    </div>
  );
}

function RolePill({ role }) {
  const map = {
    operator: { label: "Operator", tone: "info" },
    supervisor: { label: "Supervisor", tone: "success" },
    manager: { label: "Manager", tone: "warning" },
  };
  const v = map[role] || { label: role, tone: "neutral" };
  return <span className={`pill pill-${v.tone}`}>{v.label}</span>;
}

function Icon({ name }) {
  const icons = {
    dashboard: "▦",
    log: "✎",
    alerts: "⚡",
    report: "≡",
    settings: "⚙",
    plug: "⟲",
  };
  return <span className="icon" aria-hidden="true">{icons[name] || "•"}</span>;
}

// PUBLIC_INTERFACE
function App() {
  const { apiBase, wsUrl } = useMemo(() => resolveBaseUrls(), []);
  const [role, setRole] = useState(/** @type {UserRole} */ ("operator"));
  const [activeView, setActiveView] = useState("dashboard");
  const [backend, setBackend] = useState({
    status: "checking", // checking | online | offline
    message: "Checking backend connectivity…",
  });

  const [localState, setLocalState] = useState(() => {
    return loadLocalState() || makeDefaultLocalState();
  });

  const [snapshot, setSnapshot] = useState(() =>
    deriveSnapshotFromLocalState(loadLocalState() || makeDefaultLocalState())
  );

  const [events, setEvents] = useState(() => {
    const s = loadLocalState() || makeDefaultLocalState();
    return s.events || [];
  });

  const [toasts, setToasts] = useState([]);
  const wsRef = useRef(/** @type {WebSocket|null} */ (null));
  const clockRef = useRef(/** @type {number|null} */ (null));

  // Persist local state
  useEffect(() => {
    persistLocalState({ ...localState, events });
  }, [localState, events]);

  // Derive snapshot + alerts
  useEffect(() => {
    const snap = deriveSnapshotFromLocalState({ ...localState, events });
    setSnapshot(snap);
    const alerts = buildAlertsFromSnapshot(snap);
    setLocalState((prev) => ({ ...prev, alerts }));
  }, [localState.metrics, localState.line, localState.shift, events]);

  // Backend health probe
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const health = await tryBackendHealth(apiBase);
      if (cancelled) return;
      if (health.ok) {
        setBackend({ status: "online", message: health.reason });
      } else {
        setBackend({ status: "offline", message: health.reason });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // Optional: try to fetch dashboard snapshot when online
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (backend.status !== "online") return;
      const res = await tryFetchDashboard(apiBase);
      if (cancelled) return;
      if (res.ok && res.data) {
        // Best-effort mapping; accept common shapes
        const d = res.data;
        const next = {
          plannedTimeSec: Number(d.plannedTimeSec ?? d.planned_time_sec ?? localState.metrics.plannedTimeSec),
          runTimeSec: Number(d.runTimeSec ?? d.run_time_sec ?? localState.metrics.runTimeSec),
          idealCycleTimeSec: Number(d.idealCycleTimeSec ?? d.ideal_cycle_time_sec ?? localState.metrics.idealCycleTimeSec),
          totalCount: Number(d.totalCount ?? d.total_count ?? localState.metrics.totalCount),
          goodCount: Number(d.goodCount ?? d.good_count ?? localState.metrics.goodCount),
          rejectCount: Number(d.rejectCount ?? d.reject_count ?? localState.metrics.rejectCount),
          updatedAt: d.updatedAt ?? d.updated_at ?? nowIso(),
        };
        setLocalState((prev) => ({ ...prev, metrics: next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend.status]);

  // Realtime WS: listen for snapshot/event pushes; gracefully handle failures.
  useEffect(() => {
    if (backend.status !== "online") return;
    if (!wsUrl) return;

    let closedByUs = false;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setBackend((b) => ({ ...b, message: `Realtime connected: ${wsUrl}` }));
      };

      ws.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data);

          // Accept a few message formats:
          // 1) { type: "oee_snapshot", data: {...} }
          // 2) { type: "event", data: {...} }
          // 3) { ...snapshotFields }
          if (payload?.type === "oee_snapshot" && payload.data) {
            const d = payload.data;
            setLocalState((prev) => ({
              ...prev,
              metrics: {
                plannedTimeSec: Number(d.plannedTimeSec ?? prev.metrics.plannedTimeSec),
                runTimeSec: Number(d.runTimeSec ?? prev.metrics.runTimeSec),
                idealCycleTimeSec: Number(d.idealCycleTimeSec ?? prev.metrics.idealCycleTimeSec),
                totalCount: Number(d.totalCount ?? prev.metrics.totalCount),
                goodCount: Number(d.goodCount ?? prev.metrics.goodCount),
                rejectCount: Number(d.rejectCount ?? prev.metrics.rejectCount),
                updatedAt: d.updatedAt ?? nowIso(),
              },
            }));
            return;
          }

          if (payload?.type === "event" && payload.data) {
            const e = payload.data;
            setEvents((prev) => [
              {
                id: e.id || newEventId(),
                createdAt: e.createdAt || nowIso(),
                lineId: e.lineId || localState.line.id,
                shiftId: e.shiftId || localState.shift.id,
                type: e.type || "note",
                quantity: e.quantity,
                reason: e.reason,
                note: e.note,
              },
              ...prev,
            ]);
            return;
          }

          // If payload looks like snapshot directly
          if (typeof payload === "object" && payload) {
            const d = payload;
            if (
              "availability" in d ||
              "oee" in d ||
              "goodCount" in d ||
              "totalCount" in d
            ) {
              setLocalState((prev) => ({
                ...prev,
                metrics: {
                  plannedTimeSec: Number(d.plannedTimeSec ?? prev.metrics.plannedTimeSec),
                  runTimeSec: Number(d.runTimeSec ?? prev.metrics.runTimeSec),
                  idealCycleTimeSec: Number(d.idealCycleTimeSec ?? prev.metrics.idealCycleTimeSec),
                  totalCount: Number(d.totalCount ?? prev.metrics.totalCount),
                  goodCount: Number(d.goodCount ?? prev.metrics.goodCount),
                  rejectCount: Number(d.rejectCount ?? prev.metrics.rejectCount),
                  updatedAt: d.updatedAt ?? nowIso(),
                },
              }));
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        setBackend((b) => ({
          ...b,
          message: "Realtime error. Falling back to polling/local updates.",
        }));
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!closedByUs) {
          setBackend((b) => ({
            ...b,
            message: "Realtime disconnected. Using local updates.",
          }));
        }
      };

      return () => {
        closedByUs = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
    } catch {
      setBackend((b) => ({
        ...b,
        message: "Realtime not available. Using local updates.",
      }));
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend.status, wsUrl]);

  // Local clock tick to simulate runtime accumulation in offline mode
  useEffect(() => {
    if (clockRef.current) window.clearInterval(clockRef.current);
    clockRef.current = window.setInterval(() => {
      // If backend is offline, we still want the dashboard to feel alive:
      // - when machine is running, accrue runTimeSec
      // - when in downtime, do not accrue runtime
      setLocalState((prev) => {
        const state = prev.machine.state;
        const shouldRun = state === "running";
        const runTimeSec = prev.metrics.runTimeSec + (shouldRun ? 1 : 0);
        return {
          ...prev,
          metrics: { ...prev.metrics, runTimeSec, updatedAt: nowIso() },
        };
      });
    }, 1000);

    return () => {
      if (clockRef.current) window.clearInterval(clockRef.current);
    };
  }, []);

  function pushToast(tone, title, message) {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [{ id, tone, title, message }, ...prev].slice(0, 3));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }

  function setMachineState(nextState, reason = "") {
    setLocalState((prev) => {
      const prevState = prev.machine.state;
      const now = nowIso();
      // If entering downtime: record start; if leaving downtime: record end.
      let nextMachine = { ...prev.machine, state: nextState };
      const nextEvents = [];

      if (prevState === "running" && nextState !== "running") {
        nextMachine = {
          ...nextMachine,
          downtimeReason: reason,
          downtimeStartedAt: now,
        };
        nextEvents.push({
          id: newEventId(),
          createdAt: now,
          lineId: prev.line.id,
          shiftId: prev.shift.id,
          type: "downtime_start",
          reason: reason || "Downtime",
        });
      } else if (prevState !== "running" && nextState === "running") {
        nextMachine = {
          ...nextMachine,
          downtimeReason: "",
          downtimeStartedAt: null,
        };
        nextEvents.push({
          id: newEventId(),
          createdAt: now,
          lineId: prev.line.id,
          shiftId: prev.shift.id,
          type: "downtime_end",
          reason: prev.machine.downtimeReason || "Resume",
        });
      }

      if (nextEvents.length) {
        setEvents((evts) => [...nextEvents, ...evts]);
      }

      return { ...prev, machine: nextMachine };
    });
  }

  async function submitEvent(evt) {
    // Always apply locally for responsiveness.
    setEvents((prev) => [evt, ...prev]);

    if (backend.status !== "online" || !apiBase) {
      pushToast(
        "warning",
        "Saved locally",
        "Backend unavailable. This event is stored locally and will appear in your local report."
      );
      return;
    }

    const res = await tryPostEvent(apiBase, evt);
    if (res.ok) {
      pushToast("success", "Event submitted", "Event was sent to the backend.");
    } else {
      pushToast(
        "warning",
        "Stored locally",
        "Could not reach backend event endpoint. Event kept locally."
      );
    }
  }

  function applyCountDelta(type, quantity) {
    const q = Math.max(0, Math.round(Number(quantity || 0)));
    if (!q) return;

    setLocalState((prev) => {
      const totalCount = prev.metrics.totalCount + q;
      const goodCount =
        type === "good_count" ? prev.metrics.goodCount + q : prev.metrics.goodCount;
      const rejectCount =
        type === "reject_count" ? prev.metrics.rejectCount + q : prev.metrics.rejectCount;

      return {
        ...prev,
        metrics: {
          ...prev.metrics,
          totalCount,
          goodCount,
          rejectCount,
          updatedAt: nowIso(),
        },
      };
    });
  }

  function resetLocalDemoData() {
    const next = makeDefaultLocalState();
    setLocalState(next);
    setEvents([]);
    persistLocalState({ ...next, events: [] });
    pushToast("info", "Reset complete", "Local demo data has been reset.");
  }

  const nav = useMemo(() => {
    const base = [
      { key: "dashboard", label: "Dashboard", icon: "dashboard", roles: ["operator", "supervisor", "manager"] },
      { key: "log", label: "Log Event", icon: "log", roles: ["operator", "supervisor"] },
      { key: "alerts", label: "Alerts", icon: "alerts", roles: ["supervisor", "manager"] },
      { key: "report", label: "Shift Report", icon: "report", roles: ["supervisor", "manager"] },
      { key: "settings", label: "Settings", icon: "settings", roles: ["operator", "supervisor", "manager"] },
    ];
    return base.filter((i) => i.roles.includes(role));
  }, [role]);

  const topKpiTone = useMemo(() => {
    if (snapshot.oee >= 0.75) return "success";
    if (snapshot.oee >= 0.6) return "warning";
    return "error";
  }, [snapshot.oee]);

  const primaryCtaEnabled = role === "operator" || role === "supervisor";

  const connectionPill = useMemo(() => {
    if (backend.status === "online") return { tone: "success", text: "Online" };
    if (backend.status === "checking") return { tone: "info", text: "Checking" };
    return { tone: "warning", text: "Offline (Local mode)" };
  }, [backend.status]);

  return (
    <div className="oee-app" style={{ background: THEME.background, color: THEME.text }}>
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            OEE
          </div>
          <div className="brand-text">
            <div className="brand-title">Manufacturing OEE Tracker</div>
            <div className="brand-subtitle">
              Real-time Availability • Performance • Quality
            </div>
          </div>
        </div>

        <div className="topbar-right">
          <div className="topbar-meta">
            <div className="meta-row">
              <span className={`pill pill-${connectionPill.tone}`}>{connectionPill.text}</span>
              <span className="meta-muted">{localState.line.name}</span>
              <span className="dot">•</span>
              <span className="meta-muted">{localState.shift.name}</span>
            </div>
            <div className="meta-row meta-muted small">
              {backend.message}
            </div>
          </div>

          <div className="role-switch">
            <label className="label" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              className="select"
              value={role}
              onChange={(e) => {
                const next = /** @type {UserRole} */ (e.target.value);
                setRole(next);
                // Keep view valid for role
                setActiveView((v) => {
                  const allowed = nav.map((n) => n.key);
                  return allowed.includes(v) ? v : "dashboard";
                });
              }}
            >
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
              <option value="manager">Manager</option>
            </select>
            <RolePill role={role} />
          </div>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar" aria-label="Sidebar navigation">
          <div className="sidebar-section">
            <div className="sidebar-title">Navigation</div>
            <div className="nav">
              {nav.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${activeView === item.key ? "active" : ""}`}
                  onClick={() => setActiveView(item.key)}
                >
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-title">Machine</div>
            <div className="machine-card card">
              <div className="machine-row">
                <div className="machine-label">State</div>
                <div className="machine-value">
                  <span className={`pill pill-${localState.machine.state === "running" ? "success" : "warning"}`}>
                    {localState.machine.state.replace("_", " ")}
                  </span>
                </div>
              </div>

              <div className="machine-actions">
                <button
                  className="btn btn-primary"
                  disabled={!primaryCtaEnabled}
                  onClick={() => setMachineState("running")}
                >
                  Resume
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={!primaryCtaEnabled}
                  onClick={() => {
                    const reason = window.prompt("Downtime reason (e.g., jam, maintenance, changeover):", "Jam");
                    if (reason === null) return;
                    setMachineState("unplanned_downtime", reason);
                  }}
                >
                  Downtime
                </button>
              </div>

              <div className="machine-note small meta-muted">
                In offline/local mode, runtime is simulated while running to keep dashboards responsive.
              </div>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-title">Quick actions</div>
            <div className="quick-actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  // Refresh backend status
                  setBackend({ status: "checking", message: "Re-checking backend…" });
                  (async () => {
                    const health = await tryBackendHealth(apiBase);
                    if (health.ok) setBackend({ status: "online", message: health.reason });
                    else setBackend({ status: "offline", message: health.reason });
                  })();
                }}
              >
                <Icon name="plug" /> Re-check backend
              </button>
              <button className="btn btn-ghost" onClick={resetLocalDemoData}>
                Reset local demo data
              </button>
            </div>
          </div>
        </aside>

        <main className="main" aria-label="Main content">
          {activeView === "dashboard" ? (
            <DashboardView snapshot={snapshot} localState={localState} />
          ) : null}

          {activeView === "log" ? (
            <LogEventView
              disabled={!primaryCtaEnabled}
              lineId={localState.line.id}
              shiftId={localState.shift.id}
              onSubmit={async (evt) => {
                // Update aggregate counts for good/reject entries (local always)
                if (evt.type === "good_count" || evt.type === "reject_count") {
                  applyCountDelta(evt.type, evt.quantity || 0);
                }
                await submitEvent(evt);
              }}
            />
          ) : null}

          {activeView === "alerts" ? (
            <AlertsView alerts={localState.alerts || []} />
          ) : null}

          {activeView === "report" ? (
            <ReportView snapshot={snapshot} events={events} />
          ) : null}

          {activeView === "settings" ? (
            <SettingsView
              apiBase={apiBase}
              wsUrl={wsUrl}
              localState={localState}
              onUpdateLocalState={setLocalState}
            />
          ) : null}

          <section className="card subtle">
            <div className="help-title">How OEE is calculated</div>
            <div className="help-grid">
              <div className="help-item">
                <div className="help-label">Availability</div>
                <div className="help-text">Run Time / Planned Production Time</div>
              </div>
              <div className="help-item">
                <div className="help-label">Performance</div>
                <div className="help-text">(Ideal Cycle Time × Total Count) / Run Time</div>
              </div>
              <div className="help-item">
                <div className="help-label">Quality</div>
                <div className="help-text">Good Count / Total Count</div>
              </div>
              <div className="help-item">
                <div className="help-label">OEE</div>
                <div className="help-text">Availability × Performance × Quality</div>
              </div>
            </div>
          </section>
        </main>
      </div>

      <div className="toast-stack" aria-live="polite" aria-relevant="additions removals">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            tone={t.tone}
            title={t.title}
            message={t.message}
            onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          />
        ))}
      </div>

      <footer className="footer">
        <div className="footer-left">
          <span className="meta-muted small">
            Frontend URL: {process.env.REACT_APP_FRONTEND_URL || "—"}
          </span>
        </div>
        <div className="footer-right">
          <span className="meta-muted small">
            API: {apiBase || "Not configured"} • WS: {wsUrl || "Not configured"}
          </span>
        </div>
      </footer>
    </div>
  );
}

function DashboardView({ snapshot, localState }) {
  const tone = snapshot.oee >= 0.75 ? "success" : snapshot.oee >= 0.6 ? "warning" : "error";
  const oeeValue = pct(snapshot.oee);

  return (
    <section className="content-section">
      <div className="section-header">
        <div>
          <div className="section-title">Dashboard</div>
          <div className="section-subtitle">
            Live OEE and shift performance at a glance
          </div>
        </div>
        <div className="section-right">
          <span className="meta-muted small">Updated {new Date(snapshot.updatedAt).toLocaleTimeString()}</span>
        </div>
      </div>

      <div className="grid-3">
        <MetricCard
          title="OEE"
          value={oeeValue}
          tone={tone}
          hint="Overall Equipment Effectiveness"
          subvalue={`${pct(snapshot.availability)} A • ${pct(snapshot.performance)} P • ${pct(snapshot.quality)} Q`}
        />
        <MetricCard
          title="Good Units"
          value={formatNumber(snapshot.goodCount)}
          subvalue={`Total: ${formatNumber(snapshot.totalCount)} • Rejects: ${formatNumber(snapshot.rejectCount)}`}
          hint="Counts (this shift)"
        />
        <MetricCard
          title="Run Time"
          value={formatDurationSec(snapshot.runTimeSec)}
          subvalue={`Planned: ${formatDurationSec(snapshot.plannedTimeSec)} • Ideal CT: ${snapshot.idealCycleTimeSec.toFixed(2)}s`}
          hint="Time-based metrics"
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">OEE Components</div>
              <div className="card-subtitle">Where losses are occurring</div>
            </div>
          </div>
          <div className="card-body">
            <ProgressBar label="Availability" value01={snapshot.availability} tone="primary" />
            <ProgressBar label="Performance" value01={snapshot.performance} tone="secondary" />
            <ProgressBar label="Quality" value01={snapshot.quality} tone="success" />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Current Status</div>
              <div className="card-subtitle">Operational context</div>
            </div>
          </div>
          <div className="card-body">
            <div className="kv">
              <div className="kv-row">
                <div className="kv-key">Machine state</div>
                <div className="kv-val">
                  <span className={`pill pill-${localState.machine.state === "running" ? "success" : "warning"}`}>
                    {localState.machine.state.replace("_", " ")}
                  </span>
                </div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Downtime reason</div>
                <div className="kv-val">{localState.machine.downtimeReason || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Shift</div>
                <div className="kv-val">{localState.shift.name}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Line</div>
                <div className="kv-val">{localState.line.name}</div>
              </div>
            </div>

            <div className="divider" />

            <div className="card-note">
              Tip: Use <strong>Log Event</strong> to record good/reject counts and downtime.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LogEventView({ disabled, lineId, shiftId, onSubmit }) {
  const [type, setType] = useState(/** @type {EventType} */ ("good_count"));
  const [quantity, setQuantity] = useState(10);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const showQuantity = type === "good_count" || type === "reject_count";
  const showReason = type === "downtime_start" || type === "downtime_end";
  const showNote = type === "note";

  async function handleSubmit(e) {
    e.preventDefault();
    if (disabled) return;

    const evt = /** @type {ProductionEvent} */ ({
      id: newEventId(),
      createdAt: nowIso(),
      lineId,
      shiftId,
      type,
      quantity: showQuantity ? Math.max(0, Math.round(Number(quantity || 0))) : undefined,
      reason: showReason ? (reason || "").trim() : undefined,
      note: showNote ? (note || "").trim() : undefined,
    });

    setSubmitting(true);
    try {
      await onSubmit(evt);
      // Reset fields for smooth repetitive logging
      setReason("");
      setNote("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content-section">
      <div className="section-header">
        <div>
          <div className="section-title">Log Production Event</div>
          <div className="section-subtitle">
            Fast operator entry for counts, downtime, and notes
          </div>
        </div>
      </div>

      <div className="grid-2">
        <form className="card" onSubmit={handleSubmit}>
          <div className="card-header">
            <div>
              <div className="card-title">New event</div>
              <div className="card-subtitle">Applies to current line/shift</div>
            </div>
          </div>

          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label className="label" htmlFor="eventType">
                  Event type
                </label>
                <select
                  id="eventType"
                  className="select"
                  value={type}
                  onChange={(e) => setType(/** @type {EventType} */ (e.target.value))}
                  disabled={disabled || submitting}
                >
                  <option value="good_count">Good count</option>
                  <option value="reject_count">Reject count</option>
                  <option value="downtime_start">Downtime start</option>
                  <option value="downtime_end">Downtime end</option>
                  <option value="note">Note</option>
                </select>
              </div>

              {showQuantity ? (
                <div className="field">
                  <label className="label" htmlFor="qty">
                    Quantity
                  </label>
                  <input
                    id="qty"
                    className="input"
                    type="number"
                    min={0}
                    step={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    disabled={disabled || submitting}
                  />
                </div>
              ) : null}

              {showReason ? (
                <div className="field field-span-2">
                  <label className="label" htmlFor="reason">
                    Reason
                  </label>
                  <input
                    id="reason"
                    className="input"
                    placeholder="e.g., Jam, Maintenance, Changeover"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={disabled || submitting}
                  />
                </div>
              ) : null}

              {showNote ? (
                <div className="field field-span-2">
                  <label className="label" htmlFor="note">
                    Note
                  </label>
                  <textarea
                    id="note"
                    className="textarea"
                    placeholder="Add context for the shift (quality concern, material issue, etc.)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={disabled || submitting}
                    rows={4}
                  />
                </div>
              ) : null}
            </div>

            <div className="form-actions">
              <button
                className="btn btn-primary"
                type="submit"
                disabled={disabled || submitting}
              >
                {submitting ? "Submitting…" : "Submit event"}
              </button>

              {disabled ? (
                <div className="meta-muted small">
                  Event logging is disabled for this role.
                </div>
              ) : (
                <div className="meta-muted small">
                  Works offline: events are stored locally if backend is unavailable.
                </div>
              )}
            </div>
          </div>
        </form>

        <div className="card subtle">
          <div className="card-header">
            <div>
              <div className="card-title">Operator guidance</div>
              <div className="card-subtitle">For consistent event quality</div>
            </div>
          </div>
          <div className="card-body">
            <ul className="bullets">
              <li>Log <strong>good</strong> and <strong>reject</strong> counts as frequently as practical.</li>
              <li>For downtime, include a short reason (jam, no material, maintenance, etc.).</li>
              <li>Use notes for anything that might explain OEE swings.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function AlertsView({ alerts }) {
  return (
    <section className="content-section">
      <div className="section-header">
        <div>
          <div className="section-title">Alerts</div>
          <div className="section-subtitle">Auto-generated insights from OEE thresholds</div>
        </div>
      </div>

      <div className="grid-2">
        {(alerts || []).length === 0 ? (
          <div className="card">
            <div className="card-body">
              <div className="empty">
                <div className="empty-title">No active alerts</div>
                <div className="empty-subtitle">OEE metrics are within normal thresholds.</div>
              </div>
            </div>
          </div>
        ) : (
          (alerts || []).map((a) => (
            <div key={a.id} className={`card alert-card alert-${a.severity}`}>
              <div className="card-header">
                <div className="card-title">{a.title}</div>
                <Badge tone={a.severity === "error" ? "danger" : a.severity === "warning" ? "warning" : "info"}>
                  {a.severity}
                </Badge>
              </div>
              <div className="card-body">
                <div className="alert-message">{a.message}</div>
              </div>
            </div>
          ))
        )}

        <div className="card subtle">
          <div className="card-header">
            <div>
              <div className="card-title">Supervisor playbook</div>
              <div className="card-subtitle">Suggested actions</div>
            </div>
          </div>
          <div className="card-body">
            <ul className="bullets">
              <li>Investigate downtime clusters: reason codes, start/end frequency, and response time.</li>
              <li>Check reject trends: inspection station, tooling wear, and material lot changes.</li>
              <li>Use shift report to compare performance across hours and lines.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReportView({ snapshot, events }) {
  const rows = (events || []).slice(0, 30).map((e) => ({
    _key: e.id,
    ...e,
  }));

  const columns = [
    { key: "time", header: "Time", render: (r) => new Date(r.createdAt).toLocaleTimeString() },
    { key: "type", header: "Type", render: (r) => <span className="mono">{r.type}</span> },
    { key: "qty", header: "Qty", render: (r) => (r.quantity != null ? formatNumber(r.quantity) : "—") },
    { key: "reason", header: "Reason", render: (r) => r.reason || "—" },
    { key: "note", header: "Note", render: (r) => r.note || "—" },
  ];

  return (
    <section className="content-section">
      <div className="section-header">
        <div>
          <div className="section-title">Shift Report</div>
          <div className="section-subtitle">Summary + recent events (local and realtime)</div>
        </div>
      </div>

      <div className="grid-3">
        <MetricCard title="Availability" value={pct(snapshot.availability)} hint="Run time vs planned time" />
        <MetricCard title="Performance" value={pct(snapshot.performance)} hint="Speed loss vs ideal cycle" />
        <MetricCard title="Quality" value={pct(snapshot.quality)} hint="Good vs total" />
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Recent events</div>
            <div className="card-subtitle">Showing latest 30 events</div>
          </div>
        </div>
        <div className="card-body">
          <Table columns={columns} rows={rows} emptyText="No events logged yet." />
        </div>
      </div>
    </section>
  );
}

function SettingsView({ apiBase, wsUrl, localState, onUpdateLocalState }) {
  const [plannedHours, setPlannedHours] = useState(localState.metrics.plannedTimeSec / 3600);
  const [idealCycle, setIdealCycle] = useState(localState.metrics.idealCycleTimeSec);

  useEffect(() => {
    setPlannedHours(localState.metrics.plannedTimeSec / 3600);
    setIdealCycle(localState.metrics.idealCycleTimeSec);
  }, [localState.metrics.plannedTimeSec, localState.metrics.idealCycleTimeSec]);

  return (
    <section className="content-section">
      <div className="section-header">
        <div>
          <div className="section-title">Settings</div>
          <div className="section-subtitle">Shift parameters and connectivity info</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Shift parameters</div>
              <div className="card-subtitle">Used for OEE calculation in local mode</div>
            </div>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label className="label" htmlFor="plannedHours">
                  Planned production time (hours)
                </label>
                <input
                  id="plannedHours"
                  className="input"
                  type="number"
                  min={0}
                  step={0.25}
                  value={plannedHours}
                  onChange={(e) => setPlannedHours(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="idealCycle">
                  Ideal cycle time (sec / unit)
                </label>
                <input
                  id="idealCycle"
                  className="input"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={idealCycle}
                  onChange={(e) => setIdealCycle(e.target.value)}
                />
              </div>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  const planned = Math.max(0, Number(plannedHours || 0)) * 3600;
                  const ict = Math.max(0.01, Number(idealCycle || 0.01));
                  onUpdateLocalState((prev) => ({
                    ...prev,
                    metrics: {
                      ...prev.metrics,
                      plannedTimeSec: planned,
                      idealCycleTimeSec: ict,
                      updatedAt: nowIso(),
                    },
                  }));
                }}
              >
                Save parameters
              </button>
              <div className="meta-muted small">
                These settings affect Availability and Performance calculations.
              </div>
            </div>
          </div>
        </div>

        <div className="card subtle">
          <div className="card-header">
            <div>
              <div className="card-title">Connectivity</div>
              <div className="card-subtitle">Derived from environment variables</div>
            </div>
          </div>
          <div className="card-body">
            <div className="kv">
              <div className="kv-row">
                <div className="kv-key">REACT_APP_API_BASE</div>
                <div className="kv-val mono">{process.env.REACT_APP_API_BASE || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">REACT_APP_BACKEND_URL</div>
                <div className="kv-val mono">{process.env.REACT_APP_BACKEND_URL || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">API base (resolved)</div>
                <div className="kv-val mono">{apiBase || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">WS url (resolved)</div>
                <div className="kv-val mono">{wsUrl || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Environment</div>
                <div className="kv-val mono">{process.env.REACT_APP_NODE_ENV || process.env.NODE_ENV || "—"}</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Log level</div>
                <div className="kv-val mono">{process.env.REACT_APP_LOG_LEVEL || "—"}</div>
              </div>
            </div>

            <div className="divider" />

            <div className="card-note">
              If the backend doesn’t expose expected endpoints, the app automatically falls back to local mode and
              continues to function for demos and operator workflows.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default App;
