const Redis = require("ioredis");

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    // Exponential backoff, capped at 5s, so Redis coming up slightly
    // after the app (common on `docker compose up` cold start) doesn't
    // crash-loop the container.
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
});

redis.on("connect", () => {
  console.log("[redis] connected");
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

redis.on("reconnecting", (delay) => {
  console.warn(`[redis] reconnecting in ${delay}ms`);
});

module.exports = redis;
