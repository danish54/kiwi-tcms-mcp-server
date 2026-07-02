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
// Shared constants
// ---------------------------------------------------------------------------

const PRIORITY_TO_ID = { P1: 1, P2: 2, P3: 3, P4: 4 };
const ID_TO_PRIORITY = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' };
const STATUS_TO_ID = { PROPOSED: 1, CONFIRMED: 2, DISABLED: 3 };
const ID_TO_STATUS = { 1: 'PROPOSED', 2: 'CONFIRMED', 3: 'DISABLED' };
const EXEC_STATUS_TO_ID = { IDLE: 0, PASSED: 1, BLOCKED: 2, WAIVED: 4, ERROR: 5, FAILED: 6 };
const ID_TO_EXEC_STATUS = { 0: 'IDLE', 1: 'PASSED', 2: 'BLOCKED', 4: 'WAIVED', 5: 'ERROR', 6: 'FAILED' };

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
  sessionId = result;
}

// Retry-on-auth-failure wrapper â€” if session expired, re-login once and retry
async function rpcSafe(method, params = []) {
  try {
    return await rpc(method, params);
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('Login required') || err.message?.includes('Authentication failed')) {
      sessionId = null;
      await ensureLoggedIn();
      return await rpc(method, params);
    }
    throw err;
  }
}

// Tool callback wrapper â€” catches errors and returns them as MCP error content
function handler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: 'text', text: `âŒ Error: ${err.message}` }], isError: true };
    }
  };
}

// Parallel tag/multi-item helper
async function forEachParallel(items, fn) {
  await Promise.all(items.map(fn));
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'kiwi-tcms',
  version: '1.0.0',
});

// --- kiwi_list_products ---
server.registerTool('kiwi_list_products', {
  description: 'List all products in Kiwi TCMS',
}, handler(async () => {
  const products = await rpc('Product.filter', [{}]);
  const lines = products.map(p => `ID ${p.id}: ${p.name}`).join('\n');
  return { content: [{ type: 'text', text: lines || 'No products found.' }] };
}));

// --- kiwi_list_versions ---
server.registerTool('kiwi_list_versions', {
  description: 'List versions for a given product',
  inputSchema: { product_id: z.number().describe('Product ID') },
}, handler(async ({ product_id }) => {
  const versions = await rpc('Version.filter', [{ product: product_id }]);
  const lines = versions.map(v => `ID ${v.id}: ${v.value}`).join('\n');
  return { content: [{ type: 'text', text: lines || 'No versions found.' }] };
}));

// --- kiwi_list_test_plans ---
server.registerTool('kiwi_list_test_plans', {
  description: 'List existing test plans, optionally filtered by product',
  inputSchema: { product_id: z.number().optional().describe('Filter by product ID (optional)') },
}, handler(async ({ product_id }) => {
  const filter = product_id ? { product: product_id } : {};
  const plans = await rpc('TestPlan.filter', [filter]);
  const lines = plans.map(p => `ID ${p.id}: ${p.name} (product: ${p.product})`).join('\n');
  return { content: [{ type: 'text', text: lines || 'No test plans found.' }] };
}));

// --- kiwi_get_test_plan ---
server.registerTool('kiwi_get_test_plan', {
  description: 'Get full details of a test plan including name, description, product, version, and active status',
  inputSchema: { plan_id: z.number().describe('Test plan ID to retrieve') },
}, handler(async ({ plan_id }) => {
  const plans = await rpc('TestPlan.filter', [{ id: plan_id }]);
  if (!plans.length) return { content: [{ type: 'text', text: `No test plan found with ID=${plan_id}.` }] };
  const plan = plans[0];
  const output = [
    `ID: ${plan.id}`, `Name: ${plan.name}`,
    `Product: ${plan.product} (version: ${plan.product_version})`,
    `Type: ${plan.type}`, `Active: ${plan.is_active}`,
    `Created: ${plan.create_date || 'â€”'}`, ``,
    `--- Description ---`, plan.text || '(empty)',
  ].join('\n');
  return { content: [{ type: 'text', text: `${output}\n\nURL: ${KIWI_URL}/plan/${plan.id}/` }] };
}));

// --- kiwi_create_test_plan ---
server.registerTool('kiwi_create_test_plan', {
  description: 'Create a test plan in Kiwi TCMS for a feature/ticket',
  inputSchema: {
    name: z.string().describe('Test plan name, e.g. "ADS-1697 â€” Line Maintenance V1"'),
    product_id: z.number().describe('Product ID (from kiwi_list_products)'),
    product_version_id: z.number().describe('Product version ID (from kiwi_list_versions)'),
    text: z.string().optional().describe('Description / scope of the test plan'),
  },
}, handler(async ({ name, product_id, product_version_id, text }) => {
  const plan = await rpc('TestPlan.create', [{
    name, product: product_id, product_version: product_version_id,
    type: 1, is_active: true, text: text ?? '',
  }]);
  return { content: [{ type: 'text', text: `âœ… Test Plan created: ID=${plan.id} â€” "${plan.name}"\nURL: ${KIWI_URL}/plan/${plan.id}/` }] };
}));

// --- kiwi_update_test_plan ---
server.registerTool('kiwi_update_test_plan', {
  description: 'Update an existing test plan: name, description, or active status',
  inputSchema: {
    plan_id: z.number().describe('Test plan ID to update'),
    name: z.string().optional().describe('New name for the test plan'),
    text: z.string().optional().describe('Updated description / scope'),
    is_active: z.boolean().optional().describe('Set to false to deactivate the plan'),
  },
}, handler(async ({ plan_id, name, text, is_active }) => {
  const updateParams = {};
  if (name) updateParams.name = name;
  if (text !== undefined) updateParams.text = text;
  if (is_active !== undefined) updateParams.is_active = is_active;
  await rpc('TestPlan.update', [plan_id, updateParams]);
  return { content: [{ type: 'text', text: `âœ… Test Plan ID=${plan_id} updated.\n  URL: ${KIWI_URL}/plan/${plan_id}/` }] };
}));

// --- kiwi_remove_case_from_plan ---
server.registerTool('kiwi_remove_case_from_plan', {
  description: 'Remove a test case from a test plan (unlink, does not delete the test case)',
  inputSchema: {
    plan_id: z.number().describe('Test plan ID'),
    case_id: z.number().describe('Test case ID to remove from the plan'),
  },
}, handler(async ({ plan_id, case_id }) => {
  await rpc('TestPlan.remove_case', [plan_id, case_id]);
  return { content: [{ type: 'text', text: `âœ… Test Case ID=${case_id} removed from Plan ID=${plan_id}.` }] };
}));

// --- kiwi_add_case_to_plan ---
server.registerTool('kiwi_add_case_to_plan', {
  description: 'Add an existing test case to a test plan',
  inputSchema: {
    plan_id: z.number().describe('Test plan ID'),
    case_id: z.number().describe('Test case ID to add to the plan'),
  },
}, handler(async ({ plan_id, case_id }) => {
  await rpc('TestPlan.add_case', [plan_id, case_id]);
  return { content: [{ type: 'text', text: `âœ… Test Case ID=${case_id} added to Plan ID=${plan_id}.` }] };
}));

// --- kiwi_create_test_case ---
server.registerTool('kiwi_create_test_case', {
  description: 'Create a test case with numbered steps and add it to a test plan',
  inputSchema: {
    plan_id: z.number().describe('Test plan ID to attach this test case to'),
    summary: z.string().describe('Short title of the test case'),
    product_id: z.number().describe('Product ID'),
    preconditions: z.string().optional().describe('Preconditions / setup required before the test'),
    steps: z.array(z.object({
      action: z.string().describe('Action to perform'),
      expected_result: z.string().describe('Expected result after this action'),
    })).describe('List of numbered steps with action and expected result'),
    notes: z.string().optional().describe('Additional notes or context'),
    format: z.enum(['table', 'list']).optional().describe('Output format: "table" (default) or "list"'),
    navigation: z.string().optional().describe('Navigation path to reach the screen'),
    role: z.string().optional().describe('User role for this test'),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority level, defaults to P2'),
  },
}, handler(async ({ plan_id, summary, product_id, preconditions, steps, notes, format, navigation, role, priority }) => {
  const useTable = (format ?? 'table') === 'table';
  let fullText = '';
  if (useTable) {
    const header = [
      navigation ? `<b>Navigation:</b> ${navigation}` : '',
      role ? `<b>Role:</b> ${role}` : '',
    ].filter(Boolean).join('\n');
    const preText = preconditions ? `<b>Prerequisites:</b>\n${preconditions}` : '';
    const tableRows = steps.map((s, i) => `<tr><td>${i + 1}</td><td>${s.action}</td><td>${s.expected_result}</td></tr>`).join('\n');
    const table = `<table border="1">\n<tr><th>Step No.</th><th>Action</th><th>Expected Behavior</th></tr>\n${tableRows}\n</table>`;
    fullText = [header, preText, table].filter(Boolean).join('\n\n');
  } else {
    const stepsHtml = steps.map((s, i) => `<b>Step ${i + 1}:</b>\n<b>Action:</b> ${s.action}\n<b>Expected Result:</b> ${s.expected_result}`).join('\n\n');
    fullText = [
      preconditions ? `<b>Preconditions:</b>\n${preconditions}` : '',
      stepsHtml ? `<b>Steps:</b>\n\n${stepsHtml}` : '',
    ].filter(Boolean).join('\n\n');
  }
  let categoryId;
  try {
    const categories = await rpc('Category.filter', [{ product: product_id }]);
    const regression = categories.find(c => c.name?.toLowerCase().includes('regression') || c.name?.toLowerCase().includes('--')) ?? categories[0];
    categoryId = regression?.id;
  } catch { /* ignore */ }
  const priorityMap = { P1: 1, P2: 2, P3: 3, P4: 4 };
  const tc = await rpc('TestCase.create', [{
    summary, product: product_id, category: categoryId ?? 1,
    case_status: 2, priority: priorityMap[priority ?? 'P2'], text: fullText, notes: notes ?? '',
  }]);
  await rpc('TestPlan.add_case', [plan_id, tc.id]);
  return { content: [{ type: 'text', text: `âœ… Test Case created & linked to plan ${plan_id}:\n  ID=${tc.id} â€” "${tc.summary}"\n  URL: ${KIWI_URL}/case/${tc.id}/` }] };
}));

// --- kiwi_list_test_cases ---
server.registerTool('kiwi_list_test_cases', {
  description: 'List test cases in a test plan with their IDs and summaries',
  inputSchema: { plan_id: z.number().describe('Test plan ID') },
}, handler(async ({ plan_id }) => {
  const cases = await rpc('TestCase.filter', [{ plan: plan_id }]);
  if (!cases.length) return { content: [{ type: 'text', text: 'No test cases found in this plan.' }] };
  const lines = cases.map(c => `ID=${c.id} | ${c.summary}`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_get_test_case_full ---
server.registerTool('kiwi_get_test_case_full', {
  description: 'Fetch ALL data and metadata for a test case in one call: summary, steps, tags, attachments (with URLs for screenshots), priority, status, notes, category, author, product.',
  inputSchema: { case_id: z.number().describe('Test case ID to retrieve') },
}, handler(async ({ case_id }) => {
  const cases = await rpc('TestCase.filter', [{ id: case_id }]);
  if (!cases.length) return { content: [{ type: 'text', text: `No test case found with ID=${case_id}.` }] };
  const tc = cases[0];
  const [tagObjs, attachments] = await Promise.all([
    rpc('Tag.filter', [{ case: case_id }]),
    rpc('TestCase.list_attachments', [case_id]),
  ]);
  const tags = tagObjs.map(t => t.name);
  const attachList = attachments.map(a => {
    // Try common field names for filename and url
    const fname = a.filename || a.file_name || a.name || Object.values(a).find(v => typeof v === 'string' && v.includes('.')) || 'unknown';
    const url = a.url || a.file_url || Object.values(a).find(v => typeof v === 'string' && v.includes('/uploads/')) || '';
    return { id: a.pk || a.id, filename: fname, url, mime_type: a.mime_type || a.content_type || '–' };
  });
  const output = [
    `ID: ${tc.id}`,
    `Summary: ${tc.summary}`,
    `Category: ${tc.category__name || tc.category} (ID: ${tc.category})`,
    `Author: ${tc.author__username || tc.author} (ID: ${tc.author})`,
    `Default Tester: ${tc.default_tester__username || tc.default_tester || '–'}`,
    `Priority: ${tc.priority__value || ID_TO_PRIORITY[tc.priority] || tc.priority}`,
    `Status: ${tc.case_status__name || ID_TO_STATUS[tc.case_status] || tc.case_status}`,
    `Automated: ${tc.is_automated ?? '–'}`,
    `Tags: ${tags.length ? tags.join(', ') : 'None'}`,
    `Notes: ${tc.notes || '–'}`,
    `Extra Link: ${tc.extra_link || '–'}`,
    ``,
    `--- Attachments (${attachList.length}) ---`,
    attachList.length ? attachList.map(a => `  ${a.filename} → ${a.url}`).join('\n') : '  (none)',
    ``,
    `--- Text/Steps ---`,
    tc.text || '(empty)',
  ].join('\n');
  return { content: [{ type: 'text', text: output }] };
}));

// --- kiwi_add_tag ---
server.registerTool('kiwi_add_tag', {
  description: 'Add one or more tags to a test case',
  inputSchema: {
    case_id: z.number().describe('Test case ID'),
    tags: z.array(z.string()).describe('List of tag names to add'),
  },
}, handler(async ({ case_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestCase.add_tag', [case_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags added to TC-${case_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_remove_tag ---
server.registerTool('kiwi_remove_tag', {
  description: 'Remove one or more tags from a test case',
  inputSchema: {
    case_id: z.number().describe('Test case ID'),
    tags: z.array(z.string()).describe('List of tag names to remove'),
  },
}, handler(async ({ case_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestCase.remove_tag', [case_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags removed from TC-${case_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_list_tags ---
server.registerTool('kiwi_list_tags', {
  description: 'List all tags on a test case',
  inputSchema: { case_id: z.number().describe('Test case ID') },
}, handler(async ({ case_id }) => {
  const tags = await rpc('Tag.filter', [{ case: case_id }]);
  const names = tags.map(t => t.name).join(', ');
  return { content: [{ type: 'text', text: names ? `Tags on TC-${case_id}: ${names}` : `No tags on TC-${case_id}.` }] };
}));

// --- kiwi_disable_test_case ---
server.registerTool('kiwi_disable_test_case', {
  description: 'Disable a test case that is no longer relevant (e.g. feature removed)',
  inputSchema: { case_id: z.number().describe('Test case ID to disable') },
}, handler(async ({ case_id }) => {
  await rpc('TestCase.update', [case_id, { case_status: 3 }]);
  return { content: [{ type: 'text', text: `âœ… Test Case ID=${case_id} disabled.` }] };
}));

// --- kiwi_list_disabled_cases ---
server.registerTool('kiwi_list_disabled_cases', {
  description: 'List all disabled test cases, optionally filtered by product or test plan',
  inputSchema: {
    product_id: z.number().optional().describe('Filter by product ID (optional)'),
    plan_id: z.number().optional().describe('Filter by test plan ID (optional)'),
  },
}, handler(async ({ product_id, plan_id }) => {
  const filter = { case_status: 3 };
  if (product_id) filter.product = product_id;
  if (plan_id) filter.plan = plan_id;
  const cases = await rpc('TestCase.filter', [filter]);
  if (!cases.length) return { content: [{ type: 'text', text: 'No disabled test cases found.' }] };
  const lines = cases.map(c => `ID=${c.id} | ${c.summary} (product: ${c.product})`).join('\n');
  return { content: [{ type: 'text', text: `Disabled test cases (${cases.length}):\n${lines}` }] };
}));

// --- kiwi_create_test_run ---
server.registerTool('kiwi_create_test_run', {
  description: 'Create a test run (campaign) from a test plan so QA can execute tests',
  inputSchema: {
    plan_id: z.number().describe('Test plan ID'),
    summary: z.string().describe('Test run name'),
    build_id: z.number().describe('Build ID (from kiwi_list_builds)'),
    notes: z.string().optional().describe('Notes about this test run'),
  },
}, handler(async ({ plan_id, summary, build_id, notes }) => {
  const run = await rpc('TestRun.create', [{ plan: plan_id, summary, build: build_id, notes: notes ?? '', manager: KIWI_USERNAME }]);
  return { content: [{ type: 'text', text: `âœ… Test Run created:\n  ID=${run.id} â€” "${run.summary}"\n  URL: ${KIWI_URL}/runs/${run.id}/` }] };
}));

// --- kiwi_list_builds ---
server.registerTool('kiwi_list_builds', {
  description: 'List builds for a product version',
  inputSchema: { version_id: z.number().describe('Version ID (from kiwi_list_versions)') },
}, handler(async ({ version_id }) => {
  const builds = await rpc('Build.filter', [{ version: version_id }]);
  const lines = builds.map(b => `ID ${b.id}: ${b.name}`).join('\n');
  return { content: [{ type: 'text', text: lines || 'No builds found.' }] };
}));

// --- kiwi_create_build ---
server.registerTool('kiwi_create_build', {
  description: 'Create a new build for a product version',
  inputSchema: {
    version_id: z.number().describe('Version ID (from kiwi_list_versions)'),
    name: z.string().describe('Build name, e.g. "Sprint 2026-W27" or "v14.30.1"'),
  },
}, handler(async ({ version_id, name }) => {
  const build = await rpc('Build.create', [{ version: version_id, name }]);
  return { content: [{ type: 'text', text: `âœ… Build created: ID=${build.id} â€” "${build.name}"` }] };
}));

// --- kiwi_list_test_runs ---
server.registerTool('kiwi_list_test_runs', {
  description: 'List test runs, optionally filtered by plan or status',
  inputSchema: { plan_id: z.number().optional().describe('Filter by test plan ID') },
}, handler(async ({ plan_id }) => {
  const filter = plan_id ? { plan: plan_id } : {};
  const runs = await rpc('TestRun.filter', [filter]);
  if (!runs.length) return { content: [{ type: 'text', text: 'No test runs found.' }] };
  const lines = runs.map(r => `ID=${r.id} | ${r.summary} (plan: ${r.plan})`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_list_test_executions ---
server.registerTool('kiwi_list_test_executions', {
  description: 'List test executions in a test run with their status',
  inputSchema: { run_id: z.number().describe('Test run ID') },
}, handler(async ({ run_id }) => {
  const executions = await rpc('TestExecution.filter', [{ run: run_id }]);
  if (!executions.length) return { content: [{ type: 'text', text: 'No executions found in this run.' }] };
  const statusMap = ID_TO_EXEC_STATUS;
  const lines = executions.map(e => `ID=${e.id} | Case=${e.case} | Status: ${statusMap[e.status] ?? e.status} | Assignee: ${e.assignee || 'â€”'}`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_update_test_execution ---
server.registerTool('kiwi_update_test_execution', {
  description: 'Update a test execution status (PASS, FAIL, BLOCKED, etc.)',
  inputSchema: {
    execution_id: z.number().describe('Test execution ID'),
    status: z.enum(['IDLE', 'PASSED', 'BLOCKED', 'WAIVED', 'ERROR', 'FAILED']).describe('New execution status'),
  },
}, handler(async ({ execution_id, status }) => {
  const statusMap = EXEC_STATUS_TO_ID;
  await rpc('TestExecution.update', [execution_id, { status: statusMap[status] }]);
  return { content: [{ type: 'text', text: `âœ… Execution ID=${execution_id} marked as ${status}.` }] };
}));

// --- kiwi_add_execution_comment ---
server.registerTool('kiwi_add_execution_comment', {
  description: 'Add a comment to a test execution (e.g. defect notes, failure reason)',
  inputSchema: {
    execution_id: z.number().describe('Test execution ID'),
    comment: z.string().describe('Comment text to add'),
  },
}, handler(async ({ execution_id, comment }) => {
  await rpc('TestExecution.add_comment', [execution_id, comment]);
  return { content: [{ type: 'text', text: `âœ… Comment added to Execution ID=${execution_id}.` }] };
}));

// --- kiwi_search_test_cases ---
server.registerTool('kiwi_search_test_cases', {
  description: 'Search test cases by multiple criteria: product, plan, status, priority, tag, or summary keyword',
  inputSchema: {
    product_id: z.number().optional().describe('Filter by product ID'),
    plan_id: z.number().optional().describe('Filter by test plan ID'),
    case_status: z.enum(['PROPOSED', 'CONFIRMED', 'DISABLED']).optional().describe('Filter by status'),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Filter by priority'),
    tag: z.string().optional().describe('Filter by tag name'),
    summary_contains: z.string().optional().describe('Search keyword in summary (case-insensitive)'),
  },
}, handler(async ({ product_id, plan_id, case_status, priority, tag, summary_contains }) => {
  const filter = {};
  if (product_id) filter.product = product_id;
  if (plan_id) filter.plan = plan_id;
  if (case_status) filter.case_status = STATUS_TO_ID[case_status];
  if (priority) filter.priority = PRIORITY_TO_ID[priority];
  if (tag) filter.tag__name = tag;
  if (summary_contains) filter.summary__icontains = summary_contains;
  const cases = await rpc('TestCase.filter', [filter]);
  if (!cases.length) return { content: [{ type: 'text', text: 'No test cases match the given criteria.' }] };
  const lines = cases.map(c => `ID=${c.id} | ${c.summary} | ${ID_TO_STATUS[c.case_status] ?? c.case_status} | ${ID_TO_PRIORITY[c.priority] ?? c.priority}`).join('\n');
  return { content: [{ type: 'text', text: `Found ${cases.length} test case(s):\n${lines}` }] };
}));

// --- kiwi_add_attachment ---
server.registerTool('kiwi_add_attachment', {
  description: 'Upload a file attachment to a test case (e.g. screenshot, log file)',
  inputSchema: {
    case_id: z.number().describe('Test case ID'),
    filename: z.string().describe('File name of attachment, e.g. "screenshot.png"'),
    b64content: z.string().describe('Base64-encoded file content'),
  },
}, handler(async ({ case_id, filename, b64content }) => {
  await rpc('TestCase.add_attachment', [case_id, filename, b64content]);
  return { content: [{ type: 'text', text: `âœ… Attachment "${filename}" added to Test Case ID=${case_id}.` }] };
}));

// --- kiwi_list_attachments ---
server.registerTool('kiwi_list_attachments', {
  description: 'List all attachments on a test case',
  inputSchema: { case_id: z.number().describe('Test case ID') },
}, handler(async ({ case_id }) => {
  const attachments = await rpc('TestCase.list_attachments', [case_id]);
  if (!attachments.length) return { content: [{ type: 'text', text: `No attachments on TC-${case_id}.` }] };
  const lines = attachments.map(a => `ID=${a.pk} | ${a.filename} (${a.mime_type})`).join('\n');
  return { content: [{ type: 'text', text: `Attachments on TC-${case_id}:\n${lines}` }] };
}));

// --- kiwi_add_execution_link ---
server.registerTool('kiwi_add_execution_link', {
  description: 'Add a URL link to a test execution (e.g. bug tracker, CI build, screenshot URL)',
  inputSchema: {
    execution_id: z.number().describe('Test execution ID'),
    url: z.string().describe('URL to attach'),
    name: z.string().optional().describe('Display name for the link'),
  },
}, handler(async ({ execution_id, url, name }) => {
  await rpc('TestExecution.add_link', [{ execution: execution_id, url, name: name ?? url, is_defect: false }]);
  return { content: [{ type: 'text', text: `âœ… Link added to Execution ID=${execution_id}: ${url}` }] };
}));

// --- kiwi_test_run_report ---
server.registerTool('kiwi_test_run_report', {
  description: 'Generate a test run report with pass/fail statistics and execution details',
  inputSchema: {
    run_id: z.number().describe('Test run ID'),
    format: z.enum(['summary', 'detailed', 'json']).optional().describe('Report format: "summary" (default), "detailed", or "json"'),
  },
}, handler(async ({ run_id, format }) => {
  const outputFormat = format ?? 'summary';
  const runs = await rpc('TestRun.filter', [{ id: run_id }]);
  if (!runs.length) return { content: [{ type: 'text', text: `No test run found with ID=${run_id}.` }] };
  const run = runs[0];
  const executions = await rpc('TestExecution.filter', [{ run: run_id }]);
  const statusMap = ID_TO_EXEC_STATUS;
  const total = executions.length;
  const counts = {};
  for (const e of executions) { const label = statusMap[e.status] ?? 'UNKNOWN'; counts[label] = (counts[label] || 0) + 1; }
  const passed = counts['PASSED'] || 0, failed = counts['FAILED'] || 0, blocked = counts['BLOCKED'] || 0;
  const errors = counts['ERROR'] || 0, idle = counts['IDLE'] || 0;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
  if (outputFormat === 'json') {
    const report = {
      run_id: run.id, summary: run.summary, plan_id: run.plan, total, counts, pass_rate: `${passRate}%`,
      executions: executions.map(e => ({ id: e.id, case_id: e.case, status: statusMap[e.status] ?? e.status, assignee: e.assignee || null }))
    };
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  }
  let report = [`ðŸ“Š Test Run Report: "${run.summary}" (ID=${run.id})`, `Plan: ${run.plan} | Build: ${run.build}`, ``,
    `--- Statistics ---`, `Total: ${total} | Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked} | Error: ${errors} | Idle: ${idle}`, `Pass Rate: ${passRate}%`];
  if (outputFormat === 'detailed') {
    report.push('', '--- Per-Case Results ---');
    for (const e of executions) { report.push(`  Exec=${e.id} | Case=${e.case} | ${statusMap[e.status] ?? e.status} | Assignee: ${e.assignee || 'â€”'}`); }
  }
  report.push('', `URL: ${KIWI_URL}/runs/${run.id}/`);
  return { content: [{ type: 'text', text: report.join('\n') }] };
}));

// --- kiwi_test_plan_metrics ---
server.registerTool('kiwi_test_plan_metrics', {
  description: 'Get test plan metrics: total cases, status breakdown, priority distribution, and coverage stats',
  inputSchema: { plan_id: z.number().describe('Test plan ID') },
}, handler(async ({ plan_id }) => {
  const plans = await rpc('TestPlan.filter', [{ id: plan_id }]);
  if (!plans.length) return { content: [{ type: 'text', text: `No test plan found with ID=${plan_id}.` }] };
  const plan = plans[0];
  const cases = await rpc('TestCase.filter', [{ plan: plan_id }]);
  const total = cases.length;
  if (!total) return { content: [{ type: 'text', text: `Plan "${plan.name}" has no test cases.` }] };
  const statusLabels = ID_TO_STATUS;
  const priorityLabels = ID_TO_PRIORITY;
  const statusCounts = {}, priorityCounts = {};
  for (const c of cases) {
    const s = statusLabels[c.case_status] ?? 'UNKNOWN'; statusCounts[s] = (statusCounts[s] || 0) + 1;
    const p = priorityLabels[c.priority] ?? 'UNKNOWN'; priorityCounts[p] = (priorityCounts[p] || 0) + 1;
  }
  const confirmed = statusCounts['CONFIRMED'] || 0;
  const output = [`ðŸ“‹ Test Plan Metrics: "${plan.name}" (ID=${plan.id})`, `Active: ${plan.is_active} | Product: ${plan.product}`, ``,
    `--- Case Status Breakdown ---`, `Total: ${total} | Confirmed: ${confirmed} | Proposed: ${statusCounts['PROPOSED'] || 0} | Disabled: ${statusCounts['DISABLED'] || 0}`, ``,
    `--- Priority Distribution ---`, Object.entries(priorityCounts).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'), ``,
  `Coverage: ${confirmed}/${total} cases confirmed (${((confirmed / total) * 100).toFixed(1)}%)`, ``, `URL: ${KIWI_URL}/plan/${plan.id}/`];
  return { content: [{ type: 'text', text: output.join('\n') }] };
}));

// --- kiwi_add_case_comment ---
server.registerTool('kiwi_add_case_comment', {
  description: 'Add a comment to a test case',
  inputSchema: { case_id: z.number().describe('Test case ID'), comment: z.string().describe('Comment text to add') },
}, handler(async ({ case_id, comment }) => {
  await rpc('TestCase.add_comment', [case_id, comment]);
  return { content: [{ type: 'text', text: `âœ… Comment added to TC-${case_id}.` }] };
}));

// --- kiwi_list_case_comments ---
server.registerTool('kiwi_list_case_comments', {
  description: 'List comments on a test case',
  inputSchema: { case_id: z.number().describe('Test case ID') },
}, handler(async ({ case_id }) => {
  const comments = await rpc('TestCase.comments', [case_id]);
  if (!comments.length) return { content: [{ type: 'text', text: `No comments on TC-${case_id}.` }] };
  const lines = comments.map(c => `[${c.submit_date}] ${c.user_name}: ${c.comment}`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_add_component ---
server.registerTool('kiwi_add_component', {
  description: 'Link a component (module/feature) to a test case',
  inputSchema: { case_id: z.number().describe('Test case ID'), component_id: z.number().describe('Component ID to link') },
}, handler(async ({ case_id, component_id }) => {
  await rpc('TestCase.add_component', [case_id, component_id]);
  return { content: [{ type: 'text', text: `âœ… Component ID=${component_id} linked to TC-${case_id}.` }] };
}));

// --- kiwi_remove_component ---
server.registerTool('kiwi_remove_component', {
  description: 'Unlink a component from a test case',
  inputSchema: { case_id: z.number().describe('Test case ID'), component_id: z.number().describe('Component ID to unlink') },
}, handler(async ({ case_id, component_id }) => {
  await rpc('TestCase.remove_component', [case_id, component_id]);
  return { content: [{ type: 'text', text: `âœ… Component ID=${component_id} unlinked from TC-${case_id}.` }] };
}));

// --- kiwi_case_history ---
server.registerTool('kiwi_case_history', {
  description: 'Get audit trail for a test case â€” who changed what and when',
  inputSchema: { case_id: z.number().describe('Test case ID') },
}, handler(async ({ case_id }) => {
  const history = await rpc('TestCase.history', [case_id]);
  if (!history.length) return { content: [{ type: 'text', text: `No history for TC-${case_id}.` }] };
  const lines = history.map(h => `[${h.history_date}] ${h.history_user__username || 'â€”'}: ${h.history_change_reason || 'updated'}`).join('\n');
  return { content: [{ type: 'text', text: `History for TC-${case_id}:\n${lines}` }] };
}));

// --- kiwi_case_properties ---
server.registerTool('kiwi_case_properties', {
  description: 'List custom key-value properties on a test case',
  inputSchema: { case_id: z.number().describe('Test case ID') },
}, handler(async ({ case_id }) => {
  const props = await rpc('TestCase.properties', [{ case: case_id }]);
  if (!props.length) return { content: [{ type: 'text', text: `No properties on TC-${case_id}.` }] };
  const lines = props.map(p => `${p.name}: ${p.value}`).join('\n');
  return { content: [{ type: 'text', text: `Properties on TC-${case_id}:\n${lines}` }] };
}));

// --- kiwi_add_case_property ---
server.registerTool('kiwi_add_case_property', {
  description: 'Add a custom property to a test case',
  inputSchema: { case_id: z.number().describe('Test case ID'), name: z.string().describe('Property name'), value: z.string().describe('Property value') },
}, handler(async ({ case_id, name, value }) => {
  await rpc('TestCase.add_property', [case_id, name, value]);
  return { content: [{ type: 'text', text: `âœ… Property "${name}=${value}" added to TC-${case_id}.` }] };
}));

// --- kiwi_remove_case_property ---
server.registerTool('kiwi_remove_case_property', {
  description: 'Remove a custom property from a test case',
  inputSchema: { case_id: z.number().describe('Test case ID'), property_id: z.number().describe('Property ID to remove') },
}, handler(async ({ case_id, property_id }) => {
  await rpc('TestCase.remove_property', [{ case: case_id, pk: property_id }]);
  return { content: [{ type: 'text', text: `âœ… Property ID=${property_id} removed from TC-${case_id}.` }] };
}));

// --- kiwi_add_execution_attachment ---
server.registerTool('kiwi_add_execution_attachment', {
  description: 'Upload a file attachment to a test execution (evidence)',
  inputSchema: {
    execution_id: z.number().describe('Test execution ID'),
    filename: z.string().describe('File name, e.g. "screenshot.png"'),
    b64content: z.string().describe('Base64-encoded file content'),
  },
}, handler(async ({ execution_id, filename, b64content }) => {
  await rpc('TestExecution.add_attachment', [execution_id, filename, b64content]);
  return { content: [{ type: 'text', text: `âœ… Attachment "${filename}" added to Execution ID=${execution_id}.` }] };
}));

// --- kiwi_list_execution_attachments ---
server.registerTool('kiwi_list_execution_attachments', {
  description: 'List attachments on a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID') },
}, handler(async ({ execution_id }) => {
  const attachments = await rpc('TestExecution.list_attachments', [execution_id]);
  if (!attachments.length) return { content: [{ type: 'text', text: `No attachments on Execution ID=${execution_id}.` }] };
  const lines = attachments.map(a => `ID=${a.pk} | ${a.filename} (${a.mime_type})`).join('\n');
  return { content: [{ type: 'text', text: `Attachments on Execution ID=${execution_id}:\n${lines}` }] };
}));

// --- kiwi_list_execution_links ---
server.registerTool('kiwi_list_execution_links', {
  description: 'List URL links on a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID') },
}, handler(async ({ execution_id }) => {
  const links = await rpc('TestExecution.get_links', [{ execution: execution_id }]);
  if (!links.length) return { content: [{ type: 'text', text: `No links on Execution ID=${execution_id}.` }] };
  const lines = links.map(l => `ID=${l.id} | ${l.name}: ${l.url} (defect: ${l.is_defect})`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_remove_execution_link ---
server.registerTool('kiwi_remove_execution_link', {
  description: 'Remove a URL link from a test execution',
  inputSchema: { link_id: z.number().describe('Link ID to remove') },
}, handler(async ({ link_id }) => {
  await rpc('TestExecution.remove_link', [{ pk: link_id }]);
  return { content: [{ type: 'text', text: `âœ… Link ID=${link_id} removed.` }] };
}));

// --- kiwi_list_execution_comments ---
server.registerTool('kiwi_list_execution_comments', {
  description: 'Read comments on a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID') },
}, handler(async ({ execution_id }) => {
  const comments = await rpc('TestExecution.get_comments', [execution_id]);
  if (!comments.length) return { content: [{ type: 'text', text: `No comments on Execution ID=${execution_id}.` }] };
  const lines = comments.map(c => `[${c.submit_date}] ${c.user_name}: ${c.comment}`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_execution_history ---
server.registerTool('kiwi_execution_history', {
  description: 'Get audit trail for a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID') },
}, handler(async ({ execution_id }) => {
  const history = await rpc('TestExecution.history', [execution_id]);
  if (!history.length) return { content: [{ type: 'text', text: `No history for Execution ID=${execution_id}.` }] };
  const lines = history.map(h => `[${h.history_date}] ${h.history_user__username || 'â€”'}: status=${h.status}`).join('\n');
  return { content: [{ type: 'text', text: `History for Execution ID=${execution_id}:\n${lines}` }] };
}));

// --- kiwi_add_execution_tag ---
server.registerTool('kiwi_add_execution_tag', {
  description: 'Add tags to a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID'), tags: z.array(z.string()).describe('List of tag names to add') },
}, handler(async ({ execution_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestExecution.add_tag', [execution_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags added to Execution ID=${execution_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_remove_execution_tag ---
server.registerTool('kiwi_remove_execution_tag', {
  description: 'Remove tags from a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID'), tags: z.array(z.string()).describe('List of tag names to remove') },
}, handler(async ({ execution_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestExecution.remove_tag', [execution_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags removed from Execution ID=${execution_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_add_plan_attachment ---
server.registerTool('kiwi_add_plan_attachment', {
  description: 'Upload a file attachment to a test plan',
  inputSchema: { plan_id: z.number().describe('Test plan ID'), filename: z.string().describe('File name'), b64content: z.string().describe('Base64-encoded file content') },
}, handler(async ({ plan_id, filename, b64content }) => {
  await rpc('TestPlan.add_attachment', [plan_id, filename, b64content]);
  return { content: [{ type: 'text', text: `âœ… Attachment "${filename}" added to Plan ID=${plan_id}.` }] };
}));

// --- kiwi_list_plan_attachments ---
server.registerTool('kiwi_list_plan_attachments', {
  description: 'List attachments on a test plan',
  inputSchema: { plan_id: z.number().describe('Test plan ID') },
}, handler(async ({ plan_id }) => {
  const attachments = await rpc('TestPlan.list_attachments', [plan_id]);
  if (!attachments.length) return { content: [{ type: 'text', text: `No attachments on Plan ID=${plan_id}.` }] };
  const lines = attachments.map(a => `ID=${a.pk} | ${a.filename} (${a.mime_type})`).join('\n');
  return { content: [{ type: 'text', text: `Attachments on Plan ID=${plan_id}:\n${lines}` }] };
}));

// --- kiwi_add_plan_tag ---
server.registerTool('kiwi_add_plan_tag', {
  description: 'Add tags to a test plan',
  inputSchema: { plan_id: z.number().describe('Test plan ID'), tags: z.array(z.string()).describe('List of tag names to add') },
}, handler(async ({ plan_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestPlan.add_tag', [plan_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags added to Plan ID=${plan_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_remove_plan_tag ---
server.registerTool('kiwi_remove_plan_tag', {
  description: 'Remove tags from a test plan',
  inputSchema: { plan_id: z.number().describe('Test plan ID'), tags: z.array(z.string()).describe('List of tag names to remove') },
}, handler(async ({ plan_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestPlan.remove_tag', [plan_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags removed from Plan ID=${plan_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_plan_tree ---
server.registerTool('kiwi_plan_tree', {
  description: 'Get plan hierarchy (parent/child plans)',
  inputSchema: { plan_id: z.number().describe('Test plan ID') },
}, handler(async ({ plan_id }) => {
  const tree = await rpc('TestPlan.tree', [plan_id]);
  if (!tree.length) return { content: [{ type: 'text', text: `No child plans for Plan ID=${plan_id}.` }] };
  const lines = tree.map(p => `ID=${p.id} | ${p.name} (parent: ${p.parent ?? 'â€”'})`).join('\n');
  return { content: [{ type: 'text', text: `Plan tree for ID=${plan_id}:\n${lines}` }] };
}));

// --- kiwi_update_case_order ---
server.registerTool('kiwi_update_case_order', {
  description: 'Reorder test cases within a plan by setting sort keys',
  inputSchema: { plan_id: z.number().describe('Test plan ID'), case_ids: z.array(z.number()).describe('Ordered list of test case IDs (first = position 1)') },
}, handler(async ({ plan_id, case_ids }) => {
  const sortkeys = {};
  case_ids.forEach((id, i) => { sortkeys[id] = (i + 1) * 10; });
  await rpc('TestPlan.update_case_order', [plan_id, sortkeys]);
  return { content: [{ type: 'text', text: `âœ… Case order updated for Plan ID=${plan_id} (${case_ids.length} cases).` }] };
}));

// --- kiwi_update_test_run ---
server.registerTool('kiwi_update_test_run', {
  description: 'Update a test run: name, notes, or stop date',
  inputSchema: {
    run_id: z.number().describe('Test run ID'),
    summary: z.string().optional().describe('New name for the test run'),
    notes: z.string().optional().describe('Updated notes'),
    stop_date: z.string().optional().describe('Stop date in ISO format (e.g. "2026-07-01") to close the run'),
  },
}, handler(async ({ run_id, summary, notes, stop_date }) => {
  const params = {};
  if (summary) params.summary = summary;
  if (notes !== undefined) params.notes = notes;
  if (stop_date) params.stop_date = stop_date;
  await rpc('TestRun.update', [run_id, params]);
  return { content: [{ type: 'text', text: `âœ… Test Run ID=${run_id} updated.\n  URL: ${KIWI_URL}/runs/${run_id}/` }] };
}));

// --- kiwi_add_case_to_run ---
server.registerTool('kiwi_add_case_to_run', {
  description: 'Add an individual test case to a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), case_id: z.number().describe('Test case ID to add') },
}, handler(async ({ run_id, case_id }) => {
  await rpc('TestRun.add_case', [run_id, case_id]);
  return { content: [{ type: 'text', text: `âœ… TC-${case_id} added to Run ID=${run_id}.` }] };
}));

// --- kiwi_remove_case_from_run ---
server.registerTool('kiwi_remove_case_from_run', {
  description: 'Remove a test case from a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), case_id: z.number().describe('Test case ID to remove') },
}, handler(async ({ run_id, case_id }) => {
  await rpc('TestRun.remove_case', [run_id, case_id]);
  return { content: [{ type: 'text', text: `âœ… TC-${case_id} removed from Run ID=${run_id}.` }] };
}));

// --- kiwi_get_run_cases ---
server.registerTool('kiwi_get_run_cases', {
  description: 'Get test cases included in a test run',
  inputSchema: { run_id: z.number().describe('Test run ID') },
}, handler(async ({ run_id }) => {
  const cases = await rpc('TestRun.get_cases', [run_id]);
  if (!cases.length) return { content: [{ type: 'text', text: `No cases in Run ID=${run_id}.` }] };
  const lines = cases.map(c => `ID=${c.id} | ${c.summary}`).join('\n');
  return { content: [{ type: 'text', text: `Cases in Run ID=${run_id} (${cases.length}):\n${lines}` }] };
}));

// --- kiwi_add_run_tag ---
server.registerTool('kiwi_add_run_tag', {
  description: 'Add tags to a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), tags: z.array(z.string()).describe('List of tag names to add') },
}, handler(async ({ run_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestRun.add_tag', [run_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags added to Run ID=${run_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_remove_run_tag ---
server.registerTool('kiwi_remove_run_tag', {
  description: 'Remove tags from a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), tags: z.array(z.string()).describe('List of tag names to remove') },
}, handler(async ({ run_id, tags }) => {
  await forEachParallel(tags, tag => rpcSafe('TestRun.remove_tag', [run_id, tag]));
  return { content: [{ type: 'text', text: `âœ… Tags removed from Run ID=${run_id}: ${tags.join(', ')}` }] };
}));

// --- kiwi_add_run_cc ---
server.registerTool('kiwi_add_run_cc', {
  description: 'Add notification subscribers to a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), username: z.string().describe('Username to add as subscriber') },
}, handler(async ({ run_id, username }) => {
  await rpc('TestRun.add_cc', [run_id, username]);
  return { content: [{ type: 'text', text: `âœ… ${username} added as CC to Run ID=${run_id}.` }] };
}));

// --- kiwi_get_run_cc ---
server.registerTool('kiwi_get_run_cc', {
  description: 'List notification subscribers on a test run',
  inputSchema: { run_id: z.number().describe('Test run ID') },
}, handler(async ({ run_id }) => {
  const cc = await rpc('TestRun.get_cc', [run_id]);
  if (!cc.length) return { content: [{ type: 'text', text: `No CC subscribers on Run ID=${run_id}.` }] };
  const lines = cc.map(u => `${u.username} (${u.email})`).join('\n');
  return { content: [{ type: 'text', text: `CC on Run ID=${run_id}:\n${lines}` }] };
}));

// --- kiwi_remove_run_cc ---
server.registerTool('kiwi_remove_run_cc', {
  description: 'Remove a subscriber from a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), username: z.string().describe('Username to remove from CC') },
}, handler(async ({ run_id, username }) => {
  await rpc('TestRun.remove_cc', [run_id, username]);
  return { content: [{ type: 'text', text: `âœ… ${username} removed from CC on Run ID=${run_id}.` }] };
}));

// --- kiwi_add_run_attachment ---
server.registerTool('kiwi_add_run_attachment', {
  description: 'Upload a file attachment to a test run',
  inputSchema: { run_id: z.number().describe('Test run ID'), filename: z.string().describe('File name'), b64content: z.string().describe('Base64-encoded file content') },
}, handler(async ({ run_id, filename, b64content }) => {
  await rpc('TestRun.add_attachment', [run_id, filename, b64content]);
  return { content: [{ type: 'text', text: `âœ… Attachment "${filename}" added to Run ID=${run_id}.` }] };
}));

// --- kiwi_list_run_attachments ---
server.registerTool('kiwi_list_run_attachments', {
  description: 'List attachments on a test run',
  inputSchema: { run_id: z.number().describe('Test run ID') },
}, handler(async ({ run_id }) => {
  const attachments = await rpc('TestRun.list_attachments', [run_id]);
  if (!attachments.length) return { content: [{ type: 'text', text: `No attachments on Run ID=${run_id}.` }] };
  const lines = attachments.map(a => `ID=${a.pk} | ${a.filename} (${a.mime_type})`).join('\n');
  return { content: [{ type: 'text', text: `Attachments on Run ID=${run_id}:\n${lines}` }] };
}));

// --- kiwi_list_users ---
server.registerTool('kiwi_list_users', {
  description: 'List/search users in Kiwi TCMS',
  inputSchema: {
    username: z.string().optional().describe('Filter by username (supports __icontains)'),
    is_active: z.boolean().optional().describe('Filter by active status'),
  },
}, handler(async ({ username, is_active }) => {
  const filter = {};
  if (username) filter.username__icontains = username;
  if (is_active !== undefined) filter.is_active = is_active;
  const users = await rpc('User.filter', [filter]);
  if (!users.length) return { content: [{ type: 'text', text: 'No users found.' }] };
  const lines = users.map(u => `ID=${u.id} | ${u.username} (${u.email || 'â€”'}) | active: ${u.is_active}`).join('\n');
  return { content: [{ type: 'text', text: lines }] };
}));

// --- kiwi_bug_details ---
server.registerTool('kiwi_bug_details', {
  description: 'Get bug details from the configured bug tracker',
  inputSchema: { bug_id: z.number().describe('Bug/issue ID') },
}, handler(async ({ bug_id }) => {
  const details = await rpc('Bug.details', [bug_id]);
  return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
}));

// --- kiwi_bug_report ---
server.registerTool('kiwi_bug_report', {
  description: 'Report a bug to the configured bug tracker from a test execution',
  inputSchema: { execution_id: z.number().describe('Test execution ID'), tracker_id: z.number().describe('Bug tracker ID') },
}, handler(async ({ execution_id, tracker_id }) => {
  const result = await rpc('Bug.report', [execution_id, tracker_id]);
  return { content: [{ type: 'text', text: `âœ… Bug reported: ${JSON.stringify(result)}` }] };
}));

// --- kiwi_reformat_test_case ---
server.registerTool('kiwi_reformat_test_case', {
  description: 'Reformat and push a test case in one call. FULLY NON-DESTRUCTIVE: only updates specified fields. Accepts structured steps (builds HTML table automatically), handles screenshots by reference, and preserves Bugs, Components, Attachments, Author, Category, and all metadata not explicitly provided.',
  inputSchema: {
    case_id: z.number().describe('Test case ID to update'),
    summary: z.string().optional().describe('New test case title (e.g. RICE POT format: [Product][Feature][Role][Type] Description)'),
    steps: z.array(z.object({
      action: z.string().describe('Action to perform, prefixed with [Role] e.g. "[Editor] Click Save"'),
      expected_result: z.string().describe('Expected result after this action'),
    })).optional().describe('Reformatted steps (sequential flow with [Role] prefix). Builds HTML table automatically.'),
    preconditions: z.string().optional().describe('Prerequisites / setup required before the test'),
    navigation: z.string().optional().describe('Navigation path to reach the screen'),
    screenshots: z.array(z.object({
      label: z.string().describe('Label e.g. "Screenshot 1: Editor adding menu item"'),
      url: z.string().optional().describe('Attachment URL path e.g. "/uploads/attachments/auth_user/9/Screenshot.png" — if provided, embeds as visible image preview'),
    })).optional().describe('Screenshot references. If url is provided, embeds as visible image (![label](url)). Actual attachment files are NEVER touched.'),
    notes: z.string().optional().describe('Test case notes'),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority level'),
    case_status: z.enum(['PROPOSED', 'CONFIRMED', 'DISABLED']).optional().describe('Test case status'),
    replace_tags: z.array(z.string()).optional().describe('Replace ALL tags with this list'),
    add_tags: z.array(z.string()).optional().describe('Tags to ADD to existing (non-destructive)'),
    remove_tags: z.array(z.string()).optional().describe('Tags to REMOVE'),
  },
}, handler(async ({ case_id, summary, steps, preconditions, navigation, screenshots, notes, priority, case_status, replace_tags, add_tags, remove_tags }) => {
  const changes = [];

  try {
    // Fetch current state
    const cases = await rpc('TestCase.filter', [{ id: case_id }]);
    if (!cases.length) return { content: [{ type: 'text', text: `Error: Test case TC-${case_id} not found` }], isError: true };
    const tcData = cases[0];
    const tagObjs = await rpc('Tag.filter', [{ case: case_id }]);
    const currentTags = tagObjs.map(t => t.name);

    // Build update params — only what's provided
    const updateParams = {};

    if (summary) {
      updateParams.summary = summary;
      changes.push(`✓ Title: "${tcData.summary}" → "${summary}"`);
    }

    // Build HTML text from structured steps (reuses kiwi_create_test_case table format)
    if (steps) {
      const parts = [];

      if (navigation) {
        parts.push(`**Navigation:** ${navigation}`);
      }

      if (preconditions) {
        // Handle both real newlines and literal \n in input
        const preLines = preconditions.replace(/\\n/g, '\n').split('\n').filter(l => l.trim()).map(l => {
          const cleaned = l.replace(/^[-•*]\s*/, '').trim();
          return `- ${cleaned}`;
        }).join('\n');
        parts.push(`**Prerequisites:**\n${preLines}`);
      }

      // Build markdown table
      const tableHeader = `| Step No. | Action | Expected Behavior |\n|----------|--------|-------------------|`;
      const tableRows = steps.map((s, i) => `| ${i + 1} | ${s.action} | ${s.expected_result} |`).join('\n');
      parts.push(`${tableHeader}\n${tableRows}`);

      // Screenshots — embed as visible image previews using ![label](url) syntax
      if (screenshots && screenshots.length > 0) {
        const screenshotHtml = screenshots.map(s => {
          if (s.url) {
            return `![${s.label}](${s.url})`;
          }
          return s.label;
        }).join('\n');
        parts.push(`**Screenshot/Link :**\n${screenshotHtml}`);
      }

      updateParams.text = parts.join('\n\n');
      changes.push(`✓ Steps: ${steps.length} steps (table format, role-based sequential flow)`);
      if (preconditions) changes.push(`✓ Preconditions: updated (bullet list)`);
      if (navigation) changes.push(`✓ Navigation: updated`);
      if (screenshots) changes.push(`✓ Screenshots: ${screenshots.length} embedded as image previews`);
    }

    if (notes !== undefined) {
      updateParams.notes = notes;
      changes.push(`✓ Notes: updated`);
    }
    if (priority) {
      updateParams.priority = PRIORITY_TO_ID[priority];
      changes.push(`✓ Priority: ${ID_TO_PRIORITY[tcData.priority] || 'P2'} → ${priority}`);
    }
    if (case_status) {
      updateParams.case_status = STATUS_TO_ID[case_status];
      changes.push(`✓ Status: ${ID_TO_STATUS[tcData.case_status] || 'CONFIRMED'} → ${case_status}`);
    }

    if (Object.keys(updateParams).length > 0) {
      await rpc('TestCase.update', [case_id, updateParams]);
    }

    // Tag updates (reuses kiwi_add_tag / kiwi_remove_tag logic)
    if (replace_tags) {
      for (const tag of currentTags) try { await rpcSafe('TestCase.remove_tag', [case_id, tag]); } catch { }
      for (const tag of replace_tags) try { await rpcSafe('TestCase.add_tag', [case_id, tag]); } catch { }
      changes.push(`✓ Tags: [${currentTags.join(', ')}] → [${replace_tags.join(', ')}]`);
    } else {
      if (add_tags && add_tags.length > 0) {
        for (const tag of add_tags) try { await rpcSafe('TestCase.add_tag', [case_id, tag]); } catch { }
        changes.push(`✓ Tags added: [${add_tags.join(', ')}]`);
      }
      if (remove_tags && remove_tags.length > 0) {
        for (const tag of remove_tags) try { await rpcSafe('TestCase.remove_tag', [case_id, tag]); } catch { }
        changes.push(`✓ Tags removed: [${remove_tags.join(', ')}]`);
      }
    }

    const preserved = [
      `Bugs/Links`, `Components`, `Attachments (all screenshots & files)`,
      `Author: ${tcData.author || '–'}`, `Category: ${tcData.category}`,
      `Default Tester`, `Product: ${tcData.product}`,
    ];

    const out = [
      `✅ TC-${case_id} reformatted & pushed (NON-DESTRUCTIVE)`,
      ``, ...changes, ``,
      `🔒 PRESERVED: ${preserved.join(' | ')}`,
      ``, `URL: ${KIWI_URL}/case/${case_id}/`,
    ].join('\n');
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Ensure logged in before server starts handling requests
await ensureLoggedIn();

const transport = new StdioServerTransport();
await server.connect(transport);
