# Kitchen Companion (UAT) — v1.2.0

A recipe app built as a Muse space (TypeScript). Save recipes from a link or
Pinterest pin, scan a cookbook page, upload a file, or type one in — every
import lands on a check-and-fix screen first. Recipe pages carry a photo of
the finished dish, a serving scaler, a week planner that builds a shopping
list, easy sharing, and an optional Jewel-Osco shopping action (it hands the
list to Jewel's own website; you sign in and pay there — no password ever
goes into this app, and there is no Jewel API or Instacart involved).

Two example recipes come in the box — sausage and sauerkraut with mashed
potatoes (kielbasa & sauerkraut served over buttery mashed potatoes) and a
top-rated homemade lasagna. They are loaded by the app's own `seedExamples`
action, which imports them live from their source pages; no database is
included in this repo, so a fresh install starts empty apart from those
examples.

## What's new in v1.2.0

- Photos straighten themselves: a photo uploaded or scanned upside down or
  sideways is rotated right-side up automatically.
- The Jewel-Osco shopping handoff is fixed: the list builds at the servings
  shown, copying works in the app (with the list shown on screen as a backup),
  and the link goes to Jewel's own site over https — you sign in and pay
  there, as always.
- Recipes categorize themselves: course (appetizers, main dishes, desserts),
  protein/type (poultry, beef, pork, vegetarian), and time (under 30 minutes
  and up) are filled in automatically and can be corrected on the recipe.
- Settings now has App updates: it shows your version, checks this repo for a
  newer one, and shows What's new before you decide — nothing updates until
  you choose.

## Installing (for your Muse)

Give this repository to your own Muse and ask it to install Kitchen
Companion as a space in your account. It will copy the source in, install
dependencies (bun), run the drizzle migrations, and build it.

Two things to know before you approve anything:

1. Muse will run steps that need your approval — pay attention to what you
   approve.
2. Nothing you approve touches your personal data.
