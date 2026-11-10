// Kitchen Companion actions: recipe library, collections, imports
// (link / scan / file / pasted text — one pipeline onto a review screen),
// meal planner, and grocery list.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared shapes ----------

const draftShape = {
  title: z.string().min(1),
  description: z.string().default(""),
  servings: z.number().int().positive().nullable().default(null),
  prepMinutes: z.number().int().nonnegative().nullable().default(null),
  cookMinutes: z.number().int().nonnegative().nullable().default(null),
  ingredients: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  course: z.string().nullable().default(null),
  protein: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  collectionId: z.number().int().nullable().default(null),
  notes: z.string().default(""),
  dishPhotoKey: z.string().nullable().default(null),
  scanPhotoKey: z.string().nullable().default(null),
  sourcePhotoKey: z.string().nullable().default(null),
  attachmentName: z.string().nullable().default(null),
  attachmentKey: z.string().nullable().default(null),
};

const recipeDto = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  servings: z.number().nullable(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  tags: z.array(z.string()),
  course: z.string().nullable(),
  protein: z.string().nullable(),
  timeTag: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  collectionId: z.number().nullable(),
  favorite: z.boolean(),
  rating: z.number().nullable(),
  status: z.enum(["want", "made"]),
  cookCount: z.number(),
  lastCookedAt: z.string().nullable(),
  notes: z.string(),
  dishPhotoKey: z.string().nullable(),
  scanPhotoKey: z.string().nullable(),
  sourcePhotoKey: z.string().nullable(),
  dishPhotoUrl: z.string().nullable(),
  scanPhotoUrl: z.string().nullable(),
  sourcePhotoUrl: z.string().nullable(),
  attachmentName: z.string().nullable(),
  attachmentKey: z.string().nullable(),
  attachmentUrl: z.string().nullable(),
  createdAt: z.string(),
});

type RecipeRow = typeof schema.recipes.$inferSelect;

function parseJsonArray(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Resolving one photo link must never fail the whole recipe list: if a
// stored photo's link cannot be resolved (missing/unreadable blob), that
// recipe simply renders without a photo instead of the entire library
// erroring out — the failure mode behind "the images are failing to load".
async function safePhotoUrl(ctx: Ctx, key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await ctx.blobs.getUrl(key);
  } catch {
    return null;
  }
}

// ---------- backup: photos and files travel WITH the recipes ----------
// Backup format v1 (up to v1.2.0) exported recipe TEXT only — the photos
// were left behind in blob storage, so a restore brought back recipes with
// no pictures. That is the gap Anthony flagged ("those cannot be lost
// ever"). Format v2 embeds every photo/file a recipe owns — finished-dish
// photo, scanned page, source photo, attached original — as base64 inside
// the backup itself, and restore writes them back into blob storage.
// Verified live in the sandbox (Nov 9, 2026): ctx.blobs has no byte-read
// and its URLs are app-relative, so the server cannot fetch photo bytes
// back — the CLIENT assembles backups (it can fetch the photo URLs in the
// browser) and hands the complete payload to the server for download or
// for storing as an automatic snapshot. A photo the client cannot fetch
// is counted (photosUnreadable) and reported, never silently dropped.

const photoAsset = z.object({ mimeType: z.string(), dataBase64: z.string() });
type PhotoAsset = z.infer<typeof photoAsset>;

async function storeBlobAsset(
  ctx: Ctx,
  asset: PhotoAsset | null | undefined,
  prefix: string,
): Promise<string | null> {
  if (!asset) return null;
  try {
    const bytes = Uint8Array.from(atob(asset.dataBase64), (c) => c.charCodeAt(0));
    if (bytes.length === 0 || bytes.length > 12_000_000) return null;
    const key = `${prefix}/${crypto.randomUUID()}`;
    await ctx.blobs.put(key, bytes, { contentType: asset.mimeType });
    return key;
  } catch {
    return null;
  }
}

// ---------- automatic categories ----------
// Liz asked (Nov 9, 2026) for recipes to categorise themselves: a course
// (appetizers, main dishes, desserts…), a protein/type (poultry, beef…),
// and a time band (under 30 minutes…). Course and protein are chosen by the
// model when a recipe is added — with a plain keyword fallback so a recipe
// is never left uncategorised — and the cook can correct either one. The
// time band is derived from prep + cook minutes wherever it is shown.

export const COURSES = [
  "Appetizers",
  "Main Dishes",
  "Side Dishes",
  "Soups & Salads",
  "Desserts",
  "Breakfast",
  "Snacks",
  "Drinks",
] as const;

export const PROTEINS = [
  "Poultry",
  "Beef",
  "Pork",
  "Seafood",
  "Lamb & Game",
  "Vegetarian",
  "Other",
] as const;

function timeBand(prepMinutes: number | null, cookMinutes: number | null): string | null {
  const total = (prepMinutes ?? 0) + (cookMinutes ?? 0);
  if (total <= 0) return null;
  if (total < 30) return "Under 30 minutes";
  if (total <= 60) return "30–60 minutes";
  return "Over an hour";
}

function asCourse(v: string | null | undefined): string | null {
  if (!v) return null;
  const hit = COURSES.find((c) => c.toLowerCase() === v.trim().toLowerCase());
  return hit ?? null;
}

function asProtein(v: string | null | undefined): string | null {
  if (!v) return null;
  const hit = PROTEINS.find((p) => p.toLowerCase() === v.trim().toLowerCase());
  return hit ?? null;
}

// Deterministic fallback, used when the model is unavailable and to fill
// categories on recipes saved before categorisation existed.
function keywordCategories(title: string, ingredients: string[]): { course: string; protein: string } {
  const hay = `${title} ${ingredients.join(" ")}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));

  let protein: string = "Other";
  if (has("chicken", "turkey", "duck", "poultry", "cornish hen")) protein = "Poultry";
  else if (has("shrimp", "prawn", "salmon", "tuna", "fish", "cod", "tilapia", "halibut", "crab", "scallop", "clam", "mussel", "oyster", "lobster", "anchov", "sea bass", "trout", "catfish", "seafood")) protein = "Seafood";
  else if (has("beef", "steak", "brisket", "chuck roast", "ground beef", "veal")) protein = "Beef";
  else if (has("pork", "bacon", "ham", "sausage", "kielbasa", "bratwurst", "salami", "pepperoni", "prosciutto", "pancetta", "chorizo")) protein = "Pork";
  else if (has("lamb", "venison", "rabbit", "goat")) protein = "Lamb & Game";
  else if (!has("meat", "broth", "stock", "gelatin")) protein = "Vegetarian";

  const t = title.toLowerCase();
  let course: string = "Main Dishes";
  if (/\b(cake|cookie|brownie|pie|pudding|ice cream|sorbet|gelato|mousse|cheesecake|cobbler|crisp|custard|fudge|cupcake|tiramisu|panna cotta|trifle|dessert|sundae)\b/.test(t)) course = "Desserts";
  else if (/\b(soup|salad|slaw|gazpacho|chowder|bisque|stew)\b/.test(t)) course = "Soups & Salads";
  else if (/\b(pancake|waffle|omelet|omelette|frittata|french toast|breakfast|brunch|scrambled|quiche)\b/.test(t)) course = "Breakfast";
  else if (/\b(dip|spread|bruschetta|crostini|appetizer|starter|hors d|pâté|pate|hummus|guacamole|salsa|wings|nachos|quesadilla|spring roll|deviled)\b/.test(t)) course = "Appetizers";
  else if (/\b(smoothie|lemonade|cocktail|punch|shake|latte|mojito|margarita|sangria|drink)\b/.test(t)) course = "Drinks";
  else if (/\b(side dish|rice pilaf|stuffing|coleslaw|glazed carrots|green beans|cornbread)\b/.test(t)) course = "Side Dishes";
  else if (/\b(snack|granola|trail mix|popcorn|energy ball|bites)\b/.test(t)) course = "Snacks";

  return { course, protein };
}

const categorizeSchema = z.object({
  course: z.enum(COURSES),
  protein: z.enum(PROTEINS),
});

// Picks the categories for a recipe being added. The model reads the title
// and ingredients; if it is unavailable, keyword rules fill in so the
// recipe still lands categorised. Never throws.
async function autoCategorize(
  ctx: Ctx,
  input: { title: string; description: string; ingredients: string[]; prepMinutes: number | null; cookMinutes: number | null },
): Promise<{ course: string; protein: string }> {
  const fallback = keywordCategories(input.title, input.ingredients);
  try {
    const total = (input.prepMinutes ?? 0) + (input.cookMinutes ?? 0);
    const result = await ctx.inference.complete(
      [
        `Recipe title: ${input.title}`,
        input.description ? `Description: ${input.description}` : "",
        total > 0 ? `Total time: about ${total} minutes.` : "",
        "Ingredients:",
        ...input.ingredients.slice(0, 40).map((i) => `- ${i}`),
        "",
        "Choose the single best course for this recipe (what part of a meal it is) and the single best protein/type (its main protein; Vegetarian when it has no meat or seafood).",
      ].filter(Boolean).join("\n"),
      { schema: categorizeSchema, system: "You categorise recipes for a home cookbook." },
    );
    return { course: result.course, protein: result.protein };
  } catch {
    return fallback;
  }
}

async function toDto(ctx: Ctx, row: RecipeRow): Promise<z.infer<typeof recipeDto>> {
  const [dishPhotoUrl, scanPhotoUrl, sourcePhotoUrl, attachmentUrl] = await Promise.all([
    safePhotoUrl(ctx, row.dishPhotoKey),
    safePhotoUrl(ctx, row.scanPhotoKey),
    safePhotoUrl(ctx, row.sourcePhotoKey),
    safePhotoUrl(ctx, row.attachmentKey),
  ]);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    servings: row.servings,
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    ingredients: parseJsonArray(row.ingredients),
    steps: parseJsonArray(row.steps),
    tags: parseJsonArray(row.tags),
    course: row.course,
    protein: row.protein,
    timeTag: timeBand(row.prepMinutes, row.cookMinutes),
    sourceUrl: row.sourceUrl,
    sourceName: row.sourceName,
    collectionId: row.collectionId,
    favorite: row.favorite === 1,
    rating: row.rating,
    status: row.status,
    cookCount: row.cookCount,
    lastCookedAt: row.lastCookedAt,
    notes: row.notes,
    dishPhotoKey: row.dishPhotoKey,
    scanPhotoKey: row.scanPhotoKey,
    sourcePhotoKey: row.sourcePhotoKey,
    dishPhotoUrl,
    scanPhotoUrl,
    sourcePhotoUrl,
    attachmentName: row.attachmentName,
    attachmentKey: row.attachmentKey,
    attachmentUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ---------- import helpers ----------

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function fetchText(url: string): Promise<{ ok: boolean; text: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function parseDurationMinutes(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const m = iso.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const days = parseFloat(m[1] ?? "0");
  const hours = parseFloat(m[2] ?? "0");
  const mins = parseFloat(m[3] ?? "0");
  const secs = parseFloat(m[4] ?? "0");
  const total = days * 1440 + hours * 60 + mins + secs / 60;
  return total > 0 ? Math.round(total) : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function flattenInstructions(v: unknown): string[] {
  if (typeof v === "string") {
    return v.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      out.push(...flattenInstructions(item));
    }
    return out;
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === "string") return [obj.text.trim()];
    if ("itemListElement" in obj) return flattenInstructions(obj.itemListElement);
  }
  return [];
}

function findRecipeNode(node: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")) return obj;
  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    if (key in obj) {
      const found = findRecipeNode(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function recipeFromJsonLd(html: string): Record<string, unknown> | null {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    const raw = block[1];
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      const found = findRecipeNode(parsed, 0);
      if (found) return found;
    } catch {
      // not valid JSON — keep looking
    }
  }
  return null;
}

function imageUrlFrom(node: Record<string, unknown>): string | null {
  const img = node.image;
  if (typeof img === "string" && img.startsWith("http")) return img;
  if (Array.isArray(img)) {
    for (const item of img) {
      const u = imageUrlFrom({ image: item });
      if (u) return u;
    }
    return null;
  }
  if (img && typeof img === "object") {
    const url = (img as Record<string, unknown>).url;
    if (typeof url === "string" && url.startsWith("http")) return url;
  }
  return null;
}

function servingsFrom(node: Record<string, unknown>): number | null {
  const y = node.recipeYield;
  const first = Array.isArray(y) ? y[0] : y;
  if (typeof first === "number" && first > 0) return Math.round(first);
  if (typeof first === "string") {
    const m = first.match(/\d+(?:\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0]);
      if (n > 0) return Math.round(n);
    }
  }
  return null;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const inferenceDraftSchema = z.object({
  title: z.string(),
  description: z.string(),
  servings: z.number().nullable(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  tags: z.array(z.string()),
  course: z.enum(COURSES).nullable(),
  protein: z.enum(PROTEINS).nullable(),
});

// The scanner also reports how the photographed page sits in the photo, so
// a page photographed upside down or sideways can be turned right-side up
// automatically (the client rotates the stored photo by this many degrees).
const scanDraftSchema = inferenceDraftSchema.extend({
  pageNeedsRotation: z.enum(["none", "90", "180", "270"]),
});

type InferenceDraft = z.infer<typeof inferenceDraftSchema>;

function cleanDraft(d: InferenceDraft) {
  return {
    title: d.title.trim() || "Untitled recipe",
    description: d.description.trim(),
    servings: d.servings != null && d.servings > 0 ? Math.round(d.servings) : null,
    prepMinutes: d.prepMinutes != null && d.prepMinutes >= 0 ? Math.round(d.prepMinutes) : null,
    cookMinutes: d.cookMinutes != null && d.cookMinutes >= 0 ? Math.round(d.cookMinutes) : null,
    ingredients: d.ingredients.map((s) => s.trim()).filter(Boolean),
    steps: d.steps.map((s) => s.trim()).filter(Boolean),
    tags: d.tags.map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8),
    course: asCourse(d.course),
    protein: asProtein(d.protein),
  };
}

async function downloadImageToBlob(ctx: Ctx, url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.startsWith("image/")) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > 6_000_000) return null;
      const key = `src/${crypto.randomUUID()}`;
      await ctx.blobs.put(key, buf, { contentType: ct.split(";")[0] ?? "image/jpeg" });
      return key;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// ---------- grocery helpers ----------

const UNICODE_FRAC: Record<string, number> = {
  "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

const UNITS = [
  "tablespoons", "tablespoon", "tbsp", "teaspoons", "teaspoon", "tsp",
  "cups", "cup", "ounces", "ounce", "oz", "pounds", "pound", "lbs", "lb",
  "grams", "gram", "g", "kg", "ml", "liters", "liter", "l",
  "cans", "can", "cloves", "clove", "bunches", "bunch", "pinches", "pinch",
  "packages", "package", "pkg", "boxes", "box", "bags", "bag", "heads", "head",
  "stalks", "stalk", "slices", "slice", "pieces", "piece",
];

function parseIngredient(line: string): { qty: number | null; unit: string; name: string } {
  let rest = line.trim();
  let qty: number | null = null;
  const mixed = rest.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*/);
  const frac = rest.match(/^(\d+)\s*\/\s*(\d+)\s*/);
  const plain = rest.match(/^(\d+(?:\.\d+)?)\s*/);
  const uni = rest.match(/^(\d+)?\s*([½¼¾⅓⅔⅛⅜⅝⅞])\s*/);
  if (mixed && mixed[1] && mixed[2] && mixed[3]) {
    qty = parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    rest = rest.slice(mixed[0].length);
  } else if (frac && frac[1] && frac[2]) {
    qty = parseInt(frac[1], 10) / parseInt(frac[2], 10);
    rest = rest.slice(frac[0].length);
  } else if (uni && uni[2] && UNICODE_FRAC[uni[2]] != null) {
    qty = (uni[1] ? parseInt(uni[1], 10) : 0) + (UNICODE_FRAC[uni[2]] ?? 0);
    rest = rest.slice(uni[0].length);
  } else if (plain && plain[1]) {
    qty = parseFloat(plain[1]);
    rest = rest.slice(plain[0].length);
  }
  let unit = "";
  const lower = rest.toLowerCase();
  for (const u of UNITS) {
    if (lower === u || lower.startsWith(u + " ") || lower.startsWith(u + "s ")) {
      unit = u;
      rest = rest.slice(u.length).trim();
      break;
    }
  }
  rest = rest.replace(/^of\s+/i, "").trim();
  // Drop trailing prep notes after a comma for the list name, keep them out.
  const name = (rest.split(",")[0] ?? rest).trim() || line.trim();
  return { qty, unit, name };
}

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

const AISLES: Array<{ aisle: string; words: string[] }> = [
  { aisle: "Produce", words: ["tomato", "onion", "garlic", "lemon", "lime", "spinach", "lettuce", "potato", "carrot", "pepper", "cucumber", "avocado", "apple", "banana", "herb", "parsley", "cilantro", "basil", "ginger", "mushroom", "zucchini", "broccoli", "cauliflower", "celery", "corn", "bean sprout", "scallion", "green onion", "jalape", "berries", "berry", "orange", "peach", "melon", "cabbage", "kale", "chard", "leek", "shallot", "squash", "eggplant", "asparagus", "artichoke"] },
  { aisle: "Meat & seafood", words: ["chicken", "beef", "pork", "salmon", "shrimp", "bacon", "sausage", "turkey", "lamb", "fish", "tilapia", "cod", "tuna steak", "ground", "steak", "ham", "prosciutto", "salami", "crab", "scallop"] },
  { aisle: "Dairy & eggs", words: ["milk", "cheese", "butter", "egg", "cream", "yogurt", "sour cream", "mozzarella", "parmesan", "cheddar", "ricotta", "cottage", "half and half", "whipping"] },
  { aisle: "Bakery & bread", words: ["bread", "tortilla", "bun", "roll", "baguette", "pita", "naan", "croissant", "muffin", "pie crust", "pizza dough"] },
  { aisle: "Frozen", words: ["frozen", "ice cream", "peas (frozen"] },
  { aisle: "Spices & baking", words: ["flour", "sugar", "baking powder", "baking soda", "cinnamon", "cumin", "paprika", "oregano", "thyme", "rosemary", "nutmeg", "vanilla", "cocoa", "chili powder", "curry", "salt", "black pepper", "yeast", "cornstarch", "brown sugar", "powdered sugar", "spice"] },
  { aisle: "Pantry", words: ["rice", "pasta", "spaghetti", "noodle", "oil", "vinegar", "sauce", "broth", "stock", "can", "beans", "lentil", "quinoa", "oat", "peanut butter", "honey", "maple", "soy sauce", "ketchup", "mustard", "mayonnaise", "salsa", "coconut milk", "breadcrumb", "cracker", "cereal"] },
];

function guessAisle(name: string): string {
  const lower = name.toLowerCase();
  for (const { aisle, words } of AISLES) {
    if (words.some((w) => lower.includes(w))) return aisle;
  }
  return "Other";
}

// ---------- Jewel-Osco helpers (hoisted; used by the shop actions above) ----------

// Jewel-Osco's official online ordering homepage — verified by opening it
// (final URL https://www.jewelosco.com/, page title: "Grocery Delivery Near
// You - Order Groceries Online | Jewel-Osco"). The https://www form matters:
// the old http:// bare-domain link failed to open from inside the app on
// Liz's phone, which is why the handoff "didn't work" for her.
const JEWEL_URL = "https://www.jewelosco.com/";

const jewelOrderDto = z.object({
  id: z.number(),
  storeName: z.string(),
  storeLocation: z.string(),
  items: z.array(z.object({ name: z.string(), detail: z.string() })),
  itemCount: z.number(),
  status: z.enum(["built", "sent"]),
  cartText: z.string(),
  createdAt: z.string(),
});

type JewelOrderRow = typeof schema.jewelOrders.$inferSelect;

function parseCartItems(raw: string): Array<{ name: string; detail: string }> {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (typeof o.name === "string" && o.name.trim()) {
          return [{ name: o.name, detail: typeof o.detail === "string" ? o.detail : "" }];
        }
      }
      return [];
    });
  } catch {
    return [];
  }
}

function parseJsonIds(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function jewelCartText(storeName: string, storeLocation: string, items: Array<{ name: string; detail: string }>): string {
  const lines: string[] = [`${storeName} shopping list — from Kitchen Companion`];
  if (storeLocation) lines.push(`Store: ${storeLocation}`);
  lines.push("");
  for (const i of items) lines.push(`- ${i.detail ? `${i.detail} ` : ""}${i.name}`);
  return lines.join("\n");
}

function orderToDto(row: JewelOrderRow): z.infer<typeof jewelOrderDto> {
  const items = parseCartItems(row.items);
  return {
    id: row.id,
    storeName: row.storeName,
    storeLocation: row.storeLocation,
    items,
    itemCount: items.length,
    status: row.status,
    cartText: jewelCartText(row.storeName, row.storeLocation, items),
    createdAt: row.createdAt.toISOString(),
  };
}

async function getSetting(ctx: Ctx, key: string, fallback: string): Promise<string> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key));
  const value = rows[0]?.value.trim();
  return value ? value : fallback;
}

async function setSetting(ctx: Ctx, key: string, value: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
}

// ---------- full-fidelity backup payload (format v2) ----------
// exportLibrary produces the recipe/collection text; the client overlays
// each recipe's photos/files (fetched in the browser, embedded as data)
// to complete the payload. The same completed payload is what gets
// downloaded as the backup file and what saveAutoBackup stores as an
// automatic snapshot, so both copies are identical in content.

const backupRecipeShape = {
  id: z.number(),
  title: z.string(),
  description: z.string(),
  servings: z.number().nullable(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  tags: z.array(z.string()),
  course: z.string().nullable(),
  protein: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  collectionName: z.string().nullable(),
  favorite: z.boolean(),
  rating: z.number().nullable(),
  status: z.enum(["want", "made"]),
  cookCount: z.number(),
  lastCookedAt: z.string().nullable(),
  notes: z.string(),
  attachmentName: z.string().nullable(),
  dishPhoto: photoAsset.nullable(),
  scanPhoto: photoAsset.nullable(),
  sourcePhoto: photoAsset.nullable(),
  attachment: photoAsset.nullable(),
};

const backupPayloadSchema = z.object({
  version: z.number(),
  exportedAt: z.string(),
  photosUnreadable: z.number(),
  collections: z.array(z.object({ id: z.number(), name: z.string() })),
  recipes: z.array(z.object(backupRecipeShape)),
});
type BackupPayload = z.infer<typeof backupPayloadSchema>;

async function buildBackupPayload(ctx: Ctx): Promise<BackupPayload> {
  const db = ctx.db<typeof schema>();
  const collRows = await db.select().from(schema.collections).orderBy(asc(schema.collections.id));
  const collNames = new Map(collRows.map((c) => [c.id, c.name]));
  const rows = await db.select().from(schema.recipes).orderBy(asc(schema.recipes.id));
  const recipes: BackupPayload["recipes"] = [];
  for (const r of rows) {
    recipes.push({
      id: r.id,
      title: r.title,
      description: r.description,
      servings: r.servings,
      prepMinutes: r.prepMinutes,
      cookMinutes: r.cookMinutes,
      ingredients: parseJsonArray(r.ingredients),
      steps: parseJsonArray(r.steps),
      tags: parseJsonArray(r.tags),
      course: r.course,
      protein: r.protein,
      sourceUrl: r.sourceUrl,
      sourceName: r.sourceName,
      collectionName: r.collectionId != null ? (collNames.get(r.collectionId) ?? null) : null,
      favorite: r.favorite === 1,
      rating: r.rating,
      status: r.status,
      cookCount: r.cookCount,
      lastCookedAt: r.lastCookedAt,
      notes: r.notes,
      attachmentName: r.attachmentName,
      // Photo/file data is overlaid by the client, which is the side that
      // can fetch the bytes (see the backup note above).
      dishPhoto: null,
      scanPhoto: null,
      sourcePhoto: null,
      attachment: null,
    });
  }
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    photosUnreadable: 0,
    collections: collRows.map((c) => ({ id: c.id, name: c.name })),
    recipes,
  };
}

function countImportPhotos(recipes: ImportRecipe[]): number {
  return recipes.reduce(
    (n, r) => n + [r.dishPhoto, r.scanPhoto, r.sourcePhoto, r.attachment].filter(Boolean).length,
    0,
  );
}

// The import side, shared by "Restore from backup" (a file the user kept)
// and "Restore from automatic backup" (the newest in-app snapshot). Old
// format-v1 files carry no photos; their photo fields arrive as null and
// restore as photoless recipes, exactly as before.
const importRecipeSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  servings: z.number().int().positive().nullable().default(null),
  prepMinutes: z.number().int().nonnegative().nullable().default(null),
  cookMinutes: z.number().int().nonnegative().nullable().default(null),
  ingredients: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  course: z.string().nullable().default(null),
  protein: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  collectionName: z.string().nullable().default(null),
  favorite: z.boolean().default(false),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  status: z.enum(["want", "made"]).default("want"),
  cookCount: z.number().int().nonnegative().default(0),
  lastCookedAt: z.string().nullable().default(null),
  notes: z.string().default(""),
  attachmentName: z.string().nullable().default(null),
  dishPhoto: photoAsset.nullable().default(null),
  scanPhoto: photoAsset.nullable().default(null),
  sourcePhoto: photoAsset.nullable().default(null),
  attachment: photoAsset.nullable().default(null),
});
type ImportRecipe = z.infer<typeof importRecipeSchema>;

async function importLibraryData(
  ctx: Ctx,
  data: { collections: Array<{ name: string }>; recipes: ImportRecipe[] },
): Promise<{ imported: number; skipped: number; photosRestored: number }> {
  const db = ctx.db<typeof schema>();
  const existingColls = await db.select().from(schema.collections);
  const collIdByName = new Map(existingColls.map((c) => [c.name.toLowerCase(), c.id]));
  for (const c of data.collections) {
    const key = c.name.trim().toLowerCase();
    if (!key || collIdByName.has(key)) continue;
    const inserted = await db.insert(schema.collections)
      .values({ name: c.name.trim() })
      .returning({ id: schema.collections.id });
    const row = inserted[0];
    if (row) collIdByName.set(key, row.id);
  }
  const existingTitles = new Set(
    (await db.select({ title: schema.recipes.title }).from(schema.recipes))
      .map((r) => r.title.trim().toLowerCase()),
  );
  let imported = 0;
  let skipped = 0;
  let photosRestored = 0;
  for (const r of data.recipes) {
    const titleKey = r.title.trim().toLowerCase();
    if (existingTitles.has(titleKey)) { skipped++; continue; }
    existingTitles.add(titleKey);
    const cats = keywordCategories(r.title, r.ingredients);
    const [dishPhotoKey, scanPhotoKey, sourcePhotoKey, attachmentKey] = await Promise.all([
      storeBlobAsset(ctx, r.dishPhoto, "dish"),
      storeBlobAsset(ctx, r.scanPhoto, "scan"),
      storeBlobAsset(ctx, r.sourcePhoto, "src"),
      storeBlobAsset(ctx, r.attachment, "file"),
    ]);
    photosRestored += [dishPhotoKey, scanPhotoKey, sourcePhotoKey, attachmentKey].filter(Boolean).length;
    await db.insert(schema.recipes).values({
      title: r.title.trim(),
      description: r.description,
      servings: r.servings,
      prepMinutes: r.prepMinutes,
      cookMinutes: r.cookMinutes,
      ingredients: JSON.stringify(r.ingredients),
      steps: JSON.stringify(r.steps),
      tags: JSON.stringify(r.tags.map((t) => t.toLowerCase())),
      course: asCourse(r.course) ?? cats.course,
      protein: asProtein(r.protein) ?? cats.protein,
      sourceUrl: r.sourceUrl,
      sourceName: r.sourceName,
      collectionId: r.collectionName ? (collIdByName.get(r.collectionName.trim().toLowerCase()) ?? null) : null,
      favorite: r.favorite ? 1 : 0,
      rating: r.rating,
      status: r.status,
      cookCount: r.cookCount,
      lastCookedAt: r.lastCookedAt,
      notes: r.notes,
      dishPhotoKey,
      scanPhotoKey,
      sourcePhotoKey,
      attachmentName: r.attachmentName,
      attachmentKey,
    });
    imported++;
  }
  return { imported, skipped, photosRestored };
}

// Some source pages pack every step into one string with the numbering
// embedded ("...undrained2. After washing..."). For the seeded examples,
// split those back into individual steps and drop the printed numbers —
// the app numbers steps itself.
function splitSeedSteps(steps: string[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const parts = s
      .split(/(?<=[^\s])\s*(?=\d{1,2}\.\s)/)
      .map((p) => p.replace(/^\d+\s*[.)]\s*/, "").trim())
      .filter(Boolean);
    out.push(...(parts.length > 0 ? parts : [s.trim()]));
  }
  // Drop fragments with no letters at all (leftover digits from the split).
  return out.filter((p) => /[a-zA-Z]/.test(p));
}

// Runs the whole link-import pipeline (JSON-LD, Pinterest pin following,
// inference fallback) and returns a draft for review. Shared by the
// importUrl action and the seedExamples action.
async function draftFromUrl(ctx: Ctx, url: string): Promise<DraftResponse> {
  let page: { ok: boolean; text: string; finalUrl: string };
  try {
    page = await fetchText(url);
  } catch {
    return emptyDraftError("That page could not be reached. Check the link, or paste the recipe text instead.");
  }
  if (!page.ok && page.text.length < 500) {
    return emptyDraftError("That page would not open. Try pasting the recipe text instead.");
  }
  let node = recipeFromJsonLd(page.text);
  let sourceUrl = page.finalUrl;

  // Pinterest pins rarely carry the recipe themselves — follow out to the source blog.
  if (!node && /pinterest\./i.test(sourceUrl)) {
    const candidates = new Set<string>();
    for (const m of page.text.matchAll(/https?:\/\/[^\s"'\\<>]+/g)) {
      const u = m[0].replace(/\\u002F/g, "/").replace(/&amp;/g, "&");
      try {
        const host = new URL(u).hostname;
        if (!/pinterest|pinimg|google|facebook|instagram|gstatic/i.test(host)) candidates.add(u);
      } catch { /* ignore malformed */ }
      if (candidates.size >= 12) break;
    }
    for (const candidate of candidates) {
      try {
        const sub = await fetchText(candidate);
        if (!sub.ok) continue;
        const subNode = recipeFromJsonLd(sub.text);
        if (subNode) {
          node = subNode;
          sourceUrl = sub.finalUrl;
          page = sub;
          break;
        }
      } catch { /* try next candidate */ }
    }
  }

  if (node) {
    const ingredients = Array.isArray(node.recipeIngredient)
      ? node.recipeIngredient.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
      : [];
    const steps = flattenInstructions(node.recipeInstructions);
    let prep = parseDurationMinutes(node.prepTime);
    let cook = parseDurationMinutes(node.cookTime);
    if (prep == null && cook == null) {
      const total = parseDurationMinutes(node.totalTime);
      if (total != null) cook = total;
    }
    const imgUrl = imageUrlFrom(node);
    const sourcePhotoKey = imgUrl ? await downloadImageToBlob(ctx, imgUrl) : null;
    let host = "";
    try { host = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { host = ""; }
    const rawTags: string[] = [];
    if (typeof node.recipeCategory === "string") rawTags.push(node.recipeCategory);
    if (Array.isArray(node.recipeCategory)) rawTags.push(...node.recipeCategory.filter((x): x is string => typeof x === "string"));
    if (typeof node.recipeCuisine === "string") rawTags.push(node.recipeCuisine);
    const title = asString(node.name) || "Untitled recipe";
    const cats = await autoCategorize(ctx, {
      title,
      description: asString(node.description),
      ingredients,
      prepMinutes: prep,
      cookMinutes: cook,
    });
    return {
      ok: true,
      error: null,
      draft: {
        title,
        description: asString(node.description),
        servings: servingsFrom(node),
        prepMinutes: prep,
        cookMinutes: cook,
        ingredients,
        steps,
        tags: rawTags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8),
        course: cats.course,
        protein: cats.protein,
        pageNeedsRotation: "none",
        sourceUrl,
        sourceName: host || null,
        sourcePhotoKey,
        scanPhotoKey: null,
        attachmentName: null,
        attachmentKey: null,
      },
    };
  }

  // No structured recipe on the page — let the model read the visible text.
  const text = stripHtmlToText(page.text).slice(0, 7000);
  if (text.length < 80) {
    return emptyDraftError("No recipe could be found on that page. If it is a photo-only pin, try the scanner or paste the recipe text.");
  }
  try {
    const structured = await ctx.inference.complete(
      "Read this web page text and extract the recipe it contains. Ignore navigation, ads, comments, and the author's personal story — keep only the recipe itself.",
      { schema: inferenceDraftSchema, system: "You extract recipes from noisy web pages into clean structured data. Page text:\n\n" + text },
    );
    const cleaned = cleanDraft(structured);
    if (cleaned.ingredients.length === 0 && cleaned.steps.length === 0) {
      return emptyDraftError("No recipe could be found on that page. Try pasting the recipe text instead.");
    }
    let host = "";
    try { host = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { host = ""; }
    return {
      ok: true,
      error: null,
      draft: {
        ...cleaned,
        pageNeedsRotation: "none",
        sourceUrl,
        sourceName: host || null,
        sourcePhotoKey: null,
        scanPhotoKey: null,
        attachmentName: null,
        attachmentKey: null,
      },
    };
  } catch {
    return emptyDraftError("The recipe on that page could not be read automatically. Try pasting the recipe text instead.");
  }
}

// Turns recipe words into a structured draft for review. Shared by the
// structureText action (paste / text-file upload) and by email staging,
// so an email's recipe goes through exactly the same pipeline.
async function draftFromText(ctx: Ctx, text: string): Promise<DraftResponse> {
  try {
    const structured = await ctx.inference.complete(
      "Turn this text into a clean structured recipe. Keep the cook's own quantities and wording; split ingredients and steps into separate entries.",
      { schema: inferenceDraftSchema, system: "Recipe text:\n\n" + text.slice(0, 20000) },
    );
    const cleaned = cleanDraft(structured);
    return {
      ok: true,
      error: null,
      draft: {
        ...cleaned,
        pageNeedsRotation: "none",
        sourceUrl: null,
        sourceName: null,
        sourcePhotoKey: null,
        scanPhotoKey: null,
        attachmentName: null,
        attachmentKey: null,
      },
    };
  } catch {
    return emptyDraftError("That text could not be turned into a recipe automatically. You can still type the recipe in by hand.");
  }
}

// Reads a photo of a recipe page with vision OCR and returns a draft; the
// photo itself is stored as the recipe's original either way. Shared by
// the scanImage action and by email staging (an emailed photo of a recipe
// card is read exactly like a scan).
async function draftFromImage(
  ctx: Ctx,
  dataBase64: string,
  mimeType: "image/jpeg" | "image/png",
): Promise<DraftResponse> {
  const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  const key = `scan/${crypto.randomUUID()}`;
  await ctx.blobs.put(key, bytes, { contentType: mimeType });
  try {
    const structured = await ctx.inference.complete(
      "Read the recipe in this photo and return it structured. Transcribe quantities and steps exactly as written; if handwriting is unclear, make your best reading — the cook will check and fix it on the next screen. Also judge how the page sits in the photo and report pageNeedsRotation: the clockwise rotation, in degrees, that would make the page right-side up ('none' if it already is).",
      {
        schema: scanDraftSchema,
        images: [{ dataBase64, mimeType, caption: "Photo of a recipe page or card" }],
      },
    );
    const cleaned = cleanDraft(structured);
    return {
      ok: true,
      error: null,
      draft: {
        ...cleaned,
        pageNeedsRotation: structured.pageNeedsRotation,
        sourceUrl: null,
        sourceName: "Scanned page",
        sourcePhotoKey: null,
        scanPhotoKey: key,
        attachmentName: null,
        attachmentKey: null,
      },
    };
  } catch {
    return {
      ok: false,
      error: "The photo could not be read automatically. It has been kept — you can type the recipe in by hand on the review screen.",
      draft: {
        ...blankDraft(),
        sourceName: "Scanned page",
        scanPhotoKey: key,
      },
    };
  }
}

// ---------- shared backend: profiles, friends, sharing, server backup ----------
// Kitchen Companion's shared features live on the same Supabase project
// Vault X uses (Anthony's project, created Nov 2, 2026) — project URL and
// PUBLISHABLE key below. A publishable key is designed to be embedded in
// apps (Vault X's ships in its public repo the same way); the project's
// secret key is never used or stored here. The kc_* tables were created
// in the Supabase SQL editor on Nov 9, 2026 and are live (verified by
// direct reads/writes). If a backend call answers 404 (PostgREST
// PGRST205, "table not in schema cache") or the connection fails, the
// actions below report friendsOnline: false — the app says so in plain
// words and everything local (profile, code, welcome flow, local backup)
// keeps working. Registration is SELF-HEALING: it is attempted when the
// profile is created, again inside getProfile on every app open while
// the profile is still unregistered, and by the client's syncProfile
// retries — and kcFetch itself retries transient failures — so a profile
// created while the backend was unreachable (exactly what happened to
// the first two cooks) lands on the backend on a later open with no
// update and no user action needed.

const KC_BACKEND_URL = "https://iilsbousebrgkmsimucq.supabase.co";
const KC_PUBLISHABLE_KEY = "sb_publishable_Qi1YZXJNCbiDSTs0pn3fQA_MKai5qNX";

type KcResult<T> = { ok: true; data: T } | { ok: false; status: number };

const KC_RETRY_DELAYS_MS = [0, 400, 1200, 2500];
// Read paths (v1.5.2): the Friends tab felt "way too slow" because every
// read first paid a full retry ladder (up to 4 attempts × 10s timeouts)
// per call, several calls deep in series. Reads now get a short ladder —
// one quick retry — because the Friends tab renders its on-device cache
// instantly and treats the live read as a background refresh; a missed
// refresh simply leaves the cache on screen. Writes keep the full ladder:
// they must land, and they are all idempotent.
const KC_FAST_RETRY_DELAYS_MS = [0, 350];

async function kcFetch<T>(path: string, init?: RequestInit, opts?: { fast?: boolean }): Promise<KcResult<T>> {
  const delays = opts?.fast ? KC_FAST_RETRY_DELAYS_MS : KC_RETRY_DELAYS_MS;
  const timeoutMs = opts?.fast ? 4_000 : 10_000;
  // Transient connection resets are a real, observed failure on this path
  // (a single POST dying with ECONNRESET is what silently stranded profile
  // registrations — Nov 9, 2026: both cooks' profiles existed only on their
  // own copies, so every code lookup answered "no cook has that code yet").
  // Every backend write is an idempotent upsert or ignore-duplicates
  // insert, so retrying is always safe; a 4xx answer is final (a missing
  // table must still read as "not switched on" without a long stall).
  let last: KcResult<T> = { ok: false, status: 0 };
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${KC_BACKEND_URL}/rest/v1/${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          apikey: KC_PUBLISHABLE_KEY,
          Authorization: `Bearer ${KC_PUBLISHABLE_KEY}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        last = { ok: false, status: res.status };
        if (res.status < 500) return last;
        continue;
      }
      const text = await res.text();
      let data: T;
      try {
        data = (text ? JSON.parse(text) : null) as T;
      } catch {
        data = null as T;
      }
      return { ok: true, data };
    } catch {
      last = { ok: false, status: 0 };
    }
  }
  return last;
}

async function kcFriendsOnline(): Promise<boolean> {
  const r = await kcFetch<unknown[]>("kc_profiles?select=kc_id&limit=1", undefined, { fast: true });
  return r.ok;
}

// Public profile extras (v1.5.2): bio ("About my cooking"), location, and
// favourite-cuisine chips. The shared kc_profiles table gains these
// columns through a short ALTER in BACKEND-SETUP.md; until that runs,
// reads/writes naming them fail with a 400, so every call below tries the
// fullest shape first and falls back step by step — profiles keep working
// either way, and the extras start flowing to friends the moment the
// columns exist, with no app update.
type KcProfileRow = {
  kc_id: string;
  username: string;
  display_name: string;
  photo_data: string | null;
  bio?: string | null;
  location?: string | null;
  specialties?: string | null;
  created_at?: string | null;
};

const KC_SELECT_FULL = "kc_id,username,display_name,photo_data,bio,location,specialties,created_at";
const KC_SELECT_BIO = "kc_id,username,display_name,photo_data,bio,created_at";
const KC_SELECT_PLAIN = "kc_id,username,display_name,photo_data,created_at";
const KC_SELECT_LADDER = [KC_SELECT_FULL, KC_SELECT_BIO, KC_SELECT_PLAIN];

// Speed fix (v1.6.0, Anthony: "friends list still loading very slowly"):
// every Supabase round trip costs ~0.5–0.8s, and while the profile-extras
// columns don't exist yet the ladder above burns TWO wasted 400s (~1.3s)
// before the select that works — inside every single friends read. The
// worker now remembers which select last worked and goes straight to it,
// re-checking the full ladder every 10 minutes (so the extras light up
// on their own once the columns are added, no restart needed).
let kcSelectMemory: { select: string; at: number } | null = null;
const KC_MEMORY_TTL_MS = 10 * 60 * 1000;

async function kcSelectProfiles(query: string): Promise<KcProfileRow[] | null> {
  const mem = kcSelectMemory;
  if (mem && Date.now() - mem.at < KC_MEMORY_TTL_MS) {
    const r = await kcFetch<KcProfileRow[]>(`kc_profiles?select=${mem.select}&${query}`, undefined, { fast: true });
    if (r.ok) return r.data;
    kcSelectMemory = null; // remembered shape stopped working — climb the ladder again
  }
  for (const select of KC_SELECT_LADDER) {
    const r = await kcFetch<KcProfileRow[]>(`kc_profiles?select=${select}&${query}`, undefined, { fast: true });
    if (r.ok) {
      kcSelectMemory = { select, at: Date.now() };
      return r.data;
    }
  }
  return null;
}

async function kcGetProfileById(kcId: string): Promise<KcProfileRow | null> {
  const rows = await kcSelectProfiles(`kc_id=eq.${encodeURIComponent(kcId)}&limit=1`);
  return rows?.[0] ?? null;
}

async function kcGetProfileByUsername(username: string): Promise<KcProfileRow | null> {
  const rows = await kcSelectProfiles(`username=ilike.${encodeURIComponent(username)}&limit=1`);
  return rows?.[0] ?? null;
}

// Same remembered-shape trick as kcSelectProfiles (v1.6.0): writes try
// the fullest body first, but once a shape is known to work it goes
// first, so a sync costs one round trip instead of up to three.
let kcUpsertMemory: { index: number; at: number } | null = null;

async function kcUpsertProfile(p: { kcId: string; username: string; displayName: string; photoData: string | null; bio?: string; location?: string; specialties?: string[] }): Promise<boolean> {
  const base = { kc_id: p.kcId, username: p.username, display_name: p.displayName, photo_data: p.photoData };
  const bodies: Array<Record<string, unknown>> = [
    { ...base, bio: p.bio ?? "", location: p.location ?? "", specialties: JSON.stringify(p.specialties ?? []) },
    { ...base, bio: p.bio ?? "" },
    base,
  ];
  const order = [0, 1, 2];
  const mem = kcUpsertMemory;
  if (mem && Date.now() - mem.at < KC_MEMORY_TTL_MS && mem.index > 0) {
    order.splice(order.indexOf(mem.index), 1);
    order.unshift(mem.index);
  }
  for (const i of order) {
    const r = await kcFetch<unknown>("kc_profiles?on_conflict=kc_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(bodies[i]),
    });
    if (r.ok) {
      kcUpsertMemory = { index: i, at: Date.now() };
      return true;
    }
  }
  return false;
}

function parseSpecialties(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ---------- local profile ----------

type LocalProfileRow = typeof schema.profiles.$inferSelect;

async function getLocalProfile(ctx: Ctx): Promise<LocalProfileRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.profiles).orderBy(asc(schema.profiles.id)).limit(1);
  return rows[0] ?? null;
}

const KC_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newKcId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += KC_ID_ALPHABET[(bytes[i] ?? 0) % KC_ID_ALPHABET.length] ?? "A";
  }
  return `KC-${out.slice(0, 4)}-${out.slice(4)}`;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const USERNAME_ERROR = "Usernames are 3 to 20 characters — letters, numbers, and underscores only.";

// The private backup key: a high-entropy secret issued with the profile,
// SEPARATE from the public Kitchen Companion code (the code is for
// friends to see; this key is not). Only its SHA-256 hash ever goes to
// the shared backend, stamped on the user's kc_backups row; restoring a
// server backup requires presenting the key itself. The key lives only
// in this copy's own settings and is shown to the owner in the app.
async function getOrCreateRecoveryKey(ctx: Ctx): Promise<string> {
  const existing = await getSetting(ctx, "recovery_key", "");
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let raw = "";
  for (let i = 0; i < 16; i++) {
    raw += KC_ID_ALPHABET[(bytes[i] ?? 0) % KC_ID_ALPHABET.length] ?? "A";
  }
  const key = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  await setSetting(ctx, "recovery_key", key);
  return key;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const profileDto = z.object({
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  location: z.string(),
  specialties: z.array(z.string()),
  kcId: z.string(),
  photoUrl: z.string().nullable(),
  photoData: z.string().nullable(),
  createdAt: z.string(),
});

async function profileToDto(ctx: Ctx, row: LocalProfileRow): Promise<z.infer<typeof profileDto>> {
  return {
    username: row.username,
    displayName: row.displayName,
    bio: row.bio ?? "",
    location: row.location ?? "",
    specialties: parseSpecialties(row.specialties),
    kcId: row.kcId,
    photoUrl: await safePhotoUrl(ctx, row.photoKey),
    photoData: row.photoData,
    createdAt: row.createdAt.toISOString(),
  };
}

async function syncProfileToBackend(ctx: Ctx): Promise<boolean> {
  const me = await getLocalProfile(ctx);
  if (!me) return false;
  const ok = await kcUpsertProfile({
    kcId: me.kcId,
    username: me.username,
    displayName: me.displayName,
    photoData: me.photoData,
    bio: me.bio ?? "",
    location: me.location ?? "",
    specialties: parseSpecialties(me.specialties),
  });
  await setSetting(ctx, "profile_backend_synced", ok ? "1" : "0");
  return ok;
}

async function pushPendingShares(ctx: Ctx): Promise<number> {
  const me = await getLocalProfile(ctx);
  if (!me) return 0;
  const db = ctx.db<typeof schema>();
  const pending = await db.select().from(schema.localShares).where(eq(schema.localShares.synced, 0));
  let pushed = 0;
  for (const s of pending) {
    if (await pushShareRows(me, s)) {
      await db.update(schema.localShares).set({ synced: 1 }).where(eq(schema.localShares.id, s.id));
      pushed++;
    }
  }
  return pushed;
}

// ---------- friends tab: cache-first reads (v1.5.2) ----------
// The Friends tab used to wait on the whole live chain — an online probe
// (full retry ladder), then friendships, profiles, and shares fetched one
// after another — before painting anything, even though this device
// already holds a cache of the last-seen list. Now the tab paints from
// the cache first (getFriendsCached: local database only, no network at
// all) and the live read (getFriends) refreshes behind it on the fast
// ladder, in parallel, reconciling the cache for next time. A failed
// live read falls back to the cache rather than an empty page.

const friendDto = z.object({
  kcId: z.string(),
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  location: z.string(),
  specialties: z.array(z.string()),
  joinedAt: z.string().nullable(),
  photoData: z.string().nullable(),
});
type FriendDto = z.infer<typeof friendDto>;

const sharedWithMeDto = z.object({
  shareKey: z.string(),
  kind: z.enum(["recipe", "collection"]),
  title: z.string(),
  ownerKcId: z.string(),
  ownerName: z.string(),
  createdAt: z.string(),
});
type SharedWithMeDto = z.infer<typeof sharedWithMeDto>;

const myShareDto = z.object({
  shareKey: z.string(),
  kind: z.enum(["recipe", "collection"]),
  title: z.string(),
  // null = shared with all friends; otherwise only these KC-IDs see it.
  audience: z.array(z.string()).nullable(),
  synced: z.boolean(),
  createdAt: z.string(),
});
type MyShareDto = z.infer<typeof myShareDto>;

const friendsResponse = z.object({
  friendsOnline: z.boolean(),
  friends: z.array(friendDto),
  sharedWithMe: z.array(sharedWithMeDto),
  myShares: z.array(myShareDto),
});
type FriendsResponse = z.infer<typeof friendsResponse>;

function kcRowToFriend(p: KcProfileRow): FriendDto {
  return {
    kcId: p.kc_id,
    username: p.username,
    displayName: p.display_name,
    bio: p.bio ?? "",
    location: p.location ?? "",
    specialties: parseSpecialties(p.specialties),
    joinedAt: p.created_at ?? null,
    photoData: p.photo_data,
  };
}

// ---------- share audiences (v1.6.0) ----------
// Anthony: "Share with friends" shared with EVERYONE at once — he wants
// to pick the person (his case: the sausage & sauerkraut, for Liz only).
// A share's audience is stored on the local share row ('' = all friends,
// otherwise a JSON array of KC-IDs) and enforced on the shared backend
// WITHOUT any new backend column: a share for all friends keeps its
// plain share_key (every share made before v1.6.0 works unchanged),
// while a picked-friends share is written as one backend row per
// recipient with share_key "<key>#<recipient KC-ID>". Every read path
// below filters on that suffix against the VIEWER's own code, and the
// audience also rides inside the payload so saveSharedRecipe can refuse
// a key that wasn't addressed to the saver.

function parseAudience(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const ids = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

function shareKeyVisibleTo(shareKey: string, viewerKcId: string | null): boolean {
  const hash = shareKey.indexOf("#");
  if (hash < 0) return true; // plain key: shared with all friends
  if (!viewerKcId) return false;
  return shareKey.slice(hash + 1) === viewerKcId;
}

type ShareRowLike = typeof schema.localShares.$inferSelect;

// Writes (or rewrites) a share's backend rows for its current audience.
// Returns true when every row landed.
async function pushShareRows(me: LocalProfileRow, s: ShareRowLike): Promise<boolean> {
  let payloadObj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(s.payload);
    if (parsed && typeof parsed === "object") payloadObj = parsed as Record<string, unknown>;
  } catch {
    payloadObj = {};
  }
  const audience = parseAudience(s.audience);
  payloadObj.audience = audience;
  const keys = audience ? audience.map((kcId) => `${s.shareKey}#${kcId}`) : [s.shareKey];
  let ok = true;
  for (const key of keys) {
    const r = await kcFetch<unknown>("kc_shares?on_conflict=share_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ share_key: key, owner_kc_id: me.kcId, kind: s.kind, title: s.title, payload: payloadObj }),
    });
    if (!r.ok) ok = false;
  }
  return ok;
}

// Removes every backend row belonging to a share — the plain key and
// every per-recipient "#KC-ID" row — with one LIKE sweep.
async function deleteShareRows(shareKey: string): Promise<void> {
  await kcFetch<unknown>(`kc_shares?share_key=like.${encodeURIComponent(`${shareKey}%`)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function readMyShares(ctx: Ctx): Promise<MyShareDto[]> {
  const db = ctx.db<typeof schema>();
  const me = await getLocalProfile(ctx);
  if (!me) return [];
  const rows = await db.select().from(schema.localShares).orderBy(desc(schema.localShares.id));
  return rows.map((s) => ({
    shareKey: s.shareKey,
    kind: s.kind,
    title: s.title,
    audience: parseAudience(s.audience),
    synced: s.synced === 1,
    createdAt: s.createdAt.toISOString(),
  }));
}

async function readCachedFriends(ctx: Ctx): Promise<{ friends: FriendDto[]; sharedWithMe: SharedWithMeDto[] }> {
  const db = ctx.db<typeof schema>();
  const friendRows = await db.select().from(schema.localFriends).orderBy(asc(schema.localFriends.addedAt));
  const shareRows = await db.select().from(schema.localShared);
  return {
    friends: friendRows.map((f) => ({
      kcId: f.kcId,
      username: f.username,
      displayName: f.displayName,
      bio: f.bio ?? "",
      location: f.location ?? "",
      specialties: parseSpecialties(f.specialties),
      joinedAt: f.joinedAt ?? null,
      photoData: f.photoData,
    })),
    sharedWithMe: shareRows
      .slice()
      .sort((a, b) => (a.shareCreatedAt < b.shareCreatedAt ? 1 : -1))
      .map((s) => ({
        shareKey: s.shareKey,
        kind: s.kind,
        title: s.title,
        ownerKcId: s.ownerKcId,
        ownerName: s.ownerName,
        createdAt: s.shareCreatedAt,
      })),
  };
}

async function cacheFriend(ctx: Ctx, f: FriendDto): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.localFriends)
    .values({
      kcId: f.kcId, username: f.username, displayName: f.displayName,
      bio: f.bio, location: f.location, specialties: JSON.stringify(f.specialties),
      joinedAt: f.joinedAt, photoData: f.photoData,
    })
    .onConflictDoUpdate({
      target: schema.localFriends.kcId,
      set: {
        username: f.username, displayName: f.displayName, bio: f.bio,
        location: f.location, specialties: JSON.stringify(f.specialties),
        joinedAt: f.joinedAt, photoData: f.photoData,
      },
    });
}

async function liveFriends(ctx: Ctx, me: LocalProfileRow): Promise<FriendsResponse | null> {
  const db = ctx.db<typeof schema>();
  const fr = await kcFetch<Array<{ friend_kc_id: string }>>(
    `kc_friendships?select=friend_kc_id&owner_kc_id=eq.${encodeURIComponent(me.kcId)}&order=created_at.asc`,
    undefined,
    { fast: true },
  );
  if (!fr.ok) return null;
  const friendIds = fr.data.map((r) => r.friend_kc_id);
  let friends: FriendDto[] = [];
  let sharedWithMe: SharedWithMeDto[] = [];
  if (friendIds.length > 0) {
    const inList = friendIds.map((id) => `"${id}"`).join(",");
    // Profiles and shares don't depend on each other — fetch together.
    const [profileRows, sr] = await Promise.all([
      kcSelectProfiles(`kc_id=in.(${encodeURIComponent(inList)})`),
      kcFetch<Array<{ share_key: string; kind: string; title: string; owner_kc_id: string; created_at: string }>>(
        `kc_shares?select=share_key,kind,title,owner_kc_id,created_at&owner_kc_id=in.(${encodeURIComponent(inList)})&order=created_at.desc&limit=50`,
        undefined,
        { fast: true },
      ),
    ]);
    const byId = new Map((profileRows ?? []).map((p) => [p.kc_id, p]));
    friends = friendIds
      .map((id) => byId.get(id))
      .filter((p): p is KcProfileRow => p != null)
      .map((p) => kcRowToFriend(p));
    if (sr.ok) {
      const nameById = new Map(friends.map((f) => [f.kcId, f.displayName || f.username]));
      // Audience filter (v1.6.0): a per-recipient share row ("key#KC-ID")
      // is visible only to the friend it was addressed to — me.
      sharedWithMe = sr.data.filter((s) => shareKeyVisibleTo(s.share_key, me.kcId)).map((s) => ({
        shareKey: s.share_key,
        kind: s.kind === "collection" ? "collection" as const : "recipe" as const,
        title: s.title,
        ownerKcId: s.owner_kc_id,
        ownerName: nameById.get(s.owner_kc_id) ?? "A friend",
        createdAt: s.created_at,
      }));
    }
  }
  // Reconcile the on-device caches so the next open paints instantly.
  await db.delete(schema.localFriends);
  for (const f of friends) await cacheFriend(ctx, f);
  await db.delete(schema.localShared);
  for (const s of sharedWithMe) {
    await db.insert(schema.localShared).values({
      shareKey: s.shareKey, kind: s.kind, title: s.title,
      ownerKcId: s.ownerKcId, ownerName: s.ownerName, shareCreatedAt: s.createdAt,
    });
  }
  await setSetting(ctx, "friends_last_online", "1");
  return { friendsOnline: true, friends, sharedWithMe, myShares: await readMyShares(ctx) };
}

// ---------- actions ----------

const draftObject = z.object({
  title: z.string(),
  description: z.string(),
  servings: z.number().nullable(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  tags: z.array(z.string()),
  course: z.string().nullable(),
  protein: z.string().nullable(),
  pageNeedsRotation: z.enum(["none", "90", "180", "270"]),
  sourceUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourcePhotoKey: z.string().nullable(),
  scanPhotoKey: z.string().nullable(),
  attachmentName: z.string().nullable(),
  attachmentKey: z.string().nullable(),
});
type DraftObject = z.infer<typeof draftObject>;

const draftResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  draft: draftObject.nullable(),
});
type DraftResponse = z.infer<typeof draftResponse>;

function emptyDraftError(error: string): DraftResponse {
  return { ok: false, error, draft: null };
}

function blankDraft(): DraftObject {
  return {
    title: "Untitled recipe",
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
}

// ---------- email import staging (v1.5.0) ----------
// Recipes found in the user's email wait in staged_imports until the cook
// reviews them. The staging action below is what the user's own Muse
// calls from outside the app after searching their connected mailbox —
// the app itself never reads email and never sees an email password.
// Duplicate protection: a staged title is compared against the library
// (and against what is already waiting) with a forgiving similarity test,
// so "Grandma's Tomato Soup" and "Grandma's tomato soup!" count as the
// same dish; matches are flagged, never silently dropped or saved.

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

async function findSimilarRecipeTitle(ctx: Ctx, title: string): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select({ title: schema.recipes.title }).from(schema.recipes);
  const hit = rows.find((r) => titlesSimilar(r.title, title));
  return hit ? hit.title : null;
}

const stagedImportDto = z.object({
  id: z.number(),
  title: z.string(),
  senderName: z.string(),
  senderEmail: z.string(),
  subject: z.string(),
  emailDate: z.string().nullable(),
  rawText: z.string().nullable(),
  draft: draftObject.nullable(),
  similarTitle: z.string().nullable(),
  scanPhotoUrl: z.string().nullable(),
  createdAt: z.string(),
});

type StagedRow = typeof schema.stagedImports.$inferSelect;

async function stagedToDto(ctx: Ctx, row: StagedRow): Promise<z.infer<typeof stagedImportDto>> {
  let draft: DraftObject | null = null;
  try {
    const parsed = draftObject.safeParse(JSON.parse(row.draft));
    if (parsed.success) draft = parsed.data;
  } catch {
    draft = null;
  }
  const [similarTitle, scanPhotoUrl] = await Promise.all([
    findSimilarRecipeTitle(ctx, row.title),
    safePhotoUrl(ctx, draft?.scanPhotoKey ?? null),
  ]);
  return {
    id: row.id,
    title: row.title,
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    subject: row.subject,
    emailDate: row.emailDate,
    rawText: row.rawText,
    draft,
    similarTitle,
    scanPhotoUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

export const Actions = {
  listRecipes: defineAction({
    description: "Lists every recipe in the library, newest first, with photo URLs resolved.",
    request: z.object({}),
    response: z.object({ recipes: z.array(recipeDto) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.recipes).orderBy(desc(schema.recipes.id));
      const recipes = await Promise.all(rows.map((r) => toDto(ctx, r)));
      return { recipes };
    },
  }),

  createRecipe: defineAction({
    description: "Saves a new recipe from a reviewed draft. Any category the draft is missing is chosen automatically.",
    request: z.object(draftShape),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let course = asCourse(args.course);
      let protein = asProtein(args.protein);
      if (!course || !protein) {
        const cats = await autoCategorize(ctx, {
          title: args.title,
          description: args.description,
          ingredients: args.ingredients,
          prepMinutes: args.prepMinutes,
          cookMinutes: args.cookMinutes,
        });
        course = course ?? cats.course;
        protein = protein ?? cats.protein;
      }
      const inserted = await db.insert(schema.recipes).values({
        title: args.title.trim(),
        description: args.description,
        servings: args.servings,
        prepMinutes: args.prepMinutes,
        cookMinutes: args.cookMinutes,
        ingredients: JSON.stringify(args.ingredients.map((s) => s.trim()).filter(Boolean)),
        steps: JSON.stringify(args.steps.map((s) => s.trim()).filter(Boolean)),
        tags: JSON.stringify(args.tags.map((s) => s.trim().toLowerCase()).filter(Boolean)),
        course,
        protein,
        sourceUrl: args.sourceUrl,
        sourceName: args.sourceName,
        collectionId: args.collectionId,
        notes: args.notes,
        dishPhotoKey: args.dishPhotoKey,
        scanPhotoKey: args.scanPhotoKey,
        sourcePhotoKey: args.sourcePhotoKey,
        attachmentName: args.attachmentName,
        attachmentKey: args.attachmentKey,
      }).returning({ id: schema.recipes.id });
      const row = inserted[0];
      if (!row) throw new Error("createRecipe: no row returned");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateRecipe: defineAction({
    description: "Replaces a recipe's editable fields with a reviewed draft.",
    request: z.object({ id: z.number().int(), ...draftShape }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      // A partial update (like swapping the dish photo) may omit the
      // categories — keep the stored ones rather than wiping them, and
      // categorise only if the recipe somehow has none at all.
      const existingRows = await db.select().from(schema.recipes).where(eq(schema.recipes.id, args.id));
      const existing = existingRows[0];
      let course = asCourse(args.course) ?? existing?.course ?? null;
      let protein = asProtein(args.protein) ?? existing?.protein ?? null;
      if (!course || !protein) {
        const cats = await autoCategorize(ctx, {
          title: args.title,
          description: args.description,
          ingredients: args.ingredients,
          prepMinutes: args.prepMinutes,
          cookMinutes: args.cookMinutes,
        });
        course = course ?? cats.course;
        protein = protein ?? cats.protein;
      }
      await db.update(schema.recipes).set({
        title: args.title.trim(),
        description: args.description,
        servings: args.servings,
        prepMinutes: args.prepMinutes,
        cookMinutes: args.cookMinutes,
        ingredients: JSON.stringify(args.ingredients.map((s) => s.trim()).filter(Boolean)),
        steps: JSON.stringify(args.steps.map((s) => s.trim()).filter(Boolean)),
        tags: JSON.stringify(args.tags.map((s) => s.trim().toLowerCase()).filter(Boolean)),
        course,
        protein,
        sourceUrl: args.sourceUrl,
        sourceName: args.sourceName,
        collectionId: args.collectionId,
        notes: args.notes,
        dishPhotoKey: args.dishPhotoKey,
        scanPhotoKey: args.scanPhotoKey,
        sourcePhotoKey: args.sourcePhotoKey,
        attachmentName: args.attachmentName,
        attachmentKey: args.attachmentKey,
        updatedAt: new Date(),
      }).where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteRecipe: defineAction({
    description: "Deletes a recipe and any meal-plan entries pointing at it.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.mealPlan).where(eq(schema.mealPlan.recipeId, args.id));
      await db.delete(schema.recipes).where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setFavorite: defineAction({
    description: "Marks or unmarks a recipe as a favourite.",
    request: z.object({ id: z.number().int(), favorite: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.recipes)
        .set({ favorite: args.favorite ? 1 : 0, updatedAt: new Date() })
        .where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setRating: defineAction({
    description: "Sets a recipe's star rating (1-5) or clears it.",
    request: z.object({ id: z.number().int(), rating: z.number().int().min(1).max(5).nullable() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.recipes)
        .set({ rating: args.rating, updatedAt: new Date() })
        .where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setCategories: defineAction({
    description: "Corrects a recipe's automatic categories (course and protein) with the cook's own choice.",
    request: z.object({
      id: z.number().int(),
      course: z.string().nullable(),
      protein: z.string().nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.recipes)
        .set({ course: asCourse(args.course), protein: asProtein(args.protein), updatedAt: new Date() })
        .where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  backfillCategories: defineAction({
    description: "Fills in course/protein categories on recipes saved before automatic categorisation existed, using keyword rules. Recipes that already have categories are untouched.",
    request: z.object({}),
    response: z.object({ updated: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.recipes);
      let updated = 0;
      for (const row of rows) {
        if (row.course && row.protein) continue;
        const cats = keywordCategories(row.title, parseJsonArray(row.ingredients));
        await db.update(schema.recipes)
          .set({ course: row.course ?? cats.course, protein: row.protein ?? cats.protein })
          .where(eq(schema.recipes.id, row.id));
        updated++;
      }
      if (updated > 0) ctx.invalidateQueries();
      return { updated };
    },
  }),

  markCooked: defineAction({
    description: "Records that a recipe was cooked today: bumps the cook count, sets the last-cooked date, and moves it to Made It.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true), lastCookedAt: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.recipes).where(eq(schema.recipes.id, args.id));
      const row = rows[0];
      if (!row) throw new Error("markCooked: recipe not found");
      const today = todayInChicago();
      await db.update(schema.recipes).set({
        cookCount: row.cookCount + 1,
        lastCookedAt: today,
        status: "made",
        updatedAt: new Date(),
      }).where(eq(schema.recipes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const, lastCookedAt: today };
    },
  }),

  listCollections: defineAction({
    description: "Lists recipe collections in creation order.",
    request: z.object({}),
    response: z.object({
      collections: z.array(z.object({ id: z.number(), name: z.string() })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.collections).orderBy(asc(schema.collections.id));
      return { collections: rows.map((r) => ({ id: r.id, name: r.name })) };
    },
  }),

  createCollection: defineAction({
    description: "Creates a new recipe collection (folder).",
    request: z.object({ name: z.string().min(1) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db.insert(schema.collections)
        .values({ name: args.name.trim() })
        .returning({ id: schema.collections.id });
      const row = inserted[0];
      if (!row) throw new Error("createCollection: no row returned");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteCollection: defineAction({
    description: "Deletes a collection; its recipes stay in the library, unfiled.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.recipes)
        .set({ collectionId: null })
        .where(eq(schema.recipes.collectionId, args.id));
      await db.delete(schema.collections).where(eq(schema.collections.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  storePhoto: defineAction({
    description: "Stores an uploaded photo (finished dish or scan original) and returns its blob key.",
    request: z.object({
      dataBase64: z.string().min(1),
      mimeType: z.string().min(1),
      kind: z.enum(["dish", "scan"]),
    }),
    response: z.object({ key: z.string(), url: z.string() }),
    async handler(ctx, args) {
      const bytes = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
      const key = `${args.kind}/${crypto.randomUUID()}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      const url = await ctx.blobs.getUrl(key);
      return { key, url };
    },
  }),

  storeAttachment: defineAction({
    description: "Stores an uploaded file (for example a PDF) as a recipe's attached original and returns its blob key.",
    request: z.object({
      dataBase64: z.string().min(1),
      mimeType: z.string().min(1),
      filename: z.string().min(1),
    }),
    response: z.object({ key: z.string() }),
    async handler(ctx, args) {
      const bytes = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
      if (bytes.length > 10_000_000) throw new Error("File is too large (10 MB limit).");
      const key = `file/${crypto.randomUUID()}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      return { key };
    },
  }),

  importUrl: defineAction({
    description: "Fetches a recipe page (or a Pinterest pin's source page) the user pasted and extracts a structured draft for review. Nothing is saved until the user confirms on the review screen.",
    request: z.object({ url: z.string().url() }),
    response: draftResponse,
    async handler(ctx, args): Promise<DraftResponse> {
      return draftFromUrl(ctx, args.url);
    },
  }),

  structureText: defineAction({
    description: "Turns pasted recipe text (or the text of an uploaded text file) into a structured draft for review.",
    request: z.object({ text: z.string().min(10).max(20000) }),
    response: draftResponse,
    async handler(ctx, args): Promise<DraftResponse> {
      return draftFromText(ctx, args.text);
    },
  }),

  scanImage: defineAction({
    description: "Reads a photo of a recipe page or card with vision OCR and returns a structured draft for review; the photo itself is stored as the recipe's original.",
    request: z.object({
      dataBase64: z.string().min(1),
      mimeType: z.enum(["image/jpeg", "image/png"]),
    }),
    response: draftResponse,
    async handler(ctx, args): Promise<DraftResponse> {
      return draftFromImage(ctx, args.dataBase64, args.mimeType);
    },
  }),

  listPlan: defineAction({
    description: "Lists meal-plan entries between two dates (inclusive, YYYY-MM-DD).",
    request: z.object({ from: z.string(), to: z.string() }),
    response: z.object({
      entries: z.array(z.object({
        id: z.number(),
        date: z.string(),
        meal: z.enum(["breakfast", "lunch", "dinner", "other"]),
        recipeId: z.number().nullable(),
        label: z.string().nullable(),
        recipeTitle: z.string().nullable(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.mealPlan).orderBy(asc(schema.mealPlan.date), asc(schema.mealPlan.id));
      const filtered = rows.filter((r) => r.date >= args.from && r.date <= args.to);
      const recipeRows = await db.select({ id: schema.recipes.id, title: schema.recipes.title }).from(schema.recipes);
      const titles = new Map(recipeRows.map((r) => [r.id, r.title]));
      return {
        entries: filtered.map((r) => ({
          id: r.id,
          date: r.date,
          meal: r.meal,
          recipeId: r.recipeId,
          label: r.label,
          recipeTitle: r.recipeId != null ? (titles.get(r.recipeId) ?? null) : null,
        })),
      };
    },
  }),

  addPlanEntry: defineAction({
    description: "Adds a recipe (or a free-text note like 'leftovers') to a day on the meal planner.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      meal: z.enum(["breakfast", "lunch", "dinner", "other"]),
      recipeId: z.number().int().nullable().default(null),
      label: z.string().nullable().default(null),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db.insert(schema.mealPlan).values({
        date: args.date,
        meal: args.meal,
        recipeId: args.recipeId,
        label: args.label,
      }).returning({ id: schema.mealPlan.id });
      const row = inserted[0];
      if (!row) throw new Error("addPlanEntry: no row returned");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  removePlanEntry: defineAction({
    description: "Removes one entry from the meal planner.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.mealPlan).where(eq(schema.mealPlan.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listGrocery: defineAction({
    description: "Lists the grocery list, unchecked first.",
    request: z.object({}),
    response: z.object({
      items: z.array(z.object({
        id: z.number(),
        name: z.string(),
        detail: z.string(),
        aisle: z.string(),
        checked: z.boolean(),
        recipeId: z.number().nullable(),
      })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.groceryItems)
        .orderBy(asc(schema.groceryItems.checked), asc(schema.groceryItems.id));
      return {
        items: rows.map((r) => ({
          id: r.id, name: r.name, detail: r.detail, aisle: r.aisle,
          checked: r.checked === 1, recipeId: r.recipeId,
        })),
      };
    },
  }),

  addGroceryItem: defineAction({
    description: "Adds one hand-typed item to the grocery list.",
    request: z.object({ name: z.string().min(1), detail: z.string().default("") }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db.insert(schema.groceryItems).values({
        name: args.name.trim(),
        detail: args.detail.trim(),
        aisle: guessAisle(args.name),
      }).returning({ id: schema.groceryItems.id });
      const row = inserted[0];
      if (!row) throw new Error("addGroceryItem: no row returned");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  addRecipesToGrocery: defineAction({
    description: "Adds the ingredients of one or more recipes to the grocery list, scaling quantities and merging duplicates (2 eggs + 3 eggs = 5 eggs), sorted by supermarket aisle.",
    request: z.object({
      items: z.array(z.object({
        recipeId: z.number().int(),
        factor: z.number().positive().default(1),
      })).min(1),
    }),
    response: z.object({ added: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.groceryItems)
        .where(eq(schema.groceryItems.checked, 0));
      type Agg = { qty: number | null; unit: string; name: string; aisle: string; recipeId: number | null };
      const merged = new Map<string, Agg>();
      const keyOf = (name: string, unit: string) => `${name.toLowerCase()}|${unit.toLowerCase()}`;
      for (const row of existing) {
        // Existing rows store the display name; re-derive merge key from detail+name.
        merged.set(keyOf(row.name, ""), {
          qty: null, unit: "", name: row.name, aisle: row.aisle, recipeId: row.recipeId,
        });
      }
      let added = 0;
      const inserts: Array<typeof schema.groceryItems.$inferInsert> = [];
      const updates: Array<{ id: number; detail: string }> = [];
      const existingByKey = new Map(existing.map((r) => [keyOf(r.name, ""), r]));

      for (const { recipeId, factor } of args.items) {
        const rows = await db.select().from(schema.recipes).where(eq(schema.recipes.id, recipeId));
        const recipe = rows[0];
        if (!recipe) continue;
        const scale = recipe.servings && recipe.servings > 0 ? factor : 1;
        for (const line of parseJsonArray(recipe.ingredients)) {
          const parsed = parseIngredient(line);
          const qty = parsed.qty != null ? parsed.qty * scale : null;
          const k = keyOf(parsed.name, parsed.unit);
          const prev = merged.get(k);
          if (prev && prev.qty != null && qty != null) {
            prev.qty += qty;
            continue;
          }
          if (prev) continue; // already on the list, unquantified — don't duplicate
          merged.set(k, {
            qty, unit: parsed.unit, name: parsed.name,
            aisle: guessAisle(parsed.name), recipeId,
          });
          added++;
        }
      }

      for (const agg of merged.values()) {
        const detail = agg.qty != null
          ? `${fmtQty(agg.qty)}${agg.unit ? " " + agg.unit : ""}`
          : "";
        const prior = existingByKey.get(keyOf(agg.name, ""));
        if (prior) {
          if (agg.qty != null && prior.detail !== detail) {
            // Only rewrite detail when we actually summed quantities for it.
            const wasMerged = args.items.length > 0 && agg.recipeId != null;
            if (wasMerged) updates.push({ id: prior.id, detail });
          }
          continue;
        }
        inserts.push({
          name: agg.name,
          detail,
          aisle: agg.aisle,
          recipeId: agg.recipeId,
        });
      }
      if (inserts.length > 0) {
        await db.insert(schema.groceryItems).values(inserts);
      }
      for (const u of updates) {
        await db.update(schema.groceryItems).set({ detail: u.detail }).where(eq(schema.groceryItems.id, u.id));
      }
      ctx.invalidateQueries();
      return { added };
    },
  }),

  setGroceryChecked: defineAction({
    description: "Ticks or unticks one grocery item.",
    request: z.object({ id: z.number().int(), checked: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.groceryItems)
        .set({ checked: args.checked ? 1 : 0 })
        .where(eq(schema.groceryItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  removeGroceryItem: defineAction({
    description: "Removes one item from the grocery list.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.groceryItems).where(eq(schema.groceryItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearCheckedGrocery: defineAction({
    description: "Removes every ticked-off item from the grocery list.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.groceryItems).where(eq(schema.groceryItems.checked, 1));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  exportLibrary: defineAction({
    description: "Exports the whole library's recipes and collections (format v2) for a backup. The photo/file fields arrive empty: the client fetches each photo's bytes in the browser and embeds them into the backup file it downloads (or hands to saveAutoBackup), because the server cannot read blob bytes back. The client reports the finished backup via markBackupDownloaded.",
    request: z.object({}),
    response: backupPayloadSchema,
    async handler(ctx) {
      return buildBackupPayload(ctx);
    },
  }),

  markBackupDownloaded: defineAction({
    description: "Records that the user just downloaded a complete backup file (recipes plus photos), so the backup status can show when the last downloaded backup was taken and what it held.",
    request: z.object({
      recipes: z.number().int().nonnegative(),
      photos: z.number().int().nonnegative(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await setSetting(ctx, "last_backup_at", new Date().toISOString());
      await setSetting(ctx, "last_backup_recipes", String(args.recipes));
      await setSetting(ctx, "last_backup_photos", String(args.photos));
      return { ok: true };
    },
  }),

  importBackup: defineAction({
    description: "Restores recipes from a Kitchen Companion backup file (format v2 restores the photos and attached files too; v1 files restore recipe text as before), skipping any recipe whose title already exists in the library.",
    request: z.object({
      collections: z.array(z.object({ name: z.string() })).default([]),
      recipes: z.array(importRecipeSchema).default([]),
    }),
    response: z.object({ imported: z.number(), skipped: z.number(), photosRestored: z.number() }),
    async handler(ctx, args) {
      const result = await importLibraryData(ctx, args);
      ctx.invalidateQueries();
      return result;
    },
  }),

  getBackupStatus: defineAction({
    description: "Reports where the library stands on backups: how many recipes and photos/files it holds, when the last downloaded backup and the last automatic backup were taken, whether anything changed since, and how many automatic snapshots are kept.",
    request: z.object({}),
    response: z.object({
      recipeCount: z.number(),
      photoCount: z.number(),
      lastBackupAt: z.string().nullable(),
      lastAutoBackupAt: z.string().nullable(),
      autoBackupPhotos: z.number(),
      autoPhotosMissing: z.number(),
      snapshotCount: z.number(),
      changesSinceBackup: z.boolean(),
      changesSinceAutoBackup: z.boolean(),
      autoBackupNeeded: z.boolean(),
      backendBackupEnabled: z.boolean(),
      lastBackendBackupAt: z.string().nullable(),
      friendsOnline: z.boolean(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.recipes);
      const photoCount = rows.reduce(
        (n, r) => n + [r.dishPhotoKey, r.scanPhotoKey, r.sourcePhotoKey, r.attachmentKey].filter(Boolean).length,
        0,
      );
      const [lastBackupAt, lastAutoBackupAt, autoPhotosRaw, autoMissingRaw, backendEnabledRaw, lastBackendBackupAt] = await Promise.all([
        getSetting(ctx, "last_backup_at", ""),
        getSetting(ctx, "last_auto_backup_at", ""),
        getSetting(ctx, "last_auto_backup_photos", "0"),
        getSetting(ctx, "last_auto_backup_photos_missing", "0"),
        getSetting(ctx, "backend_backup_enabled", "0"),
        getSetting(ctx, "last_backend_backup_at", ""),
      ]);
      let snapshotCount = 0;
      try {
        snapshotCount = (await ctx.blobs.list("backups/")).length;
      } catch {
        snapshotCount = 0;
      }
      const latestChangeMs = rows.reduce((m, r) => Math.max(m, r.updatedAt.getTime()), 0);
      const changedSince = (stamp: string) =>
        rows.length > 0 && (!stamp || latestChangeMs > Date.parse(stamp));
      return {
        recipeCount: rows.length,
        photoCount,
        lastBackupAt: lastBackupAt || null,
        lastAutoBackupAt: lastAutoBackupAt || null,
        autoBackupPhotos: parseInt(autoPhotosRaw, 10) || 0,
        autoPhotosMissing: parseInt(autoMissingRaw, 10) || 0,
        snapshotCount,
        changesSinceBackup: changedSince(lastBackupAt),
        changesSinceAutoBackup: changedSince(lastAutoBackupAt),
        autoBackupNeeded: changedSince(lastAutoBackupAt),
        backendBackupEnabled: backendEnabledRaw === "1",
        lastBackendBackupAt: lastBackendBackupAt || null,
        friendsOnline: await kcFriendsOnline(),
      };
    },
  }),

  saveAutoBackup: defineAction({
    description: "Stores a complete automatic backup snapshot — the full backup payload the client assembled (every recipe plus its photos/files embedded as data) — in the app's own private storage, separate from the working library, keeping the newest 10 snapshots. The client calls this when the app opens and finds changes since the last snapshot.",
    request: z.object({
      exportedAt: z.string().min(1),
      photosUnreadable: z.number().int().nonnegative().default(0),
      collections: z.array(z.object({ name: z.string() })).default([]),
      recipes: z.array(importRecipeSchema).default([]),
    }),
    response: z.object({
      ok: z.literal(true),
      backedUpAt: z.string(),
      recipes: z.number(),
      photos: z.number(),
      snapshotsKept: z.number(),
      backendSaved: z.boolean(),
    }),
    async handler(ctx, args): Promise<{ ok: true; backedUpAt: string; recipes: number; photos: number; snapshotsKept: number; backendSaved: boolean }> {
      const stamp = args.exportedAt;
      const stored = {
        version: 2,
        exportedAt: stamp,
        photosUnreadable: args.photosUnreadable,
        collections: args.collections,
        recipes: args.recipes,
      };
      const key = `backups/${stamp.replace(/[:.]/g, "-")}.json`;
      await ctx.blobs.put(key, new TextEncoder().encode(JSON.stringify(stored)), { contentType: "application/json" });
      let kept = 1;
      try {
        const all = (await ctx.blobs.list("backups/"))
          .slice()
          .sort((a, b) => b.key.localeCompare(a.key));
        kept = Math.min(all.length, 10);
        for (const extra of all.slice(10)) {
          await ctx.blobs.delete(extra.key).catch(() => {});
        }
      } catch {
        kept = 1;
      }
      const photos = countImportPhotos(args.recipes);
      await setSetting(ctx, "last_auto_backup_at", stamp);
      await setSetting(ctx, "last_auto_backup_recipes", String(args.recipes.length));
      await setSetting(ctx, "last_auto_backup_photos", String(photos));
      await setSetting(ctx, "last_auto_backup_photos_missing", String(args.photosUnreadable));
      // Extra copy on the shared backend — only when Anthony has turned it
      // on for this copy (setBackendBackup) and a profile exists to own it.
      // The row carries only the HASH of the owner's private backup key;
      // restoring demands the key itself (the public code and username
      // are identifiers, never credentials).
      let backendSaved = false;
      const backendEnabled = (await getSetting(ctx, "backend_backup_enabled", "0")) === "1";
      const me = await getLocalProfile(ctx);
      if (backendEnabled && me && (await kcFriendsOnline())) {
        const recoveryHash = await sha256Hex(await getOrCreateRecoveryKey(ctx));
        const r = await kcFetch<unknown>("kc_backups?on_conflict=kc_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            kc_id: me.kcId,
            username: me.username,
            recovery_hash: recoveryHash,
            payload: {
              version: 2,
              exportedAt: stamp,
              collections: args.collections,
              recipes: args.recipes,
            },
            updated_at: new Date().toISOString(),
          }),
        });
        backendSaved = r.ok;
        if (backendSaved) await setSetting(ctx, "last_backend_backup_at", stamp);
      }
      return { ok: true, backedUpAt: stamp, recipes: args.recipes.length, photos, snapshotsKept: kept, backendSaved };
    },
  }),

  getLatestAutoBackup: defineAction({
    description: "Returns where to fetch the newest automatic backup snapshot (the client downloads it and hands it to importBackup to restore) plus when it was taken and what it holds. This is the recovery path if recipes are ever deleted or the library is lost.",
    request: z.object({}),
    response: z.object({
      found: z.boolean(),
      url: z.string().nullable(),
      backedUpAt: z.string().nullable(),
      recipes: z.number(),
      photos: z.number(),
      snapshotCount: z.number(),
    }),
    async handler(ctx) {
      let latestKey: string | null = null;
      let snapshotCount = 0;
      try {
        const all = (await ctx.blobs.list("backups/"))
          .filter((m) => m.key.endsWith(".json"))
          .sort((a, b) => b.key.localeCompare(a.key));
        snapshotCount = all.length;
        latestKey = all[0]?.key ?? null;
      } catch {
        latestKey = null;
      }
      if (!latestKey) {
        return { found: false, url: null, backedUpAt: null, recipes: 0, photos: 0, snapshotCount };
      }
      const [backedUpAt, recipesRaw, photosRaw] = await Promise.all([
        getSetting(ctx, "last_auto_backup_at", ""),
        getSetting(ctx, "last_auto_backup_recipes", "0"),
        getSetting(ctx, "last_auto_backup_photos", "0"),
      ]);
      return {
        found: true,
        url: await safePhotoUrl(ctx, latestKey),
        backedUpAt: backedUpAt || null,
        recipes: parseInt(recipesRaw, 10) || 0,
        photos: parseInt(photosRaw, 10) || 0,
        snapshotCount,
      };
    },
  }),

  // ---------- profile, friends, sharing ----------

  getProfile: defineAction({
    description: "Returns this copy's profile (null until the welcome setup is done), whether the shared friends backend is switched on yet, whether the profile is registered on it, and the owner's private backup key (this copy only — it never leaves the owner's own app except as a hash on their server backup).",
    request: z.object({}),
    response: z.object({
      profile: profileDto.nullable(),
      friendsOnline: z.boolean(),
      backendSynced: z.boolean(),
      recoveryKey: z.string().nullable(),
    }),
    async handler(ctx) {
      const me = await getLocalProfile(ctx);
      let [online, syncedRaw] = await Promise.all([
        kcFriendsOnline(),
        getSetting(ctx, "profile_backend_synced", "0"),
      ]);
      // Self-heal on every open: a profile created while the backend was
      // unreachable (or whose one registration attempt died on a transient
      // connection reset) registers HERE, without waiting for any client
      // effect — an unregistered profile is invisible to friends' code
      // lookups, which is the exact failure this prevents from recurring.
      if (me && online && syncedRaw !== "1") {
        const synced = await syncProfileToBackend(ctx);
        if (synced) {
          syncedRaw = "1";
          await pushPendingShares(ctx);
        }
      }
      return {
        profile: me ? await profileToDto(ctx, me) : null,
        friendsOnline: online,
        backendSynced: syncedRaw === "1",
        recoveryKey: me ? await getOrCreateRecoveryKey(ctx) : null,
      };
    },
  }),

  createProfile: defineAction({
    description: "Creates this copy's profile during the forced first-run welcome: a unique username, a display name, an optional photo, and a freshly issued Kitchen Companion code (KC-XXXX-XXXX). Registers on the shared backend when it is switched on; existing recipes and data are never touched.",
    request: z.object({
      username: z.string().min(1).max(40),
      displayName: z.string().max(60).default(""),
      photo: photoAsset.nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      profile: profileDto.nullable(),
      friendsOnline: z.boolean(),
      recoveryKey: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await getLocalProfile(ctx);
      if (existing) {
        return { ok: true, error: null, profile: await profileToDto(ctx, existing), friendsOnline: await kcFriendsOnline(), recoveryKey: await getOrCreateRecoveryKey(ctx) };
      }
      const username = args.username.trim();
      if (!USERNAME_RE.test(username)) {
        return { ok: false, error: USERNAME_ERROR, profile: null, friendsOnline: false, recoveryKey: null };
      }
      const online = await kcFriendsOnline();
      if (online) {
        const taken = await kcGetProfileByUsername(username);
        if (taken) {
          return { ok: false, error: "That username is already taken — try another one.", profile: null, friendsOnline: true, recoveryKey: null };
        }
      }
      let kcId = newKcId();
      if (online) {
        for (let i = 0; i < 8 && (await kcGetProfileById(kcId)) != null; i++) kcId = newKcId();
      }
      let photoKey: string | null = null;
      let photoData: string | null = null;
      if (args.photo) {
        photoKey = await storeBlobAsset(ctx, args.photo, "profile");
        // A small copy rides along for the friends directory; very large
        // photos stay local-only rather than bloating the shared row.
        if (args.photo.dataBase64.length <= 400_000) {
          photoData = `data:${args.photo.mimeType};base64,${args.photo.dataBase64}`;
        }
      }
      const inserted = await db.insert(schema.profiles).values({
        username,
        displayName: args.displayName.trim(),
        kcId,
        photoKey,
        photoData,
      }).returning({ id: schema.profiles.id });
      const rowId = inserted[0]?.id;
      if (rowId == null) throw new Error("createProfile: no row returned");
      let synced = false;
      if (online) synced = await syncProfileToBackend(ctx);
      await setSetting(ctx, "profile_backend_synced", synced ? "1" : "0");
      const me = await getLocalProfile(ctx);
      return { ok: true, error: null, profile: me ? await profileToDto(ctx, me) : null, friendsOnline: online, recoveryKey: await getOrCreateRecoveryKey(ctx) };
    },
  }),

  updateProfile: defineAction({
    description: "Updates the profile's display name, public 'About my cooking' bio, optional location line, favourite-cuisine chips, and/or photo (the username and code do not change here), and re-registers on the shared backend when it is on.",
    request: z.object({
      displayName: z.string().max(60),
      bio: z.string().max(160).optional(),
      location: z.string().max(60).optional(),
      specialties: z.array(z.string().min(1).max(30)).max(8).optional(),
      photo: photoAsset.nullable().default(null),
    }),
    response: z.object({
      ok: z.literal(true),
      profile: profileDto.nullable(),
      backendSynced: z.boolean(),
    }),
    async handler(ctx, args): Promise<{ ok: true; profile: z.infer<typeof profileDto> | null; backendSynced: boolean }> {
      const db = ctx.db<typeof schema>();
      const me = await getLocalProfile(ctx);
      if (!me) return { ok: true, profile: null, backendSynced: false };
      const patch: Partial<{ displayName: string; bio: string; location: string; specialties: string; photoKey: string | null; photoData: string | null; updatedAt: Date }> = {
        displayName: args.displayName.trim(),
        updatedAt: new Date(),
      };
      if (args.bio !== undefined) patch.bio = args.bio.trim();
      if (args.location !== undefined) patch.location = args.location.trim();
      if (args.specialties !== undefined) {
        patch.specialties = JSON.stringify(args.specialties.map((s) => s.trim()).filter(Boolean).slice(0, 8));
      }
      if (args.photo) {
        patch.photoKey = await storeBlobAsset(ctx, args.photo, "profile");
        patch.photoData = args.photo.dataBase64.length <= 400_000
          ? `data:${args.photo.mimeType};base64,${args.photo.dataBase64}`
          : null;
      }
      await db.update(schema.profiles).set(patch).where(eq(schema.profiles.id, me.id));
      const online = await kcFriendsOnline();
      const synced = online ? await syncProfileToBackend(ctx) : false;
      const fresh = await getLocalProfile(ctx);
      return { ok: true, profile: fresh ? await profileToDto(ctx, fresh) : null, backendSynced: synced };
    },
  }),

  changeUsername: defineAction({
    description: "Changes the profile's username (Settings only, with care): the Kitchen Companion code never changes, so friends keep finding this user. Checks the name is free on the shared backend when it is on.",
    request: z.object({ username: z.string().min(1).max(40) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      profile: profileDto.nullable(),
      backendSynced: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const me = await getLocalProfile(ctx);
      if (!me) return { ok: false, error: "Create your profile first.", profile: null, backendSynced: false };
      const username = args.username.trim();
      if (!USERNAME_RE.test(username)) {
        return { ok: false, error: USERNAME_ERROR, profile: await profileToDto(ctx, me), backendSynced: false };
      }
      if (username.toLowerCase() === me.username.toLowerCase()) {
        return { ok: true, error: null, profile: await profileToDto(ctx, me), backendSynced: (await getSetting(ctx, "profile_backend_synced", "0")) === "1" };
      }
      const online = await kcFriendsOnline();
      if (online) {
        const taken = await kcGetProfileByUsername(username);
        if (taken && taken.kc_id !== me.kcId) {
          return { ok: false, error: "That username is already taken — try another one.", profile: await profileToDto(ctx, me), backendSynced: false };
        }
      }
      await db.update(schema.profiles)
        .set({ username, updatedAt: new Date() })
        .where(eq(schema.profiles.id, me.id));
      const synced = online ? await syncProfileToBackend(ctx) : false;
      const fresh = await getLocalProfile(ctx);
      return { ok: true, error: null, profile: fresh ? await profileToDto(ctx, fresh) : null, backendSynced: synced };
    },
  }),

  syncProfile: defineAction({
    description: "Registers (or refreshes) this profile on the shared backend and pushes any shares made while it was off. Called by the app on open whenever the profile is not yet fully synced.",
    request: z.object({}),
    response: z.object({
      friendsOnline: z.boolean(),
      backendSynced: z.boolean(),
      sharesPushed: z.number(),
    }),
    async handler(ctx) {
      const online = await kcFriendsOnline();
      if (!online) return { friendsOnline: false, backendSynced: false, sharesPushed: 0 };
      const synced = await syncProfileToBackend(ctx);
      const sharesPushed = synced ? await pushPendingShares(ctx) : 0;
      ctx.invalidateQueries();
      return { friendsOnline: true, backendSynced: synced, sharesPushed };
    },
  }),

  getFriendsCached: defineAction({
    description: "Returns the Friends tab from this device's cache only — friends last seen, what they had shared, and this user's own shares — with no network call at all, so the tab (and a friend's page) paints instantly while getFriends refreshes live data in the background.",
    request: z.object({}),
    response: friendsResponse,
    async handler(ctx): Promise<FriendsResponse> {
      const me = await getLocalProfile(ctx);
      if (!me) return { friendsOnline: false, friends: [], sharedWithMe: [], myShares: [] };
      const cached = await readCachedFriends(ctx);
      return {
        friendsOnline: (await getSetting(ctx, "friends_last_online", "0")) === "1",
        friends: cached.friends,
        sharedWithMe: cached.sharedWithMe,
        myShares: await readMyShares(ctx),
      };
    },
  }),

  getFriends: defineAction({
    description: "Returns the Friends tab live from the shared backend on the fast read ladder (profiles and shares fetched in parallel), reconciling this device's cache for next time. If the backend can't be reached, it returns the on-device cache with friendsOnline false instead of an empty page.",
    request: z.object({}),
    response: friendsResponse,
    async handler(ctx): Promise<FriendsResponse> {
      const me = await getLocalProfile(ctx);
      if (!me) return { friendsOnline: false, friends: [], sharedWithMe: [], myShares: [] };
      const live = await liveFriends(ctx, me);
      if (live) return live;
      await setSetting(ctx, "friends_last_online", "0");
      const cached = await readCachedFriends(ctx);
      return {
        friendsOnline: false,
        friends: cached.friends,
        sharedWithMe: cached.sharedWithMe,
        myShares: await readMyShares(ctx),
      };
    },
  }),

  getFriendShares: defineAction({
    description: "Returns one friend's shared recipes/collections in profile-page detail: title, a finished-dish photo when the share carries a small one, and which of those shared recipes the friend has cooked (with when) — the 'recently cooked' strip. Only what that friend explicitly shared is ever read; their un-shared library and cooking stay private. Called when a friend's profile page opens, never on the list itself.",
    request: z.object({ kcId: z.string().min(3) }),
    response: z.object({
      ok: z.boolean(),
      shares: z.array(z.object({
        shareKey: z.string(),
        kind: z.enum(["recipe", "collection"]),
        title: z.string(),
        photoData: z.string().nullable(),
        cooked: z.array(z.object({
          title: z.string(),
          lastCookedAt: z.string().nullable(),
          photoData: z.string().nullable(),
        })),
      })),
    }),
    async handler(ctx, args) {
      const fail = { ok: false, shares: [] as never[] };
      const me = await getLocalProfile(ctx);
      const r = await kcFetch<Array<{ share_key: string; kind: string; title: string; payload: unknown }>>(
        `kc_shares?select=share_key,kind,title,payload&owner_kc_id=eq.${encodeURIComponent(args.kcId)}&order=created_at.desc&limit=20`,
        undefined,
        { fast: true },
      );
      if (!r.ok) return fail;
      // Audience filter (v1.6.0): shares that friend picked for someone
      // else never show on their profile as seen by me.
      const visibleRows = r.data.filter((s) => shareKeyVisibleTo(s.share_key, me?.kcId ?? null));
      // A share's payload is the backup format: photos travel as data
      // URLs assembled by the owner's app. Only small photos ride back to
      // a friend's profile — a big one would make the page crawl, which
      // is the very complaint this build fixes.
      const smallPhoto = (asset: unknown): string | null => {
        if (!asset || typeof asset !== "object") return null;
        const a = asset as { mimeType?: unknown; dataBase64?: unknown };
        if (typeof a.mimeType !== "string" || typeof a.dataBase64 !== "string") return null;
        if (a.dataBase64.length > 500_000) return null;
        return `data:${a.mimeType};base64,${a.dataBase64}`;
      };
      const shares = visibleRows.map((s) => {
        const parsed = z.object({
          recipes: z.array(z.object({
            title: z.string(),
            cookCount: z.number().default(0),
            lastCookedAt: z.string().nullable().default(null),
            dishPhoto: z.unknown().optional(),
          })).default([]),
        }).safeParse(s.payload);
        const recipes = parsed.success ? parsed.data.recipes : [];
        const first = recipes[0];
        return {
          shareKey: s.share_key,
          kind: s.kind === "collection" ? "collection" as const : "recipe" as const,
          title: s.title,
          photoData: first ? smallPhoto(first.dishPhoto) : null,
          cooked: recipes
            .filter((x) => x.cookCount > 0 || x.lastCookedAt != null)
            .map((x) => ({ title: x.title, lastCookedAt: x.lastCookedAt, photoData: smallPhoto(x.dishPhoto) })),
        };
      });
      return { ok: true, shares };
    },
  }),

  addFriend: defineAction({
    description: "Adds a friend by their Kitchen Companion code: looks the code up on the shared backend, records the friendship there, and caches the friend's profile locally. Adding is one-way seeing: this user will see what that friend shares with their friends.",
    request: z.object({ code: z.string().min(3).max(20) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      friend: friendDto.nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      void db;
      const me = await getLocalProfile(ctx);
      if (!me) return { ok: false, error: "Create your profile first.", friend: null };
      const code = args.code.trim().toUpperCase();
      if (code === me.kcId) {
        return { ok: false, error: "That's your own code — give it to a friend so they can add you.", friend: null };
      }
      const online = await kcFriendsOnline();
      if (!online) {
        return { ok: false, error: "Friends couldn't check in just now — the app couldn't reach the shared server. It keeps trying on its own, and your friend's code will work here the moment it gets through.", friend: null };
      }
      // Distinguish "the lookup ran and found nobody" from "the lookup
      // itself failed" — the first is a code problem, the second is a
      // connection problem, and the message must not blame the code for it.
      const rows = await kcSelectProfiles(`kc_id=eq.${encodeURIComponent(code)}&limit=1`);
      if (rows === null) {
        return { ok: false, error: "Your friend couldn't be looked up just now — the connection hiccuped. Try again in a moment.", friend: null };
      }
      const target = rows[0] ?? null;
      if (!target) {
        return { ok: false, error: "No Kitchen Companion cook has that code yet. Check the code with your friend and try again.", friend: null };
      }
      const ins = await kcFetch<unknown>("kc_friendships?on_conflict=owner_kc_id,friend_kc_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ owner_kc_id: me.kcId, friend_kc_id: target.kc_id }),
      });
      if (!ins.ok) {
        return { ok: false, error: "Your friend couldn't be added just now. Try again in a moment.", friend: null };
      }
      const friend = kcRowToFriend(target);
      await cacheFriend(ctx, friend);
      ctx.invalidateQueries();
      return { ok: true, error: null, friend };
    },
  }),

  removeFriend: defineAction({
    description: "Removes a friend from this user's list (on the shared backend and the local cache). The friend is not told, and this user's own shares are untouched.",
    request: z.object({ kcId: z.string().min(3) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const me = await getLocalProfile(ctx);
      if (me) {
        await kcFetch<unknown>(
          `kc_friendships?owner_kc_id=eq.${encodeURIComponent(me.kcId)}&friend_kc_id=eq.${encodeURIComponent(args.kcId)}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } },
        );
        // Audience cleanup (v1.6.0): any of my shares addressed to this
        // friend alone lose their backend row for them, and my local
        // audience lists forget them too — a share left with nobody on
        // its list is withdrawn entirely.
        await kcFetch<unknown>(
          `kc_shares?owner_kc_id=eq.${encodeURIComponent(me.kcId)}&share_key=like.${encodeURIComponent(`%#${args.kcId}`)}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } },
        );
        const mine = await db.select().from(schema.localShares);
        for (const s of mine) {
          const aud = parseAudience(s.audience);
          if (!aud || !aud.includes(args.kcId)) continue;
          const rest = aud.filter((id) => id !== args.kcId);
          if (rest.length === 0) {
            await db.delete(schema.localShares).where(eq(schema.localShares.id, s.id));
            await deleteShareRows(s.shareKey);
          } else {
            await db.update(schema.localShares)
              .set({ audience: JSON.stringify(rest) })
              .where(eq(schema.localShares.id, s.id));
          }
        }
      }
      await db.delete(schema.localFriends).where(eq(schema.localFriends.kcId, args.kcId));
      await db.delete(schema.localShared).where(eq(schema.localShared.ownerKcId, args.kcId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  createShare: defineAction({
    description: "Shares a recipe or a whole collection with this user's friends: the payload the client assembled (same format as a backup, photos included) is kept locally and pushed to the shared backend when it is on; unsent shares are pushed on a later open. Only what is explicitly shared ever leaves the library.",
    request: z.object({
      kind: z.enum(["recipe", "collection"]),
      title: z.string().min(1).max(200),
      payloadJson: z.string().min(2).max(25_000_000),
      // Who receives the share (v1.6.0): null/omitted = all friends;
      // otherwise only the picked friends' KC-IDs ever see it.
      audience: z.array(z.string().min(3).max(20)).max(50).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true), synced: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; synced: boolean }> {
      const db = ctx.db<typeof schema>();
      try {
        JSON.parse(args.payloadJson);
      } catch {
        throw new Error("createShare: payload is not valid JSON");
      }
      const audience = args.audience && args.audience.length > 0 ? [...new Set(args.audience)] : null;
      const shareKey = crypto.randomUUID();
      const inserted = await db.insert(schema.localShares).values({
        shareKey,
        kind: args.kind,
        title: args.title,
        payload: args.payloadJson,
        audience: audience ? JSON.stringify(audience) : "",
        synced: 0,
      }).returning({ id: schema.localShares.id });
      const rowId = inserted[0]?.id;
      let synced = false;
      const me = await getLocalProfile(ctx);
      if (me && rowId != null && (await kcFriendsOnline())) {
        const row = (await db.select().from(schema.localShares).where(eq(schema.localShares.id, rowId)))[0];
        if (row && (await pushShareRows(me, row))) {
          synced = true;
          await db.update(schema.localShares).set({ synced: 1 }).where(eq(schema.localShares.id, rowId));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, synced };
    },
  }),

  setShareAudience: defineAction({
    description: "Changes who can see one of this user's shares: null audience means all friends, otherwise only the listed friends' codes. The share's rows on the shared backend are rewritten to match, so a friend taken off the list stops seeing it (copies they already saved stay theirs).",
    request: z.object({
      shareKey: z.string().min(8),
      audience: z.array(z.string().min(3).max(20)).max(50).nullable(),
    }),
    response: z.object({ ok: z.literal(true), synced: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; synced: boolean }> {
      const db = ctx.db<typeof schema>();
      const audience = args.audience && args.audience.length > 0 ? [...new Set(args.audience)] : null;
      await db.update(schema.localShares)
        .set({ audience: audience ? JSON.stringify(audience) : "", synced: 0 })
        .where(eq(schema.localShares.shareKey, args.shareKey));
      let synced = false;
      const me = await getLocalProfile(ctx);
      const row = (await db.select().from(schema.localShares).where(eq(schema.localShares.shareKey, args.shareKey)))[0];
      if (me && row && (await kcFriendsOnline())) {
        await deleteShareRows(args.shareKey);
        if (await pushShareRows(me, row)) {
          synced = true;
          await db.update(schema.localShares).set({ synced: 1 }).where(eq(schema.localShares.id, row.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, synced };
    },
  }),

  unshare: defineAction({
    description: "Stops sharing a recipe or collection: removes the share locally and, when the backend is on, from the shared backend too. Friends who already saved a copy keep theirs — this stops it being shared from now on.",
    request: z.object({ shareKey: z.string().min(8) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.localShares).where(eq(schema.localShares.shareKey, args.shareKey));
      // One sweep removes the plain row and every per-recipient row.
      await deleteShareRows(args.shareKey);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveSharedRecipe: defineAction({
    description: "Saves a friend's shared recipe or collection into this user's own library (photos included), skipping anything whose title is already there. Returns the first saved recipe's id so the app can open it.",
    request: z.object({ shareKey: z.string().min(8) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      imported: z.number(),
      photosRestored: z.number(),
      recipeId: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const fail = (error: string) => ({ ok: false, error, imported: 0, photosRestored: 0, recipeId: null });
      const me = await getLocalProfile(ctx);
      // Audience check (v1.6.0): a per-recipient key ("key#KC-ID") opens
      // only for the friend it was addressed to.
      if (!shareKeyVisibleTo(args.shareKey, me?.kcId ?? null)) {
        return fail("That share wasn't sent to you, so it can't be saved.");
      }
      const online = await kcFriendsOnline();
      if (!online) return fail("Friends aren't switched on yet, so this share can't be fetched.");
      const r = await kcFetch<Array<{ payload: unknown }>>(
        `kc_shares?select=payload&share_key=eq.${encodeURIComponent(args.shareKey)}&limit=1`,
      );
      if (!r.ok || !r.data[0]) return fail("That share could not be found any more.");
      // Belt and braces: the payload itself names its audience when the
      // share was picked for certain friends.
      const payloadAudience = (r.data[0].payload as { audience?: unknown } | null)?.audience;
      if (Array.isArray(payloadAudience) && payloadAudience.length > 0
        && !(me && payloadAudience.includes(me.kcId))) {
        return fail("That share wasn't sent to you, so it can't be saved.");
      }
      const checked = z.object({
        collections: z.array(z.object({ name: z.string() })).default([]),
        recipes: z.array(importRecipeSchema).default([]),
      }).safeParse(r.data[0].payload);
      if (!checked.success) return fail("That share could not be read.");
      const result = await importLibraryData(ctx, checked.data);
      let recipeId: number | null = null;
      const firstTitle = checked.data.recipes[0]?.title.trim().toLowerCase();
      if (firstTitle) {
        const db = ctx.db<typeof schema>();
        const rows = await db.select({ id: schema.recipes.id, title: schema.recipes.title })
          .from(schema.recipes);
        recipeId = rows.find((row) => row.title.trim().toLowerCase() === firstTitle)?.id ?? null;
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, imported: result.imported, photosRestored: result.photosRestored, recipeId };
    },
  }),

  setBackendBackup: defineAction({
    description: "Turns the extra server copy of the automatic backup on or off (off by default; Anthony's call). When on, each automatic backup also saves a copy to this user's row on the shared backend, so the library survives even the whole app copy being lost.",
    request: z.object({ enabled: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await setSetting(ctx, "backend_backup_enabled", args.enabled ? "1" : "0");
      return { ok: true };
    },
  }),

  restoreBackendBackup: defineAction({
    description: "Recovers the library from the server backup copy. The public code and username identify whose backup it is; the owner's PRIVATE backup key (issued at setup, never shared with friends) is what unlocks it — its hash must match the one stamped on the backup row. Imports recipes and photos, skipping titles already in the library.",
    request: z.object({
      kcId: z.string().min(3).max(20),
      username: z.string().min(1).max(40),
      recoveryKey: z.string().min(8).max(64),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      imported: z.number(),
      skipped: z.number(),
      photosRestored: z.number(),
    }),
    async handler(ctx, args) {
      const fail = (error: string) => ({ ok: false, error, imported: 0, skipped: 0, photosRestored: 0 });
      const online = await kcFriendsOnline();
      if (!online) return fail("The shared server isn't switched on yet, so the server backup can't be reached.");
      const kcId = args.kcId.trim().toUpperCase();
      const r = await kcFetch<Array<{ username: string; payload: unknown; recovery_hash: string | null }>>(
        `kc_backups?select=username,payload,recovery_hash&kc_id=eq.${encodeURIComponent(kcId)}&limit=1`,
      );
      if (!r.ok || !r.data[0]) return fail("No server backup was found for that code.");
      if (r.data[0].username.trim().toLowerCase() !== args.username.trim().toLowerCase()) {
        return fail("That code and username don't match — check both and try again.");
      }
      if (!r.data[0].recovery_hash) {
        return fail("That server copy was saved before backup keys existed, so it can't be opened safely. A fresh server copy — saved by a copy of the app that has your recipes — opens with your backup key.");
      }
      const presented = await sha256Hex(args.recoveryKey.trim().toUpperCase());
      if (presented !== r.data[0].recovery_hash) {
        return fail("That backup key doesn't match. Your backup key is the private one from your setup — it's on your profile in Settings. The code alone can't open a backup.");
      }
      const checked = z.object({
        collections: z.array(z.object({ name: z.string() })).default([]),
        recipes: z.array(importRecipeSchema).default([]),
      }).safeParse(r.data[0].payload);
      if (!checked.success) return fail("The server backup could not be read.");
      const result = await importLibraryData(ctx, checked.data);
      ctx.invalidateQueries();
      return { ok: true, error: null, imported: result.imported, skipped: result.skipped, photosRestored: result.photosRestored };
    },
  }),

  // ---------- Jewel-Osco shopping ----------
  // Jewel-Osco has no public API for third-party apps, so the flow is a
  // handoff, not a sync: Kitchen Companion builds the cart here, the user
  // opens Jewel-Osco's own site, signs in there (credentials never enter
  // this app), and reviews/pays there. These actions persist the store
  // choice and the carts built, so the flow is real recorded state.

  getShop: defineAction({
    description: "Returns the saved grocery store (Jewel-Osco by default), the Jewel-Osco ordering link, and the history of Jewel carts built in the app.",
    request: z.object({}),
    response: z.object({
      storeName: z.string(),
      storeLocation: z.string(),
      jewelUrl: z.string(),
      orders: z.array(jewelOrderDto),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [storeName, storeLocation] = await Promise.all([
        getSetting(ctx, "store_name", "Jewel-Osco"),
        getSetting(ctx, "store_location", "Plainfield, IL"),
      ]);
      const rows = await db.select().from(schema.jewelOrders)
        .orderBy(desc(schema.jewelOrders.id)).limit(20);
      return {
        storeName,
        storeLocation,
        jewelUrl: JEWEL_URL,
        orders: rows.map(orderToDto),
      };
    },
  }),

  setStore: defineAction({
    description: "Saves the household's main grocery store name and location, shown on the Shop tab and stamped onto every Jewel cart built.",
    request: z.object({
      storeName: z.string().min(1),
      storeLocation: z.string().default(""),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.insert(schema.appSettings)
        .values({ key: "store_name", value: args.storeName.trim() })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: args.storeName.trim() } });
      await db.insert(schema.appSettings)
        .values({ key: "store_location", value: args.storeLocation.trim() })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: args.storeLocation.trim() } });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  buildJewelCart: defineAction({
    description: "Builds a Jewel-Osco cart from the shopping list: optionally from one recipe's ingredients at a chosen servings scale, or from every unticked grocery item. Saves the cart and returns it ready to copy or take to Jewel-Osco's site.",
    request: z.object({
      recipeId: z.number().int().nullable().default(null),
      servings: z.number().int().positive().nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      order: jewelOrderDto.nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const storeName = await getSetting(ctx, "store_name", "Jewel-Osco");
      const storeLocation = await getSetting(ctx, "store_location", "Plainfield, IL");
      type CartItem = { name: string; detail: string };
      const items: CartItem[] = [];
      const itemIds: number[] = [];

      if (args.recipeId != null) {
        const rows = await db.select().from(schema.recipes).where(eq(schema.recipes.id, args.recipeId));
        const recipe = rows[0];
        if (!recipe) return { ok: false, error: "That recipe could not be found.", order: null };
        const factor = recipe.servings && recipe.servings > 0 && args.servings
          ? args.servings / recipe.servings
          : 1;
        const merged = new Map<string, { qty: number | null; unit: string; name: string }>();
        for (const line of parseJsonArray(recipe.ingredients)) {
          const parsed = parseIngredient(line);
          const qty = parsed.qty != null ? parsed.qty * factor : null;
          const k = `${parsed.name.toLowerCase()}|${parsed.unit.toLowerCase()}`;
          const prev = merged.get(k);
          if (prev && prev.qty != null && qty != null) { prev.qty += qty; continue; }
          if (prev) continue;
          merged.set(k, { qty, unit: parsed.unit, name: parsed.name });
        }
        for (const agg of merged.values()) {
          items.push({
            name: agg.name,
            detail: agg.qty != null ? `${fmtQty(agg.qty)}${agg.unit ? " " + agg.unit : ""}` : "",
          });
        }
        if (items.length === 0) {
          return { ok: false, error: "This recipe has no ingredients to shop for yet.", order: null };
        }
      } else {
        const rows = await db.select().from(schema.groceryItems)
          .where(eq(schema.groceryItems.checked, 0))
          .orderBy(asc(schema.groceryItems.id));
        for (const r of rows) {
          items.push({ name: r.name, detail: r.detail });
          itemIds.push(r.id);
        }
        if (items.length === 0) {
          return { ok: false, error: "Your shopping list is empty — add a recipe's ingredients first, then build the cart.", order: null };
        }
      }

      const inserted = await db.insert(schema.jewelOrders).values({
        storeName,
        storeLocation,
        items: JSON.stringify(items),
        itemIds: JSON.stringify(itemIds),
        status: "built",
      }).returning();
      const row = inserted[0];
      if (!row) throw new Error("buildJewelCart: no row returned");
      ctx.invalidateQueries();
      return { ok: true, error: null, order: orderToDto(row) };
    },
  }),

  markJewelOrderSent: defineAction({
    description: "Marks a built Jewel cart as ordered at Jewel-Osco and clears the grocery items it was built from off the shopping list.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true), cleared: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.jewelOrders).where(eq(schema.jewelOrders.id, args.id));
      const row = rows[0];
      if (!row) throw new Error("markJewelOrderSent: order not found");
      await db.update(schema.jewelOrders)
        .set({ status: "sent" })
        .where(eq(schema.jewelOrders.id, args.id));
      let cleared = 0;
      for (const gid of parseJsonIds(row.itemIds)) {
        await db.delete(schema.groceryItems).where(eq(schema.groceryItems.id, gid));
        cleared++;
      }
      ctx.invalidateQueries();
      return { ok: true as const, cleared };
    },
  }),

  deleteJewelOrder: defineAction({
    description: "Removes one built Jewel cart from the order history. The shopping list is not changed.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.jewelOrders).where(eq(schema.jewelOrders.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  checkForUpdate: defineAction({
    description: "Checks the public Kitchen-Companion GitHub repo's version tags against the version this copy is running, and returns the latest version, its go-live time, and its What's-new notes (read from the repo's CHANGELOG.md at that tag — the same notes the app ships). Nothing is updated by this check; updating is always the user's choice.",
    request: z.object({ currentVersion: z.string().min(1) }),
    response: z.object({
      status: z.enum(["up-to-date", "update-available", "unknown"]),
      latestVersion: z.string().nullable(),
      latestDate: z.string().nullable(),
      currentDate: z.string().nullable(),
      whatsNew: z.array(z.string()),
      repoUrl: z.string(),
      checkedAt: z.string(),
    }),
    async handler(_ctx, args) {
      const REPO_URL = "https://github.com/aruikis/Kitchen-Companion";
      const base = { latestVersion: null, latestDate: null, currentDate: null, whatsNew: [] as string[], repoUrl: REPO_URL, checkedAt: new Date().toISOString() };
      const parseVer = (s: string): [number, number, number] | null => {
        const m = s.replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
        return m ? [parseInt(m[1] ?? "0", 10), parseInt(m[2] ?? "0", 10), parseInt(m[3] ?? "0", 10)] : null;
      };
      const cmp = (a: [number, number, number], b: [number, number, number]) =>
        a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      try {
        const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
        const tagsRes = await fetch("https://api.github.com/repos/aruikis/Kitchen-Companion/tags?per_page=100", { headers });
        if (!tagsRes.ok) return { status: "unknown" as const, ...base };
        const tagsJson: unknown = await tagsRes.json();
        if (!Array.isArray(tagsJson)) return { status: "unknown" as const, ...base };
        type TagInfo = { name: string; ver: [number, number, number]; sha: string };
        const tags: TagInfo[] = [];
        for (const t of tagsJson) {
          if (t && typeof t === "object") {
            const o = t as Record<string, unknown>;
            const commit = o.commit as Record<string, unknown> | undefined;
            const ver = typeof o.name === "string" ? parseVer(o.name) : null;
            if (ver && typeof o.name === "string" && typeof commit?.sha === "string") {
              tags.push({ name: o.name, ver, sha: commit.sha });
            }
          }
        }
        if (tags.length === 0) return { status: "unknown" as const, ...base };
        tags.sort((a, b) => cmp(b.ver, a.ver));
        const latest = tags[0];
        if (!latest) return { status: "unknown" as const, ...base };
        const current = parseVer(args.currentVersion);
        const commitDate = async (sha: string): Promise<string | null> => {
          try {
            const r = await fetch(`https://api.github.com/repos/aruikis/Kitchen-Companion/commits/${sha}`, { headers });
            if (!r.ok) return null;
            const j: unknown = await r.json();
            const d = (j as { commit?: { committer?: { date?: unknown } } })?.commit?.committer?.date;
            return typeof d === "string" ? d : null;
          } catch {
            return null;
          }
        };
        const latestDate = await commitDate(latest.sha);
        const currentTag = tags.find((t) => t.name.replace(/^v/i, "") === args.currentVersion.replace(/^v/i, ""));
        const currentDate = currentTag ? await commitDate(currentTag.sha) : null;

        let whatsNew: string[] = [];
        if (current && cmp(latest.ver, current) > 0) {
          try {
            const raw = await fetch(`https://raw.githubusercontent.com/aruikis/Kitchen-Companion/${latest.name}/CHANGELOG.md`, { headers: { "User-Agent": UA } });
            if (raw.ok) {
              const md = await raw.text();
              const section = md.split(/^##\s+/m).find((s) => s.trimStart().toLowerCase().startsWith(latest.name.toLowerCase()));
              if (section) {
                whatsNew = section
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l.startsWith("- "))
                  .map((l) => l.slice(2).trim())
                  .filter(Boolean)
                  .slice(0, 8);
              }
            }
          } catch {
            whatsNew = [];
          }
        }
        return {
          status: (current && cmp(latest.ver, current) > 0 ? "update-available" : "up-to-date") as "up-to-date" | "update-available",
          latestVersion: latest.name.replace(/^v/i, ""),
          latestDate,
          currentDate,
          whatsNew,
          repoUrl: REPO_URL,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        return { status: "unknown" as const, ...base };
      }
    },
  }),

  stageEmailImport: defineAction({
    description: "Stages a recipe found in the user's email into Kitchen Companion's import inbox for the cook's review — called by the user's own Muse after searching their connected mailbox (the app itself never reads email). Accepts the recipe's words (the email body or a transcription), and/or ONE attached file as base64 (a photo of a recipe card, a text file, or a PDF), plus where it came from: sender name, sender email, email subject, and the email's date. The recipe runs through the app's normal import pipeline (text structuring / photo OCR, automatic categories) and waits in the import inbox — nothing is saved into the recipe library until the cook checks, edits, and approves it on the review screen. If a recipe with the same or a very similar title is already in the library, the response and the review screen flag it so the cook can skip it.",
    request: z.object({
      senderName: z.string().default(""),
      senderEmail: z.string().default(""),
      subject: z.string().default(""),
      emailDate: z.string().nullable().default(null),
      text: z.string().max(40000).nullable().default(null),
      attachment: z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        dataBase64: z.string().min(1),
      }).nullable().default(null),
    }),
    response: z.object({
      ok: z.literal(true),
      stagedId: z.number(),
      title: z.string(),
      alreadyWaiting: z.boolean(),
      similarTitle: z.string().nullable(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const senderName = args.senderName.trim();
      const senderEmail = args.senderEmail.trim();
      const subject = args.subject.trim();
      const fromLabel = senderName || senderEmail || "an email";
      const sourceName = `Email from ${fromLabel}`;
      const att = args.attachment ?? null;
      const bodyText = (args.text ?? "").trim();

      let draft: DraftObject | null = null;
      let readNote: string | null = null;

      if (att && (att.mimeType === "image/jpeg" || att.mimeType === "image/png")) {
        // An emailed photo of a recipe card/page is read exactly like a scan.
        const res = await draftFromImage(ctx, att.dataBase64, att.mimeType);
        draft = res.draft;
        if (!res.ok) {
          readNote = "The attached photo could not be read automatically — it is kept with the recipe so the cook can type it up on the review screen.";
        }
      } else if (att && (att.mimeType.startsWith("text/") || /\.(txt|md)$/i.test(att.filename))) {
        // A text file: structure its words AND keep the file itself attached.
        try {
          const bytes = Uint8Array.from(atob(att.dataBase64), (c) => c.charCodeAt(0));
          const fileText = new TextDecoder().decode(bytes);
          const res = await draftFromText(ctx, fileText);
          draft = res.draft;
          if (!draft) readNote = "The attached text file could not be turned into a recipe automatically.";
        } catch {
          readNote = "The attached file could not be read.";
        }
        const key = await storeBlobAsset(ctx, { mimeType: att.mimeType, dataBase64: att.dataBase64 }, "file");
        if (draft) draft = { ...draft, attachmentName: att.filename, attachmentKey: key };
        else {
          draft = { ...blankDraft(), attachmentName: att.filename, attachmentKey: key };
        }
      } else if (att) {
        // A PDF or other document: the original is kept attached; the
        // email's own words, when present, become the recipe draft.
        const key = await storeBlobAsset(ctx, { mimeType: att.mimeType, dataBase64: att.dataBase64 }, "file");
        if (bodyText.length >= 10) {
          const res = await draftFromText(ctx, bodyText);
          draft = res.draft;
        }
        if (!draft) {
          draft = blankDraft();
          readNote = "The attached file is kept with the recipe; its words could not be read automatically, so the cook fills the recipe in on the review screen.";
        }
        draft = { ...draft, attachmentName: att.filename, attachmentKey: key };
      }

      if (!draft && bodyText.length >= 10) {
        const res = await draftFromText(ctx, bodyText);
        draft = res.draft;
        if (!draft) readNote = "The email's words could not be turned into a recipe automatically — a blank recipe was staged with the email kept attached for the cook.";
      }
      if (!draft) {
        draft = blankDraft();
        if (!readNote) readNote = "Nothing readable was found in this email — a blank recipe was staged for the cook to fill in.";
      }

      if (!draft.title || draft.title === "Untitled recipe") {
        draft = { ...draft, title: subject || "Untitled recipe" };
      }
      draft = { ...draft, sourceUrl: null, sourceName };
      if (!asCourse(draft.course) || !asProtein(draft.protein)) {
        const cats = await autoCategorize(ctx, {
          title: draft.title,
          description: draft.description,
          ingredients: draft.ingredients,
          prepMinutes: draft.prepMinutes,
          cookMinutes: draft.cookMinutes,
        });
        draft = { ...draft, course: asCourse(draft.course) ?? cats.course, protein: asProtein(draft.protein) ?? cats.protein };
      }

      const similarTitle = await findSimilarRecipeTitle(ctx, draft.title);

      // The same recipe from the same email staged twice (a search run
      // twice, say) waits only once.
      const waiting = await db.select().from(schema.stagedImports);
      const already = waiting.find(
        (w) =>
          titlesSimilar(w.title, draft.title) &&
          w.senderEmail.toLowerCase() === senderEmail.toLowerCase() &&
          w.subject === subject,
      );
      if (already) {
        return {
          ok: true as const,
          stagedId: already.id,
          title: already.title,
          alreadyWaiting: true,
          similarTitle,
          note: `“${already.title}” from that email is already waiting in Kitchen Companion's import inbox for review, so nothing new was staged.`,
        };
      }

      const inserted = await db.insert(schema.stagedImports).values({
        title: draft.title,
        draft: JSON.stringify(draft),
        senderName,
        senderEmail,
        subject,
        emailDate: args.emailDate,
        rawText: bodyText ? bodyText.slice(0, 20000) : null,
      }).returning({ id: schema.stagedImports.id });
      const row = inserted[0];
      if (!row) throw new Error("stageEmailImport: no row returned");
      ctx.invalidateQueries();

      const notes: string[] = [
        `Staged “${draft.title}” in Kitchen Companion's import inbox for review — nothing is saved into the recipe library until the cook checks and approves it there.`,
      ];
      if (similarTitle) {
        notes.push(`It looks like a recipe already in the library (“${similarTitle}”), so the review screen flags it and the cook can skip it.`);
      }
      if (readNote) notes.push(readNote);
      return {
        ok: true as const,
        stagedId: row.id,
        title: draft.title,
        alreadyWaiting: false,
        similarTitle,
        note: notes.join(" "),
      };
    },
  }),

  listStagedImports: defineAction({
    description: "Lists the recipes waiting in the import inbox (delivered from email by the user's Muse), newest first, each with its review-ready draft, where the email came from, and the title of a similar recipe already in the library when there is one.",
    request: z.object({}),
    response: z.object({ items: z.array(stagedImportDto) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.stagedImports).orderBy(desc(schema.stagedImports.id));
      const items = await Promise.all(rows.map((r) => stagedToDto(ctx, r)));
      return { items };
    },
  }),

  discardStagedImport: defineAction({
    description: "Removes one recipe from the import inbox without saving it (the cook decided not to keep it, or it was a duplicate).",
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.stagedImports).where(eq(schema.stagedImports.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  seedExamples: defineAction({
    description: "Pre-loads the two example recipes Anthony asked to ship in the box: sausage and sauerkraut with MASHED potatoes — kielbasa & sauerkraut served over buttery mashed potatoes (Half-Assed Homesteading's 'Rustic Kielbasa, Apple & Sauerkraut with Mashed Potatoes', the actual dish Anthony asked for, NOT a casserole) — and the top-rated homemade lasagna from Baker by Nature (4.99/5). Each is imported live through the normal import pipeline and tagged 'example'. Idempotent: any example already in the library is skipped, and a failed import is reported, never faked. Correction built in: the earlier seeded sausage example (Stockpiling Moms' Polish Sausage Casserole — the wrong dish, rejected by Anthony on-device) is removed and replaced when it is still in its untouched seeded state (example-tagged, never cooked, never favourited).",
    request: z.object({}),
    response: z.object({
      seeded: z.array(z.string()),
      skipped: z.array(z.string()),
      failed: z.array(z.string()),
      replaced: z.array(z.string()),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const examples: Array<{ label: string; url: string; titleKeyword: string; note: string }> = [
        {
          label: "Sausage & sauerkraut with mashed potatoes (example)",
          url: "https://halfassedhomesteading.com/2026/09/29/kielbasa-sauerkraut-apples/",
          titleKeyword: "sauerkraut with mashed potatoes",
          note: "⭐ Example recipe — sausage and sauerkraut with mashed potatoes, Anthony's favourite dish: kielbasa and sauerkraut served over buttery mashed potatoes (from the Half-Assed Homesteading blog), imported so a full recipe is in the box from day one. Make it your own, or delete it any time.",
        },
        {
          label: "Top-rated homemade lasagna (example)",
          url: "https://bakerbynature.com/the-best-homemade-lasagna-recipe/?fbclid=IwAR042vzN7ZotdRtoyBIGOcmYUKz-0boEk_oYi3KNcVtmwmrHBUDNiTHY3Mw",
          titleKeyword: "lasagna",
          note: "⭐ Example recipe — the top-rated homemade lasagna we found (rated 4.99 out of 5 from 76 reviews at Baker by Nature), imported so a full recipe is in the box from day one. Make it your own, or delete it any time.",
        },
      ];
      const replaced: string[] = [];
      // Correction: the first shipped build seeded Stockpiling Moms' "Polish
      // Sausage Casserole" as the sausage example, but that layered casserole
      // is not the sausage & sauerkraut with mashed potatoes dish Anthony
      // asked for. Remove it — only while it is still exactly as seeded — so
      // the real dish below takes its place.
      const stale = await db
        .select()
        .from(schema.recipes)
        .where(eq(schema.recipes.sourceUrl, "https://stockpilingmoms.com/polish-sausage-casserole/"));
      for (const row of stale) {
        if (parseJsonArray(row.tags).includes("example") && row.favorite === 0 && row.cookCount === 0) {
          await db.delete(schema.recipes).where(eq(schema.recipes.id, row.id));
          replaced.push(row.title);
        }
      }
      const existing = await db
        .select({ title: schema.recipes.title, sourceUrl: schema.recipes.sourceUrl })
        .from(schema.recipes);
      const existingTitles = existing.map((r) => r.title.toLowerCase());
      const existingUrls = existing.map((r) => r.sourceUrl ?? "");
      const seeded: string[] = [];
      const skipped: string[] = [];
      const failed: string[] = [];
      for (const ex of examples) {
        if (existingUrls.includes(ex.url) || existingTitles.some((t) => t.includes(ex.titleKeyword))) {
          skipped.push(ex.label);
          continue;
        }
        let res: DraftResponse;
        try {
          res = await draftFromUrl(ctx, ex.url);
        } catch {
          failed.push(ex.label);
          continue;
        }
        if (!res.ok || !res.draft) {
          failed.push(ex.label);
          continue;
        }
        const d = res.draft;
        const tags = ["example", ...d.tags.filter((t) => t !== "example")].slice(0, 8);
        await db.insert(schema.recipes).values({
          title: d.title,
          description: d.description,
          servings: d.servings,
          prepMinutes: d.prepMinutes,
          cookMinutes: d.cookMinutes,
          ingredients: JSON.stringify(d.ingredients),
          steps: JSON.stringify(splitSeedSteps(d.steps)),
          tags: JSON.stringify(tags),
          course: d.course,
          protein: d.protein,
          sourceUrl: d.sourceUrl,
          sourceName: d.sourceName,
          notes: ex.note,
          sourcePhotoKey: d.sourcePhotoKey,
          scanPhotoKey: d.scanPhotoKey,
          attachmentName: d.attachmentName,
          attachmentKey: d.attachmentKey,
        });
        existingTitles.push(d.title.toLowerCase());
        existingUrls.push(ex.url);
        seeded.push(d.title);
      }
      ctx.invalidateQueries();
      return { seeded, skipped, failed, replaced };
    },
  }),
} satisfies ActionsModule;

