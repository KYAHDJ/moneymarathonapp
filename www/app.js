/* ============================================================
   MONEY MARATHON — app logic
   Preact + htm (no build step) on top of Cloud Firestore.
   Every open browser gets live updates through onSnapshot.
   ============================================================ */

import {
  html, render, useState, useEffect, useMemo, useRef,
} from "https://unpkg.com/htm@3.1.1/preact/standalone.module.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, collection, query, orderBy, onSnapshot,
  setDoc, updateDoc, deleteDoc, getDoc, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

import { firebaseConfig } from "./firebase-config.js";

/* ---------- small helpers ---------- */

const CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const newId = (n = 16) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
};

const money = (n, cur = "₱") =>
  cur + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const compact = (n, cur = "₱") => {
  const v = Math.abs(n || 0);
  if (v >= 1000000) return cur + Math.round(n / 1000000) + "M";
  if (v >= 10000) return cur + Math.round(n / 1000) + "k";
  return money(n, cur);
};

const today = () => new Date().toISOString().slice(0, 10);

const prettyDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m || 1) - 1]} ${d}`;
};

const initial = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

/* a racer's lane/profile colour: their own pick, or the auto position cycle */
const isHexColor = (c) => !!c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);

/* HSV <-> hex, backing the color wheel picker */
const hsvToHex = (h, s, v) => {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
};
const hexToHsv = (hex) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const r = parseInt(full.slice(1, 3), 16) / 255, g = parseInt(full.slice(3, 5), 16) / 255, b = parseInt(full.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
};

/* a racer's lane/profile colour class: their own preset pick, or the auto position cycle
   (a custom hex color is applied separately via laneStyle, this just needs SOME valid class) */
const laneClass = (r) => (r.color && /^c[0-5]$/.test(r.color) ? r.color : `c${(Math.max(1, r.slot || 1) - 1) % 6}`);

/* black or white — whichever reads on top of a given hex. Only ever used for
   the tiny bit of text that has to sit directly on a custom fill (an avatar
   initial, a banner label); it never touches the fill itself. */
const contrastOn = (hex) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const r = parseInt(full.slice(1, 3), 16), g = parseInt(full.slice(3, 5), 16), b = parseInt(full.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "var(--ink)" : "#fff";
};

/* inline style override for a custom hex color, empty string for presets/auto.
   --lane-fill/--lane-ink are the exact picked hex everywhere, unmodified —
   --lane-contrast exists only so text drawn on top of the fill stays legible */
const laneStyle = (r) =>
  isHexColor(r.color)
    ? `--lane-fill:${r.color};--lane-ink:${r.color};--lane-contrast:${contrastOn(r.color)};`
    : "";

const DEFAULT_CHARACTERS = [
  {
    id: "orange-cat",
    name: "Orange cat",
    start: "https://i.imgur.com/6CiFpZv.png",
    moving: "https://i.imgur.com/tGxlFqF.png",
    finish: "https://i.imgur.com/zkd1rwZ.png",
  },
  {
    id: "bw-cat",
    name: "Black & white cat",
    start: "./characters/bw-cat-start.png",
    moving: "./characters/bw-cat-moving.png",
    finish: "./characters/bw-cat-finish.png",
  },
  {
    id: "white-cat",
    name: "White cat",
    start: "./characters/white-cat-start.png",
    moving: "./characters/white-cat-moving.png",
    finish: "./characters/white-cat-finish.png",
  },
];

/* six actual named colors off the color wheel — plus Auto and Custom */
const PROFILE_COLORS = [
  { id: "", label: "Auto-pick color" },
  { id: "c0", label: "Red" },
  { id: "c1", label: "Orange" },
  { id: "c2", label: "Yellow" },
  { id: "c3", label: "Green" },
  { id: "c4", label: "Blue" },
  { id: "c5", label: "Violet" },
];

/* hex equivalents of the c0-c5 lane presets (must match styles.css), so a
   preset pick can also fill the color box solid like a custom hex does */
const LANE_PRESET_FILLS = {
  c0: "#E85D5D", c1: "#E8923D", c2: "#E8D23D", c3: "#5DB88A", c4: "#5D8FE8", c5: "#9B6FD9",
};

const CURRENCIES = [
  { id: "₱", label: "₱ · Philippine Peso" },
  { id: "$", label: "$ · US Dollar" },
  { id: "€", label: "€ · Euro" },
  { id: "£", label: "£ · British Pound" },
  { id: "¥", label: "¥ · Japanese Yen" },
  { id: "₹", label: "₹ · Indian Rupee" },
  { id: "A$", label: "A$ · Australian Dollar" },
  { id: "C$", label: "C$ · Canadian Dollar" },
  { id: "S$", label: "S$ · Singapore Dollar" },
  { id: "HK$", label: "HK$ · Hong Kong Dollar" },
  { id: "RM", label: "RM · Malaysian Ringgit" },
  { id: "Rp", label: "Rp · Indonesian Rupiah" },
  { id: "฿", label: "฿ · Thai Baht" },
  { id: "₩", label: "₩ · South Korean Won" },
  { id: "₫", label: "₫ · Vietnamese Dong" },
  { id: "R$", label: "R$ · Brazilian Real" },
  { id: "₦", label: "₦ · Nigerian Naira" },
];

const BANKS = [
  "BDO", "BPI", "Metrobank", "Landbank", "PNB", "UnionBank", "Security Bank",
  "RCBC", "Chinabank", "EastWest Bank", "GCash", "Maya", "GrabPay", "ShopeePay", "Cash",
];

/* ---------- shrink an image client-side before it ever reaches Storage ---------- */

async function compressImage(file, maxBytes = 500 * 1024, maxDim = 1024) {
  if (!file.type || !file.type.startsWith("image/") || file.type === "image/gif") return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let quality = 0.9;
  let blob = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
  while (blob && blob.size > maxBytes && quality > 0.35) {
    quality -= 0.12;
    blob = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
  }
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".webp", { type: "image/webp" });
}

/* ---------- sound: click pops (from DryNav) + background music ---------- */

const LS_SOUND = "mm_sound_prefs";
const DEFAULT_SOUND_PREFS = { sfxOn: true, sfxVol: 0.7, musicOn: true, musicVol: 0.4 };

const loadSoundPrefs = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SOUND) || "{}");
    return { ...DEFAULT_SOUND_PREFS, ...saved };
  } catch {
    return { ...DEFAULT_SOUND_PREFS };
  }
};

let soundPrefs = loadSoundPrefs();
const soundListeners = new Set();
const saveSoundPrefs = () => localStorage.setItem(LS_SOUND, JSON.stringify(soundPrefs));

const clickPool = ["./sounds/click1.mp3", "./sounds/click2.mp3", "./sounds/click3.mp3"]
  .map((src) => { const a = new Audio(src); a.preload = "auto"; return a; });
const victoryAudio = new Audio("./sounds/victory.mp3");
const bgMusic = new Audio("./sounds/horizon-glide.mp3");
bgMusic.preload = "auto";

const MUSIC_FADE_S = 1;
let musicStarted = false;

function playClick() {
  if (!soundPrefs.sfxOn) return;
  const a = clickPool[Math.floor(Math.random() * clickPool.length)];
  try { a.currentTime = 0; } catch {}
  a.volume = soundPrefs.sfxVol;
  a.play().catch(() => {});
}

function playVictory() {
  if (!soundPrefs.sfxOn) return;
  try { victoryAudio.currentTime = 0; } catch {}
  victoryAudio.volume = soundPrefs.sfxVol;
  victoryAudio.play().catch(() => {});
}

function fadeMusicTo(target, seconds) {
  const from = bgMusic.volume;
  const steps = Math.max(1, Math.round(seconds * 20));
  let i = 0;
  const id = setInterval(() => {
    i += 1;
    const p = Math.min(1, i / steps);
    bgMusic.volume = from + (target - from) * p;
    if (p >= 1) clearInterval(id);
  }, 1000 / 20);
}

function startMusicIfNeeded() {
  if (musicStarted || !soundPrefs.musicOn) return;
  musicStarted = true;
  bgMusic.volume = 0;
  bgMusic.play().then(() => fadeMusicTo(soundPrefs.musicVol, MUSIC_FADE_S)).catch(() => { musicStarted = false; });
}

/* app backgrounded (home/recents/switched away) — just pause, don't reset
   musicStarted, so resuming picks the track back up instead of refading in */
function pauseMusicForBackground() {
  bgMusic.pause();
}
function resumeMusicFromBackground() {
  if (!soundPrefs.musicOn) return;
  if (musicStarted) bgMusic.play().catch(() => {});
  else startMusicIfNeeded();
}

/* soft 1s fade at the loop seam instead of an abrupt native loop restart */
bgMusic.addEventListener("timeupdate", () => {
  if (!bgMusic.duration || !soundPrefs.musicOn) return;
  const remaining = bgMusic.duration - bgMusic.currentTime;
  if (remaining <= MUSIC_FADE_S) bgMusic.volume = Math.max(0, soundPrefs.musicVol * (remaining / MUSIC_FADE_S));
});
bgMusic.addEventListener("ended", () => {
  bgMusic.currentTime = 0;
  if (soundPrefs.musicOn) bgMusic.play().then(() => fadeMusicTo(soundPrefs.musicVol, MUSIC_FADE_S)).catch(() => {});
});

function applySoundPrefs(next) {
  soundPrefs = { ...soundPrefs, ...next };
  saveSoundPrefs();
  if (soundPrefs.musicOn) startMusicIfNeeded(); else { bgMusic.pause(); musicStarted = false; }
  if (!bgMusic.paused) bgMusic.volume = soundPrefs.musicVol;
  soundListeners.forEach((fn) => fn(soundPrefs));
}

/* every button in the app pops — delegated so new buttons never need wiring by hand */
document.addEventListener("click", (e) => {
  startMusicIfNeeded();
  if (e.target.closest && e.target.closest("button")) playClick();
}, { capture: true });

/* ---------- themed confirm modal (no native browser/OS dialog) ---------- */

function askConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal";
    const msg = document.createElement("p");
    msg.className = "modal__msg";
    msg.textContent = message;
    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "btn " + (opts.danger === false ? "btn--go" : "btn--danger");
    okBtn.textContent = opts.okLabel || "Yes, remove it";
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(msg);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    okBtn.focus();
  });
}

/* ---------- themed dropdown (avoids the native Android/browser <select> chrome) ---------- */

function Dropdown({ value, options, onChange, ariaLabel, className, placeholder, compact, fillColor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return html`
    <div class=${"dropdown " + (className || "")} ref=${ref}>
      <button type="button" class=${"dropdown__btn" + (compact ? " dropdown__btn--compact" : "")}
        style=${fillColor ? `background:${fillColor};border-color:${fillColor};color:${contrastOn(fillColor)}` : ""}
        aria-label=${ariaLabel} onClick=${() => setOpen(!open)}>
        <span class="dropdown__val">${compact ? (current ? current.value : "") : (current ? current.label : (placeholder || "Select…"))}</span>
        <span class="dropdown__chev" style=${fillColor ? `color:${contrastOn(fillColor)}` : ""}>▾</span>
      </button>
      ${open && html`
        <div class="dropdown__menu" role="listbox">
          ${options.map((o) => html`
            <button type="button" key=${o.value}
              class=${"dropdown__opt " + (o.value === value ? "dropdown__opt--on" : "")}
              role="option" onClick=${() => { onChange(o.value); setOpen(false); }}>
              ${o.swatch !== undefined && (
                isHexColor(o.swatch)
                  ? html`<span class="swatch" style=${`background:${o.swatch};border-color:${o.swatch}`}></span>`
                  : html`<span class=${`swatch avatar--${o.swatch || "auto"}`}></span>`
              )}
              ${o.label}
            </button>`)}
        </div>`}
    </div>`;
}

/* ---------- savings plan (target date + cadence) ---------- */

const WEEKDAYS = [
  { id: "sun", label: "Sunday", idx: 0 },
  { id: "mon", label: "Monday", idx: 1 },
  { id: "tue", label: "Tuesday", idx: 2 },
  { id: "wed", label: "Wednesday", idx: 3 },
  { id: "thu", label: "Thursday", idx: 4 },
  { id: "fri", label: "Friday", idx: 5 },
  { id: "sat", label: "Saturday", idx: 6 },
];

const cadenceLabel = (id) => {
  const wd = WEEKDAYS.find((w) => w.id === id);
  if (wd) return `Every ${wd.label}`;
  if ((id || "").startsWith("every:")) {
    const n = parseInt(id.split(":")[1], 10) || 1;
    return n === 1 ? "Every day" : `Every ${n} days`;
  }
  return "Every day";
};

const daysUntil = (iso) => {
  if (!iso) return 0;
  const from = new Date(`${today()}T00:00:00`);
  const to = new Date(`${iso}T00:00:00`);
  return Math.round((to - from) / 86400000);
};

const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (base, n) => new Date(base.getTime() + n * 86400000);

/* every date, from today through the target (inclusive), that matches a cadence */
const scheduleDates = (targetISO, cadenceId) => {
  const total = daysUntil(targetISO) + 1;
  if (total <= 0) return [];
  const from = new Date(`${today()}T00:00:00`);
  const wd = WEEKDAYS.find((w) => w.id === cadenceId);
  const step = (cadenceId || "").startsWith("every:") ? Math.max(1, parseInt(cadenceId.split(":")[1], 10) || 1) : 1;
  const dates = [];
  for (let i = 0; i < total; i++) {
    if (wd ? addDays(from, i).getDay() === wd.idx : i % step === 0) dates.push(isoOf(addDays(from, i)));
  }
  return dates;
};

const paymentsUntil = (iso, cadenceId) => scheduleDates(iso, cadenceId).length;

/* ---------- savings-day reminders (local notifications) ---------- */

const REMINDER_HOUR = 9; // 9am local time on each scheduled day

async function cancelAllSavingsReminders() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    const pending = await LN.getPending();
    if (pending?.notifications?.length) {
      await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
  } catch {}
}

/* reschedules this device's own reminders to exactly match its racer's
   current savings plan — only days that are still unconfirmed and assigned
   a date in the log get a notification */
async function syncSavingsReminders(entries, currency, tripName) {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== "granted") perm = await LN.requestPermissions();
    if (perm.display !== "granted") return;

    await cancelAllSavingsReminders();

    const todayISO = today();
    const upcoming = (entries || [])
      .filter((e) => e.source === "plan" && !e.confirmed && e.date && e.date >= todayISO);
    if (!upcoming.length) return;

    const notifications = upcoming.map((e) => {
      const [y, m, d] = e.date.split("-").map(Number);
      return {
        id: y * 10000 + m * 100 + d,
        title: "Money Marathon",
        body: `Time to log today's savings — ${money(e.amount, currency)} planned for "${tripName || "your race"}".`,
        schedule: { at: new Date(y, m - 1, d, REMINDER_HOUR, 0, 0), allowWhileIdle: true },
      };
    });
    await LN.schedule({ notifications });
  } catch {}
}

/* ---------- firebase boot ---------- */

const configured =
  firebaseConfig && firebaseConfig.apiKey && !/PASTE|YOUR_/i.test(firebaseConfig.apiKey);

let db = null;
let auth = null;
let storage = null;
if (configured) {
  const app = initializeApp(firebaseConfig);
  /* persistent local cache means a reopened race can paint from disk
     immediately instead of waiting on a fresh server round-trip */
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });
  auth = getAuth(app);
  storage = getStorage(app);
}

/* resolves once anonymous sign-in has gone through — usually already true
   by the time a write actually fires, so callers can await it inline
   instead of gating buttons on a separate "connecting" state */
const waitForAuth = () => new Promise((resolve) => {
  if (auth?.currentUser) { resolve(); return; }
  const stop = onAuthStateChanged(auth, (user) => {
    if (user) { stop(); resolve(); }
  });
});

/* Firestore writes don't reject when the network is down — they just sit
   queued until it comes back. Give any create/join attempt a hard budget
   so the UI always resolves to either success or a clear error, never a
   silent forever-spinner. */
const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);

const raceRef = (id) => doc(db, "races", id);
const racersRef = (id) => collection(db, "races", id, "racers");
const racerRef = (id, rid) => doc(db, "races", id, "racers", rid);

/* ---------- local device identity (join-code model, no share links) ---------- */

const LS_RACE = "mm_raceId";
const lsRacer = (raceId) => `mm_racer_${raceId}`;

/* ---------- reusable input that only writes on blur ---------- */

function LiveInput({ value, onCommit, className, ...rest }) {
  const [local, setLocal] = useState(value ?? "");
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(value ?? "");
  }, [value]);

  return html`<input
    class=${className}
    value=${local}
    onFocus=${() => { focused.current = true; }}
    onInput=${(e) => setLocal(e.target.value)}
    onBlur=${() => {
      focused.current = false;
      if ((local ?? "") !== (value ?? "")) onCommit(local);
    }}
    onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
    ...${rest}
  />`;
}

/* ---------- splash screen (shown while connecting / loading a race) ---------- */

function SplashScreen({ out }) {
  return html`
    <div class=${"splash" + (out ? " splash--out" : "")}>
      <img class="splash__icon" src="./icon.png" alt="" />
      <p class="splash__word">MONEY<span>MARATHON</span></p>
      <div class="splash__wave"><span></span><span></span><span></span><span></span><span></span></div>
    </div>`;
}

/* ============================================================
   ROOT
   ============================================================ */

function App() {
  const [raceId, setRaceId] = useState(() => localStorage.getItem(LS_RACE) || "");
  const [race, setRace] = useState(null);
  const [racers, setRacers] = useState([]);
  const [status, setStatus] = useState("connecting");
  const [authed, setAuthed] = useState(false);
  const [toast, setToast] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [tab, setTab] = useState("track");
  const [detailRacerId, setDetailRacerId] = useState(null);
  const [tabOrigin, setTabOrigin] = useState("50% 100%");
  const [tabEntering, setTabEntering] = useState(false);
  const [tabLeaving, setTabLeaving] = useState(false);
  const tabContentRef = useRef(null);
  const [showSplash, setShowSplash] = useState(true);
  const [splashOut, setSplashOut] = useState(false);
  const [tutorial, setTutorial] = useState(() => ({
    phase: localStorage.getItem(LS_TUTORIAL_SEEN) ? "done" : "welcome",
    step: 0,
  }));
  const [showSound, setShowSound] = useState(false);
  const prevRacersRef = useRef(null);
  const splashStarted = useRef(false);

  /* warnings/errors stay up longer — a good-news toast can flash by,
     but "it timed out, try again" needs enough time to actually read */
  const say = (msg, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast(null), bad ? 5000 : 2800);
  };

  /* Race Tracker is home. Dashboard and Racer profiles are pushed on top of
     it as their own full screens — entering "grows" from wherever the
     button was tapped (a container-transform), and the back button/gesture
     shrinks the same way back down into that same spot. */
  const changeTab = (id, e) => {
    setDetailRacerId(null);
    if (e?.currentTarget && tabContentRef.current) {
      const b = e.currentTarget.getBoundingClientRect();
      const c = tabContentRef.current.getBoundingClientRect();
      const ox = ((b.left + b.width / 2 - c.left) / c.width) * 100;
      const oy = ((b.top + b.height / 2 - c.top) / c.height) * 100;
      setTabOrigin(`${ox}% ${oy}%`);
      setTabEntering(true);
    }
    setTab(id);
  };

  const goBack = () => {
    if (tab === "track") return;
    setDetailRacerId(null);
    setTabLeaving(true);
    setTimeout(() => { setTab("track"); setTabLeaving(false); }, 300);
  };

  /* a short setTimeout instead of requestAnimationFrame — rAF doesn't
     reliably fire in non-composited/backgrounded contexts (same issue hit
     with the music fade), a timeout does regardless of paint state */
  useEffect(() => {
    if (!tabEntering) return;
    const t = setTimeout(() => setTabEntering(false), 20);
    return () => clearTimeout(t);
  }, [tabEntering]);

  /* swipe from Race Tracker opens whichever screen the swipe direction
     points at; swiping on Dashboard/Racer profiles goes back — not while
     drilled into a racer's own page, where a horizontal drag means something else */
  const swipeStart = useRef(null);
  const onSwipeDown = (e) => { swipeStart.current = { x: e.clientX, y: e.clientY }; };
  const onSwipeUp = (e) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || detailRacerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (tab !== "track") { goBack(); return; }
    changeTab(dx < 0 ? "dashboard" : "racewin");
  };

  /* Android hardware/gesture back button: Race Tracker is "home" — back from
     anywhere else returns there first (with the same shrink-down animation
     as the on-screen back button), and only asks to quit once you're
     already on it, instead of suddenly closing the app. */
  const tabRef = useRef(tab);
  const detailRef = useRef(detailRacerId);
  const goBackRef = useRef(goBack);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { detailRef.current = detailRacerId; }, [detailRacerId]);
  useEffect(() => { goBackRef.current = goBack; });

  useEffect(() => {
    const CapApp = window.Capacitor?.Plugins?.App;
    if (!CapApp) return;
    let handle;
    /* Capacitor 7's addListener() returns the handle directly on native
       platforms (not a Promise) — Promise.resolve() normalizes both cases */
    Promise.resolve(CapApp.addListener("backButton", async () => {
      if (detailRef.current) { setDetailRacerId(null); return; }
      if (tabRef.current !== "track") { goBackRef.current(); return; }
      if (await askConfirm("Quit Money Marathon?", { okLabel: "Quit", danger: false })) CapApp.exitApp();
    })).then((h) => { handle = h; });
    return () => { handle?.remove(); };
  }, []);

  /* music must not keep playing once the app is backgrounded (home/recents/
     switched away) — Capacitor's App plugin on native, page visibility on web */
  useEffect(() => {
    const CapApp = window.Capacitor?.Plugins?.App;
    if (!CapApp) {
      const onVis = () => (document.hidden ? pauseMusicForBackground() : resumeMusicFromBackground());
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
    }
    let pauseHandle, resumeHandle;
    Promise.resolve(CapApp.addListener("pause", pauseMusicForBackground)).then((h) => { pauseHandle = h; });
    Promise.resolve(CapApp.addListener("resume", resumeMusicFromBackground)).then((h) => { resumeHandle = h; });
    return () => { pauseHandle?.remove(); resumeHandle?.remove(); };
  }, []);

  /* sign in anonymously so the security rules have something to check */
  useEffect(() => {
    if (!configured) return;
    const stop = onAuthStateChanged(auth, (user) => setAuthed(!!user));
    signInAnonymously(auth).catch((err) => {
      setFatal(
        err.code === "auth/operation-not-allowed"
          ? "Anonymous sign-in is switched off in your Firebase project. Open Authentication → Sign-in method and enable Anonymous, then reload."
          : `Could not sign in: ${err.message}`
      );
    });
    return stop;
  }, []);

  /* subscribe to the race + its racers */
  useEffect(() => {
    if (!configured || !authed || !raceId) return;
    prevRacersRef.current = null;
    /* re-arm the splash for this race too — leaving and starting/joining another
       shouldn't inherit the "already shown once" state from the previous one */
    splashStarted.current = false;
    setShowSplash(true);
    setSplashOut(false);
    let stopRacers = () => {};
    const stopRace = onSnapshot(
      raceRef(raceId),
      (snap) => {
        if (!snap.exists()) { setRace("missing"); return; }
        setRace({ id: snap.id, ...snap.data() });
        setStatus("live");
      },
      (err) => { setStatus("off"); say(err.message, true); }
    );
    stopRacers = onSnapshot(
      query(racersRef(raceId), orderBy("order")),
      (snap) => {
        const next = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const prev = prevRacersRef.current;
        const myId = localStorage.getItem(lsRacer(raceId));
        if (prev) {
          const prevById = new Map(prev.map((r) => [r.id, r]));
          const nextById = new Map(next.map((r) => [r.id, r]));
          next.forEach((r) => {
            if (!prevById.has(r.id) && (r.name || "").trim() && r.id !== myId) say(`${r.name} joined the race`);
          });
          prev.forEach((r) => {
            if (!nextById.has(r.id) && (r.name || "").trim() && r.id !== myId) say(`${r.name} left the race`);
          });
          next.forEach((r) => {
            if (r.id === myId) return;
            const before = prevById.get(r.id);
            if (!before) return;
            const beforeConfirmed = (before.entries || []).filter((e) => e.confirmed).length;
            const afterConfirmed = (r.entries || []).filter((e) => e.confirmed).length;
            if (afterConfirmed > beforeConfirmed) say(`${r.name} locked in a payment`);
          });
        }
        prevRacersRef.current = next;
        setRacers(next);
      },
      (err) => { setStatus("off"); say(err.message, true); }
    );
    return () => { stopRace(); stopRacers(); };
  }, [raceId, authed]);

  /* keep this device's savings-day reminders in lockstep with its own
     racer's plan — re-derive a signature so this only re-syncs when the
     actual plan (dates/amounts/confirmed) changes, not on every snapshot */
  const myPlanSignature = useMemo(() => {
    const myId = localStorage.getItem(lsRacer(raceId));
    const mine = racers.find((r) => r.id === myId);
    if (!mine) return "";
    return JSON.stringify((mine.entries || [])
      .filter((e) => e.source === "plan")
      .map((e) => [e.date, e.amount, e.confirmed]));
  }, [racers, raceId]);

  useEffect(() => {
    if (!raceId || !race || race === "missing") return;
    const myId = localStorage.getItem(lsRacer(raceId));
    const mine = racers.find((r) => r.id === myId);
    syncSavingsReminders(mine?.entries, race.currency, race.tripName);
  }, [myPlanSignature]);

  /* splash covers both the very first cold start and every later "connecting" moment */
  useEffect(() => {
    if (race && race !== "missing" && !splashStarted.current) {
      splashStarted.current = true;
      setSplashOut(true);
      const t = setTimeout(() => setShowSplash(false), 260);
      return () => clearTimeout(t);
    }
  }, [race]);

  /* keep the right tab (and, for the profile steps, the right racer's page) mounted under the tour */
  useEffect(() => {
    if (tutorial.phase !== "touring") return;
    const step = TUTORIAL_STEPS[tutorial.step];
    if (!step) return;
    if (step.tab !== tab) setTab(step.tab);
    if (step.openDetail) {
      const myId = localStorage.getItem(lsRacer(raceId));
      const target = rows.find((x) => x.id === myId && (x.name || "").trim()) || rows.find((x) => (x.name || "").trim());
      if (target && detailRacerId !== target.id) setDetailRacerId(target.id);
    } else if (detailRacerId) {
      setDetailRacerId(null);
    }
  }, [tutorial.phase, tutorial.step]);

  const startTour = () => setTutorial({ phase: "touring", step: 0 });
  const skipWelcome = () => { localStorage.setItem(LS_TUTORIAL_SEEN, "1"); setTutorial({ phase: "done", step: 0 }); };
  const nextTutorialStep = () =>
    setTutorial((t) => {
      if (t.step < TUTORIAL_STEPS.length - 1) return { ...t, step: t.step + 1 };
      playVictory();
      return { phase: "celebrating", step: t.step };
    });
  const backTutorialStep = () => setTutorial((t) => ({ ...t, step: Math.max(0, t.step - 1) }));
  const skipTour = () => { playVictory(); setTutorial((t) => ({ phase: "celebrating", step: t.step })); };
  const finishCelebration = () => { localStorage.setItem(LS_TUTORIAL_SEEN, "1"); setTutorial({ phase: "done", step: 0 }); };
  const replayTutorial = () => setTutorial({ phase: "touring", step: 0 });

  /* ---------- writes ---------- */

  const guard = (p) => p.catch((e) => say(e.message || "That didn't save", true));

  const createRace = async (creatorName) => {
    try {
      await withTimeout((async () => {
        await waitForAuth();
        const id = newId(6).toUpperCase();
        const racerId = newId(10);
        /* both writes go out at once instead of waiting on each other in turn */
        await Promise.all([
          setDoc(raceRef(id), {
            tripName: "Trip to Boracay",
            goal: 20000,
            currency: "₱",
            characters: DEFAULT_CHARACTERS,
            hostRacerId: racerId,
            createdAt: serverTimestamp(),
          }),
          setDoc(racerRef(id, racerId), {
            name: creatorName || "", bank: "", characterId: DEFAULT_CHARACTERS[0]?.id || "",
            entries: [], order: 0, createdAt: serverTimestamp(),
          }),
        ]);
        localStorage.setItem(LS_RACE, id);
        localStorage.setItem(lsRacer(id), racerId);
        setRaceId(id);
      })(), 10000, "Taking too long to connect — check your internet and try again.");
    } catch (err) {
      say(err.message || "Couldn't start the race", true);
    }
  };

  const joinRace = async (code, name) => {
    const id = (code || "").trim().toUpperCase();
    if (!id) return;
    try {
      await withTimeout((async () => {
        await waitForAuth();
        const snap = await getDoc(raceRef(id));
        if (!snap.exists()) { say("No race with that code.", true); return; }
        const existing = await getDocs(racersRef(id));
        const order = existing.size ? Math.max(...existing.docs.map((d) => d.data().order || 0)) + 1 : 0;
        const racerId = newId(10);
        await setDoc(racerRef(id, racerId), {
          name, bank: "", characterId: "", entries: [], order, createdAt: serverTimestamp(),
        });
        localStorage.setItem(LS_RACE, id);
        localStorage.setItem(lsRacer(id), racerId);
        setRaceId(id);
      })(), 10000, "Taking too long to connect — check your internet and try again.");
    } catch (err) {
      say(err.message || "Couldn't join that race", true);
    }
  };

  const leaveRace = async () => {
    if (!(await askConfirm("Leave this race? You'll be removed from the track — everyone else keeps racing.", { okLabel: "Yes, leave" }))) return;
    const myRacerId = localStorage.getItem(lsRacer(raceId));
    if (myRacerId) await guard(deleteDoc(racerRef(raceId, myRacerId)));
    localStorage.removeItem(LS_RACE);
    localStorage.removeItem(lsRacer(raceId));
    await cancelAllSavingsReminders();
    /* full reload instead of manual state teardown — guarantees a completely
       clean slate (listeners, refs, splash state) every time, like reopening the app */
    location.reload();
  };

  const backToGate = () => {
    localStorage.removeItem(LS_RACE);
    if (raceId) localStorage.removeItem(lsRacer(raceId));
    cancelAllSavingsReminders();
    location.reload();
  };

  const patchRace = (patch) => guard(updateDoc(raceRef(raceId), patch));
  const patchRacer = (rid, patch) => guard(updateDoc(racerRef(raceId, rid), patch));

  const addRacer = () => {
    const order = racers.length ? Math.max(...racers.map((r) => r.order || 0)) + 1 : 0;
    return guard(setDoc(racerRef(raceId, newId(10)), {
      name: "", bank: "", characterId: (race.characters?.[0]?.id) || "",
      entries: [], order, createdAt: serverTimestamp(),
    }));
  };

  const removeRacer = async (r) => {
    if (!(await askConfirm(`Remove ${r.name || "this racer"} and their whole savings log? This can't be undone.`))) return;
    return guard(deleteDoc(racerRef(raceId, r.id)));
  };

  const addEntry = (r, entry) =>
    patchRacer(r.id, { entries: [...(r.entries || []), { id: newId(8), ...entry }] });

  const toggleEntry = (r, eid) =>
    patchRacer(r.id, {
      entries: (r.entries || []).map((e) => (e.id === eid ? { ...e, confirmed: !e.confirmed } : e)),
    });

  const removeEntry = (r, eid) =>
    patchRacer(r.id, { entries: (r.entries || []).filter((e) => e.id !== eid) });

  const editEntryAmount = (r, eid, amount) =>
    patchRacer(r.id, {
      entries: (r.entries || []).map((e) => (e.id === eid ? { ...e, amount: Math.round(Number(amount) || 0) } : e)),
    });

  const clearLog = async (r) => {
    if (!(await askConfirm(`Erase ${r.name || "this racer"}'s whole savings log? This can't be undone.`))) return;
    return patchRacer(r.id, { entries: [], targetDate: "", cadence: "every:1" });
  };

  /* target date / cadence change → (re)build the planned, uncheck-yet entries for the remaining balance.
     every installment is a whole number, and the last one absorbs whatever rounding left over so the
     total lands exactly on the remaining balance — never over, never under. */
  const applySavingsPlan = (r, targetDate, cadence) => {
    const remaining = Math.max(0, Math.round((Number(race.goal) || 0) - r.saved));
    const keep = (r.entries || []).filter((e) => !(e.source === "plan" && !e.confirmed));
    const patch = { targetDate, cadence };
    if (targetDate && remaining > 0) {
      const dates = scheduleDates(targetDate, cadence);
      const per = dates.length ? Math.round(remaining / dates.length) : 0;
      const planned = dates.map((d, i) => ({
        id: newId(8),
        amount: i === dates.length - 1 ? remaining - per * (dates.length - 1) : per,
        date: d, confirmed: false, source: "plan",
      }));
      patch.entries = [...keep, ...planned];
    } else {
      patch.entries = keep;
    }
    return patchRacer(r.id, patch);
  };

  /* ---------- derived ---------- */

  const cur = race?.currency || "₱";
  const goal = Number(race?.goal) || 0;

  const rows = useMemo(() => {
    const base = racers.map((r, i) => {
      const entries = r.entries || [];
      const saved = entries.filter((e) => e.confirmed).reduce((s, e) => s + Number(e.amount || 0), 0);
      const planned = entries.filter((e) => !e.confirmed).reduce((s, e) => s + Number(e.amount || 0), 0);
      const pct = goal > 0 ? saved / goal : 0;
      return { ...r, slot: i + 1, saved, planned, pct, home: pct >= 1 };
    });
    const named = base.filter((r) => (r.name || "").trim());
    [...named]
      .sort((a, b) => b.pct - a.pct || a.slot - b.slot)
      .forEach((r, i) => { r.rank = i + 1; });
    return base;
  }, [racers, goal]);

  const pooled = rows.reduce((s, r) => s + r.saved, 0);
  const joined = rows.filter((r) => (r.name || "").trim()).length;
  const leader = rows.find((r) => r.rank === 1);
  const activeRow = detailRacerId ? rows.find((x) => x.id === detailRacerId) : null;

  /* whoever created the race is the host — only they can touch race setup,
     the racer list, and the character library; everyone else's own profile
     page is still theirs to edit. Races from before hostRacerId existed
     fall back to whoever has order 0, same racer createRace always used. */
  const myRacerId = raceId ? localStorage.getItem(lsRacer(raceId)) : null;
  const hostRacerId = (race && race !== "missing" && race.hostRacerId)
    || [...rows].sort((a, b) => (a.order || 0) - (b.order || 0))[0]?.id;
  const isAdmin = !!myRacerId && myRacerId === hostRacerId;

  /* ---------- screens ---------- */

  if (!configured) return html`<${SetupGate} />`;
  if (fatal) return html`<${MessageGate} title="Almost there" body=${fatal} />`;
  if (!raceId) return html`<${JoinGate} onCreate=${createRace} onJoin=${joinRace} />`;
  if (race === "missing")
    return html`<${MessageGate}
      title="No race with that code"
      body="Double-check the code, or ask whoever's hosting to resend it."
      action=${{ label: "← Back", fn: backToGate }} />`;
  if (showSplash) return html`<${SplashScreen} out=${splashOut} />`;
  if (!race) return html`<${SplashScreen} out=${false} />`;

  return html`
    <div class="shell">
      <div style="height:env(safe-area-inset-top, 0px)"></div>

      <header class="masthead">
        <div class="trip-name-wrap trip-name-wrap--full">
          <${LiveInput}
            className="trip-name"
            value=${race.tripName}
            aria-label="Trip name"
            placeholder="Name this race"
            onCommit=${(v) => patchRace({ tripName: v })} />
          <span class="trip-name-wrap__pencil" aria-hidden="true">✎</span>
        </div>
      </header>

      <div ref=${tabContentRef}
        class=${"tab-content" + ((tabEntering || tabLeaving) ? " tab-content--entering" : "")}
        style=${`transform-origin:${tabOrigin}`}
        onPointerDown=${onSwipeDown} onPointerUp=${onSwipeUp}>

        ${tab === "track" && html`<${RaceHero} race=${race} rows=${rows} cur=${cur} pooled=${pooled} />`}

        ${tab === "dashboard" && html`
          <button class="backbtn" onClick=${goBack}>← Back</button>
          <${HomeTab}
            race=${race} cur=${cur} rows=${rows} isAdmin=${isAdmin}
            onPatchRace=${patchRace}
            onPatchRacer=${patchRacer}
            onAddRacer=${addRacer}
            onRemoveRacer=${removeRacer}
            say=${say} />`}

        ${tab === "racewin" && (
          detailRacerId
            ? (activeRow
                ? html`<${RacerDetailPage} r=${activeRow} race=${race} cur=${cur}
                    isOwner=${activeRow.id === myRacerId}
                    onBack=${() => setDetailRacerId(null)}
                    onAddEntry=${(e) => addEntry(activeRow, e)}
                    onToggleEntry=${(eid) => toggleEntry(activeRow, eid)}
                    onRemoveEntry=${(eid) => removeEntry(activeRow, eid)}
                    onEditAmount=${(eid, amt) => editEntryAmount(activeRow, eid, amt)}
                    onApplyPlan=${(t, c) => applySavingsPlan(activeRow, t, c)}
                    onClearLog=${() => clearLog(activeRow)} />`
                : html`<div class="tab-panel"><div class="empty">This racer was removed.</div>
                    <button class="btn" onClick=${() => setDetailRacerId(null)}>← Back</button></div>`)
            : html`
                <button class="backbtn" onClick=${goBack}>← Back</button>
                <${RaceWinTab} race=${race} cur=${cur} rows=${rows} raceCode=${raceId}
                  onOpenRacer=${setDetailRacerId}
                  onLeave=${leaveRace}
                  onReplayTutorial=${replayTutorial}
                  onOpenSound=${() => setShowSound(true)}
                  say=${say} />`
        )}
      </div>

      ${tab === "track" && html`<${TabNav} onChange=${changeTab} />`}

      <p style="text-align:center;color:var(--ink-faint);font-size:12px;margin-top:40px">
        Racers on this race can see and edit everything. Share the code only with people you trust.
      </p>

      ${toast && html`<div class=${"toast " + (toast.bad ? "toast--bad" : "")}>${toast.msg}</div>`}

      ${tutorial.phase === "welcome" && html`<${TutorialWelcome} onStart=${startTour} onSkip=${skipWelcome} />`}
      ${tutorial.phase === "touring" && html`<${TutorialOverlay}
        step=${TUTORIAL_STEPS[tutorial.step]} index=${tutorial.step} total=${TUTORIAL_STEPS.length} tab=${tab}
        onNext=${nextTutorialStep} onBack=${backTutorialStep} onSkip=${skipTour} />`}
      ${tutorial.phase === "celebrating" && html`<${TutorialCelebration} onDismiss=${finishCelebration} />`}
      ${showSound && html`<${SoundSettingsModal} onClose=${() => setShowSound(false)} />`}
    </div>`;
}

/* ============================================================
   TABS
   ============================================================ */

const TABS = [
  { id: "dashboard", label: "Dashboard", accent: "gold" },
  { id: "racewin", label: "Racer profiles", accent: "teal" },
];

function TabNav({ onChange }) {
  return html`
    <nav class="tabnav">
      ${TABS.map((t) => html`
        <button key=${t.id} class=${`tabnav__btn tabnav__btn--${t.accent}`}
          onClick=${(e) => onChange(t.id, e)}>${t.label}</button>`)}
    </nav>`;
}

/* ---------- RACE TRACKER (home) — podium + track ---------- */

function RaceHero({ race, rows, cur, pooled }) {
  return html`
    <div class="hero">
      <p class="pooledtotal">Pooled so far: <b>${money(pooled, cur)}</b></p>

      <section class="section">
        <div class="podium" ref=${registerTarget("podium")}>
          ${[1, 2, 3].map((n) => {
            const r = rows.find((x) => x.rank === n);
            const character = r ? (race.characters || []).find((c) => c.id === r.characterId) : null;
            const face = character ? (character.finish || character.moving || character.start) : null;
            return html`<div class=${`place place--${n} ${r ? "" : "place--none"}`}>
              <div class="place__avatar avatar avatar--${r ? laneClass(r) : "auto"}" style=${r ? laneStyle(r) : ""}>
                ${face ? html`<img src=${face} alt="" loading="lazy" />` : html`<span>${r ? initial(r.name) : "?"}</span>`}
              </div>
              <div class="place__block">
                <div class="place__no">${n}</div>
              </div>
              <div class="place__name">${r ? r.name : "—"}</div>
              <div class="place__pct">${r ? Math.round(r.pct * 100) + "%" : "open"}</div>
            </div>`;
          })}
        </div>
      </section>

      <section class="section">
        <h2 class="section__label">The Money Marathon</h2>
        <div class="panel track" ref=${registerTarget("lanes")}>
          ${rows.length === 0
            ? html`<div class="empty"><strong>The track is empty.</strong>Add a racer on the Dashboard to open the first lane.</div>`
            : rows.map((r) => html`<${Lane} key=${r.id} r=${r} race=${race} cur=${cur} />`)}
        </div>
      </section>
    </div>`;
}

function Lane({ r, race, cur }) {
  const named = (r.name || "").trim();
  const character = (race.characters || []).find((c) => c.id === r.characterId);
  const shown = Math.max(0, Math.min(1, r.pct));
  const left = 6 + shown * 86;

  const src = character
    ? (r.pct >= 1 ? character.finish : r.pct > 0 ? character.moving : character.start) ||
      character.moving || character.start
    : null;

  return html`
    <div class=${`lane lane--${laneClass(r)} ${r.home ? "lane--home" : ""} ${named ? "" : "lane--empty"}`} style=${laneStyle(r)}>
      <div class="lane__head">
        <span class="lane__no">${String(r.slot).padStart(2, "0")}</span>
        <span class="lane__name">${named || "Open lane"}</span>
        <span class="lane__stats">
          <span>${compact(r.saved, cur)}</span>
          <span class="lane__pct">${Math.round(r.pct * 100)}%</span>
        </span>
      </div>
      <div class="lane__body">
        <div class="strip">
          <div class="strip__fill" style=${`width:${shown * 100}%`}></div>
          <div class="racer-sprite ${src ? "" : "racer-sprite--blank"}" style=${`left:${left}%`}>
            ${src
              ? html`<img src=${src} alt="" loading="lazy" />`
              : html`<span>${named ? initial(named) : "+"}</span>`}
          </div>
        </div>
        <div class="flagpost"><span class="flagpost__flag">🏁</span></div>
      </div>
    </div>`;
}

/* ---------- HOME TAB — setup, racers, characters, leave ---------- */

function HomeTab({ race, cur, rows, isAdmin, onPatchRace, onPatchRacer, onAddRacer, onRemoveRacer, say }) {
  const [form, setForm] = useState({ name: "", start: "", moving: "", finish: "" });
  const [uploading, setUploading] = useState({});
  const [cropTarget, setCropTarget] = useState(null);
  const [addAttempted, setAddAttempted] = useState(false);
  const [shakeN, setShakeN] = useState(0);
  const [addingCharacter, setAddingCharacter] = useState(false);
  const characters = race.characters || [];
  const busy = !!cropTarget || Object.values(uploading).some(Boolean);

  const missing = {
    name: !form.name.trim(),
    start: !form.start,
    moving: !form.moving,
    finish: !form.finish,
  };
  const showInvalid = addAttempted;

  const addCharacter = () => {
    if (Object.values(missing).some(Boolean)) {
      setAddAttempted(true);
      setShakeN((n) => n + 1);
      navigator.vibrate?.(200);
      say("Fill in the character's name and all three poses before adding.", true);
      return;
    }
    setAddAttempted(false);
    onPatchRace({ characters: [...characters, { id: newId(8), ...form }] });
    setForm({ name: "", start: "", moving: "", finish: "" });
    setAddingCharacter(false);
  };

  const cancelAddCharacter = () => {
    setForm({ name: "", start: "", moving: "", finish: "" });
    setAddAttempted(false);
    setAddingCharacter(false);
  };

  const removeCharacter = async (id) => {
    if (rows.some((r) => r.characterId === id) &&
        !(await askConfirm("Someone is racing as this character. Remove it anyway?"))) return;
    if (!rows.some((r) => r.characterId === id) &&
        !(await askConfirm("Remove this character from the library?"))) return;
    onPatchRace({ characters: characters.filter((c) => c.id !== id) });
  };

  const uploadField = async (field, file) => {
    if (!storage || !file) return;
    setUploading((u) => ({ ...u, [field]: true }));
    try {
      const toSend = await compressImage(file);
      const path = `characters/${newId(12)}-${field}-${toSend.name}`;
      const ref = storageRef(storage, path);
      await uploadBytes(ref, toSend, { contentType: toSend.type || "image/*" });
      const url = await getDownloadURL(ref);
      setForm((f) => ({ ...f, [field]: url }));
    } catch (err) {
      const msg = err.code === "storage/unauthorized"
        ? "Storage isn't set up on this Firebase project yet — ask the developer to enable it."
        : err.code === "storage/object-not-found"
          ? "Upload failed — try again."
          : (err.message || "Couldn't upload that image");
      say(msg, true);
    } finally {
      setUploading((u) => ({ ...u, [field]: false }));
    }
  };

  /* one upload at a time — GIFs skip the cropper so their animation survives */
  const pickFile = (field, file) => {
    if (busy || !file) return;
    if (file.type === "image/gif") uploadField(field, file);
    else setCropTarget({ field, file });
  };

  const handleCropSave = (blob) => {
    const { field } = cropTarget;
    setCropTarget(null);
    uploadField(field, new File([blob], "crop.png", { type: "image/png" }));
  };

  return html`
    <div class="tab-panel">
      ${!isAdmin && html`<p class="adminlock">Only the race host can edit this — you're all set on your own profile.</p>`}
      <div class=${isAdmin ? "" : "adminlock__area"}>
      <section class="section">
        <div class="goalcard" ref=${registerTarget("currency")}>
          <p class="goalcard__label">Goal per person</p>
          <div class="goalcard__row">
            <${Dropdown} className="dropdown--inline" compact=${true} value=${cur} ariaLabel="Currency"
              options=${CURRENCIES.map((c) => ({ value: c.id, label: c.label }))}
              onChange=${(v) => onPatchRace({ currency: v })} />
            <${LiveInput} className="goalcard__amount"
              value=${race.goal} inputmode="numeric" aria-label="Goal per person"
              onCommit=${(v) => onPatchRace({ goal: Math.round(Number(v)) || 0 })} />
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section__label">Racers</h2>
        <div class="racerlist" ref=${registerTarget("racers_panel")}>
          ${rows.length === 0
            ? html`<div class="empty">No lanes yet. Add one below.</div>`
            : rows.map((r) => html`<${RacerIdentityRow} key=${r.id} r=${r} race=${race}
                onPatch=${(p) => onPatchRacer(r.id, p)}
                onRemove=${() => onRemoveRacer(r)} />`)}
        </div>
        <div style="margin-top:12px">
          <button class="btn btn--go" ref=${registerTarget("add_racer")} onClick=${onAddRacer}>+ Add a racer</button>
        </div>
      </section>

      <section class="section">
        <h2 class="section__label">Character library</h2>
        <div class="charlist" ref=${registerTarget("character_library")}>
          ${characters.length === 0 && !addingCharacter
            ? html`<div class="empty">No characters yet. Add one below.</div>`
            : characters.map((c) => html`
                <div class="charcard" key=${c.id}>
                  <div class="charcard__head">
                    <span class="charcard__name">${c.name}</span>
                    <button class="charcard__remove" onClick=${() => removeCharacter(c.id)} aria-label="Remove character">×</button>
                  </div>
                  <div class="charcard__poses">
                    ${["start", "moving", "finish"].map((k) => html`
                      <div class="charcard__pose" key=${k}>
                        ${c[k]
                          ? html`<img src=${c[k]} alt="" loading="lazy" />`
                          : html`<span class="charcard__pose-label">${k === "moving" ? "Running" : k[0].toUpperCase() + k.slice(1)}</span>`}
                      </div>`)}
                  </div>
                </div>`)}

          ${addingCharacter && html`
            <div class="charcard charcard--editing" key=${shakeN} style=${shakeN ? "animation:shake 0.4s" : ""}>
              <div class="charcard__head">
                <input class=${"field charcard__name-input" + (showInvalid && missing.name ? " field--invalid" : "")}
                  placeholder="Character name" value=${form.name}
                  onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, name: v })); }} />
                <button class="charcard__remove" onClick=${cancelAddCharacter} aria-label="Cancel adding a character">×</button>
              </div>
              ${showInvalid && missing.name && html`<div class="charform__err">Name is required.</div>`}
              <div class="charcard__editposes">
                <${ImagePicker} label="Start pose" value=${form.start} uploading=${uploading.start} disabled=${busy}
                  invalid=${showInvalid && missing.start}
                  onChange=${(v) => setForm((f) => ({ ...f, start: v }))} onPick=${(f) => pickFile("start", f)} />
                <${ImagePicker} label="Running pose" value=${form.moving} uploading=${uploading.moving} disabled=${busy}
                  invalid=${showInvalid && missing.moving}
                  onChange=${(v) => setForm((f) => ({ ...f, moving: v }))} onPick=${(f) => pickFile("moving", f)} />
                <${ImagePicker} label="Finish pose" value=${form.finish} uploading=${uploading.finish} disabled=${busy}
                  invalid=${showInvalid && missing.finish}
                  onChange=${(v) => setForm((f) => ({ ...f, finish: v }))} onPick=${(f) => pickFile("finish", f)} />
              </div>
            </div>`}
        </div>

        <div style="margin-top:12px;display:flex;justify-content:center">
          ${addingCharacter
            ? html`<button class="btn btn--go" onClick=${addCharacter}>✓ Add character</button>`
            : html`<button class="btn btn--go" onClick=${() => setAddingCharacter(true)}>+ Add character</button>`}
        </div>
      </section>
      </div>

      ${cropTarget && html`<${ImageCropModal} file=${cropTarget.file}
        onCancel=${() => setCropTarget(null)} onSave=${handleCropSave} />`}
    </div>`;
}

/* ---------- crop-to-circle modal (pan / zoom / rotate, then Save) ---------- */

const CROP_STAGE = 280;
const CROP_CIRCLE = 240;
const CROP_OUTPUT = 512;

function ImageCropModal({ file, onCancel, onSave }) {
  const [img, setImg] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [zoomT, setZoomT] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => { setRotation(0); setZoomT(0); setPan({ x: 0, y: 0 }); }, [img]);

  const naturalW = img ? img.naturalWidth : 1;
  const naturalH = img ? img.naturalHeight : 1;
  const baseScale = CROP_CIRCLE / Math.min(naturalW, naturalH);
  const maxZoomMult = Math.max(1, 1 / baseScale); // never upscale past the source's own resolution
  const zoomMult = 1 + zoomT * (maxZoomMult - 1);
  const scale = baseScale * zoomMult;
  const dispW = naturalW * scale;
  const dispH = naturalH * scale;

  const clampPan = (p) => {
    const rotated = rotation % 180 !== 0;
    const effW = rotated ? dispH : dispW;
    const effH = rotated ? dispW : dispH;
    const maxX = Math.max(0, (effW - CROP_CIRCLE) / 2);
    const maxY = Math.max(0, (effH - CROP_CIRCLE) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  };

  useEffect(() => { setPan((p) => clampPan(p)); }, [scale, rotation]);

  const onDown = (e) => {
    if (!img) return;
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setPan(clampPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy }));
  };
  const onUp = () => { dragRef.current = null; };

  const save = () => {
    if (!img) return;
    const k = CROP_OUTPUT / CROP_CIRCLE;
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(CROP_OUTPUT / 2 + pan.x * k, CROP_OUTPUT / 2 + pan.y * k);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale * k, scale * k);
    ctx.drawImage(img, -naturalW / 2, -naturalH / 2, naturalW, naturalH);
    ctx.restore();
    canvas.toBlob((blob) => { if (blob) onSave(blob); }, "image/png", 0.95);
  };

  const dimStyle = img
    ? `position:absolute;left:${CROP_STAGE / 2 - dispW / 2 + pan.x}px;top:${CROP_STAGE / 2 - dispH / 2 + pan.y}px;width:${dispW}px;height:${dispH}px;transform:rotate(${rotation}deg);`
    : "";
  const innerStyle = img
    ? `position:absolute;left:${CROP_CIRCLE / 2 - dispW / 2 + pan.x}px;top:${CROP_CIRCLE / 2 - dispH / 2 + pan.y}px;width:${dispW}px;height:${dispH}px;transform:rotate(${rotation}deg);`
    : "";

  return html`
    <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="modal cropmodal">
        <p class="modal__msg">Adjust your photo — drag to reposition</p>
        <div class="cropstage"
          onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerLeave=${onUp}>
          ${img && html`
            <div class="cropstage__dim" style=${dimStyle}><img src=${img.src} style="width:100%;height:100%;display:block" /></div>
            <div class="cropstage__circle">
              <div class="cropstage__inner" style=${innerStyle}><img src=${img.src} style="width:100%;height:100%;display:block" /></div>
            </div>`}
        </div>
        <div class="cropctl">
          <span style="font-size:14px;color:var(--ink-faint)">−</span>
          <input type="range" min="0" max="1" step="0.01" value=${zoomT}
            disabled=${maxZoomMult <= 1} onInput=${(e) => setZoomT(Number(e.target.value))} aria-label="Zoom" />
          <span style="font-size:14px;color:var(--ink-faint)">+</span>
          <button class="btn btn--sm btn--ghost" onClick=${() => setRotation((r) => (r + 90) % 360)}>⟳ Rotate</button>
        </div>
        <div class="modal__actions">
          <button class="btn btn--ghost" onClick=${onCancel}>Cancel</button>
          <button class="btn btn--go" disabled=${!img} onClick=${save}>Save</button>
        </div>
      </div>
    </div>`;
}

function ImagePicker({ label, value, uploading, disabled, invalid, onChange, onPick }) {
  const locked = uploading || disabled;
  return html`
    <div class=${"imgpick" + (invalid ? " imgpick--invalid" : "")}>
      <div class="imgpick__label">${label}${invalid ? " *" : ""}</div>
      ${value && html`<img class="imgpick__preview" src=${value} alt="" />`}
      <input class=${"field" + (invalid ? " field--invalid" : "")} placeholder="Paste an image URL…" value=${value}
        disabled=${locked} onInput=${(e) => onChange(e.target.value)} />
      <label class=${"btn btn--sm btn--ghost imgpick__upload" + (locked ? " btn--disabled" : "")}>
        ${uploading ? "Uploading…" : disabled ? "Please wait…" : "Upload a photo or GIF"}
        <input type="file" accept="image/*,image/gif" style="display:none" disabled=${locked}
          onChange=${(e) => { if (e.target.files[0]) onPick(e.target.files[0]); e.target.value = ""; }} />
      </label>
    </div>`;
}

function RacerIdentityRow({ r, race, onPatch, onRemove }) {
  return html`
    <div class="racercard">
      <div class="racercard__row">
        <${LiveInput} className="field racercard__name"
          value=${r.name} placeholder="Who's in this lane?" aria-label="Racer name"
          onCommit=${(v) => onPatch({ name: v })} />
        <${BankPicker} value=${r.bank} onChange=${(v) => onPatch({ bank: v })} />
      </div>
      <div class="racercard__row">
        <${Dropdown} className="dropdown--char" value=${r.characterId || ""} ariaLabel="Character"
          options=${[{ value: "", label: "No character" }, ...(race.characters || []).map((c) => ({ value: c.id, label: c.name }))]}
          onChange=${(v) => onPatch({ characterId: v })} />
        <${ColorPicker} value=${r.color || ""} onChange=${(v) => onPatch({ color: v })} />
        <button class="racercard__remove" onClick=${onRemove} aria-label="Remove racer">×</button>
      </div>
    </div>`;
}

function ColorPicker({ value, onChange }) {
  const custom = isHexColor(value);
  const [wheelOpen, setWheelOpen] = useState(false);
  const options = [
    ...PROFILE_COLORS.map((c) => ({ value: c.id, label: c.label, swatch: c.id })),
    custom ? { value, label: "Custom", swatch: value } : { value: "__custom__", label: "Custom…", swatch: "" },
  ];
  /* the box itself fills solid with whatever's actually picked — preset or
     custom — so you can see exactly what it'll look like, not just a dot */
  const fillColor = custom ? value : LANE_PRESET_FILLS[value] || null;
  return html`
    <div style="flex:1;min-width:120px">
      <${Dropdown} className="dropdown--color" value=${custom ? value : (value || "")} ariaLabel="Profile color"
        options=${options} fillColor=${fillColor}
        onChange=${(v) => (v === "__custom__" || isHexColor(v) ? setWheelOpen(true) : onChange(v))} />
      ${wheelOpen && html`<${ColorWheelModal} value=${custom ? value : "#37e0c8"} onChange=${onChange}
        onClose=${() => setWheelOpen(false)} />`}
    </div>`;
}

/* custom hue/saturation wheel + brightness slider + hex field — replaces the
   native <input type=color>, whose Android picker UI can't be typed into
   precisely and doesn't always round-trip the exact chosen shade */
function ColorWheelModal({ value, onChange, onClose }) {
  const start = useMemo(() => hexToHsv(value), []);
  const [h, setH] = useState(start.h);
  const [s, setS] = useState(start.s);
  const [v, setV] = useState(Math.max(start.v, 0.35));
  const [hexDraft, setHexDraft] = useState(value);
  const wheelRef = useRef(null);
  const dragging = useRef(false);

  const hex = hsvToHex(h, s, v);
  useEffect(() => { setHexDraft(hex); }, [hex]);

  const setFromPointer = (e) => {
    const rect = wheelRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const radius = rect.width / 2;
    const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const sat = Math.max(0, Math.min(1, Math.hypot(dx, dy) / radius));
    setH(angle);
    setS(sat);
    onChange(hsvToHex(angle, sat, v));
  };
  const onDown = (e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setFromPointer(e);
  };
  const onMove = (e) => { if (dragging.current) setFromPointer(e); };
  const onUp = () => { dragging.current = false; };

  const onValueInput = (e) => {
    const nv = Number(e.target.value) / 100;
    setV(nv);
    onChange(hsvToHex(h, s, nv));
  };
  const commitHex = (raw) => {
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    if (!isHexColor(withHash)) return;
    const next = hexToHsv(withHash);
    setH(next.h); setS(next.s); setV(next.v);
    onChange(withHash);
  };

  const dotX = 50 + s * 50 * Math.sin(h * Math.PI / 180);
  const dotY = 50 - s * 50 * Math.cos(h * Math.PI / 180);
  const pureAtFullV = hsvToHex(h, s, 1);

  return html`
    <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal" style="max-width:300px;text-align:center">
        <p class="modal__msg" style="margin-bottom:14px;font-weight:700">Pick a color</p>

        <div class="colorwheel" ref=${wheelRef}
          onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerLeave=${onUp}>
          <span class="colorwheel__dot" style=${`left:${dotX}%;top:${dotY}%;background:${hex}`}></span>
        </div>

        <input type="range" min="0" max="100" value=${Math.round(v * 100)} onInput=${onValueInput}
          style=${`margin-top:16px;background:linear-gradient(to right, #000, ${pureAtFullV})`}
          aria-label="Brightness" />

        <div style="display:flex;align-items:center;gap:10px;margin-top:16px">
          <span class="colorwheel__swatch" style=${`background:${hex}`}></span>
          <input class="field field--mono" style="flex:1;text-transform:uppercase" value=${hexDraft}
            onInput=${(e) => setHexDraft(e.target.value)}
            onBlur=${(e) => commitHex(e.target.value.trim())}
            onKeyDown=${(e) => { if (e.key === "Enter") { commitHex(e.target.value.trim()); e.target.blur(); } }} />
        </div>

        <div class="modal__actions" style="margin-top:18px">
          <button class="btn btn--go" style="width:100%" onClick=${onClose}>Done</button>
        </div>
      </div>
    </div>`;
}

function BankPicker({ value, onChange }) {
  const known = BANKS.includes(value);
  const preset = known ? value : (value ? "other" : "");
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState(value || "");

  const options = [
    { value: "", label: "Bank / wallet" },
    ...BANKS.map((b) => ({ value: b, label: b })),
    { value: "other", label: "Other…" },
  ];

  const openOther = () => { setDraft(!known ? value || "" : ""); setAsking(true); };
  const save = () => { onChange(draft.trim()); setAsking(false); };

  return html`
    <div style="flex:1;min-width:130px">
      <${Dropdown} className="dropdown--bank" value=${preset} ariaLabel="Bank or wallet"
        options=${options} onChange=${(v) => (v === "other" ? openOther() : onChange(v))} />
      ${preset === "other" && value && html`
        <div class="setting-row__hint" style="margin-top:4px;cursor:pointer" onClick=${openOther}>${value} (tap to edit)</div>`}

      ${asking && html`
        <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setAsking(false); }}>
          <div class="modal" style="max-width:320px">
            <p class="modal__msg">What's the bank or wallet?</p>
            <input class="field" placeholder="e.g. ING, Wise, Revolut" value=${draft}
              onInput=${(e) => setDraft(e.target.value)}
              onKeyDown=${(e) => e.key === "Enter" && save()} />
            <div class="modal__actions" style="margin-top:16px">
              <button class="btn btn--ghost" onClick=${() => setAsking(false)}>Cancel</button>
              <button class="btn btn--go" onClick=${save}>Save</button>
            </div>
          </div>
        </div>`}
    </div>`;
}

/* ---------- RACER-PROFILES TAB — roster list, tap a racer to open their page ---------- */

function RaceWinTab({ race, cur, rows, raceCode, onOpenRacer, onLeave, onReplayTutorial, onOpenSound, say }) {
  const named = rows.filter((r) => (r.name || "").trim());
  return html`
    <div class="tab-panel">
      <section class="section">
        ${named.length === 0
          ? html`<div class="empty"><strong>No racers yet.</strong>Add someone on the Dashboard first.</div>`
          : html`<div class="panel" ref=${registerTarget("roster_row")} style="padding:0">
              ${named.map((r) => html`<${RosterRow} key=${r.id} r=${r} race=${race} cur=${cur}
                onClick=${() => onOpenRacer(r.id)} />`)}
            </div>`}
      </section>

      <section class="section">
        <div class="racecard" ref=${registerTarget("race_code")}>
          <p class="racecard__label">Race code</p>
          <div class="racecard__code">
            <span>${raceCode}</span>
            <button class="racecard__copy" aria-label="Copy race code" onClick=${() => {
              navigator.clipboard.writeText(raceCode)
                .then(() => say("Race code copied"))
                .catch(() => say(`Code: ${raceCode}`));
            }}>⧉</button>
          </div>
          <div class="racecard__row">
            <button class="btn btn--sm racecard__btn" onClick=${onReplayTutorial}>Watch tutorial</button>
            <button class="btn btn--sm racecard__btn" onClick=${onOpenSound}>Sound & music</button>
          </div>
          <button class="btn btn--sm btn--danger-outline" style="width:100%" onClick=${onLeave}>Leave this race</button>
        </div>
      </section>
    </div>`;
}

function RosterRow({ r, race, cur, onClick }) {
  const character = (race.characters || []).find((c) => c.id === r.characterId);
  const face = character ? (character.moving || character.start) : null;
  return html`
    <button class="rosterrow" onClick=${onClick}>
      <div class=${`avatar avatar--${laneClass(r)}`} style=${laneStyle(r)}>
        ${face ? html`<img src=${face} alt="" loading="lazy" />` : html`<span>${initial(r.name)}</span>`}
      </div>
      <div class="rosterrow__id">
        <div class="card__name-static">${r.name}</div>
        <div class="bar" style="margin:6px 0 0"><div class="bar__fill" style=${`width:${Math.min(100, r.pct * 100)}%`}></div></div>
      </div>
      <div class="rosterrow__money">
        <div style=${`font-family:var(--mono);font-weight:600;color:${r.home ? "var(--gold-deep)" : "var(--teal)"}`}>${money(r.saved, cur)}</div>
        <div style="font-size:12px;color:var(--ink-faint)">${Math.round(r.pct * 100)}%</div>
      </div>
      <span class="rosterrow__chev" aria-hidden="true">☰</span>
    </button>`;
}

/* ---------- RACER PROFILE PAGE — donut chart + stat table + lock log ---------- */

function DonutChart({ pct, size = 176 }) {
  const stroke = 24;
  const r = size / 2 - stroke / 2 - 4;
  const c = 2 * Math.PI * r;
  const saved = c * Math.min(1, Math.max(0, pct));
  return html`
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} role="img"
      aria-label=${`${Math.round(pct * 100)}% saved`}>
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--red)" stroke-opacity="0.32" stroke-width=${stroke} />
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--lane-ink, var(--teal))"
        stroke-width=${stroke} stroke-linecap="round"
        stroke-dasharray=${`${saved} ${c - saved}`}
        transform=${`rotate(-90 ${size / 2} ${size / 2})`}
        style="transition:stroke-dasharray 0.7s cubic-bezier(0.22,0.9,0.28,1)" />
      <text x=${size / 2} y=${size / 2} text-anchor="middle" dominant-baseline="central"
        font-family="'DM Mono', monospace" font-size="30" font-weight="600" fill="var(--lane-ink, var(--ink))">
        ${Math.round(pct * 100)}%
      </text>
    </svg>`;
}

function CadencePicker({ cadence, onChange }) {
  const id = cadence || "every:1";
  const wd = WEEKDAYS.find((w) => w.id === id);
  const n = id.startsWith("every:") ? parseInt(id.split(":")[1], 10) || 1 : 1;
  const preset = wd ? wd.id : (n === 1 || n === 2 || n === 3) ? `every:${n}` : "custom";

  const options = [
    { value: "every:1", label: "Every day" },
    { value: "every:2", label: "Every 2 days" },
    { value: "every:3", label: "Every 3 days" },
    { value: "custom", label: "Custom number of days…" },
    ...WEEKDAYS.map((w) => ({ value: w.id, label: `Every ${w.label}` })),
  ];

  return html`
    <div class="plan__row">
      <${Dropdown} className="dropdown--cadence" value=${preset} ariaLabel="Savings cadence"
        options=${options} onChange=${(v) => onChange(v === "custom" ? "every:4" : v)} />
      ${preset === "custom" && html`
        <span class="plan__label">every</span>
        <input class="field field--mono" type="number" min="1" style="width:64px" value=${n}
          onChange=${(e) => onChange(`every:${Math.max(1, parseInt(e.target.value, 10) || 1)}`)} />
        <span class="plan__label">days</span>`}
    </div>`;
}

function SavingsPlanHint({ r, cur, target, cadence, remaining }) {
  if (r.home) return html`<p class="plan__hint">Already home — nothing left to save. 🏁</p>`;
  if (!target) return html`<p class="plan__hint">Pick a date to get a suggested savings pace.</p>`;

  const days = daysUntil(target);
  if (days < 0) return html`<p class="plan__hint">That date's already passed — pick one in the future.</p>`;

  const payments = paymentsUntil(target, cadence);
  if (payments <= 0) return html`<p class="plan__hint">No more ${cadenceLabel(cadence).toLowerCase()} slots before then — pick a later date.</p>`;

  return html`
    <p class="plan__hint">
      Save <b>${money(remaining / payments, cur)}</b> ${cadenceLabel(cadence).toLowerCase()} to hit the goal by
      ${prettyDate(target)} — ${payments} ${payments === 1 ? "payment" : "payments"}
      (${days} ${days === 1 ? "day" : "days"} from now).
    </p>`;
}

function RacerDetailPage({ r, race, cur, isOwner, onBack, onAddEntry, onToggleEntry, onRemoveEntry, onEditAmount, onApplyPlan, onClearLog }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());

  const remaining = Math.max(0, (Number(race.goal) || 0) - r.saved);
  const cadence = r.cadence || "every:1";
  const target = r.targetDate || "";
  const entries = [...(r.entries || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const submit = () => {
    const amt = Math.round(Number(amount));
    if (!amt) return;
    onAddEntry({ amount: amt, date: date || today(), confirmed: true });
    setAmount("");
    setDate(today());
  };

  return html`
    <div class=${`tab-panel lane--${laneClass(r)}`} style=${laneStyle(r)}>
      <button class="btn btn--sm btn--ghost" onClick=${onBack} style="margin-bottom:14px">← Back to racers</button>

      <div class="detailcard">
        <div class="detailcard__banner">${r.name}${r.home ? " 🏁" : ""}</div>

        <div class="detailcard__body">
          <div class="detailcard__chart" ref=${registerTarget("profile_chart")}><${DonutChart} pct=${r.pct} /></div>

          <table class="stattable" ref=${registerTarget("profile_stats")}>
            <tbody>
              <tr><td class="stattable__label">Bank / Wallet</td><td class="stattable__value">${r.bank || "—"}</td></tr>
              <tr><td class="stattable__label">Goal</td><td class="stattable__value">${money(Number(race.goal) || 0, cur)}</td></tr>
              <tr><td class="stattable__label">Amount Saved</td><td class="stattable__value">${money(r.saved, cur)}</td></tr>
              <tr><td class="stattable__label">Remaining Balance</td><td class="stattable__value">${money(remaining, cur)}</td></tr>
              <tr class="stattable__pctrow"><td colspan="2">Progress Bar — ${Math.round(r.pct * 100)}%</td></tr>
            </tbody>
          </table>
          <div class="bar detailcard__bar"><div class="bar__fill" style=${`width:${Math.min(100, r.pct * 100)}%`}></div></div>

          ${!isOwner && html`<p class="adminlock" style="margin-top:16px">This is ${r.name}'s profile — only they can log or edit their savings.</p>`}
          <div class=${isOwner ? "" : "adminlock__area"}>
          <div class="plan" ref=${registerTarget("profile_plan")}>
            <div class="plan__row">
              <span class="plan__label">Save by</span>
              <input class="field field--mono" type="date" value=${target} min=${today()}
                onChange=${(e) => onApplyPlan(e.target.value, cadence)} />
            </div>
            <${CadencePicker} cadence=${cadence} onChange=${(c) => onApplyPlan(target, c)} />
            ${target && html`<p class="plan__note">Log below is filled in for you — just check off (lock in) each one as you set it aside, or edit the amount.</p>`}
            <${SavingsPlanHint} r=${r} cur=${cur} target=${target} cadence=${cadence} remaining=${remaining} />
          </div>

          <div class="logtable" ref=${registerTarget("profile_log")}>
            <div class="logtable__head">
              <span>Date</span><span>Amount</span><span>Lock</span><span></span>
            </div>
            ${entries.length === 0
              ? html`<div class="empty">Nothing logged yet.</div>`
              : entries.map((e) => html`
                  <div class=${`logtable__row ${e.confirmed ? "" : "logtable__row--planned"}`} key=${e.id}>
                    <span class="entry__date">${prettyDate(e.date)}</span>
                    <span class="entry__amt">
                      <span class="entry__amt-cur">${cur}</span>
                      <${LiveInput} className="entry__amt-input" value=${e.amount} inputmode="numeric"
                        aria-label="Entry amount" onCommit=${(v) => onEditAmount(e.id, v)} />
                    </span>
                    <button class=${`lockbox ${e.confirmed ? "lockbox--on" : ""}`}
                      onClick=${() => onToggleEntry(e.id)}
                      aria-label=${e.confirmed ? "Unlock" : "Lock"}>${e.confirmed ? "✓" : ""}</button>
                    <button class="entry__x" onClick=${() => onRemoveEntry(e.id)} aria-label="Delete entry">×</button>
                  </div>`)}
          </div>

          <div class="detailcard__addrow" ref=${registerTarget("profile_addrow")}>
            <input class="field field--mono" inputmode="numeric" placeholder=${`Amount in ${cur}`}
              value=${amount} onInput=${(e) => setAmount(e.target.value)}
              onKeyDown=${(e) => e.key === "Enter" && submit()} />
            <input class="field field--mono" type="date" value=${date} onInput=${(e) => setDate(e.target.value)} />
            <button class="btn btn--go btn--sm" onClick=${submit} disabled=${!Number(amount)}>Add</button>
            <button class="btn btn--sm btn--danger-outline" onClick=${onClearLog}>Clear log</button>
          </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   TUTORIAL — a spotlight-style guided tour, shown once on first
   ever open (localStorage-persisted), replayable from Home.
   ============================================================ */

const LS_TUTORIAL_SEEN = "mm_tutorial_seen";

/* real DOM elements register themselves here so the overlay can spotlight them */
const tutorialTargets = {};
const registerTarget = (key) => (el) => {
  if (el) tutorialTargets[key] = el; else delete tutorialTargets[key];
};

const TUTORIAL_STEPS = [
  // ---- Race Tracker (home) ----
  { tab: "track", key: "lanes", title: "Watch the race", description: "Every racer's lane fills up as they save. First one to the flag wins." },
  { tab: "track", key: "podium", title: "The podium", description: "The top 3 racers by percentage saved, updated live as everyone logs their money." },
  // ---- Dashboard ----
  { tab: "dashboard", key: "currency", title: "Set your goal", description: "Pick the currency and the exact amount everyone's racing to save. Change it anytime — every racer's progress updates instantly." },
  { tab: "dashboard", key: "racers_panel", title: "Your racers", description: "Everyone racing shows up here. Edit any racer's name, bank/wallet, character, and profile color right from this list." },
  { tab: "dashboard", key: "add_racer", title: "Add a racer", description: "Tap this to open a new lane for a friend who isn't racing yet." },
  { tab: "dashboard", key: "character_library", title: "Character library", description: "Add as many characters as you like — paste an image URL or upload your own photo for the start, running, and finish poses." },
  // ---- Racer Profiles ----
  { tab: "racewin", key: "roster_row", title: "Open a racer's page", description: "Tap any racer here to open their own private page and log what they've saved." },
  { tab: "racewin", key: "profile_chart", title: "Their progress ring", description: "This donut shows exactly how close this racer is to their goal — gold or their own color for saved, red for what's left.", openDetail: true },
  { tab: "racewin", key: "profile_stats", title: "The numbers", description: "Goal, amount saved, remaining balance, and the progress bar — all in one place.", openDetail: true },
  { tab: "racewin", key: "profile_plan", title: "Build a savings plan", description: "Pick a date to save by and how often — every day, every few days, or a specific weekday. The whole log below fills itself in automatically.", openDetail: true },
  { tab: "racewin", key: "profile_log", title: "Log savings & lock them in", description: "Date, amount, and a Lock checkbox for every planned or logged deposit. Tap Lock once you've actually set the money aside — you can also edit any amount right here.", openDetail: true },
  { tab: "racewin", key: "profile_addrow", title: "Add manually or start over", description: "Add a one-off deposit here anytime, or hit Clear log to wipe the whole plan and start fresh.", openDetail: true },
  { tab: "racewin", key: "race_code", title: "Your race code", description: "This is how friends join — they enter this exact code with their own name. Anyone with it can see and edit the whole race." },
];

function TutorialWelcome({ onStart, onSkip }) {
  return html`
    <div class="modal-overlay">
      <div class="modal tutorial-welcome">
        <div class="tutorial-welcome__icon">🏁</div>
        <h3>Welcome to Money Marathon!</h3>
        <p class="modal__msg">Want a quick tour of how everything works? It only takes a minute.</p>
        <button class="btn btn--go" style="width:100%" onClick=${onStart}>Get Started</button>
        <button class="btn btn--ghost" style="width:100%;margin-top:8px" onClick=${onSkip}>Skip</button>
      </div>
    </div>`;
}

function TutorialOverlay({ step, index, total, tab, onNext, onBack, onSkip }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    const measure = () => {
      const el = tutorialTargets[step.key];
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const el = tutorialTargets[step.key];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    measure();
    const raf = requestAnimationFrame(measure);
    // keep re-measuring while the smooth scroll (page or an internal panel) settles
    const ticks = [50, 120, 200, 300, 420, 560].map((ms) => setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      cancelAnimationFrame(raf);
      ticks.forEach(clearTimeout);
    };
  }, [step.key, tab]);

  const pad = 10;
  const hole = rect ? {
    top: rect.top - pad, left: rect.left - pad,
    width: rect.width + pad * 2, height: rect.height + pad * 2,
  } : null;

  const vh = window.innerHeight;
  const spaceBelow = hole ? vh - (hole.top + hole.height) : vh;
  const spaceAbove = hole ? hole.top : 0;
  const showBelow = !hole || spaceBelow >= spaceAbove;
  const cardStyle = showBelow
    ? `top:${hole ? hole.top + hole.height + 14 : vh / 2 - 80}px;`
    : `bottom:${hole ? vh - hole.top + 14 : 0}px;`;

  return html`
    <div class="tutorial-clickcatch" onClick=${onNext}>
      ${hole && html`<div class="tutorial-hole" style=${`top:${hole.top}px;left:${hole.left}px;width:${hole.width}px;height:${hole.height}px;`}></div>`}
      <div class="tutorial-card" style=${cardStyle}>
        <div class="tutorial-card__step">STEP ${index + 1} OF ${total}</div>
        <h3 class="tutorial-card__title">${step.title}</h3>
        <p class="tutorial-card__desc">${step.description}</p>
        <div class="tutorial-card__actions">
          <button class="tutorial-card__link" onClick=${(e) => { e.stopPropagation(); onSkip(); }}>Skip</button>
          ${index > 0 && html`<button class="tutorial-card__link tutorial-card__link--accent"
            onClick=${(e) => { e.stopPropagation(); onBack(); }}>Back</button>`}
          <button class="btn btn--go" onClick=${(e) => { e.stopPropagation(); onNext(); }}>
            ${index === total - 1 ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>`;
}

function TutorialCelebration({ onDismiss }) {
  const colors = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 2.4,
    duration: 2.4 + Math.random() * 1.6,
    color: colors[i % colors.length],
  })), []);
  return html`
    <div class="modal-overlay tutorial-celebrate">
      <div class="tutorial-confetti">
        ${pieces.map((p, i) => html`<span key=${i} class=${`avatar--${p.color}`}
          style=${`left:${p.left}%;animation-delay:${p.delay}s;animation-duration:${p.duration}s;background:var(--lane-ink);`}></span>`)}
      </div>
      <div class="modal" style="text-align:center;position:relative;z-index:2">
        <div style="font-size:40px">🎉</div>
        <h3>You're all set!</h3>
        <p class="modal__msg">Welcome to the race — good luck hitting your goal!</p>
        <button class="btn btn--go" style="width:100%" onClick=${onDismiss}>Let's go</button>
      </div>
    </div>`;
}

/* ---------- sound & music settings ---------- */

function SoundSettingsModal({ onClose }) {
  const [prefs, setPrefs] = useState(soundPrefs);
  const update = (patch) => { applySoundPrefs(patch); setPrefs({ ...soundPrefs }); };

  return html`
    <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal soundmodal">
        <p class="modal__msg" style="margin-bottom:14px;font-weight:700">Sound & Music</p>

        <div class="soundrow">
          <span class="soundrow__label">Background music</span>
          <button class=${"switch " + (prefs.musicOn ? "switch--on" : "")}
            onClick=${() => update({ musicOn: !prefs.musicOn })} aria-label="Toggle background music"><span></span></button>
        </div>
        <input type="range" min="0" max="1" step="0.01" value=${prefs.musicVol} disabled=${!prefs.musicOn}
          onInput=${(e) => update({ musicVol: Number(e.target.value) })} aria-label="Music volume" />

        <div class="soundrow" style="margin-top:18px">
          <span class="soundrow__label">Button sounds</span>
          <button class=${"switch " + (prefs.sfxOn ? "switch--on" : "")}
            onClick=${() => update({ sfxOn: !prefs.sfxOn })} aria-label="Toggle button sounds"><span></span></button>
        </div>
        <input type="range" min="0" max="1" step="0.01" value=${prefs.sfxVol} disabled=${!prefs.sfxOn}
          onInput=${(e) => update({ sfxVol: Number(e.target.value) })} aria-label="Sound effects volume" />

        <div class="modal__actions" style="margin-top:18px">
          <button class="btn btn--go" style="width:100%" onClick=${onClose}>Done</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   GATES
   ============================================================ */

function JoinGate({ onCreate, onJoin }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onCreate(name.trim()); } finally { setBusy(false); }
  };
  const join = async () => {
    if (!name.trim() || !code.trim() || busy) return;
    setBusy(true);
    try { await onJoin(code.trim(), name.trim()); } finally { setBusy(false); }
  };

  return html`
    <div class="gate">
      <h1 class="gate__mark">MONEY<span>MARATHON</span></h1>
      <p class="gate__sub">
        A savings race for you and your friends. Everyone gets a lane, a character,
        and the same finish line.
      </p>
      <div class="panel" style="text-align:left;max-width:360px;margin:0 auto">
        <label class="setting-row__k" style="display:block;margin-bottom:6px">Your name</label>
        <input class="field" style="margin-bottom:16px" placeholder="What should we call you?"
          value=${name} onInput=${(e) => setName(e.target.value)} />
        <button class="btn btn--go" style="width:100%" disabled=${!name.trim() || busy} onClick=${start}>
          ${busy ? "Creating…" : "Start a new race"}
        </button>
        <div class="section__label" style="margin:18px 0 12px">or join one</div>
        <div style="display:flex;gap:8px">
          <input class="field field--mono" style="text-transform:uppercase" placeholder="Race code"
            value=${code} onInput=${(e) => setCode(e.target.value.toUpperCase())} />
          <button class="btn" disabled=${!name.trim() || !code.trim() || busy} onClick=${join}>${busy ? "Joining…" : "Join"}</button>
        </div>
      </div>
    </div>`;
}

function MessageGate({ title, body, action }) {
  return html`
    <div class="gate">
      <h1 class="gate__mark" style="font-size:30px">${title}</h1>
      <p class="gate__sub">${body}</p>
      ${action && html`<button class="btn btn--go" onClick=${action.fn}>${action.label}</button>`}
    </div>`;
}

function SetupGate() {
  return html`
    <div class="gate">
      <h1 class="gate__mark">MONEY<span>MARATHON</span></h1>
      <p class="gate__sub">One step left: point this app at your Firebase project.</p>
      <div class="panel">
        <ol>
          <li>Firebase console → your project → <b>Project settings</b> → <b>Your apps</b> → Web app.</li>
          <li>Copy the <code>firebaseConfig</code> object.</li>
          <li>Paste it into <code>www/firebase-config.js</code>, replacing the placeholder.</li>
          <li>Enable <b>Anonymous</b> sign-in under Authentication → Sign-in method.</li>
          <li>Create a <b>Firestore</b> database and publish the rules from <code>firestore.rules</code>.</li>
          <li>Enable <b>Storage</b> and publish the rules from <code>storage.rules</code> (for character photo uploads).</li>
        </ol>
      </div>
      <p class="gate__note">Full walkthrough is in <code>README.md</code>.</p>
    </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
