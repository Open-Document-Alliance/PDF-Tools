/**
 * Encrypted PDFs, in both directions: the size cap, the password rules, the
 * permission rules, the queue, the deadline, the re-protection contract, and
 * every message a caller can see.
 *
 * The QPDF runtime itself is not loaded here. It runs in a worker thread —
 * `server/qpdf-decrypt-worker.js`, the only module in the tree that loads it —
 * which this module starts, drives, bounds and destroys. See that file for why
 * the work cannot run on the calling thread; see below for what this module
 * decides.
 *
 * pdf-lib 1.17.1 cannot decrypt anything, so every tool that goes through it
 * fails on an encrypted document no matter what password the caller supplies.
 * This module is the way through, for two groups of tools with two different
 * rules:
 *
 *   - the read-only tools `read_pdf_fields`, `validate_pdf` and
 *     `extract_to_csv`, which never write a PDF back; and
 *   - the mutation tools in `ENCRYPTED_WRITE_OPERATIONS`, which do, and which
 *     therefore also have to put the document's protection back afterwards.
 *
 * ## What this deliberately does not do
 *
 * It is not a "remove the password" facility, and there is no parameter that
 * turns it into one. QPDF will decrypt an owner-locked document — one that
 * opens with an empty user password but whose `/P` denies modification —
 * without any password at all, and will re-lock it afterwards with an
 * identical `/P` and `/R`. Shipping *that* shape would make PDF Tools a
 * permissions-circumvention tool, so no tool here removes, weakens or reveals
 * a document's protection, and a document that arrives encrypted leaves
 * encrypted or does not leave at all.
 *
 * The empty string counts as *no password*, so nothing that turns on whether a
 * credential was supplied can be sidestepped by passing `""` to a document
 * whose user password is empty.
 *
 * The permission rule is evaluated here, between the worker's two phases. The
 * worker reports what the document says about itself and then waits; it is told
 * to decrypt only after this module has decided that it may. A refusal is
 * therefore a refusal to do the work, not a decision to throw the result away.
 *
 * ## THE PERMISSION RULE
 *
 * `pdfPermissionRefusal` is the whole of it, and it is the only function in
 * this tree that reads `encryption.capabilities`. In one sentence:
 *
 *   **`/P` governs writes. It does not govern reads.**
 *
 * A *write* may not proceed against a `/P` that denies the change it makes,
 * unless the caller authenticated as owner. A *read* proceeds on a credential
 * alone: whoever can open the document may read it, and a document that opens
 * with an empty user password opens for everybody.
 *
 * The write half is unremarkable and is the same rule Acrobat applies. A
 * document whose `/P` says `modify: not allowed` is making an explicit
 * statement about what may be done to it, and the owner password is precisely
 * the credential that exists to authorise overriding that statement, so a
 * *user* password does not satisfy a permission the document denies. Note that
 * QPDF keeps reporting a document's declared capabilities as denied even when
 * the owner password matched, so the owner check is made against
 * `ownerPasswordMatched` rather than read out of the capabilities.
 *
 * The read half is the part that needs the argument, because an earlier
 * revision of this module did require `extract` (`/P` bit 5) for the three
 * read-only tools, and that requirement has been removed. Four reasons, in
 * descending order of how much they decide it.
 *
 * **1. A read gate cannot be made uniform without refusing to show the user
 * their own document.** `/P` is only consulted where QPDF is, and QPDF is only
 * reached from `loadEncryptedPdfBytes`. Everything else that reads a PDF here
 * goes through PDF.js, which does not implement `/P` at all — measured, not
 * assumed: on an owner-locked AES-256 document with `--extract=n`,
 * `read_pdf_content` returned 33,173 characters while `read_pdf_fields`
 * refused. Closing that would mean gating `read_pdf_content`,
 * `read_pdf_pages`, `search_pdf_text`, `read_pdf_layout`,
 * `convert_pdf_to_markdown`, `get_pdf_info`, `render_pdf_page` and
 * `render_pdf_region` — and, because each of these hands over strictly more
 * than any of them, also `read_pdf_bytes`, `get_pdf_resource_uri` and
 * `display_pdf`. The last three are "give the host the file" and "show it to
 * the user in the viewer". Refusing those is not a permission model, it is a
 * refusal to be a PDF reader, and no reader on the market does it: Acrobat,
 * Preview and Chrome all display owner-locked documents and grey out *Copy*.
 * We have no Copy menu to grey out. Every tool here *is* the copy operation,
 * so the reader convention has no analogue on this side except "refuse to
 * function". A rule that cannot be applied to the whole family is not a rule,
 * it is an inconsistency with a good conscience.
 *
 * **2. The accessibility bit makes the extract bit unenforceable on any
 * modern document.** `/P` bit 10 authorises extraction for assistive
 * technology, and ISO 32000-2 deprecated it and requires it set. That is not
 * theory: QPDF cannot produce a counterexample. `--extract=n --accessibility=n`
 * yields `accessibility: true, extract: false` at both R4 (AES-128) and R6
 * (AES-256); only legacy R3 RC4 can deny it. So on every document produced this
 * decade, an owner who denies `extract` has unavoidably granted extraction for
 * accessibility in the same breath. Honour that carve-out and an extract gate
 * is a no-op on AES; ignore it and we are stricter than the format's own
 * authors, against a caller — a language model reading a document so it can
 * answer its owner's questions about it — which is far closer to assistive
 * technology than to copy-paste. There is no reading of bit 5 here that both
 * bites and is defensible.
 *
 * **3. `/P` is a statement to a reader's user interface, not an access
 * control.** It is defeated by the empty user password the document itself
 * ships with, and it survives only where a reader volunteers to honour it. Two
 * of the three PDF libraries this product is built on decline: PDF.js does not
 * implement it, and QPDF decrypts owner-locked documents with no password at
 * all — this repository's own test fixtures depend on that. Adopting a rule our
 * own dependencies refuse to implement would put it in exactly one place, ours,
 * where it is easiest to route around.
 *
 * **4. What was actually protected was a rounding error.** The gate could only
 * ever apply to a document that is encrypted *and* opens without a password
 * *and* sets `extract=n`. An unencrypted confidential document has no `/P` and
 * got nothing. Within that slice, nine sibling tools returned the same content
 * anyway, measured through the real server. The measured protective value was
 * zero; the cost was a refusal a user
 * answers with one `qpdf --decrypt`, having learned that the honest path is the
 * slow one.
 *
 * The write gate keeps none of these problems, which is why it stays. It is
 * *complete*: there is no sibling tool that writes a PDF without going through
 * `decryptPdfForWrite`, so nothing routes around it. It is *enforceable*: we
 * are the party producing the bytes, and refusing to produce them ends the
 * matter. And it is *meaningful*: it is the difference between reading a
 * document and altering someone else's, which is the line `/P` was actually
 * written to draw.
 *
 * None of this loosens the credential rules. A document with a real user
 * password still cannot be read without one, a wrong password is still a wrong
 * password, and `""` is still not a credential.
 *
 * ## Protection in, protection out
 *
 * A write path never changes a document's protection. After pdf-lib has
 * produced the modified bytes, `reprotectPdfAfterWrite` restores the original
 * `/Encrypt` with QPDF's `--copy-encryption`, which reproduces `/O`, `/OE`,
 * `/U`, `/UE`, `/P`, `/R`, `/V`, `/ID` and the crypt filters verbatim —
 * including an owner password nothing here ever learned. The result is then
 * compared against the source's own protection, digest of the literal
 * `/Encrypt` dictionary included, before the bytes are allowed anywhere near
 * disk. Silent protection change is the failure this path exists to prevent,
 * so it is asserted against rather than assumed away.
 *
 * There is deliberately no fallback. A document that cannot be faithfully
 * re-protected fails the operation and writes nothing; an encrypted input
 * yields an encrypted output or no output at all.
 *
 * ## Which permission bit
 *
 * Only the write side has a mapping, because only the write side consults
 * `/P`. Each mutation requires the bit that matches what it actually does to
 * the file; see `ENCRYPTED_WRITE_OPERATIONS` for the mapping and why each one
 * is what it is.
 *
 * `ENCRYPTED_READ_OPERATIONS` carries no bit. It is still a security boundary,
 * and adding an entry to it is still a security decision — it names the
 * operations allowed to reach QPDF at all — but what it grants is decryption
 * subject to a credential, not decryption subject to `/P`.
 *
 * ## Memory
 *
 * QPDF-WASM costs roughly 16x the input size plus a ~45 MB baseline, which is
 * why encrypted inputs get their own explicit, much lower size cap
 * (`PDF_ENCRYPTED_MAX_FILE_BYTES`) instead of the 250 MiB mutation cap. See the
 * constant for those measurements.
 *
 * Isolation was expected to improve on that, on the theory that a heap dying
 * with its thread would be returned where an in-process collection was not. It
 * does not, and the measurements say so plainly. On macOS/arm64, after a single
 * 14.6 MiB decrypt and a forced-GC settle:
 *
 *   | arrangement | peak RSS | settled RSS | retained over baseline |
 *   | ----------- | -------: | ----------: | ---------------------: |
 *   | in-process  |   333 MB |      243 MB |                 188 MB |
 *   | worker      |   315 MB |      315 MB |                 260 MB |
 *
 * Destroying the thread returns *less* than collecting the module did: the
 * freed pages stay mapped in the process, so `terminate()` buys nothing here
 * and costs about 70 MB of resting RSS. What neither arrangement does is
 * accumulate — eight consecutive near-cap decrypts plateau at 373 MB
 * in-process and 352 MB in workers rather than summing, because each new
 * worker reuses the pages the last one released. So the per-file cap remains
 * sufficient and `extract_to_csv` still needs no aggregate bound.
 *
 * The deadline is what isolation actually buys. The memory column is a cost,
 * and a small one against the 1024 MiB budget, but it is not a saving and must
 * not be read as one; see the size constant.
 *
 * ## Plaintext handling
 *
 * Decrypted bytes exist only in memory and are never written to disk. They also
 * never leave the process that asked for them: the worker is a thread, and the
 * plaintext reaches this module through `postMessage`'s transfer list, which
 * moves ownership of the same pages rather than serializing them. Nothing is
 * copied, piped, or staged to a file.
 *
 * This module runs in two hosts, and the property holds in both. For a read it
 * runs in the server process. For a mutation it runs inside the isolated
 * pdf-lib child, which is where the decrypt/mutate/re-protect sequence has to
 * live: that child stages its output to a file on disk, so protection must be
 * restored before staging, which puts QPDF in the child — and once QPDF is
 * there, decrypting there too means the plaintext never crosses a process
 * boundary either. Passing plaintext from the server to the child would have
 * given up exactly the property this design was built to keep.
 *
 * The caller gets a `release()` and must call it once it has finished reading
 * the loaded document. Be honest about what that buys: `release()` overwrites
 * the Node buffer it handed out, but JavaScript cannot guarantee erasure. The
 * garbage collector may already have copied the buffer, and any of those pages
 * may have been written to swap. This reduces the window in which plaintext is
 * readable in the process; it does not eliminate it. The WebAssembly heap's own
 * copies are a smaller problem than they were, because the thread holding them
 * is destroyed at the end of every request.
 */

import { Worker } from "node:worker_threads";

/**
 * The per-file ceiling for an encrypted input, deliberately separate from and
 * far below `PDF_MUTATION_MAX_FILE_BYTES` (250 MiB), which must not govern
 * this path.
 *
 * Measured against this runtime on macOS/arm64, decrypting costs a peak RSS of
 * roughly `16 x input + 45 MB`:
 *
 *   |  input | peak RSS delta |
 *   | -----: | -------------: |
 *   | 1.0 MB |          52 MB |
 *   | 7.3 MB |         162 MB |
 *   | 14.6MB |         272 MB |
 *   | 29.2MB |         472 MB |
 *
 * At 16 MiB the decrypt peak is about 300 MB, and the plaintext then has to be
 * parsed by pdf-lib on top of that, landing the whole read comfortably inside
 * the 1024 MiB that `PDF_LIB_RSS_MAXIMUM_BYTES` already treats as the point
 * where a PDF operation has consumed too much. Doubling the cap to 32 MiB
 * would put the decrypt alone near 560 MB and the full read past 700 MB, with
 * no useful margin; that is the reason for the specific number rather than a
 * rounder, larger one.
 *
 * Isolation did not change any of that, and specifically did not earn a larger
 * number. The peak of a single decrypt is what this cap is derived from, and
 * the measurements in the module header put the worker's peak at 315 MB against
 * 333 MB in-process — a few percent, not a factor. Repeated decryption still
 * plateaus rather than accumulating, so `extract_to_csv` still needs no
 * aggregate bound, but that was true before as well. Raising the cap would
 * raise the peak against the same 1024 MiB budget, with nothing new to pay for
 * it.
 */
export const PDF_ENCRYPTED_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The wall-clock ceiling on one decryption, enforced by destroying the worker
 * thread that is running it.
 *
 * The size cap bounds input bytes; it does not bound work. QPDF's cost tracks
 * the number of objects in a document, and object count is nearly free per
 * byte: a 14.3 MiB encrypted file built from 800,000 tiny indirect objects —
 * inside the cap — takes over five seconds, and there is no honest reason to
 * believe five seconds is the worst a 16 MiB document can do.
 *
 * 30 seconds matches `DEFAULT_TIMEOUT_MS` in `server/pdf-lib-subprocess.js`,
 * which is the number this codebase already uses for "a PDF operation that has
 * not finished by now is not going to". It is generous against measurement —
 * the slowest legitimate near-cap decrypt observed is 1.6 seconds, and the
 * slowest constructed one 5.7 — and it can afford to be, because a decryption
 * that runs long no longer blocks anything. The server's own thread is free the
 * whole time; the deadline bounds how long a hostile document may occupy a
 * queue slot and a CPU, not how long the server is unresponsive.
 */
export const PDF_DECRYPTION_TIMEOUT_MS = 30_000;

/**
 * The operations allowed to decrypt for a read. Adding an entry here is a
 * security decision: it grants a tool the ability to read encrypted documents.
 *
 * There is deliberately no `capability` column. A read is authorised by a
 * credential, never by `/P` — see THE PERMISSION RULE in the module header for
 * why, and `pdfPermissionRefusal` for the code that says so. `activity` is the
 * human description of what the grant buys, and exists so this table can be
 * reviewed for what it actually permits rather than for what its keys suggest.
 */
export const ENCRYPTED_READ_OPERATIONS = Object.freeze({
  read_pdf_fields: Object.freeze({
    activity: "read its form fields and their values",
  }),
  validate_pdf: Object.freeze({
    activity: "report which of its form fields are filled",
  }),
  extract_to_csv: Object.freeze({
    activity: "extract its form data to a CSV file",
  }),
});

/**
 * The mutations allowed to decrypt, and the `/P` capabilities each one needs.
 *
 * Adding an entry here grants a tool the ability to rewrite an encrypted
 * document, so each mapping is justified against what the operation actually
 * does to the file rather than against what its name suggests.
 *
 *   - Filling a form is `modifyforms` — `/P` bit 9, "fill in existing
 *     interactive form fields". Not `modify`: a document written with
 *     `--modify=form` permits form filling while denying general modification,
 *     and requiring `modify` would refuse work its owner explicitly allowed.
 *
 *   - Page manipulation is `modifyassembly` — `/P` bit 11, "assemble the
 *     document (insert, rotate, or delete pages)". That is exactly what these
 *     operations do, and a document written with `--modify=assembly` permits it
 *     while denying everything else.
 *
 *   - Stamping is `modify` — `/P` bit 4, "modify the contents of the
 *     document". Deliberately *not* `modifyannotations` (bit 6). These tools
 *     draw into the page content stream with pdf-lib's `drawRectangle`,
 *     `drawText` and `drawImage`; none of them creates an annotation object or
 *     touches `/Annots`. A document written with `--modify=annotate` denies
 *     `modify` while permitting `modifyannotations`, and accepting the
 *     annotation bit here would let PDF Tools burn content into a page whose
 *     owner allowed only commenting.
 *
 *   - `prepare_signing_packet` both fills fields and draws boxes, so it needs
 *     both capabilities and is refused if either is denied.
 */
export const ENCRYPTED_WRITE_OPERATIONS = Object.freeze({
  fill_pdf: Object.freeze({
    capabilities: Object.freeze(["modifyforms"]),
    activity: "fill in its form fields",
  }),
  fill_with_profile: Object.freeze({
    capabilities: Object.freeze(["modifyforms"]),
    activity: "fill in its form fields from a profile",
  }),
  bulk_fill_from_csv: Object.freeze({
    capabilities: Object.freeze(["modifyforms"]),
    activity: "fill in its form fields from a CSV file",
  }),
  apply_page_plan: Object.freeze({
    capabilities: Object.freeze(["modifyassembly"]),
    activity: "reorder, rotate or delete its pages",
  }),
  merge_pdfs: Object.freeze({
    capabilities: Object.freeze(["modifyassembly"]),
    activity: "merge it with other documents",
  }),
  split_pdf: Object.freeze({
    capabilities: Object.freeze(["modifyassembly"]),
    activity: "split it into separate documents",
  }),
  rotate_pdf_pages: Object.freeze({
    capabilities: Object.freeze(["modifyassembly"]),
    activity: "rotate its pages",
  }),
  reorder_pdf_pages: Object.freeze({
    capabilities: Object.freeze(["modifyassembly"]),
    activity: "reorder its pages",
  }),
  add_signature_field: Object.freeze({
    capabilities: Object.freeze(["modify"]),
    activity: "draw a signature placeholder onto a page",
  }),
  apply_signature: Object.freeze({
    capabilities: Object.freeze(["modify"]),
    activity: "stamp a signature onto a page",
  }),
  apply_text: Object.freeze({
    capabilities: Object.freeze(["modify"]),
    activity: "stamp text onto a page",
  }),
  prepare_signing_packet: Object.freeze({
    capabilities: Object.freeze(["modify", "modifyforms"]),
    activity: "fill in its form fields and draw signature placeholders onto its pages",
  }),
});

/**
 * Human-readable names for the `/P` capabilities this module can require.
 *
 * `extract` is deliberately absent: it is not required by any operation, and
 * listing a label for it would leave a ready-made slot for a read gate to be
 * reintroduced without anyone re-reading THE PERMISSION RULE.
 */
const CAPABILITY_LABELS = Object.freeze({
  modify: "modifying the document's contents",
  modifyforms: "filling in form fields",
  modifyassembly: "assembling the document's pages",
});

export const PDF_ENCRYPTED_FILE_LIMIT_MESSAGE =
  `Encrypted PDF exceeds the ${PDF_ENCRYPTED_MAX_FILE_BYTES / (1024 * 1024)} MiB limit for `
  + "decryption. Decrypting a PDF costs about 16 times its size in memory, so encrypted inputs "
  + "have a lower size limit than unencrypted ones. Decrypt the file first (for example with "
  + "qpdf) and retry with the decrypted copy.";

export const PDF_PASSWORD_REJECTED_MESSAGE =
  "The password was not accepted: this PDF is encrypted, and the supplied password matches "
  + "neither its user password nor its owner password. Check the password and retry.";

export const PDF_PASSWORD_REQUIRED_MESSAGE =
  "This PDF is encrypted and cannot be opened without a password. Supply the document's "
  + "password in the private window opened by unlock_pdf and retry. Never put passwords in chat or tool arguments.";

export const PDF_PASSWORD_UNREPRESENTABLE_MESSAGE =
  "This password cannot be used: it contains a line break. Passwords are handed to the decryption "
  + "engine through a single-line password file, never on a command line, so a password containing "
  + "a carriage return or newline cannot be represented. Remove the line break and retry.";

export const PDF_DECRYPTION_FAILED_MESSAGE =
  "This PDF is encrypted and could not be decrypted: the document is malformed, incomplete, or "
  + "uses an encryption scheme this build does not support.";

export const PDF_DECRYPTION_TIMEOUT_MESSAGE =
  `Decrypting this PDF did not finish within ${PDF_DECRYPTION_TIMEOUT_MS / 1000} seconds and was `
  + "stopped. How long decryption takes depends on how many objects a document contains rather "
  + "than on how large it is, so a small file can still exceed the limit. Decrypt the file first "
  + "(for example with qpdf) and retry with the decrypted copy.";

export const PDF_REPROTECT_FAILED_MESSAGE =
  "This PDF is encrypted and its protection could not be restored to the modified copy, so "
  + "nothing was written. PDF Tools re-applies the document's own encryption after a change and "
  + "never writes an unprotected copy of a protected document. This can happen when a document "
  + "uses a protection scheme this build cannot reproduce, such as public-key (certificate) "
  + "security. Decrypt the file first (for example with qpdf), make the change, and re-protect it "
  + "yourself.";

export const PDF_REPROTECT_TIMEOUT_MESSAGE =
  `Restoring this PDF's protection after the change did not finish within `
  + `${PDF_DECRYPTION_TIMEOUT_MS / 1000} seconds and was stopped, so nothing was written. How long `
  + "this takes depends on how many objects a document contains rather than on how large it is, so "
  + "a small file can still exceed the limit.";

export const PDF_REPROTECT_CHANGED_MESSAGE =
  "This PDF is encrypted and the modified copy did not come back with exactly the protection the "
  + "original had, so nothing was written. PDF Tools verifies that a document's permissions and "
  + "encryption are unchanged before saving it, and refuses rather than write a document whose "
  + "security differs from the original's.";

/*
 * The refusal a caller sees when a merge's sources are not one protection.
 *
 * The rule itself is not negotiable — see `mergeProtectionRefusal` — so the
 * whole job of this text is to leave the caller with something they can
 * actually do. It names both routes that work, and it names the trap, because
 * the obvious reading of "the same encryption" is "the same password" and that
 * is not enough: `/Encrypt` stores `/O` and `/U`, which are derived from
 * material that is fresh per encryption run — a random salt at `/R` 6, the
 * document's own `/ID` at `/R` 4 and below — so two documents encrypted in two
 * separate qpdf runs with one password still carry two different protections.
 * A caller who is not told that will hit it, retry with the same password, and
 * get the same refusal.
 */
export const PDF_MERGE_MIXED_ENCRYPTION_MESSAGE =
  "These PDFs cannot be merged: they are not all protected the same way, so there is no single "
  + "protection the merged document could carry. PDF Tools gives a merged document the encryption "
  + "its sources share, and will not choose one source's protection over another's or drop it. "
  + "Two routes work. Either merge sources whose /Encrypt dictionary is byte-identical — copies of "
  + "one protected document, or pieces of one protected document, such as the parts split_pdf "
  + "produces, which keep that document's exact encryption. Or decrypt every source first (for "
  + "example with qpdf), merge the unprotected copies, and protect the merged file yourself. "
  + "Encrypting each source separately with the same password is not enough: every encryption run "
  + "mixes in fresh material — a random salt at /R 6, and the document's own /ID at /R 4 and "
  + "below — so the stored /O and /U values differ even when the password you typed was identical.";

/**
 * Refusal text for a mutation the document's own `/P` denies.
 *
 * Unlike the read path, holding the *user* password is not enough here: a
 * document that says `modify: not allowed` is making an explicit statement, and
 * the owner password is the credential that exists to authorise overriding it.
 * The message therefore names the denied permission and says plainly which
 * credential would authorise the work — without ever suggesting a way around
 * the restriction.
 */
export function pdfWritePermissionDeniedMessage(operation, deniedCapabilities) {
  const { activity } = ENCRYPTED_WRITE_OPERATIONS[operation];
  const named = deniedCapabilities
    .map(capability => `${CAPABILITY_LABELS[capability]} (/P '${capability}')`)
    .join(" and ");
  return `This PDF is encrypted and its permissions deny ${named}, so PDF Tools will not `
    + `${activity}. Supplying the user password proves you may open the document, but not that you `
    + "may override a restriction its owner set. If you hold the owner password, enter it in the "
    + "private window opened by unlock_pdf and retry; that is the credential which authorises this change.";
}

/**
 * Parameter text for the tools that can now decrypt, mutate and re-protect.
 * These carried the "accepted but never used" text until they could actually
 * use a password; nothing advertises that text any more.
 */
export const PDF_REPROTECTING_PASSWORD_DESCRIPTION =
  "Password for an encrypted PDF. Supply the user or owner password and the document is decrypted "
  + `in memory, changed, and then saved with exactly the encryption and permissions it already had `
  + `(encrypted inputs are limited to ${PDF_ENCRYPTED_MAX_FILE_BYTES / (1024 * 1024)} MiB). The `
  + "protection is never removed, changed, or added by this tool. Leave it unset for an "
  + "unencrypted document. If the document's own permissions deny the change being made, the owner "
  + "password is required, because that is the credential which authorises overriding them.";

/**
 * Parameter text for the three read-only tools that can decrypt. They too
 * once advertised a password they could not use.
 *
 * It no longer carries the "only if its own permissions allow content
 * extraction" caveat, because that is no longer true and was never true of the
 * sibling read tools it sat beside. See THE PERMISSION RULE in the module
 * header.
 */
export const PDF_DECRYPTABLE_PASSWORD_DESCRIPTION =
  "Password for an encrypted PDF. Supply the user or owner password and the document is "
  + `decrypted in memory to complete this read (encrypted inputs are limited to `
  + `${PDF_ENCRYPTED_MAX_FILE_BYTES / (1024 * 1024)} MiB). Leave it unset for an unencrypted `
  + "document, or for an encrypted one that opens without a password. A document that needs a "
  + "password cannot be read without it, and this tool never removes or weakens a document's "
  + "protection.";

/**
 * The deadline one request runs under.
 *
 * `timeoutMs` exists for tests, which need to watch the deadline fire without
 * waiting out the real one. It can only ever tighten: anything larger than
 * `PDF_DECRYPTION_TIMEOUT_MS`, and anything that is not a usable positive
 * number, collapses to the product's own limit. There is deliberately no way
 * to grant a document more time than the product allows.
 */
export function resolveDecryptionDeadlineMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, PDF_DECRYPTION_TIMEOUT_MS)
    : PDF_DECRYPTION_TIMEOUT_MS;
}

export class PdfDecryptionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "PdfDecryptionError";
    this.reason = reason;
  }
}

/**
 * A password is "supplied" only if it is a non-empty string.
 *
 * The empty string is treated as absent because it is exactly the credential
 * an owner-locked document accepts: counting it as "supplied" would let any
 * caller claim credentialed access to a document whose user password is empty
 * and skip the `/P` check entirely.
 *
 * Whitespace is *not* trimmed. A password of `" "` is unusual but legitimate,
 * and it needs no special handling to be safe: it is not the empty password,
 * so QPDF rejects it on a document that expects one, and the caller gets an
 * honest "not accepted" instead of a silent permission check.
 */
export function normalizeSuppliedPassword(password) {
  if (password === null || password === undefined) return null;
  if (typeof password !== "string") {
    throw new TypeError("PDF password must be a string.");
  }
  return password === "" ? null : password;
}

const DECRYPTION_WORKER_URL = new URL("./qpdf-decrypt-worker.js", import.meta.url);

let qpdfRuntimeReached = false;
const activeDecryptionWorkers = new Set();

/**
 * Whether this process has ever started a decryption worker, and so has ever
 * reached the QPDF runtime. Exists so the "an unencrypted document pays
 * nothing" property can be asserted as a fact rather than as a claim in a
 * comment. It exposes no capability.
 *
 * It is now a stronger fact than it was. The runtime is not merely unloaded
 * until something is decrypted; the module that loads it is not on the server's
 * import graph at all, and only ever runs on another thread.
 */
export function isQpdfRuntimeLoaded() {
  return qpdfRuntimeReached;
}

/**
 * Destroys every decryption worker that is still running. Called from the
 * server's signal handlers: a worker thread keeps the process alive, and a
 * decryption that has just started should not hold a shutdown open for the
 * length of its deadline.
 */
export function terminateAllDecryptionWorkers() {
  return Promise.all([...activeDecryptionWorkers].map(async worker => {
    try {
      await worker.terminate();
    } catch {
      // Already gone.
    }
  }));
}

/**
 * The same, without waiting — for the `exit` handler, where nothing
 * asynchronous can still run.
 */
export function forceTerminateAllDecryptionWorkers() {
  for (const worker of activeDecryptionWorkers) {
    try {
      void worker.terminate();
    } catch {
      // Already gone.
    }
  }
}

/*
 * Decryptions run one at a time.
 *
 * The size cap is derived from the peak cost of a *single* decrypt. The MCP
 * server does not serialize tool calls, so without this two concurrent
 * encrypted reads would each be allowed 16 MiB and the budget the cap was
 * calculated against would be wrong by a factor of the concurrency. Queueing
 * makes the measured single-operation peak the real ceiling no matter how many
 * callers arrive at once, and it bounds the number of live worker threads to
 * one along with it.
 *
 * A queued caller waits rather than fails: at the cap a decrypt is on the order
 * of a second, which is a far better outcome than an out-of-memory kill that
 * takes the whole server down. The queue never rejects, so one failing
 * operation cannot poison the chain for the next. The deadline below is what
 * stops a hostile document from holding the queue indefinitely.
 *
 * The queue is held until the worker thread is *gone*, not until the caller has
 * its answer. Those are different moments on the success path: the plaintext
 * has already been transferred out, so the caller has no stake in the teardown,
 * while the invariant that matters — one QPDF heap alive at a time — is exactly
 * what the queue is for. Destroying a worker holding a decrypted document costs
 * a measured 55-60 ms, and settling first takes that off the critical path of
 * an idle-queue request. Back-to-back requests still pay it, in the queue,
 * which is the correct place for it.
 *
 * A `run` here returns `{ outcome, teardown }`; `outcome` is what the caller
 * gets, `teardown` is what the next caller waits on. A `run` that throws before
 * a worker exists (the size cap, an unusable password) has neither, and simply
 * rejects.
 */
let decryptionQueue = Promise.resolve();

function queueDecryption(run) {
  const started = decryptionQueue.then(run, run);
  decryptionQueue = started
    .then(result => result?.teardown, () => {})
    .then(() => {}, () => {});
  return started.then(result => result.outcome);
}

/**
 * Turns a worker reason code into the caller-visible failure. The worker never
 * composes a message: QPDF prefixes its diagnostics with `argv[0]` and echoes
 * the virtual input path, so every failure maps to one of this module's own
 * fixed strings here.
 *
 * `password_not_accepted` is the one code that splits, and it splits on
 * something only this side knows: whether the caller supplied a password at
 * all. The same QPDF failure means "you need a password" to one caller and
 * "that password is wrong" to another.
 */
function workerFailure(reason, suppliedPassword) {
  if (reason === "password_not_accepted") {
    return suppliedPassword === null
      ? new PdfDecryptionError("password_required", PDF_PASSWORD_REQUIRED_MESSAGE)
      : new PdfDecryptionError("password_rejected", PDF_PASSWORD_REJECTED_MESSAGE);
  }
  if (reason === "password_unrepresentable") {
    return new PdfDecryptionError(reason, PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }
  // Every remaining code — unreadable_document, malformed_inspection,
  // decrypt_failed, qpdf_faulted, qpdf_output_overflow, runtime_unavailable,
  // protocol_violation — is a "this document did not decrypt" for the caller,
  // and stays distinguishable only in `reason`.
  return new PdfDecryptionError(
    typeof reason === "string" && reason.length > 0 ? reason : "qpdf_faulted",
    PDF_DECRYPTION_FAILED_MESSAGE,
  );
}

/**
 * Runs one document through one worker thread, under one deadline.
 *
 * The worker is destroyed on every exit path, success included. That is not
 * tidiness: `worker.terminate()` is the only mechanism that stops a synchronous
 * QPDF invocation already in flight, and it is why the work is out here at all.
 *
 * Returns `{ outcome, teardown }`. A *failure* is not reported until the thread
 * is actually dead, because "the deadline stopped this" has to mean it stopped;
 * a *success* is reported as soon as the plaintext has arrived, because by then
 * the thread holds nothing anyone is waiting for. `teardown` resolves once the
 * worker is gone either way, and is what the queue holds.
 */
/**
 * The lifecycle every QPDF request shares: one worker, one deadline, and
 * destruction on every exit path including success.
 *
 * `handleMessage` receives each worker message and the `settle` that ends the
 * request; everything mode-specific lives there. The lifecycle itself — when
 * the thread dies, when a failure may be reported, what the queue waits on —
 * is identical for a decryption and a re-protection and is written once.
 *
 * Returns `{ outcome, teardown }`. A *failure* is not reported until the thread
 * is actually dead, because "the deadline stopped this" has to mean it stopped;
 * a *success* is reported as soon as its payload has arrived, because by then
 * the thread holds nothing anyone is waiting for. `teardown` resolves once the
 * worker is gone either way, and is what the queue holds.
 */
function runBoundedQpdfWorker({ workerData, transferList, timeoutMs, timeoutError, handleMessage }) {
  let markTornDown;
  const teardown = new Promise(resolveTeardown => { markTornDown = resolveTeardown; });
  const outcome = new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(DECRYPTION_WORKER_URL, { workerData, transferList });
    } catch {
      markTornDown();
      reject(new PdfDecryptionError("worker_unavailable", PDF_DECRYPTION_FAILED_MESSAGE));
      return;
    }
    qpdfRuntimeReached = true;
    activeDecryptionWorkers.add(worker);

    let settled = false;
    let deadline = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      // A success is handed over now: the payload is already in this thread's
      // memory and the worker's own copy was detached when it was transferred.
      if (!error) resolve(value);
      const done = () => {
        activeDecryptionWorkers.delete(worker);
        // A failure waits: a timeout in particular must not be reported while
        // the thread it is about is still running.
        if (error) reject(error);
        markTornDown();
      };
      let termination = null;
      try {
        termination = worker.terminate();
      } catch {
        termination = null;
      }
      if (termination && typeof termination.then === "function") termination.then(done, done);
      else done();
    };

    worker.on("message", message => handleMessage(message, settle, worker));
    worker.once("messageerror", () => {
      settle(new PdfDecryptionError("protocol_violation", PDF_DECRYPTION_FAILED_MESSAGE));
    });
    worker.once("error", () => {
      settle(new PdfDecryptionError("worker_faulted", PDF_DECRYPTION_FAILED_MESSAGE));
    });
    worker.once("exit", () => {
      // Only reachable when the thread died without reporting: an
      // out-of-memory abort, or a fault the worker's own handler could not
      // survive. A settled request has already terminated it.
      settle(new PdfDecryptionError("worker_exited", PDF_DECRYPTION_FAILED_MESSAGE));
    });

    deadline = setTimeout(() => settle(timeoutError()), timeoutMs);
    // The deadline must not be a reason for the process to stay alive; the
    // worker it is guarding already is one.
    deadline.unref();
  });
  return { outcome, teardown };
}

/**
 * An exact copy of caller-owned bytes, safe to transfer.
 *
 * The caller's buffer is the file as it is on disk or a document another part
 * of the process still holds, so its backing store must not be detached; and a
 * Node Buffer may be a window onto a shared pool, which must not be handed to
 * another thread whatever the intent.
 */
function transferableCopy(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Runs one document through one worker thread, under one deadline.
 *
 * The worker is destroyed on every exit path, success included. That is not
 * tidiness: `worker.terminate()` is the only mechanism that stops a synchronous
 * QPDF invocation already in flight, and it is why the work is out here at all.
 */
function runDecryptionWorker(pdfBytes, suppliedPassword, permit, timeoutMs) {
  const ciphertext = transferableCopy(pdfBytes);
  // Retained from the inspection phase: it is what the permission rules were
  // applied to, and the caller is entitled to see the same facts.
  let inspectedEncryption = null;
  return runBoundedQpdfWorker({
    workerData: { mode: "decrypt", ciphertext: ciphertext.buffer, password: suppliedPassword },
    transferList: [ciphertext.buffer],
    timeoutMs,
    timeoutError: () => new PdfDecryptionError("decrypt_timeout", PDF_DECRYPTION_TIMEOUT_MESSAGE),
    handleMessage(message, settle, worker) {
      if (message?.kind === "inspected") {
        const { encryption } = message;
        if (!encryption?.encrypted) {
          // pdf-lib refused this document as encrypted but QPDF sees no
          // encryption dictionary. The two disagree about what the file is, so
          // decrypting it would be guessing.
          settle(new PdfDecryptionError(
            "encryption_state_disagreement",
            PDF_DECRYPTION_FAILED_MESSAGE,
          ));
          return;
        }
        const refusal = permit(encryption);
        if (refusal) {
          settle(refusal);
          return;
        }
        inspectedEncryption = encryption;
        try {
          worker.postMessage({ kind: "decrypt" });
        } catch {
          settle(new PdfDecryptionError("qpdf_faulted", PDF_DECRYPTION_FAILED_MESSAGE));
        }
        return;
      }
      if (message?.kind === "decrypted") {
        // A view onto the transferred pages. No copy was made crossing the
        // boundary and none is made here.
        const plaintext = Buffer.from(message.plaintext);
        if (plaintext.length === 0) {
          settle(new PdfDecryptionError("decrypt_failed", PDF_DECRYPTION_FAILED_MESSAGE));
          return;
        }
        let released = false;
        settle(null, {
          plaintext,
          encryption: inspectedEncryption,
          release() {
            if (released) return;
            released = true;
            // See the module header: this shortens the window in which
            // plaintext is readable in this process. It cannot guarantee
            // erasure.
            plaintext.fill(0);
          },
        });
        return;
      }
      if (message?.kind === "failed") {
        settle(workerFailure(message.reason, suppliedPassword));
        return;
      }
      settle(new PdfDecryptionError("protocol_violation", PDF_DECRYPTION_FAILED_MESSAGE));
    },
  });
}

/** Runs one re-protection through one worker thread, under one deadline. */
function runReprotectionWorker(plaintextBytes, referenceBytes, suppliedPassword, allowWeakCrypto, timeoutMs) {
  const plaintext = transferableCopy(plaintextBytes);
  const ciphertext = transferableCopy(referenceBytes);
  return runBoundedQpdfWorker({
    workerData: {
      mode: "reprotect",
      ciphertext: ciphertext.buffer,
      plaintext: plaintext.buffer,
      password: suppliedPassword,
      allowWeakCrypto,
    },
    transferList: [ciphertext.buffer, plaintext.buffer],
    timeoutMs,
    timeoutError: () => new PdfDecryptionError("reprotect_timeout", PDF_REPROTECT_TIMEOUT_MESSAGE),
    handleMessage(message, settle) {
      if (message?.kind === "reprotected") {
        const protectedBytes = Buffer.from(message.ciphertext);
        if (protectedBytes.length === 0) {
          settle(new PdfDecryptionError("reprotect_failed", PDF_REPROTECT_FAILED_MESSAGE));
          return;
        }
        settle(null, { ciphertext: protectedBytes, encryption: message.encryption });
        return;
      }
      if (message?.kind === "failed") {
        settle(reprotectionFailure(message.reason));
        return;
      }
      settle(new PdfDecryptionError("protocol_violation", PDF_REPROTECT_FAILED_MESSAGE));
    },
  });
}

/**
 * Decrypts an encrypted PDF for one of the read-only operations, subject to
 * the size cap, the password rules, the permission rules and the deadline
 * documented above.
 *
 * Returns `{ plaintext, encryption, release }`. The caller owns `release()`
 * and must call it once it has finished reading the document that was loaded
 * from `plaintext`.
 *
 * @param {Buffer} pdfBytes  The encrypted file exactly as it is on disk.
 * @param {string|null} password  The caller-supplied password, if any.
 * @param {string} operation  A key of `ENCRYPTED_READ_OPERATIONS`.
 * @param {{timeoutMs?: number}} [options]  See `resolveDecryptionDeadlineMs`.
 */
export async function decryptPdfForRead(pdfBytes, password, operation, options = {}) {
  return queueDecryption(() => decryptPdfForReadExclusively(pdfBytes, password, operation, options));
}

/**
 * Decrypts an encrypted PDF so one of the mutation operations can change it.
 *
 * Identical to `decryptPdfForRead` in every respect but the permission rule.
 * A read proceeds for whoever can open the document. A write does not: if the
 * document's `/P` denies the permission the change needs, only the *owner*
 * password authorises it. Authenticating as owner satisfies permissions by
 * definition, which is why QPDF still reporting `modify: false` under an owner
 * password is not consulted once `ownerPasswordMatched` is true.
 *
 * The returned `encryption` is what the re-protection is later checked against.
 */
export async function decryptPdfForWrite(pdfBytes, password, operation, options = {}) {
  return queueDecryption(
    () => decryptPdfForWriteExclusively(pdfBytes, password, operation, options),
  );
}

/** The body of `decryptPdfForWrite`, run with the decryption queue held. */
async function decryptPdfForWriteExclusively(pdfBytes, password, operation, { timeoutMs } = {}) {
  const rules = ENCRYPTED_WRITE_OPERATIONS[operation];
  if (!rules) {
    throw new TypeError(`Operation '${operation}' is not permitted to rewrite encrypted PDFs.`);
  }
  const suppliedPassword = assertDecryptableRequest(pdfBytes, password);
  return runDecryptionWorker(
    pdfBytes,
    suppliedPassword,
    encryption => pdfPermissionRefusal({
      intent: "write",
      encryption,
      suppliedPassword,
      operation,
    }),
    resolveDecryptionDeadlineMs(timeoutMs),
  );
}

/**
 * THE PERMISSION RULE, in one function. Both intents are here so the asymmetry
 * between them cannot drift apart, and so a reader looking for "where is this
 * decided" finds one answer.
 *
 * `/P` governs writes. It does not govern reads. The module header carries the
 * argument for the read half at length; the short version is that a read gate
 * could only ever be applied to the one read path that happens to route through
 * QPDF, while eight PDF.js-backed siblings and three that hand over the whole
 * file returned the same content regardless, and that `/P` bit 10 makes bit 5
 * unenforceable on anything encrypted with AES.
 *
 * This is also the only function in `server/` that reads
 * `encryption.capabilities`, which `test/pdf-read-permission-consistency.test.js`
 * asserts structurally. If a second reader of that field appears, the rule has
 * grown a second home and this comment has become a lie.
 *
 * Returns the refusal, or `null` if the operation may proceed.
 */
export function pdfPermissionRefusal({ intent, encryption, suppliedPassword, operation }) {
  if (intent === "read") {
    // Deliberately empty. Whoever can open the document may read it; the
    // credential check that decides "can open" has already happened inside
    // QPDF, and a document that opens with an empty user password opens for
    // everybody. `/P` is not consulted, and there is no branch here that could
    // start consulting it without this comment having to be deleted first.
    return null;
  }
  if (intent !== "write") {
    throw new TypeError(`Permission intent must be 'read' or 'write', not '${intent}'.`);
  }
  const rules = ENCRYPTED_WRITE_OPERATIONS[operation];
  if (!rules) {
    throw new TypeError(`Operation '${operation}' is not permitted to rewrite encrypted PDFs.`);
  }
  return writePermissionRefusal(encryption, suppliedPassword, operation, rules);
}

/**
 * The write half of `pdfPermissionRefusal`, separated so it can be read — and
 * tested — without a worker. Call `pdfPermissionRefusal` from product code;
 * this is not a second rule, it is the body of that one's write branch.
 *
 * Returns the refusal, or `null` if the mutation may proceed.
 */
export function writePermissionRefusal(encryption, suppliedPassword, operation, rules) {
  // The owner password is the credential that authorises overriding /P, so
  // holding it ends the question. Note that QPDF keeps reporting the
  // document's declared capabilities as false even when the owner password
  // matched, so this must be checked before, not through, the capabilities.
  if (suppliedPassword !== null && encryption.ownerPasswordMatched) return null;
  const denied = rules.capabilities
    .filter(capability => encryption.capabilities?.[capability] !== true);
  if (denied.length === 0) return null;
  return new PdfDecryptionError(
    "write_permission_denied",
    pdfWritePermissionDeniedMessage(operation, denied),
  );
}

/**
 * Restores a document's own protection onto the bytes a mutation produced.
 *
 * `reference` is the original encrypted file. QPDF's `--copy-encryption`
 * reproduces its `/O`, `/OE`, `/U`, `/UE`, `/P`, `/R`, `/V` and crypt filters
 * verbatim — including an owner password nothing here ever learned — so the
 * output carries the protection the document arrived with rather than new
 * protection minted from the caller's password.
 *
 * The result is then compared against the source's own encryption before it is
 * returned. A silently different `/P` is the failure this whole path exists to
 * prevent, so it is asserted against rather than assumed away: if anything
 * differs the operation fails and no bytes are handed back. There is
 * deliberately no path that returns plaintext.
 */
export async function reprotectPdfAfterWrite(mutatedBytes, reference, password, sourceEncryption, options = {}) {
  return queueDecryption(
    () => reprotectPdfAfterWriteExclusively(mutatedBytes, reference, password, sourceEncryption, options),
  );
}

function reprotectPdfAfterWriteExclusively(
  mutatedBytes,
  reference,
  password,
  sourceEncryption,
  { timeoutMs } = {},
) {
  if (!isPdfByteContainer(mutatedBytes) || !isPdfByteContainer(reference)) {
    throw new TypeError("Re-protection requires the mutated bytes and the original file.");
  }
  const suppliedPassword = normalizeSuppliedPassword(password);
  if (suppliedPassword !== null && /[\r\n]/.test(suppliedPassword)) {
    throw new PdfDecryptionError("password_unrepresentable", PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }
  // The mutated bytes are not size-capped against the encrypted-input ceiling:
  // that cap governs what may be *decrypted*, and this document already was.
  // What bounds this side is the mutation pipeline's own staging limits.
  const { outcome, teardown } = runReprotectionWorker(
    mutatedBytes,
    reference,
    suppliedPassword,
    usesWeakCrypto(sourceEncryption),
    resolveDecryptionDeadlineMs(timeoutMs),
  );
  // The verification is folded into `outcome` rather than awaited here, so the
  // queue still holds until the worker is gone on the failing path too.
  return {
    outcome: outcome.then(produced => {
      if (!sameProtection(sourceEncryption, produced.encryption)) {
        throw new PdfDecryptionError("reprotect_changed_protection", PDF_REPROTECT_CHANGED_MESSAGE);
      }
      return produced.ciphertext;
    }),
    teardown,
  };
}

/**
 * Whether the document's protection is RC4, which QPDF refuses to write
 * without being told to. Keyed off what QPDF reported about the source, so the
 * flag is only ever set for a document that already used RC4.
 */
export function usesWeakCrypto(encryption) {
  const parameters = encryption?.parameters;
  if (!parameters) return false;
  if (Number.isInteger(parameters.R) && parameters.R <= 3) return true;
  return ["method", "filemethod", "streammethod", "stringmethod"]
    .some(key => typeof parameters[key] === "string" && /rc4/i.test(parameters[key]));
}

/**
 * Whether two inspections describe the same protection.
 *
 * Compares the literal `/Encrypt` dictionary — which is what `/O`, `/U`, `/OE`
 * and `/UE` live in, and so what actually encodes the passwords — as well as
 * every reported parameter and the supplied password's standing against the
 * document. A dictionary that could not be resolved is `null`, and `null` is
 * never equal to anything here, so an unreadable or non-standard security
 * handler refuses rather than compares equal.
 */
export function sameProtection(source, produced) {
  if (!source?.parameters || !produced?.parameters) return false;
  if (typeof source.encryptDictionary !== "string"
      || source.encryptDictionary !== produced.encryptDictionary) {
    return false;
  }
  const identical = ["P", "R", "V", "bits", "method", "filemethod", "streammethod", "stringmethod"]
    .every(key => source.parameters[key] === produced.parameters[key]);
  return identical
    && source.encrypted === produced.encrypted
    && source.ownerPasswordMatched === produced.ownerPasswordMatched
    && source.userPasswordMatched === produced.userPasswordMatched;
}

/**
 * Whether a set of sources can be given one shared protection.
 *
 * `merge_pdfs` is the only operation with more than one source, and N sources
 * with different or absent encryption make "the source's encryption"
 * undefined. Rather than pick one, or quietly drop protection, the merge is
 * refused unless every source is protected identically — same parameters, and
 * the same standing for the supplied password, which is what makes them a
 * single protection rather than a coincidence of settings.
 */
export function mergeProtectionRefusal(encryptions) {
  const present = encryptions.filter(encryption => encryption !== null);
  if (present.length === 0) return null;
  if (present.length !== encryptions.length
      || !present.every(encryption => sameProtection(present[0], encryption))) {
    return new PdfDecryptionError(
      "merge_mixed_encryption",
      PDF_MERGE_MIXED_ENCRYPTION_MESSAGE,
    );
  }
  return null;
}

function reprotectionFailure(reason) {
  return new PdfDecryptionError(
    typeof reason === "string" && reason.length > 0 ? reason : "reprotect_failed",
    PDF_REPROTECT_FAILED_MESSAGE,
  );
}

const isPdfByteContainer = bytes => Buffer.isBuffer(bytes) || bytes instanceof Uint8Array;

/**
 * The checks every decryption shares, applied before a thread is started for
 * it: the size cap first, so an oversized input costs a length comparison
 * rather than an out-of-memory kill, then the password's representability.
 */
function assertDecryptableRequest(pdfBytes, password) {
  if (!isPdfByteContainer(pdfBytes)) {
    throw new TypeError("Encrypted PDF bytes must be a Buffer or Uint8Array.");
  }
  const suppliedPassword = normalizeSuppliedPassword(password);
  if (pdfBytes.length > PDF_ENCRYPTED_MAX_FILE_BYTES) {
    throw new PdfDecryptionError("encrypted_input_too_large", PDF_ENCRYPTED_FILE_LIMIT_MESSAGE);
  }
  // The worker hands QPDF the password through a single-line password file
  // rather than through argv, and QPDF reads the first line of it, so a
  // password containing a line break would be silently truncated and then
  // reported as "not accepted" — a confusing lie. Refuse it here, before a
  // thread is started for it.
  if (suppliedPassword !== null && /[\r\n]/.test(suppliedPassword)) {
    throw new PdfDecryptionError("password_unrepresentable", PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }
  return suppliedPassword;
}

/** The body of `decryptPdfForRead`, run with the decryption queue held. */
async function decryptPdfForReadExclusively(pdfBytes, password, operation, { timeoutMs } = {}) {
  const rules = ENCRYPTED_READ_OPERATIONS[operation];
  if (!rules) {
    throw new TypeError(`Operation '${operation}' is not permitted to decrypt PDFs.`);
  }
  const suppliedPassword = assertDecryptableRequest(pdfBytes, password);

  return runDecryptionWorker(
    pdfBytes,
    suppliedPassword,
    encryption => pdfPermissionRefusal({
      intent: "read",
      encryption,
      suppliedPassword,
      operation,
    }),
    resolveDecryptionDeadlineMs(timeoutMs),
  );
}
