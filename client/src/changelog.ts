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
