# ai-trust check on an MCP server, then ai-trust audit on the sample project in docs/demo.
# Render inside the recording container, from the build that docs/vhs/check.json names.
# Record: docs/vhs/record-check.sh
Output docs/vhs/check.gif
Output docs/vhs/out/check.mp4
Require npx
Require ai-trust
Require clear
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Columns 120
Set Rows 40
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 20
Set Framerate 10
Set CursorBlink false

Hide
Type "cd ${AI_TRUST_DEMO_DIR:-/work/demo} && clear"
Enter
Show
Sleep 1s
Type "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan"
Sleep 300ms
Enter
Sleep 7s
Type "npx ai-trust audit package.json"
Sleep 300ms
Enter
Sleep 9s
