# Kitchen Companion (UAT) — v1.4.0

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

## What's new in v1.4.0

- Welcome and your own Kitchen Companion code: the first time you open the
  app you create a username and are given your own code (KC-XXXX-XXXX),
  like a member number. A short, simple tutorial follows, and you can
  re-open it any time from Settings ("Show the tutorial again").
- Friends: add friends by their code and share recipes and whole
  collections with them inside the app. Only what you choose to share is
  visible to friends; your private library stays private. (Friends switch
  fully on once the owner's one-time server setup is done; until then the
  app says so plainly and keeps your shares safe to send automatically.)
- Your profile lives in Settings, with your username, your code, and a
  private backup key that protects your server backup — never share that
  key; your friend code is the one you give out.

## What's new in v1.3.0

- Backups now include everything: the Download backup file carries your
  recipes AND every photo and attachment, and restoring brings them all
  back (proven by a save, delete, restore test). Older text-only backup
  files still restore.
- The app also keeps automatic backup snapshots inside the app, and the
  backup panel honestly says what is protected, including a "Last backed
  up" status. An optional server copy can be switched on in the panel
  once the owner's one-time server setup is done.

## Installing (for your Muse)

Give this repository to your own Muse and ask it to install Kitchen
Companion as a space in your account. It will copy the source in, install
dependencies (bun), run the drizzle migrations, and build it.

Two things to know before you approve anything:

1. Muse will run steps that need your approval — pay attention to what you
   approve.
2. Nothing you approve touches your personal data.
