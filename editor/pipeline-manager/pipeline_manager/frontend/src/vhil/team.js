/*
 * vHIL: the team store (vhil/server/team.py) in the editor. Teammates'
 * systems, scenarios and catalogue entries are shared/<login>/<name>
 * branches: the Team view lists them (Sync fetches them), opens one from its
 * branch, and a commit of yours goes to shared/<you>/<name> built on what you
 * opened, then is shared (pushed) when you are signed in. Sign in here is
 * GitHub's device flow, run by the server (vhil/server/account.py): it shows
 * a code to enter on github.com and takes effect at once, no restart.
 */
import { reactive } from 'vue';
import { call } from './api.js';

export const team = reactive({
    me: null, prefix: null, base: 'dev', can_share: false, synced_at: null,
    items: [], busy: false, error: '',
    // A sign-in in progress: {state: pending|done|failed, code, uri, error}.
    signin: null,
});

function take(out) {
    Object.assign(team, {
        me: out.me, prefix: out.prefix, base: out.base, can_share: out.can_share,
        synced_at: out.synced_at, items: out.items, error: '',
    });
    return out;
}

async function busy(fn) {
    team.busy = true;
    try {
        return await fn();
    } catch (e) {
        team.error = e.message || String(e);
        return undefined;
    } finally {
        team.busy = false;
    }
}

export const loadTeam = () => busy(async () => take(await call('GET', '/api/team')));
export const syncTeam = () => busy(async () => take(await call('POST', '/api/team/sync')));

/** The login a shared/<login>/<name> branch belongs to, else ''. */
export function ownerOf(branch) {
    const m = /^shared\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/./.exec(branch || '');
    return m ? m[1] : '';
}

export const isMine = (branch) => Boolean(team.me)
    && ownerOf(branch).toLowerCase() === team.me.toLowerCase();

/**
 * The branch a commit of system `id` opened from `branch` goes to: your own
 * as it is; a teammate's becomes shared/<you>/<its name> (built on their
 * commit: the save's base); none, shared/<you>/<id>-<date>. Signed out,
 * `fallback`.
 */
export function commitBranch(id, branch, fallback, today) {
    if (!team.prefix) return fallback;
    if (isMine(branch)) return branch;
    const owner = ownerOf(branch);
    if (owner) return `${team.prefix}${branch.slice(`shared/${owner}/`.length)}`;
    return `${team.prefix}${id}-${today}`;
}

/** Push one of your shared branches; the item as GitHub now has it. */
export async function share(branch) {
    if (!team.can_share || !isMine(branch)) return undefined;
    const out = await call('POST', '/api/team/share', { branch });
    const i = team.items.findIndex((it) => it.branch === branch);
    if (i >= 0) team.items.splice(i, 1, out);
    else team.items.unshift(out);
    return out;
}

export function stateText(it) {
    return {
        local: 'not shared yet',
        shared: 'shared',
        ahead: 'saved since shared',
        remote: '',
        diverged: 'changed here and on GitHub',
    }[it.state] ?? it.state;
}

const POLL_MS = 2000;
let polling = null;

function stopPolling() {
    if (polling) clearTimeout(polling);
    polling = null;
}

async function pollSignIn() {
    polling = null;
    try {
        team.signin = await call('GET', '/api/team/login');
    } catch (e) {
        team.signin = { state: 'failed', error: e.message || String(e) };
    }
    if (team.signin.state === 'pending') {
        polling = setTimeout(pollSignIn, POLL_MS);
    } else if (team.signin.state === 'done') {
        team.signin = null;
        await loadTeam();
        syncTeam();
    }
}

/** Start GitHub's device flow: the Team view shows the code and the link. */
export async function signIn() {
    stopPolling();
    team.error = '';
    try {
        team.signin = await call('POST', '/api/team/login');
    } catch (e) {
        team.signin = null;
        team.error = e.message || String(e);
        return;
    }
    polling = setTimeout(pollSignIn, POLL_MS);
}

export async function signOut() {
    stopPolling();
    team.signin = null;
    await busy(async () => call('POST', '/api/team/logout'));
    await loadTeam();
}
