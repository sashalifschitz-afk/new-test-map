# Impact Commercial Group — Property Map

Static website (homepage + interactive property map) for Impact Commercial Group.
Map pins are generated from an Airtable base **at deploy time** — the browser only
ever loads a static JSON file, so the Airtable token is never exposed in page source.

## How it works

1. On every Netlify deploy, `npm run build` runs `scripts/build-map-data.js`.
2. That script reads `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` (Netlify environment
   variables) and queries your tables by their table IDs.
3. Any row that has Latitude + Longitude becomes a map pin; the combined result
   is written to `public/map-data.json`. Rows without coordinates are skipped.

### Tables pulled (by ID)

| Table ID            | Label                | Map layer      |
|---------------------|----------------------|----------------|
| tblRSY9kLo9sE8Ctb   | Active Sale Listing  | active-sale    |
| tblYhMRC7nJCThGGk   | Active Lease Listing | active-lease   |
| tbl69n9HQ51qVRnaN   | Property Types       | property-type  |
| tblA5lpJMKELnpQtW   | Client Info          | client         |

The build script logs the field names and pin count it finds in each table, so
the Netlify deploy log tells you exactly what was pulled. If coordinate or name
fields use unusual names, add them to the candidate lists near the top of
`scripts/build-map-data.js`.
4. Netlify publishes the `public/` folder. `map.html` fetches `/map-data.json`.

## Structure

```
public/
  index.html       Landing page
  map.html         Interactive map (fetches /map-data.json)
  map-data.json    Seed data; overwritten by the build on every deploy
scripts/
  build-map-data.js   Airtable -> JSON build step
netlify.toml          build command + publish folder
package.json          dependencies + build script
```

## Required environment variables (set in Netlify, never in the repo)

| Variable           | Value                          |
|--------------------|--------------------------------|
| `AIRTABLE_TOKEN`   | your Airtable personal access token (`pat...`) |
| `AIRTABLE_BASE_ID` | your base id (`app...`)        |

## Keeping the map fresh

The map updates whenever the site is rebuilt. To rebuild automatically when Airtable
data changes, trigger a Netlify build hook (from a nightly schedule or an Airtable
automation). Otherwise, every Git push or manual "Trigger deploy" also rebuilds it.

## Run the build locally (optional)

```
npm install
AIRTABLE_TOKEN=pat... AIRTABLE_BASE_ID=app... npm run build
```
