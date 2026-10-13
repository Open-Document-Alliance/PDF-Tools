# Header-neutral table conversion

`convert_pdf_to_markdown` accepts the explicit, default-off
`allow_headerless_tables: true` option. The selected renderer profile is
`1.22.0`; ordinary calls and explicit `false` retain profile `1.21.0` and
the previous complete result envelope.

This addresses a narrow representational limit: GFM assigns header semantics
to its first row, so the default converter refuses a grid whose source does
not distinguish a header. The opt-in profile can preserve that grid as an
HTML table containing only escaped `<td>` data cells. It creates no `<th>`,
spans, inherited values or semantic blank values. Header roles remain
unestablished and a typed conversion gap remains visible.

The fallback applies only to complete source-covered ruled-rectangle cell
grids. Every cell must have rectangle evidence, every relevant source line
and item must be accounted for, and each text advance box must fit its one
cell. Missing/competing rectangles, overlapping items, cross-cell text,
truncated evidence, suspect text and ordinary aligned prose do not qualify.
This does not broaden the captioned/solid-mask, segmented-rule, or unruled
table paths. Those and existing GFM tables keep their prior rules. Source
text is HTML-escaped, never interpreted as markup or an attribute.

Example tool arguments:

```json
{
  "pdf_path": "/absolute/local/document.pdf",
  "allow_headerless_tables": true
}
```

The option composes with `compact` and `emit_table_proposals`. Table cells
are excluded from compact normalizations; if proposal emission is requested,
the unresolved-header region remains source-bound and available for review.
No OCR, model call or automatic verification is introduced. Empty cells
represent retained text coverage, not proof that the source's data is blank.

The earlier full corpus score belongs to the default text-only profile and
has not been improved, replaced or rescored by this option. Synthetic table
success does not establish general table accuracy, scan quality, unique
semantic topology or competitive benchmark performance. The broader
equation, scanned-document and uncertain-topology gaps remain separate work.
