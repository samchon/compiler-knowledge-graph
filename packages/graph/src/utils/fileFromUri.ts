import { fileURLToPath } from "node:url";

export function fileFromUri(uri: string): string {
  if (uri.slice(0, 6).toLowerCase() !== "file:/") return uri;
  // An LSP owns the URI encoder on responses. Pyright percent-encodes reserved
  // path characters such as the drive colon and `@`, while other servers leave
  // some of them literal. `decodeURI` deliberately preserves reserved escapes,
  // which made `project%40commit` a different filesystem path and discarded every
  // reference edge from that checkout. Decode the complete file path once at
  // this boundary instead of maintaining a server-specific escape allowlist.
  try {
    // Preserve URI authority instead of turning `file://server/share` into a
    // relative `server/share`. Node also handles localhost and drive letters
    // according to the host platform.
    return fileURLToPath(new URL(uri));
  } catch {
    // A few servers emit a POSIX-shaped file URI while the client is running on
    // Windows (or otherwise fail the platform's strict file-URL rules). Keep a
    // bounded compatibility fallback without discarding a real authority.
  }
  const parsed = new URL(uri);
  const authority =
    parsed.hostname !== "" && parsed.hostname !== "localhost"
      ? `//${parsed.hostname}`
      : "";
  const decoded = `${authority}${decodeURIComponent(parsed.pathname)}`;
  if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1).replace(
    /\//g,
    "\\",
  );
  return decoded;
}
