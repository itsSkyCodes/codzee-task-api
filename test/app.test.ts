
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("Task API validation", () => {
    it("returns a successful health check", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("rejects a missing task title", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid task data");
    });

    it("rejects an empty or whitespace-only title", async () => {
        for (const title of ["", "   "]) {
            const response = await request(app)
                .post("/tasks")
                .send({ title });

            expect(response.status).toBe(400);
        }
    });

    it("creates a task with a trimmed title", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({ title: "  Learn TypeScript  " });

        expect(response.status).toBe(201);
        expect(response.body.title).toBe("Learn TypeScript");
        expect(response.body.completed).toBe(false);
    });

    it("rejects titles longer than 200 characters", async () => {
        const response = await request(app)
            .post("/tasks")
            .send({ title: "a".repeat(201) });

        expect(response.status).toBe(400);
    });

    it("rejects invalid task IDs", async () => {
        const response = await request(app).get("/tasks/abc");

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid task ID");
    });

    it("returns 404 for a valid but nonexistent task ID", async () => {
        const response = await request(app).get("/tasks/999999");

        expect(response.status).toBe(404);
    });

    it("rejects malformed JSON", async () => {
        const response = await request(app)
            .post("/tasks")
            .set("Content-Type", "application/json")
            .send('{"title":');

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid JSON body");
    });
});
