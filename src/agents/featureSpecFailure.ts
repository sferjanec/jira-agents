export type FeatureSpecFailureCode =
    | "INVALID_WORKSPACE"
    | "WORKSPACE_ACCESS_FAILED"
    | "JIRA_RETRIEVAL_FAILED"
    | "REQUEST_CANCELLED"
    | "MODEL_REQUEST_FAILED"
    | "MODEL_OUTPUT_INVALID"
    | "SPEC_ALREADY_EXISTS"
    | "SPEC_SAVE_FAILED"
    | "INTERNAL_FAILURE";

const messages: Record<FeatureSpecFailureCode, string> = {
    INVALID_WORKSPACE: "The workspace path must be an absolute path to an accessible directory.",
    WORKSPACE_ACCESS_FAILED: "The workspace could not be inspected safely. Check its permissions and try again.",
    JIRA_RETRIEVAL_FAILED: "The Jira issue could not be retrieved or did not contain supported issue data.",
    REQUEST_CANCELLED: "Feature plan generation was cancelled or exceeded its time limit.",
    MODEL_REQUEST_FAILED: "The Copilot planning request failed. Check authentication, model availability, and service access.",
    MODEL_OUTPUT_INVALID: "The planning agent returned content that did not match the required plan format.",
    SPEC_ALREADY_EXISTS: "A feature plan already exists at the output path. Move it or remove it before generating another.",
    SPEC_SAVE_FAILED: "The feature plan could not be saved. Check workspace permissions and available disk space.",
    INTERNAL_FAILURE: "Feature plan generation failed unexpectedly. No complete result is available."
};

export class FeatureSpecFailure extends Error {
    constructor(readonly code: FeatureSpecFailureCode) {
        super(messages[code]);
        this.name = "FeatureSpecFailure";
    }
}
