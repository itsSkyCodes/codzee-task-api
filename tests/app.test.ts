import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { app, errorHandler } from "../src/app.js";

const testSecret = "test-secret-for-jwt-tests-at-least-32-bytes";
process.env.JWT_SECRET = testSecret;

const tokenFor = (userId: string) =>
    jwt.sign({ sub: userId }, testSecret, {
        algorithm: "HS256",
        expiresIn: "1h",
    });

const getAs = (path: string, userId = "alice") =>
    request(app)
        .get(path)
        .set("Authorization", `Bearer ${tokenFor(userId)}`);

const postAs = (
    path: string,
    body: unknown,
    userId = "alice",
) =>
    request(app)
        .post(path)
        .set("Authorization", `Bearer ${tokenFor(userId)}`)
        .send(body as any);

describe("Task API validation", () => {
    it("returns a successful health check", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("creates a task with a trimmed title", async () => {
        const response = await postAs("/tasks", {
            title: " Learn TypeScript ",
        });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe("Learn TypeScript");
        expect(response.body.completed).toBe(false);
    });

    it("rejects missing, null, non-string, and empty titles", async () => {
        const invalidBodies = [
            {},
            { title: null },
            { title: 123 },
            { title: ["a"] },
            { title: "" },
            { title: "   " },
        ];

        const before = await getAs("/tasks");
        const countBefore = before.body.length;

        for (const body of invalidBodies) {
            const response = await postAs("/tasks", body);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe("Invalid task data");
            expect(response.body.details).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ field: "title" }),
                ]),
            );
        }

        const after = await getAs("/tasks");
        expect(after.body).toHaveLength(countBefore);
    });

    it("accepts a title of exactly 200 characters", async () => {
        const title = "a".repeat(200);

        const response = await postAs("/tasks", { title });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe(title);
        expect(response.body.title).toHaveLength(200);
    });

    it("trims whitespace before checking the 200-character limit", async () => {
        const title = ` ${"a".repeat(200)} `;

        const response = await postAs("/tasks", { title });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe("a".repeat(200));
    });

    it("rejects titles longer than 200 characters", async () => {
        const response = await postAs("/tasks", {
            title: "a".repeat(201),
        });

        expect(response.status).toBe(400);
    });

    it("creates a task and retrieves it by its ID", async () => {
        const created = await postAs("/tasks", {
            title: "Fetch this task",
        });

        expect(created.status).toBe(201);

        const fetched = await getAs(`/tasks/${created.body.id}`);

        expect(fetched.status).toBe(200);
        expect(fetched.body.id).toBe(created.body.id);
        expect(fetched.body.title).toBe("Fetch this task");
    });

    it("rejects non-canonical task IDs", async () => {
        const invalidIds = [
            "abc",
            "0",
            "0x1",
            "1e0",
            "1.0",
            "%201",
            "+1",
            "9007199254740992",
        ];

        for (const id of invalidIds) {
            const response = await getAs(`/tasks/${id}`);

            expect(response.status, `ID: ${id}`).toBe(400);
            expect(response.body.error).toBe("Invalid task ID");
        }
    });

    it("returns 404 for a valid but nonexistent task ID", async () => {
        const response = await getAs("/tasks/999999");

        expect(response.status).toBe(404);
        expect(response.body.error).toBe("Task not found");
    });

    it("returns JSON for unknown routes", async () => {
        const response = await request(app).get("/no-such-route");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Not found" });
    });

    it("returns 400 for malformed JSON", async () => {
        const response = await request(app)
            .post("/tasks")
            .set("Authorization", `Bearer ${tokenFor("alice")}`)
            .set("Content-Type", "application/json")
            .send('{"title":');

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid JSON body");
    });

    it("preserves the 413 status for oversized JSON bodies", async () => {
        const response = await request(app)
            .post("/tasks")
            .set("Authorization", `Bearer ${tokenFor("alice")}`)
            .send({ title: "a".repeat(1024 * 1024) });

        expect(response.status).toBe(413);
        expect(response.body.error).toBe("Request body too large");
    });

    it("returns a JSON client error for malformed URL-encoded task IDs", async () => {
        const response = await request(app).get("/tasks/%E0%A4%A");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: "Invalid request",
        });
    });

    it("returns a generic 500 response for unexpected errors", async () => {
        const errorApp = express();

        errorApp.get("/trigger-error", (_req, _res, next) => {
            next(new Error("Unexpected test error"));
        });

        errorApp.use(errorHandler);

        const response = await request(errorApp).get("/trigger-error");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            error: "Internal server error",
        });
    });

    const taskEndpoints = [
        {
            method: "GET",
            path: "/tasks",
            makeRequest: () => request(app).get("/tasks"),
        },
        {
            method: "POST",
            path: "/tasks",
            makeRequest: () =>
                request(app)
                    .post("/tasks")
                    .send({ title: "Unauthorized task" }),
        },
        {
            method: "GET",
            path: "/tasks/1",
            makeRequest: () => request(app).get("/tasks/1"),
        },
    ];

    it.each(taskEndpoints)(
        "rejects $method $path without credentials",
        async ({ makeRequest }) => {
            const response = await makeRequest();

            expect(response.status).toBe(401);
            expect(response.headers["www-authenticate"]).toBe("Bearer");
            expect(response.body).toEqual({
                error: "Authentication required",
            });
        },
    );

    it.each(taskEndpoints)(
        "rejects $method $path with non-Bearer credentials",
        async ({ makeRequest }) => {
            const response = await makeRequest().set(
                "Authorization",
                "Basic xyz",
            );

            expect(response.status).toBe(401);
            expect(response.headers["www-authenticate"]).toBe("Bearer");
            expect(response.body).toEqual({
                error: "Authentication required",
            });
        },
    );

    it("rejects an invalid JWT", async () => {
        const response = await request(app)
            .get("/tasks")
            .set("Authorization", "Bearer invalid.token.value");

        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(response.body).toEqual({
            error: "Invalid authentication token",
        });
    });

    it("rejects a validly signed token without an expiration claim", async () => {
        const tokenWithoutExp = jwt.sign({ sub: "alice" }, testSecret, {
            algorithm: "HS256",
        });

        const response = await request(app)
            .get("/tasks")
            .set("Authorization", `Bearer ${tokenWithoutExp}`);

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("Invalid authentication token");
    });

    it("rejects a validly signed token with a blank, missing, or non-string subject", async () => {
        const invalidSubPayloads: Array<Record<string, unknown>> = [
            {},
            { sub: "" },
            { sub: "   " },
            { sub: 123 },
            { sub: null },
        ];

        for (const payload of invalidSubPayloads) {
            const token = jwt.sign(payload, testSecret, {
                algorithm: "HS256",
                expiresIn: "1h",
            });

            const response = await request(app)
                .get("/tasks")
                .set("Authorization", `Bearer ${token}`);

            expect(response.status).toBe(401);
            expect(response.body.error).toBe("Invalid authentication token");
        }
    });

    it("rejects a validly signed token with a string payload", async () => {
        const token = jwt.sign("literal-string", testSecret, {
            algorithm: "HS256",
        });

        const response = await request(app)
            .get("/tasks")
            .set("Authorization", `Bearer ${token}`);

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("Invalid authentication token");
    });

    it("does not expose another user's tasks", async () => {
        const created = await postAs("/tasks", {
            title: "Alice private task",
        }, "alice");

        expect(created.status).toBe(201);

        const aliceList = await getAs("/tasks", "alice");
        const bobList = await getAs("/tasks", "bob");

        expect(aliceList.body.some(
            (task: { id: number }) => task.id === created.body.id,
        )).toBe(true);

        expect(bobList.body).not.toContainEqual(
            expect.objectContaining({ id: created.body.id }),
        );

        const bobFetch = await getAs(
            `/tasks/${created.body.id}`,
            "bob",
        );

        expect(bobFetch.status).toBe(404);
        expect(bobFetch.body).toEqual({ error: "Task not found" });
    });

    it("does not return the internal owner ID in task responses", async () => {
        const created = await postAs("/tasks", {
            title: "Private metadata",
        });

        expect(created.status).toBe(201);
        expect(created.body).not.toHaveProperty("ownerId");

        const fetched = await getAs(`/tasks/${created.body.id}`);
        expect(fetched.body).not.toHaveProperty("ownerId");

        const list = await getAs("/tasks");
        expect(list.body.length).toBeGreaterThan(0);
        for (const item of list.body) {
            expect(item).not.toHaveProperty("ownerId");
        }
    });
});
