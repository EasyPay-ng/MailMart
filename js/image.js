// Image -> base64 helper.
//
// Nothing imports this yet: the upload UI it belongs to is being added later.
// It is here so that when that lands, the pipeline is already solved.
//
// Why it downscales instead of calling readAsDataURL() on the raw file:
// a Firestore document is capped at 1 MiB, and a phone camera photo is several
// megabytes. Encoding one straight to base64 would blow that limit and the
// write would be rejected. So: shrink to a bounded edge, re-encode as JPEG,
// then produce the data URL.

export const DEFAULT_MAX_EDGE = 720;   // longest side, in pixels
export const DEFAULT_QUALITY = 0.72;   // JPEG quality, 0-1
export const MAX_BASE64_CHARS = 700000; // ~512 KB, leaves headroom in a 1 MiB doc

export async function fileToBase64(file, options = {}) {
  const {
    maxEdge = DEFAULT_MAX_EDGE,
    quality = DEFAULT_QUALITY,
    mimeType = "image/jpeg"
  } = options;

  assertImage(file);
  const blob = await downscale(file, maxEdge, quality, mimeType);
  const dataUrl = await blobToDataUrl(blob);

  if (dataUrl.length > MAX_BASE64_CHARS) {
    throw new Error(
      "That image is still too large after compressing. Try a smaller picture."
    );
  }
  return dataUrl;
}

function assertImage(file) {
  if (!file) throw new Error("No file selected.");
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
}

function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }
  // Fallback for browsers without createImageBitmap.
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

async function downscale(file, maxEdge, quality, mimeType) {
  const bitmap = await loadBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === "function") bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not encode that image.")),
      mimeType,
      quality
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not convert that image."));
    reader.readAsDataURL(blob);
  });
}
