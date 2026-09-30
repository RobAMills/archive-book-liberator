// Build "rebuilt" EPUB: OCR text + extracted figure crops, no page scans
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pages = JSON.parse(fs.readFileSync("build/pages.json", "utf8"));
const OUT = "book_rebuilt.epub";
const work = ".epub-build2";
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

fs.rmSync(work, { recursive: true, force: true });
for (const d of ["META-INF", "OEBPS/images", "OEBPS/text"]) {
    fs.mkdirSync(path.join(work, d), { recursive: true });
}
fs.writeFileSync(path.join(work, "mimetype"), "application/epub+zip");
fs.writeFileSync(path.join(work, "META-INF/container.xml"), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

let figCount = 0;
const chapters = [];
// Group pages into chapters of 8 pages to keep files manageable
for (let g = 0; g < pages.length; g += 8) {
    const group = pages.slice(g, g + 8);
    const body = group.map(p => {
        const parts = p.items.map(it => {
            if (it.type === "figure") {
                fs.copyFileSync(path.join("build/figures", it.src),
                                path.join(work, "OEBPS/images", it.src));
                figCount++;
                return `<figure><img src="../images/${it.src}" alt="Diagram from page ${p.page}"/></figure>`;
            }
            const cls = it.header ? "header" : "para";
            return `<p class="${cls}">${esc(it.text).replace(/\n/g, "<br/>")}</p>`;
        }).join("\n");
        return `<section class="page" id="p${p.page}"><h2>Page ${p.page}</h2>\n${parts}\n</section>`;
    }).join("\n");
    const first = group[0].page, last = group[group.length - 1].page;
    const fname = `chap${String(first).padStart(3, "0")}.xhtml`;
    fs.writeFileSync(path.join(work, "OEBPS/text", fname), `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Pages ${first}-${last}</title>
<style>
  body { font-family: serif; margin: 1em; }
  h2 { font-size: 1em; color: #888; border-bottom: 1px solid #ccc; margin-top: 2em; }
  .header { font-weight: bold; text-align: center; font-size: 1.1em; }
  .para { text-align: justify; }
  figure { text-align: center; margin: 1em 0; page-break-inside: avoid; }
  img { max-width: 100%; height: auto; }
</style></head>
<body>
${body}
</body></html>`);
    chapters.push({ fname, label: `Pages ${first}–${last}` });
}

const manifest = chapters.map(c =>
    `    <item id="${c.fname.replace(/\W/g, '')}" href="text/${c.fname}" media-type="application/xhtml+xml"/>`).join("\n") +
    "\n" + [...new Set(pages.flatMap(p => p.items.filter(i => i.type === "figure").map(i => i.src)))]
        .map(f => `    <item id="${f.replace(/\W/g, '')}" href="images/${f}" media-type="image/jpeg"/>`).join("\n");
const spine = chapters.map(c => `    <itemref idref="${c.fname.replace(/\W/g, '')}"/>`).join("\n");

fs.writeFileSync(path.join(work, "OEBPS/content.opf"), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:9f2c3d4e-${Date.now()}</dc:identifier>
    <dc:title>How to Adjust and Repair Your Sewing Machine (Rebuilt)</dc:title>
    <dc:creator>Arthur W. Smith</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
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
console.log(`Done: ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${figCount} figures)`);
