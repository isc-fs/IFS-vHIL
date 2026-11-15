// A firmware repository open in VS Code: which catalogue firmware it is, and
// which of the vHIL's tests and systems run it. Without VS Code, tested by
// test/firmware.test.ts.

import { Board } from "./sidebar";

/** "owner/name" of a GitHub remote URL (https, ssh or scp-like), else undefined. */
export function repoSlug(url: string): string | undefined {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** A catalogue firmware: its id (catalog/firmware/<id>.yaml) and source repo. */
export interface Firmware {
  id: string;
  repo: string; // owner/name
}

/** A catalogue firmware file's id and repo, from its top-level `id:` and `repo:`. */
export function firmwareOf(yaml: string): Firmware | undefined {
  const id = /^id:\s*([\w.-]+)\s*$/m.exec(yaml)?.[1];
  const repo = /^repo:\s*([\w.-]+\/[\w.-]+)\s*$/m.exec(yaml)?.[1];
  return id && repo ? { id, repo } : undefined;
}

/** The catalogue firmware built from repo `slug` (case-insensitive), if any. */
export function firmwareForRepo(catalogue: Firmware[], slug: string): Firmware | undefined {
  return catalogue.find((f) => f.repo.toLowerCase() === slug.toLowerCase());
}

/**
 * The pytest marker of the sim tests that run a firmware (pytest.ini): the
 * board's own (ecu, ams, udv). Every MainLite boots through the CAN
 * bootloader, so its developer gets the tests of the bootloader subsystem.
 */
export function markerOf(firmware: string): string {
  return firmware === "can-bootloader" ? "bootloader" : firmware;
}

/** Whether a board of a system runs `firmware`: by role, by board, or any MainLite for the bootloader. */
export function runsFirmware(board: Board, firmware: string): boolean {
  if (firmware === "can-bootloader") return !!board.role;
  return board.role === firmware || (!board.role && board.board === firmware);
}

/** The systems with a board that runs `firmware`. */
export function systemsOf<S extends { id: string; boards: Board[] }>(systems: S[], firmware: string): S[] {
  return systems.filter((s) => s.boards.some((b) => runsFirmware(b, firmware)));
}

/**
 * The system to build `firmware` from: the one with the most boards running
 * it, so one build gives every image the tests need (the bootloader of each
 * MainLite in ecu-ams-udv), else undefined.
 */
export function buildSystem(systems: { id: string; boards: Board[] }[], firmware: string): string | undefined {
  const count = (s: { boards: Board[] }) => s.boards.filter((b) => runsFirmware(b, firmware)).length;
  return systemsOf(systems, firmware).sort((a, b) => count(b) - count(a) || a.id.localeCompare(b.id))[0]?.id;
}

/**
 * Whether a listed test runs `firmware`: a sim test with its marker, or a
 * scenario of one of `systems` (test_scenario[<system>/<name>]). The unit
 * tests test the vHIL itself, not a firmware.
 */
export function testRuns(test: { id: string; markers: string[] }, firmware: string, systems: string[]): boolean {
  if (test.id.startsWith("tests/sim/")) return test.markers.includes(markerOf(firmware));
  if (test.id.startsWith("tests/scenarios/")) return systems.some((s) => test.id.includes(`[${s}/`));
  return false;
}
