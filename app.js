const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const convertButton = document.querySelector("#convertButton");
const resetButton = document.querySelector("#resetButton");
const fileSummary = document.querySelector("#fileSummary");
const statusCard = document.querySelector("#statusCard");
const statusTitle = document.querySelector("#statusTitle");
const statusPercent = document.querySelector("#statusPercent");
const statusMessage = document.querySelector("#statusMessage");
const progressBar = document.querySelector("#progressBar");
const downloadLink = document.querySelector("#downloadLink");
const openLink = document.querySelector("#openLink");
const modalBackdrop = document.querySelector("#modalBackdrop");
const modalOpenButtons = document.querySelectorAll("[data-modal-open]");
const modalCloseButtons = document.querySelectorAll("[data-modal-close]");

let selectedFiles = [];
let worker = null;
let currentDownloadUrl = null;
let currentPdfBlob = null;
let currentPdfName = "";
let lastModalTrigger = null;

const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif"]);

function setStatus(kind, title, message, progress = 0) {
  statusCard.hidden = false;
  statusCard.classList.toggle("is-error", kind === "error");
  statusCard.classList.toggle("is-success", kind === "success");
  statusTitle.textContent = title;
  statusMessage.textContent = message;
  statusPercent.textContent = `${Math.round(progress)}%`;
  progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function clearDownload() {
  if (currentDownloadUrl) {
    URL.revokeObjectURL(currentDownloadUrl);
    currentDownloadUrl = null;
  }
  currentPdfBlob = null;
  currentPdfName = "";
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  openLink.hidden = true;
  openLink.removeAttribute("href");
}

function reset() {
  selectedFiles = [];
  fileInput.value = "";
  fileSummary.hidden = true;
  statusCard.hidden = true;
  convertButton.disabled = true;
  resetButton.hidden = true;
  clearDownload();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function fileExtension(file) {
  return file.name.split(".").pop()?.toLowerCase() || "";
}

function classifyFiles(files) {
  if (!files.length) {
    return { ok: false, message: "Choose at least one file to convert." };
  }

  const pdfs = files.filter((file) => file.type === "application/pdf" || fileExtension(file) === "pdf");
  const zips = files.filter((file) => ["zip", "cbz"].includes(fileExtension(file)) || ["application/zip", "application/x-zip-compressed"].includes(file.type));
  const images = files.filter((file) => file.type.startsWith("image/") || imageExtensions.has(fileExtension(file)));
  const swfs = files.filter((file) => fileExtension(file) === "swf" || file.type === "application/x-shockwave-flash");

  if (swfs.length) {
    return {
      ok: false,
      message:
        "SWF flipbooks are detected, but modern browsers cannot safely decode SWF into page images. Export the flipbook as PDF or images first, then drop those files here."
    };
  }

  if (files.length === 1 && pdfs.length === 1) {
    return { ok: true, mode: "pdf", label: "1 PDF flipbook ready" };
  }

  if (files.length === 1 && zips.length === 1) {
    return { ok: true, mode: "zip", label: "1 ZIP flipbook ready" };
  }

  if (images.length === files.length) {
    return {
      ok: true,
      mode: "images",
      label: `${files.length} image ${files.length === 1 ? "page" : "pages"} ready`
    };
  }

  return {
    ok: false,
    message:
      "This selection mixes unsupported file types. Use one ZIP, one PDF, or select image pages only."
  };
}

function setSelectedFiles(files) {
  clearDownload();
  selectedFiles = Array.from(files).filter((file) => file.size > 0);
  selectedFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const verdict = classifyFiles(selectedFiles);
  fileSummary.hidden = false;
  resetButton.hidden = false;

  if (!verdict.ok) {
    fileSummary.textContent = verdict.message;
    convertButton.disabled = true;
    setStatus("error", "Cannot convert this selection", verdict.message, 0);
    return;
  }

  const size = selectedFiles.reduce((total, file) => total + file.size, 0);
  fileSummary.textContent = `${verdict.label}. Total size: ${formatBytes(size)}. Processing will happen locally in this tab.`;
  convertButton.disabled = false;
  setStatus("idle", "Ready", "No upload will be made. Start conversion whenever you are ready.", 0);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function startWorker() {
  if (worker) worker.terminate();
  if (!window.Worker) {
    throw new Error("This browser does not support Web Workers.");
  }
  worker = new Worker("converter-worker.js");
  return worker;
}

function makeDownload(blob, suggestedName) {
  clearDownload();
  currentPdfBlob = blob;
  currentPdfName = suggestedName;
  currentDownloadUrl = URL.createObjectURL(blob);
  downloadLink.href = currentDownloadUrl;
  downloadLink.download = suggestedName;
  downloadLink.hidden = false;
  openLink.href = currentDownloadUrl;
  openLink.hidden = false;
}

function triggerDownload() {
  if (!currentPdfBlob || !currentPdfName) return;

  const url = URL.createObjectURL(currentPdfBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = currentPdfName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function convertedFileName(files) {
  if (files.length === 1) {
    return `${files[0].name.replace(/\.[^.]+$/, "") || "flipfy-output"}.pdf`;
  }
  const commonPrefix = files[0].name.match(/^[a-z0-9 _-]+/i)?.[0]?.trim() || "flipfy-pages";
  return `${commonPrefix.replace(/\s+/g, "-")}-converted.pdf`;
}

convertButton.addEventListener("click", () => {
  const verdict = classifyFiles(selectedFiles);
  if (!verdict.ok) {
    setStatus("error", "Cannot convert", verdict.message, 0);
    return;
  }

  convertButton.disabled = true;
  clearDownload();
  setStatus("working", "Converting", "Preparing files inside your browser.", 2);

  let activeWorker;
  try {
    activeWorker = startWorker();
  } catch (error) {
    setStatus("error", "Conversion unavailable", `${error.message} Try a current version of Chrome, Edge, Firefox, or Safari.`, 0);
    convertButton.disabled = false;
    return;
  }
  activeWorker.onmessage = (event) => {
    const { type, progress, title, message, bytes, mime } = event.data;

    if (type === "progress") {
      setStatus("working", title, message, progress);
    }

    if (type === "done") {
      const blob = new Blob([bytes], { type: mime || "application/pdf" });
      makeDownload(blob, convertedFileName(selectedFiles));
      setStatus("success", "PDF ready", "Use Download PDF, or Open PDF if your browser blocks the download prompt. Nothing was uploaded or stored.", 100);
      convertButton.disabled = false;
      activeWorker.terminate();
      worker = null;
    }

    if (type === "error") {
      clearDownload();
      setStatus("error", "Conversion failed", message, progress || 0);
      convertButton.disabled = false;
      activeWorker.terminate();
      worker = null;
    }
  };

  activeWorker.onerror = () => {
    clearDownload();
    setStatus("error", "Conversion failed", "The browser stopped the conversion. Try a smaller file set or export the flipbook as PDF first.", 0);
    convertButton.disabled = false;
    activeWorker.terminate();
    worker = null;
  };

  activeWorker.postMessage({ files: selectedFiles, mode: verdict.mode });
});

fileInput.addEventListener("change", () => setSelectedFiles(fileInput.files));

downloadLink.addEventListener("click", (event) => {
  event.preventDefault();
  triggerDownload();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  setSelectedFiles(event.dataTransfer.files);
});

resetButton.addEventListener("click", reset);

function openModal(modalId, trigger) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  lastModalTrigger = trigger;
  modalBackdrop.hidden = false;
  modal.showModal();
}

function closeModal(modal) {
  if (!modal?.open) return;
  modal.close();
  modalBackdrop.hidden = true;
  lastModalTrigger?.focus();
}

modalOpenButtons.forEach((button) => {
  button.addEventListener("click", () => openModal(button.dataset.modalOpen, button));
});

modalCloseButtons.forEach((button) => {
  button.addEventListener("click", () => closeModal(button.closest("dialog")));
});

document.querySelectorAll(".info-modal").forEach((modal) => {
  modal.addEventListener("close", () => {
    modalBackdrop.hidden = true;
  });
});

modalBackdrop.addEventListener("click", () => {
  const openModalElement = document.querySelector(".info-modal[open]");
  closeModal(openModalElement);
});
