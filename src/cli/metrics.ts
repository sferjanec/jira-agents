import { readFile } from "node:fs/promises";
import { parseRecords, summarize } from "../metrics/report.js";

const file = process.argv[2] ?? process.env.METRICS_FILE;
if (!file) {
    console.error("Usage: npm run metrics -- <path-to-runs.jsonl>   (or set METRICS_FILE)");
    process.exit(2);
}
try {
    console.log(summarize(parseRecords(await readFile(file, "utf8"))));
} catch {
    console.error(`Could not read ${file}. Has a run been recorded with METRICS_FILE set?`);
    process.exit(1);
}
