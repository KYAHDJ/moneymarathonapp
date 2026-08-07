# Figma generation prompt — Money Marathon

Paste everything below into Figma AI / First Draft (or any AI UI generator).
It describes a real, already-built app — the goal is a matching high-fidelity
mockup, not a new design.

---

## 1. What this app is

"Money Marathon" is a mobile-first group savings tracker, styled as a cat
racing game. A group of friends shares one link; each friend claims a lane,
picks a cat character, and logs savings deposits toward a shared per-person
goal (e.g. "save ₱20,000 each for a Boracay trip"). Everyone's progress is
shown as a horse-race-style track where each racer's cat sprite slides toward
a finish line as their savings grow. The visual language is a cheerful,
colorful spreadsheet — pastel banner cells, thin grid borders, rounded
friendly type — because the app is a rebuild of a Google Sheets tracker and
should still feel like "a fun spreadsheet," not a fintech dashboard.

Platform: primarily a phone screen (375–430px wide), wrapped as an Android
app; also usable at desktop width up to ~980px centered.

## 2. Design tokens

### Color palette (exact hex — pulled directly from the source spreadsheet)

| Token | Hex | Use |
|---|---|---|
| `paper` | `#FBF9F5` | page background (cream paper, not white) |
| `panel` | `#FFFFFF` | card / panel background |
| `ink` | `#3D2314` | primary text (warm near-black brown) |
| `ink-dim` | `#3D2314` at 62% opacity | secondary text |
| `ink-faint` | `#7A6A5F` | tertiary text, hints, labels |
| `grid` | `#E8DECD` | hairline borders, dividers |
| `grid-soft` | `#F1E9DA` | subtle fills (log drawer bg, hover states) |
| `teal` | `#1F7A6C` | primary brand color — trip name banner, "live" dot, primary buttons, progress bars |
| `teal-fill` | `#A8DED3` | light teal fill (trip-name banner background, one lane color) |
| `pink` | `#EC7C93` | Race Tracker accent |
| `pink-deep` | `#C2185B` | pink text/accent, one lane color |
| `pink-fill` | `#FCE4EC` | light pink fill |
| `gold` | `#E8A33D` | Home tab accent, "leaderboard/podium" gold |
| `gold-deep` | `#C9A227` | gold text accent, "home/goal reached" state |
| `gold-fill` | `#FFE9A8` | light gold fill, one lane color |
| `blue-input` | `#1A54F2` | editable-field focus/underline — echoes the spreadsheet convention "blue text = you type here" |
| `red` | `#E0554F` | errors, offline state, delete hover |

**Six-color pastel lane cycle** (each racer's lane/avatar gets one, cycling by position):
1. Gold — fill `#FFE9A8`, ink `#C9A227`
2. Pink — fill `#F8BBD0`, ink `#C2185B`
3. Peach — fill `#F5CBA7`, ink `#B5651D`
4. Green — fill `#D7EDC0`, ink `#689F38`
5. Teal — fill `#A8DED3`, ink `#00897B`
6. Taupe — fill `#E0D5CF`, ink `#8D6E63`

### Typography

- Display/headers: **Baloo 2**, weights 600/700/800 — big rounded friendly
  headlines (trip name banner, section labels, tab labels, podium numbers).
- Body: **Nunito**, weights 400/600/700/800 — everything else (labels,
  buttons, hints, form fields).
- Numbers/money/dates: **DM Mono**, weights 400/500 — every currency figure
  and date uses this for tabular alignment.

### Shape & spacing

- Corner radius: 8px small controls, 14px medium (stat tiles, lanes), 20px
  large (cards, panels).
- Borders: 1px solid `grid` on almost everything (cards, inputs, stat tiles)
  — deliberately looks like spreadsheet cell borders.
- Page content max-width 980px, centered, 16–20px side padding.
- Section spacing: ~30px between major sections, 12px between cards in a list.

## 3. Global structure (present on every screen)

**Masthead** (top of every screen):
- Small eyebrow wordmark "MONEY MARATHON" in Baloo 2 12px, "MONEY" in teal,
  "MARATHON" in pink-deep.
- Big trip-name banner directly under it: a pill/rounded-rect (14px radius)
  filled `teal-fill` (`#A8DED3`) with `teal` (`#1F7A6C`) bold Baloo 2 text,
  ~32–42px, editable inline (tap to edit, like a big colored spreadsheet
  title cell). Placeholder: "Name this race".
- Right side (wraps below on narrow screens): a small "LIVE" pill — teal dot
  with a soft pulse animation + "Live" label (or red dot + "Offline"), and a
  pill button "Copy invite link".

**Tab bar** directly under the masthead — three tabs, underline style, each
tab's active color matches its own accent (this is intentional: it mirrors
the colored sheet tabs at the bottom of the original spreadsheet):
1. **Home** — gold underline/text when active (`#E8A33D` / `#C9A227`)
2. **Race Tracker** — pink underline/text when active (`#EC7C93` / `#C2185B`)
   — this is the default/first-opened tab.
3. **May the best racer win 🐱** — teal underline/text when active
   (`#1F7A6C`)

Tabs are Baloo 2 bold 13px, plain text (no icons), horizontally scrollable
on very narrow screens, 3px colored underline on the active tab, `ink-faint`
text on inactive tabs.

Footer note under all tab content: small centered `ink-faint` 12px text,
"Anyone with this link can edit the race. Keep it in the group chat."

A toast notification (dark `ink` pill, white text) can appear pinned to the
bottom center for confirmations/errors.

## 4. Screen 1 — Race Tracker tab (default view)

This is what a friend sees the instant they open the link — no landing page,
no "get started" button, race data loads immediately.

1. **Scoreboard** — a responsive grid of 4 small stat tiles (white panel,
   1px grid border, 14px radius): "Pooled so far" (big teal DM Mono number),
   "Goal each" (DM Mono number), "Racers" ("N on the track"), "Out front"
   (leader's name, or "nobody yet" in italic).
2. **"The Money Marathon" section** — a white panel containing a vertical
   stack of **lane rows**, one per racer (including empty/unclaimed lanes),
   each row:
   - Small lane number (01, 02…) in Baloo 2, faint.
   - Racer name (bold) or "Open lane" (faint) if unclaimed.
   - Right-aligned stats: compact saved amount + percentage (teal, or gold
     if the racer has hit their goal).
   - Below that: a horizontal **race strip** — a rounded pill-shaped track
     (~60px tall) filled with that lane's pastel color, with a circular cat
     avatar sprite positioned left→right proportional to % saved (a "wake"
     highlight trails behind it), and a small finish-line flagpost (🏁) at
     the right edge. Empty lanes show a dashed-border strip with a "+"
     placeholder avatar instead of a cat.
   - Racers who reached 100% get a gold border/glow on their strip.
3. **Podium section** — 3 side-by-side cards (1st/2nd/3rd), 1st place has a
   gold-tinted background and gold border; each shows a big rank number,
   the racer's name, and their %, or "—/open" if the slot is empty.

## 5. Screen 2 — Home tab

Setup and roster management. Three stacked sections, each a white panel:

1. **"Race setup"** — two rows: "Currency symbol" (small centered text
   input) and "Goal per person" (currency-prefixed DM Mono input).
2. **"Racers"** — a list of racer identity rows, one per racer/lane. Each
   row: small circular avatar (colored per the lane cycle, showing initial
   letter), a name text field ("Who's in this lane?"), a bank/wallet text
   field, a character `<select>` dropdown, and a ghost "Remove" button.
   Below the list: a solid teal pill button "+ Add a racer".
3. **"Character library"** — a list of character rows (three small thumbnail
   images — start/running/finish pose — plus the character name and a
   ghost "Remove" button), followed by a small form to add a new character
   (name field + three image-URL fields in a 3-column grid + a pink "Add
   character" button).

## 6. Screen 3 — "May the best racer win 🐱" tab

The money-logging screen. A vertical stack of **racer money cards** (only
racers with a name show here), each card (white, 20px radius, gold border
if goal is met):

- **Top row**: colored circular avatar/cat photo, racer name (static, bold,
  not editable here) + bank label underneath, right-aligned saved amount
  (teal DM Mono, big) and "₱X to go" / "₱X ahead" underneath.
- **Progress bar** — thin rounded bar, teal fill (gold if goal met).
- **Savings plan panel** — a distinct teal-tinted box (`teal-fill`
  background, teal border) containing:
  - A row: label "Save by", a date picker, and a cadence dropdown (options:
    Every day / Every 2 days / Every 3 days / Every Sunday…Saturday).
  - Helper copy: "Log below is filled in for you — just check off each one
    as you set it aside, or edit the amount."
  - A computed sentence: e.g. *"Save **₱1,333.33** every day to hit the goal
    by Aug 21 — 15 payments (14 days from now)."* (bold amount in pink-deep).
- **Actions row**: a teal "Log savings" pill button (toggles the log open/
  closed) + an optional small tag showing "₱X planned, not set aside".
- **Log drawer** (expands below, `grid-soft` background):
  - A quick-add form: amount field, date field, "Add" button, and a
    checkbox "Money is already set aside".
  - A scrollable list of log entries, each row: a checkbox-style circular
    toggle (filled teal when confirmed), the date (DM Mono, small, faint),
    a status word ("Set aside" / "Planned", with "(auto)" suffix for
    system-generated installments), a **right-aligned, inline-editable**
    amount field (currency symbol + underlined number, dashed underline
    that turns solid blue on focus — editable even after the plan
    generated it), and a small "×" delete button.

## 7. Empty / edge states

- No racers yet on Race Tracker: dashed-bordered empty message inside the
  panel, "The track is empty. Add a racer on the Home tab to open the first
  lane."
- No racers yet on "May the best racer win": centered empty message,
  "No racers yet. Add someone on the Home tab first."
- Goal already reached: gold accents replace teal throughout that racer's
  card/lane, plus a small 🏁 note "Already home — nothing left to save."
- First load / race missing: simple centered message screen, no heavy
  illustration — big wordmark, short explanation, one action button if
  applicable.

## 8. Deliverables to generate

Please produce, at mobile width (390px) as the primary frame and a
secondary 980px desktop frame:
1. Race Tracker tab (with 3–4 racers in varying progress, one at 100%)
2. Home tab (with the racer list and character library populated)
3. "May the best racer win" tab, one card expanded showing the savings
   plan panel + an open log with a mix of confirmed and auto-planned
   entries
4. A small component sheet: buttons (primary/ghost/pink), stat tile,
   lane row, racer card, tab bar, toast — using the color/type tokens above
