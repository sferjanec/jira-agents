# Jira MCP Server Demo

This project is a small Model Context Protocol (MCP) server for Jira. It exposes Jira tools to MCP clients so an agent or host can search issues, retrieve issue details, triage a project backlog, and generate reviewable feature plans.

For commands, tool arguments, programmatic calls, and agent-rule configuration,

see the [quick reference](quick-reference.md).

## What it does

The server currently exposes twelve tools:

- `get_jira_issue` — fetch one Jira issue by key like `PROJ-123` (`includeDetails` adds the description and recent comments)
- `search_jira` — search Jira using JQL such as `project = PROJ ORDER BY priority DESC`
- `fetch_triage_backlog` — fetch up to 100 compact backlog records with pagination and coverage metadata
- `fetch_candidate_descriptions` — fetch bounded plain-text descriptions for up to 20 candidate issue keys
- `audit_jira_duplicates` — run the TypeScript-coordinated retrieval and analysis agents through the Copilot SDK
- `create_feature_spec` — combine one Jira issue with bounded repository context to create a reviewable plan in `.specs/`
- `build_feature_from_spec` — explicitly build from a human-approved plan on a new local branch

Five more are fine-grained tools for the agent-driven pattern, where a Copilot agent
calls them itself instead of the server orchestrating the model (see
[Agent-driven planning and building](#agent-driven-planning-and-building)):

- `get_repo_context` — bounded repository layout, stack and instruction files (read-only)
- `save_feature_plan` — validate a plan and save it as `.specs/{ISSUE-KEY}-TASK.md` (or a clarifications file); never overwrites
- `read_approved_plan` — return the approved plan and the current contents of the files it lists (read-only)
- `create_build_branch` — create the local branch `agent/{issue-key}-builder` from a clean worktree; never pushes
- `write_planned_file` — write one plan-listed file on that branch

### Jira feature plan generation

Call `create_feature_spec` with an issue key and the absolute path to the repository
root. The tool reads the issue and a bounded set of repository details (a shallow
directory listing, recognized build manifests, and selected instruction files),
then asks a Copilot model for a structured plan. It writes only
`.specs/{ISSUE-KEY}-TASK.md`; it does not generate source code, and by default it does not modify Jira (see the optional clarification comment below).
Existing plans are never overwritten.

```json
{
  "issueKey": "PROJ-452",
  "workspaceRoot": "/absolute/path/to/repository"
}
```

Review the generated file before handing it to Copilot for implementation. Before
calling Copilot, the server gathers the repository layout and instruction files.
The planner then runs as a Copilot session rooted at the repository with
read-only tools (`view`, `grep`, `glob`) and explores the code itself. A permission
handler approves a read only for files inside the repository with source, config,
or documentation extensions; hidden paths (`.git`, `.env`), build and dependency
folders, lock files, binaries, and symlinks that leave the repository are refused,
as are shell, write, and network requests. The
tool sends bounded Jira and repository context to Copilot and consumes Copilot
usage; run it only where permitted by your organization's data policy. Ticket
descriptions and repository instructions are treated as untrusted content.

#### Writing a ticket the planner can act on

The planner finds code by searching for words from the ticket, so specific tickets
produce better plans with fewer file reads. Include:

- **Where:** the page, screen or URL (for example "Admin > Users > Edit user").
- **What:** the exact label of the field or component, copied from the UI.
- **Actual vs. expected:** what happens now and what should happen (for example,
  "the Role drop-down lists Viewer and Editor but not Approver").
- **Known names:** any class, template, endpoint or table names you already know.
- **Where to look (optional):** hints such as "check both the view template and the service".

Vague tickets still work, but the plan will contain `NEEDS CLARIFICATION:` entries
under "Open questions" that list what to add. In that case the tool reports
`needsClarification: true`, lists the questions, saves them to
`.specs/{ISSUE-KEY}-CLARIFICATIONS.md` and writes no plan, so after you update the
ticket you can simply run it again. The clarifications file is replaced on each
run and deleted once a plan is saved.

**Optional Jira comment (off by default).** Set `JIRA_POST_CLARIFICATIONS=true` in
the server environment and the tool also adds one comment with the questions to
the Jira ticket. This is the only Jira write in the project and needs a token
with permission to comment. If posting fails, the run still succeeds and the
result reports `jiraCommentPosted: false`. Each run posts a new comment, so
repeated runs on an unchanged vague ticket add repeated comments. In the
simulation, `SIM_POST_COMMENT=1` prints the comment instead of posting it.

To try it against a real (test) Jira site with credentials in `.env`:

```bash
JIRA_POST_CLARIFICATIONS=true EXPLORE_DEBUG=1 npm run plan:jira -- DEMO-1 /absolute/path/to/repository
```

`EXPLORE_DEBUG=1` logs the HTTP status and Jira's error body if the comment fails.

#### Agent-driven planning and building

`create_feature_spec` and `build_feature_from_spec` run the model inside the server. The
same workflow is also available as small tools that a Copilot agent calls itself, so
other scripts and agents can reuse the server as a toolbox. A script starts the server
as a subprocess and gives the agent session access to its tools:

```bash
npm run plan:agent -- DEMO-1 /absolute/path/to/repository              # real Jira
npm run plan:agent -- SIM-101 /absolute/path/to/repository --simulate  # fixture ticket, no Jira
npm run build:agent -- SIM-101 /absolute/path/to/repository            # after approving the plan
```

- **Plan:** the agent calls `get_jira_issue`, `get_repo_context`, explores the repo with
  read-only `view`/`grep`/`glob` (same read policy as above), then calls `save_feature_plan`.
- **Build:** the agent calls `read_approved_plan`, `create_build_branch`, then
  `write_planned_file` once per file. It has no built-in file or shell tools.
- **Guardrails live in the tools:** plans are schema-validated and never overwritten, and
  `write_planned_file` refuses any path not listed in the approved plan or any call off the
  build branch. Each script allows only its own MCP tools.
- **`--simulate`** sets `JIRA_FIXTURES_DIR` for the server so `get_jira_issue` reads
  `simulation/fixtures/KEY.txt` and Jira is never contacted. You can set that variable
  yourself to run the server offline.
- **Not yet in this path:** the Jira clarification comment and label, run metrics, and the
  single-flight guard. Prompt-injection hardening is also deferred.

See [feature-workflow-detailed.md](feature-workflow-detailed.md) for diagrams and a tool reference.

#### Run metrics and the agent label (both optional, off by default)

- **Metrics:** set `METRICS_FILE` to an absolute path (for example
  `/path/to/jira-agents/.metrics/runs.jsonl`) and every plan and build run appends one
  JSON line: outcome, error code, time per step (Jira fetch, model, Jira write), token
  counts from the Copilot SDK's usage events, model calls, reads approved and denied,
  bytes read, and whether the read budget was exhausted. It holds numbers only: no
  ticket text, prompts, file contents or plans. The file is git-ignored under
  `.metrics/`, and a write failure never fails a run.
- **Report:** `npm run metrics -- /path/to/runs.jsonl` (or with `METRICS_FILE` set)
  prints clarification and budget-hit rates, token and time statistics, the slowest
  step and the heaviest runs. The cost shown is the SDK's billing multiplier, not dollars.
- **Agent label:** set `JIRA_AGENT_LABEL=agent-assisted` to add that label to every
  ticket the planner handles (plan saved or clarification requested). Filter on it in
  Jira to compare cycle time for agent-assisted and other tickets. Jira's own
  created, in-progress and done dates supply the cycle time; these metrics supply cost
  and speed. A failed label write does not fail the run. It needs a token that can edit issues.

### Build from a human-approved plan

After a person has reviewed `.specs/{ISSUE-KEY}-TASK.md`, explicitly call
`build_feature_from_spec` with the same issue key and the absolute Git repository
root. The tool requires a clean worktree, allowing only that plan as an untracked
file, then creates a local branch named `agent/{issue-key}-builder`. It will not
push the branch. Copilot receives the approved plan, bounded repository context,
planned existing files, and a few nearby code examples; it has no direct
filesystem, shell, Jira, or MCP tools. The coordinator validates every generated
path against the plan before writing, and only plan-listed files can be created
or modified. Planned paths that cannot be grounded are reported as skipped.

The result identifies the branch and created, modified, and skipped files.
Review the branch and run the repository's tests before merging or pushing.
The builder sends the approved plan and selected repository context to Copilot;
use it only where permitted by your organization's data policy.

## Multi-agent duplicate audit (TypeScript + Copilot SDK)

The MCP server now owns orchestration in TypeScript. It invokes two model-backed

roles through the Copilot SDK: a retriever with narrowly scoped Jira access and

an analyst with no tools. Copilot Chat only calls the audit tool and presents its

result; it does not run the workflow as VS Code subagents.

```text

Copilot -> audit_jira_duplicates(projectKey) 

  -> TypeScript coordinator 

     -> Retriever agent: compact Jira backlog 

     -> Analyst agent: semantic title screening 

     -> Retriever agent: approved candidate descriptions only 

     -> Analyst agent: evidence-based verification 

  <- validated report + observed execution trace 

```

Each stage uses a fresh, isolated SDK session with role-specific instructions;

there are two agent roles and up to four session invocations, not four different

agents. TypeScript holds the handoff data. The retriever must actually invoke its

single scoped tool; a model-generated ticket list is never trusted as retrieved

data. The analyst cannot access Jira, the filesystem, a shell, or MCP tools.

### Run with Jira

1. Install dependencies with `npm ci`. Use a supported Node version and a

   Copilot CLI/SDK login allowed by your organization in the same environment as

   the server. WSL users should log in and start the server inside WSL.

2. Configure the Jira credentials below. Run `npm run example:copilot-sdk` to

   check model access independently of Jira.

3. Restart `jira-mcp` in VS Code using [`.vscode/mcp.json`](.vscode/mcp.json).

   Confirm all seven tools are available.

4. Run `/jira-duplicates YOURPROJECT` in Copilot Chat, or ask:

   ```text

   Use audit_jira_duplicates to review project YOURPROJECT for possible duplicates.

   ```

The optional **Jira Duplicate Demo** chat agent and

[launch prompt](.github/prompts/jira-duplicates.prompt.md) are now thin tool

launchers, not the implementation of the specialist agents. The earlier VS Code

retriever/analyst definitions have been replaced by TypeScript roles.

A tool call can supply custom statuses and limits:

```json

{ 

  "name": "audit_jira_duplicates", 

  "arguments": { 

    "projectKey": "DEMO", 

    "statuses": ["To Do", "In Progress"], 

    "maxIssues": 30, 

    "maxCharacters": 3000, 

    "maxPairs": 2 

  } 

} 

```

**This tool sends bounded ticket data to Copilot models and consumes Copilot

usage.** Only run against projects permitted by your organization's data policy.

No model is pinned: SDK runtime/account defaults apply, independently of the

VS Code Chat model picker. The runtime uses your existing Copilot authentication;

Jira credentials are not included in prompts or tool results.

### Run from the command line against Jira

From the project root, use the same environment where Jira credentials and

Copilot CLI login are configured:

```bash

npm run example:audit -- PROJ --status Backlog --max-issues 100 

```

This launches the MCP server and calls `audit_jira_duplicates` for project `PROJ`

with `statuses: ["Backlog"]`, replacing (not adding to) the default statuses.

`Backlog` must be an actual Jira workflow status in that project. It is not the

same as the board's Backlog view, which can include tickets with other statuses.

The project argument is a project key, not its display name.

Repeat `--status` to include multiple statuses:

```bash

npm run example:audit -- PROJ --status Backlog --status "Ready to Work" 

```

Omit `--status` to retain `To Do` / `In Progress`. The default ticket limit is 30,

maximum 100; `--max-characters` sets the per-description limit (default 3000,

range 100-6000). Run `npm run example:audit -- --help` for usage without making

Jira or model calls.

For a smaller verification test, review only the first two candidate pairs:

```bash

npm run --silent example:audit -- PROJ --status Backlog --max-pairs 2 > audit-report.json 

```

`--max-pairs` (MCP input `maxPairs`) accepts 1-10 and defaults to 10.

The coordinator selects the first N candidates in the screening model's returned

order, not a guaranteed ranking by confidence. It retrieves descriptions only

for those pairs and sends only those pairs to verification. The report keeps all

discovered candidates, reports the actual `pairsReviewed`, and is `limited` with

an explicit limitation if candidates were omitted. Screening progress logs include

`pairsSelectedForReview`. Backlog retrieval and title screening are unchanged:

this reduces hydration/verification data, not the number of SDK stage calls or

the risk of rate limits to zero.

The CLI prints the report as JSON. To save it without npm's script header:

```bash

npm run --silent example:audit -- PROJ --status Backlog > audit-report.json 

```

Incomplete audits/tool failures exit nonzero; inspect the report's status and

coverage even on success because a successful pipeline is not exhaustive

duplicate detection. This command uses live Jira data and consumes Copilot usage.

The MCP client timeout is 330 seconds.

### Failure diagnostics

Verification supplies the model with the same verdict/action mapping enforced

by the coordinator, both in instructions and in its input/output-schema guidance:

`SUSPECTED_DUPLICATE -> REVIEW_AS_DUPLICATE`,

`RELATED_BUT_DISTINCT -> CONSIDER_LINKING`,

`FALSE_POSITIVE -> KEEP_SEPARATE`, and

`INSUFFICIENT_EVIDENCE -> GATHER_MORE_CONTEXT`.

`VERDICT_ACTION_MISMATCH` means the returned evaluation violated this mapping;

the audit rejects it rather than silently changing the model's recommendation.

Explicit guidance reduces ambiguity but does not guarantee model compliance.

Live progress is written to **stderr**, leaving stdout available for the JSON

report. Each `[jira-audit]` line contains a timestamp, stage, agent role (when

applicable), status, and `elapsedMs`. Stages emit `started`, `completed`, `failed`,

or `skipped`; tasks still running emit a heartbeat every 10 seconds with elapsed

time. Completion messages include safe counts: tickets/pages retrieved, candidate

pairs, descriptions fetched/missing/truncated, and validated pairs reviewed.

Failure messages include the sanitized error code and validation rule/path.

The audit summary includes total coordinator time and counts; the `runtime`

completion measures the full SDK lifecycle including startup and cleanup.

`runtime: completed` means that lifecycle finished, not that the audit succeeded;

check the audit status as well.

Stage times cover the SDK session, model work, Jira tools (for retrieval), and

validation together. They are not model-only latency, token counts, or billing

metrics. Logs contain no ticket keys, titles, descriptions, prompts, or raw model

responses. They do not change the timeout or retry behavior.

Keep progress visible while saving JSON:

```bash

npm run --silent example:audit -- IPCM --status Refinement --max-issues 30 > audit-report.json 

```

To save progress separately as well (WSL/bash):

```bash

npm run --silent example:audit -- IPCM --status Refinement --max-issues 30 > audit-report.json 2> audit-progress.log 

```

Each `trace` entry includes `elapsedMs` for the entire stage (model request, tools,

and validation). Skipped stages have duration 0. An incomplete report includes

`error.stage`, a safe `error.code`, a fixed human-readable message, and optional

`error.details` containing validation field paths/rule identifiers only.

Common codes:

| Code | Meaning |

|------|---------|

| `SDK_FAILURE` | SDK session/request failed; the raw provider error is not exposed |

| `STAGE_TIMEOUT` | Agent stage reached its 60-second deadline |

| `AUDIT_TIMEOUT` / `AUDIT_CANCELLED` | Overall deadline or caller cancellation |

| `INVALID_JSON` / `SCHEMA_VALIDATION_FAILED` | Model output could not be parsed or did not match the schema |

| `BUSINESS_RULE_FAILED` | Candidate/evaluation constraints failed; inspect `error.details` |

| `EMPTY_MODEL_RESPONSE` / `MODEL_OUTPUT_TOO_LARGE` | Missing response or response exceeded 50,000 characters |

| `RETRIEVAL_FAILED` / `RETRIEVAL_PROTOCOL_FAILED` | Jira retrieval failed or the retriever did not execute its approved tool exactly once |

| `RUNTIME_FAILURE` / `AUDIT_BUSY` / `INTERNAL_FAILURE` | Runtime lifecycle, concurrency guard, or unexpected stage failure |

For example, `evaluations.0.evidence` with `too_big` identifies an explanation

exceeding the schema limit; `MISSING_DESCRIPTION_REQUIRES_INSUFFICIENT_EVIDENCE`

identifies a verdict inconsistent with missing evidence. Values, raw model

responses, HTTP bodies, credentials, and exception stacks are not logged.

`SDK_FAILURE` deliberately does not guess whether an opaque SDK error was

authentication, quota, or service-related.

On failure the CLI writes a short stage/code summary to **stderr**, keeps the

JSON result on **stdout**, and exits nonzero. This remains visible when you

redirect the report. Use `npm run --silent` as shown above to avoid npm headers

in JSON files. In a WSL shell, `echo $?` immediately after the command shows

its exit status. No automatic retry or timeout increase is applied.

### Try both agents without Jira

```bash

npm run example:audit:demo 

```

This makes a real MCP tool call through an in-memory transport to the production
audit handler and Copilot SDK agents, but uses built-in synthetic tickets instead
of Jira. It includes two intentionally similar pairs, distinct issues, and
statuses `To Do`, `In Progress`, `Backlog`, and `Refinement`. All four statuses
are included by default; use repeatable `--status` flags to select a subset, or
`--max-pairs` to limit final verification:

```bash

npm run example:audit:demo -- --status Backlog --status Refinement --max-pairs 2

```

It needs Copilot access and consumes usage, but needs no Jira account,
credentials, `.env` file, or Jira network access. Inspect the returned `trace`,
candidates, evaluations, and coverage. The model's exact judgments may vary.

### Bounds and interpretation

- Defaults: up to 30 issues of any type in `To Do` or `In Progress`, oldest first;

  maximum 100. Supply exact custom statuses if needed. Existing atomic tools and

  triage clients retain their original behavior.

- Backlog retrieval is paginated and returns only key, summary, status, and created

  date. `coverage.truncated` identifies an incomplete backlog subset.

- The analyst uses **semantic LLM title screening**, not lexical similarity or

  embeddings. Up to 10 unique unordered candidate pairs are allowed; invented

  keys, self-pairs, duplicates, oversized output, and invalid JSON fail the audit.

  Reaching the candidate cap conservatively marks screening limited.

- At most 20 unique candidate issues are hydrated once with 3000 characters per

  description by default (maximum 6000). Jira rich text is converted to text

  without attachment bodies. `descriptionCoverage` identifies missing/truncated

  evidence per issue, without returning full descriptions in the final report.

- Verification must cover exactly the approved pairs with consistent verdicts

  and actions. Missing descriptions require `INSUFFICIENT_EVIDENCE`; truncated

  descriptions cannot support high confidence. Verdicts are suspected duplicate,

  related-but-distinct, false positive, or insufficient evidence.

- Fewer than two issues skip analysis; zero candidates skip hydration and

  verification. Failures are explicit and stop dependent stages. Results from

  failed audits are partial, not a clean "no duplicates" finding.

- `status: complete` means the pipeline finished, **not** that the backlog has

  been exhaustively checked. `limited` means retrieval/screening was capped or

  evidence was limited. `incomplete` means a stage failed or was cancelled.

  Counters summarize successfully completed stages; a failed retrieval stage may

  have made partial Jira requests before stopping.

- For 100 issues, 4,950 is only the number of *possible* pairs, not individually

  evaluated pairs. Confidence labels are uncalibrated model judgments.

- Sentiment analysis is not used: tone does not establish duplication. No vector

  database, separate embedding provider, Jira writes, or automatic closure is used.

- Only one audit runs at a time per server process. An agent stage is bounded to

  60 seconds and the audit to five minutes (plus startup/cleanup). There are no

  automatic inference retries. Agent turns can contain multiple inference

  requests, so four stage invocations do not mean four billable model calls.

  Cancellation aborts active model work and in-flight Jira requests.

- Hosts may have a shorter tool timeout. Configure a timeout above five minutes

  when calling from another MCP client; the synthetic example uses 330 seconds.

  SDK sessions run in an empty temporary working directory, with only the

  stage-approved tool available and all other permissions denied. Temporary

  working directories are removed; Copilot-managed session history/retention

  remains subject to the runtime and organization's configuration.

### Implementation and future model providers

- [`src/agents/audit.ts`](src/agents/audit.ts): deterministic coordinator and

  handoff validation.

- [`src/agents/contracts.ts`](src/agents/contracts.ts): provider-neutral

  `AgentRunner`/tool contracts and structured result schemas.

- [`src/agents/copilot.ts`](src/agents/copilot.ts): Copilot SDK adapter, model

  sessions, tool allowlists, cancellation, and cleanup.

- [`src/tools/auditJiraDuplicates.ts`](src/tools/auditJiraDuplicates.ts): MCP entry

  point, concurrency guard, and sanitized error results.

Only the Copilot adapter is implemented. Another local or remote provider can

implement `AgentRunner` without changing Jira retrieval or coordinator validation;

it must honor tool restrictions and cancellation. An embedding screening step

would be a separate, explicitly configured addition with calibrated thresholds.

### Validation

```bash

npm run typecheck 

npm test 

```

`npm test` uses a scripted model and synthetic Jira responses, plus in-memory MCP

calls and an actual stdio server startup. It does not make inference or Jira

network requests. Tests cover stage order, real retrieval tool invocation,

candidate key/pair validation, verdict/action consistency, missing/truncated

evidence, caps, short-circuits, failures, and concurrency, in addition to the

existing Jira retrieval tests. `npm run example:audit:demo` separately checks

the real SDK/model path with synthetic data.

For live Jira acceptance, use an approved test project with a known duplicate,

similar titles with distinct descriptions, and a missing description. Confirm

coverage, only candidate keys being hydrated, and evidence-based verdicts. No

automatic test can establish the model's duplicate-detection recall.

## Copilot SDK access smoke test

This standalone example checks programmatic model access using your existing

Copilot login, independently of the MCP server and Jira:

```bash

npm run example:copilot-sdk 

```

It requires Node.js ^20.19.0 or >=22.12.0 and a Copilot account allowed to use the

CLI/SDK. Run it in the same environment where your Copilot CLI login works (for

example, the WSL terminal). The SDK includes its own Copilot runtime.

The example omits `model`, leaving model selection to the runtime/account default.

This does not necessarily select the model currently chosen in VS Code Chat.

It sends only a fixed connectivity prompt, disables tools and permission requests,

and runs from a temporary empty directory rather than the project workspace.

No Jira credentials or data are used. The model call consumes Copilot usage.

Successful output is exactly `SDK access confirmed`; a missing or unexpected

response, authentication problem, or runtime error fails the command. The SDK

client/session are disposed and the temporary working directory is removed.

This is only an access check, not the TypeScript multi-agent implementation.

## Installation and configuration

### 1. Install Node.js and project dependencies

Use **Node.js 24 LTS (recommended)** with npm. The installed Copilot SDK supports

Node.js `^20.19.0 || >=22.12.0`, but the current Copilot CLI npm installer requires

Node.js 22 or later. For the complete setup, use Node.js 22.12.0 or later on a

supported release rather than Node.js 20.

Verify your terminal environment:

```bash

node --version 

npm --version 

```

From the project root, install the locked dependency versions:

```bash

npm ci 

```

There is no need to install each library manually or install TypeScript globally.

The repository's `package.json` and `package-lock.json` supply:

| npm package | Purpose |

|---|---|

| `@modelcontextprotocol/sdk` | MCP server and TypeScript clients |

| `@github/copilot-sdk` | Model-backed agent sessions |

| `axios` | Jira HTTP requests |

| `dotenv` | Local `.env` configuration |

| `zod` | Input/output schema validation |

| `tsx`, `typescript`, `@types/node` (development dependencies) | Run TypeScript examples, type-check, and test |

Keep development dependencies installed: this demo's `npm start` uses `tsx`.

Use `npm install` when intentionally updating dependencies/the lockfile, rather

than adding separate copies of the packages above.

### 2. Install and authenticate Copilot CLI (audit workflow only)

The Jira read tools do not require a Copilot login when called from a standalone

MCP client. The duplicate audit and SDK smoke test require Copilot model access.

You need a Copilot account/plan with CLI access; organization or enterprise

policy can disable it even when Copilot Chat works.

Install the CLI in the same environment that will run this project:

```bash

npm install -g @github/copilot 

copilot --version 

copilot 

```

Inside the interactive CLI, use `/login` if prompted and follow the browser

authentication steps. Exit the CLI when done, then verify SDK access:

```bash

npm run example:copilot-sdk 

```

Expected successful output: `SDK access confirmed`. This check makes a real model

request but does not use Jira data. The npm SDK includes its runtime, so no

separate CLI binary is needed to launch it. However, this project's default SDK

configuration uses your logged-in Copilot account, so you must install and log

in with the Copilot CLI (or configure another supported SDK authentication

method) before the smoke test or model-backed audit can succeed. Installing the

CLI is for authentication, not for adding another project dependency.

For WSL, install Node, dependencies, and the CLI and authenticate **inside WSL**;

a Windows installation/login does not establish that the WSL environment works.

For native Windows, GitHub's CLI documentation also requires PowerShell 6+.

See the official [Copilot CLI installation and authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)

for platform alternatives and organization-policy requirements.

### 3. Obtain a Jira Cloud API token

You need an Atlassian account with access to the target Jira project, its project

key (for example `PROJ`), and a valid, unexpired Jira Cloud API token. A GitHub

token, Copilot login, or Atlassian account password is not a Jira API token.

1. Sign in to [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

   using the account that can read the target project's issues.

2. Create a token using the token type and expiry permitted by your organization.

   Give it a descriptive name and copy it securely when displayed; it cannot be

   retrieved again later.

3. Confirm the account has project browse/issue access, including any issue

   security restrictions. A token does not grant permissions the account lacks.

**Token type and URL must match.** The site URL example below uses Jira Cloud

email/token Basic authentication with a token without scopes. Atlassian recommends

scoped tokens where supported; scoped tokens use the gateway base URL

`https://api.atlassian.com/ex/jira/<cloudId>` instead of the site URL and need

appropriate read scopes for the endpoints called. Coordinate that setup with

your administrator; do not bypass organization policy by choosing a different

token type. This demo does not discover your cloud ID or configure scopes for you.

See [Atlassian&#39;s token guide](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)

for creation steps, scoped-token URLs, expiration, and revocation.

### 4. Configure Jira credentials

Copy the example environment file (do not overwrite an existing local file):

```bash

# WSL / bash 

cp .env.example .env 

```

Or in PowerShell:

```powershell

Copy-Item .env.example .env 

```

Update the local `.env` with your Jira details:

```env

JIRA_URL=https://your-company.atlassian.net 

JIRA_USER=you@example.com 

JIRA_API_TOKEN=your-api-token 

```

`JIRA_USER` is the Atlassian account email associated with the token. Keep the

token out of source control, prompts, screenshots, and shared reports. Rotate or

revoke exposed/expired tokens through Atlassian, and restart the MCP server after

changing credentials. Environment variables can be used instead of `.env`.

### 5. Validate and run

```bash

npm run typecheck 

npm test 

npm run example:get_jira_issue -- PROJ-123 --compact 

```

Replace `PROJ-123` with an issue your account can read. The first two commands

are offline checks; the last starts its own MCP server and checks live Jira

access. Run the Copilot smoke test separately before trying an audit.

To use Copilot Chat, enable/start `jira-mcp` through

[`.vscode/mcp.json`](.vscode/mcp.json). To use an example client, run it directly;

it starts and closes its own server. See the [quick reference](quick-reference.md)

for commands and audit arguments.

## Run the server

From the project root:

```bash

npm ci 

npm start 

```

This starts the MCP server over stdio. The server does not take a Jira ticket as a command-line argument at startup. Instead, a client calls the tool after connecting.

## Typical usage

### 1) Use through an MCP host

This project includes a starter VS Code config at [`.vscode/mcp.json`](.vscode/mcp.json). In VS Code, open the workspace through WSL/Remote if needed, then let the MCP host start the server automatically.

Once connected, a user can ask in natural language, for example:

- "Get Jira issue PROJ-123"
- "Search Jira for open issues in project PROJ"
- "Triage project PROJ"

The client/agent will usually translate those requests into tool calls like:

```json

{ 

  "name": "get_jira_issue", 

  "arguments": { 

    "issueKey": "PROJ-123" 

  } 

} 

```

or

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND status in (Open, \"To Do\") ORDER BY priority DESC, created ASC" 

  } 

} 

```

### VS Code / Copilot workflow

If you are using VS Code with Copilot or another MCP-compatible agent:

1. Open the workspace in VS Code.
2. Ensure the folder is opened through the WSL remote environment if you are developing in WSL.
3. Keep the repo root as the workspace folder.
4. The MCP server can be started automatically from [`.vscode/mcp.json`](.vscode/mcp.json).
5. Ask the agent something like:

```text

Triage project PROJ and list the top unresolved issues. 

```

Or:

```text

Get Jira issue PROJ-123 and summarize it for me. 

```

The host should select the correct tool based on the available tool metadata and your workspace instructions from `.github/copilot-instructions.md`.

### Claude Desktop / Cursor / other MCP clients

A generic MCP client usually supports a configuration block similar to:

```json

{ 

  "mcpServers": { 

    "jira-mcp": { 

      "command": "npm", 

      "args": ["start"], 

      "cwd": "/path/to/jira-mcp" 

    } 

  } 

} 

```

Then a user can ask the client to do Jira work in natural language, without manually passing a ticket at startup time. The issue key, project key, and JQL are supplied at runtime when the host chooses the appropriate tool call.

### 2) Use the demo client

This project also includes a small TypeScript example client that launches the server and calls the tools:

```bash

npm run example:client -- PROJ-123 

```

If you omit the issue key, the client lists the available tools and exits:

```bash

npm run example:client 

```

### 3) Use the Jira triage example

A second example script searches for a project backlog and then fetches the top few issues individually:

```bash

npm run example:triage -- IPCM 

```

For a compact human-readable backlog summary only:

```bash

npm run example:triage -- IPCM --compact 

```

You can also pass a project and custom statuses explicitly:

```bash

npm run example:triage -- --project BOS --status 'Ready to Work' --status 'In Progress' --max-results 20 --compact 

```

If a status contains spaces, keep it in quotes as shown above.

This script launches the MCP server internally, runs a JQL search such as:

```sql

project = IPCM AND status in ("Open", "To Do", "Ready to Work", "In Progress") ORDER BY priority DESC, created ASC 

```

and then prints a concise backlog summary for all matching issues, fetching each issue for details unless you use `--compact`, which prints only a tighter summary view.

## Project triage workflow

The recommended pattern for a project-based Jira triage is:

1. Search by project key and status first.
2. Sort the results by priority or updated date.
3. Fetch the top few issues individually for details.
4. Summarize the likely next actions.

Recommended JQL pattern:

```sql

project = PROJ AND status in ("Open", "To Do", "Ready to Work", "In Progress") ORDER BY priority DESC, created ASC 

```

This gives the fastest triage view of the backlog for a specific project.

Examples:

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND status in (Open, \"To Do\") ORDER BY priority DESC, created ASC" 

  } 

} 

```

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND assignee = currentUser() ORDER BY updated DESC" 

  } 

} 

```

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND priority = Highest ORDER BY created ASC" 

  } 

} 

```

Then retrieve specific issues with:

```json

{ 

  "name": "get_jira_issue", 

  "arguments": { 

    "issueKey": "PROJ-123" 

  } 

} 

```

A natural-language prompt for an agent could be:

```text

Triage project PROJ. Show the top 10 unresolved issues by priority, then fetch the top 3 highest-priority issues for details. 

```

That pattern maps naturally to `search_jira` followed by a few targeted `get_jira_issue` calls.

## Support and staffing workflow examples

You can also use the same server for support-style or staffing-style work by changing the JQL.

Example: my assigned issues

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "assignee = currentUser() AND status in (Open, \"In Progress\") ORDER BY updated DESC" 

  } 

} 

```

Example: unassigned blockers

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND assignee is EMPTY AND priority in (Highest, High) ORDER BY created ASC" 

  } 

} 

```

Example: issues updated in the last 7 days

```json

{ 

  "name": "search_jira", 

  "arguments": { 

    "jql": "project = PROJ AND updated >= -7d ORDER BY updated DESC" 

  } 

} 

```

These patterns work well for daily support check-ins, ownership review, and backlog hygiene.

## Notes for agent behavior

The workspace includes these optional Copilot customizations for using the Jira tools:

- `.github/copilot-instructions.md`
- `.github/agents/jira-duplicate-demo.agent.md`
- `.github/prompts/jira-duplicates.prompt.md`

These files are not required for the server to run, but they help an agent choose the proper tool and keep responses concise.

## Troubleshooting

### `Cannot find module 'dotenv'`

Make sure dependencies are installed and that the workspace is opened through the proper WSL/Node environment.

```bash

npm ci 

npm run typecheck 

```

### `JIRA_URL`, `JIRA_USER`, or `JIRA_API_TOKEN` missing

Check `.env` and verify the values are set exactly.

### Server starts but no tools appear

Verify the MCP host attached to the server and that the server process is still running.
