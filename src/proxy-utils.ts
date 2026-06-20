export type ProxyFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export function requestHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === "host" || name === "content-length") continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  result["accept-encoding"] = "identity";
  return result;
}

export function cleanResponseHeaders(
  headers: Record<string, string>,
  options: { stripSetCookie?: boolean } = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (options.stripSetCookie && (name === "set-cookie" || name === "set-cookie2")) continue;
    if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding") continue;
    result[name] = value;
  }
  return result;
}

export function shouldRewriteText(contentType: string): boolean {
  return (
    contentType.includes("text/html") ||
    contentType.includes("text/css") ||
    contentType.includes("javascript") ||
    contentType.includes("ecmascript")
  );
}

export function rewriteRootRelativeText(content: string, prefix: string, contentType: string): string {
  let next = content
    .replace(/(\s(?:src|href|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}`)
    .replace(/(url\(["']?)\/(?!\/)/gi, `$1${prefix}`);

  if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
    next = next
      .replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${prefix}`)
      .replace(/(\bimport\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`)
      .replace(/(\bnew\s+URL\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`);
  }

  return next;
}

export function textResponse(status: number, text: string): ProxyFetchResponse {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(text))
    },
    body: Buffer.from(text, "utf8")
  };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
