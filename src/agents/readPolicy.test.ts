import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReadAllowed } from "./readPolicy.js";

test("read policy allows source and blocks secrets, build output and escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-policy-"));
    const outside = await mkdtemp(join(tmpdir(), "read-outside-"));
    try {
        await mkdir(join(root, "src"));
        await mkdir(join(root, "node_modules"));
        await mkdir(join(root, ".git"));
        for (const file of ["src/App.java", "src/app.yml", ".env", "src/key.pem", "node_modules/a.js", ".git/config", "src/logo.png", "package-lock.json"]) {
            await writeFile(join(root, file), "x");
        }
        await writeFile(join(outside, "secret.txt"), "x");
        await symlink(join(outside, "secret.txt"), join(root, "src", "link.txt"));

        assert.equal(isReadAllowed(root, join(root, "src/App.java")), true);
        assert.equal(isReadAllowed(root, "src/app.yml"), true);
        assert.equal(isReadAllowed(root, `"${root}"`), true);
        assert.equal(isReadAllowed(root, join(root, "src")), true);
        assert.equal(isReadAllowed(root, root), true);
        for (const blocked of [".env", "src/key.pem", "node_modules/a.js", ".git/config", "src/logo.png", "package-lock.json", "../x", "src/link.txt", "src/missing.java"]) {
            assert.equal(isReadAllowed(root, join(root, blocked)), false, blocked);
        }
        assert.equal(isReadAllowed(root, outside), false);
    } finally {
        await rm(root, { recursive: true });
        await rm(outside, { recursive: true });
    }
});
