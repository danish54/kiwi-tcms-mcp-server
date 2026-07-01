---
name: kiwi-tcms-test-generation
description: Generate business-level test scenarios from a feature branch and push them to Kiwi TCMS. Use when asked to "generate tests for TICKET-XXXX", "push tests to Kiwi", or "update tests after PRD change".
---

<!--
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTALLATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Copy this file to the Cursor global skills folder:

   mkdir -p ~/.agents/skills/kiwi-tcms-test-generation
   cp skills/kiwi-tcms-test-generation/SKILL.md \
      ~/.agents/skills/kiwi-tcms-test-generation/SKILL.md

2. In the copied file, replace the placeholders below with your own values:

   Placeholder                | Description
   ───────────────────────────┼──────────────────────────────────────────────────
   <REPLACE_KIWI_URL>         | Base URL of your Kiwi TCMS instance
                              | e.g. https://tcms.example.com
   <REPLACE_MCP_SERVER_PATH>  | Absolute path to src/index.js on your machine
                              | e.g. /home/user/kiwi-tcms-mcp/src/index.js
   <REPLACE_PRODUCT_NAME>     | Your product name in Kiwi TCMS
   <REPLACE_PRODUCT_ID>       | Product ID (from kiwi_list_products)
   <REPLACE_VERSION_ID>       | Version ID (from kiwi_list_versions)
   <REPLACE_TICKET_PREFIX>    | Your ticket prefix (e.g. JIRA, ADS, PROJ)

   All other values (doc paths, folder structure) are shown as generic
   examples. Adapt them to your project setup.

3. In your IDE's MCP config, add the kiwi-tcms server under "mcpServers"
   (see the README for the full snippet).

4. Restart your IDE for the MCP server and the skill to be picked up.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-->

# Kiwi TCMS Test Generation

## Overview

Analyse a feature branch using one or more reference documents (PRD, design doc, implementation plan) and generate QA test scenarios in numbered steps, then push them directly to Kiwi TCMS via MCP tools. Test cases are written in business language for a non-developer QA team.

**Announce at start:** "I'm using the kiwi-tcms-test-generation skill."

**MCP server required:** `kiwi-tcms` (configured in your IDE's MCP config)  
**Kiwi instance:** `<REPLACE_KIWI_URL>`  
**Product ID:** `<REPLACE_PRODUCT_ID>` | **Version ID:** `<REPLACE_VERSION_ID>`

---

## STEP -1 — Bootstrap check (run once, before everything else)

Before any other step, verify the MCP server is configured. Check your IDE's MCP config for a `kiwi-tcms` entry.

**If the `kiwi-tcms` entry is missing**, offer to create it:

```
The Kiwi TCMS MCP server is not configured.
I can add it now. I need:
  - Your Kiwi TCMS username
  - Your Kiwi TCMS password
  (The URL is already known: <REPLACE_KIWI_URL>)
```

Then add the entry to your MCP config under `mcpServers`:

```json
"kiwi-tcms": {
  "command": "node",
  "args": ["<REPLACE_MCP_SERVER_PATH>"],
  "env": {
    "KIWI_URL": "<REPLACE_KIWI_URL>",
    "KIWI_USERNAME": "<provided>",
    "KIWI_PASSWORD": "<provided>"
  }
}
```

Then remind: **Restart your IDE for the MCP server to be picked up.**

**If the entry exists**, verify connectivity by calling `kiwi_list_products`. If connection fails, show the error and stop.

---

## STEP 0 — Interactive clarification (MANDATORY, always run first)

Before doing anything else, ask these two questions **one at a time**:

### Question 1 — Reference documents

List the available documents found in the project, then ask:

```
Which documents should I use as reference to generate the tests?
(You can select multiple)

[ ] PRD → docs/prds/ (acceptance criteria per User Story)
[ ] Design document → docs/plans/*-design.md (architecture, approaches)
[ ] Implementation plan → docs/plans/*.md (detailed tasks)
[ ] Other → specify the path
```

**How to list available docs:** Before asking, scan:
- `docs/prds/` for files matching the ticket number or feature name
- `docs/plans/` for files matching the ticket number or feature name

Present the actual filenames found so the user can choose precisely.

### Question 2 — Scope

```
What is the scope of this generation?

( ) Entire ticket <REPLACE_TICKET_PREFIX>-XXXX (all User Stories)
( ) Only newly added / modified User Stories
( ) A specific User Story → which one?
```

Only after getting answers to both questions, proceed to Step 1.

---

## Workflow A — New generation (feature branch complete)

### Step 1 — Read selected documents

Read each selected document fully. Extract:

**From PRD (`docs/prds/`):**
- Acceptance criteria per User Story
- Edge cases mentioned
- Rights and feature flags required

**From design doc (`docs/plans/*-design.md`):**
- Architecture decisions and their rationale
- Proposed approaches (especially rejected ones → often reveal edge cases)
- Component interactions and data flows

**From implementation plan (`docs/plans/*.md`):**
- Detailed task list → reveals which components are touched
- Testing notes written during planning
- Known risks or constraints flagged by the planner

**Cross-reference all sources.** Design docs and plans often contain test scenarios that weren't captured in the PRD (e.g. error states, race conditions, UI details).

### Step 2 — Identify scenarios

For each User Story (or selected scope), extract:

| Priority | Type | Source hint |
|----------|------|-------------|
| P1 | Happy path — main functional flow | PRD acceptance criteria |
| P1 | Rights / feature flags | PRD access control stories |
| P2 | Empty states, no data | PRD + design doc |
| P2 | Error states, conflict handling | Design doc (rejected approaches often reveal these) |
| P2 | Regression — existing features still work | Implementation plan (modified files list) |
| P3 | Edge cases at boundaries | Design doc + plan notes |

Rule: **1 test case = 1 acceptance criterion**. Max 8 steps per test case.

### Step 3 — Push to Kiwi via MCP

Call in this order:

```
1. kiwi_list_products          → confirm product ID
2. kiwi_list_versions          → confirm version ID
3. kiwi_create_test_plan       → name: "<REPLACE_TICKET_PREFIX>-XXXX — [Feature Name]"
4. kiwi_create_test_case       → one call per test case (format: "table")
5. kiwi_add_tag                → tag each TC with relevant labels
6. kiwi_list_builds            → find current build
7. kiwi_create_test_run        → create execution campaign for QA
```

### Step 4 — Summary

```
✅ X test cases created
Sources used: [list of docs]

📋 Test Plan: <REPLACE_KIWI_URL>/plan/<id>/
🏃 Test Run:  <REPLACE_KIWI_URL>/runs/<id>/

| Kiwi ID | Title | Source | US | Priority |
|---------|-------|--------|----|----------|
```

---

## Workflow B — Update after PRD or design doc change

### Step 0 — Interactive clarification

Same as above. Additionally ask:

```
What has changed?
( ) The PRD was updated
( ) The design doc was updated
( ) The implementation plan was updated
( ) Multiple documents changed
```

### Step 1 — Diff the changed documents

```bash
git diff main -- docs/prds/**/*TICKET-XXXX*.md
git diff main -- docs/plans/*TICKET-XXXX*
```

Classify changes:
- Added lines (`+`) → new US or new criteria → new test cases
- Removed lines (`-`) → abandoned US or removed criteria → disable test cases
- Modified lines → refined criteria → update test cases

### Step 2 — Map existing test cases

```
kiwi_list_test_cases(plan_id)
```

Link each existing TC (by title TC-XX) to its source US.

### Step 3 — Apply changes

| Situation | Action |
|-----------|--------|
| New US or criterion | `kiwi_create_test_case` |
| Modified criterion | `kiwi_update_test_case` |
| Abandoned US | `kiwi_disable_test_case` |
| New decision/clarification in design doc | `kiwi_update_test_case` (enrich steps) |

### Step 4 — New Test Run if needed

If the update corresponds to a new sprint or iteration, create a new Test Run.

---

## Test case format

```yaml
summary: "TC-XX — [Short title describing the scenario]"
navigation: "Login → Menu → Feature Screen"
role: "User Role (e.g. Admin, Manager)"
preconditions: |
  - Required user profile (rights, role)
  - Required data in database
  - Required feature flags
steps:
  - action: "Concrete action in business language"
    expected_result: "What the QA must observe"
priority: "P1"
notes: "Edge case context or dependencies on other TCs"
format: "table"
```

**Language rules:**
- ✅ "Click on the 'Start task' button"
- ✅ "Verify the card is displayed in red"
- ❌ "click on .btn-primary" (no CSS selectors)
- ❌ "check that state.deadline < 24" (no code)

---

## Fixed values for this Kiwi instance

| Field | Value |
|-------|-------|
| Product | ID = `<REPLACE_PRODUCT_ID>` |
| Version | ID = `<REPLACE_VERSION_ID>` |
| case_status CONFIRMED | ID = 2 |
| case_status DISABLED | ID = 3 |
| priority P2 (default) | ID = 2 |
| category --default-- | ID = 1 |

---

## Document locations summary

| Document type | Location | Description |
|--------------|----------|-------------|
| PRD | `docs/prds/**/*.md` | Acceptance criteria per User Story |
| Design document | `docs/plans/*-design.md` | Architecture and approaches |
| Implementation plan | `docs/plans/*.md` | Detailed task list |
| E2E tests (reference) | `tests/` or `playwright/tests/` | Existing automated tests |
