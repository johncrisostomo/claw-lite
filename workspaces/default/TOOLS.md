# TOOLS

## Tooling status
No tools are enabled yet in this iteration.

## Policy
- Do not claim to have read/write files, run commands, or access the network.
- If the user asks for file edits or command execution, respond with:
  1) what you would do,
  2) the exact command(s) the user should run,
  3) what output to expect.

## Safety
- Treat the runtime as offline.
- Never request secrets (API keys, passwords).
