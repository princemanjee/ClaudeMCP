import { main } from "./server.js";

main()
  .then(({ close }) => {
    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      console.log(`\n[ClaudeMCP] ${signal} received, shutting down...`);
      try {
        await close();
        process.exit(0);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("[ClaudeMCP] startup failed:", err);
    process.exit(1);
  });
