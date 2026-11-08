# Seismic Memory

A rotatable globe of every magnitude 6+ earthquake since 1900. Data is loaded from the USGS catalog when the page opens. Created by Waqar Ahmed Shaikh.

It is a static site: no build step, no server.

## Host on GitHub Pages
1. Create a public repository and upload everything in this folder (keep `index.html` and the `src` folder at the root).
2. Settings > Pages > Deploy from a branch > main, folder `/ (root)`.
3. Open https://YOUR-USERNAME.github.io/REPO-NAME/ and check that the globe loads.

## Use in Tableau
Dashboard > drag a Web Page object > paste the HTTPS URL. Use a fixed dashboard size of about 1280 x 800.

## Credits
Earthquake data: USGS Earthquake Hazards Program. Map outlines: Natural Earth (via world-atlas). Libraries: d3-geo and topojson-client, bundled in src/vendor-globe.js.
