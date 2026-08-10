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
  doc, collection, query, orderBy, onSnapshot, enableNetwork,
  setDoc, updateDoc, deleteDoc, getDoc, getDocs, serverTimestamp, increment,
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

/* a racer's own goal if they've set one, otherwise the race's shared goal */
const racerGoal = (r, race) => (r.goal && Number(r.goal) > 0 ? Number(r.goal) : Number(race?.goal) || 0);
/* same fallback pattern as racerGoal — a shared default everyone starts
   with, freely overridden per-racer from their own profile */
const racerTargetDate = (r, race) => r.targetDate || race?.targetDate || "";
const racerCadence = (r, race) => r.cadence || race?.cadence || "every:1";

const today = () => new Date().toISOString().slice(0, 10);

const prettyDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m || 1) - 1]} ${d}`;
};

const initial = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

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
    ? `--lane-fill:${r.color};--lane-ink:${r.color};--lane-contrast:${contrastOn(r.color)};--lane-ink-text:${contrastOn(r.color)};`
    : "";

const DEFAULT_CHARACTERS = [
  {
    id: "orange-cat",
    name: "Orange cat",
    start: "./characters/orange-cat-start.png",
    moving: "./characters/orange-cat-moving.png",
    finish: "./characters/orange-cat-finish.png",
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

/* ============================================================
   ADS — @capacitor-community/admob, accessed the same way every other
   native plugin in this file is: window.Capacitor.Plugins.X, no bundler
   import, since this app has no build step.

   Three ad experiences only: a rewarded ad to unlock adding a character,
   a banner strictly always up on the Dashboard and a racer's own profile,
   and an app-open ad (uses AdMob's Interstitial ad type under the hood —
   this plugin doesn't wrap the dedicated App Open format — but it only
   ever fires from the resume handler, there's no separate/extra
   interstitial anywhere else in this file). All three IDs are real, and
   ADMOB_TESTING is off — these are live. */
const ADMOB_BANNER_ID = "ca-app-pub-9372606273046322/9522907425";
const ADMOB_INTERSTITIAL_ID = "ca-app-pub-9372606273046322/5534581013";
const ADMOB_REWARDED_ID = "ca-app-pub-9372606273046322/3033520698";
const ADMOB_TESTING = false;

/* a real race condition lived here before: setting a boolean flag BEFORE
   awaiting initialize() meant a second caller landing in the same tick
   (the warm-up effect and the banner effect both fire on mount) would see
   "already initialized" and immediately call showBanner()/etc while the
   FIRST initialize() call was still in flight — the SDK wasn't actually
   ready yet, so that early request just silently went nowhere. Storing
   the promise itself means every caller, no matter how many pile up
   before it resolves, waits on the exact same one. */
let admobInitPromise = null;
function ensureAdMobInit() {
  const AM = window.Capacitor?.Plugins?.AdMob;
  if (!AM) return Promise.resolve(null);
  if (!admobInitPromise) {
    admobInitPromise = AM.initialize({ initializeForTesting: ADMOB_TESTING }).catch(() => {}).then(() => AM);
  }
  return admobInitPromise;
}

/* showBanner() actually creates/loads the native banner view — calling it
   repeatedly to "keep it aggressive" tears the view down and rebuilds it
   every time, which is what was making it flicker out instead of staying
   up. resumeBanner() is the plugin's own API for "make sure it's visible
   again" on an already-created banner, so that's what reassertion uses. */
let bannerActive = false;

async function showAdBanner() {
  const AM = await ensureAdMobInit();
  if (!AM) return;
  try {
    await AM.showBanner({
      adId: ADMOB_BANNER_ID, adSize: "ADAPTIVE_BANNER", position: "BOTTOM_CENTER", isTesting: ADMOB_TESTING,
    });
    bannerActive = true;
  } catch {}
}
async function resumeAdBanner() {
  const AM = window.Capacitor?.Plugins?.AdMob;
  if (!AM || !bannerActive) return;
  try { await AM.resumeBanner(); } catch {}
}
async function hideAdBanner() {
  const AM = window.Capacitor?.Plugins?.AdMob;
  if (!AM) return;
  bannerActive = false;
  try { await AM.hideBanner(); } catch {}
}

/* the "app open" slot — this plugin doesn't wrap AdMob's dedicated App
   Open ad format, so an interstitial fired right on resume is the standard
   stand-in every Capacitor app uses for that slot. Half the time, per the
   ask, uncapped — every single resume gets its own independent coin flip,
   as many times as the app is backgrounded and reopened. A resume only
   ever fires coming BACK from background though, never on a cold start,
   so this never interrupts someone's very first open. */
/* showing ANY full-screen ad (this interstitial, or the rewarded one below)
   is itself an Android activity transition — it fires a "pause" then a
   "resume" on the app's own activity, exactly like backgrounding it. Left
   unguarded, closing one app-open ad re-triggers the resume listener,
   which can roll and show ANOTHER one — the "keeps repeating" bug. This
   flag makes the resume handler ignore resumes caused by our own ad. */
let showingFullScreenAd = false;

async function maybeShowAppOpenAd() {
  if (showingFullScreenAd) return;
  if (Math.random() >= 0.5) return;
  const AM = await ensureAdMobInit();
  if (!AM) return;
  showingFullScreenAd = true;
  try {
    await AM.prepareInterstitial({ adId: ADMOB_INTERSTITIAL_ID, isTesting: ADMOB_TESTING });
    await AM.showInterstitial();
  } catch {}
  /* the dismissal's own resume event can land shortly after showInterstitial
     resolves, not exactly on it — a short grace window swallows that too */
  setTimeout(() => { showingFullScreenAd = false; }, 2000);
}

/* used to gate adding a new character — resolves true once the reward is
   actually granted. No AdMob plugin present (browser testing) never blocks
   the feature, it just skips straight to "rewarded" so dev/testing isn't
   stuck behind a native-only ad. Also raises the same guard as the app-open
   ad above, so finishing a rewarded ad can't spuriously trigger THAT one too. */
async function showRewardedAd() {
  const AM = await ensureAdMobInit();
  if (!AM) return true;
  showingFullScreenAd = true;
  try {
    await AM.prepareRewardVideoAd({ adId: ADMOB_REWARDED_ID, isTesting: ADMOB_TESTING });
    const result = await AM.showRewardVideoAd();
    return !!result;
  } catch {
    return false;
  } finally {
    setTimeout(() => { showingFullScreenAd = false; }, 2000);
  }
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

/* fires right away — no schedule.at means "now" — for real-time race
   events (someone joined/left) rather than a scheduled reminder. Purely a
   device notification alongside the in-app toast, so it's noticed even
   while the app is backgrounded; never blocks on permission being denied. */
async function notifyNow(title, body) {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== "granted") perm = await LN.requestPermissions();
    if (perm.display !== "granted") return;
    await LN.schedule({ notifications: [{ id: Date.now() % 2147483647, title, body }] });
  } catch {}
}

/* savings-day reminder ids are date-based (y*10000 + m*100 + d), so they
   always land under ~21,000,000 — filtering on that keeps this from also
   wiping the separate inactivity-warning reminders below, which share the
   same OS notification queue but live in a deliberately disjoint id range */
async function cancelAllSavingsReminders() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    const pending = await LN.getPending();
    const mine = (pending?.notifications || []).filter((n) => n.id < 100000000);
    if (mine.length) await LN.cancel({ notifications: mine.map((n) => ({ id: n.id })) });
  } catch {}
}

/* 90 days of total silence from a racer's own device is the signal their
   account is genuinely abandoned (see expiresAt below) — these three give
   fair warning before that happens, entirely offline: scheduled once, they
   fire on the OS's own clock even if the app never opens again. */
const EXPIRY_DAYS = 90;
const nextExpiry = () => new Date(Date.now() + EXPIRY_DAYS * 86400000);
const INACTIVITY_NOTIF_IDS = { d30: 500000001, d60: 500000002, d83: 500000003 };

async function cancelInactivityReminders() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    await LN.cancel({ notifications: Object.values(INACTIVITY_NOTIF_IDS).map((id) => ({ id })) });
  } catch {}
}

/* re-arms all three relative to right now — call this on anything that
   counts as "still here," and the 90-day countdown genuinely restarts */
async function syncInactivityReminders(tripName) {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== "granted") perm = await LN.requestPermissions();
    if (perm.display !== "granted") return;

    await cancelInactivityReminders();

    const label = tripName || "your race";
    const now = Date.now();
    const DAY = 86400000;
    await LN.schedule({
      notifications: [
        {
          id: INACTIVITY_NOTIF_IDS.d30, title: "Money Marathon",
          body: `You haven't opened "${label}" in 30 days — keep saving so your spot doesn't expire.`,
          schedule: { at: new Date(now + 30 * DAY), allowWhileIdle: true },
        },
        {
          id: INACTIVITY_NOTIF_IDS.d60, title: "Money Marathon",
          body: `60 days inactive on "${label}" — your racer will be erased if you don't come back soon.`,
          schedule: { at: new Date(now + 60 * DAY), allowWhileIdle: true },
        },
        {
          id: INACTIVITY_NOTIF_IDS.d83, title: "Money Marathon",
          body: `1 week left — "${label}" will erase your racer profile in 7 days if you don't log back in.`,
          schedule: { at: new Date(now + 83 * DAY), allowWhileIdle: true },
        },
      ],
    });
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
  const [isOnline, setIsOnline] = useState(navigator.onLine);
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
  const [congrats, setCongrats] = useState(null);
  /* navigator.onLine only tells you the device HAS a network interface up —
     it stays true on a dead wifi or a captive portal. Whether Firestore's
     snapshots are actually coming from the server (vs its local cache) is
     the real signal, and the only one that stays honest on a slow connection. */
  const [firestoreOnline, setFirestoreOnline] = useState(true);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [manualVoteOpen, setManualVoteOpen] = useState(false);
  const wasOfflineRef = useRef(false);
  const prevHomeRef = useRef({ id: null, home: null });
  const prevRacersRef = useRef(null);
  const selfLeavingRef = useRef(false);
  const splashStarted = useRef(false);

  /* warnings/errors stay up longer — a good-news toast can flash by,
     but "it timed out, try again" needs enough time to actually read */
  const say = (msg, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast(null), bad ? 5000 : 2800);
  };

  /* offline is fine — the local cache still shows everything and edits
     still save locally, they just queue until a connection comes back.
     The moment the browser sees a connection again, nudge Firestore to
     reconnect right away instead of waiting for it to notice on its own —
     that's the "auto sync," no button for the person to remember to tap. */
  useEffect(() => {
    const goOnline = () => { setIsOnline(true); if (db) enableNetwork(db).catch(() => {}); };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

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
    Promise.resolve(CapApp.addListener("resume", () => {
      resumeMusicFromBackground();
      maybeShowAppOpenAd();
      /* the banner must survive a background/foreground cycle too — if we
         left on a screen that strictly requires it, resume it the moment
         the app is visible again instead of trusting it stayed up */
      const onProfile = tabRef.current === "racewin" && !!detailRef.current;
      if (tabRef.current === "dashboard" || onProfile) resumeAdBanner();
    })).then((h) => { resumeHandle = h; });
    return () => { pauseHandle?.remove(); resumeHandle?.remove(); };
  }, []);

  /* warm up the ads SDK once, in the background — doesn't show anything yet */
  useEffect(() => { ensureAdMobInit(); }, []);

  /* the racer's own profile page (where the log lives) and the Dashboard
     are the two screens that must show the banner strictly always, no
     matter what — never the Race Tracker or gate screens. Re-asserting
     showAdBanner() (not just once on the tab change) means a failed/expired
     fill gets retried rather than silently leaving the slot blank. */
  useEffect(() => {
    const onProfile = tab === "racewin" && !!detailRacerId;
    if (tab !== "dashboard" && !onProfile) { hideAdBanner(); return; }
    showAdBanner();
    const retry = setInterval(resumeAdBanner, 30000);
    return () => clearInterval(retry);
  }, [tab, detailRacerId]);

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
      { includeMetadataChanges: true },
      (snap) => {
        if (!snap.exists()) { setRace("missing"); return; }
        setRace({ id: snap.id, ...snap.data() });
        setStatus("live");
        setFirestoreOnline(!snap.metadata.fromCache);
      },
      (err) => { setStatus("off"); setFirestoreOnline(false); say(err.message, true); }
    );
    stopRacers = onSnapshot(
      query(racersRef(raceId), orderBy("order")),
      { includeMetadataChanges: true },
      (snap) => {
        setFirestoreOnline(!snap.metadata.fromCache);
        const next = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const prev = prevRacersRef.current;
        const myId = localStorage.getItem(lsRacer(raceId));
        if (prev) {
          const prevById = new Map(prev.map((r) => [r.id, r]));
          const nextById = new Map(next.map((r) => [r.id, r]));
          next.forEach((r) => {
            if (!prevById.has(r.id) && (r.name || "").trim() && r.id !== myId) {
              say(`${r.name} joined the race`);
              notifyNow("Money Marathon", `${r.name} joined the race`);
            }
          });
          prev.forEach((r) => {
            if (nextById.has(r.id)) return;
            if (r.id === myId) {
              /* our own racer vanished — if we didn't trigger that ourselves
                 via leaveRace(), the host kicked us. tell them and bail out
                 to the gate instead of limping along pointed at a dead racer */
              if (!selfLeavingRef.current) {
                say("You were removed from the race by the host.", true);
                notifyNow("Money Marathon", "You were removed from the race by the host.");
                localStorage.removeItem(LS_RACE);
                localStorage.removeItem(lsRacer(raceId));
                cancelAllSavingsReminders();
                cancelInactivityReminders();
                setTimeout(() => location.reload(), 1800);
              }
              return;
            }
            if ((r.name || "").trim()) {
              say(`${r.name} left the race`);
              notifyNow("Money Marathon", `${r.name} left the race`);
            }
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
      (err) => { setStatus("off"); setFirestoreOnline(false); say(err.message, true); }
    );
    return () => { stopRace(); stopRacers(); };
  }, [raceId, authed]);

  const reallyOnline = isOnline && firestoreOnline;

  /* once we come back from actually being offline (not just a blip),
     let the person know their queued changes are syncing — Firestore
     flushes them automatically, this is just so nobody wonders if their
     offline logging actually made it */
  useEffect(() => {
    if (!reallyOnline) { wasOfflineRef.current = true; return; }
    if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      setShowSyncModal(true);
    }
  }, [reallyOnline]);

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

  /* splash covers both the very first cold start and every later "connecting" moment.
     Depends on a boolean, not the raw race object — race gets a brand new object
     reference on every single snapshot (including ones from our own writes, like
     the activity-touch heartbeat), and depending on that reference directly means
     any write landing within the 260ms window re-runs this effect, whose cleanup
     unconditionally clears the pending timeout with nothing left to replace it —
     the splash would then never dismiss. A boolean only flips once. */
  useEffect(() => {
    if (race && race !== "missing" && !splashStarted.current) {
      splashStarted.current = true;
      setSplashOut(true);
      const t = setTimeout(() => setShowSplash(false), 260);
      return () => clearTimeout(t);
    }
  }, [!!race && race !== "missing"]);

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
            expiresAt: nextExpiry(),
          }),
          setDoc(racerRef(id, racerId), {
            name: creatorName || "", bank: "", characterId: DEFAULT_CHARACTERS[0]?.id || "",
            entries: [], order: 0, editAccess: "private", joinedSelf: true, createdAt: serverTimestamp(),
            expiresAt: nextExpiry(),
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
      /* the connect-and-look-up step gets the hard 10s budget; the sync-or-not
         question below waits on the person, which shouldn't itself be able
         to trip a "taking too long" error while they're just thinking */
      const { docs } = await withTimeout((async () => {
        await waitForAuth();
        const snap = await getDoc(raceRef(id));
        if (!snap.exists()) throw new Error("No race with that code.");
        const existing = await getDocs(racersRef(id));
        return { docs: existing.docs };
      })(), 10000, "Taking too long to connect — check your internet and try again.");

      let joinName = (name || "").trim();
      /* same name as someone already racing here — could be the same
         person on a new device, or two different people who happen to
         share a name. ask which one, rather than silently guessing. */
      const match = docs.find((d) => (d.data().name || "").trim().toLowerCase() === joinName.toLowerCase());
      if (match) {
        const sync = await askConfirm(
          `"${joinName}" is already racing here. Is that you on a different device? Sync with their existing progress instead of starting a new lane.`,
          { okLabel: "Yes, sync", cancelLabel: "No, that's someone else", danger: false }
        );
        if (sync) {
          await guard(updateDoc(racerRef(id, match.id), { expiresAt: nextExpiry() }));
          await guard(updateDoc(raceRef(id), { expiresAt: nextExpiry() }));
          localStorage.setItem(LS_RACE, id);
          localStorage.setItem(lsRacer(id), match.id);
          setRaceId(id);
          return;
        }
        const taken = new Set(docs.map((d) => (d.data().name || "").trim().toLowerCase()));
        let n = 2;
        while (taken.has(`${joinName}-${n}`.toLowerCase())) n++;
        joinName = `${joinName}-${n}`;
        say(`Joining as "${joinName}" since "${name.trim()}" is already taken.`);
      }

      await withTimeout((async () => {
        const order = docs.length ? Math.max(...docs.map((d) => d.data().order || 0)) + 1 : 0;
        const racerId = newId(10);
        await setDoc(racerRef(id, racerId), {
          name: joinName, bank: "", characterId: "", entries: [], order, editAccess: "private", joinedSelf: true, createdAt: serverTimestamp(),
          expiresAt: nextExpiry(),
        });
        await updateDoc(raceRef(id), { expiresAt: nextExpiry() });
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
    selfLeavingRef.current = true;
    const myRacerId = localStorage.getItem(lsRacer(raceId));
    const others = rows.filter((r) => r.id !== myRacerId);
    if (others.length === 0) {
      /* the last racer leaving takes the whole race with them — an empty
         race with nobody in it has nothing left to track */
      if (myRacerId) await guard(deleteDoc(racerRef(raceId, myRacerId)));
      await guard(deleteDoc(raceRef(raceId)));
    } else {
      /* the host leaving hands admin to whoever joined next — the race
         shouldn't end up with no one able to touch its setup */
      if (myRacerId && race && race !== "missing" && race.hostRacerId === myRacerId) {
        const next = [...others].sort((a, b) => (a.order || 0) - (b.order || 0))[0];
        if (next) await guard(updateDoc(raceRef(raceId), { hostRacerId: next.id }));
      }
      if (myRacerId) await guard(deleteDoc(racerRef(raceId, myRacerId)));
    }
    localStorage.removeItem(LS_RACE);
    localStorage.removeItem(lsRacer(raceId));
    await cancelAllSavingsReminders();
    await cancelInactivityReminders();
    /* full reload instead of manual state teardown — guarantees a completely
       clean slate (listeners, refs, splash state) every time, like reopening the app */
    location.reload();
  };

  const backToGate = () => {
    localStorage.removeItem(LS_RACE);
    if (raceId) localStorage.removeItem(lsRacer(raceId));
    cancelAllSavingsReminders();
    cancelInactivityReminders();
    location.reload();
  };

  const patchRace = (patch) => guard(updateDoc(raceRef(raceId), patch));
  const patchRacer = (rid, patch) => guard(updateDoc(racerRef(raceId, rid), patch));

  /* a lane added here has no owning device yet — leave it open to everyone
     until whoever it's for takes it over, unlike joining (which is always
     "only me" since it's tied to your own device from the start) */
  const addRacer = () => {
    const order = racers.length ? Math.max(...racers.map((r) => r.order || 0)) + 1 : 0;
    return guard(setDoc(racerRef(raceId, newId(10)), {
      name: "", bank: "", characterId: (race.characters?.[0]?.id) || "",
      entries: [], order, editAccess: "public", createdAt: serverTimestamp(),
      expiresAt: nextExpiry(),
    }));
  };

  /* removing/kicking is host-only, full stop — a co-editor with delegated
     Dashboard access can edit goals, the racer list's details, etc, but
     never removes anyone, so there's no confusing "works for some racers
     but not others" behavior */
  const removeRacer = async (r) => {
    if (!isAdmin) { say("Only the race host can remove racers.", true); return; }
    const verb = r.joinedSelf ? "Kick" : "Remove";
    if (!(await askConfirm(`${verb} ${r.name || "this racer"} and erase their whole savings log? This can't be undone.`, { okLabel: `Yes, ${verb.toLowerCase()}` }))) return;
    await guard(deleteDoc(racerRef(raceId, r.id)));
    /* a race nobody's left in shouldn't just sit there forever */
    if (rows.filter((x) => x.id !== r.id).length === 0) await guard(deleteDoc(raceRef(raceId)));
  };

  /* records the moment a racer first reaches their goal — used to break
     podium ties by who actually finished first, not join order or name */
  const withFinishedCheck = (r, patch) => {
    if (r.finishedAt || !patch.entries) return patch;
    const newSaved = patch.entries.filter((e) => e.confirmed).reduce((s, e) => s + Number(e.amount || 0), 0);
    const goal = racerGoal(r, race);
    return goal > 0 && newSaved >= goal ? { ...patch, finishedAt: serverTimestamp() } : patch;
  };

  /* keeps a racer's (and the whole race's) 90-day clock alive — bumped
     alongside any real savings activity, regardless of who's device
     actually tapped the button, since it's the RACER's account being
     maintained that matters, not who happened to be holding the phone.
     Only reschedules THIS device's own local reminders when it's actually
     this device's own racer, since a warning about "your account" only
     makes sense on the account owner's own phone. */
  const touchActivity = (r) => {
    guard(updateDoc(raceRef(raceId), { expiresAt: nextExpiry() }));
    if (r.id === myRacerId) syncInactivityReminders(race?.tripName);
  };

  const addEntry = (r, entry) => {
    touchActivity(r);
    return patchRacer(r.id, withFinishedCheck(r, {
      entries: [...(r.entries || []), { id: newId(8), ...entry }], expiresAt: nextExpiry(),
    }));
  };

  const toggleEntry = (r, eid) => {
    touchActivity(r);
    return patchRacer(r.id, withFinishedCheck(r, {
      entries: (r.entries || []).map((e) => (e.id === eid ? { ...e, confirmed: !e.confirmed } : e)),
      expiresAt: nextExpiry(),
    }));
  };

  const removeEntry = (r, eid) =>
    patchRacer(r.id, { entries: (r.entries || []).filter((e) => e.id !== eid) });

  const editEntryAmount = (r, eid, amount) => {
    touchActivity(r);
    return patchRacer(r.id, withFinishedCheck(r, {
      entries: (r.entries || []).map((e) => (e.id === eid ? { ...e, amount: Math.round(Number(amount) || 0) } : e)),
      expiresAt: nextExpiry(),
    }));
  };

  const clearLog = async (r) => {
    if (!(await askConfirm(`Erase ${r.name || "this racer"}'s whole savings log? This can't be undone.`))) return;
    return patchRacer(r.id, { entries: [], targetDate: "", cadence: "every:1" });
  };

  /* GoalEditor already shows the "you'll differ from everyone else"
     warning every time it's opened, so this just saves */
  const setGoal = (r, newGoal) => {
    touchActivity(r);
    return patchRacer(r.id, { goal: newGoal, expiresAt: nextExpiry() });
  };

  /* "public" lets anyone in the race edit this racer's own log — off by
     default (only the racer themself can), only the racer can flip it */
  const setEditAccess = (r, editAccess) => patchRacer(r.id, { editAccess });

  /* target date / cadence change → (re)build the planned, uncheck-yet entries for the remaining balance.
     every installment is a whole number, and the last one absorbs whatever rounding left over so the
     total lands exactly on the remaining balance — never over, never under.
     scheduleCustom tracks whether this landed on something DIFFERENT from the
     race's current shared default — if it matches exactly (including a plain
     "yes, sync me to the new schedule" from the pending-adjustment prompt),
     they're still considered "on the shared default" and stay eligible for
     future auto-adjust prompts; only an actual divergence opts them out. */
  const applySavingsPlan = (r, targetDate, cadence) => {
    touchActivity(r);
    const remaining = Math.max(0, Math.round(racerGoal(r, race) - r.saved));
    const keep = (r.entries || []).filter((e) => !(e.source === "plan" && !e.confirmed));
    const sharedTarget = race?.targetDate || "";
    const sharedCadence = race?.cadence || "every:1";
    const patch = {
      targetDate, cadence,
      scheduleCustom: targetDate !== sharedTarget || cadence !== sharedCadence,
      scheduleAckVersion: Number(race?.scheduleVersion) || 0,
      expiresAt: nextExpiry(),
    };
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
      const effectiveGoal = racerGoal(r, race);
      const pct = effectiveGoal > 0 ? saved / effectiveGoal : 0;
      return { ...r, slot: i + 1, saved, planned, effectiveGoal, pct, home: pct >= 1 };
    });
    const named = base.filter((r) => (r.name || "").trim());
    /* ties go to whoever actually finished first (by timestamp), not join
       order or name — join order is only a last-resort tiebreak for people
       who are still tied and neither has finished yet */
    const finishedAtMs = (r) => (r.finishedAt?.toMillis ? r.finishedAt.toMillis() : Infinity);
    [...named]
      .sort((a, b) => {
        if (b.pct !== a.pct) return b.pct - a.pct;
        if (a.home && b.home) return finishedAtMs(a) - finishedAtMs(b);
        return a.slot - b.slot;
      })
      .forEach((r, i) => { r.rank = i + 1; });
    return base;
  }, [racers, goal]);

  const pooled = rows.reduce((s, r) => s + r.saved, 0);
  const namedRows = rows.filter((r) => (r.name || "").trim());
  const joined = namedRows.length;
  const leader = rows.find((r) => r.rank === 1);
  const activeRow = detailRacerId ? rows.find((x) => x.id === detailRacerId) : null;
  /* everyone home at once → the race is over. keeps showing (to everyone)
     until the host makes the binding call, tracked by race.raceResolved so
     it doesn't reappear the instant the next snapshot rolls in */
  const allFinished = namedRows.length > 0 && namedRows.every((r) => r.home);
  const showFinalModal = allFinished && race && race !== "missing" && !race.raceResolved;

  /* whoever created the race is the host — only they can touch race setup,
     the racer list, and the character library; everyone else's own profile
     page is still theirs to edit. Races from before hostRacerId existed
     fall back to whoever has order 0, same racer createRace always used. */
  const myRacerId = raceId ? localStorage.getItem(lsRacer(raceId)) : null;
  const hostRacerId = (race && race !== "missing" && race.hostRacerId)
    || [...rows].sort((a, b) => (a.order || 0) - (b.order || 0))[0]?.id;
  const isAdmin = !!myRacerId && myRacerId === hostRacerId;
  const myRacer = rows.find((r) => r.id === myRacerId) || null;
  /* the host can also just grant Dashboard access to specific people
     without handing over the whole admin role */
  const canEditDashboard = isAdmin || myRacer?.canEditDashboard === true;

  /* fires once, right when THIS device's own racer crosses their goal —
     ref tracks the previous home state per-racer so it never re-fires on
     unrelated re-renders, and never fires on first load for someone who
     had already finished before this session opened */
  useEffect(() => {
    if (!myRacer) return;
    const prev = prevHomeRef.current;
    if (prev.id === myRacer.id && prev.home === false && myRacer.home === true) {
      setCongrats({ rank: myRacer.rank });
    }
    prevHomeRef.current = { id: myRacer.id, home: myRacer.home };
  }, [myRacer?.id, myRacer?.home, myRacer?.rank]);

  /* just opening the app to check in counts as "still here" too, not only
     logging money — fires once per racer id, i.e. once per time this race
     is opened, not on every re-render */
  useEffect(() => {
    if (!myRacer) return;
    guard(updateDoc(racerRef(raceId, myRacer.id), { expiresAt: nextExpiry() }));
    guard(updateDoc(raceRef(raceId), { expiresAt: nextExpiry() }));
    syncInactivityReminders(race?.tripName);
  }, [myRacer?.id]);

  const setDashboardAccess = (r, allowed) => patchRacer(r.id, { canEditDashboard: allowed });

  const transferAdmin = async (r) => {
    if (!(await askConfirm(`Make ${r.name || "this racer"} the race host? They'll be able to edit race setup, the racer list, and the character library — you'll lose that unless they hand it back.`,
      { okLabel: "Transfer" }))) return;
    return guard(updateDoc(raceRef(raceId), { hostRacerId: r.id }));
  };

  const voteFinal = (vote) => { if (myRacerId) patchRacer(myRacerId, { finalVote: vote }); };

  /* only the host's tap here actually resolves it — everyone else's vote
     is just a signal the host can see, never binding on its own */
  const resolveFinalRace = async (decision) => {
    if (decision === "reset") {
      if (!(await askConfirm("Start a new race? Every racer's savings log will be wiped and everyone starts fresh toward the same goal.", { okLabel: "Yes, start new race" }))) return;
      await Promise.all(namedRows.map((r) =>
        guard(updateDoc(racerRef(raceId, r.id), {
          entries: [], targetDate: "", cadence: "every:1", finishedAt: null, finalVote: null,
          scheduleCustom: false, scheduleAckVersion: 0, expiresAt: nextExpiry(),
        }))
      ));
      await guard(updateDoc(raceRef(raceId), { raceResolved: false, scheduleVersion: 0, expiresAt: nextExpiry() }));
    } else {
      await Promise.all(namedRows.map((r) => guard(updateDoc(racerRef(raceId, r.id), { finalVote: null }))));
      await guard(updateDoc(raceRef(raceId), { raceResolved: true }));
    }
    setManualVoteOpen(false);
  };

  /* anyone still on the shared default (never set their own save-by date
     or cadence) gets asked every time the host changes it on the Dashboard
     — including a brand new racer with an empty log, since the whole point
     is offering to fill their log in for them, not just people who already
     had a plan running */
  const pendingScheduleSync = !!myRacer && !myRacer.scheduleCustom
    && race && race !== "missing"
    && (Number(race.scheduleVersion) || 0) > (Number(myRacer.scheduleAckVersion) || 0);

  const acceptScheduleSync = () => applySavingsPlan(myRacer, race.targetDate || "", race.cadence || "every:1");
  const declineScheduleSync = () => patchRacer(myRacer.id, { scheduleAckVersion: Number(race.scheduleVersion) || 0 });

  /* every "forced" popup competes for the same spot — only ever show one
     at a time, in this priority order, instead of letting several stack on
     top of each other. Congrats (you just won) always wins first; the rest
     just wait their turn and reappear the moment the one ahead of them is
     dismissed. Sound settings is excluded on purpose — it's opened by an
     explicit tap, not a forced interruption, so it can coexist. */
  const activeModal = congrats ? "congrats"
    : showFinalModal ? "final"
    : manualVoteOpen ? "manualVote"
    : pendingScheduleSync ? "scheduleSync"
    : showSyncModal ? "backOnline"
    : tutorial.phase === "welcome" ? "tutorialWelcome"
    : tutorial.phase === "touring" ? "tutorialTouring"
    : tutorial.phase === "celebrating" ? "tutorialCelebrating"
    : null;

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
    <div class=${"shell" + (reallyOnline ? "" : " shell--offline")}>
      ${!reallyOnline && html`<div class="offlinebar">⚠ You're offline — changes will sync once you're back online</div>`}
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

      <span class=${"syncsign " + (reallyOnline ? "syncsign--on" : "syncsign--off")}
        title=${reallyOnline ? "Synced automatically" : "Offline — changes will sync once reconnected"}>
        ${reallyOnline ? "⟳" : "⚠"}
      </span>

      <div ref=${tabContentRef}
        class=${"tab-content" + ((tabEntering || tabLeaving) ? " tab-content--entering" : "")}
        style=${`transform-origin:${tabOrigin}`}
        onPointerDown=${onSwipeDown} onPointerUp=${onSwipeUp}>

        ${tab === "track" && html`<${RaceHero} race=${race} rows=${rows} cur=${cur} pooled=${pooled} hostRacerId=${hostRacerId} />`}

        ${tab === "dashboard" && html`
          <button class="backbtn" onClick=${goBack}>← Back</button>
          <${HomeTab}
            race=${race} cur=${cur} rows=${rows} isAdmin=${canEditDashboard} trueAdmin=${isAdmin}
            hostRacerId=${hostRacerId}
            onPatchRace=${patchRace}
            onPatchRacer=${patchRacer}
            onAddRacer=${addRacer}
            onRemoveRacer=${removeRacer}
            reallyOnline=${reallyOnline}
            say=${say} />`}

        ${tab === "racewin" && (
          detailRacerId
            ? (activeRow
                ? html`<${RacerDetailPage} r=${activeRow} race=${race} cur=${cur} rows=${rows}
                    isOwner=${activeRow.id === myRacerId}
                    isAdmin=${isAdmin}
                    isHost=${activeRow.id === hostRacerId}
                    onBack=${() => setDetailRacerId(null)}
                    onAddEntry=${(e) => addEntry(activeRow, e)}
                    onToggleEntry=${(eid) => toggleEntry(activeRow, eid)}
                    onRemoveEntry=${(eid) => removeEntry(activeRow, eid)}
                    onEditAmount=${(eid, amt) => editEntryAmount(activeRow, eid, amt)}
                    onApplyPlan=${(t, c) => applySavingsPlan(activeRow, t, c)}
                    onClearLog=${() => clearLog(activeRow)}
                    onSetGoal=${(g) => setGoal(activeRow, g)}
                    onSetEditAccess=${(v) => setEditAccess(activeRow, v)}
                    onSetDashboardAccess=${(v) => setDashboardAccess(activeRow, v)}
                    onTransferAdmin=${() => transferAdmin(activeRow)}
                    say=${say} />`
                : html`<div class="tab-panel"><div class="empty">This racer was removed.</div>
                    <button class="btn" onClick=${() => setDetailRacerId(null)}>← Back</button></div>`)
            : html`
                <button class="backbtn" onClick=${goBack}>← Back</button>
                <${RaceWinTab} race=${race} cur=${cur} rows=${rows} raceCode=${raceId} hostRacerId=${hostRacerId}
                  onOpenRacer=${setDetailRacerId}
                  onLeave=${leaveRace}
                  onReplayTutorial=${replayTutorial}
                  onOpenSound=${() => setShowSound(true)}
                  onOpenVote=${() => setManualVoteOpen(true)}
                  say=${say} />`
        )}
      </div>

      ${tab === "track" && html`<${TabNav} onChange=${changeTab} />`}

      <p style="text-align:center;color:var(--ink-faint);font-size:12px;margin-top:40px">
        Racers on this race can see and edit everything. Share the code only with people you trust.
      </p>

      ${toast && html`<div class=${"toast " + (toast.bad ? "toast--bad" : "")}>${toast.msg}</div>`}

      ${showSound && html`<${SoundSettingsModal} onClose=${() => setShowSound(false)} />`}

      ${activeModal === "tutorialWelcome" && html`<${TutorialWelcome} onStart=${startTour} onSkip=${skipWelcome} />`}
      ${activeModal === "tutorialTouring" && html`<${TutorialOverlay}
        step=${TUTORIAL_STEPS[tutorial.step]} index=${tutorial.step} total=${TUTORIAL_STEPS.length} tab=${tab}
        onNext=${nextTutorialStep} onBack=${backTutorialStep} onSkip=${skipTour} />`}
      ${activeModal === "tutorialCelebrating" && html`<${TutorialCelebration} onDismiss=${finishCelebration} />`}
      ${activeModal === "congrats" && html`<${CongratsModal} rank=${congrats.rank} onDismiss=${() => setCongrats(null)} />`}
      ${activeModal === "final" && html`<${FinalRaceModal} rows=${namedRows} isAdmin=${isAdmin}
        myRacerId=${myRacerId} onVote=${voteFinal} onResolve=${resolveFinalRace} />`}
      ${activeModal === "manualVote" && html`<${FinalRaceModal} rows=${namedRows} isAdmin=${isAdmin}
        myRacerId=${myRacerId} onVote=${voteFinal} onResolve=${resolveFinalRace}
        onClose=${() => setManualVoteOpen(false)} isEarly=${!allFinished} />`}
      ${activeModal === "scheduleSync" && html`<${ScheduleSyncModal} race=${race}
        onAccept=${acceptScheduleSync} onDecline=${declineScheduleSync} />`}
      ${activeModal === "backOnline" && html`
        <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setShowSyncModal(false); }}>
          <div class="modal" style="text-align:center;max-width:320px">
            <div style="font-size:36px">⟳</div>
            <h3>Back online</h3>
            <p class="modal__msg">Whatever you logged while offline is syncing now — everyone else will see it shortly.</p>
            <button class="btn btn--go" style="width:100%" onClick=${() => setShowSyncModal(false)}>Got it</button>
          </div>
        </div>`}
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

/* character pose photos are the one thing worth costing data every single
   render — cache them once via the Cache Storage API (works without a
   service worker) so re-opening the app, or losing signal mid-race, still
   shows every racer's sprite from disk instead of a broken image icon.
   no-cors keeps this working for imgur/Storage URLs that don't send CORS
   headers back to a plain fetch() — the response is opaque but still
   perfectly usable as an <img> source once it's a blob: URL. */
const IMG_CACHE_NAME = "mm-images-v1";

function CachedImage({ src, alt = "" }) {
  const [resolvedSrc, setResolvedSrc] = useState(src);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    setResolvedSrc(src);
    if (!src || !window.caches) return;

    (async () => {
      try {
        const cache = await caches.open(IMG_CACHE_NAME);
        const cached = await cache.match(src);
        if (cached) {
          const blob = await cached.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setResolvedSrc(objectUrl);
        } else if (navigator.onLine) {
          const res = await fetch(src, { mode: "no-cors" }).catch(() => null);
          if (res && !cancelled) await cache.put(src, res).catch(() => {});
        }
      } catch {}
    })();

    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src]);

  return html`<img src=${resolvedSrc} alt=${alt} loading="lazy" />`;
}

/* ---------- RACE TRACKER (home) — podium + track ---------- */

function RaceHero({ race, rows, cur, pooled, hostRacerId }) {
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
                ${face ? html`<${CachedImage} src=${face} />` : html`<span>${r ? initial(r.name) : "?"}</span>`}
              </div>
              <div class="place__block">
                <div class="place__no">${n}</div>
              </div>
              <div class="place__name">${r ? r.name : "—"}${r && r.id === hostRacerId ? html` <span class="hosttag">Admin/Host</span>` : ""}</div>
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
            : rows.map((r) => html`<${Lane} key=${r.id} r=${r} race=${race} cur=${cur} isHost=${r.id === hostRacerId} />`)}
        </div>
      </section>

      <${LogCalendar} race=${race} rows=${rows} cur=${cur} />
    </div>`;
}

/* per-day, per-racer savings status — a racer only ever appears on a given
   day if they actually have an entry (planned or confirmed) dated exactly
   that day. Days nobody has anything assigned to stay completely blank,
   so nobody sees themselves flagged as "missing" a day they never planned
   to log in the first place. */
function LogCalendar({ race, rows, cur }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const [openDay, setOpenDay] = useState(null);
  const named = rows.filter((r) => (r.name || "").trim());

  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + monthOffset);
  const year = base.getFullYear();
  const month = base.getMonth();
  const monthLabel = base.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;

  const entriesSignature = named.map((r) => `${r.id}:${(r.entries || []).map((e) => `${e.date}${e.confirmed ? "1" : "0"}`).join(",")}`).join("|");

  const dayStatus = useMemo(() => {
    const map = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateStr(d);
      const entries = [];
      named.forEach((r) => {
        const e = (r.entries || []).find((x) => x.date === ds);
        if (e) entries.push({ r, confirmed: !!e.confirmed });
      });
      if (entries.length) map[ds] = entries;
    }
    return map;
  }, [entriesSignature, year, month, daysInMonth]);

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const todayStr = today();

  return html`
    <section class="section logcal">
      <div class="logcal__head">
        <h2 class="section__label" style="margin:0">Savings calendar</h2>
        <div class="logcal__nav">
          <button class="logcal__navbtn" onClick=${() => setMonthOffset((n) => n - 1)} aria-label="Previous month">‹</button>
          <span class="logcal__month">${monthLabel}</span>
          <button class="logcal__navbtn" onClick=${() => setMonthOffset((n) => n + 1)} aria-label="Next month">›</button>
        </div>
      </div>
      <div class="panel logcal__panel">
        <div class="logcal__weekdays">
          ${["S", "M", "T", "W", "T", "F", "S"].map((w, i) => html`<span key=${i}>${w}</span>`)}
        </div>
        <div class="logcal__grid">
          ${cells.map((d, i) => {
            if (d === null) return html`<div class="logcal__cell logcal__cell--pad" key=${"p" + i}></div>`;
            const ds = dateStr(d);
            const entries = dayStatus[ds] || [];
            /* nothing assigned to this day → nothing to click, nothing to show */
            return html`<div class=${`logcal__cell ${ds === todayStr ? "logcal__cell--today" : ""} ${entries.length ? "logcal__cell--clickable" : ""}`}
              key=${ds} onClick=${() => entries.length && setOpenDay({ date: ds, entries })}>
              <span class="logcal__daynum">${d}</span>
              ${entries.length > 0 && html`<div class="logcal__dots">
                ${entries.map(({ r, confirmed }) => html`<span key=${r.id}
                  class=${`logcal__dot avatar--${laneClass(r)} ${confirmed ? "logcal__dot--on" : "logcal__dot--off"}`}
                  style=${laneStyle(r)}
                  title=${`${r.name} — ${confirmed ? "logged" : "not logged yet"}`}></span>`)}
              </div>`}
            </div>`;
          })}
        </div>
      </div>
      <p class="logcal__legend">
        <span class="logcal__dot logcal__dot--on avatar--c3"></span> Logged
        <span class="logcal__dot logcal__dot--off avatar--c0"></span> Not logged yet
      </p>

      ${openDay && html`
        <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setOpenDay(null); }}>
          <div class="modal" style="max-width:320px">
            <p class="modal__msg" style="font-weight:700">${prettyDate(openDay.date)}</p>
            <div class="logcal__daylist">
              ${openDay.entries.map(({ r, confirmed }) => html`
                <div class="logcal__dayrow" key=${r.id}>
                  <span class=${`logcal__dot avatar--${laneClass(r)} ${confirmed ? "logcal__dot--on" : "logcal__dot--off"}`} style=${laneStyle(r)}></span>
                  <span>${r.name}</span>
                  <span class="logcal__daystatus">${confirmed ? "Logged" : "Not logged yet"}</span>
                </div>`)}
            </div>
            <button class="btn btn--go" style="width:100%;margin-top:16px" onClick=${() => setOpenDay(null)}>Close</button>
          </div>
        </div>`}
    </section>`;
}

function Lane({ r, race, cur, isHost }) {
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
        <span class="lane__name">${named || "Open lane"}${isHost && named ? html` <span class="hosttag">Admin/Host</span>` : ""}</span>
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
              ? html`<${CachedImage} src=${src} />`
              : html`<span>${named ? initial(named) : "+"}</span>`}
          </div>
        </div>
        <div class="flagpost"><span class="flagpost__flag">🏁</span></div>
      </div>
    </div>`;
}

/* ---------- HOME TAB — setup, racers, characters, leave ---------- */

function HomeTab({ race, cur, rows, isAdmin, trueAdmin, hostRacerId, onPatchRace, onPatchRacer, onAddRacer, onRemoveRacer, reallyOnline, say }) {
  const [form, setForm] = useState({ name: "", start: "", moving: "", finish: "" });
  const [uploading, setUploading] = useState({});
  const [cropTarget, setCropTarget] = useState(null);
  const [addAttempted, setAddAttempted] = useState(false);
  const [shakeN, setShakeN] = useState(0);
  const [addingCharacter, setAddingCharacter] = useState(false);
  const [watchingAd, setWatchingAd] = useState(false);
  const characters = race.characters || [];
  const busy = !!cropTarget || Object.values(uploading).some(Boolean);

  const missing = {
    name: !form.name.trim(),
    start: !form.start,
    moving: !form.moving,
    finish: !form.finish,
  };
  const showInvalid = addAttempted;

  /* one ad, watched in full, per character added — free forever, but this
     is the one thing that costs a watch instead of being unlimited */
  const addCharacter = async () => {
    if (Object.values(missing).some(Boolean)) {
      setAddAttempted(true);
      setShakeN((n) => n + 1);
      navigator.vibrate?.(200);
      say("Fill in the character's name and all three poses before adding.", true);
      return;
    }
    /* a rewarded ad genuinely cannot load with no connection — check up
       front instead of letting the native SDK time out and fail on its own */
    if (!reallyOnline) {
      say("You need to be online to watch the ad and add a character.", true);
      return;
    }
    setAddAttempted(false);
    setWatchingAd(true);
    const rewarded = await showRewardedAd();
    setWatchingAd(false);
    if (!rewarded) { say("Watch the full ad to add this character.", true); return; }
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
          <p class="goalcard__hint">Anyone can set their own goal from their own profile instead</p>

          <p class="goalcard__label" style="margin-top:14px">Save by (default for everyone)</p>
          <input class="field field--mono" type="date" style="width:100%" value=${race.targetDate || ""} min=${today()}
            aria-label="Default save-by date"
            onChange=${(e) => onPatchRace({ targetDate: e.target.value, scheduleVersion: increment(1) })} />
          <p class="goalcard__hint">Pre-fills everyone's savings plan — anyone can still pick their own date from their own profile</p>

          <p class="goalcard__label" style="margin-top:14px">Savings cadence (default for everyone)</p>
          <${CadencePicker} cadence=${race.cadence || "every:1"}
            onChange=${(v) => onPatchRace({ cadence: v, scheduleVersion: increment(1) })} />
          <p class="goalcard__hint">Same idea — everyone starts on this schedule, anyone can still pick their own from their own profile</p>
        </div>
      </section>

      <section class="section">
        <h2 class="section__label">Racers</h2>
        <div class="racerlist" ref=${registerTarget("racers_panel")}>
          ${rows.length === 0
            ? html`<div class="empty">No lanes yet. Add one below.</div>`
            : rows.map((r) => html`<${RacerIdentityRow} key=${r.id} r=${r} race=${race}
                isHost=${r.id === hostRacerId} canKick=${trueAdmin}
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
            ? html`<button class="btn btn--go" disabled=${watchingAd || !reallyOnline} onClick=${addCharacter}>
                ${watchingAd ? "Loading ad…" : !reallyOnline ? "Offline — connect to watch an ad" : "▶ Watch an ad to add"}</button>`
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

function RacerIdentityRow({ r, race, isHost, canKick, onPatch, onRemove }) {
  return html`
    <div class="racercard">
      <div class="racercard__row">
        <${LiveInput} className="field racercard__name"
          value=${r.name} placeholder="Who's in this lane?" aria-label="Racer name"
          onCommit=${(v) => onPatch({ name: v })} />
        ${isHost && html`<span class="hosttag">Admin/Host</span>`}
        <${BankPicker} value=${r.bank} onChange=${(v) => onPatch({ bank: v })} />
      </div>
      <div class="racercard__row">
        <${Dropdown} className="dropdown--char" value=${r.characterId || ""} ariaLabel="Character"
          options=${[{ value: "", label: "No character" }, ...(race.characters || []).map((c) => ({ value: c.id, label: c.name }))]}
          onChange=${(v) => onPatch({ characterId: v })} />
        <${ColorPicker} value=${r.color || ""} onChange=${(v) => onPatch({ color: v })} />
        ${canKick && html`<button class="racercard__remove" onClick=${onRemove} aria-label="Remove racer">×</button>`}
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

  /* once a custom bank is set, the "Other…" option's own label becomes
     that value — so the dropbox itself shows what you typed, no separate
     caption underneath */
  const options = [
    { value: "", label: "Bank / wallet" },
    ...BANKS.map((b) => ({ value: b, label: b })),
    { value: "other", label: preset === "other" && value ? value : "Other…" },
  ];

  const openOther = () => { setDraft(!known ? value || "" : ""); setAsking(true); };
  const save = () => { onChange(draft.trim()); setAsking(false); };

  return html`
    <div style="flex:1;min-width:130px">
      <${Dropdown} className="dropdown--bank" value=${preset} ariaLabel="Bank or wallet"
        options=${options} onChange=${(v) => (v === "other" ? openOther() : onChange(v))} />

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

function RaceWinTab({ race, cur, rows, raceCode, hostRacerId, onOpenRacer, onLeave, onReplayTutorial, onOpenSound, onOpenVote, say }) {
  const named = rows.filter((r) => (r.name || "").trim());
  return html`
    <div class="tab-panel">
      <section class="section">
        ${named.length === 0
          ? html`<div class="empty"><strong>No racers yet.</strong>Add someone on the Dashboard first.</div>`
          : html`<div class="panel" ref=${registerTarget("roster_row")} style="padding:0">
              ${named.map((r) => html`<${RosterRow} key=${r.id} r=${r} race=${race} cur=${cur}
                isHost=${r.id === hostRacerId}
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
          ${race.raceResolved === true && html`
            <button class="btn btn--sm btn--ghost" style="width:100%;margin-bottom:8px" onClick=${onOpenVote}>
              🗳 Vote to end race & reset</button>`}
          <button class="btn btn--sm btn--danger-outline" style="width:100%" onClick=${onLeave}>Leave this race</button>
          <a href="https://kyahdj.github.io/moneymarathonapp/privacy-policy.html" target="_blank" rel="noopener"
            class="racecard__privacy">Privacy Policy</a>
        </div>
      </section>
    </div>`;
}

function RosterRow({ r, race, cur, isHost, onClick }) {
  const character = (race.characters || []).find((c) => c.id === r.characterId);
  const face = character ? (character.moving || character.start) : null;
  return html`
    <button class="rosterrow" onClick=${onClick}>
      <div class=${`avatar avatar--${laneClass(r)}`} style=${laneStyle(r)}>
        ${face ? html`<${CachedImage} src=${face} />` : html`<span>${initial(r.name)}</span>`}
      </div>
      <div class="rosterrow__id">
        <div class="card__name-static">${r.name}${isHost ? html` <span class="hosttag">Admin/Host</span>` : ""}</div>
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
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--lane-fill, var(--teal))"
        stroke-width=${stroke} stroke-linecap="round"
        stroke-dasharray=${`${saved} ${c - saved}`}
        transform=${`rotate(-90 ${size / 2} ${size / 2})`}
        style="transition:stroke-dasharray 0.7s cubic-bezier(0.22,0.9,0.28,1)" />
      <text x=${size / 2} y=${size / 2} text-anchor="middle" dominant-baseline="central"
        font-family="'DM Mono', monospace" font-size="30" font-weight="600" fill="var(--lane-fill, var(--ink))">
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

/* editable only by the racer it belongs to. 0/blank means "use the race's
   shared goal". Tapping the pencil always shows the warning first — every
   time, not just when the number actually ends up different — since
   editing your goal at all is the thing worth flagging. */
function GoalEditor({ value, sharedGoal, cur, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const effective = value > 0 ? value : sharedGoal;
  const custom = value > 0 && value !== sharedGoal;

  const openEditor = () => { setDraft(String(effective)); setEditing(true); };
  const save = () => {
    const num = Math.round(Number(draft)) || 0;
    setEditing(false);
    if (num !== (value || 0)) onCommit(num);
  };

  return html`
    <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
      ${custom && html`<span class="goaleditor__tag">Custom</span>`}
      <span>${money(effective, cur)}</span>
      <button class="goaleditor__pencil" onClick=${openEditor} aria-label="Edit your goal">✎</button>

      ${editing && html`
        <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setEditing(false); }}>
          <div class="modal" style="max-width:320px">
            <p class="modal__msg">Changing your goal means you won't be saving toward the same amount as everyone else in this race.</p>
            <input class="field field--mono" inputmode="numeric" value=${draft}
              aria-label="Your goal" onInput=${(e) => setDraft(e.target.value)}
              onKeyDown=${(e) => e.key === "Enter" && save()} />
            <div class="modal__actions" style="margin-top:16px">
              <button class="btn btn--ghost" onClick=${() => setEditing(false)}>Cancel</button>
              <button class="btn btn--go" onClick=${save}>Save</button>
            </div>
          </div>
        </div>`}
    </div>`;
}

/* jsPDF loaded on demand from a CDN's auto-ESM endpoint — this app has no
   build step/bundler, so there's nothing to npm-install into; jsdelivr's
   `+esm` path wraps any npm package as a real ES module for a plain
   `import()`, same trick as every other CDN import already in this file. */
async function downloadSavingsPdf(r, race, cur, entries) {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
  const doc = new jsPDF();
  const tripName = race.tripName || "Money Marathon";

  doc.setFontSize(18);
  doc.text(`${r.name}'s savings summary`, 14, 20);
  doc.setFontSize(11);
  doc.setTextColor(110);
  doc.text(tripName, 14, 28);
  doc.setTextColor(20);

  doc.setFontSize(12);
  doc.text(`Goal: ${money(r.effectiveGoal, cur)}`, 14, 42);
  doc.text(`Saved so far: ${money(r.saved, cur)} (${Math.round(r.pct * 100)}%)`, 14, 50);

  let y = 66;
  doc.setFontSize(13);
  doc.text(entries.length ? "Log" : "Nothing logged yet", 14, y);
  y += 10;

  doc.setFontSize(10);
  entries.forEach((e) => {
    if (y > 280) { doc.addPage(); y = 20; }
    doc.text(prettyDate(e.date), 14, y);
    doc.text(money(e.amount, cur), 70, y);
    doc.text(e.confirmed ? "Logged" : "Not logged yet", 120, y);
    y += 7;
  });

  const filename = `${(r.name || "racer").replace(/[^a-z0-9-_ ]/gi, "")}-savings-summary.pdf`;

  /* a Capacitor Android WebView doesn't hand blob/`download` links off to
     the OS the way a real browser tab does — doc.save() would silently do
     nothing there. Filesystem.writeFile actually puts the bytes on disk,
     then a local notification stands in for the "download complete" toast
     a real browser would show, since there's no native DownloadManager
     hook wired up here. Plain browser testing has no Filesystem plugin —
     doc.save()'s normal blob download still works fine there. */
  const FS = window.Capacitor?.Plugins?.Filesystem;
  if (!FS) { doc.save(filename); return; }

  try {
    const perm = await FS.checkPermissions().catch(() => null);
    if (perm && perm.publicStorage !== "granted") {
      const req = await FS.requestPermissions().catch(() => null);
      if (req && req.publicStorage !== "granted") { doc.save(filename); return; }
    }
    const dataUri = doc.output("datauristring");
    const base64 = dataUri.split(",")[1];
    await FS.writeFile({ path: filename, data: base64, directory: "DOCUMENTS" });
    await notifyNow("PDF saved", `${filename} saved to your Documents folder.`);
  } catch {
    doc.save(filename);
  }
}

function RacerDetailPage({ r, race, cur, isOwner, isAdmin, isHost, onBack, onAddEntry, onToggleEntry, onRemoveEntry, onEditAmount, onApplyPlan, onClearLog, onSetGoal, onSetEditAccess, onSetDashboardAccess, onTransferAdmin, say }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());

  const remaining = Math.max(0, r.effectiveGoal - r.saved);
  const cadence = racerCadence(r, race);
  const target = racerTargetDate(r, race);
  const entries = [...(r.entries || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  /* the owner always can; "public" additionally opens it up to anyone else in the race */
  const canEdit = isOwner || r.editAccess === "public";

  const submit = () => {
    const amt = Math.round(Number(amount));
    if (!amt) return;
    onAddEntry({ amount: amt, date: date || today(), confirmed: true });
    setAmount("");
    setDate(today());
  };

  /* a plain-text receipt of this racer's own log — something they still
     have even if their spot ever expires from 90 days of inactivity.
     Web Share API works fine inside the Android WebView with no extra
     native plugin; falls back to the clipboard wherever it doesn't. */
  const [exporting, setExporting] = useState(false);
  const exportSummary = async () => {
    setExporting(true);
    try {
      await downloadSavingsPdf(r, race, cur, entries);
    } catch (e) {
      console.error("PDF export failed:", e);
      say("Couldn't build the PDF — try again", true);
    } finally {
      setExporting(false);
    }
  };

  return html`
    <div class=${`tab-panel lane--${laneClass(r)}`} style=${laneStyle(r)}>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px">
        <button class="btn btn--sm btn--ghost" onClick=${onBack}>← Back to racers</button>
        <button class="btn btn--sm btn--ghost" disabled=${exporting || entries.length === 0} onClick=${exportSummary}
          title=${entries.length === 0 ? "Nothing logged yet — nothing to export" : ""}>
          ${exporting ? "Building PDF…" : "⤴ Export as PDF"}</button>
      </div>

      <div class="detailcard">
        <div class="detailcard__banner">${r.name}${isHost ? html` <span class="hosttag">Admin/Host</span>` : ""}${r.home ? " 🏁" : ""}</div>

        <div class="detailcard__body">
          <div class="detailcard__chart" ref=${registerTarget("profile_chart")}><${DonutChart} pct=${r.pct} /></div>

          <table class="stattable" ref=${registerTarget("profile_stats")}>
            <tbody>
              <tr><td class="stattable__label">Bank / Wallet</td><td class="stattable__value">${r.bank || "—"}</td></tr>
              <tr><td class="stattable__label">Goal</td><td class="stattable__value">
                ${isOwner
                  ? html`<${GoalEditor} value=${r.goal || 0} sharedGoal=${Number(race.goal) || 0} cur=${cur} onCommit=${onSetGoal} />`
                  : money(r.effectiveGoal, cur)}
              </td></tr>
              <tr><td class="stattable__label">Amount Saved</td><td class="stattable__value">${money(r.saved, cur)}</td></tr>
              <tr><td class="stattable__label">Remaining Balance</td><td class="stattable__value">${money(remaining, cur)}</td></tr>
              <tr class="stattable__pctrow"><td colspan="2">Progress Bar — ${Math.round(r.pct * 100)}%</td></tr>
            </tbody>
          </table>
          <div class="bar detailcard__bar"><div class="bar__fill" style=${`width:${Math.min(100, r.pct * 100)}%`}></div></div>

          <div class="privacyrow">
            <span class="privacyrow__k">Who can edit this profile?</span>
            ${isOwner
              ? html`<${Dropdown} className="dropdown--inline" value=${r.editAccess === "public" ? "public" : "private"}
                  ariaLabel="Who can edit this profile"
                  options=${[
                    { value: "private", label: "Only me" },
                    { value: "public", label: "Everyone" },
                  ]}
                  onChange=${onSetEditAccess} />`
              : html`<span class="privacyrow__v">${r.editAccess === "public" ? "Everyone" : `Only ${r.name}`}</span>`}
          </div>

          ${isAdmin && !isOwner && html`
            <div class="privacyrow" style="margin-top:10px">
              <span class="privacyrow__k">Let ${r.name || "them"} edit the Dashboard?</span>
              <${Dropdown} className="dropdown--inline" value=${r.canEditDashboard ? "yes" : "no"}
                ariaLabel="Allow editing the Dashboard"
                options=${[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]}
                onChange=${(v) => onSetDashboardAccess(v === "yes")} />
            </div>
            <div style="margin-top:10px">
              <button class="btn btn--sm btn--go" style="width:100%" onClick=${onTransferAdmin}>Make ${r.name || "them"} the race host</button>
            </div>
          `}

          ${!canEdit && html`<p class="adminlock" style="margin-top:12px">This is ${r.name}'s profile — only they can log or edit their savings.</p>`}
          <div class=${canEdit ? "" : "adminlock__area"}>
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

/* shown to a single person the moment their own racer crosses their goal —
   same confetti treatment as the tutorial finale, but with their placement */
function CongratsModal({ rank, onDismiss }) {
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
        <div style="font-size:40px">🏆</div>
        <h3>You reached your goal!</h3>
        <p class="modal__msg">You finished in <b>${ordinal(rank)} place</b> — congratulations!</p>
        <button class="btn btn--go" style="width:100%" onClick=${onDismiss}>Nice!</button>
      </div>
    </div>`;
}

/* shown to EVERYONE the moment the whole field has finished — stays up
   (App only renders it while race.raceResolved is falsy) until the host
   taps one of the two resolve buttons. Non-hosts can cast a vote so the
   host can see what people want, but only the host's tap is binding. */
function FinalRaceModal({ rows, isAdmin, myRacerId, onVote, onResolve, onClose, isEarly }) {
  const winner = rows.find((r) => r.rank === 1);
  const resumeVotes = rows.filter((r) => r.finalVote === "resume").length;
  const resetVotes = rows.filter((r) => r.finalVote === "reset").length;
  const myVote = rows.find((r) => r.id === myRacerId)?.finalVote || "";

  return html`
    <div class="modal-overlay" onClick=${(e) => { if (onClose && e.target === e.currentTarget) onClose(); }}>
      <div class="modal" style="text-align:center;max-width:360px;position:relative">
        ${onClose && html`<button class="backbtn" style="position:absolute;top:10px;right:10px;padding:6px 10px"
          onClick=${onClose} aria-label="Close">✕</button>`}
        <div style="font-size:40px">🏁</div>
        ${isEarly
          ? html`
            <h3>Vote to end this race?</h3>
            <p class="modal__msg">Not everyone's reached their goal yet. Racers can vote to wipe the log clean and start over, or just keep going as-is.</p>`
          : html`
            <h3>The race is over!</h3>
            <p class="modal__msg">Everyone's hit their goal${winner ? html` — congrats to ${html`<b>${winner.name}</b>`} for finishing first!` : "!"}</p>`}

        <p class="goalcard__hint" style="margin-top:16px">Cast your vote — the host still makes the final call</p>
        <div class="modal__actions">
          <button class=${"btn btn--sm " + (myVote === "resume" ? "btn--go" : "btn--ghost")}
            onClick=${() => onVote("resume")}>Resume (${resumeVotes})</button>
          <button class=${"btn btn--sm " + (myVote === "reset" ? "btn--go" : "btn--ghost")}
            onClick=${() => onVote("reset")}>New race (${resetVotes})</button>
        </div>

        ${isAdmin
          ? html`
            <p class="modal__msg" style="margin-top:16px;font-size:13px">As the host, the final call is yours:</p>
            <div class="modal__actions" style="margin-top:6px">
              <button class="btn btn--ghost" onClick=${() => onResolve("resume")}>Resume this race</button>
              <button class="btn btn--danger" onClick=${() => onResolve("reset")}>Start new race</button>
            </div>`
          : html`<p class="goalcard__hint" style="margin-top:14px">Waiting on the host to make the final call…</p>`}
      </div>
    </div>`;
}

/* shown only to racers still following the shared default schedule, the
   moment the host changes it — keeps showing (App only renders it while
   the racer's own scheduleAckVersion trails the race's) until they answer
   either way, surviving a closed-and-reopened app since both sides of the
   comparison live in Firestore, not local state */
function ScheduleSyncModal({ race, onAccept, onDecline }) {
  const cadence = race.cadence || "every:1";
  return html`
    <div class="modal-overlay">
      <div class="modal" style="max-width:340px">
        <p class="modal__msg" style="font-weight:700">The host set a savings schedule</p>
        <p class="modal__msg">
          ${race.targetDate ? html`Save by <b>${prettyDate(race.targetDate)}</b>, ` : ""}${cadenceLabel(cadence).toLowerCase()}.
          Want your log filled in automatically to match, or would you rather set it up yourself?
        </p>
        <div class="modal__actions" style="margin-top:16px">
          <button class="btn btn--ghost" onClick=${onDecline}>I'll do it myself</button>
          <button class="btn btn--go" onClick=${onAccept}>Yes, fill it in for me</button>
        </div>
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
