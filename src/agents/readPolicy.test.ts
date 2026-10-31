import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRead, isReadAllowed, maxReadBytes, ReadBudget } from "./readPolicy.js";

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

test("read policy blocks generated artifacts and oversized files, and the budget caps a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-policy-"));
    try {
        await mkdir(join(root, "locales"));
        for (const file of ["logo.svg", "swagger.json", "openapi-v2.json", "coverage-report.xml", "app.min.css", "locales/en.json", "small.ts"]) {
            await writeFile(join(root, file), "x");
        }
        await writeFile(join(root, "big.ts"), "x".repeat(maxReadBytes + 1));
        for (const blocked of ["logo.svg", "swagger.json", "openapi-v2.json", "coverage-report.xml", "app.min.css", "locales/en.json", "big.ts"]) {
            assert.equal(isReadAllowed(root, join(root, blocked)), false, blocked);
        }
        const small = checkRead(root, join(root, "small.ts"));
        assert.equal(small.allowed, true);

        const budget = new ReadBudget(2, 10);
        assert.equal(budget.consume(small), undefined);
        assert.equal(budget.consume(small), undefined);
        assert.match(budget.consume(small) ?? "", /budget exhausted/);
        assert.match(new ReadBudget().consume(checkRead(root, join(root, "big.ts"))) ?? "", /too large/);
    } finally {
        await rm(root, { recursive: true });
    }
});
