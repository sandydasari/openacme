---
"@openacme/agent-core": minor
"@openacme/server": minor
---

Agent-readable data-file attachments. Users can now attach zip, csv, tsv, json, txt, md, xlsx, docx, parquet, svg, xml, and yaml files. These are committed to disk and read by the agent via its tools rather than sent to the model, so even text-only models accept them. Attachments render rich in-chat previews — a file tree for archives, real spreadsheet tables (via SheetJS), csv/json previews — using the Pierre file-tree icon set for consistency with the resource browser.
