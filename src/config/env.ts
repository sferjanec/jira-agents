import dotenv from "dotenv";
dotenv.config({ quiet: true });
function requireEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
export const jiraConfig = {
    url: requireEnvironmentVariable("JIRA_URL").replace(/\/$/, ""),
    user: requireEnvironmentVariable("JIRA_USER"),
    apiToken: requireEnvironmentVariable("JIRA_API_TOKEN")
};
