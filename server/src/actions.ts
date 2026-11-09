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
  const [dishPhotoUrl, scanPhotoUrl, sourcePhotoUrl] = await Promise.all([
    safePhotoUrl(ctx, row.dishPhotoKey),
    safePhotoUrl(ctx, row.scanPhotoKey),
    safePhotoUrl(ctx, row.sourcePhotoKey),
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
      },
    };
  } catch {
    return emptyDraftError("The recipe on that page could not be read automatically. Try pasting the recipe text instead.");
  }
}

// ---------- actions ----------

const draftResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  draft: z.object({
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
  }).nullable(),
});
type DraftResponse = z.infer<typeof draftResponse>;

function emptyDraftError(error: string): DraftResponse {
  return { ok: false, error, draft: null };
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
      try {
        const structured = await ctx.inference.complete(
          "Turn this text into a clean structured recipe. Keep the cook's own quantities and wording; split ingredients and steps into separate entries.",
          { schema: inferenceDraftSchema, system: "Recipe text:\n\n" + args.text },
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
          },
        };
      } catch {
        return emptyDraftError("That text could not be turned into a recipe automatically. You can still type the recipe in by hand.");
      }
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
      const bytes = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
      const key = `scan/${crypto.randomUUID()}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      try {
        const structured = await ctx.inference.complete(
          "Read the recipe in this photo and return it structured. Transcribe quantities and steps exactly as written; if handwriting is unclear, make your best reading — the cook will check and fix it on the next screen. Also judge how the page sits in the photo and report pageNeedsRotation: the clockwise rotation, in degrees, that would make the page right-side up ('none' if it already is).",
          {
            schema: scanDraftSchema,
            images: [{ dataBase64: args.dataBase64, mimeType: args.mimeType, caption: "Photo of a recipe page or card" }],
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
          },
        };
      } catch {
        return {
          ok: false,
          error: "The photo could not be read automatically. It has been kept — you can type the recipe in by hand on the review screen.",
          draft: {
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
            sourceName: "Scanned page",
            sourcePhotoKey: null,
            scanPhotoKey: key,
            attachmentName: null,
          },
        };
      }
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
    description: "Exports the whole library (recipes and collections) as structured data the user can save as a backup file — recipes are never trapped in the app.",
    request: z.object({}),
    response: z.object({
      version: z.number(),
      exportedAt: z.string(),
      collections: z.array(z.object({ id: z.number(), name: z.string() })),
      recipes: z.array(z.object({
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
      })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const collRows = await db.select().from(schema.collections).orderBy(asc(schema.collections.id));
      const collNames = new Map(collRows.map((c) => [c.id, c.name]));
      const rows = await db.select().from(schema.recipes).orderBy(asc(schema.recipes.id));
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        collections: collRows.map((c) => ({ id: c.id, name: c.name })),
        recipes: rows.map((r) => ({
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
        })),
      };
    },
  }),

  importBackup: defineAction({
    description: "Imports recipes from a Kitchen Companion backup file, skipping any whose title already exists in the library.",
    request: z.object({
      collections: z.array(z.object({ name: z.string() })).default([]),
      recipes: z.array(z.object({
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
      })).default([]),
    }),
    response: z.object({ imported: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existingColls = await db.select().from(schema.collections);
      const collIdByName = new Map(existingColls.map((c) => [c.name.toLowerCase(), c.id]));
      for (const c of args.collections) {
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
      for (const r of args.recipes) {
        const titleKey = r.title.trim().toLowerCase();
        if (existingTitles.has(titleKey)) { skipped++; continue; }
        existingTitles.add(titleKey);
        const cats = keywordCategories(r.title, r.ingredients);
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
        });
        imported++;
      }
      ctx.invalidateQueries();
      return { imported, skipped };
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
    async handler(ctx, args) {
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
