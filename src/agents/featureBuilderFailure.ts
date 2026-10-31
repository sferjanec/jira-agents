export type FeatureBuilderFailureCode =
    | "INVALID_INPUT"
    | "PLAN_NOT_FOUND"
    | "PLAN_INVALID"
    | "REPOSITORY_INVALID"
    | "REPOSITORY_DIRTY"
    | "BRANCH_EXISTS"
    | "BRANCH_FAILED"
    | "MODEL_REQUEST_FAILED"
    | "MODEL_OUTPUT_INVALID"
    | "FILE_WRITE_FAILED"
    | "REQUEST_CANCELLED"
    | "INTERNAL_FAILURE";

const messages: Record<FeatureBuilderFailureCode, string> = {
    INVALID_INPUT: "Provide a valid Jira issue key and an absolute repository root.",
    PLAN_NOT_FOUND: "The approved feature plan was not found at .specs/{ISSUE-KEY}-TASK.md.",
    PLAN_INVALID: "The feature plan is malformed or does not list any safe implementation file paths.",
    REPOSITORY_INVALID: "The workspace must be the root of a Git repository.",
    REPOSITORY_DIRTY: "The repository has changes other than the approved plan. Commit, stash, or remove them before starting the builder.",
    BRANCH_EXISTS: "The builder branch already exists. Choose a different issue key or remove that branch before retrying.",
    BRANCH_FAILED: "The local builder branch could not be created. Check Git status and repository permissions.",
    MODEL_REQUEST_FAILED: "The Copilot builder request failed. Check authentication, model availability, and service access.",
    MODEL_OUTPUT_INVALID: "The builder returned invalid files or did not account for every planned path.",
    FILE_WRITE_FAILED: "Generated files could not be written safely. Check the builder branch and inspect its working tree for partial output.",
    REQUEST_CANCELLED: "Feature building was cancelled or exceeded its time limit.",
    INTERNAL_FAILURE: "Feature building failed unexpectedly. Inspect the local builder branch before retrying."
};

export class FeatureBuilderFailure extends Error {
    constructor(readonly code: FeatureBuilderFailureCode, detail?: string) {
        super(detail ? `${messages[code]} ${detail}` : messages[code]);
        this.name = "FeatureBuilderFailure";
    }
}
