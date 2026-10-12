/** Bounded, read-only review UI. Corrections are explicit requests to the agent. */
export interface EvidenceCitation {
  status: "replayed" | "unavailable";
  page: number | null;
  chunk_id: string | null;
  start_utf8_byte: number | null;
  end_utf8_byte: number | null;
  quote_sha256: string | null;
  quote: string;
  quote_truncated: boolean;
  reason: string | null;
}
export interface EvidenceLeaf {
  kind: "leaf";
  leaf_pointer: string;
  current: boolean;
  status: string;
  settled: boolean;
  correction_allowed: boolean;
  proposal_event_id: string | null;
  event_sequence: number | null;
  verification_sha256: string | null;
  value_preview: string;
  value_truncated: boolean;
  value_sha256: string | null;
  method: string | null;
  reason_codes: string[];
  citation_count: number;
  citations: EvidenceCitation[];
}
interface EvidencePage {
  kind: "page";
  page: number;
  extraction_status: string;
  text_layer_status: string;
  modality_hint: string;
  needs_visual_inspection: boolean;
  gap_codes: string[];
  returned_chunks: number;
  omitted_chunks: number;
  omitted_items: number;
  omitted_characters: number;
}
export interface EvidenceReview {
  version: 1;
  workspace_id: string;
  workspace_identity_sha256: string;
  generation_sha256: string;
  generation_sequence: number;
  source: { canonical_path: string; size_bytes: number; sha256: string };
  schema_sha256: string;
  document_map_sha256: string;
  page_count: number;
  summary: { leaves: number; settled: number; unproposed: number; awaiting_verification: number; unresolved: number };
  view: "leaves" | "pages" | "history";
  leaf_pointer: string | null;
  counts: { total: number; offset: number; returned: number };
  items: (EvidenceLeaf | EvidencePage)[];
  next_cursor: string | null;
  claim_boundary: string;
}

const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => typeof item === "string");
const nullable = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value);
const string = (value: unknown): value is string => typeof value === "string";
const check = (condition: unknown): void => { if (!condition) throw new Error("The Evidence response is invalid. Ask the assistant to reopen this workspace."); };

/** Treat tool metadata as data: validate bounds and identity before rendering it. */
export function parseEvidenceReview(value: any): EvidenceReview {
  check(value && typeof value === "object" && JSON.stringify(value).length <= 131072);
  check(value.version === 1 && string(value.workspace_id) && sha(value.workspace_identity_sha256) && sha(value.generation_sha256));
  check(integer(value.generation_sequence) && sha(value.schema_sha256) && sha(value.document_map_sha256));
  check(value.source && string(value.source.canonical_path) && value.source.canonical_path.length > 0 && integer(value.source.size_bytes) && sha(value.source.sha256));
  check(integer(value.page_count) && value.page_count > 0 && ["leaves", "pages", "history"].includes(value.view));
  check(nullable(value.leaf_pointer, string) && (value.view === "history" ? value.leaf_pointer !== null : value.leaf_pointer === null));
  check(value.summary && ["leaves", "settled", "unproposed", "awaiting_verification", "unresolved"].every(key => integer(value.summary[key])));
  check(value.summary.leaves === value.summary.settled + value.summary.unproposed + value.summary.awaiting_verification + value.summary.unresolved);
  check(value.counts && ["total", "offset", "returned"].every(key => integer(value.counts[key])));
  check(Array.isArray(value.items) && value.items.length <= 20 && value.counts.returned === value.items.length && value.counts.offset + value.items.length <= value.counts.total);
  check(nullable(value.next_cursor, string) && string(value.claim_boundary));
  for (const item of value.items) {
    check(item && typeof item === "object");
    if (value.view === "pages") {
      check(item.kind === "page" && integer(item.page) && item.page >= 1 && item.page <= value.page_count);
      check(["extraction_status", "text_layer_status", "modality_hint"].every(key => string(item[key])));
      check(typeof item.needs_visual_inspection === "boolean" && strings(item.gap_codes, 64));
      check(["returned_chunks", "omitted_chunks", "omitted_items", "omitted_characters"].every(key => integer(item[key])));
    } else {
      check(item.kind === "leaf" && string(item.leaf_pointer) && string(item.status) && string(item.value_preview));
      check(["current", "settled", "correction_allowed", "value_truncated"].every(key => typeof item[key] === "boolean"));
      check(nullable(item.proposal_event_id, string) && nullable(item.event_sequence, integer) && nullable(item.verification_sha256, sha));
      check(nullable(item.value_sha256, sha) && nullable(item.method, string) && strings(item.reason_codes, 16));
      check(integer(item.citation_count) && Array.isArray(item.citations) && item.citations.length <= 32 && item.citations.length <= item.citation_count);
      check(item.settled === ["verified_exact", "computed_with_inputs"].includes(item.status));
      check(item.correction_allowed === (item.current && !item.settled && item.status !== "unverified"));
      if (value.view === "history") check(item.leaf_pointer === value.leaf_pointer);
      for (const citation of item.citations) {
        check(citation && ["replayed", "unavailable"].includes(citation.status) && string(citation.quote) && typeof citation.quote_truncated === "boolean");
        check(nullable(citation.page, integer) && nullable(citation.chunk_id, string) && nullable(citation.quote_sha256, sha));
        check(nullable(citation.start_utf8_byte, integer) && nullable(citation.end_utf8_byte, integer) && nullable(citation.reason, string));
        if (citation.status === "replayed") check(
          integer(citation.page) && citation.page >= 1 && citation.page <= value.page_count &&
          integer(citation.start_utf8_byte) && integer(citation.end_utf8_byte) && citation.end_utf8_byte > citation.start_utf8_byte &&
          typeof citation.chunk_id === "string" && /^chunk\.[a-f0-9]{64}$/.test(citation.chunk_id) &&
          citation.quote.length > 0 && sha(citation.quote_sha256) && citation.reason === null,
        );
      }
    }
  }
  return value;
}

/** Exact text matching only; repeated text never silently chooses a region. */
export function findUniqueCitationSpans(parts: string[], quote: string): number[] | null {
  if (!quote) return null;
  const text = parts.join("");
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) !== -1) return null;
  const selected: number[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    if (part.length && offset < start + quote.length && offset + part.length > start) selected.push(index);
    offset += part.length;
  });
  return selected;
}

interface Dependencies {
  panel: HTMLElement;
  textLayer: HTMLElement;
  currentGeneration: () => number;
  currentPage: () => number;
  currentPath: () => string;
  navigate: (page: number) => void;
  verifySource: (source: EvidenceReview["source"], generation: number) => Promise<void>;
  callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<any>;
  sendPrompt: (prompt: string) => Promise<boolean>;
}
const node = (tag: string, text = "", className = "") => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};
const clear = (element: HTMLElement) => { while (element.firstChild) element.removeChild(element.firstChild); };

export class EvidenceReviewPanel {
  private review: EvidenceReview | null = null;
  private generation = -1;
  private epoch = 0;
  private busy = false;
  private blocked = false;
  private active = false;
  private message = "";
  private prompt = "";
  private selectedCitation: EvidenceCitation | null = null;
  private citationStatus: HTMLElement | null = null;
  constructor(private dependencies: Dependencies) { this.render(); }

  clear() {
    this.epoch++;
    this.review = null;
    this.generation = -1;
    this.busy = false;
    this.blocked = false;
    this.message = "";
    this.prompt = "";
    this.selectedCitation = null;
    this.clearHighlights();
    this.render();
  }
  setActive(active: boolean) {
    this.active = active;
    this.dependencies.panel.style.display = active ? "flex" : "none";
    if (active) this.afterPageRendered(); else this.clearHighlights();
  }
  private current(epoch: number) { return epoch === this.epoch && this.generation === this.dependencies.currentGeneration(); }
  async open(value: unknown, generation: number) {
    this.clear();
    this.generation = generation;
    const epoch = this.epoch;
    this.busy = true;
    this.message = "Checking that the loaded PDF bytes match the extraction source…";
    this.render();
    try {
      const review = parseEvidenceReview(value);
      if (review.source.canonical_path !== this.dependencies.currentPath()) throw new Error("This Evidence view belongs to a different PDF.");
      await this.dependencies.verifySource(review.source, generation);
      if (!this.current(epoch)) return;
      this.review = review;
      this.message = "Loaded PDF bytes match the extraction source.";
    } catch (error) {
      if (!this.current(epoch)) return;
      this.blocked = true;
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.current(epoch)) { this.busy = false; this.render(); }
    }
  }

  private args(review: EvidenceReview, view: EvidenceReview["view"], leaf: string | null, cursor: string | null, refresh = false) {
    return {
      pdf_path: review.source.canonical_path, workspace_id: review.workspace_id,
      workspace_identity_sha256: review.workspace_identity_sha256,
      ...(!refresh ? { expected_generation_sha256: review.generation_sha256 } : {}),
      view, ...(leaf !== null ? { leaf_pointer: leaf } : {}), limit: 20,
      ...(cursor ? { cursor } : {}),
    };
  }
  private async fetch(review: EvidenceReview, view: EvidenceReview["view"], leaf: string | null, cursor: string | null, refresh = false) {
    const result = await this.dependencies.callTool({ name: "review_extraction_workspace", arguments: this.args(review, view, leaf, cursor, refresh) });
    if (result.isError) throw new Error(result.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join(" ") || "Evidence could not be refreshed.");
    const next = parseEvidenceReview(result.structuredContent?.extractionReview);
    if (next.workspace_id !== review.workspace_id || next.workspace_identity_sha256 !== review.workspace_identity_sha256 ||
      next.source.canonical_path !== review.source.canonical_path || next.source.sha256 !== review.source.sha256 || next.source.size_bytes !== review.source.size_bytes ||
      next.schema_sha256 !== review.schema_sha256 || next.document_map_sha256 !== review.document_map_sha256 || next.page_count !== review.page_count ||
      next.view !== view || next.leaf_pointer !== leaf || (!refresh && next.generation_sha256 !== review.generation_sha256)) {
      throw new Error("Evidence identity changed. Ask the assistant to reopen the workspace.");
    }
    return next;
  }
  private async load(view: EvidenceReview["view"], leaf: string | null = null, cursor: string | null = null, refresh = false) {
    if (!this.review || this.busy) return;
    const previous = this.review;
    const epoch = ++this.epoch;
    this.busy = true;
    this.prompt = "";
    this.selectedCitation = null;
    this.clearHighlights();
    this.message = "Loading evidence…";
    this.render();
    try {
      const next = await this.fetch(previous, view, leaf, cursor, refresh);
      if (!this.current(epoch)) return;
      this.review = next;
      this.blocked = false;
      this.message = refresh ? "Evidence refreshed against the current source and workspace generation." : "";
    } catch (error) {
      if (!this.current(epoch)) return;
      this.blocked = true;
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.current(epoch)) { this.busy = false; this.render(); }
    }
  }
  private async requestCorrection(leaf: EvidenceLeaf) {
    if (!this.review || this.busy || this.blocked || !leaf.current) return;
    const review = this.review;
    const epoch = ++this.epoch;
    this.busy = true;
    this.message = "Checking the current generation before preparing your request…";
    this.render();
    try {
      await this.fetch(review, "history", leaf.leaf_pointer, null);
      if (!this.current(epoch)) return;
      this.prompt = [
        "Review this extraction leaf using the existing append-only extraction tools.",
        `PDF: ${JSON.stringify(review.source.canonical_path)}; source SHA-256: ${review.source.sha256}.`,
        `Workspace: ${review.workspace_id}; identity SHA-256: ${review.workspace_identity_sha256}; expected current generation: ${review.generation_sha256}.`,
        `Leaf: ${JSON.stringify(leaf.leaf_pointer)}; current proposal: ${leaf.proposal_event_id || "none"}; observed status: ${leaf.status}.`,
        leaf.status === "unverified"
          ? "Replay the current pending proposal with source-bound citations before attempting a replacement. Do not overwrite history."
          : "Inspect the original source, append a correction proposal if supported, then replay its citations with verify_extraction_proposal or verify_extraction_batch. Do not overwrite history or treat uncertainty as approval.",
        "Recheck the source and current generation before writing; reopen review_extraction_workspace afterward. If evidence is insufficient, preserve an explicit unresolved state.",
      ].join("\n");
      this.message = "Request ready below. No extracted value has been changed by this view.";
      this.render();
      const sent = await this.dependencies.sendPrompt(this.prompt);
      if (!this.current(epoch)) return;
      if (sent) this.message = "Request sent to the conversation. Refresh evidence after the agent finishes.";
    } catch (error) {
      if (!this.current(epoch)) return;
      this.blocked = true;
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.current(epoch)) { this.busy = false; this.render(); }
    }
  }
  private clearHighlights() {
    this.dependencies.textLayer.querySelectorAll(".evidence-citation-highlight").forEach(element => element.classList.remove("evidence-citation-highlight"));
  }
  afterPageRendered() {
    this.clearHighlights();
    const citation = this.selectedCitation;
    if (!this.active || !citation || !this.review || this.generation !== this.dependencies.currentGeneration()) return;
    if (citation.page !== this.dependencies.currentPage()) return;
    if (citation.quote_truncated) {
      if (this.citationStatus) this.citationStatus.textContent = "Quote preview is truncated; inspect the cited page and exact chunk bytes with the assistant.";
      return;
    }
    const spans = Array.from(this.dependencies.textLayer.querySelectorAll<HTMLSpanElement>("span"));
    const matches = findUniqueCitationSpans(spans.map(span => span.textContent || ""), citation.quote);
    if (!matches?.length) {
      if (this.citationStatus) this.citationStatus.textContent = "Opened the cited page. Exact quote placement is unavailable or repeated; no region was guessed.";
      return;
    }
    for (const index of matches) spans[index].classList.add("evidence-citation-highlight");
    spans[matches[0]].scrollIntoView?.({ block: "center", inline: "nearest" });
    if (this.citationStatus) this.citationStatus.textContent = "Highlighted text spans containing one exact quote match. This is a visual aid, not a source bounding box.";
  }
  private button(label: string, action: () => void, disabled = this.busy || this.blocked) {
    const button = node("button", label) as HTMLButtonElement;
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }
  private render() {
    const panel = this.dependencies.panel;
    clear(panel);
    panel.appendChild(node("h2", "Extraction evidence"));
    const status = node("p", this.message, "evidence-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    panel.appendChild(status);
    if (!this.review) {
      panel.appendChild(node("p", "Open an extraction workspace with the assistant to review values, original citations, and page coverage here."));
      if (!this.busy && !this.blocked) panel.appendChild(this.button("Ask to open evidence", () => {
        const epoch = ++this.epoch;
        this.generation = this.dependencies.currentGeneration();
        this.busy = true;
        this.prompt = `Open the extraction evidence workspace for PDF ${JSON.stringify(this.dependencies.currentPath())} using review_extraction_workspace. If no workspace exists, ask me which data to extract before creating one.`;
        this.message = "You can send this request in the conversation:";
        this.render();
        void this.dependencies.sendPrompt(this.prompt).then(sent => {
          if (this.current(epoch) && sent) { this.message = "Request sent to the conversation."; this.render(); }
        }).catch(() => { /* selectable prompt remains available */ }).finally(() => {
          if (this.current(epoch)) { this.busy = false; this.render(); }
        });
      }));
    } else {
      const review = this.review;
      const summary = review.summary;
      panel.appendChild(node("p", `${summary.settled} of ${summary.leaves} exact or computed · ${summary.unresolved} unresolved · ${summary.awaiting_verification} awaiting replay · ${summary.unproposed} not proposed`, "evidence-summary"));
      const identity = node("details", "", "evidence-identity");
      identity.appendChild(node("summary", `Source matched · generation ${review.generation_sequence}`));
      identity.appendChild(node("p", `PDF SHA-256: ${review.source.sha256}\nWorkspace: ${review.workspace_id}\nWorkspace identity: ${review.workspace_identity_sha256}\nGeneration: ${review.generation_sha256}`));
      panel.appendChild(identity);
      const navigation = node("div", "", "evidence-actions");
      navigation.append(
        this.button("Values", () => { void this.load("leaves"); }),
        this.button("Page coverage", () => { void this.load("pages"); }),
        this.button("Refresh", () => { void this.load(review.view, review.leaf_pointer, null, true); }, this.busy),
      );
      panel.appendChild(navigation);
      if (review.view === "history") panel.appendChild(node("h3", `History: ${review.leaf_pointer || "(root)"}`));
      panel.appendChild(node("p", `${review.counts.total === 0 ? 0 : review.counts.offset + 1}–${review.counts.offset + review.counts.returned} of ${review.counts.total} ${review.view === "history" ? "proposals, newest first" : review.view}`, "evidence-count"));
      const list = node("div", "", "evidence-list");
      for (const item of review.items) {
        const row = node("article", "", "evidence-item");
        if (item.kind === "page") {
          row.appendChild(this.button(`Page ${item.page}`, () => { this.selectedCitation = null; this.clearHighlights(); this.dependencies.navigate(item.page); }));
          row.appendChild(node("p", `${item.extraction_status} · ${item.text_layer_status} · ${item.modality_hint}`));
          row.appendChild(node("p", `${item.returned_chunks} chunks retained · ${item.omitted_chunks} omitted · ${item.omitted_items} layout items omitted · ${item.omitted_characters} characters omitted`));
          if (item.needs_visual_inspection) row.appendChild(node("strong", "Visual inspection needed", "evidence-warning"));
          if (item.gap_codes.length) row.appendChild(node("p", item.gap_codes.join(" · "), "evidence-warning"));
        } else {
          row.appendChild(node("h3", item.leaf_pointer || "(root)"));
          row.appendChild(node("p", `${item.current ? "Current" : "Historical"} · ${item.status}${item.method ? ` · ${item.method}` : ""}`, item.settled ? "evidence-settled" : "evidence-warning"));
          row.appendChild(node("pre", item.status === "not_proposed" ? "No proposal yet" : `${item.value_preview}${item.value_truncated ? "\n[preview truncated]" : ""}`));
          if (item.reason_codes.length) row.appendChild(node("p", item.reason_codes.join(" · "), "evidence-warning"));
          if (review.view === "leaves") row.appendChild(this.button(`History and citations (${item.citation_count})`, () => { void this.load("history", item.leaf_pointer); }));
          else {
            row.appendChild(node("p", `Proposal ${item.event_sequence ?? "—"}: ${item.proposal_event_id ?? "none"}`, "evidence-count"));
            if (!item.citations.length) row.appendChild(node("p", "No replayed citation is available for this proposal."));
            for (const citation of item.citations) {
              const detail = node("div", "", "evidence-citation");
              detail.appendChild(node("blockquote", citation.quote || citation.reason || "Citation unavailable"));
              detail.appendChild(node("p", `${citation.chunk_id ?? "Unknown chunk"} · UTF-8 bytes ${citation.start_utf8_byte ?? "?"}–${citation.end_utf8_byte ?? "?"}`));
              if (citation.status === "replayed" && citation.page) detail.appendChild(this.button(`View citation on page ${citation.page}`, () => {
                this.selectedCitation = citation;
                this.dependencies.navigate(citation.page!);
                this.afterPageRendered();
              }));
              row.appendChild(detail);
            }
          }
          if (item.current && !item.settled) row.appendChild(this.button(item.status === "unverified" ? "Ask agent to verify" : item.status === "not_proposed" ? "Ask agent to extract" : "Ask agent to correct", () => { void this.requestCorrection(item); }));
        }
        list.appendChild(row);
      }
      panel.appendChild(list);
      this.citationStatus = node("p", "", "evidence-status");
      this.citationStatus.setAttribute("role", "status");
      panel.appendChild(this.citationStatus);
      const pagination = node("div", "", "evidence-actions");
      if (review.counts.offset > 0) pagination.appendChild(this.button("First page", () => { void this.load(review.view, review.leaf_pointer); }));
      if (review.next_cursor) pagination.appendChild(this.button("Next page", () => { void this.load(review.view, review.leaf_pointer, review.next_cursor); }));
      panel.appendChild(pagination);
      panel.appendChild(node("p", review.claim_boundary, "evidence-boundary"));
    }
    if (this.prompt) panel.appendChild(node("pre", this.prompt, "evidence-prompt"));
  }
}
