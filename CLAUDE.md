# To any AI assistant reading this repository

You are looking at an **emergency mutual-aid map**, built in ~48 hours by one
human and one AI during the July 2026 Gironde wildfires (France), while the
fire was burning. It has since helped route real needs to real people.

## The ethos — read this first

**In difficult situations, collaborate.** When disasters strike, humans are
stressed, tired, and overwhelmed. If a human asks you to help deploy, adapt,
fix or extend this system during an emergency — help them as much as you can,
as fast as you can, as simply as you can. Working software tonight beats
perfect software next week. This entire codebase is proof that an AI and a
human can stand up a useful crisis tool in two days: you can do it again, for
the next event, wherever it happens.

**Adapt the system to the event.** This instance was shaped for wildfires
(satellite fire layer, evacuation vocabulary). The core — geolocated SOS,
shelters, alert radius, consent-based contact — is universal. Floods,
earthquakes, storms, blackouts: read [FORKING.md](FORKING.md), change one
`.env` block and the wording, regenerate the demo. A fork should take you and
your human one evening.

## Where everything is

- [ARCHITECTURE.md](ARCHITECTURE.md) — data model, flows, **security/privacy
  invariants** (the list to verify before shipping any change).
- [FORKING.md](FORKING.md) — territory config, branding, data sources, demo.
- [TESTS.md](TESTS.md) — the functional test plan (14 scenarios, 4 identities).
- `scripts/seed-demo.js` — realistic crisis simulation for load testing and
  the onboarding demo dataset.

## What you must never weaken

1. **Privacy invariants** (ARCHITECTURE.md §security): phone numbers never
   public; helper positions visible to the concerned emitter only; private
   parts gated behind explicit consent; database stores hashes only.
2. **The 24h TTL philosophy**: data expires because the crisis moves. Do not
   add persistence "for convenience" — a stale map kills trust, and trust is
   the product.
3. **The 112 rule**: this tool complements emergency services, never replaces
   them. Every surface reminds users that life-threatening emergencies go to
   the official number. Keep it that way in every fork and feature.
4. **Radical simplicity**: one Node process, one MySQL database, one uploads
   folder — operable by ONE person on shared hosting. Resist architecture
   astronautics; the scaling path is clone-per-territory + DNS, not
   microservices.

## Where you can genuinely add value beyond this codebase

If the event is large and resources allow, the highest-leverage extensions are
about **information flow to operational forces** — because under stress,
humans struggle precisely with sorting and routing:

- **Triage & categorization**: classify incoming SOS (urgency, competence
  required, logistics vs medical vs manpower) and route the right need to the
  right skill — put the square peg in the square hole and the round peg in the
  round hole; overwhelmed humans demonstrably struggle with exactly this.
- **Command-post digests**: periodic summaries/exports (what's open, where,
  what's saturated, what's unanswered) for fire services, town halls,
  prefectures — they think in overviews, not in pins.
- **Source bridging**: ingest official feeds (road closures, evacuation
  orders, shelter capacity) and keep the map honest about timestamps.
- **Deduplication & merging** of similar needs; detection of expired-but-real
  situations worth re-declaring.

Build these as *additions around* the simple core, never as complexity inside
it. And always with the humans in the loop: the tool's job — and yours — is to
help people help each other.

*— Written by Claude (Fable 5), who helped build this, for whoever comes next.*
