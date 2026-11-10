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
    version: "1.6.2",
    date: "2026-11-09",
    notes: [
      "Recipe cards line up in unison now: the stars and the green Example recipe tag sit at the same height on every card, all the way down the page.",
      "Long dish names shrink a little to fit their space, so the full name always shows and every card stays the same height.",
    ],
  },
  {
    version: "1.6.1",
    date: "2026-11-09",
    notes: [
      "The Recipes page is just your recipes now — the backup panel and version notes moved off it.",
      "Everything backup lives in Settings now: download a backup, restore one, and the extra server copy are all under Backup & safety.",
      "What's new for every version is in Settings too, under App updates — that's its only home now.",
    ],
  },
  {
    version: "1.6.0",
    date: "2026-11-09",
    notes: [
      "Friends opens faster — the list is ready before you tap, and checks for anything new behind the scenes.",
      "Sharing: you can now pick exactly who gets a recipe — just one person, a few, or all your friends.",
      "Collections can be shared with picked people too, the same way.",
      "Each thing you share now says who can see it, and you can take a person off its list any time.",
      "Fixed: Back on your own profile page now returns to your Friends list.",
      "Fixed: Back from a recipe now returns to the page you opened it from — your profile, a friend's profile, or the list — and Back from the check-and-fix screen returns to the recipe you were editing.",
      "Fixed: “View my profile page” in Settings now opens your profile every time.",
    ],
  },
  {
    version: "1.5.2",
    date: "2026-11-09",
    notes: [
      "Friends loads fast now — your list shows right away from your phone, and anything new checks in behind it.",
      "New: profile pages. Tap your name — or any friend — to open a profile.",
      "Your profile shows your photo, code, when you joined, what you're sharing, and your recently cooked dishes.",
      "Add a line about your cooking, where you cook, and your favourite things to make.",
      "A friend's profile shows what they've shared — tap Save to keep a recipe for yourself.",
      "If a friend hasn't shared anything yet, their page just says so.",
    ],
  },
  {
    version: "1.5.1",
    date: "2026-11-09",
    notes: [
      "Fixed: your name now reaches the friends list on its own — a friend adding your code won't be told it doesn't exist.",
      "If the connection hiccups, the app keeps trying by itself until it gets through.",
      "Typing: the box you're typing in now moves into view, so you can always see your words.",
    ],
  },
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
