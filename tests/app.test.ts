import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { app, errorHandler } from "../src/app.js";
import { InMemoryTaskRepository, setTaskRepository } from "../src/db/index.js";

const testSecret = "test-secret-for-jwt-tests-at-least-32-bytes";
process.env.JWT_SECRET = testSecret;

setTaskRepository(new InMemoryTaskRepository());

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

const patchAs = (
    path: string,
    body: unknown,
    userId = "alice",
) =>
    request(app)
        .patch(path)
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
        {
            method: "PATCH",
            path: "/tasks/1",
            makeRequest: () =>
                request(app)
                    .patch("/tasks/1")
                    .send({ title: "Unauthorized update", version: 1 }),
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

    it("rejects PATCH /tasks/:id without credentials even with invalid body or invalid ID (verifying auth precedes validation)", async () => {
        const emptyBodyRes = await request(app)
            .patch("/tasks/1")
            .send({});

        expect(emptyBodyRes.status).toBe(401);
        expect(emptyBodyRes.headers["www-authenticate"]).toBe("Bearer");
        expect(emptyBodyRes.body).toEqual({
            error: "Authentication required",
        });

        const invalidIdRes = await request(app)
            .patch("/tasks/abc")
            .send({ title: "" });

        expect(invalidIdRes.status).toBe(401);
        expect(invalidIdRes.headers["www-authenticate"]).toBe("Bearer");
        expect(invalidIdRes.body).toEqual({
            error: "Authentication required",
        });
    });

    it("rejects POST /tasks without credentials even with invalid body (verifying auth precedes validation)", async () => {
        const invalidBodyRes = await request(app)
            .post("/tasks")
            .send({ title: "" });

        expect(invalidBodyRes.status).toBe(401);
        expect(invalidBodyRes.headers["www-authenticate"]).toBe("Bearer");
        expect(invalidBodyRes.body).toEqual({
            error: "Authentication required",
        });
    });

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

    describe("Pagination and database querying", () => {
        it("returns an empty list with correct headers for a user with no tasks", async () => {
            const response = await getAs("/tasks?page=1", "new_user_with_no_tasks");

            expect(response.status).toBe(200);
            expect(response.body).toEqual([]);
            expect(response.headers["x-total-count"]).toBe("0");
            expect(response.headers["x-page"]).toBe("1");
            expect(response.headers["x-total-pages"]).toBe("0");
        });

        it("returns empty results when requesting a page past the total count", async () => {
            await postAs("/tasks", { title: "Page test task" }, "boundary_user");

            const response = await getAs("/tasks?page=100&limit=10", "boundary_user");

            expect(response.status).toBe(200);
            expect(response.body).toEqual([]);
            expect(response.headers["x-total-count"]).toBe("1");
            expect(response.headers["x-page"]).toBe("100");
        });

        it("defaults to page 1 and limit 20 with pagination headers when page and limit are omitted", async () => {
            const user = "all_tasks_user";
            for (let i = 1; i <= 25; i++) {
                await postAs("/tasks", { title: `Task ${i}` }, user);
            }

            const response = await getAs("/tasks", user);
            expect(response.status).toBe(200);
            expect(response.body).toHaveLength(20);
            expect(response.headers["x-total-count"]).toBe("25");
            expect(response.headers["x-page"]).toBe("1");
            expect(response.headers["x-limit"]).toBe("20");
            expect(response.headers["x-total-pages"]).toBe("2");
            for (const item of response.body) {
                expect(item).not.toHaveProperty("version");
                expect(item).toHaveProperty("id");
                expect(item).toHaveProperty("title");
                expect(item).toHaveProperty("completed");
            }
        });

        it("paginates correctly across page boundaries", async () => {
            const user = "pagination_stepper";
            const taskIds: number[] = [];

            for (let i = 1; i <= 5; i++) {
                const res = await postAs("/tasks", { title: `Task ${i}` }, user);
                taskIds.push(res.body.id);
            }

            // Page 1 with limit 2 -> returns tasks 1 and 2
            const page1 = await getAs("/tasks?page=1&limit=2", user);
            expect(page1.status).toBe(200);
            expect(page1.body).toHaveLength(2);
            expect(page1.body[0].id).toBe(taskIds[0]);
            expect(page1.body[1].id).toBe(taskIds[1]);
            expect(page1.body[0]).not.toHaveProperty("version");
            expect(page1.headers["x-total-count"]).toBe("5");
            expect(page1.headers["x-page"]).toBe("1");
            expect(page1.headers["x-limit"]).toBe("2");
            expect(page1.headers["x-total-pages"]).toBe("3");

            // Page 2 with limit 2 -> returns tasks 3 and 4
            const page2 = await getAs("/tasks?page=2&limit=2", user);
            expect(page2.status).toBe(200);
            expect(page2.body).toHaveLength(2);
            expect(page2.body[0].id).toBe(taskIds[2]);
            expect(page2.body[1].id).toBe(taskIds[3]);
            expect(page2.headers["x-page"]).toBe("2");

            // Page 3 with limit 2 -> returns final task 5
            const page3 = await getAs("/tasks?page=3&limit=2", user);
            expect(page3.status).toBe(200);
            expect(page3.body).toHaveLength(1);
            expect(page3.body[0].id).toBe(taskIds[4]);
            expect(page3.headers["x-page"]).toBe("3");

            // Page 4 with limit 2 -> out of bounds, returns 0 tasks
            const page4 = await getAs("/tasks?page=4&limit=2", user);
            expect(page4.status).toBe(200);
            expect(page4.body).toHaveLength(0);
        });

        it("accepts boundary limit values 1 and 100", async () => {
            const resMin = await getAs("/tasks?limit=1");
            expect(resMin.status).toBe(200);
            expect(resMin.headers["x-limit"]).toBe("1");

            const resMax = await getAs("/tasks?limit=100");
            expect(resMax.status).toBe(200);
            expect(resMax.headers["x-limit"]).toBe("100");
        });

        it("rejects invalid, negative, or non-integer pagination parameters", async () => {
            const invalidQueries = [
                "/tasks?page=0",
                "/tasks?page=-1",
                "/tasks?page=abc",
                "/tasks?page=1.5",
                "/tasks?page=10001",
                "/tasks?limit=0",
                "/tasks?limit=-5",
                "/tasks?limit=101",
                "/tasks?limit=xyz",
                "/tasks?limit=2.5",
            ];

            for (const query of invalidQueries) {
                const response = await getAs(query);
                expect(response.status, `Query: ${query}`).toBe(400);
                expect(response.body.error).toBe("Invalid pagination parameters");
            }
        });
    });

    describe("Concurrency control and task updates (PATCH /tasks/:id)", () => {
        it("successfully updates task title and completion status with matching version", async () => {
            const created = await postAs("/tasks", { title: "Original Title" });
            expect(created.status).toBe(201);
            expect(created.body).not.toHaveProperty("version");
            expect(created.headers.etag).toBe('"1"');

            const updated = await patchAs(`/tasks/${created.body.id}`, {
                title: "Updated Title",
                completed: true,
                version: 1,
            });

            expect(updated.status).toBe(200);
            expect(updated.body.title).toBe("Updated Title");
            expect(updated.body.completed).toBe(true);
            expect(updated.body).not.toHaveProperty("version");
            expect(updated.headers.etag).toBe('"2"');

            // Fetch to ensure database persisted the update
            const fetched = await getAs(`/tasks/${created.body.id}`);
            expect(fetched.status).toBe(200);
            expect(fetched.body.title).toBe("Updated Title");
            expect(fetched.body.completed).toBe(true);
            expect(fetched.body).not.toHaveProperty("version");
            expect(fetched.headers.etag).toBe('"2"');
        });

        it("rejects conflicting updates with a stale version (409 Conflict)", async () => {
            const created = await postAs("/tasks", { title: "Concurrent Task" });
            const taskId = created.body.id;

            // Client A updates with version 1 -> succeeds, version becomes 2
            const updateA = await patchAs(`/tasks/${taskId}`, {
                title: "Client A update",
                version: 1,
            });
            expect(updateA.status).toBe(200);
            expect(updateA.body).not.toHaveProperty("version");
            expect(updateA.headers.etag).toBe('"2"');

            // Client B attempts to update with stale version 1 -> rejected with 409 Conflict
            const updateB = await patchAs(`/tasks/${taskId}`, {
                title: "Client B update",
                version: 1,
            });
            expect(updateB.status).toBe(409);
            expect(updateB.body.error).toBe(
                "Conflict: Task has been modified by another request",
            );
            expect(updateB.body.currentVersion).toBe(2);

            // Client B retries with current version 2 -> succeeds, version becomes 3
            const updateBRetry = await patchAs(`/tasks/${taskId}`, {
                title: "Client B retry",
                version: 2,
            });
            expect(updateBRetry.status).toBe(200);
            expect(updateBRetry.body).not.toHaveProperty("version");
            expect(updateBRetry.headers.etag).toBe('"3"');
        });

        it("rejects duplicate updates using the previous version with 409 Conflict", async () => {
            const created = await postAs("/tasks", { title: "Duplicate Test" });
            const taskId = created.body.id;

            const firstUpdate = await patchAs(`/tasks/${taskId}`, {
                completed: true,
                version: 1,
            });
            expect(firstUpdate.status).toBe(200);

            // Resending the exact same payload with version 1 is rejected
            const duplicateUpdate = await patchAs(`/tasks/${taskId}`, {
                completed: true,
                version: 1,
            });
            expect(duplicateUpdate.status).toBe(409);
            expect(duplicateUpdate.body.error).toBe(
                "Conflict: Task has been modified by another request",
            );
        });

        it("rejects updates with missing or invalid version", async () => {
            const created = await postAs("/tasks", { title: "Version Validation" });
            const taskId = created.body.id;

            const missingVersion = await patchAs(`/tasks/${taskId}`, {
                title: "No version",
            });
            expect(missingVersion.status).toBe(400);

            const nonIntegerVersion = await patchAs(`/tasks/${taskId}`, {
                title: "Float version",
                version: 1.5,
            });
            expect(nonIntegerVersion.status).toBe(400);

            const zeroVersion = await patchAs(`/tasks/${taskId}`, {
                title: "Zero version",
                version: 0,
            });
            expect(zeroVersion.status).toBe(400);
        });

        it("accepts version supplied via If-Match header when omitted from body", async () => {
            const created = await postAs("/tasks", { title: "Header Version Test" });
            const taskId = created.body.id;

            const updateRes = await request(app)
                .patch(`/tasks/${taskId}`)
                .set("Authorization", `Bearer ${tokenFor("alice")}`)
                .set("If-Match", '"1"')
                .send({ title: "Updated via Header" });

            expect(updateRes.status).toBe(200);
            expect(updateRes.headers.etag).toBe('"2"');
            expect(updateRes.body.title).toBe("Updated via Header");
            expect(updateRes.body).not.toHaveProperty("version");
        });

        it("rejects updates with empty body or invalid fields", async () => {
            const created = await postAs("/tasks", { title: "Field Validation" });
            const taskId = created.body.id;

            // Neither title nor completed provided
            const emptyFields = await patchAs(`/tasks/${taskId}`, {
                version: 1,
            });
            expect(emptyFields.status).toBe(400);

            // Empty title
            const emptyTitle = await patchAs(`/tasks/${taskId}`, {
                title: "   ",
                version: 1,
            });
            expect(emptyTitle.status).toBe(400);

            // Oversized title
            const longTitle = await patchAs(`/tasks/${taskId}`, {
                title: "a".repeat(201),
                version: 1,
            });
            expect(longTitle.status).toBe(400);

            // Invalid completed type
            const invalidCompleted = await patchAs(`/tasks/${taskId}`, {
                completed: "yes",
                version: 1,
            });
            expect(invalidCompleted.status).toBe(400);
        });

        it("returns 404 for a valid but nonexistent task ID on PATCH", async () => {
            const response = await patchAs("/tasks/999999", {
                title: "Nonexistent",
                version: 1,
            });
            expect(response.status).toBe(404);
            expect(response.body.error).toBe("Task not found");
        });

        it("does not allow a user to update another user's task", async () => {
            const created = await postAs(
                "/tasks",
                { title: "Alice's Task" },
                "alice",
            );

            const bobAttempt = await patchAs(
                `/tasks/${created.body.id}`,
                { title: "Bob Hijack", version: 1 },
                "bob",
            );

            expect(bobAttempt.status).toBe(404);
            expect(bobAttempt.body.error).toBe("Task not found");

            // Verify Alice's task was NOT changed
            const aliceTask = await getAs(`/tasks/${created.body.id}`, "alice");
            expect(aliceTask.body.title).toBe("Alice's Task");
            expect(aliceTask.body).not.toHaveProperty("version");
        });
    });
});
