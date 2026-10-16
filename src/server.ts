
import { app } from "./app.js";

try {
    process.loadEnvFile();
} catch {
    // Environment variables can be provided externally or via .env file
}

const secret = process.env.JWT_SECRET;

if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error(
        "JWT_SECRET environment variable must be set and at least 32 bytes",
    );
}

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
