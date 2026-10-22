# Lua · 未央 — design

The name is the brief: Lua is the moon, 未央 is "the night not yet over". The launcher frames quiet, readable content with a night-sky shell, and spends its one bold gesture on the launch action.

## Tokens (`src/theme.css`)

| Role | Light | Dark |
| --- | --- | --- |
| Night frame (sidebar, launch deck) | `#1b2140` → `#262e57` | `#0d1024` → `#171c3a` |
| Moonlight (launch button, active nav marker, logo) | `#f3c55b` | same |
| Paper / surface | `#f3f4f8` / `#ffffff` | `#12152a` / `#1a1e36` |
| Ink / muted / faint | `#1d2233` / `#4a5168` / `#7a8197` | `#e8eaf4` / `#b2b7cf` / `#8389a6` |
| Interactive accent (periwinkle) | `#4c5fd5` | `#8e9cff` |
| Status | ok `#2f8a57`, warn `#9a6512`, danger `#c0482f` | lighter equivalents |

Every component stylesheet uses these variables, so the light/dark/system appearance switch in the sidebar recolours the whole app. Never hard-code a hex value in component CSS.

## Type

System Chinese UI faces (PingFang SC, HarmonyOS Sans SC, MiSans, Microsoft YaHei UI) with system Latin. Scale 12 / 13 / 14 / 16 / 18 / 26 / 32 px; weights 400 / 500 / 600, 700 only on the launch button. Numbers use tabular figures. No all-caps labels.

## Layout

- **Sidebar**: night gradient, five primary destinations, then logs, settings, appearance and the account card (official skin head). A moon-gold bar marks the current page.
- **Launch deck** (home): night sky with a pixel-block horizon and a moon. Left: greeting, instance name, loader / version / state chips. Right: the moon-gold launch button and content / settings / folder tools. Bottom: account, Java and memory shortcuts, replaced by a progress bar while installing or launching.
- **Instance list**: one table, loader colour marks, hover-revealed actions, double-click to launch.
- Content pages: page heading, then white surfaces with 10 px radius and a soft shadow.

## Principles

- Moon gold appears only where the player starts the game; everything else interactive is periwinkle.
- Explicit empty, loading, error, installing and running states. Errors say what happened and what to do next.
- Keyboard focus always visible; dialogs use native `<dialog>`; reduced motion respected; the deck has no idle animation.
- Copy is plain and short. Detailed verification notes belong in docs, not in the interface.
