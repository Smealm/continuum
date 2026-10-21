# Continuum

**The bridge between Flashpoint Infinity and Flashpoint Ultimate.**

Ultimate is the whole archive in one package; Infinity downloads only what you launch. Continuum keeps your small Infinity install and uses the same on-demand system to request everything in the background — so you can play immediately, end up with a complete local mirror, and resume at any point.

That makes either route work: install Infinity (about 1 GB) and start playing straight away while Continuum caches the archive behind you, or start from an Ultimate install and let Continuum fill the gaps and verify what is already there.

Infinity already knows how to download anything it needs. Continuum asks it for the whole catalogue, works out what is **not** on disk, and then fetches those files through the same sources, with the same file names and the same SHA-256 checks the launcher uses. You can run it slowly in the background until the archive is local, or at full speed for a specific platform, tag, library or playlist.

Nothing is extracted and no launcher files are replaced: Continuum fills `Data/Games` and `Data/Images` and marks the packs present in the launcher database, exactly like Infinity does when you launch a game.

## Why this works

Verified against a real Flashpoint **14.0.3 Infinity** install:

| Fact | Value |
|---|---|
| Games in the launcher database | 221,288 |
| Data packs | 206,796 |
| Total pack size | **2,262.8 GB** (avg 11.2 MB, largest 34 GB) |
| Logos + screenshots | 221,288 each |
| Game files | `Data/Games/<gameId>-<dateAddedMillis>.zip` |
| Pack source | `gameDataSources` → `https://download.flashpointarchive.org/gib-roms/Games/` |
| Image source | `https://infinity.flashpointarchive.org/images/` (+ `?type=jpg` when compressed images are enabled) |

The launcher's own flow lives in `src/back/Downloader.ts` and `src/back/download.ts`: for each game it downloads the logo, the screenshot, then every data pack; skips files that already exist; verifies SHA-256; writes the zip; and updates `game_data` plus `game.activeDataOnDisk`. Continuum follows that sequence and uses the public extension APIs (`gameData.save`, `games.updateGame`) for the database writes.

### The two API gaps

1. **There is no `findAllGameIds` in the extension API.** The launcher's database layer has it, but it is not exposed. Since every one of the 221,288 games has at least one tag (checked), Continuum can union `games.findGamesWithTag` across all tags to recover the complete catalogue. On the reference database that is 2,617 tags carrying 831,571 tag links, and full coverage needs about 230 tag queries returning roughly 661k hydrated game objects — slow enough to be a fallback rather than the default (see below).
2. **There is no bulk download API.** `gameData.downloadGameData` is the official single-pack call, but it opens the placeholder download dialog and shows a modal alert on failure, which does not scale to 200k packs. Continuum therefore implements the same transfer pipeline itself, but persists state only through the documented APIs. If the launcher ever exposes its `Downloader` queue to extensions, that is the natural upgrade path.

### Building the catalogue fast

The tag union is a workaround, not a good way to read 221k games: every tag query returns complete game objects with tags, platforms, data packs and add-apps attached, so the whole catalogue costs ~830k hydrated objects and thousands of round trips. On the reference install a tag-union scan collected 66,585 games in about 50 minutes before being cancelled.

The same rows live in four tables of `Data/flashpoint.sqlite`, and Flashpoint ships a `sqlite3` binary in `Legacy/`. When that tool is present, Continuum reads the database itself — one statement per table, read-only — and assembles `state/catalog.jsonl` directly:

| Catalogue build | Queries | Game objects hydrated | Measured here |
|---|---|---|---|
| Database read (default) | 8 statements | none | **37 s** (36.6-38.1 s over three runs) |
| Tag union (fallback) | 2,617 | 831,571 | hours |

Both produce the same catalogue: 221,288 games, 206,796 packs, 2,429,710,464,234 bytes, and identical titles, tags, platforms and pack rows (checked against live records such as *100 Deeds for Eddie McDowd: Match-Master*). Every text column is hex-encoded on the way through the CLI so a title containing `|`, quotes or newlines cannot corrupt the export, and the database is opened with `-readonly`.

It degrades safely. If the tool is missing, the schema is unexpected, the database is locked or the read fails for any other reason, the rebuild says so and falls back to the tag scan. A new catalogue only replaces the old one after it has been written completely (`catalog.jsonl.tmp` → rename), so a cancelled or failed build leaves the previous one intact. Switch it off with **Fast Catalogue Build** in the settings.

### How Infinity recognises the files

There is no separate index to update. The launcher database (`Data/flashpoint.sqlite`) is the registry:

- The **Installed** filter is `game.id IN (SELECT gameId FROM game_data WHERE presentOnDisk = 1)`.
- Launching a game checks the active data pack's `presentOnDisk`; when set, the launcher skips downloading and extracts `Data/Games/<gameId>-<dateAddedMillis>.zip`. The file name is derived from `dateAdded`, not read from the `path` column.
- Images are read straight from `Data/Images/<logoPath>` and fetched only when the file is missing.

Continuum writes `presentOnDisk`, `path` and `activeDataOnDisk` through the public API right after each transfer, so Infinity treats the result exactly like its own download. Dropping zips into `Data/Games` by hand is not enough: the launcher does not scan that folder at startup (its only startup pass deletes `.temp` leftovers), so an unseen zip stays invisible until a database row says it is present.

One cosmetic caveat: extension writes do not broadcast the launcher's normal game-update events, so an open Browse page can keep showing stale Installed filtering until it re-queries. The game is launchable immediately; reopening the page or restarting the launcher refreshes the view.

Because a full mirror is **~2.26 TB**, the disk guard is not optional: Continuum estimates the job, warns you before starting if it will not fit, and pauses before free space drops below the configured reserve.

## Install

Download `continuum-0.1.0.zip` from [Releases](../../releases) and extract it so that the extension folder looks like this:

```
<Flashpoint>/Data/Extensions/Continuum/
    package.json
    dist/extension.js
    dist/... (other compiled files)
```

Restart the launcher. Continuum appears in the **Config** tab under "Continuum - Offline Mirror".

From source instead:

```sh
npm install
npm run build
```

…then copy `package.json` and the whole `dist/` folder to the same place.

For development, `npm run watch` rebuilds into `dist/`; reopen the launcher (or reload the extension) to pick changes up.

## Using it

1. Open **Config → Continuum - Offline Mirror**.
2. Press **Continuum Manager** (or **Start passive** / **Start active**).
3. The first run offers to build the catalogue. With the fast build this takes about 40 seconds; it is cached afterwards and only needs rebuilding after big metadata updates.
4. Review the size estimate and free-space warning, then confirm.
5. Leave it running. Pause/stop at any time; the next start continues from the same place.

Right-clicking a playlist also offers **Mirror with Continuum**, which downloads just that playlist's games at active speed.

### Checking progress

**Check Ongoing Progress** (Config page) opens a window that updates once a second:

- **Catalogue rebuild** — current tag, games and packs found, elapsed time, ETA and a progress bar.
- **Download** — the game being fetched, games/packs/bytes so far, failures, speed, ETA, free space and a progress bar.
- **Idle** — the last action, catalogue totals, missing size and free space.

**Back** only closes the window; the rebuild or download keeps running in the background, and the same view can be reopened from the button or from **Live progress** in the Continuum Manager. The launcher's task bar also shows a progress entry while a job is active.

### Modes

- **Active** — 4 workers by default, no artificial delay, no CPU or RAM throttling. Intended for a focused download.
- **Passive** — 1 worker and a pause between games. Intended to run in the background for days.

Both modes use the same engine; only concurrency and pacing differ. Downloads are network-bound, so passive mode mostly reduces burst load on the archive servers rather than CPU.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Download Scope | `all` | `all`, `platform`, `tag`, `library`, `playlist` |
| Scope Value | empty | e.g. `Flash`, `Puzzle`, `arcade`, playlist title |
| Download Logos and Screenshots | on | Cache metadata images as well |
| Fast Catalogue Build | on | Read the launcher database directly (~40 s) instead of unioning every tag (hours) |
| Keep Free Disk Space (GB) | 5 | Pause before free space drops below this |
| Download Limit (GB) | 0 | Stop after this much in one job (0 = unlimited) |
| Active Workers | 4 | Parallel games in active mode |
| Passive Workers | 1 | Parallel games in passive mode |
| Passive Delay (ms) | 750 | Pause after each game in passive mode |
| Respect Extreme Game Setting | on | Skip games hidden by the launcher's extreme filter |
| Resume On Launcher Startup | off | Continue an unfinished job on startup |

## Disk-space guard

The guard has two parts:

1. **Before starting**, Continuum sums the missing packs plus an image estimate, reads free space for the target drive, and tells you when the job will not fit, e.g.:

   > This job needs approximately 2.21 TB, but only 511 GB is free (keeping 5 GB in reserve). Continuum will pause when the drive gets low.

   You can cancel or start anyway.
2. **While running**, every pack (and every image) is checked against the reserve, and free space is re-read at most every 30 seconds. When the reserve is reached the job pauses, saves its place, and shows one warning dialog instead of filling the drive.

Free-space detection uses `fs.statfs` on newer runtimes, and falls back to PowerShell on Windows (Electron 19 ships Node 16, so `statfs` is unavailable) or `df` on Linux/macOS. If no method works, the guard is disabled and the confirmation dialog says so explicitly.

## Resume model

`state/catalog.jsonl` is a one-record-per-line snapshot. The engine streams it and stores a byte cursor after every game. The cursor is held at the **start of the earliest in-flight game**, so a stop mid-game retries that game instead of skipping it. Re-processing is safe: existing files are skipped and database flags are repaired.

State files live in the extension folder:

```
Data/Extensions/Continuum/state/
    catalog.jsonl      # compact catalogue (ids, tags, platforms, image paths, packs)
    catalog.json       # scan metadata and totals
    job.json           # cursor, counters, mode, scope key
    failures.jsonl     # per-item failures with URLs and errors
```

A catalogue rebuild changes the generation id, which invalidates the cursor and starts a fresh pass over the new catalogue. Files already on disk are still skipped.

## What Continuum deliberately does not do

- It does not write to the SQLite database directly. All writes go through `gameData.save` and `games.updateGame`.
- It does not extract zips or alter `htdocs`. Infinity extracts a pack when a game launches, and cached packs flow through that unchanged.
- It does not use the launcher's private downloader class, require internal modules, or monkey-patch anything.
- It does not delete anything. Removing cached data is left to the launcher/tools you already use.

## Known limits

- **The catalogue is a snapshot.** New metadata is picked up by **Rebuild Catalogue**; existing downloads are not re-verified on every start (only the files the engine is about to use are checked).
- **Images are estimated, not planned.** Image sizes are not in the database, so the pre-flight estimate uses 150 KB per image. The live guard uses real bytes.
- **A failed pack is retried twice per source, then skipped** and written to `failures.jsonl`; the job continues. Rebuild/resume will try it again on the next pass.
- **No mid-file resume.** Interrupted packs restart; packs are small on average, so this is cheaper than maintaining partial state.
- **The tag-union fallback is heavy** (thousands of API calls returning hydrated game objects, hours on a full catalogue). It only runs when the database read is unavailable or switched off.
- **Being a good citizen matters.** A full mirror is 2.26 TB from shared archive infrastructure. Passive mode exists for a reason; the default worker count is deliberately modest.

## Notes

`src/typings/flashpoint-launcher.d.ts` is the type definition file published by the Flashpoint Launcher project (MIT), used as described in the launcher's extension documentation.

## Project layout

```
src/
  extension.ts        activation, commands, config buttons, auto-resume
  api.ts              adapter over the launcher extension API
  settings.ts         reads continuum.* config values
  manager.ts          dialog manager, start/scan/status flows
  core/
    catalog.ts        tag-union scanner + JSONL cache
    sqlite.ts         fast catalogue build straight from the launcher database
    engine.ts         worker pool, pause/stop, resume, disk guard, progress
    download.ts       redirect-aware HTTP download with streaming SHA-256
    disk.ts           free-space probing with Node 16 fallback
    jsonl.ts          resumable JSONL cursor
    scope.ts          scope + extreme filtering
    paths.ts          Flashpoint/state path resolution
    format.ts         filename derivation, byte formatting
    types.ts          shared types and the testable API surface
test/                 node:test suites (HTTP server, fake API, temp folders)
```

## Tests

```sh
npm test
```

53 tests cover:

- filename derivation, including the 113 real cached packs on the reference install (all matched)
- streaming downloads: hashes, mismatches, redirects, 404, abort, `.part` cleanup
- JSONL cursor offsets and resume across chunk boundaries
- catalogue tag-union, de-duplication, abort safety
- scope and extreme filtering
- free-space output parsing
- engine end-to-end mirroring with a fake launcher API and local HTTP server
- disk-guard pause, resume without skipping a game, and failure logging
- loading the compiled extension itself against a mocked `flashpoint-launcher` module, then running the full command flow (scan → confirm → download → database writes)
- catalogue activity tracking (start, updates, finish, failure, clamping)
- progress views for rebuilds, downloads, pauses and idle state, including ETA and elapsed formatting
- the live dialog opening with four fields and updating them, plus the idle fallback
- the fast catalogue build: sqlite3 discovery, hex decoding, tag/platform/pack assembly, source selection, and refusing to overwrite a good catalogue on a bad schema, a failed CLI or a cancelled read
- the manager choosing between the database build and the tag scan, including the fallback dialog and a cancelled read not restarting the slow scan
