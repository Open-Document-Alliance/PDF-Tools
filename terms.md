---
title: PDF Tools Terms of Service
description: Terms for the PDF Tools remote MCP endpoint and the desktop extension.
---

# Terms of Service

> **Draft for review.** Written by the maintainers to describe how the software
> actually behaves. It is not legal advice and has not been reviewed by counsel.
> Items in [BRACKETS] need a decision from Open Document Alliance before this is
> published.

**Effective date:** [DATE]
**Publisher:** [LEGAL ENTITY NAME], [ADDRESS].
**Contact:** [SUPPORT CONTACT EMAIL].

## 1. What these terms cover

The PDF Tools Remote MCP endpoint at [ENDPOINT URL] (the "Service"). The PDF
Tools source code is separately licensed under the MIT license, and nothing here
restricts your rights under that license. The desktop extension runs on your own
machine and is governed by the MIT license rather than by these terms.

## 2. The Service

The Service exposes PDF form tools over the Model Context Protocol so that an
agent with no access to your filesystem can read, fill, sign and flatten PDF
forms. It is free, requires no account, and processes one document per request
in memory without storing it. See the [privacy policy](privacy.md).

## 3. Your responsibilities

You are responsible for the documents you send and for having the right to send
them. Do not use the Service to process material you are not permitted to
process, to attempt to reach systems you do not control through the URL fetcher,
to attack or overload the Service, or to break applicable law.

You are responsible for checking the result. Automated form filling and field
mapping can be wrong.

## 4. Signatures

`apply_signature` draws a visible signature onto a page and records the signer
name, the time and the intent statement supplied with the call into the
document's metadata.

**This is not a legally binding electronic signature.** It is not cryptographic,
not certificate-backed and carries no identity verification. Do not rely on it
where a binding signature is required.

The intent statement and confirmation time must come from the person signing, in
their own words. An agent that fabricates them is misusing the Service, and
whoever operates that agent bears the consequences.

## 5. Fair use

The Service is unauthenticated and free, with published limits on document size,
page count and request duration. Keep automated use proportionate. We may rate
limit, block or require authentication in response to abuse, and we may change
limits at any time.

## 6. Availability

The Service is provided as is, with no uptime commitment. We may change, suspend
or discontinue it, ideally with notice in the repository, though we cannot
promise notice in every case.

## 7. No warranty

THE SERVICE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NON-INFRINGEMENT. We do not warrant that output is accurate,
complete or fit for any filing, submission or legal purpose.

## 8. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, [LEGAL ENTITY NAME] IS NOT LIABLE FOR
ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR EXEMPLARY DAMAGES, OR FOR
LOSS OF PROFITS, DATA OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE. OUR
TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE IS LIMITED TO [AMOUNT,
e.g. USD 100].

## 9. Indemnity

You agree to indemnify [LEGAL ENTITY NAME] against claims arising from documents
you send, from your use of output, and from your breach of these terms.

## 10. Governing law

These terms are governed by the laws of [JURISDICTION], and disputes are
resolved in the courts of [VENUE].

## 11. Changes

Material changes are announced in the repository and dated here. Continuing to
use the Service after a change means accepting the updated terms.
