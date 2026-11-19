// System branches the editor's Commit… made in a vHIL checkout but nobody
// pushed: in a firmware repository that checkout is the extension's own,
// out of sight in VS Code's storage, so the Systems view lists them and
// pushes them with your git. Without VS Code; tested by test/branches.test.ts.

export interface SavedBranch {
  branch: string;
  systems: string[]; // the system ids its last commit changed
}

/**
 * The local branches not on origin at the same commit, from
 * `git for-each-ref --format='%(refname) %(objectname)' refs/heads refs/remotes/origin`;
 * `current` (the checkout's own branch, the vHIL ref it follows) is left out.
 */
export function unpushed(refs: string, current: string): string[] {
  const heads = new Map<string, string>();
  const remote = new Map<string, string>();
  for (const line of refs.split(/\r?\n/)) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (!ref || !sha) continue;
    if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
    else if (ref.startsWith("refs/remotes/origin/")) remote.set(ref.slice("refs/remotes/origin/".length), sha);
  }
  return [...heads].filter(([b, sha]) => b !== current && remote.get(b) !== sha).map(([b]) => b).sort();
}

/** The system ids among `git diff-tree --name-only` paths: systems/<id>.yaml. */
export function systemsIn(paths: string): string[] {
  const ids = new Set<string>();
  for (const p of paths.split(/\r?\n/)) {
    const m = /^systems\/([^/]+)\.yaml$/.exec(p.trim());
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** GitHub's page to open a PR from `branch` into `base`, for a github.com remote. */
export function compareUrl(remote: string, base: string, branch: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return undefined;
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${m[1]}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}
