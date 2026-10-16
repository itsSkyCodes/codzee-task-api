
import jwt from "jsonwebtoken";
import express, {
    type ErrorRequestHandler,
    type RequestHandler,
} from "express";
import { z } from "zod";

import { getTaskRepository, type TaskRecord } from "./db/index.js";

export const app = express();

app.use(express.json());

export interface Task {
    id: number;
    title: string;
    completed: boolean;
    ownerId: string;
    version: number;
}

const createTaskSchema = z.object({
    title: z.string().trim().min(1).max(200),
});

const updateTaskSchema = z
    .object({
        title: z.string().trim().min(1).max(200).optional(),
        completed: z.boolean().optional(),
        version: z
            .number()
            .int("Version must be an integer")
            .positive("Version must be a positive integer"),
    })
    .refine(
        (data) => data.title !== undefined || data.completed !== undefined,
        {
            message: "At least one field (title or completed) must be provided",
        },
    );

const paginationQuerySchema = z.object({
    page: z
        .string()
        .regex(/^[1-9]\d*$/, "Page must be a positive integer")
        .default("1")
        .transform(Number)
        .refine(Number.isSafeInteger, "Page must be a safe integer"),
    limit: z
        .string()
        .regex(/^[1-9]\d*$/, "Limit must be a positive integer")
        .default("20")
        .transform(Number)
        .refine(Number.isSafeInteger, "Limit must be a safe integer")
        .refine((n) => n >= 1 && n <= 100, "Limit must be between 1 and 100"),
});

// Accept only canonical positive decimal integers in the URL.
const taskIdSchema = z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine(Number.isSafeInteger);

export const requireAuth: RequestHandler = (req, res, next) => {
    const authorization = req.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!match) {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({
            error: "Authentication required",
        });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32) {
        console.error(
            "JWT_SECRET environment variable must be set and at least 32 bytes",
        );
        return res.status(500).json({
            error: "Internal server error",
        });
    }

    try {
        const payload = jwt.verify(match[1]!, secret, {
            algorithms: ["HS256"],
        });

        if (
            typeof payload === "string" ||
            typeof payload.sub !== "string" ||
            payload.sub.trim().length === 0 ||
            typeof payload.exp !== "number"
        ) {
            res.set("WWW-Authenticate", "Bearer");
            return res.status(401).json({
                error: "Invalid authentication token",
            });
        }

        res.locals.userId = payload.sub;
        return next();
    } catch {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({
            error: "Invalid authentication token",
        });
    }
};

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.get("/tasks", requireAuth, async (req, res) => {
    const queryResult = paginationQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
        return res.status(400).json({
            error: "Invalid pagination parameters",
            details: queryResult.error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
            })),
        });
    }

    const userId = res.locals.userId as string;
    const repository = getTaskRepository();
    const result = await repository.findMany({
        ownerId: userId,
        page: queryResult.data.page,
        limit: queryResult.data.limit,
    });

    const totalPages = Math.ceil(result.total / queryResult.data.limit);

    res.set("X-Total-Count", String(result.total));
    res.set("X-Page", String(queryResult.data.page));
    res.set("X-Limit", String(queryResult.data.limit));
    res.set("X-Total-Pages", String(totalPages));

    const userTasks = result.tasks.map(({ id, title, completed, version }) => ({
        id,
        title,
        completed,
        version,
    }));

    return res.json(userTasks);
});

app.post("/tasks", requireAuth, async (req, res) => {
    const result = createTaskSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            error: "Invalid task data",
            details: result.error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
            })),
        });
    }

    const userId = res.locals.userId as string;
    const repository = getTaskRepository();
    const task = await repository.create({
        title: result.data.title,
        ownerId: userId,
    });

    return res.status(201).json({
        id: task.id,
        title: task.title,
        completed: task.completed,
        version: task.version,
    });
});

app.get("/tasks/:id", requireAuth, async (req, res) => {
    const idResult = taskIdSchema.safeParse(req.params.id);

    if (!idResult.success) {
        return res.status(400).json({ error: "Invalid task ID" });
    }

    const userId = res.locals.userId as string;
    const repository = getTaskRepository();
    const task = await repository.findById(idResult.data, userId);

    // Do not reveal whether another user's task exists.
    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    return res.json({
        id: task.id,
        title: task.title,
        completed: task.completed,
        version: task.version,
    });
});

app.patch("/tasks/:id", requireAuth, async (req, res) => {
    const idResult = taskIdSchema.safeParse(req.params.id);

    if (!idResult.success) {
        return res.status(400).json({ error: "Invalid task ID" });
    }

    const bodyResult = updateTaskSchema.safeParse(req.body);

    if (!bodyResult.success) {
        return res.status(400).json({
            error: "Invalid task data",
            details: bodyResult.error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
            })),
        });
    }

    const userId = res.locals.userId as string;
    const repository = getTaskRepository();
    const updateResult = await repository.update(
        idResult.data,
        userId,
        {
            title: bodyResult.data.title,
            completed: bodyResult.data.completed,
            version: bodyResult.data.version,
        },
    );

    if (updateResult.status === "NOT_FOUND") {
        return res.status(404).json({ error: "Task not found" });
    }

    if (updateResult.status === "CONFLICT") {
        return res.status(409).json({
            error: "Conflict: Task has been modified by another request",
            currentVersion: updateResult.currentVersion,
        });
    }

    return res.json({
        id: updateResult.task.id,
        title: updateResult.task.title,
        completed: updateResult.task.completed,
        version: updateResult.task.version,
    });
});

// Return JSON for unknown paths and unsupported routes.
app.use((_req, res) => {
    return res.status(404).json({ error: "Not found" });
});

// Preserve appropriate 4xx statuses from Express/body-parser.
export const errorHandler: ErrorRequestHandler = (
    err: unknown,
    _req,
    res,
    _next,
) => {
    if (
        err instanceof SyntaxError &&
        "body" in err
    ) {
        return res.status(400).json({
            error: "Invalid JSON body",
        });
    }

    const error =
        typeof err === "object" && err !== null
            ? (err as { status?: unknown; statusCode?: unknown })
            : {};

    const status = error.status ?? error.statusCode;

    if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status < 500
    ) {
        return res.status(status).json({
            error:
                status === 413
                    ? "Request body too large"
                    : "Invalid request",
        });
    }

    return res.status(500).json({
        error: "Internal server error",
    });
};

app.use(errorHandler);
