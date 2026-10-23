# CNC boundary check

A map that helps City Nature Challenge organizers decide whether to approve a project. Paste a
project link and it shows:

- **Overlaps** with projects already in the list: places where two projects' boundaries cover
  the same ground, so one observation would count for both. Projects that only share a border
  are fine and are listed as "touching".
- **Gaps** inside the project: areas completely surrounded by its places but not part of any of
  them, so observations there wouldn't count. Usually worth raising with the local organizer.

Approved projects are added to the list from the page, so each new project is checked against
everything approved before it. All boundaries come from the public iNaturalist API.

## Using the map

Open the map (this repository's GitHub Pages link). Anyone with the link can view it and check
projects; adding and removing projects needs a sign-in (below).

**Check a project.** Paste one or more project links under "Check a project" (up to 50 at a time)
and click **Check**. Each project gets a result:

- ⚠ **Overlaps** a listed project, with the size of the overlap and how much of the smaller
  project it covers. Click **Zoom** to see it on the map in red.
- ◇ **Gap inside**, with its size. It shows on the map as a dashed yellow area.
- ✓ **No overlaps or gaps found.**

Links from any iNaturalist network site work (e.g. `guatemala.inaturalist.org/projects/...`), and
you can paste rows straight from the submissions spreadsheet; only Approved / In Umbrella rows
are used.

**Then, once you've decided** (signed in):

- **Add to list**: the project is saved and appears on everyone's map. If it overlaps a listed
  project or has a gap, you're asked to confirm first.
- **Replace a listed project…**: for an organizer who made a new, updated project. Pick the old
  one (projects it overlaps are listed first) and the new one takes its place in one step.
- **Remove** (next to each project in the list): for an organizer who dropped out. The project
  stays on iNaturalist; it only leaves this map.

Changes are visible straight away to anyone signed in, and on the public link within a minute
or two.

**Reading the map.** Red areas are overlaps above the threshold; orange ones are smaller overlaps,
usually slivers where two boundary datasets don't quite line up (tick "Show below-threshold
overlaps"). Project colors mean nothing on their own; they only keep neighbours apart. A dashed
black outline is a project you've checked but not added.

## Signing in (each organizer, once)

You need a GitHub account with write access to this repository (the owner adds you under
**Settings → Collaborators**, and you accept the emailed invitation). Then:

1. Click **Sign in to add or remove projects** at the top of the page.
2. Follow the link to GitHub's new token (classic) page. The name and the **public_repo**
   permission are filled in already. Choose an expiry date and leave everything else unticked.
3. Generate the token, copy it, and paste it into the page.

It has to be a classic token: GitHub's fine-grained tokens can't yet change a repository owned by
another person's account, even for a collaborator. `public_repo` lets the token change public
repositories you have write access to, which for most organizers is only this one.

The page remembers the token in that browser only. Use **Sign out** on a shared computer. When
the token expires, the page says so; make a new one the same way.

## How it works

- `projects.csv` is the list of approved projects. The page edits it when you add, remove or
  replace a project; you don't need to touch it. (Editing it on GitHub still works.)
- `data/projects.json` holds each project's outline and every overlap and gap found. The page
  saves it together with `projects.csv` in a single commit, so the two always match.
- When two people save at the same moment, the page notices, re-checks against whatever the other
  person added, and saves on top of their change.
- Checks use simplified outlines to find possible overlaps and gaps, then download
  full-precision boundaries for just the places involved, so shared borders aren't reported as
  overlaps. Requests to iNaturalist are paced at one per second.

**The weekly update.** Organizers sometimes change their project's locations after approval. The
**Update boundary data** action (`.github/workflows/update-data.yml`) re-checks every listed
project every Monday and commits any changes, so the map stays current. It also runs after every
change to the list, and you can run it any time from the **Actions** tab ("Run workflow").

**If a project can't be checked** (link not found, no location set, not a collection project), the
weekly update lists it under "In the list but not checked", with a **Remove** button.

### Settings

- **Overlap threshold** (on the page): an overlap is flagged when it covers at least 1% of the
  smaller project **or** at least 10 km². Each viewer can change this for themselves.
- **Fixed in `lib/boundary-check.js` (`SETTINGS`)**: smallest gap reported (1 km²), what counts
  as touching (under 1 hectare of shared area), and request pacing.

## Setting up the repository (once)

1. Push this folder to a new GitHub repository with `main` as the default branch.
2. **Settings → Pages**: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**: "Read and write permissions",
   so the weekly update can commit.
4. **Settings → Collaborators**: add each organizer with the **Write** role.
5. Run the **Update boundary data** action once from the Actions tab.

The page works out which repository to save to from its GitHub Pages address. If you host it
anywhere else, set `REPO` near the top of the script in `index.html`.

Keep the submissions spreadsheet out of the repository: `projects.csv` should only ever hold
names, links and statuses. `.gitignore` already skips files named like the submissions export.

## Running it on your own computer

You need [Node.js](https://nodejs.org) 20 or newer for the build; the page only needs a web server.

```bash
npm install
node scripts/build.mjs
python3 -m http.server 8000
```

Then open http://localhost:8000. (The page has to be served, not opened as a file, because it
loads its scripts as modules.) Signing in only works on the GitHub Pages copy, or when `REPO` is set.

## Files

| File | What it is |
|---|---|
| `index.html` | The map page |
| `projects.csv` | The list of approved projects (the page keeps it up to date) |
| `data/projects.json` | Outlines, overlaps and gaps. Written by the page and the weekly update |
| `lib/boundary-check.js` | The checks, shared by the page and the weekly update |
| `lib/build.js` | Builds `data/projects.json`, and applies changes saved from the page |
| `scripts/build.mjs` | Runs the build in Node (used by the action) |
| `.github/workflows/update-data.yml` | The weekly update |
