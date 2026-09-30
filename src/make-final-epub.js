// Build EPUB from hand-authored pages in pages_src/*.html
// Each file is a <section> fragment (body content only).
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SRC = "pages_src";
const OUT = "book_final.epub";
const work = ".epub-final";

fs.rmSync(work, { recursive: true, force: true });
for (const d of ["META-INF", "OEBPS/images", "OEBPS/text"]) {
    fs.mkdirSync(path.join(work, d), { recursive: true });
}
fs.writeFileSync(path.join(work, "mimetype"), "application/epub+zip");
fs.writeFileSync(path.join(work, "META-INF/container.xml"), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

const CSS = `body { font-family: serif; margin: 1em; line-height: 1.5; }
h1 { font-size: 1.4em; text-align: center; margin: 1.5em 0 0.8em; }
h2 { font-size: 1.1em; margin: 1.2em 0 0.5em; }
h3 { font-size: 1em; margin: 1em 0 0.4em; }
p { text-align: justify; margin: 0.5em 0; }
.pagenum { font-size: 0.75em; color: #999; text-align: center; margin: 2.5em 0 0.5em; }
figure { text-align: center; margin: 1em 0; page-break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; color: #666; }
ul, ol { margin: 0.5em 0 0.5em 1.5em; }
li { margin: 0.3em 0; }
table { border-collapse: collapse; margin: 1em auto; }
td, th { border: 1px solid #999; padding: 0.4em 0.7em; text-align: left; }
.center { text-align: center; }
.small { font-size: 0.85em; color: #555; }`;

fs.writeFileSync(path.join(work, "OEBPS/style.css"), CSS);

const files = fs.readdirSync(SRC).filter(f => f.endsWith(".html")).sort();
const chapters = [];
let figCount = 0;
// group 10 pages per chapter file
for (let g = 0; g < files.length; g += 10) {
    const group = files.slice(g, g + 10);
    const body = group.map(f =>
        fs.readFileSync(path.join(SRC, f), "utf8").replace(/src="images\//g, 'src="../images/')).join("\n<hr/>\n");
    // extract title from first h1
    const m = body.match(/<h1[^>]*>(.*?)<\/h1>/);
    const first = parseInt(group[0].match(/\d+/)[0], 10);
    const last = parseInt(group[group.length - 1].match(/\d+/)[0], 10);
    const fname = `chap${String(first).padStart(3, "0")}.xhtml`;
    fs.writeFileSync(path.join(work, "OEBPS/text", fname), `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${m ? m[1] : `Pages ${first}-${last}`}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
${body}
</body></html>`);
    chapters.push({ fname, label: m ? m[1] : `Pages ${first}–${last}` });
}

// copy referenced images
const usedFigs = new Set();
for (const f of files) {
    for (const m of fs.readFileSync(path.join(SRC, f), "utf8").matchAll(/images\/([^"]+)/g)) {
        usedFigs.add(m[1]);
    }
}
for (const fig of usedFigs) {
    fs.copyFileSync(path.join("build/figures", fig), path.join(work, "OEBPS/images", fig));
    figCount++;
}

const manifest = chapters.map(c =>
    `    <item id="${c.fname.replace(/\W/g, '')}" href="text/${c.fname}" media-type="application/xhtml+xml"/>`).join("\n") +
    "\n" + [...usedFigs].map(f =>
        `    <item id="${f.replace(/\W/g, '')}" href="images/${f}" media-type="image/jpeg"/>`).join("\n");
const spine = chapters.map(c => `    <itemref idref="${c.fname.replace(/\W/g, '')}"/>`).join("\n");

fs.writeFileSync(path.join(work, "OEBPS/content.opf"), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:9f2c3d4e-final-${Date.now()}</dc:identifier>
    <dc:title>How to Adjust and Repair Your Sewing Machine</dc:title>
    <dc:creator>Arthur W. Smith</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`);

fs.writeFileSync(path.join(work, "OEBPS/nav.xhtml"), `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc"><h1>Contents</h1>
    <ol>${chapters.map(c => `\n      <li><a href="text/${c.fname}">${c.label}</a></li>`).join("")}\n    </ol>
  </nav>
</body></html>`);

fs.rmSync(OUT, { force: true });
execSync(`cd ${work} && zip -q -X ../${OUT} mimetype && zip -q -rg ../${OUT} META-INF OEBPS`, { stdio: "inherit" });
fs.rmSync(work, { recursive: true, force: true });
console.log(`Done: ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${files.length} pages, ${figCount} figures)`);
