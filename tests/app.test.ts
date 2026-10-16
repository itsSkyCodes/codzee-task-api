
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("Task API validation", () => {
    it("returns a successful health check", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("creates a task with a trimmed title", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({ title: " Learn TypeScript " });

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

        const before = await request(app).get("/tasks");
        const countBefore = before.body.length;

        for (const body of invalidBodies) {
            const response = await request(app)
                .post("/tasks")
                .send(body);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe("Invalid task data");
            expect(response.body.details).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ field: "title" }),
                ]),
            );
        }

        const after = await request(app).get("/tasks");
        expect(after.body).toHaveLength(countBefore);
    });

    it("accepts a title of exactly 200 characters", async () => {
        const title = "a".repeat(200);

        const response = await request(app)
            .post("/tasks")
            .send({ title });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe(title);
        expect(response.body.title).toHaveLength(200);
    });

    it("trims whitespace before checking the 200-character limit", async () => {
        const title = ` ${"a".repeat(200)} `;

        const response = await request(app)
            .post("/tasks")
            .send({ title });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe("a".repeat(200));
    });

    it("rejects titles longer than 200 characters", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({ title: "a".repeat(201) });

        expect(response.status).toBe(400);
    });

    it("creates a task and retrieves it by its ID", async () => {
        const created = await request(app)
            .post("/tasks")
            .send({ title: "Fetch this task" });

        expect(created.status).toBe(201);

        const fetched = await request(app).get(
            `/tasks/${created.body.id}`,
        );

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
            const response = await request(app).get(`/tasks/${id}`);

            expect(response.status, `ID: ${id}`).toBe(400);
            expect(response.body.error).toBe("Invalid task ID");
        }
    });

    it("returns 404 for a valid but nonexistent task ID", async () => {
        const response = await request(app).get("/tasks/999999");

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
            .set("Content-Type", "application/json")
            .send('{"title":');

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid JSON body");
    });

    it("preserves the 413 status for oversized JSON bodies", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({ title: "a".repeat(1024 * 1024) });

        expect(response.status).toBe(413);
        expect(response.body.error).toBe("Request body too large");
    });
});
