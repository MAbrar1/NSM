import { createHash, createHmac } from "crypto";

/* ═══════════════════════════════════════════════════════════════
   S3-COMPATIBLE STORAGE CLIENT (dependency-free)
   Minimal SigV4 client for any S3-compatible object store (AWS S3,
   Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces…). Uses
   only Node's crypto + fetch — no AWS SDK required.

   Env:
     S3_ENDPOINT      — e.g. https://s3.amazonaws.com (path-style
                        addressing is used: {endpoint}/{bucket}/{key})
     S3_REGION        — default us-east-1
     S3_BUCKET        — bucket name
     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
     S3_SESSION_TOKEN — optional (temporary credentials)
   ═══════════════════════════════════════════════════════════════ */

const REGION = process.env["S3_REGION"]?.trim() || "us-east-1";
const BUCKET = process.env["S3_BUCKET"]?.trim() || "";
const ENDPOINT = (process.env["S3_ENDPOINT"]?.trim() || "https://s3.amazonaws.com").replace(/\/+$/, "");
const ACCESS_KEY = process.env["S3_ACCESS_KEY_ID"]?.trim() || "";
const SECRET_KEY = process.env["S3_SECRET_ACCESS_KEY"]?.trim() || "";
const SESSION_TOKEN = process.env["S3_SESSION_TOKEN"]?.trim() || undefined;

export function isS3Configured(): boolean {
  return Boolean(BUCKET && ACCESS_KEY && SECRET_KEY && ENDPOINT);
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function iso8601(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Scope string: YYYYMMDD/region/s3/aws4_request */
function scopeString(date: Date): string {
  const short = iso8601(date).slice(0, 8);
  return `${short}/${REGION}/s3/aws4_request`;
}

function signingKey(date: Date): Buffer {
  const short = iso8601(date).slice(0, 8);
  return hmac(
    hmac(hmac(hmac(`AWS4${SECRET_KEY}`, short), REGION), "s3"),
    "aws4_request"
  );
}

function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const keys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonical = keys.map((k) => `${k}:${headers[k]!.trim()}\n`).join("");
  return { canonical, signed: keys.join(";") };
}

/**
 * Build a SigV4-signed request and execute it with fetch. Returns the
 * raw Response — callers check status and read the body.
 */
export async function s3Request(
  method: "GET" | "PUT" | "DELETE",
  key: string,
  opts?: {
    body?: Buffer | string;
    contentType?: string;
    /** Extra query params (e.g. `list-type=2`); sorted for signing. */
    query?: Record<string, string>;
    /** 60..604800 — for presigned URLs only. */
    expiresInSeconds?: number;
  }
): Promise<Response> {
  const now = new Date();
  const amzDate = iso8601(now);

  const uri = `/${BUCKET}/${key}`;
  const queryEntries = Object.entries(opts?.query ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join("&");

  const headers: Record<string, string> = {
    host: new URL(ENDPOINT).host,
    "x-amz-content-sha256": opts?.body ? sha256Hex(opts.body) : sha256Hex(""),
    "x-amz-date": amzDate,
  };
  if (opts?.contentType) headers["content-type"] = opts.contentType;
  if (SESSION_TOKEN) headers["x-amz-security-token"] = SESSION_TOKEN;

  if (opts?.expiresInSeconds) {
    // Presigned URL — the policy lives in the query string.
    const expires = String(Math.max(60, Math.min(opts.expiresInSeconds, 604800)));
    const presignParams: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${ACCESS_KEY}/${scopeString(now)}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": expires,
      "X-Amz-SignedHeaders": "host",
      ...(SESSION_TOKEN ? { "X-Amz-Security-Token": SESSION_TOKEN } : {}),
      ...(opts.query ?? {}),
    };
    const entries = Object.entries(presignParams).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQueryString = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join("&");

    const canonicalRequest = [
      method,
      uri,
      canonicalQueryString,
      `host:${new URL(ENDPOINT).host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scopeString(now),
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = hmac(signingKey(now), stringToSign).toString("hex");
    // Presigned URLs are constructed locally — no request is made here,
    // so the caller can hand the URL to a browser without the server
    // having to reach the bucket first.
    return new Response(`${ENDPOINT}${uri}?${canonicalQueryString}&X-Amz-Signature=${signature}`);
  }

  const { canonical: canonicalHeaderString, signed: signedHeaderNames } = canonicalHeaders(headers);
  const canonicalRequest = [
    method,
    uri,
    canonicalQuery,
    canonicalHeaderString,
    signedHeaderNames,
    headers["x-amz-content-sha256"]!,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scopeString(now), sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(now), stringToSign).toString("hex");

  const url = canonicalQuery ? `${ENDPOINT}${uri}?${canonicalQuery}` : `${ENDPOINT}${uri}`;
  return fetch(url, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scopeString(now)}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    },
    body: opts?.body as BodyInit | undefined,
  });
}

/** PUT the object (returns the object key on success). */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  const res = await s3Request("PUT", key, { body, contentType });
  if (!res.ok) {
    throw new Error(`S3 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return key;
}

/** DELETE the object. Missing keys are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  const res = await s3Request("DELETE", key);
  if (!res.ok && res.status !== 404) {
    throw new Error(`S3 delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/** Presigned GET URL (public-read buckets can ignore this). */
export async function presignedGetUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const res = await s3Request("GET", key, { expiresInSeconds });
  // The presigned branch never makes a network call — the URL is the body.
  return res.text();
}

export interface S3ObjectMeta {
  key: string;
  /** ISO timestamp of LastModified, or null when unknown. */
  lastModified: string | null;
}

/** List objects under a prefix (single page via list-type=2). */
export async function listObjects(prefix: string): Promise<S3ObjectMeta[]> {
  const res = await s3Request("GET", "", {
    query: {
      "list-type": "2",
      prefix,
      "max-keys": "1000",
    },
  });
  if (!res.ok) {
    throw new Error(`S3 list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const xml = await res.text();
  const out: S3ObjectMeta[] = [];
  // Minimal, safe XML parsing — keys are URL-encoded in the response.
  const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentRe.exec(xml))) {
    const block = m[1]!;
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const lmMatch = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    if (keyMatch) {
      out.push({
        key: decodeURIComponent(keyMatch[1]!),
        lastModified: lmMatch ? new Date(lmMatch[1]!).toISOString() : null,
      });
    }
  }
  return out;
}