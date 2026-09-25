# Remote stateless profile for agent-directory connectors

Status: proposed, 2026-09-19. Sponsor approval to build and submit was given by
Max Ferguson (Lumin) the same day, with Vercel named as the deployment target
and a possible later move to Lumin infrastructure.

This is a second, narrower remote shape that sits beside
[`REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md`](REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md).
It does not amend that decision, change the local MCPB, or lift the WAIT on a
stored-document service.

## Why a second shape exists

The July decision describes a **document custodian**: it stores an immutable
source, versions each mutation, binds tenants and workspaces, and releases
outputs against per-object authorization. Those obligations exist because the
service keeps the bytes.

Meta's Muse connector directory asks for something else. Its submission form
takes an "Existing MCP" at a **hosted MCP endpoint**, and it marks
authentication methods optional. The job it needs done is one turn long: a
person asks their agent to fill and sign a form, and the agent needs a tool that
can do it.

A service that keeps nothing does not need tenants, workspaces, object
authorization, retention policy, deletion, or export review, because there is
no stored object to authorize or delete. It trades those obligations for a
different, smaller set listed below.

## The profile

**P1. No persistence.** Bytes exist only for the lifetime of one request, in
memory. Nothing is written to disk, object storage, a database, or a cache. A
process that cannot write cannot retain.

**P2. No identity.** No accounts, sessions, cookies, or user records. The
service never learns who the caller is, so there is nothing to authorize and
nothing to leak. Rate limiting works on transport metadata alone.

**P3. Bytes in, bytes out.** A request supplies the document inline or names a
URL the service fetches. The result returns inside the MCP response. The
service never hands back a link to something it kept, because it keeps nothing.

**P4. No content in logs or telemetry.** Logs may record tool name, byte
counts, durations, and error classes. They never record document bytes,
extracted text, field names, field values, filenames, or fetched URLs beyond a
scheme and host class.

**P5. One request, one document, bounded.** Explicit caps on request size, page
count, render dimensions, and wall-clock time, enforced before parsing and
again during it. Exceeding a cap fails closed with a typed error.

Two document ceilings, not one, because they have different owners. A document
fetched from a URL is bounded by this service at 25 MB. A document sent inline
is bounded by the host, which rejects a request body above roughly 4.5 MB
before any of this code runs, leaving about 3 MB of PDF after base64. The
service refuses inline documents above 3 MB itself so the caller is told to
pass a URL rather than reading the host's own message about an entity it never
addressed. Results travel back inside the response and are subject to the same
ceiling, so a large document fetched by URL can still fail on the way out.

**P6. A narrow tool surface.** Only the tools the paperwork job needs. The local
product's 57 tools include local-only concepts (allowed directories, saved
profiles, Finder integration, viewer state) that are meaningless or misleading
here, and every extra tool is extra review surface for the host platform.

**P7. Honest naming.** Tool descriptions state that this runs on a server, that
nothing is stored, and that a visible signature stamp is not a cryptographic
signature. The local product's descriptions mention Claude, desktop paths and
Finder; those are wrong here and must not be copied over.

## What replaces the custody obligations

Removing storage removes most of July's threat model and introduces these:

**T1. Server-side request forgery.** `fetch_pdf_from_url` becomes a URL fetcher
that anyone on the internet can aim. It must refuse non-HTTP(S) schemes, refuse
private, loopback, link-local, multicast and unique-local address ranges after
DNS resolution, re-check after every redirect, cap redirects, and never return
response bodies for non-PDF content types.

**T2. Hostile documents.** Parsers are the attack surface. Caps from P5, plus
the existing subprocess boundary for pdf-lib and PDF.js work, plus a hard
refusal of encrypted documents in this profile, since password handling implies
a secret we promised not to take.

**T3. Free compute.** An unauthenticated endpoint is a public CPU. Per-IP rate
limits at the edge, small caps, fast failure, and a documented fair-use note.
If abuse outgrows that, the answer is an API key, which the directory form
already supports as an optional method.

**T4. Silent breakage of the honesty guarantees.** The local product refuses to
claim a form is complete when it cannot prove it. The remote surface keeps the
same refusals, including `validate_pdf`'s "safe claim unavailable" result and
the signature tool's requirement for a human intent statement passed through
verbatim.

**T5. Confusion with the local product.** Same name, different guarantees. The
documentation states plainly which surface stores nothing and which one works
on the user's own files, so nobody assumes the desktop extension is sending
documents to a server. It is not, and that must remain true.

## Tool surface, first cut

| Tool | Purpose |
|---|---|
| `fetch_pdf` | Fetch a PDF by URL under T1's guard, return its identity and page count |
| `read_form_fields` | Field names, types, current values |
| `render_page` | One page as a PNG so the agent can map coded field names to printed labels |
| `fill_form` | Fill named fields, return the filled document |
| `detect_signature_zones` | Typed zones with coordinates, as the local product does |
| `apply_signature` | Stamp a typed signature at a zone, with the verbatim human intent statement |
| `flatten` | Flatten form fields so the result cannot be edited further |
| `extract_text` | Page-numbered text with an explicit extraction status |

Saved profiles, saved signatures, viewer tools, Lumin e-sign, extraction
workspaces, and anything path-shaped stay local-only. A typed signature is
passed per call rather than stored.

## Gates before this is public

1. Every P and T above has a test that fails when the property is broken.
2. SSRF refusals are proven against private ranges, redirect chains to private
   ranges, and non-PDF content types.
3. A log audit shows no document-derived values in any emitted line.
4. Caps are enforced before allocation, proven with oversized inputs.
5. The documentation page states the storage, identity and signature
   properties in the same words used here.
6. The deployment is reproducible from the repository, and the endpoint's
   behavior matches the documented version.

Until all six pass, the endpoint stays unpublished and unsubmitted.
