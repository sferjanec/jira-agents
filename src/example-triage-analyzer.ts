import { readFile } from "node:fs/promises";
type IssueRecord = {
    key: string;
    summary: string;
    status: string;
    priority: string;
    assignee: string;
};
const args = process.argv.slice(2);
let inputPath = "./triage-report.txt";
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--input" || arg === "-i") && args[i + 1]) {
        inputPath = args[i + 1];
        i += 1;
    }
}
function parseIssueRecord(line: string): IssueRecord | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("- ")) {
        return null;
    }
    const withoutBullet = trimmed.slice(2);
    const [hashPart, ...restParts] = withoutBullet.split(" | ");
    if (!hashPart || !hashPart.includes(":")) {
        return null;
    }
    const [key, ...summaryParts] = hashPart.split(": ", 2);
    const summary = summaryParts.join(": ").trim();
    const values = Object.fromEntries(
        restParts.map((part) => {
            const index = part.indexOf(":");
            if (index === -1) {
                return [undefined, part] as const;
            }
            return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
        }).filter(([name]) => Boolean(name))
    );
    const status = values["Status"] ?? "Unknown";
    const priority = values["Priority"] ?? "Unknown";
    const assignee = values["Assignee"] ?? "Unassigned";
    if (!key || !summary) {
        return null;
    }
    return {
        key: key.trim(),
        summary,
        status,
        priority,
        assignee
    };
}
function parseStructuredIssues(rawText: string): IssueRecord[] | null {
    try {
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((item) => item && typeof item === "object")
                .map((item) => ({
                    key: String(item.key ?? ""),
                    summary: String(item.summary ?? ""),
                    status: String(item.status ?? "Unknown"),
                    priority: String(item.priority ?? "Unknown"),
                    assignee: String(item.assignee ?? "Unassigned")
                }))
                .filter((item) => item.key && item.summary);
        }
        if (parsed && Array.isArray(parsed.issues)) {
            return parseStructuredIssues(JSON.stringify(parsed.issues));
        }
    } catch {
        return null;
    }
    return null;
}
function normalizeText(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b(the|and|for|with|into|from|issue|issues|research|analysis|technical|update|around|clone|problem|related|of|to|in|on|a|an)\b/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}
function similarityScore(left: string, right: string): number {
    const leftTokens = new Set(normalizeText(left));
    const rightTokens = new Set(normalizeText(right));
    const union = new Set([...leftTokens, ...rightTokens]);
    const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
    if (union.size === 0) {
        return 0;
    }
    return intersection.length / union.size;
}
function formatCandidate(recordA: IssueRecord, recordB: IssueRecord, score: number): string {
    const sharedAssignee = recordA.assignee === recordB.assignee ? `same assignee: ${recordA.assignee}` : "different assignee";
    return `${recordA.key} vs ${recordB.key} | score=${score.toFixed(2)} | ${sharedAssignee} | ${recordA.summary}`;
}
async function main() {
    const reportText = await readFile(inputPath, "utf8");
    const structuredIssues = parseStructuredIssues(reportText);
    const issues = structuredIssues ?? reportText
        .split(/\r?\n/)
        .map((line) => parseIssueRecord(line))
        .filter((issue): issue is IssueRecord => Boolean(issue));
    if (!issues.length) {
        console.log(`No triage issue summaries found in ${inputPath}.`);
        return;
    }
    const candidates: string[] = [];
    for (let i = 0; i < issues.length; i++) {
        for (let j = i + 1; j < issues.length; j++) {
            const left = issues[i];
            const right = issues[j];
            const score = similarityScore(left.summary, right.summary);
            const sameAssignee = left.assignee === right.assignee;
            const sameStatus = left.status === right.status;
            const isLikelyDuplicate = score >= 0.5 || (score >= 0.3 && sameAssignee && sameStatus);
            if (isLikelyDuplicate) {
                candidates.push(formatCandidate(left, right, score));
            }
        }
    }
    if (!candidates.length) {
        console.log(`No likely duplicate candidates found in ${inputPath}.`);
        return;
    }
    console.log(`Likely duplicate candidates from ${inputPath}:`);
    for (const candidate of candidates.slice(0, 10)) {
        console.log(candidate);
    }
}
await main();
