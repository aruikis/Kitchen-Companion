// Version notes — the single source of truth for "What's new".
// The app footer and the Settings update check read from here, and the
// GitHub push renders CHANGELOG.md (and the release notes for the tag)
// from this same file, so the app and GitHub can never disagree about
// what changed in a version.
//
// Written plain and short ON PURPOSE (Anthony's rule): Liz reads these
// in Settings as the "What's new" list, so every bullet is ONE short
// friendly line a home cook can scan — what changed for her, in her
// words. No jargon, no developer detail, ever.

export type VersionNotes = {
  version: string;
  /** Local calendar date (America/Chicago) this version went live. */
  date: string;
  notes: string[];
};

export const CHANGELOG: VersionNotes[] = [
  {
    version: "1.5.0",
    date: "2026-11-09",
    notes: [
      "New: recipes can come in from your email — find the import inbox at the top of the Add tab.",
      "Ask your Muse to find recipes in your email, and they wait in the inbox for your OK.",
      "Nothing from email is saved until you check it and tap save.",
      "If an emailed recipe looks like one you already have, it says so — skip it and move on.",
      "The original email stays with the recipe while you check it.",
      "Kitchen Companion never reads your email itself — Muse is the bridge, using your own email.",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-11-09",
    notes: [
      "New: your own profile — pick a username and get your Kitchen Companion code.",
      "New: a Friends tab — add friends by their code and share recipes with them.",
      "Only the recipes you choose to share are ever seen by friends.",
      "New: an optional extra backup copy on the Kitchen Companion server, opened with your private backup key.",
      "A short tour shows you around the first time you open the app — see it again any time in Settings.",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-11-09",
    notes: [
      "Backups now include your photos — the dish, scanned pages, and attached files travel with the recipes.",
      "The app now keeps its own automatic backup copies, just in case.",
      "Files you attach to a recipe, like a PDF, are kept properly with it now.",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-11-09",
    notes: [
      "Photos that come in upside down or sideways are turned right-side up for you.",
      "The Jewel-Osco shopping list works end to end again.",
      "Recipes now file themselves by course, protein, and how long they take — with filters to match.",
      "Settings now checks for new versions and tells you what is in them.",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-11-07",
    notes: [
      "Photos load properly now — one bad photo can’t stop the whole library.",
      "The sausage example is the real dish: kielbasa and sauerkraut over mashed potatoes.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-11-07",
    notes: [
      "First version: save recipes from a link, a photo scan, a file, or by typing.",
      "Every recipe lands on a check-and-fix screen before it is saved.",
      "Recipe pages carry a photo of the finished dish and a servings scaler.",
      "Cook mode with timers, a week planner, and a shopping list.",
      "Easy sharing, backup, and the Jewel-Osco shopping handoff.",
    ],
  },
];

export function notesFor(version: string): VersionNotes | null {
  return CHANGELOG.find((v) => v.version === version) ?? null;
}
