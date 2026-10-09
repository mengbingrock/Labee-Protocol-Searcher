---
name: labee-source-morimoto-lab
description: Publisher-selection marker for Labee Protocol Searcher. When this skill is enabled in plugin settings, include source id `morimoto-lab` in the default source allowlist for Labee searches. Disable it to exclude Morimoto Lab from searches by default.
---

# Morimoto Lab source

Treat this skill's presence as configuration. Contribute `morimoto-lab` to the `sources` array passed to Labee's `search` tool. Let the main Labee Protocol Searcher skill coordinate the search.

Search matches document titles and categories in Northwestern University's Morimoto Lab PDF catalog. Use `fetch` with a result's id to read the selected PDF.
