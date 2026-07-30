#!/usr/bin/env node
/**
 * Fires automatically on every `npm run build` (npm "prebuild" lifecycle).
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-30 an agent ran `npm run build` to verify a fix end-to-end and, in doing so,
 * put an uncommitted change into fleet-wide service. `dist/` is gitignored — which reads as
 * "not load-bearing" — but the globally installed `cortextos` is an npm-link SYMLINK into
 * this repo, so `dist/cli.js` is what every agent executes. The fleet ran code that existed
 * in no commit for 70 minutes.
 *
 *   A BUILD STEP IS A DEPLOY WHEN THE BUILD OUTPUT IS WHAT RUNS.
 *
 * A note describing this already existed (RESTORE-dist-2026-07-28.txt, in the repo root, two
 * days earlier, and unusually well built — `rm`/`cp` only, so the rollback never routes
 * through the CLI it is restoring). It did not reach the person who needed it, because
 * `git status` is a list you read for YOUR changes: an unrelated hazard file sitting in it is
 * invisible BY THE WAY THE OUTPUT IS USED, not by oversight.
 *
 *   ⇒ THE FAILURE WAS NOT A BAD NOTE. IT WAS A GOOD NOTE WITH NO DELIVERY MECHANISM.
 *
 * So this is a mechanism rather than a better note: it runs whether or not anyone remembers.
 *
 * DESIGN CONSTRAINTS, each paid for by something that failed this week
 * -------------------------------------------------------------------
 * 1. PRINT AND PROCEED — never prompt. Builds run unattended; a prompt would hang CI and
 *    every scripted invocation. This informs; it does not gate.
 * 2. NEVER FAIL THE BUILD. Any error here must not block a legitimate build — but it must SAY
 *    it could not run. A guard that degrades to silence is indistinguishable from one that
 *    found nothing.
 * 3. VERIFY THE SYMLINK, DO NOT ASSERT IT. The hazard is environment-specific. A guard that
 *    hardcoded "this is linked" would lie on a machine where it is not — and a false claim
 *    about a deploy path is worse than no claim.
 * 4. VERIFY THE SNAPSHOT IT TAKES. A recovery artifact nobody has checked is indistinguishable
 *    from one that works: count the files and checksum the entry point, and print both.
 *
 * ⛔ DO NOT CONVERT THIS BACK TO AN npm "prebuild" LIFECYCLE HOOK.
 * ---------------------------------------------------------------
 * It was wired that way first, and it SILENTLY NEVER RAN: `~/.npmrc` on this machine sets
 * `ignore-scripts=true`, which suppresses pre/post lifecycle scripts while still running the
 * script you explicitly invoke. So `npm run build` executed tsup and skipped `prebuild`
 * without a word — no warning, no error, output identical to a machine with no hook at all.
 *
 * That setting is a deliberate supply-chain defence (it blocks dependencies' install scripts)
 * and must NOT be turned off to make this work: re-enabling third-party postinstall execution
 * across every project on the machine is a far worse trade than the hazard handled here.
 *
 * So the guard is chained INSIDE `build` itself (`node this && tsup`) rather than hung off a
 * lifecycle event. It then runs as part of the command npm was asked to run, which no npm
 * config can skip. A guard that depends on configuration it does not control is not a guard.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIST = join(REPO, 'dist');
const KEEP_SNAPSHOTS = 3;   // newest N pre-build snapshots retained; older ones pruned
const say = (s) => process.stdout.write(`${s}\n`);

/** Every file under dir, recursively. `ls | wc -l` counts TOP-LEVEL ENTRIES and undercounts
 *  whenever a subdirectory exists — it read 5 for a 22-file tree during this very incident,
 *  and nearly produced a false alarm that a verified recovery path was incomplete. */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function globalLinkTarget() {
  // Ask the filesystem, do not assume. Returns {linked, detail}.
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'cortextos'),
    '/usr/local/lib/node_modules/cortextos',
    join(homedir(), '.npm-global', 'lib', 'node_modules', 'cortextos'),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const st = lstatSync(c);
      if (!st.isSymbolicLink()) {
        return { linked: false, detail: `${c} exists but is NOT a symlink (an independent copy)` };
      }
      const target = realpathSync(readlinkSync(c).replace(/^\/([A-Za-z])\//, '$1:/'));
      const here = realpathSync(REPO);
      return target.toLowerCase() === here.toLowerCase()
        ? { linked: true, detail: `${c} -> ${target}` }
        : { linked: false, detail: `${c} -> ${target} (a DIFFERENT checkout, not this one)` };
    } catch (e) {
      return { linked: null, detail: `${c}: could not resolve (${e.message})` };
    }
  }
  return { linked: false, detail: 'no global cortextos install found on the usual paths' };
}

function gitDirty() {
  try {
    const out = execFileSync('git', ['-C', REPO, 'status', '--porcelain', 'src/', 'package.json'],
      { encoding: 'utf-8', timeout: 20000 });
    return { ok: true, lines: out.split('\n').filter(Boolean) };
  } catch (e) {
    return { ok: false, lines: [], err: e.message };
  }
}

function snapshot() {
  if (!existsSync(DIST)) return { taken: false, why: 'no dist/ yet — nothing to snapshot (first build)' };
  // MILLISECOND resolution. At second resolution two builds in the same second produce the
  // SAME directory name and the second silently OVERWRITES the first — measured: five runs
  // produced two snapshots. A rollback artifact that can be replaced without anyone noticing
  // is worse than one that is simply missing.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\./g, '');
  const dest = join(REPO, `dist.backup-prebuild-${stamp}`);
  cpSync(DIST, dest, { recursive: true });

  // VERIFY the artifact rather than trusting cpSync's silence.
  const src = walk(DIST), dst = walk(dest);
  const cli = join(dest, 'cli.js');
  const hash = existsSync(cli) ? sha256(cli) : null;
  const ok = src.length === dst.length && hash !== null;

  // PRUNE. Every build writes ~3.3MB; unattended and unbounded that is a disk-filling
  // machine, and a guard that creates a new failure mode is not a guard. Keep the newest
  // few of OUR OWN snapshots only — never touch dist.backup-known-good-*, which is a
  // hand-made artifact someone deliberately pinned.
  try {
    const mine = readdirSync(REPO)
      .filter((n) => n.startsWith('dist.backup-prebuild-'))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_SNAPSHOTS))) {
      rmSync(join(REPO, old), { recursive: true, force: true });
    }
  } catch (e) {
    // Best-effort, but NOT SILENT. This exact bare catch swallowed a ReferenceError
    // (KEEP_SNAPSHOTS was never declared) across several runs, so pruning never happened —
    // and the output was identical to pruning that worked. A bare `catch {}` inside a guard
    // is the same fail-open shape the guard exists to prevent.
    say(`  ⚠  snapshot pruning failed (${e.message}) — old backups may accumulate.`);
  }

  const note = join(REPO, 'RESTORE-dist-LATEST.txt');
  writeFileSync(note,
    `RESTORE THE PRE-BUILD cortextos CLI\n` +
    `====================================\n` +
    `Auto-written by scripts/prebuild-deploy-notice.mjs immediately BEFORE the build that\n` +
    `replaced dist/. This is the binary the fleet was running until that build.\n\n` +
    `    cd "${REPO}" && rm -rf dist && cp -r "${dest}" dist\n\n` +
    `Then confirm:\n\n` +
    `    cortextos bus list-tasks --agent engineer --status pending\n\n` +
    `Snapshot taken ${new Date().toISOString()} · ${dst.length} files` +
    (hash ? ` · cli.js sha256 ${hash}` : ` · ⚠ cli.js ABSENT from the snapshot`) + `\n` +
    (ok ? '' : `⚠ VERIFICATION FAILED: live had ${src.length} files, snapshot has ${dst.length}.\n` +
               `   Treat this snapshot as UNTRUSTED and prefer an older verified backup.\n`) +
    `\nWhy only rm and cp: dist/cli.js is the tool the fleet uses to COORDINATE a fix. If a\n` +
    `build leaves it inconsistent, nobody can send-message or update-task — so the rollback\n` +
    `must not route through the artifact being rolled back. No npm, no git, no network, no CLI.\n`,
    'utf-8');
  return { taken: true, dest, files: dst.length, hash, ok, note };
}

say('');
say('──────────────────────────────────────────────────────────────────────────────');
say('  npm run build → THIS MAY BE A DEPLOY. Checking what reads dist/ at runtime.');
say('──────────────────────────────────────────────────────────────────────────────');

try {
  const link = globalLinkTarget();
  if (link.linked === true) {
    say(`  ⛔ DEPLOY: the global \`cortextos\` command runs THIS repo's dist/.`);
    say(`     ${link.detail}`);
    say(`     Every agent's \`cortextos bus …\` call executes what this build produces,`);
    say(`     committed or not. dist/ is gitignored — that means UNVERSIONED, not unused.`);
  } else if (link.linked === false) {
    say(`  ok  Not linked to this checkout — building dist/ here is local only.`);
    say(`     ${link.detail}`);
  } else {
    say(`  ⚠  COULD NOT DETERMINE whether the global CLI points here.`);
    say(`     ${link.detail}`);
    say(`     Treat this build as POSSIBLY a deploy until someone checks by hand.`);
  }

  const g = gitDirty();
  if (!g.ok) {
    say(`  ⚠  could not read git status (${g.err}) — cannot say whether the tree is clean.`);
  } else if (g.lines.length) {
    say(`  ⛔ UNCOMMITTED source changes (${g.lines.length}) are about to go live:`);
    for (const l of g.lines.slice(0, 8)) say(`       ${l}`);
    if (g.lines.length > 8) say(`       … and ${g.lines.length - 8} more`);
    say(`     If this is a deploy, the fleet will run code that exists in NO COMMIT.`);
  } else {
    say(`  ok  src/ and package.json are clean — the build matches a commit.`);
  }

  const s = snapshot();
  if (!s.taken) {
    say(`  ok  ${s.why}`);
  } else if (s.ok) {
    say(`  ok  rollback snapshot: ${s.files} files, cli.js ${s.hash.slice(0, 16)}…`);
    say(`     restore instructions written to ${s.note}`);
  } else {
    say(`  ⚠  snapshot taken but FAILED VERIFICATION — see ${s.note}`);
  }
} catch (e) {
  // CONSTRAINT 2: never block a build, never fail silently.
  say(`  ⚠  prebuild deploy-notice could not complete: ${e.message}`);
  say(`     The build proceeds. Nothing above was verified — do not read this as clean.`);
}

say('──────────────────────────────────────────────────────────────────────────────');
say('');
