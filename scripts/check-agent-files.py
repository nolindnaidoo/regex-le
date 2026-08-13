#!/usr/bin/env python3
"""The six agent instruction files are one document. Verify it.

Every major coding assistant looks for its own instruction file, so each repo
carries one for each, and every AGENTS.md says they stay thin pointers and never
grow a second copy of the standard. The way that rule actually breaks is someone
editing one of the six and not the other five.

One implementation, run by both generations: the extension repos call it from
`src/agent-files.test.ts` so it runs in `bun run test`, and the crate-only repos
call it from the `policy` job in `ci-crate.yml`. It used to be written twice --
a vitest file and a Python heredoc -- which is the "define it once" rule broken
inside the gate that enforces the family's rules. The two had already diverged.

Python rather than JavaScript because the crate-only repos have no JavaScript in
them at all, deliberately, and already run python3 in this same workflow.

Run from a repo root:  python3 scripts/check-agent-files.py
"""

import json
import os
import re
import sys

CANONICAL = ".cursorrules"

# Each mirror, and how many directories below the repo root it sits. A mirror
# in a subdirectory reaches AGENTS.md from where it actually is, so its relative
# links carry a `../` per level; the Cursor rule file also carries frontmatter.
# Both are normalised away before comparing. Demanding raw equality instead is
# what left the hub site's two nested mirrors pointing at a file that was not
# beside them -- the gate held two broken links in place for as long as it
# existed.
MIRRORS = [
    (".windsurfrules", 0),
    (".clinerules", 0),
    ("GEMINI.md", 0),
    (".github/copilot-instructions.md", 1),
    (".cursor/rules/project.mdc", 2),
]

# A backstop against the router growing into a second copy of the standard, not
# a target. One number across all sixteen repos: it was 50 in the extension
# repos, 40 on the hub site and nothing at all here, which is how four repos
# grew past it unnoticed. The longest today is 60.
CAP = 70


def body(text):
    """The document without a leading `---` frontmatter block."""
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---\n", 4)
    if end == -1:
        return text
    return text[end + 5 :].lstrip("\n")


def at_root(text, depth):
    """The document with its relative links written back to root-relative form."""
    if depth == 0:
        return text
    return text.replace("](" + "../" * depth, "](")


def links(text):
    """Relative link targets, ignoring URLs and bare anchors."""
    found = re.findall(r"\]\(([^)]+)\)", text)
    return [target for target in found if not re.match(r"https?:|#|/", target)]


def problems_in(read=None, exists=None):
    """Every way this repo's instruction files disagree. Split from I/O so the
    rule can be exercised without a repository on disk."""
    read = read or (lambda path: open(path, encoding="utf-8").read())
    exists = exists or os.path.exists

    found = []
    if not exists(CANONICAL):
        return ["%s: missing" % CANONICAL]
    canonical = read(CANONICAL)

    if len(canonical.splitlines()) >= CAP:
        found.append(
            "%s: %d lines, cap is %d -- it has stopped being a pointer"
            % (CANONICAL, len(canonical.splitlines()), CAP)
        )
    if "AGENTS.md" not in canonical:
        found.append("%s: does not route to AGENTS.md" % CANONICAL)

    for path, depth in MIRRORS:
        if not exists(path):
            found.append("%s: missing" % path)
            continue
        if at_root(body(read(path)), depth) != canonical:
            found.append("%s: has drifted from %s" % (path, CANONICAL))

    # The half equality cannot do: a mirror can match the canonical file exactly
    # and still point at nothing.
    for path, _ in [(CANONICAL, 0)] + MIRRORS:
        if not exists(path):
            continue
        here = os.path.dirname(path)
        for target in links(read(path)):
            if not exists(os.path.join(here, target)):
                found.append("%s: links %s, which is not there" % (path, target))

    # Only where there is a package.json to check against. The crate-only repos
    # name cargo commands rather than `bun run`, so this is inapplicable there
    # rather than skipped -- there is nothing for it to be true or false about.
    if exists("package.json"):
        scripts = json.loads(read("package.json")).get("scripts", {})
        for command in re.findall(r"bun run [a-z0-9:]+", canonical):
            if command.replace("bun run ", "") not in scripts:
                found.append("%s: names `%s`, which is not defined" % (CANONICAL, command))

    return found


def main():
    found = problems_in()
    if found:
        for problem in found:
            print(problem)
        print()
        print("These files are one pointer written six times. Change one, change all")
        print("six, and keep each one's relative links correct for where it sits.")
        return 1
    print("%d agent instruction files agree, and every link resolves." % (len(MIRRORS) + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
