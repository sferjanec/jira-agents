import type { AuditProgressListener } from "./contracts.js";
export const logAuditProgress: AuditProgressListener = (event) => {
    console.error(`[jira-audit] ${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event
    })}`);
};
