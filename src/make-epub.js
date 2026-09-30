// Build a hybrid EPUB: page image + OCR text per page
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const IMG_DIR = "images";
const TXT_FILE = "book_ocr.txt";
const OUT = "book.epub";

const images = fs.readdirSync(IMG_DIR).filter(f => /\.jpe?g$/i.test(f)).sort();
if (!images.length) { console.error("No images found"); process.exit(1); }

// Sidecar text uses \f (form feed) between pages
const pages = fs.readFileSync(TXT_FILE, "utf8").split("\f");
console.log(`Images: ${images.length}, text pages: ${pages.length}`);

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const work = ".epub-build";
fs.rmSync(work, { recursive: true, force: true });
for (const d of ["META-INF", "OEBPS/images", "OEBPS/text"]) {
    fs.mkdirSync(path.join(work, d), { recursive: true });
}

fs.writeFileSync(path.join(work, "mimetype"), "application/epub+zip");
fs.writeFileSync(path.join(work, "META-INF/container.xml"), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

const chapters = [];
images.forEach((img, i) => {
    fs.copyFileSync(path.join(IMG_DIR, img), path.join(work, "OEBPS/images", img));
    const num = i + 1;
    const raw = (pages[i] || "").replace(/\r/g, "").trim();
    const textParas = raw ? raw.split(/\n\s*\n+/).map(p =>
        `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`).join("\n") : "";
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Page ${num}</title>
<style>
  .pageimg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  .ocrtext { margin-top: 1em; font-size: 0.85em; color: #333; }
</style></head>
<body>
  <img class="pageimg" src="../images/${img}" alt="Page ${num} scan"/>
  <section class="ocrtext">
${textParas}
  </section>
</body></html>`;
    const fname = `page${String(num).padStart(3, "0")}.xhtml`;
    fs.writeFileSync(path.join(work, "OEBPS/text", fname), xhtml);
    chapters.push(fname);
});

const manifest = images.map((img, i) =>
`    <item id="img${i + 1}" href="images/${img}" media-type="image/jpeg"/>`).join("\n") +
"\n" + chapters.map((c, i) =>
`    <item id="ch${i + 1}" href="text/${c}" media-type="application/xhtml+xml"/>`).join("\n");
const spine = chapters.map((c, i) =>
`    <itemref idref="ch${i + 1}"/>`).join("\n");

fs.writeFileSync(path.join(work, "OEBPS/content.opf"), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:7a1b2c3d-${Date.now()}</dc:identifier>
    <dc:title>How to Adjust and Repair Your Sewing Machine</dc:title>
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
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>${chapters.map((c, i) => `\n      <li><a href="text/${c}">Page ${i + 1}</a></li>`).join("")}\n    </ol>
  </nav>
</body></html>`);

fs.rmSync(OUT, { force: true });
execSync(`cd ${work} && zip -q -X ../${OUT} mimetype && zip -q -rg ../${OUT} META-INF OEBPS`, { stdio: "inherit" });
fs.rmSync(work, { recursive: true, force: true });
console.log(`Done: ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
