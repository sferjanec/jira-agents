const jiraEnvironmentKeys = ["JIRA_URL", "JIRA_USER", "JIRA_API_TOKEN"] as const;

export function jiraEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of jiraEnvironmentKeys) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}
