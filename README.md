# kiwi-tcms-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes [Kiwi TCMS](https://kiwitcms.org/) as a set of AI-callable tools. It lets an AI assistant (e.g. Kiro, Cursor, Claude Desktop) create and manage test plans, test cases, test runs, and executions directly from a conversation.

## Features

The server registers the following tools:

### Products & Versions

| Tool | Description |
|---|---|
| `kiwi_list_products` | List all products |
| `kiwi_list_versions` | List versions for a product |

### Test Plans

| Tool | Description |
|---|---|
| `kiwi_list_test_plans` | List test plans, optionally filtered by product |
| `kiwi_create_test_plan` | Create a new test plan |
| `kiwi_update_test_plan` | Update plan name, description, or deactivate |
| `kiwi_add_case_to_plan` | Add an existing test case to a plan |
| `kiwi_remove_case_from_plan` | Unlink a test case from a plan |

### Test Cases

| Tool | Description |
|---|---|
| `kiwi_list_test_cases` | List test cases in a test plan |
| `kiwi_get_test_case` | Get full details (steps, notes, priority, tags) |
| `kiwi_create_test_case` | Create a test case with steps, navigation, role, priority, and format (table/list) |
| `kiwi_update_test_case` | Update an existing test case |
| `kiwi_disable_test_case` | Disable a test case that is no longer relevant |

### Tags

| Tool | Description |
|---|---|
| `kiwi_add_tag` | Add one or more tags to a test case |
| `kiwi_remove_tag` | Remove tags from a test case |
| `kiwi_list_tags` | List all tags on a test case |

### Test Runs & Executions

| Tool | Description |
|---|---|
| `kiwi_list_builds` | List builds for a product version |
| `kiwi_create_build` | Create a new build for a version |
| `kiwi_create_test_run` | Create a test run (campaign) from a test plan |
| `kiwi_list_test_runs` | List test runs, optionally filtered by plan |
| `kiwi_list_test_executions` | List executions in a run with their status |
| `kiwi_update_test_execution` | Mark execution as PASSED, FAILED, BLOCKED, WAIVED, ERROR, or IDLE |
| `kiwi_add_execution_comment` | Add a comment to a test execution |

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

This installs `@modelcontextprotocol/sdk`, `node-fetch`, and `zod`.

## Configuration

The server reads credentials from environment variables. Each user sets `KIWI_URL`, `KIWI_USERNAME`, and `KIWI_PASSWORD` as system/user environment variables on their own machine, then references them in the MCP config using `${VAR}` syntax. No credentials are hardcoded or committed.

| Variable | Required | Description |
|---|---|---|
| `KIWI_URL` | ✅ | Base URL of your Kiwi TCMS instance |
| `KIWI_USERNAME` | ✅ | Login username |
| `KIWI_PASSWORD` | ✅ | Login password |

### Setup (per user)

**1. Set environment variables on your machine:**

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

**2. Reference them in your MCP config** (`.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`):

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

## Cursor AI Skill

A ready-to-use [Cursor agent skill](https://docs.cursor.com/context/rules-for-ai) is included in `skills/kiwi-tcms-test-generation/SKILL.md`. Once installed, you can ask Cursor to generate and push a full test plan from a feature branch with a single prompt.

### What the skill does

- Reads your PRD, design docs, and implementation plans
- Extracts test scenarios (happy path, edge cases, access control, regressions)
- Pushes test cases to Kiwi TCMS via the MCP tools
- Supports both **new generation** and **updating after a doc change**

### Installation

**1. Copy the skill to the Cursor global skills folder:**

```bash
mkdir -p ~/.agents/skills/kiwi-tcms-test-generation
cp skills/kiwi-tcms-test-generation/SKILL.md \
   ~/.agents/skills/kiwi-tcms-test-generation/SKILL.md
```

**2. Edit the copied file and replace all placeholders** (search for `<REPLACE_`):

| Placeholder | Description | Example |
|---|---|---|
| `<REPLACE_KIWI_URL>` | Base URL of your Kiwi TCMS instance | `https://tcms.example.com` |
| `<REPLACE_MCP_SERVER_PATH>` | Absolute path to `src/index.js` on your machine | `/home/alice/kiwi-tcms-mcp/src/index.js` |

**3. Make sure the MCP server is registered** in your IDE's MCP config (see integration section above).

**4. Restart your IDE** for the skill and the MCP server to be picked up.

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

1. On first tool call the server authenticates with `Auth.login` and stores the session cookie.
2. Every subsequent call reuses that session — no re-login overhead.
3. Tools communicate with the Kiwi TCMS [JSON-RPC API](https://kiwitcms.readthedocs.io/en/latest/api/index.html) (`POST /json-rpc/`).
4. Test case content (steps, preconditions) is stored in the `text` field as formatted HTML (table or list format).
5. Notes and priority use Kiwi's dedicated fields rather than being embedded in the text body.
