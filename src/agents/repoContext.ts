import { lstat, mkdir, open, readdir, realpath, link, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { FeatureSpecFailure } from "./featureSpecFailure.js";

export interface RepoContext {
    workspaceRoot: string;
    stack: string[];
    layout: string;
    instructions: string;
}

const ignoredDirectories = new Set([
    ".git", ".next", ".venv", "bin", "build", "coverage", "dist", "node_modules",
    "obj", "out", "target", "vendor"
]);
const instructionFiles = [
    ".github/copilot-instructions.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules"
];
const maxLayoutEntries = 120;
const maxInstructionCharacters = 12000;
const maxInstructionFileCharacters = 6000;

function isInside(root: string, target: string): boolean {
    const pathFromRoot = relative(root, target);
    return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function isErrno(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error &&
        (error as NodeJS.ErrnoException).code === code;
}

async function readInstructions(root: string): Promise<string> {
    const sections: string[] = [];
    let remaining = maxInstructionCharacters;
    for (const file of instructionFiles) {
        if (remaining <= 0) {
            break;
        }
        try {
            const filePath = join(root, file);
            const info = await lstat(filePath);
            const resolvedPath = await realpath(filePath);
            if (!info.isFile() || info.isSymbolicLink() || !isInside(root, resolvedPath)) {
                continue;
            }
            const fileHandle = await open(filePath, "r");
            let excerpt: string;
            try {
                const buffer = Buffer.alloc(Math.min(maxInstructionFileCharacters, remaining));
                const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
                excerpt = buffer.toString("utf8", 0, bytesRead);
            } finally {
                await fileHandle.close();
            }
            if (excerpt.trim()) {
                sections.push(`### ${file}\n${excerpt}`);
                remaining -= excerpt.length;
            }
        } catch (error) {
            if (!isErrno(error, "ENOENT")) {
                throw new FeatureSpecFailure("WORKSPACE_ACCESS_FAILED");
            }
        }
    }
    return sections.join("\n\n") || "No recognized repository instruction files were found.";
}

async function readLayout(root: string): Promise<string> {
    const lines: string[] = [];
    let included = 0;
    async function visit(directory: string, prefix: string, depth: number): Promise<void> {
        if (depth > 2 || included >= maxLayoutEntries) {
            return;
        }
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (included >= maxLayoutEntries) {
                break;
            }
            if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) {
                continue;
            }
            const isDirectory = entry.isDirectory();
            lines.push(`${prefix}${entry.name}${isDirectory ? "/" : ""}`);
            included += 1;
            if (isDirectory && depth < 2) {
                await visit(join(directory, entry.name), `${prefix}  `, depth + 1);
            }
        }
    }
    await visit(root, "", 0);
    return lines.join("\n") || "(No visible files or directories found.)";
}

export async function gatherRepoContext(workspacePath: string): Promise<RepoContext> {
    if (!isAbsolute(workspacePath)) {
        throw new FeatureSpecFailure("INVALID_WORKSPACE");
    }
    let root: string;
    try {
        root = await realpath(resolve(workspacePath));
        const info = await lstat(root);
        if (!info.isDirectory()) {
            throw new FeatureSpecFailure("INVALID_WORKSPACE");
        }
    } catch (error) {
        if (error instanceof FeatureSpecFailure) {
            throw error;
        }
        throw new FeatureSpecFailure("INVALID_WORKSPACE");
    }

    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        throw new FeatureSpecFailure("WORKSPACE_ACCESS_FAILED");
    }
    const rootNames = new Set(entries);
    const stack = [
        ...(rootNames.has("package.json") ? ["Node.js / JavaScript or TypeScript (package.json present)"] : []),
        ...(rootNames.has("pom.xml") ? ["Java / Maven (pom.xml present)"] : []),
        ...(rootNames.has("build.gradle") || rootNames.has("build.gradle.kts") ? ["Gradle (build file present)"] : []),
        ...(entries.some((entry) => entry.endsWith(".csproj")) ? ["C# / .NET (.csproj present)"] : []),
        ...(rootNames.has("pyproject.toml") || rootNames.has("requirements.txt") ? ["Python (project manifest present)"] : []),
        ...(rootNames.has("go.mod") ? ["Go (go.mod present)"] : [])
    ];
    try {
        const [layout, instructions] = await Promise.all([readLayout(root), readInstructions(root)]);
        return {
            workspaceRoot: root,
            stack: stack.length ? stack : ["No recognized build manifest found."],
            layout,
            instructions
        };
    } catch (error) {
        if (error instanceof FeatureSpecFailure) {
            throw error;
        }
        throw new FeatureSpecFailure("WORKSPACE_ACCESS_FAILED");
    }
}

export async function saveFeatureSpec(
    workspaceRoot: string,
    issueKey: string,
    content: string
): Promise<string> {
    if (!isAbsolute(workspaceRoot) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
        throw new FeatureSpecFailure("INVALID_WORKSPACE");
    }
    const outputDirectory = join(workspaceRoot, ".specs");
    const outputPath = join(outputDirectory, `${issueKey}-TASK.md`);
    const temporaryPath = join(outputDirectory, `.${issueKey}-${randomUUID()}.tmp`);
    try {
        const root = await realpath(workspaceRoot);
        await mkdir(outputDirectory, { recursive: true });
        const directoryInfo = await lstat(outputDirectory);
        const actualDirectory = await realpath(outputDirectory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
            actualDirectory !== join(root, ".specs") || !isInside(root, actualDirectory)) {
            throw new FeatureSpecFailure("WORKSPACE_ACCESS_FAILED");
        }

        const file = await open(temporaryPath, "wx", 0o600);
        try {
            await file.writeFile(content, "utf8");
        } finally {
            await file.close();
        }
        await link(temporaryPath, outputPath);
        return outputPath;
    } catch (error) {
        if (isErrno(error, "EEXIST")) {
            throw new FeatureSpecFailure("SPEC_ALREADY_EXISTS");
        }
        if (error instanceof FeatureSpecFailure) {
            throw error;
        }
        throw new FeatureSpecFailure("SPEC_SAVE_FAILED");
    } finally {
        try {
            await unlink(temporaryPath);
        } catch (error) {
            if (!isErrno(error, "ENOENT")) {
                throw new FeatureSpecFailure("SPEC_SAVE_FAILED");
            }
        }
    }
}

async function specsDirectory(workspaceRoot: string, issueKey: string): Promise<string> {
    if (!isAbsolute(workspaceRoot) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
        throw new FeatureSpecFailure("INVALID_WORKSPACE");
    }
    const root = await realpath(workspaceRoot);
    const directory = join(workspaceRoot, ".specs");
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || actual !== join(root, ".specs") || !isInside(root, actual)) {
        throw new FeatureSpecFailure("WORKSPACE_ACCESS_FAILED");
    }
    return directory;
}

// Unlike the plan, the clarification file is replaced on every run so it always reflects the latest questions.
export async function saveClarifications(workspaceRoot: string, issueKey: string, content: string): Promise<string> {
    const temporaryName = `.${issueKey}-${randomUUID()}.tmp`;
    try {
        const directory = await specsDirectory(workspaceRoot, issueKey);
        const outputPath = join(directory, `${issueKey}-CLARIFICATIONS.md`);
        const temporaryPath = join(directory, temporaryName);
        const file = await open(temporaryPath, "wx", 0o600);
        try {
            await file.writeFile(content, "utf8");
        } finally {
            await file.close();
        }
        await rename(temporaryPath, outputPath);
        return outputPath;
    } catch (error) {
        if (error instanceof FeatureSpecFailure) {
            throw error;
        }
        throw new FeatureSpecFailure("SPEC_SAVE_FAILED");
    }
}

export async function removeClarifications(workspaceRoot: string, issueKey: string): Promise<void> {
    try {
        const directory = await specsDirectory(workspaceRoot, issueKey);
        await unlink(join(directory, `${issueKey}-CLARIFICATIONS.md`));
    } catch (error) {
        if (error instanceof FeatureSpecFailure || isErrno(error, "ENOENT")) {
            return;
        }
        throw new FeatureSpecFailure("SPEC_SAVE_FAILED");
    }
}
