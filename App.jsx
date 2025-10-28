// /src/App.jsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./index.css";

import Header from "./components/Header.jsx";
import { ShiftBrush } from "./components/ShiftBrush.jsx";
import { PlanGrid } from "./components/PlanGrid.jsx";
import { Modals } from "./components/Modals.jsx";

import * as db from "./lib/db.js";
import { DEFAULT_SETTINGS, SHIFT_TYPES } from "./lib/constants.js";
import { getMonthId, isWorkday, calculateSollStunden } from "./lib/utils.js";


/* ============================================================
   ===  UNDO / REDO – stabile Diff-Hilfsfunktionen  ===========
   ============================================================ */

function makeDiff(oldPlan, newPlan) {
  const forward = {};
  const backward = {};
  const keys = new Set([
    ...Object.keys(oldPlan || {}),
    ...Object.keys(newPlan || {}),
  ]);

  for (const key of keys) {
    const oldShift = oldPlan?.[key]?.shift || "";
    const newShift = newPlan?.[key]?.shift || "";

    if (oldShift !== newShift) {
      forward[key] =
        newShift === ""
          ? undefined
          : { shift: newShift, locked: !!newPlan?.[key]?.locked };
      backward[key] =
        oldShift === ""
          ? undefined
          : { shift: oldShift, locked: !!oldPlan?.[key]?.locked };
    }
  }
  return { forward, backward };
}

function applyDiff(plan, diff) {
  const out = { ...plan };
  for (const [key, val] of Object.entries(diff)) {
    if (val === undefined) delete out[key];
    else out[key] = { ...(out[key] || {}), ...val };
  }
  return out;
}


// === PATCH: App.jsx – Verbesserter Auto‑Plan Algorithmus (familien‑ & freizeitfreundlich)
// Füge die folgenden Hilfsfunktionen und Ersetzungen in deine App.jsx ein.
// Suche nach den bestehenden Blöcken „AUTO‑PLANUNG – Utils“ und „handleAutoPlan“
// und ersetze die dortigen Funktionen durch diese Versionen.


/* ============================================================
=== AUTO‑PLANUNG – Zusätzliche Utils ======================
============================================================ */


// Montag=1 … Sonntag=7 – für KW‑Logik
function getDowMonBased(year, month, day) {
const dow = new Date(year, month, day).getDay(); // 0=So … 6=Sa
return dow === 0 ? 7 : dow; // 1..7
}


function getWeekStartDay(year, month, day) {
// Liefert den Kalendertag (im Monat) des Montags der Woche
const dow = getDowMonBased(year, month, day);
return Math.max(1, day - (dow - 1));
}


function isWeekend(year, month, day) {
const dow = getDowMonBased(year, month, day);
return dow === 6 || dow === 7; // Sa/So
}


function isWorkShift(shift) {
if (!shift) return false;
return !["F", "U", "FW", ""].includes(shift);
}


function consecutiveRunLength(plan, empId, day) {
// Zählt zusammenhängende Arbeitstage inklusive Lücke um 'day' herum
let left = 0;
let right = 0;
for (let d = day - 1; isWorkShift(plan[`${empId}-${d}`]?.shift); d--) left++;
for (let d = day + 1; isWorkShift(plan[`${empId}-${d}`]?.shift); d++) right++;
return { left, right, total: left + 1 + right };
}


function weekWorkCount(plan, empId, year, month, day) {
const start = getWeekStartDay(year, month, day);
let count = 0;
for (let i = 0; i < 7; i++) {
const d = start + i;
if (isWorkShift(plan[`${empId}-${d}`]?.shift)) count++;
}
return count;
}


function weekendsWorked(plan, empId, month, year) {
const weekends = new Set();
const daysInMonth = new Date(year, month + 1, 0).getDate();
for (let d = 1; d <= daysInMonth; d++) {
if (isWeekend(year, month, d) && isWorkShift(plan[`${empId}-${d}`]?.shift)) {
weekends.add(Math.floor((d - 1) / 7));
}
}
return weekends.size;
}


function nearestAssignmentDistance(plan, empId, day) {
// Große Distanz => gute zeitliche Streuung
const assignedDays = Object.keys(plan)
.filter((k) => k.startsWith(empId + "-") && isWorkShift(plan[k]?.shift))
.map((k) => parseInt(k.split("-")[1], 10));
if (assignedDays.length === 0) return 31; // besser geht's nicht
let minDist = 31;
for (const d of assignedDays) minDist = Math.min(minDist, Math.abs(d - day));
return minDist;
}


function wouldCreateWFWSandwich(plan, empId, day) {
// Vermeidet lange Muster wie W F W F W (nur einzelne freie Tage zwischen Arbeit)
const p2 = plan[`${empId}-${day - 2}`]?.shift;
const p1 = plan[`${empId}-${day - 1}`]?.shift;
const n1 = plan[`${empId}-${day + 1}`]?.shift;
const n2 = plan[`${empId}-${day + 2}`]?.shift;
const isW = (s) => isWorkShift(s);
const isF = (s) => !isWorkShift(s);
}

/* ============================================================
   ===  HAUPTKOMPONENTE ======================================
   ============================================================ */

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [plan, setPlan] = useState({});
  const [dailyNeeds, setDailyNeeds] = useState({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activeBrush, setActiveBrush] = useState("TR");
  const [modal, setModal] = useState({ name: null, data: null });
  const [history, setHistory] = useState({ past: [], future: [] });
  const [validations, setValidations] = useState({});
  const isMouseDown = useRef(false);
  const fileInputRef = useRef(null);
  // === ONLINE-SYNC (PHP + MySQL) ===
   // <-- anpassen!
                            // <-- aus deiner config.php


// ============================================================
// ===  Plan auf den Server hochladen (sicher, JSON-kompatibel)
// ============================================================
async function handleSyncUpload(team="default") {
    const month=currentDate.getMonth()+1; const year=currentDate.getFullYear();
    const payload={team,month,year,plan};
    try {
      const j = await apiFetch("save_plan.php", { method:"POST", body: JSON.stringify(payload) });
      alert(j?.status==="ok" ? "Plan hochgeladen ✅" : "Fehler beim Upload ⚠️");
    } catch(e){
      console.error(e); alert("Fehler beim Upload ⚠️");
    }
  }
}
// ============================================================
// ===  Plan vom Server laden (JSON-kompatibel, PHP-Backend) ===
// ============================================================
async function handleSyncDownload(team="default"){
    const month=currentDate.getMonth()+1; const year=currentDate.getFullYear();
    try {
      const j = await apiFetch(`load_plan.php?team=${team}&month=${month}&year=${year}`);
      if(j?.plan_json){ setPlan(j.plan_json); alert("Plan geladen ✅"); }
      else alert("Kein Plan ⚠️");
    } catch(e){
      console.error(e); alert("Fehler beim Laden ⚠️");
    }
  }
}



  /* ============================================================
     ===  DATEN LADEN & INITIALISIEREN ========================== */
  useEffect(() => {
    async function loadData() {
      try {
        await db.init();

        let [emps, settingsData, planData] = await Promise.all([
          db.getAll("employees"),
          db.get("settings", "main"),
          db.get("plans", getMonthId(new Date())),
        ]);

        // Dummy-Mitarbeiter anlegen, falls leer
        if (!emps || emps.length === 0) {
          emps = [
            ...Array.from({ length: 12 }, (_, i) => ({
              id: `emp_100_${i}`,
              name: `Mitarbeiter ${String.fromCharCode(65 + i)}`,
              percentage: 100,
              sollWochenstunden: 39,
              maxWochenstunden: 48,
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
              id: `emp_50_${i}`,
              name: `Teilzeit ${i + 1}`,
              percentage: 50,
              sollWochenstunden: 19.5,
              maxWochenstunden: 30,
            })),
          ];
          for (const e of emps) await db.put("employees", e);
        }
        setEmployees(emps);

        // Settings mergen
        if (settingsData && typeof settingsData === "object") {
          setSettings({
            ...DEFAULT_SETTINGS,
            ...settingsData,
            shiftHours: settingsData.shiftHours || {},
            masterDemand: settingsData.masterDemand || {},
            shiftColors: settingsData.shiftColors || {},
          });
        }

        if (planData) {
          setPlan(planData.plan || {});
          setDailyNeeds(planData.dailyNeeds || {});
        }
      } catch (err) {
        console.error("Load error:", err);
        alert("Fehler beim Laden der Daten: " + err.message);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();

    const mouseUp = () => (isMouseDown.current = false);
    window.addEventListener("mouseup", mouseUp);
    return () => window.removeEventListener("mouseup", mouseUp);
  }, []);

  /* ============================================================
     ===  AUTO-BACKUP & THEME ================================== */
  useEffect(() => {
    const stop = db.startAutoBackup(30);
    return () => stop();
  }, []);

  useEffect(() => {
    document.body.className = settings.theme === "dark" ? "dark-mode" : "";
  }, [settings.theme]);

  /* ============================================================
     ===  AUTO-SAVE: Plan & Bedarf pro Monat ==================== */
  useEffect(() => {
    if (isLoading) return;
    db.put("plans", {
      monthId: getMonthId(currentDate),
      plan,
      dailyNeeds,
    }).catch((e) => console.error("Autosave fehlgeschlagen:", e));
  }, [plan, dailyNeeds, currentDate, isLoading]);

  /* ============================================================
     ===  PLAN-HILFSFUNKTIONEN ================================= */
  const getShiftHoursWithSettings = useCallback(
    (planObj, empId, day, month, year) => {
      const planKey = `${empId}-${day}`;
      const shiftKey = planObj[planKey]?.shift;
      if (!shiftKey) return 0;
      const hours =
        settings.shiftHours?.[shiftKey] ?? SHIFT_TYPES[shiftKey]?.hours ?? 0;
      // Urlaub an Wochenenden nicht werten (optional)
      return shiftKey === "U" && !isWorkday(new Date(year, month, day))
        ? 0
        : hours;
    },
    [settings.shiftHours]
  );

  const summaryData = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const data = {};
    for (const emp of employees) {
      const days = new Date(year, month + 1, 0).getDate();
      let ist = 0;
      for (let d = 1; d <= days; d++)
        ist += getShiftHoursWithSettings(plan, emp.id, d, month, year);
      const soll = calculateSollStunden(emp.percentage, year, month);
      const urlaub = Object.keys(plan).filter(
        (k) => k.startsWith(emp.id + "-") && plan[k].shift === "U"
      ).length;
      data[emp.id] = { soll, ist, delta: ist - soll, u: urlaub };
    }
    return data;
  }, [employees, plan, currentDate, settings.shiftHours, getShiftHoursWithSettings]);

  /* ============================================================
     ===  SIMPLE VALIDIERUNGEN ================================== */
  useEffect(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const v = {};
    for (const emp of employees) {
      const days = new Date(year, month + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const key = `${emp.id}-${d}`;
        const shift = plan[key]?.shift;
        if (!shift) continue;

        const prev = plan[`${emp.id}-${d - 1}`]?.shift;
        // Warnung: Tag direkt nach Nacht
        const isNight = (s) => s === "NR" || s === "VN";
        const isDay = (s) => ["TR", "VT", "T39", "V39"].includes(s);
        if (isNight(prev) && isDay(shift)) {
          v[key] = { type: "warning", message: "Tag direkt nach Nacht" };
        }
      }
    }
    setValidations(v);
  }, [plan, employees, currentDate]);

/* ============================================================
   ===  ALLE SCHICHTEN LÖSCHEN ================================
   ============================================================ */
const handleClearPlan = () => {
  if (!confirm("Wirklich alle Schichten im aktuellen Monat löschen?")) return;
  applyPlanUpdateWithHistory(() => ({})); // leert den Plan
  alert("Alle Schichten im aktuellen Monat wurden gelöscht.");
};


  /* ============================================================
     ===  UNDO / REDO  ========================================== */
  const applyPlanUpdateWithHistory = (updater) => {
    setPlan((prevPlan) => {
      const next = typeof updater === "function" ? updater(prevPlan) : updater;
      const { forward, backward } = makeDiff(prevPlan, next);
      if (Object.keys(forward).length > 0 || Object.keys(backward).length > 0) {
        setHistory((h) => ({
          past: [...h.past, { forward, backward }],
          future: [],
        }));
      }
      return next;
    });
  };

  const handleUndo = () => {
    if (history.past.length === 0) return;
    const last = history.past[history.past.length - 1];
    setPlan((p) => applyDiff(p, last.backward));
    setHistory((h) => ({
      past: h.past.slice(0, -1),
      future: [...h.future, last],
    }));
  };

  const handleRedo = () => {
    if (history.future.length === 0) return;
    const last = history.future[history.future.length - 1];
    setPlan((p) => applyDiff(p, last.forward));
    setHistory((h) => ({
      past: [...h.past, last],
      future: h.future.slice(0, -1),
    }));
  };

  /* ============================================================
     ===  INTERAKTION IM GRID  ================================= */
  const handleCellInteraction = (type, empId, day, mouseEvent) => {
    const key = `${empId}-${day}`;

    // Rechtsklick = Zelle leeren & entsperren
    if (mouseEvent?.type === "contextmenu") {
      mouseEvent.preventDefault();
      applyPlanUpdateWithHistory((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    if (type === "down") {
      isMouseDown.current = true;
      applyPlanUpdateWithHistory((prev) => ({
        ...prev,
        [key]: { shift: activeBrush, locked: true },
      }));
      return;
    }
    if (type === "over" && isMouseDown.current) {
      applyPlanUpdateWithHistory((prev) => {
        const curr = prev[key]?.shift;
        if (curr === activeBrush) return prev;
        return { ...prev, [key]: { shift: activeBrush, locked: true } };
      });
    }
  };

  /* ============================================================
     ===  HANDLER: Monatswechsel / Backup ======================= */
  const handleMonthChange = async (offset) => {
    // aktuellen Monat persistieren
    await db.put("plans", { monthId: getMonthId(currentDate), plan, dailyNeeds });

    // Zielmonat laden
    const newDate = new Date(currentDate);
    newDate.setDate(1);
    newDate.setMonth(newDate.getMonth() + offset);
    const next = await db.get("plans", getMonthId(newDate));
    setPlan(next?.plan || {});
    setDailyNeeds(next?.dailyNeeds || {});
    setCurrentDate(newDate);
    setHistory({ past: [], future: [] });
  };

  const handleBackup = async () => {
    try {
      await db.saveBackup();
      alert("Backup wurde erfolgreich gespeichert.");
    } catch (err) {
      console.error("Backup-Fehler:", err);
      alert("Backup konnte nicht gespeichert werden.");
    }
  };

  const handleExportPDF = () => {
    const { jsPDF } = window.jspdf; // über CDN
    const doc = new jsPDF({ orientation: "landscape" });

    const year = currentDate.getFullYear();
    const monthName = currentDate.toLocaleString("de-DE", { month: "long" });
    doc.setFontSize(14);
    doc.text(`Dienstplan – ${monthName} ${year}`, 14, 15);

    // CSS-Farbe lesen und nach RGB umwandeln
    const cssVar = (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const hexToRgb = (hex) => {
      const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
    };

    // Schichtfarben
    const shiftColors = {
      TR: hexToRgb(cssVar("--schicht-tr") || "#cfe2ff"),
      VT: hexToRgb(cssVar("--schicht-vt") || "#e9d8fd"),
      NR: hexToRgb(cssVar("--schicht-nr") || "#fff3cd"),
      VN: hexToRgb(cssVar("--schicht-vn") || "#ffdac2"),
      F: hexToRgb(cssVar("--schicht-f") || "#f8f9fa"),
      U: hexToRgb(cssVar("--schicht-u") || "#f8d7da"),
      FW: hexToRgb(cssVar("--schicht-fw") || "#d1e7dd"),
      T39: hexToRgb(cssVar("--schicht-t39") || "#cff4fc"),
      V39: hexToRgb(cssVar("--schicht-v39") || "#d2f4ea"),
      LR: hexToRgb(cssVar("--schicht-lr") || "#e2d9f3"),
      AVT: hexToRgb(cssVar("--schicht-avt") || "#cfe2ff"),
      AVN: hexToRgb(cssVar("--schicht-avn") || "#f5e8d7"),
    };

    const daysInMonth = new Date(year, currentDate.getMonth() + 1, 0).getDate();
    const tableHead = ["Mitarbeiter"];
    for (let i = 1; i <= daysInMonth; i++) tableHead.push(String(i));
    tableHead.push("Soll", "Ist", "Δ", "U");

    const tableBody = employees.map((emp) => {
      const row = [emp.name];
      for (let i = 1; i <= daysInMonth; i++) {
        const key = `${emp.id}-${i}`;
        row.push(plan[key]?.shift || "");
      }
      const s = summaryData[emp.id] || {};
      row.push(
        (s.soll || 0).toFixed(1),
        (s.ist || 0).toFixed(1),
        (s.delta || 0).toFixed(1),
        s.u || 0
      );
      return row;
    });

    // farbige Zellen
    const bodyCellStyle = (cell) => {
      const value = cell.raw;
      const color = shiftColors[value];
      if (color) {
        cell.styles.fillColor = color;
      } else {
        cell.styles.fillColor = [255, 255, 255];
      }
    };

    doc.autoTable({
      head: [tableHead],
      body: tableBody,
      startY: 22,
      theme: "grid",
      styles: {
        fontSize: 6.5,
        cellPadding: 1.5,
        halign: "center",
        valign: "middle",
        lineColor: [200, 200, 200],
        lineWidth: 0.1,
      },
      headStyles: { fillColor: [0, 123, 255], textColor: 255 },
      didParseCell: (data) => {
        if (data.section === "body") bodyCellStyle(data.cell);
      },
    });

    doc.save(`Dienstplan_${monthName}_${year}.pdf`);
  };

  /* ============================================================
     ===  Bedarf ändern / MasterDemand anwenden ================= */
  const handleDemandChange = (day, shift, value) => {
    const numValue = parseInt(value, 10) || 0;
    setDailyNeeds((prev) => ({
      ...prev,
      [day]: {
        ...(prev[day] || {}),
        [shift]: numValue,
      },
    }));
  };

  const handleApplyMasterDemand = (masterDemand) => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const next = {};
    for (let d = 1; d <= daysInMonth; d++) {
      next[d] = { ...(masterDemand || {}) };
    }
    setDailyNeeds(next);
  };

  /* ============================================================
     ===  Einstellungen speichern =============================== */
  const handleSettingsSave = async (newSettings) => {
    const toSave = { id: "main", ...newSettings };
    setSettings(newSettings);
    try {
      await db.put("settings", toSave);
    } catch (e) {
      console.error("Settings speichern fehlgeschlagen:", e);
    }
  };

  /* ============================================================
     ===  Mitarbeiter CRUD ====================================== */
  const handleSaveEmployee = async (employee) => {
    const hasId = !!employee.id;
    const emp = hasId ? employee : { ...employee, id: `emp_${Date.now()}` };
    await db.put("employees", emp);
    setEmployees((prev) => {
      const others = prev.filter((e) => e.id !== emp.id);
      return [...others, emp].sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
    });
    setModal({ name: "employeeOverview", data: null });
  };

  const handleDeleteEmployee = async (empId) => {
    await db.delete("employees", empId);
    setEmployees((prev) => prev.filter((e) => e.id !== empId));
    // zugehörige Planzellen optional entfernen
    setPlan((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (k.startsWith(empId + "-")) delete next[k];
      });
      return next;
    });
    setModal({ name: "employeeOverview", data: null });
  };

  /* ============================================================
     ===  Import / Export ======================================= */
  const handleExport = () => {
    const data = { employees, plan, dailyNeeds, settings };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dienstplan_${getMonthId(currentDate)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportInputClick = () => {
    fileInputRef.current?.click();
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        setEmployees(imported.employees || []);
        setPlan(imported.plan || {});
        setDailyNeeds(imported.dailyNeeds || {});
        setSettings(imported.settings || DEFAULT_SETTINGS);
        await db.put("plans", {
          monthId: getMonthId(currentDate),
          plan: imported.plan || {},
          dailyNeeds: imported.dailyNeeds || {},
        });
        await db.put("settings", { id: "main", ...(imported.settings || DEFAULT_SETTINGS) });
        alert("Import erfolgreich!");
      } catch (err) {
        console.error(err);
        alert("Fehler beim Import: " + err.message);
      } finally {
        // Input zurücksetzen, damit erneut dieselbe Datei ausgewählt werden kann
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  };
/* ============================================================
=== AUTO-PLANUNG – Familien- & Freizeitfreundliche Utils ======
============================================================= */

// 1..7 (Mo..So)
function getDowMonBased(year, month, day) {
  const dow = new Date(year, month, day).getDay(); // 0=So..6=Sa
  return dow === 0 ? 7 : dow;
}
// Montag (Kalendertag im Monat) der jeweiligen Woche zurückgeben
function getWeekStartDay(year, month, day) {
  const dow = getDowMonBased(year, month, day);
  return Math.max(1, day - (dow - 1));
}
function isWeekend(year, month, day) {
  const dow = getDowMonBased(year, month, day);
  return dow === 6 || dow === 7;
}
function isWorkShift(shift) {
  if (!shift) return false;
  return !["F", "U", "FW", ""].includes(shift);
}

// Anzahl bereits verplanter Dienste eines Mitarbeiters (gesamt / pro Shift)
function getEmpMonthCounts(plan, empId, daysInMonth) {
  let total = 0;
  const perShift = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const s = plan[`${empId}-${d}`]?.shift || "";
    if (isWorkShift(s)) {
      total++;
      perShift[s] = (perShift[s] || 0) + 1;
    }
  }
  return { total, perShift };
}

// Zählt zusammenhängende Arbeitstage um 'day' herum (wenn an day gearbeitet würde)
function consecutiveRunLengthWith(plan, empId, day, assignWork) {
  const isWork = (d) => {
    if (d === day) return !!assignWork;
    return isWorkShift(plan[`${empId}-${d}`]?.shift);
  };
  let left = 0;
  for (let d = day - 1; d >= 1 && isWork(d); d--) left++;
  let right = 0;
  const maxDay = 31; // reicht, tatsächliche Grenze wird beim Aufruf beachtet
  for (let d = day + 1; d <= maxDay && isWork(d); d++) right++;
  return left + 1 + right;
}

// Dienste in der (Mo–So) Woche
function weekWorkCountWith(plan, empId, year, month, day, assignWork) {
  const start = getWeekStartDay(year, month, day);
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = start + i;
    if (d === day) { count += assignWork ? 1 : (isWorkShift(plan[`${empId}-${d}`]?.shift) ? 1 : 0); }
    else if (isWorkShift(plan[`${empId}-${d}`]?.shift)) count++;
  }
  return count;
}

// Anzahl Wochenenden mit mindestens einem Dienst
function weekendsWorked(plan, empId, year, month, daysInMonth) {
  const weekends = new Set();
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWeekend(year, month, d) && isWorkShift(plan[`${empId}-${d}`]?.shift)) {
      weekends.add(Math.floor((d - 1) / 7));
    }
  }
  return weekends.size;
}

// Große Distanz zu anderen Einsätzen => bessere zeitliche Streuung
function nearestAssignmentDistance(plan, empId, day) {
  const assignedDays = Object.keys(plan)
    .filter((k) => k.startsWith(empId + "-") && isWorkShift(plan[k]?.shift))
    .map((k) => parseInt(k.split("-")[1], 10));
  if (assignedDays.length === 0) return 31;
  let minDist = 31;
  for (const d of assignedDays) minDist = Math.min(minDist, Math.abs(d - day));
  return minDist;
}

// Würde 'W F W' oder ähnliche „Single-Free“-Sandwiches entstehen?
function wouldCreateWFWSandwich(plan, empId, day) {
  const s = (d) => plan[`${empId}-${d}`]?.shift || "";
  const isW = (x) => isWorkShift(x);
  const isF = (x) => !isWorkShift(x);

  // Wir setzen an 'day' Arbeit -> checke Nachbarschaft
  const p2 = s(day - 2), p1 = s(day - 1), n1 = s(day + 1), n2 = s(day + 2);

  // Muster rund um den einzusetzenden Tag:
  //  F [W] F  mit davor oder danach wieder W => isolierte freie Einzel-Tage werden erzeugt/verlängert
  if (isF(p1) && isF(n1)) {
    if (isW(p2) || isW(n2)) return true;
  }
  // W F [W] (wir würden mittendrin einen einzelnen freien Tag einklemmen)
  if (isW(p1) && isF(day) && isW(n1)) return true;

  return false;
}

// Erwartungswerte je Schichttyp pro Mitarbeiter (faire Verteilung nach Bedarf & %)
function buildExpectedShares(employees, dailyNeeds, month, year) {
  // Gesamtbedarf je Shift im Monat
  const totals = {};
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const need = dailyNeeds[d] || {};
    for (const [k, v] of Object.entries(need)) totals[k] = (totals[k] || 0) + (v || 0);
  }
  // Summe der Prozente (für Anteil)
  const sumPct = employees.reduce((a, e) => a + (Number(e.percentage) || 0), 0) || 1;

  // Erwartung pro Mitarbeiter/Shift
  const expected = {};
  for (const emp of employees) {
    const factor = (Number(emp.percentage) || 0) / sumPct;
    expected[emp.id] = {};
    for (const [shift, total] of Object.entries(totals)) {
      expected[emp.id][shift] = total * factor;
    }
  }
  return { expected, totals, daysInMonth };
}

// Eignung: Darf ich an diesem Tag/Shift zuweisen?
function isEligibleForAuto(plan, emp, day, month, year, shiftType) {
  const key = `${emp.id}-${day}`;
  const cell = plan[key];

  // schon belegt oder gelockt respektieren
  if (cell?.shift && cell.locked) return false;
  if (cell?.shift && cell.shift !== "") return false;

  // Wochen- und Laufketten-Grenzen prüfen (max 4 in Woche, max 4 am Stück)
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const runLen = consecutiveRunLengthWith(plan, emp.id, day, true);
  if (runLen > 4) return false;

  const wkCount = weekWorkCountWith(plan, emp.id, year, month, day, true);
  if (wkCount > 4) return false;

  // „Single-Free“-Muster vermeiden
  if (wouldCreateWFWSandwich(plan, emp.id, day)) return false;

  // Keine Tagesdienste direkt nach echter Nacht? (sanfte Regel – harte wurde nicht verlangt)
  // -> wir lassen das als "soft penalty" in fairnessScore, nicht als Knock-Out.

  return true;
}

// Scoring: höher = besser
function fairnessScore(plan, emp, day, month, year, shiftType, sharesCache) {
  const { expected, daysInMonth } = sharesCache;
  const { total, perShift } = getEmpMonthCounts(plan, emp.id, daysInMonth);

  // 1) Gleichverteilung nach Bedarf: wer „unter Soll“ ist, bekommt Bonus
  const expForThisShift = (expected[emp.id] && expected[emp.id][shiftType]) || 0;
  const haveForThisShift = perShift[shiftType] || 0;
  const underfill = Math.max(0, expForThisShift - haveForThisShift); // je größer, desto besser
  let score = underfill * 4; // starker Faktor, um faire Verteilung zu priorisieren

  // 2) Wochen- & Kettenfreundlichkeit (weich, harte Grenzen sind bereits im Eligible)
  const wkCount = weekWorkCountWith(plan, emp.id, year, month, day, true);
  score += (4 - wkCount) * 1.5; // weniger Dienste in der Woche -> besser

  const runLen = consecutiveRunLengthWith(plan, emp.id, day, true);
  score += (4 - runLen) * 1.2; // kürzere Ketten bevorzugen (max 4 ohnehin)

  // 3) Wochenenden: möglichst wenige gearbeitete Wochenenden pro Person
  const wknds = weekendsWorked(plan, emp.id, year, month, daysInMonth);
  if (isWeekend(year, month, day)) {
    score += Math.max(0, 6 - wknds) * 1.0; // bevorzugt die mit weniger Wochenenden
  } else {
    score += 0.3; // leichter Bonus für Werktage
  }

  // 4) Streuung im Monat (verhindert „enger Zeitraum“)
  score += Math.min(10, nearestAssignmentDistance(plan, emp.id, day)) * 0.8;

  // 5) Familienfreundlich: viele 2er-Freiblocks & keine „W-F-W“
  if (!wouldCreateWFWSandwich(plan, emp.id, day)) score += 1.2;

  // 6) Sanfte Bonuskante: vor/nach U/FW-Blöcken besetzen (Ränder „sauber“ machen)
  const s = (d) => plan[`${emp.id}-${d}`]?.shift || "";
  if (["U", "FW", "F"].includes(s(day - 1)) || ["U", "FW", "F"].includes(s(day + 1))) {
    score += 0.8;
  }

  // 7) „Tag nach Nacht“ als leichte Strafe
  const prev = s(day - 1);
  const isNight = (x) => x === "NR" || x === "VN";
  const isDay = (x) => ["TR", "VT", "T39", "V39"].includes(x);
  if (isNight(prev) && isDay(shiftType)) score -= 2.0;

  return score;
}

/* ============================================================
=== AUTO-PLANUNG (familien- & freizeitfreundlich) =============
============================================================= */
const handleAutoPlan = () => {
  if (!confirm("Automatische, familienfreundliche Planung starten?")) return;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  applyPlanUpdateWithHistory((prevPlan) => {
    const newPlan = { ...prevPlan };

    // Manuelles respektieren
    Object.keys(prevPlan).forEach((k) => {
      if (prevPlan[k]?.locked) newPlan[k] = prevPlan[k];
    });

    // Erwartungswerte (faire Verteilung nach Bedarf & %)
    const sharesCache = buildExpectedShares(employees, dailyNeeds, month, year);

    // Mitarbeiter rotieren & Starttag random -> zeitliche Streuung
    const shuffledEmployees = [...employees].sort(() => Math.random() - 0.5);
    const startDay = Math.floor(Math.random() * daysInMonth) + 1;

    // Tag für Tag, Shift für Shift auf Soll auffüllen
    for (let offset = 0; offset < daysInMonth; offset++) {
      const day = ((startDay + offset - 1) % daysInMonth) + 1;
      const needs = dailyNeeds[day];
      if (!needs) continue;

      for (const [shiftType, needed] of Object.entries(needs)) {
        // Nur Schichten, die im Auto-Plan aktiv sind
        if (!SHIFT_TYPES[shiftType]?.autoPlan || (needed || 0) <= 0) continue;

        // Bereits belegte zählen
        let already = shuffledEmployees.filter(
          (e) => newPlan[`${e.id}-${day}`]?.shift === shiftType
        ).length;
        let remaining = needed - already;
        if (remaining <= 0) continue;

        // Kandidaten sammeln
        const candidates = shuffledEmployees
          .filter((e) => isEligibleForAuto(newPlan, e, day, month, year, shiftType))
          .map((e) => ({
            emp: e,
            score: fairnessScore(newPlan, e, day, month, year, shiftType, sharesCache),
          }))
          .sort((a, b) => b.score - a.score);

        for (let i = 0; i < Math.min(remaining, candidates.length); i++) {
          const emp = candidates[i].emp;
          const key = `${emp.id}-${day}`;
          newPlan[key] = { shift: shiftType, locked: false };
        }
      }
    }

    return newPlan;
  });

  alert("Automatische Planung abgeschlossen.");
};

  /* ============================================================
     ===  RENDERING  ============================================ */
  if (isLoading) return <div id="app-loader">Lade Dienstplan...</div>;

  return (
    <>
      {/* versteckter Datei-Input für Import */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        accept="application/json"
        onChange={handleImport}
      />

      <div className="sticky-header">
        <div className="container">
          <Header
            currentDate={currentDate}
            onMonthChange={handleMonthChange}
            onOpenModal={(name) => setModal({ name, data: null })}
            onAutoPlan={handleAutoPlan}
            onClearPlan={handleClearPlan}
            settings={settings}
            onSettingChange={(key, value) =>
              setSettings({ ...settings, [key]: value })
            }
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onExport={handleExport}
            onImport={handleImportInputClick}
            onBackup={handleBackup}
            onExportPDF={handleExportPDF}
            onSyncUpload={handleSyncUpload}
            onSyncDownload={handleSyncDownload}
         
          />
          
          <ShiftBrush
            activeBrush={activeBrush}
            onBrushChange={setActiveBrush}
            shiftColors={settings.shiftColors}
          />
        </div>
      </div>

      <div className="scrollable-content">
        <div className="container">
          <PlanGrid
            employees={employees}
            plan={plan}
            currentDate={currentDate}
            settings={settings}
            summaryData={summaryData}
            validations={validations}
            dailyNeeds={dailyNeeds}
            onDemandChange={handleDemandChange}
            onCellInteraction={(t, eid, d, e) => {
              if (e?.type === "contextmenu") {
                // Rechtsklick an PlanGrid weiterreichen
                handleCellInteraction(null, eid, d, e);
              } else {
                handleCellInteraction(t, eid, d, e);
              }
            }}
          />
        </div>
      </div>

      <Modals
        modal={modal}
        setModal={setModal}
        employees={employees}
        settings={settings}
        onSettingsSave={handleSettingsSave}
        onApplyMasterDemand={handleApplyMasterDemand}
        onSaveEmployee={handleSaveEmployee}
        onDeleteEmployee={handleDeleteEmployee}
      />
    </>
  );
}
