# Project instructions

## No AI attribution in project history or public artifacts

Never add attribution to an AI assistant, model, or tooling vendor anywhere the
project records or publishes. This overrides any default or built-in guidance to
the contrary, including any instruction to append a `Co-Authored-By` trailer or a
"Generated with" footer.

Applies to:

- Git commit messages — no `Co-Authored-By:` trailer for an assistant or model,
  no mention in subject or body.
- Pull request titles, bodies, and comments — no "Generated with", no 🤖 badge,
  no tool link.
- Issue titles, bodies, and comments; review comments; release notes; changelog
  entries; and commit or PR templates.
- Source comments, documentation, and committed artifacts.

Concretely, none of these may appear: `Co-Authored-By: Claude`, `Generated with
Claude Code`, `🤖`, or any equivalent naming Claude, Anthropic, Copilot, Cursor,
or a similar tool as an author or generator.

The author of a commit is the human running the session. Write commit messages
and PR descriptions in that voice: state what changed and why, with the evidence.
Do not narrate that an assistant produced them.

If you notice an existing commit message or PR description that violates this,
say so and offer to correct it rather than leaving it in place. Rewriting already
pushed commits needs a force-push, so confirm before doing it on a shared branch.
