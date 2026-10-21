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
| Image source | `https://infinity.flashpointarchive.org/images/` (+ `?type=jpg` when the launcher asks for compressed images and **Respect Flashpoint Settings** is on) |

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

The tool does not have to be the copy in `Legacy/`. Continuum looks, in order, at **SQLite Tool Path** if you set one, then the layouts Flashpoint ships on each platform (`Legacy/sqlite3[.exe]`, `Legacy/bin/sqlite3`, `Utilities/sqlite3[.exe]`, the Flashpoint folder itself), then `sqlite3` on `PATH` — macOS normally has `/usr/bin/sqlite3`, many Linux installs do not. A file that exists but is not executable is made executable when it lives in the Flashpoint folder or is one you pointed at; nothing on `PATH` is modified. Every candidate is asked for `--version` before it is trusted, so a stub file or a binary for the wrong architecture is skipped instead of breaking the rebuild. The answer is cached for the session, so a rebuild does not re-probe.

It degrades safely. If no working tool is found, the schema is unexpected, the database is locked or the read fails for any other reason, the rebuild says so and falls back to the tag scan. A new catalogue only replaces the old one after it has been written completely (`catalog.jsonl.tmp` → rename), so a cancelled or failed build leaves the previous one intact. Switch it off with **Fast Catalogue Build** in the settings.

### How Infinity recognises the files

There is no separate index to update. The launcher database (`Data/flashpoint.sqlite`) is the registry:

- The **Installed** filter is `game.id IN (SELECT gameId FROM game_data WHERE presentOnDisk = 1)`.
- Launching a game checks the active data pack's `presentOnDisk`; when set, the launcher skips downloading and extracts `Data/Games/<gameId>-<dateAddedMillis>.zip`. The file name is derived from `dateAdded`, not read from the `path` column.
- Images are read straight from `Data/Images/<logoPath>` and fetched only when the file is missing.

Continuum writes `presentOnDisk`, `path` and `activeDataOnDisk` through the public API right after each transfer, so Infinity treats the result exactly like its own download. Dropping zips into `Data/Games` by hand is not enough: the launcher does not scan that folder at startup (its only startup pass deletes `.temp` leftovers), so an unseen zip stays invisible until a database row says it is present.

One cosmetic caveat: extension writes do not broadcast the launcher's normal game-update events, so an open Browse page can keep showing stale Installed filtering until it re-queries. The game is launchable immediately; reopening the page or restarting the launcher refreshes the view.

Because a full mirror is **~2.26 TB**, the disk guard is not optional: Continuum estimates the job, warns you before starting if it will not fit, and pauses before free space drops below the configured reserve.

## Install

Download `continuum-0.4.0.zip` from [Releases](../../releases) and extract it so that the extension folder looks like this:

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
3. The manager is one short card — state, catalogue, job, progress bar and free space — with five buttons:
   - **Start** (**Resume** when a job is saved, **Pause** while it runs). Start uses the **Download Mode** setting; a resumed job keeps its own mode. Pausing finishes the current game and saves progress; there is no separate "stop now" button.
   - **Live progress** — the updating window described below.
   - **Catalogue** — last rebuild time and source (launcher database or tag scan), the last rebuild's diff summary, **Rebuild catalogue** and **Clean up old game files**.
   - **Settings** — what each setting does, where to change it, and **Reset saved progress**.
   - **Close**.
4. The first run offers to build the catalogue. With the fast build this takes about 40 seconds; it is cached afterwards and only needs rebuilding after big metadata updates.
5. Review the size estimate and free-space warning, then confirm. A resumed job was confirmed when it was started, so only a new pass asks about size and disk space.
6. Leave it running. Pause at any time; the next start continues from the same place.

Right-clicking a playlist also offers **Mirror with Continuum**, which downloads just that playlist's games at active speed.

### Playlist priority

With **Playlist Games First** on, games in any of your playlists are downloaded before the rest of the queue. Everything is still downloaded; playlist games just arrive sooner.

- The toggle is read while the job runs. Turning it on starts pulling playlist games to the front of the remaining queue; turning it off stops *new* moves (the plan already built finishes).
- Playlists are re-read at most every 30 seconds, so a game you add takes effect without restarting the job.
- Scope still wins: a playlist game outside the configured platform, tag, library or playlist scope is not downloaded early, or at all.
- Progress is saved in `job.json` (`priority: { generation, ids, cursor }`), so pause, stop and force close resume the plan instead of starting it over. A catalogue rebuild resets it. Only the first 5,000 ids are written, which keeps the file small if a playlist happens to hold the whole archive; the rest are re-read from the playlist on the next start.

Locating playlist games needs an `gameId -> offset` map, which is built once per run by streaming the catalogue when the setting is on: **2.5 s and 24.7 MB** on the reference 221,288-game catalogue. It is dropped when the job ends, and no extra file is written.

### Games you install yourself

Continuum and the launcher can work on the same library at the same time.

- When you press **Install** (or launch a game Infinity has not cached) while a job is running, the launcher fires `onDidInstallGameData`. Continuum drops that game from the current queue, cancels its own transfer if it is the one fetching it, and clears any queued retries for the game. The launcher's file and database flags are left alone.
- Uninstalling a game puts it back in the queue if the cursor has not passed it yet; otherwise the next pass picks it up.
- Installs that happen while no job is running need no handling: the next run reads the launcher's `presentOnDisk` flags and the files on disk, so the game is already considered done.

### Checking progress

**Check Ongoing Progress** (Config page) opens a window that updates once a second:

- **Catalogue rebuild** — current tag, games and packs found, elapsed time, ETA and a progress bar.
- **Download** — the game being fetched, games/packs/bytes so far, failures, speed, ETA, free space and a progress bar.
- **Idle** — the last action, catalogue totals, missing size and free space.

**Back** only closes the window; the rebuild or download keeps running in the background, and the same view can be reopened from the button or from **Live progress** in the Continuum Manager. The launcher's task bar also shows a progress entry while a job is active.

### Modes

- **Active** — up to the configured ceiling (4 by default, 20 maximum), with no artificial delay and no CPU or RAM throttling. With **Adaptive Parallelism** on it starts at two transfers and grows only while more connections actually deliver more data. Intended for a focused download.
- **Passive** — exactly 1 worker and a pause between games. Intended to run in the background for days.

Both modes use the same engine; only concurrency and pacing differ. Downloads are network-bound, so passive mode mostly reduces burst load on the archive servers rather than CPU.

### Download order: smallest games first

The archive's sizes are heavily skewed: 206,796 packs average 11.2 MB, but the median pack is around 1.7 MB and a few dozen are tens of gigabytes. Downloading in catalogue order therefore spends the first hour on whatever happens to come first. **Download Order: smallest** (the default) keeps a 500-record look-ahead window and always takes the cheapest remaining game from it:

| Link speed | Games finished in the first hour, catalogue order | Smallest first | Ratio |
|---|---|---|---|
| 5 MB/s | 1,960 | 55,429 | **28x** |
| 10 MB/s | 3,813 | 79,436 | 21x |
| 20 MB/s | 7,407 | 106,314 | 14x |
| 50 MB/s | 18,027 | 139,847 | 7.8x |

Measured by simulating a catalogue calibrated to the reference archive (206,796 packs, mean 10.4 MB, median 1.7 MB, one pack per game) byte-for-byte at each link speed. The total mirror time does not change: every game is still downloaded, the big ones simply arrive last. Playlist priority is applied first, so the ordering happens inside the priority queue; a game whose packs are mostly on disk scores cheap and moves ahead.

The window is the safety mechanism. Memory stays at 500 records instead of 221k, and the saved cursor is held at the start of the earliest game the window has not handed out, so a force close re-reads at most one window (a few milliseconds) and never skips a game. Ties keep catalogue order, so the same catalogue always produces the same sequence. **Download Order: catalogue** restores the old byte-cursor order.

### Parallel downloads

More connections only help when the bottleneck is per connection — request latency, TLS setup, redirects, or server-side shaping. Once your link is saturated they split the same bandwidth and make each individual game slower without finishing more of them.

| Per-request latency 100 ms, 24 x 1 MB | 1 conn | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| Throughput | 7.3 MB/s | 15.2 | 27.6 | 45.7 | 39.9 |

| Aggregate link 5 MB/s, 16 x 1 MB | 1 conn | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| Throughput | 2.9 MB/s | 3.1 | 3.1 | 3.1 | 3.1 |

Both measured against a local HTTP server with Continuum's own download path. That is why the controller is adaptive rather than `file size -> thread count`: it samples goodput every 15 seconds, climbs one worker while the sample improves by more than 5%, holds while it is steady, steps back when it falls by more than 15%, and halves the width on failures before a 60-second cooldown. **Active Workers** is the hard ceiling, so the archive never sees more than one client's configured maximum. Adaptive parallelism is off in passive mode and for changed-only passes, where the worker count is the exact number configured.

**Download Mode** picks which one the manager's single Start button uses. The **Start Active** and **Start Passive** buttons on the config page, **Mirror with Continuum**, and a resumed job choose explicitly and are not affected by the setting.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Download Mode | `passive` | Mode the manager's Start button uses (`passive` or `active`) |
| Download Scope | `all` | `all`, `platform`, `tag`, `library`, `playlist` |
| Scope Value | empty | e.g. `Flash`, `Puzzle`, `arcade`, playlist title |
| Fast Catalogue Build | on | Read the launcher database directly (~40 s) instead of unioning every tag (hours) |
| SQLite Tool Path | empty | Optional path to a `sqlite3` program when none is found automatically |
| Keep Free Disk Space (GB) | 5 | Pause before free space drops below this |
| Download Limit (GB) | 0 | Stop after this much in one job (0 = unlimited) |
| Active Workers | 4 | Ceiling for parallel games in active mode (up to 20) |
| Adaptive Parallelism | on | Use as many connections as actually deliver more data, up to the ceiling |
| Download Order | `smallest` | Smallest remaining games first, or `catalogue` order |
| Passive Workers | 1 | Parallel games in passive mode (exact count) |
| Passive Delay (ms) | 750 | Pause after each game in passive mode |
| Respect Flashpoint Settings | on | Follow the launcher's extreme rating, compressed images and image caching |
| Keep The Mirror Current Automatically | off | Resume or continue on startup, rebuild when the launcher database changes, and download only what changed |
| Playlist Games First | off | Download games from your playlists before the rest of the queue (read live) |

### Following the launcher's own settings

**Respect Flashpoint Settings** (on by default) makes Continuum follow the launcher preferences that change what a mirror should contain, instead of keeping its own copies:

| Launcher preference | When on | When off |
|---|---|---|
| Extreme content filter (`disableExtremeGames` + tag groups marked extreme) | Games the launcher hides are not downloaded, and are left out of the estimate | The filter is ignored; every game in scope is fetched |
| Compressed images (`onDemandImagesCompressed`) | Images are requested with `?type=jpg` when the launcher asks for compressed ones | Images are always fetched uncompressed |
| Image caching (`onDemandImages`) | Images are cached with the packs | Images are skipped entirely, and the start dialog says why |

Once the switch is off, the launcher is ignored — including its image caching, so logos and screenshots are cached anyway. That is the one asymmetry: the only way to say "no images" is the launcher's image caching preference **with Respect Flashpoint Settings on**. There is no separate Continuum image switch any more (`continuum.includeImages` was removed in 0.4.0): keeping one made no sense next to the launcher's own choice, and someone who wants the 2.26 TB of packs but not the ~40 GB of images would be saving a rounding error while losing offline browsing. Turn image caching off in the launcher, with this switch on, to skip images.

The effective values are resolved once when a job is prepared, so the estimate, the saved scope key and the workers all agree. Because the image decision is part of the scope key, switching the launcher's image caching off starts a fresh pass instead of a resume that would silently skip images.

`continuum.respectFlashpointSettings` replaces `continuum.respectExtremeFilter` in 0.2.0. The old key is ignored. Because the new switch defaults on, anyone who had deliberately turned the extreme filter off has to turn the new one off once; see [CHANGELOG.md](CHANGELOG.md).

## Disk-space guard

The guard has two parts:

1. **Before starting**, Continuum sums the missing packs plus an image estimate, reads free space for the target drive, and tells you when the job will not fit, e.g.:

   > This job needs approximately 2.21 TB, but only 511 GB is free (keeping 5 GB in reserve). Continuum will pause when the drive gets low.

   You can cancel or start anyway.
2. **While running**, every pack (and every image) is checked against the reserve, and free space is re-read at most every 30 seconds. When the reserve is reached the job pauses, saves its place, and shows one warning dialog instead of filling the drive.

Free-space detection uses `fs.statfs` on newer runtimes, and falls back to PowerShell on Windows (Electron 19 ships Node 16, so `statfs` is unavailable) or `df` on Linux/macOS. If no method works, the guard is disabled and the confirmation dialog says so explicitly.

## Resume model

`state/catalog.jsonl` is a one-record-per-line snapshot. The engine streams it and stores a byte cursor after every game. The cursor is held at the **start of the earliest in-flight game** (and, with smallest-first ordering, at the earliest game the look-ahead window has not handed out), so a stop mid-game retries that game instead of skipping it. A game the byte limit or disk guard prevented from starting is pinned the same way, so it is not lost by the pause either. Re-processing is safe: existing files are skipped and database flags are repaired.

State files live in the extension folder:

```
Data/Extensions/Continuum/state/
    catalog.jsonl      # compact catalogue (ids, tags, platforms, image paths, packs)
    catalog.json       # scan metadata and totals
    catalog.previous.jsonl  # the catalogue the last rebuild replaced (diff report)
    changed.json       # games the last rebuild changed, with catalogue offsets
    database.json      # launcher database signature of the last catalogue rebuild
    rebuild.json       # the last rebuild's diff summary, shown by the manager
    job.json           # cursor, counters, mode, scope key, playlist priority plan
    retries.json       # transient failures waiting for another attempt
    failures.jsonl     # per-item failures with URLs and errors
    denied.json        # the archive host refused access; pauses automatic work
```

A download that failed for a temporary reason (connection reset, timeout, 5xx) goes into `retries.json` with a backoff of 1 m, 5 m, 15 m, 1 h, 6 h, then 24 h; a server's `Retry-After` can push the next attempt later still. Due entries are retried at the start of the next run, and once more at the end of a pass if they come due within two minutes. Missing files (404/410) and hash mismatches are not retried, and neither is anything that reached eight attempts; `failures.jsonl` keeps the record either way. A 401/403 is not a retry at all: it ends the job and is recorded in `denied.json` (see [Talking to the archive](#talking-to-the-archive)).

Database flags are written one at a time and retried when the launcher holds the write lock. If a pack's file landed but its flag could not be written, the job reports it under `packFlagsFailed` (not as a failed download) and repairs it on the next pass.

Leftover `*.zip.part` files from a force close are removed at the start of a run once they are five minutes old. A job interrupted by a crash is relabelled `Interrupted` when the launcher next starts, and resuming continues from the same game.

A catalogue rebuild changes the generation id, which invalidates the cursor and starts a fresh pass over the new catalogue. Files already on disk are still skipped.

## Removed games and old files

Flashpoint removes games from its database from time to time. There is no changelog to follow and Continuum does not keep one: the catalogue is rebuilt from the live database, so "what should exist" is simply whatever is there now. A game that disappeared stops being a target, and a pack that appeared is a target even though it was never marked as new. That keeps the mirror current without tracking additions or removals separately.

Two things make that visible and tidy:

- **Rebuild report.** Before a rebuild replaces `catalog.jsonl`, the old file is kept as `catalog.previous.jsonl`. After the rebuild the dialog (and the log) compares the two: how many games were added, how many were removed upstream, and how many data packs changed name or hash.  It also names a few removed titles. This is informational only; nothing is downloaded or deleted because of it. On the reference catalogue (221,288 games, 116 MB) the comparison takes about 10 s and reports its own status task while it runs.
- **Clean up old game files** (manager). It reads the current catalogue, lists the data-packs folder, and finds `.zip` files whose `gameId-dateAdded` name no pack uses any more, with the counts and bytes shown before anything happens. Guard rails:
  - only the configured data-packs folder, read without recursion;
  - only regular files matching the pack-name pattern (`<gameId>-<milliseconds>.zip`);
  - only files older than 24 hours, so a launcher download Continuum has not seen yet is not touched;
  - never a name the current catalogue still uses (compared case-insensitively on Windows and macOS);
  - files of games that still exist are **superseded versions** and are only deleted when the second dialog option is chosen;
  - each file is removed on its own, so one locked file is reported and the rest continue.

Removed games have no database row left, so there is nothing to repair; only the files remain. Images are deliberately not swept: there are two per game (442,576 unique paths on the reference catalogue) and they are small next to the packs, so the risk of removing one a later catalogue still references outweighs the space saved.

### Incremental updates

A rebuild also leaves `state/changed.json`: the new games and the games whose data pack changed, each with the byte offset of its catalogue record. **Start** then asks whether to download only those games or check the whole scope again.

A changed-only pass seeks straight to each record, so it never walks the 221k-record catalogue: the estimate, the download queue and the resume point all come from the list. On the reference catalogue, reading 5,000 records by offset takes about half a second and every id matches, against 2.4 s for a full walk, before counting the 206k file checks the walk also does. The scope and extreme filters still apply, it is its own job (so it can be paused and resumed on its own), and the main catalogue cursor is untouched, so the next full pass still starts where it was. When the pass finishes, the list is removed, so the next Start is an ordinary full pass again. Choosing **Everything missing** does the usual full pass, which remains the way to notice anything the diff cannot see — for example a changed active pack that kept its file name.

If a rebuild changes more than 5,000 games, no list is written and Start does a full pass: at that size walking the catalogue is cheaper than seeking to thousands of records. A first build has no previous catalogue, so there is nothing incremental to run.

### Automatic updates

**Keep The Mirror Current Automatically** (off by default) is one switch for all of that. When it is on:

- On launcher start, an unfinished job continues where it left off. With no saved job, a pass starts only when the catalogue says something in scope is still missing. Automatic jobs use passive mode; a resumed job keeps the mode it was started with.
- Every five minutes the launcher database is checked (modification time and size, plus the launcher's `dataVersion`). When it changed, the catalogue is rebuilt with the fast build, the same report as the button runs, and the games that rebuild changed are downloaded straight away. The signature of the database that was read is kept in `state/database.json`, so restarting the launcher does not rebuild a catalogue that is already current. When every changed game in scope is already on disk, the list is removed and a full pass runs if packs are still missing, so changes the diff cannot see are still noticed.
- A rebuild that fails records nothing, so the next check tries it again. A finished or failed pass is not restarted by itself; the next rebuild is what starts new work.

No downloaded file is deleted automatically, and no dialog is shown: the log says what the automatic check did. Switching the switch on runs the first check immediately.

## Talking to the archive

The archive servers are shared infrastructure, and Continuum is a guest on them.

- **It says who it is.** Every request sends
  `Continuum/<version> (Flashpoint Infinity extension; +https://github.com/Smealm/continuum)`
  as its User-Agent. An operator can tell Continuum apart from a browser, see
  what it is from the project URL, and block it if it ever takes more than the
  archive is willing to give. That is their choice, and the identifier is what
  makes it an easy one. The string is deliberately not disguised; changing it to
  hide the client would defeat the point of having one.
- **A block is obeyed immediately.** HTTP 401 or 403 is not a transient failure:
  the job stops, nothing is retried, and the refusal is written to
  `state/denied.json`. While that file exists, automatic tasks do nothing and the
  log says why. Pressing Start explains the refusal and asks before trying again;
  only **Try again** clears the marker. If the archive has blocked Continuum,
  there is no permission to keep downloading until they say otherwise.
- **Busy servers are given time.** A `Retry-After` header (seconds or an HTTP
  date) is honoured, pushing the queued retry past Continuum's own backoff, which
  starts at one minute and grows to 24 hours. 408 and 429 stay retryable; other
  4xx responses and hash mismatches are not retried at all.
- **Connections are reused.** Keep-alive agents (32 sockets, above the worker
  ceiling) avoid a TCP and TLS handshake for every small pack, which reduces load
  on the server as much as it speeds up the client.
- **Concurrency is capped and measured.** Passive mode uses one worker, active
  mode never exceeds the configured ceiling, and adaptive parallelism backs off
  when goodput falls rather than hammering a saturated or shaped link.

## What Continuum deliberately does not do

- It does not write to the SQLite database directly. All writes go through `gameData.save` and `games.updateGame`.
- It does not extract zips or alter `htdocs`. Infinity extracts a pack when a game launches, and cached packs flow through that unchanged.
- It does not use the launcher's private downloader class, require internal modules, or monkey-patch anything.
- It does not delete anything on its own. The automatic removals are Continuum's own `*.zip.part` leftovers; old pack files are only deleted from the explicit, confirmed **Clean up old game files** action described above.
- It does not keep a redundant copy of a launcher decision. Image caching belongs to the launcher, and a separate Continuum switch for images was removed in 0.4.0.

## Known limits

- **The catalogue is a snapshot.** New metadata is picked up by **Rebuild Catalogue**; existing downloads are not re-verified on every start (only the files the engine is about to use are checked).
- **Images are estimated, not planned.** Image sizes are not in the database, so the pre-flight estimate uses 150 KB per image. The live guard uses real bytes.
- **Retries are scheduled, not instant.** Each source gets two attempts in the moment; after that the pack waits in `retries.json` for its backoff (starting at one minute). Permanent failures are dropped, not retried forever.
- **A launcher uninstall is noticed, not polled.** If you uninstall a game after the cursor has already passed it, it is downloaded again on the next pass rather than immediately.
- **Changing the extreme filter mid-job takes effect on the next pass.** The image decision is part of the saved scope key, so toggling the launcher's image caching (while Respect is on) starts a fresh pass immediately; the extreme filter is applied per game, so a resumed job keeps its place and fetches the newly included games when the pass restarts (files already on disk are skipped).
- **No mid-file resume.** Interrupted packs restart; packs are small on average, so this is cheaper than maintaining partial state.
- **The tag-union fallback is heavy** (thousands of API calls returning hydrated game objects, hours on a full catalogue). It only runs when the database read is unavailable or switched off.
- **Adaptive parallelism can only see aggregate goodput.** It settles when adding a connection stops helping, not when a particular file is unusually slow; a shape that changes mid-run is re-probed after the next sample. If in doubt, switch it off and set the exact count. Passive mode remains one worker for a reason: a full mirror is 2.26 TB from shared archive infrastructure, and the default ceiling is deliberately modest.

## Notes

`src/typings/flashpoint-launcher.d.ts` is the type definition file published by the Flashpoint Launcher project (MIT), used as described in the launcher's extension documentation.

[TASKS.md](TASKS.md) is the work queue: what is done, what is next, and the decisions behind each item.

## Project layout

```
src/
  extension.ts        activation, commands, config buttons, auto-resume
  api.ts              adapter over the launcher extension API
  settings.ts         reads continuum.* config values
  manager.ts          one-card manager, catalogue/settings submenus, start/scan flows
  core/
    auto.ts           automatic-task decision, database signature, changed-pass startup
    catalog.ts        tag-union scanner + JSONL cache
    sqlite.ts         sqlite3 discovery + fast catalogue build from the launcher database
    engine.ts         worker pool, pause/stop, resume, disk guard, progress
    dbqueue.ts        serialised database writes with lock retry
    retry.ts          persisted retry queue and failure classification
    maintenance.ts    stale .part sweep
    jobstate.ts       interrupted-job detection at startup
    reconcile.ts      rebuild diff and old-pack cleanup (scan + guarded delete)
    download.ts       redirect-aware HTTP download, keep-alive, SHA-256, Retry-After
    concurrency.ts    adaptive goodput controller and the working-width gate
    window.ts         bounded smallest-first look-ahead over the catalogue
    permission.ts     the persisted 401/403 refusal marker
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

204 tests cover:

- filename derivation, including the 113 real cached packs on the reference install (all matched)
- streaming downloads: hashes, mismatches, redirects, 404, abort, `.part` cleanup, the Continuum User-Agent, connection reuse, `Retry-After` parsing and 401/403 classification, plus a measured latency-bound comparison (8 connections finish well under half the time of one)
- the adaptive controller: climbing while goodput improves, holding on a small dip, backing off on a fall, halving on failures with a cooldown, floor and ceiling, and a zero-length sample; the work gate's width changes and cancellation
- the smallest-first window: bounded look-ahead, ties in catalogue order, the earliest-waiting offset used for a safe resume, an empty catalogue, and resuming from that offset
- a refusal: recorded and read back, junk ignored, the engine stopping after one 403 with no retry and no failed-pack count, automatic tasks pausing until cleared, and the manager asking before trying again
- JSONL cursor offsets and resume across chunk boundaries
- catalogue tag-union, de-duplication, abort safety
- scope and extreme filtering
- the Respect Flashpoint settings switch: extreme filtering following the launcher, compressed and uncompressed image URLs, images skipped when the launcher disables caching, and images cached even with launcher image caching off when the switch itself is off; the removed `continuum.includeImages` key has no effect
- the rebuild diff (new and removed games, changed packs by name or hash, no previous catalogue, seekable offsets for changed records) and the cleanup scan (only old pack-shaped files in the data-packs folder, referenced names kept, superseded versions separated, case folding, refused paths, per-file deletion failures), plus both catalogue writers keeping `catalog.previous.jsonl`
- changed-only passes: only the listed games are fetched, the main cursor does not move, a full pass afterwards fetches the rest, the list resumes after a stop without repeating a game, a stale generation is ignored, scope still filters the list, and a list that is empty or too large is not written
- automatic tasks: the database signature and `state/database.json`, rebuild vs resume vs changed or full pass decisions, refusing to restart a finished or failed job, a failed rebuild recording nothing, an automatic resume on launcher startup, and a rebuild plus first pass when the switch is turned on
- the manager: a five-line status card (state, catalogue, job, textual progress bar, free space), the Pause/Resume/Start label, the Catalogue and Settings submenus, a size confirmation for a new pass that is skipped when a saved job resumes, and Start waiting for a running catalogue rebuild
- free-space output parsing
- engine end-to-end mirroring with a fake launcher API and local HTTP server, including repairing a pack that is on disk but not flagged in the database
- disk-guard pause, resume without skipping a game, and failure logging
- database writes serialised through one queue, lock retries with doubling backoff, and a finished download not being counted as a failed pack
- retry scheduling (backoff ladder, permanence rules, persistence, attempt limit) and a queued pack being retried before the catalogue walk
- stale `.part` sweeping and interrupted-job relabelling
- playlist priority: downloading playlist games first, catalogue order when off, scope still applying, resuming a paused plan without repeating it, games added or the switch changed while a job runs, no duplicate flag writes, and a bounded job file for a huge playlist
- the settings reader, including the new switch and the existing defaults and clamps
- launcher installs: cancelling the in-flight transfer, skipping a game later in the catalogue, re-queueing an uninstall, dropping its retries, and the extension's event wiring
- two workers never downloading the same priority game at once
- a queued retry being cancelled when the launcher installs the game mid-transfer, and concurrent retry saves persisting every entry
- loading the compiled extension itself against a mocked `flashpoint-launcher` module, then running the full command flow (scan → confirm → download → database writes)
- catalogue activity tracking (start, updates, finish, failure, clamping)
- progress views for rebuilds, downloads, pauses and idle state, including ETA and elapsed formatting
- the live dialog opening with four fields and updating them, plus the idle fallback
- the fast catalogue build: sqlite3 discovery (Windows/macOS/Linux layouts, an explicit path, then PATH), version probing and the session cache, restoring a missing execute bit, hex decoding, tag/platform/pack assembly, source selection, and refusing to overwrite a good catalogue on a bad schema, a failed CLI or a cancelled read
- the manager choosing between the database build and the tag scan, including the fallback dialog and a cancelled read not restarting the slow scan
