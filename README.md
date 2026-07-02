# kiwi-tcms-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes [Kiwi TCMS](https://kiwitcms.org/) as a set of AI-callable tools. It lets an AI assistant (e.g. Kiro, Cursor, Claude Desktop) create and manage test plans, test cases, test runs, and executions directly from a conversation.

## Features

The server registers **50+ tools** covering the full Kiwi TCMS lifecycle:

### Products & Versions

| Tool | Description |
|---|---|
| `kiwi_list_products` | List all products |
| `kiwi_list_versions` | List versions for a product |

### Test Plans

| Tool | Description |
|---|---|
| `kiwi_list_test_plans` | List test plans, optionally filtered by product |
| `kiwi_get_test_plan` | Get full details of a test plan (name, description, product, version, active status) |
| `kiwi_create_test_plan` | Create a new test plan |
| `kiwi_update_test_plan` | Update plan name, description, or deactivate |
| `kiwi_add_case_to_plan` | Add an existing test case to a plan |
| `kiwi_remove_case_from_plan` | Unlink a test case from a plan |
| `kiwi_plan_tree` | Get plan hierarchy (parent/child plans) |
| `kiwi_update_case_order` | Reorder test cases within a plan by setting sort keys |
| `kiwi_add_plan_attachment` | Upload a file attachment to a test plan |
| `kiwi_list_plan_attachments` | List attachments on a test plan |
| `kiwi_add_plan_tag` | Add tags to a test plan |
| `kiwi_remove_plan_tag` | Remove tags from a test plan |

### Test Cases

| Tool | Description |
|---|---|
| `kiwi_list_test_cases` | List test cases in a test plan |
| `kiwi_get_test_case_full` | Fetch ALL data: summary, steps, tags, attachments (with URLs), priority, status, notes, category, author |
| `kiwi_create_test_case` | Create a test case with steps, navigation, role, priority, and format (table/list) |
| `kiwi_reformat_test_case` | Non-destructive reformat & push — updates only specified fields, builds HTML table from structured steps |
| `kiwi_disable_test_case` | Disable a test case that is no longer relevant |
| `kiwi_list_disabled_cases` | List all disabled test cases, optionally filtered by product or plan |
| `kiwi_search_test_cases` | Search by product, plan, status, priority, tag, or summary keyword |

### Tags & Components

| Tool | Description |
|---|---|
| `kiwi_add_tag` | Add one or more tags to a test case |
| `kiwi_remove_tag` | Remove tags from a test case |
| `kiwi_list_tags` | List all tags on a test case |
| `kiwi_add_component` | Link a component (module/feature) to a test case |
| `kiwi_remove_component` | Unlink a component from a test case |

### Test Case Metadata

| Tool | Description |
|---|---|
| `kiwi_add_case_comment` | Add a comment to a test case |
| `kiwi_list_case_comments` | List comments on a test case |
| `kiwi_add_attachment` | Upload a file attachment to a test case |
| `kiwi_list_attachments` | List all attachments on a test case |
| `kiwi_case_history` | Get audit trail — who changed what and when |
| `kiwi_case_properties` | List custom key-value properties |
| `kiwi_add_case_property` | Add a custom property |
| `kiwi_remove_case_property` | Remove a custom property |

### Test Runs

| Tool | Description |
|---|---|
| `kiwi_list_builds` | List builds for a product version |
| `kiwi_create_build` | Create a new build for a version |
| `kiwi_create_test_run` | Create a test run (campaign) from a test plan |
| `kiwi_update_test_run` | Update a test run: name, notes, or stop date |
| `kiwi_list_test_runs` | List test runs, optionally filtered by plan |
| `kiwi_add_case_to_run` | Add a test case to a test run |
| `kiwi_remove_case_from_run` | Remove a test case from a test run |
| `kiwi_get_run_cases` | Get test cases included in a test run |
| `kiwi_add_run_tag` | Add tags to a test run |
| `kiwi_remove_run_tag` | Remove tags from a test run |
| `kiwi_add_run_cc` | Add notification subscribers |
| `kiwi_get_run_cc` | List notification subscribers |
| `kiwi_remove_run_cc` | Remove a subscriber |
| `kiwi_add_run_attachment` | Upload a file attachment to a test run |
| `kiwi_list_run_attachments` | List attachments on a test run |

### Test Executions

| Tool | Description |
|---|---|
| `kiwi_list_test_executions` | List executions in a run with their status |
| `kiwi_update_test_execution` | Mark execution as PASSED, FAILED, BLOCKED, WAIVED, ERROR, or IDLE |
| `kiwi_add_execution_comment` | Add a comment to a test execution |
| `kiwi_list_execution_comments` | Read comments on a test execution |
| `kiwi_add_execution_link` | Add a URL link (bug tracker, CI build, etc.) |
| `kiwi_list_execution_links` | List URL links on a test execution |
| `kiwi_remove_execution_link` | Remove a URL link |
| `kiwi_add_execution_attachment` | Upload a file attachment (evidence) |
| `kiwi_list_execution_attachments` | List attachments on a test execution |
| `kiwi_add_execution_tag` | Add tags to a test execution |
| `kiwi_remove_execution_tag` | Remove tags from a test execution |
| `kiwi_execution_history` | Get audit trail for a test execution |

### Reporting & Analytics

| Tool | Description |
|---|---|
| `kiwi_test_run_report` | Generate a test run report with pass/fail statistics (summary, detailed, or JSON) |
| `kiwi_test_plan_metrics` | Get plan metrics: total cases, status breakdown, priority distribution, coverage |

### Users & Bugs

| Tool | Description |
|---|---|
| `kiwi_list_users` | List/search users in Kiwi TCMS |
| `kiwi_bug_details` | Get bug details from the configured bug tracker |
| `kiwi_bug_report` | Report a bug from a test execution |

## Test Case Formatting

Test cases support two output formats via the `format` parameter:

- **`table`** (default) — HTML table with Step No. | Action | Expected Behavior columns, plus Navigation and Role headers
- **`list`** — Bold labels style (Step 1: / Action: / Expected Result:)

Additional fields:
- `navigation` — Path to reach the screen (e.g. "Login → Menu → Daily Roaster")
- `role` — User role for the test (e.g. "Sales Manager (SM)")
- `priority` — P1 (highest) to P4 (lowest), defaults to P2
- `notes` — Stored in Kiwi's dedicated notes field (not embedded in the text body)

## Requirements

- Node.js 18+
- A running Kiwi TCMS instance (self-hosted or cloud)

## Installation

```bash
npm install
```

This installs `@modelcontextprotocol/sdk`, `node-fetch`, `zod`, and `dotenv`.

## Configuration

The server reads credentials from environment variables. You can either set system/user environment variables on your machine, or create a `.env` file in the project root (automatically loaded via `dotenv`). For MCP configs, reference them using `${VAR}` syntax. No credentials are hardcoded or committed.

| Variable | Required | Description |
|---|---|---|
| `KIWI_URL` | ✅ | Base URL of your Kiwi TCMS instance |
| `KIWI_USERNAME` | ✅ | Login username |
| `KIWI_PASSWORD` | ✅ | Login password |

### Setup (per user)

**Option A — Use a `.env` file** (simplest for local development):

Create a `.env` file in the project root:
```env
KIWI_URL=https://your-kiwi-instance
KIWI_USERNAME=your_user
KIWI_PASSWORD=your_pass
```

> Make sure `.env` is in `.gitignore` to avoid committing credentials.

**Option B — Set system environment variables:**

Windows (run in PowerShell as admin, or via System Settings → Environment Variables):
```powershell
[System.Environment]::SetEnvironmentVariable('KIWI_URL', 'https://your-kiwi-instance', 'User')
[System.Environment]::SetEnvironmentVariable('KIWI_USERNAME', 'your_user', 'User')
[System.Environment]::SetEnvironmentVariable('KIWI_PASSWORD', 'your_pass', 'User')
```

macOS/Linux (add to `~/.bashrc`, `~/.zshrc`, or equivalent):
```bash
export KIWI_URL="https://your-kiwi-instance"
export KIWI_USERNAME="your_user"
export KIWI_PASSWORD="your_pass"
```

**Then, reference them in your MCP config** (`.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "kiwi-tcms": {
      "command": "node",
      "args": ["/absolute/path/to/kiwi-tcms-mcp/src/index.js"],
      "env": {
        "KIWI_URL": "${KIWI_URL}",
        "KIWI_USERNAME": "${KIWI_USERNAME}",
        "KIWI_PASSWORD": "${KIWI_PASSWORD}"
      }
    }
  }
}
```

Kiro expands `${VAR}` at runtime from your system environment. Nothing sensitive is stored in the repo.

> Self-signed TLS certificates are accepted automatically, which is useful for self-hosted instances.

## Usage

### Running the server directly

```bash
KIWI_URL=https://your-kiwi-instance \
KIWI_USERNAME=your_user \
KIWI_PASSWORD=your_pass \
npm start
```

The server communicates over **stdio** using the MCP protocol.

### Kiro / Cursor / Claude Desktop integration

Add the server to your MCP configuration file (e.g. `.kiro/settings/mcp.json`, `~/.cursor/mcp.json`, or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kiwi-tcms": {
      "command": "node",
      "args": ["/absolute/path/to/kiwi-tcms-mcp/src/index.js"],
      "env": {
        "KIWI_URL": "${KIWI_URL}",
        "KIWI_USERNAME": "${KIWI_USERNAME}",
        "KIWI_PASSWORD": "${KIWI_PASSWORD}"
      }
    }
  }
}
```

Once configured, you can ask the AI to create test plans and cases in natural language:

> "Generate test cases for ADS-1697 and push them to Kiwi TCMS under the AWA product."

## AI Skill (Kiro / Cursor)

A ready-to-use AI skill is included in `skills/kiwi-tcms-test-generation/SKILL.md`. It works with Kiro (as a bundled skill) and Cursor (via the [agent skills](https://docs.cursor.com/context/rules-for-ai) mechanism). Once installed, you can generate and push a full test plan from a feature branch with a single prompt.

### What the skill does

- Reads your PRD, design docs, and implementation plans
- Extracts test scenarios (happy path, edge cases, access control, regressions)
- Pushes test cases to Kiwi TCMS via the MCP tools
- Supports both **new generation** and **updating after a doc change**

### Installation

**For Kiro:** The skill is bundled with this repo and automatically available when the MCP server is configured in your workspace.

**For Cursor:**

1. Copy the skill to the Cursor global skills folder:

```bash
mkdir -p ~/.agents/skills/kiwi-tcms-test-generation
cp skills/kiwi-tcms-test-generation/SKILL.md \
   ~/.agents/skills/kiwi-tcms-test-generation/SKILL.md
```

2. Edit the copied file and replace all placeholders (search for `<REPLACE_`):

| Placeholder | Description | Example |
|---|---|---|
| `<REPLACE_KIWI_URL>` | Base URL of your Kiwi TCMS instance | `https://tcms.example.com` |
| `<REPLACE_MCP_SERVER_PATH>` | Absolute path to `src/index.js` on your machine | `/home/alice/kiwi-tcms-mcp/src/index.js` |

3. Make sure the MCP server is registered in your IDE's MCP config (see integration section above).

4. Restart your IDE for the skill and the MCP server to be picked up.

### Usage

Once installed, trigger it with a natural language prompt:

> "Generate tests for ADS-1234 and push them to Kiwi TCMS."  
> "Update Kiwi tests after the PRD change on ADS-1234."

## Project structure

```
src/
  index.js                              # MCP server — tool definitions and JSON-RPC helpers
skills/
  kiwi-tcms-test-generation/
    SKILL.md                            # AI skill template (copy to ~/.agents/skills/)
package.json
```

## How it works

1. On startup, the server authenticates with `Auth.login` and stores the session cookie.
2. A `rpcSafe` wrapper handles session expiry — if a 403 is returned, it re-authenticates once and retries.
3. All tool handlers are wrapped in an error handler that catches exceptions and returns them as MCP error content (no crashes).
4. Tag and multi-item operations run in parallel using `Promise.all` for better performance.
5. Tools communicate with the Kiwi TCMS [JSON-RPC API](https://kiwitcms.readthedocs.io/en/latest/api/index.html) (`POST /json-rpc/`).
6. Test case content (steps, preconditions) is stored in the `text` field as formatted HTML (table or list format).
7. The `kiwi_reformat_test_case` tool is non-destructive — it only updates fields you explicitly provide and preserves everything else.
