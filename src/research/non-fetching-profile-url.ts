declare const nonFetchingLinkedInProfileUrl: unique symbol;

export type NonFetchingLinkedInProfileUrl = string & {
  readonly [nonFetchingLinkedInProfileUrl]: true;
};

export function asNonFetchingLinkedInProfileUrl(value: string): NonFetchingLinkedInProfileUrl {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Non-fetching profile references must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Non-fetching profile references cannot contain credentials");
  }
  if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
    throw new Error("Non-fetching profile references must use LinkedIn");
  }
  return url.href as NonFetchingLinkedInProfileUrl;
}
