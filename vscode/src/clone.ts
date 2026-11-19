// Your own vHIL clone against GitHub, as the desktop app sees it: the
// repository's bin/vhil-clone `status` (fetch, then key=value lines). Behind
// its upstream: Update (a fast-forward); its branch all in dev already:
// Switch to dev. Without VS Code; tested by test/clone.test.ts.

export interface CloneStatus {
  branch: string;
  fetched: boolean; // GitHub answered
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  merged: number; // > 0: the branch is all in dev, which is this many commits ahead
}

/** `vhil-clone status`'s output, or undefined (no branch, or not a clone). */
export function parseClone(out: string): CloneStatus | undefined {
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const branch = kv.get("branch");
  if (!branch || kv.has("detached")) return undefined;
  const n = (k: string) => Number(kv.get(k) ?? 0) || 0;
  return {
    branch, fetched: kv.get("fetched") === "1", upstream: kv.get("upstream"),
    ahead: n("ahead"), behind: n("behind"), dirty: kv.get("dirty") === "1", merged: n("merged"),
  };
}

export interface CloneAdvice {
  text: string;
  detail: string;
  action?: "update" | "switch";
}

const commits = (k: number) => `${k} commit${k === 1 ? "" : "s"}`;

/** What to say about the clone, or undefined when nothing needs a look. */
export function cloneAdvice(c: CloneStatus, base = "dev"): CloneAdvice | undefined {
  const offline = c.fetched ? "" : " (GitHub didn't answer: as of the last fetch)";
  if (c.merged > 0) {
    return {
      text: `${c.branch} is already in ${base}`,
      detail: `Everything on ${c.branch} is in ${base}, which is ${commits(c.merged)} ahead${offline}. ` +
        "The vHIL runs the code of the branch you're on." +
        (c.dirty ? ` Commit or stash your changes to switch to ${base}.` : ` Click to switch to ${base}.`),
      action: c.dirty ? undefined : "switch",
    };
  }
  if (c.behind > 0 && c.ahead > 0) {
    return {
      text: `${c.branch} has diverged`,
      detail: `${c.branch} and ${c.upstream} have both moved on (${c.ahead} ahead, ${c.behind} behind)${offline}: merge or rebase it with git.`,
    };
  }
  if (c.behind > 0) {
    return {
      text: `${commits(c.behind)} behind ${c.upstream}`,
      detail: `${c.branch} is ${commits(c.behind)} behind ${c.upstream}${offline}. Click to update it (a fast-forward).`,
      action: "update",
    };
  }
  return undefined;
}
