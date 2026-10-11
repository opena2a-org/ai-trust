# ai-trust — trust verification for AI packages
#
# Record from the repository root after a build:
#   npm run build && vhs docs/demo.tape
#
# Every frame is live output: the tape runs the build in dist/ against the
# public registry. It does not replay saved output. The audit step uses the
# sample project in docs/demo/package.json.

Output docs/ai-trust-demo.gif

Set Shell "bash"
Set Width 1000
Set Height 600
Set FontSize 14
Set FontFamily "JetBrains Mono"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 15

Hide
Type `unset CI; alias ai-trust="node $PWD/dist/index.js"; cd docs/demo; PS1='$ '; clear`
Enter
Sleep 1s
Show

Sleep 500ms
Type "ai-trust check @modelcontextprotocol/server-filesystem --no-scan"
Sleep 500ms
Enter
Sleep 6s

Hide
Type "clear"
Enter
Sleep 500ms
Show

Sleep 500ms
Type "ai-trust audit package.json"
Sleep 500ms
Enter
Sleep 9s
