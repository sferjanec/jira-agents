
Quick-reference:

# Jira-MCP quick reference guide

Quick reference for running the Jira tools and the multi-agent

duplicate audit. Run commands from the project root.

> Jira tools are read-only. `create_feature_spec` additionally writes a Markdown
> plan under the selected repository's `.specs/` directory; no source files or
> Jira issues are modified.

## 1. Setup

- Use Node.js 24 LTS (recommended; 22.12.0+ on a supported release for the full

  CLI/SDK setup), then run `npm ci` from the project root. This installs all

  required npm libraries, including development tools; no separate library

  installs are needed.

- Set `JIRA_URL`, `JIRA_USER`, and `JIRA_API_TOKEN` in your environment or local

  `.env` file. Never commit credentials.

- For model-backed audits, authenticate the Copilot CLI in the same environment
  that runs the server. In WSL, authenticate and run inside WSL.

  Install with `npm install -g @github/copilot`, run `copilot`, and use `/login`
  if needed. The SDK includes the runtime, but it still needs Copilot
  authentication. Your account and organization policy must permit CLI access.

- Obtain a valid Jira Cloud API token from your Atlassian account; use the

  matching account email and token-compatible Jira base URL. See the

  [installation and configuration guide](readme.md#installation-and-configuration)

  for token creation, scoped-token considerations, and environment-file setup.

- To check that you have access to the Copilot SDK/model access independently of Jira:

  ```bash

  npm run example:copilot-sdk

  ```

The basic Jira tools do not invoke the Copilot SDK themselves. The audit and SDK

examples consume Copilot usage. Only send ticket data to models if permitted by

your organization's policy. No model is pinned: SDK runtime/account defaults

apply, independently of the VS Code Chat model picker.

## 2. Pick an entry point

| Goal | Command or client |

|---|---|

| Start the stdio MCP server for a client | `npm start` |

| List tools without retrieving an issue | `npm run example:client` |

| Retrieve one issue using the generic client | `npm run example:client -- PROJ-123` |

| Retrieve a compact issue summary | `npm run example:get_jira_issue -- PROJ-123 --compact` |

| Run the original search-based triage example | `npm run example:triage -- --project PROJ --max-results 10 --compact` |

| Run a real Jira multi-agent audit | `npm run example:audit -- PROJ` |

| Run a smaller final-review test | `npm run example:audit -- PROJ --status Backlog --max-pairs 2` |

| Run the synthetic-ticket audit with real Copilot inference (no Jira account or `.env`) | `npm run example:audit:demo` |
| Run a synthetic status subset | `npm run example:audit:demo -- --status Backlog --status Refinement --max-pairs 2` |

| Show audit help without Jira or model calls | `npm run example:audit -- --help` |

| Plan a ticket with the server-orchestrated planner (real Jira) | `npm run plan:jira -- PROJ-123 /absolute/path/to/repository` |

| Plan a ticket with an agent that calls the MCP tools itself | `npm run plan:agent -- PROJ-123 /absolute/path/to/repository` |

| Same, with a fixture ticket and no Jira access | `npm run plan:agent -- SIM-101 /absolute/path/to/repository --simulate` |

| Build from an approved plan with an agent that calls the MCP tools itself | `npm run build:agent -- SIM-101 /absolute/path/to/repository` |

| Plan with a script that calls the MCP tools in code (hybrid) | `npm run plan:hybrid -- SIM-101 /absolute/path/to/repository --simulate` |

| Build with a script that calls the MCP tools in code (hybrid) | `npm run build:hybrid -- SIM-101 /absolute/path/to/repository` |

`npm start` is a JSON-RPC stdio server, not an interactive command prompt or HTTP

endpoint. The example clients start and close their own server process; there is

no need to start a separate server first.

The original triage example uses `search_jira`, not the multi-agent audit. Its

`--status` flags **add to** its defaults (`Open`, `To Do`, `Ready to Work`,

`In Progress`). In contrast, the audit's `--status` flags **replace** its defaults.

Always supply your own project explicitly. For example, supply either "BOS" or "IPCM" to retrieve/analyze tickets for the planning board. Only one JIRA project key is permitted at this time.

Feature to read an exported compact triage report:

```bash

npm run example:triage -- --project PROJ --compact --output triage-report.txt 

npm run example:triage:analyze -- --input triage-report.txt 

```

That analyzer is a local token-overlap heuristic, not an LLM or multi-agent run.

Its thresholds and assignee/status heuristics are in

[example-triage-analyzer.ts](src/example-triage-analyzer.ts); they do not configure

the newer audit.

## 3. Available MCP tools

Use these names and argument objects with a connected MCP client:

| Tool | Example arguments | Behavior |

|---|---|---|

| `get_jira_issue` | `{"issueKey":"PROJ-123","includeFull":false}` | Compact issue summary; `includeDetails: true` adds the description and recent comments; `includeFull: true` requests the full Jira payload. With `JIRA_FIXTURES_DIR` set, reads `KEY.txt` fixtures instead of Jira. |

| `search_jira` | `{"jql":"project = PROJ ORDER BY created ASC","maxResults":10,"includeFull":false}` | JQL search; compact by default. Alternatively supply `projectKey` instead of `jql`. |

| `fetch_triage_backlog` | `{"projectKey":"PROJ","statuses":["Backlog"],"maxIssues":30}` | Paginated compact records: key, summary, status, created; includes coverage. |

| `fetch_candidate_descriptions` | `{"issueKeys":["PROJ-123","PROJ-124"],"maxCharacters":3000}` | Bounded plain-text descriptions; reports missing/truncated evidence. |

| `audit_jira_duplicates` | `{"projectKey":"PROJ","statuses":["Backlog"],"maxIssues":20,"maxCharacters":3000,"maxPairs":2}` | Runs retrieval, screening, candidate hydration, and verification. |

| `create_feature_spec` | `{"issueKey":"PROJ-452","workspaceRoot":"/absolute/path/to/repository"}` | Sends bounded issue and repository context to Copilot and saves a reviewable plan as `.specs/PROJ-452-TASK.md`. Does not generate code or overwrite existing plans. |

| `build_feature_from_spec` | `{"issueKey":"PROJ-452","workspaceRoot":"/absolute/path/to/repository"}` | Explicitly builds from the reviewed plan on local branch `agent/proj-452-builder`; requires a clean worktree except for the approved untracked plan, writes only plan-listed files, and never pushes. |

Fine-grained tools for the agent-driven plan and build flow (called by an agent, not by the server's own model):

| Tool | Example arguments | Behavior |

|---|---|---|

| `get_repo_context` | `{"workspaceRoot":"/absolute/path/to/repository"}` | Read-only. Bounded layout, stack and instruction files. |

| `save_feature_plan` | `{"issueKey":"PROJ-452","summary":"...","workspaceRoot":"/absolute/path","plan":{...}}` | Validates the plan schema and file paths, saves `.specs/PROJ-452-TASK.md`; never overwrites. If an open question starts with `NEEDS CLARIFICATION:`, saves a clarifications file instead. |

| `read_approved_plan` | `{"issueKey":"PROJ-452","workspaceRoot":"/absolute/path"}` | Read-only. Returns the approved plan and the current contents of the files it lists. |

| `create_build_branch` | `{"issueKey":"PROJ-452","workspaceRoot":"/absolute/path"}` | Requires a clean worktree except the plan; creates local branch `agent/proj-452-builder`; never pushes. |

| `write_planned_file` | `{"issueKey":"PROJ-452","workspaceRoot":"/absolute/path","path":"src/a.ts","content":"..."}` | Writes one file listed in the approved plan, only on the build branch. |
| `post_clarification_comment` | `{"issueKey":"PROJ-452","questions":["..."]}` | Posts the questions as a Jira comment. Needs `JIRA_POST_CLARIFICATIONS=true`; never contacts Jira in fixture mode. |
| `post_completion_comment` | `{"issueKey":"PROJ-452","stage":"build","branch":"agent/proj-452-builder","files":["src/a.ts"],"skipped":[]}` | Posts a plan or build summary. Needs `JIRA_POST_COMPLETION=true`; never contacts Jira in fixture mode. |
| `add_agent_label` | `{"issueKey":"PROJ-452"}` | Adds the label in `JIRA_AGENT_LABEL`. Skipped when unset or in fixture mode. |

The agent-driven path does not yet post the Jira clarification comment or label, record run metrics, or apply the single-flight guard. See [feature-workflow-detailed.md](feature-workflow-detailed.md).

Feature plan generation and building require Copilot access and an absolute
repository path. The builder requires a Git repository with no unrelated
uncommitted changes and sends the plan and selected repository context to
Copilot. Only use these tools when your organization's data policy permits it.

For `search_jira`, either `jql` or `projectKey` is required; supplied JQL takes

precedence. Project-only searches default to `Open`, `To Do`, `Ready to Work`,

and `In Progress`, with `maxResults: 10`.

The description tool accepts at most 20 unique issue keys. The coordinator
automatically deduplicates keys shared across approved candidate pairs. The
synthetic demo defaults to `To Do`, `In Progress`, `Backlog`, and `Refinement`;
repeat `--status` to select exact statuses. It still uses real Copilot SDK
inference, so Copilot authentication/access is required.

### VS Code / Copilot Chat

Enable the server in [`.vscode/mcp.json`](.vscode/mcp.json), restart it after code

changes, and confirm its seven tools are available. Example requests:

```text

Use get_jira_issue to retrieve PROJ-123. 

Use search_jira with JQL: project = PROJ ORDER BY created ASC, maxResults 10. 

Use audit_jira_duplicates for PROJ with statuses ["Backlog"], maxIssues 20, maxPairs 2. 

Use create_feature_spec for PROJ-452 with workspaceRoot /absolute/path/to/repository.

After reviewing .specs/PROJ-452-TASK.md, use build_feature_from_spec for PROJ-452 with workspaceRoot /absolute/path/to/repository.

```

You can also use `/jira-duplicates PROJ`. The

[Jira Duplicate Demo agent](.github/agents/jira-duplicate-demo.agent.md) and

[launch prompt](.github/prompts/jira-duplicates.prompt.md) are thin launchers;

the server implements the specialist roles and orchestration in TypeScript.

## 4. Audit CLI options and exports

The project key is required. `npm run example:audit` without arguments prints

usage and exits nonzero; it does not start an audit.

| CLI option | MCP argument | Default | Allowed values |

|---|---|---|---|

| Positional project key | `projectKey` | None; required | Jira project key, e.g. `PROJ`, not display name |

| `--status <NAME>` | `statuses` | `["To Do","In Progress"]` | 1-10 nonempty status names; repeat flag for multiple |

| `--max-issues <N>` | `maxIssues` | 30 | Integer 1-100 |

| `--max-characters <N>` | `maxCharacters` | 3000 | Integer 100-6000 per description |

| `--max-pairs <N>` | `maxPairs` | 10 | Integer 1-10 |

```bash

npm run example:audit -- PROJ 

npm run example:audit -- PROJ --status Backlog --status "Ready to Work" 

npm run --silent example:audit -- PROJ --status Backlog --max-issues 20 --max-pairs 2 > audit-report.json 

```

`Backlog` must be an actual workflow status; a Jira board's Backlog view is not

necessarily a status. No story-only issue-type filter is applied.

`maxPairs: 2` selects the first two candidates in the screening model's returned

order, not a guaranteed confidence ranking. Only their descriptions are fetched,

and only those pairs are sent for final verification. The report retains all

discovered candidates and discloses skipped reviews. Title screening still runs

over the retrieved backlog; the number of SDK stage calls is not reduced.

The CLI writes JSON to stdout and progress/errors to stderr. `--silent` suppresses

npm's script header for clean JSON redirection. To save both streams in WSL/bash:

```bash

npm run --silent example:audit -- PROJ --max-pairs 2 > audit-report.json 2> audit-progress.log 

```

Generated reports contain Jira-derived data; protect them and do not commit them

without authorization. The CLI currently takes flags, not a JSON input-file option.

## 5. Programmatic TypeScript calls / future supervising agents

[example-audit.ts](src/example-audit.ts) already is a TypeScript MCP client.

[parseAuditArgs](src/cli/audit.ts) validates CLI flags and fills defaults into

`options.input`, which the client passes to `client.callTool()`.

For exact programmatic inputs, a client can supply the object directly. This

example assumes a TypeScript file placed directly under `src/`:

```typescript

import { fileURLToPath } from "node:url"; 

import { Client } from "@modelcontextprotocol/sdk/client/index.js"; 

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"; 

import { writeAuditResult } from "./cli/auditResult.js"; 

const client = new Client({ name: "audit-client", version: "1.0.0" }); 

const transport = new StdioClientTransport({ 

    command: process.execPath, 

    args: ["--import", "tsx", fileURLToPath(new URL("./server.ts", import.meta.url))], 

    cwd: process.cwd(), 

    stderr: "inherit" 

}); 

try { 

    await client.connect(transport); 

    const result = await client.callTool({ 

        name: "audit_jira_duplicates", 

        arguments: { 

            projectKey: "PROJ", 

            statuses: ["Backlog"], 

            maxIssues: 20, 

            maxPairs: 2 

        } 

    }, undefined, { timeout: 330000 }); 

    process.exitCode = writeAuditResult(result); 

} finally { 

    await client.close(); 

} 

```

Keep outer error handling as in the existing

[audit client](src/example-audit.ts). The

[generic client](src/example-client.ts) can also be adapted, but currently calls

`get_jira_issue`, not the audit.

A future supervising agent can call `audit_jira_duplicates` directly through MCP,

receive the structured report, and present or act on it within its own policy.

It need not execute the CLI. Shelling out to the CLI and parsing stdout is an

alternative, not a requirement. No additional supervising agent is implemented.

## 6. Agent flow and rules developers can tune

```text

MCP client -> audit_jira_duplicates -> TypeScript coordinator 

  1. Retriever: call the code-bound compact backlog tool 

  2. Analyst: screen summaries for up to 10 candidate pairs 

  3. Retriever: fetch descriptions for selected candidates only 

  4. Analyst: verify those exact pairs using supplied evidence 

<- validated report, coverage, limitations, stage timings 

```

There are two model-backed roles, using up to four fresh SDK sessions. Stages

can be skipped when fewer than two tickets or no candidates are found.

### Configuration map

| What to change | Source of truth / guidance |

|---|---|

| Scope and per-run limits | Prefer CLI flags or MCP arguments rather than code changes. |

| Default statuses, ticket bounds, retrieval fields and ordering | [jira/triage.ts](src/jira/triage.ts): input schemas and `fetchTriageBacklog`. Current order is oldest created first, then key. |

| Audit defaults and output schemas | [agents/contracts.ts](src/agents/contracts.ts): `auditInputSchema`, screening/verification schemas, and report types. |

| Role instructions and semantic comparison criteria | [agents/audit.ts](src/agents/audit.ts): `retrieverInstructions`, `analystInstructions`, and stage-specific instructions. These are application prompts, not VS Code agent files. |

| Verdict/action mapping | [agents/contracts.ts](src/agents/contracts.ts): `verdictActions`, shared by verification guidance and coordinator validation. |

| Pair selection and business-rule enforcement | [agents/audit.ts](src/agents/audit.ts): candidate checks, `maxPairs` slicing, `validateEvaluations`, and limited-status calculation. |

| SDK model/session configuration and per-stage deadline | [agents/copilot.ts](src/agents/copilot.ts): `withCopilotRunner`; stage deadline is 60 seconds, SDK wait is 65 seconds. |

| Overall deadline, concurrency guard, and MCP registration | [tools/auditJiraDuplicates.ts](src/tools/auditJiraDuplicates.ts): five-minute audit deadline, one audit at a time per server process. |

| CLI flags/help and client timeout | [cli/audit.ts](src/cli/audit.ts) and [example-audit.ts](src/example-audit.ts); client timeout is 330 seconds. |

| Error codes and output-size/schema diagnostics | [agents/diagnostics.ts](src/agents/diagnostics.ts). |

| Progress output | [agents/progress.ts](src/agents/progress.ts); coordinator emits stage events and 10-second heartbeats. |

The analyst compares functional intent, entities, scope, and whether completing

one ticket would resolve the other. It must not use tone, shared assignee, or

status as duplicate evidence. There are no embeddings, sentiment analysis,

numeric similarity thresholds, or calibrated probability scores in this audit.

Current strict verification rules:

- Candidate pairs must be unique, non-self pairs using retrieved keys.
- Verification must return exactly the selected pairs, once each.
- Missing descriptions require `INSUFFICIENT_EVIDENCE`.
- Truncated descriptions cannot support `high` confidence.
- Verdict and action must match:

  | Verdict | Action |

  |---|---|

  | `SUSPECTED_DUPLICATE` | `REVIEW_AS_DUPLICATE` |

  | `RELATED_BUT_DISTINCT` | `CONSIDER_LINKING` |

  | `FALSE_POSITIVE` | `KEEP_SEPARATE` |

  | `INSUFFICIENT_EVIDENCE` | `GATHER_MORE_CONTEXT` |

Prompt instructions guide the model; TypeScript schemas and business rules

enforce the contract. Changing a prompt alone does not change validation.

Keep prompts, schemas, validators, diagnostics, tests, and documentation aligned.

Increasing the 10-pair ceiling also requires updating the 20-key hydration bound,

output schemas, cap detection, and related tests; it is not just a CLI edit.

Preserve the safety boundaries: ticket content is untrusted data; retrievers

must invoke their single code-bound tool exactly once; analysts have no tools.

The SDK adapter disables discovery and excludes built-in/MCP tools. The workflow

does not silently repair invalid results, automatically retry, or modify Jira.

Changing providers is possible through the `AgentRunner` contract in

[contracts.ts](src/agents/contracts.ts), but requires an adapter implementation;

there is no provider-switch flag today.

## 7. Interpret results and validate changes

| Report status | Meaning |

|---|---|

| `complete` | Pipeline completed without a recorded coverage limitation; still heuristic, not proof that all duplicates were found. |

| `limited` | Pipeline completed with disclosed scope/evidence limits, such as a capped backlog, skipped candidate reviews, or missing/truncated descriptions. |

| `incomplete` | A stage failed; do not interpret partial output as a clean backlog. CLI exits nonzero. |

Inspect `coverage`, `limitations`, `evaluations`, and `trace`. On failure inspect

`error.stage`, `error.code`, and `error.details`. `evaluations.3` identifies the

fourth evaluation (zero-based). Counts of reviewed pairs include only validated

results, not all work the model may have attempted.

Console `[jira-audit]` events include timestamps, stage/role, status, elapsed time,

and safe counts. Durations cover the whole stage, not just model latency.

`runtime: completed` means SDK lifecycle/cleanup finished, not audit success.

`SDK_FAILURE` is not proof of a rate limit; authentication, model availability,

quota, or service access can also cause it. Raw model/HTTP errors are not logged.

After code/rule changes:

```bash

npm run typecheck 

npm test 

```

Offline regression tests cover coordinator rules and MCP/CLI behavior. The

synthetic SDK demo is a separate live-model check and consumes usage.

See [readme.md](readme.md) for the full architecture and diagnostic reference.
