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
