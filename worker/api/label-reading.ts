import { safeUpstreamFetch } from "../upstream-fetch";
import { createClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import {
  MAX_LABEL_MULTIPART_OVERHEAD_BYTES,
  MAX_PREPARED_LABEL_IMAGE_BYTES,
} from "../../src/lib/label/limits";
import { apiError } from "../transport";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";
import { requestLabelProposal } from "./workers-ai-label-adapter";

const ACCESS_COOKIE = "__Host-dd-access";
const MAX_MULTIPART_BODY_BYTES =
  MAX_PREPARED_LABEL_IMAGE_BYTES + MAX_LABEL_MULTIPART_OVERHEAD_BYTES;
const MAX_CONTAINER_CHUNKS = 4096;
const SERVER_DEADLINE_MS = 25_000;

export type LabelImageType = "image/jpeg" | "image/png" | "image/webp";

export type ParsedLabelUpload = {
  bytes: Uint8Array;
  contentType: LabelImageType;
};

type UploadParseResult =
  | { kind: "valid"; upload: ParsedLabelUpload }
  | { kind: "too-large" }
  | { kind: "unsupported-image" }
  | { kind: "bad-request" }
  | { kind: "timed-out" };

function readAccessToken(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== ACCESS_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const segment = key.split(".")[1];
  if (!segment) return false;
  try {
    const payload = JSON.parse(atob(segment.replaceAll("-", "+").replaceAll("_", "/"))) as {
      role?: string;
    };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

async function authorizeOwner(
  c: Context<WorkerEnv>,
  token: string,
): Promise<"owner" | "unauthorized" | "forbidden" | "unavailable"> {
  if (c.get("ownerVerified") && c.get("authenticatedSupabase")?.token === token) return "owner";
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || isServiceRoleKey(key)) return "unavailable";

  try {
    const client = createClient(url, key, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { fetch: safeUpstreamFetch, headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userResult, error: userError } = await client.auth.getUser(token);
    if (userError || !userResult.user) {
      return userError?.status && userError.status >= 500 ? "unavailable" : "unauthorized";
    }

    const { data, error } = await client.schema("api").rpc("get_owner");
    if (error) return "unavailable";
    const owner = (Array.isArray(data) ? data[0] : data) as {
      owner_id?: unknown;
      email?: unknown;
      timezone?: unknown;
    } | null;
    if (
      !owner ||
      typeof owner.owner_id !== "string" ||
      typeof owner.email !== "string" ||
      owner.timezone !== "Europe/Warsaw"
    ) {
      return "forbidden";
    }
    return "owner";
  } catch {
    return "unavailable";
  }
}

function authFailure(c: Context<WorkerEnv>, kind: "unauthorized" | "forbidden" | "unavailable") {
  if (kind === "unauthorized")
    return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
  if (kind === "forbidden")
    return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do dziennika.");
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa logowania jest chwilowo niedostępna.");
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    bytes[offset + 3]! * 0x1000000
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let markerCount = 0;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length && markerCount < 10_000) {
    if (bytes[offset] !== 0xff) return false;
    offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0xd8 || marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      markerCount += 1;
      continue;
    }
    if (offset + 2 > bytes.length) return false;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;

    const isFrameMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrameMarker) {
      if (segmentLength < 8) return false;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (!height || !width) return false;
      sawFrame = true;
    }

    if (marker === 0xda) {
      if (!sawFrame || segmentLength < 6) return false;
      sawScan = true;
      offset += segmentLength;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const nextMarkerStart = offset;
        let codeOffset = offset + 1;
        while (codeOffset < bytes.length && bytes[codeOffset] === 0xff) codeOffset += 1;
        if (codeOffset >= bytes.length) return false;
        const code = bytes[codeOffset]!;
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          offset = codeOffset + 1;
          continue;
        }
        offset = nextMarkerStart;
        break;
      }
      markerCount += 1;
      continue;
    }

    offset += segmentLength;
    markerCount += 1;
  }
  return false;
}

function isPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 45 ||
    bytes[0] !== 0x89 ||
    ascii(bytes, 1, 3) !== "PNG" ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return false;
  }

  let offset = 8;
  let count = 0;
  let sawHeader = false;
  let sawImageData = false;
  while (offset + 12 <= bytes.length && count < MAX_CONTAINER_CHUNKS) {
    const length = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = readUint32BE(bytes, offset + 8);
      const height = readUint32BE(bytes, offset + 12);
      if (!width || !height) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawImageData = true;
    offset = end;
    count += 1;
    if (type === "IEND") return length === 0 && sawImageData && offset === bytes.length;
  }
  return false;
}

function isWebp(bytes: Uint8Array): boolean {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    readUint32LE(bytes, 4) !== bytes.length - 8 ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return false;
  }

  let offset = 12;
  let count = 0;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length && count < MAX_CONTAINER_CHUNKS) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32LE(bytes, offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) return false;
    const payload = offset + 8;
    if (type === "VP8 " && length >= 10) {
      sawImageChunk ||=
        bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a;
    } else if (type === "VP8L" && length >= 5) {
      sawImageChunk ||= bytes[payload] === 0x2f;
    } else if (type === "ANMF" && length >= 29) {
      const frameChunk = payload + 16;
      const frameType = ascii(bytes, frameChunk, 4);
      const frameLength = readUint32LE(bytes, frameChunk + 4);
      const frameData = frameChunk + 8;
      if (frameData + frameLength <= offset + 8 + length) {
        sawImageChunk ||=
          (frameType === "VP8 " &&
            frameLength >= 10 &&
            bytes[frameData + 3] === 0x9d &&
            bytes[frameData + 4] === 0x01 &&
            bytes[frameData + 5] === 0x2a) ||
          (frameType === "VP8L" && frameLength >= 5 && bytes[frameData] === 0x2f);
      }
    }
    offset = end;
    count += 1;
  }
  return sawImageChunk && offset === bytes.length;
}

function detectImageType(bytes: Uint8Array): LabelImageType | null {
  if (isJpeg(bytes)) return "image/jpeg";
  if (isPng(bytes)) return "image/png";
  if (isWebp(bytes)) return "image/webp";
  return null;
}

async function readBoundedBody(
  request: Request,
  signal?: AbortSignal,
): Promise<UploadParseResult | ArrayBuffer> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { kind: "bad-request" };
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > MAX_MULTIPART_BODY_BYTES)
      return { kind: "too-large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { kind: "bad-request" };
  if (signal?.aborted) return { kind: "timed-out" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (signal?.aborted) return { kind: "timed-out" };
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > MAX_MULTIPART_BODY_BYTES) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(part.value);
    }
  } catch {
    return signal?.aborted ? { kind: "timed-out" } : { kind: "bad-request" };
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }

  if (signal?.aborted) return { kind: "timed-out" };

  if (declaredLength !== null && Number(declaredLength) !== total) return { kind: "bad-request" };
  const body = new ArrayBuffer(total);
  const merged = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function parseLabelUpload(
  request: Request,
  signal?: AbortSignal,
): Promise<UploadParseResult> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "multipart/form-data") return { kind: "unsupported-image" };

  const body = await readBoundedBody(request, signal);
  if (!(body instanceof ArrayBuffer)) return body;
  if (signal?.aborted) return { kind: "timed-out" };

  let formData: FormData;
  try {
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    });
    formData = await boundedRequest.formData();
  } catch {
    return { kind: "bad-request" };
  }
  if (signal?.aborted) return { kind: "timed-out" };

  const entries = [...formData.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "image" || typeof entries[0][1] === "string")
    return { kind: "bad-request" };
  const file = entries[0][1];
  if (file.size > MAX_PREPARED_LABEL_IMAGE_BYTES) return { kind: "too-large" };
  if (file.size === 0) return { kind: "unsupported-image" };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { kind: "bad-request" };
  }
  const detectedType = detectImageType(bytes);
  if (!detectedType || file.type.toLowerCase() !== detectedType)
    return { kind: "unsupported-image" };

  return { kind: "valid", upload: { bytes, contentType: detectedType } };
}

async function readLabelWithSignal(c: Context<WorkerEnv>, signal: AbortSignal): Promise<Response> {
  const token = readAccessToken(c.req.raw);
  if (!token) return authFailure(c, "unauthorized");
  const authorization = await authorizeOwner(c, token);
  if (authorization !== "owner") return authFailure(c, authorization);
  if (signal.aborted)
    return apiError(c, 504, "AI_TIMEOUT", "Odczyt etykiety przekroczył limit czasu.");

  const parsed = await parseLabelUpload(c.req.raw, signal);
  if (parsed.kind === "timed-out")
    return apiError(c, 504, "AI_TIMEOUT", "Odczyt etykiety przekroczył limit czasu.");
  if (parsed.kind === "too-large")
    return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Obraz przekracza limit 10 MiB.");
  if (parsed.kind === "unsupported-image")
    return apiError(c, 415, "UNSUPPORTED_IMAGE", "Wybierz poprawny obraz JPEG, PNG lub WebP.");
  if (parsed.kind === "bad-request")
    return apiError(c, 400, "BAD_REQUEST", "Prześlij jeden poprawny obraz w polu image.");

  const result = await requestLabelProposal(c.env.AI, parsed.upload, signal);
  if (result.kind === "valid") return c.json(result.proposal, 200);
  if (result.kind === "rate-limited")
    return apiError(c, 429, "AI_LIMIT", "Darmowy limit odczytów został osiągnięty.");
  if (result.kind === "timed-out")
    return apiError(c, 504, "AI_TIMEOUT", "Odczyt etykiety przekroczył limit czasu.");
  if (result.kind === "invalid-response")
    return apiError(
      c,
      503,
      "AI_INVALID_RESPONSE",
      "Nie udało się bezpiecznie odczytać danych etykiety.",
    );
  return apiError(c, 503, "AI_UNAVAILABLE", "Odczyt etykiet jest chwilowo niedostępny.");
}

async function readLabel(c: Context<WorkerEnv>): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timeoutId = setTimeout(
      () => {
        controller.abort();
        resolve(apiError(c, 504, "AI_TIMEOUT", "Odczyt etykiety przekroczył limit czasu."));
      },
      Math.max(
        0,
        SERVER_DEADLINE_MS - (performance.now() - (c.get("requestStartedAt") ?? performance.now())),
      ),
    );
  });

  try {
    return await Promise.race([readLabelWithSignal(c, controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function registerLabelReadingRoutes(app: WorkerApp): void {
  app.post("/api/v1/label-readings", readLabel);
}
