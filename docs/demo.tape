# ai-trust — trust verification for AI packages
# Run: vhs docs/demo.tape

Output docs/ai-trust-demo.gif

Set Width 950
Set Height 550
Set FontSize 14
Set FontFamily "JetBrains Mono"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Padding 15

Hide
Type "clear"
Enter
Sleep 500ms
Show

Sleep 1s
Type "ai-trust audit package.json"
Sleep 2s
Enter

Hide
Type "cat /tmp/ai-trust-demo-output.txt"
Enter
Sleep 2s
Show

Sleep 8s
