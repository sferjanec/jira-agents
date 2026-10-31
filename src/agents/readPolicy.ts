import { realpathSync } from "node:fs";
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

// Decides whether a model-requested read stays inside the repository and targets a file type
// worth the tokens. A directory (the root itself included) is allowed so listing and search work.
export function isReadAllowed(root: string, requested: string): boolean {
    // Search tools sometimes pass a quoted path; the quotes are stripped before resolving.
    const relativePath = resolveInside(root, requested.replace(/^(["'])(.*)\1$/, "$2"));
    if (relativePath === undefined) {
        return false;
    }
    if (relativePath === "") {
        return true;
    }
    const parts = relativePath.split(sep);
    if (parts.some((part) => part.startsWith(".") || excludedDirectories.has(part))) {
        return false;
    }
    const name = basename(relativePath);
    if (lockFiles.has(name) || /\.(?:min\.js|map)$/i.test(name)) {
        return false;
    }
    const extension = extname(name);
    return extension === "" || readableExtensions.has(extension.toLowerCase());
}
