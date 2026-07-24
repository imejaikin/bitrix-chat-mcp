#!/usr/bin/env python3
"""Sync Cursor rules into navigation pointer files for Codex CLI and Claude Code.

Source of truth: `.cursorrules` and `.cursor/rules/*.mdc`.
Generated navigation layer: `AGENTS.md` and `CLAUDE.md` (root + nested).

The generated files never contain rule content of their own. They only point an
agent at the Cursor rule files it should read.

All project-specific settings (which directories to skip, which non-generated
pointer files to allow) live in the required `sync-ai-rules.config.json` next to
this script; see `_load_config`. The script itself is location- and
project-independent: the repo root is found via git, and the config carries
everything else, so it ports unchanged to other PHP/Laravel repos.

Commands (run from anywhere; the repo root is detected via git):
    python3 <path>/sync-ai-rules.py generate
    python3 <path>/sync-ai-rules.py check
    python3 <path>/sync-ai-rules.py self-test

`generate` creates/updates managed files and removes stale ones.
`check` exits non-zero when the managed files are out of sync.

Glob handling (pragmatic, project-specific decision):
  - A trailing `/**`, `/*` or `/` is treated as "this directory".
  - A simple path with no wildcards maps to the directory of the file (or to the
    directory itself if the path is a directory).
  - Any other wildcard — a basename glob like `dir/Prefix*.js` or a middle
    segment like `a/*/b.php` — is NOT expanded (a non-fatal warning): the rule
    stays in the root optional catalog but produces no nested pointer files.
    (Mapping a basename glob to its whole directory would over-apply the rule to
    unrelated files; decided 2026-05-29.)
  - A non-wildcard path must exist (a file maps to its directory, a directory to
    itself); a path that does not exist is a fatal error (probable typo), never
    remapped to a neighbouring directory — not even when it carries a file
    extension, since that would silently over-broaden (a file glob -> its dir) or
    drop (a root-level file -> root) a target we cannot verify.
  - A target that escapes the repository root (via `..`, an absolute path, or a
    symlink) is a fatal error, so we never write outside the repo.
  - A target that resolves to the repo root itself is NOT fatal: it is skipped,
    because the root AGENTS.md already covers that scope and a pointer there would
    clobber it (see "Root-file globs are deliberately dropped" below).

Design notes (intentional, not bugs — see chat history 2026-05-29):
  - Root-file globs are deliberately dropped. Several rules list repo-root files
    in `globs` (e.g. billing-api.mdc: ajax_login.php, seed.php, release.php). We
    generate no per-file pointer for them: their folder is the repo root, where a
    pointer would clobber the main AGENTS.md, and it is unnecessary because the
    root AGENTS.md is always loaded and already names those files inside the
    rule's `description`. This is correct, not a gap in the .mdc.
  - Redundant nested pointers are left in place on purpose. A child directory can
    point at the same rule as one of its ancestors (e.g. ui/js/plugins/ and
    ui/js/plugins/components/Tariff/ both -> billing-api.mdc). Agents read the
    full ancestor chain, so the deeper file is redundant — but the nested file's
    "read ... if you have not already opened them" wording makes the duplicate a
    no-op. We do NOT prune descendants whose rule set is covered by an ancestor:
    the cost of the duplicate is trivial, while wrong pruning would silently drop
    coverage if the ancestor-chain assumption ever fails to hold.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

# --- Paths -----------------------------------------------------------------

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _detect_root():
    """Repository root, resolved so the script is location-independent.

    Prefer git's toplevel (works wherever the script lives — build/system_scripts,
    tools/, scripts/, …); fall back to two levels up from this file when git is
    unavailable.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=_SCRIPT_DIR, capture_output=True, text=True,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return os.path.abspath(proc.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return os.path.abspath(os.path.join(_SCRIPT_DIR, "..", ".."))


ROOT = _detect_root()
RULES_DIR = os.path.join(ROOT, ".cursor", "rules")
CURSORRULES = ".cursorrules"

# This script's path relative to the repo root (forward slashes), used in the
# marker and in user-facing hints so both are correct wherever the script lives.
SCRIPT_REL = os.path.relpath(os.path.abspath(__file__), ROOT).replace(os.sep, "/")
GENERATE_CMD = f"python3 {SCRIPT_REL} generate"

# Marker identifying a generated file. Derived from the script's own path so it is
# correct in any repo, yet stays byte-identical as long as the script is not
# moved (changing it would make existing generated files look unmanaged).
MARKER = f"<!-- Auto-generated by {SCRIPT_REL}; do not edit manually. -->"

WILDCARD_CHARS = set("*?[]{}")

# Required config file, kept next to the script so it travels with it. ALL
# project-specific settings live here (not in the script), so the script ports
# unchanged across PHP/Laravel projects.
CONFIG_PATH = os.path.join(_SCRIPT_DIR, "sync-ai-rules.config.json")

# prune_dirs entries that must always be present: scanning/generating into them
# would corrupt the repo (.git) or the rule source of truth (.cursor).
REQUIRED_PRUNE_DIRS = {".git", ".cursor"}


def _norm_prune_dirs(value):
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise ValueError(f"{CONFIG_PATH}: 'prune_dirs' must be a list of strings")
    names = set()
    for raw in value:
        name = raw.strip()
        # A bare directory name only: no separators (a prior strip("/") silently
        # accepted "/vendor"), no Windows drive prefix or backslash, no . / ..
        if (not name or "/" in name or "\\" in name or name in (".", "..")
                or re.match(r"^[A-Za-z]:", name)):
            raise ValueError(
                f"{CONFIG_PATH}: 'prune_dirs' entry {raw!r} must be a bare "
                "directory name (no slashes, backslashes, drive letters, . or ..)")
        names.add(name)
    missing = REQUIRED_PRUNE_DIRS - names
    if missing:
        raise ValueError(
            f"{CONFIG_PATH}: 'prune_dirs' must include {sorted(missing)}")
    return names


def _norm_allowlist(value):
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise ValueError(f"{CONFIG_PATH}: 'allowlist' must be a list of strings")
    paths = set()
    for raw in value:
        p = raw.strip()
        # Reject absolute / drive-qualified paths on the RAW value. A Windows-style
        # entry like `C:\tmp\AGENTS.md` would otherwise become `C:/tmp/AGENTS.md`
        # after backslash translation and slip through as repo-relative on Linux;
        # `/foo/AGENTS.md` would survive a later strip("/") as `foo/AGENTS.md`.
        # The requirement is a forward-slash, repo-root-relative path.
        if (os.path.isabs(raw) or p.startswith("/") or "\\" in p
                or re.match(r"^[A-Za-z]:", p)):
            raise ValueError(
                f"{CONFIG_PATH}: 'allowlist' entry {raw!r} must be a repo-root-"
                "relative path inside the repo (forward slashes, no drive letter)")
        while p.startswith("./"):
            p = p[2:]
        p = p.strip("/")
        # Normalize BEFORE the escape check so a path that collapses to an escape
        # (e.g. `foo/../../AGENTS.md` -> `../AGENTS.md`) is rejected as malformed
        # config, not silently kept. A lexical `startswith("..")` on the raw value
        # would miss it.
        norm = os.path.normpath(p) if p else ""
        if not norm or norm == "." or norm.startswith("..") or os.path.isabs(norm):
            raise ValueError(
                f"{CONFIG_PATH}: 'allowlist' entry {raw!r} must be a repo-root-"
                "relative path inside the repo")
        if os.path.basename(norm) not in ("AGENTS.md", "CLAUDE.md"):
            raise ValueError(
                f"{CONFIG_PATH}: 'allowlist' entry {raw!r} must end in "
                "AGENTS.md or CLAUDE.md")
        paths.add(norm)
    return paths


def _load_config():
    """Load required project settings from sync-ai-rules.config.json.

    The file is mandatory: project-specific values live only here so the script is
    reusable across repos without edits.

    Keys:
      "prune_dirs": [str]  (required) bare directory names never scanned or
                           generated into; must include .git and .cursor.
      "allowlist":  [str]  (optional) repo-root-relative AGENTS.md/CLAUDE.md
                           allowed to exist without the auto-generated marker.

    Any structural problem (missing file, wrong types, bad entries) is a hard
    error: guessing could scan the wrong tree or hide a manual pointer.
    """
    if not os.path.isfile(CONFIG_PATH):
        raise SystemExit(
            f"error: missing required config {CONFIG_PATH}\n"
            'create it, e.g. {"prune_dirs": [".git", ".cursor", "vendor", '
            '"node_modules"], "allowlist": []}')
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        cfg = json.load(fh)  # raises on malformed JSON — intentional
    if not isinstance(cfg, dict):
        raise ValueError(f"{CONFIG_PATH}: top level must be a JSON object")
    if "prune_dirs" not in cfg:
        raise ValueError(f"{CONFIG_PATH}: 'prune_dirs' is required")
    prune = _norm_prune_dirs(cfg["prune_dirs"])
    allow = _norm_allowlist(cfg.get("allowlist", []))
    return prune, allow


# Loaded lazily: generate/check need the config, but self-test does not — it
# drives throwaway repos via subprocess and must run on a freshly-copied script
# before the new project has written its config.
PRUNE_DIRS = None
ALLOWLIST = None


def _ensure_config():
    global PRUNE_DIRS, ALLOWLIST
    if PRUNE_DIRS is None:
        PRUNE_DIRS, ALLOWLIST = _load_config()


def _require_git():
    """Hard-require a git work tree for check/generate.

    The committed rule layer depends on git to (a) tell shared rules from
    local-only `.mdc` (via check-ignore) and (b) find tracked pointers inside
    pruned dirs (via ls-files). Without git both degrade to "nothing ignored /
    nothing tracked", which silently LEAKS local-only rules into the generated
    layer instead of failing — so refuse to run rather than emit a wrong layer.
    self-test is exempt: it drives throwaway repos that always run `git init`.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=ROOT, capture_output=True, text=True,
        )
    except (OSError, subprocess.SubprocessError):
        proc = None
    if proc is None or proc.returncode != 0 or proc.stdout.strip() != "true":
        raise SystemExit(
            "error: git is required — the rule layer uses it to separate shared "
            "from local-only .mdc and to find tracked pointers in pruned dirs. "
            "Run inside a git work tree with git installed.")


# --- Frontmatter parsing ---------------------------------------------------

def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _scalar(value):
    """Normalize a YAML scalar: drop an inline ` #` comment and surrounding quotes.

    A comment is only stripped when the `#` is preceded by whitespace (YAML rule),
    and never inside quotes, so values like `report_constructor_#` survive.
    """
    s = value.strip()
    if s and s[0] in "\"'":
        quote = s[0]
        end = s.find(quote, 1)
        if end != -1:
            return s[1:end]
    s = re.sub(r"\s+#.*$", "", s).strip()
    return s


def parse_frontmatter(text):
    """Minimal YAML frontmatter parser for the subset used by .mdc files.

    Handles inline scalars (`key: value`), folded/literal block scalars
    (`key: >-` followed by indented lines) and simple lists (`key:` followed
    by `- item` lines). No external YAML dependency, on purpose.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}

    fm = lines[1:end]
    data = {}
    i, n = 0, len(fm)
    while i < n:
        line = fm[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_]+):\s*(.*)$", line)
        if not m:
            i += 1
            continue
        key_indent = len(m.group(1))
        key, rest = m.group(2), m.group(3).strip()

        # Block scalar: gather the more-indented continuation lines.
        if rest in (">", ">-", ">+", "|", "|-", "|+"):
            block = []
            i += 1
            while i < n and (not fm[i].strip() or _indent(fm[i]) > key_indent):
                block.append(fm[i].strip())
                i += 1
            data[key] = " ".join(x for x in block if x).strip()
            continue

        # Empty value: may be a YAML list of `- item` lines.
        if rest == "":
            items = []
            i += 1
            while i < n and (
                not fm[i].strip()
                or (_indent(fm[i]) > key_indent and fm[i].lstrip().startswith("- "))
            ):
                s = fm[i].strip()
                if s.startswith("- "):
                    items.append(_scalar(s[2:]))
                i += 1
            data[key] = items if items else ""
            continue

        # Inline scalar (strip surrounding quotes and an inline comment).
        data[key] = _scalar(rest)
        i += 1
    return data


# --- Rule model ------------------------------------------------------------

def _git_ignored(rel_paths):
    """Return the subset of rel_paths that git ignores (local-only files).

    The project's `.cursor/rules/.gitignore` whitelists shared `.mdc` and
    ignores everything else, so ignored files are personal experiments that
    must NOT leak into the committed navigation layer. git is guaranteed present
    by _require_git(); any failure here is fatal (fail closed) rather than
    returning "nothing ignored" — degrading silently would treat a local-only
    rule as shared and let it leak into the committed pointers.

    --no-index makes the .gitignore rules the sole shared/local boundary: plain
    `check-ignore` never reports a tracked file as ignored, so a force-added
    (`git add -f private.mdc`) or still-tracked-after-un-whitelisting rule would
    slip through as shared. With --no-index the rules decide regardless of the
    index, which is exactly the boundary the .gitignore is meant to define.
    """
    if not rel_paths:
        return set()
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "--no-index", "--"] + rel_paths,
            cwd=ROOT, capture_output=True, text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SystemExit(f"error: 'git check-ignore' failed to run ({exc})")
    # Exit 0: some paths ignored; 1: none ignored; anything else is an error
    # (e.g. 128 not-a-repo) — fail closed so a local-only rule cannot leak.
    if proc.returncode not in (0, 1):
        raise SystemExit(
            f"error: 'git check-ignore' exited {proc.returncode}: "
            f"{proc.stderr.strip() or 'unknown error'}")
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def whitelist_errors():
    """Problems in .cursor/rules/.gitignore that break the shared/local boundary.

    The repo pattern is `*` (ignore everything) plus explicit `!.gitignore` and
    `!name.mdc` un-ignores. Anything else is rejected:
      - a wildcard or sub-path exception (e.g. `!*.mdc`, `!a/b.mdc`) un-ignores
        more than one named rule, so local experiments would be pulled into the
        shared layer — fail rather than "leave it for git to interpret";
      - a plain `!name.mdc` whose file is missing is a stale exception — a latent
        leak vector for a future local file of that exact name.
    A `!name.mdc` can also be syntactically valid yet ineffective: a later rule
    (e.g. a trailing `*`) re-ignores the file — in gitignore the last match wins —
    so git still ignores it and load_rules silently drops it. We verify each valid
    exception actually takes effect via git, not just by syntax.

    A missing .gitignore is the caller's concern (build_expected): it is the
    boundary, so its absence is a hard error there.
    """
    gi = os.path.join(RULES_DIR, ".gitignore")
    if not os.path.isfile(gi):
        return []
    errs = []
    valid_names = []
    with open(gi, encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if not s.startswith("!"):
                continue
            name = s[1:].strip()
            if name == ".gitignore":
                continue
            if ("/" in name or not name.endswith(".mdc")
                    or any(c in WILDCARD_CHARS for c in name)):
                errs.append(
                    f".cursor/rules/.gitignore: unsafe un-ignore '!{name}' — only "
                    "explicit '!name.mdc' (and '!.gitignore') are allowed; a broad "
                    "or wildcard exception would pull local .mdc into the shared layer.")
            elif not os.path.isfile(os.path.join(RULES_DIR, name)):
                errs.append(
                    f".cursor/rules/.gitignore: whitelists '!{name}' but no such "
                    "rule file exists — a local file with that name would leak into "
                    "the shared layer; remove the stale exception or add the rule.")
            else:
                valid_names.append(name)
    # Behavioural: a valid `!name.mdc` for an existing file is still useless if a
    # later rule re-ignores it (last match wins), so git keeps the file ignored
    # and the rule is dropped from the shared layer. Ask git which are ignored.
    if valid_names:
        ignored = _git_ignored([f".cursor/rules/{n}" for n in valid_names])
        for n in valid_names:
            if f".cursor/rules/{n}" in ignored:
                errs.append(
                    f".cursor/rules/.gitignore: whitelist entry '!{n}' is "
                    "ineffective — a later rule re-ignores the file, so the rule "
                    "is dropped from the shared layer; move the `!` exception after "
                    "the ignore-all rule.")
    return errs


def _git_ls_rules_files():
    """Repo-relative git-tracked rule-source files in the flat .cursor/rules dir:
    the `.gitignore` boundary and the `*.mdc` rules."""
    try:
        proc = subprocess.run(
            ["git", "ls-files", "--", ".cursor/rules/.gitignore", ".cursor/rules/*.mdc"],
            cwd=ROOT, capture_output=True, text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SystemExit(f"error: 'git ls-files' failed to run ({exc})")
    if proc.returncode != 0:
        raise SystemExit(
            f"error: 'git ls-files' exited {proc.returncode}: "
            f"{proc.stderr.strip() or 'unknown error'}")
    out = []
    for line in proc.stdout.splitlines():
        relp = line.strip()
        # git's `*` pathspec matches across `/`; keep only the flat rules dir.
        if os.path.dirname(relp) != ".cursor/rules":
            continue
        if relp.endswith(".mdc") or os.path.basename(relp) == ".gitignore":
            out.append(relp)
    return out


def _git_tracked_rules_mdc():
    """Repo-relative git-tracked `.cursor/rules/*.mdc` (flat dir only)."""
    return [p for p in _git_ls_rules_files() if p.endswith(".mdc")]


def tracked_unwhitelisted_mdc():
    """Tracked `.cursor/rules/*.mdc` that the .gitignore rules consider ignored.

    Symmetric to the stale-exception case in whitelist_errors(): here a rule is
    committed but NOT whitelisted (e.g. its `!name.mdc` was removed from .gitignore
    but `git rm` was forgotten). load_rules() would silently drop such a committed
    rule from the generated layer and check would still pass — so fail closed.
    """
    rel_mdc = _git_tracked_rules_mdc()
    if not rel_mdc:
        return []
    ignored = _git_ignored(rel_mdc)
    return sorted(p for p in rel_mdc if p in ignored)


def load_rules():
    """Return a sorted list of shared rule dicts.

    The shared/local boundary is the `.cursor/rules/.gitignore` ruleset, not the
    index: a `.mdc` is included iff those rules do not ignore it (evaluated via
    `git check-ignore --no-index`), regardless of whether it is tracked. Files the
    rules ignore are local-only experiments and are skipped so they never reach
    the committed pointer files.
    """
    rules = []
    if not os.path.isdir(RULES_DIR):
        return rules
    names = sorted(f for f in os.listdir(RULES_DIR) if f.endswith(".mdc"))
    rel_paths = [os.path.join(".cursor", "rules", f) for f in names]
    ignored = _git_ignored(rel_paths)
    for fname in names:
        rel_path = os.path.join(".cursor", "rules", fname)
        if rel_path in ignored:
            print(f"skipping local-only rule {rel_path} (git-ignored)", file=sys.stderr)
            continue
        path = os.path.join(RULES_DIR, fname)
        with open(path, encoding="utf-8") as fh:
            fm = parse_frontmatter(fh.read())

        always = str(fm.get("alwaysApply", "")).strip().lower() == "true"
        description = " ".join(str(fm.get("description", "")).split())

        raw_globs = fm.get("globs", "")
        if isinstance(raw_globs, list):
            globs = [g for g in (s.strip() for s in raw_globs) if g]
        elif isinstance(raw_globs, str) and raw_globs.strip():
            s = raw_globs.strip()
            if s.startswith("[") and s.endswith("]"):
                # Inline flow list, e.g. globs: [a/**, "b/**"]. Split on commas and
                # normalize each item like a block-list item. A comma inside a
                # quoted value is NOT supported, but glob paths never contain one;
                # if you need that, use the block (`- item`) form.
                globs = [_scalar(x) for x in s[1:-1].split(",") if x.strip()]
                globs = [g for g in globs if g]
            else:
                globs = [s]
        else:
            globs = []

        rules.append({
            "name": fname,
            "rel": os.path.join(".cursor", "rules", fname),
            "always": always,
            "description": description,
            "globs": globs,
        })
    return rules


def classify_glob(glob):
    """Map a single glob to a target. Always returns a (kind, value, reason) triple:

      ("dir", relative_dir, None) -> generate nested pointers in that directory
      ("root", None, None)        -> resolves to repo root, skip (already covered)
      ("skip", glob, reason)      -> intentionally not mapped; non-fatal warning
                                     (e.g. a wildcard we deliberately don't expand)
      ("error", glob, reason)     -> malformed/unsafe glob; fatal (absolute path,
                                     or a non-existent path that looks like a typo)

    The classifier never guesses: ambiguous or out-of-model input is reported, not
    silently remapped to a neighbouring directory.
    """
    g = glob.strip()
    while g.startswith("./"):
        g = g[2:]
    g = g.rstrip()

    # Absolute / root-anchored paths are ambiguous (filesystem path vs. a
    # root-anchored glob); the project's globs are repo-root-relative without a
    # leading slash, so don't guess — treat it as an error.
    if g.startswith("/"):
        return ("error", glob, "absolute/root-anchored path; use a repo-root-relative path")

    target = None
    if g.endswith("/**"):
        target = g[:-3]
    elif g.endswith("/*"):
        target = g[:-2]
    elif g.endswith("/"):
        target = g[:-1]

    if target is not None:
        if any(c in WILDCARD_CHARS for c in target):
            return ("skip", glob, "wildcard in a middle path segment is not expanded")
        return _as_dir(target)

    # No trailing directory wildcard.
    if any(c in WILDCARD_CHARS for c in g):
        # Any other wildcard (basename like `dir/Prefix*.js`, or a middle segment
        # like `a/*/b.php`) is not expanded: mapping a basename glob to its whole
        # directory would over-apply the rule to unrelated files (decided
        # 2026-05-29). The rule stays in the root optional catalog instead.
        return ("skip", glob, "wildcard outside a trailing `/**` directory glob is not expanded")

    abspath = os.path.join(ROOT, g)
    # Reject a symlinked target before the isfile/isdir tests, which follow links:
    # a glob like `app/Link.php` (Link.php -> outside the repo) would otherwise map
    # to its lexical parent and pass, since downstream checks only validate the
    # parent dir. Directory symlinks are caught later by the realpath check, but a
    # symlinked file slips through — so refuse any symlinked target here.
    if os.path.islink(abspath):
        return ("error", glob, "target is a symlink; point the glob at a real path")
    if os.path.isdir(abspath):
        return _as_dir(g)
    if os.path.isfile(abspath):
        return _as_dir(os.path.dirname(g))
    # Path does not exist. Do NOT guess: a file extension is not proof the file
    # was meant to exist, and remapping to a parent dir (or silently dropping a
    # root-level file) would over-broaden or hide a typo. Fatal, like any other
    # unverifiable target.
    return ("error", glob, "path does not exist (typo?); non-existent targets are fatal")


def _as_dir(rel):
    rel = rel.strip("/").strip()
    if rel in ("", "."):
        return ("root", None, None)
    return ("dir", rel, None)


# --- Content builders ------------------------------------------------------

def _flatten_desc(desc):
    return desc if desc else "(no description)"


def build_root_agents(rules):
    out = [MARKER, "", "# AI assistant rule map (Codex CLI, Claude Code)", ""]
    out += [
        "This file is a generated navigation layer. The real rules live in",
        "`.cursorrules` and `.cursor/rules/*.mdc`. Do not edit this file by hand;",
        f"run `{GENERATE_CMD}`.",
        "",
        "## Base rules (always read first)",
        "",
        f"- `{CURSORRULES}`",
        "",
        "## Always-applied Cursor rules",
        "",
    ]
    always = [r for r in rules if r["always"]]
    if always:
        out.append(
            "Read every file below in full before starting — these rules apply to "
            "all tasks, not only when their topic comes up."
        )
        out.append("")
        for r in sorted(always, key=lambda r: r["rel"]):
            out.append(f"- `{r['rel']}`")
    else:
        out.append("_None currently._")
    out += [
        "",
        "## Optional Cursor Rules",
        "",
        "Read these files when the description matches your task.",
        "",
    ]
    optional = [r for r in rules if not r["always"]]
    for r in sorted(optional, key=lambda r: r["rel"]):
        out.append(f"- `{r['rel']}` — {_flatten_desc(r['description'])}")
    return "\n".join(out) + "\n"


def build_nested_agents(rule_rels):
    out = [MARKER, ""]
    out += [
        "Before editing files in this directory, read these Cursor rule files if",
        "you have not already opened them:",
        "",
    ]
    for rel in sorted(set(rule_rels)):
        out.append(f"- `{rel}`")
    return "\n".join(out) + "\n"


def build_claude():
    return MARKER + "\n@AGENTS.md\n"


# --- Build the full set of expected managed files --------------------------

def build_expected(rules):
    """Return (expected_files, warnings, errors).

    expected_files: dict mapping absolute path -> desired content.
    warnings: non-fatal notes (e.g. a wildcard left only in the root catalog).
    errors: fatal problems (bad/typo glob, escape, pruned dir, symlink, missing
        description) that make `check` fail and `generate` abort without writing.
    """
    warnings = []
    errors = []
    expected = {}

    # The base rule file is one of the two sources of truth and the root catalog
    # links to it unconditionally; a missing/deleted .cursorrules must fail check
    # rather than ship a dangling pointer.
    if not os.path.isfile(os.path.join(ROOT, CURSORRULES)):
        errors.append(
            f"{CURSORRULES}: base rule file is missing — it is a source of truth "
            "the generated catalog points at; restore it or stop referencing it."
        )

    # Guard against accidental deletion of the tracked source-of-truth. If git
    # tracks rule files (.gitignore / *.mdc) under .cursor/rules but they are gone
    # from the working tree (e.g. the whole dir was rm'd), regenerating would
    # silently wipe the layer — refuse before any write.
    missing_tracked = sorted(
        p for p in _git_ls_rules_files() if not os.path.isfile(os.path.join(ROOT, p)))
    if missing_tracked:
        errors.append(
            "tracked rule source is missing from the working tree: "
            f"{', '.join(missing_tracked)} — refusing to regenerate (it would wipe "
            "the rule layer); restore the file(s) or `git rm` them deliberately."
        )

    # .cursor/rules/.gitignore is the shared/local boundary. If the rules dir
    # exists, the boundary file must too: without it every .mdc reads as shared
    # and local experiments leak. Fail closed, like a missing .cursorrules.
    has_gitignore = os.path.isfile(os.path.join(RULES_DIR, ".gitignore"))
    if os.path.isdir(RULES_DIR) and not has_gitignore:
        errors.append(
            ".cursor/rules/.gitignore: missing — it is the shared/local boundary "
            "(the whitelist of shared .mdc); without it every .mdc would be treated "
            "as shared and local experiments could leak. Restore it."
        )
    # The boundary must actually ignore a non-whitelisted .mdc. A .gitignore with
    # `!name.mdc` exceptions but no `*` ignore-all baseline would leave local .mdc
    # un-ignored, so they'd be pulled into the shared layer. Probe with a name
    # nothing would whitelist; if git does not ignore it, the baseline is broken.
    # (Behavioural, so any valid baseline — `*`, `*.mdc`, … — is accepted.)
    if has_gitignore:
        probe = ".cursor/rules/__sync_ai_rules_boundary_probe__.mdc"
        if not _git_ignored([probe]):
            errors.append(
                ".cursor/rules/.gitignore: does not ignore non-whitelisted .mdc — "
                "the `*` ignore-all baseline is missing, so local rules would leak "
                "into the shared layer; add `*` before the `!name.mdc` exceptions."
            )
    # Whitelist hygiene: reject broad/wildcard un-ignores and stale `!name.mdc`
    # exceptions (both would pull unintended .mdc into the shared layer).
    errors.extend(whitelist_errors())
    # The symmetric gap: a committed rule that is no longer whitelisted gets
    # silently dropped from the catalog. Fail so a forgotten `git rm` is caught.
    for relp in tracked_unwhitelisted_mdc():
        errors.append(
            f"{relp}: rule is committed but not whitelisted in "
            f".cursor/rules/.gitignore, so it is dropped from the generated layer "
            f"— add '!{os.path.basename(relp)}' or `git rm` the file."
        )

    # Root navigation files.
    expected[os.path.join(ROOT, "AGENTS.md")] = build_root_agents(rules)
    expected[os.path.join(ROOT, "CLAUDE.md")] = build_claude()

    # Nested files, aggregated per directory across all rules.
    dir_to_rules = {}
    for r in rules:
        if r["always"]:
            continue
        if not r["description"]:
            errors.append(
                f"{r['rel']}: alwaysApply:false without description — "
                "agent cannot tell when to read it from the optional catalog."
            )
        for g in r["globs"]:
            kind, value, reason = classify_glob(g)
            if kind in ("skip", "error"):
                msg = (
                    f"{r['rel']}: glob '{value}' — {reason}; "
                    "no nested pointer generated (rule stays in root catalog)."
                )
                (errors if kind == "error" else warnings).append(msg)
                continue
            if kind == "root":
                continue  # repo-root target, already covered by root AGENTS.md
            rel_dir = os.path.normpath(value)
            abs_dir = os.path.normpath(os.path.join(ROOT, rel_dir))

            # Reject anything that escapes the repository root. Compare *resolved*
            # paths so a symlinked directory cannot pass a purely lexical check and
            # let us write outside the repo.
            real_root = os.path.realpath(ROOT)
            real_dir = os.path.realpath(abs_dir)
            if rel_dir.startswith("..") or os.path.isabs(value) \
                    or os.path.commonpath([real_root, real_dir]) != real_root \
                    or real_dir == real_root:
                errors.append(
                    f"{r['rel']}: glob '{g}' resolves outside the repo "
                    f"('{rel_dir}'); skipped."
                )
                continue
            # Refuse paths that traverse a symlink: the resolved location differs
            # from the intended one, and os.walk (stale detection) would not follow
            # it, leaving generated files unmanaged.
            if os.path.relpath(real_dir, real_root) != rel_dir:
                errors.append(
                    f"{r['rel']}: glob '{g}' -> '{rel_dir}/' traverses a symlink; "
                    "skipped."
                )
                continue
            # Never write where stale detection cannot later scan.
            if set(rel_dir.split(os.sep)) & PRUNE_DIRS:
                errors.append(
                    f"{r['rel']}: glob '{g}' -> '{rel_dir}/' is inside an "
                    "unscanned directory; skipped."
                )
                continue
            if not os.path.isdir(abs_dir):
                errors.append(
                    f"{r['rel']}: glob '{g}' -> '{rel_dir}/' does not exist; skipped."
                )
                continue
            dir_to_rules.setdefault(rel_dir, set()).add(r["rel"])

    for rel_dir, rule_rels in dir_to_rules.items():
        abs_dir = os.path.join(ROOT, rel_dir)
        expected[os.path.join(abs_dir, "AGENTS.md")] = build_nested_agents(rule_rels)
        expected[os.path.join(abs_dir, "CLAUDE.md")] = build_claude()

    # A path cannot be both allowlisted (left manual) and generated by a rule.
    for path in expected:
        if rel(path) in ALLOWLIST:
            errors.append(
                f"{rel(path)}: is in ALLOWLIST but also generated by a rule glob "
                "— remove it from ALLOWLIST or narrow the glob."
            )

    return expected, warnings, errors


# --- Scanning for existing managed / manual files --------------------------

def _classify_navfile(path, managed, manual):
    try:
        with open(path, encoding="utf-8") as fh:
            head = fh.read(400)
    except OSError:
        return
    (managed if MARKER in head else manual).add(path)


def _git_tracked_navfiles():
    """Repo-relative AGENTS.md/CLAUDE.md paths tracked by git (incl. pruned dirs).

    git is guaranteed present by _require_git(); any failure here is fatal (fail
    closed) rather than returning [] — degrading silently would let a tracked
    manual AGENTS.md/CLAUDE.md inside a pruned dir (.docker, vendor, …) escape the
    scan, so check would wrongly pass on an unmanaged pointer.
    """
    try:
        proc = subprocess.run(
            ["git", "ls-files", "--", "*AGENTS.md", "*CLAUDE.md"],
            cwd=ROOT, capture_output=True, text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SystemExit(f"error: 'git ls-files' failed to run ({exc})")
    if proc.returncode != 0:
        raise SystemExit(
            f"error: 'git ls-files' exited {proc.returncode}: "
            f"{proc.stderr.strip() or 'unknown error'}")
    # The `*AGENTS.md` pathspec also matches names like NOTAGENTS.md / MYCLAUDE.md;
    # keep only exact basenames so an unrelated tracked file is not misclassified
    # as a manual pointer (which would wrongly block generate/check).
    out = []
    for line in proc.stdout.splitlines():
        relp = line.strip()
        if relp and os.path.basename(relp) in ("AGENTS.md", "CLAUDE.md"):
            out.append(relp)
    return out


def scan_existing():
    """Walk the repo and classify existing AGENTS.md/CLAUDE.md files.

    Returns (managed, manual): sets of absolute paths. `managed` files contain
    the auto-generated marker; `manual` files do not.
    """
    managed, manual = set(), set()
    seen = set()
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS]
        for fname in filenames:
            if fname not in ("AGENTS.md", "CLAUDE.md"):
                continue
            path = os.path.join(dirpath, fname)
            _classify_navfile(path, managed, manual)
            seen.add(path)
    # Augment with git-tracked files so repo-owned but pruned directories (e.g.
    # .docker) cannot hide a manual/unmanaged pointer that would be committed.
    for relp in _git_tracked_navfiles():
        path = os.path.normpath(os.path.join(ROOT, relp))
        if path not in seen and os.path.exists(path):
            _classify_navfile(path, managed, manual)
    return managed, manual


def rel(path):
    return os.path.relpath(path, ROOT)


def _atomic_write(path, content):
    """Write `content` to `path` via a fresh temp file + os.replace.

    os.replace is atomic on POSIX and Windows, so a reader (or a crash) never sees
    a half-written pointer file. This is per-file atomicity, not a transaction
    across the whole run: a rare mid-run I/O error can still leave the set of files
    drifted — but `check` catches that and CI blocks the branch, which is the right
    risk profile for generated markdown pointers.

    The temp file is created with tempfile.mkstemp in the destination directory:
    a random name opened O_CREAT|O_EXCL, so a pre-planted `<name>.tmp` symlink can
    never be followed to write outside the repo (a fixed temp path could).
    """
    fd, tmp = tempfile.mkstemp(
        prefix=".sync-ai-rules-", suffix=".tmp", dir=os.path.dirname(path) or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --- Commands --------------------------------------------------------------

def cmd_generate():
    _ensure_config()
    _require_git()
    rules = load_rules()
    expected, warnings, errors = build_expected(rules)
    managed, manual = scan_existing()

    # Pre-flight: collect every reason NOT to touch the tree BEFORE any write or
    # remove. A single malformed glob must not delete previously-correct pointers,
    # and the hook runs generate automatically — so on errors this is a no-op.
    for path in sorted(manual):
        if rel(path) in ALLOWLIST:
            continue
        errors.append(
            f"{rel(path)}: file without the auto-generated marker — move its "
            "content into a .mdc, delete it, or add it to ALLOWLIST."
        )
    for path in expected:
        if os.path.islink(path):
            errors.append(
                f"{rel(path)} is a symlink; refusing to write. Remove it or "
                "replace it with a regular generated file."
            )

    if errors:
        for w in warnings:
            print(f"WARNING: {w}", file=sys.stderr)
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print("generate: aborted due to errors; no files changed.", file=sys.stderr)
        return 1

    # All semantic/safety errors were caught above, so writing is straightforward:
    # write changed files (each atomically) and remove stale managed ones. We do
    # NOT attempt a transaction across the run — a rare mid-run I/O error can leave
    # the tree drifted, but `check` catches that and CI blocks the branch, which is
    # the right risk profile for generated pointer files.
    written, removed = 0, 0
    for path, content in expected.items():
        current = None
        if os.path.exists(path):
            # newline="" disables newline translation so CRLF drift is detected
            # and rewritten to the canonical LF form.
            with open(path, encoding="utf-8", newline="") as fh:
                current = fh.read()
        if current != content:
            _atomic_write(path, content)
            written += 1

    for path in sorted(managed):
        if path not in expected:
            os.remove(path)
            removed += 1
            print(f"removed stale {rel(path)}")

    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)

    print(f"generate: {written} written/updated, {removed} removed, "
          f"{len(expected)} managed files total.")
    return 0


def cmd_check():
    _ensure_config()
    _require_git()
    rules = load_rules()
    expected, warnings, errors = build_expected(rules)
    managed, manual = scan_existing()

    problems = []

    for path, content in expected.items():
        if path in manual:
            continue  # reported by the unmanaged-files scan below
        if not os.path.exists(path):
            problems.append(f"{rel(path)}: missing (run generate)")
            continue
        if os.path.islink(path):
            problems.append(f"{rel(path)}: is a symlink (must be a regular generated file)")
            continue
        # newline="" disables newline translation so CRLF drift is not masked.
        with open(path, encoding="utf-8", newline="") as fh:
            current = fh.read()
        if current != content:
            problems.append(f"{rel(path)}: out of sync (run generate)")

    for path in sorted(managed):
        if path not in expected:
            problems.append(f"{rel(path)}: stale managed file (run generate)")

    # Any unmarked AGENTS.md/CLAUDE.md anywhere (not only at expected paths) is
    # unmanaged content; flag it so the "only source of truth" model holds.
    for path in sorted(manual):
        if rel(path) in ALLOWLIST:
            continue
        problems.append(
            f"{rel(path)}: file without the auto-generated marker "
            "(generate it, delete it, or add it to ALLOWLIST)"
        )

    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)

    if problems or errors:
        print("check: OUT OF SYNC", file=sys.stderr)
        for p in problems + errors:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"check: OK ({len(expected)} managed files).")
    return 0


# --- Self-test -------------------------------------------------------------

def cmd_selftest():
    """Run the generator against an isolated throwaway repo and assert behavior.

    This copies the script into a temp git repo with fixture rules and drives the
    real CLI via subprocess, so it covers the same code paths a real run does.
    No external test framework or fixture files; safe to run anywhere.
    """
    import shutil

    failures = []

    def check(cond, label):
        print(f"  {'ok' if cond else 'FAIL'}: {label}")
        if not cond:
            failures.append(label)

    tmp = tempfile.mkdtemp(prefix="sync-ai-rules-selftest-")
    try:
        # Mirror the real script's own relative location so the copy computes the
        # same SCRIPT_REL/MARKER as this process — otherwise the assertions below
        # (which compare against the parent's MARKER) would fail when the script
        # lives somewhere other than build/system_scripts.
        script = os.path.join(tmp, SCRIPT_REL)
        script_dir = os.path.dirname(script)
        os.makedirs(script_dir, exist_ok=True)
        shutil.copyfile(os.path.abspath(__file__), script)
        # The config is required; place it next to the copied script.
        with open(os.path.join(script_dir, "sync-ai-rules.config.json"),
                  "w", encoding="utf-8", newline="\n") as fh:
            json.dump({"prune_dirs": [".git", ".cursor"], "allowlist": []}, fh)

        rules_dir = os.path.join(tmp, ".cursor", "rules")
        os.makedirs(rules_dir)
        os.makedirs(os.path.join(tmp, "app", "Models"))
        os.makedirs(os.path.join(tmp, "routes"))

        def write(path, text):
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)

        def rule(desc, globs=None, always=False):
            head = ["---", f"description: {desc}", f"alwaysApply: {str(always).lower()}"]
            if globs is not None:
                head.append(f"globs: {globs}")
            head += ["---", "body"]
            return "\n".join(head) + "\n"

        def set_gitignore(*mdc_names):
            # Whitelist exactly the named shared rules. Kept in lockstep with the
            # files that actually exist: a `!name.mdc` for a missing file is a
            # dangling exception and now fails check (a latent leak vector), so the
            # fixture only whitelists a rule while its file is present.
            lines = ["*", "!.gitignore"] + [f"!{n}" for n in mdc_names]
            write(os.path.join(rules_dir, ".gitignore"), "\n".join(lines) + "\n")

        set_gitignore("shared.mdc")  # created in S1, present for the whole test
        write(os.path.join(tmp, ".cursorrules"), "# base rules\n")

        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")

        def run(cmd):
            return subprocess.run([sys.executable, script, cmd], cwd=tmp,
                                  capture_output=True, text=True, env=env)

        def read(rel_path):
            p = os.path.join(tmp, rel_path)
            return open(p, encoding="utf-8").read() if os.path.exists(p) else None

        subprocess.run(["git", "init", "-q"], cwd=tmp, env=env, capture_output=True)

        # S1: shared rule with a dir glob generates root + nested pointers.
        write(os.path.join(rules_dir, "shared.mdc"), rule("Shared rule", "app/**"))
        r = run("generate")
        check(r.returncode == 0, "generate exit 0 on a clean shared rule")
        check("shared.mdc" in (read("AGENTS.md") or ""), "shared rule listed in root catalog")
        check("shared.mdc" in (read("app/AGENTS.md") or ""), "nested pointer created under app/")
        check(read("app/CLAUDE.md") == MARKER + "\n@AGENTS.md\n", "nested CLAUDE.md is the import")
        check(run("check").returncode == 0, "check passes right after generate")

        # S2: local-only (non-whitelisted) rule must not leak.
        write(os.path.join(rules_dir, "private.mdc"), rule("Private", "routes/**"))
        check(run("generate").returncode == 0, "generate succeeds with a local-only rule present")
        check("private" not in (read("AGENTS.md") or ""), "local-only rule excluded from catalog")
        check(not os.path.exists(os.path.join(tmp, "routes", "AGENTS.md")),
              "local-only rule generates no nested pointer")

        # S2b: a force-added (now tracked) non-whitelisted rule is ambiguous —
        # committed but not declared shared. It must HARD-FAIL (the tracked-but-
        # unwhitelisted case), not be silently excluded: that way --no-index keeps
        # it out of the shared layer AND a forgotten whitelist entry is surfaced
        # rather than dropping a committed rule. (Plain check-ignore would report
        # the tracked file as not-ignored, so this only fails thanks to --no-index.)
        subprocess.run(["git", "add", "-f", ".cursor/rules/private.mdc"],
                       cwd=tmp, env=env, capture_output=True)
        r = run("generate")
        check(r.returncode != 0, "force-added non-whitelisted rule hard-fails (not silently dropped)")
        check("private" not in (read("AGENTS.md") or ""),
              "force-added non-whitelisted rule is not written into the catalog")
        subprocess.run(["git", "rm", "-f", "--cached", "--quiet",
                        ".cursor/rules/private.mdc"], cwd=tmp, env=env, capture_output=True)
        os.remove(os.path.join(rules_dir, "private.mdc"))

        # S2c: a `!name.mdc` whitelist exception with no matching file fails check
        # (a dangling exception is a latent leak vector for a future local file).
        gi_path = os.path.join(rules_dir, ".gitignore")
        gi_orig = open(gi_path, encoding="utf-8").read()
        write(gi_path, gi_orig + "!ghost.mdc\n")
        check(run("check").returncode != 0, "dangling whitelist exception fails check")
        write(gi_path, gi_orig)
        check(run("check").returncode == 0, "check OK after removing dangling exception")

        # S2d: the symmetric case — a tracked rule that is NOT whitelisted must
        # fail check, otherwise load_rules silently drops a committed rule.
        subprocess.run(["git", "add", ".cursor/rules/shared.mdc"],
                       cwd=tmp, env=env, capture_output=True)
        set_gitignore()  # drop !shared.mdc while shared.mdc stays tracked
        check(run("check").returncode != 0, "tracked but un-whitelisted rule fails check")
        set_gitignore("shared.mdc")
        subprocess.run(["git", "rm", "--cached", "--quiet", ".cursor/rules/shared.mdc"],
                       cwd=tmp, env=env, capture_output=True)
        check(run("check").returncode == 0, "check OK after restoring the whitelist entry")

        # S2e: the boundary file itself must exist — without it every .mdc reads
        # as shared and local experiments leak, so a missing .gitignore fails.
        os.remove(gi_path)
        check(run("check").returncode != 0, "missing .cursor/rules/.gitignore fails check")
        set_gitignore("shared.mdc")
        check(run("check").returncode == 0, "check OK after restoring the boundary file")

        # S2f: a broad/wildcard un-ignore (e.g. !*.mdc) would un-ignore every local
        # .mdc, so it must be rejected — only explicit !name.mdc is allowed.
        write(gi_path, "*\n!.gitignore\n!shared.mdc\n!*.mdc\n")
        check(run("check").returncode != 0, "broad wildcard un-ignore (!*.mdc) fails check")
        set_gitignore("shared.mdc")
        check(run("check").returncode == 0, "check OK after removing the broad exception")

        # S2g: a .gitignore with exceptions but NO `*` ignore-all baseline leaves
        # local .mdc un-ignored; the boundary must fail closed.
        write(gi_path, "!.gitignore\n!shared.mdc\n")
        check(run("check").returncode != 0, "missing `*` ignore-all baseline fails check")
        set_gitignore("shared.mdc")
        check(run("check").returncode == 0, "check OK after restoring the ignore-all baseline")

        # S2h: deleting the tracked source-of-truth (.cursor/rules) must fail
        # before writes — not silently wipe the rule layer.
        subprocess.run(["git", "add", "-f", ".cursor/rules/.gitignore",
                        ".cursor/rules/shared.mdc"], cwd=tmp, env=env, capture_output=True)
        shutil.move(rules_dir, rules_dir + ".bak")  # simulate accidental rm -rf
        check(run("check").returncode != 0,
              "deleted tracked .cursor/rules fails check (no silent wipe)")
        check(run("generate").returncode != 0,
              "generate refuses when the tracked rule source is missing")
        shutil.move(rules_dir + ".bak", rules_dir)
        subprocess.run(["git", "rm", "--cached", "--quiet", "-r", ".cursor/rules"],
                       cwd=tmp, env=env, capture_output=True)
        run("generate")
        check(run("check").returncode == 0, "check OK after restoring the rule source")

        # S2i: a `!name.mdc` placed BEFORE the ignore-all `*` is re-ignored (last
        # match wins) — syntactically valid but ineffective, so the rule would be
        # silently dropped. Must fail.
        write(gi_path, "!.gitignore\n!shared.mdc\n*\n")
        check(run("check").returncode != 0,
              "ineffective whitelist entry (re-ignored by a later rule) fails check")
        set_gitignore("shared.mdc")
        check(run("check").returncode == 0, "check OK after fixing .gitignore rule order")

        # S3: editing a tracked rule's description is detected as drift.
        write(os.path.join(rules_dir, "shared.mdc"), rule("CHANGED desc", "app/**"))
        check(run("check").returncode == 1, "check reports drift after editing description")
        run("generate")
        check("CHANGED desc" in (read("AGENTS.md") or ""), "edited description propagated")

        # S4: a fatal typo glob must abort generate WITHOUT mutating the tree.
        before = read("app/AGENTS.md")
        write(os.path.join(rules_dir, "shared.mdc"), rule("Typo", "nonexistent_typo_dir"))
        r = run("generate")
        check(r.returncode == 1, "generate exits 1 on a fatal (typo) glob")
        check(read("app/AGENTS.md") == before, "tree not mutated when generate aborts on error")
        # A non-existent path is fatal even with a file extension (no guessing).
        write(os.path.join(rules_dir, "shared.mdc"), rule("Missing file", "app/Missing.php"))
        check(run("generate").returncode == 1,
              "generate exits 1 on a non-existent file glob (extension is not trusted)")
        write(os.path.join(rules_dir, "shared.mdc"), rule("Missing root", "missing-root.php"))
        check(run("generate").returncode == 1,
              "generate exits 1 on a non-existent root-level file glob (not silently dropped)")
        # A glob whose target is a symlink (here pointing outside the repo) is
        # fatal — isfile() would otherwise follow it and map to the parent dir.
        link_target = os.path.join(tmp, "OUTSIDE_TARGET.php")
        write(link_target, "x\n")
        link_path = os.path.join(tmp, "app", "Link.php")
        os.symlink(link_target, link_path)
        write(os.path.join(rules_dir, "shared.mdc"), rule("Symlink file", "app/Link.php"))
        check(run("generate").returncode == 1, "generate exits 1 on a symlinked file glob")
        os.remove(link_path)
        os.remove(link_target)
        write(os.path.join(rules_dir, "shared.mdc"), rule("Shared rule", "app/**"))
        run("generate")

        # S5: inline flow list glob produces nested pointers for each dir.
        write(os.path.join(rules_dir, "inline.mdc"), rule("Inline", "[app/**, routes/**]"))
        set_gitignore("shared.mdc", "inline.mdc")  # whitelist alongside the new file
        run("generate")
        check("inline.mdc" in (read("app/AGENTS.md") or "")
              and "inline.mdc" in (read("routes/AGENTS.md") or ""),
              "inline-list glob maps to every listed directory")

        # S6: removing a rule cleans up its now-stale nested pointers.
        os.remove(os.path.join(rules_dir, "inline.mdc"))
        set_gitignore("shared.mdc")  # drop the whitelist entry with the file
        run("generate")
        check(read("routes/AGENTS.md") is None, "stale nested pointer removed after rule deletion")

        # S7: a manual unmarked pointer anywhere fails check.
        write(os.path.join(tmp, "routes", "AGENTS.md"), "hand-written, no marker\n")
        check(run("check").returncode == 1, "manual unmarked pointer fails check")
        os.remove(os.path.join(tmp, "routes", "AGENTS.md"))

        # S8: alwaysApply:true rule lands in the mandatory block.
        write(os.path.join(rules_dir, "always.mdc"), rule("Always rule", always=True))
        set_gitignore("shared.mdc", "always.mdc")  # always.mdc persists to the end
        run("generate")
        check("always.mdc" in (read("AGENTS.md") or "")
              and "_None currently._" not in (read("AGENTS.md") or ""),
              "alwaysApply:true rule surfaced in the always block")
        check(run("check").returncode == 0, "check passes in final state")

        # S8b: a pre-planted <name>.tmp symlink must NOT be followed (no write
        # outside the intended file), and the output must be a regular file.
        sentinel = os.path.join(tmp, "ATTACK_TARGET")
        write(sentinel, "untouched\n")
        attack_link = os.path.join(tmp, "app", "AGENTS.md.tmp")
        os.symlink(sentinel, attack_link)
        # Force a rewrite of app/AGENTS.md so the write path actually runs.
        write(os.path.join(rules_dir, "shared.mdc"), rule("Rewrite trigger", "app/**"))
        run("generate")
        check(read("ATTACK_TARGET") == "untouched\n",
              "fixed-name .tmp symlink is not followed (no write outside target)")
        check(not os.path.islink(os.path.join(tmp, "app", "AGENTS.md")),
              "generated output is a regular file, not a leftover symlink")
        if os.path.lexists(attack_link):
            os.remove(attack_link)
        os.remove(sentinel)
        # Restore the canonical rule so later tests (which check without first
        # regenerating) compare against the same on-disk content as before S8b.
        write(os.path.join(rules_dir, "shared.mdc"), rule("Shared rule", "app/**"))
        run("generate")

        # S8c: a missing base .cursorrules (a source of truth) fails check.
        os.remove(os.path.join(tmp, ".cursorrules"))
        check(run("check").returncode != 0, "missing .cursorrules fails check")
        write(os.path.join(tmp, ".cursorrules"), "# base rules\n")
        check(run("check").returncode == 0, "check passes after restoring .cursorrules")

        # --- config handling (the required sync-ai-rules.config.json) ---
        config_file = os.path.join(script_dir, "sync-ai-rules.config.json")

        def set_config(text):
            with open(config_file, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)

        good_config = '{"prune_dirs": [".git", ".cursor"], "allowlist": []}'

        # S9: missing config is a hard error.
        os.remove(config_file)
        check(run("check").returncode != 0, "missing config is a hard error")
        set_config(good_config)

        # S10: malformed JSON / wrong types / bad entries are hard errors.
        set_config("{ not json")
        check(run("check").returncode != 0, "malformed JSON config is a hard error")
        set_config('{"prune_dirs": "vendor"}')
        check(run("check").returncode != 0, "prune_dirs as a string is rejected")
        set_config('{"prune_dirs": [".git", ".cursor", "a/b"]}')
        check(run("check").returncode != 0, "prune_dirs with a slash is rejected")
        set_config('{"prune_dirs": [".git", ".cursor", "/vendor"]}')
        check(run("check").returncode != 0,
              "prune_dirs with a leading slash is rejected (not silently stripped)")
        set_config(r'{"prune_dirs": [".git", ".cursor", "vendor\\pkg"]}')
        check(run("check").returncode != 0, "prune_dirs with a backslash is rejected")
        set_config('{"prune_dirs": ["vendor"]}')
        check(run("check").returncode != 0, "prune_dirs missing .git/.cursor is rejected")
        set_config('{"prune_dirs": [".git", ".cursor"],'
                   ' "allowlist": ["foo/../../AGENTS.md"]}')
        check(run("check").returncode != 0,
              "allowlist entry escaping the repo after normalization is rejected")
        set_config('{"prune_dirs": [".git", ".cursor"],'
                   ' "allowlist": ["/etc/AGENTS.md"]}')
        check(run("check").returncode != 0,
              "absolute allowlist entry is rejected (not repo-root-relative)")
        set_config(r'{"prune_dirs": [".git", ".cursor"],'
                   r' "allowlist": ["C:\\tmp\\AGENTS.md"]}')
        check(run("check").returncode != 0,
              "Windows drive-qualified allowlist entry is rejected")
        set_config(good_config)

        # S11: allowlist normalizes a leading ./ and lets a manual file pass.
        write(os.path.join(tmp, "routes", "AGENTS.md"), "hand-written, no marker\n")
        check(run("check").returncode == 1, "manual file fails before allowlisting")
        set_config('{"prune_dirs": [".git", ".cursor"],'
                   ' "allowlist": ["./routes/AGENTS.md"]}')
        check(run("check").returncode == 0, "allowlist (with ./) lets a manual file pass")

        # S12: allowlisting a path a rule generates is a hard error.
        write(os.path.join(rules_dir, "shared.mdc"), rule("Shared rule", "routes/**"))
        check(run("check").returncode != 0, "allowlist vs generated path is a hard error")
        os.remove(os.path.join(tmp, "routes", "AGENTS.md"))
        write(os.path.join(rules_dir, "shared.mdc"), rule("Shared rule", "app/**"))
        set_config(good_config)
        check(run("check").returncode == 0, "check passes after restoring config")

        # S13: a tracked file whose name merely ends in AGENTS.md/CLAUDE.md (e.g.
        # NOTAGENTS.md) is NOT a pointer and must not block check.
        write(os.path.join(tmp, "NOTAGENTS.md"), "unrelated tracked file\n")
        subprocess.run(["git", "add", "NOTAGENTS.md"], cwd=tmp, env=env,
                       capture_output=True)
        check(run("check").returncode == 0,
              "tracked NOTAGENTS.md is not misclassified as a manual pointer")
        subprocess.run(["git", "rm", "-f", "--quiet", "NOTAGENTS.md"], cwd=tmp,
                       env=env, capture_output=True)

        # S14: without git, check refuses to run (the local-only model needs it).
        # Use a separate dir that is NOT a git work tree; skip if /tmp happens to
        # sit inside one (rare, but then the assertion would not hold).
        nogit = tempfile.mkdtemp(prefix="sync-ai-rules-nogit-")
        try:
            inside = subprocess.run(
                ["git", "rev-parse", "--is-inside-work-tree"], cwd=nogit,
                capture_output=True, text=True, env=env)
            if inside.returncode == 0 and inside.stdout.strip() == "true":
                print("  skip: no-git test (tempdir is inside a git work tree)")
            else:
                ng_script = os.path.join(nogit, SCRIPT_REL)
                os.makedirs(os.path.dirname(ng_script), exist_ok=True)
                shutil.copyfile(os.path.abspath(__file__), ng_script)
                with open(os.path.join(os.path.dirname(ng_script),
                                       "sync-ai-rules.config.json"),
                          "w", encoding="utf-8", newline="\n") as fh:
                    json.dump({"prune_dirs": [".git", ".cursor"], "allowlist": []}, fh)
                write(os.path.join(nogit, ".cursorrules"), "# base\n")
                r = subprocess.run([sys.executable, ng_script, "check"], cwd=nogit,
                                   capture_output=True, text=True, env=env)
                check(r.returncode != 0, "check refuses to run without git")
        finally:
            shutil.rmtree(nogit, ignore_errors=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print(f"self-test: {len(failures)} FAILED", file=sys.stderr)
        return 1
    print("self-test: OK")
    return 0


def main(argv):
    commands = {"generate": cmd_generate, "check": cmd_check, "self-test": cmd_selftest}
    if len(argv) != 2 or argv[1] not in commands:
        print(f"usage: {os.path.basename(argv[0])} {{generate|check|self-test}}",
              file=sys.stderr)
        return 2
    return commands[argv[1]]()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
