---
title: PDF Tools Privacy Policy
description: What PDF Tools processes, what it keeps, and what it never sees.
---

# Privacy Policy

> **Draft for review.** Written by the maintainers to describe how the software
> actually behaves. It is not legal advice and has not been reviewed by counsel.
> Items in [BRACKETS] need a decision from Open Document Alliance before this is
> published.

**Effective date:** [DATE]
**Covers:** the PDF Tools desktop extension, and the PDF Tools Remote MCP
endpoint at [ENDPOINT URL].
**Publisher:** [LEGAL ENTITY NAME], [ADDRESS].
**Contact:** [PRIVACY CONTACT EMAIL].

## The short version

The desktop extension runs on your computer and sends your documents nowhere.
The remote endpoint processes one document per request in memory and keeps
nothing afterwards. Neither one requires an account, and neither one is used to
train any model.

## The desktop extension

The extension runs entirely on your own machine. It reads and writes only the
folders you have allowed it to reach. Saved profiles and signatures are stored
locally on your machine.

We do not receive your documents, your file paths, your profile data or your
signatures, and we operate no server that the extension talks to.

Two things are worth knowing:

1. **Your AI host sees what you ask it to see.** The extension returns document
   content to whichever application you are running it in, such as a desktop
   assistant. That application's own privacy terms govern what it does with that
   content.
2. **Optional signing hand-off.** If you choose to use the Lumin e-signature
   tools, the document and the recipient details you confirm are sent to Lumin at
   the moment you confirm, and Lumin's privacy terms govern that service.

## The remote MCP endpoint

### What is processed

The PDF you supply, either as a URL we fetch or as bytes you send inline, and
the arguments of the call, such as which fields to fill or where to place a
signature. If you sign, the name, the time and the sentence of intent you
provide are written into the document we hand back.

### What is kept

Nothing. Document bytes exist in memory for the length of one request. There is
no database, no file storage, no cache and no persistent link to a result. When
the response is sent, the data is gone.

### What is logged

Operational logs record the tool name, byte counts, durations and error
categories, which is what is needed to keep the service running. They do not
record document bytes, extracted text, field names, field values, filenames or
the URLs you supply.

Our hosting provider [HOSTING PROVIDER] records standard request metadata such
as IP address, timestamp and response status, retained for [RETENTION PERIOD]
under [PROVIDER]'s terms. We use it for abuse prevention and reliability.

### Accounts and identity

There are none. No sign-up, no API key, no session, no cookie. We cannot link
one request to another or to a person.

### Training

Documents sent to this service are not used to train, fine-tune or evaluate any
machine learning model, by us or by anyone else.

### Sharing

We do not sell, rent or share your documents. The only parties involved in a
request are you, [HOSTING PROVIDER] as our infrastructure provider, and the host
or agent you are using.

### Where processing happens

On [HOSTING PROVIDER] infrastructure in [REGION]. Because nothing is stored,
there is no data at rest to locate.

## Children

These tools are not directed at children under [AGE] and we do not knowingly
collect their information.

## Your rights

Because the remote service keeps nothing and identifies no one, there is nothing
to export, correct or delete after a request completes. If you believe we hold
information about you, write to [PRIVACY CONTACT EMAIL] and we will respond
within [DAYS] days.

## Security

The source is public and auditable. Report a vulnerability through the process
in [SECURITY.md](https://github.com/Open-Document-Alliance/PDF-Tools/blob/master/SECURITY.md)
rather than a public issue.

## Changes

Material changes are announced in the repository and dated here. Continuing to
use the tools after a change means accepting the updated policy.
