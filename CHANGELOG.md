# Changelog

## 0.4.2 — 2026-10-21

### Fixed

- **A wall of small files no longer becomes the new peak.** After the probe
  measured one large pack at, say, 10 MB/s, the controller's own five-second
  samples of 120 KB packs read only a few hundred KB/s and the old relearn
  adopted that figure as the peak. From then on every sample was "within 10% of
  the peak", so the width never grew again and the ETA was built on a rate the
  link never had. The probed rate is now a **floor**: self-samples can raise the
  goal above it but never lower it, and the width keeps climbing towards it (to
  the configured ceiling, at most) instead of settling on the queue's shape. Only
  a newer probe replaces it, which is a real re-measurement of the link.
- **Completions per second are a first-class signal.** A smallest-first queue can
  deliver very little per second while more connections finish more games, which
  is exactly the case where extra workers are worth it. The controller now
  receives pack and game completions with every sample and adds a worker while
  either bytes or completions improve, so a hundred slow connections adding up to
  the whole link are treated as progress rather than as a shortfall. When neither
  measure improves, it holds exactly as before.
- **The five-minute slow-phase relearn cannot halve the probed rate.** It lowered
  the ETA's rate every five minutes towards the small-file wall, which inflated
  the ETA on a link that had not changed. A probe-measured rate now stays the
  ETA's rate until the next probe replaces its floor, while a peak that came from
  normal downloads is still lowered after five minutes of the link running below
  half of it.

### Changed

- The adaptive controller no longer has a "relearn the peak" step: a plateau
  holds the current width and leaves the goal alone, so a later improvement or a
  new probe can still raise it.

## 0.4.1 — 2026-10-21

### Fixed

- **The ETA no longer assumes the small-file wall is the whole job.** It used to
  divide the remaining bytes by the average speed since the job started. With
  smallest-first ordering that average is set by the opening minutes of 120 KB
  packs, so a 6-hour job was quoted as 12 hours even though the link does 5–10
  MB/s once real packs are in flight. The engine now keeps the best **sustained**
  rate it has seen (a three-second sample, so a burst cannot inflate it) plus the
  best pack and game completion rates, and the ETA is the longest of the three:
  remaining bytes at the peak, remaining packs at the pack rate, and remaining
  games at the game rate. A resumed job also counts the bytes it already
  handled; previously its estimate restarted at zero and doubled the remaining
  work.
- **Smallest-first now sorts the whole catalogue.** The old 500-record
  look-ahead only ordered the next 500 games, so after the first batch the queue
  fell back to catalogue order and a worker could be handed a large game while
  smaller ones were still waiting. The pass now reads the catalogue once, sorts
  every in-scope game by remaining bytes, and seeks through the resulting queue;
  the saved position is an index into it, held at the first game that has not
  finished. Games with only logos or screenshots left sort first, ties keep
  catalogue order, and the order is deterministic for a catalogue generation.
- **Adaptive parallelism aims at the measured peak instead of stopping at the
  first small gain.** It samples every five seconds (was 15) and adds workers
  while goodput is more than 10% below the best rate it has seen, doubling the
  width when it is more than half below, so a wall of small packs no longer
  leaves most of the link idle. A wider width that delivers less than 85% of the
  peak is dropped at once; a shortfall at the width that produced the peak is
  held for 15 seconds before the peak is relearned instead of thrashing.

### Added

- **A 30-second speed probe warms up the peak.** Adaptive active jobs read one
  large pack the job still needs — at most once an hour — until the rate
  plateaus or 30 seconds pass, keep none of the bytes, and use the measured rate
  plus what the real workers were getting at the same time as the link ceiling.
  This gives the ETA and the worker count a target before the queue reaches a
  large game. The probed pack is still downloaded normally when its turn comes,
  and the probe is never written to the target drive.

### Changed

- The live progress view shows the current speed, the measured peak when it is
  higher, and an ETA based on the peak; the timing line is now understandable
  next to a queue of small games.
- A job that reached the end of a pass starts the next pass with its byte, pack
  and queue counters at zero, so a second pass no longer opens at 100% done with
  no ETA.

## 0.4.0 — 2026-10-21

### Added

- **Smallest games first** (`continuum.order`, default `smallest`): a pass
  downloads the cheapest remaining game in a 500-record look-ahead window, with
  playlist priority still winning. On a catalogue shaped like the archive
  (206,796 packs, mean 10.4 MB, median 1.7 MB) it finishes **28x more games in
  the first hour** at 5 MB/s and 8x at 50 MB/s, while total mirror time is
  unchanged. A bounded window keeps memory flat and the saved cursor still points
  at the earliest game the window has not handed out, so a crash re-reads at most
  one window. `catalogue` keeps the old order.
- **Adaptive parallelism** (`continuum.adaptiveWorkers`, default on): active
  mode starts at two transfers, samples goodput every 15 s and raises the number
  of workers while more connections deliver more data, holds when they do not,
  and halves on failures before probing again. The **Active Workers** ceiling
  now allows up to 20 and is a hard cap. Measured against a local server: 24 x 1
  MB with 100 ms latency went from 7.3 MB/s at one connection to 45.7 MB/s at
  eight, then stopped improving; with a 5 MB/s aggregate link every width from 1
  to 16 delivered the same ~3 MB/s. Passive mode and changed-only passes keep a
  fixed, exact worker count.
- **Identifies itself to the archive.** Every request sends
  `Continuum/<version> (Flashpoint Infinity extension; +project URL)` as its
  User-Agent, so an operator can see who is downloading and block Continuum if
  it ever asks for more than the archive is willing to give. Changing this string
  to hide the client would defeat its purpose.
- **A refusal is a permission decision.** HTTP 401/403 stops the job
  immediately, is never retried, is not counted as a failed pack, and is written
  to `state/denied.json`. While that marker exists automatic tasks do nothing and
  the manager explains why; only the user pressing Start and choosing **Try
  again** clears it.
- **Connection reuse and `Retry-After`.** Downloads share keep-alive HTTP/HTTPS
  agents (32 sockets, above the worker ceiling), so a run of small packs does not
  pay a TCP/TLS handshake per file. A `Retry-After` header (seconds or HTTP date)
  pushes the queued retry later than Continuum's own backoff.

### Changed

- The **Active Workers** setting is a ceiling now, not an exact count, unless
  adaptive parallelism is switched off. The default stays 4.
- A 401/403 is no longer queued in `retries.json`; the job ends instead.
- **Image caching follows the launcher only while it is being respected.**
  With **Respect Flashpoint Settings** on, launcher image caching off means no
  logos or screenshots. With it off, the launcher is ignored and images are
  cached with the packs anyway, because there is no separate Continuum image
  switch to say otherwise.

### Breaking

- `continuum.includeImages` has been removed. It duplicated the launcher's
  `onDemandImages` preference and let Continuum contradict it. Anyone who had it
  switched off should switch image caching off in the launcher, with **Respect
  Flashpoint Settings** on, instead. A mirror is ~2.26 TB of packs against
  roughly 40 GB of images, so a separate switch was saving almost nothing while
  breaking the "local copy of everything in scope" promise.

## 0.3.0 — 2026-10-21

### Added

- **Keep The Mirror Current Automatically** (`continuum.autoMirror`, default
  off): one switch for all automation. When it is on, Continuum
  - continues an unfinished job when the launcher starts, and starts a new
    passive pass when nothing is missing but no job is saved;
  - checks `Data/flashpoint.sqlite` (modification time and size) and the
    launcher's `dataVersion` every five minutes while the launcher is open, and
    rebuilds the catalogue when either changed;
  - downloads only the games that rebuild changed, using `state/changed.json`,
    and starts a full pass when the rebuild found no usable list.
  The rebuild and its report are the same ones the manager runs; nothing is
  deleted, and a finish or a failure is not retried automatically. A rebuild
  that fails records nothing, so the next check tries again.
- `state/database.json` records the database a catalogue was built from, written
  by every successful rebuild (manual or automatic).
- `state/rebuild.json` keeps the last rebuild's comparison, so the manager can
  show the diff summary without running it again.
- **Download Mode** (`continuum.mode`, default `passive`) picks the mode the
  manager's Start button uses.

### Changed

- **Manager redesigned.** One five-line status card (state, catalogue, job, a
  textual progress bar and free space) and five buttons: **Start** (or
  **Resume**, or **Pause** while a job runs), **Live progress**, **Catalogue**,
  **Settings**, **Close**. The size and disk-space confirmation is skipped when
  a saved job is resumed, because it was confirmed when that job started.
  Rebuild, old-file cleanup and reset progress are one level down in the
  Catalogue and Settings submenus. The separate **Stop now** button is gone:
  Pause already finishes the current game and saves progress.
- Automatic jobs run in passive mode; a resumed job keeps the mode it was
  started with.

### Breaking

- `continuum.autoResume` has been removed and is replaced by
  `continuum.autoMirror`. Both default to off, so existing behaviour only
  changes if the old switch was on: switch the new one on to keep resuming (and
  get the rebuilds and changed-only passes as well).

## 0.2.0 — 2026-10-21

### Added

- **Respect Flashpoint Settings** (default on): one switch that follows the
  launcher's own preferences instead of separate Continuum copies.
  - Extreme-rated games are skipped when the launcher's extreme filter is on.
  - Images are requested compressed (`?type=jpg`) when the launcher caches
    compressed images, and uncompressed otherwise.
  - Logos and screenshots are skipped when the launcher has image caching off,
    and the start dialog says why.
- **Rebuild report**: the catalogue a rebuild replaces is kept as
  `catalog.previous.jsonl`, and the completion dialog and log compare the two —
  new games, games removed upstream (with a few titles), and data packs whose
  name or hash changed.
- **Changed-only downloads**: a rebuild writes `state/changed.json` with the new
  and updated games and the byte offset of each catalogue record, and Start
  offers to download just those. The pass seeks straight to each record  instead of walking the catalogue, resumes on its own, and falls back to a full pass
  when more than 5,000 games changed or no list exists. A finished list is
  removed, so the next start is a full pass.
- **Clean up old game files** in the manager: finds pack files in the data-packs
  folder that no current game references, shows the counts and bytes, and only
  deletes after an explicit choice. Superseded versions of games that still
  exist need a separate option, files younger than 24 hours are left alone, and
  per-file failures are reported instead of stopping the pass.
- Cross-platform sqlite3 discovery for the fast catalogue build: the Flashpoint
  folder (`Legacy/`, `Legacy/bin/`, `Utilities/`), `PATH`, and a new **SQLite
  Tool Path** setting. Candidates are checked with `sqlite3 --version` before
  they are used, and a missing execute bit is restored on macOS and Linux.

### Changed

- The effective image and extreme-filter settings are resolved once per job, so
  the estimate, the saved scope key and the workers agree. Turning the
  launcher's image caching off now starts a fresh pass rather than resuming a
  job that would silently skip images.
- Status and start dialogs show when the launcher's settings are being followed.
- Nothing is deleted automatically apart from Continuum's own `.part` leftovers;
  old pack files are removed only through the confirmed cleanup action.

### Breaking

- `continuum.respectExtremeFilter` has been removed and is replaced by
  `continuum.respectFlashpointSettings`. The new switch defaults to on, so a
  user who had deliberately turned the extreme filter off must turn the new
  switch off once. No other setting changed key or default.
