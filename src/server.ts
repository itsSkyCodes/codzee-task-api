
import { app } from "./app.js";
import { initializeDatabase } from "./db/index.js";

try {
    process.loadEnvFile();
} catch (error: unknown) {
    if (
        !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        )
    ) {
        throw error;
    }
}

const secret = process.env.JWT_SECRET;

if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error(
        "JWT_SECRET environment variable must be set and at least 32 bytes",
    );
}

if (!process.env.MYSQL_HOST) {
    throw new Error(
        "MYSQL_HOST environment variable must be set in .env",
    );
}

const port = Number(process.env.PORT) || 3000;

async function startServer() {
    await initializeDatabase();

    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
