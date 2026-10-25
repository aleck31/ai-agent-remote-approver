export const REPO = "aleck31/ai-agent-remote-approver";
export const ASSET_NAME = "remote-approver.tgz";

export function assetUrl(tag, repo = REPO) {
  return `https://github.com/${repo}/releases/download/${tag}/${ASSET_NAME}`;
}

// Compare dotted numeric versions ("v0.5.1" ok); returns -1 | 0 | 1. Ignores pre-release suffixes.
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function fetchLatestRelease(fetchFn = fetch, repo = REPO) {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "remote-approver" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const { tag_name: tag } = await res.json();
  if (!tag) throw new Error("latest release has no tag");
  return { tag, version: tag.replace(/^v/, ""), url: assetUrl(tag, repo) };
}
