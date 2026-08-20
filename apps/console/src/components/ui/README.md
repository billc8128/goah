# Console UI primitives

The Console keeps its visual language in `styles.css`, while interaction semantics come from Radix UI:

- `Accordion` for expandable work records
- `Collapsible` for detailed tool payloads
- `Dialog` for the CEO composer
- `ScrollArea` for bounded session traces
- `Select` for session choice
- `Tabs` for Ledger modes

Import these primitives through `primitives.ts` so interaction dependencies remain centralized and can be wrapped with Goah-specific behavior when a pattern is reused.
