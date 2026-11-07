import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, bytesToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Recipe = ApiResponse<typeof api, "listRecipes">["recipes"][number];
type Collection = ApiResponse<typeof api, "listCollections">["collections"][number];
type Draft = ApiResponse<typeof api, "importUrl">["draft"];
type GroceryItem = ApiResponse<typeof api, "listGrocery">["items"][number];
type JewelOrder = ApiResponse<typeof api, "getShop">["orders"][number];
type PlanEntry = ApiResponse<typeof api, "listPlan">["entries"][number];

type Tab = "recipes" | "add" | "plan" | "shop";
type View =
  | { kind: "main" }
  | { kind: "recipe"; id: number }
  | { kind: "review"; draft: NonNullable<Draft>; editingId: number | null; previewUrl: string | null };

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
// (page title: "Grocery Delivery Near You - Order Groceries Online | Jewel-Osco").
const JEWEL_URL = "http://jewelosco.com/";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
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

/** Downscales a photo to a JPEG (max 1600px) and returns base64 — the size the scanner works best with. */
async function photoToBase64(file: File): Promise<{ dataBase64: string; mimeType: "image/jpeg" | "image/png"; previewUrl: string }> {
  const previewUrl = URL.createObjectURL(file);
  if (file.type === "image/png" && file.size < 1_500_000) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return { dataBase64: bytesToBase64(buf), mimeType: "image/png", previewUrl };
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image load failed"));
    img.src = previewUrl;
  });
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("canvas unavailable");
  ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataBase64: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg", previewUrl };
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

  const recipesQ = useQuery({ queryKey: ["recipes"], queryFn: () => api.listRecipes({}) });
  const collectionsQ = useQuery({ queryKey: ["collections"], queryFn: () => api.listCollections({}) });
  const recipes = recipesQ.data?.recipes ?? [];
  const collections = collectionsQ.data?.collections ?? [];

  const openRecipe = (id: number) => setView({ kind: "recipe", id });
  const openReview = (draft: NonNullable<Draft>, editingId: number | null, previewUrl: string | null) =>
    setView({ kind: "review", draft, editingId, previewUrl });

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
                  sourceUrl: r.sourceUrl,
                  sourceName: r.sourceName,
                  sourcePhotoKey: r.sourcePhotoKey,
                  scanPhotoKey: r.scanPhotoKey,
                  attachmentName: r.attachmentName,
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
            onOpen={openRecipe}
            onAdd={() => setTab("add")}
          />
        ) : tab === "add" ? (
          <AddRecipe onReview={openReview} />
        ) : tab === "plan" ? (
          <Planner recipes={recipes} onOpen={openRecipe} />
        ) : (
          <GroceryList />
        )}
      </main>

      {view.kind === "main" && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t pb-safe"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          aria-label="Main"
        >
          <div className="mx-auto grid max-w-3xl grid-cols-4">
            {(
              [
                ["recipes", "📖", "Recipes"],
                ["add", "＋", "Add"],
                ["plan", "🗓", "Plan"],
                ["shop", "🛒", "Shop"],
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
  recipes, collections, loading, error, onOpen, onAdd,
}: {
  recipes: Recipe[];
  collections: Collection[];
  loading: boolean;
  error: string | null;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [fridge, setFridge] = useState("");
  const queryClient = useQueryClient();
  const favMut = useMutation({
    mutationFn: (args: { id: number; favorite: boolean }) => api.setFavorite(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  });

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
  }, [recipes, filter, collectionId, query, fridgeTokens]);

  return (
    <div>
      <h1 className="font-display text-3xl font-bold">My Recipes</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        {recipes.length === 0
          ? "Your own cookbook — every recipe you save lives here, not on a pin board."
          : `${recipes.length} recipe${recipes.length === 1 ? "" : "s"} saved`}
      </p>

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

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filters">
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
                {photo ? (
                  <img src={photo} alt="" className="aspect-[4/3] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[4/3] w-full items-center justify-center text-4xl" style={{ background: "var(--surface2)" }} aria-hidden>
                    🍽️
                  </div>
                )}
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

      {recipes.length > 0 && <BackupBar recipes={recipes} collections={collections} />}
    </div>
  );
}

function BackupBar({ recipes, collections }: { recipes: Recipe[]; collections: Collection[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const doExport = async () => {
    setBusy(true);
    try {
      const data = await api.exportLibrary({});
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kitchen-companion-backup-${localDateStr(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg("Backup saved. Keep it somewhere safe — your recipes are yours, and this file proves it.");
    } catch {
      setMsg("The backup could not be made just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const obj = parsed as { collections?: unknown; recipes?: unknown };
      const result = await api.importBackup({
        collections: Array.isArray(obj.collections) ? (obj.collections as Array<{ name: string }>) : [],
        recipes: Array.isArray(obj.recipes) ? (obj.recipes as never[]) : [],
      });
      setMsg(`Restored ${result.imported} recipe${result.imported === 1 ? "" : "s"}${result.skipped > 0 ? ` (${result.skipped} already in your library, skipped)` : ""}.`);
      queryClient.invalidateQueries({ queryKey: ["recipes"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    } catch {
      setMsg("That file could not be read as a Kitchen Companion backup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="font-display text-base font-bold">Your backup</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
        Download your whole collection as one file, any time. If this app ever went away, your
        recipes would still be yours — {recipes.length} recipe{recipes.length === 1 ? "" : "s"} in {collections.length} collection{collections.length === 1 ? "" : "s"}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={doExport} disabled={busy} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
          Download backup
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)" }}>
          Restore from backup
        </button>
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
      {msg && <p className="mt-2 text-sm" style={{ color: "var(--herb)" }} role="status">{msg}</p>}
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
  const jewelMut = useMutation({
    mutationFn: api.buildJewelCart,
    onSuccess: (res) => {
      if (res.ok && res.order) {
        setJewelOrder(res.order);
        queryClient.invalidateQueries({ queryKey: ["shop"] });
      } else {
        setNotice(res.error ?? "That cart could not be built.");
      }
    },
    onError: () => setNotice("That cart could not be built. Try again from the Shop tab."),
  });
  const planMut = useMutation({
    mutationFn: api.addPlanEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      setNotice(`Planned for ${prettyDate(planDate)} (${planMeal}).`);
    },
  });
  const updateMut = useMutation({ mutationFn: api.updateRecipe, onSuccess: invalidate });

  useEffect(() => {
    setTargetServings(recipe?.servings ?? null);
    setCheckedIng(new Set());
    setCheckedSteps(new Set());
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

  const baseServings = recipe.servings ?? targetServings ?? 1;
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
        sourceUrl: recipe.sourceUrl,
        sourceName: recipe.sourceName,
        collectionId: recipe.collectionId,
        notes: recipe.notes,
        dishPhotoKey: stored.key,
        scanPhotoKey: recipe.scanPhotoKey,
        sourcePhotoKey: recipe.sourcePhotoKey,
        attachmentName: recipe.attachmentName,
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

      {heroPhoto ? (
        <img src={heroPhoto} alt={recipe.dishPhotoUrl ? `Your photo of ${recipe.title}, cooked` : recipe.title} className="mt-3 aspect-[16/10] w-full rounded-[var(--radius)] object-cover" />
      ) : (
        <div className="mt-3 flex aspect-[16/10] w-full flex-col items-center justify-center rounded-[var(--radius)]" style={{ background: "var(--surface2)" }}>
          <span className="text-5xl" aria-hidden>🍽️</span>
          <p className="mt-2 px-6 text-center text-sm" style={{ color: "var(--dim)" }}>No photo yet — add yours when you cook it.</p>
        </div>
      )}
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
          {jewelMut.isPending ? "Building your Jewel-Osco cart…" : "🛒 Shop this recipe at Jewel-Osco"}
        </button>
      </div>

      {jewelOrder && (
        <div className="mt-3 rounded-[var(--radius)] px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--herb)" }} role="status">
          <p className="text-sm font-semibold">Your {jewelOrder.storeName} cart is built — {jewelOrder.itemCount} item{jewelOrder.itemCount === 1 ? "" : "s"} for {shownServings} serving{shownServings === 1 ? "" : "s"}.</p>
          <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
            Jewel-Osco checkout happens on Jewel-Osco’s own site, in your own account — you sign in there and pay there. Take the cart with you:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={JEWEL_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              Open Jewel-Osco ↗
            </a>
            <button
              type="button"
              onClick={async () => {
                const res = await copyText(jewelOrder.cartText);
                setNotice(res ? "Cart copied — paste it into Jewel-Osco search, item by item." : "Copying is not available here right now.");
              }}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
            >
              Copy the cart
            </button>
            <button type="button" onClick={onGoShop} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>
              See it on the Shop tab →
            </button>
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
          <img src={recipe.scanPhotoUrl} alt="The original scanned recipe page" className="mt-2 w-full rounded-[var(--radius)]" style={{ border: "1px solid var(--border)" }} />
        </section>
      )}
      {recipe.attachmentName && (
        <p className="mt-4 text-sm" style={{ color: "var(--dim)" }}>📎 Original file kept with this recipe: {recipe.attachmentName}</p>
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

function AddRecipe({ onReview }: { onReview: (draft: NonNullable<Draft>, editingId: number | null, previewUrl: string | null) => void }) {
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
      const { dataBase64, mimeType, previewUrl } = await photoToBase64(file);
      const res = await api.scanImage({ dataBase64, mimeType });
      if (res.draft) onReview(res.draft, null, previewUrl);
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
      void stored;
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
          sourceUrl: null,
          sourceName: file.name,
          sourcePhotoKey: null,
          scanPhotoKey: null,
          attachmentName: file.name,
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
    sourceUrl: null,
    sourceName: null,
    sourcePhotoKey: null,
    scanPhotoKey: null,
    attachmentName: null,
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

      <section className="mt-5 rounded-[var(--radius)] px-4 py-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} aria-label="Save from a link">
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
          types it up for you to check — and keeps your photo attached as the original.
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
  draft, editingId, previewUrl, collections, recipes, onDone, onCancel,
}: {
  draft: NonNullable<Draft>;
  editingId: number | null;
  previewUrl: string | null;
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
        sourceUrl: draft.sourceUrl,
        sourceName: draft.sourceName,
        collectionId,
        notes: editingRecipe ? notes || editingRecipe.notes : notes,
        dishPhotoKey,
        scanPhotoKey: draft.scanPhotoKey ?? editingRecipe?.scanPhotoKey ?? null,
        sourcePhotoKey: draft.sourcePhotoKey ?? editingRecipe?.sourcePhotoKey ?? null,
        attachmentName: draft.attachmentName ?? editingRecipe?.attachmentName ?? null,
      };
      if (editingId != null) {
        await api.updateRecipe({ id: editingId, ...payload });
        return editingId;
      }
      const created = await api.createRecipe(payload);
      return created.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["recipes"] });
      onDone(id);
    },
    onError: () => setError("That recipe could not be saved. Your words are still here — try again."),
  });

  useEffect(() => {
    if (editingId != null && editingRecipe) setNotes(editingRecipe.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    const t = title.trim().toLowerCase();
    if (!t || editingId != null) { setDupWarning(null); return; }
    const dup = recipes.find((r) => r.title.trim().toLowerCase() === t);
    setDupWarning(dup ? `Heads up: you already have a recipe called “${dup.title}”. Saving will keep both.` : null);
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
            {shownCart.storeName} cart · {shownCart.itemCount} item{shownCart.itemCount === 1 ? "" : "s"} · built {new Date(shownCart.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-sm">
            {shownCart.items.map((i, idx) => (
              <li key={idx}>{i.detail && <span className="font-semibold">{i.detail} </span>}{i.name}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={shopQ.data?.jewelUrl ?? JEWEL_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              Open Jewel-Osco & check out ↗
            </a>
            <button
              type="button"
              onClick={async () => {
                const ok = await copyText(shownCart.cartText);
                setNotice(ok ? "Cart copied — paste it into Jewel-Osco, or keep it as your in-store list." : "Copying is not available here right now.");
              }}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              Copy the cart
            </button>
            <button
              type="button"
              disabled={sentMut.isPending}
              onClick={() => sentMut.mutate({ id: shownCart.id })}
              className="rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ background: "var(--surface)", border: "1px solid var(--herb)", color: "var(--herb)" }}
            >
              ✓ I ordered this at Jewel-Osco
            </button>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>
            On Jewel-Osco’s site: sign in, search each item, add it to your cart, pick pickup or delivery, and pay.
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
