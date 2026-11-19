# Sharing systems and tests with the team

What you make in the system editor (a system, its scenarios, a catalogue
entry such as a new part) is shared through the repository itself: each
member's work is a branch `shared/<github-login>/<name>` on GitHub. Nothing
else stores it, so it is versioned and reviewable, and it reaches `dev` the
usual way, through a pull request.

## Sign in

- **Desktop app:** **Team sharing → Sign in with GitHub**. It shows a code;
  open the link in your browser, enter the code and approve.
- **Terminal:** `vhil login` (GitHub's device flow; it works in WSL), then
  `vhil whoami` and `vhil logout`.

The token stays in a file only you can read, `~/.config/vhil/github` (in WSL
on Windows), as the GitHub CLI keeps its own. It has the `public_repo` scope:
pushing branches to this public repository, where you need write access.
`vhil ui` (the app's Open) hands it to the vHIL when it starts: after signing
in, stop the app's containers and open the vHIL again.

Without signing in you can still sync and open everything teammates shared.

## Share

Open a system and commit it (Commit…). Signed in, the commit goes to a branch
of yours, `shared/<you>/<system>-<date>`, and is pushed right after: the
team sees it on their next sync. A failed push keeps the commit; **Share** in
the Team view retries it.

## Sync and open

The editor's **Team** view (⇄ in the rail) lists every shared branch: who,
when, its commit message, its systems and tests as buttons that open them
from that branch, and how many catalogue files it adds or changes. It syncs
when the editor starts and when you open the view; **Sync** fetches again.

Opening a teammate's system shows it as they saved it, validated against
their branch's catalogue (a part they added included). An edit never moves
their branch: your commit goes to `shared/<you>/<same name>`, built on their
commit, so both stay.

A state per branch: *not shared yet* (committed here, not pushed), *saved
since shared*, *changed here and on GitHub* (diverged), and how far it is
behind `dev`.

## Into dev

A shared branch is a branch like any other: the commit dialog's **Open PR**
proposes it for `dev`, where it is reviewed and CI runs.

## Server

`vhil/server/team.py`: `GET /api/team` (the list), `POST /api/team/sync`
(fetch `refs/heads/shared/*`, pruning deleted ones) and `POST
/api/team/share` (push one of your branches). Who you are: the signed-in
member on a shared server; on a desktop `VHIL_TEAM_LOGIN`, else the login of
`VHIL_GITHUB_TOKEN`.

## Set-up (once, an isc-fs owner)

Register an OAuth app in the isc-fs organisation with **Enable Device Flow**
on, and put its client ID (public, not a secret) in `bin/vhil` as
`VHIL_DEVICE_CLIENT_ID`'s default. Until then `vhil login` says it isn't set
up.
