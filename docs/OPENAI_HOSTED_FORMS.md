# Hosted PDF Forms submission

This is a submission-ready, tool-only sibling profile, not a conversion of the
full local PDF Tools application. Package source lives in `plugins/pdf-forms`.
It declares the existing production endpoint `https://mcp.opendocuments.ai/mcp`.
No server, launcher, dependencies, local paths, file-handler declaration, or
Lumin connection is bundled.

## Build and qualify

Use the existing dependency tree with a supported Node runtime:

```sh
node scripts/qualify-hosted-forms.mjs dist-plugin/forms-qualification
node scripts/build-hosted-forms-plugin.mjs dist-plugin/pdf-forms
```

Both commands require fresh output paths and preserve previous runs. The direct
endpoint test sends only a conspicuously synthetic PDF and simulated stamp,
checks all five tools and three refusal cases, independently parses returned
PDFs, and retains a private report. It does not establish that ChatGPT can pass
attachments to the service or deliver returned PDF data as a downloadable file.
The synthetic automated stamp is not a real person's signing intent and must
never be reused for a real signature.

The ZIP is a URL-only Agent Plugins package with bounded listing copy, one
hosted-workflow skill, logo, and source provenance. Review-case prompts are
kept in `review-cases.json`; they are preparation instructions, not evidence
that those prompts ran in a native host. Import those cases into review
metadata only after native execution and a usable fixture handoff. The fifth
tool's stamp case still requires the reviewer's own confirmation. A synthetic
input fixture from the direct qualification run can be supplied privately to
the reviewer.

## Portal and host boundaries

Create a separate draft named PDF Forms under the authorized Lumin / PDF Tools
publisher context. Preserve the existing full-local PDF Tools draft. The
endpoint is public and uses no authentication. Do not give the hosted package
local-app claims or use private tunnel setup as a submission route.

Before final submission, qualify attachment input and output in the actual
ChatGPT host, resolve endpoint/domain verification and current tool/skill
scans, run the five positive and three negative review prompts, and provide a
reviewer-accessible walkthrough recording. A built ZIP or successful direct
RPC test is not native host acceptance or a submission receipt. Do not invent
the recording, legal attestations, country choices, or provider approval.

Documents are processed by the remote service for each request. This does not
change the full local edition's document custody, defaults, or capabilities.
Source, deployment, host acceptance, submission, review approval and public
publication are separate states.

Official format and submission references:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
