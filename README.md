# Seismic Memory

An interactive, rotatable globe of every magnitude 6+ earthquake recorded since 1900, drawn from the USGS earthquake catalog.

**Live:** https://waqarshaikh86.github.io/seismic-memory-web/

## What it shows

Each dot is one earthquake. Size shows magnitude, and older quakes fade relative to the year selected on the slider. Dots can be colored by depth (shallow, mid, deep) or by magnitude class (M6, M7, M8, M9+). The headline and summary line rewrite themselves as the filters change, so the page always states what is currently on screen.

## Features

- Drag to rotate the globe, scroll to zoom, and click a dot for its date, magnitude, depth, place and USGS event ID.
- A year slider with a Play button that steps through the catalog from 1900 to today.
- Filters for minimum magnitude (M6+, M7+, M8+), depth class and decade.
- A decades chart that doubles as a filter: click a bar to isolate that decade.
- Country borders, a graticule and a key for dot size and age fade.
- Summary cards for the number of quakes shown, the strongest quake so far and the count at M8 and above.

## Data

Earthquakes come from the [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/fdsnws/event/1/) catalog through its FDSN event web service. The page requests all events of magnitude 6 and above, from 1900 to today, as CSV every time it opens. It does not store a copy, so a new quake appears the next time the page is loaded, once USGS has added it to the catalog. If USGS cannot be reached, the page shows an error message instead of stale data.

The catalog is not equally complete over time. The number of recorded M6+ events per decade rises from the early 1900s, partly because instruments and record keeping improved. The early decades should be read as undercounts, not as quieter periods. The page carries this caveat next to the decades chart.

Country outlines come from [Natural Earth](https://www.naturalearthdata.com/) through the `world-atlas` package (110 m resolution), so very small countries and islands are simplified or missing. Borders follow that dataset and do not take a position on disputed boundaries.

## How it is built

A static page with no server and no build step:

- Plain JavaScript drawing to a 2D canvas, using an orthographic projection.
- `src/vendor-globe.js` is a bundled build of `d3-geo`, `topojson-client` and the `world-atlas` outlines, so the page loads no third-party scripts.
- The only outside request the page makes is to `earthquake.usgs.gov`.

```
index.html
src/
  app.js            application logic: data loading, filters, drawing, interaction
  styles.css        layout and dark theme
  vendor-globe.js   bundled map libraries and outlines
```

## Use in Tableau

The page works as a Web Page object in a Tableau dashboard, using the live URL above. It is designed for a dashboard of about 1280 x 800 pixels. The same code is also packaged as a Tableau Data App.

## Credits

Created by Waqar Ahmed Shaikh.

Earthquake data: USGS Earthquake Hazards Program. Map outlines: Natural Earth.
