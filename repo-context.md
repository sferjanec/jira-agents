
You do not need to rewrite the prompt or hardcode a unique `TASK.md` template for every repository.

Hardcoding repo structures into prompt templates creates brittle maintenance overhead across projects. Instead, decouple the **universal planning structure** from **dynamic repo inspection**.

The standard approach uses a **two-phase architecture** where Agent 1 automatically extracts the target repository's topology and conventions *before* writing the specification.

---

### The Dynamic Repository Discovery Pipeline

Rather than guessing where files belong, Agent 1 executes a lightweight discovery phase:

```
                  [ Jira Issue Description ]
                              │
                              ▼
        ┌───────────────────────────────────────────┐
        │ 1. Local Workspace Inspection (Agent 1)   │
        │ • Reads Repo Config (.github, package.json│
        │   pom.xml, or .csproj)                    │
        │ • Samples directory tree & conventions    │
        │ • Inspects existing neighbor patterns     │
        └─────────────────────┬─────────────────────┘
                              │ Dynamic Repo Context
                              ▼
        ┌───────────────────────────────────────────┐
        │ 2. Context Injection into Generic Planner │
        │ • Planner merges Jira requirements with   │
        │   discovered folder structure & stack     │
        └─────────────────────┬─────────────────────┘
                              │
                              ▼
             [ Generated Repo-Accurate TASK.md ]
                              │
                              ▼
        ┌───────────────────────────────────────────┐
        │ 3. Scaffolding (Agent 2 / Copilot)        │
        │ • Generates code matching actual repo     │
        │   paths, namespaces, and patterns         │
        └───────────────────────────────────────────┘

```

---

### Phase 1: Automated Repo Introspection

When your MCP server runs the `create_feature_spec` tool, it receives the `workspaceRoot` path. Before calling the LLM, the server performs three quick filesystem reads:

#### 1. Ingest Repo Custom Instructions (Zero Inference Cost)

Most repositories designed for AI workflows maintain a convention file:

* **Copilot Instructions:** `.github/copilot-instructions.md`
* **General AI Rules:** `CLAUDE.md`, `AGENTS.md`, or `.cursorrules`

If any of these exist, read and pass them directly into the prompt as the repository's ground truth.

#### 2. Detect the Stack Manifest

Inspect the root directory for build definitions:

* `pom.xml` / `build.gradle` $\rightarrow$ Java / Spring Boot conventions (`src/main/java/...`).
* `*.csproj` $\rightarrow$ .NET conventions (Namespaces, `Controllers/`, `Services/`).
* `package.json` $\rightarrow$ TypeScript / Node / Frontend conventions (`src/`, `@nestjs`, etc.).

#### 3. Shallow Directory Tree Scan

Generate a pruned directory outline (excluding `node_modules`, `target`, `bin`, `obj`, `.git`):

```text
src/
├── api/
│   └── v1/
├── core/
│   ├── models/
│   └── services/
└── test/

```

Passing this shallow tree takes only ~200 tokens but anchors the LLM to existing project paths.

---

### Phase 2: Finding a "Peer" Example (Exemplar Pattern)

To ensure generated controllers or services follow the exact syntax, DI pattern, and naming used in that specific codebase, Agent 1 can inspect one existing peer file.

If the Jira ticket is about adding a new API endpoint, the agent finds an existing controller/service pair:

1. Glob search: `*Controller.*` or `*Service.*`.
2. Grab the first small controller (or its interface/imports).
3. Feed that snippet to Agent 1 as a **structural exemplar**:

> *"Here is an existing controller in this repo (`src/controllers/user.controller.ts`). Ensure all new endpoints and classes match its decorator style, error envelope, and dependency injection style."*

---

### How to Implement This in Your TypeScript MCP Server

Integrate dynamic context collection directly into your MCP tool handler:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface RepoContext {
  stackInfo: string;
  projectRules: string;
  directoryStructure: string;
}

// Inspect workspace on the fly
async function gatherRepoContext(workspaceRoot: string): Promise<RepoContext> {
  // 1. Check for Copilot / Agent instruction files
  let projectRules = "";
  const candidateRules = [
    ".github/copilot-instructions.md",
    "AGENTS.md",
    "CLAUDE.md"
  ];
  for (const rulePath of candidateRules) {
    try {
      projectRules = await fs.readFile(path.join(workspaceRoot, rulePath), "utf-8");
      break;
    } catch {
      // Continue checking
    }
  }

  // 2. Detect build stack
  let stackInfo = "Generic/Unknown";
  const files = await fs.readdir(workspaceRoot);
  if (files.includes("pom.xml")) stackInfo = "Java / Maven (Spring Boot)";
  else if (files.some(f => f.endsWith(".csproj"))) stackInfo = "C# / .NET";
  else if (files.includes("package.json")) {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf-8"));
    stackInfo = `Node.js (${pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 5).join(", ") : "Vanilla"})`;
  }

  // 3. Simple top-level folder scan
  const dirStructure = files
    .filter(f => !f.startsWith(".") && !["node_modules", "target", "bin", "dist"].includes(f))
    .join(", ");

  return { stackInfo, projectRules, directoryStructure: dirStructure };
}
```

---

### The Universal Template Strategy

With dynamic discovery in place, the prompt template remains universal across any codebase:

```markdown
You are generating a TASK.md specification for the following repository:

Target Repository Profile:
- Detected Stack: {{stackInfo}}
- Top-level Layout: {{directoryStructure}}
- Workspace AI Conventions:
{{projectRules}}

Rules for Scaffolding:
1. Align all file paths with the observed layout above (e.g., if the project uses `src/main/java/...`, place classes there; if it uses `Controllers/`, place controllers there).
2. Follow the architectural paradigm established in the workspace conventions.
3. If no conventions are specified, use standard layered clean architecture:
   - Contracts/DTOs
   - Service interfaces
   - Service implementation stubs
   - Unit test suites

```

### Result

* **One MCP Server:** Works across Java, .NET, TypeScript, Python, or Go codebases without prompt editing.
* **Deterministic Output:** Agent 1 generates file paths that exist in the target project.
* **Seamless Handoff:** When Agent 2 (or GitHub Copilot) receives the generated `TASK.md`, it can run `touch <path>` or generate the files without guessing file locations or misaligning module imports.
