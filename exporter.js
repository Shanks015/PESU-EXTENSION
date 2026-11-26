// Everything here runs offline with no third-party libraries: a stored-only ZIP
// writer, a small PDF writer, and the minimum Office XML to make Word and
// PowerPoint open the result without asking to repair anything.
(function () {
  "use strict";

  /* ───────────────────────── bytes ───────────────────────── */

  function latin1(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function concat(parts) {
    let size = 0;
    for (const part of parts) size += part.length;
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /* ───────────────────────── crc-32 ───────────────────────── */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ───────────────────────── zip (stored) ───────────────────────── */

  function u16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function u32(value) {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  }

  function dosStamp(date) {
    const time =
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day =
      ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  // Office files are ZIPs. Storing entries uncompressed keeps this tiny and
  // avoids needing a deflate implementation.
  function zipStore(entries) {
    const stamp = dosStamp(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = utf8(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const local = concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(stamp.time),
        u16(stamp.day),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        name,
        data,
      ]);

      central.push(
        concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x0800),
          u16(0),
          u16(stamp.time),
          u16(stamp.day),
          u32(crc),
          u32(data.length),
          u32(data.length),
          u16(name.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
          name,
        ])
      );

      parts.push(local);
      offset += local.length;
    }

    const directory = concat(central);
    const end = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(directory.length),
      u32(offset),
      u16(0),
    ]);

    return concat([...parts, directory, end]);
  }

  /* ───────────────────────── pdf ───────────────────────── */

  const PDF_SAFE = /[^\x20-\x7e]/g;

  function pdfText(text) {
    return text
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "...")
      .replace(PDF_SAFE, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  // One JPEG per slide plus an invisible, selectable text layer on top.
  function buildPdf(pages) {
    const chunks = [];
    const offsets = [];
    let length = 0;

    const push = (part) => {
      const bytes = typeof part === "string" ? latin1(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };

    const start = (num) => {
      offsets[num] = length;
      push(`${num} 0 obj\n`);
    };

    const count = pages.length;
    const fontObj = 3 + count * 3;

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    start(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    const kids = [];
    for (let i = 0; i < count; i++) kids.push(`${3 + i * 3} 0 R`);
    start(2);
    push(`<< /Type /Pages /Count ${count} /Kids [${kids.join(" ")}] >>\nendobj\n`);

    pages.forEach((page, index) => {
      const pageObj = 3 + index * 3;
      const contentObj = pageObj + 1;
      const imageObj = pageObj + 2;

      const width = 720;
      const height = +((page.height / page.width) * width).toFixed(2);

      let stream = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;

      const visible = (page.lines || []).filter((line) => line.text && line.text.trim());
      if (visible.length) {
        stream += "BT\n3 Tr\n";
        for (const line of visible) {
          const size = Math.max(4, line.h * height);
          const x = line.x * width;
          const y = height - (line.y * height + size * 0.8);
          const natural = line.text.length * size * 0.5;
          const squeeze = natural > 0 ? Math.min(3, Math.max(0.4, (line.w * width) / natural)) : 1;
          stream += `/F1 ${size.toFixed(2)} Tf\n${squeeze.toFixed(3)} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n(${pdfText(line.text)}) Tj\n`;
        }
        stream += "ET\n";
      }

      const content = latin1(stream);

      start(pageObj);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Resources << /XObject << /Im0 ${imageObj} 0 R >> /Font << /F1 ${fontObj} 0 R >> >> ` +
          `/Contents ${contentObj} 0 R >>\nendobj\n`
      );

      start(contentObj);
      push(`<< /Length ${content.length} >>\nstream\n`);
      push(content);
      push("\nendstream\nendobj\n");

      start(imageObj);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.jpegWidth} /Height ${page.jpegHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
      );
      push(page.jpeg);
      push("\nendstream\nendobj\n");
    });

    start(fontObj);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

    const size = fontObj + 1;
    const xref = length;
    push(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) {
      push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    return concat(chunks);
  }

  /* ───────────────────────── docx ───────────────────────── */

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function xmlEscape(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Characters that are illegal in XML 1.0 (stray control codes from OCR).
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }

  function buildDocx(pages) {
    const body = [];

    pages.forEach((page, index) => {
      if (index > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');

      const lines = (page.lines || []).filter((line) => line.text && line.text.trim());
      if (!lines.length) {
        body.push(
          `<w:p><w:r><w:t xml:space="preserve">Slide ${index + 1} - no text recognised.</w:t></w:r></w:p>`
        );
        return;
      }

      for (const line of lines) {
        body.push(
          `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line.text)}</w:t></w:r></w:p>`
        );
      }
    });

    const documentXml =
      XML_HEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body>" +
      body.join("") +
      "<w:sectPr>" +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
      "</w:sectPr>" +
      "</w:body></w:document>";

    const contentTypes =
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>";

    const rels =
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>";

    return zipStore([
      { name: "[Content_Types].xml", data: utf8(contentTypes) },
      { name: "_rels/.rels", data: utf8(rels) },
      { name: "word/document.xml", data: utf8(documentXml) },
    ]);
  }

  /* ───────────────────────── pptx ───────────────────────── */

  const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  function slideXml(index, cx, cy, lines) {
    const shapes = (lines || [])
      .filter((line) => line.text && line.text.trim())
      .map((line, i) => pptTextShape(line, i + 3, cx, cy))
      .join("");

    return (
      XML_HEAD +
      `<p:sld ${NS}>` +
      "<p:cSld><p:spTree>" +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      "<p:grpSpPr/>" +
      "<p:pic>" +
      "<p:nvPicPr>" +
      `<p:cNvPr id="2" name="Slide ${index + 1}"/>` +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>' +
      "<p:nvPr/>" +
      "</p:nvPicPr>" +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      "<p:spPr>" +
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      "</p:spPr>" +
      "</p:pic>" +
      shapes +
      "</p:spTree></p:cSld>" +
      "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
      "</p:sld>"
    );
  }

  // The OCR box is the ink extent, not the em square. Uppercase lines have no
  // descenders, so their box is only about two thirds of the font size, while
  // mixed-case lines with ascenders and descenders fill most of an em. These
  // ratios were measured against real slide renders rather than guessed.
  function inkMetrics(text) {
    const hasDescender = /[gjpqy]/.test(text);
    const hasBracket = /[()[\]{}]/.test(text);
    const hasAscender = /[b-df-hk-lt]/.test(text);
    const hasCap = /[A-Z0-9]/.test(text);

    let ratio = 0.47; // lowercase without ascenders
    let top = 0.4;

    if (hasCap) {
      ratio = 0.66;
      top = 0.28;
    }
    if (hasAscender) {
      ratio = 0.73;
      top = 0.2;
    }
    if (hasBracket) {
      ratio = hasDescender ? 0.95 : 0.9;
      top = 0.2;
    }
    if (hasDescender && !hasBracket) {
      ratio = 0.86;
      top = hasAscender ? 0.2 : 0.28;
    }

    return { ratio, top };
  }

  // A line of OCR text becomes a transparent text box sized to the ink box it
  // was read from. The slide image underneath has that box painted out, so the
  // text is real text in PowerPoint rather than pixels.
  function pptTextShape(line, id, cx, cy) {
    const clamp01 = (value) => Math.min(1, Math.max(0, value));
    const x = Math.round(clamp01(line.x) * cx);
    const y = Math.round(clamp01(line.y) * cy);
    const width = Math.max(12700, Math.round(clamp01(line.w) * cx));

    const pagePoints = cy / 12700;
    const metrics = inkMetrics(line.text);
    let size = Math.max(
      600,
      Math.round((clamp01(line.h) * pagePoints) / metrics.ratio * 100)
    );

    // Calibri is a little wider than the slide typeface, so a long line can run
    // past the edge of the slide and get clipped. Measure it roughly and shrink
    // only when it would not fit on the canvas at all.
    const emuPerChar = size * 0.0055 * 12700;
    const available = Math.max(12700, Math.round((1 - clamp01(line.x)) * cx));
    const estimated = emuPerChar * line.text.length;
    if (estimated > available) {
      size = Math.max(600, Math.floor((size * available) / estimated));
    }

    const fontEmu = (size / 100) * 12700;
    // PowerPoint adds leading above the first line; lift the box by roughly
    // that much so the glyphs land on the painted-out area.
    const top = Math.max(0, Math.round(y - fontEmu * metrics.top));
    const height = Math.round(fontEmu * 1.35);
    const ink = /^[0-9A-F]{6}$/i.test(line.ink || "") ? line.ink : "1D1D1B";

    return (
      "<p:sp>" +
      "<p:nvSpPr>" +
      `<p:cNvPr id="${id}" name="Line ${id - 2}"/>` +
      '<p:cNvSpPr txBox="1"/>' +
      "<p:nvPr/>" +
      "</p:nvSpPr>" +
      "<p:spPr>" +
      `<a:xfrm><a:off x="${x}" y="${top}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      "<a:noFill/>" +
      "<a:ln><a:noFill/></a:ln>" +
      "</p:spPr>" +
      "<p:txBody>" +
      '<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr>' +
      "<a:lstStyle/>" +
      "<a:p>" +
      '<a:pPr algn="l" marL="0" indent="0"/>' +
      "<a:r>" +
      `<a:rPr lang="en-US" sz="${size}" dirty="0">` +
      `<a:solidFill><a:srgbClr val="${ink.toUpperCase()}"/></a:solidFill>` +
      '<a:latin typeface="Calibri"/>' +
      "</a:rPr>" +
      `<a:t>${xmlEscape(line.text)}</a:t>` +
      "</a:r>" +
      "</a:p>" +
      "</p:txBody>" +
      "</p:sp>"
    );
  }

  function slideRels(index) {
    return (
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.jpeg"/>` +
      "</Relationships>"
    );
  }

  function buildPptx(pages) {
    const count = pages.length;
    const cx = 12192000;
    const cy = Math.round((cx * pages[0].jpegHeight) / pages[0].jpegWidth);

    const parts = [];

    parts.push({
      name: "[Content_Types].xml",
      data: utf8(
        XML_HEAD +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
          '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
          '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
          '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
          Array.from(
            { length: count },
            (_, i) =>
              `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
          ).join("") +
          "</Types>"
      ),
    });

    parts.push({
      name: "_rels/.rels",
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
          "</Relationships>"
      ),
    });

    const slideIds = Array.from(
      { length: count },
      (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
    ).join("");

    parts.push({
      name: "ppt/presentation.xml",
      data: utf8(
        XML_HEAD +
          `<p:presentation ${NS} saveSubsetFonts="1">` +
          `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
          `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
          `<p:sldSz cx="${cx}" cy="${cy}"/>` +
          '<p:notesSz cx="6858000" cy="9144000"/>' +
          "</p:presentation>"
      ),
    });

    parts.push({
      name: "ppt/_rels/presentation.xml.rels",
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
          Array.from(
            { length: count },
            (_, i) =>
              `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
          ).join("") +
          "</Relationships>"
      ),
    });

    const emptyTree =
      "<p:spTree>" +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      "<p:grpSpPr/>" +
      "</p:spTree>";

    parts.push({
      name: "ppt/slideMasters/slideMaster1.xml",
      data: utf8(
        XML_HEAD +
          `<p:sldMaster ${NS}>` +
          `<p:cSld>${emptyTree}</p:cSld>` +
          '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
          '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
          "</p:sldMaster>"
      ),
    });

    parts.push({
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
          "</Relationships>"
      ),
    });

    parts.push({
      name: "ppt/slideLayouts/slideLayout1.xml",
      data: utf8(
        XML_HEAD +
          `<p:sldLayout ${NS} type="blank" preserve="1">` +
          `<p:cSld name="Blank">${emptyTree}</p:cSld>` +
          "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
          "</p:sldLayout>"
      ),
    });

    parts.push({
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
          "</Relationships>"
      ),
    });

    parts.push({
      name: "ppt/theme/theme1.xml",
      data: utf8(
        XML_HEAD +
          '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
          "<a:themeElements>" +
          '<a:clrScheme name="Office">' +
          '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
          '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
          '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
          '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
          '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
          '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
          '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
          '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
          '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
          '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
          '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
          '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
          "</a:clrScheme>" +
          '<a:fontScheme name="Office">' +
          '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
          '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
          "</a:fontScheme>" +
          '<a:fmtScheme name="Office">' +
          "<a:fillStyleLst>" +
          '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
          '<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill>' +
          '<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill>' +
          "</a:fillStyleLst>" +
          "<a:lnStyleLst>" +
          '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
          '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
          '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
          "</a:lnStyleLst>" +
          "<a:effectStyleLst>" +
          "<a:effectStyle><a:effectLst/></a:effectStyle>" +
          "<a:effectStyle><a:effectLst/></a:effectStyle>" +
          "<a:effectStyle><a:effectLst/></a:effectStyle>" +
          "</a:effectStyleLst>" +
          "<a:bgFillStyleLst>" +
          '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
          '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>' +
          '<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>' +
          "</a:bgFillStyleLst>" +
          "</a:fmtScheme>" +
          "</a:themeElements>" +
          "<a:objectDefaults/><a:extraClrSchemeLst/>" +
          "</a:theme>"
      ),
    });

    pages.forEach((page, index) => {
      parts.push({
        name: `ppt/slides/slide${index + 1}.xml`,
        data: utf8(slideXml(index, cx, cy, page.lines)),
      });
      parts.push({
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: utf8(slideRels(index)),
      });
      parts.push({ name: `ppt/media/image${index + 1}.jpeg`, data: page.jpeg });
    });

    return zipStore(parts);
  }

  window.Packaging = { buildPdf, buildDocx, buildPptx, zipStore, crc32 };
})();
