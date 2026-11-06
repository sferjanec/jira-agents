# Spec-First Feature Workflow: Detailed Flow (who calls what)

Companion to the high-level flow in [feature-workflow.md](./feature-workflow.md). This view shows, for every step, **which actor acts**, **when the MCP server is involved**, and **which tool or built-in is called**.

## Legend

| Actor         | What it is                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Developer     | Human in VS Code                                                                                         |
| Chat agent    | VS Code Copilot chat (MCP client). Only calls the two MCP tools when the developer asks                  |
| `plan:jira` script | `npm run plan:jira -- <KEY> <repo>` runs `src/example-plan-jira.ts`. Calls the planner service in-process, not over MCP |
| MCP server    | TypeScript server `jira-mcp`. Runs deterministic code, hosts the tools, orchestrates agents            |
| Planner agent | Copilot SDK session started by `create_feature_spec`. Built-in tools `view`, `grep`, `glob` only |
| Builder agent | Copilot SDK session started by `build_feature_from_spec`. No tools, JSON in / JSON out                 |
| Jira / Repo   | Jira REST API (read-only, optional comment/label) and the local git repository                           |

In the server-orchestrated pattern, planner and builder agents never call MCP tools themselves; the MCP server calls them. In the agent-driven pattern the agents call the MCP tools directly.

## Orchestration patterns: server-orchestrated and agent-driven

A common mental model is: a script starts the MCP server, starts a first agent, and that agent calls tools such as `get_jira_issue` on the server. **The workflow supports both that agent-driven pattern and the original server-orchestrated one.** The tables and the first diagram below describe the original, server-orchestrated pattern (`create_feature_spec`, `build_feature_from_spec`). The agent-driven pattern is described in [Agent-driven pattern (implemented)](#agent-driven-pattern-implemented).

|                                     | Agent-driven (not used here)             | Server-orchestrated (used here)                                      |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Entry point                         | Script launches server, then an agent    | Either the chat agent making one MCP tool call, or `npm run plan:jira` calling the same service function in-process (no MCP) |
| Who fetches Jira data               | The agent, by calling `get_jira_issue` | The MCP server's TypeScript code, directly                           |
| Who decides the next step           | The agent (LLM)                          | Deterministic TypeScript in the tool handler                         |
| Copilot SDK agents                  | Call MCP tools                           | Are started by the server, are given prepared input, and return JSON |
| MCP tools available to those agents | Yes                                      | None                                                                 |

Why: the Jira ticket is untrusted text. Keeping Jira access, git, file writes and validation in code means the LLM can only produce a proposal (plan JSON or file contents). The server validates that proposal before anything is saved or written. The planner's only reach is read-only `view`/`grep`/`glob` on the repo. The builder has no tools.

`get_jira_issue` and `search_jira` are standalone MCP tools. `create_feature_spec` and `build_feature_from_spec` do not call them; the agent-driven planner does call `get_jira_issue`.

## Entry points for the plan stage

`create_feature_spec` and `npm run plan:jira` share the same service, `createFeatureSpecService` in `src/tools/createFeatureSpec.ts`. Only the way it is invoked differs.

| Entry point | Command | Path to the planner |
| --- | --- | --- |
| Chat agent (MCP) | Developer asks in VS Code chat | Chat agent -> MCP `create_feature_spec` -> service -> planner agent |
| Script | `npm run plan:jira -- <ISSUE-KEY> <absolute-repo-path>` | `src/example-plan-jira.ts` -> service -> planner agent. The MCP server is not started and no MCP call is made |

The diagram below shows the chat-agent path. For the script path, replace "Chat agent" and the MCP tool call with the script calling the service directly; everything from "GET issue" onward is identical.

## Detailed flow (server-orchestrated)

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant Chat as Chat agent<br/>(MCP client)
    participant MCP as MCP server<br/>(jira-mcp, TypeScript)
    participant Jira as Jira
    participant Repo as Local git repo
    participant Plan as Planner agent<br/>(Copilot SDK)
    participant Build as Builder agent<br/>(Copilot SDK)

    rect rgb(235, 245, 255)
    Note over Dev,Plan: Stage 1 - Plan
    Dev->>Chat: "Create a plan for KEY-123"
    Chat->>MCP: MCP tool call: create_feature_spec(issueKey, workspaceRoot)
    MCP->>Jira: GET issue (read-only)
    MCP->>Repo: Read bounded context (layout, instruction files)
    MCP->>Plan: Start session with ticket (untrusted) + context
    loop Planner explores the repo
        Plan->>Repo: Built-in tools: view / grep / glob (read policy enforced)
    end
    Plan-->>MCP: Plan JSON (or clarification questions)
    MCP->>MCP: Validate with Zod, check paths, render Markdown
    MCP->>Repo: Write .specs/KEY-TASK.md (no overwrite)
    opt Ticket too vague
        MCP->>Repo: Write .specs/KEY-CLARIFICATIONS.md
        MCP->>Jira: Optional comment (JIRA_POST_CLARIFICATIONS=true)
    end
    opt JIRA_AGENT_LABEL set
        MCP->>Jira: Add label
    end
    MCP-->>Chat: Plan path
    Chat-->>Dev: Plan ready for review
    end

    rect rgb(255, 248, 225)
    Note over Dev,Repo: Stage 2 - Human approval gate (no MCP, no agent)
    Dev->>Repo: Review and edit .specs/KEY-TASK.md
    end

    rect rgb(235, 255, 238)
    Note over Dev,Build: Stage 3 - Build
    Dev->>Chat: "Build KEY-123 from the approved plan"
    Chat->>MCP: MCP tool call: build_feature_from_spec(issueKey, workspaceRoot)
    MCP->>Repo: git preflight (clean tree, branch absent)
    MCP->>Repo: git switch -c agent/key-builder
    MCP->>Repo: Read approved plan + listed files only
    MCP->>Build: Start session with plan + file context (no tools)
    Build-->>MCP: JSON: files[] + skipped[]
    MCP->>MCP: Validate every path and content
    MCP->>Repo: Write files (temp file + rename)
    MCP-->>Chat: Branch, files written, skipped with reasons
    Chat-->>Dev: Summary
    end

    rect rgb(245, 240, 255)
    Note over Dev,Repo: Stage 4 - Verify (human only)
    Dev->>Repo: Review diff, run tests, commit, push, PR
    end
```

## Step table

| #  | Stage  | Who acts      | Calls                             | Via                   | MCP server involved?       |
| -- | ------ | ------------- | --------------------------------- | --------------------- | -------------------------- |
| 1  | Plan   | Chat agent    | `create_feature_spec`           | MCP tool call         | Yes, entry point           |
| 2  | Plan   | MCP server    | Jira issue fetch                  | Jira REST (read-only) | Yes                        |
| 3  | Plan   | MCP server    | Repo layout and instruction files | Local file reads      | Yes                        |
| 4  | Plan   | MCP server    | Planner agent                     | Copilot SDK session   | Yes, starts agent          |
| 5  | Plan   | Planner agent | `view`, `grep`, `glob`      | SDK built-in tools    | No (agent's own tools)     |
| 6  | Plan   | MCP server    | Validate, render, save plan       | Local code            | Yes                        |
| 7  | Plan   | MCP server    | Jira comment / label (optional)   | Jira REST             | Yes, only if env flags set |
| 8  | Gate   | Developer     | Edit plan                         | Editor                | No                         |
| 9  | Build  | Chat agent    | `build_feature_from_spec`       | MCP tool call         | Yes, entry point           |
| 10 | Build  | MCP server    | git preflight, create branch      | git                   | Yes                        |
| 11 | Build  | MCP server    | Builder agent                     | Copilot SDK session   | Yes, starts agent          |
| 12 | Build  | Builder agent | Nothing (returns JSON)            | n/a                   | No                         |
| 13 | Build  | MCP server    | Validate and write files          | Local code            | Yes                        |
| 14 | Verify | Developer     | Diff, tests, commit, push         | git / IDE             | No                         |

Other MCP tools (`search_jira`, `get_jira_issue`, `audit_jira_duplicates`, `fetch_triage_backlog`, `fetch_candidate_descriptions`) are separate and are not part of this workflow.

---

# Agent-driven pattern (implemented)

The MCP server also exposes the workflow as small, composable tools. A script starts the server as a subprocess and gives a Copilot SDK agent session access to those tools through `mcpServers`. The agent itself decides when to call each tool. This makes the server a toolbox that any script or agent can reuse, instead of a black box that runs its own agents.

| Script | Command | Agent's MCP tools |
| --- | --- | --- |
| `src/example-plan-agent.ts` | `npm run plan:agent -- <KEY> <absolute-repo-path> [--simulate]` | `get_jira_issue`, `get_repo_context`, `save_feature_plan` |
| `src/example-build-agent.ts` | `npm run build:agent -- <KEY> <absolute-repo-path>` | `read_approved_plan`, `create_build_branch`, `write_planned_file` |

The planner agent also keeps the SDK built-ins `view`, `grep` and `glob` (read policy and read budget enforced) for repo exploration. The builder agent has no built-in tools.

## Plan flow

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant Script as Script<br/>(npm run plan:agent)
    participant Agent as Planner agent<br/>(Copilot SDK session)
    participant MCP as MCP server<br/>(jira-mcp, subprocess)
    participant Jira as Jira (or fixture file)
    participant Repo as Local git repo

    Dev->>Script: npm run plan:agent -- KEY-123 /repo
    Script->>Agent: Create session with mcpServers = jira-mcp<br/>(allow-list: 3 MCP tools + view/grep/glob)
    Note over Script,MCP: The SDK starts the server over stdio when the session is created
    Agent->>MCP: MCP tool call: get_jira_issue(KEY-123, includeDetails)
    MCP->>Jira: GET issue (read-only)
    MCP-->>Agent: Issue (untrusted data)
    Agent->>MCP: MCP tool call: get_repo_context(workspaceRoot)
    MCP->>Repo: Read bounded layout and instruction files
    MCP-->>Agent: Layout, stack, instructions
    loop Agent explores the repo
        Agent->>Repo: Built-in view / grep / glob (read policy enforced)
    end
    Agent->>MCP: MCP tool call: save_feature_plan(issueKey, summary, workspaceRoot, plan)
    MCP->>MCP: Validate plan schema and file paths, render Markdown
    alt Plan is valid
        MCP->>Repo: Write .specs/KEY-TASK.md (never overwrite)
        MCP-->>Agent: Saved path
    else Open question starts with NEEDS CLARIFICATION
        MCP->>Repo: Write .specs/KEY-CLARIFICATIONS.md, no plan
        MCP-->>Agent: needsClarification + questions
    else Validation error
        MCP-->>Agent: Error code; agent fixes the plan and retries
    end
    Agent-->>Script: One-line result
    Script-->>Dev: Tool trace and result
```

## Human approval gate

Unchanged: the developer reviews and edits `.specs/KEY-TASK.md`. No agent or MCP call is involved.

## Build flow

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant Script as Script<br/>(npm run build:agent)
    participant Agent as Builder agent<br/>(Copilot SDK session)
    participant MCP as MCP server<br/>(jira-mcp, subprocess)
    participant Repo as Local git repo

    Dev->>Script: npm run build:agent -- KEY-123 /repo
    Script->>Agent: Create session with mcpServers = jira-mcp<br/>(allow-list: 3 MCP tools, no built-ins)
    Agent->>MCP: MCP tool call: read_approved_plan(issueKey, workspaceRoot)
    MCP->>Repo: Read .specs/KEY-TASK.md, planned files, examples
    MCP-->>Agent: Plan + current file contents + instructions
    Agent->>MCP: MCP tool call: create_build_branch(issueKey, workspaceRoot)
    MCP->>Repo: Preflight (clean tree, branch absent), git switch -c agent/key-builder
    MCP-->>Agent: Branch name
    loop For each planned file
        Agent->>MCP: MCP tool call: write_planned_file(issueKey, workspaceRoot, path, content)
        MCP->>MCP: Path must be listed in the plan and safe;<br/>current branch must be agent/key-builder
        MCP->>Repo: Write file (temp + rename)
        MCP-->>Agent: created / modified, or error
    end
    Agent-->>Script: Branch, files written, skipped with reasons
    Script-->>Dev: Tool trace and summary
```

## Tool reference

| Tool | Used by | Responsibility | Guardrails enforced inside the tool |
| --- | --- | --- | --- |
| `get_jira_issue` | Planner | Fetch one issue (`includeDetails` adds description and comments) | Read-only; with `JIRA_FIXTURES_DIR` set, reads local fixture files instead of Jira |
| `get_repo_context` | Planner | Bounded layout, stack and instruction files | Size limits, read-only |
| `save_feature_plan` | Planner | Validate, render and save the plan, or save clarifications | Zod plan schema, safe relative paths, no overwrite, writes only under `.specs/` |
| `read_approved_plan` | Builder | Return the approved plan, current contents of planned files, examples | Read-only; plan must be a valid saved plan; size limits |
| `create_build_branch` | Builder | Create `agent/{key}-builder` | Clean tree (except the plan), branch must not exist, never pushes |
| `write_planned_file` | Builder | Write one planned file | Path must be listed in the approved plan, safe path rules, must be on the build branch, atomic write |

Both scripts allow only these MCP tools in `onPermissionRequest`, and the SDK names them with the server prefix (for example `jira-mcp-write_planned_file`), so the allow-list accepts both forms.

## Both patterns side by side

| | Server-orchestrated (original) | Agent-driven (implemented) |
| --- | --- | --- |
| Plan entry points | MCP `create_feature_spec`, `npm run plan:jira`, `npm run simulate -- plan` | `npm run plan:agent` |
| Build entry points | MCP `build_feature_from_spec`, `npm run simulate -- build` | `npm run build:agent` |
| Who calls `get_jira_issue` | Nobody; server code reads Jira directly | The planner agent |
| Who decides call order | TypeScript in the tool handler | The agent, guided by its prompt |
| Agent output | JSON the server validates | Tool calls the server validates one at a time |
| Single-flight guard, timeouts, run metrics | In the tool handlers | Overall timeout in the script only; no metrics yet |
| Jira clarification comment and label | Supported (env flags) | Not supported yet |

The original tools `create_feature_spec` and `build_feature_from_spec` are unchanged and still available.

## Testing without Jira

`npm run plan:agent -- SIM-101 /path/to/repo --simulate` sets `JIRA_FIXTURES_DIR` for the server subprocess, so `get_jira_issue` reads `simulation/fixtures/SIM-101.txt` and Jira is never contacted. The first line of a fixture is the summary and the rest is the description.

## Trade-offs to raise with the lead

- **Security moves into the tools.** The agent holds ticket text (untrusted) and write-capable tools in one session, so a prompt-injected ticket could try to steer tool calls. Today each tool enforces its own limits (plan-listed paths only, branch check, no overwrite, read policy). Stronger controls such as injection detection and per-run approval are deferred until beyond the demo.
- **Less deterministic.** The agent chooses the call order, so runs vary. Tool errors are written so the agent can recover.
- **Prompt-dependent.** Correct order relies on the agent prompts in the two scripts.
- **Not yet ported:** the Jira clarification comment and label, run metrics, and the single-flight guard.
- **Reuse.** Other scripts and agents can mix these tools freely, which is the main benefit.
