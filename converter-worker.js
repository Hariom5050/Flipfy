const encoder = new TextEncoder();
const decoder = new TextDecoder();
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif"]);

self.onmessage = async (event) => {
  const { files, mode } = event.data;

  try {
    if (mode === "pdf") {
      postProgress(18, "Reading PDF", "Checking the selected PDF locally.");
      const bytes = await files[0].arrayBuffer();
      if (!hasPdfHeader(bytes)) {
        throw new Error("This file does not look like a valid PDF.");
      }
      postProgress(100, "PDF ready", "The PDF flipbook is ready to download.");
      self.postMessage({ type: "done", bytes, mime: "application/pdf" }, [bytes]);
      return;
    }

    if (mode === "images") {
      await convertImages(files, "The image sequence has been converted.");
      return;
    }

    if (mode === "zip") {
      postProgress(5, "Reading ZIP", "Scanning the flipbook package locally.");
      const zipBytes = new Uint8Array(await files[0].arrayBuffer());
      const entries = readZipEntries(zipBytes);
      const pdfEntry = choosePdfEntry(entries);

      if (pdfEntry) {
        postProgress(24, "Extracting PDF", `Found ${pdfEntry.name}.`);
        const bytes = await extractZipEntry(zipBytes, pdfEntry);
        if (!hasPdfHeader(bytes.buffer)) {
          throw new Error("The PDF inside this ZIP could not be verified.");
        }
        postProgress(100, "PDF ready", "The PDF inside the ZIP is ready to download.");
        self.postMessage({ type: "done", bytes: bytes.buffer, mime: "application/pdf" }, [bytes.buffer]);
        return;
      }

      const imageEntries = chooseImageEntries(entries);
      if (!imageEntries.length) {
        throw new Error("No numbered page images or PDF were found inside this ZIP flipbook.");
      }

      const pageSources = [];
      for (let index = 0; index < imageEntries.length; index += 1) {
        const entry = imageEntries[index];
        const progress = 8 + (index / imageEntries.length) * 42;
        postProgress(progress, "Extracting ZIP", `Extracting ${entry.name}.`);
        const bytes = await extractZipEntry(zipBytes, entry);
        pageSources.push({
          name: entry.name,
          type: mimeForName(entry.name),
          bytes
        });
      }

      await convertImages(pageSources, `Converted ${imageEntries.length} pages from the ZIP flipbook.`);
      return;
    }

    throw new Error("Unsupported conversion mode.");
  } catch (error) {
    self.postMessage({
      type: "error",
      message: friendlyError(error)
    });
  }
};

function postProgress(progress, title, message) {
  self.postMessage({ type: "progress", progress, title, message });
}

function hasPdfHeader(buffer) {
  const head = new Uint8Array(buffer.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

async function convertImages(sources, successMessage) {
  const pages = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const progress = 50 + (index / sources.length) * 32;
    postProgress(progress, "Rendering pages", `Preparing ${basename(source.name)}.`);
    pages.push(await imageFileToPdfPage(source));
  }

  postProgress(86, "Building PDF", "Writing pages into a standard PDF file.");
  const pdf = buildPdf(pages);
  postProgress(100, "PDF ready", successMessage);
  self.postMessage({ type: "done", bytes: pdf.buffer, mime: "application/pdf" }, [pdf.buffer]);
}

async function imageFileToPdfPage(source) {
  const blob = source.bytes
    ? new Blob([source.bytes], { type: source.type || mimeForName(source.name) })
    : source;
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  if (!width || !height || width > 24000 || height > 24000) {
    bitmap.close();
    throw new Error(`${source.name} is too large or has invalid image dimensions.`);
  }

  let jpegBytes;
  if (isJpeg(source)) {
    jpegBytes = source.bytes ? source.bytes : new Uint8Array(await source.arrayBuffer());
  } else {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 });
    jpegBytes = new Uint8Array(await blob.arrayBuffer());
  }

  bitmap.close();
  const pageWidth = Math.max(1, width * 0.75);
  const pageHeight = Math.max(1, height * 0.75);
  return { name: source.name, width: pageWidth, height: pageHeight, jpegBytes };
}

function isJpeg(file) {
  const name = file.name.toLowerCase();
  return file.type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

function readZipEntries(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = read16(view, eocdOffset + 10);
  const centralDirectorySize = read32(view, eocdOffset + 12);
  let offset = read32(view, eocdOffset + 16);

  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || offset === 0xffffffff) {
    throw new Error("ZIP64 packages are not supported in this browser-only converter yet.");
  }

  const entries = [];
  const end = offset + centralDirectorySize;
  while (offset < end && entries.length < entryCount) {
    if (read32(view, offset) !== 0x02014b50) {
      throw new Error("The ZIP central directory is corrupted.");
    }

    const flags = read16(view, offset + 8);
    const method = read16(view, offset + 10);
    const compressedSize = read32(view, offset + 20);
    const uncompressedSize = read32(view, offset + 24);
    const nameLength = read16(view, offset + 28);
    const extraLength = read16(view, offset + 30);
    const commentLength = read16(view, offset + 32);
    const localHeaderOffset = read32(view, offset + 42);
    const nameStart = offset + 46;
    const name = normalizeZipPath(decoder.decode(zipBytes.subarray(nameStart, nameStart + nameLength)));

    if (name && !name.endsWith("/")) {
      entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    }

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (read32(view, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("This does not look like a valid ZIP file.");
}

async function extractZipEntry(zipBytes, entry) {
  if (entry.flags & 1) {
    throw new Error("Encrypted ZIP entries are not supported.");
  }
  if (![0, 8].includes(entry.method)) {
    throw new Error(`${basename(entry.name)} uses a ZIP compression method this browser cannot decode.`);
  }

  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (read32(view, offset) !== 0x04034b50) {
    throw new Error(`The ZIP entry ${basename(entry.name)} has a corrupted local header.`);
  }

  const nameLength = read16(view, offset + 26);
  const extraLength = read16(view, offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) {
    return compressed.slice();
  }

  if (!self.DecompressionStream) {
    throw new Error("This browser cannot inflate compressed ZIP entries. Try a current version of Chrome, Edge, Firefox, or Safari.");
  }

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.uncompressedSize && output.length !== entry.uncompressedSize) {
    throw new Error(`${basename(entry.name)} did not extract cleanly from the ZIP.`);
  }
  return output;
}

function choosePdfEntry(entries) {
  return entries
    .filter((entry) => extension(entry.name) === "pdf")
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
}

function chooseImageEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const ext = extension(entry.name);
    const number = pageNumber(entry.name);
    if (!imageExtensions.has(ext) || number === null) continue;

    const dir = dirname(entry.name);
    const existing = groups.get(dir) || { dir, entries: [], totalSize: 0 };
    existing.entries.push({ ...entry, pageNumber: number });
    existing.totalSize += entry.uncompressedSize || 0;
    groups.set(dir, existing);
  }

  const best = Array.from(groups.values())
    .filter((group) => group.entries.length > 1)
    .sort((a, b) => {
      if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
      return b.totalSize - a.totalSize;
    })[0];

  if (!best) return [];
  return best.entries.sort((a, b) => a.pageNumber - b.pageNumber || a.name.localeCompare(b.name));
}

function pageNumber(path) {
  const name = basename(path).replace(/\.[^.]+$/, "");
  const match = name.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function extension(path) {
  return path.split(".").pop()?.toLowerCase() || "";
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function basename(path) {
  return path.split("/").pop() || path;
}

function normalizeZipPath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function mimeForName(name) {
  const ext = extension(name);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

function read16(view, offset) {
  return view.getUint16(offset, true);
}

function read32(view, offset) {
  return view.getUint32(offset, true);
}

function buildPdf(pages) {
  const writer = new PdfWriter();
  writer.ascii("%PDF-1.7\n%\xFF\xFF\xFF\xFF\n");

  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  writer.object(1, "<< /Type /Catalog /Pages 2 0 R >>\n");
  writer.object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\n`);

  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const imageName = `/Im${index + 1}`;
    const stream = `q\n${formatNumber(page.width)} 0 0 ${formatNumber(page.height)} 0 0 cm\n${imageName} Do\nQ\n`;

    writer.object(
      pageObj,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}] /Resources << /XObject << ${imageName} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\n`
    );

    writer.streamObject(
      imageObj,
      `<< /Type /XObject /Subtype /Image /Width ${Math.round(page.width / 0.75)} /Height ${Math.round(page.height / 0.75)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>`,
      page.jpegBytes
    );

    writer.streamObject(contentObj, `<< /Length ${byteLength(stream)} >>`, encoder.encode(stream));
  });

  return writer.finish();
}

class PdfWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.offsets = [0];
  }

  ascii(text) {
    const bytes = encoder.encode(text);
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  bytes(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  object(number, body) {
    this.offsets[number] = this.length;
    this.ascii(`${number} 0 obj\n${body}endobj\n`);
  }

  streamObject(number, dictionary, streamBytes) {
    this.offsets[number] = this.length;
    this.ascii(`${number} 0 obj\n${dictionary}\nstream\n`);
    this.bytes(streamBytes);
    this.ascii("\nendstream\nendobj\n");
  }

  finish() {
    const startXref = this.length;
    const objectCount = this.offsets.length;
    this.ascii(`xref\n0 ${objectCount}\n`);
    this.ascii("0000000000 65535 f \n");
    for (let index = 1; index < objectCount; index += 1) {
      this.ascii(`${String(this.offsets[index]).padStart(10, "0")} 00000 n \n`);
    }
    this.ascii(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);

    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
}

function byteLength(text) {
  return encoder.encode(text).length;
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function friendlyError(error) {
  const message = error?.message || "The file could not be converted.";
  if (message.includes("The source image could not be decoded")) {
    return "One of the image pages could not be decoded. Try exporting that page as JPG or PNG.";
  }
  if (message.includes("valid PDF")) {
    return "The selected file has a PDF extension, but the browser could not verify its PDF header.";
  }
  return message;
}
