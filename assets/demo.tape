# regex-le — recorded by vhs, driving the real binary against the files in demo/.
#
# Reproduce:  cargo build --release --manifest-path ../crate/Cargo.toml
#             cd assets && vhs demo.tape
#
# This records the CLI, not the VS Code extension — the extension's own clip
# is src/assets/images/demo.gif and shows an editor. The two frontends are
# meant to differ, so they get their own recordings.
#
# Two commands on purpose: stdout is protocol, stderr is human. Sending stdout
# to a file is what a person types when they want to read the findings, and it
# shows both halves without either drowning the other.
#
# The first visible frame carries content on purpose: the site derives each
# card poster from frame one, so a clip that opens on a cleared terminal ships
# a blank still.
#
# 1200x760 scales to the 800x505 the site uses, and holds ~34 rows. Content
# past that scrolls and the demo loses its own opening.

Output demo.gif

Set Shell "bash"
Set FontSize 17
Set Width 1200
Set Height 760
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type "cd demo && export PATH=$(cd ../../crate/target/release && pwd):$PATH && clear"
Enter
Type "cat validate.js"
Enter
Sleep 3s
Show

Type "regex-le validate.js > findings.jsonl"
Enter
Sleep 5s

Type "head -c 96 findings.jsonl"
Enter
Sleep 3s
