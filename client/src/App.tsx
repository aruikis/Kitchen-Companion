import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, bytesToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { CHANGELOG, notesFor } from "./changelog";

type Recipe = ApiResponse<typeof api, "listRecipes">["recipes"][number];
type Collection = ApiResponse<typeof api, "listCollections">["collections"][number];
type Draft = ApiResponse<typeof api, "importUrl">["draft"];
type GroceryItem = ApiResponse<typeof api, "listGrocery">["items"][number];
type JewelOrder = ApiResponse<typeof api, "getShop">["orders"][number];
type UpdateInfo = ApiResponse<typeof api, "checkForUpdate">;
type ProfileInfo = ApiResponse<typeof api, "getProfile">;
type MyProfile = NonNullable<ProfileInfo["profile"]>;
type FriendsInfo = ApiResponse<typeof api, "getFriends">;
type PlanEntry = ApiResponse<typeof api, "listPlan">["entries"][number];
type StagedItem = ApiResponse<typeof api, "listStagedImports">["items"][number];

type Tab = "recipes" | "add" | "plan" | "shop" | "friends" | "settings";
type View =
  | { kind: "main" }
  | { kind: "recipe"; id: number }
  | {
      kind: "review";
      draft: NonNullable<Draft>;
      editingId: number | null;
      previewUrl: string | null;
      stagedId?: number | null;
      sourceNote?: string | null;
      rawText?: string | null;
    };

// Forgiving title comparison for duplicate warnings — the same rules the
// server uses when it flags a staged email recipe: punctuation and case
// don't matter, one title containing the other counts, and so does heavy
// word overlap ("Grandma's Tomato Soup" ≈ "Tomato soup, Grandma's").
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function titlesSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  const wa = new Set(na.split(" ").filter((w) => w.length > 2));
  const wb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

// ---------- small helpers ----------

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function totalMinutes(r: Recipe): number | null {
  const t = (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
  return t > 0 ? t : null;
}

const UNICODE_FRAC: Record<string, number> = {
  "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

function fmtQty(n: number): string {
  const rounded = Math.round(n * 8) / 8;
  const whole = Math.floor(rounded);
  const rem = rounded - whole;
  const fracs: Array<[number, string]> = [
    [0.125, "1/8"], [0.25, "1/4"], [1 / 3, "1/3"], [0.375, "3/8"],
    [0.5, "1/2"], [0.625, "5/8"], [2 / 3, "2/3"], [0.75, "3/4"], [0.875, "7/8"],
  ];
  let fracStr = "";
  for (const [v, s] of fracs) {
    if (Math.abs(rem - v) < 0.04) { fracStr = s; break; }
  }
  if (rem !== 0 && !fracStr) return String(Math.round(n * 100) / 100);
  if (whole === 0) return fracStr || "0";
  return fracStr ? `${whole} ${fracStr}` : String(whole);
}

/** Scales the leading quantity of an ingredient line by a factor. */
function scaleLine(line: string, factor: number): string {
  if (factor === 1) return line;
  const mixed = line.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*/);
  const frac = line.match(/^(\d+)\s*\/\s*(\d+)\s*/);
  const plain = line.match(/^(\d+(?:\.\d+)?)\s*/);
  const uni = line.match(/^(\d+)?\s*([½¼¾⅓⅔⅛⅜⅝⅞])\s*/);
  let qty: number | null = null;
  let rest = line;
  if (mixed?.[1] && mixed?.[2] && mixed?.[3]) {
    qty = parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    rest = line.slice(mixed[0].length);
  } else if (frac?.[1] && frac?.[2]) {
    qty = parseInt(frac[1], 10) / parseInt(frac[2], 10);
    rest = line.slice(frac[0].length);
  } else if (uni?.[2] && UNICODE_FRAC[uni[2]] != null) {
    qty = (uni[1] ? parseInt(uni[1], 10) : 0) + (UNICODE_FRAC[uni[2]] ?? 0);
    rest = line.slice(uni[0].length);
  } else if (plain?.[1]) {
    qty = parseFloat(plain[1]);
    rest = line.slice(plain[0].length);
  }
  if (qty == null) return line;
  return `${fmtQty(qty * factor)} ${rest}`;
}

type FoundTimer = { label: string; seconds: number };

function timersInStep(step: string): FoundTimer[] {
  const out: FoundTimer[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step)) !== null) {
    const value = parseFloat(m[1] ?? "0");
    const unit = (m[2] ?? "").toLowerCase();
    if (!value) continue;
    const mult = unit.startsWith("h") ? 3600 : unit.startsWith("s") ? 1 : 60;
    out.push({ label: m[0], seconds: Math.round(value * mult) });
  }
  return out;
}

// Jewel-Osco's official online ordering homepage — verified by opening it
// (final URL https://www.jewelosco.com/, page title: "Grocery Delivery Near
// You - Order Groceries Online | Jewel-Osco"). Use the https://www form:
// the old http:// link failed to open from inside the app.
const JEWEL_URL = "https://www.jewelosco.com/";

// Visible version (Anthony's standing rule: the UAT carries its version
// number in the app, and the GitHub push of this build is tagged with it).
const APP_VERSION = "1.5.1";

// Automatic categories (chosen by the app when a recipe is added; the cook
// can correct them). Mirrors the server's lists in actions.ts.
const COURSES = ["Appetizers", "Main Dishes", "Side Dishes", "Soups & Salads", "Desserts", "Breakfast", "Snacks", "Drinks"] as const;
const PROTEINS = ["Poultry", "Beef", "Pork", "Seafood", "Lamb & Game", "Vegetarian", "Other"] as const;
const TIME_BANDS = ["Under 30 minutes", "30–60 minutes", "Over an hour"] as const;

// Copy that works inside the app frame: the clipboard API first, then the
// older selection-based copy as a fallback. Returns false only when both
// are unavailable — callers then show the text on screen to copy by hand.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function shareOut(title: string, text: string): Promise<"shared" | "copied" | "failed"> {
  const nav = navigator as Navigator & { share?: (d: { title: string; text: string }) => Promise<void> };
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title, text });
      return "shared";
    } catch {
      // user cancelled or share failed — fall through to copy
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

function recipeShareText(r: Recipe): string {
  const lines: string[] = [r.title];
  if (r.servings) lines.push(`Serves ${r.servings}`);
  const total = totalMinutes(r);
  if (total) lines.push(`About ${total} minutes`);
  lines.push("", "Ingredients:");
  for (const i of r.ingredients) lines.push(`- ${i}`);
  lines.push("", "Steps:");
  r.steps.forEach((s, idx) => lines.push(`${idx + 1}. ${s}`));
  if (r.sourceUrl) lines.push("", `From: ${r.sourceUrl}`);
  lines.push("", "Shared from Kitchen Companion");
  return lines.join("\n");
}

/** Reads the EXIF orientation tag (1–8) from a JPEG's bytes; 1 (upright) when absent or unreadable. */
async function readExifOrientation(file: File): Promise<number> {
  try {
    if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return 1;
    const buf = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return 1;
      const marker = buf[offset + 1] ?? 0;
      if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end — no EXIF beyond here
      const len = ((buf[offset + 2] ?? 0) << 8) + (buf[offset + 3] ?? 0);
      if (len < 2) return 1;
      if (marker === 0xe1) {
        // APP1 — check for the "Exif\0\0" header
        const p = offset + 4;
        if (buf[p] === 0x45 && buf[p + 1] === 0x78 && buf[p + 2] === 0x69 && buf[p + 3] === 0x66 && buf[p + 4] === 0 && buf[p + 5] === 0) {
          const tiff = p + 6;
          const le = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
          const u16 = (o: number) => (le ? (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8) : ((buf[o] ?? 0) << 8) + (buf[o + 1] ?? 0));
          const u32 = (o: number) =>
            le
              ? (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8) + ((buf[o + 2] ?? 0) << 16) + ((buf[o + 3] ?? 0) << 24)
              : ((buf[o] ?? 0) << 24) + ((buf[o + 1] ?? 0) << 16) + ((buf[o + 2] ?? 0) << 8) + (buf[o + 3] ?? 0);
          if (tiff + 8 > buf.length) return 1;
          const ifd = tiff + u32(tiff + 4);
          if (ifd + 2 > buf.length) return 1;
          const count = u16(ifd);
          for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (entry + 12 > buf.length) break;
            if (u16(entry) === 0x0112) {
              const v = u16(entry + 8);
              return v >= 1 && v <= 8 ? v : 1;
            }
          }
          return 1;
        }
      }
      offset += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  }
}

type LoadedPhoto = { dataBase64: string; mimeType: "image/jpeg" | "image/png"; previewUrl: string };

async function drawPhoto(file: File, extraQuarterTurns: number): Promise<LoadedPhoto> {
  const srcUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = srcUrl;
    });
    const orientation = await readExifOrientation(file);
    // What the EXIF tag demands, in clockwise quarter turns + a mirror flag.
    const exifTurns = orientation === 3 || orientation === 4 ? 2 : orientation === 5 || orientation === 6 ? 1 : orientation === 7 || orientation === 8 ? 3 : 0;
    const exifMirrored = orientation === 2 || orientation === 4 || orientation === 5 || orientation === 7;
    // Did this viewer already apply the EXIF turn when decoding? Compare
    // the <img> decode against a raw decode (imageOrientation:'none'):
    // differing dimensions mean the <img> pixels are already turned, so
    // the tag must not be applied twice. Where raw decode is unavailable,
    // modern browsers apply EXIF in <img>, so assume it was applied.
    let viewerAppliedExif = true;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "none" });
      viewerAppliedExif = bmp.width !== img.naturalWidth || bmp.height !== img.naturalHeight;
      bmp.close();
    } catch {
      viewerAppliedExif = true;
    }

    const turns = (((viewerAppliedExif ? 0 : exifTurns) + extraQuarterTurns) % 4 + 4) % 4;
    const mirrored = viewerAppliedExif ? false : exifMirrored;

    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const drawW = Math.round(img.naturalWidth * scale);
    const drawH = Math.round(img.naturalHeight * scale);
    const swap = turns % 2 === 1;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? drawH : drawW;
    canvas.height = swap ? drawW : drawH;
    const c = canvas.getContext("2d");
    if (!c) throw new Error("canvas unavailable");
    c.translate(canvas.width / 2, canvas.height / 2);
    c.rotate((turns * Math.PI) / 2);
    if (mirrored) c.scale(-1, 1);
    c.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { dataBase64: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg", previewUrl: dataUrl };
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

/**
 * Prepares an uploaded photo: right-side up and sensibly sized.
 * The photo's own EXIF orientation is applied so an upside-down or sideways
 * shot is stored upright; `extraQuarterTurns` adds a further clockwise
 * quarter-turn (used when the scanner reports the page itself was turned).
 */
async function photoToBase64(file: File, extraQuarterTurns = 0): Promise<LoadedPhoto> {
  if (extraQuarterTurns === 0 && file.type === "image/png" && file.size < 1_500_000) {
    const orientation = await readExifOrientation(file); // PNGs: almost always 1; cheap guard
    if (orientation === 1) {
      const previewUrl = URL.createObjectURL(file);
      const buf = new Uint8Array(await file.arrayBuffer());
      return { dataBase64: bytesToBase64(buf), mimeType: "image/png", previewUrl };
    }
  }
  return drawPhoto(file, extraQuarterTurns);
}

/** Rotates an already-prepared photo a further 90° clockwise (the scanner's fix-up pass). */
async function rotateLoadedPhoto(photo: LoadedPhoto): Promise<LoadedPhoto> {
  const res = await fetch(photo.previewUrl);
  const blob = await res.blob();
  const file = new File([blob], "photo.jpg", { type: "image/jpeg" });
  return drawPhoto(file, 1);
}

async function fileToRawBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return bytesToBase64(buf);
}

// ---------- shared UI bits ----------

function Stars({ value, onSet, size = "text-lg" }: { value: number | null; onSet?: (n: number | null) => void; size?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${size}`} role="group" aria-label={value ? `Rated ${value} of 5` : "Not rated"}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onSet}
          aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
          onClick={() => onSet?.(value === n ? null : n)}
          className={onSet ? "cursor-pointer" : "cursor-default"}
          style={{ color: value != null && n <= value ? "#e8a33d" : "var(--dim)" }}
        >
          ★
        </button>
      ))}
    </span>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors"
      style={{
        background: active ? "var(--accent)" : "var(--surface2)",
        color: active ? "var(--accent-ink)" : "var(--text)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </button>
  );
}

// A stored recipe photo with a graceful fallback: if the photo link ever
// fails to load, the placeholder takes its place instead of a broken-image
// icon — and the rest of the page is unaffected.
function RecipePhoto({
  src, alt = "", imgClassName, imgStyle, placeholderClassName, placeholderText,
}: {
  src: string | null;
  alt?: string;
  imgClassName?: string;
  imgStyle?: CSSProperties;
  placeholderClassName?: string;
  placeholderText?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    if (placeholderText) {
      return (
        <div className={placeholderClassName} style={{ background: "var(--surface2)" }}>
          <span className="text-5xl" aria-hidden>🍽️</span>
          <p className="mt-2 px-6 text-center text-sm" style={{ color: "var(--dim)" }}>{placeholderText}</p>
        </div>
      );
    }
    return (
      <div className={placeholderClassName} style={{ background: "var(--surface2)" }} aria-hidden>
        🍽️
      </div>
    );
  }
  return <img src={src} alt={alt} className={imgClassName} style={imgStyle} onError={() => setFailed(true)} />;
}

// ---------- timers ----------

type RunningTimer = { id: number; label: string; endsAt: number; totalSec: number; done: boolean };

function useTimers() {
  const [timers, setTimers] = useState<RunningTimer[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (timers.length === 0) return;
    const iv = setInterval(() => {
      setTick((t) => t + 1);
      setTimers((prev) =>
        prev.map((t) => {
          if (!t.done && Date.now() >= t.endsAt) {
            try {
              const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
              if (AC) {
                const ac = new AC();
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain);
                gain.connect(ac.destination);
                gain.gain.value = 0.15;
                osc.frequency.value = 880;
                osc.start();
                osc.stop(ac.currentTime + 0.6);
              }
            } catch { /* sound is a nicety, not a requirement */ }
            return { ...t, done: true };
          }
          return t;
        }),
      );
    }, 500);
    return () => clearInterval(iv);
  }, [timers.length]);

  const start = (label: string, seconds: number) => {
    setTimers((prev) => [
      ...prev,
      { id: Date.now() + Math.random(), label, endsAt: Date.now() + seconds * 1000, totalSec: seconds, done: false },
    ]);
  };
  const dismiss = (id: number) => setTimers((prev) => prev.filter((t) => t.id !== id));
  return { timers, start, dismiss };
}

function fmtCountdown(t: RunningTimer): string {
  if (t.done) return "Done!";
  const remain = Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000));
  const h = Math.floor(remain / 3600);
  const m = Math.floor((remain % 3600) / 60);
  const s = remain % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function TimerBar({ timers, dismiss }: { timers: RunningTimer[]; dismiss: (id: number) => void }) {
  if (timers.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Running timers">
      {timers.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold"
          style={{
            background: t.done ? "var(--herb)" : "var(--surface2)",
            color: t.done ? "#10240c" : "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          ⏱ {t.label} · {fmtCountdown(t)}
          <button type="button" aria-label={`Dismiss timer ${t.label}`} onClick={() => dismiss(t.id)} className="opacity-70">
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

// ---------- app shell ----------

export function App() {
  const [tab, setTab] = useState<Tab>("recipes");
  const [view, setView] = useState<View>({ kind: "main" });
  const [inWelcome, setInWelcome] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const queryClient = useQueryClient();

  // The profile gates the app: no profile yet → the welcome setup runs
  // first (once, ever). Existing recipes are never touched by it.
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: () => api.getProfile({}) });
  const profile: MyProfile | null = profileQ.data?.profile ?? null;
  useEffect(() => {
    if (profileQ.data && !profileQ.data.profile) setInWelcome(true);
  }, [profileQ.data]);
  // Register on the shared backend (and push any shares made while it was
  // off) whenever the profile is still unregistered — and KEEP retrying
  // while the app stays open. This used to be a one-shot attempt: a single
  // failed try on open (one connection hiccup, or the backend not being
  // up yet at that moment) latched it off for the whole session, which is
  // how profiles stayed invisible to friends' code lookups. The server
  // also heals inside getProfile; this is the second net, and it stops on
  // its own the moment the profile reports registered.
  useEffect(() => {
    const p = profileQ.data;
    if (!p?.profile || !p.friendsOnline || p.backendSynced) return;
    let cancelled = false;
    const trySync = () => {
      void api.syncProfile({})
        .then((r) => {
          if (cancelled || !r.backendSynced) return;
          queryClient.invalidateQueries({ queryKey: ["profile"] });
          queryClient.invalidateQueries({ queryKey: ["friends"] });
        })
        .catch(() => { /* the Friends tab shows the state honestly; the timer retries */ });
    };
    trySync();
    const timer = setInterval(trySync, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [profileQ.data, queryClient]);

  // Typing must stay visible (Liz's report, Nov 9, 2026: "when typing
  // it's not in the box and I can't see it"). On a phone the on-screen
  // keyboard plus the fixed bottom bar can leave the focused field
  // covered, so every time a text field gains focus, bring it to the
  // middle of the screen once the keyboard has had a moment to open.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      if (el.type === "file" || el.type === "checkbox" || el.type === "radio") return;
      window.setTimeout(() => {
        if (document.activeElement === el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }, 350);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const recipesQ = useQuery({ queryKey: ["recipes"], queryFn: () => api.listRecipes({}) });
  const collectionsQ = useQuery({ queryKey: ["collections"], queryFn: () => api.listCollections({}) });
  // On open, check the public GitHub repo (the distribution channel) for a
  // newer version. Checking never changes anything — updating is a choice
  // made in Settings.
  const updateQ = useQuery({
    queryKey: ["update-check"],
    queryFn: () => api.checkForUpdate({ currentVersion: APP_VERSION }),
    staleTime: 1000 * 60 * 60,
    retry: false,
  });
  const updateInfo: UpdateInfo | null = updateQ.data ?? null;
  const recipes = recipesQ.data?.recipes ?? [];
  const collections = collectionsQ.data?.collections ?? [];
  // Automatic backup: on open, check where the library stands; if recipes
  // or photos changed since the last automatic snapshot, quietly take a
  // fresh one (in this app's own private storage, never anywhere public).
  const backupStatusQ = useQuery({
    queryKey: ["backupStatus"],
    queryFn: () => api.getBackupStatus({}),
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
  const autoBackupTried = useRef(false);
  useEffect(() => {
    if (autoBackupTried.current) return;
    const status = backupStatusQ.data;
    if (!status || recipesQ.isPending) return;
    autoBackupTried.current = true;
    if (status.autoBackupNeeded) {
      void (async () => {
        try {
          const { payload } = await assembleBackup(recipes);
          await api.saveAutoBackup({
            exportedAt: payload.exportedAt,
            photosUnreadable: payload.photosUnreadable,
            collections: payload.collections,
            recipes: payload.recipes,
          });
          queryClient.invalidateQueries({ queryKey: ["backupStatus"] });
        } catch {
          /* the backup panel keeps showing a snapshot is still needed */
        }
      })();
    }
  }, [backupStatusQ.data, recipesQ.isPending, recipes, queryClient]);

  // Recipes Muse delivered from email wait here for review — the count
  // drives the banner on the Recipes tab, and the Add tab's import inbox
  // reads the same query.
  const stagedQ = useQuery({ queryKey: ["stagedImports"], queryFn: () => api.listStagedImports({}) });
  const stagedItems = stagedQ.data?.items ?? [];

  const openRecipe = (id: number) => setView({ kind: "recipe", id });
  const openReview = (draft: NonNullable<Draft>, editingId: number | null, previewUrl: string | null) =>
    setView({ kind: "review", draft, editingId, previewUrl });
  const openStagedReview = (item: StagedItem) => {
    if (!item.draft) return;
    const from = item.senderName || item.senderEmail || "an email";
    const bits = [`from ${from}`];
    if (item.subject) bits.push(`“${item.subject}”`);
    if (item.emailDate) bits.push(item.emailDate);
    setView({
      kind: "review",
      draft: item.draft,
      editingId: null,
      previewUrl: item.scanPhotoUrl,
      stagedId: item.id,
      sourceNote: `📧 This recipe came from your email — ${bits.join(" · ")}. The original email is kept below${item.draft.attachmentName ? ", with its file attached" : ""}.`,
      rawText: item.rawText,
    });
  };

  if (profileQ.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--bg)", color: "var(--text)" }}>
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <p className="text-base" role="status">Opening Kitchen Companion…</p>
      </div>
    );
  }

  if (inWelcome) {
    return (
      <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <WelcomeFlow
          onDone={() => {
            setInWelcome(false);
            queryClient.invalidateQueries({ queryKey: ["profile"] });
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-4">
        {view.kind === "recipe" ? (
          <RecipeDetail
            recipeId={view.id}
            recipes={recipes}
            collections={collections}
            onBack={() => setView({ kind: "main" })}
            onGoShop={() => { setTab("shop"); setView({ kind: "main" }); }}
            onEdit={(r) =>
              openReview(
                {
                  title: r.title,
                  description: r.description,
                  servings: r.servings,
                  prepMinutes: r.prepMinutes,
                  cookMinutes: r.cookMinutes,
                  ingredients: r.ingredients,
                  steps: r.steps,
                  tags: r.tags,
                  course: r.course,
                  protein: r.protein,
                  pageNeedsRotation: "none",
                  sourceUrl: r.sourceUrl,
                  sourceName: r.sourceName,
                  sourcePhotoKey: r.sourcePhotoKey,
                  scanPhotoKey: r.scanPhotoKey,
                  attachmentName: r.attachmentName,
                  attachmentKey: r.attachmentKey,
                },
                r.id,
                null,
              )
            }
          />
        ) : view.kind === "review" ? (
          <ReviewForm
            draft={view.draft}
            editingId={view.editingId}
            previewUrl={view.previewUrl}
            stagedId={view.stagedId ?? null}
            sourceNote={view.sourceNote ?? null}
            rawText={view.rawText ?? null}
            collections={collections}
            recipes={recipes}
            onDone={(recipeId) => {
              if (recipeId != null) setView({ kind: "recipe", id: recipeId });
              else setView({ kind: "main" });
            }}
            onCancel={() => setView({ kind: "main" })}
          />
        ) : tab === "recipes" ? (
          <Library
            recipes={recipes}
            collections={collections}
            loading={recipesQ.isPending}
            error={recipesQ.error ? String(recipesQ.error) : null}
            updateInfo={updateInfo}
            profile={profile}
            stagedCount={stagedItems.length}
            onOpenSettings={() => setTab("settings")}
            onOpen={openRecipe}
            onAdd={() => setTab("add")}
          />
        ) : tab === "add" ? (
          <AddRecipe onReview={openReview} onReviewStaged={openStagedReview} />
        ) : tab === "plan" ? (
          <Planner recipes={recipes} onOpen={openRecipe} />
        ) : tab === "shop" ? (
          <GroceryList />
        ) : tab === "friends" ? (
          <FriendsView profile={profile} recipes={recipes} collections={collections} onOpenRecipe={openRecipe} />
        ) : (
          <SettingsView
            updateInfo={updateInfo}
            checking={updateQ.isFetching}
            onRecheck={() => updateQ.refetch()}
            profile={profile}
            friendsOnline={profileQ.data?.friendsOnline ?? false}
            recoveryKey={profileQ.data?.recoveryKey ?? null}
            onShowTutorial={() => setShowTutorial(true)}
          />
        )}
      </main>

      {showTutorial && (
        <div className="fixed inset-0 z-50 overflow-y-auto" style={{ background: "var(--bg)" }} role="dialog" aria-label="Tutorial">
          <Tutorial finishLabel="Done" onFinish={() => setShowTutorial(false)} />
        </div>
      )}

      {view.kind === "main" && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t pb-safe"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          aria-label="Main"
        >
          <div className="mx-auto grid max-w-3xl grid-cols-6">
            {(
              [
                ["recipes", "📖", "Recipes"],
                ["add", "＋", "Add"],
                ["plan", "🗓", "Plan"],
                ["shop", "🛒", "Shop"],
                ["friends", "👥", "Friends"],
                ["settings", "⚙️", "Settings"],
              ] as Array<[Tab, string, string]>
            ).map(([key, icon, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-current={tab === key ? "page" : undefined}
                className="flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium"
                style={{ color: tab === key ? "var(--accent)" : "var(--dim)" }}
              >
                <span className="text-xl leading-none">{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

// ---------- library ----------

type Filter = "all" | "favorites" | "want" | "made";

function Library({
  recipes, collections, loading, error, updateInfo, profile, stagedCount, onOpenSettings, onOpen, onAdd,
}: {
  recipes: Recipe[];
  collections: Collection[];
  loading: boolean;
  error: string | null;
  updateInfo: UpdateInfo | null;
  profile: MyProfile | null;
  stagedCount: number;
  onOpenSettings: () => void;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [proteinFilter, setProteinFilter] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<string | null>(null);
  const [fridge, setFridge] = useState("");
  const queryClient = useQueryClient();
  const favMut = useMutation({
    mutationFn: (args: { id: number; favorite: boolean }) => api.setFavorite(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  });

  // Recipes saved before automatic categories existed get theirs filled in
  // once, silently, the first time the library opens with any missing.
  const backfilledRef = useRef(false);
  useEffect(() => {
    if (backfilledRef.current) return;
    if (recipes.some((r) => !r.course || !r.protein)) {
      backfilledRef.current = true;
      api.backfillCategories({})
        .then(() => queryClient.invalidateQueries({ queryKey: ["recipes"] }))
        .catch(() => { /* categories fill in on a later open */ });
    }
  }, [recipes, queryClient]);

  const coursesPresent = useMemo(
    () => COURSES.filter((c) => recipes.some((r) => r.course === c)),
    [recipes],
  );
  const proteinsPresent = useMemo(
    () => PROTEINS.filter((p) => recipes.some((r) => r.protein === p)),
    [recipes],
  );
  const timesPresent = useMemo(
    () => TIME_BANDS.filter((t) => recipes.some((r) => r.timeTag === t)),
    [recipes],
  );

  const fridgeTokens = useMemo(
    () => fridge.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean),
    [fridge],
  );

  const shown = useMemo(() => {
    let list = recipes;
    if (filter === "favorites") list = list.filter((r) => r.favorite);
    if (filter === "want") list = list.filter((r) => r.status === "want");
    if (filter === "made") list = list.filter((r) => r.status === "made");
    if (collectionId != null) list = list.filter((r) => r.collectionId === collectionId);
    if (courseFilter) list = list.filter((r) => r.course === courseFilter);
    if (proteinFilter) list = list.filter((r) => r.protein === proteinFilter);
    if (timeFilter) list = list.filter((r) => r.timeTag === timeFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.tags.some((t) => t.includes(q)) ||
          r.ingredients.some((i) => i.toLowerCase().includes(q)),
      );
    }
    if (fridgeTokens.length > 0) {
      const scored = list.map((r) => {
        const hay = r.ingredients.join(" ").toLowerCase();
        const hits = fridgeTokens.filter((t) => hay.includes(t)).length;
        return { r, hits };
      });
      return scored
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .map((s) => ({ ...s.r, fridgeHits: s.hits }));
    }
    return list.map((r) => ({ ...r, fridgeHits: 0 }));
  }, [recipes, filter, collectionId, courseFilter, proteinFilter, timeFilter, query, fridgeTokens]);

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">My Recipes</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        {recipes.length === 0
          ? "Your own cookbook — every recipe you save lives here, not on a pin board."
          : `${recipes.length} recipe${recipes.length === 1 ? "" : "s"} saved`}
      </p>

      {updateInfo?.status === "update-available" && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-3 w-full rounded-[var(--radius)] px-4 py-3 text-left"
          style={{ background: "var(--surface)", border: "1px solid var(--herb)" }}
        >
          <span className="text-sm font-bold" style={{ color: "var(--herb)" }}>
            ⬆️ Update available — Kitchen Companion v{updateInfo.latestVersion}
          </span>
          <span className="mt-0.5 block text-sm" style={{ color: "var(--dim)" }}>
            See what’s new in Settings and update when you’re ready. Nothing changes until you choose it.
          </span>
        </button>
      )}

      {stagedCount > 0 && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-3 w-full rounded-[var(--radius)] px-4 py-3 text-left"
          style={{ background: "var(--surface)", border: "1px solid var(--accent)" }}
        >
          <span className="text-sm font-bold" style={{ color: "var(--accent)" }}>
            📧 {stagedCount} recipe{stagedCount === 1 ? "" : "s"} from your email waiting for your OK
          </span>
          <span className="mt-0.5 block text-sm" style={{ color: "var(--dim)" }}>
            Muse found them in your email and set them aside for you. Nothing is saved until you check each one — tap to review them in the import inbox.
          </span>
        </button>
      )}

      <div className="mt-4">
        <label htmlFor="recipe-search" className="sr-only">Search your recipes</label>
        <input
          id="recipe-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your recipes — try “chicken” or “spinach”…"
          className="w-full rounded-[var(--radius)] px-4 py-3 text-base outline-none"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2 pb-1" aria-label="Filters">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
        <Chip active={filter === "favorites"} onClick={() => setFilter("favorites")}>♥ Favourites</Chip>
        <Chip active={filter === "want"} onClick={() => setFilter("want")}>Want to try</Chip>
        <Chip active={filter === "made"} onClick={() => setFilter("made")}>Made it</Chip>
        {collections.map((c) => (
          <Chip key={c.id} active={collectionId === c.id} onClick={() => setCollectionId(collectionId === c.id ? null : c.id)}>
            {c.name}
          </Chip>
        ))}
      </div>

      {(coursesPresent.length > 0 || proteinsPresent.length > 0 || timesPresent.length > 0) && (
        <div className="mt-1 space-y-1.5" aria-label="Category filters">
          {coursesPresent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: "var(--dim)" }}>Course</span>
              {coursesPresent.map((c) => (
                <Chip key={c} active={courseFilter === c} onClick={() => setCourseFilter(courseFilter === c ? null : c)}>{c}</Chip>
              ))}
            </div>
          )}
          {proteinsPresent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: "var(--dim)" }}>Protein</span>
              {proteinsPresent.map((p) => (
                <Chip key={p} active={proteinFilter === p} onClick={() => setProteinFilter(proteinFilter === p ? null : p)}>{p}</Chip>
              ))}
            </div>
          )}
          {timesPresent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: "var(--dim)" }}>Time</span>
              {timesPresent.map((t) => (
                <Chip key={t} active={timeFilter === t} onClick={() => setTimeFilter(timeFilter === t ? null : t)}>{t}</Chip>
              ))}
            </div>
          )}
        </div>
      )}

      <details className="mt-2 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <summary className="cursor-pointer text-sm font-semibold">🥬 What’s in my fridge?</summary>
        <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
          Type what needs using up and your recipes that use it float to the top.
        </p>
        <label htmlFor="fridge-input" className="sr-only">Ingredients I have</label>
        <input
          id="fridge-input"
          type="text"
          value={fridge}
          onChange={(e) => setFridge(e.target.value)}
          placeholder="chicken, spinach, lemon…"
          className="mt-2 w-full rounded-lg px-3 py-2.5 text-base outline-none"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
      </details>

      {loading && <p className="mt-8 text-center" style={{ color: "var(--dim)" }}>Opening your cookbook…</p>}
      {error && <p className="mt-8 text-center" style={{ color: "var(--accent)" }}>Something went wrong loading your recipes: {error}</p>}

      {!loading && recipes.length === 0 && (
        <div className="mt-8 rounded-[var(--radius)] px-5 py-8 text-center" style={{ background: "var(--surface)", border: "1px dashed var(--border)" }}>
          <p className="text-4xl" aria-hidden>🍳</p>
          <h2 className="font-display mt-3 text-xl font-bold">No recipes yet — let’s fix that</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--dim)" }}>
            Four easy ways in: paste a link from Pinterest or a blog, scan a cookbook page with the
            camera, upload a file, or type one in. Every recipe lands on a check-and-fix screen
            before it’s saved, so nothing goes in garbled.
          </p>
          <button
            type="button"
            onClick={onAdd}
            className="mt-5 rounded-full px-6 py-3 text-base font-semibold"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Add your first recipe
          </button>
        </div>
      )}

      {!loading && recipes.length > 0 && shown.length === 0 && (
        <p className="mt-8 text-center text-sm" style={{ color: "var(--dim)" }}>
          Nothing matches that yet. Try a different word, or clear the filters.
        </p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {shown.map((r) => {
          const photo = r.dishPhotoUrl ?? r.sourcePhotoUrl;
          const total = totalMinutes(r);
          return (
            <article
              key={r.id}
              className="relative overflow-hidden rounded-[var(--radius)] text-left"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <button type="button" onClick={() => onOpen(r.id)} className="block w-full text-left" aria-label={`Open ${r.title}`}>
                <RecipePhoto
                  src={photo}
                  imgClassName="aspect-[4/3] w-full object-cover"
                  placeholderClassName="flex aspect-[4/3] w-full items-center justify-center text-4xl"
                />
                <div className="p-3">
                  <h3 className="font-display text-base font-bold leading-snug">{r.title}</h3>
                  {r.tags.includes("example") && (
                    <p className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "var(--herb)", color: "#10240c" }}>
                      ⭐ Example recipe
                    </p>
                  )}
                  <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
                    {total ? `${total} min` : ""}
                    {r.servings ? `${total ? " · " : ""}serves ${r.servings}` : ""}
                  </p>
                  {(r.course || r.protein) && (
                    <p className="mt-0.5 text-xs font-medium" style={{ color: "var(--herb)" }}>
                      {[r.course, r.protein].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {r.fridgeHits > 0 && (
                    <p className="mt-1 text-xs font-semibold" style={{ color: "var(--herb)" }}>
                      Uses {r.fridgeHits} of your fridge items
                    </p>
                  )}
                  {r.status === "made" ? (
                    <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
                      Cooked {r.cookCount}×{r.lastCookedAt ? ` · last ${prettyDate(r.lastCookedAt)}` : ""}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs font-medium" style={{ color: "var(--accent)" }}>Want to try</p>
                  )}
                  {r.rating != null && <Stars value={r.rating} size="text-sm" />}
                </div>
              </button>
              <button
                type="button"
                aria-label={r.favorite ? `Remove ${r.title} from favourites` : `Add ${r.title} to favourites`}
                onClick={() => favMut.mutate({ id: r.id, favorite: !r.favorite })}
                className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-lg"
                style={{ background: "rgba(23,19,16,0.65)", color: r.favorite ? "#e4572e" : "#f5ead9" }}
              >
                {r.favorite ? "♥" : "♡"}
              </button>
            </article>
          );
        })}
      </div>

      <BackupBar recipes={recipes} collections={collections} profile={profile} />

      <footer className="mt-8 pb-2 text-center">
        <p className="text-xs" style={{ color: "var(--dim)" }}>Kitchen Companion UAT · Version {APP_VERSION}</p>
        <details
          className="mx-auto mt-2 max-w-md rounded-[var(--radius)] px-4 py-3 text-left"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <summary className="cursor-pointer text-sm font-semibold">What’s new in {APP_VERSION}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--dim)" }}>
            {(notesFor(APP_VERSION)?.notes ?? []).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      </footer>
    </div>
  );
}

type BackupAsset = { mimeType: string; dataBase64: string };
type AssembledBackup = ApiResponse<typeof api, "exportLibrary">;

async function fetchPhotoAsset(url: string): Promise<BackupAsset | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim();
    return { mimeType: ct || "application/octet-stream", dataBase64: bytesToBase64(new Uint8Array(buf)) };
  } catch {
    return null;
  }
}

// Builds the COMPLETE backup payload: exportLibrary supplies the recipe
// text; each photo's bytes are fetched here in the browser (the server
// cannot read them back out of storage) and embedded as data — so the
// finished payload holds the recipes AND their photos and files. The same
// payload is downloaded as the backup file and stored as the automatic
// backup snapshot. A photo that cannot be fetched is counted and
// reported, never silently left out.
async function assembleBackup(recipes: Recipe[]): Promise<{ payload: AssembledBackup; photos: number; photosFailed: number }> {
  const data = await api.exportLibrary({});
  const byId = new Map(recipes.map((r) => [r.id, r]));
  let photos = 0;
  let photosFailed = 0;
  const out: AssembledBackup["recipes"] = [];
  for (const r of data.recipes) {
    const dto = byId.get(r.id);
    const grab = async (url: string | null | undefined): Promise<BackupAsset | null> => {
      if (!url) return null;
      const asset = await fetchPhotoAsset(url);
      if (asset) photos++;
      else photosFailed++;
      return asset;
    };
    const [dishPhoto, scanPhoto, sourcePhoto, attachment] = await Promise.all([
      grab(dto?.dishPhotoUrl),
      grab(dto?.scanPhotoUrl),
      grab(dto?.sourcePhotoUrl),
      grab(dto?.attachmentUrl),
    ]);
    out.push({ ...r, dishPhoto, scanPhoto, sourcePhoto, attachment });
  }
  return { payload: { ...data, recipes: out, photosUnreadable: photosFailed }, photos, photosFailed };
}

function BackupBar({ recipes, collections, profile }: { recipes: Recipe[]; collections: Collection[]; profile: MyProfile | null }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [serverCode, setServerCode] = useState(profile?.kcId ?? "");
  const [serverName, setServerName] = useState(profile?.username ?? "");
  const [serverKey, setServerKey] = useState("");
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: () => api.getProfile({}) });
  useEffect(() => {
    const k = profileQ.data?.recoveryKey;
    if (k) setServerKey((prev) => prev || k);
  }, [profileQ.data]);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ["backupStatus"], queryFn: () => api.getBackupStatus({}) });
  const status = statusQ.data ?? null;

  const doExport = async () => {
    setMsg(null);
    setBusy("Gathering your recipes and photos…");
    try {
      const { payload, photos, photosFailed } = await assembleBackup(recipes);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kitchen-companion-backup-${localDateStr(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      await api.markBackupDownloaded({ recipes: payload.recipes.length, photos }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["backupStatus"] });
      setMsg(
        photosFailed > 0
          ? `Backup saved — ${payload.recipes.length} recipes and ${photos} photos in one file. ⚠️ ${photosFailed} photo${photosFailed === 1 ? "" : "s"} could not be read, so ${photosFailed === 1 ? "it is" : "they are"} not in this backup — download it again in a moment, and if it keeps happening, tell Muse.`
          : `Backup saved — ${payload.recipes.length} recipe${payload.recipes.length === 1 ? "" : "s"} and ${photos} photo${photos === 1 ? "" : "s"}, all in one file. Keep it somewhere safe: it is a complete copy of your collection, photos included.`,
      );
    } catch {
      setMsg("The backup could not be made just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (parsed: unknown, fromAuto: boolean) => {
    const obj = parsed as { collections?: unknown; recipes?: unknown };
    const result = await api.importBackup({
      collections: Array.isArray(obj.collections) ? (obj.collections as Array<{ name: string }>) : [],
      recipes: Array.isArray(obj.recipes) ? (obj.recipes as never[]) : [],
    });
    queryClient.invalidateQueries({ queryKey: ["recipes"] });
    queryClient.invalidateQueries({ queryKey: ["collections"] });
    queryClient.invalidateQueries({ queryKey: ["backupStatus"] });
    setMsg(
      `Restored ${result.imported} recipe${result.imported === 1 ? "" : "s"} and ${result.photosRestored} photo${result.photosRestored === 1 ? "" : "s"}${fromAuto ? " from the automatic backup" : ""}${result.skipped > 0 ? ` (${result.skipped} already in your library, skipped)` : ""}.`,
    );
  };

  const doImport = async (file: File) => {
    setMsg(null);
    setBusy("Restoring…");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      await runImport(parsed, false);
    } catch {
      setMsg("That file could not be read as a Kitchen Companion backup.");
    } finally {
      setBusy(null);
    }
  };

  const doToggleServerCopy = async (enabled: boolean) => {
    setMsg(null);
    try {
      await api.setBackendBackup({ enabled });
      queryClient.invalidateQueries({ queryKey: ["backupStatus"] });
      setMsg(enabled
        ? "Server copy is ON — the next automatic backup will also save a copy on the shared Kitchen Companion server, under your code."
        : "Server copy is OFF — your backups stay in this app and in the files you download.");
    } catch {
      setMsg("That couldn't be changed just now. Try again in a moment.");
    }
  };

  const doRestoreServer = async () => {
    setMsg(null);
    setBusy("Fetching your server backup…");
    try {
      const result = await api.restoreBackendBackup({ kcId: serverCode, username: serverName, recoveryKey: serverKey });
      if (!result.ok) {
        setMsg(result.error ?? "The server backup could not be restored.");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["recipes"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      queryClient.invalidateQueries({ queryKey: ["backupStatus"] });
      setMsg(`Recovered ${result.imported} recipe${result.imported === 1 ? "" : "s"} and ${result.photosRestored} photo${result.photosRestored === 1 ? "" : "s"} from the server backup${result.skipped > 0 ? ` (${result.skipped} already in your library, skipped)` : ""}.`);
    } catch {
      setMsg("The server backup could not be restored just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const doRestoreAuto = async () => {
    setMsg(null);
    setBusy("Restoring from the automatic backup…");
    try {
      const latest = await api.getLatestAutoBackup({});
      if (!latest.found || !latest.url) {
        setMsg("No automatic backup has been saved yet — one is made when the app opens and your library has changed.");
        return;
      }
      const res = await fetch(latest.url);
      if (!res.ok) throw new Error("snapshot fetch failed");
      const parsed: unknown = await res.json();
      await runImport(parsed, true);
    } catch {
      setMsg("The automatic backup could not be restored just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="font-display text-base font-bold">{status && !status.lastAutoBackupAt && !status.lastBackupAt ? "🛟 Your backup" : "🛟 Your recipes are backed up"}</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Your recipes and the photos with them live in this app, in your own Muse account — they are
        never sent to GitHub or anywhere public. Kitchen Companion also keeps its own automatic backup
        copies inside the app, and you can download a complete backup file of your own at any time. If
        recipes were ever lost, either copy brings everything back — photos included. Right now:{" "}
        {recipes.length} recipe{recipes.length === 1 ? "" : "s"} in {collections.length} collection{collections.length === 1 ? "" : "s"}
        {status ? `, with ${status.photoCount} photo${status.photoCount === 1 ? "" : "s"} and files` : ""}.
      </p>

      {status && (
        <div className="mt-2 space-y-1 text-sm">
          {status.lastAutoBackupAt ? (
            <p style={{ color: "var(--herb)" }} role="status">
              ✓ Automatic backup: {fmtDateTime(status.lastAutoBackupAt)} — {status.autoBackupPhotos} photo{status.autoBackupPhotos === 1 ? "" : "s"} held
              {status.snapshotCount > 0 ? ` across ${status.snapshotCount} saved cop${status.snapshotCount === 1 ? "y" : "ies"}` : ""}.
              {status.autoPhotosMissing > 0 && (
                <span style={{ color: "var(--accent)" }}> {status.autoPhotosMissing} photo{status.autoPhotosMissing === 1 ? "" : "s"} could not be included last time.</span>
              )}
            </p>
          ) : (
            <p style={{ color: "var(--dim)" }} role="status">
              The first automatic backup is taken when the app opens with changes to save.
            </p>
          )}
          {status.changesSinceAutoBackup && status.lastAutoBackupAt && (
            <p style={{ color: "var(--dim)" }}>
              You’ve changed recipes since that snapshot — a fresh one is taken when the app opens.
            </p>
          )}
          {status.lastBackupAt ? (
            <p style={{ color: "var(--dim)" }}>
              Last backup you downloaded: {fmtDateTime(status.lastBackupAt)}.
              {status.changesSinceBackup ? " You’ve changed recipes since then — worth downloading a fresh one." : ""}
            </p>
          ) : (
            <p style={{ color: "var(--accent)" }}>
              You haven’t downloaded a backup of your own yet — the button below makes one file with everything in it, photos included.
            </p>
          )}
        </div>
      )}

      {status && !status.lastAutoBackupAt && !status.lastBackupAt && (
        <p className="mt-2 text-sm font-semibold" style={{ color: "var(--accent)" }} role="status">
          ⚠️ Nothing is backed up yet — right now your recipes live only in this app. The first
          automatic backup runs on its own when the app opens with changes to save, or download one
          right now with the button below.
        </p>
      )}

      {status && (
        <div className="mt-3 rounded-lg px-3 py-3" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
          <h3 className="text-sm font-bold">Extra copy on the shared server</h3>
          <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
            {status.backendBackupEnabled
              ? status.lastBackendBackupAt
                ? `On — a copy was saved to the shared Kitchen Companion server ${fmtDateTime(status.lastBackendBackupAt)}, under your code. It means your recipes survive even if this whole app copy is lost.`
                : "On — the next automatic backup will also save a copy to the shared Kitchen Companion server, under your code."
              : "Off — your backups live in this app and in the files you download. Turn this on and each automatic backup also saves a copy to the shared Kitchen Companion server (the one friends use), under your code — so your recipes survive even if this whole app copy is lost. It is Anthony's call for the household."}
          </p>
          <button
            type="button"
            onClick={() => void doToggleServerCopy(!status.backendBackupEnabled)}
            disabled={busy != null}
            className="mt-2 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {status.backendBackupEnabled ? "Turn the server copy off" : "Turn the server copy on"}
          </button>
          {!status.friendsOnline && (
            <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
              The server copy also needs the app to reach the shared Kitchen Companion server —
              it couldn’t just now, usually a brief connection hiccup. You can switch this on
              now, and it starts working the moment the connection lands; the app keeps trying
              on its own.
            </p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold">Recover from the server copy</summary>
            <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
              If this app copy was ever lost and rebuilt, it takes three things: your Kitchen
              Companion code, your username, and your private backup key (in Settings → Your
              profile). The code and username say whose backup it is; only the key can open it.
            </p>
            <div className="mt-2 grid gap-2">
              <label className="text-sm font-medium" htmlFor="server-code">Your Kitchen Companion code</label>
              <input
                id="server-code"
                value={serverCode}
                onChange={(e) => setServerCode(e.target.value)}
                placeholder="KC-XXXX-XXXX"
                className="rounded-lg px-3 py-2 text-sm uppercase outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
              <label className="text-sm font-medium" htmlFor="server-username">Your username</label>
              <input
                id="server-username"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder="Your username"
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
              <label className="text-sm font-medium" htmlFor="server-key">Your private backup key</label>
              <input
                id="server-key"
                value={serverKey}
                onChange={(e) => setServerKey(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                className="rounded-lg px-3 py-2 text-sm uppercase outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
              <button
                type="button"
                onClick={() => void doRestoreServer()}
                disabled={busy != null || !serverCode.trim() || !serverName.trim() || serverKey.trim().length < 8}
                className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                Recover my recipes
              </button>
            </div>
          </details>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={doExport} disabled={busy != null || recipes.length === 0} className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
          Download backup
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy != null} className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}>
          Restore from backup
        </button>
        {status && status.snapshotCount > 0 && (
          <button type="button" onClick={doRestoreAuto} disabled={busy != null} className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}>
            Restore automatic backup
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Choose a backup file to restore"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = "";
          }}
        />
      </div>
      {busy && <p className="mt-2 text-sm" style={{ color: "var(--dim)" }} role="status">{busy}</p>}
      {msg && <p className="mt-2 text-sm" style={{ color: "var(--herb)" }} role="status">{msg}</p>}
    </div>
  );
}

// ---------- profile, welcome, tutorial, friends ----------

/** A small, square-ish profile photo: upright (EXIF applied) and ≤256px. */
async function profilePhotoFromFile(file: File): Promise<LoadedPhoto> {
  const full = await photoToBase64(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = full.previewUrl;
    });
    const max = 256;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = canvas.getContext("2d");
    if (!c) return full;
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { dataBase64: dataUrl.split(",")[1] ?? full.dataBase64, mimeType: "image/jpeg", previewUrl: dataUrl };
  } catch {
    return full;
  }
}

function Avatar({ name, photoData, photoUrl, size = 44 }: { name: string; photoData?: string | null; photoUrl?: string | null; size?: number }) {
  const src = photoData ?? photoUrl;
  if (src) {
    return <img src={src} alt="" className="rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full font-bold" style={{ width: size, height: size, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", fontSize: Math.round(size * 0.42) }}>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

// One recipe in the share/backup import shape, photos fetched and embedded.
async function recipeToShareShape(r: Recipe) {
  const [dishPhoto, scanPhoto, sourcePhoto, attachment] = await Promise.all([
    r.dishPhotoUrl ? fetchPhotoAsset(r.dishPhotoUrl) : Promise.resolve(null),
    r.scanPhotoUrl ? fetchPhotoAsset(r.scanPhotoUrl) : Promise.resolve(null),
    r.sourcePhotoUrl ? fetchPhotoAsset(r.sourcePhotoUrl) : Promise.resolve(null),
    r.attachmentUrl ? fetchPhotoAsset(r.attachmentUrl) : Promise.resolve(null),
  ]);
  return {
    title: r.title,
    description: r.description,
    servings: r.servings,
    prepMinutes: r.prepMinutes,
    cookMinutes: r.cookMinutes,
    ingredients: r.ingredients,
    steps: r.steps,
    tags: r.tags,
    course: r.course,
    protein: r.protein,
    sourceUrl: r.sourceUrl,
    sourceName: r.sourceName,
    collectionName: null as string | null,
    favorite: r.favorite,
    rating: r.rating,
    status: r.status,
    cookCount: r.cookCount,
    lastCookedAt: r.lastCookedAt,
    notes: r.notes,
    attachmentName: r.attachmentName,
    dishPhoto,
    scanPhoto,
    sourcePhoto,
    attachment,
  };
}

async function buildSharePayload(list: Recipe[], collectionName: string | null) {
  const recipes = [];
  for (const r of list) {
    recipes.push({ ...(await recipeToShareShape(r)), collectionName });
  }
  return { collections: collectionName ? [{ name: collectionName }] : [], recipes };
}

// The quick tour: five stops, one idea each, big plain words. Shown once,
// forced, at the end of first setup; re-openable from Settings.
const TUTORIAL_STOPS: Array<{ icon: string; title: string; body: string }> = [
  {
    icon: "➕",
    title: "Add a recipe",
    body: "Paste a link, take a photo of a cookbook page, upload a file, or just type it in. Every recipe lands on one check-and-fix screen first — nothing is saved until you say so.",
  },
  {
    icon: "🍳",
    title: "Your recipe pages",
    body: "Change the servings and the amounts change themselves. Tick off ingredients and steps as you cook, and Cook Mode keeps your screen awake, timers and all.",
  },
  {
    icon: "🗓️",
    title: "Plan the week, shop in one go",
    body: "Put meals on the week planner and the shopping list builds itself. Send it to Jewel-Osco with one tap — you sign in and pay on Jewel's own site, just like always.",
  },
  {
    icon: "👥",
    title: "Friends & sharing",
    body: "Add friends with their Kitchen Companion code. Share a recipe — or a whole collection — with the people on your list. Only what you choose to share is ever seen. The rest of your library stays private.",
  },
  {
    icon: "🛟",
    title: "Backed up, automatically",
    body: "Your recipes and their photos are backed up on their own — you never have to think about it. They live in your own Muse account, never anywhere public.",
  },
];

function Tutorial({ finishLabel, onFinish }: { finishLabel: string; onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const stop = TUTORIAL_STOPS[step] ?? TUTORIAL_STOPS[0];
  const last = step === TUTORIAL_STOPS.length - 1;
  if (!stop) return null;
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6 py-8">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div className="text-6xl" aria-hidden>{stop.icon}</div>
        <h2 className="font-display mt-5 text-2xl font-bold">{stop.title}</h2>
        <p className="mt-3 max-w-md text-base leading-relaxed" style={{ color: "var(--dim)" }}>{stop.body}</p>
      </div>
      <div className="flex items-center justify-center gap-2" aria-hidden>
        {TUTORIAL_STOPS.map((s, i) => (
          <span key={s.title} className="h-2 w-2 rounded-full" style={{ background: i === step ? "var(--accent)" : "var(--border)" }} />
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        {step > 0 && (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="rounded-full px-5 py-3 text-base font-semibold"
            style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            ← Back
          </button>
        )}
        <button
          type="button"
          onClick={() => (last ? onFinish() : setStep(step + 1))}
          className="flex-1 rounded-full py-3 text-base font-bold"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          {last ? finishLabel : "Next →"}
        </button>
      </div>
    </div>
  );
}

// First-run, once ever, no skipping: hello → username → your code → tour.
// Existing recipes are never touched — the profile simply goes on top.
function WelcomeFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"hello" | "create" | "code" | "tour">("hello");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<MyProfile | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [friendsOnline, setFriendsOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  if (step === "tour") {
    return <Tutorial finishLabel="Enter Kitchen Companion 🎉" onFinish={onDone} />;
  }

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.createProfile({
        username,
        displayName,
        photo: photo ? { dataBase64: photo.dataBase64, mimeType: photo.mimeType } : null,
      });
      if (!res.ok || !res.profile) {
        setError(res.error ?? "That couldn't be saved — try again.");
        return;
      }
      setCreated(res.profile);
      setRecoveryKey(res.recoveryKey);
      setFriendsOnline(res.friendsOnline);
      setStep("code");
    } catch {
      setError("That couldn't be saved — try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6 py-8">
      {step === "hello" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="text-7xl" aria-hidden>🍳</div>
            <h1 className="font-display mt-5 text-3xl font-bold">Welcome to Kitchen Companion</h1>
            <p className="mt-3 max-w-md text-base leading-relaxed" style={{ color: "var(--dim)" }}>
              Your recipes, all in one place — the ones you find, the ones you scan from a cookbook,
              the ones passed down. Let’s set you up. It takes a minute, and you only do it once.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setStep("create")}
            className="w-full rounded-full py-3 text-base font-bold"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Let’s get you set up →
          </button>
        </>
      )}

      {step === "create" && (
        <>
          <div className="flex-1">
            <h1 className="font-display text-3xl font-bold">First, your name in the kitchen</h1>
            <p className="mt-2 text-base leading-relaxed" style={{ color: "var(--dim)" }}>
              Pick a username — it’s how friends find you. Already have recipes in here? They stay
              exactly as they are. This just puts your name on them.
            </p>

            <label className="mt-6 block text-sm font-bold" htmlFor="welcome-username">Username</label>
            <input
              id="welcome-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. LizCooks"
              autoCapitalize="off"
              autoCorrect="off"
              className="mt-1 w-full rounded-lg px-3 py-3 text-base outline-none"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
            <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>3 to 20 characters — letters, numbers, and underscores only.</p>

            <label className="mt-4 block text-sm font-bold" htmlFor="welcome-display-name">Your name, as friends will see it</label>
            <input
              id="welcome-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Liz"
              className="mt-1 w-full rounded-lg px-3 py-3 text-base outline-none"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
            />

            <div className="mt-4 flex items-center gap-3">
              <Avatar name={displayName || username || "?"} photoUrl={photo?.previewUrl ?? null} size={52} />
              <button
                type="button"
                onClick={() => photoRef.current?.click()}
                className="rounded-full px-4 py-2 text-sm font-semibold"
                style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                {photo ? "Change the photo" : "Add a photo (if you like)"}
              </button>
              <input
                ref={photoRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Choose a profile photo"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    setPhoto(await profilePhotoFromFile(f));
                  } catch {
                    setError("That photo couldn't be used — you can add one later in Settings.");
                  }
                }}
              />
            </div>

            {error && (
              <p className="mt-4 rounded-[var(--radius)] px-4 py-3 text-sm font-medium" style={{ background: "var(--surface)", border: "1px solid var(--accent)", color: "var(--text)" }} role="alert">
                {error}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !username.trim()}
            className="mt-6 w-full rounded-full py-3 text-base font-bold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy ? "Creating…" : "Create my profile"}
          </button>
        </>
      )}

      {step === "code" && created && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="text-6xl" aria-hidden>🎉</div>
            <h1 className="font-display mt-5 text-3xl font-bold">You’re in, {created.displayName || created.username}!</h1>
            <p className="mt-3 max-w-md text-base leading-relaxed" style={{ color: "var(--dim)" }}>
              This is your Kitchen Companion code. Give it to friends so they can add you — and it
              marks your backup as yours. It’s always waiting for you in Settings, too.
            </p>
            <div className="mt-5 rounded-[var(--radius)] px-6 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <p className="font-display text-3xl font-bold tracking-wide">{created.kcId}</p>
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>@{created.username}</p>
            </div>
            <button
              type="button"
              onClick={async () => setCopied(await copyText(created.kcId))}
              className="mt-4 rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              {copied ? "✓ Code copied" : "📋 Copy my code"}
            </button>
            {recoveryKey && (
              <div className="mt-5 max-w-md rounded-[var(--radius)] px-4 py-3 text-left" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <p className="text-sm font-bold">🔑 And this one is just for you — your backup key</p>
                <p className="font-display mt-1 text-xl font-bold tracking-wide">{recoveryKey}</p>
                <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                  Different from your code: the code is for friends, this key is private. It’s the
                  only thing that can open your server backup. It lives in Settings → Your profile
                  whenever you need it — no need to memorize it now.
                </p>
                <button
                  type="button"
                  onClick={async () => setKeyCopied(await copyText(recoveryKey))}
                  className="mt-2 rounded-full px-4 py-2 text-sm font-semibold"
                  style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
                >
                  {keyCopied ? "✓ Key copied" : "📋 Copy my backup key"}
                </button>
              </div>
            )}
            {!friendsOnline && (
              <p className="mt-4 max-w-md text-sm" style={{ color: "var(--dim)" }}>
                One honest note: your app couldn’t reach the shared Kitchen Companion server just
                now — usually a brief connection hiccup, and nothing you need to fix. It keeps
                trying on its own until your name is registered. Your code already works — hand
                it out now, and friends will light up on their own the moment it lands.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setStep("tour")}
            className="w-full rounded-full py-3 text-base font-bold"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Now, a quick tour →
          </button>
        </>
      )}
    </div>
  );
}

function FriendsView({
  profile, recipes, collections, onOpenRecipe,
}: {
  profile: MyProfile | null;
  recipes: Recipe[];
  collections: Collection[];
  onOpenRecipe: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const friendsQ = useQuery({ queryKey: ["friends"], queryFn: () => api.getFriends({}) });
  const data: FriendsInfo | null = friendsQ.data ?? null;
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Record<string, number | null>>({});
  const [shareCollectionId, setShareCollectionId] = useState<number | null>(null);

  const online = data?.friendsOnline ?? false;

  const doAdd = async () => {
    setMsg(null);
    setBusy("Adding…");
    try {
      const res = await api.addFriend({ code });
      if (!res.ok) {
        setMsg(res.error ?? "That friend couldn't be added.");
        return;
      }
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setMsg(`${res.friend?.displayName || res.friend?.username || "Your friend"} is on your list now. Anything they share with their friends will show up below.`);
    } catch {
      setMsg("That friend couldn't be added just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const doRemove = async (kcId: string) => {
    setBusy("Removing…");
    try {
      await api.removeFriend({ kcId });
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setMsg("Removed from your list.");
    } catch {
      setMsg("That couldn't be done just now. Try again in a moment.");
    } finally {
      setBusy(null);
      setRemovingId(null);
    }
  };

  const doSaveShared = async (shareKey: string) => {
    setMsg(null);
    setBusy("Saving…");
    try {
      const res = await api.saveSharedRecipe({ shareKey });
      if (!res.ok) {
        setMsg(res.error ?? "That couldn't be saved.");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["recipes"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setSavedIds((prev) => ({ ...prev, [shareKey]: res.recipeId }));
      setMsg(res.imported > 0
        ? `Saved to your recipes — ${res.imported} recipe${res.imported === 1 ? "" : "s"} and ${res.photosRestored} photo${res.photosRestored === 1 ? "" : "s"}.`
        : "You already have that one in your library.");
    } catch {
      setMsg("That couldn't be saved just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const doShareCollection = async () => {
    const coll = collections.find((c) => c.id === shareCollectionId);
    if (!coll) return;
    const inColl = recipes.filter((r) => r.collectionId === coll.id);
    if (inColl.length === 0) {
      setMsg("That collection has no recipes in it yet.");
      return;
    }
    setMsg(null);
    setBusy("Sharing…");
    try {
      const payload = await buildSharePayload(inColl, coll.name);
      const res = await api.createShare({ kind: "collection", title: coll.name, payloadJson: JSON.stringify(payload) });
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setMsg(res.synced
        ? `“${coll.name}” is shared with your friends — all ${inColl.length} recipes, photos included.`
        : `“${coll.name}” is marked to share. It will be sent to your friends the moment friends are switched on.`);
    } catch {
      setMsg("That couldn't be shared just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const doUnshare = async (shareKey: string) => {
    setBusy("Stopping…");
    try {
      await api.unshare({ shareKey });
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setMsg("Stopped sharing that. (Anyone who already saved a copy keeps theirs.)");
    } catch {
      setMsg("That couldn't be done just now. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">Friends</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Cook together, apart. Share recipes with the people on your list — only what you choose, nothing else.
      </p>

      {profile && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Your profile">
          <div className="flex items-center gap-3">
            <Avatar name={profile.displayName || profile.username} photoData={profile.photoData} photoUrl={profile.photoUrl} size={56} />
            <div className="min-w-0">
              <p className="truncate text-lg font-bold">{profile.displayName || profile.username}</p>
              <p className="text-sm" style={{ color: "var(--dim)" }}>@{profile.username}</p>
              <p className="font-display text-base font-bold tracking-wide">{profile.kcId}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={async () => setCopied(await copyText(profile.kcId))}
            className="mt-3 rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {copied ? "✓ Code copied" : "📋 Copy my code — give it to friends"}
          </button>
        </section>
      )}

      {friendsQ.isPending && <p className="mt-4 text-sm" role="status" style={{ color: "var(--dim)" }}>Loading your friends…</p>}

      {data && !online && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Friends coming on">
          <h2 className="font-display text-xl font-bold">Friends couldn’t check in just now</h2>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            Your app couldn’t reach the shared Kitchen Companion server on its last try — usually
            that’s a brief connection hiccup, and there’s nothing for you to fix. The app keeps
            trying on its own: every time it opens, and once a minute while it stays open, until
            your name is registered and this page wakes up — adding friends by code, seeing their
            shares, all of it. Your code already works — hand it out now — and anything you mark
            to share in the meantime is kept safe and sent then.
          </p>
        </section>
      )}

      {data && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Add a friend">
          <h2 className="font-display text-xl font-bold">Add a friend</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
            Type the Kitchen Companion code they gave you. Then you’ll see what they share with their friends.
          </p>
          <div className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor="friend-code">Friend’s Kitchen Companion code</label>
            <input
              id="friend-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="KC-XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-base uppercase outline-none"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
            <button
              type="button"
              onClick={() => void doAdd()}
              disabled={busy != null || !code.trim()}
              className="rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              Add friend
            </button>
          </div>

          {data.friends.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {data.friends.map((f) => (
                <li key={f.kcId} className="flex items-center gap-3 rounded-lg px-3 py-2" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                  <Avatar name={f.displayName || f.username} photoData={f.photoData} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{f.displayName || f.username}</p>
                    <p className="text-xs" style={{ color: "var(--dim)" }}>@{f.username} · {f.kcId}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => (removingId === f.kcId ? void doRemove(f.kcId) : setRemovingId(f.kcId))}
                    disabled={busy != null}
                    className="rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ background: "var(--surface)", color: removingId === f.kcId ? "var(--accent)" : "var(--text)", border: "1px solid var(--border)" }}
                  >
                    {removingId === f.kcId ? "Tap again to remove" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>
              {online ? "No friends yet — add your first with their code above." : "Your friends will appear here once friends are switched on."}
            </p>
          )}
        </section>
      )}

      {data && data.sharedWithMe.length > 0 && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Shared with you">
          <h2 className="font-display text-xl font-bold">Shared with you</h2>
          <ul className="mt-3 space-y-2">
            {data.sharedWithMe.map((s) => {
              const savedId = savedIds[s.shareKey];
              const isSaved = s.shareKey in savedIds;
              return (
                <li key={s.shareKey} className="rounded-lg px-3 py-3" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                  <p className="text-sm font-bold">{s.kind === "collection" ? "📚 " : "🍽️ "}{s.title}</p>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>
                    From {s.ownerName} · {s.kind === "collection" ? "a whole collection" : "a recipe"}
                  </p>
                  {isSaved ? (
                    <button
                      type="button"
                      disabled={savedId == null}
                      onClick={() => savedId != null && onOpenRecipe(savedId)}
                      className="mt-2 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-60"
                      style={{ background: "var(--surface)", color: "var(--herb)", border: "1px solid var(--border)" }}
                    >
                      {savedId != null ? "✓ Saved — open it" : "✓ Already in your library"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void doSaveShared(s.shareKey)}
                      disabled={busy != null}
                      className="mt-2 rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50"
                      style={{ background: "var(--herb)", color: "#10240c" }}
                    >
                      Save to my recipes
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="What you have shared">
          <h2 className="font-display text-xl font-bold">What you’re sharing</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
            Share any single recipe from its own page (the “Share with friends” button). Share a whole
            collection here. Nothing else in your library is ever visible to friends.
          </p>
          {collections.length > 0 && (
            <div className="mt-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a collection to share">
                {collections.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setShareCollectionId(c.id === shareCollectionId ? null : c.id)}
                    aria-pressed={c.id === shareCollectionId}
                    className="rounded-full px-3 py-1.5 text-sm font-semibold"
                    style={{
                      background: c.id === shareCollectionId ? "var(--accent)" : "var(--surface2)",
                      color: c.id === shareCollectionId ? "var(--accent-ink)" : "var(--text)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void doShareCollection()}
                disabled={busy != null || shareCollectionId == null}
                className="mt-2 rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50"
                style={{ background: "var(--herb)", color: "#10240c" }}
              >
                Share this collection
              </button>
            </div>
          )}
          {data.myShares.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {data.myShares.map((s) => (
                <li key={s.shareKey} className="flex items-center gap-3 rounded-lg px-3 py-2" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{s.kind === "collection" ? "📚 " : "🍽️ "}{s.title}</p>
                    <p className="text-xs" style={{ color: "var(--dim)" }}>{s.synced ? "Shared with your friends" : "Will be sent when friends are switched on"}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void doUnshare(s.shareKey)}
                    disabled={busy != null}
                    className="rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                  >
                    Stop sharing
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>You’re not sharing anything yet.</p>
          )}
        </section>
      )}

      {busy && <p className="mt-3 text-sm" role="status" style={{ color: "var(--dim)" }}>{busy}</p>}
      {msg && <p className="mt-3 text-sm" role="status" style={{ color: "var(--herb)" }}>{msg}</p>}
    </div>
  );
}

// ---------- Jewel-Osco handoff (shared by the recipe page and Shop tab) ----------
// Jewel-Osco gives no app a way into its checkout, so this panel is the
// whole handoff, in plain steps: copy the list, open Jewel-Osco, sign in
// there, add each item, and pay there. If copying is unavailable in this
// browser, the list is shown on screen to copy by hand — never a dead end.

function JewelHandoff({
  order, jewelUrl, onOrdered, ordering, extra,
}: {
  order: JewelOrder;
  jewelUrl: string;
  onOrdered?: () => void;
  ordering?: boolean;
  extra?: React.ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const doCopy = async () => {
    const ok = await copyText(order.cartText);
    setCopyState(ok ? "copied" : "failed");
  };
  return (
    <div>
      <ol className="list-decimal space-y-1 pl-5 text-sm" style={{ color: "var(--dim)" }}>
        <li>
          <strong style={{ color: "var(--text)" }}>Copy your list</strong> (button below) — {order.itemCount} item{order.itemCount === 1 ? "" : "s"}.
        </li>
        <li>
          <strong style={{ color: "var(--text)" }}>Open Jewel-Osco and sign in there.</strong> Your Jewel password never goes into this app.
        </li>
        <li>
          <strong style={{ color: "var(--text)" }}>Add each item and check out on Jewel-Osco.</strong> Jewel doesn’t let any app fill your cart for you, so the copied list is what carries over — search each item there and add it, then pay as usual.
        </li>
      </ol>
      <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg px-3 py-2 text-sm" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
        {order.items.map((i, idx) => (
          <li key={idx}>{i.detail && <span className="font-semibold">{i.detail} </span>}{i.name}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={doCopy}
          className="rounded-full px-4 py-2 text-sm font-bold"
          style={{ background: "var(--herb)", color: "#10240c" }}
        >
          {copyState === "copied" ? "✓ List copied" : "📋 Copy the list"}
        </button>
        <a
          href={jewelUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-full px-4 py-2 text-sm font-bold"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Open Jewel-Osco ↗
        </a>
        {onOrdered && (
          <button
            type="button"
            disabled={ordering}
            onClick={onOrdered}
            className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--surface)", border: "1px solid var(--herb)", color: "var(--herb)" }}
          >
            ✓ I ordered this at Jewel-Osco
          </button>
        )}
        {extra}
      </div>
      {copyState === "copied" && (
        <p className="mt-2 text-sm" style={{ color: "var(--herb)" }} role="status">
          Copied — it’s on your clipboard. On Jewel-Osco’s site, search each item and add it to your cart.
        </p>
      )}
      {copyState === "failed" && (
        <div className="mt-2" role="status">
          <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>
            Copying isn’t available in this browser — no problem, here’s the list to copy by hand:
          </p>
          <label htmlFor={`cart-text-${order.id}`} className="sr-only">Your Jewel-Osco list as text</label>
          <textarea
            id={`cart-text-${order.id}`}
            readOnly
            value={order.cartText}
            rows={Math.min(10, order.itemCount + 3)}
            onFocus={(e) => e.target.select()}
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>Tap the box, select all, and copy — then paste it wherever you keep lists, or read it off the screen at Jewel-Osco.</p>
        </div>
      )}
    </div>
  );
}

// ---------- recipe detail + cook mode ----------

function RecipeDetail({
  recipeId, recipes, collections, onBack, onEdit, onGoShop,
}: {
  recipeId: number;
  recipes: Recipe[];
  collections: Collection[];
  onBack: () => void;
  onEdit: (r: Recipe) => void;
  onGoShop: () => void;
}) {
  const recipe = recipes.find((r) => r.id === recipeId) ?? null;
  const queryClient = useQueryClient();
  const [targetServings, setTargetServings] = useState<number | null>(null);
  const [checkedIng, setCheckedIng] = useState<Set<number>>(new Set());
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set());
  const [cooking, setCooking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [planDate, setPlanDate] = useState(localDateStr(new Date()));
  const [planMeal, setPlanMeal] = useState<"breakfast" | "lunch" | "dinner" | "other">("dinner");
  const [catEditing, setCatEditing] = useState(false);
  const [catCourse, setCatCourse] = useState<string | null>(null);
  const [catProtein, setCatProtein] = useState<string | null>(null);
  const timers = useTimers();
  const dishInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["recipes"] });
  };
  const favMut = useMutation({ mutationFn: api.setFavorite, onSuccess: invalidate });
  const ratingMut = useMutation({ mutationFn: api.setRating, onSuccess: invalidate });
  const cookedMut = useMutation({
    mutationFn: api.markCooked,
    onSuccess: (res) => {
      invalidate();
      setNotice(`Marked as cooked on ${prettyDate(res.lastCookedAt)}. Nice work!`);
    },
  });
  const deleteMut = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });
  const groceryMut = useMutation({
    mutationFn: api.addRecipesToGrocery,
    onSuccess: (res) => setNotice(res.added > 0 ? `Added ${res.added} item${res.added === 1 ? "" : "s"} to your shopping list.` : "Those ingredients are already on your shopping list."),
  });
  const [jewelOrder, setJewelOrder] = useState<JewelOrder | null>(null);
  const [jewelError, setJewelError] = useState<string | null>(null);
  const jewelMut = useMutation({
    mutationFn: api.buildJewelCart,
    onSuccess: (res) => {
      if (res.ok && res.order) {
        setJewelOrder(res.order);
        setJewelError(null);
        queryClient.invalidateQueries({ queryKey: ["shop"] });
      } else {
        setJewelError(res.error ?? "That list could not be built.");
      }
    },
    onError: () => setJewelError("The Jewel-Osco list could not be built just now. Check your connection and tap the button again — nothing was lost."),
  });
  const catMut = useMutation({
    mutationFn: api.setCategories,
    onSuccess: invalidate,
  });
  const planMut = useMutation({
    mutationFn: api.addPlanEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      setNotice(`Planned for ${prettyDate(planDate)} (${planMeal}).`);
    },
  });
  const updateMut = useMutation({ mutationFn: api.updateRecipe, onSuccess: invalidate });
  const shareFriendsMut = useMutation({
    mutationFn: async () => {
      if (!recipe) throw new Error("no recipe");
      const payload = await buildSharePayload([recipe], null);
      return api.createShare({ kind: "recipe", title: recipe.title, payloadJson: JSON.stringify(payload) });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setNotice(res.synced
        ? "Shared with your friends 👥 — they’ll see it under “Shared with you” on their Friends tab."
        : "Marked to share with your friends 👥 — it will be sent the moment friends are switched on. You can see it on the Friends tab.");
    },
    onError: () => setNotice("That couldn't be shared just now. Try again in a moment."),
  });

  useEffect(() => {
    setTargetServings(recipe?.servings ?? null);
    setCheckedIng(new Set());
    setCheckedSteps(new Set());
    setCatCourse(recipe?.course ?? null);
    setCatProtein(recipe?.protein ?? null);
    setCatEditing(false);
    // reset per recipe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId]);

  if (!recipe) {
    return (
      <div>
        <button type="button" onClick={onBack} className="text-sm font-semibold" style={{ color: "var(--accent)" }}>← Back to recipes</button>
        <p className="mt-8 text-center" style={{ color: "var(--dim)" }}>That recipe could not be found.</p>
      </div>
    );
  }

  const shownServings = targetServings ?? recipe.servings ?? 1;
  const factor = recipe.servings ? shownServings / recipe.servings : 1;
  const heroPhoto = recipe.dishPhotoUrl ?? recipe.sourcePhotoUrl;
  const collection = recipe.collectionId != null ? collections.find((c) => c.id === recipe.collectionId) : null;
  const total = totalMinutes(recipe);

  const onDishPhoto = async (file: File) => {
    try {
      const { dataBase64, mimeType } = await photoToBase64(file);
      const stored = await api.storePhoto({ dataBase64, mimeType, kind: "dish" });
      updateMut.mutate({
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        servings: recipe.servings,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        tags: recipe.tags,
        course: recipe.course,
        protein: recipe.protein,
        sourceUrl: recipe.sourceUrl,
        sourceName: recipe.sourceName,
        collectionId: recipe.collectionId,
        notes: recipe.notes,
        dishPhotoKey: stored.key,
        scanPhotoKey: recipe.scanPhotoKey,
        sourcePhotoKey: recipe.sourcePhotoKey,
        attachmentName: recipe.attachmentName,
        attachmentKey: recipe.attachmentKey,
      });
      setNotice("Your photo of the finished dish is on the page.");
    } catch {
      setNotice("That photo could not be added. Try a different one.");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-sm font-semibold" style={{ color: "var(--accent)" }}>← Back to recipes</button>
        <button
          type="button"
          onClick={() => favMut.mutate({ id: recipe.id, favorite: !recipe.favorite })}
          aria-label={recipe.favorite ? "Remove from favourites" : "Add to favourites"}
          className="text-2xl"
          style={{ color: recipe.favorite ? "var(--accent)" : "var(--dim)" }}
        >
          {recipe.favorite ? "♥" : "♡"}
        </button>
      </div>

      <RecipePhoto
        src={heroPhoto}
        alt={recipe.dishPhotoUrl ? `Your photo of ${recipe.title}, cooked` : recipe.title}
        imgClassName="mt-3 aspect-[16/10] w-full rounded-[var(--radius)] object-cover"
        placeholderClassName="mt-3 flex aspect-[16/10] w-full flex-col items-center justify-center rounded-[var(--radius)]"
        placeholderText="No photo yet — add yours when you cook it."
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--dim)" }}>
          {recipe.dishPhotoUrl ? "Your photo of the finished dish" : recipe.sourcePhotoUrl ? "Photo from the original recipe" : ""}
        </p>
        <button type="button" onClick={() => dishInputRef.current?.click()} className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
          {recipe.dishPhotoUrl ? "Replace dish photo" : "📷 Add your finished-dish photo"}
        </button>
        <input
          ref={dishInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="Add a photo of the finished dish"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onDishPhoto(f);
            e.target.value = "";
          }}
        />
      </div>

      <h1 className="font-display mt-3 text-3xl font-bold leading-tight">{recipe.title}</h1>
      {recipe.description && <p className="mt-2 text-base" style={{ color: "var(--dim)" }}>{recipe.description}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" style={{ color: "var(--dim)" }}>
        {recipe.prepMinutes != null && <span>Prep {recipe.prepMinutes} min</span>}
        {recipe.cookMinutes != null && <span>Cook {recipe.cookMinutes} min</span>}
        {total != null && <span className="font-semibold" style={{ color: "var(--text)" }}>{total} min total</span>}
        {collection && <span>📁 {collection.name}</span>}
        {recipe.status === "made" ? (
          <span>Cooked {recipe.cookCount}×{recipe.lastCookedAt ? ` · last on ${prettyDate(recipe.lastCookedAt)}` : ""}</span>
        ) : (
          <span style={{ color: "var(--accent)" }}>Not tried yet</span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <Stars value={recipe.rating} onSet={(n) => ratingMut.mutate({ id: recipe.id, rating: n })} size="text-2xl" />
        <span className="text-sm" style={{ color: "var(--dim)" }}>{recipe.rating ? "Your rating" : "Tap to rate it"}</span>
      </div>

      {recipe.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {recipe.tags.map((t) => (
            <span key={t} className="rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: "var(--surface2)", color: "var(--dim)", border: "1px solid var(--border)" }}>
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 rounded-[var(--radius)] px-3 py-2.5" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold" style={{ color: "var(--dim)" }}>Categories:</span>
          {[recipe.course, recipe.protein, recipe.timeTag].filter(Boolean).map((c) => (
            <span key={c as string} className="rounded-full px-2.5 py-1 font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--herb)", color: "var(--text)" }}>
              {c}
            </span>
          ))}
          {!catEditing && (
            <button type="button" onClick={() => setCatEditing(true)} className="ml-1 font-semibold underline" style={{ color: "var(--accent)" }}>
              Fix a category
            </button>
          )}
        </div>
        {catEditing && (
          <div className="mt-2 space-y-2">
            <div>
              <span className="text-xs font-semibold" id="cat-course-label" style={{ color: "var(--dim)" }}>Course</span>
              <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-labelledby="cat-course-label">
                {COURSES.map((c) => (
                  <Chip key={c} active={catCourse === c} onClick={() => setCatCourse(c)}>{c}</Chip>
                ))}
              </div>
            </div>
            <div>
              <span className="text-xs font-semibold" id="cat-protein-label" style={{ color: "var(--dim)" }}>Protein / type</span>
              <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-labelledby="cat-protein-label">
                {PROTEINS.map((p) => (
                  <Chip key={p} active={catProtein === p} onClick={() => setCatProtein(p)}>{p}</Chip>
                ))}
              </div>
            </div>
            <p className="text-xs" style={{ color: "var(--dim)" }}>
              Time ({recipe.timeTag ?? "not set"}) follows the recipe’s prep + cook minutes — change those in Edit recipe and the time category follows.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={catMut.isPending}
                onClick={() => catMut.mutate({ id: recipe.id, course: catCourse, protein: catProtein }, { onSuccess: () => setCatEditing(false) })}
                className="rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--herb)", color: "#10240c" }}
              >
                Save categories
              </button>
              <button type="button" onClick={() => setCatEditing(false)} className="rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {recipe.sourceUrl && (
        <p className="mt-3 text-sm">
          <a href={recipe.sourceUrl} target="_blank" rel="noreferrer" className="font-semibold underline" style={{ color: "var(--accent)" }}>
            View the original{recipe.sourceName ? ` on ${recipe.sourceName}` : ""}
          </a>
        </p>
      )}

      {recipe.tags.includes("example") && (
        <p className="mt-3 rounded-[var(--radius)] px-3 py-2 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--herb)", color: "var(--dim)" }}>
          ⭐ This is one of the example recipes that came in the box — imported from {recipe.sourceName ?? "the web"} so you can see how a full recipe looks here. Make it your own, or delete it any time.
        </p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setCooking(true)}
          className="rounded-full py-3 text-base font-bold"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          🔥 Start cooking
        </button>
        <button
          type="button"
          onClick={() => cookedMut.mutate({ id: recipe.id })}
          className="rounded-full py-3 text-base font-semibold"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          ✓ I cooked this
        </button>
        <button
          type="button"
          onClick={() => groceryMut.mutate({ items: [{ recipeId: recipe.id, factor }] })}
          className="rounded-full py-2.5 text-sm font-semibold"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          🛒 Add to shopping list
        </button>
        <button
          type="button"
          onClick={async () => {
            const res = await shareOut(recipe.title, recipeShareText(recipe));
            setNotice(res === "shared" ? "Shared!" : res === "copied" ? "Recipe copied — paste it anywhere to share it." : "Sharing is not available here right now.");
          }}
          className="rounded-full py-2.5 text-sm font-semibold"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          ↗ Share this recipe
        </button>
        <button
          type="button"
          disabled={jewelMut.isPending}
          onClick={() => jewelMut.mutate({ recipeId: recipe.id, servings: shownServings })}
          className="col-span-2 rounded-full py-3 text-base font-bold disabled:opacity-50"
          style={{ background: "var(--herb)", color: "#10240c" }}
        >
          {jewelMut.isPending ? "Building your Jewel-Osco list…" : "🛒 Shop this recipe at Jewel-Osco"}
        </button>
        <button
          type="button"
          disabled={shareFriendsMut.isPending}
          onClick={() => shareFriendsMut.mutate()}
          className="col-span-2 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          {shareFriendsMut.isPending ? "Sharing…" : "👥 Share with friends"}
        </button>
      </div>

      {jewelError && !jewelOrder && (
        <p className="mt-3 rounded-[var(--radius)] px-4 py-3 text-sm font-medium" style={{ background: "var(--surface)", border: "1px solid var(--accent)" }} role="alert">
          {jewelError}
        </p>
      )}

      {jewelOrder && (
        <div className="mt-3 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--herb)" }} role="status">
          <p className="text-sm font-semibold">Your {jewelOrder.storeName} list is ready — {jewelOrder.itemCount} item{jewelOrder.itemCount === 1 ? "" : "s"} for {shownServings} serving{shownServings === 1 ? "" : "s"}.</p>
          <div className="mt-2">
            <JewelHandoff
              order={jewelOrder}
              jewelUrl={JEWEL_URL}
              extra={(
                <button type="button" onClick={onGoShop} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                  See it on the Shop tab →
                </button>
              )}
            />
          </div>
        </div>
      )}

      <div className="mt-3 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <p className="text-sm font-semibold">Plan it</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="plan-date" className="text-xs" style={{ color: "var(--dim)" }}>Day</label>
            <input
              id="plan-date"
              type="date"
              value={planDate}
              onChange={(e) => setPlanDate(e.target.value)}
              className="block rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", colorScheme: "dark" }}
            />
          </div>
          <div>
            <span className="text-xs" style={{ color: "var(--dim)" }} id="plan-meal-label">Meal</span>
            <div className="mt-1 flex gap-1" role="group" aria-labelledby="plan-meal-label">
              {(["breakfast", "lunch", "dinner", "other"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPlanMeal(m)}
                  className="rounded-full px-2.5 py-1.5 text-xs font-medium capitalize"
                  style={{
                    background: planMeal === m ? "var(--accent)" : "var(--surface2)",
                    color: planMeal === m ? "var(--accent-ink)" : "var(--text)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => planMut.mutate({ date: planDate, meal: planMeal, recipeId: recipe.id, label: null })}
            className="rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--herb)", color: "#10240c" }}
          >
            Add to planner
          </button>
        </div>
      </div>

      {notice && <p className="mt-3 text-sm font-medium" style={{ color: "var(--herb)" }} role="status">{notice}</p>}

      <section className="mt-6" aria-label="Ingredients">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">Ingredients</h2>
          <div className="flex items-center gap-2" aria-label="Adjust servings">
            <button
              type="button"
              aria-label="Fewer servings"
              onClick={() => setTargetServings(Math.max(1, shownServings - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
            >
              −
            </button>
            <span className="min-w-20 text-center text-sm font-semibold">Serves {shownServings}</span>
            <button
              type="button"
              aria-label="More servings"
              onClick={() => setTargetServings(shownServings + 1)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
            >
              +
            </button>
          </div>
        </div>
        {recipe.servings == null && (
          <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>This recipe doesn’t say how many it serves, so quantities stay as written.</p>
        )}
        <ul className="mt-2 divide-y rounded-[var(--radius)]" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderColor: "var(--border)" }}>
          {recipe.ingredients.map((ing, i) => {
            const checked = checkedIng.has(i);
            return (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setCheckedIng((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(i); else next.add(i);
                        return next;
                      })
                    }
                    aria-label={`Tick off ${ing}`}
                    className="mt-1 h-5 w-5 shrink-0 accent-[#e4572e]"
                  />
                  <span className={checked ? "line-through opacity-50" : ""}>{scaleLine(ing, factor)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-6" aria-label="Steps">
        <h2 className="font-display text-xl font-bold">Steps</h2>
        <div className="mt-2">
          <TimerBar timers={timers.timers} dismiss={timers.dismiss} />
        </div>
        <ol className="mt-2 space-y-2">
          {recipe.steps.map((step, i) => {
            const checked = checkedSteps.has(i);
            const found = timersInStep(step);
            return (
              <li key={i} className="rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setCheckedSteps((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(i); else next.add(i);
                        return next;
                      })
                    }
                    aria-label={`Mark step ${i + 1} done`}
                    className="mt-1 h-5 w-5 shrink-0 accent-[#e4572e]"
                  />
                  <span className={checked ? "line-through opacity-50" : ""}>
                    <span className="font-display mr-2 font-bold" style={{ color: "var(--accent)" }}>{i + 1}.</span>
                    {step}
                  </span>
                </label>
                {found.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 pl-8">
                    {found.map((t, ti) => (
                      <button
                        key={ti}
                        type="button"
                        onClick={() => timers.start(t.label, t.seconds)}
                        className="rounded-full px-3 py-1 text-xs font-semibold"
                        style={{ background: "var(--surface2)", border: "1px solid var(--herb)", color: "var(--herb)" }}
                        aria-label={`Start timer for ${t.label}`}
                      >
                        ⏱ Start {t.label} timer
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {recipe.notes && (
        <section className="mt-6" aria-label="Your notes">
          <h2 className="font-display text-xl font-bold">My notes</h2>
          <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius)] px-4 py-3 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {recipe.notes}
          </p>
        </section>
      )}

      {recipe.scanPhotoUrl && (
        <section className="mt-6" aria-label="Original scan">
          <h2 className="font-display text-xl font-bold">The original page</h2>
          <RecipePhoto
            src={recipe.scanPhotoUrl}
            alt="The original scanned recipe page"
            imgClassName="mt-2 w-full rounded-[var(--radius)]"
            imgStyle={{ border: "1px solid var(--border)" }}
            placeholderClassName="hidden"
          />
        </section>
      )}
      {recipe.attachmentName && (
        <p className="mt-4 text-sm" style={{ color: "var(--dim)" }}>
          📎 Original file kept with this recipe:{" "}
          {recipe.attachmentUrl ? (
            <a href={recipe.attachmentUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              {recipe.attachmentName}
            </a>
          ) : (
            recipe.attachmentName
          )}
        </p>
      )}

      <div className="mt-8 flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <button type="button" onClick={() => onEdit(recipe)} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
          ✏️ Edit recipe
        </button>
        {!confirmDelete ? (
          <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--accent)" }}>
            Delete recipe
          </button>
        ) : (
          <>
            <span className="self-center text-sm">Delete “{recipe.title}” for good?</span>
            <button type="button" onClick={() => deleteMut.mutate({ id: recipe.id })} className="rounded-full px-4 py-2 text-sm font-bold" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
              Yes, delete it
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
              Keep it
            </button>
          </>
        )}
      </div>

      {cooking && (
        <CookMode
          recipe={recipe}
          onClose={() => setCooking(false)}
          onCooked={() => {
            cookedMut.mutate({ id: recipe.id });
            setCooking(false);
          }}
        />
      )}
    </div>
  );
}

function CookMode({ recipe, onClose, onCooked }: { recipe: Recipe; onClose: () => void; onCooked: () => void }) {
  const [idx, setIdx] = useState(0);
  const timers = useTimers();

  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    if (nav.wakeLock) {
      nav.wakeLock.request("screen").then((l) => { lock = l; }).catch(() => { /* keep-awake is best-effort */ });
    }
    return () => { lock?.release().catch(() => undefined); };
  }, []);

  const step = recipe.steps[idx] ?? "";
  const found = timersInStep(step);
  const last = idx >= recipe.steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col px-5 py-6" style={{ background: "var(--bg)" }} role="dialog" aria-label="Cook mode">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold" style={{ color: "var(--dim)" }}>
          {recipe.title} · Step {idx + 1} of {recipe.steps.length}
        </p>
        <button type="button" onClick={onClose} aria-label="Exit cook mode" className="flex h-10 w-10 items-center justify-center rounded-full text-xl" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>
      <div className="mt-3 h-1.5 w-full rounded-full" style={{ background: "var(--surface2)" }}>
        <div className="h-full rounded-full transition-all" style={{ background: "var(--accent)", width: `${((idx + 1) / Math.max(1, recipe.steps.length)) * 100}%` }} />
      </div>

      <div className="mt-4">
        <TimerBar timers={timers.timers} dismiss={timers.dismiss} />
      </div>

      <div className="flex flex-1 items-center overflow-y-auto py-6">
        <p className="font-display text-2xl font-medium leading-relaxed sm:text-3xl">{step}</p>
      </div>

      {found.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {found.map((t, ti) => (
            <button
              key={ti}
              type="button"
              onClick={() => timers.start(t.label, t.seconds)}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--surface2)", border: "1px solid var(--herb)", color: "var(--herb)" }}
              aria-label={`Start timer for ${t.label}`}
            >
              ⏱ Start {t.label} timer
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 pb-safe">
        <button
          type="button"
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          className="rounded-full py-4 text-lg font-semibold disabled:opacity-40"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
        >
          ← Back
        </button>
        {last ? (
          <button
            type="button"
            onClick={onCooked}
            className="rounded-full py-4 text-lg font-bold"
            style={{ background: "var(--herb)", color: "#10240c" }}
          >
            ✓ Done — I cooked it!
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setIdx((i) => Math.min(recipe.steps.length - 1, i + 1))}
            className="rounded-full py-4 text-lg font-bold"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Next step →
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- add a recipe: four ways in, one review screen ----------

// ---------- import inbox: recipes delivered from email ----------
// Recipes Muse finds in the cook's email wait here — nothing reaches the
// library until the cook opens one on the check-and-fix screen and saves
// it. The app itself never reads email; Muse is the bridge, and the
// copyable "ask" below is how the cook sets that in motion.

function ImportInbox({ onReviewStaged }: { onReviewStaged: (item: StagedItem) => void }) {
  const queryClient = useQueryClient();
  const stagedQ = useQuery({ queryKey: ["stagedImports"], queryFn: () => api.listStagedImports({}) });
  const items = stagedQ.data?.items ?? [];
  const [sender, setSender] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);

  const discardMut = useMutation({
    mutationFn: (id: number) => api.discardStagedImport({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stagedImports"] });
      setConfirmDiscard(null);
    },
  });

  const who = sender.trim() || "[name or email address]";
  const askPrompt = `Search my email for recipes from ${who} and add what you find to Kitchen Companion.`;

  const doCopy = async () => {
    const ok = await copyText(askPrompt);
    if (ok) {
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2500);
    } else {
      setCopyFailed(true);
    }
  };

  return (
    <section className="mt-5 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Import inbox — recipes from email">
      <h2 className="font-display text-lg font-bold">📧 From your email — import inbox</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Recipes people email you don’t have to be copied in by hand. Ask your Muse to search
        your email — for one sender, or for recipes generally — and it finds the recipe emails
        and any attached recipe files and sets them aside here, waiting for your OK. Nothing is
        ever saved into your library until you check it and tap save, and if one looks like a
        recipe you already have, it is flagged so you can skip it.
      </p>
      <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
        Kitchen Companion itself never reads your email and never asks for an email password —
        your Muse is the bridge, using your own email connection, and what it finds waits here
        for you.
      </p>

      <div className="mt-3">
        <label htmlFor="ask-sender" className="text-sm font-semibold">
          Whose recipes should Muse look for? <span style={{ color: "var(--dim)" }}>(optional)</span>
        </label>
        <input
          id="ask-sender"
          type="text"
          value={sender}
          onChange={(e) => setSender(e.target.value)}
          placeholder="e.g. Aunt Mary, or mary@example.com"
          className="mt-1 w-full rounded-lg px-3 py-2.5 text-base outline-none"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
      </div>
      <div className="mt-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: "var(--surface2)", border: "1px dashed var(--border)" }} aria-label="What to ask Muse">
        “{askPrompt}”
      </div>
      <button
        type="button"
        onClick={() => void doCopy()}
        className="mt-2 w-full rounded-full py-2.5 text-sm font-semibold"
        style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
      >
        {copied ? "✓ Copied — paste it to your Muse" : "Copy what to ask Muse"}
      </button>
      {copyFailed && (
        <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
          Copying isn’t available here — the words above are the whole message, so you can type
          them to your Muse just as they are.
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-bold">Waiting for your review{items.length > 0 ? ` (${items.length})` : ""}</h3>
        {stagedQ.isPending ? (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }} role="status">Checking the inbox…</p>
        ) : items.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
            Nothing waiting right now. When Muse finds recipes in your email, they appear here
            for you to check — like mail in a tray, they sit here until you deal with them.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-lg px-3 py-3" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                <p className="text-base font-semibold">{item.title}</p>
                <p className="mt-0.5 text-sm" style={{ color: "var(--dim)" }}>
                  From {item.senderName || item.senderEmail || "an email"}
                  {item.senderName && item.senderEmail ? ` (${item.senderEmail})` : ""}
                  {item.subject ? ` · “${item.subject}”` : ""}
                  {item.emailDate ? ` · ${item.emailDate}` : ""}
                </p>
                {item.draft?.attachmentName && (
                  <p className="mt-0.5 text-sm" style={{ color: "var(--dim)" }}>📎 File from the email: {item.draft.attachmentName}</p>
                )}
                {item.similarTitle && (
                  <p className="mt-1 text-sm font-medium" style={{ color: "#e8a33d" }} role="status">
                    ⚠️ Looks like “{item.similarTitle}”, which is already in your library — you may be able to skip this one.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!item.draft}
                    onClick={() => onReviewStaged(item)}
                    className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
                    style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                  >
                    Check &amp; save
                  </button>
                  {confirmDiscard === item.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => discardMut.mutate(item.id)}
                        disabled={discardMut.isPending}
                        className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
                        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                      >
                        Yes, throw it away
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDiscard(null)}
                        className="rounded-full px-4 py-2 text-sm font-semibold"
                        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDiscard(item.id)}
                      className="rounded-full px-4 py-2 text-sm font-semibold"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                    >
                      Discard
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AddRecipe({ onReview, onReviewStaged }: { onReview: (draft: NonNullable<Draft>, editingId: number | null, previewUrl: string | null) => void; onReviewStaged: (item: StagedItem) => void }) {
  const [url, setUrl] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const runImport = async (label: string, fn: () => Promise<{ ok: boolean; error: string | null; draft: Draft }>, previewUrl: string | null = null) => {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      if (res.draft) {
        onReview(res.draft, null, previewUrl);
        if (!res.ok && res.error) {
          // Draft opened in manual mode; the review screen explains via its banner prop is lost —
          // surface the message here only if we stay. We navigate away, so keep draft flow simple.
        }
      } else {
        setError(res.error ?? "That did not work. Try another way in.");
      }
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const onScanFile = async (file: File) => {
    setError(null);
    setBusy("Reading your photo…");
    try {
      let photo = await photoToBase64(file);
      const res = await api.scanImage({ dataBase64: photo.dataBase64, mimeType: photo.mimeType });
      // The page itself may sit turned in the photo (beyond what the photo's
      // own orientation data explains). The scanner reports the turn, and
      // the photo is rotated right-side up and stored that way — Liz never
      // has to fix rotation by hand.
      let draft = res.draft;
      if (draft && draft.pageNeedsRotation !== "none") {
        const turns = draft.pageNeedsRotation === "90" ? 1 : draft.pageNeedsRotation === "180" ? 2 : 3;
        setBusy("Straightening the photo…");
        for (let i = 0; i < turns; i++) photo = await rotateLoadedPhoto(photo);
        const stored = await api.storePhoto({ dataBase64: photo.dataBase64, mimeType: photo.mimeType, kind: "scan" });
        draft = { ...draft, scanPhotoKey: stored.key, pageNeedsRotation: "none" };
      }
      if (draft) onReview(draft, null, photo.previewUrl);
      else setError(res.error ?? "The photo could not be read.");
    } catch {
      setError("That photo could not be read. Try again in good light, holding the page flat.");
    } finally {
      setBusy(null);
    }
  };

  const onUploadFile = async (file: File) => {
    setError(null);
    if (file.type.startsWith("image/")) {
      await onScanFile(file);
      return;
    }
    if (file.type === "text/plain" || file.type === "text/markdown" || /\.(txt|md)$/i.test(file.name)) {
      setBusy("Reading your file…");
      try {
        const text = await file.text();
        const res = await api.structureText({ text: text.slice(0, 20000) });
        if (res.draft) onReview({ ...res.draft, attachmentName: file.name }, null, null);
        else setError(res.error ?? "That file could not be turned into a recipe.");
      } catch {
        setError("That file could not be read.");
      } finally {
        setBusy(null);
      }
      return;
    }
    // PDFs and other documents: keep the original attached; the recipe is typed on the review screen.
    setBusy("Keeping your file…");
    try {
      const dataBase64 = await fileToRawBase64(file);
      const stored = await api.storeAttachment({ dataBase64, mimeType: file.type || "application/octet-stream", filename: file.name });
      onReview(
        {
          title: "",
          description: "",
          servings: null,
          prepMinutes: null,
          cookMinutes: null,
          ingredients: [],
          steps: [],
          tags: [],
          course: null,
          protein: null,
          pageNeedsRotation: "none",
          sourceUrl: null,
          sourceName: file.name,
          sourcePhotoKey: null,
          scanPhotoKey: null,
          attachmentName: file.name,
          attachmentKey: stored.key,
        },
        null,
        null,
      );
    } catch {
      setError("That file could not be kept. It may be too large (10 MB limit).");
    } finally {
      setBusy(null);
    }
  };

  const blankDraft: NonNullable<Draft> = {
    title: "",
    description: "",
    servings: null,
    prepMinutes: null,
    cookMinutes: null,
    ingredients: [],
    steps: [],
    tags: [],
    course: null,
    protein: null,
    pageNeedsRotation: "none",
    sourceUrl: null,
    sourceName: null,
    sourcePhotoKey: null,
    scanPhotoKey: null,
    attachmentName: null,
    attachmentKey: null,
  };

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">Add a recipe</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        However it comes in, it lands on the same check-and-fix screen before it’s saved.
      </p>

      {error && (
        <p className="mt-4 rounded-[var(--radius)] px-4 py-3 text-sm font-medium" style={{ background: "var(--surface)", border: "1px solid var(--accent)", color: "var(--text)" }} role="alert">
          {error}
        </p>
      )}
      {busy && <p className="mt-4 text-sm font-medium" style={{ color: "var(--herb)" }} role="status">{busy}</p>}

      <ImportInbox onReviewStaged={onReviewStaged} />

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Save from a link">
        <h2 className="font-display text-lg font-bold">🔗 Save from a link</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Paste a link to a recipe blog — or a Pinterest pin, and we’ll follow it to the recipe
          behind it. Only the recipe comes in; the blog story and ads stay behind.
        </p>
        <label htmlFor="import-url" className="sr-only">Recipe link</label>
        <input
          id="import-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="mt-3 w-full rounded-lg px-3 py-2.5 text-base outline-none"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        <button
          type="button"
          disabled={busy != null || !/^https?:\/\//i.test(url.trim())}
          onClick={() => runImport("Fetching that recipe…", () => api.importUrl({ url: url.trim() }))}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Fetch the recipe
        </button>
      </section>

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Scan a page">
        <h2 className="font-display text-lg font-bold">📷 Scan a page</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Photograph a cookbook page, a magazine clipping, or a handwritten recipe card. The app
          types it up for you to check — and keeps your photo attached as the original. If the
          photo comes in upside down or sideways, it is turned right-side up for you automatically.
        </p>
        <button
          type="button"
          disabled={busy != null}
          onClick={() => scanRef.current?.click()}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Take or pick a photo
        </button>
        <input
          ref={scanRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="Photograph a recipe page"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onScanFile(f);
            e.target.value = "";
          }}
        />
      </section>

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Upload a file">
        <h2 className="font-display text-lg font-bold">📁 Upload a file</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          A photo is read like a scan; a text file is turned into a recipe. A PDF is kept attached
          as the original while you fill in the recipe on the next screen.
        </p>
        <button
          type="button"
          disabled={busy != null}
          onClick={() => uploadRef.current?.click()}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold disabled:opacity-40"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          Choose a file
        </button>
        <input
          ref={uploadRef}
          type="file"
          accept="image/*,.txt,.md,.pdf,text/plain,text/markdown,application/pdf"
          className="hidden"
          aria-label="Upload a recipe file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUploadFile(f);
            e.target.value = "";
          }}
        />
      </section>

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Paste recipe text">
        <h2 className="font-display text-lg font-bold">📋 Paste the words</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Copied a recipe from somewhere? Paste it here and it will be sorted into ingredients and steps.
        </p>
        <label htmlFor="paste-text" className="sr-only">Recipe text</label>
        <textarea
          id="paste-text"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={5}
          placeholder="Paste the whole recipe here…"
          className="mt-3 w-full rounded-lg px-3 py-2.5 text-base outline-none"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        <button
          type="button"
          disabled={busy != null || pasteText.trim().length < 10}
          onClick={() => runImport("Sorting that into a recipe…", () => api.structureText({ text: pasteText }))}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold disabled:opacity-40"
          style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          Turn it into a recipe
        </button>
      </section>

      <button
        type="button"
        onClick={() => onReview(blankDraft, null, null)}
        className="mt-4 w-full rounded-[var(--radius)] px-4 py-4 text-left"
        style={{ background: "var(--surface)", border: "1px dashed var(--border)" }}
      >
        <span className="font-display text-lg font-bold">✍️ Type it in myself</span>
        <span className="mt-1 block text-sm" style={{ color: "var(--dim)" }}>Start from a blank recipe page.</span>
      </button>
    </div>
  );
}

// ---------- check-and-fix review form ----------

function ReviewForm({
  draft, editingId, previewUrl, stagedId, sourceNote, rawText, collections, recipes, onDone, onCancel,
}: {
  draft: NonNullable<Draft>;
  editingId: number | null;
  previewUrl: string | null;
  stagedId: number | null;
  sourceNote: string | null;
  rawText: string | null;
  collections: Collection[];
  recipes: Recipe[];
  onDone: (recipeId: number | null) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [servings, setServings] = useState(draft.servings != null ? String(draft.servings) : "");
  const [prep, setPrep] = useState(draft.prepMinutes != null ? String(draft.prepMinutes) : "");
  const [cook, setCook] = useState(draft.cookMinutes != null ? String(draft.cookMinutes) : "");
  const [ingredientsText, setIngredientsText] = useState(draft.ingredients.join("\n"));
  const [stepsText, setStepsText] = useState(draft.steps.join("\n"));
  const [tagsText, setTagsText] = useState(draft.tags.join(", "));
  const [course, setCourse] = useState<string | null>(draft.course);
  const [protein, setProtein] = useState<string | null>(draft.protein);
  const [notes, setNotes] = useState("");
  const [collectionId, setCollectionId] = useState<number | null>(
    editingId != null ? (recipes.find((r) => r.id === editingId)?.collectionId ?? null) : null,
  );
  const [newCollection, setNewCollection] = useState("");
  const [dishPhotoKey, setDishPhotoKey] = useState<string | null>(
    editingId != null ? (recipes.find((r) => r.id === editingId)?.dishPhotoKey ?? null) : null,
  );
  const [dishPreview, setDishPreview] = useState<string | null>(
    editingId != null ? (recipes.find((r) => r.id === editingId)?.dishPhotoUrl ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  const dishRef = useRef<HTMLInputElement>(null);

  const editingRecipe = editingId != null ? recipes.find((r) => r.id === editingId) : null;
  const scanPreview = previewUrl ?? editingRecipe?.scanPhotoUrl ?? null;

  const numOrNull = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const createCollectionMut = useMutation({
    mutationFn: api.createCollection,
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setCollectionId(res.id);
      setNewCollection("");
    },
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        servings: numOrNull(servings),
        prepMinutes: numOrNull(prep),
        cookMinutes: numOrNull(cook),
        ingredients: ingredientsText.split("\n").map((s) => s.trim()).filter(Boolean),
        steps: stepsText.split("\n").map((s) => s.trim()).filter(Boolean),
        tags: tagsText.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        course,
        protein,
        sourceUrl: draft.sourceUrl,
        sourceName: draft.sourceName,
        collectionId,
        notes: editingRecipe ? notes || editingRecipe.notes : notes,
        dishPhotoKey,
        scanPhotoKey: draft.scanPhotoKey ?? editingRecipe?.scanPhotoKey ?? null,
        sourcePhotoKey: draft.sourcePhotoKey ?? editingRecipe?.sourcePhotoKey ?? null,
        attachmentName: draft.attachmentName ?? editingRecipe?.attachmentName ?? null,
        attachmentKey: draft.attachmentKey ?? editingRecipe?.attachmentKey ?? null,
      };
      if (editingId != null) {
        await api.updateRecipe({ id: editingId, ...payload });
        return editingId;
      }
      const created = await api.createRecipe(payload);
      // Saved from the import inbox: the staged copy has done its job.
      if (stagedId != null) {
        try {
          await api.discardStagedImport({ id: stagedId });
        } catch {
          /* the recipe saved; the waiting copy can be discarded in the inbox */
        }
      }
      return created.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["recipes"] });
      if (stagedId != null) queryClient.invalidateQueries({ queryKey: ["stagedImports"] });
      onDone(id);
    },
    onError: () => setError("That recipe could not be saved. Your words are still here — try again."),
  });

  const discardStagedMut = useMutation({
    mutationFn: () => api.discardStagedImport({ id: stagedId ?? 0 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stagedImports"] });
      onCancel();
    },
    onError: () => setError("That one could not be discarded just now. You can throw it away from the import inbox instead."),
  });

  useEffect(() => {
    if (editingId != null && editingRecipe) setNotes(editingRecipe.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    const t = title.trim();
    if (!t || editingId != null) { setDupWarning(null); return; }
    const dup = recipes.find((r) => titlesSimilar(r.title, t));
    setDupWarning(
      dup
        ? `Heads up: this looks like “${dup.title}”, which is already in your library. If it’s the same recipe, go back and discard this one — or save anyway and keep both.`
        : null,
    );
  }, [title, recipes, editingId]);

  const inputCls = "w-full rounded-lg px-3 py-2.5 text-base outline-none";
  const inputStyle = { background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" } as const;

  return (
    <div>
      <button type="button" onClick={onCancel} className="text-sm font-semibold" style={{ color: "var(--accent)" }}>← Back</button>
      <h1 className="font-display mt-2 text-3xl font-bold">{editingId != null ? "Edit recipe" : "Check & fix"}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        {editingId != null
          ? "Make it yours — fix quantities, add your own notes."
          : "Here’s what was read in. Fix anything that looks wrong, then save — nothing is kept until you do."}
      </p>

      {sourceNote && (
        <p className="mt-3 rounded-[var(--radius)] px-4 py-3 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} role="status">
          {sourceNote}
        </p>
      )}
      {rawText && (
        <details className="mt-3 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <summary className="cursor-pointer text-sm font-semibold">✉️ Read the original email</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: "var(--dim)" }}>{rawText}</p>
        </details>
      )}

      {scanPreview && (
        <figure className="mt-4">
          <img src={scanPreview} alt="The page you scanned" className="max-h-64 w-full rounded-[var(--radius)] object-contain" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }} />
          <figcaption className="mt-1 text-xs" style={{ color: "var(--dim)" }}>Your original photo — it stays attached to this recipe.</figcaption>
        </figure>
      )}
      {draft.attachmentName && (
        <p className="mt-3 text-sm" style={{ color: "var(--dim)" }}>📎 Original file kept with this recipe: {draft.attachmentName}</p>
      )}
      {draft.sourceUrl && (
        <p className="mt-3 truncate text-sm" style={{ color: "var(--dim)" }}>
          From: <a href={draft.sourceUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--accent)" }}>{draft.sourceName ?? draft.sourceUrl}</a>
        </p>
      )}
      {dupWarning && <p className="mt-3 text-sm font-medium" style={{ color: "#e8a33d" }} role="status">{dupWarning}</p>}
      {error && <p className="mt-3 text-sm font-medium" style={{ color: "var(--accent)" }} role="alert">{error}</p>}

      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="f-title" className="text-sm font-semibold">Recipe name</label>
          <input id="f-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grandma’s tomato soup" className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="f-desc" className="text-sm font-semibold">Short description <span style={{ color: "var(--dim)" }}>(optional)</span></label>
          <textarea id="f-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label htmlFor="f-servings" className="text-sm font-semibold">Serves</label>
            <input id="f-servings" type="number" min={1} inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value)} placeholder="4" className={`mt-1 ${inputCls}`} style={inputStyle} />
          </div>
          <div>
            <label htmlFor="f-prep" className="text-sm font-semibold">Prep (min)</label>
            <input id="f-prep" type="number" min={0} inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="15" className={`mt-1 ${inputCls}`} style={inputStyle} />
          </div>
          <div>
            <label htmlFor="f-cook" className="text-sm font-semibold">Cook (min)</label>
            <input id="f-cook" type="number" min={0} inputMode="numeric" value={cook} onChange={(e) => setCook(e.target.value)} placeholder="30" className={`mt-1 ${inputCls}`} style={inputStyle} />
          </div>
        </div>
        <div>
          <label htmlFor="f-ingredients" className="text-sm font-semibold">Ingredients <span style={{ color: "var(--dim)" }}>(one per line)</span></label>
          <textarea id="f-ingredients" value={ingredientsText} onChange={(e) => setIngredientsText(e.target.value)} rows={8} placeholder={"2 cups flour\n1 tsp salt\n3 eggs"} className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="f-steps" className="text-sm font-semibold">Steps <span style={{ color: "var(--dim)" }}>(one per line)</span></label>
          <textarea id="f-steps" value={stepsText} onChange={(e) => setStepsText(e.target.value)} rows={8} placeholder={"Mix the flour and salt.\nKnead for 5 minutes."} className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>
        <div>
          <span className="text-sm font-semibold" id="f-course-label">Course <span style={{ color: "var(--dim)" }}>(picked for you — tap to fix)</span></span>
          <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-labelledby="f-course-label">
            {COURSES.map((c) => (
              <Chip key={c} active={course === c} onClick={() => setCourse(c)}>{c}</Chip>
            ))}
          </div>
        </div>
        <div>
          <span className="text-sm font-semibold" id="f-protein-label">Protein / type <span style={{ color: "var(--dim)" }}>(picked for you — tap to fix)</span></span>
          <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-labelledby="f-protein-label">
            {PROTEINS.map((p) => (
              <Chip key={p} active={protein === p} onClick={() => setProtein(p)}>{p}</Chip>
            ))}
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
            Time is filed automatically from the prep + cook minutes above — under 30 minutes, 30–60, or over an hour.
          </p>
        </div>
        <div>
          <label htmlFor="f-tags" className="text-sm font-semibold">Tags <span style={{ color: "var(--dim)" }}>(separated by commas)</span></label>
          <input id="f-tags" type="text" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="weeknight, chicken, freezer-friendly" className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>

        <div>
          <span className="text-sm font-semibold" id="collection-label">Collection</span>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby="collection-label">
            <Chip active={collectionId === null} onClick={() => setCollectionId(null)}>No collection</Chip>
            {collections.map((c) => (
              <Chip key={c.id} active={collectionId === c.id} onClick={() => setCollectionId(c.id)}>{c.name}</Chip>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <label htmlFor="new-collection" className="sr-only">New collection name</label>
            <input
              id="new-collection"
              type="text"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              placeholder="New collection — e.g. Weeknight dinners"
              className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
            <button
              type="button"
              disabled={!newCollection.trim()}
              onClick={() => createCollectionMut.mutate({ name: newCollection.trim() })}
              className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
            >
              Create
            </button>
          </div>
        </div>

        <div>
          <span className="text-sm font-semibold">Photo of the finished dish</span>
          {dishPreview ? (
            <img src={dishPreview} alt="Your finished dish" className="mt-2 aspect-[16/10] w-full rounded-[var(--radius)] object-cover" />
          ) : (
            <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>Add it now, or later from the recipe page once you’ve cooked it.</p>
          )}
          <button type="button" onClick={() => dishRef.current?.click()} className="mt-2 rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
            {dishPreview ? "Use a different photo" : "📷 Add dish photo"}
          </button>
          <input
            ref={dishRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Add a photo of the finished dish"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                void (async () => {
                  try {
                    const { dataBase64, mimeType, previewUrl } = await photoToBase64(f);
                    const stored = await api.storePhoto({ dataBase64, mimeType, kind: "dish" });
                    setDishPhotoKey(stored.key);
                    setDishPreview(previewUrl);
                  } catch {
                    setError("That photo could not be added.");
                  }
                })();
              }
              e.target.value = "";
            }}
          />
        </div>

        <div>
          <label htmlFor="f-notes" className="text-sm font-semibold">My notes <span style={{ color: "var(--dim)" }}>(optional — “use half the chilli next time”)</span></label>
          <textarea id="f-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`mt-1 ${inputCls}`} style={inputStyle} />
        </div>
      </div>

      <button
        type="button"
        disabled={!title.trim() || saveMut.isPending}
        onClick={() => saveMut.mutate()}
        className="mt-6 w-full rounded-full py-3.5 text-lg font-bold disabled:opacity-40"
        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
      >
        {saveMut.isPending ? "Saving…" : editingId != null ? "Save changes" : "Save this recipe"}
      </button>
      {stagedId != null && (
        <button
          type="button"
          disabled={discardStagedMut.isPending}
          onClick={() => discardStagedMut.mutate()}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold disabled:opacity-40"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {discardStagedMut.isPending ? "Discarding…" : "Don’t save this — discard it"}
        </button>
      )}
    </div>
  );
}

// ---------- settings ----------

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function SettingsView({
  updateInfo, checking, onRecheck, profile, friendsOnline, recoveryKey, onShowTutorial,
}: {
  updateInfo: UpdateInfo | null;
  checking: boolean;
  onRecheck: () => void;
  profile: MyProfile | null;
  friendsOnline: boolean;
  recoveryKey: string | null;
  onShowTutorial: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const queryClient = useQueryClient();
  const backupStatusQ = useQuery({ queryKey: ["backupStatus"], queryFn: () => api.getBackupStatus({}) });
  const backupStatus = backupStatusQ.data ?? null;
  const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [confirmingName, setConfirmingName] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const profilePhotoRef = useRef<HTMLInputElement>(null);
  const currentNotes = notesFor(APP_VERSION);
  const latest = updateInfo?.latestVersion ?? null;
  const updateText = latest
    ? `Please update my Kitchen Companion app to the latest version, v${latest}. Get it from the public GitHub repo: https://github.com/aruikis/Kitchen-Companion — use the version tagged v${latest}. Please keep all of my recipes, collections, and settings exactly as they are, install the new version the same way this app was installed before, and when it's done, tell me what's new in it.`
    : "";

  const saveDisplayName = async () => {
    if (!profile) return;
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      await api.updateProfile({ displayName: displayNameDraft ?? profile.displayName, photo: null });
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setProfileMsg("Your name is saved.");
    } catch {
      setProfileMsg("That couldn't be saved just now. Try again in a moment.");
    } finally {
      setProfileBusy(false);
    }
  };

  const savePhoto = async (file: File) => {
    if (!profile) return;
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      const photo = await profilePhotoFromFile(file);
      await api.updateProfile({ displayName: displayNameDraft ?? profile.displayName, photo: { dataBase64: photo.dataBase64, mimeType: photo.mimeType } });
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      setProfileMsg("Your photo is saved.");
    } catch {
      setProfileMsg("That photo couldn't be saved. Try a different one.");
    } finally {
      setProfileBusy(false);
    }
  };

  const saveUsername = async () => {
    if (!profile) return;
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      const res = await api.changeUsername({ username: usernameDraft });
      if (!res.ok) {
        setProfileMsg(res.error ?? "That username couldn't be taken.");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      setConfirmingName(false);
      setUsernameDraft("");
      setProfileMsg("Your username is changed. Your code is the same as ever, so friends still find you.");
    } catch {
      setProfileMsg("That couldn't be changed just now. Try again in a moment.");
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">Settings</h1>

      {profile && (
        <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Your profile">
          <h2 className="font-display text-xl font-bold">👤 Your profile</h2>
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={profile.displayName || profile.username} photoData={profile.photoData} photoUrl={profile.photoUrl} size={64} />
            <div className="min-w-0">
              <p className="truncate text-lg font-bold">{profile.displayName || profile.username}</p>
              <p className="text-sm" style={{ color: "var(--dim)" }}>@{profile.username}</p>
              <p className="font-display text-base font-bold tracking-wide">{profile.kcId}</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => setCodeCopied(await copyText(profile.kcId))}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              {codeCopied ? "✓ Code copied" : "📋 Copy my code"}
            </button>
            <button
              type="button"
              onClick={() => profilePhotoRef.current?.click()}
              disabled={profileBusy}
              className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              Change my photo
            </button>
            <input
              ref={profilePhotoRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Choose a new profile photo"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void savePhoto(f);
              }}
            />
          </div>

          <label className="mt-4 block text-sm font-bold" htmlFor="settings-display-name">Your name, as friends see it</label>
          <div className="mt-1 flex gap-2">
            <input
              id="settings-display-name"
              value={displayNameDraft ?? profile.displayName}
              onChange={(e) => setDisplayNameDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
            <button
              type="button"
              onClick={() => void saveDisplayName()}
              disabled={profileBusy}
              className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              Save name
            </button>
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-bold">Change my username</summary>
            <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
              Take care here: your username is how friends find you by name. Your Kitchen Companion
              code — {profile.kcId} — never changes, so anyone who has your code still finds you.
              {!friendsOnline && " (Friends aren't switched on yet, so the new name is checked against everyone the moment they are.)"}
            </p>
            <div className="mt-2 flex gap-2">
              <label className="sr-only" htmlFor="settings-username">New username</label>
              <input
                id="settings-username"
                value={usernameDraft}
                onChange={(e) => { setUsernameDraft(e.target.value); setConfirmingName(false); }}
                placeholder={profile.username}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
              <button
                type="button"
                onClick={() => (confirmingName ? void saveUsername() : setConfirmingName(true))}
                disabled={profileBusy || !usernameDraft.trim()}
                className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--surface2)", color: confirmingName ? "var(--accent)" : "var(--text)", border: "1px solid var(--border)" }}
              >
                {confirmingName ? "Tap again to change it" : "Change username"}
              </button>
            </div>
          </details>

          {recoveryKey && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-bold">🔑 My private backup key</summary>
              <p className="font-display mt-2 text-xl font-bold tracking-wide">{recoveryKey}</p>
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                This is NOT your friend code — it’s private. It’s the only thing that can open your
                server backup if this app copy is ever lost and rebuilt. Don’t give it out like your
                code; keep it for yourself.
              </p>
              <button
                type="button"
                onClick={async () => setKeyCopied(await copyText(recoveryKey))}
                className="mt-2 rounded-full px-4 py-2 text-sm font-semibold"
                style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                {keyCopied ? "✓ Key copied" : "📋 Copy my backup key"}
              </button>
            </details>
          )}

          <button
            type="button"
            onClick={onShowTutorial}
            className="mt-4 rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            🎓 Show the tutorial again
          </button>

          {profileMsg && <p className="mt-2 text-sm" role="status" style={{ color: "var(--herb)" }}>{profileMsg}</p>}
        </section>
      )}

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="App updates">
        <h2 className="font-display text-xl font-bold">⬆️ App updates</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          You’re running <strong style={{ color: "var(--text)" }}>Kitchen Companion version {APP_VERSION}</strong>.
        </p>

        {checking && !updateInfo && (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }} role="status">Checking for updates…</p>
        )}

        {updateInfo?.status === "up-to-date" && (
          <div className="mt-2" role="status">
            <p className="text-sm font-bold" style={{ color: "var(--herb)" }}>
              ✓ You’re up to date — version {APP_VERSION} is the latest.
            </p>
            <p className="mt-0.5 text-sm" style={{ color: "var(--dim)" }}>
              Version {APP_VERSION} went live {updateInfo.currentDate ? fmtDateTime(updateInfo.currentDate) : currentNotes ? prettyDate(currentNotes.date) : ""}.
            </p>
          </div>
        )}

        {updateInfo?.status === "unknown" && (
          <p className="mt-2 text-sm" role="status" style={{ color: "var(--dim)" }}>
            We couldn’t check for updates just now — the check needs the internet. Nothing is wrong with your app; try again in a bit.
          </p>
        )}

        {updateInfo?.status === "update-available" && latest && (
          <div className="mt-2" role="status">
            <p className="text-sm font-bold" style={{ color: "var(--herb)" }}>
              ⬆️ Update available — version {latest}
              {updateInfo.latestDate ? <span className="font-normal" style={{ color: "var(--dim)" }}> · went live {fmtDateTime(updateInfo.latestDate)}</span> : null}
            </p>

            <h3 className="mt-3 text-sm font-bold">What’s new in {latest}</h3>
            {updateInfo.whatsNew.length > 0 ? (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--dim)" }}>
                {updateInfo.whatsNew.map((n) => <li key={n}>{n}</li>)}
              </ul>
            ) : (
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                The notes for this version are on the GitHub page — the link is below.
              </p>
            )}

            <h3 className="mt-4 text-sm font-bold">How updating works</h3>
            <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
              Nothing updates on its own — ever. This copy of Kitchen Companion lives in your own
              Muse account, so when you’re ready, your own Muse pulls the new version in for you.
              All it takes:
            </p>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm" style={{ color: "var(--dim)" }}>
              <li>Tap <strong style={{ color: "var(--text)" }}>Copy the update note</strong> below.</li>
              <li>Go to your chat with Muse (outside this app) and paste it in.</li>
              <li>Muse does the rest and tells you when it’s done. Your recipes stay exactly as they are.</li>
            </ol>
            <div className="mt-3 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
              {updateText}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={async () => setCopyState((await copyText(updateText)) ? "copied" : "failed")}
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{ background: "var(--herb)", color: "#10240c" }}
              >
                {copyState === "copied" ? "✓ Note copied" : "📋 Copy the update note"}
              </button>
              <a
                href={updateInfo.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full px-4 py-2 text-sm font-semibold"
                style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
              >
                Open the GitHub page ↗
              </a>
            </div>
            {copyState === "copied" && (
              <p className="mt-2 text-sm" style={{ color: "var(--herb)" }} role="status">
                Copied — now paste it into your chat with Muse.
              </p>
            )}
            {copyState === "failed" && (
              <div className="mt-2" role="status">
                <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>
                  Copying isn’t available in this browser — here’s the note to copy by hand:
                </p>
                <label htmlFor="update-note-text" className="sr-only">The update note as text</label>
                <textarea
                  id="update-note-text"
                  readOnly
                  value={updateText}
                  rows={5}
                  onFocus={(e) => e.target.select()}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
                />
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="mt-3 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        {updateInfo && (
          <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
            Last checked {fmtDateTime(updateInfo.checkedAt)} · new versions are published at github.com/aruikis/Kitchen-Companion
          </p>
        )}

        <h3 className="mt-5 text-base font-bold">📖 What’s new — the change log</h3>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Everything each update brought, in plain words — newest first.
        </p>
        <div className="mt-3 space-y-4">
          {CHANGELOG.map((v) => (
            <div key={v.version}>
              <p className="text-sm font-bold">
                Version {v.version} · {prettyDate(v.date)}
                {v.version === APP_VERSION ? <span className="font-normal" style={{ color: "var(--herb)" }}> — the one you’re using</span> : null}
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--dim)" }}>
                {v.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Backup and safety">
        <h2 className="font-display text-xl font-bold">🛟 Backup &amp; safety</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Your recipes and their photos live in this app, in your own Muse account — never on GitHub,
          never anywhere public. So they can’t be lost, Kitchen Companion keeps automatic backup copies
          of everything (recipes and photos together) inside the app, and you can download a complete
          backup file of your own from the bottom of the Recipes tab.
        </p>
        {backupStatus ? (
          <div className="mt-2 space-y-1 text-sm">
            <p style={{ color: "var(--dim)" }}>
              In this library: {backupStatus.recipeCount} recipe{backupStatus.recipeCount === 1 ? "" : "s"} and {backupStatus.photoCount} photo{backupStatus.photoCount === 1 ? "" : "s"} and files.
            </p>
            {backupStatus.lastAutoBackupAt ? (
              <p style={{ color: "var(--herb)" }} role="status">
                ✓ Last automatic backup: {fmtDateTime(backupStatus.lastAutoBackupAt)}
                {backupStatus.snapshotCount > 0 ? ` · ${backupStatus.snapshotCount} cop${backupStatus.snapshotCount === 1 ? "y" : "ies"} kept` : ""}.
              </p>
            ) : (
              <p style={{ color: "var(--dim)" }} role="status">
                The first automatic backup is taken when the app opens with changes to save.
              </p>
            )}
            <p style={{ color: "var(--dim)" }}>
              {backupStatus.lastBackupAt
                ? `Last backup you downloaded: ${fmtDateTime(backupStatus.lastBackupAt)}.`
                : "You haven’t downloaded a backup of your own yet."}{" "}
              Downloading and restoring both happen at the bottom of the Recipes tab.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }} role="status">Checking your backups…</p>
        )}
      </section>

      <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="About">
        <h2 className="font-display text-xl font-bold">About</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          Kitchen Companion UAT · Version {APP_VERSION}. Your recipes live in this app, in your own
          Muse account. They are backed up automatically inside the app, and you can download a
          complete backup — recipes and photos together — any time from the bottom of the Recipes tab.
          What each version brought is in the change log under App updates, just above.
        </p>
      </section>
    </div>
  );
}

// ---------- week planner ----------

const MEALS = ["breakfast", "lunch", "dinner", "other"] as const;
type Meal = (typeof MEALS)[number];
const MEAL_ICON: Record<Meal, string> = { breakfast: "🌅", lunch: "🥗", dinner: "🍽", other: "•" };

function mondayOf(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (copy.getDay() + 6) % 7; // Monday = 0
  copy.setDate(copy.getDate() - dow);
  return copy;
}

function Planner({ recipes, onOpen }: { recipes: Recipe[]; onOpen: (id: number) => void }) {
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [picker, setPicker] = useState<{ date: string; meal: Meal } | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [pickSearch, setPickSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
  }, [weekStart]);
  const from = localDateStr(days[0] ?? new Date());
  const to = localDateStr(days[6] ?? new Date());

  const planQ = useQuery({ queryKey: ["plan", from, to], queryFn: () => api.listPlan({ from, to }) });
  const entries = planQ.data?.entries ?? [];
  const todayStr = localDateStr(new Date());

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["plan"] });
  const addMut = useMutation({ mutationFn: api.addPlanEntry, onSuccess: () => { invalidate(); setPicker(null); setCustomLabel(""); setPickSearch(""); } });
  const removeMut = useMutation({ mutationFn: api.removePlanEntry, onSuccess: invalidate });
  const groceryMut = useMutation({
    mutationFn: api.addRecipesToGrocery,
    onSuccess: (res) => setNotice(res.added > 0 ? `Added ${res.added} item${res.added === 1 ? "" : "s"} to your shopping list.` : "This week’s ingredients are already on your shopping list."),
  });

  const weekRecipeItems = entries
    .filter((e) => e.recipeId != null)
    .map((e) => ({ recipeId: e.recipeId as number, factor: 1 }));

  const pickable = recipes.filter((r) => r.title.toLowerCase().includes(pickSearch.trim().toLowerCase()));

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">This week’s dinners</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>Decide once, on Sunday — not in a panic at 5pm.</p>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(w.getDate() - 7); return d; })}
          className="flex h-10 w-10 items-center justify-center rounded-full text-lg"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
        >
          ←
        </button>
        <p className="font-display text-base font-bold">
          {days[0]?.toLocaleDateString(undefined, { month: "long", day: "numeric" })} – {days[6]?.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
        </p>
        <button
          type="button"
          aria-label="Next week"
          onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(w.getDate() + 7); return d; })}
          className="flex h-10 w-10 items-center justify-center rounded-full text-lg"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
        >
          →
        </button>
      </div>

      {weekRecipeItems.length > 0 && (
        <button
          type="button"
          onClick={() => groceryMut.mutate({ items: weekRecipeItems })}
          className="mt-3 w-full rounded-full py-3 text-base font-semibold"
          style={{ background: "var(--herb)", color: "#10240c" }}
        >
          🛒 Make the shopping list for this week
        </button>
      )}
      {notice && <p className="mt-2 text-sm font-medium" style={{ color: "var(--herb)" }} role="status">{notice}</p>}

      <div className="mt-4 space-y-3">
        {days.map((day) => {
          const dateStr = localDateStr(day);
          const dayEntries = entries.filter((e: PlanEntry) => e.date === dateStr);
          const isToday = dateStr === todayStr;
          return (
            <section
              key={dateStr}
              className="rounded-[var(--radius)] px-4 py-3"
              style={{ background: "var(--surface)", border: `1px solid ${isToday ? "var(--accent)" : "var(--border)"}` }}
              aria-label={day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            >
              <h2 className="font-display text-base font-bold">
                {day.toLocaleDateString(undefined, { weekday: "long" })}
                <span className="ml-2 text-sm font-normal" style={{ color: "var(--dim)" }}>
                  {day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
                {isToday && <span className="ml-2 text-xs font-bold uppercase" style={{ color: "var(--accent)" }}>Today</span>}
              </h2>
              {dayEntries.length === 0 && (
                <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>Nothing planned yet.</p>
              )}
              <ul className="mt-1 space-y-1">
                {dayEntries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-1">
                    <span className="text-sm">
                      <span aria-hidden>{MEAL_ICON[e.meal]} </span>
                      {e.recipeId != null ? (
                        <button type="button" onClick={() => onOpen(e.recipeId as number)} className="font-semibold underline" style={{ color: "var(--accent)" }}>
                          {e.recipeTitle ?? "Recipe"}
                        </button>
                      ) : (
                        <span>{e.label ?? "Planned"}</span>
                      )}
                      <span className="ml-1 capitalize" style={{ color: "var(--dim)" }}>· {e.meal}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${e.recipeTitle ?? e.label ?? "entry"} from ${dateStr}`}
                      onClick={() => removeMut.mutate({ id: e.id })}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-sm"
                      style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {MEALS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPicker({ date: dateStr, meal: m })}
                    className="rounded-full px-2.5 py-1 text-xs font-medium capitalize"
                    style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--dim)" }}
                    aria-label={`Add ${m} on ${day.toLocaleDateString(undefined, { weekday: "long" })}`}
                  >
                    + {m}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {picker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" style={{ background: "rgba(10,7,5,0.7)" }} role="dialog" aria-label="Choose a recipe to plan">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-3xl px-5 py-5 sm:rounded-3xl" style={{ background: "var(--surface)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold capitalize">{picker.meal} · {prettyDate(picker.date)}</h2>
              <button type="button" onClick={() => setPicker(null)} aria-label="Close planner picker" className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
                ✕
              </button>
            </div>
            <label htmlFor="pick-search" className="sr-only">Search your recipes</label>
            <input
              id="pick-search"
              type="search"
              value={pickSearch}
              onChange={(e) => setPickSearch(e.target.value)}
              placeholder="Search your recipes…"
              className="mt-3 w-full rounded-lg px-3 py-2.5 text-base outline-none"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
            <ul className="mt-2 divide-y" style={{ borderColor: "var(--border)" }}>
              {pickable.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => addMut.mutate({ date: picker.date, meal: picker.meal, recipeId: r.id, label: null })}
                    className="w-full py-2.5 text-left font-medium"
                  >
                    {r.title}
                    {r.status === "want" && <span className="ml-2 text-xs" style={{ color: "var(--accent)" }}>want to try</span>}
                  </button>
                </li>
              ))}
              {pickable.length === 0 && (
                <li className="py-3 text-sm" style={{ color: "var(--dim)" }}>No recipes match — add one from the Add tab first.</li>
              )}
            </ul>
            <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <label htmlFor="custom-plan-label" className="text-sm font-semibold">Or a note instead <span style={{ color: "var(--dim)" }}>(leftovers, takeaway…)</span></label>
              <div className="mt-2 flex gap-2">
                <input
                  id="custom-plan-label"
                  type="text"
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder="Leftovers night"
                  className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
                />
                <button
                  type="button"
                  disabled={!customLabel.trim()}
                  onClick={() => addMut.mutate({ date: picker.date, meal: picker.meal, recipeId: null, label: customLabel.trim() })}
                  className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
                  style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Jewel-Osco checkout handoff ----------
// Jewel-Osco has no public API for other apps, so this is a handoff, not a
// sync: the cart is built here from the shopping list (or straight from a
// recipe), then Liz opens Jewel-Osco's own site, signs in there — her
// password never comes into this app — and reviews and pays there herself.

function JewelShop({ uncheckedCount }: { uncheckedCount: number }) {
  const queryClient = useQueryClient();
  const shopQ = useQuery({ queryKey: ["shop"], queryFn: () => api.getShop({}) });
  const [storeName, setStoreName] = useState("");
  const [storeLocation, setStoreLocation] = useState("");
  const [storeDirty, setStoreDirty] = useState(false);
  const [cart, setCart] = useState<JewelOrder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (shopQ.data && !storeDirty) {
      setStoreName(shopQ.data.storeName);
      setStoreLocation(shopQ.data.storeLocation);
    }
  }, [shopQ.data, storeDirty]);

  const invalidateShop = () => queryClient.invalidateQueries({ queryKey: ["shop"] });
  const saveStoreMut = useMutation({
    mutationFn: api.setStore,
    onSuccess: () => { invalidateShop(); setStoreDirty(false); setNotice("Store saved."); },
    onError: () => setNotice("The store could not be saved — try again."),
  });
  const buildMut = useMutation({
    mutationFn: () => api.buildJewelCart({ recipeId: null, servings: null }),
    onSuccess: (res) => {
      if (res.ok && res.order) {
        setCart(res.order);
        invalidateShop();
        setNotice(null);
      } else {
        setNotice(res.error ?? "That cart could not be built.");
      }
    },
    onError: () => setNotice("That cart could not be built — try again."),
  });
  const sentMut = useMutation({
    mutationFn: api.markJewelOrderSent,
    onSuccess: (res) => {
      invalidateShop();
      queryClient.invalidateQueries({ queryKey: ["grocery"] });
      setCart(null);
      setNotice(res.cleared > 0
        ? `Marked as ordered at ${storeName || "Jewel-Osco"} — and cleared those ${res.cleared} item${res.cleared === 1 ? "" : "s"} off this list.`
        : `Marked as ordered at ${storeName || "Jewel-Osco"}.`);
    },
    onError: () => setNotice("That could not be marked — try again."),
  });
  const deleteOrderMut = useMutation({
    mutationFn: api.deleteJewelOrder,
    onSuccess: (_res, vars) => {
      invalidateShop();
      setCart((c) => (c && c.id === vars.id ? null : c));
    },
  });

  const orders = shopQ.data?.orders ?? [];
  const shownCart = cart ?? orders.find((o) => o.status === "built") ?? null;
  const pastOrders = orders.filter((o) => o.id !== shownCart?.id);

  return (
    <section className="mt-4 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--herb)" }} aria-label="Shop at Jewel-Osco">
      <h2 className="font-display text-xl font-bold">🛒 Shop at {storeName || "Jewel-Osco"}</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Your store is {storeName || "Jewel-Osco"}{storeLocation ? ` in ${storeLocation}` : ""}. Jewel-Osco doesn’t offer
        other apps a way into its checkout, so Kitchen Companion builds your cart here — then you take it to
        Jewel-Osco’s own site, sign in with your own account there (your password never comes into this app),
        and review and pay there. The final checkout is always yours.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="store-name" className="text-xs font-semibold" style={{ color: "var(--dim)" }}>Store</label>
          <input
            id="store-name"
            type="text"
            value={storeName}
            onChange={(e) => { setStoreName(e.target.value); setStoreDirty(true); }}
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
        </div>
        <div>
          <label htmlFor="store-location" className="text-xs font-semibold" style={{ color: "var(--dim)" }}>Town</label>
          <input
            id="store-location"
            type="text"
            value={storeLocation}
            onChange={(e) => { setStoreLocation(e.target.value); setStoreDirty(true); }}
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
        </div>
      </div>
      {storeDirty && (
        <button
          type="button"
          disabled={!storeName.trim() || saveStoreMut.isPending}
          onClick={() => saveStoreMut.mutate({ storeName: storeName.trim(), storeLocation: storeLocation.trim() })}
          className="mt-2 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
          style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
        >
          Save store
        </button>
      )}

      <button
        type="button"
        disabled={uncheckedCount === 0 || buildMut.isPending}
        onClick={() => buildMut.mutate()}
        className="mt-3 w-full rounded-full py-3 text-base font-bold disabled:opacity-40"
        style={{ background: "var(--herb)", color: "#10240c" }}
      >
        {buildMut.isPending
          ? "Building your cart…"
          : uncheckedCount === 0
            ? "Add items to the list to build a Jewel-Osco cart"
            : `Build my Jewel-Osco cart (${uncheckedCount} item${uncheckedCount === 1 ? "" : "s"})`}
      </button>

      {shownCart && (
        <div className="mt-3 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
          <p className="text-sm font-semibold">
            {shownCart.storeName} list · {shownCart.itemCount} item{shownCart.itemCount === 1 ? "" : "s"} · built {new Date(shownCart.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </p>
          <div className="mt-2">
            <JewelHandoff
              order={shownCart}
              jewelUrl={shopQ.data?.jewelUrl ?? JEWEL_URL}
              ordering={sentMut.isPending}
              onOrdered={() => sentMut.mutate({ id: shownCart.id })}
            />
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>
            Marking it ordered here clears these items off your shopping list.
          </p>
        </div>
      )}

      {notice && <p className="mt-2 text-sm font-medium" style={{ color: "var(--herb)" }} role="status">{notice}</p>}

      {pastOrders.length > 0 && (
        <div className="mt-3">
          <h3 className="text-sm font-semibold" style={{ color: "var(--dim)" }}>Past Jewel-Osco carts</h3>
          <ul className="mt-1 space-y-1">
            {pastOrders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {new Date(o.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"} ·{" "}
                  <span style={{ color: o.status === "sent" ? "var(--herb)" : "var(--dim)" }}>
                    {o.status === "sent" ? "ordered ✓" : "built, not ordered"}
                  </span>
                </span>
                <span className="flex gap-1">
                  {o.status === "built" && (
                    <button
                      type="button"
                      onClick={() => setCart(o)}
                      className="rounded-full px-3 py-1 text-xs font-semibold"
                      style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Delete Jewel-Osco cart from ${new Date(o.createdAt).toLocaleDateString()}`}
                    onClick={() => deleteOrderMut.mutate({ id: o.id })}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-xs"
                    style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- grocery list ----------

const AISLE_ORDER = ["Produce", "Meat & seafood", "Dairy & eggs", "Bakery & bread", "Frozen", "Pantry", "Spices & baking", "Other"];

function GroceryList() {
  const queryClient = useQueryClient();
  const [newItem, setNewItem] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const groceryQ = useQuery({ queryKey: ["grocery"], queryFn: () => api.listGrocery({}) });
  const items = groceryQ.data?.items ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["grocery"] });
  const addMut = useMutation({
    mutationFn: api.addGroceryItem,
    onSuccess: () => { invalidate(); setNewItem(""); },
  });
  const checkMut = useMutation({ mutationFn: api.setGroceryChecked, onSuccess: invalidate });
  const removeMut = useMutation({ mutationFn: api.removeGroceryItem, onSuccess: invalidate });
  const clearMut = useMutation({ mutationFn: () => api.clearCheckedGrocery({}), onSuccess: invalidate });

  const byAisle = useMemo(() => {
    const map = new Map<string, GroceryItem[]>();
    for (const item of items) {
      const arr = map.get(item.aisle) ?? [];
      arr.push(item);
      map.set(item.aisle, arr);
    }
    return AISLE_ORDER.filter((a) => map.has(a)).map((a) => ({ aisle: a, items: map.get(a) ?? [] }));
  }, [items]);

  const checkedCount = items.filter((i) => i.checked).length;

  const shareList = async () => {
    const text = ["Shopping list", "", ...items.filter((i) => !i.checked).map((i) => `- ${i.detail ? `${i.detail} ` : ""}${i.name}`)].join("\n");
    const res = await shareOut("Shopping list", text);
    setNotice(res === "shared" ? "List shared!" : res === "copied" ? "List copied — paste it anywhere to share it." : "Sharing is not available here right now.");
  };

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">Shopping list</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Built from your recipes, duplicates added together and sorted by aisle — plus anything you add yourself.
      </p>

      <JewelShop uncheckedCount={items.filter((i) => !i.checked).length} />

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newItem.trim()) addMut.mutate({ name: newItem.trim(), detail: "" });
        }}
      >
        <label htmlFor="new-grocery" className="sr-only">Add an item</label>
        <input
          id="new-grocery"
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder="Add an item — milk, bin bags…"
          className="flex-1 rounded-lg px-3 py-2.5 text-base outline-none"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        <button type="submit" disabled={!newItem.trim()} className="rounded-full px-5 py-2.5 font-semibold disabled:opacity-40" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
          Add
        </button>
      </form>

      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={shareList} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
            ↗ Share the list
          </button>
          {checkedCount > 0 && (
            <button type="button" onClick={() => clearMut.mutate()} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
              Clear {checkedCount} ticked item{checkedCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
      {notice && <p className="mt-2 text-sm font-medium" style={{ color: "var(--herb)" }} role="status">{notice}</p>}

      {groceryQ.isPending && <p className="mt-8 text-center" style={{ color: "var(--dim)" }}>Getting your list…</p>}

      {!groceryQ.isPending && items.length === 0 && (
        <div className="mt-8 rounded-[var(--radius)] px-5 py-8 text-center" style={{ background: "var(--surface)", border: "1px dashed var(--border)" }}>
          <p className="text-4xl" aria-hidden>🧺</p>
          <h2 className="font-display mt-3 text-xl font-bold">Nothing to buy yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--dim)" }}>
            Open a recipe and tap “Add to shopping list”, plan a week and make its list in one tap,
            or just type items above.
          </p>
        </div>
      )}

      {byAisle.map(({ aisle, items: aisleItems }) => (
        <section key={aisle} className="mt-5" aria-label={aisle}>
          <h2 className="font-display text-base font-bold" style={{ color: "var(--dim)" }}>{aisle}</h2>
          <ul className="mt-1 divide-y rounded-[var(--radius)]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {aisleItems.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-3 py-1.5">
                <label className="flex flex-1 cursor-pointer items-center gap-3 py-1">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => checkMut.mutate({ id: item.id, checked: !item.checked })}
                    aria-label={`Tick off ${item.name}`}
                    className="h-5 w-5 shrink-0 accent-[#e4572e]"
                  />
                  <span className={item.checked ? "line-through opacity-50" : ""}>
                    {item.detail && <span className="font-semibold">{item.detail} </span>}
                    {item.name}
                  </span>
                </label>
                <button
                  type="button"
                  aria-label={`Remove ${item.name} from the list`}
                  onClick={() => removeMut.mutate({ id: item.id })}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-sm"
                  style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
