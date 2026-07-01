import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import https from 'https';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env file from the project root (relative to this script)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// Allow self-signed certificates for self-hosted Kiwi TCMS instances
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const KIWI_URL = process.env.KIWI_URL?.replace(/\/$/, '') ?? '';
const KIWI_USERNAME = process.env.KIWI_USERNAME ?? '';
const KIWI_PASSWORD = process.env.KIWI_PASSWORD ?? '';

let sessionId = null;
let rpcId = 1;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

async function rpc(method, params = []) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Cookie'] = `sessionid=${sessionId}`;

  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
  const res = await fetch(`${KIWI_URL}/json-rpc/`, { method: 'POST', headers, body, agent: httpsAgent });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const json = await res.json();
  if (json.error) throw new Error(`RPC error [${json.error.code}]: ${json.error.message}`);
  return json.result;
}

async function ensureLoggedIn() {
  if (sessionId) return;
  const result = await rpc('Auth.login', [KIWI_USERNAME, KIWI_PASSWORD]);
  // Auth.login returns the session key directly
  sessionId = result;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'kiwi-tcms',
  version: '1.0.0',
});

// --- kiwi_list_products ---
server.tool(
  'kiwi_list_products',
  'List all products in Kiwi TCMS',
  {},
  async () => {
    await ensureLoggedIn();
    const products = await rpc('Product.filter', [{}]);
    const lines = products.map(p => `ID ${p.id}: ${p.name}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No products found.' }] };
  }
);

// --- kiwi_list_versions ---
server.tool(
  'kiwi_list_versions',
  'List versions for a given product',
  { product_id: z.number().describe('Product ID') },
  async ({ product_id }) => {
    await ensureLoggedIn();
    const versions = await rpc('Version.filter', [{ product: product_id }]);
    const lines = versions.map(v => `ID ${v.id}: ${v.value}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No versions found.' }] };
  }
);

// --- kiwi_list_test_plans ---
server.tool(
  'kiwi_list_test_plans',
  'List existing test plans, optionally filtered by product',
  { product_id: z.number().optional().describe('Filter by product ID (optional)') },
  async ({ product_id }) => {
    await ensureLoggedIn();
    const filter = product_id ? { product: product_id } : {};
    const plans = await rpc('TestPlan.filter', [filter]);
    const lines = plans.map(p => `ID ${p.id}: ${p.name} (product: ${p.product})`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No test plans found.' }] };
  }
);

// --- kiwi_create_test_plan ---
server.tool(
  'kiwi_create_test_plan',
  'Create a test plan in Kiwi TCMS for a feature/ticket',
  {
    name: z.string().describe('Test plan name, e.g. "ADS-1697 — Line Maintenance V1"'),
    product_id: z.number().describe('Product ID (from kiwi_list_products)'),
    product_version_id: z.number().describe('Product version ID (from kiwi_list_versions)'),
    text: z.string().optional().describe('Description / scope of the test plan'),
  },
  async ({ name, product_id, product_version_id, text }) => {
    await ensureLoggedIn();

    // type 1 = "Unit" — most instances have it. We use it as default.
    const plan = await rpc('TestPlan.create', [{
      name,
      product: product_id,
      product_version: product_version_id,
      type: 1,
      is_active: true,
      text: text ?? '',
    }]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Plan created: ID=${plan.id} — "${plan.name}"\nURL: ${KIWI_URL}/plan/${plan.id}/`,
      }],
    };
  }
);

// --- kiwi_update_test_plan ---
server.tool(
  'kiwi_update_test_plan',
  'Update an existing test plan: name, description, or active status',
  {
    plan_id: z.number().describe('Test plan ID to update'),
    name: z.string().optional().describe('New name for the test plan'),
    text: z.string().optional().describe('Updated description / scope'),
    is_active: z.boolean().optional().describe('Set to false to deactivate the plan'),
  },
  async ({ plan_id, name, text, is_active }) => {
    await ensureLoggedIn();
    const updateParams = {};
    if (name) updateParams.name = name;
    if (text !== undefined) updateParams.text = text;
    if (is_active !== undefined) updateParams.is_active = is_active;
    await rpc('TestPlan.update', [plan_id, updateParams]);
    return {
      content: [{
        type: 'text',
        text: `✅ Test Plan ID=${plan_id} updated.\n  URL: ${KIWI_URL}/plan/${plan_id}/`,
      }],
    };
  }
);

// --- kiwi_remove_case_from_plan ---
server.tool(
  'kiwi_remove_case_from_plan',
  'Remove a test case from a test plan (unlink, does not delete the test case)',
  {
    plan_id: z.number().describe('Test plan ID'),
    case_id: z.number().describe('Test case ID to remove from the plan'),
  },
  async ({ plan_id, case_id }) => {
    await ensureLoggedIn();
    await rpc('TestPlan.remove_case', [plan_id, case_id]);
    return {
      content: [{
        type: 'text',
        text: `✅ Test Case ID=${case_id} removed from Plan ID=${plan_id}.`,
      }],
    };
  }
);

// --- kiwi_add_case_to_plan ---
server.tool(
  'kiwi_add_case_to_plan',
  'Add an existing test case to a test plan',
  {
    plan_id: z.number().describe('Test plan ID'),
    case_id: z.number().describe('Test case ID to add to the plan'),
  },
  async ({ plan_id, case_id }) => {
    await ensureLoggedIn();
    await rpc('TestPlan.add_case', [plan_id, case_id]);
    return {
      content: [{
        type: 'text',
        text: `✅ Test Case ID=${case_id} added to Plan ID=${plan_id}.`,
      }],
    };
  }
);

// --- kiwi_create_test_case ---
server.tool(
  'kiwi_create_test_case',
  'Create a test case with numbered steps and add it to a test plan',
  {
    plan_id: z.number().describe('Test plan ID to attach this test case to'),
    summary: z.string().describe('Short title of the test case, e.g. "TC-01 — Verify Dashboard displays after login"'),
    product_id: z.number().describe('Product ID'),
    preconditions: z.string().optional().describe('Preconditions / setup required before the test'),
    steps: z.array(z.object({
      action: z.string().describe('Action to perform (visible to QA)'),
      expected_result: z.string().describe('Expected result after this action'),
    })).describe('List of numbered steps with action and expected result'),
    notes: z.string().optional().describe('Additional notes, linked ticket (e.g. ADS-1697), or context'),
    format: z.enum(['table', 'list']).optional().describe('Output format: "table" (HTML table) or "list" (bold labels). Defaults to "table"'),
    navigation: z.string().optional().describe('Navigation path to reach the screen, e.g. "Login → Menu → Daily Roaster"'),
    role: z.string().optional().describe('User role for this test, e.g. "Sales Manager (SM)"'),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority level: P1 (highest) to P4 (lowest). Defaults to P2'),
  },
  async ({ plan_id, summary, product_id, preconditions, steps, notes, format, navigation, role, priority }) => {
    await ensureLoggedIn();

    // Build formatted text based on chosen format
    const useTable = (format ?? 'table') === 'table';

    let fullText = '';
    if (useTable) {
      // Table format (TC-2437 style)
      const header = [
        navigation ? `<b>Navigation:</b> ${navigation}` : '',
        role ? `<b>Role:</b> ${role}` : '',
      ].filter(Boolean).join('\n');

      const preText = preconditions ? `<b>Prerequisites:</b>\n${preconditions}` : '';

      const tableRows = steps
        .map((s, i) => `<tr><td>${i + 1}</td><td>${s.action}</td><td>${s.expected_result}</td></tr>`)
        .join('\n');

      const table = `<table border="1">\n<tr><th>Step No.</th><th>Action</th><th>Expected Behavior</th></tr>\n${tableRows}\n</table>`;

      fullText = [header, preText, table].filter(Boolean).join('\n\n');
    } else {
      // List format (bold labels style)
      const stepsHtml = steps
        .map((s, i) => `<b>Step ${i + 1}:</b>\n<b>Action:</b> ${s.action}\n<b>Expected Result:</b> ${s.expected_result}`)
        .join('\n\n');

      fullText = [
        preconditions ? `<b>Preconditions:</b>\n${preconditions}` : '',
        stepsHtml ? `<b>Steps:</b>\n\n${stepsHtml}` : '',
      ].filter(Boolean).join('\n\n');
    }

    // Get or create category "Regression" for this product
    let categoryId;
    try {
      const categories = await rpc('Category.filter', [{ product: product_id }]);
      const regression = categories.find(c =>
        c.name?.toLowerCase().includes('regression') ||
        c.name?.toLowerCase().includes('--')
      ) ?? categories[0];
      categoryId = regression?.id;
    } catch {
      // ignore if category fetch fails
    }

    // case_status 2 = CONFIRMED, category falls back to 1 (--default--)
    const priorityMap = { P1: 1, P2: 2, P3: 3, P4: 4 };
    const caseParams = {
      summary,
      product: product_id,
      category: categoryId ?? 1,
      case_status: 2,
      priority: priorityMap[priority ?? 'P2'],
      text: fullText,
      notes: notes ?? '',
    };

    const tc = await rpc('TestCase.create', [caseParams]);

    // Link to the test plan
    await rpc('TestPlan.add_case', [plan_id, tc.id]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Case created & linked to plan ${plan_id}:\n  ID=${tc.id} — "${tc.summary}"\n  URL: ${KIWI_URL}/case/${tc.id}/`,
      }],
    };
  }
);

// --- kiwi_list_test_cases ---
server.tool(
  'kiwi_list_test_cases',
  'List test cases in a test plan with their IDs and summaries',
  { plan_id: z.number().describe('Test plan ID') },
  async ({ plan_id }) => {
    await ensureLoggedIn();
    const cases = await rpc('TestCase.filter', [{ plan: plan_id }]);
    if (!cases.length) return { content: [{ type: 'text', text: 'No test cases found in this plan.' }] };
    const lines = cases.map(c => `ID=${c.id} | ${c.summary}`).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }
);

// --- kiwi_get_test_case ---
server.tool(
  'kiwi_get_test_case',
  'Get full details of a test case including steps, preconditions, notes, priority, and tags',
  {
    case_id: z.number().describe('Test case ID to retrieve'),
  },
  async ({ case_id }) => {
    await ensureLoggedIn();
    const cases = await rpc('TestCase.filter', [{ id: case_id }]);
    if (!cases.length) return { content: [{ type: 'text', text: `No test case found with ID=${case_id}.` }] };

    const tc = cases[0];
    const tags = await rpc('Tag.filter', [{ case: case_id }]);
    const tagNames = tags.map(t => t.name).join(', ') || 'None';

    const priorityMap = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' };
    const statusMap = { 1: 'PROPOSED', 2: 'CONFIRMED', 3: 'DISABLED' };

    const output = [
      `ID: ${tc.id}`,
      `Summary: ${tc.summary}`,
      `Product: ${tc.product}`,
      `Priority: ${priorityMap[tc.priority] ?? tc.priority}`,
      `Status: ${statusMap[tc.case_status] ?? tc.case_status}`,
      `Category: ${tc.category}`,
      `Tags: ${tagNames}`,
      `Notes: ${tc.notes || '—'}`,
      ``,
      `--- Text/Steps ---`,
      tc.text || '(empty)',
    ].join('\n');

    return { content: [{ type: 'text', text: output }] };
  }
);

// --- kiwi_update_test_case ---
server.tool(
  'kiwi_update_test_case',
  'Update an existing test case: summary, preconditions, steps, notes',
  {
    case_id: z.number().describe('Test case ID to update'),
    summary: z.string().optional().describe('New title for the test case'),
    preconditions: z.string().optional().describe('Updated preconditions'),
    steps: z.array(z.object({
      action: z.string(),
      expected_result: z.string(),
    })).optional().describe('New list of steps (replaces existing steps)'),
    notes: z.string().optional().describe('Updated notes'),
    format: z.enum(['table', 'list']).optional().describe('Output format: "table" (HTML table) or "list" (bold labels). Defaults to "table"'),
    navigation: z.string().optional().describe('Navigation path to reach the screen, e.g. "Login → Menu → Daily Roaster"'),
    role: z.string().optional().describe('User role for this test, e.g. "Sales Manager (SM)"'),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority level: P1 (highest) to P4 (lowest)'),
  },
  async ({ case_id, summary, preconditions, steps, notes, format, navigation, role, priority }) => {
    await ensureLoggedIn();

    const updateParams = {};
    if (summary) updateParams.summary = summary;
    if (notes !== undefined) updateParams.notes = notes;
    if (priority) {
      const priorityMap = { P1: 1, P2: 2, P3: 3, P4: 4 };
      updateParams.priority = priorityMap[priority];
    }

    // Build formatted text based on chosen format
    if (steps || preconditions) {
      const useTable = (format ?? 'table') === 'table';

      let fullText = '';
      if (useTable) {
        const header = [
          navigation ? `<b>Navigation:</b> ${navigation}` : '',
          role ? `<b>Role:</b> ${role}` : '',
        ].filter(Boolean).join('\n');

        const preText = preconditions ? `<b>Prerequisites:</b>\n${preconditions}` : '';

        const tableRows = steps
          ? steps.map((s, i) => `<tr><td>${i + 1}</td><td>${s.action}</td><td>${s.expected_result}</td></tr>`).join('\n')
          : '';

        const table = tableRows
          ? `<table border="1">\n<tr><th>Step No.</th><th>Action</th><th>Expected Behavior</th></tr>\n${tableRows}\n</table>`
          : '';

        fullText = [header, preText, table].filter(Boolean).join('\n\n');
      } else {
        const stepsHtml = steps
          ? steps.map((s, i) => `<b>Step ${i + 1}:</b>\n<b>Action:</b> ${s.action}\n<b>Expected Result:</b> ${s.expected_result}`).join('\n\n')
          : '';

        fullText = [
          preconditions ? `<b>Preconditions:</b>\n${preconditions}` : '',
          stepsHtml ? `<b>Steps:</b>\n\n${stepsHtml}` : '',
        ].filter(Boolean).join('\n\n');
      }

      updateParams.text = fullText;
    }

    await rpc('TestCase.update', [case_id, updateParams]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Case ID=${case_id} updated.\n  URL: ${KIWI_URL}/case/${case_id}/`,
      }],
    };
  }
);

// --- kiwi_add_tag ---
server.tool(
  'kiwi_add_tag',
  'Add one or more tags to a test case',
  {
    case_id: z.number().describe('Test case ID'),
    tags: z.array(z.string()).describe('List of tag names to add, e.g. ["SalesApp", "Daily Roaster", "edge-case"]'),
  },
  async ({ case_id, tags }) => {
    await ensureLoggedIn();
    for (const tag of tags) {
      await rpc('TestCase.add_tag', [case_id, tag]);
    }
    return {
      content: [{
        type: 'text',
        text: `✅ Tags added to TC-${case_id}: ${tags.join(', ')}`,
      }],
    };
  }
);

// --- kiwi_remove_tag ---
server.tool(
  'kiwi_remove_tag',
  'Remove one or more tags from a test case',
  {
    case_id: z.number().describe('Test case ID'),
    tags: z.array(z.string()).describe('List of tag names to remove'),
  },
  async ({ case_id, tags }) => {
    await ensureLoggedIn();
    for (const tag of tags) {
      await rpc('TestCase.remove_tag', [case_id, tag]);
    }
    return {
      content: [{
        type: 'text',
        text: `✅ Tags removed from TC-${case_id}: ${tags.join(', ')}`,
      }],
    };
  }
);

// --- kiwi_list_tags ---
server.tool(
  'kiwi_list_tags',
  'List all tags on a test case',
  {
    case_id: z.number().describe('Test case ID'),
  },
  async ({ case_id }) => {
    await ensureLoggedIn();
    const tags = await rpc('Tag.filter', [{ case: case_id }]);
    const names = tags.map(t => t.name).join(', ');
    return {
      content: [{
        type: 'text',
        text: names ? `Tags on TC-${case_id}: ${names}` : `No tags on TC-${case_id}.`,
      }],
    };
  }
);

// --- kiwi_disable_test_case ---
server.tool(
  'kiwi_disable_test_case',
  'Disable a test case that is no longer relevant (e.g. feature removed)',
  { case_id: z.number().describe('Test case ID to disable') },
  async ({ case_id }) => {
    await ensureLoggedIn();
    // case_status 3 = DISABLED
    await rpc('TestCase.update', [case_id, { case_status: 3 }]);
    return { content: [{ type: 'text', text: `✅ Test Case ID=${case_id} disabled.` }] };
  }
);

// --- kiwi_create_test_run ---
server.tool(
  'kiwi_create_test_run',
  'Create a test run (campaign) from a test plan so QA can execute tests',
  {
    plan_id: z.number().describe('Test plan ID'),
    summary: z.string().describe('Test run name, e.g. "ADS-1697 — Sprint 2026-W12"'),
    build_id: z.number().describe('Build ID (from kiwi_list_builds)'),
    notes: z.string().optional().describe('Notes about this test run'),
  },
  async ({ plan_id, summary, build_id, notes }) => {
    await ensureLoggedIn();
    const run = await rpc('TestRun.create', [{
      plan: plan_id,
      summary,
      build: build_id,
      notes: notes ?? '',
      manager: KIWI_USERNAME,
    }]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Run created:\n  ID=${run.id} — "${run.summary}"\n  URL: ${KIWI_URL}/runs/${run.id}/`,
      }],
    };
  }
);

// --- kiwi_list_builds ---
server.tool(
  'kiwi_list_builds',
  'List builds for a product version',
  { version_id: z.number().describe('Version ID (from kiwi_list_versions)') },
  async ({ version_id }) => {
    await ensureLoggedIn();
    const builds = await rpc('Build.filter', [{ version: version_id }]);
    const lines = builds.map(b => `ID ${b.id}: ${b.name}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No builds found.' }] };
  }
);

// --- kiwi_list_test_runs ---
server.tool(
  'kiwi_list_test_runs',
  'List test runs, optionally filtered by plan or status',
  {
    plan_id: z.number().optional().describe('Filter by test plan ID'),
  },
  async ({ plan_id }) => {
    await ensureLoggedIn();
    const filter = plan_id ? { plan: plan_id } : {};
    const runs = await rpc('TestRun.filter', [filter]);
    if (!runs.length) return { content: [{ type: 'text', text: 'No test runs found.' }] };
    const lines = runs.map(r => `ID=${r.id} | ${r.summary} (plan: ${r.plan})`).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }
);

// --- kiwi_list_test_executions ---
server.tool(
  'kiwi_list_test_executions',
  'List test executions in a test run with their status',
  {
    run_id: z.number().describe('Test run ID'),
  },
  async ({ run_id }) => {
    await ensureLoggedIn();
    const executions = await rpc('TestExecution.filter', [{ run: run_id }]);
    if (!executions.length) return { content: [{ type: 'text', text: 'No executions found in this run.' }] };
    const statusMap = { 0: 'IDLE', 1: 'PASSED', 2: 'BLOCKED', 4: 'WAIVED', 5: 'ERROR', 6: 'FAILED' };
    const lines = executions.map(e =>
      `ID=${e.id} | Case=${e.case} | Status: ${statusMap[e.status] ?? e.status} | Assignee: ${e.assignee || '—'}`
    ).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }
);

// --- kiwi_update_test_execution ---
server.tool(
  'kiwi_update_test_execution',
  'Update a test execution status (PASS, FAIL, BLOCKED, etc.)',
  {
    execution_id: z.number().describe('Test execution ID'),
    status: z.enum(['IDLE', 'PASSED', 'BLOCKED', 'WAIVED', 'ERROR', 'FAILED']).describe('New execution status'),
  },
  async ({ execution_id, status }) => {
    await ensureLoggedIn();
    const statusMap = { IDLE: 0, PASSED: 1, BLOCKED: 2, WAIVED: 4, ERROR: 5, FAILED: 6 };
    await rpc('TestExecution.update', [execution_id, { status: statusMap[status] }]);
    return {
      content: [{
        type: 'text',
        text: `✅ Execution ID=${execution_id} marked as ${status}.`,
      }],
    };
  }
);

// --- kiwi_add_execution_comment ---
server.tool(
  'kiwi_add_execution_comment',
  'Add a comment to a test execution (e.g. defect notes, failure reason)',
  {
    execution_id: z.number().describe('Test execution ID'),
    comment: z.string().describe('Comment text to add'),
  },
  async ({ execution_id, comment }) => {
    await ensureLoggedIn();
    await rpc('TestExecution.add_comment', [execution_id, comment]);
    return {
      content: [{
        type: 'text',
        text: `✅ Comment added to Execution ID=${execution_id}.`,
      }],
    };
  }
);

// --- kiwi_create_build ---
server.tool(
  'kiwi_create_build',
  'Create a new build for a product version',
  {
    version_id: z.number().describe('Version ID (from kiwi_list_versions)'),
    name: z.string().describe('Build name, e.g. "Sprint 2026-W27" or "v14.30.1"'),
  },
  async ({ version_id, name }) => {
    await ensureLoggedIn();
    const build = await rpc('Build.create', [{ version: version_id, name }]);
    return {
      content: [{
        type: 'text',
        text: `✅ Build created: ID=${build.id} — "${build.name}"`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
