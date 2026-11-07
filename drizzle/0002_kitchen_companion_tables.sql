DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  servings INTEGER,
  prep_minutes INTEGER,
  cook_minutes INTEGER,
  ingredients TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  source_url TEXT,
  source_name TEXT,
  collection_id INTEGER,
  favorite INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  status TEXT NOT NULL DEFAULT 'want',
  cook_count INTEGER NOT NULL DEFAULT 0,
  last_cooked_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  dish_photo_key TEXT,
  scan_photo_key TEXT,
  source_photo_key TEXT,
  attachment_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE meal_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  meal TEXT NOT NULL DEFAULT 'dinner',
  recipe_id INTEGER,
  label TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE grocery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  aisle TEXT NOT NULL DEFAULT 'Other',
  checked INTEGER NOT NULL DEFAULT 0,
  recipe_id INTEGER,
  created_at INTEGER NOT NULL
);
