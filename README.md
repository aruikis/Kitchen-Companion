# Kitchen Companion (UAT) — v1.6.1

A recipe app built as a Muse space (TypeScript). Save recipes from a link or
Pinterest pin, scan a cookbook page, upload a file, bring them in from your
email through your own Muse, or type one in — every import lands on a
check-and-fix screen first. Recipe pages carry a photo of the finished dish, a
serving scaler, a week planner that builds a shopping list, friends and
sharing, and an optional Jewel-Osco shopping action (it hands the list to
Jewel's own website; you sign in and pay there — no password ever goes into
this app, and there is no Jewel API or Instacart involved).

Two example recipes come in the box — sausage and sauerkraut with mashed
potatoes (kielbasa & sauerkraut served over buttery mashed potatoes) and a
top-rated homemade lasagna. They are loaded by the app's own `seedExamples`
action; no database is included in this repo, so a fresh install starts empty
apart from those examples.

## What's new in v1.6.1

- The Recipes page is just your recipes now — the backup panel and version
  notes moved off it.
- Everything backup lives in Settings now: download a backup, restore one,
  and the extra server copy are all under Backup & safety.
- What's new for every version is in Settings too, under App updates —
  that's its only home now.

## Installing (for your Muse)

Give this repository to your own Muse and ask it to install Kitchen
Companion as a space in your account. It will copy the source in, install
dependencies (bun), run the drizzle migrations, and build it.

Two things to know before you approve anything:

1. Muse will run steps that need your approval — pay attention to what you
   approve.
2. Nothing you approve touches your personal data.
