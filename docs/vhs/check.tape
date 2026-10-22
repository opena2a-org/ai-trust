# ai-trust check on an MCP server, then ai-trust audit on the sample project in docs/demo.
# Render inside the recording container, from the build that docs/vhs/check.json names.
# Record: docs/vhs/record-check.sh
# Each step waits for the prompt, takes its anchor frame, then holds its output for the time
# docs/vhs/check.narration.json takes to read.
Output docs/vhs/check.gif
Output docs/vhs/out/check.mp4
Require npx
Require ai-trust
Require clear
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Columns 120
Set Rows 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 120ms
Set Padding 20
Set Framerate 10
Set CursorBlink false

Hide
Type "cd ${AI_TRUST_DEMO_DIR:-/work/demo} && clear"
Enter
Show
Sleep 1s
# step: s1 Look up an MCP server in the registry
Type "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan"
Sleep 800ms
Enter
Wait@30s
Screenshot docs/vhs/check-s1.png
Sleep 7s
# step: s2 Audit the dependencies in package.json
Type "npx ai-trust audit package.json"
Sleep 800ms
Enter
Wait@30s
Screenshot docs/vhs/check-s2.png
Sleep 9s
