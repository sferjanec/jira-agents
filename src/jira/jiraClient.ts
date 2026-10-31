import axios from "axios";
import { jiraConfig } from "../config/env.js";
export const jira = axios.create({
    baseURL: jiraConfig.url,
    auth: {
        username: jiraConfig.user,
        password: jiraConfig.apiToken
    }
});
