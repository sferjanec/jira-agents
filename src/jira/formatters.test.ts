import assert from "node:assert/strict";
import test from "node:test";
import { detailIssue, richTextToPlainText } from "./formatters.js";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("rich text converts to plain text with lists and tolerates unknown nodes", () => {
    const doc = {
        type: "doc",
        content: [
            paragraph("Intro"),
            { type: "bulletList", content: [{ type: "listItem", content: [paragraph("one")] }, { type: "listItem", content: [paragraph("two")] }] },
            { type: "mysteryNode", content: [paragraph("still shown")] }
        ]
    };
    assert.equal(richTextToPlainText(doc).trim(), "Intro\n- one\n- two\nstill shown");
});

test("detailIssue returns description and the latest comments as plain text", () => {
    const comments = Array.from({ length: 25 }, (_, index) => ({
        author: { displayName: "Agent user" },
        created: "2026-10-31T00:00:00.000+0000",
        body: { type: "doc", content: [paragraph(`comment ${index}`)] }
    }));
    const result = detailIssue({
        key: "KAN-1",
        fields: { summary: "S", description: { type: "doc", content: [paragraph("Body")] }, comment: { comments } }
    });
    assert.equal(result.description, "Body");
    assert.equal(result.comments.length, 20);
    assert.equal(result.comments[19].body, "comment 24");
    assert.equal(result.commentsTruncated, true);
    assert.equal(detailIssue({ key: "K", fields: {} }).description, "(no description)");
});
