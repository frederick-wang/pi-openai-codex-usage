# CLAUDE.md

@AGENTS.md

Project standards, hard-won implementation notes, writing rules, and agent-skill configuration live in `AGENTS.md` (imported above). Summary:

- No personal information in any file, including git history (see AGENTS.md "Project standards").
- English shipped text with an idiomatic Chinese README mirror; zero runtime deps; single extension file; ChatGPT Codex subscription OAuth only.
- Before any release: install the packed tarball and run it under real pi once (AGENTS.md explains why the test suite cannot replace this).
- npm publishing follows the AGENTS.md notes (404-vs-auth, OIDC setup-node shape, repository.url form).
- Issue tracker: GitHub Issues (`docs/agents/issue-tracker.md`).
- Triage labels: five canonical defaults (`docs/agents/triage-labels.md`).
- Domain docs: single-context `CONTEXT.md` + `docs/adr/` (`docs/agents/domain.md`).
