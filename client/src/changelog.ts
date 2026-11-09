// Version notes — the single source of truth for "What's new".
// The app footer and the Settings update check read from here, and the
// GitHub push renders CHANGELOG.md (and the release notes for the tag)
// from this same file, so the app and GitHub can never disagree about
// what changed in a version.

export type VersionNotes = {
  version: string;
  /** Local calendar date (America/Chicago) this version went live. */
  date: string;
  notes: string[];
};

export const CHANGELOG: VersionNotes[] = [
  {
    version: "1.4.0",
    date: "2026-11-09",
    notes: [
      "Welcome to Kitchen Companion! The first time in, the app says hello, you pick your username, and you get your very own Kitchen Companion code (like KC-XXXX-XXXX) — that's you, for friends and for your backup. A tiny five-stop tour shows the ropes, and you can see it again any time in Settings. Already had recipes here? They're untouched — they simply belong to your new profile now.",
      "Friends are arriving: there's a whole new Friends tab. Add friends by their code, see their names and photos, save what they share with you into your own library, and share a recipe (from its page) or a whole collection (from the Friends tab) with the people on your list. Only what you choose to share is ever seen — the rest of your library stays private. One honest note: friends switch on the moment one last setup step is finished on our side; your code already works, so hand it out now.",
      "Your profile lives at the top of Settings — your photo, the name friends see, your username (changeable, with care: your code never changes), and your code to copy and give out.",
      "Backup grew an extra seatbelt: in the backup panel you can turn on a server copy, and each automatic backup then also saves a copy on the shared Kitchen Companion server under your code — so your recipes survive even if this whole app copy is lost. Opening that copy takes your private backup key (shown when you set up, and kept in Settings) — your code is for friends, but the key is yours alone, and the code by itself can never open a backup. The server copy is off until you turn it on.",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-11-09",
    notes: [
      "Your photos are backed up now — really backed up. Download backup takes EVERYTHING in one file: every recipe plus its photos (the finished dish, scanned cookbook pages, and any file you attached). Restore brings the photos back too. Before this version, the backup only carried the recipe words and left the photos behind.",
      "Kitchen Companion also keeps its own automatic backup now. When the app opens and your library has changed, it quietly saves a complete copy — recipes and photos — inside your own Muse account, separate from your working recipes, and keeps the last ten. If recipes were ever deleted or lost, “Restore automatic backup” at the bottom of the Recipes tab brings them back, photos included. The backup panel on the Recipes tab and in Settings shows when the last automatic backup ran.",
      "Where your recipes live, in plain words: in this app, in your own Muse account — never on GitHub, never anywhere public. The backup you download is an extra copy that belongs to you, to keep wherever you like (email it to yourself, or keep it in your files).",
      "Files you attach to a recipe (like a PDF of a recipe card) are properly kept with the recipe now — tap the file name on the recipe page to open it again, and it is included in backups. Before, only the file’s name was kept.",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-11-09",
    notes: [
      "Photos straighten themselves now. If a scan or dish photo comes in upside down or sideways, it is turned right-side up automatically — no fixing by hand.",
      "The Jewel-Osco shopping list works end to end again: the button builds your list at the servings shown, the copy step works in the app (and shows the list on screen if copying is ever unavailable), and the Jewel-Osco link now opens their site properly, where you sign in and pay as before.",
      "Recipes file themselves now: every recipe gets a course (Main Dishes, Desserts…), a protein/type (Poultry, Beef…), and a time band (Under 30 minutes…) when it is added, with filter rows at the top of the library. Got one wrong? Open the recipe and tap “Fix a category”.",
      "Settings now checks for updates: it shows the version you have, tells you when a newer one is out with what's new in it, and gives you a copyable note to hand your own Muse when you're ready to update. Nothing ever updates without you choosing it.",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-11-07",
    notes: [
      "Photos load properly now. One bad photo link can no longer stop the whole library from loading, and a photo that fails shows a placeholder instead of a broken image.",
      "The sausage example is the real dish now: kielbasa and sauerkraut served over mashed potatoes. The Polish sausage casserole that was shipped by mistake has been replaced.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-11-07",
    notes: [
      "First UAT build: save recipes from a link or Pinterest pin, scan a cookbook page, upload a file, or type one in — every import lands on a check-and-fix screen first. Recipe pages carry a photo of the finished dish, a servings scaler, cook mode with timers, a week planner that builds a shopping list, easy sharing and backup, and the Jewel-Osco shopping handoff.",
    ],
  },
];

export function notesFor(version: string): VersionNotes | null {
  return CHANGELOG.find((v) => v.version === version) ?? null;
}
