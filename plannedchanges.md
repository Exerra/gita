# Planned Changes

## Objective
Replace hardcoded "main" branch name with dynamic branch detection in the error handling block of `src/index.ts`.

## Steps
1.  **Detect Current Branch**: Use `git.revparse(['--abbrev-ref', 'HEAD'])` to get the current branch name.
2.  **Update Error Handler**: Replace the hardcoded `"main"` with the dynamic branch name in the `git.push` command within the `catch` block.

## Verification
- Ensure the branch is correctly detected.
- Verify that the `push` command uses the correct branch name when handling the "no upstream branch" error.