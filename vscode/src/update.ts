// The extension's own updates, without VS Code: the vscode workflow's
// vscode-latest release holds latest.json, {version, vsix}. Tested by
// test/update.test.ts.

/** Where latest.json is, for the vHIL's GitHub repository `slug` (owner/name). */
export function latestUrl(slug: string): string {
  return `https://github.com/${slug}/releases/download/vscode-latest/latest.json`;
}

export interface Latest {
  version: string;
  vsix: string;
}

/** latest.json, if it is one and its .vsix is a release asset of `slug`. */
export function parseLatest(text: string, slug: string): Latest | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { version, vsix } = (j ?? {}) as { version?: unknown; vsix?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (typeof vsix !== "string" || !vsix.startsWith(`https://github.com/${slug}/releases/download/`)
      || !vsix.endsWith(".vsix")) {
    return undefined;
  }
  return { version, vsix };
}

/** Whether version `a` is newer than `b` (major.minor.patch; anything else is not). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}
