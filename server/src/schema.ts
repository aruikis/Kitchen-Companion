import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  servings: integer("servings"),
  prepMinutes: integer("prep_minutes"),
  cookMinutes: integer("cook_minutes"),
  // JSON-encoded string arrays
  ingredients: text("ingredients").notNull().default("[]"),
  steps: text("steps").notNull().default("[]"),
  tags: text("tags").notNull().default("[]"),
  // Automatic categories (Liz's request, Nov 9 2026): course ("Main Dishes",
  // "Desserts", …) and protein/type ("Poultry", "Beef", …), filled in by the
  // app when a recipe is added and correctable by the cook. Time category is
  // derived from prep+cook minutes, never stored.
  course: text("course"),
  protein: text("protein"),
  sourceUrl: text("source_url"),
  sourceName: text("source_name"),
  collectionId: integer("collection_id"),
  favorite: integer("favorite").notNull().default(0),
  rating: integer("rating"),
  status: text("status", { enum: ["want", "made"] }).notNull().default("want"),
  cookCount: integer("cook_count").notNull().default(0),
  lastCookedAt: text("last_cooked_at"),
  notes: text("notes").notNull().default(""),
  dishPhotoKey: text("dish_photo_key"),
  scanPhotoKey: text("scan_photo_key"),
  sourcePhotoKey: text("source_photo_key"),
  attachmentName: text("attachment_name"),
  // Blob key of the attached original file (e.g. an uploaded PDF). Until
  // v1.3.0 only the file's NAME was kept and the stored bytes were orphaned
  // — unrecoverable. The key makes the original reachable and backable-up.
  attachmentKey: text("attachment_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const mealPlan = sqliteTable("meal_plan", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD, local calendar date
  meal: text("meal", { enum: ["breakfast", "lunch", "dinner", "other"] })
    .notNull()
    .default("dinner"),
  recipeId: integer("recipe_id"),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// A Jewel-Osco cart built in Kitchen Companion and handed over for checkout
// on Jewel-Osco's own site. `items` is a JSON array of {name, detail};
// `itemIds` is the JSON array of grocery_items ids the cart was built from,
// so marking the order sent can clear exactly those off the shopping list.
export const jewelOrders = sqliteTable("jewel_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeName: text("store_name").notNull(),
  storeLocation: text("store_location").notNull().default(""),
  items: text("items").notNull().default("[]"),
  itemIds: text("item_ids").notNull().default("[]"),
  status: text("status", { enum: ["built", "sent"] }).notNull().default("built"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The cook's own profile (v1.4.0): created in the forced first-run welcome
// flow. One row per installed copy — this copy's identity. The username and
// KC-ID (KC-XXXX-XXXX) are registered on the shared Kitchen Companion
// backend (Supabase, the same project Vault X uses) when its kc_* tables
// are live, so friends on other copies can find this user by code.
// photoData is a small base64 copy of the profile photo kept for backend
// sync; the full photo lives in blob storage under photoKey.
export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  displayName: text("display_name").notNull().default(""),
  // Short public "About my cooking" line shown on the profile page and
  // (once the shared backend carries it) on this cook's friend profile.
  bio: text("bio").notNull().default(""),
  // Optional public location line (Cookpad-style, e.g. "Plainfield, IL").
  // Free text, blank by default, never required.
  location: text("location").notNull().default(""),
  // Public favourite-cuisine / specialty chips as a JSON string array
  // (e.g. ["Polish", "Slow cooker", "Baking"]).
  specialties: text("specialties").notNull().default("[]"),
  kcId: text("kc_id").notNull(),
  photoKey: text("photo_key"),
  photoData: text("photo_data"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Cache of this user's friends (the live list is on the backend; this
// cache lets the Friends tab render what it last saw when offline).
export const localFriends = sqliteTable("local_friends", {
  kcId: text("kc_id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull().default(""),
  bio: text("bio").notNull().default(""),
  location: text("location").notNull().default(""),
  specialties: text("specialties").notNull().default("[]"),
  joinedAt: text("joined_at"),
  photoData: text("photo_data"),
  addedAt: integer("added_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Cache of what friends have shared with this user (v1.5.2). The live list
// lives on the shared backend; this cache lets the Friends tab — and a
// friend's own page — render instantly from this device while the live
// list refreshes in the background, instead of staring at a spinner
// through several slow server round-trips.
export const localShared = sqliteTable("local_shared", {
  shareKey: text("share_key").primaryKey(),
  kind: text("kind", { enum: ["recipe", "collection"] }).notNull(),
  title: text("title").notNull(),
  ownerKcId: text("owner_kc_id").notNull(),
  ownerName: text("owner_name").notNull().default(""),
  shareCreatedAt: text("share_created_at").notNull().default(""),
});

// Recipes/collections this user has chosen to share with friends. The
// payload is the same import format a backup uses (photos embedded), so a
// friend saving it gets the whole recipe. `synced` flips to 1 once the
// share is pushed to the backend; unsynced shares are pushed on app open.
export const localShares = sqliteTable("local_shares", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shareKey: text("share_key").notNull(),
  kind: text("kind", { enum: ["recipe", "collection"] }).notNull(),
  title: text("title").notNull(),
  payload: text("payload").notNull().default("{}"),
  // Who may see this share (v1.6.0): '' = all friends; otherwise a JSON
  // array of friend KC-IDs — only those friends ever see the share.
  audience: text("audience").notNull().default(""),
  synced: integer("synced").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Recipes delivered from email by the user's own Muse, waiting for the
// cook's review (v1.5.0). The app itself never reads email — Muse is the
// bridge, searching the user's own connected mailbox and staging what it
// finds here through the stageEmailImport action. `draft` is the full
// import draft (same shape the check-and-fix screen edits) as JSON, so a
// staged item opens straight onto the existing review screen; nothing
// reaches the recipes table until the cook approves it there. The email's
// own words are kept in `rawText` and any attached file is kept as a blob
// referenced inside the draft, exactly like the other import paths.
export const stagedImports = sqliteTable("staged_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  draft: text("draft").notNull().default("{}"),
  senderName: text("sender_name").notNull().default(""),
  senderEmail: text("sender_email").notNull().default(""),
  subject: text("subject").notNull().default(""),
  emailDate: text("email_date"),
  rawText: text("raw_text"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const groceryItems = sqliteTable("grocery_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  detail: text("detail").notNull().default(""),
  aisle: text("aisle").notNull().default("Other"),
  checked: integer("checked").notNull().default(0),
  recipeId: integer("recipe_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
