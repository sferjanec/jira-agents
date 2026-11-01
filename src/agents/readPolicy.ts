import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const excludedDirectories = new Set([
    "bin", "build", "coverage", "dist", "node_modules", "obj", "out", "target", "vendor", "__pycache__"
]);
const readableExtensions = new Set([
    ".java", ".kt", ".cs", ".cshtml", ".razor", ".ts", ".tsx", ".js", ".jsx", ".vue", ".py", ".go", ".rb",
    ".html", ".htm", ".jsp", ".css", ".scss", ".xml", ".properties", ".yml", ".yaml", ".json", ".sql",
    ".md", ".txt", ".resx", ".gradle", ".kts"
]);
const lockFiles = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const maxPathCharacters = 1000;
// Generated or bulky artifacts that cost many tokens and rarely help planning.
const generatedFilePattern = /(?:\.(?:min\.(?:js|css)|map|svg|lcov)$|^(?:swagger|openapi)[^/]*\.json$|^(?:coverage|lcov|jacoco|cobertura|junit)[^/]*\.xml$)/i;
const localizationPattern = /(?:^|[._-])(?:i18n|l10n|locale|locales|translations?)(?:[._-]|$)/i;
export const maxReadBytes = 200_000;

function resolveInside(root: string, requested: string): string | undefined {
    if (!requested || requested.length > maxPathCharacters || /[\u0000-\u001f]/.test(requested)) {
        return undefined;
    }
    try {
        const realRoot = realpathSync(root);
        const target = realpathSync(isAbsolute(requested) ? requested : resolve(root, requested));
        const relativePath = relative(realRoot, target);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
            return undefined;
        }
        return relativePath;
    } catch {
        return undefined;
    }
}

export type ReadDecision = { allowed: true; bytes: number } | { allowed: false; reason: string };

const notPermitted: ReadDecision = { allowed: false, reason: "Only reading source files inside the repository is permitted." };

// Decides whether a model-requested read stays inside the repository and targets a file type
// worth the tokens. A directory (the root itself included) is allowed so listing and search work.
export function checkRead(root: string, requested: string): ReadDecision {
    // Search tools sometimes pass a quoted path; the quotes are stripped before resolving.
    const relativePath = resolveInside(root, requested.replace(/^(["'])(.*)\1$/, "$2"));
    if (relativePath === undefined) {
        return notPermitted;
    }
    if (relativePath === "") {
        return { allowed: true, bytes: 0 };
    }
    const parts = relativePath.split(sep);
    if (parts.some((part) => part.startsWith(".") || excludedDirectories.has(part))) {
        return notPermitted;
    }
    const name = basename(relativePath);
    if (lockFiles.has(name) || generatedFilePattern.test(name) || parts.some((part) => localizationPattern.test(part))) {
        return notPermitted;
    }
    const extension = extname(name);
    if (extension !== "" && !readableExtensions.has(extension.toLowerCase())) {
        return notPermitted;
    }
    const stats = statSync(resolve(root, relativePath));
    if (stats.isDirectory()) {
        return { allowed: true, bytes: 0 };
    }
    if (stats.size > maxReadBytes) {
        return {
            allowed: false,
            reason: `File is too large (${stats.size} bytes, limit ${maxReadBytes}). Use grep for specific symbols in other files instead.`
        };
    }
    return { allowed: true, bytes: stats.size };
}

export function isReadAllowed(root: string, requested: string): boolean {
    return checkRead(root, requested).allowed;
}

// Caps the total work one exploration session may do, regardless of per-call limits.
export class ReadBudget {
    private reads = 0;
    private bytes = 0;
    private exhaustedFlag = false;

    constructor(private readonly maxReads = 40, private readonly maxBytes = 600_000) {}

    get bytesRead(): number {
        return this.bytes;
    }

    get exhausted(): boolean {
        return this.exhaustedFlag;
    }

    // Returns a rejection reason when the request is denied, otherwise records it and returns undefined.
    consume(decision: ReadDecision): string | undefined {
        if (!decision.allowed) {
            return decision.reason;
        }
        if (this.reads + 1 > this.maxReads || this.bytes + decision.bytes > this.maxBytes) {
            this.exhaustedFlag = true;
            return "Read budget exhausted. Stop exploring and produce the answer from what you have already read.";
        }
        this.reads += 1;
        this.bytes += decision.bytes;
        return undefined;
    }
}
